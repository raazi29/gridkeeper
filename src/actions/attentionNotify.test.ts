import { describe, expect, it } from "vitest";
import type { NotificationSettings } from "../lib/types";
import type { Alert } from "../store/attention";
import { toastDecision } from "./attentionNotify";

const on: NotificationSettings = { enabled: true, onIdle: true, onBell: true, sound: false };
const bell: Alert = { category: "bell", kind: "waiting", message: "x" };
const idle: Alert = { category: "idle", kind: "done", message: "x" };
const error: Alert = { category: "error", kind: "error", message: "x" };
const away = { windowFocused: false, onScreen: true, sinceLastMs: 1e9 };

describe("toastDecision", () => {
  it("OS toast when the window is in the background", () => {
    expect(toastDecision(bell, on, away)).toBe("os");
  });
  it("in-app toast when focused but the session is off screen; nothing when visible", () => {
    expect(toastDecision(bell, on, { windowFocused: true, onScreen: false, sinceLastMs: 1e9 })).toBe("inApp");
    expect(toastDecision(bell, on, { windowFocused: true, onScreen: true, sinceLastMs: 1e9 })).toBe("none");
  });
  it("honours the settings toggles", () => {
    expect(toastDecision(bell, { ...on, enabled: false }, away)).toBe("none");
    expect(toastDecision(bell, { ...on, onBell: false }, away)).toBe("none");
    expect(toastDecision(idle, { ...on, onIdle: false }, away)).toBe("none");
    expect(toastDecision(error, { ...on, onIdle: false, onBell: false }, away)).toBe("os");
  });
  it("rate-limits per session", () => {
    expect(toastDecision(bell, on, { ...away, sinceLastMs: 1000 })).toBe("none");
  });
});
