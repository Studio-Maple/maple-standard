---
description: Spin up an isolated parallel-session worktree (agent/<slug> branch)
---

# /wt-start — Spin up an isolated parallel-session worktree

Create an isolated git worktree + ephemeral `<branchPrefix><slug>` branch for
parallel work that **cannot collide** with other sessions. Each session gets
its own working tree + git index + linked `node_modules` (+ linked dev env if
configured), so a `git commit` can never sweep in another session's files.
Integrate later with `/wt-land`.

Sibling commands: `/wt-land` (integrate back to the target branch),
`/wt-preview` (watch a branch on the one dev server), `/wt-reap` (prune
merged worktrees).

## Config this command reads (`maple.config.json` at project root, all optional)

| Key | Default |
|---|---|
| `worktree.remote` | `"origin"` |
| `worktree.targetBranch` | origin's default branch, else `"main"` |
| `worktree.branchPrefix` | `"agent/"` |
| `worktree.root` | `"../<repo-name>-wt"` (sibling dir) |
| `worktree.nodeModulesDirs` | `["."]` — dirs (relative to repo root) whose `node_modules` gets linked into the new worktree |
| `worktree.envFiles` | `[]` — gitignored env files (relative to repo root) hardlinked into the worktree |
| `worktree.freshDepsCommand` | `"npm ci"` — used only with `--fresh-deps` |

No `maple.config.json`? Every key above falls back to its default — the
command still works for a single-package repo with no extra env files.

## Arguments

`$ARGUMENTS` — `<slug>` (lowercase-kebab, e.g. `reader-rail`), plus optional flags:
- `--from <ref>` → branch off something other than the configured target's remote tip (use `--from <targetBranch>` if local is ahead of origin and you need its commits).
- `--fresh-deps` → run `worktree.freshDepsCommand` for a real install in the worktree (use only when the task bumps a dependency; default junction-links the main checkout's `node_modules`).

## Run

```bash
bash "$CLAUDE_PLUGIN_ROOT/scripts/agent-wt/maple-start.sh" $ARGUMENTS --no-launch
```

Then switch **this** session into the worktree — don't tell the user to open a new one:
- Take the worktree path the script prints on stdout and call **`EnterWorktree`** with that `path` (the worktree is already registered in `git worktree list`, so `path` works). The session's working directory becomes the worktree.
- Confirm you're in (branch `<branchPrefix><slug>`), then get oriented and start the work the user described in the slug — keep working in this conversation.

Don't remind the user to `/wt-land` later — they know. (Landing is still how the work integrates back: `/wt-land` from this session when committed.)

If the slug is missing/invalid or the branch already exists, the script exits non-zero with the reason — relay it; don't retry blindly.

## Gap vs. the VeHagita original

The source command (`VeHagita/.claude/commands/wt-start.md`) hardcoded
`origin/development` as the base and assumed a `frontend/` + `tests/e2e/` +
`supabase/tests/` monorepo layout for `node_modules` linking. Both are now
`maple.config.json` keys with generic single-package defaults — a project
with a different layout must enumerate its own `worktree.nodeModulesDirs`.
