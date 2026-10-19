// Mission replay recorder: turns what already happens in the app into compact JSON lines in
// `<projectDir>/.gridkeeper/replay/<YYYY-MM-DD-HHmm>-<slug(goal)>.jsonl` (format: replay/events.ts).
//
// - Event-driven only: subscriptions to the mission file store, attention, branch summaries, the activity
//   log and the app store. No timers while nothing happens; while events arrive, one flush at most every
//   FLUSH_MS (2 s) through `replay_append`.
// - When: automatically (setting, default on) as soon as the ACTIVE workspace's mission file is read
//   by a watcher (Mission Control open, or anything else holding the file), or when the user presses
//   "rec". A recording holds its own mission-file watch, so it keeps going after Mission Control closes,
//   until the user stops it (a stop also suppresses auto-record for that project for this run).
// - Recording the same goal again within RESUME_MS of the last write appends to that file (an app
//   restart doesn't split a mission); more than IDLE_SPLIT_MS without any event starts a new file.
// - PRIVACY: only goal / task text / session names (scrubbed), roles, agent kinds, attention states,
//   branch NUMBERS (+ an opaque folder hash), short message previews (scrubbed, <= 120 chars). Never
//   terminal output, file contents, environment, paths or account e-mails.

import { notify } from "../actions/notify";
import { t } from "../i18n";
import { evidencePath, pathKey, refreshBranchSummary, scheduleBranchSummary, useBranchSummaries } from "../actions/handoff";
import { isTerminalMeta } from "../lib/browserPanes";
import { errorMessage, ipc } from "../lib/ipc";
import { slugify } from "../lib/missionDoc";
import { normalizeRole } from "../lib/roles";
import type { SessionId, SessionInfo, SessionMeta } from "../lib/types";
import { useActivity, type ActivityEvent } from "../store/activity";
import { isLive, selectActiveWorkspace, useApp } from "../store/appStore";
import { useAttention, type AttnState } from "../store/attention";
import { acquireMission, dirKey, useMissionDocs, type MissionEntry } from "../store/missionDoc";
import { bumpReplayVersion, useReplay, type RecordingStatus } from "../store/replay";
import { diffMission, EMPTY_SNAP, plainTasks, snapMission, type MissionSnap } from "./diff";
import {
  encodeEvent,
  folderHash,
  goalSlug,
  metaFromName,
  MSG_MAX,
  NAME_MAX,
  recordingFileName,
  REPLAY_FORMAT,
  scrubText,
  type LeaveReason,
  type ReplayAttn,
  type ReplayEvent,
  type ReplayMember,
} from "./events";

export const FLUSH_MS = 2000;
export const RESUME_MS = 6 * 3600_000;
export const IDLE_SPLIT_MS = 6 * 3600_000;
/** Broadcasts to several sessions arrive as one activity event per target: merged within this window. */
export const MSG_MERGE_MS = 2000;
const DOC_WAIT_MS = 2500;
const MAX_FAILURES = 3;
const NEAR_FULL = 4.5 * 1024 * 1024;

// ---- pure helpers (unit-tested) -----------------------------------------------------------------

export function mapAttn(s: AttnState | undefined): ReplayAttn {
  return s === "waiting" ? "needs" : s === "working" || s === "done" || s === "error" ? s : "idle";
}

/** A slug for `name` not in `used` (name slug, else "agent"; "-2", "-3", … on collisions). */
export function uniqueSlug(name: string, used: ReadonlySet<string>): string {
  const base = slugify(scrubText(name, NAME_MAX).replace(/[‹›]/g, "")).slice(0, NAME_MAX) || "agent";
  if (!used.has(base)) return base;
  for (let i = 2; ; i++) if (!used.has(`${base}-${i}`)) return `${base}-${i}`;
}

export function leaveReason(info: SessionInfo | undefined): LeaveReason {
  const st = info?.state;
  if (!st) return "stopped";
  if (st.state === "failed") return "error";
  if (st.state === "exited" && st.code !== null && st.code !== 0) return "error";
  return "stopped";
}

export interface MsgDraft {
  from: string;
  text: string;
}

/**
 * Activity log entry → message (sender + text), or null when it isn't one. Recipient = the entry's
 * session. `slugOfName` maps a session NAME to its recorded slug (hand-offs name their sender).
 */
