// ── Simple Markdown Renderer ──────────────────────────────────────────────

export function escapeHtml(text) {
  const map = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };
  return text.replace(/[&<>"']/g, c => map[c]);
}

export function renderMarkdown(text) {
  if (!text) return '';

  // Extract code blocks from the raw text first: the copy button needs the
  // original code, and the placeholder protects it from escaping/formatting.
  const codeBlocks = [];
  let processed = text.replace(/```(\w*)\n?([\s\S]*?)```/g, (_, lang, code) => {
    const idx = codeBlocks.length;
    codeBlocks.push({ lang: lang || '', code: code.trimEnd() });
    return `\x00CODEBLOCK${idx}\x00`;
  });

  // Tables are extracted from raw text too; cells are escaped later by
  // renderInline so cell-level markdown still works.
  const tables = [];
  processed = processed.replace(
    /^\|(.+)\|\n\|([-:| ]+)\|\n(?:\|.+\|\n?)+/gm,
    (match) => {
      const idx = tables.length;
      tables.push(match.split('\n').filter(l => l.trim()));
      return `\x00TABLE${idx}\x00`;
    }
  );

  // Inline code is protected before the global escape pass.
  const inlineCodes = [];
  processed = processed.replace(/`([^`]+)`/g, (_, code) => {
    const idx = inlineCodes.length;
    inlineCodes.push(code);
    return `\x00INLINECODE${idx}\x00`;
  });

  // Escape all remaining text. This is the key XSS guard: everything that is
  // not one of the generated tags below is now inert.
  processed = escapeHtml(processed);

  // Explicit http(s) links. The label and URL are already HTML-escaped, and
  // the scheme allow-list prevents javascript:/data: URLs.
  processed = processed.replace(
    /\[([^\]]+)\]\((https?:\/\/[^)\s]+)\)/g,
    '<a href="$2" target="_blank" rel="noopener noreferrer">$1</a>',
  );

  // Bold / italic (contents are already escaped).
  processed = processed.replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>');
  processed = processed.replace(/\*([^*]+)\*/g, '<em>$1</em>');

  // Headers
  processed = processed.replace(/^#### (.+)$/gm, '<h4>$1</h4>');
  processed = processed.replace(/^### (.+)$/gm, '<h3>$1</h3>');
  processed = processed.replace(/^## (.+)$/gm, '<h2>$1</h2>');
  processed = processed.replace(/^# (.+)$/gm, '<h1>$1</h1>');

  // Blockquotes (the leading > was escaped to &gt; above)
  processed = processed.replace(/^&gt; (.+)$/gm, '<blockquote>$1</blockquote>');

  // Horizontal rules
  processed = processed.replace(/^---$/gm, '<hr>');

  // Lists: extract each block before paragraph wrapping so ordered and
  // unordered items cannot be nested inside each other by later passes.
  const lists = [];
  processed = processed.replace(/^(?:\d+\. .+(?:\n|$))+/gm, (block) => {
    const idx = lists.length;
    const items = block.trimEnd().split('\n')
      .map(line => `<li>${line.replace(/^\d+\.\s+/, '')}</li>`)
      .join('');
    lists.push(`<ol>${items}</ol>`);
    return `\x00LIST${idx}\x00\n`;
  });
  processed = processed.replace(/^(?:[*-] .+(?:\n|$))+/gm, (block) => {
    const idx = lists.length;
    const items = block.trimEnd().split('\n')
      .map(line => `<li>${line.replace(/^[*-]\s+/, '')}</li>`)
      .join('');
    lists.push(`<ul>${items}</ul>`);
    return `\x00LIST${idx}\x00\n`;
  });

  // Paragraphs: wrap remaining text blocks in <p>
  processed = processed.replace(/\n\n+/g, '</p><p>');
  processed = '<p>' + processed + '</p>';
  processed = processed.replace(/<p>\s*<\/p>/g, '');
  // Keep block elements out of paragraph wrappers.
  processed = processed.replace(/<p>\s*(<h[1-6][^>]*>)/g, '$1');
  processed = processed.replace(/(<\/h[1-6]>)\s*<\/p>/g, '$1');
  processed = processed.replace(/<p>\s*(<blockquote>)/g, '$1');
  processed = processed.replace(/(<\/blockquote>)\s*<\/p>/g, '$1');
  processed = processed.replace(/<p>\s*(<hr>)\s*<\/p>/g, '$1');
  processed = processed.replace(/<p>\x00(?:TABLE|LIST|CODEBLOCK)(\d+)\x00<\/p>/g, (match, idx) => match.replace(/<p>|<\/p>/g, ''));

  // Restore lists and tables
  processed = processed.replace(/\x00LIST(\d+)\x00/g, (_, idx) => lists[parseInt(idx)]);
  processed = processed.replace(/\x00TABLE(\d+)\x00/g, (_, idx) => renderTable(tables[parseInt(idx)]));

  // Restore code blocks, using the raw code for both display and copy.
  processed = processed.replace(/\x00CODEBLOCK(\d+)\x00/g, (_, idx) => {
    const block = codeBlocks[parseInt(idx)];
    const header = block.lang
      ? `<div class="code-header"><span>${escapeHtml(block.lang)}</span><button class="copy-btn" data-code="${encodeURIComponent(block.code)}">Copy</button></div>`
      : '';
    return `${header}<pre><code>${escapeHtml(block.code)}</code></pre>`;
  });

  // Restore inline code after all tag-generating passes.
  processed = processed.replace(/\x00INLINECODE(\d+)\x00/g, (_, idx) =>
    `<code>${escapeHtml(inlineCodes[parseInt(idx)])}</code>`
  );

  // Final safety pass: block-level output must not sit inside <p>.
  processed = processed.replace(/<p>\s*(<ul>|<ol>|<blockquote>|<h[1-6][^>]*>|<hr>|<div class="(?:table-wrapper|code-header)">|<pre>)/g, '$1');
  processed = processed.replace(/(<\/ul>|<\/ol>|<\/blockquote>|<\/h[1-6]>|<\/div>|<\/pre>)\s*<\/p>/g, '$1');
  processed = processed.replace(/<p>\s*<\/p>/g, '');

  return processed;
}

function renderInline(text) {
  // Table cells are raw here; escape once, then apply inline markdown.
  let result = escapeHtml(text);
  const inlineCodes = [];
  result = result.replace(/`([^`]+)`/g, (_, code) => {
    const idx = inlineCodes.length;
    inlineCodes.push(code);
    return `\x00INLINECODE${idx}\x00`;
  });
  result = result.replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>');
  result = result.replace(/\*([^*]+)\*/g, '<em>$1</em>');
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
