<#
.SYNOPSIS
  Starts an isolated Gridkeeper test instance ("sandbox") next to a live Gridkeeper without disturbing it.

.DESCRIPTION
  The live app and a test build share the identifier app.gridkeeper.desktop, so a plain second launch either hits
  the single-instance lock (it just focuses the live window) or shares workspaces.json and the WebView2 profile.
  This script starts the test build with GRIDKEEPER_SANDBOX=<name>, which gives it:
    - its own data folder   %APPDATA%\app.gridkeeper.desktop\sandboxes\<name>
    - its own WebView2 user-data folder (also pinned here via WEBVIEW2_USER_DATA_FOLDER)
    - no single-instance lock, window title "Gridkeeper [sandbox: <name>]", ipc.appInfo().sandbox = <name>
  plus a CDP port for scripts/e2e (default 9333; 9222 is left to the developer).

  Safety:
    - Memory guard: refuses to start below -MinFreeCommitGB of free commit (default 4 GB for dev builds). When
      Windows runs out of commit it kills WebView2 processes, including the live app's.
    - Cargo runs with CARGO_BUILD_JOBS=-Jobs (default 2), RUST_MIN_STACK=16 MiB, below-normal priority.
    - Only the process this script starts is recorded (PID + creation time + command line in
      <sandbox>\sandbox-launch.json). sandbox-stop.ps1 stops only that verified process tree. Nothing here ever
      stops a process by name.

  Modes:
    dev      npm run tauri dev in this checkout (debug build, Vite on :1420, window.__gridkeeper e2e handles).
    release  <target>\release\gridkeeper.exe from this checkout (build it first; no e2e handles in release builds).
    exe      -Exe <path> (an installer build, a CI artifact, ...).

.EXAMPLE
  npm run sandbox                                   # dev build, sandbox "dev", CDP on 9333
.EXAMPLE
  npm run sandbox -- -DryRun                        # print what would happen, change nothing
.EXAMPLE
  pwsh -NoProfile -File scripts/dev/sandbox.ps1 -Mode release -Name rel -CdpPort 9334 -Fresh
.EXAMPLE
  pwsh -NoProfile -File scripts/dev/sandbox-stop.ps1 -Name dev
#>
[CmdletBinding()]
param(
  [string]$Name = "dev",
  [ValidateRange(1024, 65535)][int]$CdpPort = 9333,
  [ValidateSet("dev", "release", "exe")][string]$Mode = "dev",
  [string]$Exe,
  [ValidateRange(1, 64)][int]$Jobs = 2,
  # Free commit (GB) required before starting. Dev builds compile Rust; release/exe only start the app (1.5 GB).
  [double]$MinFreeCommitGB = 4,
  # Optional shared CARGO_TARGET_DIR (lets several worktrees reuse one build cache instead of one each).
  [string]$TargetDir,
  [switch]$Fresh,
  [switch]$Force,
  [switch]$NormalPriority,
  [switch]$DryRun
)
$ErrorActionPreference = "Stop"
. (Join-Path $PSScriptRoot "sandbox-common.ps1")

function Fail([string]$msg) {
  Write-Host ""
  Write-Host "sandbox: $msg" -ForegroundColor Red
  exit 1
}
function Info([string]$msg) { Write-Host "sandbox: $msg" }
$tag = if ($DryRun) { "[dry run] " } else { "" }

try { Assert-SandboxName $Name } catch { Fail $_.Exception.Message }
if ($CdpPort -eq 9222) { Fail "CDP port 9222 is reserved for the developer's own instance. Pick another -CdpPort (default 9333)." }

$repo = (Resolve-Path (Join-Path $PSScriptRoot "..\..")).Path
$paths = Get-SandboxPaths $Name

# ---- what to run -------------------------------------------------------------------------------------------
$targetRoot = if ($TargetDir) { [IO.Path]::GetFullPath($TargetDir) } elseif ($env:CARGO_TARGET_DIR) { $env:CARGO_TARGET_DIR } else { Join-Path $repo "src-tauri\target" }
switch ($Mode) {
  "dev" {
    if (-not (Test-Path -LiteralPath (Join-Path $repo "node_modules"))) {
      Fail "node_modules is missing in $repo. Run 'npm install' (or junction it from the main checkout: cmd /c mklink /J node_modules D:\AlteraAI\node_modules)."
    }
    $runExe = $null
  }
  "release" {
    $runExe = Join-Path $targetRoot "release\gridkeeper.exe"
    if (-not (Test-Path -LiteralPath $runExe -PathType Leaf)) {
      Fail "No release build at $runExe. Build it first (PowerShell): `$env:CARGO_BUILD_JOBS=2; `$env:RUST_MIN_STACK='16777216'; npx tauri build --no-bundle"
    }
  }
  "exe" {
    if (-not $Exe) { Fail "-Mode exe needs -Exe <path to gridkeeper.exe>." }
    if (-not (Test-Path -LiteralPath $Exe -PathType Leaf)) { Fail "Exe not found: $Exe" }
    $runExe = (Resolve-Path -LiteralPath $Exe).Path
  }
}

