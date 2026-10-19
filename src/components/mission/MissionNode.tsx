// Mission node: the shared mission board at the top of Mission Control, rendered live from
// `<projectDir>/.gridkeeper/mission.md` (format: lib/missionDoc.ts). Goal, progress, tasks grouped
// doing → todo → blocked → done with owner chips, managed directly on the board:
// - drag a task onto another state group (blocked asks for an optional reason inline) or between tasks
//   (reorders the file: order = priority); drag it onto an owner chip to reassign it, or onto a session card
//   (the cards' drop handler calls actions/missionAssign) to add that agent as an owner;
// - "+ add task" at the bottom (Tab completes @owners), double-click / F2 to edit a task in place,
//   Del deletes (toast with Undo), right-click / ⋯ for state, assign, unassign, edit, move, copy, delete;
// - filters (all / the agent selected in Mission Control / unassigned / blocked + text), and a collapse to a
//   one-line summary, remembered per project;
// - keyboard on a focused task row: ↑/↓ move between rows, Space cycles the state, Alt+↑/↓ reorders,
//   Enter/F2 edits, Del deletes, n focuses quick add. Keys from task rows never reach Mission Control's
//   card shortcuts (stopPropagation), except Esc / Ctrl combos.
// Every write is a pure line edit (lib/missionDoc.ts) applied with the conflict-checked write path
// (store/missionDoc.ts editMission). Plus "edit file…" (raw editor), "open folder" and "brief team…".
// Without a project folder it explains why; without a mission file it offers a small "set a mission" form.

import { fileManagerName } from "../../lib/platform";
import { useEffect, useLayoutEffect, useMemo, useReducer, useRef, useState, type CSSProperties, type DragEvent, type KeyboardEvent, type ReactNode, type RefObject } from "react";
import { gatherBrief, sendBrief, type BriefRecipient, type BriefSkip } from "../../actions/missionBrief";
import { notify } from "../../actions/notify";
import {
  addTask,
  addTaskOwner,
  changeTaskState,
  deleteTask,
  editTaskText,
  matchesFilter,
  newMissionText,
  nextState,
  ownerCompletion,
  ownerMatches,
  ownersFor,
  planMove,
  progress,
  setTaskOwners,
  slugify,
  STATE_ORDER,
  taskBlockEnd,
  taskSource,
  teamSlugs,
  type MissionDoc,
  type Task,
  type TaskFilter,
  type TaskState,
  type TeamMember,
} from "../../lib/missionDoc";
import type { MissionFile, SessionId } from "../../lib/types";
import { useApp } from "../../store/appStore";
import { dirKey, editMission, reloadMission, useMissionDocs, writeMission, type EditOptions, type MissionEntry } from "../../store/missionDoc";
import { confirmDialog } from "../../store/uiStore";
import { Button } from "../ui/Button";
import { anchorOf, type MenuItem, type MenuOpenEvent } from "../ui/Menu";
import { Modal } from "../ui/Modal";
import { copyText, pickFolder, revealPath } from "../util/pick";
import { shortPath } from "../util/text";
import { beginTaskDrag, endTaskDrag } from "./mcDrag";
import { RoleTag, roleStyle } from "./RoleTag";
import "../../styles/missionBoard.css";

type MenuEvent = MenuOpenEvent;

export const BOX_TEXT: Record<TaskState, string> = { todo: "[ ]", doing: "[~]", done: "[x]", blocked: "[!]" };
const STATE_TEXT: Record<TaskState, string> = { todo: "todo", doing: "doing", done: "done", blocked: "blocked" };
/** Drag payload type of a board task (JSON { line, text }); session cards accept it too. */
export const TASK_MIME = "application/x-gridkeeper-task";

export interface MissionNodeProps {
  workspaceId: string | null;
  projectDir: string | null;
  mission: MissionEntry;
  /** Process sessions of the workspace (name + role), for owner chips and briefs. */
  team: TeamMember[];
  onSelectSession: (id: SessionId) => void;
  openMenu: (e: MenuEvent, items: MenuItem[]) => void;
  /** The card selected in Mission Control: the board's "mine" filter shows the tasks it owns. */
  selectedSessionId?: SessionId | null;
}

export function MissionNode({ workspaceId, projectDir, mission, team, onSelectSession, openMenu, selectedSessionId = null }: MissionNodeProps) {
  const [dialog, setDialog] = useState<"edit" | "brief" | null>(null);
  const root = useRef<HTMLDivElement>(null);
  // A closed dialog would hand focus back to the terminal under the overlay: keep it in Mission Control.
  const hadDialog = useRef(false);
  useLayoutEffect(() => {
    if (dialog) hadDialog.current = true;
    else if (hadDialog.current) {
      hadDialog.current = false;
      root.current?.focus({ preventScroll: true });
    }
  }, [dialog]);

  if (!projectDir)
    return (
      <div data-node="mission" className="mc-node mb-node is-placeholder" ref={root} tabIndex={-1}>
        <span className="mc-node-label">mission</span>
        <div>
          A mission needs a project folder: the shared task board lives in <span className="mc-strong">&lt;folder&gt;\.gridkeeper\mission.md</span>, where every
          agent can read and edit it.
        </div>
        {workspaceId && (
          <div className="mc-empty-actions">
            <button
              type="button"
              className="mc-btn is-primary"
              onClick={async () => {
                const dir = await pickFolder("Choose project folder", null);
                if (dir) useApp.getState().updateWorkspace(workspaceId, { projectDir: dir });
              }}
            >
              choose project folder…
            </button>
          </div>
        )}
      </div>
    );

  const { file, doc } = mission;
  const label = <span className="mc-node-label">mission · shared task board</span>;

  if (!file)
    return (
      <div data-node="mission" className="mc-node mb-node is-placeholder" ref={root} tabIndex={-1}>
        {label}
        {mission.error ? (
          <>
            <div className="mb-error">could not read the mission file: {mission.error}</div>
            <div className="mc-empty-actions">
              <button type="button" className="mc-btn" onClick={() => void reloadMission(projectDir)}>
                retry
              </button>
            </div>
          </>
        ) : (
          <div className="mc-empty">reading mission file…</div>
        )}
      </div>
    );

  if (!file.exists || !doc)
    return (
      <div data-node="mission" className="mc-node mb-node" ref={root} tabIndex={-1}>
        {label}
        <SetMission projectDir={projectDir} path={file.path} />
      </div>
    );

  return (
    <div data-node="mission" className="mc-node mb-node is-solid" ref={root} tabIndex={-1}>
      {label}
      <Board
        key={projectDir}
        projectDir={projectDir}
        file={file}
        doc={doc}
        team={team}
        error={mission.error}
        selectedSessionId={selectedSessionId}
        onSelectSession={onSelectSession}
        openMenu={openMenu}
        onEdit={() => setDialog("edit")}
        onBrief={() => setDialog("brief")}
      />
      {dialog === "edit" && <EditMissionDialog projectDir={projectDir} file={file} onClose={() => setDialog(null)} />}
      {dialog === "brief" && <BriefDialog missionPath={file.path} team={team} onClose={() => setDialog(null)} />}
    </div>
  );
}

