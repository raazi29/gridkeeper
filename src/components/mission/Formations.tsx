// "Launch formation" dialog: pick a team template (built-in or saved), project folder, counts, worktrees,
// Claude account per role and optional starter prompts (pre-filled from the mission file on request). A
// live plan preview shows exactly what will happen; ONE confirmation lists every group, session and
// `git worktree add` command before anything is created. Also: save the current workspace as a formation.

import { shellLabel } from "../../lib/platform";
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
  roleKeyOf,
  type BuiltinFormationId,
  type BuiltinParams,
  type FormationTemplate,
} from "../../actions/formationPlan";
import { deleteSavedFormation, launchFormation, loadSavedFormations, reusableEmptyGroup, saveWorkspaceAsFormation } from "../../actions/formations";
import { formationBriefPrompts } from "../../actions/missionBrief";
import { notify } from "../../actions/notify";
import { useT } from "../../i18n";
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
import { TeamTemplates } from "../teamTemplates/TeamTemplates";
import { useTeamTemplateUi } from "../../store/teamTemplates";
import "../../styles/mission.css";

type Choice = { kind: "builtin"; id: BuiltinFormationId } | { kind: "saved"; id: string };

function Stepper({ value, min, max, onChange, label }: { value: number; min: number; max: number; onChange: (n: number) => void; label: string }) {
  const t = useT();
  return (
    <div className="stepper" role="group" aria-label={label}>
      <button type="button" className="stepper-btn" aria-label={t("formations.stepper.fewer")} disabled={value <= min} onClick={() => onChange(Math.max(min, value - 1))}>
        −
      </button>
      <span className="stepper-val" aria-live="polite">
        {value}
      </span>
      <button type="button" className="stepper-btn" aria-label={t("formations.stepper.more")} disabled={value >= max} onClick={() => onChange(Math.min(max, value + 1))}>
        +
      </button>
    </div>
  );
}

