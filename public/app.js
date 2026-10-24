import { escapeHtml, renderMarkdown } from './markdown.js';
import { createSSEParser } from './sse.js';
import { createRuler } from './ruler.js';
import { formatBytes, attachmentIsImage, attachmentLabel, escapeAttr } from './util.js';
import { parseAttachmentMessage, renderToolCall, renderThinking, createMessageElement, createMessageStep } from './messages.js';

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
  editing: null,         // { sessionId, entryId, previousValue } for edit-and-resend
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
const welcomeTemplate = $('.welcome', chatMessages)?.cloneNode(true) || null;
const chatRuler = $('#chatRuler');
const rulerTrack = $('#rulerTrack');
const rulerTip = $('#rulerTip');
const rulerTipRole = $('#rulerTipRole');
const rulerTipText = $('#rulerTipText');
const btnScrollBottom = $('#btnScrollBottom');
const promptInput = $('#promptInput');
const btnSend = $('#btnSend');
const btnAbort = $('#btnAbort');
const btnNewChat = $('#btnNewChat');
const sessionList = $('#sessionList');
const sidebarModel = $('#sidebarModel');
const sidebarUsage = $('#sidebarUsage');
const attachmentTray = $('#attachmentTray');
const fileInput = $('#fileInput');
const btnAttach = $('#btnAttach');
const chatInputContainer = $('#chatInputContainer');
const editBanner = $('#editBanner');
const btnCancelEdit = $('#btnCancelEdit');
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

function showNotice(message) {
  const div = document.createElement('div');
  div.className = 'msg-warning';
  div.textContent = message;
  chatMessages.appendChild(div);
  scrollToBottom();
  setTimeout(() => div.remove(), 9000);
}

// ── Message rendering ─────────────────────────────────────────────────────

function messageCopyText(msg) {
  if (msg.role === 'user') {
    const parsed = parseAttachmentMessage(msg.content || '');
    const files = (parsed.attachments || []).map(a => a.name).filter(Boolean);
    return [parsed.text, files.length ? files.map(name => `[${name}]`).join(' ') : '']
      .filter(Boolean)
      .join('\n\n');
  }
  return String(msg.content || '');
}

// Provider pricing is in USD. Show an approximate CNY conversion; override
// the rate in the browser with:
//   localStorage.setItem('pi-web-usd-cny', '7.30')
const USD_TO_CNY = (() => {
  try {
    const saved = Number(localStorage.getItem('pi-web-usd-cny'));
    return Number.isFinite(saved) && saved > 0 ? saved : 7.2;
  } catch {
    return 7.2;
  }
})();

function normalizeUsage(usage) {
  if (!usage || typeof usage !== 'object') return null;
  const currency = usage.currency || 'USD';
  const cost = typeof usage.cost === 'number' ? usage.cost : Number(usage.cost?.total) || 0;
  const costs = usage.costs && typeof usage.costs === 'object'
    ? { ...usage.costs }
    : { [currency]: cost };
  return {
    input: Number(usage.input) || 0,
    output: Number(usage.output) || 0,
    cacheRead: Number(usage.cacheRead) || 0,
    cacheWrite: Number(usage.cacheWrite) || 0,
    reasoning: Number(usage.reasoning) || 0,
    totalTokens: Number(usage.totalTokens) || 0,
    cost,
    currency,
    costs,
    priceSource: usage.priceSource || '',
    pricePeriod: usage.pricePeriod || '',
  };
}

function mergeUsage(existing, next) {
  const a = normalizeUsage(existing);
  const b = normalizeUsage(next);
  if (!a) return b;
  if (!b) return a;
  const costs = { ...a.costs };
  for (const [currency, value] of Object.entries(b.costs)) {
    costs[currency] = (costs[currency] || 0) + (Number(value) || 0);
  }
  const currency = a.currency || b.currency || 'USD';
  return {
    input: a.input + b.input,
    output: a.output + b.output,
    cacheRead: a.cacheRead + b.cacheRead,
    cacheWrite: a.cacheWrite + b.cacheWrite,
    reasoning: a.reasoning + b.reasoning,
    totalTokens: a.totalTokens + b.totalTokens,
    cost: costs[currency] ?? 0,
    currency,
    costs,
    priceSource: a.priceSource === b.priceSource ? a.priceSource : '',
    pricePeriod: a.pricePeriod === b.pricePeriod ? a.pricePeriod : '',
  };
}

function sumUsage(messages) {
  let total = null;
  for (const msg of messages || []) {
    if (!msg || msg.role !== 'assistant') continue;
    const usage = normalizeUsage(msg.usage);
    if (!usage) continue;
    total = mergeUsage(total, usage);
  }
  return total;
}

function formatTokenCount(value) {
  const number = Number(value) || 0;
  if (number >= 1_000_000) return `${(number / 1_000_000).toFixed(number >= 10_000_000 ? 0 : 1)}M`;
  if (number >= 1_000) return `${(number / 1_000).toFixed(number >= 10_000 ? 0 : 1)}k`;
  return String(number);
}

const CURRENCY_SYMBOLS = { USD: '$', CNY: '¥', EUR: '€', GBP: '£', JPY: 'JP¥' };

