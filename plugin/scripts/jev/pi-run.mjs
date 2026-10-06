#!/usr/bin/env node
/**
 * pi-run.mjs — headless Pi (the Pi coding agent, `@earendil-works/pi-coding-agent`,
 * on the owner's ChatGPT subscription — "Pi's GPT") run in an isolated git
 * worktree, for the `pi` executor jev-model-routing can pick.
 *
 * Trimmed port of C:\Projects\MapleLens\tools\jev\worker-pi.mjs (the worker
 * adapter) + worktree.mjs (isolation). MapleLens's worktree.mjs also carries
 * checkpoint/revert/patch-cap machinery for a long-running supervised
 * mission loop (supervise.mjs) — this is a single-shot, one-prompt-in
 * one-diff-out runner for a plugin skill script, so that machinery is not
 * ported; see the "Gap" note in plugin/README.md's Jev section.
 *
 * detect availability -> run in isolation -> return {summary, diff} ->
 * caller (jev-model-routing's script, or a session directly) runs the
 * result through validate.mjs before trusting it, same as any other
 * sub-agent's output (per plugin/hooks/jev-validate-subagent.mjs).
 */
import { execFile } from "node:child_process";
import { existsSync, lstatSync, mkdirSync, rmdirSync, rmSync, symlinkSync } from "node:fs";
import path from "node:path";
import { promisify } from "node:util";
import { createHash } from "node:crypto";
import { DEFAULT_PI_MODEL, isPiModel } from "./ladder.mjs";

const execFileAsync = promisify(execFile);
const PREFIX = "pi-";
const PI_PROVIDER = "openai-codex"; // matches MapleLens tools/jev/worker-pi.mjs's session.modelRuntime.getModel() provider id

/** @returns {Promise<boolean>} true when the Pi SDK is installed and importable. */
export async function piAvailable() {
  try {
    await import("@earendil-works/pi-coding-agent");
    return true;
  } catch {
    return false;
  }
}

async function git(cwd, args) {
  const { stdout } = await execFileAsync("git", args, {
    cwd,
    encoding: "utf8",
    timeout: 60_000,
    windowsHide: true,
    maxBuffer: 16 * 1024 * 1024,
  });
  return stdout.trim();
}

/**
 * The MAIN checkout root for `root` (parent of git's common dir), so a run started from inside a linked
 * worktree still creates its worktree at <main>/.worktrees/<slug> and never nests (D055/D065). Falls back
 * to `root` when the common dir cannot be resolved (bare repo, not a repo).
 */
export async function mainRootOf(root) {
  try {
    const common = path.resolve(root, await git(root, ["rev-parse", "--git-common-dir"]));
    return path.basename(common) === ".git" ? path.dirname(common) : root;
  } catch {
    return root;
  }
}

function slugify(text) {
  return (
    String(text ?? "")
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 40) || "task"
  );
}

/** Throws unless `target` is a pi-run worktree under `<root>/.worktrees`. */
export function assertPiWorktree(root, target) {
  const base = path.resolve(root, ".worktrees") + path.sep;
  const resolved = path.resolve(target);
  if (!resolved.startsWith(base) || !path.basename(resolved).startsWith(PREFIX) || path.dirname(resolved) + path.sep !== base) {
    throw new Error(`refusing to operate outside a pi-run worktree: ${resolved}`);
  }
  return resolved;
}

function linkNodeModules(root, wt) {
  const link = path.join(wt, "node_modules");
  if (existsSync(link) || !existsSync(path.join(root, "node_modules"))) return;
  try {
    symlinkSync(path.join(root, "node_modules"), link, "junction");
  } catch {
    /* best-effort — a fresh install still works, just slower */
  }
}

/** Unlink WITHOUT following — must run before any recursive delete (see worktree.mjs's own comment; this is the Windows-junction hazard maple-lib.sh's maple_remove_worktree also guards against). */
function unlinkNodeModules(wt) {
  const link = path.join(wt, "node_modules");
  try {
    if (lstatSync(link).isSymbolicLink()) rmdirSync(link);
  } catch {
    /* not present */
  }
}

/**
 * Create an isolated worktree, run one Pi prompt in it, capture the diff,
 * then remove the worktree (junction-safe) regardless of outcome.
 *
 * @param {object} args
 * @param {string} args.root repo root
 * @param {string} args.task short task description (used for the branch slug)
 * @param {string} args.prompt full prompt to hand Pi
 * @param {string} [args.model] a plugin/scripts/jev/ladder.mjs Pi rung
 *   ("gpt-5.6-luna"/"gpt-5.6-terra"/"gpt-5.6-sol"). Defaults to
 *   DEFAULT_PI_MODEL (gpt-5.6-luna) — the owner decision that Pi's
 *   cheapest model is the default rung, not an afterthought.
 * @returns {Promise<{summary:string, diff:string, branch:string, model:string}>}
 */
