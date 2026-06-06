#!/usr/bin/env bash
#
# tmux-smoke.sh — end-to-end smoke test for the queue UI in a real PTY.
#
# Drives ui/queue-ui.js inside an isolated tmux server: types tasks, sends raw
# SGR mouse bytes (press / drag / hover / release) and asserts on the captured
# pane — including the xterm-family drag encoding (a held button reported as a
# stream of 'mousedown's, Cb=32) that the unit tests can't reach. Everything
# runs against a throwaway CLAUDE_QUEUE_DIR and a private tmux socket, so a
# user's real queues and tmux server are never touched.
#
# Usage:  bash test/tmux-smoke.sh
#
# Requires tmux. The UI's blessed dependency is installed on first run.

set -u

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
SOCK="cq-smoke-$$"
SESSION="cq"
PANE_W=70
PANE_H=24
BODYX=11 # any column over a task's text — left of the handles

command -v tmux >/dev/null 2>&1 || {
  echo "tmux-smoke: tmux is required (brew install tmux / apt install tmux)" >&2
  exit 1
}

if [ ! -d "${ROOT}/ui/node_modules/blessed" ]; then
  (cd "${ROOT}/ui" && npm install --silent --no-audit --no-fund) || {
    echo "tmux-smoke: failed to install the UI dependency (blessed)" >&2
    exit 1
  }
fi

TMPQ="$(mktemp -d)"
ERRLOG="${TMPQ}/ui-stderr.txt"
PASS=0
FAIL=0

TM() { tmux -L "${SOCK}" "$@"; }

cleanup() {
  TM kill-server 2>/dev/null
  rm -rf "${TMPQ}"
}
trap cleanup EXIT

# Derive click coordinates from the same geometry module the UI renders with,
# so the harness can never drift from the layout. (1-based SGR coordinates.)
GEO="$(node -e '
const L = require(process.argv[1]);
const W = Number(process.argv[2]);
const innerW = Math.max(24, (W - 4) - 2);   // listArea is left:2 right:2, minus scrollbar gutter
const c = L.handleCols(innerW - 2);         // content width inside the box border
const sx = (col) => 2 + 1 + col + 1;        // listArea left + box border + content col → 1-based
const sy = (i) => 6 + i * L.STRIDE + 1 + 1; // listArea top + box top + content row → 1-based
console.log([sx(c.up), sx(c.down), sx(c.remove), sy(0), sy(1), sy(2)].join(" "));
' "${ROOT}/ui/layout.js" "${PANE_W}")"
read -r UPX DOWNX REMX Y0 Y1 Y2 <<EOF
${GEO}
EOF

# --- tiny driver toolbox ----------------------------------------------------

cap() { TM capture-pane -p -t "${SESSION}"; }
cap_esc() { TM capture-pane -e -p -t "${SESSION}"; }

keys() { TM send-keys -t "${SESSION}" "$@"; }

# mouse <Cb> <x> <y> <M|m> — inject one raw SGR mouse report.
# Cb=0 press/release, Cb=32 motion with the left button held, Cb=35 hover.
mouse() {
  TM send-keys -t "${SESSION}" -H $(printf '\x1b[<%s;%s;%s%s' "$1" "$2" "$3" "$4" | od -An -tx1 | tr -d '\n')
  sleep 0.1
}

# dblclick <x> <y> — two press/release pairs, fast. Each event must be its own
# stdin chunk (blessed's ^-anchored SGR regex parses ONE mouse report per
# chunk), but the pairs must still land within the UI's 400ms double-click
# window — so: separate sends, tiny gaps, no 0.1s sleeps like mouse().
dblclick() {
  local press release
  press=$(printf '\x1b[<0;%s;%sM' "$1" "$2" | od -An -tx1 | tr -d '\n')
  release=$(printf '\x1b[<0;%s;%sm' "$1" "$2" | od -An -tx1 | tr -d '\n')
  local ev
  for ev in "${press}" "${release}" "${press}" "${release}"; do
    TM send-keys -t "${SESSION}" -H ${ev}
    sleep 0.03
  done
  sleep 0.2
}

