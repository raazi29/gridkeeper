// E2E: IPC sanity after the capability change; a pwsh pane runs a tiny HTTP server; ports are detected;
// a browser pane opens it and the iframe loads the page.
(async () => {
  const G = window.__gridkeeper;
  const { useApp } = G.store;
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const waitFor = async (pred, ms = 20000) => {
    const t0 = Date.now();
    while (Date.now() - t0 < ms) {
      if (await pred()) return true;
      await sleep(250);
    }
    return false;
  };
  const out = {};
  out.ipcList = Array.isArray(await G.ipc.sessionList());
  out.ipcState = !!(await G.ipc.stateLoad()).version;

  for (const w of useApp.getState().persisted.workspaces.filter((w) => w.name === "Browser test")) {
    for (const id of w.groups.flatMap((g) => g.sessionIds)) await G.sessions.closeSession(id);
    useApp.getState().deleteWorkspace(w.id);
  }
  const wsId = useApp.getState().createWorkspace("Browser test", E2E_CWD + "\\docs");
  const g = useApp.getState().persisted.workspaces.find((w) => w.id === wsId).groups[0].id;
  const server = G.sessions.newSession({
    groupId: g, agent: "powershell", cwd: E2E_CWD + "\\docs", name: "web server",
    args: ["-NoProfile", "-NoExit", "-Command", "python -m http.server 8765 --bind 127.0.0.1"],
  });
  out.serverRunning = await waitFor(() => useApp.getState().runtime[server]?.state.state === "running");
  await sleep(3000);
  const ports = await G.ipc.portsList();
  out.ports = JSON.stringify(ports).slice(0, 300);
  out.portDetected = JSON.stringify(ports).includes("8765");

  const browser = await import("/src/actions/browser.ts").catch(() => null);
  const openFn = browser && (browser.openBrowserPane || browser.openUrlInPane || browser.openBrowser || browser.newBrowserPane);
  out.browserApi = browser ? Object.keys(browser) : null;
  if (openFn) await openFn({ groupId: g, url: "http://127.0.0.1:8765/" });
  else out.note = "no open fn found";
  await sleep(4000);
  const frames = [...document.querySelectorAll("iframe")].map((f) => ({ src: f.src, w: f.clientWidth, h: f.clientHeight, visible: !!f.offsetParent }));
  out.frames = frames;
  out.paneKinds = useApp.getState().persisted.sessions.filter((m) => useApp.getState().persisted.workspaces.find((w) => w.id === wsId).groups[0].sessionIds.includes(m.id)).map((m) => m.kind ?? "terminal");
  return out;
})();
