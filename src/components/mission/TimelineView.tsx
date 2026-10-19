// Timeline view: one row per agent (grouped by lane), coloured by what it was doing over time (working / needs you /
// done / idle / error / not running, from the state history recorded since the app started), with markers for
// tasks turned done and messages delivered (broadcast, hand-off, lead control, briefs). A live "now" line; the
// range follows now (presets 5m–4h, all) until you zoom (Ctrl+wheel around the pointer, + / −) or pan (drag,
// Shift+wheel). Re-renders with the Mission Control clock (once a second while visible); no timers of its own.

import { memo, useEffect, useMemo, useRef, useState, type KeyboardEvent, type MutableRefObject, type PointerEvent as RPointerEvent } from "react";
import type { SessionId } from "../../lib/types";
import { useActivity, type ActivityEvent } from "../../store/activity";
import { useApp } from "../../store/appStore";
import { useDeck } from "../../store/missionDeck";
import { useStateHistory, type HistoryState } from "../../store/stateHistory";
import { formatDuration } from "../../store/attention";
import type { FleetLamp } from "../util/fleet";
import { inSpotlight, matchesFilters } from "./deck";
import { T } from "./mcText";
import { RoleTag, roleStyle } from "./RoleTag";
import { formatClock } from "./SessionLog";
import { frac, liveRange, panRange, RANGE_PRESETS, segmentsFor, tickLabel, ticks, zoomRange, type TimeRange } from "./timeline";
import "../../styles/mcViews.css";

export interface TimelineAgent {
  id: SessionId;
  lane: string;
  laneName: string;
}

export interface TimelineViewProps {
  agents: TimelineAgent[];
  lamps: Record<SessionId, FleetLamp>;
  roles: Record<SessionId, string | null>;
  selected: SessionId | null;
  multi: SessionId[];
  now: number;
  onSelect: (id: SessionId, e: { ctrlKey: boolean; metaKey: boolean; shiftKey: boolean }) => void;
  onJump: (id: SessionId) => void;
  keys: MutableRefObject<((e: KeyboardEvent) => boolean) | null>;
}

const DEFAULT_SPAN = 15 * 60_000;
const LEGEND: HistoryState[] = ["working", "waiting", "done", "idle", "error", "off"];

function isMessage(e: ActivityEvent): boolean {
  return (e.kind === "broadcast" || e.kind === "mission") && e.level !== "error" && /^(sent|auto-sent|handoff)$/.test(e.result ?? "");
}

