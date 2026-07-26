---
description: Prune merged/orphan parallel-session worktrees
---

# /wt-reap — Prune merged / orphan parallel-session worktrees

Keep the worktree set from sprawling — mechanical cleanup so nobody has to
remember it. By default it removes only work that already landed — branches
matching `worktrees.namePattern` merged into the remote target (worktree +
branch) and orphan worktree dirs whose branch is gone. Unmerged branches are
**never** auto-deleted (that's unlanded work); they're reported with their
idle age.

## Config this command reads (`maple.config.json` at project root)

Canonical keys per `docs/standard-architecture.md` (reconciled #T11):

| Key | Default |
|---|---|
| `repo.remote` | `"origin"` |
| `repo.devBranch` / `repo.prodBranch` | origin's default branch, else `"main"` |
| `worktrees.namePattern` | `"agent/<slug>"` |
| `worktrees.root` | `"../<repo-name>-wt"` |
| `worktrees.reap.staleHours` | `24` — idle threshold for `--force` |

Malformed config? Run
`node "$CLAUDE_PLUGIN_ROOT/scripts/validate-config.mjs"`.

## Arguments

`$ARGUMENTS` — optional:
- `--dry-run` → show what would be removed, change nothing.
- `--force` → also free disk for unmerged-but-idle worktrees (removes the worktree dir, **keeps** the branch).
- `--stale-hours N` → idle threshold for `--force` (default `worktrees.reap.staleHours`, itself default 24).

## Run

```bash
bash "$CLAUDE_PLUGIN_ROOT/scripts/agent-wt/maple-reap.sh" $ARGUMENTS
```

Report the count removed/kept. Safe to run anytime — and a good candidate
for `/loop` so sprawl can't reaccumulate, or as one of `dev-burner`'s loops.
