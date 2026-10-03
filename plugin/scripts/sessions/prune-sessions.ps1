<#
.SYNOPSIS
    Archive stale Claude Code desktop sessions so the sidebar stays readable.

.DESCRIPTION
    The desktop app's session list is backed by one JSON file per session card under
    %APPDATA%\Claude\claude-code-sessions\<installId>\<workspaceId>\local_<sessionId>.json.
    A card leaves the main list when its `isArchived` field is true; archived sessions stay
    fully reopenable from the Archived list, so this is reversible by design and never
    touches a transcript.

    Transcripts (~/.claude/projects/**/*.jsonl) and the memory/ folders that live alongside
    them are NEVER read or written by this script. Only the session-card JSON is modified.

    Default is a DRY RUN: nothing is written until -Apply is passed.

.NOTES
    Flips `isArchived` with a targeted string replace on the raw file so the rest of the
    JSON stays byte-identical (these cards carry large enabledMcpTools maps that a
    PowerShell 5.1 re-serialize would reorder). Only cards missing the field entirely fall
    back to a full parse + rewrite, always written as UTF-8 WITHOUT a BOM -- the app's
    JSON reader rejects a BOM.

.PARAMETER Days
    Archive sessions whose lastActivityAt is older than this many days. Default 7.

.PARAMETER Apply
    Actually write. Without it the script reports what it would archive and exits.

.PARAMETER List
    Report every active session with its age and exit. Ignores -Days thresholds.

.PARAMETER NoBackup
    Skip the pre-change zip. Only meaningful with -Apply.

.PARAMETER KeepBackups
    How many backup zips to retain in ~\.claude\backups\sessions. Default 5.

.EXAMPLE
    prune-sessions.ps1
    Dry run at the default 7-day cutoff.

.EXAMPLE
    prune-sessions.ps1 -Days 14 -Apply
    Back up, then archive everything untouched for more than 14 days.
#>

[CmdletBinding()]
param(
    [int]$Days = 7,
    [switch]$Apply,
    [switch]$List,
    [switch]$NoBackup,
    [int]$KeepBackups = 5
)

$ErrorActionPreference = 'Stop'

$script:StoreRoot    = Join-Path $env:APPDATA 'Claude\claude-code-sessions'
$script:ProtectPath  = Join-Path $env:USERPROFILE '.claude\session-prune.json'
$script:BackupDir    = Join-Path $env:USERPROFILE '.claude\backups\sessions'

# ---------------------------------------------------------------------------
# Protect list -- ~\.claude\session-prune.json, all keys optional:
#   {
#     "protectSessionIds": ["local_4a7f9e83-..."],
#     "protectTitles":     ["ביקורת חיוב מלאה"],      // exact match
#     "protectTitlePatterns": ["^Nightly heal"],        // regex
#     "protectCwdPatterns":   ["\\\\Maple-Pole$"]       // regex on the session's cwd
#   }
# A protected session is never archived, however old it is.
# ---------------------------------------------------------------------------
function Get-ProtectList {
    $empty = [pscustomobject]@{
        SessionIds    = @()
        Titles        = @()
        TitlePatterns = @()
        CwdPatterns   = @()
    }
    if (-not (Test-Path $script:ProtectPath)) { return $empty }
    try {
        $raw = [System.IO.File]::ReadAllText($script:ProtectPath)
        if ([string]::IsNullOrWhiteSpace($raw)) { return $empty }
        $cfg = $raw | ConvertFrom-Json
        return [pscustomobject]@{
            SessionIds    = @($cfg.protectSessionIds)     | Where-Object { $_ }
            Titles        = @($cfg.protectTitles)         | Where-Object { $_ }
            TitlePatterns = @($cfg.protectTitlePatterns)  | Where-Object { $_ }
            CwdPatterns   = @($cfg.protectCwdPatterns)    | Where-Object { $_ }
        }
    } catch {
        Write-Warning "ignoring malformed $($script:ProtectPath): $($_.Exception.Message)"
        return $empty
    }
}

function Test-Protected {
    param($Session, $Protect)
    if ($Protect.SessionIds -contains $Session.SessionId) { return 'sessionId' }
    if ($Session.Title -and ($Protect.Titles -contains $Session.Title)) { return 'title' }
    foreach ($p in $Protect.TitlePatterns) { if ($Session.Title -and $Session.Title -match $p) { return "title ~ $p" } }
    foreach ($p in $Protect.CwdPatterns)   { if ($Session.Cwd   -and $Session.Cwd   -match $p) { return "cwd ~ $p" } }
    return $null
}

# ---------------------------------------------------------------------------
# Read the store. Cheap regex pass for the two fields that decide the sweep;
# full parse only for the handful of cards we actually report on.
# ---------------------------------------------------------------------------
function Get-SessionCards {
    if (-not (Test-Path $script:StoreRoot)) {
        throw "session store not found at $script:StoreRoot -- is the Claude Code desktop app installed for this user?"
    }
    $files = Get-ChildItem $script:StoreRoot -Recurse -File -Filter 'local_*.json' -ErrorAction SilentlyContinue
    foreach ($f in $files) {
        $raw = [System.IO.File]::ReadAllText($f.FullName)
        $mAct  = [regex]::Match($raw, '"lastActivityAt"\s*:\s*(\d+)')
        $mArch = [regex]::Match($raw, '"isArchived"\s*:\s*(true|false)')
        if (-not $mAct.Success) { continue }   # not a session card
        [pscustomobject]@{
            Path       = $f.FullName
            SessionId  = [System.IO.Path]::GetFileNameWithoutExtension($f.Name)
            LastMs     = [long]$mAct.Groups[1].Value
            IsArchived = ($mArch.Success -and $mArch.Groups[1].Value -eq 'true')
            HasField   = $mArch.Success
            Title      = $null
            Cwd        = $null
        }
    }
}

