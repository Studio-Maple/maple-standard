# Parallel-agent worktree workflow (`maple-*`)

Enforced parallel sessions — isolation + a merge semaphore — so multiple
Claude sessions stop colliding on the shared tree. Ported + generalized from
VeHagita's `scripts/agent-wt/vh-*.sh` (decision D085 / #T070 there): every
value that was hardcoded to VeHagita's specific layout (target branch,
`frontend/` subdir, Supabase-specific gate invocation, dev-server command,
`node_modules` dirs) now reads from `maple.config.json` at the adopting
project's root, with sane defaults for a typical single-package project.

## Why

Parallel sessions sharing one working tree clobber each other (`git commit`
stages the whole index). The fix is **enforcement, not discipline**:

- **Isolation by construction** — each session gets its own git worktree +
  ephemeral branch named per `worktrees.namePattern` (default
  `agent/<slug>`). A session physically cannot stage another's files.
- **A landing queue** (D066) — the only path to the target branch is
  `maple-land`: it enqueues the branch; the first lander becomes the queue
  owner, rebases everything queued FIFO in a throwaway integration worktree
  (conflicting branches are returned), runs ONE gate on the combined tip,
  fast-forward-pushes, and bisects a red gate to the breaking branch. The
  owner lock is never taken from a live pid (stale only when its holder is
  dead). See `maple-queue.sh` and `docs/quality.md`.
- **No sprawl** — `maple-reap` mechanically removes landed/merged worktrees.

## Commands

Primary interface = the plugin's slash commands (`/wt-start`, `/wt-land`,
`/wt-preview`, `/wt-reap` — see `plugin/commands/`). The raw `bash`
invocations below are the same scripts, useful outside Claude Code or for
debugging:

```bash
bash "$CLAUDE_PLUGIN_ROOT/scripts/agent-wt/maple-start.sh" my-feature
#   --fresh-deps   run worktrees.freshDepsCommand instead of linking node_modules
#   --no-launch    don't open a tmux/claude session
#   --from <ref>   branch off something other than origin/<targetBranch>

bash "$CLAUDE_PLUGIN_ROOT/scripts/agent-wt/maple-preview.sh" my-feature
bash "$CLAUDE_PLUGIN_ROOT/scripts/agent-wt/maple-preview.sh" --stop

bash "$CLAUDE_PLUGIN_ROOT/scripts/agent-wt/maple-land.sh"
#   --tier <name>   which ci.tiers.<name> command to run (default ci.prePushTier)
#   --keep          don't prune the worktree after landing
#   --no-push       rebase + gate this branch alone (behind the owner lock), push nothing

bash "$CLAUDE_PLUGIN_ROOT/scripts/agent-wt/maple-reap.sh" --dry-run
```

## Config (`maple.config.json`)

All keys optional. See `plugin/README.md` for the full schema (canonical
per docs/standard-architecture.md, reconciled docs/tasks.md #T11 — this
table used to list an invented `worktree.*`/singular block; that's retired,
one key set now); the subset these scripts read:

| Key | Default | Used by |
|---|---|---|
| `repo.remote` | `"origin"` | all |
| `repo.devBranch` / `repo.prodBranch` | origin's default branch, else `"main"` | all (devBranch wins if set, D008) |
| `worktrees.namePattern` | `"agent/<slug>"` | all |
| `worktrees.root` | `".worktrees"` (inside the repo, gitignored) | all |
| `worktrees.nodeModulesDirs` | `["."]` | start, preview, reap (unlink) |
| `worktrees.envFiles` | `[]` | start, preview |
| `worktrees.freshDepsCommand` | `"npm ci"` | start `--fresh-deps` |
| `worktrees.preview.port` | `8080` | preview |
| `worktrees.preview.workdir` | `"."` | preview |
| `worktrees.preview.command` | `"npm run dev -- --port {port} --host 127.0.0.1"` | preview |
| `worktrees.preview.logFile` | `".preview-dev.log"` | preview |
| `ci.prePushTier` | `"gate"` | land |
| `ci.tiers.<name>` | none — **required** for any tier you use | land |
| `worktrees.lock.ttlSeconds` | — | **ignored since D066** (a lock is never taken from a live pid; accepted so old configs validate) |
| `worktrees.lock.waitSeconds` | `300` | land `--no-push`, `/dev-burner` (lock wait); queued landers wait `MAPLE_LAND_WAIT` (default 14400 s) |
| `worktrees.lock.pollSeconds` | `5` | lock poll interval (queue followers poll every `MAPLE_LAND_POLL`, default 3 s) |
| `worktrees.reap.staleHours` | `24` | reap `--force` |

`maple.config.json` failing to parse, or holding an unknown/wrong-typed key?
Every script above falls back to defaults and warns once
(`maple_check_config` in `maple-lib.sh`) — run
`node "$CLAUDE_PLUGIN_ROOT/scripts/validate-config.mjs"` for the full list
of problems.

## Known gaps vs. the VeHagita original (see plugin/README.md "Gaps")

- **No package-manager-specific dependency linking beyond `node_modules`
  junctions/symlinks.** VeHagita's `_lib.sh` linked exactly four
  monorepo-specific dirs (`.`, `frontend`, `tests/e2e`, `supabase/tests`);
  this version takes an arbitrary list via `worktrees.nodeModulesDirs`, but a
  project must enumerate its own dirs — there's no auto-discovery.
  Windows-only: junction/hardlink logic mirrors the original 1:1
  (`mklink /J` for dirs, `mklink /H` for files); Unix uses real symlinks.
- **No Supabase-specific `SUPABASE_WORKDIR` gate workaround.** VeHagita's
  `vh-land.sh` set `SUPABASE_WORKDIR` so the Supabase CLI's local-stack
  identity (keyed to a project dir) resolved from inside a worktree. That's
  a Supabase-CLI-specific quirk, not something this generic script can infer
  — if your `ci.tiers.*` command needs a similar per-tool workaround, bake
  it into the command string itself (e.g.
  `"gate": "SUPABASE_WORKDIR=/abs/path npm run ci:gate"`).
- **No auto-launch beyond tmux.** `maple-start`'s launch step only knows
  tmux + `claude` on PATH; anything else (Windows Terminal tabs, iTerm2,
  etc.) falls back to printing the manual `cd` command.