// Show the vendor's own currency: prices from DeepSeek/OpenRouter are USD, and
// a CNY-priced provider must stay in CNY instead of being converted. The fixed
// USD/CNY rate is only used for the estimated conversion in the tooltip.
function formatCost(value, currency = 'USD') {
  const amount = Number(value) || 0;
  if (amount <= 0) return '';
  const symbol = CURRENCY_SYMBOLS[currency] || `${currency} `;
  if (amount >= 100) return `${symbol}${amount.toFixed(0)}`;
  if (amount >= 1) return `${symbol}${amount.toFixed(2)}`;
  if (amount >= 0.01) return `${symbol}${amount.toFixed(3)}`;
  if (amount >= 0.001) return `${symbol}${amount.toFixed(4)}`;
  return `${symbol}${amount.toFixed(5)}`;
}

function formatUsageCost(usage) {
  if (!usage) return '';
  const costs = usage.costs && typeof usage.costs === 'object'
    ? usage.costs
    : { [usage.currency || 'USD']: usage.cost };
  return Object.entries(costs)
    .filter(([, value]) => Number(value) > 0)
    .map(([currency, value]) => formatCost(value, currency))
    .join(' · ');
}

function formatUsageLabel(usage) {
  if (!usage) return '';
  const tokens = `↑${formatTokenCount(usage.input)} ↓${formatTokenCount(usage.output)}`;
  const cost = formatUsageCost(usage);
  return cost ? `${tokens} · ${cost}` : tokens;
}

function formatUsageTitle(usage) {
  if (!usage) return '';
  const costs = usage.costs && typeof usage.costs === 'object'
    ? usage.costs
    : { [usage.currency || 'USD']: usage.cost };
  const costText = Object.entries(costs)
    .filter(([, value]) => Number(value) > 0)
    .map(([currency, value]) => {
      const amount = Number(value) || 0;
      const symbol = CURRENCY_SYMBOLS[currency] || '';
      const base = symbol
        ? `${symbol}${amount.toFixed(6)} ${currency}`
        : `${currency} ${amount.toFixed(6)}`;
      if (currency === 'USD') {
        return `${base} (≈¥${(amount * USD_TO_CNY).toFixed(4)} at ${USD_TO_CNY})`;
      }
      return base;
    })
    .join(' / ') || '—';
  const source = usage.priceSource && usage.priceSource !== 'local'
    ? `price: ${usage.priceSource}${usage.pricePeriod ? ` (${usage.pricePeriod})` : ''}`
    : usage.priceSource === 'local'
      ? 'price: local models.json / SDK'
      : 'price: mixed sources';
  return `input ${usage.input.toLocaleString()} · output ${usage.output.toLocaleString()} · cache read ${usage.cacheRead.toLocaleString()} · cache write ${usage.cacheWrite.toLocaleString()} · cost ${costText} · ${source}`;
}

function updateMessageMeta(el) {
  const messages = el._messages || [];
  const last = messages[messages.length - 1];
  const timeEl = el.querySelector('.msg-time');
  const usageEl = el.querySelector('.msg-usage');

  if (timeEl) {
    const date = last ? new Date(last.timestamp) : null;
    const valid = date && !Number.isNaN(date.getTime());
    timeEl.textContent = valid ? date.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }) : '';
    timeEl.dateTime = valid ? date.toISOString() : '';
    timeEl.title = valid ? date.toLocaleString() : '';
  }

  if (usageEl) {
    const usage = sumUsage(messages);
    usageEl.textContent = formatUsageLabel(usage);
    usageEl.title = formatUsageTitle(usage);
    usageEl.classList.toggle('hidden', !usage);
  }
}

function updateSidebarUsage() {
  if (!sidebarUsage) return;
  const usage = sumUsage(state.messages);
  if (!usage) {
    sidebarUsage.textContent = '';
    sidebarUsage.title = '';
    sidebarUsage.classList.add('hidden');
    return;
  }
  const cost = formatUsageCost(usage);
  sidebarUsage.textContent = `↑${formatTokenCount(usage.input)} ↓${formatTokenCount(usage.output)}${cost ? ` · ${cost}` : ''}`;
  sidebarUsage.title = `Session totals — ${formatUsageTitle(usage)}`;
  sidebarUsage.classList.remove('hidden');
}

function groupCopyText(messages) {
  if (!Array.isArray(messages) || messages.length === 0) return '';
  if (messages[0].role === 'user') return messageCopyText(messages[0]);
  return messages
    .map(msg => String(msg.content || '').trim())
    .filter(Boolean)
    .join('\n\n');
}

function updateMessageCopyButton(el) {
  const btn = el.querySelector('.msg-copy-btn');
  if (!btn) return;
  btn.classList.toggle('hidden', !groupCopyText(el._messages || []));
}

function attachCodeCopyHandlers(root) {
  root.querySelectorAll('.copy-btn').forEach(btn => {
    btn.addEventListener('click', (event) => {
      event.stopPropagation();
      copyButtonWithFeedback(btn);
    });
  });
}

function renderEditBanner() {
  editBanner?.classList.toggle('hidden', !state.editing);
}

