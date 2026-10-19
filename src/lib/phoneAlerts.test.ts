import { describe, expect, it } from "vitest";
import { boardProgress, buildPhoneAlert, isPrivateHost, phoneSkipReason, serverProblem, subscribeLinks, weakTopic, type PhoneContext, type PhoneEvent } from "./phoneAlerts";
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
    expect(phoneSkipReason(cfg(), ev({ kind: "missionDone", sessionId: undefined }), { ...away, notif: { ...away.notif, mutedWorkspaces: ["w1"] } })).toBe("workspace");
  });
  it("honours phone quiet hours (across midnight, start == end never)", () => {
    const q = cfg({ quietHours: { enabled: true, start: "22:00", end: "07:00" } });
    expect(phoneSkipReason(q, ev(), { ...away, minutesOfDay: 23 * 60 })).toBe("quiet");
    expect(phoneSkipReason(q, ev(), { ...away, minutesOfDay: 6 * 60 + 59 })).toBe("quiet");
    expect(phoneSkipReason(q, ev(), { ...away, minutesOfDay: 7 * 60 })).toBeNull();
    expect(phoneSkipReason(q, ev(), away)).toBeNull();
    const day = cfg({ quietHours: { enabled: true, start: "09:00", end: "17:00" } });
    expect(phoneSkipReason(day, ev(), away)).toBe("quiet");
    expect(phoneSkipReason(cfg({ quietHours: { enabled: true, start: "08:00", end: "08:00" } }), ev(), away)).toBeNull();
    expect(phoneSkipReason(cfg({ quietHours: { enabled: false, start: "00:00", end: "23:59" } }), ev(), away)).toBeNull();
  });
  it("applies the minimum priority", () => {
    expect(phoneSkipReason(cfg({ minPriority: 4 }), ev({ kind: "missionDone" }), away)).toBe("priority");
    expect(phoneSkipReason(cfg({ minPriority: 4 }), ev({ kind: "error" }), away)).toBeNull();
    expect(phoneSkipReason(cfg({ minPriority: 5 }), ev({ kind: "error" }), away)).toBe("priority");
  });
  it("only when away: skipped while the window is in front; never for the pane on screen", () => {
    expect(phoneSkipReason(cfg(), ev(), { ...away, windowActive: true })).toBe("present");
    expect(phoneSkipReason(cfg({ onlyWhenAway: false }), ev(), { ...away, windowActive: true })).toBeNull();
    expect(phoneSkipReason(cfg({ onlyWhenAway: false }), ev({ onScreen: true }), { ...away, windowActive: true })).toBe("visible");
    expect(phoneSkipReason(cfg(), ev({ onScreen: true }), away)).toBeNull();
  });
});

