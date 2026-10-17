// E2E: 6 concurrent agent sessions (3 Claude profiles, 2 Codex, 1 PowerShell). Verifies each TUI renders.
// Sends no prompts to the models (no quota use): only waits for each UI to draw.
(async () => {
  const { newSession } = await import("/src/actions/sessions.ts");
  const { useApp, selectActiveWorkspace } = await import("/src/store/appStore.ts");
  const { getRendererStatus } = await import("/src/terminal/registry.ts");
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const app = useApp.getState();
  const wsId = app.createWorkspace("E2E Agents", "D:\\AlteraAI");
  const ws = useApp.getState().persisted.workspaces.find((w) => w.id === wsId);
  const groupId = ws.groups[0].id;
  const profiles = useApp.getState().profiles;
  const ids = [];
  for (const p of profiles.slice(0, 3)) ids.push(["claude:" + p.name, newSession({ groupId, agent: "claude", cwd: "D:\\AlteraAI", profileId: p.id, name: "Claude " + p.name })]);
  ids.push(["codex:1", newSession({ groupId, agent: "codex", cwd: "D:\\AlteraAI", name: "Codex review" })]);
  ids.push(["codex:2", newSession({ groupId, agent: "codex", cwd: "D:\\AlteraAI", name: "Codex fix" })]);
  ids.push(["pwsh", newSession({ groupId, agent: "powershell", cwd: "D:\\AlteraAI", name: "Git" })]);
  await sleep(20000);
  const out = {};
  for (const [label, id] of ids) {
    const rt = useApp.getState().runtime[id];
    const text = (window.__alteraTerminals?.text(id) ?? "").replace(/\s+\n/g, "\n");
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