function refreshMessageEditButton(msg) {
  if (!msg?.id) return;
  const el = document.querySelector(`#chatMessages .msg[data-id="${CSS.escape(msg.id)}"]`);
  const button = el?.querySelector('.msg-edit-btn');
  if (!button) return;
  const parsed = parseAttachmentMessage(msg.content || '');
  button.classList.toggle('hidden', !msg.entryId || parsed.attachments.length > 0);
}

function startEditMessage(msg) {
  if (!msg?.entryId || state.isStreaming) return;
  const parsed = parseAttachmentMessage(msg.content || '');
  if (parsed.attachments.length > 0) return;
  state.editing = {
    sessionId: state.sessionId,
    entryId: msg.entryId,
    previousValue: promptInput.value,
  };
  setComposerValue(parsed.text);
  renderEditBanner();
  promptInput.focus();
}

function cancelEdit() {
  if (!state.editing) return;
  const previous = state.editing.previousValue || '';
  state.editing = null;
  renderEditBanner();
  setComposerValue(previous);
}

function appendMessage(msg) {
  const last = chatMessages.lastElementChild;

  // Consecutive assistant steps belong to the same reply. Keep one P avatar
  // and one copy button for the whole group.
  if (msg.role === 'assistant'
      && last?.classList.contains('msg-assistant')
      && Array.isArray(last._messages)) {
    const step = createMessageStep(msg);
    last.querySelector('.msg-steps')?.appendChild(step);
    last._messages.push(msg);
    attachCodeCopyHandlers(step);
    updateMessageCopyButton(last);
    updateMessageMeta(last);
    refreshMessageDetails(last);
    if (!stickToBottom) markNewOutput();
    scrollToBottom();
    return last;
  }

  const el = createMessageElement(msg);
  el._messages = [msg];
  chatMessages.appendChild(el);
  if (!stickToBottom) markNewOutput();
  scrollToBottom();
  attachCodeCopyHandlers(el);
  updateMessageCopyButton(el);
  updateMessageMeta(el);
  refreshMessageDetails(el);

  const detailsBtn = el.querySelector('.btn-msg-details');
  detailsBtn?.addEventListener('click', (event) => {
    event.stopPropagation();
    toggleMessageDetails(el);
  });

  const editBtn = el.querySelector('.msg-edit-btn');
  if (editBtn) {
    const parsed = msg.role === 'user' ? parseAttachmentMessage(msg.content || '') : null;
    editBtn.classList.toggle('hidden', !msg.entryId || Boolean(parsed?.attachments?.length));
    editBtn.addEventListener('click', (event) => {
      event.stopPropagation();
      if (msg.entryId) startEditMessage(msg);
    });
  }

  const messageCopyBtn = el.querySelector('.msg-copy-btn');
  messageCopyBtn?.addEventListener('click', (event) => {
    event.stopPropagation();
    copyToClipboard(groupCopyText(el._messages)).then((ok) => {
      if (!ok) return;
      clearTimeout(messageCopyBtn._copyTimer);
      messageCopyBtn.classList.add('copied');
      messageCopyBtn.textContent = '✓';
      messageCopyBtn._copyTimer = setTimeout(() => {
        messageCopyBtn.classList.remove('copied');
        messageCopyBtn.textContent = '⧉';
      }, 1200);
    });
  });
  return el;
}

function getLastAssistantEl() {
  const all = $$('.msg-assistant', chatMessages);
  return all[all.length - 1];
}

// Auto-scroll only while the user is (or has returned to) the bottom of the
// transcript. If they scroll up to read earlier output, incoming stream deltas
// must leave their viewport alone; once they scroll back down we resume.
const SCROLL_STICK_THRESHOLD = 48;
let stickToBottom = true;
let hasNewOutput = false;

function isNearBottom() {
  const distance = chatMessages.scrollHeight - chatMessages.scrollTop - chatMessages.clientHeight;
  return distance <= SCROLL_STICK_THRESHOLD;
}

let lastScrollTop = chatMessages.scrollTop;
let ruler = null;

chatMessages.addEventListener('scroll', () => {
  const top = chatMessages.scrollTop;

  // Only a genuine upward move means the reader is looking at earlier output.
  // Deriving this from distance-to-bottom alone is racy: a burst of streamed
  // content can grow the transcript before the programmatic scroll event is
  // processed, making it look like the user scrolled away.
  //
  // A decrease that still ends at the bottom is not a user scroll-up: it is
  // caused by collapsing a thinking/tool block, which shortens the transcript
  // and clamps scrollTop. Keep following in that case.
  const nearBottom = isNearBottom();
  if (top < lastScrollTop - 1 && !nearBottom) {
    stickToBottom = false;
  } else if (nearBottom) {
    stickToBottom = true;
    hasNewOutput = false;
  }

  lastScrollTop = top;
  updateScrollBottomButton();
  ruler?.scheduleUpdate();
}, { passive: true });

// Treat an upward wheel/touch gesture as intent immediately, before the scroll
// event arrives. A stream delta landing between the gesture and the event must
// not yank the viewport back down.
chatMessages.addEventListener('wheel', (event) => {
  if (event.deltaY < 0 && chatMessages.scrollTop > 0) {
    stickToBottom = false;
    updateScrollBottomButton();
  }
}, { passive: true });