export function msgFromActivity(e: Pick<ActivityEvent, "kind" | "level" | "message" | "result">, slugOfName: (name: string) => string | null): MsgDraft | null {
  if (e.level === "error" || e.result === "failed" || e.result === "skipped") return null;
  if (e.kind === "broadcast") {
    if (e.message.startsWith("broadcast: ")) return { from: "you", text: e.message.slice("broadcast: ".length) };
    const h = /^hand-off from (.+?): (.*)$/s.exec(e.message);
    if (h) return { from: slugOfName(h[1]) ?? (slugify(h[1]) || "agent"), text: h[2] };
    return null; // "handed off to X" is the sender-side echo of the same hand-off
  }
  if (e.kind === "mission") {
    const i = e.message.indexOf(": ");
    if (i < 0) return null;
    const prefix = e.message.slice(0, i).toLowerCase();
    if (/\bnot sent\b|\bfailed\b/.test(prefix)) return null;
    const from = /\blead\b/.test(prefix) ? (slugOfName("lead") ?? "lead") : "you";
    return { from, text: e.message.slice(i + 2) };
  }
  return null;
}

// ---- recordings ---------------------------------------------------------------------------------

interface Member {
  slug: string;
  name: string;
  role: string | null;
  agent: string;
  live: boolean;
  /** Shown in the recording (in a `start` roster or joined). */
  announced: boolean;
  attn: ReplayAttn;
  /** Last branch signature recorded ("w|ahead|files|ins|del"). */
  branch: string | null;
  path: string | null;
}

interface Rec {
  dir: string;
  key: string;
  file: string | null;
  manual: boolean;
  started: boolean;
  stopped: boolean;
  startedAt: number;
  lastEventAt: number;
  pending: ReplayEvent[];
  timer: ReturnType<typeof setTimeout> | null;
  flushing: boolean;
  failures: number;
  release: () => void;
  snap: MissionSnap;
  /** Mission store entry last diffed (reference compare). */
  entry: MissionEntry | undefined;
  members: Map<SessionId, Member>;
  events: number;
  bytes: number;
}

const recs = new Map<string, Rec>();
/** Observers of queued events (the flight log reads branch and message events). */
export type RecorderTap = (projectKey: string, ev: ReplayEvent) => void;
const taps = new Set<RecorderTap>();

/** Observe every event a recording queues (`projectKey` = dirKey of the project). Returns an unsubscribe. */
export function tapRecorder(fn: RecorderTap): () => void {
  taps.add(fn);
  return () => void taps.delete(fn);
}

/** Projects whose recording the user stopped this run: no auto-restart. */
const userStopped = new Set<string>();
let installed = false;

function publish(rec: Rec | null, key: string) {
  useReplay.setState((s) => {
    const recording = { ...s.recording };
    if (!rec || rec.stopped) delete recording[key];
    else {
      const st: RecordingStatus = { dir: rec.dir, file: rec.file, startedAt: rec.startedAt, events: rec.events, bytes: rec.bytes, manual: rec.manual };
      recording[key] = st;
    }
    return { recording };
  });
}

// ---- team ---------------------------------------------------------------------------------------

type AppState = ReturnType<typeof useApp.getState>;

/** Process sessions of every workspace whose project folder is `key`, in layout order. */
function teamOf(s: AppState, key: string): SessionMeta[] {
  const metas = new Map(s.persisted.sessions.map((m) => [m.id, m]));
  const out: SessionMeta[] = [];
  const seen = new Set<string>();
  for (const w of s.persisted.workspaces) {
    if (!w.projectDir || dirKey(w.projectDir) !== key) continue;
    for (const g of w.groups)
      for (const id of g.sessionIds) {
        const m = metas.get(id);
        if (m && isTerminalMeta(m) && !seen.has(id)) {
          seen.add(id);
          out.push(m);
        }
      }
  }
  return out;
}

function memberFields(m: SessionMeta) {
  return {
    name: scrubText(m.name, NAME_MAX) || "agent",
    role: normalizeRole(m.role),
    agent: (m.agent === "generic" && m.preset ? m.preset : m.agent).slice(0, 24),
    path: evidencePath(m),
  };
}

function usedSlugs(rec: Rec, except?: SessionId): Set<string> {
  const used = new Set<string>();
  for (const [id, m] of rec.members) if (id !== except) used.add(m.slug);
  return used;
}

function rosterOf(rec: Rec): ReplayMember[] {
  return [...rec.members.values()].map((m) => ({ slug: m.slug, name: m.name, role: m.role, agent: m.agent, live: m.live }));
}

