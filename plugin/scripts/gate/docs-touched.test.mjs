// check-docs-touched.mjs: the semantic docs-drift reminder moved from the Stop hook to the landing gate (warning only).
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { docsTouchedWarnings, normalizeAnchors, owns, run } from "../docs/check-docs-touched.mjs";

let n = 0;
const t = (name, fn) => { fn(); n++; console.log("ok - " + name); };

const index = {
  files: [
    { path: "docs/quality.md", title: "Quality", anchor_paths: ["scripts/ci-local.sh", "plugin/scripts/prepush/prepush-lib.sh", ".husky/{pre-commit,pre-push}"] },
    { path: "docs/docker.md", title: "Docker", anchor_paths: ["plugin/scripts/docker/dstack.ps1", "~/.claude/docker-stacks.json", "supabase/*"] },
    { path: "docs/loose.md", title: "Loose", anchor_paths: [] },
  ],
};

t("anchors: braces expand, globs/placeholders/absolute/home refs are dropped, file vs dir ownership", () => {
  assert.deepEqual(normalizeAnchors(".husky/{pre-commit,pre-push}"), [".husky/pre-commit", ".husky/pre-push"]);
  assert.deepEqual(normalizeAnchors("~/.claude/x.json"), []);
  assert.deepEqual(normalizeAnchors("src/<feature>/x.ts"), []);
  assert.equal(owns("scripts/ci-local.sh", "scripts/ci-local.sh"), true);
  assert.equal(owns("scripts/ci-local.sh", "scripts/ci-local.sh.bak"), false);
  assert.equal(owns("plugin/scripts/prepush", "plugin/scripts/prepush/prepush-lib.sh"), true);
  assert.equal(owns("plugin/scripts/prep", "plugin/scripts/prepush/x.sh"), false);
});

t("code changed under a doc's ownership with the doc untouched -> a doc warning, plus CHANGELOG", () => {
  const w = docsTouchedWarnings({ index, changed: ["scripts/ci-local.sh"] });
  assert.ok(w.some((l) => /\[\[quality\]\] owns scripts\/ci-local\.sh/.test(l)), w.join("\n"));
  assert.ok(w.some((l) => /CHANGELOG\.md was not updated/.test(l)));
  assert.ok(w.every((l) => /non-blocking/.test(l) || l.startsWith("  ")), "every warning says it is non-blocking");
});

t("the owning doc and CHANGELOG touched -> silence", () => {
  assert.deepEqual(docsTouchedWarnings({ index, changed: ["scripts/ci-local.sh", "docs/quality.md", "CHANGELOG.md"] }), []);
});

t("only docs / non-code changes -> silence (no code, nothing to reconcile)", () => {
  assert.deepEqual(docsTouchedWarnings({ index, changed: ["docs/quality.md", "README.md", "docs/decisions.md"] }), []);
});

t("code outside every doc's ownership still asks for a CHANGELOG entry, but names no doc", () => {
  const w = docsTouchedWarnings({ index, changed: ["src/app/page.tsx"] });
  assert.equal(w.length, 1);
  assert.match(w[0], /CHANGELOG\.md was not updated/);
});

t("CLI over a real repo: base..working tree, exit 0 always, silent without an index", () => {
  const repo = mkdtempSync(join(tmpdir(), "docs-touched-"));
  const g = (...a) => { const r = spawnSync("git", a, { cwd: repo, encoding: "utf8" }); assert.equal(r.status, 0, r.stderr); return r.stdout.trim(); };
  g("init", "-q"); g("config", "user.email", "t@t"); g("config", "user.name", "t"); g("config", "commit.gpgsign", "false");
  mkdirSync(join(repo, "docs")); mkdirSync(join(repo, "scripts"));
  writeFileSync(join(repo, "scripts", "ci-local.sh"), "echo 1\n");
  writeFileSync(join(repo, "docs", "quality.md"), "q\n");
  g("add", "-A"); g("commit", "-q", "-m", "base");
  const base = g("rev-parse", "HEAD");
  writeFileSync(join(repo, "scripts", "ci-local.sh"), "echo 2\n");
  g("add", "-A"); g("commit", "-q", "-m", "change");
  assert.deepEqual(run({ root: repo, base }), [], "no docs index yet -> silent");
  writeFileSync(join(repo, "docs", ".docs-index.json"), JSON.stringify(index));
  const w = run({ root: repo, base });
  assert.ok(w.some((l) => /\[\[quality\]\]/.test(l)), w.join("\n"));
  const cli = spawnSync(process.execPath, [join(dirname(fileURLToPath(import.meta.url)), "..", "docs", "check-docs-touched.mjs"), "--base", base, "--root", repo], { encoding: "utf8" });
  assert.equal(cli.status, 0);
  assert.match(cli.stdout, /DOCS-SYNC \(warning, non-blocking\)/);
});

console.log(`\nall ${n} docs-touched tests passed`);