let lastTouchY = null;
chatMessages.addEventListener('touchstart', (event) => {
  lastTouchY = event.touches[0]?.clientY ?? null;
}, { passive: true });
chatMessages.addEventListener('touchmove', (event) => {
  const y = event.touches[0]?.clientY;
  // Dragging the finger down reveals earlier output.
  if (chatMessages.scrollTop > 0 && lastTouchY !== null && y !== undefined && y > lastTouchY + 1) {
    stickToBottom = false;
    updateScrollBottomButton();
  }
  lastTouchY = y ?? null;
}, { passive: true });
chatMessages.addEventListener('touchend', () => {
  lastTouchY = null;
}, { passive: true });

// Lazy-loaded images can change the scroll height after we pinned to bottom.
chatMessages.addEventListener('load', () => {
  if (stickToBottom) scrollToBottom();
}, true);

// force=true is for explicit jumps (session switch, sending a prompt) that
// should always follow the latest output regardless of scroll position.
function scrollToBottom(force = false) {
  if (force) {
    stickToBottom = true;
    hasNewOutput = false;
    updateScrollBottomButton();
  }
  if (!stickToBottom) return;
  chatMessages.scrollTop = chatMessages.scrollHeight;
  // A forced jump (session switch, sending a prompt) may land above the old
  // scroll position when the new transcript is shorter. Keep the scroll
  // handler from mistaking that for a user scroll-up.
  if (force) lastScrollTop = chatMessages.scrollTop;
}

// ── Conversation timeline (right-hand ruler) ─────────────────────────────
// One evenly spaced tick per user prompt. Hovering previews the prompt;
// clicking or dragging the rail jumps to the nearest prompt.
function maxChatScroll() {
  return Math.max(0, chatMessages.scrollHeight - chatMessages.clientHeight);
}

// Show the jump-to-latest button whenever the reader is above the live edge.
function updateScrollBottomButton() {
  const show = maxChatScroll() > 8 && !stickToBottom;
  btnScrollBottom.classList.toggle('hidden', !show);
  btnScrollBottom.classList.toggle('has-new', show && hasNewOutput);
}

function markNewOutput() {
  if (stickToBottom) return;
  hasNewOutput = true;
  updateScrollBottomButton();
}

btnScrollBottom.addEventListener('click', () => {
  // Re-enable follow mode: while a stream keeps producing output, every new
  // delta will keep the view pinned to the newest message.
  scrollToBottom(true);
  updateScrollBottomButton();
});

btnScrollBottom.addEventListener('wheel', (event) => {
  const unit = event.deltaMode === 1 ? 16 : event.deltaMode === 2 ? chatMessages.clientHeight : 1;
  chatMessages.scrollTop += event.deltaY * unit;
  event.preventDefault();
}, { passive: false });

ruler = createRuler({
  chatMessages,
  rulerEl: chatRuler,
  trackEl: rulerTrack,
  tipEl: rulerTip,
  tipRoleEl: rulerTipRole,
  tipTextEl: rulerTipText,
  isNearBottom,
  updateJumpButton: updateScrollBottomButton,
  setStickToBottom(value) {
    stickToBottom = value;
    if (value) hasNewOutput = false;
    updateScrollBottomButton();
  },
});

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
  ruler?.markOffsetsDirty();
};

// ── Per-reply details toggle (thinking / tool calls) ─────────────────────
// Every assistant reply owns a button that hides just its own reasoning and
// tool output. A live reply stays expanded; it collapses when the turn ends.

function stepHasAnswer(step) {
  const answer = step.querySelector('.msg-answer');
  if (answer && answer.textContent.trim()) return true;
  if (step.querySelector('.msg-attachments')) return true;
  for (const child of step.children) {
    if (child.classList.contains('thinking-block') ||
        child.classList.contains('tool-block') ||
        child.classList.contains('msg-answer') ||
        child.classList.contains('working-indicator')) {
      continue;
    }
    if (child.textContent.trim()) return true;
  }
  return false;
}

// Hide steps that contain nothing but reasoning/tool calls, and move the step
// separator to the first visible step so collapsing does not leave stray lines.
function syncMessageSteps(msgEl) {
  if (!msgEl?.classList.contains('msg-assistant')) return;
  const collapsed = msgEl.classList.contains('details-collapsed');
  let firstVisible = true;
  msgEl.querySelectorAll('.msg-step').forEach((step) => {
    const detailsOnly = collapsed && !stepHasAnswer(step);
    step.classList.toggle('details-only-step', detailsOnly);
    step.classList.toggle('step-first-visible', !detailsOnly && firstVisible);
    if (!detailsOnly) firstVisible = false;
  });
}

