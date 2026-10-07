#!/usr/bin/env node
/**
 * verify-no-links.mjs <root> - read-only, lstat-only scan. Exit 0 only when <root> is a real
 * directory (or absent) containing NO links and every directory was readable. Anything else is a
 * non-zero exit, and the caller must not delete (D012/D069: fail closed).
 */
import { findLinks, rootState } from "./link-walk.mjs";

const root = process.argv[2];
if (!root) { console.error("usage: verify-no-links.mjs <root>"); process.exit(64); }
const state = rootState(root);
if (state === "absent") process.exit(0);
if (state !== "dir") { console.error(`verify-no-links: ${root} is ${state}, refusing`); process.exit(2); }
const { links, errors } = findLinks(root);
if (links.length > 0) {
  console.error(`verify-no-links: ${links.length} link(s) remain inside ${root}:\n  ${links.slice(0, 10).join("\n  ")}`);
  process.exit(3);
}
if (errors.length > 0) {
  console.error(`verify-no-links: could not scan ${errors.length} path(s), cannot prove the tree is link-free:\n  ${errors.slice(0, 10).join("\n  ")}`);
  process.exit(4);
}
process.exit(0);
