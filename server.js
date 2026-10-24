import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import * as piSdk from '@earendil-works/pi-coding-agent';

const {
  ModelRegistry,
  SessionManager,
  createAgentSession,
  resizeImage,
} = piSdk;

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PORT = process.env.PORT || 3000;
const HOST = process.env.HOST || '127.0.0.1';
const CWD = process.cwd();

// Uploaded attachments live inside the agent's working directory so the model
// can also reach them through the normal read/bash tools.
const UPLOAD_DIR = path.resolve(CWD, '.pi-web', 'uploads');
const MAX_UPLOAD_BYTES = 25 * 1024 * 1024;
const MAX_IMAGE_BYTES = 5 * 1024 * 1024;
const MAX_IMAGES_PER_MESSAGE = 8;
const TEXT_INLINE_LIMIT = 80_000;
try {
  fs.mkdirSync(UPLOAD_DIR, { recursive: true });
} catch (err) {
  console.warn(`Could not create upload directory ${UPLOAD_DIR}: ${err.message}`);
}

// ── Keep-awake (macOS) ─────────────────────────────────────────────────────
// Long agent turns can outlive the idle sleep timer and lose their network
// connections. While at least one prompt stream is active, hold a caffeinate
// assertion so macOS stays awake. Set PI_WEB_KEEP_AWAKE=0 to disable.
const KEEP_AWAKE_ENABLED = process.platform === 'darwin' && process.env.PI_WEB_KEEP_AWAKE !== '0';
let activeKeepAwakeTasks = 0;
let keepAwakeProcess = null;

function startKeepAwake() {
  if (!KEEP_AWAKE_ENABLED) return;
  activeKeepAwakeTasks += 1;
  if (keepAwakeProcess) return;

  try {
    // -i: prevent idle system sleep, -m: prevent disk sleep, -s: prevent
    // system sleep while on AC power.
    keepAwakeProcess = spawn('caffeinate', ['-ims'], { stdio: 'ignore' });
    keepAwakeProcess.on('error', () => { keepAwakeProcess = null; });
    keepAwakeProcess.on('exit', () => { keepAwakeProcess = null; });
  } catch {
    keepAwakeProcess = null;
  }
}

function stopKeepAwake() {
  if (!KEEP_AWAKE_ENABLED) return;
  activeKeepAwakeTasks = Math.max(0, activeKeepAwakeTasks - 1);
  if (activeKeepAwakeTasks > 0 || !keepAwakeProcess) return;

  const proc = keepAwakeProcess;
  keepAwakeProcess = null;
  try { proc.kill('SIGTERM'); } catch {}
}

process.on('exit', () => {
  try { keepAwakeProcess?.kill('SIGTERM'); } catch {}
});

// ── Auth & Model Registry ──────────────────────────────────────────────────
const MODELS_FILE = path.join(os.homedir(), '.pi', 'agent', 'models.json');

function modelsFileMtime() {
  try { return fs.statSync(MODELS_FILE).mtimeMs; } catch { return 0; }
}

// pi-coding-agent 1.x replaced AuthStorage with ModelRuntime; 0.x used
// AuthStorage + ModelRegistry.create(). Support both so the server can be
// upgraded (or rolled back) without a flag day.
let modelRuntime = null;
let authStorage = null;
let modelRegistry;

if (typeof piSdk.ModelRuntime === 'function') {
  modelRuntime = await piSdk.ModelRuntime.create();
  modelRegistry = new ModelRegistry(modelRuntime);
} else {
  authStorage = piSdk.AuthStorage.create();
  modelRegistry = ModelRegistry.create(authStorage);
}

let modelRegistryMtime = modelsFileMtime();
let modelRefreshPromise = null;

// models.json can change while the web server is running (new cloud models,
// capability fixes, etc.). Reload when the file's mtime changes so the
// `/model` picker does not stay stale until a full server restart.
function refreshModelRegistry() {
  const mtime = modelsFileMtime();
  if (mtime !== modelRegistryMtime) {
    if (modelRuntime) {
      if (!modelRefreshPromise) {
        const targetMtime = mtime;
        modelRefreshPromise = modelRuntime.refresh()
          .then(() => { modelRegistryMtime = targetMtime; })
          .catch((err) => {
            console.warn(`Could not refresh models.json: ${err.message}`);
          })
          .finally(() => { modelRefreshPromise = null; });
      }
    } else {
      modelRegistry = ModelRegistry.create(authStorage);
      modelRegistryMtime = mtime;
    }
  }
  return modelRegistry;
}