export const TimelineView = memo(function TimelineView(p: TimelineViewProps) {
  const history = useStateHistory((s) => s.bySession);
  const marks = useStateHistory((s) => s.marks);
  const events = useActivity((s) => s.events);
  const names = useApp((s) => p.agents.map((a) => s.persisted.sessions.find((m) => m.id === a.id)?.name ?? "").join("\u0000"));
  const filters = useDeck((s) => s.filters);
  const spotlight = useDeck((s) => s.spotlight);
  const current = useDeck((s) => s.findCurrent);
  const [span, setSpan] = useState(DEFAULT_SPAN);
  const [fixed, setFixed] = useState<TimeRange | null>(null); // null = follow now
  const [trackW, setTrackW] = useState(800);
  const tracks = useRef<HTMLDivElement>(null);
  const drag = useRef<{ id: number; x: number; r: TimeRange } | null>(null);

  const earliest = useMemo(() => {
    let t = Infinity;
    for (const a of p.agents) {
      const h = history[a.id];
      if (h?.length) t = Math.min(t, h[0].at);
    }
    return Number.isFinite(t) ? t : p.now - DEFAULT_SPAN;
  }, [history, p.agents, p.now]);

  const range: TimeRange = fixed ?? liveRange(span, p.now);
  const live = fixed === null;
  const nameList = names.split("\u0000");

  // Track width for the tick count (ResizeObserver, no polling).
  useEffect(() => {
    const el = tracks.current;
    if (!el) return;
    const ro = new ResizeObserver(() => setTrackW(Math.max(200, el.clientWidth - 188)));
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  const zoom = (factor: number, at?: number) => {
    const r = zoomRange(range, factor, at ?? (live ? p.now : (range.from + range.to) / 2));
    if (live && at === undefined) {
      setSpan(r.to - r.from);
      return;
    }
    setFixed(r.to >= p.now ? null : r);
    if (r.to >= p.now) setSpan(r.to - r.from);
  };
  const showAll = () => {
    setFixed(null);
    setSpan(Math.max(60_000, p.now - earliest + 30_000));
  };

  // Keys from Mission Control (+ / − / 0 / F) while this view is shown.
  const keyRef = useRef(p.keys);
  keyRef.current = p.keys;
  const handlers = useRef({ zoom, showAll, reset: () => (setFixed(null), setSpan(DEFAULT_SPAN)) });
  handlers.current = { zoom, showAll, reset: () => (setFixed(null), setSpan(DEFAULT_SPAN)) };
  useEffect(() => {
    const keys = keyRef.current;
    keys.current = (e) => {
      if (e.ctrlKey || e.metaKey || e.altKey) return false;
      if (e.key === "+" || e.key === "=") handlers.current.zoom(0.7);
      else if (e.key === "-" || e.key === "_") handlers.current.zoom(1 / 0.7);
      else if (e.key === "0") handlers.current.reset();
      else if (e.key === "f" || e.key === "F") handlers.current.showAll();
      else return false;
      return true;
    };
    return () => {
      keys.current = null;
    };
  }, []);

  // Ctrl+wheel zooms the time axis around the pointer; Shift+wheel pans (non-passive: no WebView zoom).
  useEffect(() => {
    const el = tracks.current;
    if (!el) return;
    const onWheel = (e: WheelEvent) => {
      const zoomIt = e.ctrlKey || e.metaKey;
      if (!zoomIt && !e.shiftKey) return;
      const lane = el.querySelector<HTMLElement>(".tl-axis-track");
      if (!lane) return;
      e.preventDefault();
      const r = lane.getBoundingClientRect();
      const cur = rangeRef.current;
      const at = cur.from + ((e.clientX - r.left) / Math.max(1, r.width)) * (cur.to - cur.from);
      if (zoomIt) handlers.current.zoom(Math.exp(Math.max(-300, Math.min(300, e.deltaY)) * 0.002), at);
      else {
        const d = (e.deltaY || e.deltaX) / Math.max(1, r.width);
        const next = panRange(cur, d * (cur.to - cur.from), nowRef.current);
        setFixed(next.to >= nowRef.current ? null : next);
      }
    };
    el.addEventListener("wheel", onWheel, { passive: false });
    return () => el.removeEventListener("wheel", onWheel);
  }, []);
  const rangeRef = useRef(range);
  rangeRef.current = range;
  const nowRef = useRef(p.now);
  nowRef.current = p.now;

  const onDown = (e: RPointerEvent<HTMLDivElement>) => {
    if (e.button !== 0 || !(e.target as HTMLElement).closest(".tl-track, .tl-axis-track")) return;
    e.currentTarget.setPointerCapture(e.pointerId);
    drag.current = { id: e.pointerId, x: e.clientX, r: range };
  };
  const onMove = (e: RPointerEvent<HTMLDivElement>) => {
    const d = drag.current;
    if (!d || d.id !== e.pointerId) return;
    const lane = tracks.current?.querySelector<HTMLElement>(".tl-axis-track");
    const w = lane?.clientWidth ?? 1;
    const dt = (-(e.clientX - d.x) / w) * (d.r.to - d.r.from);
    if (Math.abs(e.clientX - d.x) < 3) return;
    const next = panRange(d.r, dt, p.now);
    setFixed(next.to >= p.now ? null : next);
  };
  const onUp = (e: RPointerEvent<HTMLDivElement>) => {
    if (drag.current?.id === e.pointerId) drag.current = null;
  };

  const tickList = ticks(range, Math.max(2, Math.floor(trackW / 90)));
  const nowF = frac(range, p.now);
  const pct = (t: number) => `${(frac(range, t) * 100).toFixed(3)}%`;
  const msgs = events.filter((e) => e.sessionId && e.at >= range.from && e.at <= range.to && isMessage(e));
  const tasksDone = marks.filter((m) => m.at >= range.from && m.at <= range.to);
  const anyHistory = p.agents.some((a) => (history[a.id]?.length ?? 0) > 0);

  let lastLane = "";
  return (
    <div className="tl" role="region" aria-label={T.timeline.label}>
      <div className="tl-bar">
        <div className="mc-seg" role="radiogroup" aria-label="Time range">
          {RANGE_PRESETS.map((r) => (
            <button key={r.label} type="button" role="radio" aria-checked={live && Math.abs(span - r.ms) < 1000} onClick={() => (setFixed(null), setSpan(r.ms))}>
              {r.label}
            </button>
          ))}
          <button type="button" role="radio" aria-checked={false} title={T.timeline.allHint} onClick={showAll}>
            {T.timeline.all}
          </button>
        </div>
        <button type="button" className={`mc-btn tl-live${live ? " is-on" : ""}`} aria-pressed={live} title={T.timeline.liveHint} onClick={() => setFixed(null)}>
          <span className="tl-live-dot" />
          {T.timeline.live}
        </button>
        <span className="mc-micro tl-span">{formatDuration(range.to - range.from)}</span>
        <span className="mc-spacer" />
        <span className="tl-legend" aria-label="Colours">
          {LEGEND.map((s) => (
            <span key={s} className="tl-legend-item">
              <span className={`tl-legend-sq is-${s}`} />
              {T.timeline.legend[s]}
            </span>
          ))}
          <span className="tl-legend-item">
            <span className="tl-mark-glyph is-task">◆</span>task done
          </span>
          <span className="tl-legend-item">
            <span className="tl-mark-glyph is-msg">▾</span>message
          </span>
        </span>
      </div>
      <div ref={tracks} className="tl-grid" title={T.timeline.zoomHint} onPointerDown={onDown} onPointerMove={onMove} onPointerUp={onUp} onPointerCancel={onUp}>
        <div className="tl-axis">
          <div className="tl-label tl-axis-label mc-micro">{formatClock(range.from)} → {live ? T.timeline.now : formatClock(range.to)}</div>
          <div className="tl-axis-track">
            {tickList.map((t) => (
              <span key={t.t} className="tl-tick" style={{ left: pct(t.t) }}>
                {tickLabel(t.t, t.step)}
              </span>
            ))}
            {nowF >= 0 && nowF <= 1.0001 && <span className="tl-now-label" style={{ left: pct(p.now) }}>{T.timeline.now}</span>}
          </div>
        </div>
        {!anyHistory && <div className="mc-empty tl-nohist">{T.timeline.noHistory}</div>}
        {p.agents.map((a, i) => {
          const laneRow = a.lane !== lastLane ? (
            <div key={`lane:${a.lane}`} className="tl-lane mc-micro">
              {a.laneName}
            </div>
          ) : null;
          lastLane = a.lane;
          const segs = segmentsFor(history[a.id] ?? [], range.from, range.to, p.now);
          const lamp = p.lamps[a.id] ?? "stopped";
          const role = p.roles[a.id] ?? null;
          const dim = !inSpotlight(spotlight, a.id, a.lane) || !matchesFilters(filters, role, lamp);
          const sel = p.selected === a.id || p.multi.includes(a.id);
          return (
            <div key={a.id} className="tl-rowwrap">
              {laneRow}
              <div className={`tl-row${dim ? " is-dim" : ""}${sel ? " is-selected" : ""}${current === `a:${a.id}` ? " is-hit" : ""}`} data-tl={a.id} style={roleStyle(role)}>
                <button type="button" className="tl-label" onClick={(e) => p.onSelect(a.id, e)} onDoubleClick={() => p.onJump(a.id)} title={`${nameList[i]} — click to select, double-click to jump`}>
                  <span className={`attn-lamp attn-lamp--${lamp}`} />
                  <span className="tl-name">{nameList[i]}</span>
                  <RoleTag role={role} glyphOnly />
                </button>
                <div className="tl-track" onClick={(e) => !drag.current && p.onSelect(a.id, e)}>
                  {segs.map((s) => (
                    <span
                      key={s.from}
                      className={`tl-seg is-${s.state}`}
                      style={{ left: pct(s.from), width: `${Math.max(0.15, (frac(range, s.to) - frac(range, s.from)) * 100).toFixed(3)}%` }}
                      title={`${T.timeline.legend[s.state]} · ${formatClock(s.from)}–${s.to >= p.now - 1500 ? T.timeline.now : formatClock(s.to)} (${formatDuration(s.to - s.from)})`}
                    />
                  ))}
                  {tasksDone
                    .filter((m) => m.sessionId === a.id)
                    .map((m, j) => (
                      <span key={`t${m.at}:${j}`} className="tl-mark is-task" style={{ left: pct(m.at) }} title={`${formatClock(m.at)} · ${T.timeline.taskDone(m.label)}`}>
                        ◆
                      </span>
                    ))}
                  {nowF >= 0 && nowF <= 1.0001 && <span className="tl-now" style={{ left: pct(p.now) }} aria-hidden="true" />}
                  {msgs
                    .filter((m) => m.sessionId === a.id)
                    .map((m) => (
                      <span key={`m${m.seq}`} className="tl-mark is-msg" style={{ left: pct(m.at) }} title={`${formatClock(m.at)} · ${m.message}`}>
                        ▾
                      </span>
                    ))}
                </div>
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
});
