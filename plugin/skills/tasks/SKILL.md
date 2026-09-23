---
name: tasks
description: Use whenever the user or the work calls for adding, changing, closing or listing a task on an app's MapleLens board (MapleLens, EasyCaller, or the current repo), including from another repo.
---

# tasks

Use the ledger CLI; it resolves `docs.tasks` from the app configuration:

```sh
node "$CLAUDE_PLUGIN_ROOT/scripts/docs/task.mjs" --app MapleLens list
node "$CLAUDE_PLUGIN_ROOT/scripts/docs/task.mjs" --app EasyCaller add "Title" --body "Details" --section Inbox --set priority=P1
node "$CLAUDE_PLUGIN_ROOT/scripts/docs/task.mjs" --root "$(git rev-parse --show-toplevel)" set 106 status=review
node "$CLAUDE_PLUGIN_ROOT/scripts/docs/task.mjs" --app MapleLens done 106
node "$CLAUDE_PLUGIN_ROOT/scripts/docs/task.mjs" --app MapleLens title 106 "New title"
```

IDs are always allocated by the script; never choose one. Sessions never commit the ledger: the MapleLens desk does. Decisions do not go in tasks.
