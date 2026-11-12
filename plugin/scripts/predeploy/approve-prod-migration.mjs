#!/usr/bin/env node
// OWNER-ONLY: approve exact migration versions for ONE production Supabase project.
//
//   node approve-prod-migration.mjs --project-ref <ref> <version>... [--ttl-minutes 30]
//
// Run it in your own terminal, inside the repo. It writes <git-common-dir>/maple/prod-migration-approval.json,
// which prod-migration-guard (the PreToolUse hook) requires before any `supabase db push` / `migration up` /
// `migration repair` against production. The approval is NOT consumed by use: it simply expires (default 30
// minutes) and is replaced by the next run. It needs an interactive terminal and a typed confirmation, and
// the hook denies every agent tool call that runs it, so an agent cannot issue its own approval.
import { createInterface } from "node:readline/promises";
import { fileURLToPath } from "node:url";
import process from "node:process";
import { DEFAULT_TTL_MINUTES, buildApproval, gitCommonDir, writeApproval } from "./migration-approval.mjs";

/** @returns {{ projectRef?: string, versions: string[], ttlMinutes: number }} */
export function parseArgs(argv) {
  const out = { versions: [], ttlMinutes: DEFAULT_TTL_MINUTES };
  for (let n = 0; n < argv.length; n++) {
    const a = argv[n];
    if (a === "--project-ref") out.projectRef = argv[++n];
    else if (a.startsWith("--project-ref=")) out.projectRef = a.slice(14);
    else if (a === "--ttl-minutes") out.ttlMinutes = Number(argv[++n]);
    else if (a.startsWith("--ttl-minutes=")) out.ttlMinutes = Number(a.slice(14));
    else if (a.startsWith("-")) throw new Error(`unknown option ${a}`);
    else out.versions.push(a);
  }
  return out;
}

async function main() {
  let opts;
  let approval;
  try {
    opts = parseArgs(process.argv.slice(2));
    approval = buildApproval(opts);
  } catch (err) {
    process.stderr.write(`${err.message}\nusage: node approve-prod-migration.mjs --project-ref <ref> <version>... [--ttl-minutes ${DEFAULT_TTL_MINUTES}]\n`);
    return 2;
  }
  if (!process.stdin.isTTY || !process.stdout.isTTY) {
    process.stderr.write("refused: this must be run by the owner in an interactive terminal (stdin and stdout must be a TTY).\n");
    return 1;
  }
  const common = gitCommonDir(process.cwd());
  if (!common) { process.stderr.write("refused: run this inside the project's git repository.\n"); return 1; }
  process.stdout.write(
    `Approve production migrations\n  project : ${approval.projectRef}\n  versions: ${approval.versions.join(", ")}\n  expires : ${approval.expiresAt}\n` +
    "This replaces any earlier approval. It is not consumed by use; it simply expires.\n",
  );
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  const answer = (await rl.question(`Type the project ref (${approval.projectRef}) to confirm: `)).trim();
  rl.close();
  if (answer !== approval.projectRef) { process.stderr.write("not confirmed; nothing written.\n"); return 1; }
  const file = writeApproval(common, approval);
  process.stdout.write(`approved: ${file}\n`);
  return 0;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  main().then((c) => process.exit(c), (e) => { process.stderr.write(`${e?.message ?? e}\n`); process.exit(1); });
}
