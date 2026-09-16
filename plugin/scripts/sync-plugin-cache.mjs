#!/usr/bin/env node
/**
 * sync-plugin-cache.mjs — bootstrap the maple-standard plugin cache from
 * this repo's plugin/ tree, so an update to the standard reaches every
 * adopting project without a manual `/plugin marketplace update`.
 *
 * WHY THIS EXISTS: Claude Code does not read a directory-source
 * marketplace live. On `/plugin install` (and marketplace refresh) it
 * COPIES plugin/ into a versioned cache dir
 * (~/.claude/plugins/cache/<marketplace>/<plugin>/<version>/) and every
 * session reads THAT copy. Editing plugin/ in this repo has zero effect on
 * any other project's session until something re-runs the copy. This
 * script is that "something" — invoked as a SessionStart hook (see
 * plugin/README.md) so it runs at the start of every session, everywhere.
 *
 * HOW IT DECIDES "OUT OF DATE": plugin/.claude-plugin/plugin.json's
 * `version` names the target cache directory
 * (cache/<marketplace>/<plugin>/<version>/). Inside that directory this
 * script writes its own manifest file (MANIFEST_NAME) recording a SHA-256
 * content hash of every file under plugin/ (relative path + bytes, sorted
 * for determinism). Each run recomputes the repo's current hash and
 * compares: version dir missing, manifest missing, or hash mismatch all
 * mean "out of sync" — covers both a version bump (new dir) and an
 * in-place edit without a version bump (same dir, stale content).
 *
 * SELF-LOCATING / SELF-HEALING (repo-move survival): this script finds the
 * repo root from import.meta.url, NEVER from a hardcoded path — it keeps
 * working if the repo is moved (only the SessionStart hook's `command`
 * path in ~/.claude/settings.json needs updating after a move; see
 * plugin/README.md). It identifies "which known_marketplaces.json entry is
 * ME" primarily by exact path match against its own resolved repo root; if
 * that fails (post-move, before the settings.json hook path is fixed) it
 * falls back to matching by directory basename, and if THAT matches but
 * the recorded path differs, it self-heals known_marketplaces.json's
 * `path`/`installLocation` and settings.json's
 * extraKnownMarketplaces.<name>.source.path to the new location. If no
 * marketplace entry can be matched at all, it gives up quietly (exit 0) —
 * nothing to sync against.
 *
 * SAFETY: never touches any plugin/marketplace other than the one it
 * resolves to itself. Never deletes outside
 * ~/.claude/plugins/cache/<that-marketplace>/. Writes are staged in a
 * temp directory and swapped in; JSON config files are backed up
 * (sibling `.bak-<timestamp>`) before any write. This is a SessionStart
 * hook: it must never block or fail a session, so every path through
 * main() that isn't --check is wrapped in a top-level try/catch that
 * prints one line to stderr and exits 0 on any error.
 *
 * CLI:
 *   node sync-plugin-cache.mjs            sync if out of date, else no-op (exit 0)
 *   node sync-plugin-cache.mjs --check    report drift, change nothing (exit 0 in sync, 1 if drift/error)
 *   node sync-plugin-cache.mjs --force    re-sync even if content hash matches
 */

import { createHash } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';

const MANIFEST_NAME = '.maple-sync-manifest.json';

const args = process.argv.slice(2);
const CHECK = args.includes('--check');
const FORCE = args.includes('--force');

function log(msg) {
  // Single line, stderr — never let sync chatter pollute a session's stdout.
  process.stderr.write(`[sync-plugin-cache] ${msg}\n`);
}

function readJson(p) {
  return JSON.parse(fs.readFileSync(p, 'utf8'));
}

function writeJsonAtomic(p, obj) {
  const tmp = `${p}.tmp-${process.pid}-${Date.now()}`;
  fs.writeFileSync(tmp, JSON.stringify(obj, null, 2) + '\n', 'utf8');
  fs.renameSync(tmp, p);
}

function backupFile(p) {
  if (!fs.existsSync(p)) return;
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  fs.copyFileSync(p, `${p}.bak-${stamp}`);
}

/** Recursively list files under dir, returning paths relative to dir (posix-style, sorted). */
function listFiles(dir) {
  const out = [];
  function walk(rel) {
    const abs = path.join(dir, rel);
    const entries = fs.readdirSync(abs, { withFileTypes: true });
    for (const e of entries) {
      const relPath = rel ? `${rel}/${e.name}` : e.name;
      if (e.isDirectory()) {
        walk(relPath);
      } else if (e.isFile()) {
        out.push(relPath);
      }
      // symlinks: skip (none expected in this tree; avoids cycles)
    }
  }
  walk('');
  out.sort();
  return out;
}

