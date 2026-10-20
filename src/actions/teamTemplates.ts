// Team templates: file IO, export from the current workspace / a saved formation, and launching an imported
// template (formation → mission file → lead control → brain notes). The schema, sanitizer and planner are
// pure (actions/teamTemplatePlan.ts). Nothing from a template is ever executed: it becomes a formation plan
// that the user reviews and confirms like any other formation.

import { t } from "../i18n";
import { errorMessage, ipc } from "../lib/ipc";
import { slugify } from "../lib/missionDoc";
import { selectActiveWorkspace, useApp } from "../store/appStore";
import { recordActivity } from "../store/activity";
import { launchFormation, workspaceFormation, type LaunchResult } from "./formations";
import { setControlMode } from "./leadControl";
import { notify } from "./notify";
import type { FormationPlan, FormationTemplate } from "./formationPlan";
import {
  mergeTemplateTasks,
  missionTextFromTemplate,
  parseTeamTemplate,
  serializeTeamTemplate,
  TEAM_LIMITS,
  teamTemplateFileName,
  teamTemplateFrom,
  type BrainNote,
  type ExportSource,
  type MissionChoice,
  type TeamTemplate,
  type TemplateCheck,
} from "./teamTemplatePlan";

// ---- reading -----------------------------------------------------------------------------------------

function knownPresets(): string[] {
  return useApp
    .getState()
    .agents.map((a) => a.preset)
    .filter((p): p is string => !!p);
}

let appVersion: string | null = null;

/** Fetch the running version once (for the minimum-version warning); call when the Templates tab opens. */
export async function loadAppVersion(): Promise<void> {
  if (appVersion) return;
  try {
    appVersion = (await ipc.appInfo()).version;
  } catch {
    /* unknown version: no warning */
  }
}

/** Validate pasted / loaded text against the schema (with this machine's version and agent tools). */
export function checkTemplateText(text: string): TemplateCheck {
  return parseTeamTemplate(text, { appVersion, knownPresets: knownPresets() });
}

/** Read a file the user picked (`<input type="file">`): size-checked before it is read. */
export async function readTemplateFile(file: File): Promise<TemplateCheck> {
  if (file.size > TEAM_LIMITS.fileChars * 4)
    return { template: null, errors: [t("teams.check.fileTooLarge", { name: file.name, kb: TEAM_LIMITS.fileChars >> 10 })], warnings: [] };
  try {
    return checkTemplateText(await file.text());
  } catch (e) {
    return { template: null, errors: [t("teams.check.readFailed", { name: file.name, error: errorMessage(e) })], warnings: [] };
  }
}

// ---- export ------------------------------------------------------------------------------------------

export interface WorkspaceExportBase {
  formation: FormationTemplate;
  team: { name: string; role: string | null }[];
  missionText: string | null;
  missionPath: string | null;
}

/** The active workspace's layout, team and mission file, as the base of an export. */
export async function activeWorkspaceExportBase(): Promise<WorkspaceExportBase | null> {
  const s = useApp.getState();
  const ws = selectActiveWorkspace(s);
  if (!ws) return null;
  const formation = workspaceFormation(ws.id, ws.name);
  if (!formation || !formation.groups.length) return null;
  const team = formation.groups.flatMap((g) => g.slots.map((sl) => ({ name: sl.name ?? sl.role, role: sl.role || null })));
  let missionText: string | null = null;
  let missionPath: string | null = null;
  if (ws.projectDir) {
    try {
      const f = await ipc.missionRead(ws.projectDir);
      missionPath = f.path;
      if (f.exists) missionText = f.text;
    } catch {
      /* no mission file: export without tasks */
    }
  }
  return { formation, team, missionText, missionPath };
}

export function buildExport(src: ExportSource): TemplateCheck {
  return teamTemplateFrom(src);
}

/** Save through the native dialog (Rust writes only to the path the user picked). */
export async function saveTeamTemplateFile(tpl: TeamTemplate): Promise<string | null> {
  const body = serializeTeamTemplate(tpl);
  const fileName = teamTemplateFileName(tpl.meta.name);
  try {
    const target = await ipc.replaySaveDialog(fileName.replace(/\.json$/, ""), "json");
    if (!target) return null;
    const path = await ipc.replaySaveFile(target.token, new TextEncoder().encode(body));
    notify("info", t("teams.toast.saved", { path }));
    // Activity log entries stay English (event data, like store/activity.ts).
    recordActivity({ sessionId: null, sessionName: "formation", role: null, agent: null, kind: "formation", level: "ok", message: `team template “${tpl.meta.name}” exported`, result: "saved" });
    return path;
  } catch (e) {
    // An older host without the "json" save kind: fall back to a browser download.
    if (/unknown export format/i.test(errorMessage(e)) && downloadText(fileName, body)) {
      notify("info", t("teams.toast.downloaded", { name: fileName }));
      return fileName;
    }
    notify("error", t("teams.toast.saveFailed", { error: errorMessage(e) }));
    return null;
  }
}

function downloadText(name: string, text: string): boolean {
  try {
    const url = URL.createObjectURL(new Blob([text], { type: "application/json" }));
    const a = document.createElement("a");
    a.href = url;
    a.download = name;
    a.click();
    setTimeout(() => URL.revokeObjectURL(url), 10_000);
    return true;
  } catch {
    return false;
  }
}

