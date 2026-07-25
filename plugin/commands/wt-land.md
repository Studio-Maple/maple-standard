---
description: Integrate this worktree back into the target branch (the semaphore)
---

# /wt-land — Integrate this worktree back into the target branch

Run this **from inside a `<branchPrefix><slug>` worktree session** to
integrate its work. This is the only sanctioned path to the target branch.
Under one global lock it rebases onto the freshest remote target, runs the
configured gate command for the chosen tier, fast-forward-pushes, and prunes
the worktree. A red gate / rebase conflict / non-ff push makes it **refuse
and release** — nothing un-gated lands.

## Config this command reads (`maple.config.json` at project root)

| Key | Default | Notes |
|---|---|---|
| `worktree.remote` | `"origin"` | |
| `worktree.targetBranch` | origin's default branch, else `"main"` | |
| `worktree.gate.defaultTier` | `"gate"` | which tier `--tier` defaults to |
| `worktree.gate.tiers.<name>` | **none** | a shell command string to run as the gate for that tier, e.g. `{"fast": "npm run ci:fast", "gate": "npm run ci:gate", "core": "npm run ci:core"}`. **Required** for whichever tier you invoke — with no configured command for a tier, `/wt-land` refuses to land ungated rather than guess at one. |
| `worktree.lock.ttlSeconds` / `.waitSeconds` / `.pollSeconds` | `1800` / `3600` / `5` | stale-lock recovery + queue timeout |

## Arguments

`$ARGUMENTS` — optional:
- `--tier <name>` → which `worktree.gate.tiers.<name>` command to run (default `worktree.gate.defaultTier`, itself default `"gate"`).
- `--keep` → don't prune the worktree after landing.
- `--no-push` → rebase + gate only (dry run), leave the branch in place.

## Run

The gate can take minutes and holds the global lock the whole time, so other
`/wt-land`s queue behind it. **Run it in the background and report the
result:**

```bash
bash "$CLAUDE_PLUGIN_ROOT/scripts/agent-wt/maple-land.sh" $ARGUMENTS
```

Preconditions the script enforces (relay failures, don't paper over them):
- HEAD must be a `<branchPrefix>*` branch (i.e. you're in a `/wt-start` worktree).
- The working tree must be clean — **commit the work first**; `/wt-land` integrates commits.
- The tier you asked for (or the default) must have a `worktree.gate.tiers.<name>` command configured.

On success it reports the branch landed + pruned. On a red gate it prints
the failing step — fix it in this worktree and re-run. Do **not** bypass the
gate (no `--no-verify`, no skipping the configured tier) — the gate is the
enforcement.

## Gap vs. the VeHagita original

The source command (`VeHagita/.claude/commands/wt-land.md`) called a fixed
`frontend/scripts/ci-local.sh <tier>` and set a Supabase-CLI-specific
`SUPABASE_WORKDIR` env var so the local-stack identity resolved from inside
a worktree. This version runs whatever shell command
`worktree.gate.tiers.<tier>` names — generic, but it means **the adopting
project must define its own tier commands**; there is no bundled default
gate script. If your gate needs a tool-specific workaround like
`SUPABASE_WORKDIR`, bake it into the command string itself.
