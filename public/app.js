// ── Theme ───────────────────────────────────────────────────────────────────
const THEME_KEY = 'pi-web-theme';

function getTheme() {
  const saved = localStorage.getItem(THEME_KEY);
  if (saved === 'light' || saved === 'dark') return saved;
  return window.matchMedia('(prefers-color-scheme: light)').matches ? 'light' : 'dark';
}

function applyTheme(theme) {
  document.documentElement.setAttribute('data-theme', theme);
  localStorage.setItem(THEME_KEY, theme);
}

function toggleTheme() {
  const current = document.documentElement.getAttribute('data-theme') || 'dark';
  const next = current === 'dark' ? 'light' : 'dark';
  applyTheme(next);
}

// ── State ──────────────────────────────────────────────────────────────────
const state = {
  sessionId: null,
  currentModel: null,    // { provider, id, name }
  currentStream: null,   // AbortController for fetch
  isStreaming: false,
  messages: [],          // { id, role, content, toolCalls, thinking, images, timestamp }
  pendingAttachments: [], // attachments uploaded or uploading for the next message
  uploading: 0,
  commands: null,        // slash commands for the current session
  commandsSessionId: null,
  modelsData: null,      // cached /api/models response
  sessionPickerSessions: [],
  slash: {
    open: false,
    mode: 'commands',    // commands | models | skills | prompts
    query: '',
    key: '',
    items: [],
    selected: 0,
    loading: false,
  },
};

const $ = (sel, el = document) => el.querySelector(sel);
const $$ = (sel, el = document) => [...el.querySelectorAll(sel)];

// ── DOM refs ──────────────────────────────────────────────────────────────
const chatMessages = $('#chatMessages');
const promptInput = $('#promptInput');
const btnSend = $('#btnSend');
const btnAbort = $('#btnAbort');
const btnNewChat = $('#btnNewChat');
const sessionList = $('#sessionList');
const sidebarModel = $('#sidebarModel');
const attachmentTray = $('#attachmentTray');
const fileInput = $('#fileInput');
const btnAttach = $('#btnAttach');
const chatInputContainer = $('#chatInputContainer');
const slashMenu = $('#slashMenu');
const sessionModal = $('#sessionModal');
const sessionPickerList = $('#sessionPickerList');
const sessionSearch = $('#sessionSearch');

const MAX_ATTACHMENTS = 8;
const MAX_ATTACHMENT_BYTES = 25 * 1024 * 1024;

// ── API helpers ───────────────────────────────────────────────────────────

async function api(method, path, body) {
  const opts = {
    method,
    headers: { 'Content-Type': 'application/json' },
  };
  if (body) opts.body = JSON.stringify(body);

  const res = await fetch(path, opts);
  if (!res.ok) {
    const err = await res.json().catch(() => ({ error: res.statusText }));
    throw new Error(err.error || `HTTP ${res.status}`);
  }
  return res;
}

async function apiJSON(method, path, body) {
  const res = await api(method, path, body);
  return res.json();
}

// ── Attachments ───────────────────────────────────────────────────────────

