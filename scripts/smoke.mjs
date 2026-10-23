#!/usr/bin/env node
/*
 * Minimal UI smoke test for pi Web.
 *
 * It starts a temporary static/API stub server, launches headless Chrome and
 * exercises the parts that are easy to regress: SSE chunk parsing, safe
 * markdown, streaming scroll-follow, tool blocks, and the conversation ruler.
 *
 * Usage: npm run smoke
 * Requirements: Node 22+ (global WebSocket), Chrome/Chromium installed.
 */
import http from 'node:http';
import path from 'node:path';
import os from 'node:os';
import { existsSync } from 'node:fs';
import { readFile, mkdtemp, rm } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { setTimeout as sleep } from 'node:timers/promises';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const PUBLIC_DIR = path.join(ROOT, 'public');

const CHROME_CANDIDATES = [
  process.env.CHROME_PATH,
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  '/Applications/Chromium.app/Contents/MacOS/Chromium',
  '/usr/bin/google-chrome',
  '/usr/bin/chromium',
  '/usr/bin/chromium-browser',
].filter(Boolean);

const chromePath = CHROME_CANDIDATES.find(candidate => existsSync(candidate));
if (!chromePath) {
  console.error('Chrome/Chromium not found. Set CHROME_PATH or install Chrome.');
  process.exit(1);
}
if (typeof WebSocket === 'undefined') {
  console.error('This smoke test requires Node 22+ (global WebSocket).');
  process.exit(1);
}

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
};

const smokeSession = {
  sessionId: 'smoke',
  messages: [],
  isStreaming: false,
  model: 'smoke-model',
  currentModel: { provider: 'smoke', id: 'smoke-model', name: 'Smoke Model' },
};

function sendJson(res, data, status = 200) {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify(data));
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://127.0.0.1');

  if (url.pathname === '/api/sessions' && req.method === 'GET') {
    return sendJson(res, [{
      id: 'smoke',
      messageCount: 0,
      isStreaming: false,
      firstMessage: 'Smoke test',
      label: 'Smoke test',
    }]);
  }
  if (url.pathname === '/api/sessions' && req.method === 'POST') {
    return sendJson(res, { sessionId: 'smoke', messages: [] });
  }
  if (url.pathname === '/api/sessions/smoke' && req.method === 'GET') {
    return sendJson(res, smokeSession);
  }
  if (url.pathname === '/api/commands') {
    return sendJson(res, { commands: [] });
  }
  if (url.pathname === '/api/models') {
    return sendJson(res, { models: [] });
  }
  if (url.pathname.startsWith('/api/')) {
    return sendJson(res, { error: 'not found' }, 404);
  }

  const rel = decodeURIComponent(url.pathname).replace(/^\/+/, '') || 'index.html';
  const fullPath = path.join(PUBLIC_DIR, rel);
  if (!fullPath.startsWith(PUBLIC_DIR)) {
    res.writeHead(403);
    res.end('Forbidden');
    return;
  }

  try {
    const body = await readFile(fullPath);
    res.writeHead(200, {
      'Content-Type': MIME[path.extname(fullPath)] || 'application/octet-stream',
      'Cache-Control': 'no-cache',
    });
    res.end(body);
  } catch {
    res.writeHead(404);
    res.end('Not found');
  }
});

await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
const appPort = server.address().port;
const debugPort = 9400 + Math.floor(Math.random() * 300);
const userDataDir = await mkdtemp(path.join(os.tmpdir(), 'pi-web-smoke-'));
const chrome = spawn(chromePath, [
  '--headless=new',
  `--remote-debugging-port=${debugPort}`,
  `--user-data-dir=${userDataDir}`,
  '--no-first-run',
  '--no-default-browser-check',
  '--disable-gpu',
  '--no-sandbox',
  'about:blank',
], { stdio: 'ignore' });

let ws;
const pageErrors = [];

async function waitForTarget() {
  for (let i = 0; i < 80; i++) {
    try {
      const targets = await (await fetch(`http://127.0.0.1:${debugPort}/json/list`)).json();
      const page = targets.find(target => target.type === 'page');
      if (page?.webSocketDebuggerUrl) return page;
    } catch {}
    await sleep(150);
  }
  throw new Error('Chrome did not expose a page target');
}

