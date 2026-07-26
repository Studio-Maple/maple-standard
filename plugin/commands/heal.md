---
description: Self-healing error review — fetch, triage, fix, and verify tracked errors
---

# /heal — Self-Healing Error Review

Review unresolved issues from the project's configured error tracker,
cluster them, propose fixes, and only resolve in the tracker **after** the
fix is verified live and the tracker stops emitting events.

## Config this command reads (`maple.config.json` at project root)

Canonical keys per `docs/standard-architecture.md` (reconciled #T11 — the
old separate `errorTracker.org` + `.project` fold into one
`errorTracker.sentryProject`, and the verification ladder below moved off
`ci.tiers.*` — that path collided with the unrelated `wt-land` gate tiers
of the same name — onto its own `errorTracker.verification.*`):

| Key | Default | Notes |
|---|---|---|
| `errorTracker.provider` | `"sentry"` | `"sentry"` \| `"maplelens"` (Studio Maple's DIY tracker) — determines which MCP tool / API this command calls |
| `errorTracker.sentryProject` | **none — required** | Sentry org/project identity, or the maplelens tenant/project id |
| `errorTracker.endpoint` | **none** | For `provider: "sentry"`: the region URL (e.g. `https://de.sentry.io`) — pass it on every Sentry call. For `provider: "maplelens"`: the tracker's API base URL. |
| `errorTracker.query` | `"is:unresolved"` | default issue-search query; `$ARGUMENTS` overrides |
| `errorTracker.livePreviewUrl` | **none** | base URL to verify a fix went live (T3/T4) — e.g. `https://dev.example.com` |
| `errorTracker.verification.t1` | `["npx eslint --cache .", "npx tsc --noEmit", "npm run build"]` | pre-commit commands (array, run in order) |
| `errorTracker.verification.t2.pushCommand` | `"git push origin HEAD"` | how a fix commit gets pushed |
| `errorTracker.verification.t2.ciWatchCommand` | `""` (skip if empty) | e.g. `"gh run watch"` — a command that blocks until CI is green/red for the just-pushed commit |
| `errorTracker.verification.t3.deployUrlTemplate` | `""` (skip tier if empty) | e.g. `"{livePreviewUrl}/{page}"` — `{livePreviewUrl}`, `{page}`, `{sha}` substituted |
| `errorTracker.verification.t3.waitSeconds` | `20` | poll interval while waiting for the deployed bundle to flip |
| `errorTracker.verification.t4.enabled` | `true` | browser console/network check — uses whatever browser automation is available in the session (Claude Browser tools, or a Playwright MCP if configured) |
| `errorTracker.verification.t5.waitMinutes` | `8` | wait after T3 deploy before rechecking the tracker for new events |

No error-tracker MCP tool configured for `errorTracker.provider`? Say so up
front and stop — don't guess at a tool name; MCP server ids are
per-installation and can't be hardcoded here. Malformed config? Run
`node "$CLAUDE_PLUGIN_ROOT/scripts/validate-config.mjs"`.

## Arguments

`$ARGUMENTS` — optional tracker query, e.g. `firstSeen:-7d` or `level:error`.
Default: `errorTracker.query` (`is:unresolved` — no environment filter;
`production`/`unknown`/missing all matter unless the project says otherwise).

## Steps

### 1. Fetch + cluster

Query the configured tracker (`errorTracker.provider`) for
`errorTracker.sentryProject` (pass `errorTracker.endpoint` on every call
where the tool requires it — e.g. Sentry's region URL), query =
`$ARGUMENTS` or `errorTracker.query`, sorted by frequency, limit ~25.

If no issues, report "No unresolved issues." and stop.

For each issue, fetch full details (in parallel where the tool allows it).

**Cluster** before triaging:
- Group issues sharing `{culprit, error_class}` — they get one fix.
- Drop replay-capture duplicates: if a session-replay-error issue and a
  regular error issue share the same culprit, keep the regular one as
  canonical.

### 2. Triage each cluster

For every cluster:
1. **Stale check** (auto-skip if any holds — propose `stale` in step 3):
   - First-frame symbol no longer exists in the repo (Grep).
   - Stack file path no longer exists.
   - `lastSeen` is older than the most recent commit touching the affected file.
   - The release tag predates the most recent fix commit on the target branch.
2. **Locate the bug** — Grep for the file/function from the stack, Read surrounding code, identify root cause.
3. If the tool offers an AI-assisted root-cause proposal (e.g. Sentry's Seer), optionally use it for a code-level starting point.

### 3. Present in chat

One table for all clusters, then a single `AskUserQuestion`:

```
| Cluster | IDs | Page | Title | Events | Users | Last seen | Diagnosis (1 line) | Suggested fix (1 line) |
```

For each cluster, ask: **approve / deny / stale / change [instructions]**
(multi-select across clusters with one `AskUserQuestion` call).

### 4. Apply outcomes (per approved cluster)

#### 4a. `approve` — apply the fix and verify

Run the **verification ladder** sequentially. Halt on the first failing
tier; do not advance to marking the issue resolved in the tracker.

**T1 — Pre-commit (always).** Run each command in `errorTracker.verification.t1` in order.
Halt + revert the edit if any fails.

**T2 — Push + CI gate.**
```bash
git add <files> && git commit -m "fix(heal): <ID> — <brief>"
<errorTracker.verification.t2.pushCommand>
<errorTracker.verification.t2.ciWatchCommand>   # only if configured — blocks until CI resolves
```

**On CI red — up to 2 retries when the diagnosis is concrete:**
1. Fetch the failing job's log/output. Read the actual error — file, line, message.
2. Classify by **fix-tempting** signal: does the log name a file/line the
   fix touched, with an unambiguous error (typecheck error on the diff,
   lint violation, missing import, build error in a modified module, a
   single failing test for the changed code)? If yes — diagnose, edit,
   single new commit (`fix(heal): <ID> — <brief> (CI fix N)`), push,
   re-watch. If the failure is outside the diff, flake-shaped, or the
   diagnostic is ambiguous — do **not** retry; halt the cluster.
3. Max 2 retries, each backed by fresh log output for that retry's run —
   never retry blind. Two failed retries → escalate.
4. **Hard stops** — drop to chat immediately regardless of retries left:
   same error recurring unchanged, failure migrating to a different file
   each retry, or any deploy/secret/quota error.
5. The tracker issue stays unresolved while CI is red. Do not advance to T3-T5.
6. Never revert/reset/force-push to "clean up" CI. Forward fixes only.

**T3 — Deploy live (skip if `errorTracker.verification.t3.deployUrlTemplate` is empty).**
```bash
TARGET_SHA=$(git rev-parse --short HEAD)
until curl -fsS "<deployUrlTemplate with {sha}/{page} substituted>" | grep -q "$TARGET_SHA"; do
  sleep <errorTracker.verification.t3.waitSeconds>
done
# per-cluster marker: each fix declares what should appear in the response HTML
curl -fsS "<deployUrlTemplate>" | grep -E '<expected-marker>'
```
Halt if the expected marker doesn't show up.

**T4 — Browser check (skip if `errorTracker.verification.t4.enabled` is false).** Using
whatever browser automation is available this session: navigate to the
affected page under `errorTracker.livePreviewUrl`, read console messages
(filter errors) and network requests (look for 4xx/5xx on the affected
endpoint). If any console error matches the original tracker message → halt.

**T5 — Tracker recheck.** Wait `errorTracker.verification.t5.waitMinutes` after the T3
deploy, then re-query the tracker scoped to this issue + a short recent
window.
- 0 new events → mark every issue in the cluster resolved in the tracker.
- New events → leave unresolved, report what's still firing.

Final chat reply: `Fixed cluster <N> [<IDs>] — pushed <SHA>, deploy live, tracker quiet.`

#### 4b. `approve all` — run 4a sequentially per cluster.

#### 4c. `deny` — mark ignored in the tracker (or the closest equivalent the tool offers). Reply `Ignored <IDs>.`

#### 4d. `change [instructions]` — same as 4a but with the modified diagnosis. Full ladder still required.

#### 4e. `stale` — mark resolved in the tracker for every issue in the cluster. No commit. Reply `Marked <IDs> stale (already fixed in current code).`

### 5. Post-run sweep

After all approved clusters land, re-run the original query. Anything
**new** that appeared during the run gets reported as a follow-up batch —
do not silently miss it.

## Permission note

Writing to the tracker (resolving/ignoring an issue) is an external write.
If not pre-approved in this session's settings, ask explicitly. If denied,
leave the issue alone and report the diagnosis only — do not retry.

## Stale-issue heuristics (reference)

A cluster is stale when **any** of:
- `lastSeen` predates the most recent commit touching the affected file.
- The stack references a symbol no longer present (Grep negative).
- The release tag predates the most recent fix commit on the target branch.
- All issues in the cluster are non-production AND no production traffic is affected.

When in doubt, surface the diagnosis with a `stale?` flag and let the user decide.

## Gap vs. the VeHagita original

The source command (`VeHagita/.claude/commands/heal.md`) hardcoded the
Sentry org (`margix`), region (`de.sentry.io`), project
(`vehagita-frontend`), the live URL (`dev.wehagita.com`), a `frontend/` cd
for lint/build, and specific MCP tool names (`mcp__<uuid>__search_issues`
etc.) plus Playwright MCP for T4. All of that is now config or generic
guidance — but this means **the plugin cannot name the exact MCP tool to
call**; whoever runs `/heal` needs the matching error-tracker MCP server
actually configured in their session, and this command can only describe
the shape of the call, not the literal tool name.
