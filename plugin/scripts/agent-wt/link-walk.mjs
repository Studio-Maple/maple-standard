/**
 * link-walk.mjs - shared lstat-only walk for strip-links.mjs / verify-no-links.mjs (D012, D069).
 * NEVER follows a link: a junction/symlink is recorded and not entered, so the walk can never
 * leave the tree it was given (the whole point - git/rm deleters that follow links gut the main
 * checkout's node_modules). Node reports NTFS junctions as symbolic links via lstat.
 */
import { lstatSync, readdirSync } from "node:fs";
import { join } from "node:path";

/** Returns { links: string[], errors: string[] } for every link inside root (root itself excluded). */
export function findLinks(root) {
  const links = [];
  const errors = [];
  const queue = [root];
  while (queue.length > 0) {
    const dir = queue.shift();
    let entries;
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch (e) {
      errors.push(`${dir}: ${e.code || e.message}`);
      continue;
    }
    for (const ent of entries) {
      const p = join(dir, ent.name);
      let st;
      try {
        st = lstatSync(p);
      } catch (e) {
        errors.push(`${p}: ${e.code || e.message}`);
        continue;
      }
      if (st.isSymbolicLink()) links.push(p);
      else if (st.isDirectory()) queue.push(p);
    }
  }
  return { links, errors };
}

/** True when root itself is a link (or cannot be lstat-ed for a reason other than absence). */
export function rootState(root) {
  try {
    const st = lstatSync(root);
    return st.isSymbolicLink() ? "link" : st.isDirectory() ? "dir" : "file";
  } catch (e) {
    return e.code === "ENOENT" ? "absent" : "error";
  }
}