export function FormationDialog() {
  const t = useT();
  const close = () => useMission.getState().closeFormation();
  const wsId = useApp((s) => selectActiveWorkspace(s)?.id ?? null);
  const wsName = useApp((s) => selectActiveWorkspace(s)?.name ?? "");
  const wsDir = useApp((s) => selectActiveWorkspace(s)?.projectDir ?? "");
  const profiles = useApp((s) => s.profiles);
  const agents = useApp((s) => s.agents);
  const runtime = useApp((s) => s.runtime);

  const [tab, setTab] = useState<"formations" | "templates">(() => (useTeamTemplateUi.getState().intent ? "templates" : "formations"));
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
  // The workspace's mission file (read once per open): offers to brief the new team from it.
  const [missionPath, setMissionPath] = useState<string | null>(null);
  const [briefOn, setBriefOn] = useState(false);
  const briefed = useRef<Record<string, string>>({});
  useEffect(() => {
    if (!wsDir) return;
    let cancelled = false;
    ipc
      .missionRead(wsDir)
      .then((f) => !cancelled && setMissionPath(f.exists ? f.path : null))
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, [wsDir]);

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
    return saved.find((x) => x.id === choice.id) ?? null;
    // `t`: a language change re-reads the built-in name (and re-plans, so errors / warnings follow).
  }, [choice, params, saved, t]);

  // Roles in the template (in order) and which of them run Claude.
  const roles = useMemo(() => {
    const out: { role: string; claude: boolean }[] = [];
    for (const g of template?.groups ?? [])
      for (const s of g.slots) {
        const key = roleKeyOf(s.role);
        const r = out.find((x) => x.role === key);
        if (r) r.claude ||= s.agent === "claude";
        else out.push({ role: key, claude: s.agent === "claude" });
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

  // Mission briefs as starter prompts: refilled when the planned team changes (names / roles), not on
  // every prompt edit (the plan depends on the prompts, the team key does not).
  const planTeam = useMemo(() => plan?.groups.flatMap((g) => g.sessions.map((s) => ({ name: s.name, role: s.role }))) ?? [], [plan]);
  const teamKey = planTeam.map((m) => `${m.name}=${m.role ?? ""}`).join("|");
  useEffect(() => {
    if (!briefOn || !missionPath) return;
    const next = formationBriefPrompts(roles.map((r) => r.role), planTeam, missionPath);
    briefed.current = next;
    setPrompts((p) => ({ ...p, ...next }));
    setShowPrompts(true);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [briefOn, missionPath, teamKey]);
  const toggleBrief = (on: boolean) => {
    setBriefOn(on);
    if (on) return;
    // Clear the briefs the user did not edit.
    const gen = briefed.current;
    briefed.current = {};
    setPrompts((p) => Object.fromEntries(Object.entries(p).filter(([k, v]) => gen[k] !== v)));
  };

  const extraWarnings = useMemo(() => {
    const w: string[] = [];
    const needs = new Set(plan?.groups.flatMap((g) => g.sessions.map((s) => s.agent)) ?? []);
    for (const k of ["claude", "codex"] as const) if (needs.has(k) && agents.some((a) => a.kind === k && !a.path)) w.push(t("formations.warn.notDetected", { agent: k === "claude" ? "Claude Code" : "Codex" }));
    if (plan && plan.sessionCount > 12) w.push(t("formations.warn.manySessions", { count: plan.sessionCount }));
    if (useWorktrees && gitState === "none" && template?.groups.some((g) => g.slots.some((s) => s.worktreeKey))) w.push(t("formations.warn.notRepo"));
    return w;
  }, [plan, agents, useWorktrees, gitState, template, t]);

  const targetGroupId = useMission((s) => s.formationGroupId);
  const reuse = wsId ? reusableEmptyGroup(wsId, targetGroupId) : null;
  const canLaunch = !!wsId && !!plan && plan.errors.length === 0 && gitState !== "checking" && !busy;

  const launch = async () => {
    if (!plan || !wsId || !canLaunch) return;
    const counts = { groups: plan.groups.length, sessions: plan.sessionCount, worktrees: plan.worktrees.length };
    const ok = await confirmDialog({
      title: t("formations.confirm.title", { name: plan.name, workspace: wsName }),
      message: [
        plan.worktrees.length ? t("formations.confirm.createsWorktrees", counts) : t("formations.confirm.creates", counts),
        reuse ? t("formations.confirm.reuse", { group: reuse.name, name: plan.groups[0]?.name ?? "" }) : "",
        t("formations.confirm.safety"),
      ]
        .filter(Boolean)
        .join(" "),
      detail: describePlan(plan),
      confirmLabel: t("formations.confirm.ok"),
    });
    if (!ok) return;
    setBusy(true);
    try {
      const r = await launchFormation(plan, wsId, { groupId: targetGroupId });
      if (r.ok) {
        notify("info", t("formations.toast.started", { name: plan.name, count: r.sessionIds.length }));
        close();
      }
    } finally {
      setBusy(false);
    }
  };

  const save = () => {
    if (!wsId) return;
    const tpl = saveWorkspaceAsFormation(wsId, saveName.trim() || wsName);
    if (tpl) {
      setSaved(loadSavedFormations());
      setChoice({ kind: "saved", id: tpl.id });
      setSaveName("");
      notify("info", t("formations.toast.saved", { name: tpl.name }));
    }
  };

  const claudeRoles = roles.filter((r) => r.claude);
  const codexOrTools = useMemo(() => agents.filter((a) => a.preset && !a.error), [agents]);

  const tabs = (
    <Segmented
      size="sm"
      ariaLabel={t("formations.tabsAria")}
      value={tab}
      onChange={setTab}
      options={[
        { value: "formations", label: t("formations.tab.formations") },
        { value: "templates", label: t("formations.tab.templates") },
      ]}
    />
  );
  if (tab === "templates") return <TeamTemplates onClose={close} tabs={tabs} />;

  return (
    <Modal
      title={t("formations.title")}
      onClose={close}
      width={720}
      headerExtra={tabs}
      footer={
        <>
          <span className="fm-save">
            <Input
              value={saveName}
              onChange={(e) => setSaveName(e.target.value)}
              placeholder={wsName ? t("formations.save.placeholder", { name: wsName }) : t("formations.save.placeholderEmpty")}
              aria-label={t("formations.save.aria")}
              style={{ width: 200 }}
            />
            <Button size="sm" onClick={save} disabled={!wsId} title={t("formations.save.title")}>
              {t("formations.save.button")}
            </Button>
          </span>
          <Button onClick={close}>{t("common.cancel")}</Button>
          <Button variant="primary" onClick={() => void launch()} disabled={!canLaunch}>
            {busy ? t("formations.launching") : t("formations.review")}
          </Button>
        </>
      }
    >
      <div className="form">
        <Field label={t("formations.field.formation")}>
          <div className="fm-list" role="radiogroup" aria-label={t("formations.field.formation")}>
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
            {saved.map((tpl) => (
              <div key={tpl.id} style={{ position: "relative" }}>
                <button
                  type="button"
                  role="radio"
                  aria-checked={choice.kind === "saved" && choice.id === tpl.id}
                  className={`fm-card${choice.kind === "saved" && choice.id === tpl.id ? " is-selected" : ""}`}
                  style={{ width: "100%" }}
                  onClick={() => setChoice({ kind: "saved", id: tpl.id })}
                >
                  <span className="fm-card-name">{tpl.name}</span>
                  <span className="fm-card-desc">
                    {t("formations.savedCard", { groups: tpl.groups.length, sessions: tpl.groups.reduce((n, g) => n + g.slots.length, 0) })}
                  </span>
                </button>
                <button
                  type="button"
                  className="icon-btn icon-btn-sm fm-card-del"
                  aria-label={t("formations.deleteAria", { name: tpl.name })}
                  title={t("formations.deleteTitle")}
                  onClick={() => {
                    setSaved(deleteSavedFormation(tpl.id));
                    if (choice.kind === "saved" && choice.id === tpl.id) setChoice({ kind: "builtin", id: "pbv" });
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
            <Field label={t("formations.field.builders")}>
              <Stepper label={t("formations.buildersAria")} value={params.builders} min={1} max={MAX_BUILDERS} onChange={(n) => setParams({ ...params, builders: n })} />
            </Field>
            <Field label={t("formations.field.builderAgent")}>
              <Segmented
                size="sm"
                ariaLabel={t("formations.field.builderAgent")}
                value={params.builderAgent}
                onChange={(v) => setParams({ ...params, builderAgent: v })}
                options={[
                  { value: "claude", label: "Claude Code" },
                  { value: "codex", label: "Codex" },
                ]}
              />
            </Field>
            <Field label={t("formations.field.verify")}>
              <Toggle checked={params.verifier} onChange={(v) => setParams({ ...params, verifier: v })} label={t("formations.verifierToggle")} />
            </Field>
          </div>
        )}
        {choice.kind === "builtin" && choice.id === "swarm" && (
          <div className="fm-row">
            <Field label={t("formations.field.scouts")}>
              <Stepper label={t("formations.scoutsAria")} value={params.scouts} min={1} max={MAX_SCOUTS} onChange={(n) => setParams({ ...params, scouts: n })} />
            </Field>
            <Field label={t("formations.field.scoutAgent")}>
              <Select value={params.scoutAgent} onChange={(e) => setParams({ ...params, scoutAgent: e.target.value })} aria-label={t("formations.field.scoutAgent")}>
                <option value="claude">Claude Code</option>
                <option value="codex">Codex</option>
                {codexOrTools.map((a) => (
                  <option key={a.preset!} value={`preset:${a.preset}`}>
                    {a.label ?? a.preset}
                  </option>
                ))}
                <option value="powershell">{shellLabel()}</option>
              </Select>
            </Field>
          </div>
        )}

        <Field
          label={t("formations.field.projectFolder")}
          hint={
            gitState === "checking"
              ? t("formations.git.checking")
              : gitState === "ok"
                ? t(git?.dirty ? "formations.git.repoDirty" : "formations.git.repo", { branch: git?.branch ?? t("formations.git.detached") })
                : gitState === "none"
                  ? t("formations.git.none")
                  : undefined
          }
        >
          <div className="input-group">
            <Input mono value={dir} onChange={(e) => setDir(e.target.value)} onBlur={(e) => void checkDir(e.currentTarget.value)} placeholder={"D:\\code\\project"} aria-label={t("formations.field.projectFolder")} />
            <Button
              icon={<IconFolder size={13} />}
              onClick={async () => {
                const d = await pickFolder(t("formations.field.projectFolder"), dir || null);
                if (d) {
                  setDir(d);
                  void checkDir(d);
                }
              }}
            >
              {t("common.browse")}
            </Button>
          </div>
        </Field>

        {template?.groups.some((g) => g.slots.some((s) => s.worktreeKey)) && (
          <div className="fm-row">
            <Toggle
              checked={useWorktrees && gitState === "ok"}
              disabled={gitState !== "ok"}
              onChange={setUseWorktrees}
              label={t("formations.worktrees.label")}
              hint={t("formations.worktrees.hint")}
            />
            <Field label={t("formations.field.branchPrefix")}>
              <Input mono value={prefix} onChange={(e) => setPrefix(e.target.value)} aria-label={t("formations.field.branchPrefix")} style={{ width: 110 }} disabled={!useWorktrees || gitState !== "ok"} />
            </Field>
          </div>
        )}

        {claudeRoles.length > 0 && (
          <Field label={t("formations.field.claudeAccounts")}>
            <div className="fm-roles">
              {claudeRoles.map(({ role }) => (
                <FragmentRow key={role} role={role}>
                  <Select
                    value={effectiveProfiles[role] ?? ""}
                    onChange={(e) => setProfileByRole({ ...profileByRole, [role]: e.target.value })}
                    aria-label={t("formations.profileAria", { role })}
                  >
                    {choice.kind === "saved" && <option value={PROFILE_SAVED}>{t("formations.profile.asSaved")}</option>}
                    {profiles.length > 1 && <option value={PROFILE_RR}>{t("formations.profile.roundRobin", { count: profiles.length })}</option>}
                    {profiles.length === 0 && <option value={PROFILE_RR}>{t("formations.profile.default")}</option>}
                    {profiles.length > 0 && <option value="">{t("formations.profile.default")}</option>}
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
          {missionPath && (
            <div style={{ marginBottom: 8 }}>
              <Toggle
                checked={briefOn}
                onChange={toggleBrief}
                label={t("formations.brief.label")}
                hint={t("formations.brief.hint", { path: missionPath })}
              />
            </div>
          )}
          <Toggle checked={showPrompts} onChange={setShowPrompts} label={t("formations.prompts.label")} hint={t("formations.prompts.hint")} />
          {showPrompts && (
            <div className="fm-roles" style={{ marginTop: 8 }}>
              {roles.map(({ role }) => (
                <FragmentRow key={role} role={role}>
                  <textarea
                    className="fm-textarea"
                    value={prompts[role] ?? ""}
                    onChange={(e) => setPrompts({ ...prompts, [role]: e.target.value })}
                    placeholder={t("formations.prompts.placeholder", { role })}
                    aria-label={t("formations.prompts.aria", { role })}
                    spellCheck={false}
                  />
                </FragmentRow>
              ))}
            </div>
          )}
        </div>

        <Field label={t("formations.field.plan")}>
          {plan ? <pre className="fm-plan">{describePlan(plan)}</pre> : <div className="muted">{t("formations.choose")}</div>}
          {(plan?.errors.length || plan?.warnings.length || extraWarnings.length || !wsId) && (
            <div className="fm-msgs" style={{ marginTop: 6 }}>
              {!wsId && <span className="fm-msg-err">{t("formations.noWorkspace")}</span>}
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
  const t = useT();
  return (
    <>
      <span className="fm-role-name">
        <RoleTag role={role} />
        <span className="muted">{roleInfo(role)?.builtin ? "" : role === "agent" ? t("formations.noRole") : role}</span>
      </span>
      {children}
    </>
  );
}
