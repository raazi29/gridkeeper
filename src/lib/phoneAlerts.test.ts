import { describe, expect, it } from "vitest";
import { buildPhoneAlert, phoneSkipReason, type PhoneContext, type PhoneEvent } from "./phoneAlerts";
import type { PhoneConfig } from "./types";

const cfg = (patch: Partial<PhoneConfig> = {}): PhoneConfig => ({
  enabled: true,
  server: "https://ntfy.sh",
  topic: "gk-abc",
  events: { needsInput: true, error: true, proposal: true, missionDone: true, done: false },
  minPriority: 3,
  quietHours: { enabled: false, start: "22:00", end: "07:00" },
  includeNames: true,
  includeTaskNames: false,
  onlyWhenAway: true,
  ...patch,
});
const away: PhoneContext = { windowActive: false, minutesOfDay: 14 * 60, notif: { dnd: false, mutedSessions: [], mutedWorkspaces: [] } };
const ev = (patch: Partial<PhoneEvent> = {}): PhoneEvent => ({ kind: "needsInput", key: "s:s1", sessionId: "s1", workspaceId: "w1", paneName: "builder-1", workspaceName: "OAuth demo", ...patch });

describe("phoneSkipReason", () => {
  it("qualifies a needs-input event while away", () => expect(phoneSkipReason(cfg(), ev(), away)).toBeNull());
  it("is off by switch, missing topic and event filter", () => {
    expect(phoneSkipReason(cfg({ enabled: false }), ev(), away)).toBe("off");
    expect(phoneSkipReason(cfg({ topic: "" }), ev(), away)).toBe("off");
    expect(phoneSkipReason(cfg(), ev({ kind: "done" }), away)).toBe("event");
    expect(phoneSkipReason(cfg({ events: { ...cfg().events, done: true } }), ev({ kind: "done" }), away)).toBeNull();
  });
  it("honours the app's Do not disturb and mutes", () => {
    expect(phoneSkipReason(cfg(), ev(), { ...away, notif: { ...away.notif, dnd: true } })).toBe("dnd");
    expect(phoneSkipReason(cfg(), ev(), { ...away, notif: { ...away.notif, mutedSessions: ["s1"] } })).toBe("session");
    expect(phoneSkipReason(cfg(), ev(), { ...away, notif: { ...away.notif, mutedWorkspaces: ["w1"] } })).toBe("workspace");
    expect(phoneSkipReason(cfg(), ev({ kind: "proposal", sessionId: undefined, workspaceId: undefined }), { ...away, notif: { ...away.notif, mutedSessions: ["s1"] } })).toBeNull();
  });
  it("honours phone quiet hours (across midnight)", () => {
    const q = cfg({ quietHours: { enabled: true, start: "22:00", end: "07:00" } });
    expect(phoneSkipReason(q, ev(), { ...away, minutesOfDay: 23 * 60 })).toBe("quiet");
    expect(phoneSkipReason(q, ev(), { ...away, minutesOfDay: 6 * 60 })).toBe("quiet");
    expect(phoneSkipReason(q, ev(), away)).toBeNull();
  });
  it("applies the minimum priority", () => {
    expect(phoneSkipReason(cfg({ minPriority: 4 }), ev({ kind: "proposal" }), away)).toBe("priority");
    expect(phoneSkipReason(cfg({ minPriority: 4 }), ev({ kind: "error" }), away)).toBeNull();
  });
  it("only when away: skipped while the window is in front", () => {
    expect(phoneSkipReason(cfg(), ev(), { ...away, windowActive: true })).toBe("present");
    expect(phoneSkipReason(cfg({ onlyWhenAway: false }), ev(), { ...away, windowActive: true })).toBeNull();
  });
});

describe("buildPhoneAlert", () => {
  it("uses names only when allowed", () => {
    const a = buildPhoneAlert(cfg(), ev());
    expect(a.title).toBe("builder-1 needs you");
    expect(a.message).toBe("OAuth demo · Open Gridkeeper to respond.");
    const g = buildPhoneAlert(cfg({ includeNames: false }), ev());
    expect(g.title).toBe("An agent needs you");
    expect(g.message).toBe("Open Gridkeeper to respond.");
    expect(JSON.stringify(g)).not.toMatch(/builder-1|OAuth/);
  });
  it("never carries terminal output or other fields of the event", () => {
    const leaky = { ...ev(), lastMessage: "rm -rf C:\Users\me\secret", output: "sk-ant-123", title: "token=abc" } as PhoneEvent;
    for (const kind of ["needsInput", "error", "done", "proposal", "missionDone"] as const) {
      const a = buildPhoneAlert(cfg({ includeTaskNames: true }), { ...leaky, kind });
      expect(JSON.stringify(a)).not.toMatch(/rm -rf|sk-ant|token=abc/);
    }
  });
  it("includes the mission goal only with includeTaskNames", () => {
    const m = ev({ kind: "missionDone", key: "m:x", goal: "Add OAuth login" });
    expect(buildPhoneAlert(cfg(), m).message).not.toContain("OAuth login");
    expect(buildPhoneAlert(cfg({ includeTaskNames: true }), m).message).toBe("OAuth demo · Add OAuth login · Every task on the board is checked off.");
    expect(buildPhoneAlert(cfg({ includeTaskNames: true }), ev({ goal: "Add OAuth login" })).message).not.toContain("Add OAuth login");
  });
  it("keys and tags are fixed, tags are ntfy-safe", () => {
    const a = buildPhoneAlert(cfg(), ev({ kind: "error" }));
    expect(a).toMatchObject({ key: "s:s1", kind: "error", priority: 4, tags: ["rotating_light"] });
    expect(a.tags.every((t) => /^[a-z0-9_-]+$/.test(t))).toBe(true);
  });
});
