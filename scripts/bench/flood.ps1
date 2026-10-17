<#
.SYNOPSIS
  Terminal output generator for stress tests. Run inside an Altera session.
  -Mode lines   : N numbered lines with SGR colours (default)
  -Mode sustained: continuous output at roughly -Rate lines/sec for -Seconds
  -Mode unicode : CJK, emoji, combining marks, RTL, box drawing
  -Mode garbage : malformed/truncated escape sequences and random bytes (must not break the terminal)
#>
param(
  [ValidateSet("lines", "sustained", "unicode", "garbage")][string]$Mode = "lines",
  [int]$Count = 20000,
  [int]$Rate = 2000,
  [int]$Seconds = 60
)
$e = [char]27
switch ($Mode) {
  "lines" {
    $sw = [Diagnostics.Stopwatch]::StartNew()
    $sb = [Text.StringBuilder]::new()
    for ($i = 1; $i -le $Count; $i++) {
      [void]$sb.Append("$e[38;5;$((($i % 200) + 16))mline $i$e[0m the quick brown fox jumps over the lazy dog 0123456789`n")
      if ($sb.Length -gt 65536) { [Console]::Out.Write($sb.ToString()); [void]$sb.Clear() }
    }
    [Console]::Out.Write($sb.ToString())
    Write-Host "`nDONE $Count lines in $($sw.ElapsedMilliseconds) ms"
  }
  "sustained" {
    $sw = [Diagnostics.Stopwatch]::StartNew()
    $n = 0
    while ($sw.Elapsed.TotalSeconds -lt $Seconds) {
      $batch = [math]::Max(1, [int]($Rate / 20))
      $sb = [Text.StringBuilder]::new()
      for ($i = 0; $i -lt $batch; $i++) { $n++; [void]$sb.Append("$e[32m[$n]$e[0m sustained output sample line with some text`n") }
      [Console]::Out.Write($sb.ToString())
      Start-Sleep -Milliseconds 50
    }
    Write-Host "`nDONE $n lines in $([int]$sw.Elapsed.TotalSeconds) s"
  }
  "unicode" {
    "日本語のテキスト — 中文字符 — 한국어 텍스트"
    "Emoji: 🚀 ✅ 🧪 👩‍💻 🇺🇸 ❤️"
    "Combining: e$([char]0x0301) a$([char]0x0308) n$([char]0x0303)"
    "RTL: שלום עולם — مرحبا بالعالم"
    "Box: ┌──────┬──────┐`n     │ cell │ cell │`n     └──────┴──────┘"
    "Wide: ＡＢＣ１２３"
  }
  "garbage" {
    $rnd = [Random]::new(42)
    for ($i = 0; $i -lt 200; $i++) {
      $bytes = New-Object byte[] 64
      $rnd.NextBytes($bytes)
      $s = -join ($bytes | ForEach-Object { if ($_ -lt 32 -and $_ -ne 27) { [char]46 } else { [char]$_ } })
      [Console]::Out.Write("$e[$s$e]0;$s$e[?99999h$e[38;5;999m$e[")
    }
    [Console]::Out.Write("$e[0m$e[?25h`r`nGARBAGE DONE - terminal should still be usable`r`n")
  }
}