// ---- board -------------------------------------------------------------------------------------

/** Where a dragged task would land: a state section (line null = anywhere in it) or before / after a task. */
interface DropAt {
  state: TaskState;
  line: number | null;
  pos: "before" | "after";
}

/** A pending block (menu, drag or keyboard) waiting for its optional reason. */
interface BlockAsk {
  line: number;
  text: string;
  target: { line: number; pos: "before" | "after" } | null;
}

const FILTERS: readonly TaskFilter[] = ["all", "mine", "unassigned", "blocked"];

const collapseKey = (dir: string) => `gridkeeper.missionBoard.collapsed:${dirKey(dir)}`;
function readCollapsed(dir: string): boolean {
  try {
    return localStorage.getItem(collapseKey(dir)) === "1";
  } catch {
    return false;
  }
}
function writeCollapsed(dir: string, on: boolean) {
  try {
    if (on) localStorage.setItem(collapseKey(dir), "1");
    else localStorage.removeItem(collapseKey(dir));
  } catch {
    /* storage unavailable: the board just doesn't remember */
  }
}

const short = (s: string) => (s.length > 48 ? `${s.slice(0, 47)}…` : s);
const sameDrop = (a: DropAt | null, b: DropAt | null) => a === b || (!!a && !!b && a.state === b.state && a.line === b.line && a.pos === b.pos);

/** Insertion line for "before / after task `line`" in `text` (after = past its notes). */
function targetLine(text: string, target: { line: number; pos: "before" | "after" }): number {
  return target.pos === "before" ? target.line : (taskBlockEnd(text, target.line) ?? target.line + 1);
}