function formatBytes(bytes) {
  if (!Number.isFinite(bytes)) return '';
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(bytes < 10 * 1024 ? 1 : 0)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

function attachmentIsImage(a) {
  return Boolean(a) && (a.kind === 'image' || (a.kind !== 'text' && String(a.mimeType || '').startsWith('image/')));
}

function attachmentLabel(a) {
  if (!a) return 'file';
  if (attachmentIsImage(a)) return 'image';
  return a.kind === 'text' ? 'text' : 'file';
}

function escapeAttr(value) {
  return escapeHtml(String(value ?? ''));
}

async function uploadAttachment(file) {
  const res = await fetch('/api/uploads', {
    method: 'POST',
    headers: {
      'Content-Type': file.type || 'application/octet-stream',
      'X-File-Name': encodeURIComponent(file.name || 'attachment'),
    },
    body: file,
  });
  if (!res.ok) {
    const err = await res.json().catch(() => ({ error: res.statusText }));
    throw new Error(err.error || 'Upload failed');
  }
  return res.json();
}

async function addFiles(fileList) {
  const files = [...fileList].filter(Boolean);
  if (!files.length) return;

  const room = MAX_ATTACHMENTS - state.pendingAttachments.length;
  if (room <= 0) {
    showError(`You can attach at most ${MAX_ATTACHMENTS} files per message.`);
    return;
  }
  const accepted = files.slice(0, room);
  if (files.length > room) {
    showError(`Only ${room} more file${room === 1 ? '' : 's'} can be attached.`);
  }

  for (const file of accepted) {
    if (file.size > MAX_ATTACHMENT_BYTES) {
      showError(`${file.name || 'This file'} is larger than 25 MB.`);
      continue;
    }
    const local = {
      id: 'upload_' + Math.random().toString(36).slice(2) + Date.now(),
      name: file.name || 'attachment',
      size: file.size,
      mimeType: file.type || 'application/octet-stream',
      kind: String(file.type || '').startsWith('image/') ? 'image' : 'file',
      uploading: true,
      preview: String(file.type || '').startsWith('image/') ? URL.createObjectURL(file) : '',
      text: '',
    };
    state.pendingAttachments.push(local);
    state.uploading += 1;
    renderAttachmentTray();
    updateSendState();

    uploadAttachment(file).then((data) => {
      if (!state.pendingAttachments.includes(local)) return;
      const oldPreview = local.preview;
      Object.assign(local, data, { uploading: false });
      local.preview = attachmentIsImage(local) ? (local.url || oldPreview) : '';
      if (oldPreview && oldPreview.startsWith('blob:') && local.preview !== oldPreview) {
        URL.revokeObjectURL(oldPreview);
      }
      renderAttachmentTray();
    }).catch((err) => {
      const index = state.pendingAttachments.indexOf(local);
      if (index >= 0) state.pendingAttachments.splice(index, 1);
      showError(`Could not attach ${local.name}: ${err.message}`);
    }).finally(() => {
      state.uploading = Math.max(0, state.uploading - 1);
      renderAttachmentTray();
      updateSendState();
    });
  }
}

function renderAttachmentTray() {
  const items = state.pendingAttachments;
  attachmentTray.classList.toggle('hidden', items.length === 0);
  if (!items.length) {
    attachmentTray.innerHTML = '';
    return;
  }

  const imageWarning = items.some(attachmentIsImage) &&
    state.currentModel && Array.isArray(state.currentModel.input) &&
    !state.currentModel.input.includes('image');

  attachmentTray.innerHTML = items.map((a) => {
    const name = escapeHtml(a.name || 'attachment');
    const meta = `${escapeHtml(a.mimeType || '')}${a.size ? ' · ' + formatBytes(a.size) : ''}`;
    const preview = attachmentIsImage(a) && a.preview
      ? `<img class="attachment-thumb" src="${escapeAttr(a.preview)}" alt="">`
      : `<span class="attachment-icon">${a.kind === 'text' ? '📄' : a.kind === 'image' ? '🖼️' : '📎'}</span>`;
    return `<div class="attachment-chip${a.uploading ? ' uploading' : ''}">
      ${preview}
      <span class="attachment-copy">
        <span class="attachment-name" title="${escapeAttr(a.path || a.name)}">${name}</span>
        <span class="attachment-meta">${a.uploading ? 'Uploading…' : meta}</span>
      </span>
      ${a.uploading ? '<span class="attachment-spinner" aria-label="Uploading"></span>' : `
        <button class="attachment-btn ref" data-act="ref" data-id="${escapeAttr(a.id)}" title="Reference this file in the message" aria-label="Reference ${name}">@</button>
        <button class="attachment-btn remove" data-act="remove" data-id="${escapeAttr(a.id)}" title="Remove" aria-label="Remove ${name}">×</button>`}
    </div>`;
  }).join('') + (imageWarning
    ? '<div class="attachment-warning" title="Choose a vision model to read images">Images may not be read by this model</div>'
    : '');
}

function updateSendState() {
  const hasContent = promptInput.value.trim().length > 0 || state.pendingAttachments.length > 0;
  btnSend.disabled = state.isStreaming || state.uploading > 0 || !hasContent;
}

function insertAttachmentReference(name) {
  const start = promptInput.selectionStart ?? promptInput.value.length;
  const end = promptInput.selectionEnd ?? start;
  const before = promptInput.value.slice(0, start);
  const token = `${before && !/\s/.test(before.slice(-1)) ? ' ' : ''}@${/\s/.test(name) ? `"${name}"` : name} `;
  promptInput.setRangeText(token, start, end, 'end');
  promptInput.focus();
  autoResize();
  updateSendState();
}

function buildAttachmentMessage(text, attachments) {
  if (!attachments.length) return text;
  const meta = attachments.map((a) => ({
    id: a.id,
    name: a.name,
    mimeType: a.mimeType,
    size: a.size,
    kind: a.kind,
    url: a.url || '',
    path: a.path || '',
    truncated: Boolean(a.truncated),
    inline: a.kind === 'image' ? Boolean(a.data) : true,
  }));
  const lines = attachments.map((a, index) => {
    const where = a.kind === 'image'
      ? (a.data ? 'image attached inline' : 'image saved as a file (too large to inline)')
      : a.kind === 'text'
        ? 'text contents below'
        : 'file saved for the agent';
    return `${index + 1}. ${attachmentLabel(a)}: ${a.name} (${a.mimeType || 'application/octet-stream'}, ${formatBytes(a.size)}) — ${where}${a.path ? ` · ${a.path}` : ''}`;
  });

  let fileContents = '';
  for (const a of attachments) {
    if (a.kind === 'text' && a.text) {
      fileContents += `<pi-web-content id="${escapeAttr(a.id)}">\n<file name="${escapeAttr(a.path || a.name)}">\n${a.text}\n${a.truncated ? '\n[Content truncated; the full file is at the path above.]\n' : ''}</file>\n</pi-web-content>\n\n`;
    }
  }

  const marker = JSON.stringify(meta)
    .replace(/</g, '\\u003c')
    .replace(/>/g, '\\u003e')
    .replace(/--/g, '\\u002d\\u002d');

  return `<pi-web-attachments>${marker}</pi-web-attachments>\n[Attached files]\n${lines.join('\n')}\n[End attachments]\n\n${String(text || '').trim()}\n\n${fileContents}`.trim();
}

function parseAttachmentMessage(content) {
  let text = String(content || '');
  let attachments = [];
  const marker = text.match(/<pi-web-attachments>([\s\S]*?)<\/pi-web-attachments>/);
  if (marker) {
    try {
      const parsed = JSON.parse(marker[1]);
      const list = Array.isArray(parsed) ? parsed : parsed && parsed.files;
      if (Array.isArray(list)) attachments = list;
    } catch {}
    text = text.replace(marker[0], '');
  }
  text = text.replace(/<pi-web-content\b[\s\S]*?<\/pi-web-content>/g, '');
  text = text.replace(/\[Attached files\][\s\S]*?\[End attachments\]/g, '');
  return { text: text.replace(/\n{3,}/g, '\n\n').trim(), attachments };
}

function renderMessageAttachments(attachments, images) {
  let list = Array.isArray(attachments) ? attachments.filter(Boolean) : [];
  if (!list.length && Array.isArray(images) && images.length) {
    list = images.map((img, index) => ({
      id: `image-${index}`,
      name: `image-${index + 1}`,
      mimeType: img.mimeType,
      kind: 'image',
      url: img.dataUrl || (img.data ? `data:${img.mimeType};base64,${img.data}` : ''),
    }));
  }
  if (!list.length) return '';

  const cards = list.map((a) => {
    const name = escapeHtml(a.name || 'attachment');
    const meta = `${escapeHtml(a.mimeType || '')}${a.size ? ' · ' + formatBytes(a.size) : ''}`;
    const href = escapeAttr(a.url || '#');
    const title = escapeAttr(a.path || a.name || '');
    if (attachmentIsImage(a) && a.url) {
      return `<a class="msg-attachment image" href="${href}" target="_blank" rel="noopener noreferrer" title="${title}">
        <img src="${href}" alt="${name}" loading="lazy">
        <span class="msg-attachment-info"><span class="msg-attachment-name">${name}</span><span class="msg-attachment-meta">${meta}</span></span>
      </a>`;
    }
    return `<a class="msg-attachment" href="${href}" target="_blank" rel="noopener noreferrer" title="${title}">
      <span class="file-icon">${a.kind === 'text' ? '📄' : '📎'}</span>
      <span class="msg-attachment-info"><span class="msg-attachment-name">${name}</span><span class="msg-attachment-meta">${meta}</span></span>
    </a>`;
  }).join('');

  return `<div class="msg-attachments">${cards}</div>`;
}

function showNotice(message) {
  const div = document.createElement('div');
  div.className = 'msg-warning';
  div.textContent = message;
  chatMessages.appendChild(div);
  scrollToBottom();
  setTimeout(() => div.remove(), 9000);
}

// ── Simple Markdown Renderer ──────────────────────────────────────────────

function escapeHtml(text) {
  const map = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };
  return text.replace(/[&<>"']/g, c => map[c]);
}

function renderMarkdown(text) {
  if (!text) return '';

  // Extract code blocks to protect them
  const codeBlocks = [];
  let processed = text.replace(/```(\w*)\n?([\s\S]*?)```/g, (_, lang, code) => {
    const idx = codeBlocks.length;
    const langLabel = lang ? `<span class="code-header">${escapeHtml(lang)}<button class="copy-btn" data-code="${idx}">Copy</button></span>` : '';
    codeBlocks.push({ lang: lang || '', code: code.trimEnd() });
    return `\x00CODEBLOCK${idx}\x00`;
  });

  // Tables (extract before inline processing so cell content stays raw)
  const tables = [];
  processed = processed.replace(
    /^\|(.+)\|\n\|([-:| ]+)\|\n(?:\|.+\|\n?)+/gm,
    (match) => {
      const idx = tables.length;
      const lines = match.split('\n').filter(l => l.trim());
      tables.push(lines);
      return `\x00TABLE${idx}\x00`;
    }
  );

  // Inline code: use placeholders so the bold/italic pass below cannot
  // escape the generated <code> tags and leak them as visible text.
  const inlineCodes = [];
  processed = processed.replace(/`([^`]+)`/g, (_, code) => {
    const idx = inlineCodes.length;
    inlineCodes.push(escapeHtml(code));
    return `\x00INLINECODE${idx}\x00`;
  });

  // Bold
  processed = processed.replace(/\*\*([^*]+)\*\*/g, (_, text) =>
    `<strong>${escapeHtml(text)}</strong>`
  );

  // Italic
  processed = processed.replace(/\*([^*]+)\*/g, (_, text) =>
    `<em>${escapeHtml(text)}</em>`
  );

  // Headers
  processed = processed.replace(/^#### (.+)$/gm, '<h4>$1</h4>');
  processed = processed.replace(/^### (.+)$/gm, '<h3>$1</h3>');
  processed = processed.replace(/^## (.+)$/gm, '<h2>$1</h2>');
  processed = processed.replace(/^# (.+)$/gm, '<h1>$1</h1>');

  // Blockquotes
  processed = processed.replace(/^&gt; (.+)$/gm, '<blockquote>$1</blockquote>');

  // Horizontal rules
  processed = processed.replace(/^---$/gm, '<hr>');

  // Unordered lists
  processed = processed.replace(/^[*-] (.+)$/gm, '<li>$1</li>');
  // Wrap consecutive <li> in <ul>
  processed = processed.replace(/((?:<li>.*<\/li>\n?)+)/g, '<ul>$1</ul>');

  // Ordered lists
  processed = processed.replace(/^\d+\. (.+)$/gm, '<li>$1</li>');
  processed = processed.replace(/((?:<li>.*<\/li>\n?)+)/g, (match) => {
    if (match.includes('<ul>')) return match; // already wrapped
    return `<ol>${match}</ol>`;
  });

  // Paragraphs: wrap remaining text blocks in <p>
  processed = processed.replace(/\n\n+/g, '</p><p>');
  processed = '<p>' + processed + '</p>';
  // Clean empty paragraphs
  processed = processed.replace(/<p>\s*<\/p>/g, '');
  // Clean nested <p> inside block elements
  processed = processed.replace(/<(h[1-6]|ul|ol|blockquote|pre|hr)[^>]*><\/p>/g, '<$1>');
  processed = processed.replace(/<p><\/(h[1-6]|ul|ol|blockquote)>/g, '</$1>');
  // Strip <p> wrapping around table placeholders
  processed = processed.replace(/<p>\x00TABLE(\d+)\x00<\/p>/g, '\x00TABLE$1\x00');

  // Restore tables
  processed = processed.replace(/\x00TABLE(\d+)\x00/g, (_, idx) => {
    const lines = tables[parseInt(idx)];
    return renderTable(lines);
  });

  // Restore code blocks
  processed = processed.replace(/\x00CODEBLOCK(\d+)\x00/g, (_, idx) => {
    const block = codeBlocks[parseInt(idx)];
    const header = block.lang
      ? `<div class="code-header"><span>${escapeHtml(block.lang)}</span><button class="copy-btn" data-code="${encodeURIComponent(block.code)}">Copy</button></div>`
      : '';
    return `${header}<pre><code>${escapeHtml(block.code)}</code></pre>`;
  });

  // Restore inline code after all tag-generating passes.
  processed = processed.replace(/\x00INLINECODE(\d+)\x00/g, (_, idx) =>
    `<code>${inlineCodes[parseInt(idx)]}</code>`
  );

  return processed;
}

function renderInline(text) {
  // Safe inline markdown rendering for table cells
  let result = escapeHtml(text);
  // Inline code: protect with placeholders until after bold/italic so the
  // generated <code> tags are not escaped into visible text.
  const inlineCodes = [];
  result = result.replace(/`([^`]+)`/g, (_, code) => {
    const idx = inlineCodes.length;
    inlineCodes.push(code);
    return `\x00INLINECODE${idx}\x00`;
  });
  // Bold
  result = result.replace(/\*\*([^*]+)\*\*/g, (_, t) => `<strong>${escapeHtml(t)}</strong>`);
  // Italic
  result = result.replace(/\*([^*]+)\*/g, (_, t) => `<em>${escapeHtml(t)}</em>`);
  result = result.replace(/\x00INLINECODE(\d+)\x00/g, (_, idx) => `<code>${inlineCodes[parseInt(idx)]}</code>`);
  return result;
}

function renderTable(lines) {
  if (!lines || lines.length < 2) return '';

  // Parse alignment from delimiter line (second line)
  const delimiterCells = lines[1].split('|').filter(c => c.trim());
  const alignments = delimiterCells.map(cell => {
    const trimmed = cell.trim();
    if (trimmed.startsWith(':') && trimmed.endsWith(':')) return 'center';
    if (trimmed.endsWith(':')) return 'right';
    return 'left';
  });

  let html = '<div class="table-wrapper"><table>';

  // Header row (first line)
  const headerCells = lines[0].split('|').filter(c => c.trim());
  html += '<thead><tr>';
  headerCells.forEach((cell, i) => {
    const align = alignments[i] || 'left';
    html += `<th style="text-align:${align}">${renderInline(cell.trim())}</th>`;
  });
  html += '</tr></thead>';

  // Body rows (from third line onwards)
  if (lines.length > 2) {
    html += '<tbody>';
    for (let r = 2; r < lines.length; r++) {
      const cells = lines[r].split('|').filter(c => c.trim());
      if (cells.length === 0) continue;
      html += '<tr>';
      cells.forEach((cell, i) => {
        const align = alignments[i] || 'left';
        html += `<td style="text-align:${align}">${renderInline(cell.trim())}</td>`;
      });
      html += '</tr>';
    }
    html += '</tbody>';
  }

  html += '</table></div>';
  return html;
}

// ── Message rendering ─────────────────────────────────────────────────────

function renderToolCall(tc, index) {
  let statusClass = 'running';
  let statusText = 'Running...';
  if (tc.result !== null) {
    statusClass = tc.isError ? 'error' : 'success';
    statusText = tc.isError ? 'Error' : 'Done';
  }
  const title = tc.name || 'Tool';
  const output = tc.result !== null ? String(tc.result) : String(tc.pendingOutput || '');
  return `
    <div class="tool-block" data-tool-index="${index}">
      <div class="tool-header" onclick="toggleToolBlock(this)">
        <span class="tool-icon">🔧</span>
        <span class="tool-name">${escapeHtml(title)}</span>
        <span class="tool-status ${statusClass}">${statusText}</span>
        <span class="tool-chevron">▶</span>
      </div>
      <div class="tool-body${tc.result !== null ? '' : ' open'}">
        <pre><code>${escapeHtml(JSON.stringify(tc.input || {}, null, 2))}</code></pre>
        ${output ? `<pre data-type="result"><code>${escapeHtml(output.slice(0, 8000))}</code></pre>` : ''}
      </div>
    </div>`;
}

function renderThinking(thinking) {
  if (!thinking) return '';
  return `
    <div class="thinking-block">
      <div class="thinking-header" onclick="toggleToolBlock(this.parentElement.querySelector('.thinking-body'))">
        <span>💭 Thinking</span>
        <span class="tool-chevron">▶</span>
      </div>
      <div class="thinking-body">
        ${escapeHtml(thinking)}
      </div>
    </div>`;
}

function createMessageElement(msg) {
  const div = document.createElement('div');
  div.className = `msg msg-${msg.role}`;
  div.dataset.id = msg.id;

  const isUser = msg.role === 'user';
  const parsed = isUser ? parseAttachmentMessage(msg.content) : { text: msg.content, attachments: [] };
  const attachmentsHtml = isUser ? renderMessageAttachments(parsed.attachments, msg.images) : '';
  const avatar = isUser ? 'U' : 'P';
  div.innerHTML = `
    <div class="msg-avatar">${avatar}</div>
    <div class="msg-content">
      ${msg.thinking ? renderThinking(msg.thinking) : ''}
      ${msg.toolCalls && msg.toolCalls.length > 0
        ? msg.toolCalls.map((tc, i) => renderToolCall(tc, i)).join('')
        : ''}
      ${attachmentsHtml}
      ${parsed.text ? renderMarkdown(parsed.text) : ''}
    </div>`;

  return div;
}

function appendMessage(msg) {
  const el = createMessageElement(msg);
  chatMessages.appendChild(el);
  scrollToBottom();
  // Attach copy handlers
  el.querySelectorAll('.copy-btn').forEach(btn => {
    btn.addEventListener('click', (e) => {
      e.stopPropagation();
      copyButtonWithFeedback(btn);
    });
  });
  return el;
}

function getLastAssistantEl() {
  const all = $$('.msg-assistant', chatMessages);
  return all[all.length - 1];
}

function scrollToBottom() {
  chatMessages.scrollTop = chatMessages.scrollHeight;
}

function copyToClipboard(text) {
  if (navigator.clipboard) {
    return navigator.clipboard.writeText(text)
      .then(() => true)
      .catch(() => fallbackCopyToClipboard(text));
  }
  return Promise.resolve(fallbackCopyToClipboard(text));
}

function fallbackCopyToClipboard(text) {
  const ta = document.createElement('textarea');
  ta.value = text;
  ta.style.position = 'fixed';
  ta.style.opacity = '0';
  document.body.appendChild(ta);
  ta.select();
  let ok = false;
  try {
    ok = document.execCommand('copy');
  } catch {}
  document.body.removeChild(ta);
  return ok;
}

// Copy the code attached to a button and briefly show a check mark when the
// clipboard write succeeded.
function copyButtonWithFeedback(btn) {
  let code = btn.dataset.code || '';
  try { code = decodeURIComponent(code); } catch {}
  copyToClipboard(code).then((ok) => {
    if (!ok) return;
    clearTimeout(btn._copyFeedbackTimer);
    btn.classList.add('copied');
    btn.textContent = '✓ Copy';
    btn._copyFeedbackTimer = setTimeout(() => {
      btn.classList.remove('copied');
      btn.textContent = 'Copy';
    }, 1500);
  });
}

// ── Tool block toggle ─────────────────────────────────────────────────────

window.toggleToolBlock = function (headerOrBody) {
  let header, body;
  if (headerOrBody.classList.contains('tool-header')) {
    header = headerOrBody;
    body = header.nextElementSibling;
  } else {
    body = headerOrBody;
    header = body.previousElementSibling;
  }
  header.classList.toggle('open');
  body.classList.toggle('open');
};

// ── Session management ────────────────────────────────────────────────────

async function loadSessionList() {
  try {
    const sessions = await apiJSON('GET', '/api/sessions');
    renderSessionList(sessions);
  } catch {
    sessionList.innerHTML = '<div class="session-item" style="opacity:0.5">No sessions yet</div>';
  }
}

function renderSessionList(sessions) {
  if (!sessions || sessions.length === 0) {
    sessionList.innerHTML = '<div class="session-item" style="opacity:0.5">No sessions yet</div>';
    return;
  }
  sessionList.innerHTML = sessions.map(s => {
    const label = s.label || escapeHtml(s.firstMessage || '').slice(0, 50) || s.id.slice(0, 8);
    const active = s.id === state.sessionId ? ' active' : '';
    return `
      <div class="session-item${active}" data-sid="${s.id}" onclick="switchSession('${s.id}')">
        <span class="session-icon">💬</span>
        <span class="session-label" title="${escapeHtml(s.firstMessage || s.id)}">${label}</span>
        <button class="session-delete" onclick="deleteSession(event, '${s.id}')" title="Delete">×</button>
      </div>`;
  }).join('');
}

window.switchSession = async function (sid) {
  if (sid === state.sessionId) return;
  try {
    const data = await apiJSON('GET', `/api/sessions/${sid}`);
    state.sessionId = data.sessionId;
    state.messages = data.messages || [];
    state.isStreaming = data.isStreaming || false;
    state.pendingAttachments = [];
    state.uploading = 0;
    renderAttachmentTray();
    updateSendState();
    renderAllMessages();
    closeSlashMenu();
    invalidateSessionCommands();
    ensureCommands();
    await loadModelInfo();
    await loadSessionList();
    setStreaming(state.isStreaming);
    if (state.isStreaming) {
      showNotice('This session is still generating. It will refresh when finished.');
      appendWorkingMessage();
      startSessionPoll(state.sessionId);
    } else {
      stopSessionPoll();
    }
  } catch (err) {
    console.error('Failed to switch session:', err);
  }
};

window.deleteSession = async function (e, sid) {
  e.stopPropagation();
  if (!confirm('Delete this session?')) return;
  try {
    await api('DELETE', `/api/sessions/${sid}`);
    if (sid === state.sessionId) {
      state.sessionId = null;
      state.messages = [];
      renderAllMessages();
      await createNewSession();
    }
    await loadSessionList();
  } catch (err) {
    console.error('Failed to delete session:', err);
  }
};

async function createNewSession() {
  try {
    const data = await apiJSON('POST', '/api/sessions');
    state.sessionId = data.sessionId;
    state.messages = data.messages || [];
    state.pendingAttachments = [];
    state.uploading = 0;
    stopSessionPoll();
    setStreaming(false);
    renderAttachmentTray();
    updateSendState();
    renderAllMessages();
    closeSlashMenu();
    invalidateSessionCommands();
    ensureCommands();
    await loadSessionList();
    await loadModelInfo();
  } catch (err) {
    console.error('Failed to create session:', err);
    showError('Failed to create session. Check your API key configuration.');
  }
}

// ── Resume session picker ──────────────────────────────────────────────────

async function openSessionPicker() {
  state.sessionPickerSessions = [];
  sessionSearch.value = '';
  sessionPickerList.innerHTML = '<div class="modal-loading">Loading sessions...</div>';
  sessionModal.classList.remove('hidden');
  sessionSearch.focus();

  try {
    const sessions = await apiJSON('GET', '/api/sessions');
    state.sessionPickerSessions = Array.isArray(sessions) ? sessions : [];
    renderSessionPicker();
  } catch (err) {
    sessionPickerList.innerHTML = `<div class="modal-error">Failed to load sessions: ${escapeHtml(err.message)}</div>`;
  }
}

function renderSessionPicker() {
  const query = sessionSearch.value.trim().toLowerCase();
  const sessions = (state.sessionPickerSessions || []).filter((s) => {
    if (!query) return true;
    return `${s.label || ''} ${s.firstMessage || ''} ${s.id || ''}`.toLowerCase().includes(query);
  });

  if (!sessions.length) {
    sessionPickerList.innerHTML = '<div class="modal-empty">No matching sessions</div>';
    return;
  }

  sessionPickerList.innerHTML = sessions.map((s) => {
    const label = s.label || s.firstMessage || String(s.id || '').slice(0, 12);
    const date = s.updatedAt ? new Date(s.updatedAt) : null;
    const updated = date && !Number.isNaN(date.getTime()) ? date.toLocaleString() : '';
    const meta = `${s.messageCount || 0} messages${updated ? ' · ' + updated : ''}`;
    const active = s.id === state.sessionId ? ' active' : '';
    return `<button type="button" class="resume-item${active}" data-sid="${escapeHtml(s.id)}">
      <span class="resume-icon">💬</span>
      <span class="resume-main">
        <span class="resume-label">${escapeHtml(label)}</span>
        <span class="resume-meta">${escapeHtml(meta)}</span>
      </span>
    </button>`;
  }).join('');
}

function closeSessionPicker() {
  sessionModal.classList.add('hidden');
  promptInput.focus();
}

async function loadModelInfo() {
  try {
    const data = await apiJSON('GET', `/api/sessions/${state.sessionId}`);
    const modelName = data.model || 'unknown';
    state.currentModel = data.currentModel || { provider: '', id: modelName, name: modelName };
    sidebarModel.textContent = `Model: ${modelName}`;
    renderAttachmentTray();
  } catch {}
}

// ── Message rendering ─────────────────────────────────────────────────────

function renderAllMessages() {
  // Remove existing messages
  const existing = $$('.msg', chatMessages);
  existing.forEach(el => el.remove());

  // Remove welcome if we have messages
  const welcome = $('.welcome', chatMessages);
  if (welcome && state.messages.length > 0) {
    welcome.remove();
  }

  for (const msg of state.messages) {
    appendMessage(msg);
  }
}

// ── Streaming ─────────────────────────────────────────────────────────────

function setStreaming(streaming) {
  state.isStreaming = streaming;
  btnSend.classList.toggle('hidden', streaming);
  btnAbort.classList.toggle('hidden', !streaming);
  promptInput.disabled = streaming;
  updateSendState();
}

// When returning to a session whose backend is still generating, the original
// SSE connection is attached to DOM nodes that no longer exist. Poll until it
// finishes, then reload the completed messages.
let sessionPollTimer = null;
let sessionPollSid = null;

function stopSessionPoll() {
  if (sessionPollTimer) clearInterval(sessionPollTimer);
  sessionPollTimer = null;
  sessionPollSid = null;
}

function startSessionPoll(sid) {
  stopSessionPoll();
  sessionPollSid = sid;
  sessionPollTimer = setInterval(async () => {
    if (state.sessionId !== sid) {
      stopSessionPoll();
      return;
    }
    try {
      const data = await apiJSON('GET', `/api/sessions/${sid}`);
      if (state.sessionId !== sid) {
        stopSessionPoll();
        return;
      }
      if (!data.isStreaming) {
        stopSessionPoll();
        state.messages = data.messages || [];
        renderAllMessages();
        setStreaming(false);
        await loadSessionList();
      }
    } catch {
      // Transient fetch failures should not freeze the UI; keep polling.
    }
  }, 1000);
}

async function sendPrompt(message) {
  if (state.isStreaming || state.uploading > 0) return;
  const sid = state.sessionId;
  const attachments = state.pendingAttachments.slice();
  if (!message.trim() && attachments.length === 0) return;

  const images = attachments
    .filter((a) => attachmentIsImage(a) && a.data)
    .map((a) => ({ type: 'image', mimeType: a.inlineMime || a.mimeType, data: a.data }));
  const modelMessage = buildAttachmentMessage(message, attachments);

  // Remove welcome
  const welcome = $('.welcome', chatMessages);
  if (welcome) welcome.remove();

  // Add user message to UI and state. The content marker carries the attachment
  // metadata so the cards survive a session reload.
  const userMsg = {
    id: 'user_' + Date.now(),
    role: 'user',
    content: modelMessage,
    images: attachments
      .filter(attachmentIsImage)
      .map((a) => ({ mimeType: a.mimeType, dataUrl: a.url || (a.data ? `data:${a.mimeType};base64,${a.data}` : '') })),
    toolCalls: [],
    thinking: '',
    timestamp: new Date().toISOString(),
  };
  state.messages.push(userMsg);
  appendMessage(userMsg);

  // Clear input and pending attachments
  promptInput.value = '';
  state.pendingAttachments = [];
  renderAttachmentTray();
  autoResize();
  updateSendState();

  // Start streaming
  setStreaming(true);

  // Add placeholder assistant message
  const assistantMsg = {
    id: 'assistant_' + Date.now(),
    role: 'assistant',
    content: '',
    toolCalls: [],
    thinking: '',
    timestamp: new Date().toISOString(),
  };
  state.messages.push(assistantMsg);
  const assistantEl = appendMessage(assistantMsg);
  const msgContentEl = $('.msg-content', assistantEl);

  // Keep the streamed content in its own container so the Working indicator
  // can live below it and survive every innerHTML rebuild.
  const contentEl = document.createElement('div');
  contentEl.className = 'msg-stream';
  msgContentEl.appendChild(contentEl);

  const workingEl = document.createElement('div');
  workingEl.className = 'working-indicator';
  workingEl.setAttribute('role', 'status');
  workingEl.setAttribute('aria-live', 'polite');
  workingEl.innerHTML = WORKING_INDICATOR_INNER;
  msgContentEl.appendChild(workingEl);

  // Streaming state
  let currentText = '';
  let currentThinking = '';
  let toolBlocks = []; // { id, name, input, result, isError, el }
  let thinkingBlockEl = null;
  let thinkingBodyEl = null;
  let activeToolBlock = null;
  let activeToolBody = null;

  scrollToBottom();

  try {
    const res = await fetch(`/api/sessions/${sid}/prompt`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ message: modelMessage, images }),
    });

    if (!res.ok) {
      const err = await res.json().catch(() => ({ error: res.statusText }));
      throw new Error(err.error || `HTTP ${res.status}`);
    }

    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });

      // Parse SSE events
      const lines = buffer.split('\n');
      buffer = '';

      let eventType = '';
      let eventData = '';

      for (let i = 0; i < lines.length; i++) {
        const line = lines[i];
        if (line.startsWith('event: ')) {
          eventType = line.slice(7).trim();
        } else if (line.startsWith('data: ')) {
          eventData = line.slice(6);
          try {
            const data = JSON.parse(eventData);
            handleSSEEvent(eventType, data, {
              sessionId: sid,
              contentEl, assistantEl, workingEl,
              get currentText() { return currentText; },
              set currentText(v) { currentText = v; },
              get currentThinking() { return currentThinking; },
              set currentThinking(v) { currentThinking = v; },
              toolBlocks,
              get thinkingBlockEl() { return thinkingBlockEl; },
              set thinkingBlockEl(v) { thinkingBlockEl = v; },
              get thinkingBodyEl() { return thinkingBodyEl; },
              set thinkingBodyEl(v) { thinkingBodyEl = v; },
              get activeToolBlock() { return activeToolBlock; },
              set activeToolBlock(v) { activeToolBlock = v; },
              get activeToolBody() { return activeToolBody; },
              set activeToolBody(v) { activeToolBody = v; },
            });
          } catch {}
          eventType = '';
          eventData = '';
        }
      }
    }
  } catch (err) {
    if (err.name === 'AbortError') {
      // User aborted
      if (contentEl) {
        contentEl.querySelector('.streaming-cursor')?.classList.remove('streaming-cursor');
      }
    } else {
      showError(err.message);
    }
  } finally {
    state.currentStream = null;

    // The user may have switched sessions while this stream was running. Only
    // touch shared UI/state if this stream still owns the visible session and
    // its DOM is still mounted.
    if (state.sessionId === sid && assistantEl.isConnected) {
      setStreaming(false);

      // Finalize assistant message in state
      const lastMsg = state.messages[state.messages.length - 1];
      if (lastMsg && lastMsg.role === 'assistant') {
        lastMsg.content = currentText;
        lastMsg.thinking = currentThinking;
        lastMsg.toolCalls = toolBlocks.map(tb => ({
          id: tb.id,
          name: tb.name,
          input: tb.input || {},
          result: tb.result ?? null,
          isError: tb.isError || false,
        }));
      }

      // Remove streaming cursor / working indicator
      if (contentEl) {
        contentEl.querySelector('.streaming-cursor')?.classList.remove('streaming-cursor');
        workingEl.remove();
      }
    }

    await loadSessionList();
  }
}

