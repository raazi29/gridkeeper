import { describe, expect, it } from "vitest";
import { DEFAULT_SETTINGS, type NotificationSettings } from "../lib/types";
import { reduceAttention } from "../store/attention";
import { shouldNotify } from "./attentionNotify";
import {
  PER_SESSION_GAP_MS,
  agentBucket,
  eventKindOf,
  inQuietHours,
  normalizeNotifications,
  parseHHMM,
  pruneMutes,
  toggleIn,
  type NotifyContext,
  type NotifyEvent,
} from "./notifyRules";

const base: NotificationSettings = DEFAULT_SETTINGS.notifications;
const cfg = (patch: Partial<NotificationSettings> = {}): NotificationSettings => ({ ...base, ...patch });
const ev = (patch: Partial<NotifyEvent> = {}): NotifyEvent => ({ kind: "needsInput", sessionId: "s1", workspaceId: "w1", agent: "claude", ...patch });
/** Window in the background, 14:00, no recent toast. */
const away: NotifyContext = { windowFocused: false, onScreen: true, sinceLastMs: 1e9, minutesOfDay: 14 * 60 };
const front: NotifyContext = { ...away, windowFocused: true, onScreen: false };

describe("shouldNotify: delivery", () => {
  it("Windows toast in the background, in-app toast when focused but off screen", () => {
    expect(shouldNotify(ev(), away, cfg())).toMatchObject({ toast: true, inApp: false, muted: false });
    expect(shouldNotify(ev(), front, cfg())).toMatchObject({ toast: false, inApp: true, muted: false });
  });
  it("nothing when the user is looking at the session (not marked muted)", () => {
    expect(shouldNotify(ev(), { ...front, onScreen: true }, cfg())).toEqual({ toast: false, inApp: false, sound: false, muted: false, reason: "visible" });
  });
  it("in-app only mode never raises a Windows toast", () => {
    expect(shouldNotify(ev(), away, cfg({ delivery: "inApp" }))).toMatchObject({ toast: false, inApp: true });
    expect(shouldNotify(ev(), front, cfg({ delivery: "inApp" }))).toMatchObject({ toast: false, inApp: true });
  });
  it("off mode = feed only, not marked muted", () => {
    expect(shouldNotify(ev(), away, cfg({ delivery: "off" }))).toMatchObject({ toast: false, inApp: false, muted: false, reason: "feedOnly" });
  });
  it("only-when-unfocused suppresses while the window is in front", () => {
    expect(shouldNotify(ev(), front, cfg({ onlyWhenUnfocused: true }))).toMatchObject({ inApp: false, reason: "focused", muted: false });
    expect(shouldNotify(ev(), away, cfg({ onlyWhenUnfocused: true }))).toMatchObject({ toast: true });
  });
  it("rate-limits per session", () => {
    expect(shouldNotify(ev(), { ...away, sinceLastMs: PER_SESSION_GAP_MS - 1 }, cfg())).toMatchObject({ toast: false, reason: "rate", muted: false });
    expect(shouldNotify(ev(), { ...away, sinceLastMs: PER_SESSION_GAP_MS }, cfg())).toMatchObject({ toast: true });
  });
  it("master switch off silences everything without marking muted", () => {
    expect(shouldNotify(ev(), away, cfg({ enabled: false }))).toMatchObject({ toast: false, inApp: false, sound: false, muted: false, reason: "disabled" });
  });
});

