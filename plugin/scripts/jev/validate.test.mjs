#!/usr/bin/env node
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { judgeCompletion } from "./validate.mjs";

let failed = 0;
const check = (name, ok, detail = "") => {
  console.log(`  ${ok ? "PASS" : "FAIL"}  ${name}${detail ? ` — ${detail}` : ""}`);
  if (!ok) failed++;
};

function sandboxRoot() {
  return mkdtempSync(join(tmpdir(), "jev-validate-"));
}

const fakeAnswer = (choice, confidence) => async () => ({ answers: { done: { type: "choice", choice, confidence } } });

async function run() {
  // confident "not_done" -> blocks with a reason
  {
    const root = sandboxRoot();
    try {
      const out = await judgeCompletion(
        { root, task: "add a login form", report: "I looked at the code but didn't change anything." },
        { safeEvaluate: fakeAnswer("not_done", 0.85) },
      );
      check("blocks on a confident not_done verdict", out.block === true && out.reason.length > 0, JSON.stringify(out));
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  }

  // confident "done" -> allows
  {
    const root = sandboxRoot();
    try {
      const out = await judgeCompletion(
        { root, task: "add a login form", report: "Added src/LoginForm.tsx, wired it into the router, tests pass." },
        { safeEvaluate: fakeAnswer("done", 0.9) },
      );
      check("allows on a confident done verdict", out.block === false, JSON.stringify(out));
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  }

  // low confidence either way -> allow (fail toward not blocking)
  {
    const root = sandboxRoot();
    try {
      const out = await judgeCompletion(
        { root, task: "add a login form", report: "done" },
        { safeEvaluate: fakeAnswer("not_done", 0.2) },
      );
      check("does not block on a low-confidence verdict", out.block === false, JSON.stringify(out));
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  }

  // jev unavailable -> fail open
  {
    const root = sandboxRoot();
    try {
      const out = await judgeCompletion(
        { root, task: "add a login form", report: "done" },
        { safeEvaluate: async () => null },
      );
      check("fails open when jev is unavailable", out.block === false && out.source === "fallback", JSON.stringify(out));
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  }

  // empty report -> allow without even asking
  {
    const root = sandboxRoot();
    try {
      let called = false;
      const out = await judgeCompletion({ root, task: "add a login form", report: "" }, { safeEvaluate: async () => { called = true; return null; } });
      check("skips the call entirely for an empty report", !called && out.block === false);
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
  console.log("All validate.mjs checks passed.");
});