// ---- event queue --------------------------------------------------------------------------------

function push(rec: Rec, ev: ReplayEvent) {
  if (rec.stopped) return;
  if (rec.started && rec.lastEventAt && ev.t - rec.lastEventAt > IDLE_SPLIT_MS && ev.k !== "end") rollover(rec, ev.t);
  // One broadcast = one activity event per target: merge into one message.
  if (ev.k === "msg") {
    const last = rec.pending[rec.pending.length - 1];
    if (last && last.k === "msg" && last.from === ev.from && last.text === ev.text && ev.t - last.t < MSG_MERGE_MS) {
      for (const to of ev.to) if (!last.to.includes(to)) last.to.push(to);
      return;
    }
  }
  rec.pending.push(ev);
  rec.lastEventAt = Math.max(rec.lastEventAt, ev.t);
  schedule(rec);
  for (const tap of taps) {
    try {
      tap(rec.key, ev);
    } catch {
      /* an observer never breaks recording */
    }
  }
}

function schedule(rec: Rec, ms = FLUSH_MS) {
  if (rec.timer || rec.flushing || !rec.file) return;
  rec.timer = setTimeout(() => {
    rec.timer = null;
    void flush(rec);
  }, ms);
}

async function flush(rec: Rec): Promise<void> {
  if (rec.flushing || !rec.file || rec.pending.length === 0) return;
  if (rec.timer) {
    clearTimeout(rec.timer);
    rec.timer = null;
  }
  const batch = rec.pending.splice(0);
  const file = rec.file;
  rec.flushing = true;
  try {
    const r = await ipc.replayAppend(rec.dir, file, batch.map(encodeEvent));
    rec.failures = 0;
    if (r.full) {
      notify("warn", t("replay.recorderFull"));
      finish(rec, { userStop: false, writeEnd: false });
      return;
    }
    rec.events += batch.length;
    rec.bytes = r.sizeBytes;
    publish(rec, rec.key);
    bumpReplayVersion();
  } catch (e) {
    rec.failures++;
    if (rec.failures >= MAX_FAILURES) {
      notify("error", t("replay.recorderFailed", { error: errorMessage(e) }));
      finish(rec, { userStop: false, writeEnd: false });
      return;
    }
    rec.pending.unshift(...batch); // retry with the next flush
  } finally {
    rec.flushing = false;
  }
  if (rec.pending.length && !rec.stopped) schedule(rec);
}

// ---- snapshots / diffs --------------------------------------------------------------------------

function startEvent(rec: Rec, t: number): ReplayEvent {
  return { t, k: "start", v: REPLAY_FORMAT, goal: rec.snap.goal, team: rosterOf(rec), tasks: plainTasks(rec.snap) };
}

/** Members' current state right after a `start`: attention + a branch baseline refresh. */
function seedAfterStart(rec: Rec, t: number) {
  const attn = useAttention.getState().sessions;
  const paths = new Set<string>();
  for (const [id, m] of rec.members) {
    m.announced = true;
    m.attn = mapAttn(attn[id]?.state);
    if (m.live && m.attn !== "idle") push(rec, { t, k: "attn", slug: m.slug, s: m.attn });
    m.branch = null;
    if (m.path) paths.add(m.path);
  }
  // Baselines come from fresh reads only (a cached summary may predate the recording).
  for (const p of paths) void refreshBranchSummary(p);
}

/** More than IDLE_SPLIT_MS without events: close this file, continue in a new one. */
function rollover(rec: Rec, t: number) {
  const tail = rec.pending.splice(0);
  tail.push({ t: rec.lastEventAt + 1000, k: "end" });
  const old = rec.file;
  if (old) void ipc.replayAppend(rec.dir, old, tail.map(encodeEvent)).catch(() => {});
  rec.file = recordingFileName(new Date(t), rec.snap.goal);
  if (rec.file === old) rec.file = recordingFileName(new Date(t), rec.snap.goal, "-2");
  rec.startedAt = t;
  rec.events = 0;
  rec.bytes = 0;
  rec.lastEventAt = t;
  rec.pending.push(startEvent(rec, t));
  publish(rec, rec.key);
}

