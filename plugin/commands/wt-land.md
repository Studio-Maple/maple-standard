---
description: Integrate this worktree back into the target branch (the semaphore)
---

# /wt-land — Integrate this worktree back into the target branch

Run this **from inside an agent worktree session** (branch matching
`worktrees.namePattern`, e.g. `agent/<slug>`) to integrate its work. This is
the only sanctioned path to the target branch. It **enqueues** the branch
(D066); whichever lander finds the queue-owner lock free becomes the owner
and lands everyone queued as **one batch**: rebases each queued branch FIFO onto
the freshest remote target in a throwaway integration worktree (a branch that
conflicts is returned to its owner), runs the configured gate command for the
chosen tier **once** on the combined tip (a red gate is bisected to the
breaking branch, which is returned; the rest land), fast-forward-pushes, and
each lander prunes its own worktree. The owner lock is never taken from a
live process. A red gate / rebase conflict / non-ff push makes it **refuse and
hand the branch back** — nothing un-gated lands. The Jev quality audit no
longer runs here (heavy tier, D066).

## Config this command reads (`maple.config.json` at project root)

Canonical keys per `docs/standard-architecture.md` (reconciled #T11):

| Key | Default | Notes |
|---|---|---|
| `repo.remote` | `"origin"` | |
| `repo.devBranch` / `repo.prodBranch` | origin's default branch, else `"main"` | devBranch wins if set (D008 dual-checkout) |
| `ci.prePushTier` | `"gate"` | which tier `--tier` defaults to |
| `ci.tiers.<name>` | **none** | a shell command string to run as the gate for that tier, e.g. `{"fast": "pnpm ci:fast", "gate": "pnpm ci:gate", "heavy": "pnpm ci:heavy"}`. **Required** for whichever tier you invoke — with no configured command for a tier, `/wt-land` refuses to land ungated rather than guess at one. |
| `worktrees.lock.waitSeconds` / `.pollSeconds` | `300` / `5` | owner-lock wait for `--no-push`; `worktrees.lock.ttlSeconds` is ignored (D066: never stolen from a live pid). Queued landers wait up to `MAPLE_LAND_WAIT` (14400 s), polling every `MAPLE_LAND_POLL` (3 s) |

Malformed config? Run
`node "$CLAUDE_PLUGIN_ROOT/scripts/validate-config.mjs"` for the full list
of problems.

## Arguments

`$ARGUMENTS` — optional:
- `--tier <name>` → which `ci.tiers.<name>` command to run (default `ci.prePushTier`, itself default `"gate"`).
- `--keep` → don't prune the worktree after landing.
- `--no-push` → rebase + gate this branch alone (serialised behind the owner lock, never queued), push nothing, leave the branch in place.

## Run

The gate is the affected-only fast tier (minutes at most); other `/wt-land`s that
arrive meanwhile join the next batch. **Run it in the background and report the
result:**

```bash
bash "$CLAUDE_PLUGIN_ROOT/scripts/agent-wt/maple-land.sh" $ARGUMENTS
```

Preconditions the script enforces (relay failures, don't paper over them):
- HEAD must match `worktrees.namePattern` (i.e. you're in a `/wt-start` worktree).
- The working tree must be clean — **commit the work first**; `/wt-land` integrates commits.
- The tier you asked for (or the default) must have a `ci.tiers.<name>` command configured.

On success it reports the branch landed + pruned. If the branch was started with `--task <ref>`, a successful push also sets that task's `landed: <date> <short-sha>` and `status: review` fields (ledger update failures only warn). On a red gate it prints
the failing step — fix it in this worktree and re-run. Do **not** bypass the
gate (no `--no-verify`, no skipping the configured tier) — the gate is the
enforcement.

## Gap vs. the VeHagita original

The source command (`VeHagita/.claude/commands/wt-land.md`) called a fixed
`frontend/scripts/ci-local.sh <tier>` and set a Supabase-CLI-specific
`SUPABASE_WORKDIR` env var so the local-stack identity resolved from inside
a worktree. This version runs whatever shell command `ci.tiers.<tier>`
names — generic, but it means **the adopting project must define its own
tier commands**; there is no bundled default gate script. If your gate
needs a tool-specific workaround like `SUPABASE_WORKDIR`, bake it into the
command string itself.
