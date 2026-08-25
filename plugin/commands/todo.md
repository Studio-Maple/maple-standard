---
description: Manage the open-task list (docs/**/tasks.md) — allocator-aware, docs-shape-agnostic.
argument-hint: "[ | done <ID> | remove <ID> | <new task description>]"
allowed-tools: ["Bash", "Read", "Edit", "Glob"]
---


> **The allocator.** IDs are allocated, never hand-picked. The canonical allocator is the
> plugin-bundled `node "$CLAUDE_PLUGIN_ROOT/scripts/docs/next-task-id.mjs" --root "$(git rev-parse --show-toplevel)"` — it hands out
> **repo-global** ids (a counter in the git common dir + a live scan of every worktree), so
> parallel `agent/<slug>` worktrees can't both issue `#T42`. `--root` matters: `CLAUDE_PROJECT_DIR`
> is set once at session start and does not follow a `cd` into a worktree. If `$CLAUDE_PLUGIN_ROOT`
> is unset (command copied into a project standalone), fall back to `node scripts/next-task-id.mjs`.
Manage the project's open-task list. **Locate the file by search — do NOT hardcode a path:** prefer `docs/state/tasks.md`, then `docs/tasks.md`, then the first match of `docs/**/tasks.md`. If none exists, refuse: "No tasks file under docs/ — this command assumes the docs/ convention."

**No argument** → list open tasks: every `- [ ]` line, grouped by its `## Section` heading. One line each, no fluff.

**`done {ID}`** → toggle `- [ ] …#T{ID}…` → `- [x]`. A closed task is debt in tasks.md (struck tombstones cause the open-vs-closed id confusion) — so if the project has a `docs/**/log.md` or `CHANGELOG.md`, move the one-liner there and **delete it from tasks.md** instead of leaving the `[x]`. Print: `Done: #T{ID}`.

**`remove {ID}`** → delete the task line. Print: `Removed: #T{ID}`.

**Anything else** (a description) → add a task:
1. **Allocate the ID (never hand-pick — parallel sessions collide):** run the allocator (see note below) and use its "Next free task id"; better, let `--add --section "<section>" --title "…" --body "…"` allocate AND insert atomically. Only if no allocator is reachable, scan the file for the highest `#T<n>` (any width) and use `n+1` — that path is worktree-blind and can collide.
2. Append `- [ ] **#T{ID} {description}**` under a `## Inbox` section at the top of the file (create it if missing).
3. Print: `Added #T{ID}: {description}`.

If the input is really a **decision** (a choice locked, not work to do) and `docs/**/decisions.md` exists, say so and point to `/session-end` or a `D###` entry — decisions don't belong in the task list.

One line per action. No fluff.
