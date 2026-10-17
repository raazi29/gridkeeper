<#
.SYNOPSIS
  Runs the standard benchmark scenarios against a RELEASE build and writes bench-results/summary.csv.
  Each scenario launches the app with ALTERA_BENCH (in-memory bench workspace; user data untouched),
  warms up, samples CPU/RAM/GPU by category with sample.ps1, then closes the app.

.EXAMPLE
  pwsh -File scripts/bench/run-all.ps1 -Exe src-tauri/target/release/altera.exe
#>
param(
  [string]$Exe = "src-tauri/target/release/altera.exe",
  [int]$Warmup = 20,
  [int]$Seconds = 40,
  [string]$OutDir = "bench-results",
  [string[]]$Only = @()
)
$ErrorActionPreference = "Stop"
$Exe = (Resolve-Path $Exe).Path
$here = Split-Path -Parent $MyInvocation.MyCommand.Path
$procName = [IO.Path]::GetFileNameWithoutExtension($Exe)

$scenarios = @(
  @{ label = "idle-1-webgl"; bench = "sessions=1;mode=idle;renderer=webgl" },
  @{ label = "idle-6-webgl"; bench = "sessions=6;mode=idle;renderer=webgl" },
  @{ label = "idle-12-webgl"; bench = "sessions=12;mode=idle;renderer=webgl" },
  @{ label = "sustained-6-webgl"; bench = "sessions=6;mode=sustained;rate=2000;seconds=120;renderer=webgl" },
  @{ label = "sustained-6-dom"; bench = "sessions=6;mode=sustained;rate=2000;seconds=120;renderer=dom" },
  @{ label = "flood-6-webgl"; bench = "sessions=6;mode=lines;count=200000;renderer=webgl" }
)
if ($Only.Count) { $scenarios = $scenarios | Where-Object { $Only -contains $_.label } }

New-Item -ItemType Directory -Force -Path $OutDir | Out-Null
$all = @()
foreach ($s in $scenarios) {
  Write-Host "=== $($s.label) ===" -ForegroundColor Cyan
  Get-Process -Name $procName -ErrorAction SilentlyContinue | Where-Object { $_.Path -eq $Exe } | Stop-Process -Force
  $env:ALTERA_BENCH = $s.bench
  $p = Start-Process -FilePath $Exe -PassThru
  Remove-Item Env:ALTERA_BENCH
  Start-Sleep -Seconds $Warmup
  & pwsh -NoProfile -File (Join-Path $here "sample.ps1") -Seconds $Seconds -Label $s.label -OutDir $OutDir -ProcessName $procName -RootPid $p.Id
  $sum = Import-Csv (Join-Path $OutDir "$($s.label).summary.csv")
  $all += $sum
  # Graceful close (WM_CLOSE) so the app's shutdown path stops sessions; force after 8 s.
  [void]$p.CloseMainWindow()
  if (-not $p.WaitForExit(8000)) { $p | Stop-Process -Force }
  Start-Sleep -Seconds 3
}
$all | Export-Csv -NoTypeInformation -Path (Join-Path $OutDir "summary.csv")
$all | Format-Table -AutoSize | Out-String -Width 220 | Write-Output
