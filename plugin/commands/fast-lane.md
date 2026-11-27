---
description: Fast lane - deploy a low-risk change before its heavy + predeploy run, then owe that run (check, permit, status)
---

# /fast-lane - deploy first, enforce after

Normally a deploy needs a predeploy stamp and a green heavy run on the exact commit. The fast lane (opt-in, off by
default) lets a change ship **first** when it provably only touches low-risk paths, and moves the slow verification to
**after** the deploy. Nothing is skipped: it is owed, with a deadline, and nothing else can deploy until it is paid.

Turn it on in `maple.config.json`: `predeploy.fastLane: { "enabled": true, "allow": ["src/**", "docs/**"] }` (optional
`deny`, `deadlineHours` default 12, `permitMinutes` default 60, `gateTiers` default `["gate"]`).
It does not change the stamp's config hash, so existing stamps stay valid.

**Per deploy target (optional, D087).** Add `"targets": { "staging": "default", "production": "owner-only" }` to `fastLane` and label the staging deploy command in `deployGuard.patterns` with `"target": "staging"`. `default` = a routine permit; `owner-only` = the owner must approve this run (`permit --target production --owner-approved "<owner's words>"`; ask him first, never invent the text); `off` = no fast lane; unlisted = off. Each target has its own permit and debt: a staging debt never blocks production and never vouches for it (production still needs the full stamp for its exact HEAD). Without `targets` nothing changes. The path allow/deny lists are shared; migrations stay denied everywhere.

`$ARGUMENTS`:
- `check` / `permit` / `status` accept `--target <name>` (required with `targets`; `permit` also takes `--owner-approved` for owner-only targets).
- `check` - would HEAD qualify? Looks only: writes nothing and does not run the secret scan.
- `permit` - run every pre-deploy condition and, if all hold, issue a short-lived permit for HEAD.
- `status` - show the open debt, its deadline and what pays it. Exit 0 = clear, 10 = owed, 11 = overdue. Add `--json` for a scheduler.

```bash
node "$CLAUDE_PLUGIN_ROOT/scripts/predeploy/fastlane-cli.mjs" $ARGUMENTS
```

## What `permit` requires

- The tracked tree is clean, HEAD is pushed, and the project's gate tier is green on this exact tree.
- No unpaid gate debt, and a secret scan (gitleaks) of the diff finds nothing.
- The diff from the nearest fully stamped commit (green heavy run + predeploy pass) touches only paths matching
  `allow`. Anything matching the built-in deny list (migrations, infra/deploy, auth/RLS, edge functions, dependency
  manifests and lockfiles, CI and gate config, env/secret files) or `deny` is refused, and so is any path that matches
  no `allow` pattern. Deny always wins.
- No other fast-lane debt is open on that target: only one at a time per target (one overall without `targets`).

If anything fails, the command prints every reason and the change takes the normal full path (`/predeploy-gate`).

## What a debt is

Deploying under a permit makes the deploy guard record one **debt** on that commit: a green heavy run **and** a
predeploy stamp are owed on it within the deadline. More steps of the same deploy are fine. While the debt is open,
every other deploy to that target is refused (other targets are unaffected when `targets` is set). A permit does not survive a new commit, its expiry, or a change to the
allow/deny rules. Past the deadline nothing is rolled back for you; deploys simply stay blocked.

## The two ways out

1. **Fix forward** - get a green heavy run and a predeploy stamp on the indebted commit or any commit that contains it.
   That pays the debt (a fully stamped descendant may also be deployed).
2. **Roll back** - check out the last fully stamped commit (shown by `status`) and deploy it. The debt closes as rolled back.

The lane's state lives under `<git-common-dir>/maple/predeploy/fast-lane/` and cannot be written by tool commands, only
by this CLI and the guard.
