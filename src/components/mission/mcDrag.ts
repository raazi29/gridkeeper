// Mission Control drag & drop state. HTML5 dataTransfer payloads are unreadable during dragover, so
// the current drag lives here (like layout/paneDrag.ts); the MIME type on dataTransfer only says WHAT
// is being dragged. Three kinds:
//   - session card  (MIME application/x-gridkeeper-session, payload = session id)
//   - lane          (MIME application/x-gridkeeper-lane, payload = group id; drag handle on the label)
//   - mission task  (MIME application/x-gridkeeper-task; started by the mission board, dropped on a card)
// `useMcDragKind` changes only on begin/end (never per dragover), so components can show drop zones
// without re-rendering while the pointer moves.

import { create } from "zustand";
import type { SessionId } from "../../lib/types";

export const SESSION_MIME = "application/x-gridkeeper-session";
export const LANE_MIME = "application/x-gridkeeper-lane";
export const TASK_MIME = "application/x-gridkeeper-task";

export interface SessionDrag {
  sessionId: SessionId;
  /** Group the card was dragged from. */
  fromGroupId: string;
}

export interface LaneDrag {
  groupId: string;
}

/** A mission task line being dragged from the board (`line` = 0-based line in mission.md). */
export interface TaskDrag {
  line: number;
  text: string;
}

export type McDragKind = "session" | "lane" | "task" | null;

/** What is being dragged (for drop-zone visuals). `sessionId` = the dragged card, if any. */
export const useMcDragKind = create<{ kind: McDragKind; sessionId: SessionId | null }>()(() => ({ kind: null, sessionId: null }));

let session: SessionDrag | null = null;
let lane: LaneDrag | null = null;
let task: TaskDrag | null = null;
let queued = false;

function publish() {
  queued = false;
  const kind: McDragKind = session ? "session" : lane ? "lane" : task ? "task" : null;
  const sessionId = session?.sessionId ?? null;
  const cur = useMcDragKind.getState();
  if (cur.kind !== kind || cur.sessionId !== sessionId) useMcDragKind.setState({ kind, sessionId });
}

/**
 * Begin: published on the next frame, because changing the DOM inside dragstart (drop zones appearing,
 * the source card dimming) can cancel the drag in Chromium and would end up in the drag image.
 * End: published at once. `publish` always reads the current drags, so the order never matters.
 */
function sync(immediate: boolean) {
  if (immediate || typeof requestAnimationFrame !== "function") publish();
  else if (!queued) {
    queued = true;
    requestAnimationFrame(publish);
  }
}

export function beginSessionDrag(d: SessionDrag): void {
  session = d;
  sync(false);
}
export function endSessionDrag(): void {
  session = null;
  sync(true);
}
export function currentSessionDrag(): SessionDrag | null {
  return session;
}

export function beginLaneDrag(d: LaneDrag): void {
  lane = d;
  sync(false);
}
export function endLaneDrag(): void {
  lane = null;
  sync(true);
}
export function currentLaneDrag(): LaneDrag | null {
  return lane;
}

export function beginTaskDrag(d: TaskDrag): void {
  task = d;
  sync(false);
}
export function endTaskDrag(): void {
  task = null;
  sync(true);
}
export function currentTaskDrag(): TaskDrag | null {
  return task;
}

/** Clears every drag (drop / dragend fallback: a dragged element that re-mounted never gets dragend). */
export function endAllMcDrags(): void {
  session = null;
  lane = null;
  task = null;
  sync(true);
}

/** True when this drag event carries `mime` (types are readable during dragover, payloads are not). */
export function dragHas(e: { dataTransfer: DataTransfer | null }, mime: string): boolean {
  const types = e.dataTransfer?.types;
  return !!types && Array.from(types).includes(mime);
}
