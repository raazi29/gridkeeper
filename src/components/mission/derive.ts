// Pure Mission Control derivations (unit-tested): lanes, lead nodes, sign-off list, counts, card status.
// Everything comes from real state — process state, exit codes, attention — nothing is estimated.

import type { SessionId, SessionInfo } from "../../lib/types";
import { needsAttention, type SessionAttn } from "../../store/attention";
import { fleetLamp, type FleetLamp } from "../util/fleet";

export interface SessionStatus {
  lamp: FleetLamp;
  live: boolean;
  /** Finished: attention "done" or exited with code 0. */
  done: boolean;
  needs: boolean;
  working: boolean;
}

const isLiveInfo = (r?: SessionInfo) => !!r && (r.state.state === "running" || r.state.state === "starting" || r.state.state === "stopping");

export function sessionStatus(rt: SessionInfo | undefined, a: SessionAttn | undefined): SessionStatus {
  const lamp = fleetLamp(rt, a);
  const live = isLiveInfo(rt);
  const exitedOk = rt?.state.state === "exited" && rt.state.code === 0;
  return {
    lamp,
    live,
    done: lamp === "done" || exitedOk,
    needs: needsAttention(a) && lamp !== "exited" && lamp !== "stopped",
    working: live && lamp === "working",
  };
}

export const LAMP_TEXT: Record<FleetLamp, string> = {
  working: "working",
  waiting: "waiting for you",
  done: "done",
  error: "error",
  idle: "idle",
  exited: "exited",
  stopped: "not started",
};

export type LaneState = "active" | "needs" | "review" | "idle" | "empty";

export interface LaneModel {
  groupId: string;
  name: string;
  ids: SessionId[];
  total: number;
  done: number;
  working: number;
  needs: number;
  errors: number;
  live: number;
  state: LaneState;
}

export interface MissionGroupInput {
  id: string;
  name: string;
  sessionIds: SessionId[];
}

export interface MissionModel {
  leads: SessionId[];
  lanes: LaneModel[];
  /** Sessions waiting for the user or done: "ready for review". */
  signoff: SessionId[];
  counts: { total: number; live: number; working: number; needs: number; done: number; errors: number };
}

/**
 * Lanes = the workspace's groups (a group is a phase / team). Sessions with role "lead" are shown in
 * the lead node only. A group that only contains leads is not shown as a lane.
 */
export function deriveMission(
  groups: MissionGroupInput[],
  roleOf: (id: SessionId) => string | null | undefined,
  statusOf: (id: SessionId) => SessionStatus,
): MissionModel {
  const leads: SessionId[] = [];
  const lanes: LaneModel[] = [];
  const signoff: SessionId[] = [];
  const counts = { total: 0, live: 0, working: 0, needs: 0, done: 0, errors: 0 };
  for (const g of groups) {
    const ids: SessionId[] = [];
    for (const id of g.sessionIds) {
      const st = statusOf(id);
      counts.total++;
      if (st.live) counts.live++;
      if (st.working) counts.working++;
      if (st.needs) counts.needs++;
      if (st.done) counts.done++;
      if (st.lamp === "error") counts.errors++;
      if (st.lamp === "waiting" || st.lamp === "done") signoff.push(id);
      if (roleOf(id) === "lead") leads.push(id);
      else ids.push(id);
    }
    if (ids.length === 0 && g.sessionIds.length > 0) continue; // leads only
    lanes.push(laneOf(g, ids, statusOf));
  }
  return { leads, lanes, signoff, counts };
}

export function laneOf(g: { id: string; name: string }, ids: SessionId[], statusOf: (id: SessionId) => SessionStatus): LaneModel {
  let done = 0;
  let working = 0;
  let needs = 0;
  let errors = 0;
  let live = 0;
  for (const id of ids) {
    const st = statusOf(id);
    if (st.done) done++;
    if (st.working) working++;
    if (st.needs) needs++;
    if (st.lamp === "error") errors++;
    if (st.live) live++;
  }
  const total = ids.length;
  const state: LaneState =
    total === 0 ? "empty" : needs > 0 ? "needs" : working > 0 ? "active" : done > 0 ? "review" : "idle";
  return { groupId: g.id, name: g.name, ids, total, done, working, needs, errors, live, state };
}

/** "3/4 done" progress, only when the lane has sessions. Fraction is real (done / total). */
export function laneProgress(l: Pick<LaneModel, "done" | "total">): { label: string; fraction: number } | null {
  if (l.total <= 0) return null;
  return { label: `${l.done}/${l.total} done`, fraction: l.done / l.total };
}

/** Phase marker for the lead node's workflow line: ✓ all done, ● working, ! needs you, ○ otherwise. */
export function phaseMark(l: LaneModel): string {
  if (l.total > 0 && l.done === l.total) return "✓";
  if (l.needs > 0) return "!";
  if (l.working > 0) return "●";
  return "○";
}
