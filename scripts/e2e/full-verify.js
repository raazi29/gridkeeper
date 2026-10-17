// Full end-to-end verification against the running dev app. Run via: node scripts/e2e/cdp.mjs file scripts/e2e/full-verify.js
// Uses a dedicated "Verify" workspace with PowerShell panes (no prompts are ever sent to AI agents).
(async () => {
  const G = window.__gridkeeper;
  const { useApp } = G.store;
  const ipc = G.ipc;
  const S = G.sessions;
  const run = (id) => G.commands.runCommand(id);
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const waitFor = async (pred, ms = 20000) => {
    const t0 = Date.now();
    while (Date.now() - t0 < ms) {
      try {
        if (await pred()) return true;
      } catch {}
      await sleep(200);
    }
    return false;
  };
  const text = (id) => window.__gridkeeperTerminals?.text(id) ?? "";
  const visible = (sel) => [...document.querySelectorAll(sel)].some((e) => e.offsetParent);
  const esc = () => document.activeElement?.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true })) ||
    document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
  const R = {};
  const check = async (name, fn) => {
    try {
      const v = await fn();
      R[name] = v === undefined ? true : v;
    } catch (e) {
      R[name] = "ERROR " + String(e?.message ?? e).slice(0, 160);
    }
  };

  // ---- setup
  for (const w of useApp.getState().persisted.workspaces.filter((w) => w.name === "Verify")) {
    for (const id of w.groups.flatMap((g) => g.sessionIds)) await S.closeSession(id);
    useApp.getState().deleteWorkspace(w.id);
  }
  const wsId = useApp.getState().createWorkspace("Verify", "D:\\AlteraAI");
  const groupId = useApp.getState().persisted.workspaces.find((w) => w.id === wsId).groups[0].id;
  const a = S.newSession({ groupId, agent: "powershell", cwd: "D:\\AlteraAI", name: "verify-a" });
  const b = S.newSession({ groupId, agent: "powershell", cwd: "D:\\AlteraAI", name: "verify-b" });
  await waitFor(() => /PS .*>/.test(text(a)) && /PS .*>/.test(text(b)));

  // ---- core terminal
  await check("terminal.interactive", async () => {
    await ipc.sessionWrite(a, "Write-Output ('ok-' + (6*7))\r");
    return await waitFor(() => text(a).includes("ok-42"));
  });
  await check("terminal.unicode", async () => {
    await ipc.sessionWrite(a, "Write-Output '日本語 ✅ 🚀'\r");
    return await waitFor(() => text(a).includes("日本語 ✅"));
  });
  await check("terminal.bulk20k", async () => {
    await ipc.sessionWrite(b, "1..20000 | % { \"r $_\" }; 'BULK-OK'\r");
    // The echoed command scrolls out of the 5,000-line scrollback; check the output tail instead.
    return await waitFor(() => /r 20000\s+BULK-OK/.test(text(b)), 60000);
  });

  // ---- pane UI affordances
  await check("pane.closeButtons", () => [...document.querySelectorAll(".pane-icon-btn--close")].filter((x) => x.offsetParent).length >= 2);
  await check("pane.addButtons", () => [...document.querySelectorAll('[aria-label="Add session"]')].filter((x) => x.offsetParent).length >= 2);
  await check("tabs.addSession", () => visible(".quick-launch--ghost"));
  await check("header.newSession", () => [...document.querySelectorAll("button")].some((x) => x.offsetParent && /New session/.test(x.innerText)));

  // ---- add + close via actions
  await check("session.addAndClose", async () => {
    const c = S.newSession({ groupId, agent: "powershell", cwd: "D:\\AlteraAI", name: "verify-c" });
    const up = await waitFor(() => useApp.getState().runtime[c]?.state.state === "running");
    await S.closeSession(c);
    const gone = await waitFor(() => !useApp.getState().persisted.sessions.some((m) => m.id === c));
    return up && gone;
  });

  // ---- find, zoom
  await check("find.bar", async () => {
    useApp.getState().setFocused(a);
    run("terminal.find");
    const ok = await waitFor(() => visible(".find-bar, [class*=find-bar], [class*=findbar]"), 3000);
    esc();
    return ok;
  });
  await check("zoom", async () => {
    const before = G.registry.getTerminalSize(a);
    useApp.getState().setFocused(a);
    run("terminal.zoomIn");
    run("terminal.zoomIn");
    await sleep(600);
    const after = G.registry.getTerminalSize(a);
    run("terminal.zoomReset");
    await sleep(400);
    return !!before && !!after && after.cols < before.cols;
  });

  // ---- right-click terminal menu (if present)
  await check("contextMenu.terminal", async () => {
    const term = [...document.querySelectorAll(".gk-term")].find((e) => e.offsetParent);
    const el = term?.querySelector(".xterm-screen");
    if (!el) return "no terminal element";
    const r = el.getBoundingClientRect();
    el.dispatchEvent(new MouseEvent("contextmenu", { bubbles: true, cancelable: true, clientX: r.x + 40, clientY: r.y + 40, button: 2 }));
    const ok = await waitFor(() => visible(".menu-item"), 2000);
    const items = [...document.querySelectorAll(".menu-item")].filter((x) => x.offsetParent).map((x) => x.innerText.trim().split(/\r?\n/)[0]).filter(Boolean).slice(0, 30);
    esc();
    document.body.dispatchEvent(new MouseEvent("mousedown", { bubbles: true }));
    return ok ? items.join(" | ") : false;
  });

  // ---- overlays
  for (const [name, id, sel] of [
    ["overlay.mission", "view.mission", '[class*="mission"], [class*="mc-"]'],
    ["overlay.fleet", "view.fleet", '[class*="fleet"]'],
    ["overlay.palette", "view.palette", '[class*="palette"]'],
    ["overlay.changes", "view.changes", '[class*="changes"]'],
  ]) {
    await check(name, async () => {
      run(id);
      const ok = await waitFor(() => visible(sel), 4000);
      if (id === "view.mission" || id === "view.changes") run(id);
      else esc();
      await sleep(400);
      return ok;
    });
  }

  // ---- themes
  await check("themes.allApply", async () => {
    const prev = useApp.getState().persisted.settings.theme;
    const ids = ["deep-space", "twin-suns", "carbonite", "ice-planet", "imperial", "rebel-squadron", "hyperspace", "phosphor", "high-contrast", "holo-comms", "saber-duel", "outer-rim"];
    const seen = new Set();
    for (const t of ids) {
      useApp.getState().updateSettings({ theme: t });
      await sleep(120);
      seen.add(getComputedStyle(document.documentElement).getPropertyValue("--bg-0").trim() + "/" + getComputedStyle(document.documentElement).getPropertyValue("--accent").trim());
    }
    useApp.getState().updateSettings({ theme: prev });
    return `${seen.size}/${ids.length} distinct`;
  });

  // ---- backend services
  await check("diagnostics.gpu", async () => {
    await ipc.diagnosticsSnapshot();
    await sleep(2200);
    const d = await ipc.diagnosticsSnapshot();
    return d.gpu?.available ? `3D ${d.gpu.webview3dPercent?.toFixed(2)}% · ${Math.round((d.gpu.webviewDedicatedBytes ?? 0) / 1048576)} MB` : `unavailable: ${d.gpu?.error}`;
  });
  await check("accounts.detected", async () => {
    const r = await ipc.accountsList();
    const list = Array.isArray(r) ? r : r.accounts ?? [];
    return list.map((x) => `${x.agent}:${x.name}`).join(", ");
  });
  await check("agents.detected", async () => {
    const r = await ipc.agentsDetect();
    return r.filter((x) => x.path && !x.error).map((x) => x.label ?? x.kind).join(", ");
  });
  await check("ports.api", async () => Array.isArray(await ipc.portsList()));
  await check("git.info", async () => (await ipc.gitInfo("D:\\AlteraAI")).isRepo);

  // ---- crash detection + restart
  await check("crash.detectAndRestart", async () => {
    const pid = useApp.getState().runtime[b]?.pid;
    await ipc.sessionWrite(a, `Stop-Process -Id ${pid} -Force\r`);
    const exited = await waitFor(() => useApp.getState().runtime[b]?.state.state === "exited", 15000);
    await S.restartSession(b, { mode: "none" });
    const back = await waitFor(() => useApp.getState().runtime[b]?.state.state === "running", 15000);
    return exited && back;
  });

  // ---- cleanup
  for (const id of [a, b]) await S.closeSession(id);
  useApp.getState().deleteWorkspace(wsId);
  const failed = Object.entries(R).filter(([, v]) => v === false || (typeof v === "string" && v.startsWith("ERROR")));
  return { passed: Object.keys(R).length - failed.length, total: Object.keys(R).length, failed: failed.map(([k]) => k), results: R };
})();
