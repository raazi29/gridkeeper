# AppVeyor, Windows image: Rust if missing, then test (branch builds) or build the NSIS installer (tag builds);
# both end with the built binary's headless self-test (`--gk-self-test`).
# Node 22 is selected in appveyor.yml (Install-Product only exists in AppVeyor's own PowerShell host).
# Runs under Windows PowerShell 5.1, where a failing native command doesn't throw: every step checks the
# exit code itself. Mirrors .github/workflows/ci.yml.
$ErrorActionPreference = "Continue"
# AppVeyor sets CI=True; the Tauri CLI parses CI as its --ci flag and accepts only "true" or "false".
$env:CI = "true"

function Step([string]$name, [scriptblock]$body) {
  Write-Host "==> $name" -ForegroundColor Cyan
  & $body
  if ($LASTEXITCODE -ne 0) {
    Write-Host "FAILED: $name (exit code $LASTEXITCODE)" -ForegroundColor Red
    exit $LASTEXITCODE
  }
}

Step "Node" { node --version }

if (-not (Get-Command cargo -ErrorAction SilentlyContinue)) {
  Step "Install Rust (stable)" {
    Invoke-WebRequest https://win.rustup.rs/x86_64 -OutFile "$env:TEMP\rustup-init.exe"
    & "$env:TEMP\rustup-init.exe" -y --default-toolchain stable --profile minimal
  }
  $env:PATH = "$env:USERPROFILE\.cargo\bin;$env:PATH"
}
Step "Rust" { cargo --version }

Step "npm ci" { npm ci }

if ($env:APPVEYOR_REPO_TAG -eq "true" -and $env:APPVEYOR_REPO_TAG_NAME -like "*-macos") {
  Write-Host "Tag $env:APPVEYOR_REPO_TAG_NAME builds only the macOS dmg; nothing to do on Windows."
  exit 0
}

if ($env:APPVEYOR_REPO_TAG -eq "true") {
  # Unsigned NSIS installer (tauri.conf.json bundle targets).
  Step "tauri build ($env:APPVEYOR_REPO_TAG_NAME)" { npx tauri build }
  # Headless self-test of the shipped binary (src-tauri/src/selftest.rs): data folder, default shell in
  # ConPTY, Job Object containment. Release builds are GUI-subsystem executables, so stdout is redirected
  # to a file and the exit code comes from the process object.
  Step "Self-test of the release binary" {
    $log = Join-Path $env:TEMP "gk-self-test.txt"
    $p = Start-Process -FilePath ".\src-tauri\target\release\gridkeeper.exe" -ArgumentList "--gk-self-test" `
      -Wait -PassThru -NoNewWindow -RedirectStandardOutput $log
    Get-Content $log
    $global:LASTEXITCODE = $p.ExitCode
  }
} else {
  Step "Typecheck" { npx tsc --noEmit }
  Step "Frontend unit tests" { npx vitest run }
  # generate_context!() embeds dist/, so the Rust crate only compiles once it exists.
  Step "Build frontend" { npm run build }
  Step "cargo test" { cargo test --manifest-path src-tauri/Cargo.toml --lib }
  # The app binary itself (debug builds are console executables), so CI runs what users run.
  Step "cargo build (debug app binary)" { cargo build --manifest-path src-tauri/Cargo.toml --bin gridkeeper }
  Step "Self-test of the debug binary" { & ".\src-tauri\target\debug\gridkeeper.exe" --gk-self-test }
}
