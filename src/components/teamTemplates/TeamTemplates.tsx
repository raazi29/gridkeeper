// "Templates" tab of the Formations dialog: a gallery of built-in team templates, import (open a
// `.gridkeeper-team.json` file or paste JSON) with a full preview of what will be created, and export of the
// current workspace or a saved formation. Imported templates are sanitized (actions/teamTemplatePlan.ts) and
// launched through the same reviewed plan + confirmation as a formation. The UI is translated; template content
// (names, prompts, mission text, the file preview) stays English: it is written to files and typed into agents.
// Built-in templates show a translated name and description (lib/teamGallery.ts GALLERY_TEXT).

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
import { useT, type Translator } from "../../i18n";
import { ipc } from "../../lib/ipc";
import { roleInfo } from "../../lib/roles";
import { GALLERY_TEXT, TEAM_GALLERY, galleryKey } from "../../lib/teamGallery";
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

/** Where a template came from (the card shows "From <file>" / "Pasted"; built-ins show nothing). */
type TemplateSource = { kind: "builtin" } | { kind: "file"; name: string } | { kind: "paste" };

type Selected = { key: string; source: TemplateSource; check: TemplateCheck };

/** Name / description as shown: built-ins are looked up by key (translated), anything else is the file's text. */
function shownName(t: Translator, c: Selected): string {
  const g = c.source.kind === "builtin" ? GALLERY_TEXT[c.key] : undefined;
  return g ? t(g.name) : (c.check.template?.meta.name ?? "");
}

