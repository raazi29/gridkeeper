// Mission file state per project folder (see lib/missionDoc.ts for the format). Ephemeral zustand store.
// Work happens only while a view holds the folder (`useMissionFile`, i.e. while Mission Control is open):
// a ref-counted filesystem watch in Rust (no polling) plus a re-read on every `mission-changed` event.
// Writes pass the last-read modification time so an agent's concurrent edit is never overwritten; on a
// conflict the file is re-read and the user is told to try again.

import { useEffect } from "react";
import { create } from "zustand";
import { notify } from "../actions/notify";
import { errorMessage, ipc, onMissionChanged } from "../lib/ipc";
import { parseMission, setTaskState, type MissionDoc, type TaskState } from "../lib/missionDoc";
import type { MissionFile } from "../lib/types";
import { actionToast } from "./uiStore";

export interface MissionEntry {
  file: MissionFile | null;
  /** Parsed file; null while unread or when the file does not exist. */
  doc: MissionDoc | null;
  loading: boolean;
  error: string | null;
}

export const EMPTY_MISSION: MissionEntry = { file: null, doc: null, loading: false, error: null };

export const CONFLICT_MESSAGE = "The mission file changed — reloaded, try again";

export const useMissionDocs = create<{ byDir: Record<string, MissionEntry> }>()(() => ({ byDir: {} }));

