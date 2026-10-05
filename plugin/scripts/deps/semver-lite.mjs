/**
 * semver-lite.mjs — the tiny slice of semver the dependency-freshness checks (D064) need,
 * dependency-free (the plugin ships to projects that do not share this repo's node_modules).
 *
 * The question asked is never "does the range match version X" but "what is the LOWEST version
 * this spec would let in, and is that behind the latest release's major (0.x: minor)?" — so a
 * range's FLOOR is what matters: `^17.0.2` -> 17.0.2, `~1.2` -> 1.2.0, `1.x` -> 1.0.0,
 * `>=2 <4` -> 2.0.0, `^17 || ^18 || ^19` -> 19.0.0 (a `||` range is as fresh as its newest branch:
 * it admits that major, which is how peerDependencies are normally written).
 */

const VERSION = /^v?(\d+)(?:\.(\d+|[xX*]))?(?:\.(\d+|[xX*]))?(?:-([0-9A-Za-z.-]+))?(?:\+[0-9A-Za-z.-]+)?$/;

/** Parse a (possibly partial / x-range) version. Wildcard parts become 0. null when not version-shaped. */
export function parseVersion(text) {
  const m = VERSION.exec(String(text).trim());
  if (!m) return null;
  const num = (s) => (s === undefined || /^[xX*]$/.test(s) ? 0 : Number(s));
  return { major: Number(m[1]), minor: num(m[2]), patch: num(m[3]), pre: m[4] ?? null };
}

export function isPrerelease(text) {
  return parseVersion(text)?.pre != null;
}

/** Standard semver ordering (a prerelease sorts below its release). */
export function compareVersions(a, b) {
  const x = typeof a === "string" ? parseVersion(a) : a;
  const y = typeof b === "string" ? parseVersion(b) : b;
  for (const k of ["major", "minor", "patch"]) if (x[k] !== y[k]) return x[k] < y[k] ? -1 : 1;
  if (x.pre === y.pre) return 0;
  if (x.pre === null) return 1;
  if (y.pre === null) return -1;
  return x.pre < y.pre ? -1 : 1;
}

const ZERO = { major: 0, minor: 0, patch: 0, pre: null };
const maxVersion = (a, b) => (compareVersions(a, b) >= 0 ? a : b);
const OPERATOR_GAP = /(\^|~>?|>=|>|<=|<|=)\s+/g;

/** Lower bound of ONE comparator (`^1.2.3`, `>=1`, `<2`, `1.x`, `=1.0.0`, `~1.2`). */
function comparatorFloor(token) {
  const m = /^(\^|~>?|>=|>|<=|<|=)?(.+)$/.exec(token);
  if (!m) return null;
  const op = m[1] ?? "";
  if (op === "<" || op === "<=") return ZERO; // upper bound only
  const v = parseVersion(m[2]);
  if (!v) return null;
  if (op === ">") return { ...v, patch: v.patch + 1, pre: null }; // strictly above
  return v;
}

/**
 * The floor of a version spec: the lowest version it admits. Returns null when the spec carries no
 * version at all (`*`, `x`, empty, dist-tags like `latest`) — those resolve to whatever is current at install.
 */
export function rangeFloor(spec) {
  const text = String(spec).trim();
  if (text === "" || text === "*" || /^[xX]$/.test(text) || /^[A-Za-z]/.test(text) && !/^v\d/.test(text)) return null;
  let best = null;
  for (const alt of text.split("||")) {
    const hyphen = /^\s*(\S+)\s+-\s+(\S+)\s*$/.exec(alt); // `1.2.3 - 2.0.0`: only the left side bounds below
    const tokens = hyphen ? [hyphen[1]] : alt.trim().replace(OPERATOR_GAP, "$1").split(/\s+/).filter(Boolean);
    let floor = null;
    for (const t of tokens) {
      const f = comparatorFloor(t);
      if (f) floor = floor ? maxVersion(floor, f) : f;
    }
    if (floor) best = best ? maxVersion(best, floor) : floor;
  }
  return best;
}

/** True when a spec's floor is behind `latest` (major; for a 0.x latest, minor). Specs with no floor are never stale. */
export function isBehind(spec, latest) {
  const floor = rangeFloor(spec);
  const l = parseVersion(latest);
  if (!floor || !l) return false;
  if (floor.major !== l.major) return floor.major < l.major;
  return l.major === 0 && floor.minor < l.minor;
}

/** Same freshness bucket: equal major (for 0.x, equal major and minor). Used to match exception ranges. */
export function sameBucket(specA, specB) {
  const a = rangeFloor(specA);
  const b = rangeFloor(specB);
  if (!a || !b) return false;
  return a.major === b.major && (a.major !== 0 || a.minor === b.minor);
}