function Board({
  projectDir,
  file,
  doc,
  team,
  error,
  selectedSessionId,
  onSelectSession,
  openMenu,
  onEdit,
  onBrief,
}: {
  projectDir: string;
  file: MissionFile;
  doc: MissionDoc;
  team: TeamMember[];
  error: string | null;
  selectedSessionId: SessionId | null;
  onSelectSession: (id: SessionId) => void;
  openMenu: (e: MenuEvent, items: MenuItem[]) => void;
  onEdit: () => void;
  onBrief: () => void;
}) {
  const [showDone, setShowDone] = useState(false);
  const [writing, setWriting] = useState(false);
  const [collapsed, setCollapsed] = useState(() => readCollapsed(projectDir));
  const [filter, setFilter] = useState<TaskFilter>("all");
  const [query, setQuery] = useState("");
  const [focusLine, setFocusLine] = useState<number | null>(null);
  const [editing, setEditing] = useState<number | null>(null);
  const [ask, setAsk] = useState<BlockAsk | null>(null);
  const [dragLine, setDragLine] = useState<number | null>(null);
  const dragRef = useRef<number | null>(null);
  const [drop, setDropState] = useState<DropAt | null>(null);
  const [chipDrop, setChipDrop] = useState<string | null>(null);
  const wrap = useRef<HTMLDivElement>(null);
  const addRef = useRef<HTMLInputElement>(null);
  const wantFocus = useRef(false);
  const [, bumpFocus] = useReducer((n: number) => n + 1, 0);

  const p = progress(doc.tasks);
  const unassigned = doc.tasks.filter((t) => t.state !== "done" && ownersFor(t, team).length === 0).length;
  const slugs = useMemo(() => teamSlugs(team), [team]);
  const member = (selectedSessionId && team.find((m) => m.id === selectedSessionId)) || null;
  const activeFilter: TaskFilter = filter === "mine" && !member ? "all" : filter;
  const filtering = activeFilter !== "all" || query.trim() !== "";
  const dragging = dragLine !== null;

  const byState = useMemo(() => {
    const m: Record<TaskState, Task[]> = { doing: [], todo: [], blocked: [], done: [] };
    for (const t of doc.tasks) if (matchesFilter(t, activeFilter, query, team, member)) m[t.state].push(t);
    return m;
  }, [doc.tasks, activeFilter, query, team, member]);
  const doneOpen = showDone || (filtering && byState.done.length > 0);
  /** Rows in display order (arrow-key navigation). */
  const order = useMemo(() => STATE_ORDER.flatMap((s) => (s === "done" && !doneOpen ? [] : byState[s])), [byState, doneOpen]);
  const tabLine = order.some((t) => t.line === focusLine) ? focusLine : (order[0]?.line ?? null);

  // Keyboard-driven changes re-render rows under new keys: put focus back on the row we meant.
  useLayoutEffect(() => {
    if (!wantFocus.current || focusLine === null) return;
    wantFocus.current = false;
    const el = wrap.current?.querySelector<HTMLElement>(`[data-line="${focusLine}"]`);
    if (!el) return;
    el.focus({ preventScroll: true });
    el.scrollIntoView?.({ block: "nearest" });
  });

  const focusRow = (line: number | null) => {
    if (line === null) return;
    setFocusLine(line);
    wantFocus.current = true;
    bumpFocus(); // render (and run the focus effect) even when focusLine is unchanged
  };

  /** Run one conflict-checked edit; the board is read-only while it is in flight. */
  const run = async (edit: (text: string) => string | null, opts?: EditOptions): Promise<boolean> => {
    if (writing) return false;
    setWriting(true);
    try {
      return await editMission(projectDir, edit, opts);
    } finally {
      setWriting(false);
    }
  };
  const expect = (t: Task) => ({ line: t.line, text: t.text });

  // ---- task operations ----
  const setState = async (t: Task, state: TaskState, opts: { reason?: string; refocus?: boolean } = {}) => {
    if (state === "blocked" && opts.reason === undefined && t.state !== "blocked") {
      setAsk({ line: t.line, text: t.text, target: null });
      return;
    }
    if (state === t.state && opts.reason === undefined) return;
    const ok = await run((text) => changeTaskState(text, t.line, state, opts.reason), { expect: expect(t) });
    if (ok && opts.refocus) focusRow(t.line);
  };

  const move = async (t: Task, target: { line: number; pos: "before" | "after" } | null, state?: TaskState, reason?: string, refocus = false) => {
    let line = t.line;
    const ok = await run(
      (text) => {
        const r = target ? planMove(text, t.line, targetLine(text, target)) : { text, line: t.line };
        if (!r) return null;
        line = r.line;
        return state && (state !== t.state || reason !== undefined) ? changeTaskState(r.text, r.line, state, reason) : r.text;
      },
      { expect: expect(t) },
    );
    if (ok && refocus) focusRow(line);
  };

  const reorder = (t: Task, up: boolean) => {
    const sib = byState[t.state];
    const i = sib.findIndex((x) => x.line === t.line);
    const other = sib[up ? i - 1 : i + 1];
    if (!other) return;
    void move(t, { line: other.line, pos: up ? "before" : "after" }, undefined, undefined, true);
  };

  const remove = async (t: Task, refocus = false) => {
    const i = order.findIndex((x) => x.line === t.line);
    const next = order[i + 1] ?? order[i - 1] ?? null;
    const size = (taskBlockEnd(file.text, t.line) ?? t.line + 1) - t.line;
    const ok = await run((text) => deleteTask(text, t.line), { expect: expect(t), undo: `Deleted “${short(t.text)}”` });
    if (ok && refocus && next) focusRow(next.line > t.line ? next.line - size : next.line);
  };

  const saveText = async (t: Task, value: string, refocus: boolean) => {
    setEditing(null);
    if (refocus) focusRow(t.line); // the line stays the same: only its text changes
    if (!value.trim()) return;
    await run((text) => editTaskText(text, t.line, value), { expect: expect(t) });
  };

  const toggleOwner = (t: Task, slug: string) =>
    void run((text) => (t.owners.includes(slug) ? setTaskOwners(text, t.line, t.owners.filter((o) => o !== slug)) : addTaskOwner(text, t.line, slug)), {
      expect: expect(t),
    });

  const reassign = (t: Task, owner: string) => {
    if (t.owners.length === 1 && t.owners[0] === owner) return;
    void run((text) => setTaskOwners(text, t.line, [owner]), { expect: expect(t), undo: `Reassigned “${short(t.text)}” to @${owner}` });
  };

  const startEdit = (t: Task) => {
    setFocusLine(t.line);
    setEditing(t.line);
  };

  const confirmBlock = async (reason: string) => {
    const a = ask;
    setAsk(null);
    const t = a && doc.tasks.find((x) => x.line === a.line && x.text === a.text);
    if (!t) return;
    await move(t, a.target, "blocked", reason.trim() || undefined, true);
  };
  const cancelBlock = () => {
    const line = ask?.line ?? null;
    setAsk(null);
    focusRow(line);
  };

  const taskMenu = (t: Task): MenuItem[] => {
    const sib = byState[t.state];
    const i = sib.findIndex((x) => x.line === t.line);
    const owners: MenuItem[] = slugs.map((s) => {
      const who = team.filter((m) => ownerMatches(s, m));
      const isName = who.some((m) => slugify(m.name) === s);
      return {
        label: `@${s}`,
        hint: isName ? who.find((m) => slugify(m.name) === s)!.name : `every ${s} (${who.length})`,
        checked: t.owners.includes(s),
        disabled: writing,
        onSelect: () => toggleOwner(t, s),
      };
    });
    return [
      ...(["todo", "doing", "done", "blocked"] as const).map((s) => ({
        label: `${BOX_TEXT[s]} ${STATE_TEXT[s]}${s === "blocked" && t.state !== "blocked" ? "…" : ""}`,
        checked: t.state === s,
        disabled: writing,
        onSelect: () => void setState(t, s),
      })),
      "separator",
      { label: "assign to", children: owners.length ? owners : [{ label: "no teammates in this workspace", disabled: true }] },
      { label: "unassign", disabled: writing || t.owners.length === 0, onSelect: () => void run((text) => setTaskOwners(text, t.line, []), { expect: expect(t) }) },
      "separator",
      { label: "edit text", hint: "F2", disabled: writing, onSelect: () => startEdit(t) },
      { label: "move up", hint: "Alt+↑", disabled: writing || i <= 0, onSelect: () => reorder(t, true) },
      { label: "move down", hint: "Alt+↓", disabled: writing || i < 0 || i >= sib.length - 1, onSelect: () => reorder(t, false) },
      { label: "copy line", onSelect: () => void copyText(taskSource(file.text, t.line) ?? t.text, "Task line copied") },
      "separator",
      { label: "delete", hint: "Del", danger: true, disabled: writing, onSelect: () => void remove(t) },
    ];
  };

  // ---- drag and drop ----
  // The dragged line lives in a ref (set synchronously in dragstart); the visual state follows a frame later,
  // because re-rendering the dragged row inside its own dragstart can cancel the drag in Chromium.
  const isOurDrag = (e: DragEvent) => dragRef.current !== null && e.dataTransfer.types.includes(TASK_MIME);
  const setDrop = (d: DropAt | null) => setDropState((cur) => (sameDrop(cur, d) ? cur : d));
  const endDrag = () => {
    endTaskDrag();
    dragRef.current = null;
    setDragLine(null);
    setDropState(null);
    setChipDrop(null);
  };
  const finishDrop = (target: DropAt) => {
    const t = doc.tasks.find((x) => x.line === dragRef.current);
    endDrag();
    if (!t) return;
    const pos = target.line !== null && target.line !== t.line ? { line: target.line, pos: target.pos } : null;
    const state = target.state !== t.state ? target.state : undefined;
    if (!pos && !state) return;
    if (state === "blocked") {
      setAsk({ line: t.line, text: t.text, target: pos });
      return;
    }
    void move(t, pos, state);
  };
  const dropOnOwner = (owner: string) => {
    const t = doc.tasks.find((x) => x.line === dragRef.current);
    endDrag();
    if (t) reassign(t, owner);
  };
  const sectionDrag = (state: TaskState) => ({
    onDragOver: (e: DragEvent) => {
      if (!isOurDrag(e)) return;
      e.preventDefault();
      e.dataTransfer.dropEffect = "move";
      setDrop({ state, line: null, pos: "after" });
    },
    onDrop: (e: DragEvent) => {
      if (!isOurDrag(e)) return;
      e.preventDefault();
      finishDrop({ state, line: null, pos: "after" });
    },
  });

  const rowCtx: RowCtx = {
    team,
    slugs,
    writing,
    dragging,
    tabLine,
    editing,
    drop,
    dragLine,
    chipDrop,
    onSelectSession,
    onCycle: (t) => void setState(t, nextState(t.state)),
    onMenu: (t, e) => openMenu(e, taskMenu(t)),
    onStartEdit: startEdit,
    onSaveText: (t, v, key) => void saveText(t, v, key),
    onCancelEdit: (t, key) => {
      setEditing(null);
      if (key) focusRow(t.line);
    },
    onFocusRow: (t) => setFocusLine(t.line),
    onDragStart: (t, e) => {
      e.dataTransfer.setData(TASK_MIME, JSON.stringify({ line: t.line, text: t.text }));
      e.dataTransfer.effectAllowed = "all";
      beginTaskDrag({ line: t.line, text: t.text });
      dragRef.current = t.line;
      requestAnimationFrame(() => {
        if (dragRef.current === t.line) setDragLine(t.line);
      });
      setAsk(null);
    },
    onDragEnd: endDrag,
    onRowDragOver: (t, e) => {
      if (!isOurDrag(e)) return;
      e.preventDefault();
      e.stopPropagation();
      e.dataTransfer.dropEffect = "move";
      const r = e.currentTarget.getBoundingClientRect();
      setDrop({ state: t.state, line: t.line, pos: e.clientY < r.top + r.height / 2 ? "before" : "after" });
    },
    onRowDrop: (t, e) => {
      if (!isOurDrag(e)) return;
      e.preventDefault();
      e.stopPropagation();
      const r = e.currentTarget.getBoundingClientRect();
      finishDrop({ state: t.state, line: t.line, pos: e.clientY < r.top + r.height / 2 ? "before" : "after" });
    },
    onChipDragOver: (key, e) => {
      if (!isOurDrag(e)) return;
      e.preventDefault();
      e.stopPropagation();
      e.dataTransfer.dropEffect = "move";
      setDrop(null);
      if (chipDrop !== key) setChipDrop(key);
    },
    onChipDragLeave: (key) => setChipDrop((cur) => (cur === key ? null : cur)),
    onChipDrop: (owner, e) => {
      if (!isOurDrag(e)) return;
      e.preventDefault();
      e.stopPropagation();
      dropOnOwner(owner);
    },
  };

  // ---- keyboard (task rows) ----
  const onKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    const el = e.target as HTMLElement;
    if (el.tagName === "INPUT" || el.tagName === "TEXTAREA" || el.tagName === "SELECT") return;
    if (e.key === "Escape" || e.ctrlKey || e.metaKey) return; // Mission Control: close, app shortcuts
    const quickAdd = (e.key === "n" || e.key === "N") && !e.altKey && !e.shiftKey;
    const rowEl = el.closest<HTMLElement>("[data-line]");
    if (!rowEl) {
      if (quickAdd && el.closest(".mb-board")) {
        e.preventDefault();
        e.stopPropagation();
        addRef.current?.focus();
      }
      return;
    }
    // Every other key from a task row belongs to the board: Mission Control would act on the selected card.
    e.stopPropagation();
    const t = doc.tasks.find((x) => x.line === Number(rowEl.dataset.line));
    if (!t || editing !== null) return;
    const onRow = el === rowEl;
    const i = order.findIndex((x) => x.line === t.line);
    const go = (j: number) => focusRow(order[Math.max(0, Math.min(order.length - 1, j))]?.line ?? null);
    const act = (fn: () => void) => {
      e.preventDefault();
      fn();
    };
    if (e.key === "ArrowUp" || e.key === "ArrowDown") act(() => (e.altKey ? !writing && reorder(t, e.key === "ArrowUp") : go(i + (e.key === "ArrowUp" ? -1 : 1))));
    else if (e.key === "Home") act(() => go(0));
    else if (e.key === "End") act(() => go(order.length - 1));
    else if (quickAdd) act(() => addRef.current?.focus());
    else if (!onRow) return;
    else if (e.key === " ") act(() => !writing && void setState(t, nextState(t.state), { refocus: true }));
    else if (e.key === "Enter" || e.key === "F2") act(() => startEdit(t));
    else if (e.key === "Delete") act(() => !writing && void remove(t, true));
    else if (e.key === "ContextMenu" || (e.shiftKey && e.key === "F10")) {
      act(() => {
        const r = rowEl.getBoundingClientRect();
        openMenu({ clientX: r.left + 24, clientY: r.bottom }, taskMenu(t));
      });
    }
  };

  const toggleCollapsed = () => {
    const v = !collapsed;
    setCollapsed(v);
    writeCollapsed(projectDir, v);
  };

  const progressBar = (
    <span className="mc-progress" role="progressbar" aria-valuemin={0} aria-valuemax={p.total} aria-valuenow={p.done} aria-label={`${p.done} of ${p.total} tasks done`}>
      <span style={{ width: `${Math.round(p.fraction * 100)}%` } as CSSProperties} />
    </span>
  );
  const stats = (
    <span className="mc-lane-stats">
      {p.doing > 0 && <span className="is-working">{p.doing} doing</span>}
      {p.blocked > 0 && <span className="is-err">{p.blocked} blocked</span>}
      {unassigned > 0 && <span className="is-needs">{unassigned} unassigned</span>}
    </span>
  );
  const goal = (
    <span className="mc-strong mb-goal-text" title={doc.goal ?? undefined}>
      {doc.goal ?? <span className="mb-muted">no goal — add a “# Mission: …” heading</span>}
    </span>
  );
  const collapseBtn = (
    <button
      type="button"
      className="mb-collapse"
      aria-expanded={!collapsed}
      title={collapsed ? "Show the task board" : "Collapse the board to one line (remembered for this project)"}
      onClick={toggleCollapsed}
    >
      {collapsed ? "▸" : "▾"}
    </button>
  );

  if (collapsed)
    return (
      <div className="mb-board is-collapsed" ref={wrap}>
        <span className="mc-node-label mc-node-label-right">{p.total ? `${p.done}/${p.total} done` : "no tasks yet"}</span>
        <div className="mb-summary mc-micro">
          {collapseBtn}
          {goal}
          {progressBar}
          <span>
            {p.done}/{p.total}
          </span>
          {stats}
        </div>
      </div>
    );

  const counts: Record<TaskFilter, number | null> = {
    all: null,
    mine: member ? doc.tasks.filter((t) => matchesFilter(t, "mine", "", team, member)).length : null,
    unassigned: unassigned,
    blocked: p.blocked,
  };
  const filterLabel = (f: TaskFilter) => (f === "mine" ? (member ? `@${slugify(member.name) || member.name}` : "selected agent") : f);
  const shown = STATE_ORDER.reduce((n, s) => n + byState[s].length, 0);

  return (
    <div
      className={`mb-board${dragging ? " is-dragging" : ""}`}
      ref={wrap}
      onKeyDown={onKeyDown}
      onDragLeave={(e) => {
        if (dragging && !wrap.current?.contains(e.relatedTarget as Node | null)) setDropState(null);
      }}
    >
      <span className="mc-node-label mc-node-label-right">{p.total ? `${p.done}/${p.total} done` : "no tasks yet"}</span>
      <div className="mb-goal">
        {collapseBtn}
        <span className="mb-goal-label mc-micro">goal</span>
        {goal}
      </div>
      {doc.context && (
        <div className="mb-context" title={doc.context}>
          {doc.context}
        </div>
      )}
      <div className="mc-lane-head mc-micro mb-progress">
        {progressBar}
        <span>
          {p.done}/{p.total} done
        </span>
        {stats}
      </div>

      {p.total > 0 && (
        <div className="mb-filters mc-micro" role="group" aria-label="Filter tasks">
          {FILTERS.map((f) => (
            <button
              key={f}
              type="button"
              className={`mb-filter${activeFilter === f ? " is-on" : ""}`}
              aria-pressed={activeFilter === f}
              disabled={f === "mine" && !member}
              title={
                f === "mine"
                  ? member
                    ? `Tasks owned by ${member.name} (the card selected in Mission Control)`
                    : "Select an agent's card to see its tasks"
                  : f === "unassigned"
                    ? "Open tasks no teammate owns"
                    : f === "blocked"
                      ? "Blocked tasks"
                      : "Every task"
              }
              onClick={() => setFilter(f)}
            >
              {filterLabel(f)}
              {counts[f] !== null && <span className="mb-filter-n">{counts[f]}</span>}
            </button>
          ))}
          <input
            className="mb-input mb-search"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Escape" && query) {
                e.preventDefault();
                e.stopPropagation();
                setQuery("");
              }
            }}
            placeholder="filter…"
            spellCheck={false}
            aria-label="Filter tasks by text or @owner"
          />
        </div>
      )}

      {p.total === 0 ? (
        <div className="mc-empty">no tasks yet — add one below, brief the team so the lead splits the mission into “- [ ] task @owner” lines, or edit the file</div>
      ) : (
        <div className="mb-groups">
          {ask && !order.some((t) => t.line === ask.line) && (
            <ul className="mb-tasks">
              <AskReason ask={ask} onConfirm={(r) => void confirmBlock(r)} onCancel={cancelBlock} />
            </ul>
          )}
          {filtering && shown === 0 && !dragging && <div className="mc-empty">no tasks match</div>}
          {STATE_ORDER.map((s) => {
            const list = byState[s];
            const dropHere = drop?.state === s && drop.line === null;
            if (list.length === 0 && !dragging) return null;
            if (s === "done" && !doneOpen)
              return (
                <button
                  key={s}
                  type="button"
                  className={`mb-done-toggle mc-micro${dropHere ? " is-drop" : ""}`}
                  aria-expanded={false}
                  onClick={() => setShowDone(true)}
                  {...sectionDrag(s)}
                >
                  ▸ {list.length} done{dragging ? " — drop to mark done" : ""}
                </button>
              );
            return (
              <div key={s} className={`mb-group is-${s}${dropHere ? " is-drop" : ""}`} {...sectionDrag(s)}>
                {s === "done" && !filtering ? (
                  <button type="button" className="mb-done-toggle mc-micro" aria-expanded onClick={() => setShowDone(false)}>
                    ▾ {list.length} done
                  </button>
                ) : (
                  <div className="mb-group-head mc-micro">
                    {STATE_TEXT[s]} · {list.length}
                  </div>
                )}
                <ul className="mb-tasks">
                  {list.map((t) => (
                    <TaskRow key={t.line} task={t} ctx={rowCtx}>
                      {ask?.line === t.line && <AskReason ask={ask} onConfirm={(r) => void confirmBlock(r)} onCancel={cancelBlock} />}
                    </TaskRow>
                  ))}
                  {list.length === 0 && <li className="mb-drop-empty">drop here → {STATE_TEXT[s]}</li>}
                </ul>
              </div>
            );
          })}
        </div>
      )}

      <QuickAdd
        inputRef={addRef}
        slugs={slugs}
        disabled={writing}
        onAdd={(value) => run((text) => addTask(text, value))}
        onLeave={() => {
          if (tabLine === null) return false;
          focusRow(tabLine);
          return true;
        }}
      />

      {error && <div className="mb-error">last re-read failed: {error}</div>}
      <div className="mc-node-actions mb-actions">
        <span className="mc-path mb-path" title={file.path}>
          {shortPath(file.path, 48)}
        </span>
        <button type="button" className="mc-btn" title="Edit the raw Markdown file (saved with a conflict check)" onClick={onEdit}>
          edit file…
        </button>
        <button type="button" className="mc-btn" title={`Show mission.md in ${fileManagerName()}`} onClick={() => void revealPath(file.path)}>
          open folder
        </button>
        <button
          type="button"
          className="mc-btn is-primary"
          title="Send each running agent one line about the mission file, based on its role (shows every line first; nothing is sent until you press Send)"
          onClick={onBrief}
        >
          brief team…
        </button>
      </div>
    </div>
  );
}