# wait_for <fixed-string> — poll the pane until it shows up (5s budget).
wait_for() {
  local i
  for ((i = 0; i < 50; i++)); do
    if cap | grep -qF "$1"; then return 0; fi
    sleep 0.1
  done
  return 1
}

ok() { PASS=$((PASS + 1)); echo "ok   - $1"; }
not_ok() {
  FAIL=$((FAIL + 1))
  echo "FAIL - $1" >&2
}

# assert_shows <description> <fixed-string>
assert_shows() {
  if wait_for "$2"; then ok "$1"; else
    not_ok "$1 (never saw: $2)"
    echo "--- pane ---" >&2
    cap >&2
  fi
}

# assert_absent <description> <fixed-string>
assert_absent() {
  sleep 0.3
  if cap | grep -qF "$2"; then
    not_ok "$1 (unexpectedly saw: $2)"
  else
    ok "$1"
  fi
}

# queue_texts — the persisted pending order, pipe-separated.
queue_texts() {
  node -e '
const fs = require("fs");
const s = JSON.parse(fs.readFileSync(process.argv[1], "utf8"));
console.log(s.queue.map((i) => i.text).join("|"));
' "${TMPQ}/queue-smoke.json"
}

# start_ui [task ...] — relaunch the UI against a queue freshly seeded with
# the given tasks. Each scenario gets a clean slate.
start_ui() {
  TM kill-session -t "${SESSION}" 2>/dev/null
  rm -f "${TMPQ}/queue-smoke.json"
  if [ "$#" -gt 0 ]; then
    node -e '
process.env.CLAUDE_QUEUE_DIR = process.argv[1];
const store = require(process.argv[2]);
for (const t of process.argv.slice(3)) store.append("smoke", t);
' "${TMPQ}" "${ROOT}/scripts/lib/queue-store.js" "$@"
  fi
  TM new-session -d -x "${PANE_W}" -y "${PANE_H}" -s "${SESSION}" \
    "env CLAUDE_QUEUE_DIR='${TMPQ}' TERM=xterm-256color LANG=en_US.UTF-8 \
     node '${ROOT}/ui/queue-ui.js' smoke 2>>'${ERRLOG}'; echo UI-EXITED:\$?; sleep 300"
  TM set -g mouse off
  wait_for 'claude-queue' || { not_ok "UI failed to start"; cap >&2; exit 1; }
}

# pop_head — run the real Stop hook once, exactly as Claude Code would.
# CQ_MAX_WAIT_MS bounds the hook's wait-for-new-tasks loop (the smoke UI holds
# a live pid file, so an empty-queue hook would otherwise wait a very long time).
pop_head() {
  printf '{"session_id":"smoke"}' \
    | CLAUDE_QUEUE_DIR="${TMPQ}" CQ_MAX_WAIT_MS=1000 node "${ROOT}/scripts/stop-hook.js" >/dev/null
}

echo "# tmux-smoke: pane ${PANE_W}x${PANE_H}, handles at x=${UPX}/${DOWNX}/${REMX}, rows y=${Y0}/${Y1}/${Y2}"

# --- 1. layout: boxes, gap rows, handle margin, chrome ----------------------

start_ui 'first task' 'second task' 'ship the release 🚀'

assert_shows 'header shows the queue counts' '3 queued · 0 done'
assert_shows 'task 1 is rendered in its box' '1 first task'
assert_shows 'task 3 renders its emoji intact' 'ship the release 🚀'
assert_shows 'footer advertises drag + jump keys' 'drag/⇧↑↓ move'
assert_shows 'footer advertises the edit key' 'e edit'

# A blank gap row must separate box 1's bottom border from box 2's top border.
GAP_ROW=$((Y0 + 2)) # row after task 1's bottom border
if cap | sed -n "${GAP_ROW}p" | grep -q '[^ ]'; then
  not_ok 'boxes are separated by a blank gap row'
else
  ok 'boxes are separated by a blank gap row'
fi

# The ✕ handle keeps a margin and never touches the right border.
if cap | sed -n "${Y0}p" | grep -q '✕  │'; then
  ok 'handles keep a right margin inside the box'
else
  not_ok 'handles keep a right margin inside the box'
  cap | sed -n "${Y0}p" >&2
fi

# --- 2. keyboard: add, reorder, jump, remove ---------------------------------

