// Flight log state (lib/flightlog.ts has the rules): persisted per machine in localStorage
// (`gridkeeper.flightlog.v1`), fed by two signals the app already produces:
// - the mission file store: a task that goes to "[x]" between two good reads of a project's mission file
//   (the first read of a project is a baseline, so boards that were already done never count);
// - the replay recorder's queued events: branch summaries (commits ahead) and hand-off messages.
// Event-driven only: no timers, no polling. Promotions / medals raise one toast (and a short chime when
// blade sounds are on); nothing ever takes focus.

import { create } from "zustand";
import { t } from "../i18n";
import { isTerminalMeta } from "../lib/browserPanes";
import {
  announcement,
  creditedSessions,
  FLIGHTLOG_KEY,
  missionFinished,
  newlyDone,
  parseLog,
  recordCommits,
  recordMission,
  resetLog,
  serializeLog,
  type ApplyResult,
  type FlightLogData,
} from "../lib/flightlog";
import type { MissionDoc, TeamMember } from "../lib/missionDoc";
import type { ReplayEvent } from "../replay/events";
import { tapRecorder } from "../replay/recorder";
import { currentSaberLevel } from "../theme/applyTheme";
import { useApp } from "./appStore";
import { dirKey, useMissionDocs, type MissionEntry } from "./missionDoc";
import { actionToast } from "./uiStore";

interface FlightLogStore {
  data: FlightLogData;
  /** Storage holds a newer format: keep it, count in memory only. */
  readOnly: boolean;
  open: boolean;
}

function load(): { data: FlightLogData; readOnly: boolean } {
  let raw: string | null = null;
  try {
    raw = globalThis.localStorage?.getItem(FLIGHTLOG_KEY) ?? null;
  } catch {
    /* storage unavailable: start empty, counting lasts for this run */
  }
  const { data, status } = parseLog(raw);
  return { data, readOnly: status === "newer" };
}

export const useFlightLog = create<FlightLogStore>()(() => ({ ...load(), open: false }));

function save(d: FlightLogData, force = false) {
  if (useFlightLog.getState().readOnly && !force) return;
  try {
    globalThis.localStorage?.setItem(FLIGHTLOG_KEY, serializeLog(d));
  } catch {
    /* storage unavailable or full: the log lasts for this run */
  }
}

export function openFlightLog(): void {
  useFlightLog.setState({ open: true });
}

export function closeFlightLog(): void {
  useFlightLog.setState({ open: false });
}

/** Settings: counting and every flight-log surface on / off. */
export function setFlightLogEnabled(on: boolean): void {
  const data = { ...useFlightLog.getState().data, enabled: on };
  useFlightLog.setState({ data, ...(on ? {} : { open: false }) });
  save(data);
}

/** Settings: wipe the log (keeps the on / off choice). */
export function resetFlightLog(): void {
  const data = resetLog(useFlightLog.getState().data);
  useFlightLog.setState({ data, readOnly: false });
  save(data, true);
}

// ---- announcements ------------------------------------------------------------------------------

let chime: ((volume: number) => void) | null = null;

/** The component layer registers the synthesized chime (kept out of this module so tests need no audio). */
export function setFlightLogChime(fn: ((volume: number) => void) | null): void {
  chime = fn;
}

function commit(r: ApplyResult) {
  if (!r.changed) return;
  useFlightLog.setState({ data: r.data });
  save(r.data);
  const msg = announcement(r.promoted, r.medals);
  if (!msg) return;
  actionToast({ kind: "info", message: msg, action: { label: t("flightLog.title"), run: openFlightLog } }, 8000);
  const s = useApp.getState().persisted.settings;
  if (chime && s.saberSound && currentSaberLevel(s) !== "off") chime(s.notifications?.volume ?? 50);
}

// ---- signals ------------------------------------------------------------------------------------

/** Last good parsed board per project (dirKey): the baseline the next read is compared with. */
const boards = new Map<string, MissionDoc>();
/** Per project being recorded: who committed and who handed off (Clean landing). */
const flights = new Map<string, { committed: Set<string>; handed: Set<string> }>();
let installed = false;

const WRITE_MAX_AGE = 7 * 86_400_000;

