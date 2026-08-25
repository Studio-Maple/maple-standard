---
type: spec
title: Standard architecture — the plugin / template / bootstrap / global split
description: the standard's four-way split (plugin / user-global / stamped files / template), the `maple.config.json` schema, and the `/adopt-standard` sequence.
tags: [architecture, plugin, config-schema]
timestamp: 2026-07-25
audience: anyone asking "where does this piece of the standard live, and why."
authoritative_for: [the four-way component split, the maple.config.json schema, and the adoption sequence]
code: [plugin/, plugin/commands/adopt-standard.md, plugin/README.md]
---
# Standard architecture — the plugin / template / bootstrap / global split

> **Status:** Approved 2026-07-25 (owner sign-off). Spec for plugin v1 — implementation tracked in [[tasks]] and [[decisions]].
> **Related:** [[loop-pack]] · [[maplelens]] · [[rollout]]

**The methodology carries over unchanged: enforce by mechanism, not by trust.** Everything below is either a gate that fails red or a file a gate reads — nothing here is a convention someone has to remember across projects.

## Why a hybrid, not one artifact

A single template repo (clone-and-rename) works for greenfield Next.js+Supabase projects but can't retrofit VeHagita, EasyCaller, or anything already alive with its own stack, history, and extras. A single global `~/.claude` drop-in works for truly universal behavior but can't carry project-specific parameters (branch names, CI commands, tracker endpoints) or per-project docs scaffolding. So the standard splits into four components, each carrying only what belongs at that layer.

## The four components

| Component | Lives in | Carries | Why here, not elsewhere |
|---|---|---|---|
| **maple-standard plugin** | Claude Code plugin (installed per-project or per-user via the plugin marketplace mechanism) | `wt-*` commands, generic safety hooks, parameterized `/heal`, the loop pack (`/sweep-errors` `/burn-backlog` `/sweep-quality` `/detect-drift` `/dev-burner`), `/adopt-standard`, the session commands (`/todo` `/project-status` `/session-end` `/represent` `/review-aspect`), `skills/` (`credential-manager`), MapleLens MCP server + shared worker code | Stack-agnostic logic that reads `maple.config.json` for the project-specific bits. One codebase, versioned, updates propagate to every adopting project without a re-clone. |
| **User-global `~/.claude`** | The owner's machine, outside any repo | Personal preferences only — voice, working style, cross-project conventions that are about *the owner*, not about a project | **Near-empty by design (D051).** "Zero project-specific parameters" turned out to be the wrong test: the credential-manager skill and the five session commands had zero parameters and still belonged in the plugin, because machine-local means unversioned, invisible to a new machine, and unavailable to an adopting project. The real test is *does anything but this one human need it* — if yes, it ships in the plugin. This bucket is the one place with no gate backing it, so keep it for things a gate could never check anyway. |
| **Per-project stamped files** | Each adopting project's repo root, written once by `/adopt-standard` then owned by the project | `maple.config.json`, `docs/` skeleton (`index.md` `decisions.md` `tasks.md` `gaps.md` `log.md`), `docs/.docs-index.json`, a `CLAUDE.md` skeleton merged into (never overwriting) whatever's there | This is the parameterization surface the plugin commands read. Project-owned after stamping — `/adopt-standard` never re-stamps over existing content. |
| **maple-standard template repo** (unchanged) | `Studio-Maple/maple-standard`, clone-and-rename | Full Next.js+Supabase+Vercel scaffold, its own CI workflows, its own `.claude/hooks/*` including the JS/TS-specific ones | Greenfield-only concern. A brand-new project still gets the fastest path: clone, rename, done — it doesn't need a bootstrap command because there's no existing state to reconcile. |

**Project-specific hooks stay out of the plugin.** `eslint-fix`, `size-warning`, `build-counter` assume ESLint + `tsc` + a per-layer line-cap convention — real for Next.js/TS projects, not universal. They stay in the template (for greenfield) and get hand-ported per-project (for adopted projects) — never promoted into the plugin's generic hook set.

## v1 layers of the plugin (scope boundary — not reopening this)