start_ui
assert_shows 'empty queue shows the centered hint' 'queue is empty — add a task above'

keys 'task alpha' Enter
wait_for '1 task alpha' || true
keys 'task bravo' Enter
wait_for '2 task bravo' || true
keys 'task charlie' Enter
assert_shows 'typing into the input appends tasks' '3 task charlie'

keys Escape # hand focus to the list (selection starts on task 1)
keys S-Down # move alpha below bravo
assert_shows 'Shift+Down moves the selected task down' '2 task alpha'
keys S-Up
assert_shows 'Shift+Up moves it back' '1 task alpha'

keys G # jump to the last task
keys d # remove it
assert_absent 'G then d removes the last task' 'task charlie'
keys g # jump back to the top
keys d
assert_absent 'g then d removes the first task' 'task alpha'
assert_shows 'the remaining task renumbers to 1' '1 task bravo'

# --- 2b. keyboard: edit in place ---------------------------------------------

start_ui 'task alpha' 'task bravo'

keys Escape # hand focus to the list (selection starts on task 1)
keys e
assert_shows 'e opens the selected task in the input box' 'edit task 1'
keys ' edited' Enter
assert_shows 'Enter saves the edit in place' '1 task alpha edited'
if [ "$(queue_texts)" = 'task alpha edited|task bravo' ]; then
  ok 'the edit was persisted without reordering the queue'
else
  not_ok "the edit was persisted without reordering the queue (got: $(queue_texts))"
fi

keys e
wait_for 'edit task 1' || true
keys ' DISCARDED' Escape
assert_absent 'Escape abandons the edit' 'DISCARDED'
assert_absent 'Escape leaves edit mode (label restored)' 'edit task'

# --- 3. mouse: drag to reorder (xterm-style mousedown stream) ----------------

start_ui 'task alpha' 'task bravo' 'task charlie'

mouse 0 "${BODYX}" "${Y0}" M  # press on alpha
mouse 32 "${BODYX}" "${Y1}" M # held-button motion across bravo…
mouse 32 "${BODYX}" "${Y2}" M # …down to charlie's row
mouse 0 "${BODYX}" "${Y2}" m  # release
assert_shows 'drag moved alpha to the bottom' '3 task alpha'
assert_shows 'bravo slid up to the top' '1 task bravo'
if [ "$(queue_texts)" = 'task bravo|task charlie|task alpha' ]; then
  ok 'the dragged order was persisted to the queue file'
else
  not_ok "the dragged order was persisted to the queue file (got: $(queue_texts))"
fi

# --- 4. mouse: click selects, hover brightens, handles act -------------------

mouse 0 "${BODYX}" "${Y0}" M # press and release on row 1, no motion = click
mouse 0 "${BODYX}" "${Y0}" m
sleep 0.3
if cap_esc | sed -n "${Y0}p" | grep -q '47m'; then
  ok 'a motionless click selects (row inverts)'
else
  not_ok 'a motionless click selects (row inverts)'
  cap_esc | sed -n "${Y0}p" >&2
fi

# Match '37m┌' (a white top-left corner): the row right of the box always
# carries a white reset, so a bare '37m' would false-positive.
mouse 35 "${BODYX}" "${Y1}" M # hover the second row (no button)
sleep 0.3
if cap_esc | sed -n "$((Y1 - 1))p" | grep -q '37m┌'; then
  ok 'hover brightens the row border to white'
else
  not_ok 'hover brightens the row border to white'
  cap_esc | sed -n "$((Y1 - 1))p" >&2
fi
mouse 35 "${BODYX}" 4 M # leave the list (cross onto the input)
sleep 0.3
if cap_esc | sed -n "$((Y1 - 1))p" | grep -q '37m┌'; then
  not_ok 'leaving the list clears the hover highlight'
  cap_esc | sed -n "$((Y1 - 1))p" >&2
else
  ok 'leaving the list clears the hover highlight'
fi

mouse 0 "${REMX}" "${Y1}" M # click the ✕ handle on row 2
mouse 0 "${REMX}" "${Y1}" m
assert_absent '✕ removes its task' 'task charlie'

