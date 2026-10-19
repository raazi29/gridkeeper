// List view: one dense row per agent — name, role, lane, state and time in it, current mission task, branch
// evidence (the sign-off summary cache, read once per open), cost / context (meter), CPU / RAM (shared
// diagnostics poll), output rate. Sortable columns (click a header; empty values last), selection shared with
// the graph (click, Ctrl/⌘ toggles, Shift ranges), ↑↓ / Home / End move it, Enter / double-click jump, and the
// card keys (R, S, M, Del, F2…) act on the selected row.

import { memo, useEffect, useMemo, useRef, useState, type KeyboardEvent, type MouseEvent, type MutableRefObject } from "react";
import { evidencePath, pathKey, refreshBranchSummary, useBranchSummaries } from "../../actions/handoff";
import { paneCost } from "../../lib/meter";
import type { Task } from "../../lib/missionDoc";
import type { SessionId } from "../../lib/types";
import { AgentGlyph } from "../../layout/icons";
import { isLive, useApp } from "../../store/appStore";
import { useAttention } from "../../store/attention";
import { useMeter } from "../../store/meter";
import { useDeck } from "../../store/missionDeck";
import { formatRate, latestRate, useRates } from "../../store/rates";
import { useUi } from "../../store/uiStore";
import type { FleetLamp } from "../util/fleet";
import { basename, formatCpu, formatMb, formatSince, taskManagerCpu } from "../util/text";
import { inSpotlight, matchesFilters } from "./deck";
import { LAMP_TEXT } from "./derive";
import { nextSort, sortRows, type ListRow, type SortDir, type SortKey } from "./listModel";
import { T } from "./mcText";
import { RoleTag, roleStyle } from "./RoleTag";
import { formatSummaryLine } from "./signoffModel";
import "../../styles/mcViews.css";

export interface ListAgent {
  id: SessionId;
  lane: string;
  laneName: string;
}

export interface ListViewProps {
  agents: ListAgent[];
  lamps: Record<SessionId, FleetLamp>;
  tasks: Record<SessionId, Task>;
  selected: SessionId | null;
  multi: SessionId[];
  now: number;
  onSelect: (id: SessionId, e: { ctrlKey: boolean; metaKey: boolean; shiftKey: boolean }) => void;
  onJump: (id: SessionId) => void;
  onMenu: (e: MouseEvent, id: SessionId) => void;
  keys: MutableRefObject<((e: KeyboardEvent) => boolean) | null>;
}

const COLS: SortKey[] = ["name", "role", "lane", "state", "since", "task", "branch", "cost", "ctx", "cpu", "ram", "out"];
const NUM: SortKey[] = ["since", "cost", "ctx", "cpu", "ram", "out"];

