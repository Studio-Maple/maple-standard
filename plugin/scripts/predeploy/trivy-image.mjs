/**
 * trivy-image.mjs — the `trivy-image` preset: Trivy-scan (vuln + secret) each declared image, built from the candidate
 * tree ({name, context}) or a third-party image pulled by its exact deployed ref ({name, ref}).
 *
 * Images are prepared (pull or build, then `docker save`) `options.concurrency` at a time (default 3). The trivy scan
 * itself runs one image at a time behind an in-process mutex: trivy's cache is a single-writer bolt DB, so parallel
 * scans on one cache would only collide and fall into the lock-retry loop. Prepare work (the slow part: pulls from a
 * registry, builds) overlaps with other images' scans. Findings are returned in the configured image order, whatever
 * order the images finish in. Each image's tarball is removed right after its scan (peak disk stays ~N tarballs).
 *
 * Test seam: ctx.resolveTool(name, opts) replaces tools.mjs resolveTool.
 */
import { existsSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { resolveTool, dockerRunCmd, shq } from "./tools.mjs";
import { parseOutput } from "./parsers.mjs";
import { getCredential } from "./credentials.mjs";
import { runShellAsync } from "./lib.mjs";
import { mutex, pool, sleep } from "./proc.mjs";
import { imageFindingLocation } from "./imagedebt.mjs";

export const IMAGE_CONCURRENCY_DEFAULT = 3;
const F = (id, message, location = "", severity = "high") => ({ id, severity, message, location });
const IMAGE_INFRA_ID = /^(no-report|unparseable-report)$/;
const capture = (command, opts = {}) => runShellAsync(command, { timeoutSec: 1800, ...opts });
const lastLines = (r, n) => (r.stderr || r.stdout).trim().split(/\r?\n/).slice(-n).join(" | ");

export async function trivyImage(o, ctx) {
  const resolve = ctx.resolveTool || resolveTool;
  const t = resolve("trivy", { allowDocker: ctx.docker, pull: ctx.pull });
  if (t.mode === "missing") return { findings: [F("tool-missing", `trivy: ${t.reason}`)] };
  if (!resolve("docker").mode.startsWith("native")) return { findings: [F("tool-missing", "docker is required to build images for trivy-image")] };
  const images = (o.images || []).filter((im) => !ctx.onlyImages || ctx.onlyImages.has(im.name));
  if (!images.length) return { findings: [F("misconfigured", "trivy-image needs options.images [{name, context, dockerfile?, buildArgs?} | {name, ref, platform?} (+ timeoutSec? for slow builds)]")] };
  if (o.concurrency !== undefined && !(Number.isInteger(o.concurrency) && o.concurrency >= 1 && o.concurrency <= 16)) return { findings: [F("misconfigured", `trivy-image options.concurrency must be an integer 1..16 (images prepared at once; default ${IMAGE_CONCURRENCY_DEFAULT})`)] };
  const width = o.concurrency ?? IMAGE_CONCURRENCY_DEFAULT;
  writeFileSync(join(ctx.outDir, "empty.ignore"), "");
  const scanLock = mutex();
  const notes = [];
  const lists = await pool(images, width, async (im) => {
    const t0 = Date.now();
    const r = await scanOne(im, t, ctx, scanLock);
    notes.push({ name: im.name, line: `${im.name}: prepare ${(r.prepareMs / 1000).toFixed(0)}s, scan ${(r.scanMs / 1000).toFixed(0)}s, total ${((Date.now() - t0) / 1000).toFixed(0)}s` });
    return r.findings;
  });
  const order = new Map(images.map((im, i) => [im.name, i]));
  notes.sort((a, b) => order.get(a.name) - order.get(b.name));
  return { findings: lists.flat(), notes: [`${images.length} image(s), ${Math.min(width, images.length)} prepared at a time, scans serialised`, ...notes.map((n) => n.line)] };
}

/** One image: { findings, prepareMs, scanMs }. Every per-image finding carries { image } (the image-debt ledger keys on it). */
async function scanOne(im, t, ctx, scanLock) {
  const findings = [];
  const FI = (...a) => ({ ...F(...a), image: im.name });
  const t0 = Date.now();
  const out = (prepareMs = Date.now() - t0, scanMs = 0) => ({ findings, prepareMs, scanMs });
  // { name, ref } = a THIRD-PARTY image run as-is (pulled by the exact ref that is deployed, tag or digest);
  // { name, context } = an image we build from the candidate tree.
  const tag = im.ref ? im.ref : `predeploy/${im.name}:${ctx.sha.slice(0, 12)}`;
  let pulledHere = false;
  const dockerfile = im.dockerfile ? `-f ${shq(join(ctx.scanRoot, im.dockerfile))}` : "";
  const args = (im.buildArgs || []).map((a) => `--build-arg ${shq(a)}`).join(" ");
  const secretEnv = {};
  const secretFlags = [];
  for (const sec of im.secrets || []) {
    // { id, from: "gh-auth-token" | { credential: "<store target>" } } -> BuildKit --secret, value only in env of this one command
    const value = sec.from === "gh-auth-token" ? ((await capture("gh auth token")).stdout || "").trim() : getCredential(sec.from?.credential);
    if (!value) { findings.push(FI("secret-missing", `build secret ${sec.id} for image ${im.name} could not be resolved`, im.name)); continue; }
    secretEnv[`PREDEPLOY_SECRET_${sec.id}`] = value;
    secretFlags.push(`--secret id=${sec.id},env=PREDEPLOY_SECRET_${sec.id}`);
  }
  const platform = im.platform ? `--platform ${shq(im.platform)}` : "";
  if (im.ref) {
    if (im.context || im.dockerfile) { findings.push(FI("misconfigured", `image ${im.name}: ref and context are mutually exclusive`, im.name)); return out(); }
    pulledHere = (await capture(`docker image inspect ${shq(im.ref)}`)).status !== 0;
    const pull = await capture(`docker pull -q ${platform} ${shq(im.ref)}`);
    if (pull.status !== 0) { findings.push(FI("image-pull-failed", `docker pull ${im.ref} failed: ${lastLines(pull, 2)}`, im.name)); return out(); }
  }
  const build = im.ref ? { status: 0 } : await capture(`docker build -q ${platform} ${secretFlags.join(" ")} -t ${shq(tag)} ${dockerfile} ${args} ${shq(join(ctx.scanRoot, im.context || "."))}`, { env: secretEnv, timeoutSec: im.timeoutSec || 7200 });
  if (build.status !== 0) { findings.push(FI("image-build-failed", `docker build ${im.name} failed${build.timedOut ? ` (timed out; raise images[].timeoutSec, default 7200)` : ""}: ${lastLines(build, 3)}`, im.name)); return out(); }
  const removeImage = async () => { if (!im.ref || pulledHere) await capture(`docker image rm ${shq(tag)}`); };
  const tar = join(ctx.outDir, `image-${im.name}.tar`);
  // trivy's own default timeout is 5 minutes, which a large image (CUDA/torch) or a busy machine exceeds and
  // then leaves NO report; scans get the same generous budget as builds.
  const scanSec = im.timeoutSec || 7200;
  const trivyTimeout = `${Math.round(scanSec / 60)}m`;
  const save = await capture(`docker save -o ${shq(tar)} ${shq(tag)}`, { timeoutSec: scanSec });
  if (save.status !== 0) { findings.push(FI("image-save-failed", `docker save ${im.name} failed`, im.name)); return out(); }
  const prepareMs = Date.now() - t0;
  const report = `trivy-image-${im.name}.json`;
  const cmd = t.mode === "native"
    ? `trivy image --input ${shq(tar)} --scanners vuln,secret --severity UNKNOWN,LOW,MEDIUM,HIGH,CRITICAL --ignorefile ${shq(join(ctx.outDir, "empty.ignore"))} --exit-code 0 --timeout ${trivyTimeout} --quiet --format json -o ${shq(join(ctx.outDir, report))}`
    : dockerRunCmd(t.image, { mounts: [[ctx.outDir, "/out", "rw"]], args: `image --input /out/image-${im.name}.tar --scanners vuln,secret --severity UNKNOWN,LOW,MEDIUM,HIGH,CRITICAL --ignorefile /out/empty.ignore --exit-code 0 --timeout ${trivyTimeout} --quiet --format json -o /out/${report}` });
  const s0 = Date.now();
  const scan = await scanLock.run(async () => {
    let r = await capture(cmd, { timeoutSec: scanSec });
    // trivy's cache is a single-writer bolt DB: another gate/trivy on this machine holds the lock for a while. Wait and retry
    // instead of reporting an image as unscannable (a false failure that wastes a multi-minute scan cycle).
    for (let attempt = 0; attempt < 12 && !existsSync(join(ctx.outDir, report)) && /cache may be in use by another process/.test(r.stderr + r.stdout); attempt++) {
      await sleep(15000);
      r = await capture(cmd, { timeoutSec: scanSec });
    }
    return r;
  });
  const scanMs = Date.now() - s0;
  rmSync(tar, { force: true });
  if (!existsSync(join(ctx.outDir, report))) {
    findings.push(FI("image-scan-failed", `trivy produced no report for ${im.name}${scan.timedOut ? " (timed out)" : ""}: ${lastLines(scan, 2).slice(0, 300)}`, im.name));
    await removeImage();
    return out(prepareMs, scanMs);
  }
  const text = readFileSync(join(ctx.outDir, report), "utf8");
  for (const f of parseOutput("trivy-json", { reports: [report], readReport: () => text })) findings.push({ ...f, image: im.name, location: imageFindingLocation(im.name, f.location), imageFinding: !IMAGE_INFRA_ID.test(f.id) });
  // built images are always ours to remove; a pulled ref only if it was not on this machine already
  await removeImage();
  return out(prepareMs, scanMs);
}