Write-Host ""
Write-Host "${tag}Gridkeeper sandbox '$Name' (mode $Mode)" -ForegroundColor Cyan
Info "checkout      $repo"
Info "data folder   $($paths.Dir)"
Info "CDP port      $CdpPort"
if ($runExe) { Info "executable    $runExe" }

# ---- an instance of this sandbox already running? --------------------------------------------------------
$existing = Read-LaunchRecord $paths
if ($existing) {
  $r = Resolve-RecordedProcess $existing
  if ($r.State -eq "running") {
    Fail "sandbox '$Name' is already running (PID $($existing.pid), mode $($existing.mode)). Stop it first: pwsh -NoProfile -File scripts/dev/sandbox-stop.ps1 -Name $Name"
  }
  Info "stale launch record ignored ($($r.Reason))"
}

# ---- memory guard ----------------------------------------------------------------------------------------
$mem = Get-MemoryStatus
$need = if ($Mode -eq "dev") { $MinFreeCommitGB } else { [Math]::Min(1.5, $MinFreeCommitGB) }
Info ("memory        {0} GB commit free of {1} GB, {2} GB RAM free of {3} GB (need {4} GB commit)" -f $mem.FreeCommitGB, $mem.CommitLimitGB, $mem.FreePhysGB, $mem.TotalPhysGB, $need)
if ($mem.FreeCommitGB -lt $need) {
  $why = "only $($mem.FreeCommitGB) GB of commit is free (need $need GB). " +
    "This guard protects the Gridkeeper you are working in and every agent running inside it: when Windows runs " +
    "out of commit it kills WebView2 processes (the live window goes black or crashes). Close something heavy " +
    "(another build, a browser), lower -Jobs, or re-run with -Force if you accept the risk."
  if ($Force) { Write-Warning "-Force: starting anyway although $why" }
  elseif ($DryRun) { Write-Warning "would refuse: $why" }
  else { Fail $why }
}
if ($mem.FreePhysGB -lt 1.5) { Write-Warning "only $($mem.FreePhysGB) GB of RAM is free; expect paging while this builds." }

# ---- ports -----------------------------------------------------------------------------------------------
if (Test-PortListening $CdpPort) {
  Fail "port $CdpPort is already in use by $(Get-PortOwnerText $CdpPort) (another sandbox?). Pick another -CdpPort or stop it with sandbox-stop.ps1."
}
if ($Mode -eq "dev" -and (Test-PortListening 1420)) {
  Fail ("the Vite dev server port 1420 is already in use by $(Get-PortOwnerText 1420), probably another " +
    "'npm run tauri dev' (maybe from another worktree or sandbox). Tauri dev needs exactly 1420 (strictPort). " +
    "Stop that instance first (sandbox-stop.ps1 -Name <its name> if it is a sandbox), or use -Mode release / -Mode exe.")
}

