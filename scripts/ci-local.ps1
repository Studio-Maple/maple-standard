# scripts/ci-local.ps1 — Windows-native mirror of scripts/ci-local.sh.
#
# Same four tiers, same semantics (see ci-local.sh's header comment for the
# full rationale). This script never shells out to bash — it runs the exact
# same pnpm/node commands directly, so it works on a bare Windows box with
# no Git Bash / WSL requirement.
#
# Usage:
#   .\scripts\ci-local.ps1 [fast|gate|core|full]   (default: gate)
#
# Escape hatch (NOT --no-verify — this template's CLAUDE.md forbids that):
#   $env:SKIP_LIVE_GATE = "1"; .\scripts\ci-local.ps1

[CmdletBinding()]
param(
    [Parameter(Position = 0)]
    [ValidateSet("fast", "gate", "core", "full")]
    [string]$Tier = "gate"
)

# "Continue", not "Stop": every native call below is explicitly
# $LASTEXITCODE-checked (Invoke-Checked), and under Windows PowerShell 5.1
# a Stop preference turns harmless native stderr output (e.g. docs-drift
# warnings) into a terminating NativeCommandError when streams are merged.
$ErrorActionPreference = "Continue"
$repoRoot = Split-Path -Parent $PSScriptRoot
Set-Location $repoRoot

function Step($msg) { Write-Host ""; Write-Host "--- $msg ---" -ForegroundColor Cyan }
function Die($msg) { Write-Host ""; Write-Error "x $msg"; exit 1 }

function Invoke-Checked([string]$Command) {
    Write-Host "> $Command" -ForegroundColor DarkGray
    Invoke-Expression $Command
    if ($LASTEXITCODE -ne 0) { Die "command failed: $Command" }
}

function Run-Fast {
    Step "fast 1/6: lint (eslint --max-warnings=0, incl. eslint-plugin-security)"
    Invoke-Checked "pnpm run lint:ci"

    Step "fast 2/6: typecheck (tsc --noEmit)"
    Invoke-Checked "pnpm run typecheck"

    Step "fast 3/6: knip (dead code - fails on regressions)"
    Invoke-Checked "pnpm run knip"

    Step "fast 4/6: dependency-cruiser (module boundaries)"
    try { Invoke-Checked "pnpm run depcruise" }
    catch { Write-Host "(depcruise: advisory findings - not blocking unless an 'error' rule fired)" -ForegroundColor Yellow }

    Step "fast 5/6: unit + component tests (vitest)"
    Invoke-Checked "pnpm run test"

    Step "fast 6/6: build (next build) + docs-drift"
    Invoke-Checked "pnpm run build"
    Invoke-Checked "node scripts/check-docs-drift.mjs"
}

function Stack-Up {
    try {
        # pnpm exec — a bare `supabase` resolves to whatever global CLI is on
        # PATH, which can be older than the project's and fail parsing config.toml.
        & pnpm exec supabase status -o env *> $null
        return ($LASTEXITCODE -eq 0)
    } catch { return $false }
}

function Require-Stack {
    if (-not (Stack-Up)) {
        Die @"
Local Supabase not reachable.
   Bring it up in another shell:
     pnpm supabase:start; pnpm supabase:reset
   (needs Docker Desktop). To push from a no-Docker box anyway:
     `$env:SKIP_LIVE_GATE = "1"; git push   # runs fast tier only, records the skip
"@
    }
}

function Check-TypesFresh {
    Step "types-freshness: src/types/database.types.ts vs local schema"
    Invoke-Checked "node scripts/check-types-fresh.mjs"
}

function Run-Live([string]$PlaywrightArgs, [string]$Label) {
    Require-Stack

    Step "live: Supabase RLS + trigger suite"
    Invoke-Checked "pnpm run test:supabase"

    Step "live: Playwright - $Label"
    Invoke-Checked "pnpm exec playwright test --config e2e/playwright.config.ts $PlaywrightArgs"
}

function Run-Audit {
    Step "full: pnpm audit (SCA)"
    try { Invoke-Checked "pnpm audit --audit-level=high" }
    catch { Write-Host "(pnpm audit: high/critical advisories - triage)" -ForegroundColor Yellow }
}

if ($env:SKIP_LIVE_GATE -eq "1") {
    Write-Host "!! SKIP_LIVE_GATE=1 - running fast tier ONLY. The live gate (RLS + E2E) was SKIPPED." -ForegroundColor Yellow
    Run-Fast
    Write-Host ""
    Write-Host "fast tier passed. LIVE GATE SKIPPED - re-run with the local Supabase stack up." -ForegroundColor Yellow
    exit 0
}

switch ($Tier) {
    "fast" {
        Run-Fast
        Write-Host ""; Write-Host "fast tier passed (no live checks - use 'gate' before push)." -ForegroundColor Green
    }
    "gate" {
        Run-Fast
        Check-TypesFresh
        Run-Live "--grep @smoke --project=desktop" "@smoke (desktop)"
        Write-Host ""; Write-Host "gate passed - safe to push." -ForegroundColor Green
    }
    "core" {
        Run-Fast
        Check-TypesFresh
        Run-Live "--project=desktop" "all specs (desktop)"
        Write-Host ""; Write-Host "core passed - fast + RLS + full desktop E2E green (pre-merge)." -ForegroundColor Green
    }
    "full" {
        Run-Fast
        Check-TypesFresh
        Run-Live "" "all specs, all projects"
        Run-Audit
        Write-Host ""; Write-Host "full passed - fast + RLS + full E2E + audit." -ForegroundColor Green
    }
}
