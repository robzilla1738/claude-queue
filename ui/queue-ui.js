#!/usr/bin/env node
'use strict';

/**
 * queue-ui.js — a minimal, black-and-white terminal task list for claude-queue.
 *
 * Usage:  node queue-ui.js <session_id>
 *
 * Each queued task is its own box. Click a box to select it; drag it up or
 * down to reorder (or click the ▲ / ▼ handles, or use Shift+↑/↓); remove with
 * ⌫ / d / the ✕ handle. The row under the mouse brightens so you can see what
 * a click will hit. New tasks are typed into the box at the top. The list
 * reads and writes the same per-session queue file as the Stop hook, so
 * whatever is here is what the running Claude session works through, one item
 * at a time, and it refreshes live (fs.watch) as items are consumed.
 *
 * Design: monochrome only — white / grey on black, selection shown by inverting
 * the box (black on white), hover shown by brightening grey to white. No accent
 * colors.
 */

const path = require('path');
const fs = require('fs');

let blessed;
try {
  blessed = require('blessed');
} catch (_err) {
  console.error(
    'The queue UI needs the "blessed" package.\n' +
      'Install it once with:  (cd "' + __dirname + '" && npm install)\n'
  );
  process.exit(1);
}

const store = require(path.join(__dirname, '..', 'scripts', 'lib', 'queue-store'));

const sessionId = process.argv[2] || process.env.CLAUDE_SESSION_ID || 'default';
const queueFile = store.queuePath(sessionId);

// Monochrome palette — only white, grey (ANSI bright-black = index 8) and black.
// Using the numeric index avoids blessed's hex→palette mis-mapping and renders
// as a true grey in 16-colour, 256-colour and truecolour terminals alike.
const FG = 'white';
const DIM = 8;
const FAINT = 8;

// Display-width helpers (emoji / CJK are 2 columns wide). blessed ships these;
// fall back to code-unit counting if a future blessed drops them.
const uni = blessed.unicode;
const strW = uni && uni.strWidth ? (s) => uni.strWidth(s) : (s) => String(s).length;
const charW = uni && uni.charWidth ? (s, i) => uni.charWidth(s, i) : () => 1;
const isSurrogate = uni && uni.isSurrogate ? (s, i) => uni.isSurrogate(s, i) : () => false;

// ---------------------------------------------------------------------------
// Screen + static chrome
// ---------------------------------------------------------------------------
const screen = blessed.screen({
  smartCSR: true,
  title: `claude-queue · ${sessionId}`,
  mouse: true,
  fullUnicode: true,
});

// When the terminal is Unicode-capable (blessed detects this from the locale),
// draw real box-drawing characters instead of the legacy ACS charset — ACS
// degrades to bare letters (lqqqk) in some captures and multiplexers.
if (screen.tput && screen.tput.unicode) screen.tput.brokenACS = true;

const header = blessed.box({
  parent: screen,
  top: 0,
  left: 2,
  right: 2,
  height: 1,
  tags: true,
  style: { fg: FG },
});

// Note: deliberately NOT inputOnFocus. With it, blessed's readInput cleanup
// calls screen.rewindFocus() on blur, which re-focuses the input, which
// re-enters readInput — so any programmatic focus move away from a reading
// input (e.g. pressing on a task) recurses until the stack overflows. We bind
// focus → readInput ourselves below, which skips the rewind entirely.
const input = blessed.textbox({
  parent: screen,
  top: 2,
  left: 2,
  right: 2,
  height: 3,
  border: { type: 'line' },
  padding: { left: 1, right: 1 },
  label: ' new task ',
  mouse: true,
  style: {
    fg: FG,
    border: { fg: DIM },
    label: { fg: DIM },
    focus: { border: { fg: FG }, label: { fg: FG } },
  },
});
input.on('focus', () => input.readInput());

// Scrollable region that holds one box per task (a blank gap row in between).
const listArea = blessed.box({
  parent: screen,
  top: 6,
  left: 2,
  right: 2,
  bottom: 2,
  scrollable: true,
  alwaysScroll: true,
  mouse: true,
  keys: true,
  scrollbar: { ch: '│', style: { fg: FAINT } },
  style: { fg: FG },
});

const footer = blessed.box({
  parent: screen,
  bottom: 0,
  left: 2,
  right: 2,
  height: 1,
  tags: true,
  style: { fg: FAINT },
  content: '{|}↑↓ select · drag/⇧↑↓ move · ⏎/a add · d remove · q quit',
});

// ---------------------------------------------------------------------------
// State + layout
// ---------------------------------------------------------------------------
let state = { queue: [], done: [] };
let selected = 0;
let taskBoxes = []; // direct children of listArea, rebuilt each render
let innerW = 24; // task-box width; refreshed each render for click hit-testing

