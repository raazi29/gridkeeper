#!/usr/bin/env bash
# Run a built Gridkeeper binary's self-tests (src-tauri/src/selftest.rs). Used by appveyor.sh and
# .github/workflows/ci.yml, from the repository root:
#
#   bash scripts/ci/self-test.sh <binary> <dev|release>
#
# 1. `--gk-self-test` (headless, always fatal): data folder, default shell in a PTY, process containment.
#    A universal macOS binary on an Apple Silicon host with Rosetta also runs its Intel slice (not fatal).
# 2. `--gk-self-test-gui`: the real window must come up and the frontend must call into Rust over IPC.
#    Linux: under Xvfb, required. macOS: optional (needs a GUI session on the build machine). Windows:
#    skipped. GK_GUI_SELF_TEST=required|optional|off overrides the default.
#    `dev` = a debug build, which loads the frontend from devUrl (http://localhost:1420), so `vite preview`
#    serves dist/ there for the duration; release builds embed the frontend.
set -euo pipefail

bin="${1:?usage: self-test.sh <binary> <dev|release>}"
mode="${2:-release}"
os="$(uname -s)"
step() { printf '\n==> %s\n' "$*"; }

step "Self-test of the $mode binary ($bin)"
"$bin" --gk-self-test

if [ "$os" = "Darwin" ] && [ "$mode" = "release" ] && [ "$(uname -m)" = "arm64" ] \
  && lipo -archs "$bin" 2>/dev/null | grep -q x86_64 && arch -x86_64 /usr/bin/true 2>/dev/null; then
  step "Self-test of the Intel slice (Rosetta)"
  arch -x86_64 "$bin" --gk-self-test || echo "Intel slice self-test failed (not fatal)"
fi

policy="${GK_GUI_SELF_TEST:-}"
if [ -z "$policy" ]; then
  case "$os" in
    Linux) policy=required ;;
    Darwin) policy=optional ;;
    *) policy=off ;;
  esac
fi
if [ "$policy" = "off" ]; then
  echo "window self-test skipped on $os (GK_GUI_SELF_TEST=$policy)"
  exit 0
fi

step "Window self-test of the $mode binary ($policy)"
preview_pid=""
cleanup() { if [ -n "$preview_pid" ]; then kill "$preview_pid" 2>/dev/null || true; fi; }
trap cleanup EXIT
if [ "$mode" = "dev" ]; then
  node node_modules/vite/bin/vite.js preview --port 1420 --strictPort >"${TMPDIR:-/tmp}/gk-vite-preview.log" 2>&1 &
  preview_pid=$!
  for _ in $(seq 1 60); do
    curl -fsS -o /dev/null http://localhost:1420/ 2>/dev/null && break
    sleep 0.5
  done
fi

rc=0
export GK_SELF_TEST_TIMEOUT="${GK_SELF_TEST_TIMEOUT:-120}"
if [ "$os" = "Linux" ]; then
  runner=(timeout 300 xvfb-run -a -s "-screen 0 1440x900x24")
  if command -v dbus-run-session >/dev/null 2>&1; then
    runner=(timeout 300 dbus-run-session -- xvfb-run -a -s "-screen 0 1440x900x24")
  fi
  "${runner[@]}" "$bin" --gk-self-test-gui || rc=$?
else
  # The self-test has its own hard deadline (GK_SELF_TEST_TIMEOUT + 30 s), so this cannot hang the job.
  "$bin" --gk-self-test-gui || rc=$?
fi

if [ "$rc" -ne 0 ]; then
  if [ "$policy" = "required" ]; then
    echo "window self-test failed (exit $rc)"
    exit "$rc"
  fi
  echo "window self-test failed (exit $rc); not fatal here (GK_GUI_SELF_TEST=$policy)"
fi