function syncMission(rec: Rec, t: number) {
  const entry = useMissionDocs.getState().byDir[rec.dir];
  if (entry === rec.entry) return;
  rec.entry = entry;
  // A failed read keeps the last good board (no flurry of "gone" tasks for a transient error).
  if (!entry || entry.loading || entry.error) return;
  const next = entry.file?.exists && entry.doc ? snapMission(entry.doc) : EMPTY_SNAP;
  for (const ev of diffMission(rec.snap, next, t)) push(rec, ev);
  rec.snap = next;
}

function syncTeam(rec: Rec, t: number) {
  const s = useApp.getState();
  const team = teamOf(s, rec.key);
  const ids = new Set(team.map((m) => m.id));
  const attn = useAttention.getState().sessions;
  for (const meta of team) {
    const f = memberFields(meta);
    const live = isLive(s.runtime[meta.id]);
    let m = rec.members.get(meta.id);
    if (!m) {
      m = { slug: uniqueSlug(f.name, usedSlugs(rec)), name: f.name, role: f.role, agent: f.agent, live, announced: false, attn: mapAttn(attn[meta.id]?.state), branch: null, path: f.path };
      rec.members.set(meta.id, m);
      if (live) {
        m.announced = true;
        push(rec, { t, k: "join", slug: m.slug, name: m.name, role: m.role, agent: m.agent });
        if (m.path) void refreshBranchSummary(m.path);
      }
      continue;
    }
    const renamed = f.name !== m.name;
    const changed = renamed || f.role !== m.role || f.agent !== m.agent;
    const was = m.slug;
    if (renamed) m.slug = uniqueSlug(f.name, usedSlugs(rec, meta.id));
    m.name = f.name;
    m.role = f.role;
    m.agent = f.agent;
    if (f.path !== m.path) {
      m.path = f.path;
      m.branch = null;
      if (live && f.path) void refreshBranchSummary(f.path);
    }
    if (live && (!m.live || changed || !m.announced)) {
      push(rec, { t, k: "join", slug: m.slug, name: m.name, role: m.role, agent: m.agent, ...(renamed && m.announced && was !== m.slug ? { was } : {}) });
      if (!m.live && m.path) void refreshBranchSummary(m.path);
      m.announced = true;
    } else if (!live && m.live && m.announced) {
      push(rec, { t, k: "leave", slug: m.slug, why: leaveReason(s.runtime[meta.id]) });
      if (m.path) scheduleBranchSummary(m.path);
    }
    m.live = live;
  }
  for (const [id, m] of rec.members)
    if (!ids.has(id)) {
      if (m.announced) push(rec, { t, k: "leave", slug: m.slug, why: "removed" });
      rec.members.delete(id);
    }
}

function syncAttention(rec: Rec, t: number, prev: Record<SessionId, { state: AttnState }> | null) {
  const attn = useAttention.getState().sessions;
  for (const [id, m] of rec.members) {
    if (!m.announced) continue;
    const next = mapAttn(attn[id]?.state);
    if (next === m.attn) continue;
    m.attn = next;
    push(rec, { t: attn[id]?.at && attn[id].at <= t ? Math.max(attn[id].at, rec.startedAt) : t, k: "attn", slug: m.slug, s: next });
    // Branch evidence changes when an agent finishes or stops to ask: refresh (debounced, read-only git).
    const before = prev?.[id]?.state;
    if (m.path && (next === "done" || next === "needs") && before !== attn[id]?.state) scheduleBranchSummary(m.path);
  }
}

function syncBranches(rec: Rec, t: number) {
  const byPath = useBranchSummaries.getState().byPath;
  for (const m of rec.members.values()) {
    if (!m.path || !m.announced) continue;
    const entry = byPath[pathKey(m.path)];
    const sum = entry?.summary;
    if (!sum?.isRepo) continue;
    // The first (baseline) observation must be read after the recording started.
    if (m.branch === null && entry.at < rec.startedAt) continue;
    const w = folderHash(m.path);
    const sig = `${w}|${sum.ahead}|${sum.filesChanged}|${sum.insertions}|${sum.deletions}`;
    if (sig === m.branch) continue;
    m.branch = sig;
    push(rec, { t, k: "branch", slug: m.slug, w, ahead: sum.ahead, files: sum.filesChanged, ins: sum.insertions, del: sum.deletions });
  }
}

let lastActivitySeq = 0;