let hoverIdx = -1; // task under the mouse (hover affordance), -1 = none
let drag = { phase: 'idle' }; // dragReducer state
let draggedId = null; // id of the item being dragged, so a concurrent pop can't redirect the drag
let suppressClick = false; // swallow the click blessed synthesizes after a press we handled
let pendingScroll = true; // scroll the selection into view on the next render only

// Shared, unit-tested geometry for the rows and the ▲ / ▼ / ✕ handles (see
// ui/layout.js), so the rendered glyph position and its clickable target can
// never drift apart — and the same for the drag state machine.
const { ROW_H, STRIDE, TEXT_LEFT, HANDLE_GAP, handleCols, hitRegion, rowToIndex, dragReducer } =
  require(path.join(__dirname, 'layout'));

function clamp(n, lo, hi) {
  return Math.max(lo, Math.min(hi, n));
}

/** Truncate to a display width (not a character count), ellipsis included. */
function truncate(text, width) {
  const t = String(text).replace(/\s+/g, ' ').trim();
  const w = Math.max(1, width);
  if (strW(t) <= w) return t;
  let out = '';
  let used = 0;
  for (let i = 0; i < t.length; i++) {
    const pair = isSurrogate(t, i);
    const cw = charW(t, i);
    if (used + cw > w - 1) break;
    out += pair ? t.slice(i, i + 2) : t[i];
    used += cw;
    if (pair) i++;
  }
  return out + '…';
}

// blessed parses {tags}; strip braces from untrusted strings shown in tag mode.
function notag(s) {
  return String(s).replace(/[{}]/g, '');
}

// ---------------------------------------------------------------------------
// Render
// ---------------------------------------------------------------------------
function render() {
  state = store.read(sessionId);
  const pending = state.queue.length;
  selected = clamp(selected, 0, Math.max(0, pending - 1));
  if (hoverIdx >= pending) hoverIdx = -1;

  header.setContent(
    `{bold}claude-queue{/bold}  ${notag(sessionId)}` +
      `{|}${pending} queued · ${state.done.length} done`
  );

  // Tear down the previous frame's children. The task boxes carry no mouse
  // handlers (all clicks are handled once, on listArea), so nothing leaks into
  // screen.clickable across re-renders.
  taskBoxes.forEach((b) => b.destroy());
  taskBoxes = [];

  innerW = Math.max(24, listArea.width - 2); // minus the scrollbar gutter
  const contentW = innerW - 2; // inside the box border
  const cols = handleCols(contentW);
  let top = 0;

  if (pending === 0) {
    const msg = 'queue is empty — add a task above';
    taskBoxes.push(
      blessed.box({
        parent: listArea,
        // Center the hint; tuck it back up top when a done tail needs the room.
        top: state.done.length ? 1 : Math.max(1, Math.floor((listArea.height - 1) / 2)),
        left: Math.max(1, Math.floor((innerW - strW(msg)) / 2)),
        height: 1,
        content: msg,
        style: { fg: FAINT },
      })
    );
    top = STRIDE;
  }

  state.queue.forEach((item, i) => {
    const isSel = i === selected;
    const isHover = !isSel && i === hoverIdx && drag.phase === 'idle';
    const fg = isSel ? 'black' : FG;
    const dim = isSel ? 'black' : isHover ? FG : DIM; // hover brightens grey → white
    const bg = isSel ? 'white' : undefined;
    taskBoxes.push(
      blessed.box({
        parent: listArea,
        top,
        left: 0,
        width: innerW,
        height: ROW_H,
        border: { type: 'line' },
        tags: false,
        style: { bg, fg, border: { fg: isSel || isHover ? 'white' : DIM } },
      })
    );

    // The number / text / handles are SIBLINGS of the box, placed over its
    // content row, not children of it: blessed 0.1.81 stops rendering
    // grandchildren of a scrollable container once it has scrolled. They are
    // visual-only — clicks on them are resolved by listArea's handler.
    const text = (left, content, style) => {
      taskBoxes.push(
        blessed.text({ parent: listArea, top: top + 1, left: 1 + left, height: 1, content, style })
      );
    };
    text(1, String(i + 1).padStart(2, ' '), { bg, fg: dim, bold: isSel });
    text(TEXT_LEFT, truncate(item.text, cols.up - TEXT_LEFT - HANDLE_GAP), { bg, fg });
    [['▲', cols.up], ['▼', cols.down], ['✕', cols.remove]].forEach(([ch, x]) => {
      text(x, ch, { bg, fg: dim });
    });

    top += STRIDE; // ROW_H of box + a blank gap row
  });

  // A faint "done" tail so you can see what's already been picked up.
  if (state.done.length) {
    const shown = state.done.slice(-4);
    const label =
      shown.length < state.done.length ? `─ done (${state.done.length}) ` : '─ done ';
    const div = blessed.box({
      parent: listArea,
      top,
      left: 1,
      height: 1,
      content: label + '─'.repeat(Math.max(0, innerW - strW(label) - 2)),
      style: { fg: FAINT },
    });
    taskBoxes.push(div);
    top += 1;
    shown.forEach((item) => {
      const d = blessed.box({
        parent: listArea,
        top,
        left: 1,
        height: 1,
        content: '✓ ' + truncate(item.text, innerW - 4),
        style: { fg: FAINT },
      });
      taskBoxes.push(d);
      top += 1;
    });
  }

  // Keep the selected box in view — but only when the selection itself moved
  // (key nav / click / drag start), so wheel scrolling isn't snapped back on
  // every hover or external refresh. scrollTo(offset) makes `offset` the top
  // visible content row, so to reveal a box that fell off the bottom we scroll
  // to (its end - viewport height), not to its end.
  if (pendingScroll) {
    const selTop = selected * STRIDE;
    if (selTop < listArea.childBase) listArea.scrollTo(selTop);
    else if (selTop + ROW_H > listArea.childBase + listArea.height)
      listArea.scrollTo(selTop + ROW_H - listArea.height);
    pendingScroll = false;
  }

  screen.render();
}

