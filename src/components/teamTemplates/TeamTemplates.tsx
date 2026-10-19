// "Templates" tab of the Formations dialog: a gallery of built-in team templates, import (open a
// `.gridkeeper-team.json` file or paste JSON) with a full preview of what will be created, and export of the
// current workspace or a saved formation. Imported templates are sanitized (actions/teamTemplatePlan.ts) and
// launched through the same reviewed plan + confirmation as a formation. Strings are plain English for now.

import { useEffect, useMemo, useRef, useState } from "react";
import { describePlan, formationStamp, roleKeyOf, type FormationTemplate } from "../../actions/formationPlan";
import { loadSavedFormations, reusableEmptyGroup } from "../../actions/formations";
import { notify } from "../../actions/notify";
import {
  defaultRolePrompt,
  missionPathFor,
  missionTextFromTemplate,
  planTeamTemplate,
  renderPrompt,
  serializeTeamTemplate,
  templateTaskLines,
  type LeadMode,
  type MissionChoice,
  type TeamTemplate,
  type TemplateCheck,
} from "../../actions/teamTemplatePlan";
import {
  activeWorkspaceExportBase,
  buildExport,
  checkTemplateText,
  launchTeamTemplate,
  loadAppVersion,
  readTemplateFile,
  saveTeamTemplateFile,
  type WorkspaceExportBase,
} from "../../actions/teamTemplates";
import { ipc } from "../../lib/ipc";
import { roleInfo } from "../../lib/roles";
import { TEAM_GALLERY, galleryKey } from "../../lib/teamGallery";
import type { GitInfo } from "../../lib/types";
import { isLive, selectActiveWorkspace, useApp } from "../../store/appStore";
import { useMission } from "../../store/mission";
import { takeTemplateIntent } from "../../store/teamTemplates";
import { confirmDialog } from "../../store/uiStore";
import { IconFolder } from "../icons";
import { RoleTag } from "../mission/RoleTag";
import { Button } from "../ui/Button";
import { Field, Input, Segmented, Select, Toggle } from "../ui/Field";
import { Modal } from "../ui/Modal";
import { copyText, pickFolder } from "../util/pick";
import "../../styles/mission.css";
import "../../styles/teamTemplates.css";

type Selected = { key: string; label: string; check: TemplateCheck };

const LEAD_LABEL: Record<LeadMode, string> = { off: "off", advisor: "advisor (instructions wait for your approval)", autopilot: "autopilot (instructions are delivered automatically)" };

export function TeamTemplates({ onClose, tabs }: { onClose: () => void; tabs: React.ReactNode }) {
  const intent = useMemo(() => takeTemplateIntent(), []);
  const [view, setView] = useState<"browse" | "export">(intent === "export" ? "export" : "browse");
  const [pasteOpen, setPasteOpen] = useState(intent === "import");
  useEffect(() => void loadAppVersion(), []);
  return view === "export" ? (
    <ExportPanel onClose={onClose} tabs={tabs} onBack={() => setView("browse")} />
  ) : (
    <ImportPanel onClose={onClose} tabs={tabs} pasteOpen={pasteOpen} setPasteOpen={setPasteOpen} onExport={() => setView("export")} />
  );
}

// ---- gallery + import ----------------------------------------------------------------------------