function handleSSEEvent(type, data, ctx) {
  // Ignore events from a session that was switched away from (or whose DOM
  // was replaced). Otherwise a background stream can scroll the new session
  // or corrupt its messages.
  if (ctx.sessionId !== state.sessionId || !ctx.contentEl?.isConnected) return;

  const { contentEl } = ctx;

  switch (type) {
    case 'text': {
      // Close any open thinking block
      if (ctx.thinkingBlockEl) {
        ctx.thinkingBlockEl.querySelector('.thinking-body')?.classList.remove('open');
        ctx.thinkingBlockEl = null;
        ctx.thinkingBodyEl = null;
      }
      ctx.currentText += data.delta;
      updateAssistantContent(contentEl, ctx);
      break;
    }

    case 'thinking_start': {
      // Create thinking block
      const block = document.createElement('div');
      block.className = 'thinking-block';
      block.innerHTML = `
        <div class="thinking-header" onclick="toggleToolBlock(this.parentElement.querySelector('.thinking-body'))">
          <span>💭 Thinking</span>
          <span class="tool-chevron">▶</span>
        </div>
        <div class="thinking-body open"></div>`;
      contentEl.appendChild(block);
      ctx.thinkingBlockEl = block;
      ctx.thinkingBodyEl = block.querySelector('.thinking-body');
      break;
    }

    case 'thinking': {
      ctx.currentThinking += data.delta;
      if (ctx.thinkingBodyEl) {
        ctx.thinkingBodyEl.textContent = ctx.currentThinking;
      }
      break;
    }

    case 'tool_start': {
      // Close thinking block
      if (ctx.thinkingBlockEl) {
        ctx.thinkingBlockEl.querySelector('.thinking-body')?.classList.remove('open');
        ctx.thinkingBlockEl = null;
        ctx.thinkingBodyEl = null;
      }

      const block = document.createElement('div');
      block.className = 'tool-block';
      block.innerHTML = `
        <div class="tool-header open" onclick="toggleToolBlock(this)">
          <span class="tool-icon">🔧</span>
          <span class="tool-name">${escapeHtml(data.toolName || 'Tool')}</span>
          <span class="tool-status running">Running...</span>
          <span class="tool-chevron">▶</span>
        </div>
        <div class="tool-body open">
          <pre><code>${escapeHtml(JSON.stringify(data.input || {}, null, 2))}</code></pre>
        </div>`;
      contentEl.appendChild(block);
      ctx.activeToolBlock = block;
      ctx.activeToolBody = block.querySelector('.tool-body');
      ctx.toolBlocks.push({
        id: data.toolCallId,
        name: data.toolName,
        input: data.input,
        result: null,
        isError: false,
        el: block,
      });
      break;
    }

    case 'tool_update': {
      const tb = ctx.toolBlocks.find(t => t.id === data.toolCallId);
      const body = tb?.el?.querySelector('.tool-body');
      if (!tb || !body) break;
      const output = data.output || data.delta || '';
      tb.streamOutput = output;
      let pre = body.querySelector('pre[data-type="output"]');
      if (!pre) {
        pre = document.createElement('pre');
        pre.dataset.type = 'output';
        const code = document.createElement('code');
        pre.appendChild(code);
        body.appendChild(pre);
      }
      const code = pre.querySelector('code');
      if (code) {
        // Event output is cumulative, so replace instead of appending.
        code.textContent = output;
        scrollToBottom();
      }
      break;
    }

    case 'tool_end': {
      const tb = ctx.toolBlocks.find(t => t.id === data.toolCallId);
      if (tb && tb.el) {
        const status = tb.el.querySelector('.tool-status');
        if (data.isError) {
          status.className = 'tool-status error';
          status.textContent = 'Error';
          tb.isError = true;
        } else {
          status.className = 'tool-status success';
          status.textContent = 'Done';
        }
        tb.result = data.output || '';
        tb.streamOutput = '';

        // Add/replace result in body, reusing the streaming output node if any.
        const body = tb.el.querySelector('.tool-body');
        if (body && data.output !== undefined) {
          let resultPre = body.querySelector('pre[data-type="result"]')
            || body.querySelector('pre[data-type="output"]');
          if (!resultPre) {
            resultPre = document.createElement('pre');
            const code = document.createElement('code');
            resultPre.appendChild(code);
            body.appendChild(resultPre);
          }
          resultPre.dataset.type = 'result';
          const code = resultPre.querySelector('code');
          if (code) code.textContent = String(data.output).slice(0, 8000);
        }

        // Auto-toggle tool body
        const header = tb.el.querySelector('.tool-header');
        if (header) {
          header.classList.remove('open');
          body.classList.remove('open');
        }
      }
      ctx.activeToolBlock = null;
      ctx.activeToolBody = null;
      // The model now has the tool result and is working on the next step.
      showWorking(ctx);
      break;
    }

    case 'agent_start':
      showWorking(ctx);
      break;

    case 'message_start':
      showWorking(ctx);
      break;

    case 'agent_end':
      hideWorking(ctx);
      break;

    case 'message_end':
    case 'turn_end':
    case 'turn_start':
      break;

    case 'done':
      hideWorking(ctx);
      break;

    case 'warning':
      showNotice(data.message);
      break;

    case 'error':
      showError(data.error);
      break;
  }
}

