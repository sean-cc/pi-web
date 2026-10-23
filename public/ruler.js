// Conversation timeline: one tick per user prompt, with a fixed minimum gap
// and a scrolling window when prompts overflow. Extracted from app.js.
export function createRuler(options) {
  const {
    chatMessages, rulerEl, trackEl, tipEl, tipRoleEl, tipTextEl,
    isNearBottom, setStickToBottom, updateJumpButton,
  } = options;

let rulerTicks = [];
let rulerRaf = 0;
let rulerDragging = false;
let hoveredTick = null;
let rulerWindowOffset = 0;
let rulerCurrentIndex = 0;
let rulerOffsetsDirty = true;
let rulerLastOffsetMeasure = 0;
let rulerTicksVersion = 0;
let rulerLastLayoutKey = '';
let rulerLastCurrentVersion = -1;
let rulerLastCurrentIndex = -1;
let rulerEdgeTimer = null;
let rulerEdgeDir = 0;
const RULER_MIN_GAP = 9;
const RULER_EDGE_ZONE = 18;
const RULER_EDGE_STEP = 2;
const RULER_EDGE_INTERVAL = 100;

function maxRulerScroll() {
  return Math.max(0, chatMessages.scrollHeight - chatMessages.clientHeight);
}

function scheduleRulerUpdate() {
  if (rulerRaf) return;
  rulerRaf = requestAnimationFrame(() => {
    rulerRaf = 0;
    refreshRuler();
  });
}

function syncRulerTicks(messages) {
  const changed = messages.length !== rulerTicks.length
    || messages.some((msgEl, i) => rulerTicks[i].msgEl !== msgEl);
  if (!changed) return;

  hoveredTick = null;
  tipEl.classList.remove('visible');
  rulerOffsetsDirty = true;
  rulerTicksVersion += 1;
  trackEl.querySelectorAll('.ruler-tick').forEach(el => el.remove());
  rulerTicks = messages.map((msgEl) => {
    const el = document.createElement('div');
    el.className = 'ruler-tick';
    trackEl.appendChild(el);
    return { el, msgEl, y: 0, offset: 0 };
  });
}

function refreshRuler() {
  updateJumpButton?.();
  const maxScroll = maxRulerScroll();
  const prompts = [...chatMessages.querySelectorAll('.msg-user')];

  if (maxScroll < 8 || prompts.length === 0) {
    rulerEl.hidden = true;
    hideRulerTip();
    if (rulerTicks.length) {
      trackEl.querySelectorAll('.ruler-tick').forEach(el => el.remove());
      rulerTicks = [];
    }
    return;
  }
  rulerEl.hidden = false;
  syncRulerTicks(prompts);

  const containerRect = chatMessages.getBoundingClientRect();
  const scrollTop = chatMessages.scrollTop;
  const trackHeight = trackEl.clientHeight || 1;

  // Evenly spaced slots: the ruler is an index of prompts, not a map of the
  // transcript's pixel offsets (long replies no longer create huge gaps).
  const count = rulerTicks.length;
  const edgePadding = Math.min(10, trackHeight / 4);
  const usableHeight = Math.max(1, trackHeight - edgePadding * 2);

  // `gap` never drops below RULER_MIN_GAP. Once the prompts no longer fit,
  // the ruler becomes a scrolling window over a taller fixed-pitch stack
  // instead of dropping ticks or squeezing them together.
  const capacity = Math.max(2, Math.floor(usableHeight / RULER_MIN_GAP) + 1);
  const scrollable = count > capacity;
  const gap = scrollable
    ? RULER_MIN_GAP
    : (count > 1 ? usableHeight / (count - 1) : 0);
  const totalHeight = scrollable
    ? edgePadding * 2 + (count - 1) * RULER_MIN_GAP
    : trackHeight;

  // Measure prompt offsets on structure/layout changes, or at most a few
  // times per second. During streaming, scrolling alone does not move prompts
  // above the live message, so cached offsets stay valid and we avoid doing
  // hundreds of layout reads on every animation frame.
  const now = performance.now();
  if (rulerOffsetsDirty || now - rulerLastOffsetMeasure > 200) {
    rulerTicks.forEach((tick) => {
      const rect = tick.msgEl.getBoundingClientRect();
      tick.offset = Math.max(0, rect.top - containerRect.top + scrollTop);
    });
    rulerOffsetsDirty = false;
    rulerLastOffsetMeasure = now;
  }

  let currentIndex = 0;
  rulerTicks.forEach((tick, index) => {
    // The current prompt is the last one that started above the viewport.
    if (tick.offset <= scrollTop + 2) currentIndex = index;
  });
  // At the very bottom the last prompt may sit below the viewport top; it is
  // still the one being followed.
  if (maxScroll > 0 && scrollTop >= maxScroll - 2) currentIndex = count - 1;
  rulerCurrentIndex = currentIndex;

  // Slide the window just enough to keep the reading position visible. This is
  // what makes the ruler scroll with the conversation once it overflows.
  if (scrollable) {
    const focusScroll = scrollTop + chatMessages.clientHeight / 2;
    let focusIndex = 0;
    for (let i = 0; i < count; i++) {
      if (rulerTicks[i].offset <= focusScroll) focusIndex = i;
    }
    // Interpolate between prompts so the window glides instead of jumping
    // whenever a long reply is being read.
    if (focusIndex < count - 1) {
      const prevOffset = rulerTicks[focusIndex].offset;
      const nextOffset = rulerTicks[focusIndex + 1].offset;
      if (nextOffset > prevOffset) {
        const progress = Math.max(0, Math.min(1, (focusScroll - prevOffset) / (nextOffset - prevOffset)));
        focusIndex += progress;
      }
    }

    const focusY = edgePadding + focusIndex * RULER_MIN_GAP;
    const maxOffset = Math.max(0, totalHeight - trackHeight);
    // Keep the reading position centred in the ruler window.
    rulerWindowOffset = Math.max(0, Math.min(maxOffset, focusY - trackHeight / 2));
  } else {
    rulerWindowOffset = 0;
  }

  const layoutKey = `${rulerTicksVersion}|${gap}|${trackHeight}|${rulerWindowOffset}|${count}`;
  if (layoutKey !== rulerLastLayoutKey) {
    rulerTicks.forEach((tick, index) => {
      const stackY = count === 1 ? trackHeight / 2 : edgePadding + index * gap;
      tick.y = stackY - rulerWindowOffset;
      tick.el.style.top = `${tick.y}px`;
    });
    rulerLastLayoutKey = layoutKey;
  }

  if (rulerTicksVersion !== rulerLastCurrentVersion || currentIndex !== rulerLastCurrentIndex) {
    const currentTick = rulerTicks[currentIndex] || null;
    for (const tick of rulerTicks) {
      tick.el.classList.toggle('current', tick === currentTick);
    }
    rulerLastCurrentVersion = rulerTicksVersion;
    rulerLastCurrentIndex = currentIndex;
  }

  if (hoveredTick && (hoveredTick.y < -8 || hoveredTick.y > trackHeight + 8)) {
    hideRulerTip();
  }
}

function rulerMessagePreview(msgEl) {
  const content = msgEl.querySelector('.msg-content');
  if (!content) return '';
  const clone = content.cloneNode(true);
  clone.querySelectorAll('.tool-block, .thinking-block, .working-indicator, .msg-attachments, .streaming-cursor, .copy-btn')
    .forEach(node => node.remove());

  // textContent would glue separate block elements together, so add spaces
  // around block-level nodes before normalizing.
  let text = '';
  const walk = (node) => {
    if (node.nodeType === 3) {
      text += node.nodeValue + ' ';
      return;
    }
    if (node.nodeType !== 1) return;
    if (node.tagName === 'BR') {
      text += ' ';
      return;
    }
    const block = /^(P|DIV|LI|UL|OL|H[1-6]|PRE|BLOCKQUOTE|TR|TABLE)$/.test(node.tagName);
    if (block) text += ' ';
    for (const child of node.childNodes) walk(child);
    if (block) text += ' ';
  };
  walk(clone);

  return text.replace(/\s+/g, ' ').trim().slice(0, 240);
}

function setHoveredTick(tick) {
  if (hoveredTick === tick) return;
  hoveredTick?.el.classList.remove('hover');
  hoveredTick = tick;
  hoveredTick?.el.classList.add('hover');
}

function hideRulerTip() {
  tipEl.classList.remove('visible');
  setHoveredTick(null);
}

function showRulerTip(tick) {
  if (hoveredTick === tick && tipEl.classList.contains('visible')) return;
  setHoveredTick(tick);

  const isUser = tick.msgEl.classList.contains('msg-user');
  tipRoleEl.textContent = isUser ? 'You' : 'Pi';
  tipRoleEl.classList.toggle('assistant', !isUser);
  tipTextEl.textContent = rulerMessagePreview(tick.msgEl) || '(empty message)';
  tipEl.classList.add('visible');

  const tipHeight = tipEl.offsetHeight;
  const rulerRect = rulerEl.getBoundingClientRect();
  const tickRect = tick.el.getBoundingClientRect();
  let top = tickRect.top + tickRect.height / 2 - tipHeight / 2;
  top = Math.max(8, Math.min(window.innerHeight - tipHeight - 8, top));
  tipEl.style.top = `${top}px`;
  tipEl.style.right = `${Math.max(8, window.innerWidth - rulerRect.left + 10)}px`;
}

function nearestRulerTick(clientY) {
  const rect = trackEl.getBoundingClientRect();
  const y = clientY - rect.top;
  let best = null;
  let bestDistance = Infinity;
  const trackHeight = rect.height;
  for (const tick of rulerTicks) {
    // Ignore ticks currently clipped outside the ruler window.
    if (tick.y < -6 || tick.y > trackHeight + 6) continue;
    const distance = Math.abs(tick.y - y);
    if (distance < bestDistance) {
      best = tick;
      bestDistance = distance;
    }
  }
  return best;
}

function goToRulerIndex(index) {
  if (!rulerTicks.length) return;
  const targetIndex = Math.max(0, Math.min(rulerTicks.length - 1, index));
  const target = rulerTicks[targetIndex];
  if (!target) return;

  rulerCurrentIndex = targetIndex;
  setStickToBottom(false);
  hideRulerTip();
  chatMessages.scrollTop = Math.min(target.offset, maxRulerScroll());
  scheduleRulerUpdate();
}

function jumpRulerTo(clientY) {
  const target = nearestRulerTick(clientY);
  if (!target) return;
  goToRulerIndex(rulerTicks.indexOf(target));
}

function stopRulerEdgeScroll() {
  if (rulerEdgeTimer) clearInterval(rulerEdgeTimer);
  rulerEdgeTimer = null;
  rulerEdgeDir = 0;
}

function advanceRulerEdge() {
  if (!rulerDragging || !rulerEdgeDir || !rulerTicks.length) {
    stopRulerEdgeScroll();
    return;
  }

  const nextIndex = rulerCurrentIndex + rulerEdgeDir * RULER_EDGE_STEP;
  const clamped = Math.max(0, Math.min(rulerTicks.length - 1, nextIndex));
  if (clamped === rulerCurrentIndex) {
    stopRulerEdgeScroll();
    return;
  }

  goToRulerIndex(clamped);
}

function setRulerEdgeDirection(direction) {
  if (direction === rulerEdgeDir && (direction === 0 || rulerEdgeTimer)) return;
  rulerEdgeDir = direction;
  if (!direction) {
    stopRulerEdgeScroll();
    return;
  }
  if (!rulerEdgeTimer) {
    rulerEdgeTimer = setInterval(advanceRulerEdge, RULER_EDGE_INTERVAL);
  }
}

function updateRulerEdgeMode(clientY) {
  const rect = trackEl.getBoundingClientRect();
  const y = clientY - rect.top;
  if (y < RULER_EDGE_ZONE) setRulerEdgeDirection(-1);
  else if (y > rect.height - RULER_EDGE_ZONE) setRulerEdgeDirection(1);
  else setRulerEdgeDirection(0);
}

function endRulerDrag(event) {
  if (!rulerDragging) return;
  rulerDragging = false;
  rulerEl.classList.remove('dragging');
  if (event && trackEl.hasPointerCapture?.(event.pointerId)) {
    try { trackEl.releasePointerCapture(event.pointerId); } catch {}
  }
  stopRulerEdgeScroll();
  setStickToBottom(isNearBottom());
  scheduleRulerUpdate();
}

trackEl.addEventListener('pointerdown', (event) => {
  if (event.button !== 0) return;
  event.preventDefault();
  rulerDragging = true;
  rulerEl.classList.add('dragging');
  try { trackEl.focus({ preventScroll: true }); } catch {}
  try { trackEl.setPointerCapture(event.pointerId); } catch {}
  jumpRulerTo(event.clientY);
  updateRulerEdgeMode(event.clientY);
});

trackEl.addEventListener('pointermove', (event) => {
  if (rulerDragging) {
    const rect = trackEl.getBoundingClientRect();
    const y = event.clientY - rect.top;
    if (y < RULER_EDGE_ZONE || y > rect.height - RULER_EDGE_ZONE) {
      updateRulerEdgeMode(event.clientY);
      return;
    }
    setRulerEdgeDirection(0);
    jumpRulerTo(event.clientY);
    return;
  }
  const tick = nearestRulerTick(event.clientY);
  if (tick) showRulerTip(tick);
  else hideRulerTip();
});

trackEl.addEventListener('keydown', (event) => {
  if (!rulerTicks.length) return;
  let nextIndex;
  switch (event.key) {
    case 'ArrowUp': nextIndex = rulerCurrentIndex - 1; break;
    case 'ArrowDown': nextIndex = rulerCurrentIndex + 1; break;
    case 'PageUp': nextIndex = rulerCurrentIndex - 5; break;
    case 'PageDown': nextIndex = rulerCurrentIndex + 5; break;
    case 'Home': nextIndex = 0; break;
    case 'End': nextIndex = rulerTicks.length - 1; break;
    default: return;
  }
  event.preventDefault();
  goToRulerIndex(nextIndex);
});

trackEl.addEventListener('pointerleave', () => {
  if (!rulerDragging) hideRulerTip();
});
trackEl.addEventListener('pointerup', endRulerDrag);
trackEl.addEventListener('pointercancel', endRulerDrag);

// Wheel over the ruler should still scroll the transcript.
trackEl.addEventListener('wheel', (event) => {
  const unit = event.deltaMode === 1 ? 16 : event.deltaMode === 2 ? chatMessages.clientHeight : 1;
  if (event.deltaY < 0) setStickToBottom(false);
  hideRulerTip();
  chatMessages.scrollTop += event.deltaY * unit;
  event.preventDefault();
}, { passive: false });

// Keep ticks in sync with message inserts/removals and streaming updates.
new MutationObserver(scheduleRulerUpdate).observe(chatMessages, {
  childList: true,
  subtree: true,
  characterData: true,
});
window.addEventListener('resize', () => {
  rulerOffsetsDirty = true;
  scheduleRulerUpdate();
});
chatMessages.addEventListener('load', () => {
  rulerOffsetsDirty = true;
  scheduleRulerUpdate();
}, true);
if (window.ResizeObserver) {
  new ResizeObserver(scheduleRulerUpdate).observe(chatMessages);
}
scheduleRulerUpdate();


  function markOffsetsDirty() {
    rulerOffsetsDirty = true;
    scheduleRulerUpdate();
  }

  scheduleRulerUpdate();

  return {
    scheduleUpdate: scheduleRulerUpdate,
    markOffsetsDirty,
    getTicks: () => rulerTicks,
    getCurrentIndex: () => rulerCurrentIndex,
  };
}
