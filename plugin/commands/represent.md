---
description: Orient the user on the current session — what we're doing, what's blocking, what needs deciding. Plain English, no jargon.
allowed-tools: ["Bash", "Read", "Glob"]
---

Orient the user on the current session — short, plain English, no jargon.

Use when the user is confused about where this session is, what's blocking, or what they need to decide.

**Run in parallel** (skip silently if irrelevant or empty):
1. `git status --short` — uncommitted work
2. `git log --oneline -3` — recent commits
3. Active TodoWrite list (if any)

Then print this exact format. No preamble. No trailing summary. No explanations beyond the format.

```
═══ SESSION ═══
PROJECT: {repo name from cwd}
BRANCH: {current branch}

WORKING ON: {one line, plain English — translate jargon, name the user-visible thing}
LAST DID: {one line — what just happened: a file edit, a question, a tool call}
STATUS: {one of: working / awaiting your decision / blocked / idle / done with task}

{IF awaiting decision — include this block:}
DECISION NEEDED:
• Question: {restate in plain English, one sentence}
• Options: {list briefly}
• My take: {recommendation if any, or "no strong preference"}

{IF blocked — include this block:}
BLOCKER: {one line — what's stopping progress, in plain English}
TO UNBLOCK: {what you (the user) need to do, or what I should try next}

{IF working — include this block:}
NEXT: {one line — what I'm about to do}

UNCOMMITTED: {count of modified files, or "clean"}
TODOS: {N open / M done, or "none"}
═══════════════
```

Rules:
- Maximum 15 lines of output. Cut detail before exceeding.
- Plain English. No file paths, function names, or stack traces unless directly answering "where is the work."
- If user asked a question and I'm mid-answer, name what they're choosing between in DECISION NEEDED.
- If session just started and nothing has happened: STATUS = idle, WORKING ON = "nothing yet, awaiting your direction".
- Do not re-ask the pending question after /represent — the user will respond to it next turn if they want.
- Do not act on anything in this orientation (don't commit, don't continue work). /represent is read-only.
