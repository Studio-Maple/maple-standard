// trivy-image: images are prepared in parallel (bounded, default 3), trivy scans never overlap, findings keep the
// configured image order. docker and trivy are fake bash scripts on PATH; no Docker, no network.
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { delimiter, join } from "node:path";
import { tmpdir } from "node:os";
import { trivyImage, IMAGE_CONCURRENCY_DEFAULT } from "./trivy-image.mjs";

let n = 0;
const t = async (name, fn) => { await fn(); n++; console.log("ok - " + name); };
const base = mkdtempSync(join(tmpdir(), "predeploy-trivy-"));
const bin = join(base, "bin");
mkdirSync(bin);
const LOG = join(base, "events.log");
const posix = (p) => p.replace(/\\/g, "/").replace(/^([A-Za-z]):/, (_, d) => `/${d.toLowerCase()}`);

// Fake docker: `pull <ref>` sleeps for the seconds in the ref's tag (fake/a:2 -> 2 s); a tag of `fail` fails the pull.
writeFileSync(join(bin, "docker"), `#!/bin/bash
now() { date +%s%3N; }
case "$1" in
  image) [ "$2" = inspect ] && exit 1; exit 0 ;;
  pull) ref="\${@: -1}"; tag="\${ref##*:}"; echo "pull-start $ref $(now)" >> "$FAKE_LOG"
        [ "$tag" = fail ] && { echo "pull access denied" >&2; exit 1; }
        sleep "$tag"; echo "pull-end $ref $(now)" >> "$FAKE_LOG"; exit 0 ;;
  save) echo tarball > "$3"; exit 0 ;;
esac
exit 0
`);
// Fake trivy: logs scan start/end, takes 0.3 s, writes a report with one CVE named after the image.
writeFileSync(join(bin, "trivy"), `#!/bin/bash
now() { date +%s%3N; }
while [ $# -gt 0 ]; do case "$1" in --input) in="$2"; shift ;; -o) out="$2"; shift ;; esac; shift; done
in="\${in//\\\\//}"; name=$(basename "$in" .tar); name=\${name#image-}
echo "scan-start $name $(now)" >> "$FAKE_LOG"; sleep 0.3
printf '{"Results":[{"Target":"%s (debian 12)","Vulnerabilities":[{"VulnerabilityID":"CVE-%s","PkgName":"libc","InstalledVersion":"1","Severity":"HIGH"}]}]}' "$in" "$name" > "$out"
echo "scan-end $name $(now)" >> "$FAKE_LOG"
`);
process.env.PATH = bin + delimiter + process.env.PATH;
process.env.FAKE_LOG = posix(LOG);

const fakeResolve = (name) => ({ name, mode: "native", version: "fake", bin: name });
const run = async (images, extra = {}) => {
  const outDir = join(base, "out-" + Math.random().toString(36).slice(2));
  mkdirSync(outDir);
  writeFileSync(LOG, "");
  const t0 = Date.now();
  const r = await trivyImage({ images, ...extra }, { resolveTool: fakeResolve, docker: true, outDir, scanRoot: base, sha: "b".repeat(40) });
  const events = readFileSync(LOG, "utf8").split(/\r?\n/).filter(Boolean).map((l) => { const [ev, who, at] = l.split(" "); return { ev, who, at: Number(at) }; });
  return { ...r, wall: Date.now() - t0, events, outDir };
};
const spans = (events, kind) => {
  const m = new Map();
  for (const e of events) if (e.ev.startsWith(kind)) m.set(e.who, { ...(m.get(e.who) || {}), [e.ev.endsWith("start") ? "s" : "e"]: e.at });
  return [...m.values()];
};
const anyOverlap = (xs) => xs.some((a, i) => xs.some((b, j) => i < j && a.s < b.e && b.s < a.e));
const IMGS = (tags) => tags.map((tag, i) => ({ name: "img" + "abcd"[i], ref: `fake/img${"abcd"[i]}:${tag}` }));

await t("default: images are prepared 3 at a time (pulls overlap), well under the serial time", async () => {
  assert.equal(IMAGE_CONCURRENCY_DEFAULT, 3);
  const r = await run(IMGS([2, 2, 2]));
  assert.deepEqual(r.findings.filter((f) => !f.imageFinding), [], JSON.stringify(r.findings));
  assert.ok(anyOverlap(spans(r.events, "pull")), "pulls overlap");
  assert.ok(r.wall < 5500, `wall ${r.wall}ms; serial pulls alone would take >= 6000ms`);
});

await t("trivy scans never overlap (single-writer cache), and findings keep the configured image order", async () => {
  const r = await run(IMGS([2, 0.2, 0.2]));
  assert.equal(anyOverlap(spans(r.events, "scan")), false, "scans overlapped");
  const scanOrder = r.events.filter((e) => e.ev === "scan-start").map((e) => e.who);
  assert.equal(scanOrder[scanOrder.length - 1], "imga", "the slow first image was scanned last");
  assert.deepEqual(r.findings.map((f) => f.image), ["imga", "imgb", "imgc"]);
  assert.deepEqual(r.findings.map((f) => f.id), ["CVE-imga", "CVE-imgb", "CVE-imgc"]);
  assert.ok(r.findings.every((f) => f.imageFinding && f.location === "image-" + f.image + ".tar (debian 12)"), JSON.stringify(r.findings[0]));
});

await t("options.concurrency bounds the prepare width (1 = serial pulls)", async () => {
  const r = await run(IMGS([0.5, 0.5, 0.5]), { concurrency: 1 });
  assert.equal(anyOverlap(spans(r.events, "pull")), false);
  const r2 = await run(IMGS([1, 1, 1, 1]), { concurrency: 2 });
  const p = spans(r2.events, "pull");
  const maxLive = Math.max(...p.map((a) => p.filter((b) => b.s <= a.s && a.s < b.e).length));
  assert.equal(maxLive, 2);
});

await t("an invalid options.concurrency is a misconfigured finding, not a silent default", async () => {
  for (const c of [0, 2.5, "3", 99]) {
    const r = await run(IMGS([0]), { concurrency: c });
    assert.equal(r.findings[0].id, "misconfigured", String(c));
  }
});

await t("one failing image does not disturb the others; tarballs are removed; per-image timing is noted", async () => {
  const r = await run(IMGS([0.2, "fail", 0.2]));
  assert.deepEqual(r.findings.map((f) => `${f.image}:${f.id}`), ["imga:CVE-imga", "imgb:image-pull-failed", "imgc:CVE-imgc"]);
  assert.ok(!existsSync(join(r.outDir, "image-imga.tar")) && !existsSync(join(r.outDir, "image-imgc.tar")));
  assert.match(r.notes[0], /3 image\(s\), 3 prepared at a time/);
  assert.match(r.notes[1], /^imga: prepare \d+s, scan \d+s/);
});

rmSync(base, { recursive: true, force: true });
console.log(`\n${n} trivy-image tests passed`);
