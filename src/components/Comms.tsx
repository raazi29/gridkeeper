// "Comms": compact notification center. A bell button in the status bar (unread count) opens a
// popover with the last 100 attention events across all workspaces; click one to jump to it.

import { useEffect, useMemo, useRef } from "react";
import { jumpToSession } from "../actions/commands";
import { useApp } from "../store/appStore";
import { countUnread, useAttention, useAttentionUi, type FeedItem } from "../store/attention";
import { useShortcut, withShortcut } from "./hooks";
import { IconBell, IconFleet } from "./AttentionBits";
import "../styles/attention.css";

export function CommsButton() {
  const unread = useAttention((s) => countUnread(s.sessions));
  const open = useAttentionUi((s) => s.commsOpen);
  return (
    <button
      type="button"
      className={`sb-item sb-btn attn-sb-btn${unread ? " has-unread" : ""}${open ? " is-active" : ""}`}
      title={unread ? `Comms — ${unread} session${unread === 1 ? "" : "s"} need${unread === 1 ? "s" : ""} attention` : "Comms — recent alerts"}
      aria-label="Comms"
      aria-expanded={open}
      data-comms-toggle=""
      onClick={() => useAttentionUi.getState().toggleComms()}
    >
      <IconBell size={13} />
      {unread > 0 && <span className="attn-count">{unread}</span>}
    </button>
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
      if (ref.current?.contains(t) || t.closest("[data-comms-toggle]")) return;
      close();
    };
    const onKey = (e: KeyboardEvent) => {
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
              className="attn-feed-row"
              onClick={() => {
                close();
                jumpToSession(f.id);
              }}
            >
              <span className={`attn-lamp attn-lamp--${f.kind} attn-still`} aria-label={KIND_LABEL[f.kind]} />
              <span className="attn-feed-main">
                <span className="attn-feed-who">
                  <span className="attn-feed-name">{w?.name ?? "Session"}</span>
                  {w?.ws && <span className="attn-feed-ws">{w.ws}</span>}
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
