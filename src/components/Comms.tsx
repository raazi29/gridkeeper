// "Comms": compact notification center. A bell button in the status bar (unread count) opens a
// popover with the last 100 attention events across all workspaces; click one to jump to it.

import { useEffect, useMemo, useRef } from "react";
import { jumpToSession } from "../actions/commands";
import { toggleDnd, useDnd } from "../actions/notifyPrefs";
import { useApp } from "../store/appStore";
import { useUi } from "../store/uiStore";
import { IconBellOff } from "./MutedGlyph";
import { useContextMenu } from "./ui/Menu";
import { openAppMenu } from "./ContextMenuHost";
import { buildSessionMenu } from "./menus/sessionMenu";
import { countUnread, useAttention, useAttentionUi, type FeedItem } from "../store/attention";
import { useShortcut, withShortcut } from "./hooks";
import { IconBell, IconFleet } from "./AttentionBits";
import "../styles/attention.css";

const HOLD_MS = 550;

export function CommsButton() {
  const unread = useAttention((s) => countUnread(s.sessions));
  const open = useAttentionUi((s) => s.commsOpen);
  const dnd = useDnd();
  const menu = useContextMenu();
  // Click-and-hold toggles Do not disturb; the click that ends the hold must not open the panel.
  const hold = useRef<{ timer?: number; fired: boolean }>({ fired: false });
  useEffect(() => () => window.clearTimeout(hold.current.timer), []);
  const cancelHold = () => window.clearTimeout(hold.current.timer);
  const openMenu = (e: { clientX: number; clientY: number; preventDefault?: () => void }) =>
    menu.open(e, [
      { label: dnd ? "Turn off Do not disturb" : "Do not disturb", hint: "hold the bell", onSelect: () => toggleDnd() },
      { label: "Mark all read", onSelect: () => useAttention.getState().markAllRead() },
      "separator",
      { label: "Notification settings…", onSelect: () => useUi.getState().openDialog({ kind: "settings", section: "notifications" }) },
    ]);
  const base = unread ? `Comms — ${unread} session${unread === 1 ? "" : "s"} need${unread === 1 ? "s" : ""} attention` : "Comms — recent alerts";
  return (
    <>
      <button
        type="button"
        className={`sb-item sb-btn attn-sb-btn${unread ? " has-unread" : ""}${open ? " is-active" : ""}${dnd ? " is-dnd" : ""}`}
        title={`${base}${dnd ? "\nDo not disturb is on" : ""}\nHold or right-click for Do not disturb`}
        aria-label={dnd ? "Comms (do not disturb)" : "Comms"}
        aria-expanded={open}
        data-comms-toggle=""
        onPointerDown={(e) => {
          if (e.button !== 0) return;
          hold.current.fired = false;
          cancelHold();
          hold.current.timer = window.setTimeout(() => {
            hold.current.fired = true;
            toggleDnd();
          }, HOLD_MS);
        }}
        onPointerUp={cancelHold}
        onPointerLeave={cancelHold}
        onContextMenu={openMenu}
        onKeyDown={(e) => {
          if (e.key === "ContextMenu" || (e.shiftKey && e.key === "F10")) {
            e.preventDefault();
            const r = e.currentTarget.getBoundingClientRect();
            openMenu({ clientX: r.left, clientY: r.top - 4 });
          }
        }}
        onClick={() => {
          if (hold.current.fired) {
            hold.current.fired = false;
            return;
          }
          useAttentionUi.getState().toggleComms();
        }}
      >
        {dnd ? <IconBellOff size={13} /> : <IconBell size={13} />}
        {unread > 0 && <span className="attn-count">{unread}</span>}
      </button>
      {menu.element}
    </>
  );
}

export function FleetButton() {
  const sc = useShortcut("view.fleet");
  return (
    <button type="button" className="sb-item sb-btn attn-sb-btn" title={withShortcut("Fleet overview", sc)} aria-label="Fleet overview" onClick={() => useAttentionUi.getState().open("fleet")}>
      <IconFleet size={13} />
      <span>Fleet</span>
    </button>
  );
}

function ago(at: number, now: number): string {
  const s = Math.max(0, Math.round((now - at) / 1000));
  if (s < 45) return "now";
  const m = Math.round(s / 60);
  if (m < 60) return `${m}m`;
  const h = Math.round(m / 60);
  return h < 24 ? `${h}h` : `${Math.round(h / 24)}d`;
}

