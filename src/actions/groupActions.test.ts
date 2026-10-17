import { describe, expect, it } from "vitest";
import type { SessionInfo } from "../lib/types";
import { isTerminalSession, liveTargets, restartTargets, terminalTargets } from "./groupActions";

function info(id: string, state: SessionInfo["state"]): SessionInfo {
  return { id, name: id, agent: "claude", pid: 1, state, cwd: "C:\\", profileId: null, commandDisplay: "", startedAt: "t", endedAt: null, bytesOut: 0 };
}

const metas = [{ id: "a" }, { id: "b" }, { id: "c" }, { id: "web", kind: "browser" }, { id: "t", kind: "terminal" }];
const runtime: Record<string, SessionInfo> = {
  a: info("a", { state: "running" }),
  b: info("b", { state: "exited", code: 0 }),
  web: info("web", { state: "running" }),
  t: info("t", { state: "starting" }),
};

describe("lane / group action targets", () => {
  it("message & stop target live terminal sessions only, in lane order", () => {
    expect(liveTargets(["t", "a", "b", "c", "web"], metas, runtime)).toEqual(["t", "a"]);
  });

  it("restart targets sessions that have run (live or exited), never browser panes", () => {
    expect(restartTargets(["a", "b", "c", "web", "t"], metas, runtime)).toEqual(["a", "b", "t"]);
  });

  it("close targets every terminal session (browser panes excluded) and ignores unknown ids", () => {
    expect(terminalTargets(["a", "web", "c", "ghost"], metas)).toEqual(["a", "c"]);
  });

  it("isTerminalSession: no kind or kind terminal", () => {
    expect(isTerminalSession({ id: "x" })).toBe(true);
    expect(isTerminalSession({ id: "x", kind: "terminal" })).toBe(true);
    expect(isTerminalSession({ id: "x", kind: "browser" })).toBe(false);
    expect(isTerminalSession(undefined)).toBe(false);
  });
});