const WORKING_INDICATOR_INNER = `
    <span class="working-spinner" aria-hidden="true"></span>
    <span class="working-text">Working</span>
    <span class="working-dots" aria-hidden="true"><span>.</span><span>.</span><span>.</span></span>`;

function renderWorkingIndicator() {
  return `<div class="working-indicator" role="status" aria-live="polite">${WORKING_INDICATOR_INNER}</div>`;
}

// Standalone assistant bubble used when attaching to a session that is still
// generating in the background (its original stream is no longer connected).
function appendWorkingMessage() {
  const div = document.createElement('div');
  div.className = 'msg msg-assistant msg-working-placeholder';
  div.innerHTML = `<div class="msg-avatar">P</div><div class="msg-content">${renderWorkingIndicator()}</div>`;
  chatMessages.appendChild(div);
  scrollToBottom();
}

function showWorking(ctx) {
  ctx?.workingEl?.classList.remove('hidden');
}

function hideWorking(ctx) {
  ctx?.workingEl?.classList.add('hidden');
}

function updateAssistantContent(contentEl, ctx) {
  // Build HTML: thinking + tool blocks + text
  let html = '';

  if (ctx.currentThinking && !ctx.thinkingBlockEl) {
    html += renderThinking(ctx.currentThinking);
  }

  if (ctx.toolBlocks.length > 0) {
    for (const tb of ctx.toolBlocks) {
      html += renderToolCall({
        id: tb.id,
        name: tb.name,
        input: tb.input || {},
        result: tb.result,
        pendingOutput: tb.streamOutput,
        isError: tb.isError,
      }, ctx.toolBlocks.indexOf(tb));
    }
  }

  html += renderMarkdown(ctx.currentText);
  html += '<span class="streaming-cursor"></span>';

  contentEl.innerHTML = html;

  // onclick attributes in renderToolCall/renderThinking already handle toggling.
  // No duplicate addEventListener needed — that would toggle twice per click.
  // Only attach copy button handlers (onclick in code blocks uses data-"code" attr).
  contentEl.querySelectorAll('.copy-btn').forEach(btn => {
    btn.addEventListener('click', (e) => {
      e.stopPropagation();
      copyButtonWithFeedback(btn);
    });
  });

  scrollToBottom();
}

