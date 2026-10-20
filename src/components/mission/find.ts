// Mission Control find (Ctrl/⌘+F), pure (unit-tested): agents by name, role, lane and branch; mission tasks by
// text and @owner. Every word of the query must match (case-insensitive); "@x" matches an owner / name slug.

import { t as tr } from "../../i18n";
import { slugify, type TaskState } from "../../lib/missionDoc";
import type { SessionId } from "../../lib/types";

export interface FindAgent {
  id: SessionId;
  name: string;
  role: string | null;
  lane: string;
  branch: string | null;
}

export interface FindTask {
  line: number;
  text: string;
  owners: string[];
  state: TaskState;
}

export type FindHit =
  | { kind: "agent"; key: string; id: SessionId; label: string; detail: string }
  | { kind: "task"; key: string; line: number; label: string; detail: string; state: TaskState };

function terms(q: string): string[] {
  return q.trim().toLowerCase().split(/\s+/).filter(Boolean);
}

function agentText(a: FindAgent): string {
  return [a.name, a.role ?? "", a.lane, a.branch ?? "", `@${slugify(a.name)}`].join(" ").toLowerCase();
}

function taskText(t: FindTask): string {
  return [t.text, t.state, ...t.owners.map((o) => `@${o}`)].join(" ").toLowerCase();
}

/** Matches for `query`: agents first (names that start with the first word lead), then tasks in file order. */
export function findHits(query: string, agents: readonly FindAgent[], tasks: readonly FindTask[]): FindHit[] {
  const ts = terms(query);
  if (!ts.length) return [];
  const ok = (hay: string) => ts.every((t) => hay.includes(t));
  const head = ts[0].replace(/^@/, "");
  const found = agents
    .map((a, i) => ({ a, i }))
    .filter(({ a }) => ok(agentText(a)))
    .sort((x, y) => Number(!x.a.name.toLowerCase().startsWith(head)) - Number(!y.a.name.toLowerCase().startsWith(head)) || x.i - y.i)
    .map(
      ({ a }): FindHit => ({
        kind: "agent",
        key: `a:${a.id}`,
        id: a.id,
        label: a.name,
        detail: [a.role, a.lane, a.branch ? `⎇ ${a.branch}` : null].filter(Boolean).join(" · "),
      }),
    );
  for (const t of tasks)
    if (ok(taskText(t)))
      found.push({ kind: "task", key: `t:${t.line}`, line: t.line, label: t.text, state: t.state, detail: [tr("mc.find.taskState", { state: t.state }), ...t.owners.map((o) => `@${o}`)].join(" · ") });
  return found;
}

/** Next index when stepping through `n` hits (wraps; -1 when there are none). */
export function stepHit(i: number, n: number, dir: 1 | -1): number {
  if (n <= 0) return -1;
  if (i < 0) return dir > 0 ? 0 : n - 1;
  return (i + dir + n) % n;
}
