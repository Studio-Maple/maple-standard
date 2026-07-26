---
description: Watch a parallel session's branch on the one shared dev server
---

# /wt-preview — Watch a parallel session's branch on the one dev server

Point the single shared dev server at an agent worktree's branch so you can
see its work live and decide whether to keep steering it or stop it. Honors
"one server only" — it frees the port and serves the chosen branch from a
dedicated detached `_preview` worktree, so it never conflicts with the
agent's own checkout.

## Config this command reads (`maple.config.json` at project root)

Canonical keys per `docs/standard-architecture.md` (reconciled #T11):

| Key | Default |
|---|---|
| `worktrees.preview.port` | `8080` |
| `worktrees.preview.workdir` | `"."` (dir, relative to the worktree root, to run the dev command in) |
| `worktrees.preview.command` | `"npm run dev -- --port {port} --host 127.0.0.1"` — `{port}` is substituted |
| `worktrees.preview.logFile` | `".preview-dev.log"` (relative to the preview worktree) |
| `worktrees.nodeModulesDirs` / `worktrees.envFiles` | same as `/wt-start` — linked into the preview worktree too |

Malformed config? Run
`node "$CLAUDE_PLUGIN_ROOT/scripts/validate-config.mjs"`.

## Arguments

`$ARGUMENTS` — `<slug>` of the worktree to preview, or `--stop` to stop the preview server.
- `--port <N>` → use a port other than the configured default (e.g. to preview without killing your main dev server).

## Run

```bash
bash "$CLAUDE_PLUGIN_ROOT/scripts/agent-wt/maple-preview.sh" $ARGUMENTS
```

The dev server starts in the background; report the URL the script prints
(default `http://127.0.0.1:8080`, or your configured port). Switch to
another branch by re-running with a different slug; stop with
`/wt-preview --stop`. Note: only one branch previews at a time (one server).

## Gap vs. the VeHagita original

The source command hardcoded `cd frontend && npm run dev -- --port N --host
127.0.0.1`. This version runs `worktrees.preview.command` (with `{port}`
substituted) from `worktrees.preview.workdir` — generic, but **the adopting
project must configure its own dev command** if it isn't a plain `npm run
dev` at the repo root.
