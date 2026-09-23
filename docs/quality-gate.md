---
type: guide
title: Jev quality gate
description: the per-function Jev gate every landing passes: what it checks, what blocks, how to accept a finding.
tags: [quality, gates, jev]
timestamp: 2026-09-23
audience: anyone whose landing was blocked by the quality gate, or configuring it for a repo
authoritative_for: [the per-function quality gate's rules, suppression syntax and config]
code: [plugin/scripts/jev/audit/, plugin/scripts/agent-wt/maple-land.sh, plugin/commands/quality-gate.md]
---
# Jev quality gate

Every landing checks the functions it **created or edited** (D059). The
repo's own CI runs first; the quality gate runs after it goes green and
before the merge. MapleLens missions run the same gate after their
verification step, so a Pi worker fixes findings before the work is judged.

## What blocks

| Rule | Check | Source |
|---|---|---|
| `exact-duplicate` | the function's body is identical to another function in the repo | deterministic |
| `near-duplicate` | Jev is ≥ 0.9 sure it does the same job as an existing function | Jev |
| `security` | security score ≥ 3 (Serious) at confidence ≥ 0.6 | Jev |
| `error-handling` | the function can fail (≥ 0.7) but swallows failures (< 0.2) with no documented best-effort fallback | Jev |
| `efficiency` | efficiency score ≥ 3 (Wasteful) | Jev |

Everything else Jev notices is a warning in the report, not a block. The
thresholds are uncalibrated; tune them in `quality.jevAudit` rather than in code.

If Jev is unreachable, the gate says so loudly and only the deterministic
rule runs. Missing Jev never blocks a landing; a duplicate always does.

## Accepting a finding

Put a comment on the function, visible to anyone reviewing the diff:

```ts
// jev-audit: accept error-handling — telemetry is best-effort by design
```

The gate lists every accepted finding in its output. There is no flag that
skips the gate.

## Sensitive code

Functions whose path or name matches the denylist (credentials, auth,
secrets, tokens, MFA and the like) are never sent to Jev. They appear as
"not audited (sensitive)" and never block.

## Configuration

Opt in per repo in `maple.config.json` under `quality.jevAudit`: `enabled`,
scope directories, excludes, denylist and thresholds. Run it by hand with
`/quality-gate` (changed functions), `--full` (everything) or `--report`
(HTML report).
