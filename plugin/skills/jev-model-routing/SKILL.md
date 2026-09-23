---
name: jev-model-routing
description: Use before delegating work to a sub-agent (Agent/Task tool) — ask Jev which executor is actually needed (haiku, sonnet, opus, or the Pi coding agent on the owner's ChatGPT subscription) instead of defaulting to sonnet or guessing. Cuts Claude quota spend on work that doesn't need it.
---

# Model routing with Jev

Jev (TypeSafe System One) answers one typed CHOICE question in well under a
second: given a task description, which is the **cheapest executor still
capable of doing it well** — `haiku`, `sonnet`, `opus`, or `pi`? Code acts on
the label only when Jev is confident; otherwise it falls back to `sonnet`,
the safe default. See `plugin/scripts/jev/route.mjs`.

## When to use

Before spawning a sub-agent (the `Agent`/`Task` tool) for a piece of
delegable work — a search, a mechanical edit, an isolated implementation
task, a review pass. Not for the main session's own turn; that stays on
whatever model the person picked.

## How

```js
import { chooseExecutor } from "<plugin>/scripts/jev/route.mjs";

const { executor, confidence, source, reason } = await chooseExecutor({
  root: projectRoot,        // the project's cwd, not this plugin's install path
  task: "Rename the unused `foo` export across the repo and update imports.",
  context: "touches ~6 files, no schema/security implications",
});
```

- `executor` is one of `haiku`, `sonnet`, `opus`, `pi` — always a valid
  value, never `null` (fallback covers that).
- `source` is `"jev"` when Jev's answer was used, `"fallback"` when the
  default (`sonnet`) was used instead — because Jev was unavailable, the
  answer was low-confidence, the task text looked sensitive, or Jev picked
  `pi` but the Pi worker isn't installed/available on this machine.
- Spawn the sub-agent on the returned `executor`. For `pi`, run it through
  `plugin/scripts/jev/pi-run.mjs`'s `runPi()` instead of the `Agent` tool —
  it runs headless Pi in an isolated git worktree and hands back
  `{summary, diff}`.

## Guarantees

- **Fail-open.** No credential configured, a timeout (~3s, `jev.timeoutMs`),
  a malformed reply, or `jev.enabled: false` in `maple.config.json` — all of
  these resolve to `sonnet`, never an error and never a stall.
- **Confidence-gated.** A `choice` answer below `jev.confidenceFloor`
  (default 0.5) is treated as "don't know" and falls back, the same rule
  `plugin/scripts/jev/client.mjs`'s `decide()` applies everywhere in this
  plugin.
- **`pi` degrades gracefully.** Jev doesn't know whether the Pi SDK is
  installed or its quota is exhausted — `chooseExecutor()` checks
  `piAvailable()` after the fact and downgrades to `sonnet` rather than
  handing back an executor the caller can't actually use.
- **Redacted, minimal payload.** Only `task` (clipped to ~900 chars) and
  `context` (clipped to ~300 chars) are sent, both passed through
  `redact.mjs` first (masks emails, tokens, hex strings, phone-shaped
  numbers). Text that looks like it holds a secret or password is never
  sent at all — routing falls back to `sonnet` instead.
- **Logged.** Every decision (executor, confidence, source, a redacted task
  preview) is appended to `.maple/jev-decisions.jsonl` in the project root
  (gitignored). Run `node plugin/scripts/jev/report.mjs [root]` for a
  summary — decision counts, how often Jev's answer was actually used vs.
  fallback, average confidence, per kind.

## Config (`maple.config.json`)

See `plugin/README.md`'s Jev section for the full `jev.*` key set
(`enabled`, `credentialTarget`, `confidenceFloor`, `timeoutMs`).

## Credential

Reads a TypeSafe API key from the OS credential store (Windows Credential
Manager) — see `plugin/skills/credential-manager`. Target name resolution
order: `jev.credentialTarget` (if set) → `Maple-TypeSafe-APIKey` →
`MapleLens-TypeSafe-APIKey`. No key configured is not an error — it's the
first (and most common) fail-open path above.

## Attribution

The routing concept (ask a fast decision model, confidence-gate, fail open)
is adapted from kerpopule/hermes-jev-skills (MIT) — see `./NOTICE`. The
implementation here is a from-scratch Node port for maple-standard's own
four-executor set, not hermes-jev-skills' multi-vendor OpenRouter pool
system.
