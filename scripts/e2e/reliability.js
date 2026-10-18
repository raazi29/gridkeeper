// E2E reliability checks against the running app (run via cdp.mjs file). PowerShell sessions only.
(async () => {
  const S = window.__gridkeeper.sessions;
  const { useApp } = window.__gridkeeper.store;
  const reg = window.__gridkeeper.registry;
  const ipc = window.__gridkeeper.ipc;
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const waitFor = async (pred, ms = 20000) => {
    const t0 = Date.now();
    while (Date.now() - t0 < ms) {
      if (await pred()) return true;
      await sleep(100);
    }
    return false;
  };
  const text = (id) => window.__gridkeeperTerminals?.text(id) ?? "";
  const cwd = E2E_CWD;
  const scripts = E2E_CWD + "\\scripts\\bench";
  const results = {};

  for (const w of useApp.getState().persisted.workspaces.filter((w) => w.name === "Reliability")) {
    for (const id of w.groups.flatMap((g) => g.sessionIds)) await S.closeSession(id);
    useApp.getState().deleteWorkspace(w.id);
  }
  const wsId = useApp.getState().createWorkspace("Reliability", cwd);
  const groupId = useApp.getState().persisted.workspaces.find((w) => w.id === wsId).groups[0].id;
  const a = S.newSession({ groupId, agent: "powershell", cwd, name: "rel-a" });
  const b = S.newSession({ groupId, agent: "powershell", cwd, name: "rel-b" });
  await waitFor(() => /PS .*>/.test(text(a)) && /PS .*>/.test(text(b)));

  // 1. Malformed / garbage escape sequences must not break the terminal.
  await ipc.sessionWrite(a, `& '${scripts}\\flood.ps1' -Mode garbage; 'AFTER-GARBAGE-' + (6*7)\r`);
  results.garbage = await waitFor(() => text(a).includes("AFTER-GARBAGE-42"), 30000);

  // 2. GPU context loss -> DOM fallback -> WebGL recovery.
  const before = reg.getRendererStatus();
  window.__gridkeeperForceContextLoss?.(a);
  await sleep(1500);
  const during = reg.getRendererStatus();
  await waitFor(() => reg.getRendererStatus().webglActive >= before.webglActive, 15000);
  const after = reg.getRendererStatus();
  await ipc.sessionWrite(a, "'post-loss-ok'\r");
  results.contextLoss = {
    before: before.webglActive,
    during: during.webglActive,
    after: after.webglActive,
    losses: after.contextLosses,
    stillWorks: await waitFor(() => text(a).includes("post-loss-ok")),
  };

  // 3. Hide view, produce lots of output while hidden, reopen -> replay shows the tail.
  S.hideView(b);
  await sleep(300);
  await ipc.sessionWrite(b, "1..50000 | % { \"hidden $_\" }; 'HIDDEN-DONE'\r");
  await waitFor(async () => (await ipc.sessionOutputText(b)).includes("HIDDEN-DONE\r\n") || (await ipc.sessionOutputText(b)).split("HIDDEN-DONE").length > 2, 60000);
  const hiddenHasTerm = reg.hasTerminal?.(b);
  S.showView(b);
  results.hiddenReopen = {
    terminalDisposedWhileHidden: hiddenHasTerm === false,
    replayed: await waitFor(() => text(b).includes("hidden 50000") && text(b).includes("HIDDEN-DONE"), 15000),
    interactiveAfter: false,
  };
  await ipc.sessionWrite(b, "'reopen-ok'\r");
  results.hiddenReopen.interactiveAfter = await waitFor(() => text(b).includes("reopen-ok"));

  // 4. Large paste (200 KB single line read by the child).
  const big = "x".repeat(200 * 1024);
  await ipc.sessionWrite(a, "$l = [Console]::In.ReadLine(); 'PASTE-LEN=' + $l.Length\r");
  await sleep(800);
  const t0 = performance.now();
  for (let i = 0; i < big.length; i += 64 * 1024) await ipc.sessionWrite(a, big.slice(i, i + 64 * 1024));
  await ipc.sessionWrite(a, "\r");
  const pasted = await waitFor(() => /PASTE-LEN=\d+/.test(text(a)), 60000);
  results.largePaste = { ok: pasted, reported: (text(a).match(/PASTE-LEN=(\d+)/) || [])[1], ms: Math.round(performance.now() - t0) };

  // 5. Agent crash: kill the child process externally -> exit detected, others unaffected.
  const pidB = useApp.getState().runtime[b]?.pid;
  await ipc.sessionWrite(a, `Stop-Process -Id ${pidB} -Force; 'KILLED'\r`);
  const exited = await waitFor(() => useApp.getState().runtime[b]?.state.state === "exited", 15000);
  results.crash = { exited, code: useApp.getState().runtime[b]?.state.code, otherAlive: useApp.getState().runtime[a]?.state.state === "running" };

  // 6. Restart after crash.
  await S.restartSession(b, { mode: "none" });
  results.restartAfterCrash = await waitFor(() => useApp.getState().runtime[b]?.state.state === "running" && /PS .*>/.test(text(b).split("[process exited").pop() ?? ""), 20000);

  // 7. Repeated workspace switching: no terminal/listener growth.
  const wsIds = useApp.getState().persisted.workspaces.map((w) => w.id);
  const heap0 = performance.memory?.usedJSHeapSize;
  const terms0 = window.__gridkeeperTerminals.list().length;
  const t1 = performance.now();
  for (let i = 0; i < 60; i++) {
    useApp.getState().setActiveWorkspace(wsIds[i % wsIds.length]);
    await sleep(50);
  }
  useApp.getState().setActiveWorkspace(wsId);
  await sleep(1000);
  results.switching = {
    switches: 60,
    msPerSwitch: Math.round((performance.now() - t1) / 60 - 50),
    terminalsBefore: terms0,
    terminalsAfter: window.__gridkeeperTerminals.list().length,
    heapMBBefore: heap0 && Math.round(heap0 / 1048576),
    heapMBAfter: performance.memory && Math.round(performance.memory.usedJSHeapSize / 1048576),
    renderer: reg.getRendererStatus(),
  };
  return results;
})();
