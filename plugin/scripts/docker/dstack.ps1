<#
.SYNOPSIS
    Docker stack manager for compose/Supabase-CLI stacks on a dev machine.

.DESCRIPTION
    Stack identity = the `com.docker.compose.project` container label (works for both
    plain `docker compose` stacks and `supabase start` stacks, which stamp the same label).

    Because every container in scope has had its restart policy pinned to `--restart=no`,
    a container's StartedAt/FinishedAt only change when a human explicitly starts it again.
    That makes those timestamps a TRUE "last used" signal -- this script leans on that fact
    everywhere it computes idle time. `dstack up` re-strips the policy on every start because
    `supabase start` silently re-stamps `unless-stopped` on its containers; skipping that step
    lets the original problem (44 containers auto-launching on every Windows boot) come back.

.NOTES
    No external dependencies (no jq). Everything is parsed from `docker inspect --format`.
#>

[CmdletBinding()]
param(
    [Parameter(Position = 0)]
    [ValidateSet('ls', 'up', 'down', 'audit', 'archive', 'prune')]
    [string]$Command,

    [Parameter(Position = 1)]
    [string]$Stack,

    [int]$Days = 14,

    [switch]$Confirm
)

$ErrorActionPreference = 'Stop'

$script:RegistryPath = 'C:\Users\Maayan Margolin\.claude\docker-stacks.json'

# ---------------------------------------------------------------------------
# Registry (fallback project-dir map for containers that don't carry the
# com.docker.compose.project.working_dir label -- e.g. Supabase CLI containers)
# ---------------------------------------------------------------------------

function Initialize-StackRegistry {
    if (Test-Path -LiteralPath $script:RegistryPath) { return }

    $dir = Split-Path -Parent $script:RegistryPath
    if (-not (Test-Path -LiteralPath $dir)) {
        New-Item -ItemType Directory -Path $dir -Force | Out-Null
    }

    $default = [ordered]@{
        'caller'            = 'C:\Projects\Caller'
        'caller-call-plane' = 'C:\Projects\Caller\services\call-plane'
        'vehagita-local'    = 'C:\Projects\VeHagita'
    }
    ($default | ConvertTo-Json) | Set-Content -LiteralPath $script:RegistryPath -Encoding utf8
    Write-Host "Created stack registry: $script:RegistryPath" -ForegroundColor DarkGray
}

function Get-StackRegistry {
    Initialize-StackRegistry
    try {
        $json = Get-Content -LiteralPath $script:RegistryPath -Raw | ConvertFrom-Json
    } catch {
        Write-Warning "Could not parse registry file at $script:RegistryPath -- ignoring it."
        return @{}
    }
    $map = @{}
    if ($null -ne $json) {
        foreach ($prop in $json.PSObject.Properties) {
            $map[$prop.Name] = $prop.Value
        }
    }
    return $map
}

# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------

function Convert-DockerPathToWindows {
    param([string]$Path)
    if ([string]::IsNullOrWhiteSpace($Path)) { return $Path }
    if ($Path -match '^/mnt/([a-zA-Z])/(.*)$') {
        $drive = $Matches[1].ToUpper()
        $rest = $Matches[2] -replace '/', '\'
        return "${drive}:\$rest"
    }
    return $Path
}

function ConvertTo-NullableDate {
    param([string]$Value)
    if ([string]::IsNullOrWhiteSpace($Value)) { return $null }
    if ($Value -eq '0001-01-01T00:00:00Z') { return $null }
    try {
        return [datetime]::Parse($Value, [System.Globalization.CultureInfo]::InvariantCulture)
    } catch {
        return $null
    }
}

# ---------------------------------------------------------------------------
# Inventory
# ---------------------------------------------------------------------------

function Get-ContainerInventory {
    $ids = @(docker ps -aq)
    if (-not $ids -or $ids.Count -eq 0) { return @() }

    # NOTE: Go template string literals use backticks here, not double quotes --
    # PowerShell mangles embedded double quotes when passing args to a native exe.
    $fmt = '{{.Id}}|||{{.Name}}|||{{.State.Running}}|||{{.State.StartedAt}}|||{{.State.FinishedAt}}|||' +
           '{{index .Config.Labels `com.docker.compose.project`}}|||' +
           '{{index .Config.Labels `com.docker.compose.project.working_dir`}}|||' +
           '{{.HostConfig.RestartPolicy.Name}}'

    $raw = docker inspect @ids --format $fmt
    if ($LASTEXITCODE -ne 0) {
        throw "docker inspect failed while building container inventory."
    }

    $result = @()
    foreach ($line in $raw) {
        if ([string]::IsNullOrWhiteSpace($line)) { continue }
        $parts = $line -split '\|\|\|'
        if ($parts.Count -lt 8) { continue }

        $workingDir = $parts[6]
        if ($workingDir -eq '<no value>' -or [string]::IsNullOrWhiteSpace($workingDir)) {
            $workingDir = $null
        } else {
            $workingDir = Convert-DockerPathToWindows $workingDir
        }

        $result += [pscustomobject]@{
            Id             = $parts[0]
            Name           = $parts[1].TrimStart('/')
            Running        = ($parts[2] -eq 'true')
            StartedAt      = ConvertTo-NullableDate $parts[3]
            FinishedAt     = ConvertTo-NullableDate $parts[4]
            Project        = $parts[5]
            WorkingDirRaw  = $workingDir
            RestartPolicy  = $parts[7]
        }
    }
    return $result
}

