#!/usr/bin/env node
'use strict';

/**
 * queue-ui.js — a minimal, black-and-white terminal task list for claude-queue.
 *
 * Usage:  node queue-ui.js <session_id>
 *
 * Each queued task is its own box. Click a box to select it; click the ▲ / ▼
 * handles (or use Shift+↑/↓) to reorder; remove with ⌫ / d / the ✕ handle. New
 * tasks are typed into the box at the top. The list reads and writes the same
 * per-session queue file as the Stop hook, so whatever is here is what the
 * running Claude session works through, one item at a time, and it refreshes
 * live (fs.watch) as items are consumed.
 *
 * Design: monochrome only — white / grey on black, selection shown by inverting
 * the box (black on white). No accent colors.
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

// ---------------------------------------------------------------------------
// Screen + static chrome
// ---------------------------------------------------------------------------
const screen = blessed.screen({
  smartCSR: true,
  title: `claude-queue · ${sessionId}`,
  mouse: true,
  fullUnicode: true,
});

const header = blessed.box({
  parent: screen,
  top: 0,
  left: 2,
  right: 2,
  height: 1,
  tags: true,
  style: { fg: FG },
});

const input = blessed.textbox({
  parent: screen,
  top: 2,
  left: 2,
  right: 2,
  height: 3,
  border: { type: 'line' },
  label: ' new task ',
  inputOnFocus: true,
  mouse: true,
  keys: true,
  style: {
    fg: FG,
    border: { fg: DIM },
    label: { fg: DIM },
    focus: { border: { fg: FG }, label: { fg: FG } },
  },
});

// Scrollable region that holds one box per task.
const listArea = blessed.box({
  parent: screen,
  top: 5,
  left: 2,
  right: 2,
  bottom: 1,
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
  content:
    '{|}↑↓ select   ⇧↑↓ move   ⏎/a add   d remove   q quit',
});

// ---------------------------------------------------------------------------
// State + layout
// ---------------------------------------------------------------------------
let state = { queue: [], done: [] };
let selected = 0;
let taskBoxes = []; // direct children of listArea, rebuilt each render
let innerW = 24; // task-box width; refreshed each render for click hit-testing

const ROW_H = 3; // height of one task box (top border / content / bottom border)
const TEXT_LEFT = 4; // content column where the task text begins

// Shared, unit-tested geometry for the ▲ / ▼ / ✕ handles (see ui/layout.js), so
// the rendered glyph position and its clickable target can never drift apart.
const { handleCols, hitRegion } = require(path.join(__dirname, 'layout'));

function clamp(n, lo, hi) {
  return Math.max(lo, Math.min(hi, n));
}

function truncate(text, width) {
  const t = String(text).replace(/\s+/g, ' ').trim();
  const w = Math.max(1, width);
  if (t.length <= w) return t;
  return t.slice(0, Math.max(0, w - 1)) + '…';
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
    taskBoxes.push(
      blessed.box({
        parent: listArea,
        top: 1,
        left: 1,
        height: 1,
        content: 'queue is empty — add a task above',
        style: { fg: FAINT },
      })
    );
  }

  state.queue.forEach((item, i) => {
    const isSel = i === selected;
    const fg = isSel ? 'black' : FG;
    const dim = isSel ? 'black' : DIM;
    const bg = isSel ? 'white' : undefined;
    const box = blessed.box({
      parent: listArea,
      top,
      left: 0,
      width: innerW,
      height: ROW_H,
      border: { type: 'line' },
      tags: false,
      style: { bg, fg, border: { fg: isSel ? 'white' : DIM } },
    });

    blessed.text({
      parent: box,
      top: 0,
      left: 1,
      content: String(i + 1).padStart(2, ' '),
      style: { bg, fg: dim, bold: isSel },
    });
    blessed.text({
      parent: box,
      top: 0,
      left: TEXT_LEFT,
      content: truncate(item.text, cols.up - TEXT_LEFT - 1),
      style: { bg, fg },
    });
    // Visual-only handles; clicks on them are resolved by listArea's handler.
    [['▲', cols.up], ['▼', cols.down], ['✕', cols.remove]].forEach(([ch, x]) => {
      blessed.text({ parent: box, top: 0, left: x, content: ch, style: { bg, fg: dim } });
    });

    taskBoxes.push(box);
    top += ROW_H;
  });

  // A faint "done" tail so you can see what's already been picked up.
  if (state.done.length) {
    const div = blessed.box({
      parent: listArea,
      top: top + 0,
      left: 1,
      height: 1,
      content: '─ done ' + '─'.repeat(Math.max(0, innerW - 9)),
      style: { fg: FAINT },
    });
    taskBoxes.push(div);
    top += 1;
    state.done.slice(-4).forEach((item) => {
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

  // Keep the selected box in view. scrollTo(offset) makes `offset` the top
  // visible content row, so to reveal a box that fell off the bottom we scroll
  // to (its end - viewport height), not to its end.
  const selTop = selected * ROW_H;
  if (selTop < listArea.childBase) listArea.scrollTo(selTop);
  else if (selTop + ROW_H > listArea.childBase + listArea.height)
    listArea.scrollTo(selTop + ROW_H - listArea.height);

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
  if (selected >= i) selected = Math.max(0, selected - 1);
  render();
}

function move(i, delta) {
  const to = i + delta;
  if (to < 0 || to >= state.queue.length) return;
  store.reorder(sessionId, i, to);
  selected = to;
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
  listArea.focus();
  screen.render();
});

// All mouse interaction is resolved here, on the one clickable element, by
// mapping the click coordinate back to a task row + handle band. This avoids
// overlapping per-box clickables (which in blessed all fire on one click and
// accumulate in screen.clickable across re-renders).
listArea.on('click', (data) => {
  if (!state.queue.length) return;
  const row = data.y - listArea.atop + listArea.childBase;
  const idx = Math.floor(row / ROW_H);
  if (idx < 0 || idx >= state.queue.length) return; // a done/empty row
  listArea.focus();
  const withinBox = row - idx * ROW_H; // 0 top border, 1 content, 2 bottom border
  const contentX = data.x - listArea.aleft - 1; // -1 for the box's left border
  if (withinBox === 1) {
    const region = hitRegion(contentX, innerW - 2);
    if (region === 'up') return move(idx, -1);
    if (region === 'down') return move(idx, 1);
    if (region === 'remove') return removeAt(idx);
  }
  selected = idx;
  render();
});

// Navigation / shortcuts (active when the list has focus).
listArea.key(['up', 'k'], () => {
  selected = clamp(selected - 1, 0, state.queue.length - 1);
  render();
});
listArea.key(['down', 'j'], () => {
  selected = clamp(selected + 1, 0, state.queue.length - 1);
  render();
});
listArea.key(['S-up', 'K'], () => move(selected, -1));
listArea.key(['S-down', 'J'], () => move(selected, 1));
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