function sessionOptions(sessionManager) {
  const options = { sessionManager };
  if (modelRuntime) {
    options.modelRuntime = modelRuntime;
  } else {
    options.authStorage = authStorage;
    options.modelRegistry = modelRegistry;
  }
  return options;
}

// ── Active sessions pool ───────────────────────────────────────────────────
const activeSessions = new Map();

// Slash commands implemented by the web UI itself. Skills, prompt templates
// and extension commands are added per-session in /api/commands.
const WEB_BUILTIN_COMMANDS = [
  { name: 'model', description: 'Select a model', argumentProvider: 'models' },
  { name: 'skills', description: 'Browse skills and insert a skill command', argumentProvider: 'skills' },
  { name: 'prompts', description: 'Browse prompt templates', argumentProvider: 'prompts' },
  { name: 'new', description: 'Start a new chat session' },
  { name: 'resume', description: 'Switch to another session' },
  { name: 'compact', description: 'Compact the current session context' },
  { name: 'session', description: 'Show session information' },
  { name: 'abort', description: 'Stop the current response' },
  { name: 'help', description: 'Show all available commands' },
];

// ── MIME types ─────────────────────────────────────────────────────────────
const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.css':  'text/css; charset=utf-8',
  '.js':   'application/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg':  'image/svg+xml',
  '.png':  'image/png',
  '.jpg':  'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.ico':  'image/x-icon',
  '.webp': 'image/webp',
  '.gif':  'image/gif',
  '.bmp':  'image/bmp',
  '.pdf':  'application/pdf',
  '.txt':  'text/plain; charset=utf-8',
  '.md':   'text/markdown; charset=utf-8',
  '.csv':  'text/csv; charset=utf-8',
  '.yaml': 'text/yaml; charset=utf-8',
  '.yml':  'text/yaml; charset=utf-8',
  '.toml': 'text/plain; charset=utf-8',
  '.log':  'text/plain; charset=utf-8',
};

// ── Helpers ────────────────────────────────────────────────────────────────

function parseBody(req) {
  return new Promise((resolve) => {
    let body = '';
    req.on('data', chunk => { body += chunk; });
    req.on('end', () => {
      try { resolve(body ? JSON.parse(body) : {}); }
      catch { resolve({}); }
    });
    req.on('error', () => resolve({}));
  });
}

function sendJSON(res, status, data) {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify(data));
}

// ── Attachment helpers ─────────────────────────────────────────────────────
const IMAGE_MIME = new Set(['image/png', 'image/jpeg', 'image/gif', 'image/webp']);
const TEXT_EXT = new Set([
  'txt', 'md', 'markdown', 'json', 'jsonc', 'js', 'mjs', 'cjs', 'jsx', 'ts', 'tsx',
  'css', 'scss', 'less', 'html', 'htm', 'xml', 'svg', 'yaml', 'yml', 'toml', 'ini',
  'cfg', 'conf', 'env', 'csv', 'tsv', 'log', 'py', 'rb', 'go', 'rs', 'java', 'kt',
  'c', 'h', 'cc', 'cpp', 'hpp', 'cs', 'php', 'sh', 'bash', 'zsh', 'fish', 'sql',
  'graphql', 'gql', 'vue', 'svelte', 'tex', 'rst', 'diff', 'patch',
]);

function sniffImageMime(buffer) {
  if (!buffer || buffer.length < 12) return null;
  if (buffer[0] === 0x89 && buffer[1] === 0x50 && buffer[2] === 0x4e && buffer[3] === 0x47 &&
      buffer[4] === 0x0d && buffer[5] === 0x0a && buffer[6] === 0x1a && buffer[7] === 0x0a) return 'image/png';
  if (buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[2] === 0xff) return 'image/jpeg';
  if (buffer.toString('ascii', 0, 4) === 'GIF8') return 'image/gif';
  if (buffer.toString('ascii', 0, 4) === 'RIFF' && buffer.toString('ascii', 8, 12) === 'WEBP') return 'image/webp';
  if (buffer[0] === 0x42 && buffer[1] === 0x4d) return 'image/bmp';
  return null;
}

