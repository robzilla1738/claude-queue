---
description: Open the claude-queue task list in a new terminal window so you can queue follow-up tasks for this session.
argument-hint: ""
allowed-tools: Bash
disable-model-invocation: true
---

## Open the queue UI

I'm launching the claude-queue task list in a separate terminal window for this session.

!`"${CLAUDE_PLUGIN_ROOT}/scripts/launch-queue.sh" "${CLAUDE_SESSION_ID}"`

Tell the user, in one short sentence, that their queue UI has opened in a new terminal window and they can add tasks there — you'll work through your current task, then automatically pick up whatever they've queued, one item at a time, until the queue is empty.

If the command output above instead printed a `node ...` command (meaning no terminal could be opened — e.g. a remote/SSH/web session), share that exact command with the user and explain they can run it in any terminal to open the queue UI manually.

Do not take any further action or start new work — just confirm and wait.
