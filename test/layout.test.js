'use strict';

const { test } = require('node:test');
const assert = require('node:assert');
const {
  ROW_H,
  GAP,
  STRIDE,
  HANDLE_MARGIN,
  handleCols,
  hitRegion,
  rowToIndex,
  dragReducer,
} = require('../ui/layout');

// ---------------------------------------------------------------------------
// Handle geometry
// ---------------------------------------------------------------------------

test('a click on each handle glyph maps back to that handle', () => {
  for (const w of [30, 60, 84, 120]) {
    const c = handleCols(w);
    assert.strictEqual(hitRegion(c.up, w), 'up', `up @ width ${w}`);
    assert.strictEqual(hitRegion(c.down, w), 'down', `down @ width ${w}`);
    assert.strictEqual(hitRegion(c.remove, w), 'remove', `remove @ width ${w}`);
  }
});

test('a click within one column of a glyph still hits it', () => {
  for (const w of [30, 60, 84, 120]) {
    const c = handleCols(w);
    for (const [name, col] of [['up', c.up], ['down', c.down], ['remove', c.remove]]) {
      assert.strictEqual(hitRegion(col - 1, w), name, `${name}-1 @ width ${w}`);
      assert.strictEqual(hitRegion(col + 1, w), name, `${name}+1 @ width ${w}`);
    }
  }
});

test('clicks to the left of the handles select the task', () => {
  const w = 84;
  const c = handleCols(w);
  assert.strictEqual(hitRegion(0, w), 'select');
  // The first column left of the 'up' band selects.
  assert.strictEqual(hitRegion(c.up - 2, w), 'select');
  assert.strictEqual(hitRegion(40, w), 'select');
});

test('the right margin between ✕ and the border never deletes', () => {
  for (const w of [30, 60, 84, 120]) {
    const c = handleCols(w);
    // Columns right of the remove band (the HANDLE_MARGIN gutter) are inert.
    for (let x = c.remove + 2; x < w; x++) {
      assert.strictEqual(hitRegion(x, w), 'select', `col ${x} @ width ${w}`);
    }
    assert.ok(c.remove < w - 1 - HANDLE_MARGIN + 1, 'remove glyph keeps its margin');
  }
});

test('handle bands are ordered and non-overlapping (up < down < remove)', () => {
  const w = 84;
  const c = handleCols(w);
  assert.ok(c.up < c.down && c.down < c.remove);
  // each glyph column resolves to its own region, not a neighbour
  assert.notStrictEqual(hitRegion(c.up, w), 'down');
  assert.notStrictEqual(hitRegion(c.down, w), 'remove');
});

// ---------------------------------------------------------------------------
// Row geometry (boxes + gap rows)
// ---------------------------------------------------------------------------

test('rowToIndex maps every row of a box, and the gap row, to that box', () => {
  assert.strictEqual(STRIDE, ROW_H + GAP);
  for (const idx of [0, 1, 2, 7]) {
    const base = idx * STRIDE;
    assert.deepStrictEqual(rowToIndex(base), { idx, within: 0 }, 'top border');
    assert.deepStrictEqual(rowToIndex(base + 1), { idx, within: 1 }, 'content');
    assert.deepStrictEqual(rowToIndex(base + 2), { idx, within: 2 }, 'bottom border');
    assert.deepStrictEqual(rowToIndex(base + 3), { idx, within: 3 }, 'gap row');
  }
});

test('rowToIndex honors an explicit stride', () => {
  assert.deepStrictEqual(rowToIndex(5, 5), { idx: 1, within: 0 });
  assert.deepStrictEqual(rowToIndex(9, 5), { idx: 1, within: 4 });
});

// ---------------------------------------------------------------------------
// Drag state machine
// ---------------------------------------------------------------------------

/** Run a sequence of events through the reducer, collecting all actions. */
function run(events) {
  let state = { phase: 'idle' };
  const actions = [];
  for (const event of events) {
    const r = dragReducer(state, event);
    state = r.state;
    actions.push(...r.actions);
  }
  return { state, actions };
}

test('press + release on the same row is a click (select, no drag)', () => {
  const { state, actions } = run([
    { type: 'down', idx: 1 },
    { type: 'up', idx: 1 },
  ]);
  assert.deepStrictEqual(actions, [{ type: 'select', idx: 1 }]);
  assert.strictEqual(state.phase, 'idle');
});

test('press, cross rows, release commits a drag', () => {
  const { state, actions } = run([
    { type: 'down', idx: 0 },
    { type: 'move', idx: 1 },
    { type: 'move', idx: 2 },
    { type: 'up', idx: 2 },
  ]);
  assert.deepStrictEqual(actions, [
    { type: 'beginDrag', idx: 0 },
    { type: 'moveTo', toIdx: 1 },
    { type: 'moveTo', toIdx: 2 },
    { type: 'commit' },
  ]);
  assert.strictEqual(state.phase, 'idle');
});

test('a repeated mousedown at a new row counts as drag motion (xterm/macOS path)', () => {
  // Terminal.app / iTerm2 report a held-button drag as a stream of 'down'
  // events, one per cell, never 'move'. The reducer must treat them the same.
  const { state, actions } = run([
    { type: 'down', idx: 2 },
    { type: 'down', idx: 1 },
    { type: 'down', idx: 0 },
    { type: 'up', idx: 0 },
  ]);
  assert.deepStrictEqual(actions, [
    { type: 'beginDrag', idx: 2 },
    { type: 'moveTo', toIdx: 1 },
    { type: 'moveTo', toIdx: 0 },
    { type: 'commit' },
  ]);
  assert.strictEqual(state.phase, 'idle');
});

test('motion within the starting row never begins a drag', () => {
  const { state, actions } = run([
    { type: 'down', idx: 1 },
    { type: 'move', idx: 1 },
    { type: 'down', idx: 1 },
    { type: 'up', idx: 1 },
  ]);
  assert.deepStrictEqual(actions, [{ type: 'select', idx: 1 }]);
  assert.strictEqual(state.phase, 'idle');
});

test('only one moveTo per row crossed, none for repeated motion on a row', () => {
  const { actions } = run([
    { type: 'down', idx: 0 },
    { type: 'move', idx: 1 },
    { type: 'move', idx: 1 },
    { type: 'move', idx: 1 },
    { type: 'up', idx: 1 },
  ]);
  const moves = actions.filter((a) => a.type === 'moveTo');
  assert.deepStrictEqual(moves, [{ type: 'moveTo', toIdx: 1 }]);
});

test('motion off the list (idx null) is ignored mid-drag', () => {
  const { state, actions } = run([
    { type: 'down', idx: 0 },
    { type: 'move', idx: 1 },
    { type: 'move', idx: null },
    { type: 'up', idx: null },
  ]);
  assert.deepStrictEqual(actions, [
    { type: 'beginDrag', idx: 0 },
    { type: 'moveTo', toIdx: 1 },
    { type: 'commit' },
  ]);
  assert.strictEqual(state.phase, 'idle');
});

test('a press off the list arms nothing', () => {
  const { state, actions } = run([
    { type: 'down', idx: null },
    { type: 'move', idx: 2 },
    { type: 'up', idx: 2 },
  ]);
  assert.deepStrictEqual(actions, []);
  assert.strictEqual(state.phase, 'idle');
});
