// "Launch formation" dialog: pick a team template (built-in or saved), project folder, counts, worktrees,
// Claude account per role and optional starter prompts. A live plan preview shows exactly what will
// happen; ONE confirmation lists every group, session and `git worktree add` command before anything
// is created. Also: save the current workspace as a formation.

import { useEffect, useMemo, useRef, useState } from "react";
import {
  BUILTIN_FORMATIONS,
  buildFormationPlan,
  builtinTemplate,
  DEFAULT_PARAMS,
  describePlan,
  formationStamp,
  MAX_BUILDERS,
  MAX_SCOUTS,
  PROFILE_RR,
  PROFILE_SAVED,
  type BuiltinFormationId,
  type BuiltinParams,
  type FormationTemplate,
} from "../../actions/formationPlan";
import { deleteSavedFormation, launchFormation, loadSavedFormations, reusableEmptyGroup, saveWorkspaceAsFormation } from "../../actions/formations";
import { notify } from "../../actions/notify";
import { ipc } from "../../lib/ipc";
import { roleInfo } from "../../lib/roles";
import type { GitInfo } from "../../lib/types";
import { isLive, selectActiveWorkspace, useApp } from "../../store/appStore";
import { useMission } from "../../store/mission";
import { confirmDialog } from "../../store/uiStore";
import { IconFolder } from "../icons";
import { Button } from "../ui/Button";
import { Field, Input, Segmented, Select, Toggle } from "../ui/Field";
import { Modal } from "../ui/Modal";
import { pickFolder } from "../util/pick";
import { RoleTag } from "./RoleTag";
import "../../styles/mission.css";

type Choice = { kind: "builtin"; id: BuiltinFormationId } | { kind: "saved"; id: string };

function Stepper({ value, min, max, onChange, label }: { value: number; min: number; max: number; onChange: (n: number) => void; label: string }) {
  return (
    <div className="stepper" role="group" aria-label={label}>
      <button type="button" className="stepper-btn" aria-label="Fewer" disabled={value <= min} onClick={() => onChange(Math.max(min, value - 1))}>
        −
      </button>
      <span className="stepper-val" aria-live="polite">
        {value}
      </span>
      <button type="button" className="stepper-btn" aria-label="More" disabled={value >= max} onClick={() => onChange(Math.min(max, value + 1))}>
        +
      </button>
    </div>
  );
}

