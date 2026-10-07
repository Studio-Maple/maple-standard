---
type: guide
title: Docker — local stacks run on demand, never at boot
description: why local Supabase/Docker stacks were auto-starting on every boot, the one-line fix that also makes idle-time honest, and the 14-day archive-candidate rule enforced via /docker-audit.
tags: [docker, supabase, local-dev, infra]
timestamp: 2026-10-06
audience: anyone running local Supabase stacks, or wondering why Docker Desktop is busy at login
authoritative_for: [the on-demand-only restart policy, the stack last-used definition, and the 14-day archive rule]
code: [supabase/config.toml, plugin/scripts/gate/ci-stack.mjs, plugin/scripts/docker/dstack.ps1, plugin/commands/docker-audit.md, ~/.claude/commands/docker-audit.md, ~/.claude/docker-stacks.json]
---
# Docker — local stacks run on demand, never at boot

> **Status:** Standard, effective 2026-08-30 (D052). The command surface
> below (`dstack.ps1`, `/docker-audit`) is not yet implemented in this
> repo — it is landing alongside this page from a concurrent session. This
> page documents the standard and the target interface, not the
> implementation.
> **Related:** [[decisions]] (D052) · [[standard-architecture]] (worktree
> lifecycle) · [[loop-pack]] (the report-then-approve pattern this borrows)
> · [[quality]] (enforcement-by-mechanism, extended here to local infra)

## What happened

The machine had 4 Supabase CLI stacks and 44 containers, all auto-starting
on every Windows boot. 36 of the 44 ran continuously; 3 (`vector`,
`storage`, `realtime`, all on dead stacks) were stuck in permanent restart
loops burning CPU. Cause: `supabase start` stamps `restart: unless-stopped`
on every container it creates, so Docker Desktop resurrects the entire
stack at login regardless of whether the project is actually being worked
on.

Stacks were identified by the `com.docker.compose.project` /
`com.supabase.cli.project` container labels, then mapped back to their
owning project by matching `project_id` against every `supabase/config.toml`
on disk. Two of the four stacks had no owner left:

- `maple-pole-local` (12 containers, built 2026-07-16) — no `config.toml`
  anywhere referenced it.
- `supabase` (12 containers, built 2026-08-05) — owned only by the legacy
  `C:\Projects\Caller\old telnyx MVP` folder; its `db` container had never
  started and 3 of its services were restart-looping.

Together these were 24 of 44 containers — 64% of the load was projects
that no longer existed. Removing both stacks, then `docker image prune -a`
(78.48GB — mostly old Supabase version tags accumulated across months of
CLI upgrades), `docker volume prune -a` (2.97GB — dead parallel-session
worktree DBs: `maple-pole-s4`/`s5`/`s6`/`s8b`, `caller-loop`,
`caller-verify1`/`2`/`3`, `your-project-local`, plus 30+ unnamed volumes),
and `docker builder prune -a` (9.93GB) reclaimed 91.4GB total. Final state:
20 containers, 20 images, 5 volumes, 13.58GB — then `docker update
--restart=no` on all 20 remaining containers.

## The design insight

While `restart: unless-stopped` is set, every container's `StartedAt`
resets on every boot — so there is **no reliable way to measure how long a
stack has actually gone unused**. A stack that hasn't been touched in
months looks identical, in `docker ps`, to one worked on yesterday: both
show a `StartedAt` of "this morning," because Docker Desktop restarted
both at login.

Setting the restart policy to `no` fixes two things with one change, not
two separate fixes:

1. It stops the auto-start.
2. It turns `StartedAt`/`FinishedAt` into a **truthful last-used
   timestamp** — because from that point on, a container only starts when
   someone actually starts it.

The idle-time rule below is only measurable *because* of the autostart
fix. Do the second without the first and the timestamps stay meaningless;
there's no version of "just track idle time" that works while
`unless-stopped` is still set.

## The standard

1. **Local stacks run only on demand.** No container carries a restart
   policy other than `no`.
2. **`supabase start` re-adds `unless-stopped` every time it runs** — the
   CLI stamps its own default, unconditionally. The policy must be
   re-stripped after every start. `dstack up <stack>` does this
   automatically; that's the reason to start stacks through it rather than
   calling `supabase start` bare.
3. **Stack last-used = `max(StartedAt, FinishedAt)`** across all of a
   stack's containers. Idle more than 14 days => candidate for archiving.
4. **Archiving is approval-gated, never automatic.** `/docker-audit` runs
   weekly, reports idle and orphaned stacks, and asks — it never removes
   anything on its own. (Same shape as the loop pack's rule that a worker
   never grades its own homework and never self-applies a destructive
   call — see [[loop-pack]].)
5. **An orphan can be archived immediately, regardless of age.** A stack
   whose `project_id` matches no `config.toml` anywhere on disk has no
   owning project left; the 14-day clock doesn't need to run before
   flagging it.
6. **Parallel-session worktrees leak Supabase volumes.** The
   `maple-pole-s*` / `caller-verify*` pattern above — each worktree's
   local Supabase stack leaves its named volume behind after the worktree
   is reaped. `docker volume prune -a` is part of the routine, not a
   one-off. See [[standard-architecture]] for the worktree lifecycle
   (`wt-start` / `wt-reap`) that creates these per-worktree stacks in the
   first place.

## Command surface

