import { describe, expect, it } from "vitest";
import type { SessionInfo } from "../../lib/types";
import { fleetLamp, formatUptime, matchesFleetFilter, tailLines } from "./fleet";

const rt = (state: SessionInfo["state"]): SessionInfo => ({
  id: "s",
  name: "s",
  agent: "generic",
  pid: 1,
  state,
  cwd: "",
  profileId: null,
  commandDisplay: "",
  startedAt: "2026-01-01T00:00:00.000Z",
  endedAt: null,
  bytesOut: 0,
});

describe("fleet helpers", () => {
  it("derives the tile lamp", () => {
    expect(fleetLamp(undefined, undefined)).toBe("stopped");
    expect(fleetLamp(rt({ state: "running" }), { state: "waiting", unread: true, at: 0 })).toBe("waiting");
    expect(fleetLamp(rt({ state: "running" }), undefined)).toBe("idle");
    expect(fleetLamp(rt({ state: "exited", code: 3 }), undefined)).toBe("error");
    expect(fleetLamp(rt({ state: "exited", code: 0 }), undefined)).toBe("exited");
    expect(fleetLamp(rt({ state: "failed", message: "x" }), undefined)).toBe("error");
  });

  it("filters", () => {
    const working = { state: "working" as const, unread: false, at: 0 };
    expect(matchesFleetFilter("working", rt({ state: "running" }), working)).toBe(true);
    expect(matchesFleetFilter("working", rt({ state: "exited", code: 0 }), working)).toBe(false);
    expect(matchesFleetFilter("needs", rt({ state: "running" }), { state: "done", unread: true, at: 0 })).toBe(true);
    expect(matchesFleetFilter("errors", rt({ state: "exited", code: 1 }), undefined)).toBe(true);
    expect(matchesFleetFilter("all", undefined, undefined)).toBe(true);
  });

  it("takes the last non-blank lines", () => {
    expect(tailLines("a\nb\n\n  \nc  \nd\n\n", 3)).toEqual(["b", "c", "d"]);
    expect(tailLines("", 3)).toEqual([]);
    expect(tailLines("x".repeat(300), 1, 10)[0]).toHaveLength(10);
  });

  it("formats uptime", () => {
    const start = "2026-01-01T00:00:00.000Z";
    const t0 = Date.parse(start);
    expect(formatUptime(start, null, t0 + 42_000)).toBe("42s");
    expect(formatUptime(start, null, t0 + 3_725_000)).toBe("1h 2m");
    expect(formatUptime(start, "2026-01-01T00:02:05.000Z", t0 + 99_999_000)).toBe("2m 5s");
    expect(formatUptime(null, null, t0)).toBe("");
  });
});