// ---------------------------------------------------------------------------
// Actions
// ---------------------------------------------------------------------------
function addTask(text) {
  const t = (text || '').trim();
  if (t) store.append(sessionId, t);
  render();
}

function removeAt(i) {
  store.removeAt(sessionId, i);
  // Stay on the item that slid up into the removed slot (clamped by render),
  // so repeatedly pressing d works down the list; only follow the selection
  // upward when something above it was removed.
  if (selected > i) selected -= 1;
  pendingScroll = true;
  render();
}

function move(i, delta) {
  const to = i + delta;
  if (to < 0 || to >= state.queue.length) return;
  store.reorder(sessionId, i, to);
  selected = to;
  pendingScroll = true;
  render();
}

// ---------------------------------------------------------------------------
// Input wiring
// ---------------------------------------------------------------------------
function focusInput() {
  input.focus();
  screen.render();
}

input.on('submit', (value) => {
  addTask(value);
  input.clearValue();
  input.focus(); // stay in "add" mode for rapid entry
  screen.render();
});
input.on('cancel', () => {
  // Escape hands focus to the list. Skip when focus already moved (the cancel
  // was caused by our own focus steal) so the two can't ping-pong.
  if (screen.focused !== listArea) listArea.focus();
  screen.render();
});

// ---------------------------------------------------------------------------
// Mouse wiring
//
// All mouse interaction is resolved here, on the one clickable element, by
// mapping coordinates back to a task row + handle band (ui/layout.js). This
// avoids overlapping per-box clickables (which in blessed all fire on one
// click and accumulate in screen.clickable across re-renders).
//
// Press / drag / release feed the pure dragReducer. Terminals differ in how
// they report a held-button drag — VTE sends 'mousemove', xterm-family
// (Terminal.app, iTerm2) a stream of 'mousedown's — so both are fed in as
// motion. blessed synthesizes a 'click' on every mouseup; presses we already
// handled set suppressClick so that click is swallowed, while genuine
// click-only terminals (no press/motion reporting) fall through to the legacy
// click path below and behave as before (drag simply never engages).
// ---------------------------------------------------------------------------

/** Resolve an event's screen position to a row of the task list. */
function eventRow(data) {
  return rowToIndex(data.y - listArea.atop + listArea.childBase);
}

/** Where a drag at this event should drop the item (ends pin to the ends). */
function dragTarget(data) {
  if (!state.queue.length) return null;
  return clamp(eventRow(data).idx, 0, state.queue.length - 1);
}

/**
 * Handle a press/click on the list. Runs a handle action ('up'/'down'/
 * 'remove') immediately and returns 'handled'; returns the task index for a
 * press on the body of a task; returns null for gap rows / done tail / empty.
 */
function resolvePress(data) {
  const { idx, within } = eventRow(data);
  if (!state.queue.length || idx < 0 || idx >= state.queue.length || within === 3) return null;
  listArea.focus();
  if (within === 1) {
    const region = hitRegion(data.x - listArea.aleft - 1, innerW - 2);
    if (region === 'up') { move(idx, -1); return 'handled'; }
    if (region === 'down') { move(idx, 1); return 'handled'; }
    if (region === 'remove') { removeAt(idx); return 'handled'; }
  }
  return idx;
}