// ---- rows ----------------------------------------------------------------------------------------

interface RowCtx {
  team: TeamMember[];
  slugs: string[];
  writing: boolean;
  dragging: boolean;
  /** The row that takes Tab focus (roving tabindex). */
  tabLine: number | null;
  editing: number | null;
  drop: DropAt | null;
  dragLine: number | null;
  chipDrop: string | null;
  onSelectSession: (id: SessionId) => void;
  onCycle: (t: Task) => void;
  onMenu: (t: Task, e: MenuEvent) => void;
  onStartEdit: (t: Task) => void;
  /** `key`: ended with Enter / Esc (focus goes back to the row), else by blur. */
  onSaveText: (t: Task, value: string, key: boolean) => void;
  onCancelEdit: (t: Task, key: boolean) => void;
  onFocusRow: (t: Task) => void;
  onDragStart: (t: Task, e: DragEvent<HTMLLIElement>) => void;
  onDragEnd: () => void;
  onRowDragOver: (t: Task, e: DragEvent<HTMLLIElement>) => void;
  onRowDrop: (t: Task, e: DragEvent<HTMLLIElement>) => void;
  onChipDragOver: (key: string, e: DragEvent) => void;
  onChipDragLeave: (key: string) => void;
  onChipDrop: (owner: string, e: DragEvent) => void;
}

