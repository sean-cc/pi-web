import { escapeHtml } from './markdown.js';

export function formatBytes(bytes) {
  if (!Number.isFinite(bytes)) return '';
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(bytes < 10 * 1024 ? 1 : 0)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

export function attachmentIsImage(a) {
  return Boolean(a) && (a.kind === 'image' || (a.kind !== 'text' && String(a.mimeType || '').startsWith('image/')));
}

export function attachmentLabel(a) {
  if (!a) return 'file';
  if (attachmentIsImage(a)) return 'image';
  return a.kind === 'text' ? 'text' : 'file';
}

export function escapeAttr(value) {
  return escapeHtml(String(value ?? ''));
}
