---
description: Run the enforced pre-deploy gate (zero findings) and issue a stamp for HEAD; also --live, doctor
---

# /predeploy-gate — zero-findings gate in front of every deploy

Runs every check in `maple.config.json` → `predeploy.checks` against the
exact HEAD commit and, only if **nothing** is found (warnings included, minus
unexpired allowlist entries and decision-backed exceptions), writes a stamp bound to the sha, the config hash,
the allowlist hash and the decisions-file hash. The `predeploy-guard` hook refuses deploy commands
without that stamp. Full rules: `docs/predeploy-gate.md` (D060).

`$ARGUMENTS`:
- *(none)* — run the full gate. Needs a clean tree and the candidate branch pushed (the remote workflow runs on GitHub).
- `doctor` — list missing tools/images/credentials with install commands (`doctor --pull` fetches Docker images).
- `--live` — AFTER a deploy: aggressive full active ZAP scan of the configured live targets; blocks the next deploy until clean.
- `--check <id>` — run one check (no stamp). `--list` — list checks.
- `--rebaseline-image-debt [--owner X --plan "..." --due YYYY-MM-DD]` — re-scan the `trivy-image` checks and rewrite the dated third-party image debt snapshot (D063); review and commit the diff. No stamp.

```bash
node "$CLAUDE_PLUGIN_ROOT/scripts/predeploy/run.mjs" $ARGUMENTS      # gate / --live / --check
node "$CLAUDE_PLUGIN_ROOT/scripts/predeploy/doctor.mjs"               # when $ARGUMENTS is "doctor"
```

The gate takes many minutes: run it in the background. On failure it prints
`[check] rule location — message` per finding and the report path
(`<git-common-dir>/maple/predeploy/reports/<sha>.json`). Fix the cause. The
only exception paths are the expiring allowlist (reason, owner, expiry) and the permanent
`predeploy-decisions.json` (existing D###, why it cannot be fixed, review date) — essentials only,
both committed, plus (when `predeploy.imageDebt` is configured) the dated, shrink-only third-party image debt file — reported as its own NOT ZERO block, never counted as zero; never a flag, `|| true`, or a lowered threshold. Do not hand-edit the stamp
directory; the guard blocks it. Never run `--live` against anything not listed
in config.
