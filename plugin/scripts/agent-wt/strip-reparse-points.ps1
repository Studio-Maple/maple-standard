# strip-reparse-points.ps1 -Root <dir>
#
# Delete every reparse point (junction / directory symlink / file symlink)
# INSIDE <dir> — the LINKS themselves, never their targets.
#
# Why this exists (2026-07-30, maple-pole): Next.js/Turbopack writes
# junctions under `.next/node_modules/` (require-in-the-middle-<hash>,
# import-in-the-middle-<hash>) whose targets are the MAIN checkout's real
# `.pnpm` package dirs. `git worktree remove --force` follows junctions in
# its recursive delete (verified: it empties the TARGET and leaves the dir),
# so tearing down a worktree that still contains those links deleted the
# main tree's real package files (three incidents, 2026-07-28..30).
# Stripping all links first makes any subsequent recursive delete safe.
#
# The walk deliberately does NOT descend through reparse points: Windows
# PowerShell 5.1's `Get-ChildItem -Recurse` FOLLOWS junctions, which would
# enumerate links OUTSIDE the tree (e.g. the whole main node_modules through
# a still-present worktree node_modules junction) and delete those too.
# Deleting a link via .Delete() removes only the reparse point — documented
# .NET behavior for both DirectoryInfo (junction/symlink) and FileInfo.
param([Parameter(Mandatory = $true)][string]$Root)

$ErrorActionPreference = 'SilentlyContinue'

$rootItem = Get-Item -LiteralPath $Root -Force -ErrorAction SilentlyContinue
if ($null -eq $rootItem) { exit 0 }
# If the root itself is a link, there is nothing INSIDE it we own — bail.
if ($rootItem.Attributes -band [IO.FileAttributes]::ReparsePoint) { exit 0 }

$queue = New-Object System.Collections.Queue
$queue.Enqueue($rootItem)
while ($queue.Count -gt 0) {
  $dir = $queue.Dequeue()
  foreach ($e in @(Get-ChildItem -LiteralPath $dir.FullName -Force -ErrorAction SilentlyContinue)) {
    if ($e.Attributes -band [IO.FileAttributes]::ReparsePoint) {
      try { $e.Delete() } catch {
        # rmdir removes a stubborn junction without recursing; del for files
        cmd /c rmdir "$($e.FullName)" 2>$null
        if (Test-Path -LiteralPath $e.FullName) { cmd /c del /f /q "$($e.FullName)" 2>$null }
      }
    } elseif ($e.PSIsContainer) {
      $queue.Enqueue($e)
    }
  }
}
exit 0