function updateMessageDetailsButton(msgEl) {
  const btn = msgEl?.querySelector('.btn-msg-details');
  if (!btn) return;
  const count = msgEl.querySelectorAll('.thinking-block, .tool-block').length;
  btn.classList.toggle('hidden', count === 0);
  const collapsed = msgEl.classList.contains('details-collapsed');
  btn.setAttribute('aria-expanded', String(!collapsed));
  btn.title = collapsed ? 'Show thinking and tool calls' : 'Hide thinking and tool calls';
  const label = btn.querySelector('.btn-msg-details-label');
  if (label) {
    label.textContent = `${collapsed ? 'Show' : 'Hide'} thinking & tools · ${count} step${count === 1 ? '' : 's'}`;
  }
}

function refreshMessageDetails(msgEl) {
  updateMessageDetailsButton(msgEl);
  syncMessageSteps(msgEl);
}

function setMessageDetailsCollapsed(msgEl, collapsed) {
  if (!msgEl?.classList.contains('msg-assistant')) return;
  msgEl.classList.toggle('details-collapsed', collapsed);

  // Expanding a reply shows its details immediately instead of making the
  // reader open every single block again.
  if (!collapsed) {
    msgEl.querySelectorAll('.thinking-block, .tool-block').forEach((block) => {
      block.querySelector('.thinking-header, .tool-header')?.classList.add('open');
      block.querySelector('.thinking-body, .tool-body')?.classList.add('open');
    });
  }

  refreshMessageDetails(msgEl);
  ruler?.markOffsetsDirty();
  if (stickToBottom) scrollToBottom();
}

function toggleMessageDetails(msgEl) {
  setMessageDetailsCollapsed(msgEl, !msgEl.classList.contains('details-collapsed'));
}

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
  state.editing = null;
  renderEditBanner();
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
      // Reattached to a turn that is still running: keep its details open so
      // the reasoning/tools stay followable, matching a live send.
      const lastMsg = state.messages[state.messages.length - 1];
      const groups = $$('.msg-assistant:not(.msg-working-placeholder)');
      const lastGroup = groups[groups.length - 1];
      if (lastMsg?.role === 'assistant' && lastGroup) {
        setMessageDetailsCollapsed(lastGroup, false);
      }
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
  state.editing = null;
  renderEditBanner();
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

function captureMessageOpenState() {
  const tools = new Map();
  const thinking = new Map();
  const groups = new Map();

  $$('.msg', chatMessages).forEach(msgEl => {
    const msgId = msgEl.dataset.id;
    if (!msgId) return;

    if (msgEl.classList.contains('msg-assistant')) {
      groups.set(msgId, msgEl.classList.contains('details-collapsed'));
    }

    msgEl.querySelectorAll('.tool-block').forEach(block => {
      const toolId = block.dataset.toolId;
      if (!toolId) return;
      tools.set(`tool:${msgId}:${toolId}`, !!block.querySelector('.tool-body')?.classList.contains('open'));
    });

    msgEl.querySelectorAll('.thinking-block').forEach((block, index) => {
      thinking.set(`thinking:${msgId}:${index}`, !!block.querySelector('.thinking-body')?.classList.contains('open'));
    });
  });

  return { tools, thinking, groups };
}

function restoreMessageOpenState(state) {
  if (!state) return;
  const { tools, thinking, groups } = state;

  $$('.msg', chatMessages).forEach(msgEl => {
    const msgId = msgEl.dataset.id;
    if (!msgId) return;

    if (groups?.has(msgId)) {
      msgEl.classList.toggle('details-collapsed', groups.get(msgId));
    }

    msgEl.querySelectorAll('.tool-block').forEach(block => {
      const toolId = block.dataset.toolId;
      const key = `tool:${msgId}:${toolId}`;
      if (!toolId || !tools.has(key)) return;
      const open = tools.get(key);
      block.querySelector('.tool-header')?.classList.toggle('open', open);
      block.querySelector('.tool-body')?.classList.toggle('open', open);
    });

    msgEl.querySelectorAll('.thinking-block').forEach((block, index) => {
      const key = `thinking:${msgId}:${index}`;
      if (!thinking.has(key)) return;
      const open = thinking.get(key);
      block.querySelector('.thinking-header')?.classList.toggle('open', open);
      block.querySelector('.thinking-body')?.classList.toggle('open', open);
    });
  });

  $$('.msg-assistant', chatMessages).forEach(msgEl => refreshMessageDetails(msgEl));
}

function renderAllMessages({ forceScroll = true } = {}) {
  const previousScrollTop = chatMessages.scrollTop;
  const wasStick = stickToBottom;
  const openState = captureMessageOpenState();

  // Remove existing messages
  const existing = $$('.msg', chatMessages);
  existing.forEach(el => el.remove());

  // Show the welcome screen for an empty session; remove it otherwise.
  const welcome = $('.welcome', chatMessages);
  if (state.messages.length > 0) {
    welcome?.remove();
  } else if (!welcome && welcomeTemplate) {
    chatMessages.appendChild(welcomeTemplate.cloneNode(true));
  }

  for (const msg of state.messages) {
    appendMessage(msg);
  }

  restoreMessageOpenState(openState);
  updateSidebarUsage();

  if (forceScroll || wasStick) {
    // A freshly rendered transcript should open at the latest message.
    scrollToBottom(true);
  } else {
    // A background refresh (e.g. stream finished while reading history) must
    // keep the reader where they were; scroll events will re-evaluate stick.
    chatMessages.scrollTop = previousScrollTop;
    markNewOutput();
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
        renderAllMessages({ forceScroll: false });
        setStreaming(false);
        await loadSessionList();
      }
    } catch {
      // Transient fetch failures should not freeze the UI; keep polling.
    }
  }, 1000);
}

