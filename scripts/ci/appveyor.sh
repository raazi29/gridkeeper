#!/usr/bin/env bash
# AppVeyor, Ubuntu / macOS images: system libraries (Linux), Node 22 and Rust if missing, then test (branch
# builds) or build the installers (tag builds: AppImage + deb on Linux, one universal (Apple Silicon + Intel)
# ad-hoc signed dmg on macOS). Both paths end with the built binary's self-tests (scripts/ci/self-test.sh):
# headless everywhere, plus the real window under Xvfb on Linux (informational on macOS).
# Mirrors .github/workflows/ci.yml. Any failing command fails the build.
set -euo pipefail

step() { printf '\n==> %s\n' "$*"; }

if [ "$(uname)" = "Linux" ]; then
  step "Linux system libraries"
  sudo apt-get update -qq
  # xvfb + xauth: virtual display for the window self-test.
  sudo apt-get install -y -qq libwebkit2gtk-4.1-dev libgtk-3-dev libayatana-appindicator3-dev librsvg2-dev libssl-dev patchelf build-essential xvfb xauth
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
echo "host: $(uname -sm)"

step "npm ci"
npm ci

if [ "${APPVEYOR_REPO_TAG:-false}" = "true" ]; then
  # Bundle targets come from tauri.linux.conf.json / tauri.macos.conf.json.
  if [ "$(uname)" = "Darwin" ]; then
    # One dmg for Apple Silicon and Intel: both slices are compiled, then merged with lipo
    # (bundle: src-tauri/target/universal-apple-darwin/release/bundle/dmg/Gridkeeper_<version>_universal.dmg).
    step "Rust targets for a universal macOS build"
    rustup target add aarch64-apple-darwin x86_64-apple-darwin
    step "tauri build --target universal-apple-darwin (${APPVEYOR_REPO_TAG_NAME:-tag})"
    npx tauri build --target universal-apple-darwin
    bin=src-tauri/target/universal-apple-darwin/release/gridkeeper
    lipo -info "$bin"
  else
    step "tauri build (${APPVEYOR_REPO_TAG_NAME:-tag})"
    npx tauri build
    bin=src-tauri/target/release/gridkeeper
  fi
  bash scripts/ci/self-test.sh "$bin" release
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
  # The app binary itself (debug), so CI runs what users run, not only the test harness.
  step "cargo build (debug app binary)"
  cargo build --manifest-path src-tauri/Cargo.toml --bin gridkeeper
  bash scripts/ci/self-test.sh src-tauri/target/debug/gridkeeper dev
fi
