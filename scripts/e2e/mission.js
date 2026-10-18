// E2E: Mission Control's shared task board (<projectDir>/.gridkeeper/mission.md), against a SANDBOX dev instance.
// Run via:  $env:CDP_PORT = 9333; node scripts/e2e/cdp.mjs file scripts/e2e/mission.js   (see scripts/dev/sandbox.ps1)
// Builds a throwaway git repo under %TEMP% from a helper PowerShell pane, a "Mission test" workspace on it with three
// PowerShell sessions (lead, builder in its own worktree, verifier; never AI agents, never prompts), then checks the
// mission file round trip, the board, live FS-watch updates, click-to-change-state persistence and the builder's
// branch evidence in sign-off. Everything it creates (sessions, workspaces, worktree, temp repo) is removed again.
// Returns { pass, checks: [{ name, ok, detail }] }. DOM queries go by text and [data-node], not class names.
(async () => {
  const G = window.__gridkeeper;
  const { useApp } = G.store;
  const ipc = G.ipc;
  const S = G.sessions;
  const missionUi = G.mission.useMission ?? G.mission;
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const waitFor = async (pred, ms = 20000, step = 150) => {
    const t0 = Date.now();
    while (Date.now() - t0 < ms) {
      try {
        if (await pred()) return true;
      } catch {}
      await sleep(step);
    }
    return false;
  };
  const checks = [];
  /** fn returns { ok, detail }. */
  const check = async (name, fn) => {
    try {
      const r = await fn();
      checks.push({ name, ok: !!r?.ok, detail: r?.detail ?? null });
      return !!r?.ok;
    } catch (e) {
      checks.push({ name, ok: false, detail: "ERROR " + String(e?.message ?? e).slice(0, 300) });
      return false;
    }
  };
  const out = (id) => ipc.sessionOutputText(id).catch(() => "");
  const q = (s) => "'" + String(s).replace(/'/g, "''") + "'"; // PowerShell single-quoted literal
  let seq = 0;
  /** Types a command into a PowerShell session and waits until it has finished (marker built by concatenation so
   *  the echoed command line never matches). */
  const ps = async (id, command, ms = 30000) => {
    const n = ++seq;
    await ipc.sessionWrite(id, `${command}; Write-Output ('GKE2E' + '${n}' + 'OK')\r`);
    const done = await waitFor(async () => (await out(id)).includes(`GKE2E${n}OK`), ms, 200);
    if (!done) throw new Error(`PowerShell command timed out: ${command.slice(0, 120)}`);
    return out(id);
  };
  const promptReady = (id) => waitFor(async () => /PS [^\r\n]*>/.test(await out(id)), 30000, 200);
  const shown = (el) => !!el && el.getClientRects().length > 0;
  /** Deepest visible elements whose text (or input value) contains `text`. */
  const findText = (root, text) =>
    [...(root ?? document).querySelectorAll("*")].filter((e) => {
      if (!shown(e)) return false;
      if ((e.tagName === "INPUT" || e.tagName === "TEXTAREA") && String(e.value ?? "").includes(text)) return true;
      if (!e.textContent?.includes(text)) return false;
      return ![...e.children].some((c) => c.textContent?.includes(text));
    });
  /** The [data-node] that shows the mission (prefers ids containing "mission"), else null. */
  const missionNode = (goal) => {
    const nodes = [...document.querySelectorAll("[data-node]")].filter((n) => shown(n) && n.textContent?.includes(goal));
    return nodes.find((n) => /mission/i.test(n.getAttribute("data-node") ?? "")) ?? nodes[0] ?? null;
  };
  const taskLine = (text, needle) => text.split(/\r?\n/).find((l) => l.includes(needle)) ?? null;

  const WS = "Mission test";
  const SETUP_WS = "Mission test setup";
  const stamp = Date.now().toString(36);
  const goal = `Ship the e2e board ${stamp}`;
  const branch = `gk/mission-builder-${stamp}`;
  const prevActive = useApp.getState().persisted.activeWorkspaceId;
  const created = { sessions: [], workspaces: [] };
  let helper = null; // setup / "external editor" PowerShell, lives in its own workspace
  let builder = null;
  let repo = null;
  let wtPath = null;
  let cleanupDetail = "";

  const removeWorkspaceNamed = async (name) => {
    for (const w of useApp.getState().persisted.workspaces.filter((w) => w.name === name)) {
      for (const id of w.groups.flatMap((g) => g.sessionIds)) await S.closeSession(id);
      useApp.getState().deleteWorkspace(w.id);
    }
  };

  try {
    // ---- environment
    await check("env.sandbox", async () => {
      const info = await ipc.appInfo();
      return { ok: !!info.sandbox, detail: `sandbox=${info.sandbox ?? "null"} v${info.version}` };
    });
    await removeWorkspaceNamed(WS);
    await removeWorkspaceNamed(SETUP_WS);

    // ---- throwaway repo under %TEMP%, built by a helper PowerShell
    const ok = await check("setup.repo", async () => {
      const setupWs = useApp.getState().createWorkspace(SETUP_WS, E2E_CWD);
      created.workspaces.push(setupWs);
      const g = useApp.getState().persisted.workspaces.find((w) => w.id === setupWs).groups[0].id;
      helper = S.newSession({ groupId: g, agent: "powershell", cwd: E2E_CWD, name: "mission-helper", args: ["-NoProfile"] });
      created.sessions.push(helper);
      if (!(await promptReady(helper))) return { ok: false, detail: "helper PowerShell never showed a prompt" };
      const text = await ps(
        helper,
        `$gk = Join-Path ([IO.Path]::GetTempPath()) ${q("gk-mission-" + stamp)}; New-Item -ItemType Directory -Force -Path $gk | Out-Null; ` +
          `git -C $gk init -q -b main; git -C $gk -c user.name=gk-e2e -c user.email=gk-e2e@example.invalid commit -q --allow-empty -m init; ` +
          `Write-Output ('GKREPO' + '<' + $gk + '>END')`,
      );
      const m = /GKREPO<([\s\S]*?)>END/.exec(text);
      repo = m ? m[1].replace(/\r?\n/g, "").trim() : null;
      if (!repo) return { ok: false, detail: "could not read the repo path from the helper's output" };
      const info = await ipc.gitInfo(repo);
      return { ok: info.isRepo, detail: `${repo} (branch ${info.branch})` };
    });
    if (!ok) throw new Error("setup failed");

    const wtOk = await check("setup.worktree", async () => {
      wtPath = repo + "-wt-builder";
      const wt = await ipc.gitWorktreeAdd(repo, wtPath, branch, true);
      wtPath = wt.path ?? wtPath;
      return { ok: wt.branch === branch || (wt.branch ?? "").endsWith(branch), detail: `${wt.path} @ ${wt.branch}` };
    });
    if (!wtOk) throw new Error("worktree setup failed");

    // ---- the workspace under test: three PowerShell sessions with roles
    const wsId = useApp.getState().createWorkspace(WS, repo);
    created.workspaces.push(wsId);
    const groupId = useApp.getState().persisted.workspaces.find((w) => w.id === wsId).groups[0].id;
    const ps1 = { groupId, agent: "powershell", cwd: repo, args: ["-NoProfile"] };
    const lead = S.newSession({ ...ps1, name: "mission-lead", role: "lead" });
    builder = S.newSession({ ...ps1, name: "mission-builder", role: "builder", worktree: { path: wtPath, branch } });
    const verifier = S.newSession({ ...ps1, name: "mission-verifier", role: "verifier" });
    created.sessions.push(lead, builder, verifier);
    useApp.getState().setActiveWorkspace(wsId);
    await check("setup.sessions", async () => {
      const up = await waitFor(() => [lead, builder, verifier].every((id) => useApp.getState().runtime[id]?.state.state === "running"), 30000);
      const metas = useApp.getState().persisted.sessions.filter((m) => [lead, builder, verifier].includes(m.id));
      const prompts = up && (await promptReady(builder));
      return { ok: up && prompts, detail: metas.map((m) => `${m.name}:${m.role}:${m.cwd}`).join(" | ") };
    });

    // ---- mission file contract
    const missionText = [
      `# Mission: ${goal}`,
      "",
      "## Tasks",
      "- [ ] Write the parser @builder",
      "- [~] Review the plan @lead",
      "- [x] Set up the repo @lead",
      "- [!] Waiting on CI @verifier",
      "",
    ].join("\n");
    await check("mission.write", async () => {
      const w = await ipc.missionWrite(repo, missionText, null);
      const r = await ipc.missionRead(repo);
      return { ok: w.exists && r.exists && r.text.includes(`# Mission: ${goal}`) && r.text.includes("- [!] Waiting on CI"), detail: r.path };
    });
    await check("mission.writeConflict", async () => {
      try {
        await ipc.missionWrite(repo, "# Mission: clobber\n", null); // null = must not exist yet
        return { ok: false, detail: "second create-only write was accepted" };
      } catch (e) {
        const msg = String(e?.code ?? "") + " " + String(e?.message ?? e);
        return { ok: /conflict/i.test(msg), detail: msg.trim().slice(0, 160) };
      }
    });

    // ---- the board in Mission Control
    missionUi.getState().toggle(true);
    await check("board.renders", async () => {
      const tasks = ["Write the parser", "Review the plan", "Set up the repo", "Waiting on CI"];
      const okAll = await waitFor(() => {
        const node = missionNode(goal);
        return node && tasks.every((t) => findText(node, t).length);
      }, 10000);
      const node = missionNode(goal);
      return {
        ok: okAll,
        detail: node ? `data-node=${node.getAttribute("data-node")}; missing: ${tasks.filter((t) => !findText(node, t).length).join(", ") || "none"}` : "no [data-node] shows the goal",
      };
    });

    await check("board.liveExternalEdit", async () => {
      const p = repo + "\\.gridkeeper\\mission.md";
      await ps(
        helper,
        `$p = ${q(p)}; $t = [IO.File]::ReadAllText($p); ` +
          `$t = $t.Replace('Write the parser', 'Write the parser v2').TrimEnd() + "\`n- [ ] Added externally @verifier\`n"; ` +
          `Set-Content -LiteralPath $p -Value $t -NoNewline`,
      );
      const t0 = Date.now();
      const seen = await waitFor(() => {
        const node = missionNode(goal);
        return node && findText(node, "Added externally").length && findText(node, "Write the parser v2").length;
      }, 3500, 100);
      const disk = await ipc.missionRead(repo);
      return { ok: seen, detail: `${seen ? "board updated" : "board NOT updated"} after ${Date.now() - t0} ms; file has new task: ${disk.text.includes("Added externally")}` };
    });

    await check("board.clickPersists", async () => {
      const before = taskLine((await ipc.missionRead(repo)).text, "Write the parser v2");
      const node = missionNode(goal);
      const label = node && findText(node, "Write the parser v2")[0];
      if (!label) return { ok: false, detail: "task not on the board" };
      // Walk up from the task text to its row and pick the state box: an explicit checkbox/state control first,
      // else a button that comes before the text (never one that contains the text, never a later row action).
      const boxSel =
        '[role="checkbox"], input[type="checkbox"], [data-task-state], [data-state], [aria-label*="state" i], [title*="state" i], [class*="check" i], [class*="state" i]';
      const isBox = (b) => shown(b) && b !== label && !b.contains(label) && !b.textContent?.includes("Write the parser v2");
      const before_ = (b) => !!(b.compareDocumentPosition(label) & Node.DOCUMENT_POSITION_FOLLOWING);
      let box = null;
      for (let el = label.parentElement, depth = 0; el && el !== node.parentElement && depth < 6 && !box; el = el.parentElement, depth++) {
        box =
          [...el.querySelectorAll(boxSel)].find(isBox) ??
          [...el.querySelectorAll("button, [role='button']")].find((b) => isBox(b) && before_(b)) ??
          null;
      }
      if (!box) return { ok: false, detail: "no state box near the task: " + (label.parentElement?.outerHTML ?? "").slice(0, 300) };
      box.click();
      let after = before;
      const changed = await waitFor(async () => {
        after = taskLine((await ipc.missionRead(repo)).text, "Write the parser v2");
        return after !== null && after !== before;
      }, 5000, 150);
      return { ok: changed, detail: `"${before}" -> "${after}" (clicked <${box.tagName.toLowerCase()}> ${(box.getAttribute("aria-label") ?? box.textContent ?? "").trim().slice(0, 40)})` };
    });

    // ---- sign-off: the builder commits in its worktree, then signals it's done (OSC 9, like an agent would)
    await check("signoff.branchSummary", async () => {
      await ps(
        builder,
        `Set-Content -LiteralPath feature.txt -Value 'built by the mission e2e'; git add feature.txt; ` +
          `git -c user.name=gk-e2e -c user.email=gk-e2e@example.invalid commit -q -m 'mission e2e: builder commit'`,
      );
      const s = await ipc.gitBranchSummary(wtPath, "main");
      return {
        ok: s.isRepo && s.branch === branch && s.ahead >= 1 && s.filesChanged >= 1,
        detail: `${s.branch} vs ${s.base}: ahead ${s.ahead}, behind ${s.behind}, ${s.filesChanged} file(s) +${s.insertions}/-${s.deletions}, uncommitted ${s.uncommitted}, "${s.lastCommitSubject}"`,
      };
    });
    await check("signoff.evidenceShown", async () => {
      await ipc.sessionWrite(builder, "Write-Host ([char]27 + ']9;mission e2e: builder done' + [char]7)\r");
      const evidence = (txt) =>
        txt.includes("mission-builder") &&
        (txt.includes(branch) || /ahead|\u2191\s*\d|\b\d+\s*commits?\b|\b\d+\s*files?\b|\+\d+\s*[/\u2212-]\s*\d+/i.test(txt));
      const signoffText = () =>
        [...document.querySelectorAll("[data-node]")]
          .filter((n) => shown(n) && /sign/i.test(n.getAttribute("data-node") ?? ""))
          .map((n) => n.textContent ?? "")
          .join(" ");
      const seen = await waitFor(() => evidence(signoffText()), 20000, 250);
      return { ok: seen, detail: signoffText().replace(/\s+/g, " ").slice(0, 240) || "no sign-off [data-node] visible" };
    });
  } catch (e) {
    checks.push({ name: "run", ok: false, detail: "ERROR " + String(e?.message ?? e).slice(0, 300) });
  } finally {
    // ---- cleanup: sessions first (the builder's cwd keeps the worktree folder busy), then worktree + repo
    try {
      missionUi.getState().toggle(false);
      for (const id of created.sessions.filter((id) => id !== helper)) await S.closeSession(id);
      if (helper && repo) {
        const text = await ps(
          helper,
          `$r = ${q(repo)}; $w = ${q(wtPath ?? repo + "-wt-builder")}; git -C $r worktree remove --force $w 2>$null; ` +
            `Remove-Item -LiteralPath $w, $r -Recurse -Force -ErrorAction SilentlyContinue; ` +
            `Write-Output ('GKLEFT' + '=' + ((Test-Path -LiteralPath $r) -or (Test-Path -LiteralPath $w)))`,
        ).catch((e) => String(e?.message ?? e));
        cleanupDetail = /GKLEFT=False/.test(text) ? "temp repo and worktree removed" : "temp folders may remain: " + (repo ?? "");
      }
      if (helper) await S.closeSession(helper);
      for (const w of created.workspaces) useApp.getState().deleteWorkspace(w);
      if (prevActive && useApp.getState().persisted.workspaces.some((w) => w.id === prevActive)) useApp.getState().setActiveWorkspace(prevActive);
      const leftovers = useApp.getState().persisted.sessions.filter((m) => created.sessions.includes(m.id)).length;
      checks.push({ name: "cleanup", ok: leftovers === 0 && !cleanupDetail.startsWith("temp folders"), detail: `${leftovers} session(s) left; ${cleanupDetail || "no temp repo created"}` });
    } catch (e) {
      checks.push({ name: "cleanup", ok: false, detail: "ERROR " + String(e?.message ?? e).slice(0, 300) });
    }
  }
  return { pass: checks.every((c) => c.ok), checks };
})();
