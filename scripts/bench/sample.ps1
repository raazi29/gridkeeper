<#
.SYNOPSIS
  Samples CPU, memory and GPU usage of a running Altera instance, attributed by category:
    host     = altera.exe (Tauri/Rust process)
    webview  = msedgewebview2.exe descendants (UI + terminal rendering)
    console  = OpenConsole.exe / conhost.exe descendants (ConPTY hosts)
    agents   = everything else in the tree (pwsh, claude, codex, node, git, ...)
  CPU is reported Task-Manager style: percent of total machine capacity (all logical cores).
  GPU numbers come from the Windows "GPU Engine" / "GPU Process Memory" performance counters (same source as Task Manager).

.EXAMPLE
  pwsh -File scripts/bench/sample.ps1 -Seconds 60 -Label idle-6-sessions -OutDir bench-results
#>
param(
  [int]$Seconds = 30,
  [double]$Interval = 1.0,
  [string]$Label = "sample",
  [string]$OutDir = "bench-results",
  [string]$ProcessName = "altera"
)

$ErrorActionPreference = "Stop"
$cores = [Environment]::ProcessorCount
New-Item -ItemType Directory -Force -Path $OutDir | Out-Null

function Get-Tree([int]$rootPid) {
  $all = Get-CimInstance Win32_Process -Property ProcessId, ParentProcessId, Name
  $children = @{}
  foreach ($p in $all) {
    $pp = [int]$p.ParentProcessId
    if (-not $children.ContainsKey($pp)) { $children[$pp] = New-Object System.Collections.ArrayList }
    [void]$children[$pp].Add($p)
  }
  $result = @{}
  $stack = New-Object System.Collections.Stack
  $root = $all | Where-Object { $_.ProcessId -eq $rootPid } | Select-Object -First 1
  if (-not $root) { return $result }
  $stack.Push($root)
  while ($stack.Count -gt 0) {
    $p = $stack.Pop()
    $result[[int]$p.ProcessId] = $p.Name
    if ($children.ContainsKey([int]$p.ProcessId)) { foreach ($c in $children[[int]$p.ProcessId]) { $stack.Push($c) } }
  }
  return $result
}

function Get-Category([string]$name, [int]$procId, [int]$rootPid) {
  if ($procId -eq $rootPid) { return "host" }
  switch -Regex ($name) {
    '^msedgewebview2' { return "webview" }
    '^(OpenConsole|conhost)' { return "console" }
    default { return "agents" }
  }
}

$host_ = Get-Process -Name $ProcessName -ErrorAction SilentlyContinue | Sort-Object StartTime | Select-Object -First 1
if (-not $host_) { throw "Process '$ProcessName' is not running." }
$rootPid = $host_.Id

$prevCpu = @{}
$prevTime = Get-Date
$rows = New-Object System.Collections.ArrayList
$gpuAvailable = $true

$end = (Get-Date).AddSeconds($Seconds)
# Prime CPU counters
foreach ($kv in (Get-Tree $rootPid).GetEnumerator()) {
  $p = Get-Process -Id $kv.Key -ErrorAction SilentlyContinue
  if ($p) { $prevCpu[$kv.Key] = $p.TotalProcessorTime.TotalMilliseconds }
}
Start-Sleep -Milliseconds ([int]($Interval * 1000))