// ── Error display ─────────────────────────────────────────────────────────

function showError(message) {
  const div = document.createElement('div');
  div.className = 'msg-error';
  div.textContent = `Error: ${message}`;
  chatMessages.appendChild(div);
  scrollToBottom();
  setTimeout(() => div.remove(), 8000);
}

// ── Slash command palette ─────────────────────────────────────────────────

const FALLBACK_BUILTIN_LIST = [
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

const FALLBACK_BUILTIN_COMMANDS = new Set(FALLBACK_BUILTIN_LIST.map(c => c.name));

const COMMAND_GROUP_LABELS = {
  builtin: 'Commands',
  prompt: 'Prompt templates',
  extension: 'Extension commands',
  skill: 'Skills',
};

let commandsPromise = null;
let modelsPromise = null;

function invalidateSessionCommands() {
  state.commands = null;
  state.commandsSessionId = null;
  commandsPromise = null;
}

function ensureCommands(force = false) {
  if (!state.sessionId) return Promise.resolve([]);
  if (!force && state.commands && state.commandsSessionId === state.sessionId) {
    return Promise.resolve(state.commands);
  }
  if (commandsPromise) return commandsPromise;

  const sessionId = state.sessionId;
  commandsPromise = (async () => {
    let commands;
    try {
      const data = await apiJSON('GET', `/api/commands?sessionId=${encodeURIComponent(sessionId)}`);
      commands = Array.isArray(data.commands) ? data.commands : [];
      // The UI can be newer than a running server process. Keep its own
      // built-ins available even if the server has not been restarted.
      const seen = new Set(commands.map(c => c.name));
      const missingBuiltins = FALLBACK_BUILTIN_LIST
        .filter(c => !seen.has(c.name))
        .map(c => ({ ...c, source: 'builtin' }));
      if (missingBuiltins.length) commands = [...missingBuiltins, ...commands];
    } catch {
      // Keep the palette usable even if the session endpoint is unavailable.
      commands = FALLBACK_BUILTIN_LIST.map(c => ({ ...c, source: 'builtin' }));
    } finally {
      commandsPromise = null;
    }
    if (state.sessionId === sessionId) {
      state.commands = commands;
      state.commandsSessionId = sessionId;
    }
    return commands;
  })();

  return commandsPromise;
}

function ensureModelsData() {
  if (state.modelsData) return Promise.resolve(state.modelsData);
  if (!modelsPromise) {
    modelsPromise = loadModels()
      .then((data) => {
        if (data) state.modelsData = data;
        return data;
      })
      .catch(() => {
        // Avoid retry loops in the palette; the model modal can still refresh.
        state.modelsData = { all: [], grouped: {} };
        return state.modelsData;
      })
      .finally(() => { modelsPromise = null; });
  }
  return modelsPromise;
}

function isBuiltinSlashCommand(name) {
  if (FALLBACK_BUILTIN_COMMANDS.has(name)) return true;
  return (state.commands || []).some(c => c.source === 'builtin' && c.name === name);
}

// Fuzzy match: returns -1 when there is no match, otherwise a score that is
// higher for prefix matches and consecutive characters.
function fuzzyScore(query, target) {
  if (!query) return 1;
  const q = query.toLowerCase();
  const t = String(target || '').toLowerCase();
  if (!t) return -1;
  if (t.startsWith(q)) return 1000 - q.length;
  const index = t.indexOf(q);
  if (index >= 0) return 500 - index;

  let qi = 0;
  let score = 0;
  let last = -2;
  for (let ti = 0; ti < t.length && qi < q.length; ti++) {
    if (t[ti] !== q[qi]) continue;
    score += last === ti - 1 ? 3 : 1;
    last = ti;
    qi += 1;
  }
  return qi === q.length ? score : -1;
}

function getSlashContext() {
  if (promptInput.disabled) return null;
  const value = promptInput.value;
  const caret = promptInput.selectionStart ?? value.length;
  const before = value.slice(0, caret);
  if (!before.startsWith('/') || before.includes('\n')) return null;

  const match = before.match(/^\/([^\s]*)(?:\s([\s\S]*))?$/);
  if (!match) return null;
  const hadSpace = match[2] !== undefined;
  return {
    command: match[1],
    args: hadSpace ? (match[2] || '') : null,
    hadSpace,
  };
}

function resolveSlashMode(ctx) {
  const command = ctx.command;
  if (ctx.hadSpace) {
    const query = (ctx.args || '').trimStart();
    if (command === 'model') return { mode: 'models', query };
    if (command === 'skills' || command === 'skill') return { mode: 'skills', query };
    if (command === 'prompts') return { mode: 'prompts', query };
    return null;
  }
  if (command === 'model') return { mode: 'models', query: '' };
  if (command === 'skills' || command === 'skill') return { mode: 'skills', query: '' };
  if (command.startsWith('skill:')) return { mode: 'skills', query: command.slice(6) };
  if (command === 'prompts') return { mode: 'prompts', query: '' };
  return { mode: 'commands', query: command };
}

function buildCommandItems(mode, query) {
  const sourceFilter = mode === 'skills' ? 'skill' : mode === 'prompts' ? 'prompt' : null;
  return (state.commands || [])
    .filter(c => !sourceFilter || c.source === sourceFilter)
    .map(c => ({
      kind: 'command',
      source: c.source || 'builtin',
      name: c.name,
      label: `/${c.name}`,
      description: c.description || '',
      argumentHint: c.argumentHint || '',
      argumentProvider: c.argumentProvider || '',
      group: COMMAND_GROUP_LABELS[c.source] || 'Commands',
      score: fuzzyScore(query, `${c.name} ${c.description || ''}`),
    }))
    .filter(item => item.score >= 0)
    .sort((a, b) => b.score - a.score);
}

function buildModelItems(query) {
  const all = state.modelsData && Array.isArray(state.modelsData.all) ? state.modelsData.all : [];
  return all
    .map(m => {
      const active = Boolean(state.currentModel &&
        state.currentModel.provider === m.provider && state.currentModel.id === m.id);
      return {
        kind: 'model',
        provider: m.provider,
        id: m.id,
        name: m.name || m.id,
        label: `${m.provider}/${m.id}`,
        description: m.name && m.name !== m.id ? m.name : '',
        input: Array.isArray(m.input) ? m.input : null,
        active,
        group: m.provider || 'Models',
        score: fuzzyScore(query, `${m.provider}/${m.id} ${m.name || ''}`),
      };
    })
    .filter(item => item.score >= 0)
    .sort((a, b) => b.score - a.score);
}

function updateSlashMenu() {
  const ctx = getSlashContext();
  if (!ctx) {
    closeSlashMenu();
    return;
  }

  const resolved = resolveSlashMode(ctx);
  if (!resolved) {
    closeSlashMenu();
    return;
  }

  const { mode, query } = resolved;
  const commandsReady = Boolean(state.commands && state.commandsSessionId === state.sessionId);
  const modelsReady = Boolean(state.modelsData);

  let items = [];
  let loading = false;

  if (mode === 'models') {
    if (!modelsReady) {
      loading = true;
      ensureModelsData().then(() => {
        if (state.slash.open && state.slash.mode === 'models' && getSlashContext()) updateSlashMenu();
      });
    } else {
      items = buildModelItems(query);
    }
  } else if (!commandsReady) {
    loading = true;
    ensureCommands().then(() => {
      if (state.slash.open && getSlashContext()) updateSlashMenu();
    });
  } else {
    items = buildCommandItems(mode, query);
  }

  renderSlashMenu(mode, query, items, loading);
}

function renderSlashMenu(mode, query, items, loading) {
  const key = `${mode}\u0000${query}`;
  const keepSelection = state.slash.open && state.slash.key === key;
  const selected = keepSelection
    ? Math.min(state.slash.selected, Math.max(0, items.length - 1))
    : 0;

  state.slash = { open: true, mode, query, key, items, selected, loading };
  slashMenu.classList.remove('hidden');

  if (loading) {
    slashMenu.innerHTML = '<div class="slash-loading">Loading…</div>';
    return;
  }

  if (!items.length) {
    const noun = mode === 'models' ? 'models'
      : mode === 'skills' ? 'skills'
        : mode === 'prompts' ? 'prompt templates'
          : 'commands';
    slashMenu.innerHTML = `<div class="slash-empty">No matching ${noun}</div>`;
    return;
  }

  let html = '';
  let lastGroup = null;
  items.forEach((item, index) => {
    if (item.group !== lastGroup) {
      html += `<div class="slash-group-label">${escapeHtml(item.group)}</div>`;
      lastGroup = item.group;
    }

    let badge = '';
    if (item.kind === 'model') {
      if (item.active) {
        badge = '<span class="slash-item-badge active">current</span>';
      } else if (item.input && item.input.includes('image')) {
        badge = '<span class="slash-item-badge vision">vision</span>';
      }
    } else if (item.source === 'builtin') {
      badge = '<span class="slash-item-badge">built-in</span>';
    } else {
      badge = `<span class="slash-item-badge">${escapeHtml(item.source)}</span>`;
    }

    const description = [item.description, item.argumentHint ? `<${item.argumentHint}>` : ''].filter(Boolean).join(' · ');
    html += `<button type="button" class="slash-item${index === selected ? ' selected' : ''}" data-slash-index="${index}" role="option" aria-selected="${index === selected}">
      <span class="slash-item-main">
        <span class="slash-item-name">${escapeHtml(item.label)}</span>
        ${description ? `<span class="slash-item-desc">${escapeHtml(description)}</span>` : ''}
      </span>
      ${badge}
    </button>`;
  });

  html += '<div class="slash-footer"><span>↑↓ navigate</span><span>Enter select</span><span>Esc close</span></div>';
  slashMenu.innerHTML = html;
  scrollSelectedSlashItem();
}

function scrollSelectedSlashItem() {
  const selected = $('.slash-item.selected', slashMenu);
  if (selected) selected.scrollIntoView({ block: 'nearest' });
}

function moveSlashSelection(delta) {
  if (!state.slash.open || state.slash.loading || !state.slash.items.length) return;
  const count = state.slash.items.length;
  state.slash.selected = (state.slash.selected + delta + count) % count;
  $$('.slash-item', slashMenu).forEach((el, index) => {
    const isSelected = index === state.slash.selected;
    el.classList.toggle('selected', isSelected);
    el.setAttribute('aria-selected', isSelected ? 'true' : 'false');
  });
  scrollSelectedSlashItem();
}

function closeSlashMenu() {
  state.slash = {
    open: false, mode: 'commands', query: '', key: '', items: [], selected: 0, loading: false,
  };
  slashMenu.classList.add('hidden');
  slashMenu.innerHTML = '';
}

function setComposerValue(value) {
  promptInput.value = value;
  promptInput.focus();
  const end = value.length;
  promptInput.setSelectionRange(end, end);
  autoResize();
  updateSendState();
}

async function chooseModelFromPalette(item) {
  if (!state.sessionId) return;
  closeSlashMenu();
  setComposerValue('');
  await selectModel(item.provider, item.id);
}

async function compactSession() {
  if (!state.sessionId || state.isStreaming) return;
  showNotice('Compacting session…');
  try {
    const data = await apiJSON('POST', `/api/sessions/${state.sessionId}/compact`, {});
    showNotice(data.summary ? `Session compacted: ${data.summary}` : 'Session compacted.');
    const info = await apiJSON('GET', `/api/sessions/${state.sessionId}`);
    state.messages = info.messages || [];
    renderAllMessages();
  } catch (err) {
    showError(`Compaction failed: ${err.message}`);
  }
}

function runBuiltinCommand(name) {
  switch (name) {
    case 'model':
      setComposerValue('/model ');
      updateSlashMenu();
      break;
    case 'skills':
      setComposerValue('/skills ');
      updateSlashMenu();
      break;
    case 'prompts':
      setComposerValue('/prompts ');
      updateSlashMenu();
      break;
    case 'help':
      setComposerValue('/');
      updateSlashMenu();
      break;
    case 'new':
      closeSlashMenu();
      setComposerValue('');
      startNewChat();
      break;
    case 'resume':
      closeSlashMenu();
      setComposerValue('');
      openSessionPicker();
      break;
    case 'compact':
      closeSlashMenu();
      setComposerValue('');
      compactSession();
      break;
    case 'session': {
      closeSlashMenu();
      setComposerValue('');
      const count = state.messages.length;
      const model = state.currentModel?.name || state.currentModel?.id || 'unknown';
      showNotice(`Session ${state.sessionId || '—'} · model: ${model} · ${count} message${count === 1 ? '' : 's'}`);
      break;
    }
    case 'abort':
      closeSlashMenu();
      setComposerValue('');
      btnAbort.click();
      break;
    default:
      setComposerValue(`/${name} `);
      closeSlashMenu();
  }
}

function acceptSlashSelection() {
  const { open, loading, items, selected } = state.slash;
  if (!open || loading) return false;
  const item = items[selected];
  if (!item) return false;

  if (item.kind === 'model') {
    chooseModelFromPalette(item);
    return true;
  }

  if (item.kind === 'command') {
    if (item.source === 'builtin') {
      if (item.argumentProvider === 'models') {
        setComposerValue('/model ');
        updateSlashMenu();
      } else if (item.argumentProvider === 'skills') {
        setComposerValue('/skills ');
        updateSlashMenu();
      } else if (item.argumentProvider === 'prompts') {
        setComposerValue('/prompts ');
        updateSlashMenu();
      } else {
        runBuiltinCommand(item.name);
      }
      return true;
    }

    // Prompt templates, extension commands and skills are inserted so the
    // user can add arguments (and verify) before sending.
    setComposerValue(`/${item.name} `);
    closeSlashMenu();
    return true;
  }

  return false;
}

function submitComposer() {
  const value = promptInput.value;
  const trimmed = value.trim();

  // Let the palette consume Enter/Tab when it has a selection.
  if (state.slash.open && !state.slash.loading && state.slash.items.length) {
    if (acceptSlashSelection()) return;
  }

  // Built-in commands also work if the palette has not loaded yet.
  const commandMatch = trimmed.match(/^\/([^\s]+)(?:\s[\s\S]*)?$/);
  if (commandMatch && isBuiltinSlashCommand(commandMatch[1])) {
    runBuiltinCommand(commandMatch[1]);
    return;
  }

  sendPrompt(value);
}

slashMenu.addEventListener('mousedown', (event) => event.preventDefault());
slashMenu.addEventListener('click', (event) => {
  const button = event.target.closest('[data-slash-index]');
  if (!button) return;
  const index = Number(button.dataset.slashIndex);
  if (!Number.isInteger(index) || !state.slash.items[index]) return;
  state.slash.selected = index;
  acceptSlashSelection();
});

// ── Input handling ────────────────────────────────────────────────────────

function autoResize() {
  promptInput.style.height = 'auto';
  promptInput.style.height = Math.min(promptInput.scrollHeight, 200) + 'px';
}

promptInput.addEventListener('input', () => {
  autoResize();
  updateSendState();
  updateSlashMenu();
});

promptInput.addEventListener('blur', () => {
  setTimeout(() => {
    if (document.activeElement !== promptInput) closeSlashMenu();
  }, 120);
});

document.addEventListener('selectionchange', () => {
  if (document.activeElement === promptInput) updateSlashMenu();
});

// IME (Chinese/Japanese/Korean) support: the Enter that confirms a candidate
// must not send the message. Chrome/Edge mark it with isComposing/keyCode 229;
// Safari may report a normal Enter just after compositionend, so also ignore
// Enter for a short moment after composition ends.
let isComposing = false;
let compositionEndedAt = 0;

promptInput.addEventListener('compositionstart', () => {
  isComposing = true;
});

promptInput.addEventListener('compositionend', () => {
  isComposing = false;
  compositionEndedAt = Date.now();
});

promptInput.addEventListener('keydown', (e) => {
  if (state.slash.open) {
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault();
      moveSlashSelection(e.key === 'ArrowDown' ? 1 : -1);
      return;
    }
    if (e.key === 'Escape') {
      e.preventDefault();
      closeSlashMenu();
      return;
    }
    if (e.key === 'Tab' || (e.key === 'Enter' && !e.shiftKey)) {
      if (e.isComposing || e.keyCode === 229 || isComposing) return;
      if (Date.now() - compositionEndedAt < 50) return;
      e.preventDefault();
      if (state.slash.loading || !state.slash.items.length || !acceptSlashSelection()) {
        submitComposer();
      }
      return;
    }
  }

  if (e.key !== 'Enter' || e.shiftKey) return;
  if (e.isComposing || e.keyCode === 229 || isComposing) return;
  if (Date.now() - compositionEndedAt < 50) return;
  e.preventDefault();
  submitComposer();
});