async function sendPrompt(message, options = {}) {
  if (state.isStreaming || state.uploading > 0) return;
  const sid = state.sessionId;
  const retryAttachments = Array.isArray(options.attachments) ? options.attachments : null;
  const attachments = (retryAttachments || state.pendingAttachments).slice();
  if (!message.trim() && attachments.length === 0) return;

  if (state.editing && !options.skipEdit) {
    const edit = state.editing;
    try {
      const result = await apiJSON('POST', `/api/sessions/${edit.sessionId}/branch`, {
        entryId: edit.entryId,
      });
      state.editing = null;
      renderEditBanner();
      await switchSession(result.sessionId);
      showNotice('Started a new branch. The original conversation is preserved.');
      return sendPrompt(message, { ...options, skipEdit: true });
    } catch (err) {
      showError(`Could not start a branch: ${err.message}`);
      return;
    }
  }

  chatMessages.querySelectorAll('.msg-error').forEach(el => el.remove());

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
  // Sending a prompt is an explicit jump to the latest output.
  scrollToBottom(true);

  // Clear the composer for a normal send. A retry keeps whatever the user
  // has typed in the meantime.
  if (!retryAttachments) {
    promptInput.value = '';
    state.pendingAttachments = [];
    renderAttachmentTray();
    autoResize();
    updateSendState();
  }

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
  // A reply that is being generated stays expanded so thinking and tool calls
  // can be followed live. It collapses automatically when the turn ends.
  setMessageDetailsCollapsed(assistantEl, false);
  const msgContentEl = $('.msg-content', assistantEl);

  // Keep the streamed content in its own container so the Working indicator
  // can live below it and survive every innerHTML rebuild.
  const msgStepsEl = $('.msg-steps', assistantEl) || msgContentEl;
  const contentEl = document.createElement('div');
  contentEl.className = 'msg-stream';
  msgStepsEl.appendChild(contentEl);

  const workingEl = document.createElement('div');
  workingEl.className = 'working-indicator';
  workingEl.setAttribute('role', 'status');
  workingEl.setAttribute('aria-live', 'polite');
  workingEl.innerHTML = WORKING_INDICATOR_INNER;
  msgStepsEl.appendChild(workingEl);

  // Streaming state
  let currentText = '';
  let currentThinking = '';
  let activeThinkingText = '';
  let toolBlocks = []; // { id, name, input, result, isError, el }
  let thinkingBlockEl = null;
  let thinkingBodyEl = null;
  let activeToolBlock = null;
  let activeToolBody = null;

  scrollToBottom();

  let streamCtx = null;
  let requestStarted = false;
  let responseStarted = false;
  let httpError = false;
  let recoverAfterDisconnect = false;
  let removeOptimistic = false;

  try {
    requestStarted = true;
    const res = await fetch(`/api/sessions/${sid}/prompt`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ message: modelMessage, images }),
    });

    if (!res.ok) {
      httpError = true;
      const err = await res.json().catch(() => ({ error: res.statusText }));
      throw new Error(err.error || `HTTP ${res.status}`);
    }

    responseStarted = true;
    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    streamCtx = {
      sessionId: sid,
      contentEl, assistantEl, assistantMsg, userMsg, workingEl,
      get currentText() { return currentText; },
      set currentText(v) { currentText = v; },
      get currentThinking() { return currentThinking; },
      set currentThinking(v) { currentThinking = v; },
      get activeThinkingText() { return activeThinkingText; },
      set activeThinkingText(v) { activeThinkingText = v; },
      toolBlocks,
      get thinkingBlockEl() { return thinkingBlockEl; },
      set thinkingBlockEl(v) { thinkingBlockEl = v; },
      get thinkingBodyEl() { return thinkingBodyEl; },
      set thinkingBodyEl(v) { thinkingBodyEl = v; },
      get activeToolBlock() { return activeToolBlock; },
      set activeToolBlock(v) { activeToolBlock = v; },
      get activeToolBody() { return activeToolBody; },
      set activeToolBody(v) { activeToolBody = v; },
    };
    const parser = createSSEParser((type, data) => handleSSEEvent(type, data, streamCtx));

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      parser.push(decoder.decode(value, { stream: true }));
    }
    parser.push(decoder.decode());
    parser.end();
  } catch (err) {
    if (err.name === 'AbortError') {
      // User aborted
      if (contentEl) {
        contentEl.querySelector('.streaming-cursor')?.classList.remove('streaming-cursor');
      }
    } else if (responseStarted || (requestStarted && !httpError)) {
      // The response stream broke mid-task (sleep, Wi-Fi change, proxy), or
      // the network failed before headers arrived. The agent may still be
      // running server-side; keep the working UI and reconcile with the
      // session once it finishes.
      recoverAfterDisconnect = true;
      showNotice(`Connection lost (${err.message}). Waiting for the session to finish…`);
      startSessionPoll(sid);
    } else {
      // The server rejected the request before any stream started, so the
      // optimistic user message was never persisted. Remove it instead of
      // leaving a ghost message that disappears on the next reload.
      removeOptimistic = true;
      showError(err.message, () => sendPrompt(message, { attachments }));
    }
  } finally {
    state.currentStream = null;

    if (removeOptimistic && state.sessionId === sid) {
      const removedIds = new Set([userMsg.id, assistantMsg.id]);
      state.messages = state.messages.filter(msg => !removedIds.has(msg.id));
      renderAllMessages({ forceScroll: false });
      setStreaming(false);
    }

    // The user may have switched sessions while this stream was running. Only
    // touch shared UI/state if this stream still owns the visible session and
    // its DOM is still mounted.
    if (state.sessionId === sid && assistantEl.isConnected && !recoverAfterDisconnect) {
      if (streamCtx) flushAssistantContentRender(contentEl, streamCtx);
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

      // The turn is over: fold the reasoning and tool output away so the
      // transcript reads as a plain question/answer log.
      setMessageDetailsCollapsed(assistantEl, true);
    }

    await loadSessionList();
  }
}

