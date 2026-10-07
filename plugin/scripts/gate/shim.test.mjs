// One runner (D066): ci-local.ps1 is a shim that finds Git Bash - never WSL's System32\bash.exe - and run-gate.mjs / find-bash.mjs
// share that rule. The real-PowerShell case only runs on Windows.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { candidates, findBash } from "./find-bash.mjs";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
let n = 0;
const t = (name, fn) => { fn(); n++; console.log("ok - " + name); };

t("findBash: not Windows -> plain bash", () => {
  assert.equal(findBash("linux", () => false), "bash");
});

t("findBash: Windows looks next to `git --exec-path` (<Git>\\mingw64\\libexec\\git-core -> <Git>\\bin\\bash.exe)", () => {
  const exec = "C:/Program Files/Git/mingw64/libexec/git-core";
  const want = candidates(exec)[0];
  const got = findBash("win32", (p) => p === want, () => exec);
  assert.equal(got, want);
  assert.match(got.replace(/\\/g, "/"), /Program Files\/Git\/bin\/bash\.exe$/);
});

t("findBash: falls back to the default install dirs, never System32 (WSL)", () => {
  const got = findBash("win32", (p) => /Program Files\\Git\\bin\\bash\.exe$/.test(p) || /system32/i.test(p), () => "");
  assert.match(got, /Program Files\\Git\\bin\\bash\.exe$/);
  assert.ok(!/system32/i.test(got));
});

t("findBash: no Git Bash -> a clear error, not a silent WSL fallback", () => {
  assert.throws(() => findBash("win32", () => false, () => ""), /Git Bash not found.*WSL bash is deliberately not used/);
});

t("every candidate list excludes System32", () => {
  assert.ok(candidates("C:/x/mingw64/libexec/git-core").every((c) => !/system32/i.test(c)));
});

if (process.platform === "win32") {
  t("ci-local.ps1 (real PowerShell) resolves Git's bash, not the WSL bash that `bash` on PATH may be", () => {
    const ps1 = join(ROOT, "scripts", "ci-local.ps1");
    assert.ok(existsSync(ps1));
    const r = spawnSync("powershell.exe", ["-NoProfile", "-ExecutionPolicy", "Bypass", "-File", ps1, "fast"], {
      encoding: "utf8",
      env: { ...process.env, MAPLE_CI_SHIM_PRINT_BASH: "1" },
    });
    assert.equal(r.status, 0, r.stderr);
    const bash = r.stdout.trim();
    assert.match(bash, /Git\\bin\\bash\.exe$/i);
    assert.ok(!/system32/i.test(bash), "must never be WSL's bash: " + bash);
    assert.ok(existsSync(bash));
  });

} else {
  console.log("(skipped - the real-PowerShell shim cases only run on Windows)");
}

console.log(`\nall ${n} shim tests passed`);