function ImportPanel({ onClose, tabs, pasteOpen, setPasteOpen, onExport }: { onClose: () => void; tabs: React.ReactNode; pasteOpen: boolean; setPasteOpen: (v: boolean) => void; onExport: () => void }) {
  const wsId = useApp((s) => selectActiveWorkspace(s)?.id ?? null);
  const wsName = useApp((s) => selectActiveWorkspace(s)?.name ?? "");
  const wsDir = useApp((s) => selectActiveWorkspace(s)?.projectDir ?? "");
  const profiles = useApp((s) => s.profiles);
  const agents = useApp((s) => s.agents);
  const runtime = useApp((s) => s.runtime);

  const gallery = useMemo<Selected[]>(() => TEAM_GALLERY.map((t) => ({ key: galleryKey(t), label: "Built-in", check: { template: t, errors: [], warnings: [] } })), []);
  const [imported, setImported] = useState<Selected | null>(null);
  const [selKey, setSelKey] = useState<string>(gallery[0]?.key ?? "");
  const [paste, setPaste] = useState("");
  const fileRef = useRef<HTMLInputElement>(null);
  const selected = imported?.key === selKey ? imported : (gallery.find((g) => g.key === selKey) ?? null);
  const t = selected?.check.template ?? null;

  const [dir, setDir] = useState(wsDir);
  const [git, setGit] = useState<GitInfo | null>(null);
  const [gitState, setGitState] = useState<"idle" | "checking" | "ok" | "none">("idle");
  const [mission, setMission] = useState<{ exists: boolean; path: string } | null>(null);
  const [missionChoice, setMissionChoice] = useState<MissionChoice>("merge");
  const [useWorktrees, setUseWorktrees] = useState(true);
  const [prefix, setPrefix] = useState("gk/");
  const [goal, setGoal] = useState("");
  const [applyLead, setApplyLead] = useState(true);
  const [queueNotes, setQueueNotes] = useState(true);
  const [busy, setBusy] = useState(false);
  const stamp = useMemo(() => formationStamp(new Date()), []);
  const seq = useRef(0);

  const checkDir = async (path: string) => {
    const n = ++seq.current;
    const p = path.trim();
    setGit(null);
    setMission(null);
    if (!p) return setGitState("idle");
    setGitState("checking");
    const [g, m] = await Promise.all([ipc.gitInfo(p).catch(() => null), ipc.missionRead(p).catch(() => null)]);
    if (n !== seq.current) return;
    setGit(g?.isRepo ? g : null);
    setGitState(g?.isRepo ? "ok" : "none");
    setMission(m ? { exists: m.exists, path: m.path } : null);
  };
  useEffect(() => {
    void checkDir(dir);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const take = (key: string, label: string, check: TemplateCheck) => {
    if (!check.template) {
      notify("error", `Not imported: ${check.errors.join(" ")}`);
      return;
    }
    setImported({ key, label, check });
    setSelKey(key);
    setPasteOpen(false);
    setApplyLead(check.template.leadControl !== "autopilot");
  };
  const onFile = async (f: File | undefined) => {
    if (!f) return;
    take(`file:${f.name}:${Date.now()}`, `From ${f.name}`, await readTemplateFile(f));
  };

  const liveProfileUse = useMemo(() => {
    const use: Record<string, number> = {};
    for (const id in runtime) {
      const r = runtime[id];
      if (r.agent === "claude" && isLive(r)) use[r.profileId ?? ""] = (use[r.profileId ?? ""] ?? 0) + 1;
    }
    return use;
  }, [runtime]);

  const hasWorktrees = !!t?.formation.groups.some((g) => g.slots.some((s) => s.worktree));
  const plan = useMemo(() => {
    if (!t) return null;
    return planTeamTemplate(t, {
      projectDir: dir,
      repoRoot: git?.root ?? null,
      useWorktrees: useWorktrees && !!git?.isRepo,
      branchPrefix: prefix,
      stamp,
      profiles: profiles.map((p) => ({ id: p.id, name: p.name })),
      existingWorktrees: git?.worktrees ?? [],
      liveProfileUse,
    });
  }, [t, dir, git, useWorktrees, prefix, stamp, profiles, liveProfileUse]);

  const team = useMemo(() => plan?.groups.flatMap((g) => g.sessions.map((s) => ({ name: s.name, role: s.role }))) ?? [], [plan]);
  const missionPath = mission?.path ?? (dir.trim() ? missionPathFor(dir) : "");
  const writesNewMission = !!t && (t.mission.tasks.length > 0 || !!goal.trim()) && (!mission?.exists || missionChoice === "replace");
  const needsGoal = writesNewMission && !goal.trim();

  const extraWarnings = useMemo(() => {
    const w: string[] = [...(selected?.check.warnings ?? [])];
    const needs = new Set(plan?.groups.flatMap((g) => g.sessions.map((s) => s.agent)) ?? []);
    for (const k of ["claude", "codex"] as const) if (needs.has(k) && agents.some((a) => a.kind === k && !a.path)) w.push(`${k === "claude" ? "Claude Code" : "Codex"} was not detected on this PC; those sessions will fail to start until a path is set in Settings.`);
    if (hasWorktrees && useWorktrees && gitState === "none") w.push("The folder is not a Git repository, so sessions will share the folder instead of using worktrees.");
    return w;
  }, [selected, plan, agents, hasWorktrees, useWorktrees, gitState]);

  const targetGroupId = useMission((s) => s.formationGroupId);
  const canLaunch = !!t && !!wsId && !!plan && plan.errors.length === 0 && gitState !== "checking" && !needsGoal && !busy;

  const launch = async () => {
    if (!t || !plan || !wsId || !canLaunch) return;
    const reuse = reusableEmptyGroup(wsId, targetGroupId);
    const missionLine = !t.mission.tasks.length && !goal.trim() ? "" : !mission?.exists ? ` Writes a new mission file with ${t.mission.tasks.length} tasks.` : missionChoice === "merge" ? " Adds the template's tasks to the existing mission file." : missionChoice === "replace" ? " Replaces the existing mission file." : " Keeps the existing mission file.";
    const ok = await confirmDialog({
      title: `Launch “${t.meta.name}” in ${wsName}?`,
      message:
        `Creates ${plan.groups.length} group${plan.groups.length === 1 ? "" : "s"} and starts ${plan.sessionCount} session${plan.sessionCount === 1 ? "" : "s"}` +
        (plan.worktrees.length ? `, after creating ${plan.worktrees.length} Git worktree${plan.worktrees.length === 1 ? "" : "s"} on new branches from the current HEAD` : "") +
        (reuse ? `. The empty group “${reuse.name}” is reused as “${plan.groups[0]?.name}”` : "") +
        `.${missionLine} Nothing in the template is executed; starter prompts are typed into the agents once they are idle. Agents are never auto-approved.`,
      detail: describePlan(plan),
      confirmLabel: "Create and start",
    });
    if (!ok) return;
    setBusy(true);
    try {
      const r = await launchTeamTemplate(t, plan, {
        workspaceId: wsId,
        projectDir: dir.trim(),
        goal,
        missionChoice,
        applyLeadControl: applyLead && t.leadControl !== "off",
        queueNotes: queueNotes && t.brain.length > 0,
        groupId: targetGroupId,
      });
      if (r.ok) {
        notify("info", `Team “${t.meta.name}” started: ${r.sessionIds.length} sessions`);
        onClose();
      }
    } finally {
      setBusy(false);
    }
  };

  const cards = imported ? [imported, ...gallery] : gallery;
  return (
    <Modal
      title="Launch formation"
      onClose={onClose}
      width={760}
      headerExtra={tabs}
      footer={
        <>
          <span className="fm-save">
            <Button size="sm" onClick={() => fileRef.current?.click()}>
              Import file…
            </Button>
            <Button size="sm" onClick={() => setPasteOpen(!pasteOpen)} aria-expanded={pasteOpen}>
              Paste JSON…
            </Button>
            <Button size="sm" onClick={onExport} title="Export the current workspace or a saved formation as a team template">
              Export…
            </Button>
          </span>
          <Button onClick={onClose}>Cancel</Button>
          <Button variant="primary" onClick={() => void launch()} disabled={!canLaunch}>
            {busy ? "Launching…" : "Review and launch…"}
          </Button>
        </>
      }
    >
      <input ref={fileRef} type="file" accept=".json,application/json" hidden onChange={(e) => {
          const el = e.currentTarget;
          const f = el.files?.[0];
          el.value = "";
          void onFile(f);
        }}
      />
      <div className="form">
        {pasteOpen && (
          <Field label="Paste a team template (JSON)" hint="Validated and cleaned before anything is shown; nothing in it is executed.">
            <textarea className="fm-textarea tt-paste" value={paste} onChange={(e) => setPaste(e.target.value)} placeholder='{ "format": "gridkeeper-team", "version": 1, … }' aria-label="Team template JSON" spellCheck={false} />
            <div className="fm-row" style={{ marginTop: 6 }}>
              <Button size="sm" variant="primary" disabled={!paste.trim()} onClick={() => take(`paste:${Date.now()}`, "Pasted", checkTemplateText(paste))}>
                Check and preview
              </Button>
            </div>
          </Field>
        )}

        <Field label="Template">
          <div className="fm-list" role="radiogroup" aria-label="Team template">
            {cards.map((c) => (
              <button key={c.key} type="button" role="radio" aria-checked={selKey === c.key} className={`fm-card${selKey === c.key ? " is-selected" : ""}`} onClick={() => setSelKey(c.key)}>
                <span className="fm-card-name">{c.check.template?.meta.name}</span>
                <span className="fm-card-desc">
                  {c.label === "Built-in" ? "" : `${c.label} · `}
                  {c.check.template?.meta.description}
                </span>
              </button>
            ))}
          </div>
        </Field>

        {t && (
          <>
            <div className="tt-meta">
              {t.meta.author && <span>by @{t.meta.author}</span>}
              {t.meta.tags.map((tag) => (
                <span key={tag} className="tt-tag">
                  {tag}
                </span>
              ))}
              <span className="muted">needs Gridkeeper {t.meta.minVersion}+</span>
            </div>

            <Field label="Project folder" hint={gitState === "checking" ? "Checking…" : gitState === "ok" ? `Git repository · ⎇ ${git?.branch ?? "detached"}${git?.dirty ? " · uncommitted changes" : ""}` : gitState === "none" ? "Not a Git repository (worktrees unavailable)" : undefined}>
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

            {hasWorktrees && (
              <div className="fm-row">
                <Toggle checked={useWorktrees && gitState === "ok"} disabled={gitState !== "ok"} onChange={setUseWorktrees} label="Own Git worktrees as the template describes" hint="Created one by one with git worktree add -b; nothing is ever deleted" />
                <Field label="Branch prefix">
                  <Input mono value={prefix} onChange={(e) => setPrefix(e.target.value)} aria-label="Branch prefix" style={{ width: 110 }} disabled={!useWorktrees || gitState !== "ok"} />
                </Field>
              </div>
            )}

            <Field label="Mission goal" error={needsGoal ? "Enter the goal for the new mission file." : undefined}>
              <Input value={goal} onChange={(e) => setGoal(e.target.value)} placeholder={t.mission.goalHint || "The goal in one line"} aria-label="Mission goal" />
            </Field>

            {mission?.exists && (t.mission.tasks.length > 0 || goal.trim()) && (
              <Field label="A mission file already exists" hint={mission.path}>
                <Segmented
                  size="sm"
                  ariaLabel="Existing mission file"
                  value={missionChoice}
                  onChange={setMissionChoice}
                  options={[
                    { value: "merge", label: "Add the template's tasks" },
                    { value: "replace", label: "Replace it" },
                    { value: "skip", label: "Keep it as is" },
                  ]}
                />
              </Field>
            )}

            {t.leadControl !== "off" && (
              <Toggle checked={applyLead} onChange={setApplyLead} label={`Set lead control to ${LEAD_LABEL[t.leadControl]} for this project`} hint="Recommended by the template; you can change it later in Mission Control" />
            )}
            {t.brain.length > 0 && (
              <Toggle checked={queueNotes} onChange={setQueueNotes} label={`Queue ${t.brain.length} brain note${t.brain.length === 1 ? "" : "s"} for the project's brain inbox`} hint={t.brain.map((n) => `${n.kind}: ${n.title}`).join(" · ")} />
            )}

            <Field label="What will happen">
              {plan && <pre className="fm-plan">{describePlan(plan)}</pre>}
              <Messages errors={[...(selected?.check.errors ?? []), ...(plan?.errors ?? []), ...(!wsId ? ["Create a workspace first."] : [])]} warnings={[...(plan?.warnings ?? []), ...extraWarnings]} />
            </Field>

            {Object.keys(t.prompts).length > 0 && (
              <Field label="Starter prompts (typed once each agent is idle)">
                <div className="fm-roles tt-prompts">
                  {Object.entries(t.prompts).map(([role, text]) => (
                    <RolePrompt key={role} role={role}>
                      <span className="tt-prompt">{missionPath ? renderPrompt(text, { role, missionPath, team }) : text}</span>
                    </RolePrompt>
                  ))}
                </div>
              </Field>
            )}

            {(t.mission.tasks.length > 0 || goal.trim()) && missionChoice !== "skip" && (
              <Field label={!mission?.exists || missionChoice === "replace" ? `Mission file${missionPath ? ` (${missionPath})` : ""}` : "Tasks added to the mission file"}>
                <pre className="fm-plan">{!mission?.exists || missionChoice === "replace" ? missionTextFromTemplate(t, goal || "<goal>") : templateTaskLines(t).map((l) => `- [ ] ${l}`).join("\n")}</pre>
              </Field>
            )}
          </>
        )}
      </div>
    </Modal>
  );
}

// ---- export ------------------------------------------------------------------------------------------

function ExportPanel({ onClose, tabs, onBack }: { onClose: () => void; tabs: React.ReactNode; onBack: () => void }) {
  const wsName = useApp((s) => selectActiveWorkspace(s)?.name ?? "");
  const saved = useMemo(() => loadSavedFormations(), []);
  const [base, setBase] = useState<WorkspaceExportBase | null>(null);
  const [baseState, setBaseState] = useState<"loading" | "ok" | "none">("loading");
  const [source, setSource] = useState<string>("workspace");
  const [name, setName] = useState(wsName);
  const [description, setDescription] = useState("");
  const [author, setAuthor] = useState("");
  const [tags, setTags] = useState("");
  const [prompts, setPrompts] = useState<Record<string, string>>({});
  const [withTasks, setWithTasks] = useState(true);
  const [lead, setLead] = useState<LeadMode>("off");

  useEffect(() => {
    let cancelled = false;
    void activeWorkspaceExportBase().then((b) => {
      if (cancelled) return;
      setBase(b);
      setBaseState(b ? "ok" : "none");
      if (!b && saved[0]) {
        setSource(saved[0].id);
        setName(saved[0].name);
      }
    });
    return () => {
      cancelled = true;
    };
  }, [saved]);

  const formation: FormationTemplate | null = source === "workspace" ? (base?.formation ?? null) : (saved.find((f) => f.id === source) ?? null);
  const roles = useMemo(() => {
    const out: string[] = [];
    for (const g of formation?.groups ?? []) for (const s of g.slots) if (!out.includes(roleKeyOf(s.role))) out.push(roleKeyOf(s.role));
    return out;
  }, [formation]);
  const fromWorkspace = source === "workspace" && !!base;
  const openTasks = fromWorkspace && base?.missionText ? (base.missionText.match(/^\s*(?:[-*+]|\d{1,4}[.)])\s+\[[ ~\-/!]?\]/gm)?.length ?? 0) : 0;

  const check = useMemo(() => {
    if (!formation) return null;
    return buildExport({
      name: name.trim() || formation.name,
      description: description.trim() || undefined,
      author: author.trim() || null,
      tags: tags.split(/[,\s]+/).filter(Boolean),
      formation,
      prompts,
      missionText: fromWorkspace && withTasks ? base?.missionText : null,
      team: fromWorkspace ? base?.team : [],
      missionPath: fromWorkspace ? base?.missionPath : null,
      leadControl: lead,
    });
  }, [formation, name, description, author, tags, prompts, fromWorkspace, withTasks, base, lead]);
  const t: TeamTemplate | null = check?.template ?? null;
  const json = t ? serializeTeamTemplate(t) : "";

  return (
    <Modal
      title="Export team template"
      onClose={onClose}
      width={760}
      headerExtra={tabs}
      footer={
        <>
          <span className="fm-save">
            <Button size="sm" onClick={onBack}>
              ← Templates
            </Button>
          </span>
          <Button disabled={!t} onClick={() => void copyText(json, "Team template copied")}>
            Copy as text
          </Button>
          <Button variant="primary" disabled={!t} onClick={() => t && void saveTeamTemplateFile(t)}>
            Save file…
          </Button>
        </>
      }
    >
      <div className="form">
        <Field label="Export from" hint="Groups, roles, agent kinds and worktree layout. Accounts, args, env, paths and conversations are never exported.">
          <Select value={source} onChange={(e) => setSource(e.target.value)} aria-label="Export from">
            <option value="workspace" disabled={baseState !== "ok"}>
              {baseState === "loading" ? "Current workspace (loading…)" : baseState === "ok" ? `Current workspace: ${wsName}` : "Current workspace (no sessions)"}
            </option>
            {saved.map((f) => (
              <option key={f.id} value={f.id}>
                Saved formation: {f.name}
              </option>
            ))}
          </Select>
        </Field>
        <div className="tt-grid">
          <Field label="Name">
            <Input value={name} onChange={(e) => setName(e.target.value)} placeholder="Feature squad" aria-label="Template name" />
          </Field>
          <Field label="Author handle (optional)">
            <Input value={author} onChange={(e) => setAuthor(e.target.value)} placeholder="your-handle" aria-label="Author handle" />
          </Field>
        </div>
        <Field label="Description">
          <Input value={description} onChange={(e) => setDescription(e.target.value)} placeholder="Who does what, in one sentence" aria-label="Description" />
        </Field>
        <div className="tt-grid">
          <Field label="Tags">
            <Input value={tags} onChange={(e) => setTags(e.target.value)} placeholder="feature, worktrees" aria-label="Tags" />
          </Field>
          <Field label="Recommended lead control">
            <Select value={lead} onChange={(e) => setLead(e.target.value as LeadMode)} aria-label="Recommended lead control">
              <option value="off">Off</option>
              <option value="advisor">Advisor</option>
              <option value="autopilot">Autopilot</option>
            </Select>
          </Field>
        </div>
        {fromWorkspace && base?.missionText && (
          <Toggle checked={withTasks} onChange={setWithTasks} label={`Include the mission's ${openTasks} open task${openTasks === 1 ? "" : "s"} as starter tasks`} hint="Owners are kept as roles (@builder-1 becomes @builder); done tasks are left out" />
        )}
        {roles.length > 0 && (
          <Field label="Starter prompts" hint="Placeholders: {mission} = mission file path, {teammates} = the other panes, {role} = the role">
            <div className="fm-roles">
              {roles.map((role) => (
                <RolePrompt key={role} role={role}>
                  <textarea
                    className="fm-textarea"
                    value={prompts[role] ?? defaultRolePrompt(role === "agent" ? "" : role)}
                    onChange={(e) => setPrompts({ ...prompts, [role]: e.target.value })}
                    aria-label={`Starter prompt for ${role}`}
                    spellCheck={false}
                  />
                </RolePrompt>
              ))}
            </div>
          </Field>
        )}
        <Field label="File preview">
          {t ? <pre className="fm-plan tt-json">{json}</pre> : <div className="muted">{baseState === "loading" ? "Loading…" : "Choose something to export."}</div>}
          <Messages errors={check?.errors ?? []} warnings={check?.warnings ?? []} />
        </Field>
        {t && (
          <div className="muted tt-count">
            {t.formation.groups.reduce((n, g) => n + g.slots.length, 0)} sessions in {t.formation.groups.length} group{t.formation.groups.length === 1 ? "" : "s"} · {t.mission.tasks.length} task{t.mission.tasks.length === 1 ? "" : "s"}
          </div>
        )}
      </div>
    </Modal>
  );
}

// ---- bits --------------------------------------------------------------------------------------------

function Messages({ errors, warnings }: { errors: string[]; warnings: string[] }) {
  if (!errors.length && !warnings.length) return null;
  return (
    <div className="fm-msgs" style={{ marginTop: 6 }}>
      {errors.map((e) => (
        <span key={e} className="fm-msg-err">
          ✕ {e}
        </span>
      ))}
      {warnings.map((w) => (
        <span key={w} className="fm-msg-warn">
          ! {w}
        </span>
      ))}
    </div>
  );
}

function RolePrompt({ role, children }: { role: string; children: React.ReactNode }) {
  return (
    <>
      <span className="fm-role-name">
        <RoleTag role={role} />
        <span className="muted">{roleInfo(role)?.builtin ? "" : role === "agent" ? "no role" : role}</span>
      </span>
      {children}
    </>
  );
}
