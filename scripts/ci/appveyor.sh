#!/usr/bin/env bash
# AppVeyor, Ubuntu / macOS images: system libraries (Linux), Node 22 and Rust if missing, then test (branch
# builds) or build the installers (tag builds: AppImage + deb on Linux, one Intel ad-hoc signed dmg on
# macOS, which Apple Silicon runs through Rosetta 2). Both paths end with the built binary's self-tests
# (scripts/ci/self-test.sh): headless everywhere, plus the real window under Xvfb on Linux (informational on macOS).
# Mirrors .github/workflows/ci.yml. Any failing command fails the build.
set -euo pipefail
# AppVeyor sets CI=True; the Tauri CLI parses CI as its --ci flag and accepts only "true" or "false".
export CI=true

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

# A "vX.Y.Z-macos" tag builds only the macOS dmg (to add it to an existing release).
if [ "${APPVEYOR_REPO_TAG:-false}" = "true" ] && [ "$(uname)" != "Darwin" ] && [[ "${APPVEYOR_REPO_TAG_NAME:-}" == *-macos ]]; then
  echo "Tag ${APPVEYOR_REPO_TAG_NAME} builds only the macOS dmg; nothing to do here."
  exit 0
fi

if [ "${APPVEYOR_REPO_TAG:-false}" = "true" ]; then
  # Bundle targets come from tauri.linux.conf.json / tauri.macos.conf.json.
  if [ "$(uname)" = "Darwin" ]; then
    # AppVeyor's macOS VM is an Intel machine where a debug compile alone takes ~40 minutes, so a universal
    # (two-slice) release build can't fit the 60-minute job limit. One native Intel dmg instead
    # (bundle: src-tauri/target/release/bundle/dmg/Gridkeeper_<version>_x64.dmg); Apple Silicon Macs run it
    # through Rosetta 2. Lighter optimization than the release profile so the compile fits as well.
    export CARGO_PROFILE_RELEASE_LTO=off CARGO_PROFILE_RELEASE_CODEGEN_UNITS=256 CARGO_PROFILE_RELEASE_OPT_LEVEL=1
    step "tauri build (${APPVEYOR_REPO_TAG_NAME:-tag}, Intel)"
    npx tauri build
    bin=src-tauri/target/release/gridkeeper
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