function TaskRow({ task, ctx, children }: { task: Task; ctx: RowCtx; children?: ReactNode }) {
  const next = nextState(task.state);
  const editing = ctx.editing === task.line;
  const dropPos = ctx.drop && ctx.drop.line === task.line ? ctx.drop.pos : null;
  const cls = [
    "mb-task",
    `is-${task.state}`,
    dropPos ? `is-drop-${dropPos}` : "",
    ctx.dragLine === task.line ? "is-dragged" : "",
    editing ? "is-editing" : "",
  ]
    .filter(Boolean)
    .join(" ");
  return (
    <>
      <li
        className={cls}
        data-line={task.line}
        tabIndex={ctx.tabLine === task.line ? 0 : -1}
        aria-label={`${task.text} — ${STATE_TEXT[task.state]}${task.owners.length ? `, ${task.owners.map((o) => `@${o}`).join(" ")}` : ", unassigned"}`}
        draggable={!editing && !ctx.writing}
        onFocus={(e) => {
          if (e.target === e.currentTarget) ctx.onFocusRow(task);
        }}
        onContextMenu={(e) => {
          e.stopPropagation();
          ctx.onMenu(task, e);
        }}
        onDragStart={(e) => ctx.onDragStart(task, e)}
        onDragEnd={ctx.onDragEnd}
        onDragOver={(e) => ctx.onRowDragOver(task, e)}
        onDrop={(e) => ctx.onRowDrop(task, e)}
      >
        <button
          type="button"
          className="mb-box"
          tabIndex={-1}
          disabled={ctx.writing}
          title={`${STATE_TEXT[task.state]} — click: ${STATE_TEXT[next]} · Space on the row cycles · right-click: any state (blocked…) · drag the row to move it`}
          aria-label={`${task.text}: ${STATE_TEXT[task.state]}. Mark ${STATE_TEXT[next]}`}
          onClick={() => ctx.onCycle(task)}
        >
          {BOX_TEXT[task.state]}
        </button>
        {editing ? (
          <EditText task={task} slugs={ctx.slugs} onSave={(v, key) => ctx.onSaveText(task, v, key)} onCancel={(key) => ctx.onCancelEdit(task, key)} />
        ) : (
          <span className="mb-text" title={`${task.text} — double-click (or F2) to edit`} onDoubleClick={() => !ctx.writing && ctx.onStartEdit(task)}>
            {task.text || <span className="mb-muted">(empty)</span>}
          </span>
        )}
        <span className="mb-owners">
          {task.owners.length === 0 && task.state !== "done" && (
            <span className="mb-flag" title="No @owner on this task — drag it onto an agent's card, or right-click → assign to">
              unassigned
            </span>
          )}
          {task.owners.map((o) => (
            <OwnerChip key={o} owner={o} task={task} ctx={ctx} />
          ))}
        </span>
        <button
          type="button"
          className="mb-more"
          tabIndex={-1}
          aria-label={`Actions for ${task.text}`}
          title="Task actions (right-click, Shift+F10)"
          onClick={(e) => ctx.onMenu(task, anchorOf(e.currentTarget))}
        >
          ⋯
        </button>
      </li>
      {children}
    </>
  );
}