/** Folder key for comparing paths from the UI and from Rust events (case, slashes, trailing separator). */
export function dirKey(dir: string): string {
  return dir.trim().replace(/\//g, "\\").replace(/\\+$/, "").toLowerCase();
}

function patch(dir: string, p: Partial<MissionEntry>) {
  useMissionDocs.setState((s) => ({ byDir: { ...s.byDir, [dir]: { ...(s.byDir[dir] ?? EMPTY_MISSION), ...p } } }));
}

function setFile(dir: string, file: MissionFile) {
  readSeq.set(dir, (readSeq.get(dir) ?? 0) + 1); // results of reads started earlier are stale now
  patch(dir, { file, doc: file.exists ? parseMission(file.text) : null, loading: false, error: null });
}

// ---- reading ----------------------------------------------------------------------------------

const readSeq = new Map<string, number>();
const inflight = new Set<string>();
const again = new Set<string>();

/** Re-read the mission file. Bursts of change events coalesce into at most one extra read. */
export async function reloadMission(dir: string): Promise<void> {
  if (inflight.has(dir)) {
    again.add(dir);
    return;
  }
  inflight.add(dir);
  try {
    do {
      again.delete(dir);
      const n = (readSeq.get(dir) ?? 0) + 1;
      readSeq.set(dir, n);
      if (!useMissionDocs.getState().byDir[dir]?.file) patch(dir, { loading: true });
      try {
        const file = await ipc.missionRead(dir);
        if (readSeq.get(dir) === n) setFile(dir, file);
      } catch (e) {
        if (readSeq.get(dir) === n) patch(dir, { loading: false, error: errorMessage(e) });
      }
    } while (again.has(dir));
  } finally {
    inflight.delete(dir);
  }
}

// ---- watching (ref-counted per folder; one event listener while anything is held) --------------

const holds = new Map<string, number>();
let unlisten: Promise<(() => void) | null> | null = null;

function ensureListener() {
  if (unlisten) return;
  unlisten = onMissionChanged((ev) => {
    const key = dirKey(ev.projectDir);
    for (const dir of holds.keys()) if (dirKey(dir) === key) void reloadMission(dir);
  }).catch(() => null);
}

function dropListener() {
  const p = unlisten;
  unlisten = null;
  void p?.then((off) => off?.());
}

// watch / unwatch are separate async invokes: chain them per folder so an unwatch never overtakes its watch.
const watchOps = new Map<string, Promise<unknown>>();
function watchOp(dir: string, call: (d: string) => Promise<unknown>) {
  const p = (watchOps.get(dir) ?? Promise.resolve()).then(() => call(dir)).catch(() => {});
  watchOps.set(dir, p);
  void p.then(() => watchOps.get(dir) === p && watchOps.delete(dir));
}

/** Watch + read `dir` until the returned release function is called. */
export function acquireMission(dir: string): () => void {
  const n = (holds.get(dir) ?? 0) + 1;
  holds.set(dir, n);
  if (n === 1) {
    ensureListener();
    // no watcher on failure: the board still shows the last read and updates after our own writes
    watchOp(dir, ipc.missionWatch);
    void reloadMission(dir);
  }
  let released = false;
  return () => {
    if (released) return;
    released = true;
    const left = (holds.get(dir) ?? 1) - 1;
    if (left > 0) {
      holds.set(dir, left);
      return;
    }
    holds.delete(dir);
    watchOp(dir, ipc.missionUnwatch);
    if (holds.size === 0) dropListener();
  };
}

/** Mission file of `projectDir`, watched and kept fresh while the calling component is mounted. */
export function useMissionFile(projectDir: string | null | undefined): MissionEntry {
  useEffect(() => (projectDir ? acquireMission(projectDir) : undefined), [projectDir]);
  return useMissionDocs((s) => (projectDir ? s.byDir[projectDir] : undefined)) ?? EMPTY_MISSION;
}

// ---- writing ----------------------------------------------------------------------------------

export function isConflict(e: unknown): boolean {
  return !!e && typeof e === "object" && (e as { code?: unknown }).code === "conflict";
}

export type WriteResult = { ok: true; file: MissionFile } | { ok: false; conflict: boolean };

/**
 * Write the mission file. `expected` = the modification time the text was based on (null = the file
 * must not exist yet); by default the last-read file's. On a conflict: re-read + toast.
 */
export async function writeMission(dir: string, text: string, expected?: number | null, conflictMessage = CONFLICT_MESSAGE): Promise<WriteResult> {
  const cur = useMissionDocs.getState().byDir[dir]?.file;
  const base = expected !== undefined ? expected : cur?.exists ? cur.modifiedMs : null;
  try {
    const file = await ipc.missionWrite(dir, text, base);
    setFile(dir, file);
    return { ok: true, file };
  } catch (e) {
    if (isConflict(e)) {
      await reloadMission(dir);
      notify("warn", conflictMessage);
      return { ok: false, conflict: true };
    }
    notify("error", `Could not save the mission file: ${errorMessage(e)}`);
    return { ok: false, conflict: false };
  }
}

export const UNDO_CONFLICT_MESSAGE = "Can't undo: the mission file changed since — reloaded";

// Board edits run one at a time per folder, each on the file the previous one left (rapid Alt+↓ presses,
// a drop while a write is in flight).
const queues = new Map<string, Promise<unknown>>();
function serial<T>(dir: string, fn: () => Promise<T>): Promise<T> {
  const run = (queues.get(dir) ?? Promise.resolve()).then(fn, fn);
  const tail = run.catch(() => {});
  queues.set(dir, tail);
  void tail.then(() => {
    if (queues.get(dir) === tail) queues.delete(dir);
  });
  return run;
}

export interface EditOptions {
  /** After a successful write: a toast with this message and an Undo button (restores the previous text). */
  undo?: string;
  /** The task the edit is about, as the UI saw it: the edit is refused (re-read + toast) unless the file still has it on that line. */
  expect?: { line: number; text: string };
}

/**
 * Apply a pure edit (`edit(text)` → new text; null = the line is stale) to the last-read file and write it
 * with that file's modification time, so a concurrent agent edit is never overwritten (conflict → re-read +
 * toast). Returns true when the file now has the edit (also for a no-op).
 */
export function editMission(dir: string, edit: (text: string) => string | null, opts: EditOptions = {}): Promise<boolean> {
  return serial(dir, async () => {
    const file = useMissionDocs.getState().byDir[dir]?.file;
    if (!file?.exists) return false;
    const exp = opts.expect;
    const stale = exp && !parseMission(file.text).tasks.some((t) => t.line === exp.line && t.text === exp.text);
    const next = stale ? null : edit(file.text);
    if (next === null) {
      await reloadMission(dir);
      notify("warn", CONFLICT_MESSAGE);
      return false;
    }
    if (next === file.text) return true;
    const r = await writeMission(dir, next, file.modifiedMs);
    if (r.ok && opts.undo) {
      const before = file.text;
      const after = r.file.modifiedMs;
      actionToast({ kind: "info", message: opts.undo, action: { label: "Undo", run: () => void undoMission(dir, before, after) } });
    }
    return r.ok;
  });
}

/** Restore `before` if the file is still exactly what our edit wrote (modification time `after`). */
export function undoMission(dir: string, before: string, after: number | null): Promise<boolean> {
  return serial(dir, async () => (await writeMission(dir, before, after, UNDO_CONFLICT_MESSAGE)).ok);
}

/** Change one task's box (by line) in the last-read file. A stale line re-reads instead of guessing. */
export function updateTaskState(dir: string, line: number, state: TaskState): Promise<boolean> {
  return editMission(dir, (text) => setTaskState(text, line, state));
}

/** Test hook: forget every hold / listener / cached entry. */
export function resetMissionDocsForTests() {
  holds.clear();
  readSeq.clear();
  inflight.clear();
  again.clear();
  queues.clear();
  unlisten = null;
  useMissionDocs.setState({ byDir: {} });
}
