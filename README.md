# claude-queue

Queue follow-up tasks for a running Claude Code session — in a clickable, draggable
terminal task list.

![the claude-queue terminal UI](docs/screenshot.svg)

Fire off your first task, then pop open a small second-terminal UI and start adding more.
Claude finishes what it's working on, then **automatically picks up the next queued task**,
draining the list one item at a time. Nothing interrupts the task in progress — items are
only pulled once the current one is done. And while the queue window is open, an idle
session **picks up new tasks the moment you add them** — no need to nudge the main window.

```
  ┌──────────────────────────┐         writes / edits        ┌──────────────────────┐
  │  Main Claude Code session │                               │  Second terminal     │
  │                           │     ┌───────────────────┐     │  window (the UI)     │
  │  /claude-queue ───────────┼────▶│ queue-<sid>.json  │◀────┤  clickable task list │
  │  (opens the UI)           │     │ {queue,active,done}│    │  add / remove / move │
  │                           │     └───────────────────┘     └──────────────────────┘
  │  Stop hook ◀──── reads ───┼──── starts next → "do this next"
  └──────────────────────────┘
```

## How it works

Claude Code fires a **`Stop` hook** every time Claude finishes a turn. claude-queue's
hook advances your session's queue file — the task Claude just finished moves to *done*,
and if a pending task exists it becomes *active* and the hook returns
`{"decision": "block", "reason": "Next queued task: …"}`. That tells Claude not to go idle
and to work on that task next.

When there's nothing left to start, the behavior depends on the queue window:

- **window open** — the hook waits, watching the queue file, and feeds Claude the next
  task the instant you add one. The session shows as working while it waits; pressing
  Esc or sending a message in the main window takes over immediately.
- **window closed** — the hook exits and the session idles as usual.

Each block consumes exactly one queued item, so the feeding can't run away on its own —
it only continues while you keep adding tasks.

The terminal UI and the hook share one file per session
(`~/.claude-queue/queue-<session_id>.json`), written atomically so they never collide.
Exactly one queue window runs per session: a duplicate (however it gets spawned —
window restoration, a terminal quirk, running `/claude-queue` twice) notices and
closes itself immediately.

## Install

claude-queue is distributed as a Claude Code plugin from this repo (which doubles as a
marketplace):

```
/plugin marketplace add robzilla1738/claude-queue
/plugin install claude-queue@claude-queue
```

Then restart Claude Code so the `Stop` hook loads.

**Requirements:** Node.js (already required by Claude Code) and macOS or Linux. The UI's
one dependency (`blessed`) is installed automatically the first time you open the queue.

## Usage

1. Give Claude a task as normal.
2. Run **`/claude-queue`** — a new terminal window opens with the task list.
3. Type tasks into the input box (Enter to add). Add as many as you like, whenever you like.
4. When Claude finishes its current task, it pulls the top item off your queue and starts
   on it — then the next, and the next. With the window open, even an idle session picks
   up a new task the moment you add it; close the window when you're done feeding it.

If you're in a remote/SSH/web session where a window can't be opened, `/claude-queue`
prints the exact `node …/ui/queue-ui.js <session>` command to run in any terminal instead.

### The UI

A minimal, black-and-white list. Each queued task is its own box; the selected
box is inverted (black on white), and the box under your cursor brightens so you
can see what a click will hit. The task Claude is working on right now shows in
the **▶ strip** under the input — queued boxes are what's still ahead.

| Action | Mouse | Keys |
| --- | --- | --- |
| Add a task | type in the **new task** box, click away | type + **Enter** |
| Select a task | click its box | **↑/↓** or **j/k** |
| Reorder | **drag a box up / down**, or click its **▲ / ▼** | **Shift+↑/↓** |
| Edit a task | **double-click its box** | **e** (Enter saves, Esc cancels) |
| Remove a task | click the **✕** handle on the box | **d** / **⌫** |
| Pause / resume pickup | — | **p** (Claude finishes the current task, starts nothing new) |
| Jump to top / bottom | — | **g** / **G** (or Home / End) |
| Jump to the input | click the **new task** box | **a** / **i** |
| Quit (lets the session idle) | — | **q** / **Esc** / **Ctrl-C** |

Drag-to-reorder needs a terminal that reports mouse motion (Terminal.app, iTerm2
and the rest of the xterm family all do); anywhere else, the ▲ / ▼ handles and
Shift+↑/↓ do the same job.

Finished tasks drop into a dim **done** strip at the bottom (the most recent 50
are kept) so you can see what Claude has already worked through.

## Layout

```
.claude-plugin/plugin.json        # plugin manifest
.claude-plugin/marketplace.json   # makes this repo installable as a marketplace
commands/claude-queue.md          # the /claude-queue command (opens the UI)
hooks/hooks.json                  # registers the Stop hook
scripts/stop-hook.js              # Stop hook: advance the queue, tell Claude to continue
scripts/launch-queue.sh           # opens the default terminal + starts the UI
scripts/lib/queue-store.js        # shared, atomic per-session queue file logic
ui/queue-ui.js                    # the blessed terminal task list
ui/layout.js                      # pure row/handle geometry + the drag state machine
test/                             # node:test units + hook integration + tmux smoke test
docs/                             # README screenshot + the script that regenerates it
```

## Development

```
node --test test/*.test.js     # run the test suite
bash test/tmux-smoke.sh        # drive the real UI in tmux: keys, clicks, drags, hover
(cd ui && npm install)         # install the UI dependency for local runs
node ui/queue-ui.js my-session # run the UI standalone against a session id
bash docs/make-screenshot.sh   # regenerate the README screenshot from the live UI
```

Queues live in `~/.claude-queue/`. Delete that folder any time to clear all queues, or set
`CLAUDE_QUEUE_DIR` to store them elsewhere. Files from sessions untouched for a week are
pruned automatically the next time `/claude-queue` runs.

## Notes & limitations

- macOS (Terminal.app / iTerm2 / Ghostty) and Linux (`$TERMINAL`, `x-terminal-emulator`,
  `gnome-terminal`, `konsole`, `kitty`, `alacritty`, `xterm`, …) are supported. Windows
  Terminal is not yet handled — contributions welcome.
- Queues are scoped per session id, so multiple concurrent sessions stay independent.
- The open queue window is tracked through `~/.claude-queue/ui-<session_id>.pid` — that's
  what enforces one window per session and tells the Stop hook to keep listening for new
  tasks. While it waits, the main session shows as working; that's the trade for instant
  pickup, and closing the queue window (or pressing Esc in the main session) ends it.

## License

MIT — see [LICENSE](./LICENSE).
