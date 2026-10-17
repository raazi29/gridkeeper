// E2E: restart the "Codex daemon" panes in resume modes; report which came up (15 s).
(async () => {
  const S = window.__gridkeeper.sessions;
  const { useApp } = window.__gridkeeper.store;
  const ipc = window.__gridkeeper.ipc;
  const res = {};
  for (const w of useApp.getState().persisted.workspaces.filter((w) => w.name.startsWith("Codex daemon"))) {
    const ids = w.groups.flatMap((g) => g.sessionIds);
    await Promise.all(ids.map((id, i) => S.restartSession(id, i === 0 ? { mode: "continue" } : { mode: "pick" })));
    await new Promise((r) => setTimeout(r, 15000));
    res[w.name] = [];
    for (const id of ids) {
      const t = await ipc.sessionOutputText(id);
      const st = useApp.getState().runtime[id];
      res[w.name].push({ cmd: st?.commandDisplay?.split("codex.exe")[1], state: st?.state?.state, code: st?.state?.code, err: (t.match(/[^\n]*(failed|timed out)[^\n]*/i) || [""])[0].slice(0, 100) });
    }
  }
  return res;
})();