function Get-StackInventory {
    $containers = Get-ContainerInventory
    $registry = Get-StackRegistry
    $now = (Get-Date).ToUniversalTime()

    $groups = $containers | Group-Object -Property Project
    $stacks = @()

    foreach ($g in $groups) {
        $name = $g.Name
        $members = $g.Group

        $lastUsed = $null
        foreach ($c in $members) {
            foreach ($ts in @($c.StartedAt, $c.FinishedAt)) {
                if ($null -ne $ts) {
                    if ($null -eq $lastUsed -or $ts -gt $lastUsed) { $lastUsed = $ts }
                }
            }
        }

        $runningCount = @($members | Where-Object { $_.Running }).Count
        $totalCount = $members.Count
        $isRunning = $runningCount -gt 0

        if ($isRunning) {
            $idleDays = 0
            $idleSortKey = 0
        } elseif ($null -eq $lastUsed) {
            $idleDays = $null
            $idleSortKey = [int]::MaxValue
        } else {
            $idleDays = [math]::Floor(($now - $lastUsed).TotalDays)
            $idleSortKey = $idleDays
        }

        $dir = $null
        $dirFromLabel = ($members | Where-Object { $_.WorkingDirRaw } | Select-Object -First 1).WorkingDirRaw
        if ($dirFromLabel) {
            $dir = $dirFromLabel
        } elseif ($registry.ContainsKey($name)) {
            $dir = $registry[$name]
        } else {
            $dir = '(unknown -- add to docker-stacks.json)'
        }

        $stacks += [pscustomobject]@{
            Stack        = $name
            Dir          = $dir
            Running      = $runningCount
            Total        = $totalCount
            LastUsed     = $lastUsed
            IdleDays     = $idleDays
            IdleSortKey  = $idleSortKey
            IsRunning    = $isRunning
            Containers   = $members
        }
    }

    return $stacks
}

function Resolve-Stack {
    param([Parameter(Mandatory)][string]$Name)

    $all = Get-StackInventory
    $match = $all | Where-Object { $_.Stack -eq $Name }
    if (-not $match) {
        $valid = ($all | Select-Object -ExpandProperty Stack) -join ', '
        Write-Host "Stack not found: '$Name'" -ForegroundColor Red
        if ($valid) {
            Write-Host "Valid stack names: $valid"
        } else {
            Write-Host "No stacks found on this machine."
        }
        exit 1
    }
    return $match
}

# ---------------------------------------------------------------------------
# Commands
# ---------------------------------------------------------------------------

function Format-DateOrNever {
    param($d)
    if ($null -eq $d) { return 'never' }
    return $d.ToLocalTime().ToString('yyyy-MM-dd')
}

function Format-IdleOrNever {
    param($stack)
    if ($stack.IsRunning) { return '0 (running)' }
    if ($null -eq $stack.IdleDays) { return 'never used' }
    return "$($stack.IdleDays)"
}

