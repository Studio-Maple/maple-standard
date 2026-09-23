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
 *
 * CROSS-PROCESS CACHE (owner decision — cut the ~1.5s Get-StoredCredential
 * PowerShell round trip most calls were paying): each hook/skill invocation
 * is a FRESH Node process, so the in-process `keyCache` Map below never
 * helps across calls — only within one process's lifetime (multiple
 * evaluate() calls from the same script run). To amortize across
 * processes within one Claude Code session, readKey() also maintains a
 * small per-user cache file under `%LOCALAPPDATA%\maple-standard\jev\`
 * (falls back to the OS temp dir if LOCALAPPDATA is unset), short-TTL
 * (`jev.credentialCacheTtlSeconds`, default 300s; 0 disables it).
 *
 * The cache file is NEVER the plaintext key. It holds ciphertext produced
 * by PowerShell's built-in `ConvertFrom-SecureString` — Windows DPAPI,
 * bound to the current user AND machine, the same primitive Credential
 * Manager itself is built on. A copy of the file is useless to anyone who
 * isn't this Windows user on this machine (a stolen-disk / offline-copy
 * scenario gets nothing from it, same guarantee Credential Manager gives).
 * Best-effort `icacls` also restricts the file to the current user as
 * defense in depth. The win comes from `ConvertTo-SecureString` (built-in,
 * no module import) being materially cheaper to shell out to than
 * `Get-StoredCredential` (the CredentialManager binary module's import),
 * not from skipping PowerShell entirely — decrypting DPAPI ciphertext from
 * plain Node without a native addon isn't possible, and this repo takes on
 * no new dependencies (see plugin/README.md). If that tradeoff ever stops
 * being worth it, set `jev.credentialCacheTtlSeconds: 0` — every call goes
 * straight back to Get-StoredCredential, unchanged from v0.3.0.
 */

import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
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

// ---- cross-process DPAPI credential cache (see module docstring) ---------

function cacheDir() {
  const base = process.env.LOCALAPPDATA || tmpdir();
  return join(base, "maple-standard", "jev");
}

/** @param {string} target @returns {string} deterministic, non-reversible path — never embeds the target name in plaintext on disk. */
export function cacheFilePathFor(target) {
  const hash = createHash("sha256").update(target).digest("hex").slice(0, 32);
  return join(cacheDir(), `${hash}.cache`);
}

/**
 * Parse the cache file's own format: line 1 = expiry (epoch ms), line 2+ =
 * the DPAPI ciphertext blob (PowerShell's ConvertFrom-SecureString output —
 * never the plaintext key). Pure, so it's unit-testable without touching disk.
 * @param {string} raw @returns {{expiresAt:number, blob:string}|null}
 */
export function parseCacheFile(raw) {
  if (typeof raw !== "string") return null;
  const nl = raw.indexOf("\n");
  if (nl === -1) return null;
  const expiresAt = Number(raw.slice(0, nl).trim());
  const blob = raw.slice(nl + 1).trim();
  if (!Number.isFinite(expiresAt) || !blob) return null;
  return { expiresAt, blob };
}

/** @param {number} expiresAt epoch ms @param {number} [now] injectable for tests */
export function isCacheFresh(expiresAt, now = Date.now()) {
  return Number.isFinite(expiresAt) && now < expiresAt;
}

function stripBom(s) {
  return s.charCodeAt(0) === 0xfeff ? s.slice(1) : s;
}

/**
 * Cheap path: decrypt an on-disk DPAPI blob. No CredentialManager module
 * import. Returns null on any failure (missing/corrupt file, expired,
 * decrypted on a different user/machine, etc.) — the caller falls through
 * to the full Get-StoredCredential fetch, which also refreshes the cache.
 */
async function readCachedKey(target, ttlSeconds) {
  if (!ttlSeconds || ttlSeconds <= 0) return null;
  const file = cacheFilePathFor(target);
  let raw;
  try {
    raw = readFileSync(file, "utf8");
  } catch {
    return null;
  }
  const parsed = parseCacheFile(raw);
  if (!parsed || !isCacheFresh(parsed.expiresAt)) return null;

  // NOTE: the try/finally block below is ONE array element, joined with the
  // rest via "; " — PowerShell's parser rejects a `;` immediately before
  // `finally` ("The Try statement is missing its Catch or Finally block"),
  // so `try { ... } finally { ... }` must stay together, unseparated, on
  // one line. This cost a real debugging session (live-tested, D058 —
  // see plugin/README.md's Jev section) before it was caught: it silently
  // broke every cache HIT, so every call fell through to the slow fetch
  // and re-wrote the cache, making "warm" calls consistently SLOWER than
  // cold ones (paying for a failed decrypt attempt, then the full fetch).
  const decryptScript = [
    "$ErrorActionPreference='Stop'",
    `$secure = ConvertTo-SecureString '${parsed.blob}'`,
    "$ptr = [Runtime.InteropServices.Marshal]::SecureStringToBSTR($secure)",
    "try { [Console]::OutputEncoding=[System.Text.Encoding]::UTF8; [Console]::Out.Write([Runtime.InteropServices.Marshal]::PtrToStringBSTR($ptr)) } finally { [Runtime.InteropServices.Marshal]::ZeroFreeBSTR($ptr) }",
  ].join("; ");

  try {
    const { stdout } = await execFileAsync(
      "powershell.exe",
      ["-NoProfile", "-NonInteractive", "-Command", decryptScript],
      { encoding: "utf8", windowsHide: true, timeout: 10_000 },
    );
    const key = stripBom(stdout).trim();
    return key || null;
  } catch {
    return null; // corrupt/cross-user blob — full fetch below will refresh it
  }
}

/**
 * Slow path: Get-StoredCredential (imports the CredentialManager module),
 * and — when caching is enabled — refresh the DPAPI cache file in the SAME
 * PowerShell invocation (one process spawn either way, not two).
 */
async function fetchAndCacheKey(target, ttlSeconds) {
  const cacheEnabled = ttlSeconds > 0;
  const file = cacheEnabled ? cacheFilePathFor(target) : null;
  const expiresAt = cacheEnabled ? Date.now() + ttlSeconds * 1000 : 0;

  const lines = [
    "$ErrorActionPreference='Stop'",
    `$c = Get-StoredCredential -Target '${target}'`,
    "if (-not $c) { exit 3 }",
    "$key = $c.GetNetworkCredential().Password",
  ];
  if (cacheEnabled) {
    lines.push(
      "$secure = ConvertTo-SecureString $key -AsPlainText -Force",
      "$enc = ConvertFrom-SecureString $secure",
      `$cacheFile = '${file.replace(/'/g, "''")}'`,
      "New-Item -ItemType Directory -Force -Path (Split-Path $cacheFile) | Out-Null",
      `Set-Content -LiteralPath $cacheFile -Value @('${expiresAt}', $enc) -Encoding ascii`,
      'try { icacls $cacheFile /inheritance:r /grant:r "$($env:USERNAME):(R,W)" 2>$null | Out-Null } catch {}',
    );
  }
  lines.push("[Console]::OutputEncoding=[System.Text.Encoding]::UTF8", "[Console]::Out.Write($key)");
  const script = lines.join("; ");

  const { stdout } = await execFileAsync(
    "powershell.exe",
    ["-NoProfile", "-NonInteractive", "-Command", script],
    { encoding: "utf8", windowsHide: true, timeout: 10_000 },
  );
  return stripBom(stdout).trim();
}

/**
 * Read the key from Windows Credential Manager (via the DPAPI cache when
 * fresh, else Credential Manager directly), trying each candidate target
 * in order and caching the first that resolves. Only the target NAME ever
 * appears in a script string; the plaintext value returns on stdout,
 * captured in-process and never logged, never written to disk.
 * @param {string} root
 */
async function readKey(root) {
  if (keyCache.has(root)) return keyCache.get(root);
  if (process.platform !== "win32") {
    throw new Error(`Jev: credential store read not implemented for ${process.platform}`);
  }
  const { credentialCacheTtlSeconds } = resolveJevConfig(root);

  let lastErr;
  for (const target of candidateTargets(root)) {
    if (!/^[A-Za-z0-9._-]+$/.test(target)) continue;

    try {
      const cached = await readCachedKey(target, credentialCacheTtlSeconds);
      if (cached) {
        keyCache.set(root, cached);
        return cached;
      }

      const key = await fetchAndCacheKey(target, credentialCacheTtlSeconds);
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