function OwnerChip({ owner, task, ctx }: { owner: string; task: Task; ctx: RowCtx }) {
  const key = `${task.line}:${owner}`;
  const ids = ownersFor({ owners: [owner] }, ctx.team);
  const first = ctx.team.find((m) => m.id === ids[0]);
  const dropProps = {
    onDragOver: (e: DragEvent) => ctx.onChipDragOver(key, e),
    onDragLeave: () => ctx.onChipDragLeave(key),
    onDrop: (e: DragEvent) => ctx.onChipDrop(owner, e),
  };
  const isDrop = ctx.chipDrop === key ? " is-drop" : "";
  if (!first)
    return (
      <span className={`mb-owner is-unknown${isDrop}`} title={`No session in this workspace is named or has the role “${owner}” · drop a task here to give it to @${owner}`} {...dropProps}>
        @{owner}
      </span>
    );
  const names = ctx.team.filter((m) => ids.includes(m.id)).map((m) => m.name);
  return (
    <button
      type="button"
      className={`mb-owner${isDrop}`}
      tabIndex={-1}
      style={roleStyle(first.role)}
      title={`${names.join(", ")} — click to select${ids.length > 1 ? " the first" : ""} · drop a task here to reassign it to @${owner}`}
      onClick={(e) => {
        e.stopPropagation();
        ctx.onSelectSession(first.id);
      }}
      {...dropProps}
    >
      @{owner}
      {ids.length > 1 && <span className="mb-owner-n">×{ids.length}</span>}
    </button>
  );
}

// ---- inputs with @owner Tab completion -------------------------------------------------------------

interface TabCycle {
  start: number;
  end: number;
  matches: string[];
  i: number;
}

/** Tab / Shift+Tab completes (and cycles) the "@partial" before the caret. True when it handled the key. */
function completeOwnerTab(e: KeyboardEvent<HTMLInputElement>, slugs: readonly string[], cycle: { current: TabCycle | null }, setValue: (v: string) => void): boolean {
  const el = e.currentTarget;
  const caret = el.selectionStart ?? el.value.length;
  let c = cycle.current;
  if (!c || c.end !== caret) {
    const found = ownerCompletion(el.value, caret, slugs);
    if (!found || found.matches.length === 0) {
      cycle.current = null;
      return false;
    }
    c = { start: found.start, end: caret, matches: found.matches, i: -1 };
  }
  e.preventDefault();
  const n = c.matches.length;
  const i = (((c.i + (e.shiftKey ? -1 : 1)) % n) + n) % n;
  const token = `@${c.matches[i]}`;
  const value = el.value.slice(0, c.start) + token + el.value.slice(c.end);
  const end = c.start + token.length;
  cycle.current = { ...c, end, i };
  setValue(value);
  requestAnimationFrame(() => el.setSelectionRange(end, end));
  return true;
}

