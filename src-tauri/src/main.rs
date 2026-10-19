// Prevents additional console window on Windows in release, DO NOT REMOVE!!
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

fn main() {
    // Status line helper mode (`--gk-statusline`, run by Claude Code for the cost meter): handled before
    // anything Tauri-related, so it starts no window, no logging and no single-instance check.
    // In release this is a GUI-subsystem exe; the stdin/stdout pipes Claude Code passes still work.
    if let Some(code) = gridkeeper_lib::meter::helper::main_from_env() {
        std::process::exit(code);
    }
    // Built-binary smoke test (`--gk-self-test`, run by CI): data folder, default shell in a PTY,
    // process containment; prints a report and exits. `--gk-self-test-gui` goes through run().
    if let Some(code) = gridkeeper_lib::selftest::main_from_env() {
        std::process::exit(code);
    }
    gridkeeper_lib::run()
}