describe("shouldNotify: event and agent filters", () => {
  it("per-event toggles", () => {
    expect(shouldNotify(ev({ kind: "needsInput" }), away, cfg({ onInput: false }))).toMatchObject({ toast: false, muted: true, reason: "event" });
    expect(shouldNotify(ev({ kind: "done" }), away, cfg({ onIdle: false }))).toMatchObject({ toast: false, muted: true, reason: "event" });
    expect(shouldNotify(ev({ kind: "error" }), away, cfg({ onError: false }))).toMatchObject({ toast: false, muted: true });
    expect(shouldNotify(ev({ kind: "bell" }), away, cfg({ onBell: false }))).toMatchObject({ toast: false, muted: true });
    // Other kinds are unaffected by one toggle.
    expect(shouldNotify(ev({ kind: "error" }), away, cfg({ onIdle: false, onBell: false, onInput: false }))).toMatchObject({ toast: true });
  });
  it("per-agent-kind toggles (generic tools count as other)", () => {
    const n = cfg({ agents: { claude: true, codex: false, powershell: false, other: false } });
    expect(shouldNotify(ev({ agent: "claude" }), away, n)).toMatchObject({ toast: true });
    expect(shouldNotify(ev({ agent: "codex" }), away, n)).toMatchObject({ muted: true, reason: "agent" });
    expect(shouldNotify(ev({ agent: "powershell" }), away, n)).toMatchObject({ muted: true, reason: "agent" });
    expect(shouldNotify(ev({ agent: "generic" }), away, n)).toMatchObject({ muted: true, reason: "agent" });
  });
});

describe("shouldNotify: mutes, DND and quiet hours", () => {
  it("session and workspace mutes mark the alert muted", () => {
    expect(shouldNotify(ev(), away, cfg({ mutedSessions: ["s1"] }))).toMatchObject({ toast: false, inApp: false, muted: true, reason: "session" });
    expect(shouldNotify(ev(), away, cfg({ mutedWorkspaces: ["w1"] }))).toMatchObject({ toast: false, muted: true, reason: "workspace" });
    expect(shouldNotify(ev({ sessionId: "s2", workspaceId: "w2" }), away, cfg({ mutedSessions: ["s1"], mutedWorkspaces: ["w1"] }))).toMatchObject({ toast: true });
    expect(shouldNotify(ev({ workspaceId: null }), away, cfg({ mutedWorkspaces: ["w1"] }))).toMatchObject({ toast: true });
  });
  it("mutes win over visibility, so the feed still says why", () => {
    expect(shouldNotify(ev(), { ...front, onScreen: true }, cfg({ mutedSessions: ["s1"] }))).toMatchObject({ muted: true, reason: "session" });
  });
  it("do not disturb", () => {
    expect(shouldNotify(ev({ kind: "error" }), away, cfg({ dnd: true }))).toMatchObject({ toast: false, inApp: false, sound: false, muted: true, reason: "dnd" });
  });
  it("quiet hours, including a range across midnight", () => {
    const night = cfg({ quietHours: { enabled: true, start: "22:00", end: "07:00" } });
    expect(shouldNotify(ev(), { ...away, minutesOfDay: 23 * 60 }, night)).toMatchObject({ muted: true, reason: "quiet" });
    expect(shouldNotify(ev(), { ...away, minutesOfDay: 3 * 60 }, night)).toMatchObject({ muted: true, reason: "quiet" });
    expect(shouldNotify(ev(), { ...away, minutesOfDay: 7 * 60 }, night)).toMatchObject({ toast: true });
    expect(shouldNotify(ev(), { ...away, minutesOfDay: 12 * 60 }, night)).toMatchObject({ toast: true });
    const lunch = cfg({ quietHours: { enabled: true, start: "12:00", end: "13:30" } });
    expect(shouldNotify(ev(), { ...away, minutesOfDay: 12 * 60 + 45 }, lunch)).toMatchObject({ reason: "quiet" });
    expect(shouldNotify(ev(), { ...away, minutesOfDay: 13 * 60 + 30 }, lunch)).toMatchObject({ toast: true });
    // Disabled quiet hours never apply.
    expect(shouldNotify(ev(), { ...away, minutesOfDay: 23 * 60 }, cfg())).toMatchObject({ toast: true });
  });
});

