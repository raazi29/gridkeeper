// Small attention indicators: pane-header lamp, group-tab / workspace unread badges, bell icon.
// Each subscribes to the attention store with a primitive-returning selector, so it re-renders only
// when its own number / state changes.

import { memo } from "react";
import { useShallow } from "zustand/react/shallow";
import type { SessionId } from "../lib/types";
import { useApp } from "../store/appStore";
import { countUnread, useAttention, type AttnState } from "../store/attention";
import "../styles/attention.css";

export const ATTN_LABEL: Record<AttnState, string> = {
  working: "Working",
  waiting: "Waiting for you",
  done: "Done",
  error: "Error",
  idle: "Idle",
};

/** Reduce-motion: a future `settings.reduceMotion` wins; otherwise CSS honours prefers-reduced-motion. */
function useReduceMotion(): boolean {
  return useApp((s) => (s.persisted.settings as { reduceMotion?: boolean }).reduceMotion === true);
}

/** Pane header lamp: working (pulse) / waiting for you / done / error, plus an unread dot. */
export const AttentionLamp = memo(function AttentionLamp({ sessionId }: { sessionId: SessionId }) {
  const state = useAttention((s) => s.sessions[sessionId]?.state ?? "idle");
  const unread = useAttention((s) => !!s.sessions[sessionId]?.unread);
  const message = useAttention((s) => s.sessions[sessionId]?.lastMessage);
  const still = useReduceMotion();
  if (state === "idle" && !unread) return null;
  const label = `${ATTN_LABEL[state]}${message ? ` — ${message}` : ""}${unread ? " (unread)" : ""}`;
  return (
    <span className="attn-lamp-wrap" title={label} aria-label={label} role="status">
      {state !== "idle" && <span className={`attn-lamp attn-lamp--${state}${still ? " attn-still" : ""}`} />}
      {unread && <span className="attn-badge-dot" />}
    </span>
  );
});

/** Unread count badge for a group tab. */
export const GroupUnreadBadge = memo(function GroupUnreadBadge({ groupId }: { groupId: string }) {
  const ids = useApp(
    useShallow((s) => {
      for (const w of s.persisted.workspaces) for (const g of w.groups) if (g.id === groupId) return g.sessionIds;
      return [] as SessionId[];
    }),
  );
  const n = useAttention((s) => countUnread(s.sessions, ids));
  if (n === 0) return null;
  return (
    <span className="attn-count" title={`${n} session${n === 1 ? "" : "s"} need${n === 1 ? "s" : ""} attention`}>
      {n}
    </span>
  );
});

/** Unread count badge for a sidebar workspace row (or a dot on the collapsed rail). */
export const WorkspaceUnreadBadge = memo(function WorkspaceUnreadBadge({ workspaceId, compact }: { workspaceId: string; compact?: boolean }) {
  const ids = useApp(
    useShallow((s) => s.persisted.workspaces.find((w) => w.id === workspaceId)?.groups.flatMap((g) => g.sessionIds) ?? []),
  );
  const n = useAttention((s) => countUnread(s.sessions, ids));
  if (n === 0) return null;
  const title = `${n} session${n === 1 ? "" : "s"} need${n === 1 ? "s" : ""} attention`;
  return compact ? <span className="attn-badge-dot attn-rail-dot" title={title} /> : (
    <span className="attn-count" title={title}>
      {n}
    </span>
  );
});

export const IconBell = ({ size = 14 }: { size?: number }) => (
  <svg width={size} height={size} viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth={1.4} strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
    <path d="M4 11V7.2a4 4 0 0 1 8 0V11l1.2 1.3H2.8z" />
    <path d="M6.6 13.6a1.5 1.5 0 0 0 2.8 0" />
  </svg>
);

export const IconFleet = ({ size = 14 }: { size?: number }) => (
  <svg width={size} height={size} viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth={1.4} strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
    <rect x="2" y="2.5" width="5" height="4.5" rx="1" />
    <rect x="9" y="2.5" width="5" height="4.5" rx="1" />
    <rect x="2" y="9" width="5" height="4.5" rx="1" />
    <rect x="9" y="9" width="5" height="4.5" rx="1" />
  </svg>
);

export const IconBroadcast = ({ size = 14 }: { size?: number }) => (
  <svg width={size} height={size} viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth={1.4} strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
    <circle cx="8" cy="8" r="1.4" />
    <path d="M5.2 5.2a4 4 0 0 0 0 5.6M10.8 5.2a4 4 0 0 1 0 5.6M3.1 3.1a7 7 0 0 0 0 9.8M12.9 3.1a7 7 0 0 1 0 9.8" />
  </svg>
);
