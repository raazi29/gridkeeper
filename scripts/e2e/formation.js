// E2E: launch a real "Plan · Build · Verify" formation against a throwaway git repo (path injected below),
// with PowerShell builders in their own worktrees and a starter prompt, then verify groups/roles/worktrees/prompt.
(async () => {
  const REPO = "__REPO__";
  const G = window.__gridkeeper;
  const { useApp } = G.store;
  const P = await import("/src/actions/formationPlan.ts");
  const F = await import("/src/actions/formations.ts");
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const waitFor = async (pred, ms = 30000) => {
    const t0 = Date.now();
    while (Date.now() - t0 < ms) {
      try { if (await pred()) return true; } catch {}
      await sleep(300);
    }
    return false;
  };
  for (const w of useApp.getState().persisted.workspaces.filter((w) => w.name === "Formation test")) {
    for (const id of w.groups.flatMap((g) => g.sessionIds)) await G.sessions.closeSession(id);
    useApp.getState().deleteWorkspace(w.id);
  }
  const wsId = useApp.getState().createWorkspace("Formation test", REPO);
  const git = await G.ipc.gitInfo(REPO);
  const template = P.builtinTemplate("pbv", { ...P.DEFAULT_PARAMS, builders: 2, builderAgent: "powershell", verifier: false });
  const plan = P.buildFormationPlan({
    template, projectDir: REPO, repoRoot: git.root, useWorktrees: true, branchPrefix: "gk/",
    stamp: P.formationStamp(new Date()), profiles: useApp.getState().profiles.map((p) => ({ id: p.id, name: p.name })),
    profileByRole: {}, prompts: { builder: "Write-Output ('starter-' + 'ok')" },
    existingWorktrees: git.worktrees.map((w) => ({ path: w.path, branch: w.branch })), liveProfileUse: {},
  });
  const summary = {
    errors: plan.errors, warnings: plan.warnings,
    groups: plan.groups.map((g) => `${g.name}: ${g.sessions.map((s) => `${s.role}/${s.agent}`).join(", ")}`),
    worktreeCommands: plan.worktrees.map((w) => `git worktree add -b ${w.branch} ${w.path}`),
  };
  const res = await F.launchFormation(plan, wsId);
  const ws = useApp.getState().persisted.workspaces.find((w) => w.id === wsId);
  const metas = useApp.getState().persisted.sessions.filter((m) => ws.groups.some((g) => g.sessionIds.includes(m.id)));
  const builders = metas.filter((m) => m.role === "builder");
  const promptDelivered = await waitFor(async () => {
    for (const b of builders) if (!(await G.ipc.sessionOutputText(b.id)).includes("starter-ok")) return false;
    return true;
  }, 45000);
  const after = await G.ipc.gitInfo(REPO);
  return {
    plan: summary,
    launched: res.ok, error: res.error ?? null,
    groupsCreated: ws.groups.map((g) => `${g.name}(${g.sessionIds.length})`),
    roles: metas.map((m) => `${m.name}:${m.role}:${m.worktree?.branch ?? "-"}`),
    builderCwdsAreWorktrees: builders.every((b) => b.worktree && b.cwd === b.worktree.path),
    worktreesInRepo: after.worktrees.length,
    starterPromptDeliveredToBuilders: promptDelivered,
    wsId,
  };
})();
