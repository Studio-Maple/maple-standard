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
  ephemeral `<branchPrefix><slug>` branch (default prefix `agent/`). A
  session physically cannot stage another's files.
- **A single semaphore** — the only path to the target branch is
  `maple-land`, which holds one global lock while it rebases -> runs the
  configured gate command -> pushes.
- **No sprawl** — `maple-reap` mechanically removes landed/merged worktrees.

## Commands

Primary interface = the plugin's slash commands (`/wt-start`, `/wt-land`,
`/wt-preview`, `/wt-reap` — see `plugin/commands/`). The raw `bash`
invocations below are the same scripts, useful outside Claude Code or for
debugging:

```bash
bash "$CLAUDE_PLUGIN_ROOT/scripts/agent-wt/maple-start.sh" my-feature
#   --fresh-deps   run worktree.freshDepsCommand instead of linking node_modules
#   --no-launch    don't open a tmux/claude session
#   --from <ref>   branch off something other than origin/<targetBranch>

bash "$CLAUDE_PLUGIN_ROOT/scripts/agent-wt/maple-preview.sh" my-feature
bash "$CLAUDE_PLUGIN_ROOT/scripts/agent-wt/maple-preview.sh" --stop

bash "$CLAUDE_PLUGIN_ROOT/scripts/agent-wt/maple-land.sh"
#   --tier <name>   which worktree.gate.tiers.<name> command to run (default worktree.gate.defaultTier)
#   --keep          don't prune the worktree after landing
#   --no-push       rebase + gate only, leave the branch in place

bash "$CLAUDE_PLUGIN_ROOT/scripts/agent-wt/maple-reap.sh" --dry-run
```

## Config (`maple.config.json`)

All keys optional. See `plugin/README.md` for the full schema; the subset
these scripts read:

| Key | Default | Used by |
|---|---|---|
| `worktree.remote` | `"origin"` | all |
| `worktree.targetBranch` | origin's default branch, else `"main"` | all |
| `worktree.branchPrefix` | `"agent/"` | all |
| `worktree.root` | `"../<repo-name>-wt"` | all |
| `worktree.nodeModulesDirs` | `["."]` | start, preview, reap (unlink) |
| `worktree.envFiles` | `[]` | start, preview |
| `worktree.freshDepsCommand` | `"npm ci"` | start `--fresh-deps` |
| `worktree.preview.port` | `8080` | preview |
| `worktree.preview.workdir` | `"."` | preview |
| `worktree.preview.command` | `"npm run dev -- --port {port} --host 127.0.0.1"` | preview |
| `worktree.preview.logFile` | `".preview-dev.log"` | preview |
| `worktree.gate.defaultTier` | `"gate"` | land |
| `worktree.gate.tiers.<name>` | none — **required** for any tier you use | land |
| `worktree.lock.ttlSeconds` | `1800` | land (lock) |
| `worktree.lock.waitSeconds` | `3600` | land (lock) |
| `worktree.lock.pollSeconds` | `5` | land (lock) |
| `worktree.reap.staleHours` | `24` | reap `--force` |

## Known gaps vs. the VeHagita original (see plugin/README.md "Gaps")

- **No package-manager-specific dependency linking beyond `node_modules`
  junctions/symlinks.** VeHagita's `_lib.sh` linked exactly four
  monorepo-specific dirs (`.`, `frontend`, `tests/e2e`, `supabase/tests`);
  this version takes an arbitrary list via `worktree.nodeModulesDirs`, but a
  project must enumerate its own dirs — there's no auto-discovery.
  Windows-only: junction/hardlink logic mirrors the original 1:1
  (`mklink /J` for dirs, `mklink /H` for files); Unix uses real symlinks.
- **No Supabase-specific `SUPABASE_WORKDIR` gate workaround.** VeHagita's
  `vh-land.sh` set `SUPABASE_WORKDIR` so the Supabase CLI's local-stack
  identity (keyed to a project dir) resolved from inside a worktree. That's
  a Supabase-CLI-specific quirk, not something this generic script can infer
  — if your `worktree.gate.tiers.*` command needs a similar per-tool
  workaround, bake it into the command string itself (e.g.
  `"gate": "SUPABASE_WORKDIR=/abs/path npm run ci:gate"`).
- **No auto-launch beyond tmux.** `maple-start`'s launch step only knows
  tmux + `claude` on PATH; anything else (Windows Terminal tabs, iTerm2,
  etc.) falls back to printing the manual `cd` command.
