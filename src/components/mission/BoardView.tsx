// Board view: the mission's tasks (mission.md) in one column per agent, or per lane with each agent as a section;
// an "unassigned" column first. Drag a task onto another agent to reassign it (onto "unassigned" to clear its
// owners), click its box for the next state, right-click for any state / assign. Keyboard on a task: ↑↓ within a
// column, ←→ across columns, Alt+←→ reassigns to the neighbouring agent, Space next state, Enter selects the
// agent, Shift+F10 menu. Every write goes through taskOps (conflict-checked, Undo on reassign).

import { memo, useMemo, useRef, useState, type DragEvent, type KeyboardEvent } from "react";
import { ownersFor, slugify, STATE_ORDER, type Task, type TeamMember } from "../../lib/missionDoc";
import type { SessionId } from "../../lib/types";
import { useT } from "../../i18n";
import { AgentGlyph } from "../../layout/icons";
import { useApp } from "../../store/appStore";
import { useDeck } from "../../store/missionDeck";
import type { MissionEntry } from "../../store/missionDoc";
import type { FleetLamp } from "../util/fleet";
import type { MenuItem, MenuOpenEvent } from "../ui/Menu";
import { inSpotlight, matchesFilters } from "./deck";
import { LAMP_TEXT } from "./derive";
import { IcSpot } from "./mcIcons";
import { T } from "./mcText";
import { RoleTag, roleStyle } from "./RoleTag";
import { BOX, cycleTask, reassignTask, STATE_WORD, taskMenuItems } from "./taskOps";
import "../../styles/mcViews.css";

const BOARD_MIME = "application/x-gridkeeper-board-task";
const UNASSIGNED = "__unassigned";

export interface BoardAgent {
  id: SessionId;
  /** Lane group id, or "lead". */
  lane: string;
  laneName: string;
}

export interface BoardViewProps {
  projectDir: string | null;
  mission: MissionEntry;
  team: TeamMember[];
  /** Agents in display order (leads first). */
  agents: BoardAgent[];
  lanes: { id: string; name: string }[];
  lamps: Record<SessionId, FleetLamp>;
  selected: SessionId | null;
  onSelect: (id: SessionId) => void;
  onJump: (id: SessionId) => void;
  onGraph: () => void;
  openMenu: (e: MenuOpenEvent, items: MenuItem[]) => void;
}

interface Col {
  /** Agent id or UNASSIGNED. */
  id: string;
  tasks: Task[];
}

const rank = (t: Task) => STATE_ORDER.indexOf(t.state);

