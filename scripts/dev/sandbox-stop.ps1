<#
.SYNOPSIS
  Stops a Gridkeeper sandbox started by sandbox.ps1, and nothing else.

.DESCRIPTION
  Reads <sandbox>\sandbox-launch.json, verifies that the recorded PID is still the very process sandbox.ps1
  started (same creation time and command line), then stops that process and its descendants: first a polite
  WM_CLOSE to any gridkeeper.exe in the tree (so the app's shutdown path stops its sessions), then a forced stop
  of whatever is left after -TimeoutSec. Descendants are only followed when they were created after their parent,
  so a reused PID is never mistaken for a child. It never stops processes by name.

.EXAMPLE
  pwsh -NoProfile -File scripts/dev/sandbox-stop.ps1 -Name dev
.EXAMPLE
  npm run sandbox:stop -- -Name dev -DryRun
#>
[CmdletBinding()]
param(
  [string]$Name = "dev",
  [ValidateRange(0, 120)][int]$TimeoutSec = 10,
  [switch]$DryRun
)
$ErrorActionPreference = "Stop"
. (Join-Path $PSScriptRoot "sandbox-common.ps1")

try { Assert-SandboxName $Name } catch { Write-Host "sandbox-stop: $($_.Exception.Message)" -ForegroundColor Red; exit 1 }
$paths = Get-SandboxPaths $Name
$tag = if ($DryRun) { "[dry run] " } else { "" }

$record = Read-LaunchRecord $paths
if (-not $record) {
  Write-Host "sandbox-stop: no launch record for sandbox '$Name' ($($paths.Record)); nothing to stop."
  Write-Host "sandbox-stop: this script only stops processes that sandbox.ps1 started and recorded."
  exit 0
}

$r = Resolve-RecordedProcess $record
if ($r.State -ne "running") {
  Write-Host "sandbox-stop: not stopping anything: $($r.Reason)."
  if ($DryRun) { Write-Host "sandbox-stop: [dry run] would remove the stale launch record." }
  else { Remove-LaunchRecord $paths; Write-Host "sandbox-stop: removed the stale launch record." }
  exit 0
}

# ---- collect the verified tree (root first, breadth-first) ------------------------------------------------
$all = @(Get-CimInstance Win32_Process | ForEach-Object {
    [pscustomobject]@{
      ProcessId       = [int]$_.ProcessId
      ParentProcessId = [int]$_.ParentProcessId
      Name            = $_.Name
      CreatedUtcTicks = if ($_.CreationDate) { [long]$_.CreationDate.ToUniversalTime().Ticks } else { [long]0 }
    }
  })
$root = $r.Process
$tree = New-Object System.Collections.Generic.List[object]
$tree.Add([pscustomobject]@{ ProcessId = $root.ProcessId; Name = $root.Name; CreatedUtcTicks = $root.CreatedUtcTicks; Depth = 0 })
$seen = @{ $root.ProcessId = $true }
for ($i = 0; $i -lt $tree.Count; $i++) {
  $parent = $tree[$i]
  foreach ($c in $all) {
    if ($c.ParentProcessId -eq $parent.ProcessId -and -not $seen.ContainsKey($c.ProcessId) -and $c.CreatedUtcTicks -ge $parent.CreatedUtcTicks) {
      $seen[$c.ProcessId] = $true
      $tree.Add([pscustomobject]@{ ProcessId = $c.ProcessId; Name = $c.Name; CreatedUtcTicks = $c.CreatedUtcTicks; Depth = $parent.Depth + 1 })
    }
  }
}

Write-Host "${tag}Stopping sandbox '$Name' (mode $($record.mode), root PID $($root.ProcessId)): $($tree.Count) process(es)" -ForegroundColor Cyan
foreach ($t in $tree) { Write-Host ("    {0}{1} {2}" -f ("  " * $t.Depth), $t.ProcessId, $t.Name) }
if ($DryRun) { Write-Host "sandbox-stop: dry run: nothing was stopped."; exit 0 }

# A process is only touched while it still has the creation time we saw (PIDs get reused).
function Get-LiveProcess($t) {
  $p = Get-Process -Id $t.ProcessId -ErrorAction SilentlyContinue
  if (-not $p) { return $null }
  try { $ticks = $p.StartTime.ToUniversalTime().Ticks } catch { return $null }
  if ([Math]::Abs(($ticks - $t.CreatedUtcTicks) / [TimeSpan]::TicksPerSecond) -gt 2) { return $null }
  return $p
}

# ---- polite close of the app window(s) ----------------------------------------------------------------------
$apps = @($tree | Where-Object { $_.Name -ieq "gridkeeper.exe" })
foreach ($a in $apps) {
  $p = Get-LiveProcess $a
  if ($p -and $p.CloseMainWindow()) { Write-Host "sandbox-stop: asked PID $($a.ProcessId) to close" }
}
if ($apps.Count -and $TimeoutSec -gt 0) {
  $deadline = (Get-Date).AddSeconds($TimeoutSec)
  while ((Get-Date) -lt $deadline -and @($apps | Where-Object { Get-LiveProcess $_ }).Count) { Start-Sleep -Milliseconds 250 }
}

# ---- force-stop what is left, deepest first -------------------------------------------------------------------
$stopped = 0
foreach ($t in ($tree | Sort-Object Depth -Descending)) {
  $p = Get-LiveProcess $t
  if ($p) {
    try { $p.Kill(); $stopped++ } catch { Write-Warning "could not stop PID $($t.ProcessId): $($_.Exception.Message)" }
  }
}
Remove-LaunchRecord $paths
Write-Host "sandbox-stop: done ($stopped force-stopped, the rest exited on their own)." -ForegroundColor Green
