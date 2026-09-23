---
name: jev-model-routing
description: Use before delegating work to a sub-agent (Agent/Task tool) — the default is the cheapest executor, Pi on gpt-5.6-luna, and Jev only escalates when confident the task needs more (up through gpt-5.6-terra/sol, sonnet, opus). Cuts Claude quota spend on work that doesn't need it.
---

# Model routing with Jev

**The burden is inverted.** The default executor is the cheapest one — the
Pi coding agent on the owner's ChatGPT subscription, running the
`gpt-5.6-luna` model — whenever Pi is available. Jev only picks something
more expensive when it is **confident (>= 0.8)** the task needs it. This is
the opposite of "ask Jev to justify the cheap option" — cheap is the
default, and an escalation has to earn its keep.

Jev answers one typed CHOICE question in well under a second: given a task
description, which starting rung on the ladder does it need?

```
gpt-5.6-luna  ->  gpt-5.6-terra  ->  gpt-5.6-sol  ->  sonnet  ->  opus
 (default)         (medium)                          (big / high-risk /
                                                        production / security)
```

See `plugin/scripts/jev/ladder.mjs` (the ladder itself) and
`plugin/scripts/jev/route.mjs` (the routing call).

## When to use

Before spawning a sub-agent (the `Agent`/`Task` tool, or a headless Pi run
via `pi-run.mjs`) for a piece of delegable work — a search, a mechanical
edit, an isolated implementation task, a review pass. Not for the main
session's own turn; that stays on whatever model the person picked.

## How

```js
import { chooseExecutor } from "<plugin>/scripts/jev/route.mjs";

const { model, kind, confidence, source, reason } = await chooseExecutor({
  root: projectRoot,        // the project's cwd, not this plugin's install path
  task: "Rename the unused `foo` export across the repo and update imports.",
  context: "touches ~6 files, no schema/security implications",
});
```

- `model` is a ladder rung: `gpt-5.6-luna`, `gpt-5.6-terra`, `gpt-5.6-sol`,
  `sonnet`, or `opus` — always a valid value, never `null`.
- `kind` is `"pi"` for the three `gpt-5.6-*` rungs, `"claude"` for
  `sonnet`/`opus` — tells you which runner to use.
- `source` is `"jev"` when Jev's answer was used, `"fallback"` when the
  default was used instead (Jev unavailable, the escalation wasn't
  confident enough, the task text looked sensitive, or Jev's Pi pick isn't
  actually available on this machine).
- `kind: "pi"` — run it through `plugin/scripts/jev/pi-run.mjs`'s
  `runPi({root, task, prompt, model})`. It runs headless Pi in an isolated
  git worktree on the requested model and hands back `{summary, diff,
  branch, model}`. From a shell: `node plugin/scripts/jev/pi-run.mjs --task
  "<slug>" --prompt "<full prompt>" [--model gpt-5.6-terra]` (defaults to
  `gpt-5.6-luna`; prompt can also be piped on stdin).
- `kind: "claude"` — spawn the sub-agent on `model` via the `Agent`/`Task`
  tool as usual.
- **Always validate the result** through `plugin/scripts/jev/validate.mjs`'s
  `judgeCompletion()` (the same check `plugin/hooks/jev-validate-subagent.mjs`
  runs on every `Agent`/`Task` sub-agent) before trusting it — this applies
  to a `pi-run.mjs` result too, not just Claude sub-agents.

## Escalating after a failed validation

If `judgeCompletion()` says the work isn't done, don't just retry on the
same model — climb one rung:

```js
import { nextRung } from "<plugin>/scripts/jev/ladder.mjs"; // or route.mjs, which re-exports it

const retryModel = nextRung(previousModel); // gpt-5.6-luna -> gpt-5.6-terra -> gpt-5.6-sol -> sonnet -> opus
```

`nextRung("opus")` returns `"opus"` — it's the ceiling. A retry that's
already failed at opus needs a human, not another automatic escalation.
`pi-run.mjs` is single-shot (see its own header comment and
`plugin/README.md`'s "Gap" note) — a caller implementing an escalation
loop drives `runPi()`/the `Agent` tool again itself with the next rung's
model; this skill doesn't run that loop for you.

## Guarantees

- **Fail-open to the cheap default, not to opus.** No credential
  configured, a timeout (~3s, `jev.timeoutMs`), a malformed reply, or
  `jev.enabled: false` — all resolve to `gpt-5.6-luna` if Pi is available,
  else `sonnet`. **Never opus** on a fail-open path; opus is reached only
  by a confident Jev escalation or a real validation-failure climb.
- **The default itself needs no confidence floor.** Jev confirming
  `pi-luna` is used at any confidence — it's already the safe choice.
  Escalating PAST it (to terra/sol/sonnet/opus) requires confidence >= 0.8
  (`ladder.ESCALATION_CONFIDENCE_FLOOR`); below that, stay on the default
  rather than trust a shaky "this needs more."
- **Pi unavailability degrades gracefully.** Whether the default (luna) or
  an escalation (terra/sol), if Jev's chosen rung is a Pi model and Pi
  isn't actually available (SDK not installed, quota exhausted),
  `chooseExecutor()` falls back straight to `sonnet` — never a
  no-longer-cheaper Pi rung, never a crash.
- **Redacted, minimal payload.** Only `task` (clipped to ~900 chars) and
  `context` (clipped to ~300 chars) are sent, both passed through
  `redact.mjs` first (masks emails, tokens, hex strings, phone-shaped
  numbers). Text that looks like it holds a secret or password is never
  sent at all — routing falls back to the default instead.
- **Logged.** Every decision (model, kind, confidence, source, a redacted
  task preview) is appended to `.maple/jev-decisions.jsonl` in the project
  root (gitignored). Run `node plugin/scripts/jev/report.mjs [root]` for a
  summary — decision counts, how often Jev's answer was actually used vs.
  fallback, average confidence, per kind.

## Config (`maple.config.json`)

See `plugin/README.md`'s Jev section for the full `jev.*` key set
(`enabled`, `credentialTarget`, `confidenceFloor`, `timeoutMs`,
`credentialCacheTtlSeconds`).

## Credential

Reads a TypeSafe API key from the OS credential store (Windows Credential
Manager) — see `plugin/skills/credential-manager`. Target name resolution
order: `jev.credentialTarget` (if set) → `Maple-TypeSafe-APIKey` →
`MapleLens-TypeSafe-APIKey`. No key configured is not an error — it's the
first (and most common) fail-open path above. Repeated calls within a
session are cached: see `plugin/scripts/jev/client.mjs`'s module docstring
for the DPAPI-encrypted, short-TTL cache that cuts the PowerShell round
trip most calls were paying.

## Attribution

The routing concept (ask a fast decision model, confidence-gate, fail open)
is adapted from kerpopule/hermes-jev-skills (MIT) — see `./NOTICE`. The
implementation here is a from-scratch Node port for maple-standard's own
ladder, not hermes-jev-skills' multi-vendor OpenRouter pool system.
