<#
.SYNOPSIS
  Plays a scripted, generic "agent-style" transcript in a terminal at human pace, for the launch video.

.DESCRIPTION
  This is NOT an AI agent and never contacts one. It prints the lines of a transcript file
  (scripts/showcase/transcripts/*.txt) with a jittered per-line delay so a Gridkeeper pane looks busy, and it
  performs a few real, local side effects that the transcript asks for, so that what Gridkeeper shows is real:
    - flips a task box in the demo mission file (.gridkeeper/mission.md), like an agent following the
      agent-mission protocol would;
    - writes an instruction file into .gridkeeper/outbox/ (the lead-control channel);
    - writes files and makes real git commits in its own working folder (sign-off evidence and the review diff
      come from these commits);
    - waits for a line on stdin (so a lead-control delivery is visibly received).
  Used by scripts/showcase/launch.mjs in a disposable demo repository inside a sandbox Gridkeeper instance.

  Transcript format (UTF-8). Lines starting with ";;" are comments. Plain lines are printed. Directives:
    @@section <name>          start of a section (-Section plays only that section)
    @@pace <ms>               base delay after each printed line (jittered +-35%, scaled by -Pace)
    @@fast / @@normal         print the following lines quickly (context at the start of a shot) / normal pace
    @@sleep <ms>              pause
    @@clear                   clear the screen
    @@wait <signal> [sec]     wait until <SignalDir>/<signal> exists (launch.mjs creates it), default 600 s
    @@signal <name>           create <SignalDir>/<name>
    @@task <todo|doing|done|blocked> <text>   set the box of the first mission task containing <text>
    @@add <markdown line>     append a task line to the mission file
    @@outbox <to> <action> | <text>           write one lead-control instruction file
    @@file <relative path>    write the following lines (up to @@end) to a file in the working folder
    @@commit <message>        git add -A + git commit; prints git's own output
    @@git <args>              run git with these arguments in the working folder; prints its output
    @@input <prompt>          print <prompt> and read one line from stdin (echoed), available as {input}
    @@notify <text>           OSC 9 desktop-notification escape (shows up as "needs you" in Gridkeeper)
    @@mark / @@loop [n]       loop back to the last @@mark (n more times; forever without n)
    @@hold                    stop here and stay quiet until Ctrl+C (also implicit at the end)
  Inline markup in printed lines: {dim} {b} {green} {red} {yellow} {cyan} {blue} {magenta} {/} (reset),
  and the placeholders {name} {branch} {input}. A line starting with "~ " is typed out word by word.

.EXAMPLE
  pwsh -NoProfile -File scripts/showcase/fake-agent.ps1 -Transcript scripts/showcase/transcripts/builder-1.txt -Section grid -Name builder-1
#>
[CmdletBinding()]
param(
  [Parameter(Mandatory = $true)][string]$Transcript,
  [string]$Section,
  [string]$Name = "agent",
  [string]$MissionFile,
  [string]$SignalDir,
  [ValidateRange(0.1, 10)][double]$Pace = 1.0,
  [ValidateRange(1, 3600)][int]$InputTimeoutSec = 180,
  [string]$GitName = "Gridkeeper demo",
  [string]$GitEmail = "demo@example.invalid",
  [switch]$NoClear
)
$ErrorActionPreference = "Stop"
try { [Console]::OutputEncoding = New-Object System.Text.UTF8Encoding $false } catch { }

$script:basePace = 450
$script:fast = $false
$script:lastInput = ""
$script:rng = New-Object System.Random

function Slug([string]$s) {
  return (($s.ToLowerInvariant() -replace '[\s_]+', '-') -replace '[^a-z0-9\-]', '')
}

function Signal-Path([string]$n) {
  if (-not $SignalDir) { return $null }
  return Join-Path $SignalDir $n
}

function Touch-Signal([string]$n) {
  $p = Signal-Path $n
  if (-not $p) { return }
  New-Item -ItemType Directory -Force -Path $SignalDir | Out-Null
  [IO.File]::WriteAllText($p, (Get-Date).ToString("o"))
}

function Pause-Line {
  if ($script:fast) { Start-Sleep -Milliseconds 18; return }
  $j = 0.65 + ($script:rng.NextDouble() * 0.7)
  $ms = [int]($script:basePace * $j * $Pace)
  if ($ms -gt 0) { Start-Sleep -Milliseconds $ms }
}

function Current-Branch {
  $ErrorActionPreference = "Continue" # Windows PowerShell 5.1 turns redirected stderr into a terminating error under "Stop"
  try {
    $b = (& git rev-parse --abbrev-ref HEAD 2>$null)
    if ($LASTEXITCODE -eq 0 -and $b) { return "$b".Trim() }
  } catch { }
  return "-"
}

$colorMap = @{
  "dim" = "DarkGray"; "b" = "White"; "green" = "Green"; "red" = "Red"; "yellow" = "Yellow";
  "cyan" = "Cyan"; "blue" = "Blue"; "magenta" = "Magenta"
}

function Expand-Text([string]$s) {
  $s = $s.Replace("{name}", $Name).Replace("{input}", $script:lastInput)
  if ($s.Contains("{branch}")) { $s = $s.Replace("{branch}", (Current-Branch)) }
  return $s
}

# Prints one line with {color} markup. -Typed prints it word by word.
function Write-Marked([string]$line, [switch]$Typed) {
  $line = Expand-Text $line
  $parts = [regex]::Split($line, '(\{(?:dim|b|green|red|yellow|cyan|blue|magenta|/)\})')
  $color = $null
  foreach ($p in $parts) {
    if ($p -eq "") { continue }
    $m = [regex]::Match($p, '^\{(dim|b|green|red|yellow|cyan|blue|magenta|/)\}$')
    if ($m.Success) {
      $k = $m.Groups[1].Value
      if ($k -eq "/") { $color = $null } else { $color = $colorMap[$k] }
      continue
    }
    if ($Typed -and -not $script:fast) {
      $words = [regex]::Split($p, '(\s+)')
      foreach ($w in $words) {
        if ($w -eq "") { continue }
        if ($color) { Write-Host $w -NoNewline -ForegroundColor $color } else { Write-Host $w -NoNewline }
        if ($w.Trim() -ne "") { Start-Sleep -Milliseconds ([int]((45 + $script:rng.Next(0, 70)) * $Pace)) }
      }
    } else {
      if ($color) { Write-Host $p -NoNewline -ForegroundColor $color } else { Write-Host $p -NoNewline }
    }
  }
  Write-Host ""
}

# Read a whole text file and write it back with retries (Gridkeeper may be reading it at that moment).
function Read-TextRetry([string]$path) {
  for ($i = 0; $i -lt 20; $i++) {
    try { return [IO.File]::ReadAllText($path, [Text.Encoding]::UTF8) } catch [IO.IOException] { Start-Sleep -Milliseconds 60 }
  }
  return [IO.File]::ReadAllText($path, [Text.Encoding]::UTF8)
}
function Write-TextRetry([string]$path, [string]$text) {
  $enc = New-Object System.Text.UTF8Encoding $false
  for ($i = 0; $i -lt 20; $i++) {
    try { [IO.File]::WriteAllText($path, $text, $enc); return } catch [IO.IOException] { Start-Sleep -Milliseconds 60 }
  }
  [IO.File]::WriteAllText($path, $text, $enc)
}

function Set-TaskState([string]$state, [string]$needle) {
  if (-not $MissionFile -or -not (Test-Path -LiteralPath $MissionFile)) { return }
  $box = switch ($state) { "todo" { " " } "doing" { "~" } "done" { "x" } "blocked" { "!" } default { $null } }
  if ($null -eq $box) { Write-Warning "fake-agent: unknown task state '$state'"; return }
  $text = Read-TextRetry $MissionFile
  $lines = [regex]::Split($text, '(?<=\n)')
  for ($i = 0; $i -lt $lines.Length; $i++) {
    $l = $lines[$i]
    if ($l -match '^\s*(?:[-*+]|\d+[.)])\s+\[[ xX~/!\-]?\]' -and $l.IndexOf($needle, [StringComparison]::OrdinalIgnoreCase) -ge 0) {
      $lines[$i] = ([regex]'\[[ xX~/!\-]?\]').Replace($l, "[$box]", 1) # only the first box on the line
      Write-TextRetry $MissionFile ($lines -join "")
      return
    }
  }
  Write-Warning "fake-agent: no mission task contains '$needle'"
}

function Add-TaskLine([string]$md) {
  if (-not $MissionFile -or -not (Test-Path -LiteralPath $MissionFile)) { return }
  $text = Read-TextRetry $MissionFile
  $nl = if ($text.Contains("`r`n")) { "`r`n" } else { "`n" }
  if ($text.Length -gt 0 -and -not $text.EndsWith("`n")) { $text += $nl }
  Write-TextRetry $MissionFile ($text + $md + $nl)
}

function Write-Outbox([string]$spec) {
  if (-not $MissionFile) { Write-Warning "fake-agent: @@outbox needs -MissionFile"; return }
  $bar = $spec.IndexOf("|")
  if ($bar -lt 0) { Write-Warning "fake-agent: @@outbox <to> <action> | <text>"; return }
  $head = $spec.Substring(0, $bar).Trim() -split '\s+'
  $body = $spec.Substring($bar + 1).Trim()
  $to = $head[0]
  $action = if ($head.Length -gt 1) { $head[1] } else { "message" }
  $gk = Split-Path -Parent $MissionFile
  $outbox = Join-Path $gk "outbox"
  New-Item -ItemType Directory -Force -Path $outbox | Out-Null
  $file = "{0}-{1}.md" -f (Get-Date).ToString("yyyyMMdd-HHmmss"), (Slug $to)
  $tmp = Join-Path $gk (".outbox-" + [Guid]::NewGuid().ToString("N") + ".tmp")
  $content = "to: $to`nfrom: $(Slug $Name)`naction: $action`n---`n$body`n"
  [IO.File]::WriteAllText($tmp, $content, (New-Object System.Text.UTF8Encoding $false))
  # One rename into outbox/: Gridkeeper never sees a half-written instruction.
  Move-Item -LiteralPath $tmp -Destination (Join-Path $outbox $file)
}

function Invoke-GitShow([string[]]$gitArgs) {
  $ErrorActionPreference = "Continue" # stderr lines are output here, not errors (Windows PowerShell 5.1)
  $all = @("-c", "user.name=$GitName", "-c", "user.email=$GitEmail", "-c", "color.ui=false") + $gitArgs
  $out = & git @all 2>&1
  foreach ($o in $out) {
    $s = "$o"
    if ($s.Trim() -ne "") { Write-Host ("    " + $s) -ForegroundColor DarkGray; Pause-Line }
  }
}

function Read-InputLine([string]$prompt) {
  Write-Marked $prompt
  Write-Host "  > " -NoNewline -ForegroundColor Cyan
  $buf = New-Object System.Text.StringBuilder
  $deadline = (Get-Date).AddSeconds($InputTimeoutSec)
  while ((Get-Date) -lt $deadline) {
    $avail = $false
    try { $avail = [Console]::KeyAvailable } catch { $avail = $false }
    if (-not $avail) { Start-Sleep -Milliseconds 40; continue }
    $k = [Console]::ReadKey($true)
    if ($k.Key -eq [ConsoleKey]::Enter) { break }
    if ($k.Key -eq [ConsoleKey]::Backspace) {
      if ($buf.Length -gt 0) { [void]$buf.Remove($buf.Length - 1, 1); Write-Host "`b `b" -NoNewline }
      continue
    }
    if ([int]$k.KeyChar -ge 32) { [void]$buf.Append($k.KeyChar); Write-Host $k.KeyChar -NoNewline }
  }
  Write-Host ""
  $script:lastInput = $buf.ToString().Trim()
  if ($script:lastInput -eq "") { Write-Host "    (no instruction received)" -ForegroundColor DarkGray }
}

function Hold-Forever {
  while ($true) { Start-Sleep -Seconds 3600 }
}

# ---- load and select ---------------------------------------------------------------------------
if (-not (Test-Path -LiteralPath $Transcript)) { throw "transcript not found: $Transcript" }
$all = [IO.File]::ReadAllLines((Resolve-Path -LiteralPath $Transcript).Path, [Text.Encoding]::UTF8)
$lines = New-Object System.Collections.Generic.List[string]
$inSection = -not $Section
foreach ($l in $all) {
  $m = [regex]::Match($l, '^@@section\s+(\S+)')
  if ($m.Success) {
    if ($Section) {
      if ($m.Groups[1].Value -eq $Section) { $inSection = $true; continue }
      if ($inSection) { break }
    }
    continue
  }
  if ($inSection) { $lines.Add($l) }
}
if ($Section -and $lines.Count -eq 0) { Write-Warning "fake-agent: section '$Section' is empty or missing in $Transcript" }

Touch-Signal ("started-" + (Slug $Name))
if (-not $NoClear) { Clear-Host }

# ---- play ---------------------------------------------------------------------------------------
$markAt = 0
$loopsLeft = $null
$i = 0
while ($i -lt $lines.Count) {
  $line = $lines[$i]
  $i++
  if ($line.StartsWith(";;")) { continue }
  if (-not $line.StartsWith("@@")) {
    if ($line.StartsWith("~ ")) { Write-Marked $line.Substring(2) -Typed } else { Write-Marked $line }
    Pause-Line
    continue
  }
  $m = [regex]::Match($line, '^@@(\S+)\s*(.*)$')
  $cmd = $m.Groups[1].Value
  $arg = $m.Groups[2].Value
  switch ($cmd) {
    "pace" { $script:basePace = [int]$arg }
    "fast" { $script:fast = $true }
    "normal" { $script:fast = $false }
    "sleep" { Start-Sleep -Milliseconds ([int]([int]$arg * $Pace)) }
    "clear" { Clear-Host }
    "wait" {
      $w = $arg -split '\s+'
      $limit = if ($w.Length -gt 1) { [int]$w[1] } else { 600 }
      $p = Signal-Path $w[0]
      if ($p) {
        $until = (Get-Date).AddSeconds($limit)
        while (-not (Test-Path -LiteralPath $p) -and (Get-Date) -lt $until) { Start-Sleep -Milliseconds 50 }
      }
    }
    "signal" { Touch-Signal $arg.Trim() }
    "task" {
      $t = [regex]::Match($arg, '^(\S+)\s+(.+)$')
      if ($t.Success) { Set-TaskState $t.Groups[1].Value $t.Groups[2].Value.Trim() }
    }
    "add" { Add-TaskLine $arg }
    "outbox" { Write-Outbox $arg }
    "file" {
      $rel = $arg.Trim()
      $body = New-Object System.Collections.Generic.List[string]
      while ($i -lt $lines.Count -and $lines[$i] -ne "@@end") { $body.Add($lines[$i]); $i++ }
      $i++ # skip @@end
      $path = Join-Path (Get-Location).Path $rel
      New-Item -ItemType Directory -Force -Path (Split-Path -Parent $path) | Out-Null
      [IO.File]::WriteAllText($path, (($body -join "`n") + "`n"), (New-Object System.Text.UTF8Encoding $false))
    }
    "commit" {
      Invoke-GitShow @("add", "-A")
      Invoke-GitShow @("commit", "-m", $arg.Trim())
    }
    "git" { Invoke-GitShow ([regex]::Split($arg.Trim(), '\s+')) }
    "input" { Read-InputLine $arg }
    "notify" { [Console]::Write([string][char]27 + "]9;" + (Expand-Text $arg) + [string][char]7) }
    "mark" { $markAt = $i; $loopsLeft = $null }
    "loop" {
      if ($arg.Trim() -ne "" -and $null -eq $loopsLeft) { $loopsLeft = [int]$arg }
      if ($null -eq $loopsLeft) { $i = $markAt }
      elseif ($loopsLeft -gt 0) { $loopsLeft--; $i = $markAt }
      else { $loopsLeft = $null }
    }
    "hold" { Hold-Forever }
    "end" { }
    default { Write-Warning "fake-agent: unknown directive @@$cmd" }
  }
}
Hold-Forever