function Invoke-Ls {
    $stacks = Get-StackInventory
    if (-not $stacks -or $stacks.Count -eq 0) {
        Write-Host "No docker-compose / supabase stacks found on this machine."
        return
    }

    $sorted = $stacks | Sort-Object -Property IdleSortKey -Descending

    $rows = foreach ($s in $sorted) {
        [pscustomobject]@{
            STACK      = $s.Stack
            DIR        = $s.Dir
            CONTAINERS = "$($s.Running)/$($s.Total)"
            LAST_USED  = Format-DateOrNever $s.LastUsed
            IDLE_DAYS  = Format-IdleOrNever $s
            STATUS     = if ($s.IsRunning) { 'RUNNING' } else { 'STOPPED' }
        }
    }

    $colStack  = [Math]::Max(5,  ($rows | ForEach-Object { $_.STACK.Length }      | Measure-Object -Maximum).Maximum)
    $colDir    = [Math]::Max(3,  ($rows | ForEach-Object { $_.DIR.Length }        | Measure-Object -Maximum).Maximum)
    $colCont   = [Math]::Max(10, ($rows | ForEach-Object { $_.CONTAINERS.Length } | Measure-Object -Maximum).Maximum)
    $colLast   = [Math]::Max(9,  ($rows | ForEach-Object { $_.LAST_USED.Length }  | Measure-Object -Maximum).Maximum)
    $colIdle   = [Math]::Max(9,  ($rows | ForEach-Object { $_.IDLE_DAYS.Length }  | Measure-Object -Maximum).Maximum)
    $colStatus = [Math]::Max(6,  ($rows | ForEach-Object { $_.STATUS.Length }     | Measure-Object -Maximum).Maximum)

    $line = "{0,-$colStack}  {1,-$colDir}  {2,-$colCont}  {3,-$colLast}  {4,-$colIdle}  {5,-$colStatus}"
    Write-Host ($line -f 'STACK', 'DIR', 'CONTAINERS', 'LAST_USED', 'IDLE_DAYS', 'STATUS')
    Write-Host ($line -f ('-' * $colStack), ('-' * $colDir), ('-' * $colCont), ('-' * $colLast), ('-' * $colIdle), ('-' * $colStatus))
    foreach ($r in $rows) {
        Write-Host ($line -f $r.STACK, $r.DIR, $r.CONTAINERS, $r.LAST_USED, $r.IDLE_DAYS, $r.STATUS)
    }
}

function Invoke-Up {
    param([string]$Name)
    if ([string]::IsNullOrWhiteSpace($Name)) {
        Write-Host "Usage: dstack up <stack>" -ForegroundColor Red
        exit 1
    }
    $s = Resolve-Stack -Name $Name
    $ids = $s.Containers | Select-Object -ExpandProperty Id

    Write-Host "Starting stack '$($s.Stack)' ($($ids.Count) containers)..."
    docker start @ids | Out-Null
    if ($LASTEXITCODE -ne 0) { throw "docker start failed for stack '$($s.Stack)'." }

    $stripped = @()
    foreach ($c in $s.Containers) {
        if ($c.RestartPolicy -ne 'no' -and -not [string]::IsNullOrWhiteSpace($c.RestartPolicy)) {
            $stripped += $c
        }
    }

    docker update --restart=no @ids | Out-Null
    if ($LASTEXITCODE -ne 0) { throw "docker update --restart=no failed for stack '$($s.Stack)'." }

    if ($stripped.Count -gt 0) {
        foreach ($c in $stripped) {
            Write-Host "NOTE: stripped restart policy '$($c.RestartPolicy)' -> 'no' on $($c.Name)" -ForegroundColor Yellow
        }
        Write-Host "(this is expected -- supabase start / compose up re-stamp a restart policy every time)" -ForegroundColor DarkGray
    } else {
        Write-Host "Restart policy already 'no' on all containers -- nothing to strip."
    }

    Write-Host "Stack '$($s.Stack)' is up."
}

function Invoke-Down {
    param([string]$Name)
    if ([string]::IsNullOrWhiteSpace($Name)) {
        Write-Host "Usage: dstack down <stack>" -ForegroundColor Red
        exit 1
    }
    $s = Resolve-Stack -Name $Name
    $ids = $s.Containers | Select-Object -ExpandProperty Id

    Write-Host "Stopping stack '$($s.Stack)' ($($ids.Count) containers)..."
    docker stop @ids | Out-Null
    if ($LASTEXITCODE -ne 0) { throw "docker stop failed for stack '$($s.Stack)'." }
    Write-Host "Stack '$($s.Stack)' is down."
}

function Invoke-Audit {
    param([int]$ThresholdDays)

    $stacks = Get-StackInventory
    $idle = $stacks | Where-Object { -not $_.IsRunning -and ($null -eq $_.IdleDays -or $_.IdleDays -gt $ThresholdDays) }

    Write-Host "Audit: stacks idle more than $ThresholdDays day(s)"
    Write-Host "======================================================"

    if (-not $idle -or $idle.Count -eq 0) {
        Write-Host "None. All stacks are either running or within the idle threshold."
        exit 0
    }

    foreach ($s in $idle | Sort-Object -Property IdleSortKey -Descending) {
        $idleDesc = if ($null -eq $s.IdleDays) { 'never used' } else { "$($s.IdleDays) days idle" }
        Write-Host ""
        Write-Host "Stack: $($s.Stack)"
        Write-Host "  Dir:        $($s.Dir)"
        Write-Host "  Containers: $($s.Total) ($($s.Running) running)"
        Write-Host "  Last used:  $(Format-DateOrNever $s.LastUsed)  ($idleDesc)"
        Write-Host "  To archive: dstack archive $($s.Stack) -Confirm"
    }

    Write-Host ""
    Write-Host "This command only reports. Nothing was changed."
    exit 0
}