btnSend.addEventListener('click', () => {
  submitComposer();
});

// ── Attachment input ──────────────────────────────────────────────────────

btnAttach.addEventListener('click', () => fileInput.click());
fileInput.addEventListener('change', () => {
  addFiles(fileInput.files);
  fileInput.value = '';
});

attachmentTray.addEventListener('click', (event) => {
  const button = event.target.closest('button[data-act]');
  if (!button) return;
  const item = state.pendingAttachments.find((a) => a.id === button.dataset.id);
  if (!item) return;
  if (button.dataset.act === 'ref') {
    insertAttachmentReference(item.name);
    return;
  }
  if (button.dataset.act === 'remove') {
    state.pendingAttachments = state.pendingAttachments.filter((a) => a.id !== item.id);
    if (item.preview && item.preview.startsWith('blob:')) URL.revokeObjectURL(item.preview);
    renderAttachmentTray();
    updateSendState();
  }
});

// Drag and drop anywhere over the chat, with a drop target in the composer.
let dragDepth = 0;
function hasFiles(event) {
  return Boolean(event.dataTransfer && [...event.dataTransfer.types].includes('Files'));
}
const chatArea = $('.chat');
chatArea.addEventListener('dragenter', (event) => {
  if (!hasFiles(event)) return;
  event.preventDefault();
  dragDepth += 1;
  chatInputContainer.classList.add('drag-over');
});
chatArea.addEventListener('dragover', (event) => {
  if (!hasFiles(event)) return;
  event.preventDefault();
  event.dataTransfer.dropEffect = 'copy';
});
chatArea.addEventListener('dragleave', (event) => {
  if (!hasFiles(event)) return;
  dragDepth = Math.max(0, dragDepth - 1);
  if (dragDepth === 0) chatInputContainer.classList.remove('drag-over');
});
chatArea.addEventListener('drop', (event) => {
  if (!hasFiles(event)) return;
  event.preventDefault();
  event.stopPropagation();
  dragDepth = 0;
  chatInputContainer.classList.remove('drag-over');
  addFiles(event.dataTransfer.files);
});
document.addEventListener('dragover', (event) => {
  if (hasFiles(event)) event.preventDefault();
});
document.addEventListener('drop', (event) => {
  if (hasFiles(event)) event.preventDefault();
});

