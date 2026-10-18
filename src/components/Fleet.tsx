// "Fleet" overview: every session of every workspace as a compact tile (state lamp, last alert,
// uptime, CPU/RAM, last lines of output). Click / Enter jumps to the session; arrows move; Esc closes.
// Output tails are fetched only for tiles on screen, at most every 2 s, and only while open.

import { memo, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { create } from "zustand";
import { useShallow } from "zustand/react/shallow";
import { jumpToSession } from "../actions/commands";
import { ipc } from "../lib/ipc";
import { processSessionIds } from "../lib/browserPanes";
import type { SessionId } from "../lib/types";
import { AgentGlyph } from "../layout/icons";
import { isLive, useApp } from "../store/appStore";
import { useAttention, useAttentionUi } from "../store/attention";
import { popModal, pushModal, useUi } from "../store/uiStore";
import { ATTN_LABEL, IconFleet } from "./AttentionBits";
import { useDiagnosticsPoll } from "./hooks";
import { IconClose } from "./icons";
import { fleetLamp, formatUptime, matchesFleetFilter, tailLines, type FleetFilter, type FleetLamp } from "./util/fleet";
import { formatCpu, formatMb, taskManagerCpu } from "./util/text";
import { buildSessionMenu } from "./menus/sessionMenu";
import { useContextMenu } from "./ui/Menu";
import { CostMeterHint, MeterChip } from "./MeterChip";
import "../styles/attention.css";

const LAMP_LABEL: Record<FleetLamp, string> = { ...ATTN_LABEL, exited: "Exited", stopped: "Not started" };
const FILTERS: { id: FleetFilter; label: string }[] = [
  { id: "all", label: "All" },
  { id: "needs", label: "Needs me" },
  { id: "working", label: "Working" },
  { id: "errors", label: "Errors" },
];
const TAIL_BYTES = 8 * 1024;
const TAIL_REFRESH_MS = 2000;

// Output tails, keyed by session (per-tile subscription; only changed tiles re-render).
const useTails = create<{ tails: Record<SessionId, string[]> }>()(() => ({ tails: {} }));

export function FleetOverlay() {
  const close = useCallback(() => useAttentionUi.getState().close(), []);
  const [filter, setFilter] = useState<FleetFilter>("all");
  const [selected, setSelected] = useState<SessionId | null>(() => useApp.getState().focusedSessionId);
  const panel = useRef<HTMLDivElement>(null);
  useDiagnosticsPoll(true);

  // Structure: workspaces -> session ids (changes only with layout edits).
  // Process tiles only: browser panes have no process, output or CPU.
  const sections = useApp(
    useShallow((s) => {
      const metas = new Map(s.persisted.sessions.map((m) => [m.id, m]));
      return s.persisted.workspaces.map(
        (w) => `${w.id}\u0000${w.name}\u0000${processSessionIds(w.groups.flatMap((g) => g.sessionIds), metas).join(",")}`,
      );
    }),
  );
  const runtime = useApp((s) => s.runtime);
  const attn = useAttention((s) => s.sessions);

  const groups = useMemo(
    () =>
      sections.map((row) => {
        const [id, name, ids] = row.split("\u0000");
        return { id, name, ids: ids ? ids.split(",") : [] };
      }),
    [sections],
  );
  const counts = useMemo(() => {
    const c: Record<FleetFilter, number> = { all: 0, needs: 0, working: 0, errors: 0 };
    for (const g of groups)
      for (const id of g.ids) for (const f of FILTERS) if (matchesFleetFilter(f.id, runtime[id], attn[id])) c[f.id]++;
    return c;
  }, [groups, runtime, attn]);
  const visible = useMemo(
    () => groups.map((g) => ({ ...g, ids: g.ids.filter((id) => matchesFleetFilter(filter, runtime[id], attn[id])) })).filter((g) => g.ids.length > 0),
    [groups, filter, runtime, attn],
  );
  const flat = useMemo(() => visible.flatMap((g) => g.ids), [visible]);
  const allIds = useMemo(() => groups.flatMap((g) => g.ids), [groups]);

  // Modal semantics: suspend app shortcuts, restore focus on close.
  useLayoutEffect(() => {
    const id = pushModal();
    const prev = document.activeElement as HTMLElement | null;
    // Fallback focus target (no tiles yet / empty filter) so Esc and arrows work.
    panel.current?.focus();
    return () => {
      popModal(id);
      if (prev?.isConnected && !useUi.getState().dialog) requestAnimationFrame(() => prev.focus());
    };
  }, []);

  useEffect(() => {
    if (flat.length && (!selected || !flat.includes(selected))) setSelected(flat[0]);
  }, [flat, selected]);

  useEffect(() => {
    if (!selected) return;
    const el = panel.current?.querySelector<HTMLElement>(`[data-tile="${CSS.escape(selected)}"]`);
    if (el && document.activeElement !== el) el.focus({ preventScroll: false });
  }, [selected]);

  // ---- tails: IntersectionObserver for on-screen tiles + one 2 s refresh loop while open
  const onScreen = useRef(new Set<SessionId>());
  const observer = useRef<IntersectionObserver | null>(null);
  useEffect(() => {
    const io = new IntersectionObserver(
      (entries) => {
        for (const e of entries) {
          const id = (e.target as HTMLElement).dataset.tile;
          if (!id) continue;
          if (e.isIntersecting) onScreen.current.add(id);
          else onScreen.current.delete(id);
        }
      },
      { root: panel.current?.querySelector(".attn-fleet-body") ?? null },
    );
    observer.current = io;
    for (const el of panel.current?.querySelectorAll<HTMLElement>("[data-tile]") ?? []) io.observe(el);
    let stopped = false;
    let timer: number | undefined;
    const fetched = new Set<SessionId>();
    const tick = async () => {
      const rt = useApp.getState().runtime;
      for (const id of [...onScreen.current]) {
        if (stopped) return;
        // Exited sessions do not change: fetch them once.
        if (!isLive(rt[id]) && fetched.has(id)) continue;
        try {
          const text = await ipc.sessionOutputTail(id, TAIL_BYTES);
          fetched.add(id);
          const lines = tailLines(text);
          const prev = useTails.getState().tails[id];
          if (!prev || prev.join("\n") !== lines.join("\n")) useTails.setState((s) => ({ tails: { ...s.tails, [id]: lines } }));
        } catch {
          fetched.add(id); // never started / removed
        }
      }
      if (!stopped) timer = window.setTimeout(() => void tick(), TAIL_REFRESH_MS);
    };
    // First pass right after the observer has reported the initial visibility.
    timer = window.setTimeout(() => void tick(), 50);
    return () => {
      stopped = true;
      window.clearTimeout(timer);
      io.disconnect();
      observer.current = null;
      onScreen.current.clear();
    };
  }, []);

  const observe = useCallback((el: HTMLElement | null) => {
    if (el) observer.current?.observe(el);
  }, []);

  const jump = useCallback(
    (id: SessionId) => {
      close();
      jumpToSession(id);
    },
    [close],
  );

  // Right-click / context-menu key on a tile: the shared session menu.
  const menu = useContextMenu();
  const openContextMenu = menu.open;
  const openMenu = useCallback(
    (e: { clientX: number; clientY: number; preventDefault?: () => void; stopPropagation?: () => void }, id: SessionId) => {
      setSelected(id);
      openContextMenu(e, buildSessionMenu(id, { surface: "fleet", onNavigate: close }));
    },
    [openContextMenu, close],
  );

  const onKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === "Escape") {
      e.preventDefault();
      e.stopPropagation();
      close();
      return;
    }
    if (!flat.length) return;
    const i = selected ? flat.indexOf(selected) : -1;
    if ((e.key === "ContextMenu" || (e.shiftKey && e.key === "F10")) && selected && (e.target as HTMLElement).dataset.tile) {
      e.preventDefault();
      const r = (e.target as HTMLElement).getBoundingClientRect();
      openMenu({ clientX: r.left + 12, clientY: r.top + 24 }, selected);
    } else if (e.key === "Enter" && selected && (e.target as HTMLElement).dataset.tile) {
      e.preventDefault();
      jump(selected);
    } else if (e.key === "ArrowRight" || e.key === "ArrowLeft") {
      e.preventDefault();
      const n = e.key === "ArrowRight" ? Math.min(flat.length - 1, i + 1) : Math.max(0, i - 1);
      setSelected(flat[n]);
    } else if (e.key === "ArrowDown" || e.key === "ArrowUp") {
      e.preventDefault();
      setSelected(verticalNeighbor(panel.current, selected, flat, e.key === "ArrowDown") ?? selected);
    } else if (e.key === "Home") {
      e.preventDefault();
      setSelected(flat[0]);
    } else if (e.key === "End") {
      e.preventDefault();
      setSelected(flat[flat.length - 1]);
    }
  };

  return createPortal(
    <div className="attn-fleet-backdrop" onMouseDown={(e) => e.target === e.currentTarget && close()}>
      <div ref={panel} className="attn-fleet" role="dialog" aria-modal="true" aria-label="Fleet overview" tabIndex={-1} onKeyDown={onKeyDown}>
        <div className="attn-fleet-head">
          <span className="attn-fleet-title">
            <IconFleet size={15} /> Fleet
          </span>
          <div className="segmented segmented-sm" role="radiogroup" aria-label="Filter">
            {FILTERS.map((f) => (
              <button
                key={f.id}
                type="button"
                role="radio"
                aria-checked={filter === f.id}
                className={`segment${filter === f.id ? " is-selected" : ""}`}
                onClick={() => setFilter(f.id)}
              >
                {f.label}
                <span className="attn-fleet-count">{counts[f.id]}</span>
              </button>
            ))}
          </div>
          <span className="attn-spacer" />
          <CostMeterHint ids={allIds} variant="fleet" />
          <span className="attn-fleet-hint">Arrows to move · Enter to jump · Esc to close</span>
          <button type="button" className="icon-btn icon-btn-sm" aria-label="Close" title="Close (Esc)" onClick={close}>
            <IconClose size={14} />
          </button>
        </div>
        <div className="attn-fleet-body">
          {visible.length === 0 && <div className="attn-empty">{filter === "all" ? "No sessions yet." : "Nothing here right now."}</div>}
          {visible.map((g) => (
            <section key={g.id} className="attn-fleet-section">
              <h3 className="attn-fleet-ws">{g.name}</h3>
              <div className="attn-fleet-grid">
                {g.ids.map((id) => (
                  <FleetTile key={id} id={id} selected={id === selected} onSelect={setSelected} onJump={jump} onMenu={openMenu} tileRef={observe} />
                ))}
              </div>
            </section>
          ))}
        </div>
      </div>
      {menu.element}
    </div>,
    document.body,
  );
}

