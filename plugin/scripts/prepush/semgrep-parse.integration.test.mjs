#!/usr/bin/env node
// Regression (heavy tier): the shell files adopters copy (prepush-lib.sh, the template ci-local.sh) must
// parse under the REAL semgrep, the one the predeploy gate runs (native, else the semgrep Docker image).
// semgrep's bash grammar rejects some valid constructs and the adopter's gate counts an unparseable file as
// a `semgrep-error` finding. Fast static twin: semgrep-parse.test.mjs. Fails closed when semgrep is missing.
import { spawnSync } from "node:child_process";
import { cpSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { ADOPTED } from "./adopted-shell-files.mjs";
import { resolveTool, dockerRunCmd, nativePath } from "../predeploy/tools.mjs";

const tool = resolveTool("semgrep");
if (tool.mode === "missing") { console.error(`FAIL semgrep unavailable: ${tool.reason}`); process.exit(1); }

const work = mkdtempSync(join(tmpdir(), "maple-sg-parse-"));
const src = join(work, "src"), out = join(work, "out");
mkdirSync(src); mkdirSync(out);
for (const f of ADOPTED) cpSync(f, join(src, basename(f)));
// semgrep only parses a file when some loaded rule targets its language, so a bash rule is loaded here
// (matches nothing real; the parse is the test) instead of depending on a registry pack shipping one.
const rules = join(work, "rules");
mkdirSync(rules);
writeFileSync(join(rules, "bash-parse.yml"), ["rules:", "  - id: maple-bash-parse-probe", "    languages: [bash]", "    severity: INFO", "    message: probe", "    pattern: maple_probe_never_matches_anything $X", ""].join("\n"));
const args = "scan --config /rules/bash-parse.yml --metrics=off --quiet --json --disable-nosem -o /out/semgrep.json .";
const cmd = tool.mode === "native"
  ? `cd '${nativePath(src)}' && '${tool.bin}' ${args.replace('/out/', nativePath(out) + '/').replace('/rules/', nativePath(rules) + '/')}`
  : dockerRunCmd(tool.image, { mounts: [[src, "/src", "ro"], [out, "/out", "rw"], [rules, "/rules", "ro"]], workdir: "/src", args: `${tool.entry} ${args}` });
const r = spawnSync("bash", ["-c", cmd], { encoding: "utf8", timeout: 10 * 60 * 1000 });
let report;
try { report = JSON.parse(readFileSync(join(out, "semgrep.json"), "utf8")); }
catch { console.error(`FAIL no semgrep report (exit ${r.status}): ${(r.stderr || "").slice(-400)}`); process.exit(1); }
rmSync(work, { recursive: true, force: true });
const bad = (report.errors || []).filter((e) => /Syntax|Parsing|Lexical/i.test(`${e.type} ${e.message}`));
for (const e of bad) console.error(`FAIL semgrep cannot parse ${basename(e.path)}: ${String(e.message).split("\n")[0]}`);
if (bad.length) process.exit(1);
console.log(`ok - semgrep (${tool.mode}) parses all ${ADOPTED.length} adopted shell files without error`);