function DndChip() {
  const dnd = useDnd();
  return (
    <button
      type="button"
      className={`chip attn-dnd-chip${dnd ? " is-on" : ""}`}
      aria-pressed={dnd}
      title={dnd ? "Do not disturb is on: alerts collect here silently" : "Do not disturb: collect alerts here without toasts or sounds"}
      onClick={() => toggleDnd()}
    >
      {dnd ? <IconBellOff size={11} /> : <IconBell size={11} />}
      {dnd ? "DND on" : "DND"}
    </button>
  );
}

const KIND_LABEL: Record<FeedItem["kind"], string> = { waiting: "Needs you", done: "Done", error: "Error" };

export function CommsPanel() {
  const feed = useAttention((s) => s.feed);
  const sessions = useApp((s) => s.persisted.sessions);
  const workspaces = useApp((s) => s.persisted.workspaces);
  const ref = useRef<HTMLDivElement>(null);
  const close = () => useAttentionUi.getState().toggleComms(false);

  const where = useMemo(() => {
    const m = new Map<string, { name: string; ws: string }>();
    const names = new Map(sessions.map((x) => [x.id, x.name]));
    for (const w of workspaces) for (const g of w.groups) for (const id of g.sessionIds) m.set(id, { name: names.get(id) ?? "Session", ws: w.name });
    return m;
  }, [sessions, workspaces]);

  useEffect(() => {
    ref.current?.querySelector<HTMLElement>(".attn-feed-row, button")?.focus();
    const onDown = (e: MouseEvent) => {
      const t = e.target as HTMLElement;
      if (ref.current?.contains(t) || t.closest("[data-comms-toggle], .menu-root")) return;
      close();
    };
    const onKey = (e: KeyboardEvent) => {
      if ((document.activeElement as HTMLElement | null)?.closest(".menu-root")) return; // a row's context menu handles its keys
      if (e.key === "Escape") {
        e.preventDefault();
        e.stopPropagation();
        close();
      } else if ((e.key === "ArrowDown" || e.key === "ArrowUp") && ref.current?.contains(document.activeElement)) {
        e.preventDefault();
        const rows = [...(ref.current?.querySelectorAll<HTMLElement>(".attn-feed-row") ?? [])];
        const i = rows.indexOf(document.activeElement as HTMLElement);
        rows[e.key === "ArrowDown" ? Math.min(rows.length - 1, i + 1) : Math.max(0, i - 1)]?.focus();
      }
    };
    window.addEventListener("mousedown", onDown, true);
    window.addEventListener("keydown", onKey, true);
    return () => {
      window.removeEventListener("mousedown", onDown, true);
      window.removeEventListener("keydown", onKey, true);
    };
  }, []);

  const now = Date.now();
  const items = [...feed].reverse();
  return (
    <div ref={ref} className="attn-comms" role="dialog" aria-label="Comms">
      <div className="attn-comms-head">
        <span className="attn-comms-title">Comms</span>
        <span className="attn-comms-sub">{feed.length ? `${feed.length} recent` : ""}</span>
        <span className="attn-spacer" />
        <DndChip />
        <button type="button" className="chip" onClick={() => useAttention.getState().markAllRead()}>
          Mark all read
        </button>
        <button type="button" className="chip" disabled={!feed.length} onClick={() => useAttention.getState().clearFeed()}>
          Clear
        </button>
      </div>
      <div className="attn-feed" role="list">
        {items.length === 0 && <div className="attn-empty">All quiet. Alerts from every workspace show up here.</div>}
        {items.map((f) => {
          const w = where.get(f.id);
          return (
            <button
              key={f.seq}
              type="button"
              role="listitem"
              className={`attn-feed-row${f.muted ? " is-muted" : ""}`}
              title={f.muted ? `Not notified: ${f.mutedReason ?? "muted"}` : undefined}
              onClick={() => {
                close();
                jumpToSession(f.id);
              }}
              onContextMenu={(e) => {
                e.preventDefault();
                openAppMenu(e.clientX, e.clientY, buildSessionMenu(f.id, { surface: "comms", onNavigate: close }));
              }}
            >
              <span className={`attn-lamp attn-lamp--${f.kind} attn-still`} aria-label={KIND_LABEL[f.kind]} />
              <span className="attn-feed-main">
                <span className="attn-feed-who">
                  <span className="attn-feed-name">{w?.name ?? "Session"}</span>
                  {w?.ws && <span className="attn-feed-ws">{w.ws}</span>}
                  {f.muted && (
                    <span className="attn-feed-muted">
                      <IconBellOff size={10} />
                      {f.mutedReason ?? "Muted"}
                    </span>
                  )}
                </span>
                <span className="attn-feed-msg">{f.message}</span>
              </span>
              <span className="attn-feed-time" title={new Date(f.at).toLocaleTimeString()}>
                {ago(f.at, now)}
              </span>
            </button>
          );
        })}
      </div>
    </div>
  );
}
