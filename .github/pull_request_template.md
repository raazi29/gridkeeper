## What and why

<!-- What does this change, and what problem does it solve? Link the issue: "Closes #123". -->

## How it was tested

<!-- Commands you ran, e2e scripts, manual steps. For performance-sensitive changes, before/after numbers from scripts/bench. -->

## Screenshots / recording

<!-- Required for UI changes. Check that no account e-mails or tokens are visible. -->

## Checklist

- [ ] `npx tsc --noEmit` passes
- [ ] `npx vitest run` passes
- [ ] `cargo test` passes (run in `src-tauri` from PowerShell)
- [ ] New or changed behaviour has tests
- [ ] UI changes include screenshots and work in a light theme (Ice Planet) and with *Reduce motion*
- [ ] `src-tauri/src/types.rs` and `src/lib/types.ts` were changed together (or the IPC contract is untouched)
- [ ] No terminal output through React state, no new idle polling, narrow zustand selectors, theme variables only
- [ ] No credential files read; no secrets, e-mails or private paths in code, logs, args, tests or screenshots
- [ ] Docs updated (README / ARCHITECTURE / ADR) where behaviour changed
