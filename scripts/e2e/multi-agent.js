// E2E: 6 concurrent agent sessions (3 Claude profiles, 2 Codex, 1 PowerShell). Verifies each TUI renders.
// Sends no prompts to the models (no quota use): only waits for each UI to draw.
(async () => {
  const { newSession } = window.__gridkeeper.sessions;
  const { useApp, selectActiveWorkspace } = window.__gridkeeper.store;
  const { getRendererStatus } = window.__gridkeeper.registry;
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const app = useApp.getState();
  const wsId = app.createWorkspace("E2E Agents", E2E_CWD);
  const ws = useApp.getState().persisted.workspaces.find((w) => w.id === wsId);
  const groupId = ws.groups[0].id;
  const profiles = useApp.getState().profiles;
  const ids = [];
  for (const p of profiles.slice(0, 3)) ids.push(["claude:" + p.name, newSession({ groupId, agent: "claude", cwd: E2E_CWD, profileId: p.id, name: "Claude " + p.name })]);
  ids.push(["codex:1", newSession({ groupId, agent: "codex", cwd: E2E_CWD, name: "Codex review" })]);
  ids.push(["codex:2", newSession({ groupId, agent: "codex", cwd: E2E_CWD, name: "Codex fix" })]);
  ids.push(["pwsh", newSession({ groupId, agent: "powershell", cwd: E2E_CWD, name: "Git" })]);
  await sleep(20000);
  const out = {};
  for (const [label, id] of ids) {
    const rt = useApp.getState().runtime[id];
    const text = (window.__gridkeeperTerminals?.text(id) ?? "").replace(/\s+\n/g, "\n");
    out[label] = {
      state: rt?.state,
      pid: rt?.pid,
      bytes: rt?.bytesOut,
      cmd: rt?.commandDisplay,
      sample: text.split("\n").filter((l) => l.trim()).slice(0, 8).map((l) => l.slice(0, 100)),
    };
  }
  out.renderer = getRendererStatus();
  out.ids = Object.fromEntries(ids);
  return out;
})();
