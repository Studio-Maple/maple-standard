#!/usr/bin/env node
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { chooseExecutor, EXECUTORS, DEFAULT_EXECUTOR } from "./route.mjs";
import { readDecisions } from "./log.mjs";

let failed = 0;
const check = (name, ok, detail = "") => {
  console.log(`  ${ok ? "PASS" : "FAIL"}  ${name}${detail ? ` — ${detail}` : ""}`);
  if (!ok) failed++;
};

function sandboxRoot() {
  return mkdtempSync(join(tmpdir(), "jev-route-"));
}

const fakeAnswer = (choice, confidence) => async () => ({ model: "jev-latest", answers: { executor: { type: "choice", choice, confidence } } });

async function run() {
  check("EXECUTORS lists the four planned executors", JSON.stringify(EXECUTORS) === JSON.stringify(["haiku", "sonnet", "opus", "pi"]));

  // 1. jev confidently picks haiku -> used as-is
  {
    const root = sandboxRoot();
    try {
      const out = await chooseExecutor({ root, task: "rename a variable" }, { safeEvaluate: fakeAnswer("haiku", 0.95) });
      check("uses jev's confident choice", out.executor === "haiku" && out.source === "jev", JSON.stringify(out));
      const logged = readDecisions(root);
      check("logs the decision", logged.length === 1 && logged[0].kind === "route");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  }

  // 2. jev unavailable -> falls back to sonnet
  {
    const root = sandboxRoot();
    try {
      const out = await chooseExecutor({ root, task: "do something" }, { safeEvaluate: async () => null });
      check("falls back to the default executor when jev is unavailable", out.executor === DEFAULT_EXECUTOR && out.source === "fallback", JSON.stringify(out));
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  }

  // 3. low confidence -> falls back
  {
    const root = sandboxRoot();
    try {
      const out = await chooseExecutor({ root, task: "do something" }, { safeEvaluate: fakeAnswer("opus", 0.1) });
      check("falls back on a low-confidence answer", out.executor === DEFAULT_EXECUTOR && out.source === "fallback", JSON.stringify(out));
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  }

  // 4. jev picks pi, but pi is unavailable -> falls back to sonnet, not to a crash
  {
    const root = sandboxRoot();
    try {
      const out = await chooseExecutor(
        { root, task: "self-contained refactor" },
        { safeEvaluate: fakeAnswer("pi", 0.9), piAvailable: async () => false },
      );
      check("falls back to sonnet when jev picks pi but pi is unavailable", out.executor === "sonnet" && out.source === "fallback", JSON.stringify(out));
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  }

  // 5. jev picks pi and pi IS available -> used
  {
    const root = sandboxRoot();
    try {
      const out = await chooseExecutor(
        { root, task: "self-contained refactor" },
        { safeEvaluate: fakeAnswer("pi", 0.9), piAvailable: async () => true },
      );
      check("uses pi when jev picks it and it's available", out.executor === "pi" && out.source === "jev", JSON.stringify(out));
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  }

  // 6. jev disabled via config -> never calls safeEvaluate at all
  {
    const root = sandboxRoot();
    try {
      writeFileSync(join(root, "maple.config.json"), JSON.stringify({ project: { name: "x", slug: "x" }, jev: { enabled: false } }));
      let called = false;
      const out = await chooseExecutor({ root, task: "do something" }, { safeEvaluate: async () => { called = true; return null; } });
      check("skips the network call entirely when jev.enabled=false", !called && out.source === "fallback");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  }

  // 7. sensitive-looking task text is never sent
  {
    const root = sandboxRoot();
    try {
      let called = false;
      const out = await chooseExecutor(
        { root, task: "rotate this secret: password: hunter2" },
        { safeEvaluate: async () => { called = true; return null; } },
      );
      check("never sends task text that looks sensitive", !called && out.source === "fallback", JSON.stringify(out));
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