function EditText({ task, slugs, onSave, onCancel }: { task: Task; slugs: string[]; onSave: (v: string, key: boolean) => void; onCancel: (key: boolean) => void }) {
  const [value, setValue] = useState(task.text);
  const done = useRef(false);
  const cycle = useRef<TabCycle | null>(null);
  const finish = (save: boolean, key: boolean) => {
    if (done.current) return;
    done.current = true;
    if (save && value.trim() && value.trim() !== task.text) onSave(value, key);
    else onCancel(key);
  };
  return (
    <input
      className="mb-input mb-edit"
      value={value}
      autoFocus
      spellCheck={false}
      aria-label="Task text (Enter saves, Esc cancels; @owner replaces the owners)"
      title="Enter saves · Esc cancels · typing @owner replaces the owners · Tab completes @owners"
      onFocus={(e) => e.currentTarget.select()}
      onChange={(e) => setValue(e.target.value)}
      onBlur={() => finish(true, false)}
      onKeyDown={(e) => {
        if (e.key === "Tab" && completeOwnerTab(e, slugs, cycle, setValue)) return;
        cycle.current = null;
        if (e.key === "Enter") {
          e.preventDefault();
          finish(true, true);
        } else if (e.key === "Escape") {
          e.preventDefault();
          e.stopPropagation();
          finish(false, true);
        }
      }}
    />
  );
}

function QuickAdd({
  inputRef,
  slugs,
  disabled,
  onAdd,
  onLeave,
}: {
  inputRef: RefObject<HTMLInputElement | null>;
  slugs: string[];
  disabled: boolean;
  onAdd: (value: string) => Promise<boolean>;
  /** Move focus back to the task rows; false when there is no row to go to. */
  onLeave: () => boolean;
}) {
  const [value, setValue] = useState("");
  const cycle = useRef<TabCycle | null>(null);
  const hint = useMemo(() => {
    const c = ownerCompletion(value, value.length, slugs);
    return c && c.matches.length ? c.matches.slice(0, 6) : null;
  }, [value, slugs]);
  const submit = async () => {
    if (!value.trim() || disabled) return;
    if (await onAdd(value)) setValue("");
  };
  return (
    <form
      className="mb-add"
      onSubmit={(e) => {
        e.preventDefault();
        void submit();
      }}
    >
      <span className="mb-add-plus" aria-hidden>
        +
      </span>
      <input
        ref={inputRef}
        className="mb-input mb-add-input"
        value={value}
        spellCheck={false}
        placeholder="add task — @owner assigns, Tab completes (n)"
        aria-label="Add a task (Enter adds it under ## Tasks; @owner assigns it)"
        onChange={(e) => setValue(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Tab" && completeOwnerTab(e, slugs, cycle, setValue)) return;
          cycle.current = null;
          // Esc: clear the draft, else back to the task rows; with neither, Mission Control closes as usual.
          if (e.key === "Escape" && (value || onLeave())) {
            e.preventDefault();
            e.stopPropagation();
            if (value) setValue("");
          }
        }}
      />
      {hint && <span className="mb-add-hint mc-micro">Tab: {hint.map((s) => `@${s}`).join(" ")}</span>}
    </form>
  );
}

function AskReason({ ask, onConfirm, onCancel }: { ask: BlockAsk; onConfirm: (reason: string) => void; onCancel: () => void }) {
  const [reason, setReason] = useState("");
  return (
    <li className="mb-ask">
      <span className="mb-box is-static">[!]</span>
      <input
        className="mb-input mb-ask-input"
        value={reason}
        autoFocus
        spellCheck={false}
        placeholder={`why is “${short(ask.text)}” blocked? (optional) — Enter blocks · Esc cancels`}
        aria-label="Reason the task is blocked (optional)"
        onChange={(e) => setReason(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Enter") {
            e.preventDefault();
            onConfirm(reason);
          } else if (e.key === "Escape") {
            e.preventDefault();
            e.stopPropagation();
            onCancel();
          }
        }}
      />
      <button type="button" className="mc-btn is-primary" onClick={() => onConfirm(reason)}>
        block
      </button>
      <button type="button" className="mc-btn" onClick={onCancel}>
        cancel
      </button>
    </li>
  );
}

// ---- no mission file yet -------------------------------------------------------------------------

function SetMission({ projectDir, path }: { projectDir: string; path: string }) {
  const [goal, setGoal] = useState("");
  const [tasks, setTasks] = useState("");
  const [busy, setBusy] = useState(false);
  const create = async () => {
    if (!goal.trim() || busy) return;
    setBusy(true);
    try {
      const r = await writeMission(projectDir, newMissionText(goal, "", tasks.split(/\r?\n/)), null);
      if (r.ok) notify("info", "Mission set — brief the team so every agent knows where it is");
    } finally {
      setBusy(false);
    }
  };
  return (
    <form
      className="mb-form"
      onSubmit={(e) => {
        e.preventDefault();
        void create();
      }}
    >
      <div className="mc-empty">
        no mission yet — set one and every agent can read and update it in <span title={path}>.gridkeeper\mission.md</span>
      </div>
      <label className="mb-field">
        <span className="mc-micro">goal</span>
        <input className="mb-input" value={goal} onChange={(e) => setGoal(e.target.value)} placeholder="e.g. Add OAuth login" spellCheck={false} aria-label="Mission goal" />
      </label>
      <label className="mb-field">
        <span className="mc-micro">tasks (optional, one per line, “@owner” to assign)</span>
        <textarea
          className="mb-input mb-textarea"
          value={tasks}
          onChange={(e) => setTasks(e.target.value)}
          placeholder={"Design the token storage @lead\nImplement /auth/callback @builder-1"}
          spellCheck={false}
          rows={3}
          aria-label="Mission tasks, one per line"
        />
      </label>
      <div className="mc-empty-actions mb-form-actions">
        <button type="submit" className="mc-btn is-primary" disabled={!goal.trim() || busy}>
          {busy ? "creating…" : "create mission"}
        </button>
      </div>
    </form>
  );
}

// ---- raw editor ----------------------------------------------------------------------------------

