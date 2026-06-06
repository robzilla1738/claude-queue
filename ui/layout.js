'use strict';

/**
 * layout.js — pure geometry + drag state for the task list.
 *
 * Kept dependency-free (no blessed) and separate from queue-ui.js so the click
 * hit-testing and the drag state machine can be unit-tested, and so a rendered
 * glyph position and its clickable target are always derived from the same
 * numbers.
 *
 * Vertical layout: each task box is ROW_H rows tall (top border / content /
 * bottom border) followed by GAP blank rows, so successive boxes start STRIDE
 * rows apart. rowToIndex() maps a content-relative row back to a task index.
 *
 * Horizontal layout: a task box is `contentWidth` columns wide inside its
 * border. The ▲ / ▼ / ✕ handles occupy the right side, HANDLE_GAP columns
 * apart, with HANDLE_MARGIN blank columns before the right border so the ✕
 * never sits flush against it. Everything to their left selects.
 */

const ROW_H = 3; // task box height: top border / content / bottom border
const GAP = 1; // blank rows between task boxes
const STRIDE = ROW_H + GAP; // distance between successive box tops

const TEXT_LEFT = 4; // content column where the task text begins
const HANDLE_GAP = 2; // blank columns between handle glyphs
const HANDLE_MARGIN = 2; // blank columns between ✕ and the right border

/** Column (0-based, content-relative) of each handle glyph. */
function handleCols(contentWidth) {
  const remove = contentWidth - 1 - HANDLE_MARGIN;
  const down = remove - (HANDLE_GAP + 1);
  const up = down - (HANDLE_GAP + 1);
  return { up, down, remove };
}

/**
 * Map a content-relative click X to 'up' | 'down' | 'remove' | 'select'.
 * Bands are derived from handleCols() (each glyph ±1 column) so the glyphs and
 * their targets can never drift apart. The margin columns right of ✕ resolve
 * to 'select', never 'remove' — a click brushing the border must not delete.
 */
function hitRegion(contentX, contentWidth) {
  const cols = handleCols(contentWidth);
  if (contentX > cols.remove + 1) return 'select';
  if (contentX >= cols.remove - 1) return 'remove';
  if (contentX >= cols.down - 1) return 'down';
  if (contentX >= cols.up - 1) return 'up';
  return 'select';
}

/**
 * Map a content-relative row to a task index plus the row's role within the
 * box: 0 top border, 1 content (the only handle-eligible row), 2 bottom
 * border, 3 gap row below the box. Callers bounds-check idx themselves.
 */
function rowToIndex(row, stride) {
  const s = stride || STRIDE;
  const idx = Math.floor(row / s);
  return { idx, within: row - idx * s };
}

/**
 * dragReducer — the mouse press/move/release state machine, as a pure reducer
 * so every transition is unit-testable without a terminal.
 *
 *   state:  { phase: 'idle' }
 *         | { phase: 'armed', originIdx }     button down, no row crossed yet
 *         | { phase: 'dragging', curIdx }     a row boundary has been crossed
 *   event:  { type: 'down' | 'move' | 'up', idx }   idx = task index or null
 *
 * Returns { state, actions } where actions ∈
 *   { type: 'beginDrag', idx }    a drag just started from idx
 *   { type: 'moveTo', toIdx }     move the dragged item to toIdx (≤1 per row crossed)
 *   { type: 'commit' }            drag ended on mouseup
 *   { type: 'select', idx }       press+release without crossing a row = a click
 *
 * Terminals differ in how they report a held-button drag: VTE relabels the
 * motion 'mousemove', while xterm-family terminals (Terminal.app, iTerm2)
 * deliver it as a stream of 'mousedown' events, one per cell. The reducer
 * therefore treats EITHER a 'move' or a repeated 'down' at a different row as
 * drag motion. On terminals with no motion reporting at all, the reducer never
 * leaves 'armed' and a press/release is just a click.
 */
function dragReducer(state, event) {
  const actions = [];
  const idx = Number.isInteger(event.idx) ? event.idx : null;

  if (state.phase === 'armed') {
    if (event.type === 'up') {
      actions.push({ type: 'select', idx: state.originIdx });
      return { state: { phase: 'idle' }, actions };
    }
    if (idx !== null && idx !== state.originIdx) {
      // 'move' or a repeated 'down' on a new row — the drag begins.
      actions.push({ type: 'beginDrag', idx: state.originIdx });
      actions.push({ type: 'moveTo', toIdx: idx });
      return { state: { phase: 'dragging', curIdx: idx }, actions };
    }
    return { state, actions };
  }

  if (state.phase === 'dragging') {
    if (event.type === 'up') {
      actions.push({ type: 'commit' });
      return { state: { phase: 'idle' }, actions };
    }
    if (idx !== null && idx !== state.curIdx) {
      actions.push({ type: 'moveTo', toIdx: idx });
      return { state: { phase: 'dragging', curIdx: idx }, actions };
    }
    return { state, actions };
  }

  // idle
  if (event.type === 'down' && idx !== null) {
    return { state: { phase: 'armed', originIdx: idx }, actions };
  }
  return { state: { phase: 'idle' }, actions };
}

module.exports = {
  ROW_H,
  GAP,
  STRIDE,
  TEXT_LEFT,
  HANDLE_GAP,
  HANDLE_MARGIN,
  handleCols,
  hitRegion,
  rowToIndex,
  dragReducer,
};
