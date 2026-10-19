// Mission task edits shared by the board view, the agent panel and the selection bar: every one is a pure line
// edit (lib/missionDoc.ts) through the conflict-checked write path (store/missionDoc.ts editMission), with the
// line + text the UI saw as the expectation (a task that moved meanwhile is refused, never mis-edited).

import { t as translate } from "../../i18n";
import { addTaskOwner, changeTaskState, nextState, ownerMatches, setTaskOwners, slugify, teamSlugs, type Task, type TaskState, type TeamMember } from "../../lib/missionDoc";
import { editMission } from "../../store/missionDoc";
import type { MenuItem } from "../ui/Menu";

export const BOX: Record<TaskState, string> = { todo: "[ ]", doing: "[~]", done: "[x]", blocked: "[!]" };
/** A task state as a word in the current UI language (getters: never frozen at import time). */
export const STATE_WORD: Readonly<Record<TaskState, string>> = {
  get todo() {
    return translate("mcNode.state.todo");
  },
  get doing() {
    return translate("mcNode.state.doing");
  },
  get done() {
    return translate("mcNode.state.done");
  },
  get blocked() {
    return translate("mcNode.state.blocked");
  },
};

const short = (s: string) => (s.length > 48 ? `${s.slice(0, 47)}…` : s);
const expect = (t: Task) => ({ expect: { line: t.line, text: t.text } });

export function setTaskStateOp(dir: string, t: Task, state: TaskState): Promise<boolean> {
  if (state === t.state) return Promise.resolve(true);
  return editMission(dir, (text) => changeTaskState(text, t.line, state), expect(t));
}

/** Click on a task box: todo → doing → done → todo (blocked → todo). */
export function cycleTask(dir: string, t: Task): Promise<boolean> {
  return setTaskStateOp(dir, t, nextState(t.state));
}

/** The task's owners become exactly `slug` (null = unassigned), with Undo. */
export function reassignTask(dir: string, t: Task, slug: string | null, who?: string): Promise<boolean> {
  const owners = slug ? [slug] : [];
  if (owners.length === t.owners.length && owners.every((o, i) => o === t.owners[i])) return Promise.resolve(true);
  return editMission(dir, (text) => setTaskOwners(text, t.line, owners), {
    ...expect(t),
    undo: slug ? translate("mcNode.toast.reassigned", { task: short(t.text), who: who ?? `@${slug}` }) : translate("mcNode.toast.unassigned", { task: short(t.text) }),
  });
}

/** Adds every slug as an owner (one write), with Undo. */
export function addOwners(dir: string, t: Task, slugs: readonly string[], undo: string): Promise<boolean> {
  const add = slugs.filter((s) => s && !t.owners.includes(s));
  if (!add.length) return Promise.resolve(true);
  return editMission(
    dir,
    (text) => {
      let cur: string | null = text;
      for (const s of add) cur = cur === null ? null : addTaskOwner(cur, t.line, s);
      return cur;
    },
    { ...expect(t), undo },
  );
}

/** Context menu of a task: any state, assign to (one owner) / add owner, unassign. */
export function taskMenuItems(dir: string, t: Task, team: readonly TeamMember[]): MenuItem[] {
  const slugs = teamSlugs(team);
  const owners: MenuItem[] = slugs.map((s) => {
    const who = team.filter((m) => ownerMatches(s, m));
    const named = who.find((m) => slugify(m.name) === s);
    return { label: `@${s}`, hint: named ? undefined : translate("mcNode.menu.every", { role: s, count: who.length }), checked: t.owners.length === 1 && t.owners[0] === s, onSelect: () => void reassignTask(dir, t, s, named?.name) };
  });
  return [
    ...(["todo", "doing", "done", "blocked"] as const).map((s) => ({ label: `${BOX[s]} ${STATE_WORD[s]}`, checked: t.state === s, onSelect: () => void setTaskStateOp(dir, t, s) })),
    "separator",
    { label: translate("mcNode.menu.assignTo"), children: owners.length ? owners : [{ label: translate("mcNode.menu.noTeammates"), disabled: true }] },
    { label: translate("mcNode.menu.unassign"), disabled: t.owners.length === 0, onSelect: () => void reassignTask(dir, t, null) },
  ];
}
