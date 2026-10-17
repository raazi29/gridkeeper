// E2E: start 3 Codex sessions in the same tick; report output bytes after 12 s (tiny = hung at startup).
(async () => {
  const { newSession, closeSession } = await import("/src/actions/sessions.ts");
  const { useApp } = await import("/src/store/appStore.ts");
  const ipc = (await import("/src/lib/ipc.ts")).ipc;
  const app = useApp.getState();
  // Clean up earlier runs.
  for (const w of useApp.getState().persisted.workspaces.filter((w) => w.name === "Codex race")) {
    for (const id of w.groups.flatMap((g) => g.sessionIds)) await closeSession(id);
    useApp.getState().deleteWorkspace(w.id);
  }
  const cwd = "D:\\AlteraAI";
  const wsId = app.createWorkspace("Codex race", cwd);
  const g = useApp.getState().persisted.workspaces.find((w) => w.id === wsId).groups[0].id;
  const ids = [0, 1, 2].map(() => newSession({ groupId: g, agent: "codex", cwd }));
  await new Promise((r) => setTimeout(r, 12000));
  const r = {};
  for (const id of ids) {
    const t = await ipc.sessionOutputText(id).catch((e) => "ERR " + String(e?.message));
    r[id.slice(0, 8)] = { len: t.length, first: t.trim().split("\n")[0]?.slice(0, 80) };
  }
  return r;
})();
