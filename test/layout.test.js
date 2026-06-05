'use strict';

const { test } = require('node:test');
const assert = require('node:assert');
const { handleCols, hitRegion } = require('../ui/layout');

test('a click on each handle glyph maps back to that handle', () => {
  for (const w of [30, 60, 84, 120]) {
    const c = handleCols(w);
    assert.strictEqual(hitRegion(c.up, w), 'up', `up @ width ${w}`);
    assert.strictEqual(hitRegion(c.down, w), 'down', `down @ width ${w}`);
    assert.strictEqual(hitRegion(c.remove, w), 'remove', `remove @ width ${w}`);
  }
});

test('clicks to the left of the handles select the task', () => {
  const w = 84;
  const c = handleCols(w);
  assert.strictEqual(hitRegion(0, w), 'select');
  // The 'up' band spans [w-8, w-6]; the first column left of it selects.
  assert.strictEqual(hitRegion(c.up - 2, w), 'select');
  assert.strictEqual(hitRegion(40, w), 'select');
});

test('handle bands are ordered and non-overlapping (up < down < remove)', () => {
  const w = 84;
  const c = handleCols(w);
  assert.ok(c.up < c.down && c.down < c.remove);
  // each glyph column resolves to its own region, not a neighbour
  assert.notStrictEqual(hitRegion(c.up, w), 'down');
  assert.notStrictEqual(hitRegion(c.down, w), 'remove');
});
