// ── SSE parsing ───────────────────────────────────────────────────────────
// Keep incomplete lines across network chunks: a `data:` payload can be split
// anywhere, and dropping the tail loses thinking/text deltas.
function emitSSEBlock(block, onEvent) {
  let eventType = '';
  const dataLines = [];

  for (const rawLine of block.split('\n')) {
    const line = rawLine.endsWith('\r') ? rawLine.slice(0, -1) : rawLine;
    if (!line || line.startsWith(':')) continue;

    const colon = line.indexOf(':');
    const field = colon === -1 ? line : line.slice(0, colon);
    let value = colon === -1 ? '' : line.slice(colon + 1);
    if (value.startsWith(' ')) value = value.slice(1);

    if (field === 'event') eventType = value;
    else if (field === 'data') dataLines.push(value);
  }

  if (!dataLines.length) return;
  const payload = dataLines.join('\n');
  try {
    onEvent(eventType, JSON.parse(payload));
  } catch (err) {
    console.warn('Failed to parse SSE event', eventType, err);
  }
}

export function createSSEParser(onEvent) {
  let buffer = '';

  return {
    push(chunk) {
      buffer += chunk;
      // Normalise CRLF, including a CR that ended the previous chunk.
      buffer = buffer.replace(/\r\n?/g, '\n');

      let boundary = buffer.indexOf('\n\n');
      while (boundary !== -1) {
        const block = buffer.slice(0, boundary);
        buffer = buffer.slice(boundary + 2);
        emitSSEBlock(block, onEvent);
        boundary = buffer.indexOf('\n\n');
      }
    },
    end() {
      if (buffer.trim()) emitSSEBlock(buffer, onEvent);
      buffer = '';
    },
  };
}