/** Feed one event through the drag reducer and apply the resulting actions. */
function applyDrag(event) {
  const r = dragReducer(drag, event);
  drag = r.state;
  for (const a of r.actions) {
    if (a.type === 'beginDrag') {
      const item = state.queue[a.idx];
      draggedId = item ? item.id : null;
    } else if (a.type === 'moveTo') {
      if (draggedId === null) continue;
      // Resolve the dragged id to an index under the store lock, so the Stop
      // hook popping the head mid-drag can never make us move the wrong item.
      const queue = store.reorderById(sessionId, draggedId, a.toIdx);
      if (queue === null) {
        // The dragged item was consumed/removed out from under us — abort.
        drag = { phase: 'idle' };
        draggedId = null;
        render();
        return;
      }
      selected = queue.findIndex((it) => it.id === draggedId);
      render();
    } else if (a.type === 'commit') {
      draggedId = null;
      render();
    } else if (a.type === 'select') {
      selected = a.idx;
      pendingScroll = true;
      render();
    }
  }
}

listArea.on('mousedown', (data) => {
  suppressClick = true; // blessed will synthesize a click on the coming mouseup
  if (drag.phase !== 'idle') {
    // Held-button drag motion, reported as another mousedown (xterm-family).
    applyDrag({ type: 'down', idx: dragTarget(data) });
    return;
  }
  const target = resolvePress(data);
  if (typeof target === 'number') applyDrag({ type: 'down', idx: target });
});

listArea.on('mousemove', (data) => {
  if (drag.phase !== 'idle') {
    applyDrag({ type: 'move', idx: dragTarget(data) });
    return;
  }
  // Hover affordance — re-render only when the hovered row changes.
  const { idx, within } = eventRow(data);
  const h = state.queue.length && idx >= 0 && idx < state.queue.length && within !== 3 ? idx : -1;
  if (h !== hoverIdx) {
    hoverIdx = h;
    render();
  }
});

listArea.on('mouseout', () => {
  if (hoverIdx !== -1) {
    hoverIdx = -1;
    render();
  }
});

// The release can land anywhere (even outside the list mid-drag); blessed
// still reports it at screen level, so end drags here.
screen.on('mouse', (data) => {
  if (data.action === 'mouseup' && drag.phase !== 'idle') {
    applyDrag({ type: 'up', idx: null });
  }
});

listArea.on('click', (data) => {
  if (suppressClick) {
    suppressClick = false;
    return;
  }
  // Click-only terminals (no press reporting): behave exactly as before.
  const target = resolvePress(data);
  if (typeof target === 'number') {
    selected = target;
    pendingScroll = true;
    render();
  }
});

// ---------------------------------------------------------------------------
// Keyboard wiring (active when the list has focus)
// ---------------------------------------------------------------------------
listArea.key(['up', 'k'], () => {
  selected = clamp(selected - 1, 0, state.queue.length - 1);
  pendingScroll = true;
  render();
});
listArea.key(['down', 'j'], () => {
  selected = clamp(selected + 1, 0, state.queue.length - 1);
  pendingScroll = true;
  render();
});
listArea.key(['g', 'home'], () => {
  selected = 0;
  pendingScroll = true;
  render();
});
listArea.key(['S-g', 'end'], () => {
  // blessed reports shifted letters as 'S-<letter>', never the uppercase char.
  selected = Math.max(0, state.queue.length - 1);
  pendingScroll = true;
  render();
});
listArea.key(['S-up', 'S-k'], () => move(selected, -1));
listArea.key(['S-down', 'S-j'], () => move(selected, 1));
listArea.key(['d', 'delete', 'backspace'], () => {
  if (state.queue.length) removeAt(selected);
});
listArea.key(['a', 'i', 'enter'], focusInput);
listArea.key('r', render);

screen.key(['q', 'C-c'], () => process.exit(0));
screen.key('escape', () => {
  if (screen.focused === listArea) process.exit(0);
});
screen.key('tab', () => {
  if (screen.focused === input) listArea.focus();
  else focusInput();
  screen.render();
});
screen.on('resize', () => {
  pendingScroll = true;
  render(); // widths, truncation and handle columns all reflow
});

// Live refresh when the hook (or anything) changes the queue file.
let watchTimer = null;
try {
  fs.watch(store.queueDir(), (_evt, fname) => {
    if (fname && fname === path.basename(queueFile)) {
      clearTimeout(watchTimer);
      watchTimer = setTimeout(render, 80);
    }
  });
} catch (_err) {
  // fs.watch unsupported here — poll, but only re-render when the file changed.
  let lastMtime = 0;
  setInterval(() => {
    let mtime = 0;
    try { mtime = fs.statSync(queueFile).mtimeMs; } catch (_e) {}
    if (mtime !== lastMtime) {
      lastMtime = mtime;
      render();
    }
  }, 1000);
}

render();
focusInput();
