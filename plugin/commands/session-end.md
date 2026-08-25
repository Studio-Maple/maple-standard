---
description: End the session — capture decisions, update log + tasks, run the docs gate. Docs-shape-agnostic.
allowed-tools: ["Bash", "Read", "Edit", "Glob"]
---


> **The allocator.** IDs are allocated, never hand-picked. The canonical allocator is the
> plugin-bundled `node "$CLAUDE_PLUGIN_ROOT/scripts/docs/next-task-id.mjs" --root "$(git rev-parse --show-toplevel)"` — it hands out
> **repo-global** ids (a counter in the git common dir + a live scan of every worktree), so
> parallel `agent/<slug>` worktrees can't both issue `#T42`. `--root` matters: `CLAUDE_PROJECT_DIR`
> is set once at session start and does not follow a `cd` into a worktree. If `$CLAUDE_PLUGIN_ROOT`
> is unset (command copied into a project standalone), fall back to `node scripts/next-task-id.mjs`.
End the session. Write directly — no approval gate. **Locate files by search (don't hardcode):**
- `log` = first of `docs/state/log.md` / `docs/log.md` / `docs/**/log.md` — if none, refuse: "No log file under docs/ — assumes the docs/ convention."
- `tasks` = first of `docs/state/tasks.md` / `docs/tasks.md` / `docs/**/tasks.md`.
- `decisions` = `docs/state/decisions.md` / `docs/**/decisions.md` (may not exist — feature-detect).

1. **Session number** — if the allocator (see note below) supports atomic session allocation (try `--add --session …` in step 5; it prints the id), let it assign the number — **don't pre-guess** (the allocator closes the parallel-session race under a lockfile). Otherwise the number is the latest `## SXXX` in the log, +1 (empty → S001; if a parallel session took your number, bump again), hand-prepended in step 5.

2. **Gather** — commits since the last `## SXXX | DATE` (`git log --oneline`), `git status --short` + `git diff --stat`, and the conversation's decisions / lessons / gotchas.

3. **Decisions → decisions.md (the key step).** For every *decision* made this session — a choice locked, an ambiguity resolved, an owner call — append a block to the decisions file:
   - ID via the allocator's `--decision` if reachable, else next `D###`.
   - `## D### | YYYY-MM-DD | title` + `**Decision:**` / `**Why:**` / `**Affects:**` (docs · #T · code).
   - If no decisions file exists, fold decisions into the log paragraph (the old way).

4. **tasks.md** — toggle `- [ ]`→`- [x]` for tasks closed this session (move them out per `/todo done` if a log/CHANGELOG exists); add new tasks (ID via the allocator) under `## Inbox`.

5. **log.md** — write the entry: `## S{n} | YYYY-MM-DD | {title}` + a dense paragraph (what shipped, lessons, gotchas — file paths + SHAs).
   - **Prefer the allocator** (atomic, lock-guarded vs parallel session-ends, validates ≤600): the allocator's `--add --session --title "{title}" --body "{paragraph}"` — it allocates the next S, prepends the block, and **prints the allocated id** (use it for step 1 + the step 8 summary). On `unknown argument` (older script / no `--session`), fall back to hand-prepending under the log heading.
   - Decisions now live in decisions.md — reference their `D###` ids rather than re-explaining. Update any `Next session:` footer.

6. **Reflection (workflow learning — concise).** Reflect on *how the session went*, not what shipped:
   - **Corrections (ground truth):** each time the user corrected/redirected you — *what you did → what they wanted → the lesson.*
   - **What worked:** moves worth repeating.
   - **Route each:** one-off → discard silently; recurring behavior/workflow rule → propose into the project lessons file (locate by search: `docs/dev/ai-workflow-lessons.md` / `docs/**/ai-workflow*lessons*.md`; create it only if the project has an `ai-workflow.md` design doc, else skip the whole step); a workflow *design* change → propose an `ai-workflow.md` / `decisions.md` edit.
   - **Present** behavior/design proposals for approval (don't auto-write these — unlike log/tasks); **synthesize, don't append**; keep it tight. Skip the whole step in projects without `ai-workflow.md`.

7. **Docs gate** — if `scripts/check-docs-drift.mjs` exists, run it; on errors, run `--fix` and note any that remain. Don't end on a red gate silently.

8. **Summary** (one line each): `Session S{n} ended` · `Decisions: D### …` · `Done: #T… ` · `Added: #T…` · `Lessons: …` · `Gate: green/red`.

The log entry is the only long-form output.