// ---- brain notes -------------------------------------------------------------------------------------

/** One note as a Markdown file for `.gridkeeper/brain/inbox/` (front matter: title, kind, tags, source). Pure. */
// Agent-facing: stays English (typed into agents / written to files).
export function brainNoteFile(note: BrainNote, source: string, now = new Date()): { name: string; text: string } {
  const two = (n: number) => String(n).padStart(2, "0");
  const day = `${now.getFullYear()}${two(now.getMonth() + 1)}${two(now.getDate())}`;
  const q = (s: string) => JSON.stringify(s);
  const text = [
    "---",
    `title: ${q(note.title)}`,
    `kind: ${note.kind}`,
    `tags: [${note.tags.join(", ")}]`,
    `source: ${q(`team-template:${source}`)}`,
    "---",
    "",
    note.body,
    "",
  ].join("\n");
  return { name: `${day}-${slugify(note.title).slice(0, 48) || "note"}.md`, text };
}

export const PENDING_KEY = "gridkeeper.brainInbox.pending.v1";

/**
 * Queue a template's brain notes for `<projectDir>/.gridkeeper/brain/inbox/`.
 * TODO(brain integration): write each `brainNoteFile(...)` into the inbox through the Brain API once it
 * lands (the Brain feature owns `.gridkeeper/brain/`; there is no IPC for it yet). Until then the files are
 * kept in localStorage under PENDING_KEY, grouped by project folder, so the integration can flush them.
 */
export async function importBrainNotes(projectDir: string, notes: readonly BrainNote[], source = "template"): Promise<{ written: number; queued: number }> {
  if (!notes.length || !projectDir.trim()) return { written: 0, queued: 0 };
  const files = notes.map((n) => brainNoteFile(n, source));
  try {
    const ls = globalThis.localStorage;
    if (!ls) return { written: 0, queued: 0 };
    const raw = ls.getItem(PENDING_KEY);
    const parsed = raw ? (JSON.parse(raw) as unknown) : null;
    const all: Record<string, { name: string; text: string }[]> = parsed && typeof parsed === "object" && !Array.isArray(parsed) ? (parsed as Record<string, { name: string; text: string }[]>) : {};
    const list = Array.isArray(all[projectDir]) ? all[projectDir] : [];
    all[projectDir] = [...list, ...files].slice(-100);
    ls.setItem(PENDING_KEY, JSON.stringify(all));
  } catch {
    return { written: 0, queued: 0 };
  }
  return { written: 0, queued: files.length };
}

// ---- launch ------------------------------------------------------------------------------------------

export interface TemplateLaunchOptions {
  workspaceId: string;
  projectDir: string;
  goal: string;
  /** What to do when a mission file already exists ("merge" adds missing tasks). */
  missionChoice: MissionChoice;
  applyLeadControl: boolean;
  queueNotes: boolean;
  groupId?: string | null;
}

export interface TemplateLaunchResult extends LaunchResult {
  mission: "created" | "merged" | "replaced" | "kept" | "failed" | "none";
  notesQueued: number;
}

/** Run the reviewed plan, then write the mission file, set lead control and queue brain notes. */
export async function launchTeamTemplate(tpl: TeamTemplate, plan: FormationPlan, o: TemplateLaunchOptions): Promise<TemplateLaunchResult> {
  const r = await launchFormation(plan, o.workspaceId, { groupId: o.groupId });
  if (!r.ok) return { ...r, mission: "none", notesQueued: 0 };
  let mission: TemplateLaunchResult["mission"] = "none";
  if (tpl.mission.tasks.length || o.goal.trim()) {
    try {
      const f = await ipc.missionRead(o.projectDir);
      if (!f.exists) {
        await ipc.missionWrite(o.projectDir, missionTextFromTemplate(tpl, o.goal), null);
        mission = "created";
      } else if (o.missionChoice === "replace") {
        await ipc.missionWrite(o.projectDir, missionTextFromTemplate(tpl, o.goal), f.modifiedMs);
        mission = "replaced";
      } else if (o.missionChoice === "merge") {
        const m = mergeTemplateTasks(f.text, tpl);
        if (m.added) await ipc.missionWrite(o.projectDir, m.text, f.modifiedMs);
        mission = "merged";
      } else mission = "kept";
    } catch (e) {
      mission = "failed";
      notify("error", t("teams.toast.missionFailed", { error: errorMessage(e) }));
    }
  }
  if (o.applyLeadControl) setControlMode(o.projectDir, tpl.leadControl);
  const notes = o.queueNotes ? await importBrainNotes(o.projectDir, tpl.brain, tpl.meta.name) : { written: 0, queued: 0 };
  // Activity log entries stay English (event data, like store/activity.ts).
  recordActivity({
    sessionId: null,
    sessionName: "formation",
    role: null,
    agent: null,
    kind: "formation",
    level: "ok",
    message: `team template “${tpl.meta.name}” launched (mission ${mission}${notes.queued ? `, ${notes.queued} brain notes queued` : ""})`,
    result: `${r.sessionIds.length} sessions`,
  });
  return { ...r, mission, notesQueued: notes.queued + notes.written };
}