mouse 0 "${DOWNX}" "${Y0}" M # click ▼ on row 1
mouse 0 "${DOWNX}" "${Y0}" m
assert_shows '▼ moves its task down a slot' '2 task bravo'
mouse 0 "${UPX}" "${Y1}" M # click ▲ on row 2 to undo it
mouse 0 "${UPX}" "${Y1}" m
assert_shows '▲ moves it back up' '1 task bravo'

dblclick "${BODYX}" "${Y0}"
assert_shows 'double-click opens the task for editing' 'edit task 1'
keys Escape # abandon the edit

# --- 5. concurrency: the Stop hook pops the head mid-drag ---------------------

start_ui 'task alpha' 'task bravo' 'task charlie'

mouse 0 "${BODYX}" "${Y2}" M  # press on charlie (not the head)
mouse 32 "${BODYX}" "${Y1}" M # drag it up one row → alpha, charlie, bravo
pop_head                      # Claude finishes a turn: alpha is consumed
sleep 0.3
mouse 32 "${BODYX}" "${Y0}" M # keep dragging to the top
mouse 0 "${BODYX}" "${Y0}" m  # release
assert_shows 'the popped head shows in the active strip' '▶ task alpha'
if [ "$(queue_texts)" = 'task charlie|task bravo' ]; then
  ok 'mid-drag pop: the dragged item is tracked by id, nothing mis-moves'
else
  not_ok "mid-drag pop: expected 'task charlie|task bravo', got: $(queue_texts)"
fi
if grep -q 'RangeError\|TypeError\|Error:' "${ERRLOG}" 2>/dev/null; then
  not_ok "the UI logged an error ($(head -1 "${ERRLOG}"))"
else
  ok 'the UI survived the mid-drag pop without errors'
fi

# --- 6. live refresh: active strip + done tail --------------------------------

start_ui 'one' 'two' 'three' 'four' 'five' 'six'
for _ in 1 2 3 4 5 6; do pop_head; done
# Six Stops: one..five finished (done), six just started (active), queue empty.
assert_shows 'the done divider shows the total when truncated' '─ done (5)'
assert_shows 'finished tasks appear in the done tail' '✓ five'
assert_shows 'the in-progress task shows in the active strip' '▶ six'

# --- 6b. pause / resume --------------------------------------------------------

start_ui 'held task'
keys Escape # hand focus to the list
keys p
assert_shows 'p shows the PAUSED flag in the header' 'PAUSED'
pop_head # a Stop while paused must start nothing
sleep 0.3
if [ "$(queue_texts)" = 'held task' ]; then
  ok 'a Stop while paused leaves the queue untouched'
else
  not_ok "a Stop while paused leaves the queue untouched (got: $(queue_texts))"
fi
keys p
assert_absent 'p again resumes (PAUSED cleared)' 'PAUSED'

# --- 6c. single instance ---------------------------------------------------------

# The UI from 6b is still running and owns the session's ui pid file; a second
# instance — however it gets spawned — must announce itself and exit at once.
DUP_OUT="$(env CLAUDE_QUEUE_DIR="${TMPQ}" node "${ROOT}/ui/queue-ui.js" smoke 2>&1)"
if printf '%s' "${DUP_OUT}" | grep -q 'already open'; then
  ok 'a duplicate UI self-closes instead of binding the same session'
else
  not_ok "a duplicate UI self-closes instead of binding the same session (got: ${DUP_OUT})"
fi
if cap | grep -qF 'claude-queue'; then
  ok 'the original UI survives the duplicate attempt'
else
  not_ok 'the original UI survives the duplicate attempt'
fi

# --- 7. resize reflows the layout ---------------------------------------------

TM resize-window -t "${SESSION}" -x 90 -y "${PANE_H}" 2>/dev/null \
  || TM resize-pane -t "${SESSION}" -x 90 -y "${PANE_H}" 2>/dev/null
sleep 0.5
if cap | sed -n "${Y0}p" | grep -q '✕  │'; then
  ok 'resize reflows boxes to the new width'
else
  not_ok 'resize reflows boxes to the new width'
  cap | sed -n "${Y0}p" >&2
fi

# --- summary -------------------------------------------------------------------

echo
echo "# tmux-smoke: ${PASS} passed, ${FAIL} failed"
[ "${FAIL}" -eq 0 ]