export const ListView = memo(function ListView(p: ListViewProps) {
  const sessions = useApp((s) => s.persisted.sessions);
  const runtime = useApp((s) => s.runtime);
  const attn = useAttention((s) => s.sessions);
  const meters = useMeter((s) => s.bySession);
  const diag = useUi((s) => s.diag);
  const hist = useRates((s) => s.hist);
  const summaries = useBranchSummaries((s) => s.byPath);
  const filters = useDeck((s) => s.filters);
  const spotlight = useDeck((s) => s.spotlight);
  const current = useDeck((s) => s.findCurrent);
  const [sort, setSort] = useState<{ key: SortKey; dir: SortDir }>({ key: "state", dir: "asc" });

  // Branch evidence: read once per open for each agent's folder (like the sign-off cards). No polling.
  const paths = useMemo(() => [...new Set(p.agents.map((a) => evidencePath(sessions.find((m) => m.id === a.id))).filter((x): x is string => !!x))].join("\u0000"), [p.agents, sessions]);
  useEffect(() => {
    for (const path of paths.split("\u0000")) if (path && !useBranchSummaries.getState().byPath[pathKey(path)]) void refreshBranchSummary(path);
  }, [paths]);

  const rows = useMemo<ListRow[]>(() => {
    const cores = diag?.logicalCores ?? 1;
    return p.agents.map((a, order) => {
      const m = sessions.find((x) => x.id === a.id);
      const rt = runtime[a.id];
      const at = attn[a.id];
      const started = rt?.startedAt ? Date.parse(rt.startedAt) : Number.NaN;
      const live = isLive(rt);
      const path = evidencePath(m);
      const sum = path ? summaries[pathKey(path)]?.summary : undefined;
      const stats = diag?.sessions.find((x) => x.id === a.id)?.stats;
      const meter = meters[a.id];
      const task = p.tasks[a.id];
      return {
        id: a.id,
        order,
        name: m?.name ?? "session",
        role: m?.role ?? null,
        lane: a.laneName,
        lamp: p.lamps[a.id] ?? "stopped",
        since: live && !Number.isNaN(started) ? (at && at.at >= started ? at.at : started) : null,
        task: task?.text ?? null,
        taskState: task?.state ?? null,
        branch: m?.worktree ? (m.worktree.branch ?? basename(m.worktree.path)) : null,
        evidence: sum ? formatSummaryLine(sum, p.now).replace(/^⎇ [^·]+· ?/, "") : "",
        cost: paneCost(meter),
        ctx: meter?.contextPct ?? null,
        cpu: live && stats ? taskManagerCpu(stats.cpuPercent, cores) : null,
        ram: live && stats ? stats.memoryBytes : null,
        out: live ? latestRate(hist[a.id]) : null,
      };
    });
  }, [p.agents, p.lamps, p.tasks, p.now, sessions, runtime, attn, summaries, diag, meters, hist]);

  const visible = rows.filter((r) => inSpotlight(spotlight, r.id, p.agents[r.order]?.lane ?? null) && matchesFilters(filters, r.role, r.lamp));
  const sorted = sortRows(visible, sort.key, sort.dir);
  const order = sorted.map((r) => r.id);

  // ↑↓ / Home / End (Shift extends) from Mission Control's key handler while this view is shown.
  const orderRef = useRef(order);
  orderRef.current = order;
  const sel = useRef(p.selected);
  sel.current = p.selected;
  const onSelect = useRef(p.onSelect);
  onSelect.current = p.onSelect;
  useEffect(() => {
    const keys = p.keys;
    keys.current = (e) => {
      const o = orderRef.current;
      if (!o.length || e.ctrlKey || e.metaKey || e.altKey) return false;
      const i = sel.current ? o.indexOf(sel.current) : -1;
      let j: number;
      if (e.key === "ArrowDown") j = Math.min(o.length - 1, i + 1);
      else if (e.key === "ArrowUp") j = Math.max(0, i - 1);
      else if (e.key === "Home") j = 0;
      else if (e.key === "End") j = o.length - 1;
      else return false;
      onSelect.current(o[j], { ctrlKey: false, metaKey: false, shiftKey: e.shiftKey });
      requestAnimationFrame(() => document.querySelector<HTMLElement>(`.lv [data-row="${CSS.escape(o[j])}"]`)?.scrollIntoView({ block: "nearest" }));
      return true;
    };
    return () => {
      keys.current = null;
    };
  }, [p.keys, orderRef, sel, onSelect]);

  const cell = (r: ListRow, k: SortKey) => {
    switch (k) {
      case "name": {
        const agent = sessions.find((m) => m.id === r.id)?.agent ?? "powershell";
        return (
          <>
            <span className={`attn-lamp attn-lamp--${r.lamp}`} />
            <span className="mc-card-glyph">
              <AgentGlyph agent={agent} size={11} />
            </span>
            <span className="lv-name">{r.name}</span>
          </>
        );
      }
      case "role":
        return <RoleTag role={r.role} />;
      case "lane":
        return r.lane;
      case "state":
        return <span className={`is-${r.lamp}`}>{LAMP_TEXT[r.lamp]}</span>;
      case "since":
        return r.since !== null ? formatSince(p.now - r.since) : "—";
      case "task":
        return r.task ? (
          <span className={`lv-task is-${r.taskState ?? "todo"}`} title={r.task}>
            {r.taskState === "doing" ? "[~]" : "[ ]"} {r.task}
          </span>
        ) : (
          <span className="lv-dim">—</span>
        );
      case "branch":
        return r.branch || r.evidence ? (
          <span className="lv-branch" title={[r.branch ? `⎇ ${r.branch}` : "", r.evidence].filter(Boolean).join(" · ")}>
            {r.branch && <span className="lv-br">⎇ {r.branch}</span>}
            {r.evidence && <span className="lv-ev">{r.evidence}</span>}
          </span>
        ) : (
          <span className="lv-dim">—</span>
        );
      case "cost":
        return r.cost !== null ? `$${r.cost.toFixed(2)}` : "—";
      case "ctx":
        return r.ctx !== null ? `${Math.round(r.ctx)}%` : "—";
      case "cpu":
        return r.cpu !== null ? formatCpu(r.cpu) : "—";
      case "ram":
        return r.ram !== null ? formatMb(r.ram) : "—";
      case "out":
        return r.out !== null ? formatRate(r.out) : "—";
    }
  };

  return (
    <div className="lv" role="region" aria-label={T.list.label}>
      <table className="lv-table" role="grid" aria-label={T.list.label} aria-multiselectable="true">
        <thead>
          <tr>
            {COLS.map((k) => (
              <th
                key={k}
                className={`lv-c-${k}${NUM.includes(k) ? " is-num" : ""}`}
                aria-sort={sort.key === k ? (sort.dir === "asc" ? "ascending" : "descending") : "none"}
                scope="col"
              >
                <button type="button" title={T.list.sortHint} onClick={() => setSort(nextSort(sort, k))}>
                  {T.list.cols[k]}
                  <span className="lv-sort" aria-hidden="true">
                    {sort.key === k ? (sort.dir === "asc" ? "▲" : "▼") : ""}
                  </span>
                </button>
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {sorted.map((r) => {
            const on = p.selected === r.id || p.multi.includes(r.id);
            return (
              <tr
                key={r.id}
                data-row={r.id}
                aria-selected={on}
                className={`${on ? "is-selected" : ""}${p.selected === r.id ? " is-focus" : ""}${current === `a:${r.id}` ? " is-hit" : ""}`}
                style={roleStyle(r.role)}
                onClick={(e) => p.onSelect(r.id, e)}
                onDoubleClick={() => p.onJump(r.id)}
                onContextMenu={(e) => {
                  p.onSelect(r.id, { ctrlKey: false, metaKey: false, shiftKey: false });
                  p.onMenu(e, r.id);
                }}
              >
                {COLS.map((k) => (
                  <td key={k} className={`lv-c-${k}${NUM.includes(k) ? " is-num" : ""}`}>
                    {cell(r, k)}
                  </td>
                ))}
              </tr>
            );
          })}
        </tbody>
      </table>
      {sorted.length === 0 && <div className="mc-empty lv-empty">{T.list.empty}</div>}
    </div>
  );
});
