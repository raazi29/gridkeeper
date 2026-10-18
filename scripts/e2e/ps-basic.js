// E2E: create a PowerShell session in the running dev app, type into it, verify output. Run via cdp.mjs file.
(async () => {
  const { newSession } = window.__gridkeeper.sessions;
  const { useApp, selectActiveGroup } = window.__gridkeeper.store;
  const ipc = window.__gridkeeper.ipc;
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const st = useApp.getState();
  const group = selectActiveGroup(st);
  const id = newSession({ groupId: group.id, agent: "powershell", cwd: E2E_CWD, name: "e2e-ps" });
  const text = () => window.__gridkeeperTerminals?.text(id) ?? "";
  const waitFor = async (pred, ms = 15000) => {
    const t0 = Date.now();
    while (Date.now() - t0 < ms) {
      if (pred()) return true;
      await sleep(100);
    }
    return false;
  };
  const started = await waitFor(() => useApp.getState().runtime[id]?.state.state === "running");
  const prompt = await waitFor(() => /PS [A-Z]:\\.*>/.test(text()));
  const t0 = performance.now();
  await ipc.sessionWrite(id, "Write-Output ('hello-' + 'altera'); $PSVersionTable.PSVersion.Major\r");
  const echoed = await waitFor(() => text().includes("hello-altera"));
  const latency = Math.round(performance.now() - t0);
  // Unicode
  await ipc.sessionWrite(id, "Write-Output '日本語 ✅ émoji 🚀'\r");
  const uni = await waitFor(() => text().includes("日本語 ✅"));
  // Large output
  const t1 = performance.now();
  await ipc.sessionWrite(id, "1..20000 | % { \"row $_\" }; 'BULK-DONE'\r");
  const bulk = await waitFor(() => /BULK-DONE\s*\n/.test(text()) || text().split("BULK-DONE").length > 2, 60000);
  const bulkMs = Math.round(performance.now() - t1);
  const info = useApp.getState().runtime[id];
  return { id, started, prompt, echoed, latency, uni, bulk, bulkMs, pid: info?.pid, cmd: info?.commandDisplay, tail: text().split("\n").slice(-6) };
})();
