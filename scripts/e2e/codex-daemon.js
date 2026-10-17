// E2E: start 3 Codex panes at once with and without --no-daemon; report which ones came up (12 s).
(async () => {
  const { newSession, closeSession } = window.__gridkeeper.sessions;
  const { useApp } = window.__gridkeeper.store;
  const ipc = window.__gridkeeper.ipc;
  for (const w of useApp.getState().persisted.workspaces.filter((w) => w.name.startsWith("Codex daemon"))) {
    for (const id of w.groups.flatMap((g) => g.sessionIds)) await closeSession(id);
    useApp.getState().deleteWorkspace(w.id);
  }
  const cwd = "D:\\AlteraAI";
  const run = async (label, args) => {
    const wsId = useApp.getState().createWorkspace(`Codex daemon ${label}`, cwd);
    const g = useApp.getState().persisted.workspaces.find((w) => w.id === wsId).groups[0].id;
    const ids = [0, 1, 2].map(() => newSession({ groupId: g, agent: "codex", cwd, args }));
    await new Promise((r) => setTimeout(r, 15000));
    const out = [];
    for (const id of ids) {
      const t = await ipc.sessionOutputText(id).catch((e) => "ERR " + e?.message);
      const st = useApp.getState().runtime[id]?.state;
      out.push({ state: st?.state, code: st?.code, ok: /OpenAI Codex|Update available|Trust this folder|Resume a previous/.test(t), err: (t.match(/[^\n]*(failed|timed out|error)[^\n]*/i) || [""])[0].slice(0, 120) });
    }
    return out;
  };
  return { daemon: await run("default", []), noDaemon: await run("no-daemon", ["--no-daemon"]) };
})();