function Invoke-Archive {
    param([string]$Name, [bool]$Confirmed)

    if ([string]::IsNullOrWhiteSpace($Name)) {
        Write-Host "Usage: dstack archive <stack> -Confirm" -ForegroundColor Red
        exit 1
    }

    $s = Resolve-Stack -Name $Name

    if ($s.IsRunning) {
        Write-Host "Refusing: stack '$($s.Stack)' is currently running." -ForegroundColor Red
        Write-Host "Run 'dstack down $($s.Stack)' first, then re-run archive."
        exit 1
    }

    $containerNames = $s.Containers | Select-Object -ExpandProperty Name
    $volumes = @(docker volume ls --filter "label=com.docker.compose.project=$($s.Stack)" --format '{{.Name}}')

    Write-Host "This will PERMANENTLY remove stack '$($s.Stack)':"
    Write-Host "  Containers ($($containerNames.Count)):"
    foreach ($n in $containerNames) { Write-Host "    - $n" }
    Write-Host "  Named volumes ($($volumes.Count)):"
    if ($volumes.Count -eq 0) {
        Write-Host "    (none found)"
    } else {
        foreach ($v in $volumes) { Write-Host "    - $v" }
    }

    if (-not $Confirmed) {
        Write-Host ""
        Write-Host "Refusing without -Confirm. Re-run as:" -ForegroundColor Yellow
        Write-Host "  dstack archive $($s.Stack) -Confirm"
        exit 1
    }

    Write-Host ""
    Write-Host "Confirmed. Removing..."
    $ids = $s.Containers | Select-Object -ExpandProperty Id
    docker rm @ids | Out-Null
    if ($LASTEXITCODE -ne 0) { throw "docker rm failed for stack '$($s.Stack)'." }

    if ($volumes.Count -gt 0) {
        docker volume rm @volumes | Out-Null
        if ($LASTEXITCODE -ne 0) { throw "docker volume rm failed for stack '$($s.Stack)'." }
    }

    Write-Host "Stack '$($s.Stack)' archived: $($ids.Count) containers and $($volumes.Count) volumes removed."
}

function Get-ReclaimedSpace {
    param([string[]]$Output)
    $line = $Output | Where-Object { $_ -match 'Total reclaimed space:\s*(.+)' } | Select-Object -Last 1
    if ($line -and $line -match 'Total reclaimed space:\s*(.+)') {
        return $Matches[1].Trim()
    }
    return '(unknown)'
}

function Invoke-Prune {
    Write-Host "WARNING: 'docker image prune -af' removes every image not referenced by an EXISTING container." -ForegroundColor Yellow
    Write-Host "         Images belonging to archived/removed stacks (or stacks you haven't started recently" -ForegroundColor Yellow
    Write-Host "         enough to have a live container) will be deleted and re-pulled/rebuilt on next use." -ForegroundColor Yellow
    Write-Host ""

    Write-Host "Running: docker builder prune -af"
    $builderOut = docker builder prune -af 2>&1
    $builderOut | ForEach-Object { Write-Host "  $_" }

    Write-Host "Running: docker volume prune -af"
    $volumeOut = docker volume prune -af 2>&1
    $volumeOut | ForEach-Object { Write-Host "  $_" }

    Write-Host "Running: docker image prune -af"
    $imageOut = docker image prune -af 2>&1
    $imageOut | ForEach-Object { Write-Host "  $_" }

    Write-Host ""
    Write-Host "Reclaimed space:"
    Write-Host "  Builder cache: $(Get-ReclaimedSpace $builderOut)"
    Write-Host "  Volumes:       $(Get-ReclaimedSpace $volumeOut)"
    Write-Host "  Images:        $(Get-ReclaimedSpace $imageOut)"
}

# ---------------------------------------------------------------------------
# Entry point
# ---------------------------------------------------------------------------

if ([string]::IsNullOrWhiteSpace($Command)) {
    Write-Host "Usage: dstack <ls|up|down|audit|archive|prune> [stack] [-Days N] [-Confirm]"
    exit 1
}

switch ($Command) {
    'ls'      { Invoke-Ls }
    'up'      { Invoke-Up -Name $Stack }
    'down'    { Invoke-Down -Name $Stack }
    'audit'   { Invoke-Audit -ThresholdDays $Days }
    'archive' { Invoke-Archive -Name $Stack -Confirmed $Confirm.IsPresent }
    'prune'   { Invoke-Prune }
}
