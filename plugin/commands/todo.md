---
description: Manage the MapleLens task ledger — list, add, change, close, or rename tasks.
argument-hint: "[list | add <title> | set <ID> key=value | done <ID> | title <ID> <new title>]"
allowed-tools: ["Bash", "Read"]
---

Use the plugin task CLI. It resolves `maple.config.json` `docs.tasks` first; only when that configuration is absent should a legacy `docs/**/tasks.md` search be used as a fallback. Do not assume the ledger is inside this repository: apps can keep it in the MapleLens desk repo.

```sh
node "$CLAUDE_PLUGIN_ROOT/scripts/docs/task.mjs" --root "$(git rev-parse --show-toplevel)" list
node "$CLAUDE_PLUGIN_ROOT/scripts/docs/task.mjs" --root "$(git rev-parse --show-toplevel)" add "Title" --body "Details" --section Inbox --set priority=P1
node "$CLAUDE_PLUGIN_ROOT/scripts/docs/task.mjs" --root "$(git rev-parse --show-toplevel)" set 106 status=review
node "$CLAUDE_PLUGIN_ROOT/scripts/docs/task.mjs" --root "$(git rev-parse --show-toplevel)" done 106
node "$CLAUDE_PLUGIN_ROOT/scripts/docs/task.mjs" --root "$(git rev-parse --show-toplevel)" title 106 "New title"
# From another repo, target a desk app instead:
node "$CLAUDE_PLUGIN_ROOT/scripts/docs/task.mjs" --app MapleLens list
```

Always let `add` allocate IDs; never hand-pick one. Sessions never commit the ledger: the MapleLens desk commits and displays it. Decisions do not belong in tasks.