describe("buildPhoneAlert", () => {
  it("uses names only when allowed", () => {
    const a = buildPhoneAlert(cfg(), ev());
    expect(a.title).toBe("builder-1 needs you · OAuth demo");
    expect(a.message).toBe("Waiting for your input or a permission answer.");
    const g = buildPhoneAlert(cfg({ includeNames: false }), ev());
    expect(g.title).toBe("An agent needs you");
    expect(JSON.stringify(g)).not.toMatch(/builder-1|OAuth/);
  });
  it("never carries terminal output or other fields of the event", () => {
    const leaky = { ...ev(), lastMessage: "rm -rf C:\\Users\\me\\secret", output: "sk-ant-123", title: "token=abc", dir: "D:\\work\\acme" } as PhoneEvent;
    for (const kind of ["needsInput", "error", "done", "proposal", "missionDone"] as const) {
      const a = buildPhoneAlert(cfg({ includeTaskNames: true }), { ...leaky, kind });
      expect(JSON.stringify(a)).not.toMatch(/rm -rf|sk-ant|token=abc|acme|Users/);
    }
  });
  it("mission done: count always, goal only with includeTaskNames", () => {
    const m = ev({ kind: "missionDone", key: "m:x", goal: "Add OAuth login", done: 8, total: 8, paneName: undefined });
    expect(buildPhoneAlert(cfg(), m).title).toBe("Mission done (8/8)");
    expect(buildPhoneAlert(cfg(), m).message).toBe("Every task on the board is checked off in OAuth demo.");
    expect(buildPhoneAlert(cfg({ includeTaskNames: true }), m).title).toBe("Mission done: Add OAuth login (8/8)");
    expect(buildPhoneAlert(cfg({ includeTaskNames: true, includeNames: false }), m).message).toBe("Every task on the board is checked off.");
    expect(JSON.stringify(buildPhoneAlert(cfg({ includeTaskNames: true }), ev({ goal: "Add OAuth login" })))).not.toContain("Add OAuth login");
  });
  it("proposal names the lead and workspace only with names on", () => {
    const p = ev({ kind: "proposal", key: "p:x", paneName: "lead" });
    expect(buildPhoneAlert(cfg(), p)).toMatchObject({ title: "Lead proposal waiting · OAuth demo", message: "From lead. Approve or dismiss it in Mission Control.", priority: 4 });
    expect(buildPhoneAlert(cfg({ includeNames: false }), p)).toMatchObject({ title: "Lead proposal waiting", message: "Approve or dismiss it in Mission Control." });
  });
  it("keys and tags are fixed, tags are ntfy-safe", () => {
    const a = buildPhoneAlert(cfg(), ev({ kind: "error" }));
    expect(a).toMatchObject({ key: "s:s1", kind: "error", priority: 4, tags: ["rotating_light"] });
    for (const kind of ["needsInput", "error", "done", "proposal", "missionDone"] as const) expect(buildPhoneAlert(cfg(), ev({ kind })).tags.every((t) => /^[a-z0-9_-]+$/.test(t))).toBe(true);
  });
});

describe("settings helpers", () => {
  it("server hints mirror the Rust validation", () => {
    expect(serverProblem("https://ntfy.sh/")).toBeNull();
    expect(serverProblem("https://push.example.com:8443/ntfy")).toBeNull();
    expect(serverProblem("http://192.168.1.10:8080")).toBeNull();
    expect(serverProblem("http://nas.local")).toBeNull();
    for (const bad of ["", "ntfy.sh", "http://ntfy.sh", "https://u:p@ntfy.sh", "https://ntfy.sh/?x", "https://ntfy .sh", 'https://ntfy.sh/"x'])
      expect(serverProblem(bad), bad).not.toBeNull();
  });
  it("private hosts", () => {
    expect(["localhost", "10.0.0.1", "172.20.1.1", "192.168.1.1", "100.64.0.1", "[::1]", "box.lan"].every(isPrivateHost)).toBe(true);
    expect(["ntfy.sh", "8.8.8.8", "172.32.0.1", "1.2.3", "[2001:db8::1]"].some(isPrivateHost)).toBe(false);
  });
  it("weak topics", () => {
    expect(weakTopic("alerts")).toBe(true);
    expect(weakTopic("mysupersecrettopicname")).toBe(true);
    expect(weakTopic("gk-a8F3kq9ZpL2mW7xR4tY6vB1n")).toBe(false);
  });
  it("subscribe links: web page and ntfy:// deep link", () => {
    expect(subscribeLinks("https://ntfy.sh", "gk-x")).toEqual({ web: "https://ntfy.sh/gk-x", app: "ntfy://ntfy.sh/gk-x" });
    expect(subscribeLinks("http://192.168.1.2:8080/", "gk-x")).toEqual({ web: "http://192.168.1.2:8080/gk-x", app: "ntfy://192.168.1.2:8080/gk-x?secure=false" });
  });
  it("board progress", () => {
    const t = (state: "todo" | "doing" | "done" | "blocked") => ({ line: 0, text: "x", state, owners: [] });
    expect(boardProgress({ tasks: [] })).toEqual({ done: 0, total: 0, finished: false });
    expect(boardProgress({ tasks: [t("done"), t("doing")] })).toEqual({ done: 1, total: 2, finished: false });
    expect(boardProgress({ tasks: [t("done"), t("done")] })).toEqual({ done: 2, total: 2, finished: true });
  });
});
