#!/usr/bin/env node
'use strict';

/**
 * queue-ui.js — the clickable terminal task list that runs in the second window.
 *
 * Usage:  node queue-ui.js <session_id>
 *
 * It reads and writes the same per-session queue file as the Stop hook (via
 * scripts/lib/queue-store.js), so anything you add here is what the running
 * Claude session picks up when it finishes its current task. The list refreshes
 * live (fs.watch) whenever the hook consumes an item, moving it into "Done".
 *
 * Controls:
 *   - Type in the input box + Enter ........ add a task to the queue
 *   - Click a task (or j/k, ↑/↓) .......... select it
 *   - d / Delete / click [Remove] ......... remove the selected task
 *   - J / K (shift) ....................... move the selected task down / up
 *   - r ................................... force refresh
 *   - q / Esc / Ctrl-C .................... quit (the queue keeps working)
 */

const path = require('path');
const fs = require('fs');

let blessed;
try {
  blessed = require('blessed');
} catch (_err) {
  console.error(
    'The queue UI needs the "blessed" package.\n' +
      'Install it once with:  (cd "' +
      path.join(__dirname) +
      '" && npm install)\n'
  );
  process.exit(1);
}

const store = require(path.join(__dirname, '..', 'scripts', 'lib', 'queue-store'));

const sessionId = process.argv[2] || process.env.CLAUDE_SESSION_ID || 'default';
const queueFile = store.queuePath(sessionId);

// ---------------------------------------------------------------------------
// Screen + layout
// ---------------------------------------------------------------------------
const screen = blessed.screen({
  smartCSR: true,
  title: `claude-queue · ${sessionId}`,
  mouse: true,
});

const header = blessed.box({
  parent: screen,
  top: 0,
  left: 0,
  width: '100%',
  height: 3,
  tags: true,
  border: 'line',
  style: { border: { fg: 'cyan' } },
  content: '',
});

const input = blessed.textbox({
  parent: screen,
  top: 3,
  left: 0,
  width: '100%',
  height: 3,
  border: 'line',
  label: ' Add a task (Enter to queue) ',
  inputOnFocus: true,
  mouse: true,
  keys: true,
  style: { border: { fg: 'green' }, focus: { border: { fg: 'yellow' } } },
});

const list = blessed.list({
  parent: screen,
  top: 6,
  left: 0,
  width: '100%',
  bottom: 4,
  border: 'line',
  label: ' Queue ',
  mouse: true,
  keys: true,
  vi: true,
  tags: true,
  scrollbar: { ch: ' ', style: { bg: 'cyan' } },
  style: {
    border: { fg: 'cyan' },
    selected: { bg: 'blue', fg: 'white' },
    item: { hover: { bg: 'grey' } },
  },
});

const removeBtn = blessed.button({
  parent: screen,
  bottom: 1,
  left: 1,
  width: 12,
  height: 3,
  content: ' Remove ',
  align: 'center',
  valign: 'middle',
  mouse: true,
  border: 'line',
  style: { border: { fg: 'red' }, focus: { bg: 'red' }, hover: { bg: 'red' } },
});

const footer = blessed.box({
  parent: screen,
  bottom: 0,
  left: 14,
  width: '100%-14',
  height: 1,
  tags: true,
  content:
    '{grey-fg}Enter add · d remove · J/K move · r refresh · q quit{/grey-fg}',
});

// ---------------------------------------------------------------------------
// Rendering
// ---------------------------------------------------------------------------
let state = { queue: [], done: [] };

function render() {
  state = store.read(sessionId);

  const pending = state.queue.length;
  const done = state.done.length;
  header.setContent(
    `{bold}claude-queue{/bold}   session {cyan-fg}${sessionId}{/cyan-fg}   ` +
      `{green-fg}${pending} queued{/green-fg} · {grey-fg}${done} done{/grey-fg}`
  );

  const rows = [];
  state.queue.forEach((it, i) => {
    rows.push(`{green-fg}${String(i + 1).padStart(2)}{/green-fg}  ${escape(it.text)}`);
  });
  if (state.done.length) {
    rows.push('{grey-fg}── done ──{/grey-fg}');
    state.done.slice(-5).forEach((it) => {
      rows.push(`{grey-fg} ✓  ${escape(it.text)}{/grey-fg}`);
    });
  }
  if (rows.length === 0) {
    rows.push('{grey-fg}(empty — type a task above and press Enter){/grey-fg}');
  }

  const prevSelected = list.selected;
  list.setItems(rows);
  // Keep selection within the pending range.
  if (pending > 0) {
    list.select(Math.min(prevSelected, pending - 1));
  }
  screen.render();
}

function escape(text) {
  // Show multi-line tasks on one row; blessed tag-escape braces.
  return String(text).replace(/\n/g, ' ⏎ ').replace(/\{/g, '{open}').replace(/\}/g, '{close}');
}

// The currently selected *pending* index (done rows are not selectable targets).
function selectedPendingIndex() {
  const idx = list.selected;
  if (idx < 0 || idx >= state.queue.length) return -1;
  return idx;
}

// ---------------------------------------------------------------------------
// Actions
// ---------------------------------------------------------------------------
function addTask(text) {
  const t = (text || '').trim();
  if (t) store.append(sessionId, t);
  render();
}

function removeSelected() {
  const idx = selectedPendingIndex();
  if (idx >= 0) {
    store.removeAt(sessionId, idx);
    render();
  }
}

function move(delta) {
  const idx = selectedPendingIndex();
  if (idx < 0) return;
  const to = idx + delta;
  if (to < 0 || to >= state.queue.length) return;
  store.reorder(sessionId, idx, to);
  render();
  list.select(to);
  screen.render();
}

// ---------------------------------------------------------------------------
// Wiring
// ---------------------------------------------------------------------------
input.on('submit', (value) => {
  addTask(value);
  input.clearValue();
  input.focus();
  screen.render();
});
input.on('cancel', () => {
  list.focus();
  screen.render();
});

removeBtn.on('press', removeSelected);

list.key(['d', 'delete'], removeSelected);
list.key(['J', 'S-down'], () => move(1));
list.key(['K', 'S-up'], () => move(-1));
list.key('r', render);
list.key(['i', 'a'], () => {
  input.focus();
  screen.render();
});

screen.key(['q', 'C-c'], () => process.exit(0));
screen.key('escape', () => {
  // Esc from the list quits; from the input it just defocuses (handled above).
  if (screen.focused === list) process.exit(0);
});
screen.key('tab', () => {
  if (screen.focused === input) list.focus();
  else input.focus();
  screen.render();
});

// Live-refresh when the hook (or another process) changes the file.
let watchTimer = null;
try {
  fs.watch(store.queueDir(), (_evt, fname) => {
    if (fname && fname === path.basename(queueFile)) {
      clearTimeout(watchTimer);
      watchTimer = setTimeout(render, 80); // debounce rapid temp/rename events
    }
  });
} catch (_err) {
  // If watching is unavailable, fall back to a gentle poll.
  setInterval(render, 1000);
}

// First paint, focus the input so the user can type immediately.
render();
input.focus();
screen.render();
