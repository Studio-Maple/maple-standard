---
description: "Targeted code review focused on a specific aspect"
argument-hint: "<free-text description of what to review>"
allowed-tools: ["Bash", "Glob", "Grep", "Read", "Task"]
---

# Review: $ARGUMENTS

Review the current changes (or staged work) with focus on the aspect described above.

## Steps

1. Identify scope of changes:
   - `git status` for modified/untracked files
   - `git diff --name-only` for changed files
   - `git diff` for actual changes
   - If a PR exists: `gh pr view`

2. Pick the right reviewer(s) based on the aspect described in `$ARGUMENTS`. Use the pr-review-toolkit agents — match by what the user asked for, not by file types:

   | If the aspect is about... | Spawn agent |
   |---|---|
   | bugs, logic, conventions, general quality | `pr-review-toolkit:code-reviewer` |
   | error handling, catch blocks, fallbacks, silent failures | `pr-review-toolkit:silent-failure-hunter` |
   | type design, invariants, encapsulation | `pr-review-toolkit:type-design-analyzer` |
   | comments, docstrings, doc accuracy | `pr-review-toolkit:comment-analyzer` |
   | tests, coverage, edge cases | `pr-review-toolkit:pr-test-analyzer` |
   | simplification, clarity, readability | `pr-review-toolkit:code-simplifier` |

   If the aspect spans multiple categories (e.g. "review my error handling and tests"), launch the matching agents in parallel — one Task per agent in a single message.

   If the aspect is vague ("review this", "look at my changes"), default to `pr-review-toolkit:code-reviewer` only — don't spam every agent. Ask the user to narrow if needed.

3. When briefing each agent, pass:
   - The user's exact aspect description (`$ARGUMENTS`)
   - The list of changed files
   - That this is a focused review, not a full PR audit

4. Aggregate results into a tight summary:
   - **Critical** (blocks merge)
   - **Important** (should fix)
   - **Suggestions** (nice-to-have)
   - File:line references throughout
   - No fluff — the user reads the diff themselves

## Notes

- Keep the response focused on findings — no preamble.
- If no aspect is provided (`$ARGUMENTS` empty), ask via AskUserQuestion which aspect to focus on rather than defaulting to "review everything."
- For pre-PR comprehensive sweeps, the user can still run `/pr-review-toolkit:review-pr all` directly.
