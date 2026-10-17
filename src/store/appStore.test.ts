import { describe, expect, it } from "vitest";
import type { SessionInfo, SessionState } from "../lib/types";
import { shouldApplyStartResult } from "./appStore";

function info(state: SessionState, startedAt: string | null, bytesOut = 0): SessionInfo {
  return {
    id: "s",
    name: "s",
    agent: "generic",
    pid: 1,
    state,
    cwd: "C:\\",
    profileId: null,
    commandDisplay: "",
    startedAt,
    endedAt: null,
    bytesOut,
  };
}

describe("shouldApplyStartResult", () => {
  const T1 = "2026-10-17T08:00:00.000Z";
  const T0 = "2026-10-17T07:00:00.000Z";
  const result = info({ state: "running" }, T1);

  it("applies over the optimistic 'starting' placeholder and the previous run", () => {
    expect(shouldApplyStartResult(undefined, result)).toBe(true);
    expect(shouldApplyStartResult(info({ state: "starting" }, null), result)).toBe(true);
    expect(shouldApplyStartResult(info({ state: "exited", code: 0 }, T0), result)).toBe(true);
  });

  it("never overwrites an event of the same run that arrived first", () => {
    // The process already exited: the stale 'running' snapshot must not resurrect the pane.
    expect(shouldApplyStartResult(info({ state: "exited", code: 1 }, T1), result)).toBe(false);
    // First-output event already counted bytes: keep it (else the no-output watchdog misfires).
    expect(shouldApplyStartResult(info({ state: "running" }, T1, 16), result)).toBe(false);
  });
});
