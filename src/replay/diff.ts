// Mission replay: successive parsed mission files → `goal` / `task` events. Pure and node-safe.
//
// Tasks have no ids in mission.md, so they are matched by their (scrubbed, whitespace-normalized) text;
// repeated texts are told apart by occurrence. A task whose text changed while staying on the same
// line is reported as a rename (`was`), so the replay's task list doesn't flicker remove + add.

import type { MissionDoc } from "../lib/missionDoc";
import { scrubText, TEXT_MAX, type ReplayEvent, type ReplayTaskSnap } from "./events";

/** A task as recorded (scrubbed text) plus its line, used only for rename pairing. */
export interface LineTask extends ReplayTaskSnap {
  line: number;
}

export interface MissionSnap {
  goal: string | null;
  tasks: LineTask[];
}

export const EMPTY_SNAP: MissionSnap = { goal: null, tasks: [] };

/** Scrubbed view of a parsed mission file (null doc = no file = empty board). */
export function snapMission(doc: MissionDoc | null | undefined): MissionSnap {
  if (!doc) return EMPTY_SNAP;
  const goal = doc.goal ? scrubText(doc.goal, TEXT_MAX) || null : null;
  const tasks: LineTask[] = [];
  for (const t of doc.tasks) {
    const text = scrubText(t.text, TEXT_MAX);
    if (!text) continue;
    tasks.push({ text, s: t.state, o: t.owners.slice(0, 8).map((o) => o.slice(0, 40)), line: t.line });
  }
  return { goal, tasks };
}

export function plainTasks(snap: MissionSnap): ReplayTaskSnap[] {
  return snap.tasks.map(({ text, s, o }) => ({ text, s, o }));
}

const norm = (s: string) => s.replace(/\s+/g, " ").trim().toLowerCase();

function keyed(tasks: readonly LineTask[]): Map<string, LineTask> {
  const seen = new Map<string, number>();
  const out = new Map<string, LineTask>();
  for (const t of tasks) {
    const base = norm(t.text);
    const n = (seen.get(base) ?? 0) + 1;
    seen.set(base, n);
    out.set(n === 1 ? base : `${base}#${n}`, t);
  }
  return out;
}

const sameOwners = (a: readonly string[], b: readonly string[]) => a.length === b.length && a.every((x, i) => x === b[i]);

/** Events that turn `prev` into `next` at time `t` (goal first, then tasks in file order, then removals). */
export function diffMission(prev: MissionSnap, next: MissionSnap, t: number): ReplayEvent[] {
  const out: ReplayEvent[] = [];
  if (prev.goal !== next.goal) out.push({ t, k: "goal", goal: next.goal });

  const before = keyed(prev.tasks);
  const after = keyed(next.tasks);
  const removed = new Map<number, string>(); // line -> key, for rename pairing
  for (const [k, task] of before) if (!after.has(k)) removed.set(task.line, k);
  const renamedFrom = new Set<string>();

  for (const [k, n] of after) {
    const p = before.get(k);
    if (p) {
      if (p.s !== n.s || !sameOwners(p.o, n.o)) out.push({ t, k: "task", text: n.text, s: n.s, o: n.o });
      continue;
    }
    const oldKey = removed.get(n.line);
    const old = oldKey !== undefined ? before.get(oldKey) : undefined;
    if (oldKey !== undefined && old && !renamedFrom.has(oldKey)) {
      renamedFrom.add(oldKey);
      out.push({ t, k: "task", text: n.text, s: n.s, o: n.o, was: old.text });
    } else out.push({ t, k: "task", text: n.text, s: n.s, o: n.o });
  }
  for (const [k, p] of before) if (!after.has(k) && !renamedFrom.has(k)) out.push({ t, k: "task", text: p.text, s: "gone", o: [] });
  return out;
}
