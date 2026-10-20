// SESSION LOG: streams the activity store (newest at the bottom). Auto-scrolls unless the user scrolled
// up; filter all / needs-you / errors / lifecycle; scope this workspace / everything. Folds to its head line
// (which then shows the newest event) and is resizable from its top edge (drag, or arrows on the handle);
// both are remembered on this device. Short windows start folded, so the canvas above gets the room.

import { memo, useLayoutEffect, useMemo, useRef, useState, type KeyboardEvent, type PointerEvent } from "react";
import type { SessionId } from "../../lib/types";
import { roleTag } from "../../lib/roles";
import { useT, type MessageKey, type Translator } from "../../i18n";
import { ACTIVITY_LIMIT, activityResultText, activityText, matchesActivityFilter, useActivity, type ActivityEvent, type ActivityFilter, type ActivityKind } from "../../store/activity";
import { clampLogHeight, usePref } from "./mcPrefs";
import { roleStyle } from "./RoleTag";

const FILTERS: { id: ActivityFilter; label: MessageKey }[] = [
  { id: "all", label: "activity.filter.all" },
  { id: "needs", label: "activity.filter.needs" },
  { id: "errors", label: "activity.filter.errors" },
  { id: "lifecycle", label: "activity.filter.lifecycle" },
];

const KIND_KEYS: Record<ActivityKind, MessageKey> = {
  lifecycle: "activity.kind.lifecycle",
  attention: "activity.kind.attention",
  broadcast: "activity.kind.broadcast",
  formation: "activity.kind.formation",
  worktree: "activity.kind.worktree",
  mission: "activity.kind.mission",
  tests: "activity.kind.tests",
  merge: "activity.kind.merge",
  browser: "activity.kind.browser",
};

export function formatClock(ms: number): string {
  const d = new Date(ms);
  const two = (n: number) => String(n).padStart(2, "0");
  return `${two(d.getHours())}:${two(d.getMinutes())}:${two(d.getSeconds())}`;
}

function who(e: ActivityEvent, t: Translator): string {
  const kind = KIND_KEYS[e.kind] ? t(KIND_KEYS[e.kind]) : e.kind;
  const tag = e.role ? roleTag(e.role).toLowerCase() : (e.agent ?? kind);
  return e.sessionId ? `${tag} · ${e.sessionName}` : kind;
}