function syncActivity(events: readonly ActivityEvent[]) {
  let maxSeq = lastActivitySeq;
  for (const e of events) {
    if (e.seq <= lastActivitySeq) continue;
    maxSeq = Math.max(maxSeq, e.seq);
    if (!e.sessionId) continue;
    for (const rec of recs.values()) {
      if (!rec.started || rec.stopped) continue;
      const to = rec.members.get(e.sessionId);
      if (!to) continue;
      const draft = msgFromActivity(e, (name) => {
        const n = scrubText(name, NAME_MAX);
        for (const m of rec.members.values()) if (m.name === n || m.slug === slugify(n) || (name === "lead" && m.role === "lead")) return m.slug;
        return null;
      });
      if (!draft) continue;
      const text = scrubText(draft.text, MSG_MAX);
      if (!text) continue;
      push(rec, { t: e.at, k: "msg", from: scrubText(draft.from, NAME_MAX) || "you", to: [to.slug], text });
    }
  }
  lastActivitySeq = maxSeq;
}

// ---- start / stop -------------------------------------------------------------------------------

function waitForDoc(dir: string, ms: number): Promise<void> {
  const ready = () => {
    const e = useMissionDocs.getState().byDir[dir];
    return !!e && !e.loading && (!!e.file || !!e.error);
  };
  if (ready()) return Promise.resolve();
  return new Promise((resolve) => {
    const timer = setTimeout(done, ms);
    const off = useMissionDocs.subscribe(() => ready() && done());
    function done() {
      clearTimeout(timer);
      off();
      resolve();
    }
  });
}

async function chooseFile(rec: Rec, now: number): Promise<string> {
  const slug = goalSlug(rec.snap.goal);
  let fresh = recordingFileName(new Date(now), rec.snap.goal);
  try {
    const list = await ipc.replayList(rec.dir);
    const latest = list[0];
    if (latest && metaFromName(latest.name).slug === slug && now - latest.modifiedMs < RESUME_MS && latest.sizeBytes < NEAR_FULL) return latest.name;
    for (let i = 2; list.some((x) => x.name === fresh); i++) fresh = recordingFileName(new Date(now), rec.snap.goal, `-${i}`);
  } catch {
    /* listing failed: a fresh name; the append reports real problems */
  }
  return fresh;
}

export function isRecording(dir: string | null | undefined): boolean {
  return !!dir && recs.has(dirKey(dir));
}

/** Start recording `dir` (no-op when already recording). `manual` = the user pressed "rec". */
export async function startRecording(dir: string, opts: { manual: boolean }): Promise<void> {
  const key = dirKey(dir);
  if (!dir.trim() || recs.has(key)) return;
  if (opts.manual) userStopped.delete(key);
  const now = Date.now();
  const rec: Rec = {
    dir,
    key,
    file: null,
    manual: opts.manual,
    started: false,
    stopped: false,
    startedAt: now,
    lastEventAt: 0,
    pending: [],
    timer: null,
    flushing: false,
    failures: 0,
    release: acquireMission(dir),
    snap: EMPTY_SNAP,
    entry: undefined,
    members: new Map(),
    events: 0,
    bytes: 0,
  };
  recs.set(key, rec);
  publish(rec, key);
  await waitForDoc(dir, DOC_WAIT_MS);
  if (rec.stopped) return;
  const entry = useMissionDocs.getState().byDir[dir];
  rec.entry = entry;
  rec.snap = entry?.file?.exists && entry.doc ? snapMission(entry.doc) : EMPTY_SNAP;
  const t = Date.now();
  // Team as it is now (stopped sessions are in the roster, dimmed).
  const s = useApp.getState();
  for (const meta of teamOf(s, key)) {
    const f = memberFields(meta);
    rec.members.set(meta.id, { slug: uniqueSlug(f.name, usedSlugs(rec)), name: f.name, role: f.role, agent: f.agent, live: isLive(s.runtime[meta.id]), announced: true, attn: "idle", branch: null, path: f.path });
  }
  rec.file = await chooseFile(rec, t);
  if (rec.stopped) return;
  rec.startedAt = t;
  rec.started = true;
  push(rec, startEvent(rec, t));
  seedAfterStart(rec, t);
  publish(rec, key);
  void flush(rec); // write the start right away: the file exists as soon as "● rec" shows
}

interface FinishOpts {
  userStop: boolean;
  writeEnd: boolean;
}