function EditMissionDialog({ projectDir, file, onClose }: { projectDir: string; file: MissionFile; onClose: () => void }) {
  const [text, setText] = useState(file.text);
  // What the edit is based on: the text + modification time last loaded from disk.
  const [baseText, setBaseText] = useState(file.text);
  const [base, setBase] = useState(file.modifiedMs);
  const [busy, setBusy] = useState(false);
  const latest = useMissionDocs((s) => s.byDir[projectDir]?.file ?? null);
  const dirty = text !== baseText;
  const changedOnDisk = !!latest && latest.modifiedMs !== base;

  const loadLatest = () => {
    const f = useMissionDocs.getState().byDir[projectDir]?.file;
    if (!f) return;
    setText(f.text);
    setBaseText(f.text);
    setBase(f.modifiedMs);
  };
  // Untouched editor: follow the file as agents change it. With edits: warn instead (see below).
  useEffect(() => {
    if (changedOnDisk && !dirty) loadLatest();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [latest]);
  const requestClose = async () => {
    if (dirty && !(await confirmDialog({ title: "Discard your edits?", message: "The mission file stays as it is on disk.", confirmLabel: "Discard", danger: true }))) return;
    onClose();
  };
  const save = async (overwrite = false) => {
    if (busy) return;
    setBusy(true);
    try {
      const expected = overwrite ? (useMissionDocs.getState().byDir[projectDir]?.file?.modifiedMs ?? null) : base;
      const r = await writeMission(projectDir, text, expected);
      if (r.ok) onClose();
    } finally {
      setBusy(false);
    }
  };

  return (
    <Modal
      title="Mission file"
      onClose={() => void requestClose()}
      width={780}
      footer={
        <>
          <span className="mb-editor-path mono" title={file.path}>
            {file.path}
          </span>
          <Button onClick={() => void requestClose()}>Cancel</Button>
          {changedOnDisk ? (
            <Button variant="danger" onClick={() => void save(true)} disabled={busy} title="Replace the newer file on disk with your text">
              Overwrite
            </Button>
          ) : (
            <Button variant="primary" onClick={() => void save()} disabled={busy || !dirty}>
              {busy ? "Saving…" : "Save"}
            </Button>
          )}
        </>
      }
    >
      {changedOnDisk && (
        <div className="mb-editor-warn" role="status">
          The file changed on disk while you were editing (an agent may have updated it).{" "}
          <button type="button" className="link-btn" onClick={loadLatest}>
            Load the latest version
          </button>{" "}
          (discards your edits) or Overwrite it.
        </div>
      )}
      <textarea
        className="mb-editor"
        value={text}
        onChange={(e) => setText(e.target.value)}
        spellCheck={false}
        aria-label="Mission file (Markdown)"
        data-autofocus
        onKeyDown={(e) => {
          if (e.key === "s" && (e.ctrlKey || e.metaKey) && !changedOnDisk) {
            e.preventDefault();
            void save();
          }
        }}
      />
      <div className="mb-editor-hint muted">
        Tasks: <code>- [ ] task @owner</code> · boxes <code>[ ]</code> todo, <code>[~]</code> doing, <code>[x]</code> done, <code>[!]</code> blocked · owners are
        session names or roles (<code>@builder</code> = every builder).
      </div>
    </Modal>
  );
}

// ---- brief team ----------------------------------------------------------------------------------

interface Draft extends BriefRecipient {
  on: boolean;
}

function BriefDialog({ missionPath, team, onClose }: { missionPath: string; team: TeamMember[]; onClose: () => void }) {
  const [drafts, setDrafts] = useState<Draft[] | null>(null);
  const [skipped, setSkipped] = useState<BriefSkip[]>([]);
  const [busy, setBusy] = useState(false);
  const ids = useMemo(() => team.map((m) => m.id), [team]);

  useEffect(() => {
    let cancelled = false;
    void gatherBrief(ids, missionPath).then((r) => {
      if (cancelled) return;
      setDrafts(r.recipients.map((x) => ({ ...x, on: true })));
      setSkipped(r.skipped);
    });
    return () => {
      cancelled = true;
    };
    // Snapshot once per open: the team changing underneath must not wipe the user's edits.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const chosen = (drafts ?? []).filter((d) => d.on && d.text.trim());
  const edit = (id: SessionId, p: Partial<Draft>) => setDrafts((ds) => ds && ds.map((d) => (d.id === id ? { ...d, ...p } : d)));
  const send = async () => {
    if (busy || chosen.length === 0) return;
    setBusy(true);
    try {
      const r = await sendBrief(chosen);
      const bits = [`${r.sent.length} sent`];
      if (r.skipped.length) bits.push(`skipped (now asking something): ${r.skipped.join(", ")}`);
      if (r.failed.length) bits.push(`failed: ${r.failed.join(", ")}`);
      notify(r.failed.length ? "error" : r.skipped.length ? "warn" : "info", `Mission brief — ${bits.join(" · ")}`);
      onClose();
    } finally {
      setBusy(false);
    }
  };

  return (
    <Modal
      title="Brief the team"
      onClose={onClose}
      width={760}
      footer={
        <>
          <Button onClick={onClose}>Cancel</Button>
          <Button variant="primary" onClick={() => void send()} disabled={busy || chosen.length === 0}>
            {busy ? "Sending…" : `Send to ${chosen.length} session${chosen.length === 1 ? "" : "s"}`}
          </Button>
        </>
      }
    >
      <p className="confirm-msg">
        Each line below is typed into that agent and submitted with Enter. Agents that are asking you something are skipped, because an Enter there would answer
        it. Edit any line first; nothing is sent until you press Send.
      </p>
      {drafts === null ? (
        <div className="muted">Checking the running sessions…</div>
      ) : (
        <div className="mb-brief">
          {drafts.length === 0 && <div className="muted">No running agent can be briefed right now.</div>}
          {drafts.map((d) => (
            <div key={d.id} className={`mb-brief-row${d.on ? "" : " is-off"}`}>
              <label className="mb-brief-who">
                <input type="checkbox" checked={d.on} onChange={(e) => edit(d.id, { on: e.currentTarget.checked })} aria-label={`Send to ${d.name}`} />
                <span className="mb-brief-name">{d.name}</span>
                <RoleTag role={d.role} />
              </label>
              <textarea
                className="fm-textarea mb-brief-text"
                rows={Math.min(8, Math.max(2, Math.ceil(d.text.length / 84)))}
                value={d.text}
                disabled={!d.on}
                onChange={(e) => edit(d.id, { text: e.target.value })}
                spellCheck={false}
                aria-label={`Brief for ${d.name}`}
              />
            </div>
          ))}
          {skipped.length > 0 && (
            <div className="mb-brief-skipped">
              <div className="mc-micro">skipped</div>
              {skipped.map((s) => (
                <div key={s.id}>
                  {s.name} — <span className="muted">{s.reason}</span>
                </div>
              ))}
            </div>
          )}
        </div>
      )}
    </Modal>
  );
}