while ((Get-Date) -lt $end) {
  $now = Get-Date
  $elapsedMs = ($now - $prevTime).TotalMilliseconds
  $prevTime = $now
  $tree = Get-Tree $rootPid
  $cat = @{
    host    = @{ cpu = 0.0; mem = 0; n = 0; gpu = 0.0; gpumem = 0 }
    webview = @{ cpu = 0.0; mem = 0; n = 0; gpu = 0.0; gpumem = 0 }
    console = @{ cpu = 0.0; mem = 0; n = 0; gpu = 0.0; gpumem = 0 }
    agents  = @{ cpu = 0.0; mem = 0; n = 0; gpu = 0.0; gpumem = 0 }
  }
  $pidCat = @{}
  foreach ($kv in $tree.GetEnumerator()) {
    $p = Get-Process -Id $kv.Key -ErrorAction SilentlyContinue
    if (-not $p) { continue }
    $c = Get-Category $kv.Value $kv.Key $rootPid
    $pidCat[$kv.Key] = $c
    $ms = $p.TotalProcessorTime.TotalMilliseconds
    if ($prevCpu.ContainsKey($kv.Key)) {
      $cat[$c].cpu += [math]::Max(0, ($ms - $prevCpu[$kv.Key])) / $elapsedMs / $cores * 100
    }
    $prevCpu[$kv.Key] = $ms
    $cat[$c].mem += $p.WorkingSet64
    $cat[$c].n += 1
  }
  if ($gpuAvailable) {
    try {
      $eng = (Get-Counter -Counter "\GPU Engine(*)\Utilization Percentage" -ErrorAction Stop).CounterSamples
      foreach ($s in $eng) {
        if ($s.InstanceName -match 'pid_(\d+)_') {
          $gp = [int]$Matches[1]
          if ($pidCat.ContainsKey($gp)) { $cat[$pidCat[$gp]].gpu += $s.CookedValue }
        }
      }
      $gmem = (Get-Counter -Counter "\GPU Process Memory(*)\Dedicated Usage" -ErrorAction Stop).CounterSamples
      foreach ($s in $gmem) {
        if ($s.InstanceName -match 'pid_(\d+)_') {
          $gp = [int]$Matches[1]
          if ($pidCat.ContainsKey($gp)) { $cat[$pidCat[$gp]].gpumem += [int64]$s.CookedValue }
        }
      }
    } catch { $gpuAvailable = $false; Write-Warning "GPU counters unavailable: $_" }
  }
  foreach ($k in $cat.Keys) {
    [void]$rows.Add([pscustomobject]@{
        time = $now.ToString("HH:mm:ss.fff"); category = $k; processes = $cat[$k].n
        cpu_pct = [math]::Round($cat[$k].cpu, 2); mem_mb = [math]::Round($cat[$k].mem / 1MB, 1)
        gpu_engine_pct = [math]::Round($cat[$k].gpu, 2); gpu_dedicated_mb = [math]::Round($cat[$k].gpumem / 1MB, 1)
      })
  }
  $sleep = [int]($Interval * 1000 - ((Get-Date) - $now).TotalMilliseconds)
  if ($sleep -gt 0) { Start-Sleep -Milliseconds $sleep }
}

$csv = Join-Path $OutDir "$Label.csv"
$rows | Export-Csv -NoTypeInformation -Path $csv
$summary = $rows | Group-Object category | ForEach-Object {
  $g = $_.Group
  [pscustomobject]@{
    label = $Label; category = $_.Name
    procs = ($g | Measure-Object processes -Maximum).Maximum
    cpu_avg = [math]::Round(($g | Measure-Object cpu_pct -Average).Average, 2)
    cpu_max = [math]::Round(($g | Measure-Object cpu_pct -Maximum).Maximum, 2)
    mem_avg_mb = [math]::Round(($g | Measure-Object mem_mb -Average).Average, 1)
    mem_max_mb = [math]::Round(($g | Measure-Object mem_mb -Maximum).Maximum, 1)
    gpu_avg = [math]::Round(($g | Measure-Object gpu_engine_pct -Average).Average, 2)
    gpu_max = [math]::Round(($g | Measure-Object gpu_engine_pct -Maximum).Maximum, 2)
    gpumem_max_mb = [math]::Round(($g | Measure-Object gpu_dedicated_mb -Maximum).Maximum, 1)
  }
}
$summary | Format-Table -AutoSize | Out-String -Width 200 | Write-Output
$summary | Export-Csv -NoTypeInformation -Path (Join-Path $OutDir "$Label.summary.csv")
