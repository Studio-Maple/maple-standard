#!/usr/bin/env node
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { chooseExecutor } from "./route.mjs";
import { DEFAULT_PI_MODEL, DEFAULT_FALLBACK_MODEL } from "./ladder.mjs";
import { readDecisions } from "./log.mjs";

let failed = 0;
const check = (name, ok, detail = "") => {
  console.log(`  ${ok ? "PASS" : "FAIL"}  ${name}${detail ? ` — ${detail}` : ""}`);
  if (!ok) failed++;
};

function sandboxRoot() {
  return mkdtempSync(join(tmpdir(), "jev-route-"));
}

const fakeAnswer = (choice, confidence) => async () => ({ model: "jev-latest", answers: { rung: { type: "choice", choice, confidence } } });

async function run() {
  // 1. Jev unavailable, Pi up -> defaults to pi+luna (the whole point of the inverted-burden design).
  {
    const root = sandboxRoot();
    try {
      const out = await chooseExecutor({ root, task: "do something" }, { safeEvaluate: async () => null, piAvailable: async () => true });
      check("defaults to pi+luna when jev is unavailable and Pi is up", out.model === DEFAULT_PI_MODEL && out.kind === "pi" && out.source === "fallback", JSON.stringify(out));
      const logged = readDecisions(root);
      check("logs the decision", logged.length === 1 && logged[0].kind === "route");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  }

  // 2. Jev unavailable, Pi down -> sonnet, never opus.
  {
    const root = sandboxRoot();
    try {
      const out = await chooseExecutor({ root, task: "do something" }, { safeEvaluate: async () => null, piAvailable: async () => false });
      check("falls back to sonnet (not opus) when both jev and Pi are unavailable", out.model === DEFAULT_FALLBACK_MODEL && out.kind === "claude", JSON.stringify(out));
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  }

  // 3. Jev confidently confirms pi-luna -> used (no confidence floor needed for the default itself).
  {
    const root = sandboxRoot();
    try {
      const out = await chooseExecutor({ root, task: "rename a variable" }, { safeEvaluate: fakeAnswer("pi-luna", 0.55), piAvailable: async () => true });
      check("uses pi-luna even at modest confidence — it's the default, not an escalation", out.model === "gpt-5.6-luna" && out.source === "jev", JSON.stringify(out));
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  }

  // 4. Jev picks pi-terra with LOW confidence (< 0.8) -> stays on the default rung.
  {
    const root = sandboxRoot();
    try {
      const out = await chooseExecutor({ root, task: "medium task" }, { safeEvaluate: fakeAnswer("pi-terra", 0.6), piAvailable: async () => true });
      check("does not escalate past the default below the 0.8 floor", out.model === DEFAULT_PI_MODEL && out.source === "fallback", JSON.stringify(out));
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  }

  // 5. Jev picks pi-terra with HIGH confidence (>= 0.8) -> escalates.
  {
    const root = sandboxRoot();
    try {
      const out = await chooseExecutor({ root, task: "medium task" }, { safeEvaluate: fakeAnswer("pi-terra", 0.85), piAvailable: async () => true });
      check("escalates to pi-terra at/above the 0.8 floor", out.model === "gpt-5.6-terra" && out.kind === "pi" && out.source === "jev", JSON.stringify(out));
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  }

  // 6. Jev picks opus with high confidence -> used as-is.
  {
    const root = sandboxRoot();
    try {
      const out = await chooseExecutor(
        { root, task: "production data migration with security implications" },
        { safeEvaluate: fakeAnswer("opus", 0.97), piAvailable: async () => true },
      );
      check("escalates all the way to opus when jev is confident and the task warrants it", out.model === "opus" && out.kind === "claude" && out.source === "jev", JSON.stringify(out));
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  }

  // 7. Jev picks a Pi rung confidently, but Pi is unavailable -> falls back to sonnet, not another Pi rung.
  {
    const root = sandboxRoot();
    try {
      const out = await chooseExecutor(
        { root, task: "medium task" },
        { safeEvaluate: fakeAnswer("pi-terra", 0.9), piAvailable: async () => false },
      );
      check("falls back to sonnet when the chosen Pi rung is unavailable", out.model === "sonnet" && out.source === "fallback", JSON.stringify(out));
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  }

  // 8. jev disabled via config -> never calls safeEvaluate at all.
  {
    const root = sandboxRoot();
    try {
      writeFileSync(join(root, "maple.config.json"), JSON.stringify({ project: { name: "x", slug: "x" }, jev: { enabled: false } }));
      let called = false;
      const out = await chooseExecutor(
        { root, task: "do something" },
        { safeEvaluate: async () => { called = true; return null; }, piAvailable: async () => true },
      );
      check("skips the network call entirely when jev.enabled=false", !called && out.model === DEFAULT_PI_MODEL && out.source === "fallback");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  }

  // 9. sensitive-looking task text is never sent.
  {
    const root = sandboxRoot();
    try {
      let called = false;
      const out = await chooseExecutor(
        { root, task: "rotate this secret: password: hunter2" },
        { safeEvaluate: async () => { called = true; return null; }, piAvailable: async () => true },
      );
      check("never sends task text that looks sensitive", !called && out.source === "fallback", JSON.stringify(out));
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  }

  // 10. an unrecognized/hallucinated choice label falls back rather than being trusted.
  {
    const root = sandboxRoot();
    try {
      const out = await chooseExecutor({ root, task: "do something" }, { safeEvaluate: fakeAnswer("gpt-9000", 0.99), piAvailable: async () => true });
      check("ignores a choice label outside RUNG_CHOICES", out.model === DEFAULT_PI_MODEL && out.source === "fallback", JSON.stringify(out));
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  }
}

run().then(() => {
  if (failed > 0) {
    console.error(`${failed} check(s) FAILED`);
    process.exit(1);
  }
  console.log("All route.mjs checks passed.");
});
