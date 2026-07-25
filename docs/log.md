---
type: ledger
title: Session log
description: append-only session history (`S###`, 1-2 sentences each).
tags: [log, session-history]
timestamp: 2026-07-25
audience: owner + future sessions (history scan)
authoritative_for: [what happened when. Append-only, newest first]
code: [node scripts/next-task-id.mjs --add --session --title "..." --body "..."]
---
# Session log

Each entry: `## S### | YYYY-MM-DD | title` + 1-2 sentences (≤600 chars,
gate-enforced). Detail belongs in CHANGELOG.md.

## S001 | 2026-07-15 | Project instantiated
Instantiated from the maple-standard template.
