---
description: Run the per-function Jev code-quality gate by hand
---

# /quality-gate — per-function Jev code-quality audit/gate

Runs the same quality gate `/wt-land` runs automatically before every merge
(see `plugin/scripts/agent-wt/maple-land.sh`): extracts every function that
was created or edited (TypeScript compiler API), asks Jev typed questions
about each one, and — in gate mode — fails when any changed function trips
a BLOCKING rule:

1. **Exact duplicate** of an existing function (same normalized body hash) —
   deterministic, no Jev call, never skipped even if Jev is unavailable.
2. **Near-duplicate**, confirmed by Jev with p ≥ 0.9, of an existing function.
3. **Security** scored Serious or worse (≥3/4) with confidence ≥ 0.6.
4. Can fail (can_fail ≥ 0.7) but doesn't visibly handle errors
   (error_handling < 0.2), and it isn't a documented best-effort catch.
5. **Efficiency** scored Wasteful or worse (≥3/4).

Everything else prints as a non-blocking warning. A denylisted (sensitive)
function is never sent to Jev at all — listed as "not audited", never
blocking.

## Escape hatch

An inline comment directly above (or inside) the function:

```
// jev-audit: accept security — reviewed, input is already sanitized upstream
```

suppresses THAT rule for THAT function. It's visible in code review, not a
CLI flag — there is no way to skip the gate itself.

## Config (`maple.config.json` → `quality.jevAudit`)

The gate is **opt-in**: with no `quality.jevAudit` block (or
`enabled: false`), both `/quality-gate` and the `/wt-land` landing step
report "skipped" rather than doing anything. See
`plugin/schema/maple.config.schema.json` and `plugin/scripts/jev/audit/config.mjs`
for the full key list (scopeDirs, extensions, excludeGlobs, denylistPatterns/
Files/Dirs, moduleLabels, thresholds) and their defaults.

## Arguments

`$ARGUMENTS` — optional:
- *(none)* → audit only new/modified functions vs. the base branch
  (`quality.jevAudit.baseBranch`, else `repo.devBranch`, else `main`), and
  **fail on any blocking finding** (same as the `/wt-land` step).
- `--full` → audit every in-scope function, not just changed ones. Pass this
  WITHOUT `--gate` to get a report on the whole repo without failing on
  pre-existing issues you didn't touch; `--full --gate` together audits and
  gates the entire repo, which is rarely what you want for a landing gate.
- `--report` → also write `report.html` (self-contained, open in a browser)
  alongside `report.json`.
- `--base <branch>` → override the diff base for this run.

## Run

Default (changed functions, gated):

```bash
node "$CLAUDE_PLUGIN_ROOT/scripts/jev/audit/run.mjs" --gate $ARGUMENTS
```

Report-only over the whole repo (no `--gate`, so nothing can fail the turn):

```bash
node "$CLAUDE_PLUGIN_ROOT/scripts/jev/audit/run.mjs" --full --report
```

Cache/report land under `<repo>/.maplelens/audit/<slug>/` when that path is
gitignored in the target repo, else under this plugin's own per-user state
directory — never a newly-tracked file (see
`plugin/scripts/jev/audit/state-dir.mjs`).

On a red gate it prints each blocking finding as `[rule] file:line
function-id` plus what to do — fix it, or add a documented accept comment,
then re-run. On success it also lists any accepted suppressions and
sensitive functions it skipped, so both stay visible even when the gate is
green.
