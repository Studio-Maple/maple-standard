---
type: ledger
title: Gaps
description: things the owner flagged as missing or wrong. Check at session start.
tags: [gaps, governance]
timestamp: 2026-07-25
audience: agents — check at session start
authoritative_for: [things the owner flagged as missing, wrong, or unresolved]
---
# Gaps

Flat bullets, one gap per line. When a gap is resolved, delete the bullet
(the resolution belongs in [[decisions]] or the owning doc).

- **`goals.md` should join the standard docs structure** (index / gaps / tasks / log / decisions + goals): a short ranked list of what matters now per app plus standing policy — what an advisor may do alone, what always waits for the owner. Read by every session and by MapleLens's advisor. Raised from MapleLens D014/[[maplelens]], 2026-09-10.
- **Standard-wide convention: gates run locally before push; CI only deploys.** Build/typecheck/tests/docs gate run on the machine that pushes (hooks); GitHub Actions deploys the dev tier only when a landing is marked *major*, never re-runs the suite — keeps GitHub minutes near zero and deploy tokens in CI secrets only. Raised from MapleLens D017, 2026-09-10.