# ---- fresh data folder -----------------------------------------------------------------------------------
if ($Fresh) {
  $full = [IO.Path]::GetFullPath($paths.Dir)
  $rootFull = [IO.Path]::GetFullPath($paths.Root).TrimEnd("\")
  if ((Split-Path -Parent $full) -ne $rootFull -or (Split-Path -Leaf $full) -cne $Name) {
    Fail "refusing -Fresh: $full is not $rootFull\$Name"
  }
  if (Test-Path -LiteralPath $full) {
    $item = Get-Item -LiteralPath $full -Force
    if (-not $item.PSIsContainer) { Fail "refusing -Fresh: $full is not a folder" }
    if ($item.Attributes -band [IO.FileAttributes]::ReparsePoint) { Fail "refusing -Fresh: $full is a junction/symlink" }
    if ($DryRun) { Info "[dry run] would delete $full" }
    else {
      Info "deleting $full (-Fresh)"
      # rd /s does not follow junctions inside the folder (Windows PowerShell's Remove-Item -Recurse can).
      & cmd.exe /d /c "rd /s /q `"$full`""
      if (Test-Path -LiteralPath $full) { Fail "could not delete $full completely (a file is in use; is a sandbox instance still running?)" }
    }
  } else { Info "-Fresh: $full does not exist yet" }
}

# ---- environment for the child only ----------------------------------------------------------------------
$envVars = [ordered]@{
  GRIDKEEPER_SANDBOX                      = $Name
  WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS   = "--remote-debugging-port=$CdpPort"
  # Belt and braces: the app picks its own sandbox WebView2 folder, but this variable overrides the default
  # profile even for a build that predates the sandbox flag, so the live app's profile is never shared.
  WEBVIEW2_USER_DATA_FOLDER               = $paths.WebView
  CARGO_BUILD_JOBS                        = "$Jobs"
  RUST_MIN_STACK                          = "16777216"
  CDP_PORT                                = "$CdpPort"
}
if ($TargetDir) { $envVars["CARGO_TARGET_DIR"] = $targetRoot }

$psi = New-Object System.Diagnostics.ProcessStartInfo
$psi.UseShellExecute = $false
$psi.WorkingDirectory = $repo
if ($Mode -eq "dev") {
  # cmd.exe /s strips the outer quotes and runs the rest verbatim; output goes to a log file (no console window).
  $psi.FileName = $env:ComSpec
  $psi.Arguments = "/d /s /c `"npm run tauri dev 1>`"$($paths.Log)`" 2>&1`""
  $psi.CreateNoWindow = $true
} else {
  $psi.FileName = $runExe
}
foreach ($k in $envVars.Keys) { $psi.Environment[$k] = $envVars[$k] }
# Bench mode would replace the sandbox workspace with an in-memory one.
[void]$psi.Environment.Remove("GRIDKEEPER_BENCH")

Info "environment (child process only):"
foreach ($k in $envVars.Keys) { Write-Host ("    {0,-38} {1}" -f $k, $envVars[$k]) }
Info "command       $($psi.FileName) $($psi.Arguments)"
if ($Mode -eq "dev") { Info "log           $($paths.Log)" }
Info "priority      $(if ($NormalPriority) { 'normal' } else { 'below normal (keeps the live agents responsive)' })"

if ($DryRun) {
  Write-Host ""
  Info "dry run: nothing was started, deleted or written."
  exit 0
}

# ---- start ------------------------------------------------------------------------------------------------
New-Item -ItemType Directory -Force -Path (Split-Path -Parent $paths.Log) | Out-Null
$proc = [System.Diagnostics.Process]::Start($psi)
if (-not $NormalPriority) {
  # Children inherit BELOW_NORMAL, so cargo/rustc and the sandbox app yield to the live app.
  try { $proc.PriorityClass = [System.Diagnostics.ProcessPriorityClass]::BelowNormal } catch { }
}
$id = $null
for ($i = 0; $i -lt 20 -and -not $id; $i++) {
  $id = Get-ProcessIdentity $proc.Id
  if (-not $id) { Start-Sleep -Milliseconds 100 }
}
if (-not $id) { Fail "the process exited immediately (PID $($proc.Id)). $(if ($Mode -eq 'dev') { "See $($paths.Log)" })" }

Write-LaunchRecord $paths ([ordered]@{
    name            = $Name
    mode            = $Mode
    pid             = $id.ProcessId
    createdUtcTicks = $id.CreatedUtcTicks
    commandLine     = $id.CommandLine
    executablePath  = $id.ExecutablePath
    cdpPort         = $CdpPort
    checkout        = $repo
    log             = if ($Mode -eq "dev") { $paths.Log } else { $null }
    startedAt       = (Get-Date).ToString("o")
  })

Write-Host ""
Write-Host "Sandbox '$Name' started (PID $($id.ProcessId))." -ForegroundColor Green
if ($Mode -eq "dev") {
  Write-Host "  The first dev build can take several minutes. Follow it with:"
  Write-Host "    Get-Content -Wait '$($paths.Log)'"
}
Write-Host "  Window title:  Gridkeeper [sandbox: $Name]"
Write-Host "  e2e (dev mode only; release builds have no window.__gridkeeper):"
Write-Host "    `$env:CDP_PORT = $CdpPort; node scripts/e2e/cdp.mjs file scripts/e2e/full-verify.js"
Write-Host "    `$env:CDP_PORT = $CdpPort; node scripts/e2e/cdp.mjs shot sandbox.png"
Write-Host "  Stop it (only this sandbox's process tree):"
Write-Host "    pwsh -NoProfile -File scripts/dev/sandbox-stop.ps1 -Name $Name"