export function FormationDialog() {
  const close = () => useMission.getState().closeFormation();
  const wsId = useApp((s) => selectActiveWorkspace(s)?.id ?? null);
  const wsName = useApp((s) => selectActiveWorkspace(s)?.name ?? "");
  const wsDir = useApp((s) => selectActiveWorkspace(s)?.projectDir ?? "");
  const profiles = useApp((s) => s.profiles);
  const agents = useApp((s) => s.agents);
  const runtime = useApp((s) => s.runtime);

  const [saved, setSaved] = useState<FormationTemplate[]>(() => loadSavedFormations());
  const [choice, setChoice] = useState<Choice>({ kind: "builtin", id: "pbv" });
  const [params, setParams] = useState<BuiltinParams>(DEFAULT_PARAMS);
  const [dir, setDir] = useState(wsDir);
  const [git, setGit] = useState<GitInfo | null>(null);
  const [gitState, setGitState] = useState<"idle" | "checking" | "ok" | "none">("idle");
  const [useWorktrees, setUseWorktrees] = useState(true);
  const [prefix, setPrefix] = useState("gk/");
  const [profileByRole, setProfileByRole] = useState<Record<string, string>>({});
  const [prompts, setPrompts] = useState<Record<string, string>>({});
  const [showPrompts, setShowPrompts] = useState(false);
  const [saveName, setSaveName] = useState("");
  const [busy, setBusy] = useState(false);
  const stamp = useMemo(() => formationStamp(new Date()), []);
  const seq = useRef(0);

  const checkDir = async (path: string) => {
    const n = ++seq.current;
    const p = path.trim();
    setGit(null);
    if (!p) {
      setGitState("idle");
      return;
    }
    setGitState("checking");
    try {
      const g = await ipc.gitInfo(p);
      if (n !== seq.current) return;
      setGit(g.isRepo ? g : null);
      setGitState(g.isRepo ? "ok" : "none");
    } catch {
      if (n === seq.current) setGitState("none");
    }
  };
  useEffect(() => {
    void checkDir(dir);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const template = useMemo<FormationTemplate | null>(() => {
    if (choice.kind === "builtin") return builtinTemplate(choice.id, params);
    return saved.find((t) => t.id === choice.id) ?? null;
  }, [choice, params, saved]);

  // Roles in the template (in order) and which of them run Claude.
  const roles = useMemo(() => {
    const out: { role: string; claude: boolean }[] = [];
    for (const g of template?.groups ?? [])
      for (const s of g.slots) {
        const r = out.find((x) => x.role === s.role);
        if (r) r.claude ||= s.agent === "claude";
        else out.push({ role: s.role, claude: s.agent === "claude" });
      }
    return out;
  }, [template]);

  const liveProfileUse = useMemo(() => {
    const use: Record<string, number> = {};
    for (const id in runtime) {
      const r = runtime[id];
      if (r.agent === "claude" && isLive(r)) use[r.profileId ?? ""] = (use[r.profileId ?? ""] ?? 0) + 1;
    }
    return use;
  }, [runtime]);

  const defaultProfileChoice = (role: string) => {
    if (choice.kind === "saved") return PROFILE_SAVED;
    // The lead gets the first account; everyone else is spread over the least-used accounts.
    if (role === "lead") return profiles[0]?.id ?? "";
    return PROFILE_RR;
  };
  const effectiveProfiles = useMemo(() => {
    const out: Record<string, string> = {};
    for (const r of roles) if (r.claude) out[r.role] = profileByRole[r.role] ?? defaultProfileChoice(r.role);
    return out;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [roles, profileByRole, choice.kind, profiles]);

  const plan = useMemo(() => {
    if (!template) return null;
    return buildFormationPlan({
      template,
      projectDir: dir,
      repoRoot: git?.root ?? null,
      useWorktrees: useWorktrees && !!git?.isRepo,
      branchPrefix: prefix,
      stamp,
      profiles: profiles.map((p) => ({ id: p.id, name: p.name })),
      profileByRole: effectiveProfiles,
      prompts: showPrompts ? prompts : {},
      existingWorktrees: git?.worktrees ?? [],
      liveProfileUse,
    });
  }, [template, dir, git, useWorktrees, prefix, stamp, profiles, effectiveProfiles, prompts, showPrompts, liveProfileUse]);

  const extraWarnings = useMemo(() => {
    const w: string[] = [];
    const needs = new Set(plan?.groups.flatMap((g) => g.sessions.map((s) => s.agent)) ?? []);
    for (const k of ["claude", "codex"] as const) if (needs.has(k) && agents.some((a) => a.kind === k && !a.path)) w.push(`${k === "claude" ? "Claude Code" : "Codex"} was not detected on this PC; those sessions will fail to start until a path is set in Settings.`);
    if (plan && plan.sessionCount > 12) w.push(`${plan.sessionCount} sessions will start (launches of the same agent are spaced out automatically).`);
    if (useWorktrees && gitState === "none" && template?.groups.some((g) => g.slots.some((s) => s.worktreeKey))) w.push("The folder is not a Git repository, so sessions will share the folder instead of using worktrees.");
    return w;
  }, [plan, agents, useWorktrees, gitState, template]);

  const reuse = wsId ? reusableEmptyGroup(wsId) : null;
  const canLaunch = !!wsId && !!plan && plan.errors.length === 0 && gitState !== "checking" && !busy;

  const launch = async () => {
    if (!plan || !wsId || !canLaunch) return;
    const ok = await confirmDialog({
      title: `Launch “${plan.name}” in ${wsName}?`,
      message:
        `Creates ${plan.groups.length} group${plan.groups.length === 1 ? "" : "s"} and starts ${plan.sessionCount} session${plan.sessionCount === 1 ? "" : "s"}` +
        (plan.worktrees.length ? `, after creating ${plan.worktrees.length} Git worktree${plan.worktrees.length === 1 ? "" : "s"} on new branches from the current HEAD` : "") +
        (reuse ? `. The empty group “${reuse.name}” is reused as “${plan.groups[0]?.name}”` : "") +
        ". Nothing is deleted. Agents are never auto-approved; starter prompts are held while an agent asks for confirmation.",
      detail: describePlan(plan),
      confirmLabel: "Create and start",
    });
    if (!ok) return;
    setBusy(true);
    try {
      const r = await launchFormation(plan, wsId);
      if (r.ok) {
        notify("info", `Formation “${plan.name}” started: ${r.sessionIds.length} sessions`);
        close();
      }
    } finally {
      setBusy(false);
    }
  };

  const save = () => {
    if (!wsId) return;
    const t = saveWorkspaceAsFormation(wsId, saveName.trim() || wsName);
    if (t) {
      setSaved(loadSavedFormations());
      setChoice({ kind: "saved", id: t.id });
      setSaveName("");
      notify("info", `Saved formation “${t.name}”`);
    }
  };

  const claudeRoles = roles.filter((r) => r.claude);
  const codexOrTools = useMemo(() => agents.filter((a) => a.preset && !a.error), [agents]);

  return (
    <Modal
      title="Launch formation"
      onClose={close}
      width={720}
      footer={
        <>
          <span className="fm-save">
            <Input value={saveName} onChange={(e) => setSaveName(e.target.value)} placeholder={wsName ? `save “${wsName}” as…` : "formation name"} aria-label="Saved formation name" style={{ width: 200 }} />
            <Button size="sm" onClick={save} disabled={!wsId} title="Save this workspace's groups, roles, agents and accounts (no prompts, env or conversation ids)">
              Save current workspace
            </Button>
          </span>
          <Button onClick={close}>Cancel</Button>
          <Button variant="primary" onClick={() => void launch()} disabled={!canLaunch}>
            {busy ? "Launching…" : "Review and launch…"}
          </Button>
        </>
      }
    >
      <div className="form">
        <Field label="Formation">
          <div className="fm-list" role="radiogroup" aria-label="Formation">
            {BUILTIN_FORMATIONS.map((f) => (
              <button
                key={f.id}
                type="button"
                role="radio"
                aria-checked={choice.kind === "builtin" && choice.id === f.id}
                className={`fm-card${choice.kind === "builtin" && choice.id === f.id ? " is-selected" : ""}`}
                onClick={() => setChoice({ kind: "builtin", id: f.id })}
              >
                <span className="fm-card-name">{f.name}</span>
                <span className="fm-card-desc">{f.description}</span>
              </button>
            ))}
            {saved.map((t) => (
              <div key={t.id} style={{ position: "relative" }}>
                <button
                  type="button"
                  role="radio"
                  aria-checked={choice.kind === "saved" && choice.id === t.id}
                  className={`fm-card${choice.kind === "saved" && choice.id === t.id ? " is-selected" : ""}`}
                  style={{ width: "100%" }}
                  onClick={() => setChoice({ kind: "saved", id: t.id })}
                >
                  <span className="fm-card-name">{t.name}</span>
                  <span className="fm-card-desc">Saved · {t.description}</span>
                </button>
                <button
                  type="button"
                  className="icon-btn icon-btn-sm fm-card-del"
                  aria-label={`Delete saved formation ${t.name}`}
                  title="Delete saved formation"
                  onClick={() => {
                    setSaved(deleteSavedFormation(t.id));
                    if (choice.kind === "saved" && choice.id === t.id) setChoice({ kind: "builtin", id: "pbv" });
                  }}
                >
                  ✕
                </button>
              </div>
            ))}
          </div>
        </Field>

        {choice.kind === "builtin" && choice.id === "pbv" && (
          <div className="fm-row">
            <Field label="Builders">
              <Stepper label="Number of builders" value={params.builders} min={1} max={MAX_BUILDERS} onChange={(n) => setParams({ ...params, builders: n })} />
            </Field>
            <Field label="Builder agent">
              <Segmented
                size="sm"
                ariaLabel="Builder agent"
                value={params.builderAgent}
                onChange={(v) => setParams({ ...params, builderAgent: v })}
                options={[
                  { value: "claude", label: "Claude Code" },
                  { value: "codex", label: "Codex" },
                ]}
              />
            </Field>
            <Field label="Verify">
              <Toggle checked={params.verifier} onChange={(v) => setParams({ ...params, verifier: v })} label="Add a Claude verifier next to the Codex reviewer" />
            </Field>
          </div>
        )}
        {choice.kind === "builtin" && choice.id === "swarm" && (
          <div className="fm-row">
            <Field label="Scouts">
              <Stepper label="Number of scouts" value={params.scouts} min={1} max={MAX_SCOUTS} onChange={(n) => setParams({ ...params, scouts: n })} />
            </Field>
            <Field label="Scout agent">
              <Select value={params.scoutAgent} onChange={(e) => setParams({ ...params, scoutAgent: e.target.value })} aria-label="Scout agent">
                <option value="claude">Claude Code</option>
                <option value="codex">Codex</option>
                {codexOrTools.map((a) => (
                  <option key={a.preset!} value={`preset:${a.preset}`}>
                    {a.label ?? a.preset}
                  </option>
                ))}
                <option value="powershell">PowerShell</option>
              </Select>
            </Field>
          </div>
        )}

        <Field
          label="Project folder"
          hint={gitState === "checking" ? "Checking…" : gitState === "ok" ? `Git repository · ⎇ ${git?.branch ?? "detached"}${git?.dirty ? " · uncommitted changes" : ""}` : gitState === "none" ? "Not a Git repository (worktrees unavailable)" : undefined}
        >
          <div className="input-group">
            <Input mono value={dir} onChange={(e) => setDir(e.target.value)} onBlur={(e) => void checkDir(e.currentTarget.value)} placeholder={"D:\\code\\project"} aria-label="Project folder" />
            <Button
              icon={<IconFolder size={13} />}
              onClick={async () => {
                const d = await pickFolder("Project folder", dir || null);
                if (d) {
                  setDir(d);
                  void checkDir(d);
                }
              }}
            >
              Browse…
            </Button>
          </div>
        </Field>

        {template?.groups.some((g) => g.slots.some((s) => s.worktreeKey)) && (
          <div className="fm-row">
            <Toggle
              checked={useWorktrees && gitState === "ok"}
              disabled={gitState !== "ok"}
              onChange={setUseWorktrees}
              label="Own Git worktree per builder (isolated copy on a new branch)"
              hint="Created one by one with git worktree add -b; nothing is ever deleted"
            />
            <Field label="Branch prefix">
              <Input mono value={prefix} onChange={(e) => setPrefix(e.target.value)} aria-label="Branch prefix" style={{ width: 110 }} disabled={!useWorktrees || gitState !== "ok"} />
            </Field>
          </div>
        )}

        {claudeRoles.length > 0 && (
          <Field label="Claude accounts">
            <div className="fm-roles">
              {claudeRoles.map(({ role }) => (
                <FragmentRow key={role} role={role}>
                  <Select
                    value={effectiveProfiles[role] ?? ""}
                    onChange={(e) => setProfileByRole({ ...profileByRole, [role]: e.target.value })}
                    aria-label={`Claude profile for ${role}`}
                  >
                    {choice.kind === "saved" && <option value={PROFILE_SAVED}>As saved</option>}
                    {profiles.length > 1 && <option value={PROFILE_RR}>Round-robin across {profiles.length} profiles</option>}
                    {profiles.length === 0 && <option value={PROFILE_RR}>Default (~/.claude)</option>}
                    {profiles.length > 0 && <option value="">Default (~/.claude)</option>}
                    {profiles.map((p) => (
                      <option key={p.id} value={p.id}>
                        {p.name}
                      </option>
                    ))}
                  </Select>
                </FragmentRow>
              ))}
            </div>
          </Field>
        )}

        <div>
          <Toggle checked={showPrompts} onChange={setShowPrompts} label="Starter prompts (optional)" hint="Sent once per new agent after it has started and gone quiet; held while it asks for confirmation" />
          {showPrompts && (
            <div className="fm-roles" style={{ marginTop: 8 }}>
              {roles.map(({ role }) => (
                <FragmentRow key={role} role={role}>
                  <textarea
                    className="fm-textarea"
                    value={prompts[role] ?? ""}
                    onChange={(e) => setPrompts({ ...prompts, [role]: e.target.value })}
                    placeholder={`First message for every ${role} (one line)`}
                    aria-label={`Starter prompt for ${role}`}
                    spellCheck={false}
                  />
                </FragmentRow>
              ))}
            </div>
          )}
        </div>

        <Field label="What will happen">
          {plan ? <pre className="fm-plan">{describePlan(plan)}</pre> : <div className="muted">Choose a formation.</div>}
          {(plan?.errors.length || plan?.warnings.length || extraWarnings.length || !wsId) && (
            <div className="fm-msgs" style={{ marginTop: 6 }}>
              {!wsId && <span className="fm-msg-err">Create a workspace first.</span>}
              {plan?.errors.map((e) => (
                <span key={e} className="fm-msg-err">
                  ✕ {e}
                </span>
              ))}
              {[...(plan?.warnings ?? []), ...extraWarnings].map((w) => (
                <span key={w} className="fm-msg-warn">
                  ! {w}
                </span>
              ))}
            </div>
          )}
        </Field>
      </div>
    </Modal>
  );
}

function FragmentRow({ role, children }: { role: string; children: React.ReactNode }) {
  return (
    <>
      <span className="fm-role-name">
        <RoleTag role={role} />
        <span className="muted">{roleInfo(role)?.builtin ? "" : role}</span>
      </span>
      {children}
    </>
  );
}