export const SessionLog = memo(function SessionLog({ workspaceIds }: { workspaceIds: Set<SessionId> }) {
  const t = useT();
  const events = useActivity((s) => s.events);
  const [filter, setFilter] = useState<ActivityFilter>("all");
  const [scope, setScope] = useState<"workspace" | "all">("workspace");
  const body = useRef<HTMLDivElement>(null);
  const stick = useRef(true);
  const [unseen, setUnseen] = useState(false);
  const [open, setOpen] = usePref<boolean>("logOpen", () => window.innerHeight >= 900);
  const [savedHeight, saveHeight] = usePref<number>("logHeight", () => (window.innerHeight > 860 ? 190 : 140));
  const [dragHeight, setDragHeight] = useState<number | null>(null);
  const drag = useRef<{ y: number; h: number } | null>(null);
  const height = clampLogHeight(dragHeight ?? savedHeight, window.innerHeight);

  const rows = useMemo(
    () =>
      events.filter(
        (e) => matchesActivityFilter(e, filter) && (scope === "all" || e.sessionId === null || workspaceIds.has(e.sessionId)),
      ),
    [events, filter, scope, workspaceIds],
  );

  useLayoutEffect(() => {
    const el = body.current;
    if (!el) return;
    if (stick.current) {
      el.scrollTop = el.scrollHeight;
      setUnseen(false);
    } else setUnseen(true);
  }, [rows, open]);

  // ---- resize from the top edge -----------------------------------------------------------------
  const onHandleDown = (e: PointerEvent<HTMLDivElement>) => {
    if (e.button !== 0) return;
    e.preventDefault();
    e.currentTarget.setPointerCapture(e.pointerId);
    drag.current = { y: e.clientY, h: height };
    setDragHeight(height);
  };
  const onHandleMove = (e: PointerEvent<HTMLDivElement>) => {
    const d = drag.current;
    if (d) setDragHeight(clampLogHeight(d.h + (d.y - e.clientY), window.innerHeight));
  };
  const onHandleUp = () => {
    if (!drag.current) return;
    drag.current = null;
    if (dragHeight !== null) saveHeight(dragHeight);
    setDragHeight(null);
  };
  const onHandleKey = (e: KeyboardEvent<HTMLDivElement>) => {
    if (e.key === "Escape") return; // Mission Control closes
    e.stopPropagation(); // card shortcuts (R, S, Del…) never act from the handle
    if (e.key !== "ArrowUp" && e.key !== "ArrowDown") return;
    e.preventDefault();
    saveHeight(clampLogHeight(height + (e.key === "ArrowUp" ? 24 : -24), window.innerHeight));
  };
  const newest = rows[rows.length - 1];

  const onScroll = () => {
    const el = body.current;
    if (!el) return;
    stick.current = el.scrollTop + el.clientHeight >= el.scrollHeight - 8;
    if (stick.current) setUnseen(false);
  };

  const jumpEnd = () => {
    const el = body.current;
    if (!el) return;
    stick.current = true;
    el.scrollTop = el.scrollHeight;
    setUnseen(false);
  };

  if (!open)
    return (
      <section className="mc-log is-folded" aria-label={t("activity.log.label")}>
        <div className="mc-log-head">
          <button type="button" className="mc-fold" aria-expanded={false} aria-label={t("activity.log.show")} title={t("activity.log.show")} onClick={() => setOpen(true)}>
            ▸
          </button>
          <span className="mc-micro">{t("activity.log.title")}</span>
          {newest ? (
            <button type="button" className={`mc-log-latest is-${newest.level}`} title={t("activity.log.latestTitle", { message: activityText(newest) })} onClick={() => setOpen(true)}>
              <span className="mc-log-time">{formatClock(newest.at)}</span>
              <span className="mc-log-who" style={newest.role ? roleStyle(newest.role) : undefined}>
                {who(newest, t)}
              </span>
              <span className="mc-log-msg">{activityText(newest)}</span>
            </button>
          ) : (
            <span className="mc-log-latest mc-log-empty-inline">{t("activity.log.noEventsInline")}</span>
          )}
          <span className="mc-micro mc-log-count">{t("activity.log.count", { count: rows.length })}</span>
        </div>
      </section>
    );

  return (
    <section className="mc-log" aria-label={t("activity.log.label")} style={{ height }}>
      <div
        className={`mc-log-resize${dragHeight !== null ? " is-dragging" : ""}`}
        role="separator"
        aria-orientation="horizontal"
        aria-label={t("activity.log.resize")}
        aria-valuenow={height}
        tabIndex={0}
        title={t("activity.log.resizeHint")}
        onPointerDown={onHandleDown}
        onPointerMove={onHandleMove}
        onPointerUp={onHandleUp}
        onPointerCancel={onHandleUp}
        onKeyDown={onHandleKey}
      />
      <div className="mc-log-head">
        <button type="button" className="mc-fold" aria-expanded aria-label={t("activity.log.fold")} title={t("activity.foldHint")} onClick={() => setOpen(false)}>
          ▾
        </button>
        <span className="mc-micro">{t("activity.log.title")}</span>
        <div className="mc-seg" role="radiogroup" aria-label={t("activity.log.filterAria")}>
          {FILTERS.map((f) => (
            <button key={f.id} type="button" role="radio" aria-checked={filter === f.id} onClick={() => {
                stick.current = true;
                setFilter(f.id);
              }}>
              {t(f.label)}
            </button>
          ))}
        </div>
        <div className="mc-seg" role="radiogroup" aria-label={t("activity.log.scopeAria")}>
          <button type="button" role="radio" aria-checked={scope === "workspace"} onClick={() => {
              stick.current = true;
              setScope("workspace");
            }}>
            {t("activity.log.scopeWorkspace")}
          </button>
          <button type="button" role="radio" aria-checked={scope === "all"} onClick={() => {
              stick.current = true;
              setScope("all");
            }}>
            {t("activity.log.scopeAll")}
          </button>
        </div>
        <span className="mc-micro mc-log-count">{t("activity.log.countMemory", { count: rows.length, limit: ACTIVITY_LIMIT })}</span>
        {unseen && (
          <button type="button" className="mc-btn mc-log-jump" onClick={jumpEnd}>
            {t("activity.log.newEvents")}
          </button>
        )}
      </div>
      <div ref={body} className="mc-log-body" onScroll={onScroll} role="log" aria-live="off">
        {rows.length === 0 && <div className="mc-log-empty">{t("activity.log.empty")}</div>}
        {rows.map((e) => (
          <div key={e.seq} className={`mc-log-row is-${e.level}`}>
            <span className="mc-log-time">{formatClock(e.at)}</span>
            <span className="mc-log-who" style={e.role ? roleStyle(e.role) : undefined} title={e.sessionName}>
              {who(e, t)}
            </span>
            <span className="mc-log-msg" title={activityText(e)}>
              {activityText(e)}
            </span>
            <span className="mc-log-res">{activityResultText(e.result)}</span>
          </div>
        ))}
      </div>
    </section>
  );
});