function sanitizeFileName(name) {
  const base = path.basename(String(name || 'attachment')).replace(/[\x00-\x1f<>:"/\\|?*]/g, '_').replace(/^\.+/, '').trim();
  return (base || 'attachment').slice(0, 120);
}

function mimeForName(name) {
  const ext = path.extname(name).slice(1).toLowerCase();
  return MIME['.' + ext] || (TEXT_EXT.has(ext) ? 'text/plain; charset=utf-8' : 'application/octet-stream');
}

function isTextAttachment(buffer, mimeType, name) {
  if (!buffer || buffer.includes(0)) return false;
  const ext = path.extname(name).slice(1).toLowerCase();
  const mime = String(mimeType || '').split(';')[0].trim().toLowerCase();
  if (TEXT_EXT.has(ext)) return true;
  if (mime === 'image/svg+xml' || mime.startsWith('text/') || mime === 'application/json' ||
      mime === 'application/xml' || mime === 'application/javascript' || mime === 'application/x-javascript' ||
      mime === 'application/x-yaml' || mime === 'application/yaml') return true;
  return false;
}

function readRawBody(req, limit = MAX_UPLOAD_BYTES) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    let tooLarge = false;
    req.on('data', (chunk) => {
      size += chunk.length;
      if (size > limit) {
        tooLarge = true;
        chunks.length = 0;
        return;
      }
      if (!tooLarge) chunks.push(chunk);
    });
    req.on('end', () => {
      if (tooLarge) reject(new Error('File too large'));
      else resolve(Buffer.concat(chunks));
    });
    req.on('error', reject);
  });
}

