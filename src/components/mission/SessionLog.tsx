// SESSION LOG: streams the activity store (newest at the bottom). Auto-scrolls unless the user scrolled
// up; filter all / needs-you / errors / lifecycle; scope this workspace / everything.

import { memo, useLayoutEffect, useMemo, useRef, useState } from "react";
import type { SessionId } from "../../lib/types";
import { roleTag } from "../../lib/roles";
import { matchesActivityFilter, useActivity, type ActivityEvent, type ActivityFilter } from "../../store/activity";
import { roleStyle } from "./RoleTag";

const FILTERS: { id: ActivityFilter; label: string }[] = [
  { id: "all", label: "all" },
  { id: "needs", label: "needs-you" },
  { id: "errors", label: "errors" },
  { id: "lifecycle", label: "lifecycle" },
];

export function formatClock(ms: number): string {
  const d = new Date(ms);
  const two = (n: number) => String(n).padStart(2, "0");
  return `${two(d.getHours())}:${two(d.getMinutes())}:${two(d.getSeconds())}`;
}

function who(e: ActivityEvent): string {
  const tag = e.role ? roleTag(e.role).toLowerCase() : (e.agent ?? e.kind);
  return e.sessionId ? `${tag} · ${e.sessionName}` : e.kind;
}

export const SessionLog = memo(function SessionLog({ workspaceIds }: { workspaceIds: Set<SessionId> }) {
  const events = useActivity((s) => s.events);
  const [filter, setFilter] = useState<ActivityFilter>("all");
  const [scope, setScope] = useState<"workspace" | "all">("workspace");
  const body = useRef<HTMLDivElement>(null);
  const stick = useRef(true);
  const [unseen, setUnseen] = useState(false);

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
  }, [rows]);

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

  return (
    <section className="mc-log" aria-label="Session log">
      <div className="mc-log-head">
        <span className="mc-micro">session log</span>
        <div className="mc-seg" role="radiogroup" aria-label="Log filter">
          {FILTERS.map((f) => (
            <button key={f.id} type="button" role="radio" aria-checked={filter === f.id} onClick={() => {
                stick.current = true;
                setFilter(f.id);
              }}>
              {f.label}
            </button>
          ))}
        </div>
        <div className="mc-seg" role="radiogroup" aria-label="Log scope">
          <button type="button" role="radio" aria-checked={scope === "workspace"} onClick={() => {
              stick.current = true;
              setScope("workspace");
            }}>
            this workspace
          </button>
          <button type="button" role="radio" aria-checked={scope === "all"} onClick={() => {
              stick.current = true;
              setScope("all");
            }}>
            everything
          </button>
        </div>
        <span className="mc-micro">{rows.length} events · in-memory, last 500</span>
        {unseen && (
          <button type="button" className="mc-btn mc-log-jump" onClick={jumpEnd}>
            ↓ new events
          </button>
        )}
      </div>
      <div ref={body} className="mc-log-body" onScroll={onScroll} role="log" aria-live="off">
        {rows.length === 0 && <div className="mc-log-empty">No events yet. Starts, exits, attention changes, broadcasts and formations appear here.</div>}
        {rows.map((e) => (
          <div key={e.seq} className={`mc-log-row is-${e.level}`}>
            <span className="mc-log-time">{formatClock(e.at)}</span>
            <span className="mc-log-who" style={e.role ? roleStyle(e.role) : undefined} title={e.sessionName}>
              {who(e)}
            </span>
            <span className="mc-log-msg" title={e.message}>
              {e.message}
            </span>
            <span className="mc-log-res">{e.result ?? ""}</span>
          </div>
        ))}
      </div>
    </section>
  );
});