/** SHA-256 over every file's relative path + content, sorted — deterministic content identity. */
function hashTree(dir) {
  const hash = createHash('sha256');
  for (const rel of listFiles(dir)) {
    hash.update(rel);
    hash.update('\0');
    hash.update(fs.readFileSync(path.join(dir, rel)));
    hash.update('\0');
  }
  return hash.digest('hex');
}

function copyTree(srcDir, destDir) {
  fs.mkdirSync(destDir, { recursive: true });
  for (const rel of listFiles(srcDir)) {
    const destPath = path.join(destDir, rel);
    fs.mkdirSync(path.dirname(destPath), { recursive: true });
    fs.copyFileSync(path.join(srcDir, rel), destPath);
  }
}

function currentGitSha(cwd) {
  try {
    return execFileSync('git', ['rev-parse', 'HEAD'], { cwd, encoding: 'utf8' }).trim();
  } catch {
    return undefined;
  }
}

function samePath(a, b) {
  // Windows paths are case-insensitive and may differ in separator style.
  const norm = (p) => path.resolve(p).replace(/\\/g, '/').toLowerCase();
  return norm(a) === norm(b);
}

function main() {
  const __filename = fileURLToPath(import.meta.url);
  const scriptDir = path.dirname(__filename); // .../plugin/scripts
  const pluginDir = path.dirname(scriptDir); // .../plugin
  const repoRoot = path.dirname(pluginDir); // repo root

  const pluginJsonPath = path.join(pluginDir, '.claude-plugin', 'plugin.json');
  if (!fs.existsSync(pluginJsonPath)) {
    log(`no plugin.json at ${pluginJsonPath} — nothing to sync`);
    return CHECK ? 1 : 0;
  }
  const pluginJson = readJson(pluginJsonPath);
  const pluginName = pluginJson.name;
  const pluginVersion = pluginJson.version;
  if (!pluginName || !pluginVersion) {
    log('plugin.json missing name/version — nothing to sync');
    return CHECK ? 1 : 0;
  }

  const claudeHome = path.join(os.homedir(), '.claude');
  const knownMarketplacesPath = path.join(claudeHome, 'plugins', 'known_marketplaces.json');
  const installedPluginsPath = path.join(claudeHome, 'plugins', 'installed_plugins.json');
  const cacheRoot = path.join(claudeHome, 'plugins', 'cache');

  if (!fs.existsSync(knownMarketplacesPath) || !fs.existsSync(installedPluginsPath)) {
    log('no plugin config under ~/.claude/plugins — nothing to sync (plugin not installed on this machine?)');
    return CHECK ? 1 : 0;
  }

  const knownMarketplaces = readJson(knownMarketplacesPath);

  // Find which marketplace entry is US: exact path match first, then
  // basename match (post-move self-heal case).
  let marketplaceKey;
  let needsPathHeal = false;
  for (const [key, entry] of Object.entries(knownMarketplaces)) {
    const src = entry && entry.source;
    if (!src || src.source !== 'directory' || typeof src.path !== 'string') continue;
    if (samePath(src.path, repoRoot)) {
      marketplaceKey = key;
      needsPathHeal = false;
      break;
    }
    if (!marketplaceKey && path.basename(path.resolve(src.path)) === path.basename(repoRoot)) {
      marketplaceKey = key;
      needsPathHeal = true;
      // keep scanning in case a later entry is an exact match
    }
  }

  if (!marketplaceKey) {
    log(`no known_marketplaces.json entry points at ${repoRoot} (or a same-named dir) — nothing to sync`);
    return CHECK ? 1 : 0;
  }

  const pluginKey = `${pluginName}@${marketplaceKey}`;
  const installedPlugins = readJson(installedPluginsPath);
  const installedEntries = installedPlugins.plugins && installedPlugins.plugins[pluginKey];
  if (!installedEntries || installedEntries.length === 0) {
    log(`no installed_plugins.json entry for ${pluginKey} — nothing to sync`);
    return CHECK ? 1 : 0;
  }

  const marketplaceCacheDir = path.join(cacheRoot, marketplaceKey, pluginName);
  const versionDir = path.join(marketplaceCacheDir, pluginVersion);

  const repoHash = hashTree(pluginDir);

  let inSync = false;
  let manifest;
  if (fs.existsSync(versionDir)) {
    const manifestPath = path.join(versionDir, MANIFEST_NAME);
    if (fs.existsSync(manifestPath)) {
      try {
        manifest = readJson(manifestPath);
        inSync = manifest.hash === repoHash && manifest.version === pluginVersion;
      } catch {
        inSync = false;
      }
    }
  }

  const pathDrift = needsPathHeal;
  const outOfSync = !inSync || FORCE;

  if (CHECK) {
    if (!outOfSync && !pathDrift) {
      log(`in sync (version ${pluginVersion}, hash ${repoHash.slice(0, 12)})`);
      return 0;
    }
    if (outOfSync) log(`drift: cache ${inSync ? '(forced)' : 'stale or missing'} for version ${pluginVersion}`);
    if (pathDrift) log(`drift: marketplace "${marketplaceKey}" path is stale (registered elsewhere, repo now at ${repoRoot})`);
    return 1;
  }

  if (!outOfSync && !pathDrift) {
    // Nothing to do — the common case on every session start.
    return 0;
  }

  // ---- Perform the sync (and/or path heal) ----

  if (outOfSync) {
    const tmpDir = `${versionDir}.tmp-${process.pid}-${Date.now()}`;
    copyTree(pluginDir, tmpDir);
    writeJsonAtomic(path.join(tmpDir, MANIFEST_NAME), {
      version: pluginVersion,
      hash: repoHash,
      syncedAt: new Date().toISOString(),
    });

    // Preserve the .in_use marker directory across the swap (tracks
    // sessions currently running this version) — copy it forward rather
    // than losing it if the version dir already exists (in-place resync).
    const oldInUse = path.join(versionDir, '.in_use');
    if (fs.existsSync(oldInUse)) {
      copyTree(oldInUse, path.join(tmpDir, '.in_use'));
    }

    if (fs.existsSync(versionDir)) {
      const bak = `${versionDir}.bak-${Date.now()}`;
      fs.renameSync(versionDir, bak);
      try {
        fs.renameSync(tmpDir, versionDir);
        fs.rmSync(bak, { recursive: true, force: true });
      } catch (e) {
        // Best-effort rollback: restore the backup if the swap failed.
        if (!fs.existsSync(versionDir) && fs.existsSync(bak)) {
          fs.renameSync(bak, versionDir);
        }
        throw e;
      }
    } else {
      fs.mkdirSync(path.dirname(versionDir), { recursive: true });
      fs.renameSync(tmpDir, versionDir);
    }

    // Update installed_plugins.json for this plugin key.
    backupFile(installedPluginsPath);
    const fresh = readJson(installedPluginsPath); // re-read post-backup, pre-write
    const entries = fresh.plugins[pluginKey];
    const sha = currentGitSha(repoRoot);
    const now = new Date().toISOString();
    for (const entry of entries) {
      entry.version = pluginVersion;
      entry.installPath = versionDir;
      entry.lastUpdated = now;
      if (sha) entry.gitCommitSha = sha;
    }
    writeJsonAtomic(installedPluginsPath, fresh);

    // Remove stale older version dirs for THIS plugin only.
    try {
      if (fs.existsSync(marketplaceCacheDir)) {
        for (const name of fs.readdirSync(marketplaceCacheDir)) {
          if (name === pluginVersion) continue;
          const staleDir = path.join(marketplaceCacheDir, name);
          let stat;
          try {
            stat = fs.statSync(staleDir);
          } catch {
            continue;
          }
          if (!stat.isDirectory()) continue;
          const staleInUse = path.join(staleDir, '.in_use');
          if (fs.existsSync(staleInUse) && fs.readdirSync(staleInUse).length > 0) {
            log(`leaving stale version ${name} in place — .in_use is non-empty`);
            continue;
          }
          fs.rmSync(staleDir, { recursive: true, force: true });
        }
      }
    } catch (e) {
      log(`non-fatal: failed cleaning stale versions: ${e.message}`);
    }

    log(`synced ${pluginKey} -> ${versionDir} (version ${pluginVersion})`);
  }

  if (pathDrift) {
    backupFile(knownMarketplacesPath);
    const freshKnown = readJson(knownMarketplacesPath);
    if (freshKnown[marketplaceKey] && freshKnown[marketplaceKey].source) {
      freshKnown[marketplaceKey].source.path = repoRoot;
      freshKnown[marketplaceKey].installLocation = repoRoot;
      freshKnown[marketplaceKey].lastUpdated = new Date().toISOString();
      writeJsonAtomic(knownMarketplacesPath, freshKnown);
    }

    const settingsPath = path.join(claudeHome, 'settings.json');
    if (fs.existsSync(settingsPath)) {
      try {
        backupFile(settingsPath);
        const settings = readJson(settingsPath);
        const extra = settings.extraKnownMarketplaces && settings.extraKnownMarketplaces[marketplaceKey];
        if (extra && extra.source && extra.source.source === 'directory') {
          extra.source.path = repoRoot;
          writeJsonAtomic(settingsPath, settings);
        }
      } catch (e) {
        log(`non-fatal: failed to self-heal settings.json marketplace path: ${e.message}`);
      }
    }

    log(`self-healed marketplace "${marketplaceKey}" path -> ${repoRoot}`);
  }

  return 0;
}

try {
  const code = main();
  process.exit(code || 0);
} catch (e) {
  log(`error (non-fatal, session continues): ${e && e.message ? e.message : e}`);
  process.exit(CHECK ? 1 : 0);
}