| Command | Does |
|---|---|
| `dstack ls` | List local stacks with their last-used timestamp and owning project (or "orphan"). |
| `dstack up <stack>` | `supabase start` for that stack, then immediately strips the `unless-stopped` restart policy it just re-added. |
| `dstack down <stack>` | Stop the stack. |
| `dstack audit [-Days N]` | Report stacks idle longer than `N` days (default 14) and any orphans. Report-only — never removes anything. |
| `dstack archive <stack> -Confirm` | Remove a stack's containers/volumes. Requires the explicit flag; not offered as a bare default. |
| `dstack prune` | Run image/volume/builder prune across the whole Docker install (the three commands from the incident above). |

`/docker-audit` (available both as a user-global command and a plugin
command) runs `dstack audit`, presents the findings, and asks before
calling `archive` on anything — mirroring the report-then-approve shape
used everywhere else archiving/deletion touches this standard.

Supabase CLI containers don't set the compose `working_dir` label, so
there's no direct container -> project-directory mapping to read back off
Docker. An optional registry at `~/.claude/docker-stacks.json` (stack name
-> project directory) fills that gap for `dstack ls` and `/docker-audit`
when a stack's config.toml isn't enough to resolve it on its own.

## Template stack ports - the 5632x block (D066)

On Windows, TCP `54207-54906` can be a **dynamic excluded port range** (`netsh interface ipv4 show excludedportrange
protocol=tcp`), which covers the Supabase CLI's default `5432x` ports - `supabase start` then cannot bind and the live
gate can never run on that machine (D064 landed with its live tier skipped for exactly this reason; it is recorded as
gate debt, #T15, and paid by the first green heavy run). Other ranges reserved on this machine: `50000-50359`,
`50480-50579`, `55320-55331` (VeHagita's administered exclusion), `60142-60241`, `61035-61134`.

The template's `supabase/config.toml` therefore pins **every** port the CLI binds to `56320-56329`:

| Service | Port |
|---|---|
| shadow DB (`[db].shadow_port`) | 56320 |
| API (`[api].port`) | 56321 |
| DB (`[db].port`) | 56322 |
| Studio (`[studio].port`) | 56323 |
| local SMTP (`[local_smtp].port`) | 56324 |
| analytics (`[analytics].port`, disabled) | 56327 |
| pooler (`[db.pooler].port`, disabled) | 56329 |

Blocks in use on this machine: template 5632x, VeHagita 5532x, Caller 5832x. A project instantiated from the template
picks an unused block. References that follow the config: `supabase/tests/local-defaults.mjs` (`SUPABASE_URL`
default), `.github/workflows/supabase-migrations.yml` (`--db-url`), `.env.example`.

**Owner-run, one time, elevated PowerShell** - make the block an *administered* exclusion so Windows' dynamic range can
never grow into it (it fails harmlessly if something already holds a port in the block; check first with the `netsh ...
show excludedportrange` command above):

```powershell
netsh int ipv4 add excludedportrange protocol=tcp startport=56320 numberofports=10
```

The heavy tier (`pnpm ci:heavy`, see [[quality]]) no longer uses this dev stack at all (D071): it starts its own throwaway stack
(next section). The dev stack above is only ever started by hand (`pnpm supabase:start`).
If a CI port cannot be bound, the run fails and tells you to use `MAPLE_GATE_SKIP=docker-unavailable` - which is verified
(`docker info` fails or a port of the **CI block** is unbindable), recorded as gate debt, and blocks production promotion until a green
heavy run pays it.

## The CI stack - isolated and throwaway (D071)

`maple.config.json` `ci.stack: { "portBase": 56420 }` (template) gives the heavy tier a second, disposable Supabase project:
`project_id` `<dev id>-ci` (`your-project-local-ci`; override with `ci.stack.projectId`), its own containers/network/volumes, and every
port inside the 10-port block `56420-56429` (shadow 56420, API 56421, DB 56422, Studio 56423, SMTP 56424, analytics 56427, pooler 56429).
Mechanism: `plugin/scripts/gate/ci-stack.mjs up | env | status | down`, driven by `scripts/ci-local.sh`. It copies `supabase/` into
`<git-common-dir>/maple/ci-stack/<id>/` (never `.env*`, `.temp`, `.branches`), rewrites the id and ports there, runs the CLI with `--workdir`
on that copy only and removes only Docker objects whose `com.supabase.cli.project` label equals the CI id. A fresh volume per run;
`down` always runs; one CI stack per repo (pid lock, never taken from a live pid); a start sweeps orphans of a crashed run. The dev
stack's data and migrations never matter to heavy, and heavy can never reset them.

Pick a block per project that is outside the dev block and outside every reserved range (`netsh interface ipv4 show excludedportrange
protocol=tcp`, `Get-NetTCPConnection -State Listen`). In use on this machine: dev 5532x VeHagita, 5632x template, 5832x Caller; CI 5642x
template, 584xx EasyCaller. **Owner-run, one time, elevated PowerShell** - reserve the template's CI block so Windows' dynamic range never
grows into it:

```powershell
netsh int ipv4 add excludedportrange protocol=tcp startport=56420 numberofports=10
```

By hand: `node plugin/scripts/gate/ci-stack.mjs status` (no keys), `... down` (stuck stack; refuses while another live run owns the lock).
`env` prints keys: eval it in a shell, never print or log it.
