'use strict';

/**
 * layout.js — pure geometry for the task-box handles.
 *
 * Kept dependency-free (no blessed) and separate from queue-ui.js so the click
 * hit-testing can be unit-tested, and so the rendered glyph position and its
 * clickable target are always derived from the same numbers.
 *
 * A task box is `contentWidth` columns wide inside its border. The ▲ / ▼ / ✕
 * handles occupy the rightmost columns; everything to their left selects.
 */

/** Column (0-based, content-relative) of each handle glyph. */
function handleCols(contentWidth) {
  return { up: contentWidth - 7, down: contentWidth - 4, remove: contentWidth - 1 };
}

/** Map a content-relative click X to 'up' | 'down' | 'remove' | 'select'. */
function hitRegion(contentX, contentWidth) {
  if (contentX >= contentWidth - 2) return 'remove';
  if (contentX >= contentWidth - 5) return 'down';
  if (contentX >= contentWidth - 8) return 'up';
  return 'select';
}

module.exports = { handleCols, hitRegion };
