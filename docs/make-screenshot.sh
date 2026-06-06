#!/usr/bin/env bash
#
# make-screenshot.sh — regenerate docs/screenshot.svg from the real UI.
#
# Seeds a demo queue in a throwaway CLAUDE_QUEUE_DIR, runs ui/queue-ui.js in a
# private tmux pane, captures it with colors, and renders the capture to SVG
# via docs/ansi-to-svg.js. Run it after any visual change so the README stays
# honest.
#
# Usage:  bash docs/make-screenshot.sh

set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
SOCK="cq-shot-$$"
PANE_W=64
PANE_H=23

command -v tmux >/dev/null 2>&1 || {
  echo "make-screenshot: tmux is required" >&2
  exit 1
}
if [ ! -d "${ROOT}/ui/node_modules/blessed" ]; then
  (cd "${ROOT}/ui" && npm install --silent --no-audit --no-fund)
fi

TMPQ="$(mktemp -d)"
TM() { tmux -L "${SOCK}" "$@"; }
cleanup() {
  TM kill-server 2>/dev/null
  rm -rf "${TMPQ}"
}
trap cleanup EXIT

# Three pending tasks and two already-consumed ones, so the shot shows the
# numbered boxes, the inverted selection and the done tail all at once.
CLAUDE_QUEUE_DIR="${TMPQ}" node -e '
const store = require(process.argv[1]);
store.append("demo", "wire up the new settings pane");
store.append("demo", "fix the dark-mode contrast bug");
store.append("demo", "tighten copy on the login screen");
store.append("demo", "bump deps and write the changelog");
store.append("demo", "add a retry to the flaky auth test");
store.popHead("demo");
store.popHead("demo");
' "${ROOT}/scripts/lib/queue-store.js"

TM new-session -d -x "${PANE_W}" -y "${PANE_H}" -s shot \
  "env CLAUDE_QUEUE_DIR='${TMPQ}' TERM=xterm-256color LANG=en_US.UTF-8 node '${ROOT}/ui/queue-ui.js' demo"
TM set -g mouse off

for _ in $(seq 1 50); do
  TM capture-pane -p -t shot | grep -qF 'claude-queue' && break
  sleep 0.1
done

TM send-keys -t shot Escape # focus the list
TM send-keys -t shot Down   # select the middle task
sleep 0.5

TM capture-pane -e -p -t shot | node "${ROOT}/docs/ansi-to-svg.js" > "${ROOT}/docs/screenshot.svg"
echo "wrote docs/screenshot.svg"