function findLiveToolBlock(contentEl, tb) {
  const live = [...contentEl.querySelectorAll('.tool-block')]
    .find(el => el.dataset.toolId === String(tb.id));
  return live || tb.el;
}

function handleSSEEvent(type, data, ctx) {
  // Ignore events from a session that was switched away from (or whose DOM
  // was replaced). Otherwise a background stream can scroll the new session
  // or corrupt its messages.
  if (ctx.sessionId !== state.sessionId || !ctx.contentEl?.isConnected) return;

  if (!stickToBottom) markNewOutput();

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
      scheduleAssistantContentRender(contentEl, ctx);
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
      ctx.activeThinkingText = '';
      refreshMessageDetails(ctx.assistantEl);
      scrollToBottom();
      break;
    }

    case 'thinking': {
      ctx.currentThinking += data.delta;
      ctx.activeThinkingText = (ctx.activeThinkingText || '') + data.delta;
      if (ctx.thinkingBodyEl) {
        // Show only this block's text; currentThinking still accumulates the
        // full reasoning for the persisted assistant message.
        ctx.thinkingBodyEl.textContent = ctx.activeThinkingText;
        scrollToBottom();
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
      block.dataset.toolId = data.toolCallId || '';
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
      refreshMessageDetails(ctx.assistantEl);
      scrollToBottom();
      break;
    }

    case 'tool_update': {
      const tb = ctx.toolBlocks.find(t => t.id === data.toolCallId);
      if (!tb) break;
      const liveEl = findLiveToolBlock(contentEl, tb);
      const body = liveEl?.querySelector('.tool-body');
      if (!body) break;
      tb.el = liveEl;
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
        // Event output is cumulative, so replace instead of appending. Keep
        // only the tail of very large outputs to avoid multi-megabyte text
        // nodes and expensive re-layouts.
        const MAX_STREAM_OUTPUT = 12000;
        const display = output.length > MAX_STREAM_OUTPUT
          ? `… (${output.length - MAX_STREAM_OUTPUT} characters hidden) …\n` + output.slice(-MAX_STREAM_OUTPUT)
          : output;
        tb.streamOutput = display;
        code.textContent = display;
        scrollToBottom();
      }
      break;
    }

    case 'tool_end': {
      const tb = ctx.toolBlocks.find(t => t.id === data.toolCallId);
      if (tb) {
        const liveEl = findLiveToolBlock(contentEl, tb);
        tb.el = liveEl;
        const status = liveEl?.querySelector('.tool-status');
        if (status) {
          if (data.isError) {
            status.className = 'tool-status error';
            status.textContent = 'Error';
            tb.isError = true;
          } else {
            status.className = 'tool-status success';
            status.textContent = 'Done';
          }
        }
        tb.result = data.output || '';
        tb.streamOutput = '';

        // Add/replace result in body, reusing the streaming output node if any.
        const body = liveEl?.querySelector('.tool-body');
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
        const header = liveEl?.querySelector('.tool-header');
        if (header) {
          header.classList.remove('open');
          body?.classList.remove('open');
        }
      }
      ctx.activeToolBlock = null;
      ctx.activeToolBody = null;
      // The model now has the tool result and is working on the next step.
      showWorking(ctx);
      scrollToBottom();
      break;
    }

    case 'agent_start':
      showWorking(ctx);
      break;

    case 'message_start':
      if (ctx.thinkingBlockEl) {
        ctx.thinkingBlockEl.querySelector('.thinking-body')?.classList.remove('open');
        ctx.thinkingBlockEl = null;
        ctx.thinkingBodyEl = null;
        ctx.activeThinkingText = '';
      }
      showWorking(ctx);
      break;

    case 'agent_end':
      hideWorking(ctx);
      break;

    case 'message_end': {
      const usage = normalizeUsage(data.usage);
      if (ctx.assistantMsg) {
        if (usage) ctx.assistantMsg.usage = mergeUsage(ctx.assistantMsg.usage, usage);
        if (data.timestamp) ctx.assistantMsg.timestamp = data.timestamp;
      }
      if (ctx.assistantEl) updateMessageMeta(ctx.assistantEl);
      updateSidebarUsage();
      break;
    }

    case 'turn_end':
    case 'turn_start':
      break;

    case 'done':
      hideWorking(ctx);
      if (data.userEntryId && ctx.userMsg) {
        ctx.userMsg.entryId = data.userEntryId;
        refreshMessageEditButton(ctx.userMsg);
      }
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
  if (!ctx?.workingEl) return;
  ctx.workingEl.classList.remove('hidden');
  scrollToBottom();
}