function Add-CardDetail {
    param($Cards)
    foreach ($c in $Cards) {
        try {
            $o = [System.IO.File]::ReadAllText($c.Path) | ConvertFrom-Json
            $c.Title = $o.title
            $c.Cwd   = $o.cwd
        } catch {
            $c.Title = '<unparseable>'
        }
        $c
    }
}

# ---------------------------------------------------------------------------
function New-StoreBackup {
    if (-not (Test-Path $script:BackupDir)) { New-Item -ItemType Directory -Path $script:BackupDir -Force | Out-Null }
    $zip = Join-Path $script:BackupDir ("sessions-{0}.zip" -f (Get-Date -Format 'yyyyMMdd-HHmmss'))
    Compress-Archive -Path $script:StoreRoot -DestinationPath $zip -CompressionLevel Optimal -Force
    $kept = Get-ChildItem $script:BackupDir -Filter 'sessions-*.zip' | Sort-Object LastWriteTime -Descending
    if ($kept.Count -gt $KeepBackups) {
        $kept | Select-Object -Skip $KeepBackups | ForEach-Object { Remove-Item $_.FullName -Force }
    }
    return $zip
}

function Set-CardArchived {
    param([string]$Path, [bool]$HasField)

    $raw = [System.IO.File]::ReadAllText($Path)
    if ($HasField) {
        # Targeted replace keeps every other byte intact.
        $new = [regex]::Replace($raw, '"isArchived"\s*:\s*false', '"isArchived":true', 1)
        if ($new -eq $raw) { throw 'isArchived was not false' }
    } else {
        $o = $raw | ConvertFrom-Json
        $o | Add-Member -NotePropertyName isArchived -NotePropertyValue $true -Force
        $new = $o | ConvertTo-Json -Depth 100 -Compress
    }
    # UTF-8 with NO BOM -- a BOM makes the app drop the card.
    [System.IO.File]::WriteAllText($Path, $new, (New-Object System.Text.UTF8Encoding($false)))
}

# ---------------------------------------------------------------------------
# Main
# ---------------------------------------------------------------------------
$protect = Get-ProtectList
$all     = @(Get-SessionCards)
$active  = @($all | Where-Object { -not $_.IsArchived })

if ($List) {
    Write-Host ("store: {0}" -f $script:StoreRoot)
    Write-Host ("cards: {0} total, {1} active, {2} archived`n" -f $all.Count, $active.Count, ($all.Count - $active.Count))
    Add-CardDetail $active | Sort-Object LastMs | ForEach-Object {
        $age = [math]::Round(((Get-Date) - [datetimeoffset]::FromUnixTimeMilliseconds($_.LastMs).LocalDateTime).TotalDays, 1)
        $tag = if (Test-Protected $_ $protect) { 'PROTECTED' } else { '' }
        '{0,6}d  {1,-9} {2,-52} {3}' -f $age, $tag, $_.Title, $_.Cwd
    }
    return
}

if ($Days -lt 1) { throw "-Days must be at least 1 (got $Days)" }
$cutoffMs = [datetimeoffset]::new((Get-Date).AddDays(-$Days)).ToUnixTimeMilliseconds()
$cutoffAt = (Get-Date).AddDays(-$Days)

$stale     = @(Add-CardDetail @($active | Where-Object { $_.LastMs -lt $cutoffMs }))
$protected = @($stale | Where-Object { Test-Protected $_ $protect })
$targets   = @($stale | Where-Object { -not (Test-Protected $_ $protect) })

Write-Host ("store:   {0}" -f $script:StoreRoot)
Write-Host ("cutoff:  {0:yyyy-MM-dd HH:mm} ({1} days)" -f $cutoffAt, $Days)
Write-Host ("cards:   {0} total, {1} active, {2} stale, {3} protected, {4} to archive`n" -f `
    $all.Count, $active.Count, $stale.Count, $protected.Count, $targets.Count)

if ($protected.Count -gt 0) {
    Write-Host 'protected (kept regardless of age):'
    $protected | Sort-Object LastMs | ForEach-Object {
        '  {0}  [{1}]  -- {2}' -f $_.Title, $_.Cwd, (Test-Protected $_ $protect)
    }
    Write-Host ''
}

if ($targets.Count -eq 0) {
    Write-Host 'nothing to archive.'
    return
}

Write-Host ('{0}:' -f $(if ($Apply) { 'archiving' } else { 'would archive (dry run -- pass -Apply to write)' }))
$targets | Sort-Object LastMs | ForEach-Object {
    $age = [math]::Round(((Get-Date) - [datetimeoffset]::FromUnixTimeMilliseconds($_.LastMs).LocalDateTime).TotalDays, 1)
    '  {0,6}d  {1,-52} {2}' -f $age, $_.Title, $_.Cwd
}

if (-not $Apply) {
    Write-Host ("`n{0} session(s) would be archived. Re-run with -Apply." -f $targets.Count)
    return
}

if (-not $NoBackup) {
    $zip = New-StoreBackup
    Write-Host ("`nbackup: {0} ({1:N1} MB)" -f $zip, ((Get-Item $zip).Length / 1MB))
}

$ok = 0; $failed = @()
foreach ($t in $targets) {
    try { Set-CardArchived -Path $t.Path -HasField $t.HasField; $ok++ }
    catch { $failed += "$($t.Title): $($_.Exception.Message)" }
}

Write-Host ("`narchived {0} session(s); {1} active remain." -f $ok, ($active.Count - $ok))
if ($failed.Count -gt 0) {
    Write-Host 'failures:'
    $failed | ForEach-Object { "  $_" }
}
Write-Host 'restart the Claude Code desktop app to refresh the sidebar.'