/** Tile directly below / above (closest horizontal centre in the next row). */
function verticalNeighbor(root: HTMLElement | null, current: SessionId | null, flat: SessionId[], down: boolean): SessionId | null {
  if (!root || !current) return flat[0] ?? null;
  const rect = (id: SessionId) => root.querySelector<HTMLElement>(`[data-tile="${CSS.escape(id)}"]`)?.getBoundingClientRect();
  const cur = rect(current);
  if (!cur) return null;
  const cx = cur.left + cur.width / 2;
  let best: { id: SessionId; dy: number; dx: number } | null = null;
  for (const id of flat) {
    const r = rect(id);
    if (!r || id === current) continue;
    const dy = down ? r.top - cur.bottom : cur.top - r.bottom;
    if (dy < -2) continue;
    const dx = Math.abs(r.left + r.width / 2 - cx);
    if (!best || dy < best.dy - 4 || (Math.abs(dy - best.dy) <= 4 && dx < best.dx)) best = { id, dy, dx };
  }
  return best?.id ?? null;
}

const FleetTile = memo(function FleetTile({
  id,
  selected,
  onSelect,
  onJump,
  onMenu,
  tileRef,
}: {
  id: SessionId;
  selected: boolean;
  onSelect: (id: SessionId) => void;
  onJump: (id: SessionId) => void;
  onMenu: (e: React.MouseEvent, id: SessionId) => void;
  tileRef: (el: HTMLElement | null) => void;
}) {
  const meta = useApp(useShallow((s) => {
    const m = s.persisted.sessions.find((x) => x.id === id);
    return m ? { name: m.name, agent: m.agent, profileId: m.profileId } : null;
  }));
  const group = useApp((s) => {
    for (const w of s.persisted.workspaces) for (const g of w.groups) if (g.sessionIds.includes(id)) return w.groups.length > 1 ? g.name : "";
    return "";
  });
  const profile = useApp(useShallow((s) => {
    const p = meta?.profileId ? s.accounts.find((x) => x.id === meta.profileId) : undefined;
    return p ? { name: p.name, color: p.color } : null;
  }));
  const rt = useApp((s) => s.runtime[id]);
  const a = useAttention((s) => s.sessions[id]);
  const stats = useUi((s) => s.diag?.sessions.find((x) => x.id === id)?.stats);
  const cores = useUi((s) => s.diag?.logicalCores ?? 1);
  const tail = useTails((s) => s.tails[id]);
  if (!meta) return null;

  const lamp = fleetLamp(rt, a);
  const live = isLive(rt);
  const uptime = formatUptime(rt?.startedAt, live ? null : rt?.endedAt, Date.now());
  return (
    <div
      ref={tileRef}
      data-tile={id}
      role="button"
      tabIndex={selected ? 0 : -1}
      aria-label={`${meta.name}: ${LAMP_LABEL[lamp]}`}
      className={`attn-tile attn-tile--${lamp}${selected ? " is-selected" : ""}${a?.unread ? " is-unread" : ""}`}
      onClick={() => onJump(id)}
      onFocus={() => onSelect(id)}
      onContextMenu={(e) => onMenu(e, id)}
    >
      <div className="attn-tile-head">
        <span className={`attn-lamp attn-lamp--${lamp}`} title={LAMP_LABEL[lamp]} />
        <span className="attn-tile-glyph">
          <AgentGlyph agent={meta.agent} size={12} />
        </span>
        <span className="attn-tile-name" title={meta.name}>
          {meta.name}
        </span>
        {a?.unread && <span className="attn-badge-dot" />}
        {profile && (
          <span className="chip attn-tile-account" title={`Claude profile: ${profile.name}`}>
            <span className="dot" style={{ background: profile.color }} />
            {profile.name}
          </span>
        )}
        <MeterChip sessionId={id} variant="tile" />
      </div>
      <div className="attn-tile-meta">
        <span>{LAMP_LABEL[lamp]}</span>
        {group && <span>{group}</span>}
        {uptime && <span title={live ? "Uptime" : "Ran for"}>{uptime}</span>}
        {live && stats && (
          <span title="CPU (share of all cores) · RAM of the process tree">
            {formatCpu(taskManagerCpu(stats.cpuPercent, cores))} · {formatMb(stats.memoryBytes)}
          </span>
        )}
      </div>
      {a?.lastMessage && (
        <div className="attn-tile-msg" title={a.lastMessage}>
          {a.lastMessage}
        </div>
      )}
      <pre className="attn-tile-tail mono">{tail?.length ? tail.join("\n") : live ? " " : ""}</pre>
    </div>
  );
});
