#!/usr/bin/env node
'use strict';

/**
 * ansi-to-svg.js — render `tmux capture-pane -e -p` output (plain text with
 * SGR color sequences) as a crisp SVG terminal screenshot. Dependency-free.
 *
 * Usage:  tmux capture-pane -e -p | node ansi-to-svg.js > screenshot.svg
 *
 * Tuned for claude-queue's monochrome UI (white / grey / inverted selection)
 * but handles the common SGR subset generically. Text is laid out on a strict
 * cell grid with per-run `textLength`, so the box-drawing always lines up no
 * matter which monospace font the viewer resolves.
 */

const FS = 13; // font size
const CW = 7.8; // cell width
const LH = 17; // line height
const PAD = 18; // content padding
const BAR = 36; // window title bar height

const COLORS = {
  page: '#101010', // panel background
  bar: '#1a1a1a',
  dot: '#2e2e2e',
  title: '#6e6e6e',
  fgDefault: '#e6e6e6',
  fgWhite: '#ffffff',
  fgGrey: '#6e6e6e',
  fgBlack: '#101010',
  bgWhite: '#e6e6e6',
};

function freshStyle() {
  return { fg: 'default', bg: 'none', bold: false, reverse: false };
}

/** Apply one SGR parameter list (e.g. "1;37") to a style. */
function applySgr(params, st) {
  const ps = params.length ? params.split(';').map(Number) : [0];
  for (let i = 0; i < ps.length; i++) {
    const p = ps[i];
    if (p === 0) Object.assign(st, freshStyle());
    else if (p === 1) st.bold = true;
    else if (p === 22) st.bold = false;
    else if (p === 7) st.reverse = true;
    else if (p === 27) st.reverse = false;
    else if (p === 30) st.fg = 'black';
    else if (p >= 31 && p <= 36) st.fg = 'default'; // non-mono hues → default
    else if (p === 37) st.fg = 'white';
    else if (p === 39) st.fg = 'default';
    else if (p === 90) st.fg = 'grey';
    else if (p >= 91 && p <= 96) st.fg = 'default';
    else if (p === 97) st.fg = 'white';
    else if (p === 40) st.bg = 'none';
    else if (p >= 41 && p <= 46) st.bg = 'none';
    else if (p === 47 || p === 107) st.bg = 'white';
    else if (p === 49) st.bg = 'none';
    else if (p === 38 || p === 48) {
      // 38;5;N / 48;5;N (256-color) and 38;2;r;g;b (truecolor)
      const isFg = p === 38;
      const mode = ps[i + 1];
      let n = -1;
      if (mode === 5) {
        n = ps[i + 2];
        i += 2;
      } else if (mode === 2) {
        n = -1;
        i += 4;
      }
      const mapped = n === 8 ? 'grey' : n === 0 ? 'black' : n === 7 || n === 15 ? 'white' : 'default';
      if (isFg) st.fg = mapped;
      else st.bg = n === 7 || n === 15 ? 'white' : 'none';
    }
  }
}