// Paste screenshots or files directly into the composer.
document.addEventListener('paste', (event) => {
  const items = event.clipboardData && event.clipboardData.items;
  if (!items) return;
  const files = [];
  for (const item of items) {
    if (item.kind !== 'file') continue;
    const file = item.getAsFile();
    if (file) files.push(file);
  }
  if (files.length) {
    event.preventDefault();
    addFiles(files);
  }
});

btnAbort.addEventListener('click', async () => {
  if (!state.sessionId) return;
  try {
    await api('POST', `/api/sessions/${state.sessionId}/abort`);
  } catch {}
});

$('#btnThemeToggle').addEventListener('click', toggleTheme);

// Model selector
$('#btnModelSelector').addEventListener('click', openModelSelector);
$('#btnModalClose').addEventListener('click', closeModelSelector);
$('#modelModal').addEventListener('click', (e) => {
  if (e.target === e.currentTarget) closeModelSelector();
});

// Resume session modal
$('#btnSessionModalClose').addEventListener('click', closeSessionPicker);
sessionModal.addEventListener('click', (e) => {
  if (e.target === sessionModal) closeSessionPicker();
});
sessionSearch.addEventListener('input', renderSessionPicker);
sessionPickerList.addEventListener('click', (e) => {
  const button = e.target.closest('[data-sid]');
  if (!button) return;
  const sid = button.dataset.sid;
  closeSessionPicker();
  switchSession(sid);
});
document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape' && !sessionModal.classList.contains('hidden')) {
    e.preventDefault();
    closeSessionPicker();
  }
});

