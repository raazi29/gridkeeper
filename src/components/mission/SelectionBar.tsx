// Multi-selection bar (two or more cards selected): message… / restart / stop / move to lane ▾ / assign task ▾ /
// clear. Every action goes through the existing confirmed paths: the Broadcast composer sends nothing until Send,
// restart / stop ask first (groupActions.ts), moves and assignments offer Undo.

import { memo } from "react";
import { messageSessions, restartSessions, stopSessions } from "../../actions/groupActions";
import { useT } from "../../i18n";
import type { Task } from "../../lib/missionDoc";
import type { SessionId } from "../../lib/types";
import { useContextMenu, type MenuItem } from "../ui/Menu";
import { useMcExtensions } from "./mcExtensions";
import { T } from "./mcText";

export interface SelectionBarProps {
  ids: SessionId[];
  lanes: { groupId: string; name: string }[];
  openTasks: Task[];
  onMove: (groupId: string | null) => void;
  onAssign: (task: Task) => void;
  onClear: () => void;
}

const short = (s: string) => (s.length > 56 ? `${s.slice(0, 55)}…` : s);

export const SelectionBar = memo(function SelectionBar({ ids, lanes, openTasks, onMove, onAssign, onClear }: SelectionBarProps) {
  useT(); // re-render on a language change (T reads the catalog)
  const menu = useContextMenu();
  const cardActions = useMcExtensions((s) => s.card);
  const extra = cardActions.filter((a) => a.bulk);
  const what = T.selection.what(ids.length);
  const laneItems: MenuItem[] = [
    ...(lanes.length ? lanes.map((l) => ({ label: l.name, onSelect: () => onMove(l.groupId) })) : [{ label: T.selection.noLanes, disabled: true }]),
    "separator",
    { label: `+ ${T.selection.newLane}`, onSelect: () => onMove(null) },
  ];
  const taskItems: MenuItem[] = openTasks.length
    ? openTasks.map((t) => ({ label: short(t.text), hint: t.owners.length ? t.owners.map((o) => `@${o}`).join(" ") : undefined, onSelect: () => onAssign(t) }))
    : [{ label: T.selection.noTasks, disabled: true }];
  return (
    <div className="mc-selbar" role="toolbar" aria-label={T.selection.count(ids.length)} onPointerDown={(e) => e.stopPropagation()}>
      <span className="mc-selbar-count">{T.selection.count(ids.length)}</span>
      <button type="button" className="mc-btn" onClick={() => messageSessions(ids, what)}>
        {T.selection.message}
      </button>
      <button type="button" className="mc-btn" onClick={() => void restartSessions(ids, what)}>
        {T.selection.restart}
      </button>
      <button type="button" className="mc-btn" onClick={() => void stopSessions(ids, what)}>
        {T.selection.stop}
      </button>
      <button type="button" className="mc-btn" aria-haspopup="menu" onClick={(e) => menu.openAt(e.currentTarget, laneItems)}>
        {T.selection.moveTo} ▾
      </button>
      <button type="button" className="mc-btn" aria-haspopup="menu" disabled={!openTasks.length} onClick={(e) => menu.openAt(e.currentTarget, taskItems)}>
        {T.selection.assign} ▾
      </button>
      {extra.map((a) => (
        <button key={a.id} type="button" className={`mc-btn${a.danger ? " is-danger" : ""}`} title={a.title} onClick={() => ids.forEach((id) => void a.run(id))}>
          {a.label}
        </button>
      ))}
      <button type="button" className="mc-btn mc-selbar-clear" title={T.selection.clearHint} onClick={onClear}>
        {T.selection.clear} ✕
      </button>
      {menu.element}
    </div>
  );
});