/** Parse one captured line into styled runs: [{ text, col, fg, bg, bold }]. */
function parseLine(line) {
  const runs = [];
  const st = freshStyle();
  let col = 0;
  let i = 0;
  let cur = null;

  const effective = () => ({
    fg: st.reverse ? (st.bg === 'white' ? 'white' : 'black') : st.fg,
    bg: st.reverse ? (st.fg === 'grey' ? 'white' : 'white') : st.bg,
    bold: st.bold,
  });

  while (i < line.length) {
    if (line[i] === '\u001b') {
      const m = /^\u001b\[([0-9;]*)m/.exec(line.slice(i));
      if (m) {
        applySgr(m[1], st);
        cur = null; // style changed — start a new run
        i += m[0].length;
        continue;
      }
      // Some other escape — skip the introducer and move on.
      i += 1;
      continue;
    }
    const ch = line[i];
    const eff = effective();
    if (!cur || cur.fg !== eff.fg || cur.bg !== eff.bg || cur.bold !== eff.bold) {
      cur = { text: '', col, fg: eff.fg, bg: eff.bg, bold: eff.bold };
      runs.push(cur);
    }
    cur.text += ch;
    col += 1;
    i += 1;
  }
  return runs;
}

function esc(s) {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

function fgColor(name) {
  if (name === 'white') return COLORS.fgWhite;
  if (name === 'grey') return COLORS.fgGrey;
  if (name === 'black') return COLORS.fgBlack;
  return COLORS.fgDefault;
}

function main() {
  let data = '';
  process.stdin.setEncoding('utf8');
  process.stdin.on('data', (c) => (data += c));
  process.stdin.on('end', () => {
    const rawLines = data.replace(/\r/g, '').split('\n');
    while (rawLines.length && rawLines[rawLines.length - 1] === '') rawLines.pop();
    const lines = rawLines.map(parseLine);

    const cols = Math.max(...lines.map((rs) => rs.reduce((w, r) => Math.max(w, r.col + r.text.length), 0)), 40);
    const rows = lines.length;
    const width = Math.round(PAD * 2 + cols * CW);
    const height = Math.round(BAR + PAD * 2 + rows * LH);

    const out = [];
    out.push(`<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}" font-family="ui-monospace, SFMono-Regular, Menlo, Consolas, 'Liberation Mono', monospace" font-size="${FS}">`);
    out.push(`  <rect width="${width}" height="${height}" rx="12" fill="${COLORS.page}"/>`);
    out.push(`  <path d="M0 12a12 12 0 0 1 12-12h${width - 24}a12 12 0 0 1 12 12v${BAR - 12}H0z" fill="${COLORS.bar}"/>`);
    for (let d = 0; d < 3; d++) {
      out.push(`  <circle cx="${20 + d * 20}" cy="${BAR / 2}" r="5.5" fill="${COLORS.dot}"/>`);
    }

    // Box-drawing glyphs become real vector lines: stretched text glyphs leave
    // hairline gaps, while paths render the borders as continuously as a
    // terminal does. Everything else stays text.
    function boxPath(ch, x, y) {
      const xm = x + CW / 2;
      const ym = y + LH / 2;
      const r = (n) => n.toFixed(1);
      switch (ch) {
        case '─': return `M${r(x)} ${r(ym)}H${r(x + CW)}`;
        case '│': return `M${r(xm)} ${r(y)}V${r(y + LH)}`;
        case '┌': return `M${r(x + CW)} ${r(ym)}H${r(xm)}V${r(y + LH)}`;
        case '┐': return `M${r(x)} ${r(ym)}H${r(xm)}V${r(y + LH)}`;
        case '└': return `M${r(x + CW)} ${r(ym)}H${r(xm)}V${r(y)}`;
        case '┘': return `M${r(x)} ${r(ym)}H${r(xm)}V${r(y)}`;
        default: return '';
      }
    }

    lines.forEach((runs, row) => {
      const y = BAR + PAD + row * LH;
      const baseline = (y + LH * 0.72).toFixed(1);
      for (const run of runs) {
        const x = (PAD + run.col * CW).toFixed(1);
        const w = (run.text.length * CW).toFixed(1);
        if (run.bg === 'white') {
          out.push(`  <rect x="${x}" y="${y}" width="${w}" height="${LH}" fill="${COLORS.bgWhite}"/>`);
        }
        // Emit per non-space chunk so blank stretches never drift; split each
        // chunk into box-drawing segments (→ one path) and plain text.
        const re = /\S+/g;
        let m;
        while ((m = re.exec(run.text))) {
          const color = fgColor(run.fg);
          const weight = run.bold ? ' font-weight="600"' : '';
          let seg;
          const segRe = /([─│┌┐└┘]+)|([^─│┌┐└┘]+)/g;
          while ((seg = segRe.exec(m[0]))) {
            const segCol = run.col + m.index + seg.index;
            const sx = PAD + segCol * CW;
            if (seg[1]) {
              const d = Array.from(seg[1], (ch, k) => boxPath(ch, sx + k * CW, y)).join('');
              out.push(`  <path d="${d}" stroke="${color}" stroke-width="1" fill="none"/>`);
            } else {
              const cw = (seg[2].length * CW).toFixed(1);
              out.push(
                `  <text x="${sx.toFixed(1)}" y="${baseline}" fill="${color}"${weight} textLength="${cw}" lengthAdjust="spacingAndGlyphs">${esc(seg[2])}</text>`
              );
            }
          }
        }
      }
    });

    out.push('</svg>');
    process.stdout.write(out.join('\n') + '\n');
  });
}

main();
