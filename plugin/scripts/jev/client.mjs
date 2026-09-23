#!/usr/bin/env node
/**
 * Jev (TypeSafe System One) client — direct API, not a gateway.
 *
 * Ported from C:\Projects\MapleLens\tools\jev\client.mjs (same product, same
 * endpoint/model pin, same question/answer shapes) — this copy generalizes
 * credential-target resolution so any maple-standard project can point at
 * its own stored key, per plugin/README.md's Jev section.
 *
 * Jev answers typed questions about a state and returns calibrated
 * probabilities instead of prose. The value for a router/validator is
 * `confidence`: a low-confidence answer means "this is genuinely ambiguous",
 * which an LLM asked for a probability cannot give you as reliably.
 *
 * The API key is read from the OS credential store in-process (Windows
 * Credential Manager via PowerShell, per plugin/skills/credential-manager).
 * It never goes through an environment variable: callers here run inside
 * hooks/skills that spawn further processes, and a child inherits its
 * parent's environment.
 */

import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { resolveJevConfig } from "./config.mjs";

const execFileAsync = promisify(execFile);

const ENDPOINT = "https://api.typesafe.ai/v1/systemone";
const MODEL = "jev-latest";

/** Below this confidence on a choice or score, treat the answer as "don't know". */
export const DEFAULT_CONFIDENCE_FLOOR = 0.5;

/**
 * Retried with backoff. 429 and 529 are the documented ones; 502/503/504 are
 * what a gateway in front of the model answers during a blip.
 */
const RETRYABLE = new Set([429, 502, 503, 504, 529]);
const MAX_ATTEMPTS = 3; // one fewer than MapleLens's worker use — these callers run inline in a hook/skill and must stay fast, not exhaustively retry.

const keyCache = new Map(); // root -> key, so repeated calls in one process don't re-shell out

/**
 * Candidate credential target names, in resolution order:
 * project's own maple.config.json `jev.credentialTarget`, then the two
 * documented plugin-wide fallbacks.
 * @param {string} root
 */
export function candidateTargets(root) {
  const { credentialTarget } = resolveJevConfig(root);
  const targets = [];
  if (credentialTarget) targets.push(credentialTarget);
  targets.push("Maple-TypeSafe-APIKey", "MapleLens-TypeSafe-APIKey");
  return [...new Set(targets)];
}

/**
 * Read the key from Windows Credential Manager, trying each candidate
 * target in order and caching the first that resolves. Only the target
 * NAME is passed as an argument; the value returns on stdout, captured
 * in-process and never logged.
 * @param {string} root
 */
