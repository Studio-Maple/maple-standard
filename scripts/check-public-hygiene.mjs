#!/usr/bin/env node
/**
 * check-public-hygiene.mjs — this repo is a PUBLIC plugin: no consuming project, client, person or private
 * infrastructure may be named in it (fast tier, also run by every push's gate).
 *
 * Two sources, so the check itself leaks nothing:
 *   1. scripts/public-hygiene.hashes.json — salted SHA-256 of denied names / identifiers (normalised to
 *      lower-case words; phrases of up to 3 words). Every 1-3 word window of every tracked text file is
 *      hashed and compared. The names never appear in plaintext here.
 *   2. Generic patterns (no names): an owner-specific Windows path (a named user's profile folder, or a drive-root Projects tree),
 *      and e-mail addresses outside reserved example domains.
 * Optional local extras (never committed): one term per line in the file named by MAPLE_HYGIENE_DENYLIST,
 * else ~/.maple/public-hygiene-denylist.txt. `--hash` prints the hash lines for that file's terms, to add
 * to the committed list.
 *
 *   node scripts/check-public-hygiene.mjs            check every tracked text file (exit 1 on a hit)
 *   node scripts/check-public-hygiene.mjs --hash     print hashes for the local denylist's terms
 *   node scripts/check-public-hygiene.mjs <paths...> check only these files
 *
 * Honest limit: the hashes stop casual reading, not a determined guess (a short name can be brute-forced
 * against the salt). A term that is also an ordinary word cannot be listed; wording review still matters.
 */
import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const HASH_FILE = join(ROOT, "scripts", "public-hygiene.hashes.json");
// Generated / third-party data that names other people's packages, not ours.
const SKIP = [/^pnpm-lock\.yaml$/, /^plugin\/scripts\/deps\/data\//, /\.(png|jpe?g|gif|ico|woff2?|ttf|pdf|zip|gz)$/i];

const USER_PATH = /\b[A-Za-z]:[\\/]{1,2}Users[\\/]{1,2}(?!<|\$|%|\{|\.\.\.|USER\b|USERNAME\b|you\b|me\b|runneradmin\b|Public\b|Default\b|name\b|x\b|u\b|a\b|someone\b|dev\b|test\b)[A-Za-z][^\\/\s"'`:*?<>|]*/;
const PROJECTS_PATH = /\b[A-Za-z]:[\\/]{1,2}Projects[\\/]/i;
const EMAIL = /\b[A-Za-z0-9._%+-]+@([A-Za-z0-9-]+\.)+[A-Za-z]{2,}\b/g;
const OK_EMAIL_DOMAIN = /(^|\.)(example\.(com|org|net)|test|invalid|localhost|evil\.com|evil\.example\.com|users\.noreply\.github\.com|anthropic\.com|github\.com|supabase\.co|supabase\.com|host\.docker\.internal|b\.com)$/i;

export function normalize(text) {
  return String(text).toLowerCase().normalize("NFKC").split(/[^\p{L}\p{N}]+/u).filter(Boolean);
}

export function hashTerm(term, salt) {
  return createHash("sha256").update(`${salt}\u0000${normalize(term).join(" ")}`).digest("hex");
}

function loadHashes() {
  const data = JSON.parse(readFileSync(HASH_FILE, "utf8"));
  return { salt: data.salt, hashes: new Set(data.hashes) };
}

function localTerms() {
  const file = process.env.MAPLE_HYGIENE_DENYLIST || join(homedir(), ".maple", "public-hygiene-denylist.txt");
  if (!existsSync(file)) return [];
  return readFileSync(file, "utf8").split(/\r?\n/).map((l) => l.trim()).filter((l) => l && !l.startsWith("#"));
}

/** @returns {{ line: number, why: string }[]} hits in one file's text (the matched words are never printed). */
export function scanText(text, { salt, hashes, extra = [] }) {
  const hits = [];
  const extraNorm = extra.map((t) => normalize(t).join(" ")).filter(Boolean);
  const lines = text.split(/\r?\n/);
  lines.forEach((line, i) => {
    if (USER_PATH.test(line)) hits.push({ line: i + 1, why: "a personal Windows user path" });
    if (PROJECTS_PATH.test(line)) hits.push({ line: i + 1, why: "an owner-specific drive-root Projects path" });
    for (const m of line.matchAll(EMAIL)) {
      const domain = m[0].split("@")[1];
      if (!OK_EMAIL_DOMAIN.test(domain)) { hits.push({ line: i + 1, why: "an e-mail address outside example domains" }); break; }
    }
    const words = normalize(line);
    let found = false;
    for (let n = 1; n <= 3 && !found; n++) {
      for (let s = 0; s + n <= words.length; s++) {
        const phrase = words.slice(s, s + n).join(" ");
        if (hashes.has(hashTerm(phrase, salt)) || extraNorm.includes(phrase)) { found = true; break; }
      }
    }
    if (found) hits.push({ line: i + 1, why: "a denied project / person / infrastructure name" });
  });
  return hits;
}

function trackedFiles() {
  const r = spawnSync("git", ["-C", ROOT, "ls-files", "-z"], { encoding: "utf8", maxBuffer: 64 << 20 });
  if (r.status !== 0) throw new Error("git ls-files failed");
  return r.stdout.split("\0").filter(Boolean);
}

function main(argv) {
  const { salt, hashes } = loadHashes();
  if (argv[0] === "--hash") {
    for (const t of localTerms()) console.log(`"${hashTerm(t, salt)}",`);
    return 0;
  }
  const files = argv.length ? argv.map((p) => resolve(p).slice(ROOT.length + 1).replace(/\\/g, "/")) : trackedFiles();
  const extra = localTerms();
  let total = 0;
  for (const f of files) {
    if (SKIP.some((re) => re.test(f)) || f === "scripts/public-hygiene.hashes.json") continue;
    let text;
    try { text = readFileSync(join(ROOT, f), "utf8"); } catch { continue; }
    if (text.includes("\u0000")) continue; // binary
    for (const h of scanText(text, { salt, hashes, extra })) {
      console.error(`${f}:${h.line}: ${h.why}`);
      total++;
    }
  }
  if (total) {
    console.error(`\npublic-hygiene: ${total} hit(s). This repo is public: replace the name with generic wording or a placeholder (<project>, "a consuming project").`);
    return 1;
  }
  console.log(`public-hygiene: ok (${files.length} file(s), ${hashes.size} hashed term(s)${extra.length ? ` + ${extra.length} local` : ""})`);
  return 0;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) process.exit(main(process.argv.slice(2)));
