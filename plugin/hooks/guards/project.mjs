// Project config lookup shared by the guards: nearest ancestor of cwd holding maple.config.json.
// Filesystem only (no git spawn), memoised per process so several guards cost one read.
import { existsSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";

const cache = new Map();

/** @returns {{ root: string|null, cfg: object|null, invalid: boolean }} cfg is {} when there is no config. */
export function projectConfig(start) {
  const key = resolve(start || process.cwd());
  if (cache.has(key)) return cache.get(key);
  let dir = key;
  let result = { root: null, cfg: {}, invalid: false };
  for (;;) {
    const file = join(dir, "maple.config.json");
    if (existsSync(file)) {
      try {
        const cfg = JSON.parse(readFileSync(file, "utf8"));
        result = { root: dir, cfg: cfg && typeof cfg === "object" ? cfg : {}, invalid: false };
      } catch {
        result = { root: dir, cfg: null, invalid: true };
      }
      break;
    }
    const up = dirname(dir);
    if (up === dir) break;
    dir = up;
  }
  cache.set(key, result);
  return result;
}