async function readKey(root) {
  if (keyCache.has(root)) return keyCache.get(root);
  if (process.platform !== "win32") {
    throw new Error(`Jev: credential store read not implemented for ${process.platform}`);
  }

  let lastErr;
  for (const target of candidateTargets(root)) {
    if (!/^[A-Za-z0-9._-]+$/.test(target)) continue;
    const script = [
      "$ErrorActionPreference='Stop'",
      `$c = Get-StoredCredential -Target '${target}'`,
      "if (-not $c) { exit 3 }",
      "[Console]::OutputEncoding=[System.Text.Encoding]::UTF8",
      "[Console]::Out.Write($c.GetNetworkCredential().Password)",
    ].join("; ");

    try {
      const { stdout } = await execFileAsync(
        "powershell.exe",
        ["-NoProfile", "-NonInteractive", "-Command", script],
        { encoding: "utf8", windowsHide: true, timeout: 10_000 },
      );
      const key = stdout.replace(/^\uFEFF/, "").trim();
      if (key) {
        keyCache.set(root, key);
        return key;
      }
      lastErr = new Error(`Jev credential '${target}': empty value`);
    } catch (err) {
      // Never surface err.stdout — a partial read can hold key material.
      lastErr = new Error(`Jev credential '${target}': ${err.code === 3 ? "not found" : "read failed"}`);
    }
  }
  throw lastErr ?? new Error("Jev: no credential target configured");
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * Evaluate `state` against typed `questions`.
 *
 * Untrusted content belongs in `state`, never in `questions`: Jev returns
 * types drawn from the question definitions, so text in the state cannot
 * rewrite the answer schema. That property is the whole reason to route
 * with it rather than with a prompt.
 *
 * @param {string} root project root — resolves which credential to read
 * @param {string|object|Array} state
 * @param {Record<string, {type:'noul'|'choice'|'score', instructions:string, criteria?:object|Array}>} questions
 * @param {{ timeoutMs?: number, signal?: AbortSignal }} [options]
 */
export async function evaluate(root, state, questions, options = {}) {
  const apiKey = await readKey(root);
  const timeoutMs = options.timeoutMs ?? resolveJevConfig(root).timeoutMs;

  let lastError;
  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    const timer = AbortSignal.timeout(timeoutMs);
    const signal = options.signal ? AbortSignal.any([options.signal, timer]) : timer;

    let res;
    try {
      res = await fetch(ENDPOINT, {
        method: "POST",
        headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" },
        body: JSON.stringify({ model: MODEL, state, questions }),
        signal,
      });
    } catch (err) {
      if (options.signal?.aborted) throw err;
      lastError = err;
      if (attempt === MAX_ATTEMPTS) throw err;
      await sleep(2 ** attempt * 200);
      continue;
    }

    if (RETRYABLE.has(res.status) && attempt < MAX_ATTEMPTS) {
      const retryAfter = Number(res.headers.get("retry-after"));
      await sleep(Number.isFinite(retryAfter) && retryAfter > 0 ? retryAfter * 1000 : 2 ** attempt * 200);
      continue;
    }

    const body = RETRYABLE.has(res.status) ? null : await res.json().catch(() => null);
    if (!res.ok) {
      const detail = body?.message ?? body?.error?.message ?? `HTTP ${res.status}`;
      throw new Error(`Jev: ${detail}`);
    }
    return { model: body.model, answers: body.answers, usage: body.usage };
  }
  throw lastError ?? new Error("Jev: exhausted retries");
}

/**
 * evaluate() wrapped fail-open: any error (no key, timeout, malformed
 * reply, network) resolves to `null` instead of throwing. This is the
 * entry point every skill/hook in this plugin should call — Jev must never
 * be the reason a routing decision or a validation stalls a turn.
 *
 * @returns {Promise<{model:string, answers:object, usage?:object}|null>}
 */
export async function safeEvaluate(root, state, questions, options = {}) {
  try {
    return await evaluate(root, state, questions, options);
  } catch {
    return null;
  }
}

/**
 * Read a CHOICE answer, returning null when Jev is too unsure to act on the
 * label. Callers treat null as "escalate" / "fall back to the default".
 */
export function decide(answer, floor = DEFAULT_CONFIDENCE_FLOOR) {
  if (answer?.type !== "choice") {
    throw new Error(`decide() expects a choice answer, got ${answer?.type} — use scoreOf() for scores`);
  }
  return answer.confidence >= floor ? answer.choice : null;
}

/** Read a SCORE answer. Deliberately not confidence-gated — see MapleLens client.mjs for rationale. */
export function scoreOf(answer) {
  if (answer?.type !== "score") {
    throw new Error(`scoreOf() expects a score answer, got ${answer?.type}`);
  }
  return { score: answer.score, confidence: answer.confidence, legend: answer.legend, probabilities: answer.probabilities };
}

/** A noul is already a probability; there is no separate confidence to gate on. */
export function likely(answer, threshold = 0.5) {
  if (answer?.type !== "noul") throw new Error(`likely() expects a noul answer, got ${answer?.type}`);
  return answer.noul >= threshold;
}

/** Test-only: clear the cached key so a test can simulate a fresh process. */
export function _resetKeyCacheForTests() {
  keyCache.clear();
}