try {
  const page = await waitForTarget();
  ws = new WebSocket(page.webSocketDebuggerUrl);
  await new Promise((resolve, reject) => {
    ws.addEventListener('open', resolve, { once: true });
    ws.addEventListener('error', reject, { once: true });
  });

  let messageId = 0;
  const pending = new Map();
  ws.addEventListener('message', (event) => {
    const message = JSON.parse(event.data);
    if (message.method === 'Runtime.exceptionThrown') {
      pageErrors.push(message.params.exceptionDetails?.exception?.description || message.params.exceptionDetails?.text);
    }
    if (message.id && pending.has(message.id)) {
      pending.get(message.id)(message);
      pending.delete(message.id);
    }
  });

  function send(method, params = {}) {
    const id = ++messageId;
    ws.send(JSON.stringify({ id, method, params }));
    return new Promise(resolve => pending.set(id, resolve));
  }

  async function evaluate(expression, awaitPromise = false) {
    const response = await send('Runtime.evaluate', {
      expression,
      awaitPromise,
      returnByValue: true,
    });
    if (response.result?.exceptionDetails) {
      throw new Error(JSON.stringify(response.result.exceptionDetails));
    }
    return response.result?.result?.value;
  }

  await send('Runtime.enable');
  await send('Page.enable');
  await send('Emulation.setDeviceMetricsOverride', {
    width: 1440, height: 900, deviceScaleFactor: 1, mobile: false,
  });
  await send('Page.navigate', { url: `http://127.0.0.1:${appPort}/` });

  // Wait for the app to finish its initial session switch.
  let ready = false;
  for (let i = 0; i < 60; i++) {
    ready = await evaluate(`(() => {
      try { return Boolean(window.__piWeb) && window.__piWeb.state.sessionId === 'smoke'; }
      catch { return false; }
    })()`).catch(() => false);
    if (ready) break;
    await sleep(150);
  }
  if (!ready) throw new Error('App did not initialize');

  const results = await evaluate(`(${browserTests.toString()})()`, true);
  const failures = results.filter(result => !result.ok);

  for (const result of results) {
    console.log(`${result.ok ? 'PASS' : 'FAIL'}  ${result.name}${result.detail ? '  — ' + result.detail : ''}`);
  }
  if (pageErrors.length) {
    console.log('\nPage exceptions:');
    for (const error of pageErrors) console.log('  ' + error);
  }

  if (failures.length || pageErrors.length) {
    console.error(`\n${failures.length} failed check(s).`);
    process.exitCode = 1;
  } else {
    console.log(`\n${results.length} checks passed.`);
  }
} catch (error) {
  console.error(error.stack || error);
  process.exitCode = 1;
} finally {
  try { ws?.close(); } catch {}
  chrome.kill('SIGKILL');
  server.close();
  await rm(userDataDir, { recursive: true, force: true });
}

/*
 * Runs inside the browser. Keep this self-contained: it is serialized with
 * Function.prototype.toString() and evaluated in the page.
 */
