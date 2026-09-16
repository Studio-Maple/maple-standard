---
description: Audit idle Docker stacks (dstack) and ask before archiving anything.
allowed-tools: ["Bash", "AskUserQuestion"]
---

Run `dstack ls` and `dstack audit` (PowerShell function; falls back to
`& "C:\Projects\Studio-Maple\maple-standard\plugin\scripts\docker\dstack.ps1" ls` / `audit`
if the `dstack` function isn't loaded in this shell).

Summarize which stacks are idle more than 14 days (from the audit output), with their
project dir and last-used date. Stacks that are running, or idle under 14 days, are just
context — do not propose archiving them.

If one or more stacks are idle > 14 days: use **AskUserQuestion** to ask which of them (if
any) to archive. Multi-select, one option per idle stack plus "None — just checked in."
Never run `dstack archive` without an explicit yes from that question — audit is
report-only by design.

If the user approves one or more stacks, run `dstack archive <stack> -Confirm` for each
approved stack, one at a time, and report the result. If none are idle, just report that
and stop — no question needed.
