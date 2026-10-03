---
description: Archive stale Claude Code desktop sessions (dry-run first) so the sidebar stays readable.
allowed-tools: ["Bash", "PowerShell", "AskUserQuestion", "Read", "Write"]
---

Prune the desktop app's session sidebar by archiving cards nobody has touched in a while.
Archiving is reversible — archived sessions stay fully reopenable from the Archived list —
and **no transcript is ever touched**: `~/.claude/projects/**/*.jsonl` and the `memory/`
folders that live beside them are never read or written by this command.

## Run

Always start with the dry run (this is the default — the script writes nothing without `-Apply`):

```
powershell -NoProfile -File "$CLAUDE_PLUGIN_ROOT/scripts/sessions/prune-sessions.ps1" -Days 7
```

Report the counts (`total / active / stale / protected / to archive`) and the list of
sessions it would archive, with ages. Then use **AskUserQuestion** to confirm before
writing — options should cover: apply at this cutoff, a different `-Days`, add something to
the protect list, or cancel. Never pass `-Apply` without an explicit yes.

On approval:

```
powershell -NoProfile -File "$CLAUDE_PLUGIN_ROOT/scripts/sessions/prune-sessions.ps1" -Days 7 -Apply
```

Relay the archived count, the backup zip path, and tell the user to **restart the desktop
app** — a running app holds the old sidebar in memory.

`-List` reports every active session with its age and protect status, no cutoff logic —
use it when the user just wants to see what's open.

## Flags

| Flag | Default | Meaning |
|---|---|---|
| `-Days <n>` | `7` | Archive sessions whose last activity is older than this |
| `-Apply` | off | Actually write; without it the run is a dry run |
| `-List` | off | Report active sessions and exit |
| `-NoBackup` | off | Skip the pre-change zip (only with `-Apply`) |
| `-KeepBackups <n>` | `5` | Backup zips retained in `~/.claude/backups/sessions` |

## Protect list

`~/.claude/session-prune.json` — sessions matched here are never archived, however old.
All keys optional; create the file if the user wants something pinned:

```json
{
  "protectSessionIds": ["local_4a7f9e83-a571-4b2b-9cb3-877238be7ade"],
  "protectTitles": ["ביקורת חיוב מלאה"],
  "protectTitlePatterns": ["^Nightly heal"],
  "protectCwdPatterns": ["\\\\Maple-Pole$"]
}
```

`protectTitles` is an exact match; the `*Patterns` keys are .NET regex (so backslashes in a
Windows path need escaping twice — once for JSON, once for regex). A malformed file warns
and is ignored rather than blocking the run.

## How it works

The sidebar is backed by one JSON card per session under
`%APPDATA%\Claude\claude-code-sessions\<installId>\<workspaceId>\local_<sessionId>.json`;
a card leaves the main list when its `isArchived` field is `true`. The script flips that one
field with a targeted string replace so the rest of the card stays byte-identical, and
writes UTF-8 **without a BOM** — the app silently drops a card whose JSON starts with one.

## Caveats

- **Restart the app after applying.** The running app keeps the sidebar in memory, and a
  session it currently has loaded can get its card rewritten (un-archiving it). Sessions
  that were open during a sweep may reappear — re-run the prune after the restart.
- The main `C:\Projects\Maple-Standard` checkout has `bare = true` in `.git/config`, so git
  work-tree commands fail there. Edit this plugin from a `/wt-start` worktree.
