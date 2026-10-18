# Type-check the Rust crate for Linux and macOS from this Windows machine (no WSL, nothing linked).
#
#   pwsh -NoProfile -File scripts/dev/unix-check.ps1                 # both targets
#   pwsh -NoProfile -File scripts/dev/unix-check.ps1 -Targets linux  # one target
#
# The gtk / webkit `*-sys` build scripts are fed a fake pkg-config that "finds" every library, and the
# few crates that compile C for macOS get a fake cc / ar that write empty objects. `cargo check` never
# links, so this catches cfg / API mistakes in #[cfg(unix)] code; it runs nothing. CI is the real test.
# First run: `rustup target add x86_64-unknown-linux-gnu aarch64-apple-darwin`, then ~15-20 minutes per
# target with 2 jobs (incremental afterwards). Uses the shared target folder like other agent builds.

param(
    [ValidateSet('linux', 'macos')]
    [string[]]$Targets = @('linux', 'macos'),
    [string]$TargetDir = 'D:\AlteraAI\src-tauri\target',
    [int]$Jobs = 2,
    [double]$MinFreeCommitGB = 4
)
$ErrorActionPreference = 'Stop'

$free = (Get-CimInstance Win32_OperatingSystem).FreeVirtualMemory / 1MB
if ($free -lt $MinFreeCommitGB) {
    throw ("Only {0:N1} GB of free commit (need {1}); a build now could take the live app's WebView2 down." -f $free, $MinFreeCommitGB)
}

$shims = Join-Path ([IO.Path]::GetTempPath()) 'gridkeeper-unix-check'
New-Item -ItemType Directory -Force (Join-Path $shims 'sdk') | Out-Null
Set-Content -Path (Join-Path $shims 'pkg-config.bat') -Encoding ascii -Value @'
@echo off
for %%a in (%*) do (
  if "%%~a"=="--modversion" (
    echo 99.0.0
    exit /b 0
  )
)
exit /b 0
'@
Set-Content -Path (Join-Path $shims 'fake-cc.bat') -Encoding ascii -Value @'
@echo off
:loop
if "%~1"=="" goto done
if "%~1"=="-o" (
  type nul > "%~2"
  goto done
)
shift
goto loop
:done
exit /b 0
'@
[IO.File]::WriteAllText((Join-Path $shims 'empty.a'), "!<arch>`n")
Set-Content -Path (Join-Path $shims 'fake-ar.bat') -Encoding ascii -Value @'
@echo off
if "%~2"=="" exit /b 0
copy /y "%~dp0empty.a" "%~2" >nul
exit /b 0
'@

$env:CARGO_TARGET_DIR = $TargetDir
$env:CARGO_BUILD_JOBS = "$Jobs"
$env:RUST_MIN_STACK = '16777216'
$env:PKG_CONFIG = Join-Path $shims 'pkg-config.bat'
$env:PKG_CONFIG_ALLOW_CROSS = '1'
$env:CC_aarch64_apple_darwin = Join-Path $shims 'fake-cc.bat'
$env:CXX_aarch64_apple_darwin = Join-Path $shims 'fake-cc.bat'
$env:AR_aarch64_apple_darwin = Join-Path $shims 'fake-ar.bat'
$env:SDKROOT = Join-Path $shims 'sdk'
$env:MACOSX_DEPLOYMENT_TARGET = '11.0'

$manifest = Join-Path $PSScriptRoot '..\..\src-tauri\Cargo.toml'
$failed = @()
foreach ($t in $Targets) {
    $triple = if ($t -eq 'linux') { 'x86_64-unknown-linux-gnu' } else { 'aarch64-apple-darwin' }
    Write-Host "== cargo check --lib --tests --target $triple"
    cargo check --manifest-path $manifest --lib --tests --target $triple
    if ($LASTEXITCODE -ne 0) { $failed += $triple }
}
if ($failed) { throw "type-check failed for: $($failed -join ', ')" }
Write-Host 'Unix type-check passed.'