function stripAttachmentMarkers(text) {
  return String(text || '')
    .replace(/<pi-web-attachments>[\s\S]*?<\/pi-web-attachments>/g, '')
    .replace(/\[Attached files\][\s\S]*?\[End attachments\]/g, '')
    .replace(/<pi-web-content\b[\s\S]*?<\/pi-web-content>/g, '')
    .replace(/<!--pi-web-attachments:[\s\S]*?-->/g, '')
    .replace(/<!--pi-web-content:[\s\S]*?-->[\s\S]*?<!--\/pi-web-content:[\s\S]*?-->/g, '')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

function serveStatic(res, urlPath) {
  // Security: prevent directory traversal
  const publicDir = path.resolve(path.join(__dirname, 'public'));
  let filePath = path.join(publicDir, urlPath === '/' ? 'index.html' : urlPath);
  filePath = path.resolve(filePath);

  if (!filePath.startsWith(publicDir)) {
    res.writeHead(403);
    res.end('Forbidden');
    return;
  }

  const ext = path.extname(filePath);
  fs.readFile(filePath, (err, data) => {
    if (err) {
      // SPA fallback: serve index.html for non-file routes
      fs.readFile(path.join(publicDir, 'index.html'), (err2, data2) => {
        if (err2) { res.writeHead(404); res.end('Not Found'); return; }
        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
        res.end(data2);
      });
      return;
    }
    res.writeHead(200, { 'Content-Type': MIME[ext] || 'application/octet-stream' });
    res.end(data);
  });
}

function blockToText(block) {
  if (!block) return '';
  if (typeof block === 'string') return block;
  if (block.type === 'text') return String(block.text || '');
  if (block.type === 'image') return '[image]';
  if (typeof block.text === 'string') return block.text;
  return '';
}

// Extract readable text from a tool result. The agent emits results as
// { content: [{ type: 'text', text }], details }, while older/other shapes
// may be a string, an array of blocks, or { output }.
function extractToolOutput(result) {
  if (result == null) return '';
  if (typeof result === 'string') return result;
  if (Array.isArray(result)) {
    return result.map(blockToText).filter(Boolean).join('\n');
  }
  if (Array.isArray(result.content)) {
    return result.content.map(blockToText).filter(Boolean).join('\n');
  }
  if (typeof result.text === 'string') return result.text;
  if (typeof result.output === 'string') return result.output;
  try {
    return JSON.stringify(result, null, 2);
  } catch {
    return String(result);
  }
}

// Convert AgentMessage to a frontend-friendly format
function formatUsage(usage) {
  if (!usage || typeof usage !== 'object') return null;
  return {
    input: Number(usage.input) || 0,
    output: Number(usage.output) || 0,
    cacheRead: Number(usage.cacheRead) || 0,
    cacheWrite: Number(usage.cacheWrite) || 0,
    reasoning: Number(usage.reasoning) || 0,
    totalTokens: Number(usage.totalTokens) || 0,
    cost: typeof usage.cost === 'number'
      ? usage.cost
      : Number(usage.cost?.total) || 0,
  };
}

function formatMessages(messages) {
  const result = [];
  const toolCallsById = new Map();
  for (const msg of messages) {
    if (!msg || !msg.role) continue;
    const role = msg.role;
    let content = '';
    let toolCalls = [];
    let thinking = '';
    let images = [];

    // Tool results are separate messages in the agent's message list. Merge
    // them into the assistant tool call so reloaded sessions render the same
    // tool blocks as live streaming.
    if (role === 'toolResult') {
      const tc = msg.toolCallId ? toolCallsById.get(msg.toolCallId) : null;
      if (tc) {
        tc.result = extractToolOutput({ content: msg.content });
        tc.isError = Boolean(msg.isError);
      }
      continue;
    }

    if (typeof msg.content === 'string') {
      content = msg.content;
    } else if (Array.isArray(msg.content)) {
      for (const block of msg.content) {
        if (block.type === 'text') {
          content += block.text;
        } else if (block.type === 'toolCall' || block.type === 'tool_use') {
          const tc = {
            id: block.id,
            name: block.name,
            input: block.arguments ?? block.input ?? {},
            result: null,
            isError: false,
          };
          toolCalls.push(tc);
          if (tc.id) toolCallsById.set(tc.id, tc);
        } else if (block.type === 'tool_result') {
          // Attach result to the matching tool call
          const tc = toolCalls.find(t => t.id === block.tool_use_id);
          if (tc) {
            tc.result = extractToolOutput(block.content);
            tc.isError = block.is_error || false;
          }
        } else if (block.type === 'thinking') {
          thinking += block.thinking || '';
        } else if (block.type === 'image') {
          const data = block.data || block.source?.data;
          const mimeType = block.mimeType || block.source?.mediaType;
          if (data && mimeType) {
            images.push({ mimeType, data, dataUrl: `data:${mimeType};base64,${data}` });
          }
        }
      }
    }

    result.push({
      id: msg.id || crypto.randomUUID(),
      role,
      content: content.trim(),
      toolCalls,
      thinking: thinking.trim(),
      images,
      usage: formatUsage(msg.usage),
      timestamp: msg.timestamp || new Date().toISOString(),
    });
  }
  return result;
}

// ── Session helpers ────────────────────────────────────────────────────────

async function getOrCreateSession(sessionId) {
  if (sessionId && activeSessions.has(sessionId)) {
    return activeSessions.get(sessionId);
  }
  // Create new
  const sm = SessionManager.create(CWD);
  const { session } = await createAgentSession(sessionOptions(sm));
  const id = session.sessionId;
  activeSessions.set(id, { session, sessionManager: sm });
  return activeSessions.get(id);
}

async function openSession(sessionPath) {
  const sm = SessionManager.open(sessionPath);
  const { session, modelFallbackMessage } = await createAgentSession(sessionOptions(sm));
  const id = session.sessionId;
  activeSessions.set(id, { session, sessionManager: sm });
  return { id, modelFallbackMessage };
}

// ── Router ─────────────────────────────────────────────────────────────────

const server = http.createServer(async (req, res) => {
  // The UI and API are same-origin. Do not add wildcard CORS headers here:
  // this server has no authentication and should not be callable by arbitrary
  // websites. Put a reverse proxy in front for cross-origin/remote use.
  const url = new URL(req.url, `http://localhost:${PORT}`);
  const p = url.pathname;

  // ── API: Health ──────────────────────────────────────────────────────
  if (p === '/api/health' && req.method === 'GET') {
    const available = await refreshModelRegistry().getAvailable();
    sendJSON(res, 200, {
      status: 'ok',
      modelsAvailable: available.length,
      activeSessions: activeSessions.size,
    });
    return;
  }

  // ── API: List models ───────────────────────────────────────────────
  if (p === '/api/models' && req.method === 'GET') {
    try {
      const available = await refreshModelRegistry().getAvailable();
      const grouped = {};
      for (const m of available) {
        const provider = m.provider || 'unknown';
        if (!grouped[provider]) grouped[provider] = [];
        grouped[provider].push({
          id: m.id,
          name: m.name || m.id,
          reasoning: m.reasoning || false,
          input: m.input || ['text'],
          contextWindow: m.contextWindow || 128000,
          maxTokens: m.maxTokens || 16384,
          cost: m.cost || { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
        });
      }
      sendJSON(res, 200, {
        models: available.length,
        grouped,
        all: available.map(m => ({
          provider: m.provider,
          id: m.id,
          name: m.name || m.id,
          reasoning: m.reasoning || false,
          input: m.input || ['text'],
        })),
      });
    } catch (err) {
      sendJSON(res, 500, { error: err.message });
    }
    return;
  }

  // ── API: List slash commands for a session ──────────────────────────
  if (p === '/api/commands' && req.method === 'GET') {
    try {
      const sid = url.searchParams.get('sessionId');
      let entry = sid ? activeSessions.get(sid) : null;

      if (!entry && sid) {
        try {
          const sessions = await SessionManager.list(CWD);
          const found = sessions.find(s => s.id === sid);
          if (found) {
            const { id } = await openSession(found.path);
            entry = activeSessions.get(id);
          }
        } catch {}
      }

      const commands = WEB_BUILTIN_COMMANDS.map(c => ({ ...c, source: 'builtin' }));
      const seen = new Set(commands.map(c => c.name));

      if (entry) {
        const { session } = entry;

        // File-based prompt templates (/name)
        for (const template of session.promptTemplates) {
          if (!template?.name || seen.has(template.name)) continue;
          seen.add(template.name);
          commands.push({
            name: template.name,
            description: template.description || '',
            argumentHint: template.argumentHint || '',
            scope: template.sourceInfo?.scope || '',
            source: 'prompt',
          });
        }

        // Commands registered by extensions (/name)
        try {
          for (const cmd of session.extensionRunner.getRegisteredCommands()) {
            const name = cmd.invocationName || cmd.name;
            if (!name || seen.has(name)) continue;
            seen.add(name);
            commands.push({
              name,
              description: cmd.description || '',
              scope: cmd.sourceInfo?.scope || '',
              source: 'extension',
            });
          }
        } catch {}

        // Skills (/skill:name)
        try {
          if (session.settingsManager.getEnableSkillCommands()) {
            for (const skill of session.resourceLoader.getSkills().skills) {
              const name = `skill:${skill.name}`;
              if (!skill?.name || seen.has(name)) continue;
              seen.add(name);
              commands.push({
                name,
                description: skill.description || '',
                scope: skill.sourceInfo?.scope || '',
                source: 'skill',
              });
            }
          }
        } catch {}
      }

      sendJSON(res, 200, { commands });
    } catch (err) {
      sendJSON(res, 500, { error: err.message });
    }
    return;
  }

  // ── API: List sessions ───────────────────────────────────────────────
  if (p === '/api/sessions' && req.method === 'GET') {
    try {
      const sessions = await SessionManager.list(CWD);
      const formatted = sessions.map(s => ({
        id: s.id || s.sessionId,
        file: s.file || s.sessionFile,
        label: s.name || '',
        firstMessage: stripAttachmentMarkers(s.firstMessage || '').replace(/\s+/g, ' ').slice(0, 160),
        messageCount: s.messageCount || 0,
        cwd: s.cwd || CWD,
        updatedAt: s.updatedAt || s.mtime,
      }));
      sendJSON(res, 200, formatted);
    } catch (err) {
      sendJSON(res, 500, { error: err.message });
    }
    return;
  }

  // ── API: Create session ──────────────────────────────────────────────
  if (p === '/api/sessions' && req.method === 'POST') {
    try {
      const entry = await getOrCreateSession(null);
      const msgs = formatMessages(entry.session.messages || []);
      sendJSON(res, 201, { sessionId: entry.session.sessionId, messages: msgs });
    } catch (err) {
      sendJSON(res, 500, { error: err.message });
    }
    return;
  }

  // ── API: Get session info ────────────────────────────────────────────
  const sessionMatch = p.match(/^\/api\/sessions\/([^/]+)$/);
  if (sessionMatch && req.method === 'GET') {
    try {
      let entry = activeSessions.get(sessionMatch[1]);
      if (!entry) {
        // Try to load from file
        const sessions = await SessionManager.list(CWD);
        const found = sessions.find(s => s.id === sessionMatch[1]);
        if (!found) { sendJSON(res, 404, { error: 'Session not found' }); return; }
        const { id } = await openSession(found.path);
        entry = activeSessions.get(id);
      }
      const msgs = formatMessages(entry.session.messages || []);
      const m = entry.session.model;
      sendJSON(res, 200, {
        sessionId: entry.session.sessionId,
        messages: msgs,
        isStreaming: entry.session.isStreaming,
        model: m?.name || m?.id || 'unknown',
        currentModel: m ? { provider: m.provider, id: m.id, name: m.name || m.id, input: m.input || ['text'] } : null,
      });
    } catch (err) {
      sendJSON(res, 500, { error: err.message });
    }
    return;
  }

  // ── API: Set model for session ──────────────────────────────────────
  const modelMatch = p.match(/^\/api\/sessions\/([^/]+)\/model$/);
  if (modelMatch && req.method === 'POST') {
    const body = await parseBody(req);
    const { provider, modelId } = body;
    if (!provider && !modelId) {
      sendJSON(res, 400, { error: 'provider and modelId are required' });
      return;
    }
    try {
      let entry = activeSessions.get(modelMatch[1]);
      if (!entry) {
        // Try to load from file
        const sessions = await SessionManager.list(CWD);
        const found = sessions.find(s => s.id === modelMatch[1]);
        if (!found) { sendJSON(res, 404, { error: 'Session not found' }); return; }
        const { id } = await openSession(found.path);
        entry = activeSessions.get(id);
      }
      const model = refreshModelRegistry().find(provider, modelId);
      if (!model) {
        sendJSON(res, 404, { error: `Model not found: ${provider}/${modelId}` });
        return;
      }
      await entry.session.setModel(model);
      sendJSON(res, 200, {
        success: true,
        model: { provider: model.provider, id: model.id, name: model.name || model.id, input: model.input || ['text'] },
      });
    } catch (err) {
      sendJSON(res, 500, { error: err.message });
    }
    return;
  }

  // ── API: Upload an attachment ────────────────────────────────────────
  if (p === '/api/uploads' && req.method === 'POST') {
    try {
      const buffer = await readRawBody(req);
      if (!buffer.length) {
        sendJSON(res, 400, { error: 'Empty upload' });
        return;
      }

      let name = 'attachment';
      const rawName = req.headers['x-file-name'];
      if (rawName) {
        try { name = decodeURIComponent(String(rawName)); } catch { name = String(rawName); }
      }
      name = sanitizeFileName(name);

      const headerType = String(req.headers['content-type'] || '').split(';')[0].trim().toLowerCase();
      const sniffed = sniffImageMime(buffer);
      const imageMime = IMAGE_MIME.has(sniffed) ? sniffed : '';
      let kind = 'file';
      let mimeType = headerType && headerType !== 'application/octet-stream' ? headerType : mimeForName(name);
      let data;
      let inlineMime;
      let text;
      let truncated = false;

      if (imageMime) {
        kind = 'image';
        mimeType = imageMime;
        data = buffer.length <= MAX_IMAGE_BYTES ? buffer.toString('base64') : undefined;
        inlineMime = imageMime;
        if (buffer.length > 300 * 1024) {
          try {
            const resized = await resizeImage(buffer, imageMime, {
              maxWidth: 2000,
              maxHeight: 2000,
              maxBytes: MAX_IMAGE_BYTES,
              jpegQuality: 85,
            });
            if (resized) {
              data = resized.data;
              inlineMime = resized.mimeType;
            }
          } catch {
            // Keep the original if the resizer is unavailable; the prompt route
            // will refuse it if it is too large to send inline.
          }
        }
      } else if (isTextAttachment(buffer, headerType, name)) {
        kind = 'text';
        mimeType = headerType.startsWith('text/') || headerType === 'application/json' || headerType === 'application/xml'
          ? headerType
          : mimeForName(name);
        const full = buffer.toString('utf8');
        text = full.slice(0, TEXT_INLINE_LIMIT);
        truncated = full.length > TEXT_INLINE_LIMIT;
      }

      const id = randomUUID();
      const stored = `${id}-${name}`;
      const filePath = path.join(UPLOAD_DIR, stored);
      await fs.promises.writeFile(filePath, buffer);
      await fs.promises.writeFile(`${filePath}.meta.json`, JSON.stringify({ name, mimeType, kind, size: buffer.length }));

      sendJSON(res, 201, {
        id,
        name,
        mimeType,
        size: buffer.length,
        kind,
        url: `/api/uploads/${encodeURIComponent(stored)}`,
        path: filePath,
        data,
        inlineMime,
        text,
        truncated,
        inline: Boolean(data),
      });
    } catch (err) {
      sendJSON(res, /too large/i.test(err.message) ? 413 : 500, { error: err.message });
    }
    return;
  }

  // ── API: Serve an uploaded attachment ────────────────────────────────
  if (p.startsWith('/api/uploads/') && req.method === 'GET') {
    let name = '';
    try { name = decodeURIComponent(p.slice('/api/uploads/'.length)); } catch {}
    if (!name || name.endsWith('.meta.json') || name !== path.basename(name) || name.includes('\\') || name.includes('..')) {
      sendJSON(res, 400, { error: 'Invalid attachment path' });
      return;
    }
    const filePath = path.join(UPLOAD_DIR, name);
    if (!filePath.startsWith(UPLOAD_DIR + path.sep)) {
      sendJSON(res, 403, { error: 'Forbidden' });
      return;
    }
    fs.readFile(filePath, async (err, contents) => {
      if (err) {
        sendJSON(res, 404, { error: 'Attachment not found' });
        return;
      }
      let meta = {};
      try { meta = JSON.parse(await fs.promises.readFile(`${filePath}.meta.json`, 'utf8')); } catch {}
      const kind = meta.kind || (mimeForName(name).startsWith('image/') ? 'image' : 'file');
      // Only decoded images are served inline. Text is served as plain text so
      // an uploaded HTML/SVG file cannot run same-origin script; binaries are
      // downloads for the same reason.
      const mimeType = kind === 'image' ? (meta.mimeType || mimeForName(name)) : kind === 'text' ? 'text/plain; charset=utf-8' : 'application/octet-stream';
      const disposition = kind === 'file' ? 'attachment' : 'inline';
      res.writeHead(200, {
        'Content-Type': mimeType,
        'Content-Length': contents.length,
        'Content-Disposition': `${disposition}; filename*=UTF-8''${encodeURIComponent(meta.name || name)}`,
        'X-Content-Type-Options': 'nosniff',
      });
      res.end(contents);
    });
    return;
  }

  // ── API: Send prompt (SSE stream) ────────────────────────────────────
  const promptMatch = p.match(/^\/api\/sessions\/([^/]+)\/prompt$/);
  if (promptMatch && req.method === 'POST') {
    const body = await parseBody(req);
    const message = String(body.message || body.prompt || '');
    const rawImages = Array.isArray(body.images) ? body.images : [];
    const images = rawImages.slice(0, MAX_IMAGES_PER_MESSAGE).map((img) => {
      const data = String(img?.data || img?.source?.data || '').replace(/^data:[^;]+;base64,/, '');
      const mimeType = String(img?.mimeType || img?.source?.mediaType || '').toLowerCase();
      if (!data || !IMAGE_MIME.has(mimeType)) return null;
      // Keep the request inside provider inline-image limits.
      if (data.length > Math.ceil(MAX_IMAGE_BYTES * 4 / 3) + 1024) return null;
      return { type: 'image', data, mimeType };
    }).filter(Boolean);

    if (!message.trim() && images.length === 0) {
      sendJSON(res, 400, { error: 'Message is required' });
      return;
    }

    let entry = activeSessions.get(promptMatch[1]);
    if (!entry) { sendJSON(res, 404, { error: 'Session not found' }); return; }

    const { session } = entry;

    // Setup SSE
    res.writeHead(200, {
      'Content-Type': 'text/event-stream; charset=utf-8',
      'Cache-Control': 'no-cache',
      'Connection': 'keep-alive',
      'X-Accel-Buffering': 'no',
    });

    function send(event, data) {
      if (res.writableEnded) return;
      if (event) res.write(`event: ${event}\n`);
      res.write(`data: ${JSON.stringify(data)}\n\n`);
    }

    if (images.length > 0 && Array.isArray(session.model?.input) && !session.model.input.includes('image')) {
      send('warning', { message: 'The selected model does not declare image input; attached images may be ignored. Choose a vision model to read them.' });
    }

    // Track streaming state
    let currentToolName = '';
    let thinkingBlock = false;

    const unsub = session.subscribe((event) => {
      if (res.writableEnded) return;

      switch (event.type) {
        case 'message_update': {
          const me = event.assistantMessageEvent;
          if (me.type === 'text_delta') {
            send('text', { delta: me.delta });
          } else if (me.type === 'thinking_delta') {
            if (!thinkingBlock) {
              thinkingBlock = true;
              send('thinking_start', {});
            }
            send('thinking', { delta: me.delta });
          }
          break;
        }

        case 'tool_execution_start':
          currentToolName = event.toolName || 'unknown';
          thinkingBlock = false;
          send('tool_start', {
            toolCallId: event.toolCallId,
            toolName: event.toolName,
            input: event.args ?? event.input ?? {},
          });
          break;

        case 'tool_execution_update':
          // partialResult is cumulative: it contains all output so far.
          send('tool_update', {
            toolCallId: event.toolCallId,
            output: extractToolOutput(event.partialResult ?? event.output ?? event.delta),
          });
          break;

        case 'tool_execution_end':
          send('tool_end', {
            toolCallId: event.toolCallId,
            isError: event.isError || false,
            output: extractToolOutput(event.result ?? event.output),
            details: event.result?.details ?? event.details ?? {},
          });
          currentToolName = '';
          break;

        case 'message_start':
          thinkingBlock = false;
          send('message_start', {});
          break;

        case 'message_end':
          send('message_end', {
            usage: formatUsage(event.message?.usage),
            timestamp: event.message?.timestamp || null,
          });
          break;

        case 'agent_start':
          send('agent_start', {});
          break;

        case 'agent_end':
          send('agent_end', {
            messages: formatMessages(event.messages || session.messages || []),
          });
          break;

        case 'turn_start':
          send('turn_start', {});
          break;

        case 'turn_end':
          send('turn_end', {
            toolResults: event.toolResults || [],
          });
          break;

        default:
          break;
      }
    });

    try {
      const promptOptions = {
        expandPromptTemplates: true,
      };
      if (images.length > 0) {
        promptOptions.images = images;
      }
      if (session.isStreaming) {
        promptOptions.streamingBehavior = body.streamingBehavior || 'steer';
      }

      startKeepAwake();
      await session.prompt(message, promptOptions);
      send('done', {});
    } catch (err) {
      send('error', { error: err.message });
    } finally {
      stopKeepAwake();
      unsub();
      if (!res.writableEnded) res.end();
    }

    // Handle client disconnect
    req.on('close', () => {
      unsub();
    });

    return;
  }

  // ── API: Compact a session ──────────────────────────────────────────
  const compactMatch = p.match(/^\/api\/sessions\/([^/]+)\/compact$/);
  if (compactMatch && req.method === 'POST') {
    const entry = activeSessions.get(compactMatch[1]);
    if (!entry) { sendJSON(res, 404, { error: 'Session not found' }); return; }
    try {
      const body = await parseBody(req);
      const result = await entry.session.compact(body.instructions || undefined);
      sendJSON(res, 200, {
        success: true,
        summary: result?.summary || '',
        tokensBefore: result?.tokensBefore ?? null,
      });
    } catch (err) {
      sendJSON(res, 500, { error: err.message });
    }
    return;
  }

  // ── API: Abort ───────────────────────────────────────────────────────
  const abortMatch = p.match(/^\/api\/sessions\/([^/]+)\/abort$/);
  if (abortMatch && req.method === 'POST') {
    const entry = activeSessions.get(abortMatch[1]);
    if (!entry) { sendJSON(res, 404, { error: 'Session not found' }); return; }
    try {
      await entry.session.abort();
      sendJSON(res, 200, { success: true });
    } catch (err) {
      sendJSON(res, 500, { error: err.message });
    }
    return;
  }

  // ── API: Delete session ──────────────────────────────────────────────
  const deleteMatch = p.match(/^\/api\/sessions\/([^/]+)$/);
  if (deleteMatch && req.method === 'DELETE') {
    const sid = deleteMatch[1];
    const entry = activeSessions.get(sid);
    if (entry) {
      try { entry.session.dispose(); } catch {}
      activeSessions.delete(sid);
    }
    // Also try to delete the file
    try {
      const sessions = await SessionManager.list(CWD);
      const found = sessions.find(s => s.id === sid);
      if (found) {
        if (found.path) fs.unlinkSync(found.path);
      }
    } catch {}
    sendJSON(res, 200, { success: true });
    return;
  }

  // ── Static files / SPA fallback ──────────────────────────────────────
  serveStatic(res, p);
});

server.listen(PORT, HOST, () => {
  const displayHost = HOST === '0.0.0.0' || HOST === '::' ? 'localhost' : HOST;
  console.log(`\n  🚀 pi Web UI running at http://${displayHost}:${PORT}\n`);
  console.log(`  Listening on: ${HOST}:${PORT}`);
  console.log(`  Sessions directory: ${CWD}\n`);

  if (HOST !== '127.0.0.1' && HOST !== 'localhost' && HOST !== '::1') {
    console.warn('  ⚠️  No authentication is enabled. Use a trusted network or a reverse proxy.\n');
  }
});
