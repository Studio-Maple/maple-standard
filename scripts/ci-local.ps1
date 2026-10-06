# scripts/ci-local.ps1 - a SHIM for scripts/ci-local.sh (D066: one gate runner, bash is canonical).
#
# The old PowerShell mirror drifted from the bash runner (different tool resolution: predeploy
# tests reported tool-missing and crashed under .ps1 yet passed under .sh), and `bash` on a
# Windows PATH can be WSL's System32\bash.exe, which sees another filesystem. This shim finds
# Git for Windows' bash explicitly - never WSL - and execs ci-local.sh with the same arguments.
#
# Usage:   .\scripts\ci-local.ps1 [fast|gate|heavy] [--full]     (default tier: gate)
# Env:     MAPLE_GATE_SKIP=<reason> as documented in ci-local.sh (SKIP_LIVE_GATE is a deprecated alias)

$ErrorActionPreference = "Continue"
$script = Join-Path $PSScriptRoot "ci-local.sh"

function Find-GitBash {
    $candidates = @()
    $git = Get-Command git -ErrorAction SilentlyContinue
    if ($git) {
        # git --exec-path = <Git>\mingw64\libexec\git-core; bash lives in <Git>\bin (and, in older
        # layouts, <Git>\mingw64\bin).
        $exec = (& git --exec-path) -replace "/", "\"
        if ($exec) {
            $candidates += (Join-Path $exec "..\..\..\bin\bash.exe")
            $candidates += (Join-Path $exec "..\..\bin\bash.exe")
        }
    }
    $candidates += "C:\Program Files\Git\bin\bash.exe"
    $candidates += "C:\Program Files (x86)\Git\bin\bash.exe"
    foreach ($c in $candidates) {
        if (Test-Path $c) { return (Resolve-Path $c).Path }
    }
    return $null
}

if ($env:MAPLE_CI_SHIM_PRINT_BASH -eq "1") {
    # test hook: print the bash this shim would use, run nothing
    $b = Find-GitBash
    if ($b) { Write-Output $b; exit 0 } else { exit 2 }
}

$bash = Find-GitBash
if (-not $bash) {
    Write-Error "ci-local.ps1: Git Bash not found. Install Git for Windows (WSL's bash is deliberately not used)."
    exit 2
}
if ($bash -match "System32") {
    Write-Error "ci-local.ps1: refusing to use WSL bash ($bash)."
    exit 2
}

& $bash $script @args
exit $LASTEXITCODE
