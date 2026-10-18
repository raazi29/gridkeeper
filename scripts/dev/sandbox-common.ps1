# Shared helpers for sandbox.ps1 / sandbox-stop.ps1 (dot-sourced; not meant to be run directly).
# Everything here is read-only except Write-LaunchRecord / Remove-LaunchRecord, which only touch
# %APPDATA%\app.gridkeeper.desktop\sandboxes\<name>\sandbox-launch.json.

$script:GkIdentifier = "app.gridkeeper.desktop"

function Assert-SandboxName([string]$Name) {
  # Case-sensitive on purpose: the app accepts [a-z0-9-]{1,32} only (ValidatePattern would ignore case).
  if ($Name -cnotmatch '^[a-z0-9-]{1,32}$') {
    throw "Invalid sandbox name '$Name': use 1-32 characters from a-z, 0-9 and '-'."
  }
}

function Get-SandboxPaths([string]$Name) {
  Assert-SandboxName $Name
  $appData = [Environment]::GetFolderPath("ApplicationData")
  if (-not $appData) { throw "Could not resolve %APPDATA%." }
  $base = Join-Path $appData $script:GkIdentifier
  $root = Join-Path $base "sandboxes"
  $dir = Join-Path $root $Name
  [pscustomobject]@{
    Name    = $Name
    Base    = $base
    Root    = $root
    Dir     = $dir
    Record  = Join-Path $dir "sandbox-launch.json"
    WebView = Join-Path $dir "EBWebView"
    Log     = Join-Path $dir "sandbox-logs\sandbox.log"
  }
}

function Read-LaunchRecord($Paths) {
  if (-not (Test-Path -LiteralPath $Paths.Record -PathType Leaf)) { return $null }
  try { return Get-Content -LiteralPath $Paths.Record -Raw | ConvertFrom-Json }
  catch { Write-Warning "Unreadable launch record $($Paths.Record): $($_.Exception.Message)"; return $null }
}

function Write-LaunchRecord($Paths, $Record) {
  $dir = Split-Path -Parent $Paths.Record
  New-Item -ItemType Directory -Force -Path $dir | Out-Null
  $Record | ConvertTo-Json -Depth 4 | Set-Content -LiteralPath $Paths.Record -Encoding utf8
}

function Remove-LaunchRecord($Paths) {
  if (Test-Path -LiteralPath $Paths.Record -PathType Leaf) { Remove-Item -LiteralPath $Paths.Record -Force }
}

function Get-ProcessIdentity([int]$ProcessId) {
  $p = Get-CimInstance Win32_Process -Filter "ProcessId=$ProcessId" -ErrorAction SilentlyContinue
  if (-not $p) { return $null }
  [pscustomobject]@{
    ProcessId       = [int]$p.ProcessId
    ParentProcessId = [int]$p.ParentProcessId
    Name            = $p.Name
    CommandLine     = $p.CommandLine
    ExecutablePath  = $p.ExecutablePath
    CreatedUtcTicks = if ($p.CreationDate) { [long]$p.CreationDate.ToUniversalTime().Ticks } else { [long]0 }
  }
}

# Returns @{ State = "running" | "gone" | "mismatch"; Process; Reason }.
# "running" only when the recorded PID still has the recorded creation time AND command line, i.e. it is the
# exact process sandbox.ps1 started (PIDs get reused; never trust a bare PID).
function Resolve-RecordedProcess($Record) {
  if (-not $Record -or -not $Record.pid) { return @{ State = "gone"; Process = $null; Reason = "no PID recorded" } }
  $id = Get-ProcessIdentity ([int]$Record.pid)
  if (-not $id) { return @{ State = "gone"; Process = $null; Reason = "PID $($Record.pid) is not running" } }
  $dt = [Math]::Abs(($id.CreatedUtcTicks - [long]$Record.createdUtcTicks) / [TimeSpan]::TicksPerSecond)
  if ($dt -gt 2) {
    return @{ State = "mismatch"; Process = $id; Reason = "PID $($Record.pid) now belongs to a process started at a different time ($($id.Name))" }
  }
  if ([string]$id.CommandLine -cne [string]$Record.commandLine) {
    return @{ State = "mismatch"; Process = $id; Reason = "PID $($Record.pid) has a different command line ($($id.Name))" }
  }
  return @{ State = "running"; Process = $id; Reason = "" }
}

function Test-PortListening([int]$Port) {
  $listeners = [System.Net.NetworkInformation.IPGlobalProperties]::GetIPGlobalProperties().GetActiveTcpListeners()
  return [bool]($listeners | Where-Object { $_.Port -eq $Port } | Select-Object -First 1)
}

function Get-PortOwnerText([int]$Port) {
  try {
    $c = Get-NetTCPConnection -LocalPort $Port -State Listen -ErrorAction Stop | Select-Object -First 1
    $p = Get-Process -Id $c.OwningProcess -ErrorAction SilentlyContinue
    if ($p) { return "PID $($c.OwningProcess) ($($p.ProcessName))" }
    return "PID $($c.OwningProcess)"
  } catch { return "unknown process" }
}

function Get-MemoryStatus {
  $os = Get-CimInstance Win32_OperatingSystem
  # Win32_OperatingSystem reports KiB; KiB / 1MB = GiB.
  [pscustomobject]@{
    FreeCommitGB  = [Math]::Round($os.FreeVirtualMemory / 1MB, 2)
    CommitLimitGB = [Math]::Round($os.TotalVirtualMemorySize / 1MB, 2)
    FreePhysGB    = [Math]::Round($os.FreePhysicalMemory / 1MB, 2)
    TotalPhysGB   = [Math]::Round($os.TotalVisibleMemorySize / 1MB, 2)
  }
}