/** When the tasks were done: the mission file's write time when it is plausible, else now. */
export function writeTime(modifiedMs: number | null | undefined, now: number): number {
  if (typeof modifiedMs !== "number" || !Number.isFinite(modifiedMs)) return now;
  if (modifiedMs > now + 60_000 || modifiedMs < now - WRITE_MAX_AGE) return now;
  return Math.min(modifiedMs, now);
}

function teamFor(key: string): TeamMember[] {
  const s = useApp.getState();
  const metas = new Map(s.persisted.sessions.map((m) => [m.id, m]));
  const out: TeamMember[] = [];
  const seen = new Set<string>();
  for (const w of s.persisted.workspaces) {
    if (!w.projectDir || dirKey(w.projectDir) !== key) continue;
    for (const g of w.groups)
      for (const id of g.sessionIds) {
        const m = metas.get(id);
        if (m && isTerminalMeta(m) && !seen.has(id)) {
          seen.add(id);
          out.push({ id, name: m.name, role: m.role ?? null });
        }
      }
  }
  return out;
}

function cleanLanding(key: string): boolean {
  const f = flights.get(key);
  if (!f || f.committed.size === 0) return false;
  for (const slug of f.committed) if (!f.handed.has(slug)) return false;
  return true;
}

function goodBoard(entry: MissionEntry | undefined): MissionDoc | null | undefined {
  // undefined = no usable read (keep the last baseline); null = no mission file.
  if (!entry || entry.loading || entry.error || !entry.file) return undefined;
  return entry.file.exists && entry.doc ? entry.doc : null;
}

function onDocs(byDir: Record<string, MissionEntry>, prev: Record<string, MissionEntry>) {
  for (const [dir, entry] of Object.entries(byDir)) {
    if (entry === prev[dir]) continue;
    const next = goodBoard(entry);
    if (next === undefined) continue;
    const key = dirKey(dir);
    const before = boards.get(key);
    if (next) boards.set(key, next);
    else boards.delete(key);
    if (!before || !next || before === next || !useFlightLog.getState().data.enabled) continue;
    const done = newlyDone(before, next);
    const finished = done.length > 0 && missionFinished(before, next);
    if (done.length === 0) continue;
    const now = Date.now();
    const at = writeTime(entry.file?.modifiedMs, now);
    const team = teamFor(key);
    commit(
      recordMission(
        useFlightLog.getState().data,
        { project: key, goal: next.goal, completions: done.map((t) => ({ text: t.text, at, agents: creditedSessions(t, team) })), finished: finished ? { at, clean: cleanLanding(key) } : null },
        now,
      ),
    );
  }
}

function onRecorded(key: string, ev: ReplayEvent) {
  switch (ev.k) {
    case "start":
      flights.set(key, { committed: new Set(), handed: new Set() });
      break;
    case "branch": {
      if (!useFlightLog.getState().data.enabled) return;
      const r = recordCommits(useFlightLog.getState().data, key, ev.w, ev.ahead, Date.now());
      if (r.commits > 0) flights.get(key)?.committed.add(ev.slug);
      commit(r);
      break;
    }
    case "msg":
      if (ev.from !== "you") flights.get(key)?.handed.add(ev.from);
      break;
    default:
      break;
  }
}

/** Wire the subscriptions once (FlightLogLayer). Returns a cleanup. */
export function installFlightLog(): () => void {
  if (installed) return () => {};
  installed = true;
  // What is already loaded is the baseline.
  for (const [dir, entry] of Object.entries(useMissionDocs.getState().byDir)) {
    const b = goodBoard(entry);
    if (b) boards.set(dirKey(dir), b);
  }
  const offDocs = useMissionDocs.subscribe((s, prev) => {
    if (s.byDir !== prev.byDir) onDocs(s.byDir, prev.byDir);
  });
  const offTap = tapRecorder(onRecorded);
  return () => {
    offDocs();
    offTap();
    boards.clear();
    flights.clear();
    installed = false;
  };
}

/** Test hook. */
export function resetFlightLogForTests(data?: FlightLogData): void {
  boards.clear();
  flights.clear();
  installed = false;
  chime = null;
  useFlightLog.setState({ data: data ?? parseLog(null).data, readOnly: false, open: false });
}
