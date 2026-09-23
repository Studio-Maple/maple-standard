#!/usr/bin/env node
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pickSkill } from "./skill-select.mjs";

let failed = 0;
const check = (name, ok, detail = "") => {
  console.log(`  ${ok ? "PASS" : "FAIL"}  ${name}${detail ? ` — ${detail}` : ""}`);
  if (!ok) failed++;
};

function sandboxRoot() {
  return mkdtempSync(join(tmpdir(), "jev-skillselect-"));
}

const skills = [
  { name: "xlsx", description: "Work with spreadsheet files." },
  { name: "pdf", description: "Work with PDF files." },
];

async function run() {
  {
    const root = sandboxRoot();
    try {
      const out = await pickSkill(
        { root, request: "clean up this messy xlsx file", skills },
        { safeEvaluate: async () => ({ answers: { skill: { type: "choice", choice: "xlsx", confidence: 0.92 } } }) },
      );
      check("returns the confidently matched skill", out.skill === "xlsx" && out.source === "jev", JSON.stringify(out));
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  }

  {
    const root = sandboxRoot();
    try {
      const out = await pickSkill(
        { root, request: "what's the weather like", skills },
        { safeEvaluate: async () => ({ answers: { skill: { type: "choice", choice: "none", confidence: 0.95 } } }) },
      );
      check("returns null when jev says none apply", out.skill === null, JSON.stringify(out));
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  }

  {
    const root = sandboxRoot();
    try {
      const out = await pickSkill({ root, request: "do a thing", skills }, { safeEvaluate: async () => null });
      check("fails open (no skill) when jev is unavailable", out.skill === null && out.source === "fallback", JSON.stringify(out));
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  }

  {
    const root = sandboxRoot();
    try {
      const out = await pickSkill({ root, request: "do a thing", skills: [] }, { safeEvaluate: async () => ({}) });
      check("returns null with an empty catalog without calling jev meaningfully", out.skill === null);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  }

  // A hallucinated / unrecognized choice must never be trusted.
  {
    const root = sandboxRoot();
    try {
      const out = await pickSkill(
        { root, request: "do a thing", skills },
        { safeEvaluate: async () => ({ answers: { skill: { type: "choice", choice: "made-up-skill", confidence: 0.99 } } }) },
      );
      check("ignores a choice outside the given catalog", out.skill === null, JSON.stringify(out));
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
  console.log("All skill-select.mjs checks passed.");
});
