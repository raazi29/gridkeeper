import { describe, expect, it } from "vitest";
import { cometFor } from "./cometRoute";
import { arcPath } from "./Comets";
import { findTestAction } from "./mcExtensions";
import { noEmail } from "./AgentPanel";

const ev = (kind: string, message: string, result = "sent", level = "info", sessionId: string | null = "b1") =>
  ({ kind, message, result, level, sessionId }) as Parameters<typeof cometFor>[0];
const resolve = (t: string) => ({ lead: "L", reviewer: "R", "builder-1": "b1" })[t] ?? null;

describe("message comets", () => {
  it("routes broadcasts from the top, briefs from the board", () => {
    expect(cometFor(ev("broadcast", "broadcast: run the tests"), resolve)).toEqual({ from: { node: "top" }, to: "b1" });
    expect(cometFor(ev("mission", "mission brief: read the file"), resolve)).toEqual({ from: { node: "mission" }, to: "b1" });
    expect(cometFor(ev("mission", "lead control brief: …", "sent", "info", "L"), resolve)).toEqual({ from: { node: "mission" }, to: "L" });
  });
  it("routes hand-offs and lead control deliveries from the sender's card", () => {
    expect(cometFor(ev("broadcast", "hand-off from reviewer: please look", "sent"), resolve)).toEqual({ from: { session: "R" }, to: "b1" });
    expect(cometFor(ev("mission", "lead → builder-1: add a test", "auto-sent"), resolve)).toEqual({ from: { session: "L" }, to: "b1" });
    expect(cometFor(ev("mission", "auto-review → lead: review b1", "sent", "info", "L"), resolve)).toEqual({ from: { node: "signoff" }, to: "L" });
    expect(cometFor(ev("mission", "ghost → builder-1: hi"), resolve)).toEqual({ from: { node: "mission" }, to: "b1" });
  });
  it("ignores failures, skips, the sender's own echo and non-messages", () => {
    expect(cometFor(ev("broadcast", "broadcast: x", "failed", "error"), resolve)).toBeNull();
    expect(cometFor(ev("mission", "mission brief not sent: busy", "skipped", "needs"), resolve)).toBeNull();
    expect(cometFor(ev("broadcast", "handed off to reviewer", "handoff"), resolve)).toBeNull();
    expect(cometFor(ev("attention", "working", "active"), resolve)).toBeNull();
    expect(cometFor(ev("broadcast", "broadcast: x", "sent", "info", null), resolve)).toBeNull();
  });
  it("bows the arc upward", () => {
    const d = arcPath({ x: 0, y: 100 }, { x: 200, y: 100 });
    const cy = Number(/Q[-\d.]+,([-\d.]+)/.exec(d)?.[1]);
    expect(cy).toBeLessThan(100);
  });
});

describe("extension helpers", () => {
  it("finds a registered test action by id", () => {
    const a = (id: string) => ({ id, label: id, run: () => {} });
    expect(findTestAction([a("merge"), a("run-tests")])?.id).toBe("run-tests");
    expect(findTestAction([a("tests.run")])?.id).toBe("tests.run");
    expect(findTestAction([a("merge"), a("contest")])).toBeNull();
  });
  it("never shows an e-mail address", () => {
    expect(noEmail("work (ana.b@example.com)")).toBe("work (ana.b@…)");
    expect(noEmail("Personal")).toBe("Personal");
  });
});
