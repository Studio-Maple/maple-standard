#!/usr/bin/env node
/**
 * strip-links.mjs <root> - remove every link (junction/symlink) INSIDE <root>: the links
 * themselves, never their targets. lstat-only, no PowerShell (D012, D069). Exit 0 when the strip
 * pass finished; the caller still runs verify-no-links.mjs - the strip's own exit code is never
 * trusted as proof. Non-zero on a root that is a link/unscannable or a link that would not go.
 */
import { rmdirSync, unlinkSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { findLinks, rootState } from "./link-walk.mjs";

const root = process.argv[2];
if (!root) { console.error("usage: strip-links.mjs <root>"); process.exit(64); }
const state = rootState(root);
if (state === "absent") process.exit(0);
if (state !== "dir") { console.error(`strip-links: ${root} is ${state}, refusing`); process.exit(2); }

function removeLink(p) {
  try { unlinkSync(p); return; } catch { /* junction on some platforms */ }
  try { rmdirSync(p); return; } catch { /* fall through */ }
  if (process.platform === "win32") spawnSync("cmd", ["/c", "rmdir", p], { stdio: "ignore" });
}

// Links nested under a stripped link are never entered (findLinks does not descend into links),
// so each pass only ever sees links physically inside root. Loop in case a pass reveals more.
let failed = 0;
for (let pass = 0; pass < 5; pass++) {
  const { links } = findLinks(root);
  if (links.length === 0) break;
  for (const l of links) removeLink(l);
  failed = findLinks(root).links.length;
  if (failed === 0) break;
}
if (failed > 0) { console.error(`strip-links: ${failed} link(s) would not be removed`); process.exit(1); }
process.exit(0);