export const BoardView = memo(function BoardView(p: BoardViewProps) {
  const t = useT();
  const boardBy = useDeck((s) => s.boardBy);
  const filters = useDeck((s) => s.filters);
  const spotlight = useDeck((s) => s.spotlight);
  const current = useDeck((s) => s.findCurrent);
  const setDeck = useDeck((s) => s.set);
  const names = useApp((s) => p.agents.map((a) => s.persisted.sessions.find((m) => m.id === a.id)?.name ?? "").join("\u0000"));
  const doc = p.mission.doc;
  const tasks = doc?.tasks ?? [];
  const [focus, setFocus] = useState<string | null>(null);
  const [dropOn, setDropOn] = useState<string | null>(null);
  const drag = useRef<Task | null>(null);
  const root = useRef<HTMLDivElement>(null);

  const cols = useMemo<Col[]>(() => {
    const by = new Map<string, Task[]>([[UNASSIGNED, []]]);
    for (const a of p.agents) by.set(a.id, []);
    for (const t of tasks) {
      const ids = ownersFor(t, p.team).filter((id) => by.has(id));
      if (ids.length === 0) {
        if (t.state !== "done") by.get(UNASSIGNED)!.push(t);
      } else for (const id of ids) by.get(id)!.push(t);
    }
    const sort = (l: Task[]) => [...l].sort((a, b) => rank(a) - rank(b) || a.line - b.line);
    return [{ id: UNASSIGNED, tasks: sort(by.get(UNASSIGNED)!) }, ...p.agents.map((a) => ({ id: a.id, tasks: sort(by.get(a.id)!) }))];
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tasks, p.team, p.agents, names]);

  const nameOf = (id: string) => p.team.find((m) => m.id === id)?.name ?? "";
  const roleOf = (id: string) => p.team.find((m) => m.id === id)?.role ?? null;
  const lit = (id: string) => {
    if (id === UNASSIGNED) return !spotlight;
    const a = p.agents.find((x) => x.id === id);
    return inSpotlight(spotlight, id, a?.lane ?? null) && matchesFilters(filters, roleOf(id), p.lamps[id] ?? "stopped");
  };

  // ---- writes ----
  const dir = p.projectDir;
  const reassign = (t: Task, to: string) => {
    if (!dir) return;
    if (to === UNASSIGNED) void reassignTask(dir, t, null);
    else {
      const name = nameOf(to);
      const slug = slugify(name);
      if (slug) void reassignTask(dir, t, slug, name);
    }
  };

  // ---- drag and drop ----
  const dropProps = (colId: string) => ({
    onDragOver: (e: DragEvent) => {
      if (!drag.current || !e.dataTransfer.types.includes(BOARD_MIME)) return;
      e.preventDefault();
      e.dataTransfer.dropEffect = "move";
      if (dropOn !== colId) setDropOn(colId);
    },
    onDragLeave: (e: DragEvent) => {
      if (!(e.currentTarget as HTMLElement).contains(e.relatedTarget as Node | null)) setDropOn((c) => (c === colId ? null : c));
    },
    onDrop: (e: DragEvent) => {
      const t = drag.current;
      if (!t || !e.dataTransfer.types.includes(BOARD_MIME)) return;
      e.preventDefault();
      drag.current = null;
      setDropOn(null);
      reassign(t, colId);
    },
  });

  // ---- keyboard ----
  const keyOf = (colId: string, t: Task) => `${colId}:${t.line}`;
  const all = cols.flatMap((c) => c.tasks.map((t) => ({ col: c.id, t })));
  const tabKey = focus && all.some((x) => keyOf(x.col, x.t) === focus) ? focus : all[0] ? keyOf(all[0].col, all[0].t) : null;
  const focusKey = (k: string | null) => {
    if (!k) return;
    setFocus(k);
    requestAnimationFrame(() => root.current?.querySelector<HTMLElement>(`[data-bkey="${CSS.escape(k)}"]`)?.focus());
  };
  const onTaskKey = (e: KeyboardEvent, colIdx: number, i: number, t: Task) => {
    if (e.key === "Escape" || e.ctrlKey || e.metaKey) return;
    e.stopPropagation();
    const col = cols[colIdx];
    const act = (fn: () => void) => {
      e.preventDefault();
      fn();
    };
    if (e.key === "ArrowUp" || e.key === "ArrowDown") act(() => focusKey(col.tasks[i + (e.key === "ArrowUp" ? -1 : 1)] ? keyOf(col.id, col.tasks[i + (e.key === "ArrowUp" ? -1 : 1)]) : null));
    else if ((e.key === "ArrowLeft" || e.key === "ArrowRight") && e.altKey) {
      act(() => {
        const to = cols[colIdx + (e.key === "ArrowLeft" ? -1 : 1)];
        if (to) reassign(t, to.id);
      });
    } else if (e.key === "ArrowLeft" || e.key === "ArrowRight") {
      act(() => {
        const step = e.key === "ArrowLeft" ? -1 : 1;
        for (let j = colIdx + step; j >= 0 && j < cols.length; j += step) {
          const c = cols[j];
          if (!c.tasks.length) continue;
          focusKey(keyOf(c.id, c.tasks[Math.min(i, c.tasks.length - 1)]));
          return;
        }
      });
    } else if (e.key === " ") act(() => dir && void cycleTask(dir, t));
    else if (e.key === "Enter") act(() => col.id !== UNASSIGNED && p.onSelect(col.id));
    else if (e.key === "ContextMenu" || (e.shiftKey && e.key === "F10")) {
      act(() => {
        const r = (e.currentTarget as HTMLElement).getBoundingClientRect();
        if (dir) p.openMenu({ clientX: r.left + 20, clientY: r.bottom }, taskMenuItems(dir, t, p.team));
      });
    }
  };

  if (!p.projectDir || !doc)
    return (
      <div className="bv bv-empty">
        <div className="mc-empty">{T.board.noMission}</div>
        <div className="mc-panel-dim">{T.board.noMissionHint}</div>
        <button type="button" className="mc-btn is-primary" onClick={p.onGraph}>
          {T.board.toGraph}
        </button>
      </div>
    );

  const renderTask = (colId: string, colIdx: number, t: Task, i: number) => {
    const k = keyOf(colId, t);
    const others = t.owners.filter((o) => colId === UNASSIGNED || o !== slugify(nameOf(colId)));
    return (
      <li
        key={k}
        data-bkey={k}
        data-line={t.line}
        className={`bv-task is-${t.state}${current === `t:${t.line}` ? " is-hit" : ""}`}
        tabIndex={tabKey === k ? 0 : -1}
        draggable={!!dir}
        aria-label={`${t.text} — ${STATE_WORD[t.state]}`}
        onFocus={(e) => e.target === e.currentTarget && setFocus(k)}
        onKeyDown={(e) => onTaskKey(e, colIdx, i, t)}
        onContextMenu={(e) => {
          e.preventDefault();
          e.stopPropagation();
          if (dir) p.openMenu(e, taskMenuItems(dir, t, p.team));
        }}
        onDragStart={(e) => {
          drag.current = t;
          e.dataTransfer.effectAllowed = "move";
          e.dataTransfer.setData(BOARD_MIME, String(t.line));
        }}
        onDragEnd={() => {
          drag.current = null;
          setDropOn(null);
        }}
      >
        <button type="button" className="mb-box" tabIndex={-1} title={T.board.cycle} disabled={!dir} onClick={() => dir && void cycleTask(dir, t)}>
          {BOX[t.state]}
        </button>
        <span className="bv-task-text" title={t.text}>
          {t.text}
        </span>
        {others.length > 0 && (
          <span className="bv-task-owners">
            {others.map((o) => (
              <span key={o} className="mb-owner is-static">
                @{o}
              </span>
            ))}
          </span>
        )}
      </li>
    );
  };

  const header = (id: string) => {
    if (id === UNASSIGNED)
      return (
        <div className="bv-col-head is-unassigned" title={T.board.unassignedHint}>
          <span className="bv-col-name">{T.board.unassigned}</span>
        </div>
      );
    const lamp = p.lamps[id] ?? "stopped";
    const agent = useApp.getState().persisted.sessions.find((m) => m.id === id)?.agent ?? "powershell";
    const spot = spotlight?.kind === "agent" && spotlight.id === id;
    return (
      <div
        className={`bv-col-head${p.selected === id ? " is-selected" : ""}${current === `a:${id}` ? " is-hit" : ""}`}
        style={roleStyle(roleOf(id))}
        title={t("mcView.board.colTitle", { name: nameOf(id), state: LAMP_TEXT[lamp] })}
        onClick={() => p.onSelect(id)}
        onDoubleClick={() => p.onJump(id)}
      >
        <span className={`attn-lamp attn-lamp--${lamp}`} />
        <span className="mc-card-glyph">
          <AgentGlyph agent={agent} size={11} />
        </span>
        <span className="bv-col-name">{nameOf(id)}</span>
        <RoleTag role={roleOf(id)} glyphOnly />
        <button
          type="button"
          className={`bv-spot${spot ? " is-on" : ""}`}
          aria-pressed={spot}
          title={T.lane.spotlight(nameOf(id))}
          onClick={(e) => {
            e.stopPropagation();
            setDeck({ spotlight: spot ? null : { kind: "agent", id } });
          }}
        >
          <IcSpot size={11} />
        </button>
      </div>
    );
  };

  const column = (c: Col, colIdx: number, inLane = false) => {
    const open = c.tasks.filter((t) => t.state !== "done");
    const done = c.tasks.filter((t) => t.state === "done");
    return (
      <section
        key={c.id}
        className={`bv-col${inLane ? " is-section" : ""}${dropOn === c.id ? " is-drop" : ""}${lit(c.id) ? "" : " is-dim"}`}
        aria-label={c.id === UNASSIGNED ? T.board.unassigned : nameOf(c.id)}
        {...dropProps(c.id)}
      >
        {header(c.id)}
        <ul className="bv-tasks">
          {open.map((t, i) => renderTask(c.id, colIdx, t, i))}
          {done.map((t, i) => renderTask(c.id, colIdx, t, open.length + i))}
          {c.tasks.length === 0 && <li className="bv-none">{dropOn === c.id && c.id !== UNASSIGNED ? T.board.dropHere(slugify(nameOf(c.id))) : T.board.empty}</li>}
        </ul>
      </section>
    );
  };

  return (
    <div ref={root} className={`bv is-by-${boardBy}`} role="region" aria-label={T.views.boardHint}>
      {boardBy === "agent" ? (
        cols.map((c, i) => column(c, i))
      ) : (
        <>
          {column(cols[0], 0)}
          {[{ id: "lead", name: "lead" }, ...p.lanes].map((lane) => {
            const members = cols.map((c, i) => ({ c, i })).filter(({ c }) => p.agents.find((a) => a.id === c.id)?.lane === lane.id);
            if (!members.length) return null;
            return (
              <div key={lane.id} className={`bv-lane${spotlight?.kind === "lane" && spotlight.id !== lane.id ? " is-dim" : ""}`}>
                <div className="bv-lane-head mc-micro">{lane.id === "lead" ? "lead" : lane.name}</div>
                <div className="bv-lane-body">{members.map(({ c, i }) => column(c, i, true))}</div>
              </div>
            );
          })}
        </>
      )}
    </div>
  );
});