async function startNewChat() {
  if (state.isStreaming && state.sessionId) {
    try { await api('POST', `/api/sessions/${state.sessionId}/abort`); } catch {}
  }
  state.messages = [];
  state.pendingAttachments = [];
  state.uploading = 0;
  renderAttachmentTray();
  updateSendState();
  await createNewSession();
}

btnNewChat.addEventListener('click', startNewChat);

// ── Model Selection ──────────────────────────────────────────────────────

async function loadModels() {
  try {
    const data = await apiJSON('GET', '/api/models');
    return data;
  } catch {
    return null;
  }
}

function renderModelList(data) {
  if (data) state.modelsData = data;
  const container = $('#modelList');
  if (!data || !data.grouped || Object.keys(data.grouped).length === 0) {
    container.innerHTML = '<div class="modal-error">No models available. Configure API keys first.</div>';
    return;
  }

  let html = '';
  const providers = Object.keys(data.grouped).sort();

  for (const provider of providers) {
    const models = data.grouped[provider];
    html += `<div class="model-provider-group">`;
    html += `<div class="model-provider-name">${escapeHtml(provider)}</div>`;
    for (const m of models) {
      const isActive = (state.currentModel && state.currentModel.provider === provider && state.currentModel.id === m.id);
      const activeClass = isActive ? ' active' : '';
      const reasoningIcon = m.reasoning ? ' 💭' : '';
      const nameStr = m.name !== m.id ? `<span class="model-id-hint">${escapeHtml(m.id)}</span>` : '';
      html += `
        <div class="model-item${activeClass}" data-provider="${escapeHtml(provider)}" data-model-id="${escapeHtml(m.id)}" onclick="selectModel('${escapeHtml(provider)}', '${escapeHtml(m.id)}')">
          <span class="model-item-name">${escapeHtml(m.name)}${reasoningIcon}</span>
          ${nameStr}
          ${isActive ? '<span class="model-active-badge">✓</span>' : ''}
        </div>`;
    }
    html += '</div>';
  }

  container.innerHTML = html;
}

async function openModelSelector() {
  const modal = $('#modelModal');
  const container = $('#modelList');
  container.innerHTML = '<div class="modal-loading">Loading models...</div>';
  modal.classList.remove('hidden');

  const data = await loadModels();
  renderModelList(data);
}

function closeModelSelector() {
  $('#modelModal').classList.add('hidden');
}

window.selectModel = async function (provider, modelId) {
  if (!state.sessionId) return null;
  try {
    const data = await apiJSON('POST', `/api/sessions/${state.sessionId}/model`, { provider, modelId });
    if (data.success && data.model) {
      state.currentModel = data.model;
      sidebarModel.textContent = `Model: ${data.model.name || data.model.id}`;
      renderAttachmentTray();
      renderModelList(await loadModels());
      closeModelSelector();
      return data;
    }
    return null;
  } catch (err) {
    console.error('Failed to switch model:', err);
    showError(`Failed to switch model: ${err.message}`);
    return null;
  }
};

// ── Init ──────────────────────────────────────────────────────────────────

// Apply theme immediately
applyTheme(getTheme());

async function init() {
  try {
    // Try to get existing sessions
    const sessions = await apiJSON('GET', '/api/sessions');
    if (sessions && sessions.length > 0) {
      // Use the most recent session
      // sessions are sorted most-recent-first from server
      const recentSession = sessions[0];
      await switchSession(recentSession.id);
    } else {
      await createNewSession();
    }
  } catch (err) {
    console.error('Init error:', err);
    // Show welcome screen with error hint
    const welcome = $('.welcome', chatMessages);
    if (welcome) {
      welcome.innerHTML += `<p style="color:var(--danger);margin-top:12px">Could not connect to server. Make sure the server is running and API keys are configured.</p>`;
    }
  }
}

init();
updateSendState();