async function browserTests() {
  const wait = ms => new Promise(resolve => setTimeout(resolve, ms));
  const results = [];
  const check = (name, ok, detail = '') => {
    results.push({ name, ok: Boolean(ok), detail: String(detail).slice(0, 300) });
  };
  const chat = document.querySelector('#chatMessages');
  const distanceToBottom = () => Math.round(chat.scrollHeight - chat.scrollTop - chat.clientHeight);

  const api = window.__piWeb;
  if (!api) throw new Error('window.__piWeb is missing');
  const {
    state, appendMessage, handleSSEEvent, scrollToBottom,
    renderWorkingIndicator, createSSEParser, renderMarkdown,
  } = api;
  const stopSessionPoll = api.stopSessionPoll;

  stopSessionPoll();
  document.querySelectorAll('#chatMessages > *').forEach(element => element.remove());
  state.messages = [];
  state.pendingAttachments = [];
  state.uploading = 0;
  state.isStreaming = false;

  // ── SSE parser: chunks split inside event/data lines ────────────────────
  const sseEvents = [];
  const parser = createSSEParser((type, data) => sseEvents.push({ type, data }));
  const wire = 'event: text\ndata: {"delta":"a"}\n\nevent: thinking\ndata: {"delta":"b"}\n\n';
  const cuts = [3, 11, 18, 27, 39, wire.length];
  let cursor = 0;
  for (const cut of cuts) {
    parser.push(wire.slice(cursor, cut));
    cursor = cut;
  }
  parser.end();
  check(
    'SSE parser handles split chunks',
    sseEvents.length === 2 && sseEvents[0].type === 'text' && sseEvents[1].data.delta === 'b',
    JSON.stringify(sseEvents),
  );

  // ── Markdown safety and lists ────────────────────────────────────────────
  const safeHtml = renderMarkdown('hello <img src=x onerror="alert(1)">');
  check(
    'markdown escapes raw HTML',
    !safeHtml.includes('<img') && safeHtml.includes('&lt;img'),
    safeHtml,
  );
  const listHtml = renderMarkdown('- one\n- two');
  check(
    'markdown renders a single list',
    (listHtml.match(/<li>/g) || []).length === 2 && listHtml.includes('<ul>') && !listHtml.includes('<ol>'),
    listHtml,
  );
  const linkHtml = renderMarkdown('[example](https://example.com)');
  check(
    'markdown renders safe links',
    linkHtml.includes('<a href="https://example.com"') && linkHtml.includes('rel="noopener noreferrer"'),
    linkHtml,
  );
  const badLinkHtml = renderMarkdown('[bad](javascript:alert(1))');
  check('markdown rejects javascript URLs', !badLinkHtml.includes('<a '), badLinkHtml);

  // ── Streaming transcript setup ───────────────────────────────────────────
  const baseline = Array.from({ length: 8 }, (_, i) => 'Baseline paragraph ' + i + '. ' + 'Earlier conversation text. '.repeat(12)).join('\n\n');
  for (let i = 0; i < 14; i++) {
    appendMessage({
      id: 'base_' + i,
      role: i % 2 ? 'assistant' : 'user',
      content: baseline,
      toolCalls: [],
      thinking: '',
      timestamp: new Date().toISOString(),
    });
  }

  const assistant = { id: 'smoke_assistant', role: 'assistant', content: '', toolCalls: [], thinking: '', timestamp: new Date().toISOString() };
  state.messages.push(assistant);
  const assistantEl = appendMessage(assistant);
  const contentEl = document.createElement('div');
  contentEl.className = 'msg-stream';
  assistantEl.querySelector('.msg-content').appendChild(contentEl);
  const workingEl = document.createElement('div');
  workingEl.className = 'working-indicator';
  workingEl.innerHTML = renderWorkingIndicator();
  assistantEl.querySelector('.msg-content').appendChild(workingEl);
  const ctx = {
    sessionId: state.sessionId,
    contentEl,
    currentText: '',
    currentThinking: '',
    activeThinkingText: '',
    thinkingBlockEl: null,
    thinkingBodyEl: null,
    toolBlocks: [],
    workingEl,
  };
  scrollToBottom(true);
  await wait(80);

  // ── Thinking and tool output keep following the bottom ───────────────────
  handleSSEEvent('message_start', {}, ctx);
  handleSSEEvent('thinking_start', {}, ctx);
  for (let i = 0; i < 24; i++) {
    handleSSEEvent('thinking', { delta: 'thinking line ' + i + '\n' }, ctx);
  }
  await wait(120);
  check('thinking stream follows the bottom', api.stickToBottom && distanceToBottom() <= 2, `dist=${distanceToBottom()} stick=${api.stickToBottom}`);

  handleSSEEvent('tool_start', { toolCallId: 'tool_smoke', toolName: 'bash', input: { command: 'echo test' } }, ctx);
  handleSSEEvent('tool_update', { toolCallId: 'tool_smoke', output: 'streamed tool output' }, ctx);
  handleSSEEvent('tool_end', { toolCallId: 'tool_smoke', isError: false, output: 'tool finished' }, ctx);
  for (let i = 0; i < 8; i++) {
    handleSSEEvent('text', { delta: 'answer chunk ' + i + ' ' }, ctx);
  }
  await wait(150);
  const toolBlock = contentEl.querySelector('.tool-block[data-tool-id="tool_smoke"]');
  check(
    'tool block survives a text rebuild',
    Boolean(toolBlock) && toolBlock.querySelector('.tool-status')?.textContent === 'Done',
    toolBlock?.textContent?.replace(/\s+/g, ' ').slice(0, 80),
  );
  const toolHeader = toolBlock?.querySelector('.tool-header');
  toolHeader?.click();
  check(
    'inline tool toggle still works',
    Boolean(toolHeader?.classList.contains('open')) && Boolean(toolBlock?.querySelector('.tool-body')?.classList.contains('open')),
    toolHeader?.className,
  );
  toolHeader?.click();

  handleSSEEvent('message_start', {}, ctx);
  handleSSEEvent('thinking_start', {}, ctx);
  handleSSEEvent('thinking', { delta: 'second thought' }, ctx);
  await wait(50);
  const thinkingBlocks = contentEl.querySelectorAll('.thinking-block');
  const lastThinkingText = thinkingBlocks[thinkingBlocks.length - 1]?.querySelector('.thinking-body')?.textContent;
  check('new thinking block keeps its own text', lastThinkingText === 'second thought', lastThinkingText);
  check('text stream follows the bottom', api.stickToBottom && distanceToBottom() <= 2, `dist=${distanceToBottom()}`);

  // ── Reading history must not move while output continues ────────────────
  chat.dispatchEvent(new WheelEvent('wheel', { deltaY: -120, bubbles: true, cancelable: true }));
  chat.scrollTop -= 900;
  await wait(120);
  const readingTop = chat.scrollTop;
  for (let i = 0; i < 12; i++) {
    handleSSEEvent('thinking', { delta: 'more while reading ' + i + '\n' }, ctx);
  }
  await wait(120);
  check(
    'reading stays frozen during stream',
    Math.abs(chat.scrollTop - readingTop) <= 1 && !api.stickToBottom,
    `moved=${Math.round(chat.scrollTop - readingTop)}px stick=${api.stickToBottom}`,
  );
  const jumpButton = document.querySelector('#btnScrollBottom');
  check(
    'jump button marks new output',
    !jumpButton.classList.contains('hidden') && jumpButton.classList.contains('has-new'),
    jumpButton.className,
  );

  jumpButton.click();
  for (let i = 0; i < 8; i++) {
    handleSSEEvent('text', { delta: 'after jump ' + i + ' ' }, ctx);
  }
  await wait(150);
  check('jump-to-latest resumes following', api.stickToBottom && distanceToBottom() <= 2, `dist=${distanceToBottom()}`);
  check(
    'jump button clears the new-output marker',
    jumpButton.classList.contains('hidden') && !jumpButton.classList.contains('has-new'),
    jumpButton.className,
  );

  // ── Full re-render preserves expanded blocks ─────────────────────────────
  state.messages = [{
    id: 'persist',
    role: 'assistant',
    content: 'done',
    thinking: 'some reasoning',
    toolCalls: [{ id: 'persist-tool', name: 'bash', input: { command: 'x' }, result: 'ok', isError: false }],
    timestamp: new Date().toISOString(),
  }];
  document.querySelectorAll('#chatMessages > *').forEach(element => element.remove());
  api.renderAllMessages();
  await wait(80);
  const persistMsg = document.querySelector('.msg[data-id="persist"]');
  const persistTool = persistMsg?.querySelector('.tool-block');
  const persistThinking = persistMsg?.querySelector('.thinking-block');
  toggleToolBlock(persistTool.querySelector('.tool-header'));
  toggleToolBlock(persistThinking.querySelector('.thinking-body'));
  api.renderAllMessages({ forceScroll: false });
  await wait(80);
  const reRendered = document.querySelector('.msg[data-id="persist"]');
  check(
    'full re-render preserves expanded blocks',
    Boolean(reRendered?.querySelector('.tool-block .tool-body.open')) && Boolean(reRendered?.querySelector('.thinking-block .thinking-body.open')),
    reRendered ? 'ok' : 'message missing',
  );

  // ── Ruler: all prompts retained, min gap, click and keyboard ────────────
  document.querySelectorAll('#chatMessages > *').forEach(element => element.remove());
  for (let i = 0; i < 90; i++) {
    appendMessage({ id: 'ru' + i, role: 'user', content: 'prompt ' + i, toolCalls: [], thinking: '', timestamp: new Date().toISOString() });
    appendMessage({ id: 'ra' + i, role: 'assistant', content: 'reply ' + i, toolCalls: [], thinking: '', timestamp: new Date().toISOString() });
  }
  await wait(300);

  const track = document.querySelector('#rulerTrack');
  const ticks = [...document.querySelectorAll('.ruler-tick')];
  check('ruler keeps every prompt', ticks.length === 90, `ticks=${ticks.length}`);

  const visibleTicks = ticks.filter(tick => {
    const y = parseFloat(tick.style.top);
    return y >= -6 && y <= track.clientHeight + 6;
  });
  const ys = visibleTicks.map(tick => parseFloat(tick.style.top)).sort((a, b) => a - b);
  const gaps = ys.slice(1).map((y, i) => y - ys[i]);
  check('ruler enforces minimum gap', gaps.length > 0 && Math.min(...gaps) >= 8.9, `min=${Math.min(...gaps).toFixed(2)}px`);

  const targetTick = visibleTicks[Math.floor(visibleTicks.length / 2)];
  const tickRect = targetTick.getBoundingClientRect();
  const trackRect = track.getBoundingClientRect();
  const beforeClick = chat.scrollTop;
  track.dispatchEvent(new PointerEvent('pointerdown', {
    clientX: trackRect.right - 5, clientY: tickRect.top + tickRect.height / 2,
    bubbles: true, button: 0, pointerId: 1,
  }));
  track.dispatchEvent(new PointerEvent('pointerup', {
    clientX: trackRect.right - 5, clientY: tickRect.top + tickRect.height / 2,
    bubbles: true, button: 0, pointerId: 1,
  }));
  await wait(150);
  check('ruler click jumps', Math.abs(chat.scrollTop - beforeClick) > 10, `delta=${Math.round(chat.scrollTop - beforeClick)}px`);

  track.focus();
  track.dispatchEvent(new KeyboardEvent('keydown', { key: 'Home', bubbles: true }));
  await wait(120);
  check('ruler Home goes to the first prompt', chat.scrollTop <= 2, `top=${Math.round(chat.scrollTop)}`);
  track.dispatchEvent(new KeyboardEvent('keydown', { key: 'End', bubbles: true }));
  await wait(120);
  check(
    'ruler End goes to the last prompt',
    chat.scrollTop >= chat.scrollHeight - chat.clientHeight - 2,
    `top=${Math.round(chat.scrollTop)} max=${Math.round(chat.scrollHeight - chat.clientHeight)}`,
  );

  // ── Copy whole message ───────────────────────────────────────────────────
  let copiedText = null;
  try {
    Object.defineProperty(navigator, 'clipboard', {
      configurable: true,
      value: { writeText: async (text) => { copiedText = text; } },
    });
  } catch {}
  const copyMsg = {
    id: 'copy_test', role: 'assistant', content: 'copy **me**',
    toolCalls: [], thinking: '', timestamp: new Date().toISOString(),
  };
  api.state.messages.push(copyMsg);
  const copyEl = api.appendMessage(copyMsg);
  const copyBtn = copyEl.querySelector('.msg-copy-btn');
  copyBtn?.click();
  await wait(80);
  check(
    'message copy button copies the markdown',
    copiedText === 'copy **me**' && copyBtn?.textContent === '✓',
    `copied=${copiedText} label=${copyBtn?.textContent}`,
  );
  api.state.messages.pop();
  copyEl.remove();

  // ── HTTP rejection removes optimistic messages ────────────────────────────
  const httpErrorFetch = window.fetch;
  window.fetch = async (url, opts) => {
    if (String(url).includes('/prompt')) {
      return new Response(JSON.stringify({ error: 'simulated rejection' }), {
        status: 500,
        headers: { 'Content-Type': 'application/json' },
      });
    }
    return httpErrorFetch(url, opts);
  };
  api.state.isStreaming = false;
  api.state.pendingAttachments = [];
  api.state.uploading = 0;
  const beforeRejected = api.state.messages.length;
  await api.sendPrompt('http rejection test');
  window.fetch = httpErrorFetch;
  await wait(100);
  check(
    'HTTP rejection removes the optimistic message',
    api.state.isStreaming === false &&
      api.state.messages.length === beforeRejected &&
      !api.state.messages.some(message => message.content === 'http rejection test') &&
      !document.querySelector('#chatMessages .msg-content')?.textContent.includes('http rejection test'),
    `messages=${api.state.messages.length} streaming=${api.state.isStreaming}`,
  );
  check(
    'HTTP rejection shows an error',
    Boolean(document.querySelector('.msg-error')?.textContent.includes('simulated rejection')),
    document.querySelector('.msg-error')?.textContent,
  );

  // ── Mid-stream disconnect recovery ───────────────────────────────────────
  const realFetch = window.fetch;
  let promptFetched = false;
  window.fetch = async (url, opts) => {
    if (String(url).includes('/prompt')) {
      promptFetched = true;
      const encoder = new TextEncoder();
      const stream = new ReadableStream({
        start(controller) {
          controller.enqueue(encoder.encode('event: thinking_start\ndata: {}\n\nevent: thinking\ndata: {"delta":"partial"}\n\n'));
          setTimeout(() => controller.error(new Error('simulated network loss')), 30);
        },
      });
      return new Response(stream, { status: 200, headers: { 'Content-Type': 'text/event-stream' } });
    }
    return realFetch(url, opts);
  };

  api.state.isStreaming = false;
  api.state.pendingAttachments = [];
  api.state.uploading = 0;
  await api.sendPrompt('recovery test');
  window.fetch = realFetch;

  let recovered = false;
  for (let i = 0; i < 40; i++) {
    await wait(100);
    if (!api.state.isStreaming) { recovered = true; break; }
  }
  check('mid-stream disconnect recovers', promptFetched && recovered, `streaming=${api.state.isStreaming}`);
  check(
    'empty session restores the welcome screen',
    Boolean(document.querySelector('#chatMessages .welcome')),
    document.querySelector('#chatMessages')?.className,
  );

  return results;
}
