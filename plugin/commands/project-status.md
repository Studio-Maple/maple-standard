---
description: Status board — git + gaps + tasks + decisions + drift-gate health + #T collisions. Docs-shape-agnostic.
allowed-tools: ["Bash", "Read", "Glob"]
---


> **The allocator.** IDs are allocated, never hand-picked. The canonical allocator is the
> plugin-bundled `node "$CLAUDE_PLUGIN_ROOT/scripts/docs/next-task-id.mjs" --root "$(git rev-parse --show-toplevel)"` — it hands out
> **repo-global** ids (a counter in the git common dir + a live scan of every worktree), so
> parallel `agent/<slug>` worktrees can't both issue `#T42`. `--root` matters: `CLAUDE_PROJECT_DIR`
> is set once at session start and does not follow a `cd` into a worktree. If `$CLAUDE_PLUGIN_ROOT`
> is unset (command copied into a project standalone), fall back to `node scripts/next-task-id.mjs`.
Concise status board. **Locate files by search (prefer `docs/state/`):** gaps, tasks, decisions under `docs/**`. Skip a section silently if its file is missing. Don't hardcode `docs/tasks.md`.

**Run in parallel:**
1. `git log --oneline -10` — latest commits
2. `git status --short` — uncommitted work
3. `git stash list` — stashed work
4. `git branch -a` — branches
5. **Drift gate** — if `scripts/check-docs-drift.mjs` exists: run it, capture the trailing `N error(s), M warning(s)`.
6. **#T integrity** — the allocator (see note below): next free id, plus `--check` for collisions.

**Read** (skip if missing): the gaps file, the tasks file, the decisions file (top 3 newest `D###`).

Then print:

```
PROJECT STATUS — {project name from cwd}
═══════════════════════════════════════════════

GAPS (address first):
• [non-empty bullets from the gaps file, max 5; omit if missing/empty]

OPEN TASKS:
• [open `- [ ]` items, grouped by `## Section`; one line each]

RECENT DECISIONS:
• [top 3 `D###` titles from the decisions file; omit if missing]

RECENT COMMITS:
• [one-liner per commit, max 5]

UNCOMMITTED WORK:
• [modified files grouped by area] + [untracked listed separately]

HEALTH:
• Drift gate: {N errors / M warnings, or "n/a"}
• #T collisions: {list, or "none"}   ·   Next id: {#T…}

BRANCHES: • [current + notable]
STASHED:  • [entries or "None"]
```

Rules:
- Omit any section whose file is missing — don't fall back to other locations.
- Short. Just the board — no explanations, no recommendations.
- Truncate each task to one line.
