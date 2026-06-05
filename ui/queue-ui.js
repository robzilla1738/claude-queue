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
// State
// ---------------------------------------------------------------------------
let state = { queue: [], done: [] };
let selected = 0;
let taskBoxes = []; // live blessed children, rebuilt each render

function clamp(n, lo, hi) {
  return Math.max(lo, Math.min(hi, n));
}

function truncate(text, width) {
  const t = String(text).replace(/\s+/g, ' ').trim();
  if (t.length <= width) return t;
  return t.slice(0, Math.max(0, width - 1)) + '…';
}

// ---------------------------------------------------------------------------
// Render
// ---------------------------------------------------------------------------
function render() {
  state = store.read(sessionId);
  const pending = state.queue.length;
  selected = clamp(selected, 0, Math.max(0, pending - 1));

  header.setContent(
    `{bold}claude-queue{/bold}  ${sessionId}` +
      `{|}${pending} queued · ${state.done.length} done`
  );

  // Tear down old task boxes.
  taskBoxes.forEach((b) => b.destroy());
  taskBoxes = [];

  const innerW = listArea.width - 2; // minus scrollbar gutter
  let top = 0;

  if (pending === 0) {
    const empty = blessed.box({
      parent: listArea,
      top: 1,
      left: 1,
      height: 1,
      content: 'queue is empty — add a task above',
      style: { fg: FAINT },
    });
    taskBoxes.push(empty);
  }

  state.queue.forEach((item, i) => {
    const isSel = i === selected;
    const box = blessed.box({
      parent: listArea,
      top,
      left: 0,
      width: innerW,
      height: 3,
      border: { type: 'line' },
      mouse: true,
      tags: false,
      style: isSel
        ? { bg: 'white', fg: 'black', border: { fg: 'white' } }
        : { fg: FG, border: { fg: DIM } },
    });

    const num = blessed.text({
      parent: box,
      top: 0,
      left: 1,
      content: String(i + 1).padStart(2, ' '),
      style: isSel ? { bg: 'white', fg: 'black', bold: true } : { fg: DIM },
    });

    blessed.text({
      parent: box,
      top: 0,
      left: 5,
      content: truncate(item.text, innerW - 5 - 8),
      style: isSel ? { bg: 'white', fg: 'black' } : { fg: FG },
    });

    // Reorder / remove handles on the right.
    const handles = [
      { ch: '▲', dx: 7, fn: () => move(i, -1) },
      { ch: '▼', dx: 5, fn: () => move(i, 1) },
      { ch: '✕', dx: 2, fn: () => removeAt(i) },
    ];
    handles.forEach((h) => {
      const btn = blessed.box({
        parent: box,
        top: 0,
        right: h.dx,
        width: 1,
        height: 1,
        content: h.ch,
        mouse: true,
        clickable: true,
        style: isSel
          ? { bg: 'white', fg: 'black', hover: { fg: 'white', bg: 'black' } }
          : { fg: DIM, hover: { fg: FG } },
      });
      btn.on('click', (data) => {
        h.fn();
        return data; // swallow so the parent box click doesn't double-fire
      });
    });

    box.on('click', () => {
      selected = i;
      render();
    });

    taskBoxes.push(box, num);
    top += 3;
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

  // Keep the selected box in view.
  const selTop = selected * 3;
  if (selTop < listArea.childBase) listArea.scrollTo(selTop);
  else if (selTop + 3 > listArea.childBase + listArea.height)
    listArea.scrollTo(selTop + 3);

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
  setInterval(render, 1000);
}

render();
focusInput();
