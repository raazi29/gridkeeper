#!/usr/bin/env bash
# AppVeyor, Ubuntu / macOS images: system libraries (Linux), Node 22 and Rust if missing, then test (branch
# builds) or build the installers (tag builds: AppImage + deb on Linux, ad-hoc signed dmg on macOS).
# Mirrors .github/workflows/ci.yml. Any failing command fails the build.
set -euo pipefail

step() { printf '\n==> %s\n' "$*"; }

if [ "$(uname)" = "Linux" ]; then
  step "Linux system libraries"
  sudo apt-get update -qq
  sudo apt-get install -y -qq libwebkit2gtk-4.1-dev libgtk-3-dev libayatana-appindicator3-dev librsvg2-dev libssl-dev patchelf build-essential
fi

step "Node 22"
if ! node --version 2>/dev/null | grep -q '^v2[2-9]'; then
  export NVM_DIR="${NVM_DIR:-$HOME/.nvm}"
  # shellcheck disable=SC1091
  [ -s "$NVM_DIR/nvm.sh" ] && . "$NVM_DIR/nvm.sh"
  nvm install 22
  nvm use 22
fi
node --version

step "Rust (stable)"
if ! command -v cargo >/dev/null 2>&1; then
  curl -sSf https://sh.rustup.rs | sh -s -- -y --default-toolchain stable --profile minimal
fi
# shellcheck disable=SC1091
[ -f "$HOME/.cargo/env" ] && . "$HOME/.cargo/env"
rustup update stable >/dev/null 2>&1 || true
cargo --version

step "npm ci"
npm ci

if [ "${APPVEYOR_REPO_TAG:-false}" = "true" ]; then
  # Bundle targets come from tauri.linux.conf.json / tauri.macos.conf.json.
  step "tauri build (${APPVEYOR_REPO_TAG_NAME:-tag})"
  npx tauri build
else
  step "Typecheck"
  npx tsc --noEmit
  step "Frontend unit tests"
  npx vitest run
  # generate_context!() embeds dist/, so the Rust crate only compiles once it exists.
  step "Build frontend"
  npm run build
  step "cargo test"
  cargo test --manifest-path src-tauri/Cargo.toml --lib
fi