export async function runPi({ root, task, prompt, model = DEFAULT_PI_MODEL }) {
  if (!(await piAvailable())) {
    const err = new Error("Pi worker unavailable: @earendil-works/pi-coding-agent is not installed");
    err.piUnavailable = true;
    throw err;
  }
  if (!isPiModel(model)) {
    throw new Error(`runPi() got a non-Pi model "${model}" — route sonnet/opus through the Agent/Task tool instead`);
  }

  const hash = createHash("sha1").update(`${task}:${Date.now()}`).digest("hex").slice(0, 8);
  const dirName = `${PREFIX}${slugify(task)}-${hash}`;
  const mainRoot = await mainRootOf(root);
  const wt = path.join(mainRoot, ".worktrees", dirName);
  const branch = `pi/${slugify(task)}-${hash}`;

  mkdirSync(path.join(mainRoot, ".worktrees"), { recursive: true });
  await git(root, ["worktree", "add", "-q", wt, "-b", branch]);

  try {
    linkNodeModules(root, wt);

    const { createAgentSession } = await import("@earendil-works/pi-coding-agent");
    const { session } = await createAgentSession({ cwd: wt });
    // Select the requested Pi rung — mirrors MapleLens tools/jev/worker-pi.mjs's
    // startModelFor()/session.modelRuntime.getModel() pattern. Not fatal if the
    // SDK can't resolve it (e.g. a future model-name change) — better to run on
    // whatever Pi's own default is than to fail the whole task over model choice.
    try {
      const chosen = session.modelRuntime?.getModel?.(PI_PROVIDER, model);
      if (chosen) await session.setModel(chosen);
    } catch {
      /* fall through on Pi's own default model */
    }
    let output = "";
    session.subscribe((ev) => {
      if (ev.type === "message_update" && ev.assistantMessageEvent?.type === "text_delta") {
        output = `${output}${ev.assistantMessageEvent.delta}`.slice(-6000);
      }
    });

    try {
      await session.prompt(prompt);
    } catch (err) {
      const detail = String(err?.message ?? err);
      const quota = /usage limit|quota|rate limit|429/i.test(detail);
      const wrapped = new Error(`Pi (ChatGPT) error: ${detail}`);
      wrapped.quota = quota;
      throw wrapped;
    } finally {
      try {
        session.dispose();
      } catch {
        /* ignore */
      }
    }

    const diff = await git(wt, ["diff", "HEAD"]).catch(() => "");
    return { summary: output, diff, branch, model };
  } finally {
    unlinkNodeModules(wt);
    try {
      await git(root, ["worktree", "remove", "--force", assertPiWorktree(mainRoot, wt)]);
    } catch {
      /* best-effort cleanup — an orphaned worktree is a `maple-reap` gap, not a crash */
    }
    try {
      await git(root, ["branch", "-D", branch]);
    } catch {
      /* branch may already be gone */
    }
  }
}

// ---- CLI (owner decision: "pi-run.mjs must accept --model and default to
// gpt-5.6-luna") ---------------------------------------------------------
//
//   node plugin/scripts/jev/pi-run.mjs --task "<slug text>" --prompt "<full prompt>" [--model gpt-5.6-terra]
//   … or pipe the prompt on stdin and omit --prompt.
//
// Prints {summary, diff, branch, model} as JSON on stdout. Exit 1 with the
// error message on stderr on failure (piUnavailable/quota flags included).

export function parseCliArgs(argv) {
  const args = { model: DEFAULT_PI_MODEL, task: "", prompt: "" };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--model") args.model = argv[++i] ?? args.model;
    else if (a === "--task") args.task = argv[++i] ?? "";
    else if (a === "--prompt") args.prompt = argv[++i] ?? "";
  }
  return args;
}

function readStdin() {
  return new Promise((resolve) => {
    if (process.stdin.isTTY) return resolve("");
    let buf = "";
    process.stdin.setEncoding("utf8");
    process.stdin.on("data", (c) => (buf += c));
    process.stdin.on("end", () => resolve(buf));
  });
}

function isMain() {
  if (!process.argv[1]) return false;
  const argvUrl = new URL(`file://${process.argv[1].replace(/\\/g, "/")}`).href;
  return import.meta.url === argvUrl;
}

async function main() {
  const args = parseCliArgs(process.argv.slice(2));
  if (!args.prompt) args.prompt = (await readStdin()).trim();
  if (!args.task || !args.prompt) {
    process.stderr.write("usage: pi-run.mjs --task <slug text> --prompt <text> [--model gpt-5.6-luna|gpt-5.6-terra|gpt-5.6-sol]  (or pipe the prompt on stdin)\n");
    process.exitCode = 1;
    return;
  }
  try {
    const result = await runPi({ root: process.env.CLAUDE_PROJECT_DIR || process.cwd(), task: args.task, prompt: args.prompt, model: args.model });
    process.stdout.write(`${JSON.stringify(result)}\n`);
  } catch (err) {
    process.stderr.write(`${err instanceof Error ? err.message : String(err)}\n`);
    process.exitCode = 1;
  }
}

if (isMain()) {
  main();
}
