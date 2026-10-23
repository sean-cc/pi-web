import { escapeHtml, renderMarkdown } from './markdown.js';
import { formatBytes, attachmentIsImage, escapeAttr } from './util.js';

export function parseAttachmentMessage(content) {
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

export function renderMessageAttachments(attachments, images) {
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

export function renderToolCall(tc, index) {
  let statusClass = 'running';
  let statusText = 'Running...';
  if (tc.result !== null) {
    statusClass = tc.isError ? 'error' : 'success';
    statusText = tc.isError ? 'Error' : 'Done';
  }
  const title = tc.name || 'Tool';
  let output = tc.result !== null ? String(tc.result) : String(tc.pendingOutput || '');
  if (tc.result !== null) {
    output = output.slice(0, 8000);
  } else if (output.length > 13000) {
    output = `… (${output.length - 12000} characters hidden) …\n` + output.slice(-12000);
  }
  const outputType = tc.result !== null ? 'result' : 'output';
  return `
    <div class="tool-block" data-tool-index="${index}" data-tool-id="${escapeAttr(tc.id ?? '')}">
      <div class="tool-header${tc.result === null ? ' open' : ''}" onclick="toggleToolBlock(this)">
        <span class="tool-icon">🔧</span>
        <span class="tool-name">${escapeHtml(title)}</span>
        <span class="tool-status ${statusClass}">${statusText}</span>
        <span class="tool-chevron">▶</span>
      </div>
      <div class="tool-body${tc.result !== null ? '' : ' open'}">
        <pre><code>${escapeHtml(JSON.stringify(tc.input || {}, null, 2))}</code></pre>
        ${output ? `<pre data-type="${outputType}"><code>${escapeHtml(output)}</code></pre>` : ''}
      </div>
    </div>`;
}

export function renderThinking(thinking) {
  if (!thinking) return '';
  return `
    <div class="thinking-block">
      <div class="thinking-header" onclick="toggleToolBlock(this.parentElement.querySelector('.thinking-body'))">
        <span>💭 Thinking</span>
        <span class="tool-chevron">▶</span>
      </div>
      <div class="thinking-body">${escapeHtml(thinking)}</div>
    </div>`;
}

export function createMessageElement(msg) {
  const div = document.createElement('div');
  div.className = `msg msg-${msg.role}`;
  div.dataset.id = msg.id;

  const isUser = msg.role === 'user';
  const parsed = isUser ? parseAttachmentMessage(msg.content) : { text: msg.content, attachments: [] };
  const attachmentsHtml = isUser ? renderMessageAttachments(parsed.attachments, msg.images) : '';
  const avatar = isUser ? 'U' : 'P';
  div.innerHTML = `
    <div class="msg-aside">
      <div class="msg-avatar">${avatar}</div>
      <button class="msg-copy-btn" type="button" title="Copy message" aria-label="Copy message">⧉</button>
    </div>
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