1. **Worktree lifecycle** — `wt-start` / `wt-land` / `wt-preview` / `wt-reap`, generalized from VeHagita's `scripts/agent-wt/*`, parameterized by `maple.config.json`'s `repo.*` fields instead of hardcoded branch/domain names.
2. **Generic safety hooks** — `deny-credential-paths`, `scrub-secrets`, `bash-guard` (new — a stack-agnostic dangerous-command blocker, no JS/TS equivalent existed before), `dirty-tree-guard`, `ask-gate`, `decision-reminder`, `docs-sync-reminder`, `parallel-session-warn`. All pure Node, no stack assumptions — file paths and doc locations come from `maple.config.json`.
3. **Docs gate + decision integrity** — the drift-gate pattern (dead `Code:` paths, broken wikilinks, stale index, ID collisions) and the `D###`/`#T###`/`S###` allocator, both already stack-agnostic in the template — ported as-is, paths parameterized. The allocator's ids are **repo-global**, not per-worktree (D050): a counter in `<git-common-dir>/maple/id-counters.json` plus a live `git worktree list` scan, with the `--add` mutex in that same shared dir. Two parallel `agent/<slug>` sessions used to each scan their own branch-local `tasks.md` and both issue `#T42`, colliding only at `/wt-land`. Fails open to single-worktree behaviour outside git. `Code:` `plugin/scripts/docs/lib/id-store.mjs`.
4. **Self-healing engine** — a parameterized `/heal` that takes its tracker (Sentry today, MapleLens once deployed — see [[maplelens]]) and its target environment from config, instead of VeHagita's hardcoded org/project/domain.

Everything else discussed this session (loop pack, MapleLens) builds on top of these four; none of them reopen this boundary.

## `maple.config.json` — schema

One file, repo root, written by `/adopt-standard`, read by every plugin command.

```jsonc
{
  "$schema": "https://maple-standard/schema/maple.config.json",
  "project": {
    "name": "EasyCaller",
    "slug": "caller"
  },
  "repo": {
    // Decision 7: prod/dev dual checkouts of the same repo.
    "prodCheckout": "C:/Projects/Caller",
    "devCheckout": "C:/Projects/Caller-development",
    "prodBranch": "production",
    "devBranch": "development",
    "standingLoopBranch": "dev-burner"   // see [[loop-pack]]
  },
  "worktrees": {
    "root": "../Caller-wt",
    "namePattern": "agent/<slug>"
  },
  "docs": {
    "root": "docs/",
    "index": "docs/index.md",
    "decisions": "docs/decisions.md",
    "tasks": "docs/tasks.md",
    "gaps": "docs/gaps.md",
    "log": "docs/log.md",
    "docsIndexJson": "docs/.docs-index.json"
  },
  "ci": {
    "tiers": {
      "fast": "npm run ci:fast",
      "gate": "npm run ci:gate",
      "core": "npm run ci:core",
      "full": "npm run ci:full"
    },
    "prePushTier": "gate"
  },
  "lint": {
    "roots": ["app/src", "admin/src", "frontend/app"],
    "maxWarnings": 0
  },
  "sizeCaps": {
    "hook": 250, "component": 300, "service": 350, "route": 500
  },
  "errorTracker": {
    "provider": "sentry",              // "sentry" | "maplelens" — flips once deployed, see [[maplelens]]
    "endpoint": null,                  // MapleLens worker URL once live
    "readTokenRef": null,              // credential-manager reference, never a literal value
    "writeTokenRef": null,
    "sentryProject": "caller-frontend"
  },
  "loops": {
    "enabled": ["sweep-errors", "burn-backlog", "sweep-quality", "detect-drift"],
    "budgetPerCycle": { "turns": 40, "minutes": 20 }
  }
}
```

Every plugin command that needs a path, branch name, or CI invocation reads it from here — nothing hardcoded. A command run in a repo with no `maple.config.json` fails loud and points at `/adopt-standard`, it does not guess.

## Adoption sequence (`/adopt-standard`)

1. **Detect repo layout.** Look for a sibling `<name>-development` / prod checkout pair (decision 7's dual-checkout convention); if ambiguous, ask rather than guess.
2. **Write `maple.config.json`.** Infer what's inferable from `package.json` / existing CI config / existing git branches; ask (`AskUserQuestion`, per Maayan's global convention) for anything it can't infer. Validate against the schema before writing.
3. **Stamp `docs/` skeleton if missing.** Write `index.md`, `decisions.md`, `tasks.md`, `gaps.md`, `log.md` only where absent — never overwrite an existing page. A project with its own richer `docs/` (VeHagita) keeps it; `/adopt-standard` fills gaps, not replaces structure.
4. **Generate `docs/.docs-index.json`.** Run the index generator once so the drift gate has something to check against from commit one.
5. **Merge the `CLAUDE.md` skeleton.** If `CLAUDE.md` exists, propose insertions as a diff for approval — never a blind overwrite. This is how VeHagita "keeps its extras" per [[rollout]].
6. **Reconcile `.claude/settings.json` against project-local hooks.** The plugin's own hooks apply globally once the plugin is enabled — no per-project merge needed for them. This step only checks the project's own directly-wired hooks (if any) for a filename collision with the plugin's hooks and flags it; it never merges entries in.
7. **Verify.** Run the docs-drift gate once and one CI tier once; report red/green. Adoption isn't declared done on say-so — it's done when the gate the project just inherited actually passes.

Per-step "adopted correctly" checks are detailed in [[rollout]].
