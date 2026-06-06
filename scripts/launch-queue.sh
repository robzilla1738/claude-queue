#!/usr/bin/env bash
#
# launch-queue.sh — open the user's terminal and start the claude-queue TUI.
#
# Usage: launch-queue.sh <session_id>
#
# Invoked by the /claude-queue slash command. Opens a new terminal window
# (macOS or Linux), running the Node TUI for the given session. If no terminal
# can be opened (headless / remote / SSH), it prints the exact command to run
# manually so the user (or Claude) can start it by hand.

set -euo pipefail

RAW_SESSION_ID="${1:-${CLAUDE_SESSION_ID:-default}}"

# Resolve the plugin root from this script's location (scripts/ -> plugin root).
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PLUGIN_ROOT="$(cd "${SCRIPT_DIR}/.." && pwd)"
UI_DIR="${PLUGIN_ROOT}/ui"
UI_ENTRY="${UI_DIR}/queue-ui.js"

# Sanitize the session id with the SAME function the queue store and Stop hook
# use (safeSessionId), so all three resolve to the same queue file even for
# non-ASCII ids — and so the id can't carry shell/AppleScript metacharacters into
# the command we hand to the terminal below. Fall back to a byte-wise scrub if
# node is somehow unavailable.
SESSION_ID="$(node -e 'process.stdout.write(require(process.argv[1]).safeSessionId(process.argv[2]))' \
  "${SCRIPT_DIR}/lib/queue-store.js" "${RAW_SESSION_ID}" 2>/dev/null \
  || printf '%s' "${RAW_SESSION_ID}" | tr -c 'A-Za-z0-9._-' '_')"
[ -z "${SESSION_ID}" ] && SESSION_ID="default"

# Ensure the queue directory exists.
mkdir -p "${CLAUDE_QUEUE_DIR:-${HOME}/.claude-queue}"

# Make sure the UI's one dependency (blessed) is installed.
if [ ! -d "${UI_DIR}/node_modules/blessed" ]; then
  if command -v npm >/dev/null 2>&1; then
    ( cd "${UI_DIR}" && npm install --silent --no-audit --no-fund ) || true
  fi
fi

# The command we want the new terminal to run, and the same command with its
# quotes escaped for embedding in an AppleScript string literal (a bare "
# would end the literal and break the whole script).
RUN_CMD="node \"${UI_ENTRY}\" \"${SESSION_ID}\""
AS_CMD="${RUN_CMD//\"/\\\"}"

manual_fallback() {
  echo "claude-queue: could not open a terminal window automatically."
  echo "Run this in any terminal to open the queue UI:"
  echo
  echo "    node \"${UI_ENTRY}\" \"${SESSION_ID}\""
  echo
}

open_macos() {
  # Prefer the terminal the user is already in; fall through to Terminal.app
  # whenever that one can't be driven.
  case "${TERM_PROGRAM:-}" in
    ghostty)
      # Ghostty has no scripting dictionary; `-e` runs an argv in a new window.
      if open -na Ghostty --args -e node "${UI_ENTRY}" "${SESSION_ID}" >/dev/null 2>&1; then
        return 0
      fi
      ;;
    iTerm.app)
      osascript >/dev/null 2>&1 <<EOF
tell application "iTerm"
  create window with default profile
  tell current session of current window to write text "${AS_CMD}"
end tell
EOF
      [ $? -eq 0 ] && return 0
      ;;
  esac
  # Default to Terminal.app.
  osascript >/dev/null 2>&1 <<EOF
tell application "Terminal"
  activate
  do script "${AS_CMD}"
end tell
EOF
}

open_linux() {
  # No display → opening a GUI terminal would silently fail; use the manual
  # fallback instead (covers headless boxes and plain SSH sessions).
  if [ -z "${DISPLAY:-}" ] && [ -z "${WAYLAND_DISPLAY:-}" ]; then
    return 1
  fi

  # A new interactive shell so the TUI has a controlling terminal; keep it open
  # if node exits so the user can read any message.
  local sh_cmd="${RUN_CMD}; echo; echo '[claude-queue UI closed]'; exec \${SHELL:-bash}"

  # Honor an explicit preference first.
  if [ -n "${TERMINAL:-}" ] && command -v "${TERMINAL}" >/dev/null 2>&1; then
    "${TERMINAL}" -e bash -lc "${sh_cmd}" >/dev/null 2>&1 & return 0
  fi

  local term
  for term in x-terminal-emulator gnome-terminal konsole xfce4-terminal kitty alacritty xterm; do
    if command -v "${term}" >/dev/null 2>&1; then
      case "${term}" in
        gnome-terminal)
          "${term}" -- bash -lc "${sh_cmd}" >/dev/null 2>&1 & return 0 ;;
        konsole|xfce4-terminal)
          "${term}" -e bash -lc "${sh_cmd}" >/dev/null 2>&1 & return 0 ;;
        kitty|alacritty)
          "${term}" -e bash -lc "${sh_cmd}" >/dev/null 2>&1 & return 0 ;;
        *)
          "${term}" -e bash -lc "${sh_cmd}" >/dev/null 2>&1 & return 0 ;;
      esac
    fi
  done
  return 1
}

case "$(uname -s)" in
  Darwin)
    if open_macos; then
      echo "claude-queue: opened the queue UI for session ${SESSION_ID}."
    else
      manual_fallback
    fi
    ;;
  Linux)
    if open_linux; then
      echo "claude-queue: opened the queue UI for session ${SESSION_ID}."
    else
      manual_fallback
    fi
    ;;
  *)
    manual_fallback
    ;;
esac