function shownDescription(t: Translator, c: Selected): string {
  const g = c.source.kind === "builtin" ? GALLERY_TEXT[c.key] : undefined;
  return g ? t(g.description) : (c.check.template?.meta.description ?? "");
}

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
  const t = useT();
  const wsId = useApp((s) => selectActiveWorkspace(s)?.id ?? null);
  const wsName = useApp((s) => selectActiveWorkspace(s)?.name ?? "");
  const wsDir = useApp((s) => selectActiveWorkspace(s)?.projectDir ?? "");
  const profiles = useApp((s) => s.profiles);
  const agents = useApp((s) => s.agents);
  const runtime = useApp((s) => s.runtime);

  const gallery = useMemo<Selected[]>(() => TEAM_GALLERY.map((g) => ({ key: galleryKey(g), source: { kind: "builtin" as const }, check: { template: g, errors: [], warnings: [] } })), []);
  const [imported, setImported] = useState<Selected | null>(null);
  const [selKey, setSelKey] = useState<string>(gallery[0]?.key ?? "");
  const [paste, setPaste] = useState("");
  const fileRef = useRef<HTMLInputElement>(null);
  const selected = imported?.key === selKey ? imported : (gallery.find((g) => g.key === selKey) ?? null);
  const tpl = selected?.check.template ?? null;

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

  const take = (key: string, source: TemplateSource, check: TemplateCheck) => {
    if (!check.template) {
      notify("error", t("teams.toast.notImported", { errors: check.errors.join(" ") }));
      return;
    }
    setImported({ key, source, check });
    setSelKey(key);
    setPasteOpen(false);
    setApplyLead(check.template.leadControl !== "autopilot");
  };
  const onFile = async (f: File | undefined) => {
    if (!f) return;
    take(`file:${f.name}:${Date.now()}`, { kind: "file", name: f.name }, await readTemplateFile(f));
  };

  const liveProfileUse = useMemo(() => {
    const use: Record<string, number> = {};
    for (const id in runtime) {
      const r = runtime[id];
      if (r.agent === "claude" && isLive(r)) use[r.profileId ?? ""] = (use[r.profileId ?? ""] ?? 0) + 1;
    }
    return use;
  }, [runtime]);

  const hasWorktrees = !!tpl?.formation.groups.some((g) => g.slots.some((s) => s.worktree));
  const plan = useMemo(() => {
    if (!tpl) return null;
    return planTeamTemplate(tpl, {
      projectDir: dir,
      repoRoot: git?.root ?? null,
      useWorktrees: useWorktrees && !!git?.isRepo,
      branchPrefix: prefix,
      stamp,
      profiles: profiles.map((p) => ({ id: p.id, name: p.name })),
      existingWorktrees: git?.worktrees ?? [],
      liveProfileUse,
    });
  }, [tpl, dir, git, useWorktrees, prefix, stamp, profiles, liveProfileUse]);

  const team = useMemo(() => plan?.groups.flatMap((g) => g.sessions.map((s) => ({ name: s.name, role: s.role }))) ?? [], [plan]);
  const missionPath = mission?.path ?? (dir.trim() ? missionPathFor(dir) : "");
  const writesNewMission = !!tpl && (tpl.mission.tasks.length > 0 || !!goal.trim()) && (!mission?.exists || missionChoice === "replace");
  const needsGoal = writesNewMission && !goal.trim();

  const extraWarnings = useMemo(() => {
    const w: string[] = [...(selected?.check.warnings ?? [])];
    const needs = new Set(plan?.groups.flatMap((g) => g.sessions.map((s) => s.agent)) ?? []);
    for (const k of ["claude", "codex"] as const) if (needs.has(k) && agents.some((a) => a.kind === k && !a.path)) w.push(t("teams.import.agentMissing", { agent: k === "claude" ? "Claude Code" : "Codex" }));
    if (hasWorktrees && useWorktrees && gitState === "none") w.push(t("teams.import.notGitWarning"));
    return w;
  }, [t, selected, plan, agents, hasWorktrees, useWorktrees, gitState]);

  const targetGroupId = useMission((s) => s.formationGroupId);
  const canLaunch = !!tpl && !!wsId && !!plan && plan.errors.length === 0 && gitState !== "checking" && !needsGoal && !busy;

  const launch = async () => {
    if (!tpl || !plan || !wsId || !canLaunch || !selected) return;
    const reuse = reusableEmptyGroup(wsId, targetGroupId);
    const name = shownName(t, selected);
    const missionLine =
      !tpl.mission.tasks.length && !goal.trim()
        ? ""
        : !mission?.exists
          ? t("teams.launch.missionNew", { count: tpl.mission.tasks.length })
          : missionChoice === "merge"
            ? t("teams.launch.missionMerge")
            : missionChoice === "replace"
              ? t("teams.launch.missionReplace")
              : t("teams.launch.missionKeep");
    const counts = { groups: plan.groups.length, sessions: plan.sessionCount };
    const ok = await confirmDialog({
      title: t("teams.launch.title", { name, workspace: wsName }),
      message: [
        plan.worktrees.length ? t("teams.launch.createsWorktrees", { ...counts, worktrees: plan.worktrees.length }) : t("teams.launch.creates", counts),
        reuse ? t("teams.launch.reuse", { name: reuse.name, as: plan.groups[0]?.name ?? "" }) : "",
        missionLine,
        t("teams.launch.safety"),
      ]
        .filter(Boolean)
        .join(" "),
      detail: describePlan(plan),
      confirmLabel: t("teams.launch.confirm"),
    });
    if (!ok) return;
    setBusy(true);
    try {
      const r = await launchTeamTemplate(tpl, plan, {
        workspaceId: wsId,
        projectDir: dir.trim(),
        goal,
        missionChoice,
        applyLeadControl: applyLead && tpl.leadControl !== "off",
        queueNotes: queueNotes && tpl.brain.length > 0,
        groupId: targetGroupId,
      });
      if (r.ok) {
        notify("info", t("teams.toast.started", { name, count: r.sessionIds.length }));
        onClose();
      }
    } finally {
      setBusy(false);
    }
  };

  const cards = imported ? [imported, ...gallery] : gallery;
  return (
    <Modal
      title={t("teams.import.title")}
      onClose={onClose}
      width={760}
      headerExtra={tabs}
      footer={
        <>
          <span className="fm-save">
            <Button size="sm" onClick={() => fileRef.current?.click()}>
              {t("teams.import.importFile")}
            </Button>
            <Button size="sm" onClick={() => setPasteOpen(!pasteOpen)} aria-expanded={pasteOpen}>
              {t("teams.import.pasteJson")}
            </Button>
            <Button size="sm" onClick={onExport} title={t("teams.import.exportTitle")}>
              {t("teams.import.export")}
            </Button>
          </span>
          <Button onClick={onClose}>{t("common.cancel")}</Button>
          <Button variant="primary" onClick={() => void launch()} disabled={!canLaunch}>
            {busy ? t("teams.import.launching") : t("teams.import.reviewLaunch")}
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
          <Field label={t("teams.import.pasteLabel")} hint={t("teams.import.pasteHint")}>
            <textarea className="fm-textarea tt-paste" value={paste} onChange={(e) => setPaste(e.target.value)} placeholder='{ "format": "gridkeeper-team", "version": 1, … }' aria-label={t("teams.import.pasteAria")} spellCheck={false} />
            <div className="fm-row" style={{ marginTop: 6 }}>
              <Button size="sm" variant="primary" disabled={!paste.trim()} onClick={() => take(`paste:${Date.now()}`, { kind: "paste" }, checkTemplateText(paste))}>
                {t("teams.import.check")}
              </Button>
            </div>
          </Field>
        )}

        <Field label={t("teams.import.template")}>
          <div className="fm-list" role="radiogroup" aria-label={t("teams.import.templateAria")}>
            {cards.map((c) => (
              <button key={c.key} type="button" role="radio" aria-checked={selKey === c.key} className={`fm-card${selKey === c.key ? " is-selected" : ""}`} onClick={() => setSelKey(c.key)}>
                <span className="fm-card-name">{shownName(t, c)}</span>
                <span className="fm-card-desc">
                  {c.source.kind === "file" ? `${t("teams.card.fromFile", { name: c.source.name })} · ` : c.source.kind === "paste" ? `${t("teams.card.pasted")} · ` : ""}
                  {shownDescription(t, c)}
                </span>
              </button>
            ))}
          </div>
        </Field>

        {tpl && (
          <>
            <div className="tt-meta">
              {tpl.meta.author && <span>{t("teams.import.byAuthor", { author: tpl.meta.author })}</span>}
              {tpl.meta.tags.map((tag) => (
                <span key={tag} className="tt-tag">
                  {tag}
                </span>
              ))}
              <span className="muted">{t("teams.import.needsVersion", { version: tpl.meta.minVersion })}</span>
            </div>

            <Field
              label={t("teams.import.projectFolder")}
              hint={
                gitState === "checking"
                  ? t("teams.import.gitChecking")
                  : gitState === "ok"
                    ? t(git?.dirty ? "teams.import.gitRepoDirty" : "teams.import.gitRepo", { branch: git?.branch ?? t("teams.import.detached") })
                    : gitState === "none"
                      ? t("teams.import.notGit")
                      : undefined
              }
            >
              <div className="input-group">
                <Input mono value={dir} onChange={(e) => setDir(e.target.value)} onBlur={(e) => void checkDir(e.currentTarget.value)} placeholder={"D:\\code\\project"} aria-label={t("teams.import.projectFolder")} />
                <Button
                  icon={<IconFolder size={13} />}
                  onClick={async () => {
                    const d = await pickFolder(t("teams.import.projectFolder"), dir || null);
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

            {hasWorktrees && (
              <div className="fm-row">
                <Toggle checked={useWorktrees && gitState === "ok"} disabled={gitState !== "ok"} onChange={setUseWorktrees} label={t("teams.import.worktrees")} hint={t("teams.import.worktreesHint")} />
                <Field label={t("teams.import.branchPrefix")}>
                  <Input mono value={prefix} onChange={(e) => setPrefix(e.target.value)} aria-label={t("teams.import.branchPrefix")} style={{ width: 110 }} disabled={!useWorktrees || gitState !== "ok"} />
                </Field>
              </div>
            )}

            <Field label={t("teams.import.goal")} error={needsGoal ? t("teams.import.goalRequired") : undefined}>
              <Input value={goal} onChange={(e) => setGoal(e.target.value)} placeholder={tpl.mission.goalHint || t("teams.import.goalPlaceholder")} aria-label={t("teams.import.goal")} />
            </Field>

            {mission?.exists && (tpl.mission.tasks.length > 0 || goal.trim()) && (
              <Field label={t("teams.import.missionExists")} hint={mission.path}>
                <Segmented
                  size="sm"
                  ariaLabel={t("teams.import.missionExistsAria")}
                  value={missionChoice}
                  onChange={setMissionChoice}
                  options={[
                    { value: "merge", label: t("teams.import.missionMerge") },
                    { value: "replace", label: t("teams.import.missionReplace") },
                    { value: "skip", label: t("teams.import.missionKeep") },
                  ]}
                />
              </Field>
            )}

            {tpl.leadControl !== "off" && (
              <Toggle
                checked={applyLead}
                onChange={setApplyLead}
                label={tpl.leadControl === "autopilot" ? t("teams.import.leadAutopilot") : t("teams.import.leadAdvisor")}
                hint={t("teams.import.leadHint")}
              />
            )}
            {tpl.brain.length > 0 && (
              <Toggle checked={queueNotes} onChange={setQueueNotes} label={t("teams.import.queueNotes", { count: tpl.brain.length })} hint={tpl.brain.map((n) => `${n.kind}: ${n.title}`).join(" · ")} />
            )}

            <Field label={t("teams.import.whatHappens")}>
              {plan && <pre className="fm-plan">{describePlan(plan)}</pre>}
              <Messages errors={[...(selected?.check.errors ?? []), ...(plan?.errors ?? []), ...(!wsId ? [t("teams.import.noWorkspace")] : [])]} warnings={[...(plan?.warnings ?? []), ...extraWarnings]} />
            </Field>

            {Object.keys(tpl.prompts).length > 0 && (
              <Field label={t("teams.import.prompts")}>
                <div className="fm-roles tt-prompts">
                  {Object.entries(tpl.prompts).map(([role, text]) => (
                    <RolePrompt key={role} role={role}>
                      <span className="tt-prompt">{missionPath ? renderPrompt(text, { role, missionPath, team }) : text}</span>
                    </RolePrompt>
                  ))}
                </div>
              </Field>
            )}

            {(tpl.mission.tasks.length > 0 || goal.trim()) && missionChoice !== "skip" && (
              <Field label={!mission?.exists || missionChoice === "replace" ? (missionPath ? t("teams.import.missionFileAt", { path: missionPath }) : t("teams.import.missionFile")) : t("teams.import.tasksAdded")}>
                {/* File content preview: stays English (written to the mission file). */}
                <pre className="fm-plan">{!mission?.exists || missionChoice === "replace" ? missionTextFromTemplate(tpl, goal || "<goal>") : templateTaskLines(tpl).map((l) => `- [ ] ${l}`).join("\n")}</pre>
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
  const t = useT();
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
  const tpl: TeamTemplate | null = check?.template ?? null;
  const json = tpl ? serializeTeamTemplate(tpl) : "";

  return (
    <Modal
      title={t("teams.export.title")}
      onClose={onClose}
      width={760}
      headerExtra={tabs}
      footer={
        <>
          <span className="fm-save">
            <Button size="sm" onClick={onBack}>
              {t("teams.export.back")}
            </Button>
          </span>
          <Button disabled={!tpl} onClick={() => void copyText(json, t("teams.export.copied"))}>
            {t("teams.export.copy")}
          </Button>
          <Button variant="primary" disabled={!tpl} onClick={() => tpl && void saveTeamTemplateFile(tpl)}>
            {t("teams.export.save")}
          </Button>
        </>
      }
    >
      <div className="form">
        <Field label={t("teams.export.from")} hint={t("teams.export.fromHint")}>
          <Select value={source} onChange={(e) => setSource(e.target.value)} aria-label={t("teams.export.from")}>
            <option value="workspace" disabled={baseState !== "ok"}>
              {baseState === "loading" ? t("teams.export.currentLoading") : baseState === "ok" ? t("teams.export.current", { name: wsName }) : t("teams.export.currentNone")}
            </option>
            {saved.map((f) => (
              <option key={f.id} value={f.id}>
                {t("teams.export.saved", { name: f.name })}
              </option>
            ))}
          </Select>
        </Field>
        <div className="tt-grid">
          <Field label={t("teams.export.name")}>
            <Input value={name} onChange={(e) => setName(e.target.value)} placeholder={t("teams.export.namePlaceholder")} aria-label={t("teams.export.nameAria")} />
          </Field>
          <Field label={t("teams.export.author")}>
            {/* Example handle (ASCII only, like the handle itself). */}
            <Input value={author} onChange={(e) => setAuthor(e.target.value)} placeholder="your-handle" aria-label={t("teams.export.authorAria")} />
          </Field>
        </div>
        <Field label={t("teams.export.description")}>
          <Input value={description} onChange={(e) => setDescription(e.target.value)} placeholder={t("teams.export.descriptionPlaceholder")} aria-label={t("teams.export.description")} />
        </Field>
        <div className="tt-grid">
          <Field label={t("teams.export.tags")}>
            {/* Example tag slugs (ASCII, like the tags themselves). */}
            <Input value={tags} onChange={(e) => setTags(e.target.value)} placeholder="feature, worktrees" aria-label={t("teams.export.tags")} />
          </Field>
          <Field label={t("teams.export.lead")}>
            <Select value={lead} onChange={(e) => setLead(e.target.value as LeadMode)} aria-label={t("teams.export.lead")}>
              <option value="off">{t("common.off")}</option>
              <option value="advisor">{t("teams.export.leadAdvisor")}</option>
              <option value="autopilot">{t("teams.export.leadAutopilot")}</option>
            </Select>
          </Field>
        </div>
        {fromWorkspace && base?.missionText && (
          <Toggle checked={withTasks} onChange={setWithTasks} label={t("teams.export.includeTasks", { count: openTasks })} hint={t("teams.export.includeTasksHint")} />
        )}
        {roles.length > 0 && (
          <Field label={t("teams.export.prompts")} hint={t("teams.export.promptsHint", { mission: "{mission}", teammates: "{teammates}", role: "{role}" })}>
            <div className="fm-roles">
              {roles.map((role) => (
                <RolePrompt key={role} role={role}>
                  <textarea
                    className="fm-textarea"
                    value={prompts[role] ?? defaultRolePrompt(role === "agent" ? "" : role)}
                    onChange={(e) => setPrompts({ ...prompts, [role]: e.target.value })}
                    aria-label={t("teams.export.promptAria", { role })}
                    spellCheck={false}
                  />
                </RolePrompt>
              ))}
            </div>
          </Field>
        )}
        <Field label={t("teams.export.preview")}>
          {tpl ? <pre className="fm-plan tt-json">{json}</pre> : <div className="muted">{baseState === "loading" ? t("common.loading") : t("teams.export.nothing")}</div>}
          <Messages errors={check?.errors ?? []} warnings={check?.warnings ?? []} />
        </Field>
        {tpl && (
          <div className="muted tt-count">
            {t("teams.export.count", { sessions: tpl.formation.groups.reduce((n, g) => n + g.slots.length, 0), groups: tpl.formation.groups.length, tasks: tpl.mission.tasks.length })}
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
  const t = useT();
  return (
    <>
      <span className="fm-role-name">
        <RoleTag role={role} />
        <span className="muted">{roleInfo(role)?.builtin ? "" : role === "agent" ? t("teams.noRole") : role}</span>
      </span>
      {children}
    </>
  );
}
