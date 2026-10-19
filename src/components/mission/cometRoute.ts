// Message comets, pure (unit-tested): which real activity events carry a message from one place to another in
// Mission Control — broadcasts, hand-offs, lead control deliveries, mission / lead briefs — and where the comet
// starts and lands. Sources are a session (by name or slug), the mission board, the top of the canvas (you) or
// the sign-off box (auto-review). Everything else is not a message and gets no comet.

import { slugify } from "../../lib/missionDoc";
import type { SessionId } from "../../lib/types";
import type { ActivityEvent } from "../../store/activity";

export type CometEnd = { session: SessionId } | { node: "top" | "mission" | "signoff" };

export interface CometRoute {
  from: CometEnd;
  to: SessionId;
}

/** `resolve` maps a sender token (a session name or its slug, "lead") to a session id in the workspace. */
export function cometFor(e: Pick<ActivityEvent, "sessionId" | "kind" | "level" | "message" | "result">, resolve: (token: string) => SessionId | null): CometRoute | null {
  if (!e.sessionId || e.level === "error") return null;
  const to = e.sessionId;
  const sent = e.result === "sent" || e.result === "auto-sent";
  if (!sent) return null;
  const fromToken = (token: string): CometEnd => {
    const id = resolve(token.trim()) ?? resolve(slugify(token));
    return id && id !== to ? { session: id } : { node: "mission" };
  };
  if (e.kind === "broadcast") {
    if (e.message.startsWith("broadcast:")) return { from: { node: "top" }, to };
    const h = /^hand-off from (.+?): /.exec(e.message);
    if (h) return { from: fromToken(h[1]), to };
    return null;
  }
  if (e.kind === "mission") {
    if (e.message.startsWith("mission brief:") || e.message.startsWith("lead control brief:")) return { from: { node: "mission" }, to };
    const lc = /^(.+?) → [^:]+: /.exec(e.message);
    if (lc) return lc[1] === "auto-review" ? { from: { node: "signoff" }, to } : { from: fromToken(lc[1]), to };
  }
  return null;
}