function finish(rec: Rec, o: FinishOpts) {
  if (rec.stopped) return;
  if (o.userStop) userStopped.add(rec.key);
  if (o.writeEnd && rec.started) rec.pending.push({ t: Date.now(), k: "end" });
  const batch = rec.pending.splice(0);
  rec.stopped = true;
  if (rec.timer) clearTimeout(rec.timer);
  rec.timer = null;
  rec.release();
  recs.delete(rec.key);
  publish(null, rec.key);
  if (batch.length && rec.file) {
    ipc
      .replayAppend(rec.dir, rec.file, batch.map(encodeEvent))
      .then(() => bumpReplayVersion())
      .catch(() => {});
  } else bumpReplayVersion();
}

/** Stop recording `dir` (writes `end`); auto-record won't restart it this run. */
export function stopRecording(dir: string): void {
  const rec = recs.get(dirKey(dir));
  if (rec) finish(rec, { userStop: true, writeEnd: true });
}

/** Write what is pending now (before reading a recording that is still being written). */
export async function flushRecording(dir: string): Promise<void> {
  const rec = recs.get(dirKey(dir));
  if (rec?.started) await flush(rec);
}

// ---- auto-record --------------------------------------------------------------------------------

/** Active project's mission file was (re)read: start recording if the setting is on and a mission exists. */
function evaluateAuto(prevByDir: Record<string, MissionEntry> | null) {
  if (!useReplay.getState().auto) return;
  const dir = selectActiveWorkspace(useApp.getState())?.projectDir;
  if (!dir) return;
  const key = dirKey(dir);
  if (recs.has(key) || userStopped.has(key)) return;
  const entry = useMissionDocs.getState().byDir[dir];
  if (!entry || entry === prevByDir?.[dir]) return;
  const doc = entry.file?.exists ? entry.doc : null;
  if (!doc || (!doc.goal && doc.tasks.length === 0)) return;
  void startRecording(dir, { manual: false });
}

// ---- install --------------------------------------------------------------------------------------

/** Wire the subscriptions (once, at app level: ReplayLayer). Returns a full cleanup. */
export function installReplayRecorder(): () => void {
  if (installed) return () => {};
  installed = true;
  const ev = useActivity.getState().events;
  lastActivitySeq = ev.length ? ev[ev.length - 1].seq : 0;

  const active = () => {
    for (const r of recs.values()) if (r.started && !r.stopped) return true;
    return false;
  };

  const offDocs = useMissionDocs.subscribe((s, prev) => {
    if (s.byDir === prev.byDir) return;
    evaluateAuto(prev.byDir);
    if (!active()) return;
    const t = Date.now();
    for (const r of recs.values()) if (r.started) syncMission(r, t);
  });
  const offApp = useApp.subscribe((s, prev) => {
    if (!active()) return;
    if (s.persisted.sessions === prev.persisted.sessions && s.persisted.workspaces === prev.persisted.workspaces && s.runtime === prev.runtime) return;
    const t = Date.now();
    for (const r of recs.values()) if (r.started) syncTeam(r, t);
  });
  const offAttn = useAttention.subscribe((s, prev) => {
    if (s.sessions === prev.sessions || !active()) return;
    const t = Date.now();
    for (const r of recs.values()) if (r.started) syncAttention(r, t, prev.sessions);
  });
  const offBranch = useBranchSummaries.subscribe((s, prev) => {
    if (s.byPath === prev.byPath || !active()) return;
    const t = Date.now();
    for (const r of recs.values()) if (r.started) syncBranches(r, t);
  });
  const offActivity = useActivity.subscribe((s, prev) => {
    if (s.events === prev.events) return;
    if (!active()) {
      const last = s.events[s.events.length - 1];
      lastActivitySeq = last ? last.seq : lastActivitySeq;
      return;
    }
    syncActivity(s.events);
  });
  // Best effort on reload / close: write what is pending (no `end`: the recording may resume).
  const onHide = () => {
    for (const r of recs.values()) if (r.started && r.pending.length) void flush(r);
  };
  const win = typeof window === "undefined" ? null : window;
  win?.addEventListener("pagehide", onHide);

  return () => {
    offDocs();
    offApp();
    offAttn();
    offBranch();
    offActivity();
    win?.removeEventListener("pagehide", onHide);
    for (const r of [...recs.values()]) finish(r, { userStop: false, writeEnd: true });
    installed = false;
  };
}

/** Test hook. */
export function resetRecorderForTests(): void {
  for (const r of recs.values()) {
    if (r.timer) clearTimeout(r.timer);
    r.release();
  }
  recs.clear();
  userStopped.clear();
  installed = false;
  lastActivitySeq = 0;
  useReplay.setState({ recording: {} });
}