function hideWorking(ctx) {
  ctx?.workingEl?.classList.add('hidden');
}

let pendingStreamRender = null;

// Coalesce text deltas to at most one render per frame. Rebuilding the whole
// streamed message for every token is both O(n^2) and very layout-heavy.
function scheduleAssistantContentRender(contentEl, ctx) {
  if (pendingStreamRender?.contentEl === contentEl) return;
  if (pendingStreamRender) cancelAnimationFrame(pendingStreamRender.raf);
  pendingStreamRender = {
    contentEl,
    ctx,
    raf: requestAnimationFrame(() => {
      const job = pendingStreamRender;
      pendingStreamRender = null;
      if (job?.contentEl?.isConnected) updateAssistantContent(job.contentEl, job.ctx);
    }),
  };
}

function flushAssistantContentRender(contentEl, ctx) {
  if (pendingStreamRender?.contentEl === contentEl) {
    cancelAnimationFrame(pendingStreamRender.raf);
    pendingStreamRender = null;
  }
  if (contentEl?.isConnected) updateAssistantContent(contentEl, ctx);
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

  html += ctx.currentText
    ? `<div class="msg-answer">${renderMarkdown(ctx.currentText)}</div>`
    : '';
  html += '<span class="streaming-cursor"></span>';

  // Remember which tool bodies the user expanded/collapsed before the rebuild.
  const previousToolIds = new Set();
  const openToolIds = new Set();
  contentEl.querySelectorAll('.tool-block').forEach(block => {
    const id = block.dataset.toolId;
    if (!id) return;
    previousToolIds.add(id);
    if (block.querySelector('.tool-body')?.classList.contains('open')) {
      openToolIds.add(id);
    }
  });

  contentEl.innerHTML = html;
  if (ctx.assistantMsg) ctx.assistantMsg.content = ctx.currentText;
  const liveCopyBtn = contentEl.closest('.msg')?.querySelector('.msg-copy-btn');
  if (liveCopyBtn) liveCopyBtn.classList.toggle('hidden', !ctx.currentText);

  // Restore the user's toggle state; newly rendered tools keep their default
  // (running tools open, completed tools closed).
  contentEl.querySelectorAll('.tool-block').forEach(block => {
    const id = block.dataset.toolId;
    if (!id) return;
    const header = block.querySelector('.tool-header');
    const body = block.querySelector('.tool-body');
    const shouldOpen = previousToolIds.has(id)
      ? openToolIds.has(id)
      : !!body?.classList.contains('open');
    header?.classList.toggle('open', shouldOpen);
    body?.classList.toggle('open', shouldOpen);
  });

  // onclick attributes in renderToolCall/renderThinking already handle toggling.
  // No duplicate addEventListener needed — that would toggle twice per click.
  // Only attach copy button handlers (onclick in code blocks uses data-"code" attr).
  contentEl.querySelectorAll('.copy-btn').forEach(btn => {
    btn.addEventListener('click', (e) => {
      e.stopPropagation();
      copyButtonWithFeedback(btn);
    });
  });

  refreshMessageDetails(contentEl.closest('.msg'));
  scrollToBottom();
}

// ── Error display ─────────────────────────────────────────────────────────

function showError(message, retry) {
  chatMessages.querySelectorAll('.msg-error').forEach(el => el.remove());

  const div = document.createElement('div');
  div.className = 'msg-error';

  const text = document.createElement('span');
  text.className = 'msg-error-text';
  text.textContent = `Error: ${message}`;
  div.appendChild(text);

  if (typeof retry === 'function') {
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'msg-error-retry';
    button.textContent = 'Retry';
    button.addEventListener('click', () => {
      div.remove();
      retry();
    });
    div.appendChild(button);
  } else {
    setTimeout(() => div.remove(), 8000);
  }

  chatMessages.appendChild(div);
  scrollToBottom();
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
btnCancelEdit?.addEventListener('click', cancelEdit);

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

// Exposed for scripts/smoke.mjs and browser-console debugging.
window.__piWeb = {
  state,
  appendMessage,
  renderAllMessages,
  sendPrompt,
  updateSidebarUsage,
  handleSSEEvent,
  scrollToBottom,
  renderWorkingIndicator,
  stopSessionPoll,
  createSSEParser,
  renderMarkdown,
  escapeHtml,
  get stickToBottom() { return stickToBottom; },
  ruler,
  get rulerTicks() { return ruler?.getTicks() ?? []; },
  get rulerCurrentIndex() { return ruler?.getCurrentIndex() ?? 0; },
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
