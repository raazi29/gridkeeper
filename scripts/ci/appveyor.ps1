# AppVeyor, Windows image: Rust if missing, then test (branch builds) or build the NSIS installer (tag builds).
# Node 22 is selected in appveyor.yml (Install-Product only exists in AppVeyor's own PowerShell host).
# Runs under Windows PowerShell 5.1, where a failing native command doesn't throw: every step checks the
# exit code itself. Mirrors .github/workflows/ci.yml.
$ErrorActionPreference = "Continue"

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

if ($env:APPVEYOR_REPO_TAG -eq "true") {
  # Unsigned NSIS installer (tauri.conf.json bundle targets).
  Step "tauri build ($env:APPVEYOR_REPO_TAG_NAME)" { npx tauri build }
} else {
  Step "Typecheck" { npx tsc --noEmit }
  Step "Frontend unit tests" { npx vitest run }
  # generate_context!() embeds dist/, so the Rust crate only compiles once it exists.
  Step "Build frontend" { npm run build }
  Step "cargo test" { cargo test --manifest-path src-tauri/Cargo.toml --lib }
}
