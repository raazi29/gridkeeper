// Broadcast: send one line to several live sessions. Pure target-selection helpers (unit-tested) plus
// the sender. Nothing is ever sent without an explicit user action in the composer.

import { errorMessage, ipc } from "../lib/ipc";
import type { AgentKind, SessionId, Workspace } from "../lib/types";
import { isLive, type AppStore } from "../store/appStore";
import { recordBroadcast } from "../store/activity";
import { isTerminalMeta } from "../lib/browserPanes";

export interface BroadcastCandidate {
  id: SessionId;
  name: string;
  agent: AgentKind;
  workspaceId: string;
  workspaceName: string;
  groupId: string;
  groupName: string;
}

export type AgentFilter = "all" | AgentKind;
export const AGENT_FILTERS_ORDER: AgentFilter[] = ["all", "claude", "codex", "powershell", "generic"];

/** Every live session, in workspace -> group -> pane order. */
export function broadcastCandidates(s: Pick<AppStore, "persisted" | "runtime">): BroadcastCandidate[] {
  const metas = new Map(s.persisted.sessions.map((m) => [m.id, m]));
  const out: BroadcastCandidate[] = [];
  for (const w of s.persisted.workspaces)
    for (const g of w.groups)
      for (const id of g.sessionIds) {
        const m = metas.get(id);
        // Processes only: browser panes never receive keystrokes.
        if (!m || !isTerminalMeta(m) || !isLive(s.runtime[id])) continue;
        out.push({ id, name: m.name, agent: m.agent, workspaceId: w.id, workspaceName: w.name, groupId: g.id, groupName: g.name });
      }
  return out;
}

/** Default selection: the live sessions of the active group. */
export function defaultBroadcastTargets(candidates: BroadcastCandidate[], activeGroupId: string | undefined): SessionId[] {
  return candidates.filter((c) => c.groupId === activeGroupId).map((c) => c.id);
}

export function filterByAgent(candidates: BroadcastCandidate[], filter: AgentFilter): BroadcastCandidate[] {
  return filter === "all" ? candidates : candidates.filter((c) => c.agent === filter);
}

/** Selected ids that are still live candidates, in candidate order. */
export function resolveTargets(candidates: BroadcastCandidate[], selected: ReadonlySet<SessionId>): BroadcastCandidate[] {
  return candidates.filter((c) => selected.has(c.id));
}

export const CONFIRM_ABOVE = 3;

/** Why the send needs an extra confirmation (null = none needed). */
export function confirmationReason(targets: BroadcastCandidate[], activeWorkspaceId: string | null | undefined): string | null {
  const reasons: string[] = [];
  if (targets.length > CONFIRM_ABOVE) reasons.push(`${targets.length} sessions`);
  const others = new Set(targets.filter((t) => t.workspaceId !== activeWorkspaceId).map((t) => t.workspaceName));
  if (others.size > 0) reasons.push(`other workspace${others.size === 1 ? "" : "s"}: ${[...others].join(", ")}`);
  return reasons.length ? reasons.join(" · ") : null;
}

export function workspaceName(workspaces: Workspace[], id: string | null | undefined): string {
  return workspaces.find((w) => w.id === id)?.name ?? "";
}

/** Delay between the text and the Enter key: TUIs (Claude Code, Codex) treat a single "text\r" write as a paste. */
const ENTER_DELAY_MS = 80;

/** Send `line` + Enter to each target. Returns the names that failed. */
export async function sendBroadcast(line: string, targets: BroadcastCandidate[]): Promise<{ sent: number; failed: string[] }> {
  const text = line.replace(/[\r\n]+/g, " ");
  const failed: string[] = [];
  let sent = 0;
  await Promise.all(
    targets.map(async (t) => {
      try {
        await ipc.sessionWrite(t.id, text);
        await new Promise((r) => setTimeout(r, ENTER_DELAY_MS));
        await ipc.sessionWrite(t.id, "\r");
        sent++;
      } catch (e) {
        failed.push(`${t.name} (${errorMessage(e)})`);
      }
    }),
  );
  recordBroadcast(text, targets, failed);
  return { sent, failed };
}