describe("shouldNotify: sound", () => {
  it("plays only when enabled, a set is chosen and volume > 0", () => {
    expect(shouldNotify(ev(), away, cfg()).sound).toBe(false); // off by default
    expect(shouldNotify(ev(), away, cfg({ sound: true })).sound).toBe(true);
    expect(shouldNotify(ev(), front, cfg({ sound: true })).sound).toBe(true);
    expect(shouldNotify(ev(), away, cfg({ sound: true, soundSet: "none" })).sound).toBe(false);
    expect(shouldNotify(ev(), away, cfg({ sound: true, volume: 0 })).sound).toBe(false);
  });
  it("never sounds for a suppressed alert", () => {
    expect(shouldNotify(ev(), { ...front, onScreen: true }, cfg({ sound: true })).sound).toBe(false);
    expect(shouldNotify(ev(), away, cfg({ sound: true, dnd: true })).sound).toBe(false);
    expect(shouldNotify(ev(), away, cfg({ sound: true, delivery: "off" })).sound).toBe(false);
  });
});

describe("notification helpers", () => {
  it("normalizes legacy / partial settings", () => {
    const legacy = { enabled: true, onIdle: false, onBell: true, sound: true } as Partial<NotificationSettings>;
    const n = normalizeNotifications(legacy);
    expect(n.onIdle).toBe(false);
    expect(n.onInput).toBe(true);
    expect(n.quietHours).toEqual(base.quietHours);
    expect(n.agents).toEqual(base.agents);
    expect(n.mutedSessions).toEqual([]);
    expect(normalizeNotifications({ delivery: "loud" as never, soundSet: "x" as never, volume: 250 })).toMatchObject({ delivery: "toast", soundSet: "comm", volume: 100 });
    expect(normalizeNotifications({ agents: { codex: false } as never }).agents).toEqual({ ...base.agents, codex: false });
    expect(normalizeNotifications(undefined)).toEqual(base);
  });
  it("maps reducer alerts to event kinds", () => {
    const bell = reduceAttention(undefined, { type: "attention", ev: { id: "s", kind: "bell" } }, false, 0).alert!;
    const notify = reduceAttention(undefined, { type: "attention", ev: { id: "s", kind: "notify", title: "hi" } }, false, 0).alert!;
    const waiting = reduceAttention(undefined, { type: "attention", ev: { id: "s", kind: "status", status: "blocked", reason: "permission" } }, false, 0).alert!;
    const done = reduceAttention(undefined, { type: "attention", ev: { id: "s", kind: "idle", status: "done", activeMs: 5000 } }, false, 0).alert!;
    const crash = reduceAttention(undefined, { type: "exit", code: 2, userStopped: false }, false, 0).alert!;
    const failed = reduceAttention(undefined, { type: "failed", message: "nope" }, false, 0).alert!;
    expect([bell, notify, waiting, done, crash, failed].map(eventKindOf)).toEqual(["bell", "bell", "needsInput", "done", "error", "error"]);
  });
  it("buckets agent kinds", () => {
    expect(["claude", "codex", "powershell", "generic"].map((a) => agentBucket(a as never))).toEqual(["claude", "codex", "powershell", "other"]);
  });
  it("parses HH:MM and evaluates quiet ranges", () => {
    expect(parseHHMM("07:30")).toBe(450);
    expect(parseHHMM("7:05")).toBe(425);
    expect(parseHHMM("24:00")).toBeNull();
    expect(parseHHMM("aa")).toBeNull();
    expect(inQuietHours(600, { enabled: true, start: "10:00", end: "10:00" })).toBe(false);
    expect(inQuietHours(600, { enabled: true, start: "bad", end: "11:00" })).toBe(false);
  });
  it("prunes mutes of removed sessions / workspaces and keeps identity when unchanged", () => {
    const n = cfg({ mutedSessions: ["a", "gone"], mutedWorkspaces: ["w1", "w-gone"] });
    const p = pruneMutes(n, new Set(["a", "b"]), new Set(["w1"]));
    expect(p.mutedSessions).toEqual(["a"]);
    expect(p.mutedWorkspaces).toEqual(["w1"]);
    expect(pruneMutes(p, new Set(["a"]), new Set(["w1"]))).toBe(p);
  });
  it("toggles ids", () => {
    expect(toggleIn(["a"], "b")).toEqual(["a", "b"]);
    expect(toggleIn(["a", "b"], "a")).toEqual(["b"]);
    expect(toggleIn(["a"], "a", true)).toEqual(["a"]);
    expect(toggleIn(["a"], "b", false)).toEqual(["a"]);
  });
});
