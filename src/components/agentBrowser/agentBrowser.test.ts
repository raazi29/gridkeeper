import { describe, expect, it } from "vitest";
import type { AgentBrowserActivity, AgentBrowserSession } from "../../lib/types";
import { keyInput, mapPoint, modifiersOf, mouseButton, parseFrame, shortUrl } from "./frames";
import { activityLevel, isBrowserCapable, isLoggedAction, needsRestart, pushLog } from "./store";

function frame(header: object, jpeg: number[]): ArrayBuffer {
  const h = new TextEncoder().encode(JSON.stringify(header));
  const buf = new ArrayBuffer(4 + h.length + jpeg.length);
  new DataView(buf).setUint32(0, h.length, true);
  new Uint8Array(buf, 4, h.length).set(h);
  new Uint8Array(buf, 4 + h.length).set(jpeg);
  return buf;
}

describe("parseFrame", () => {
  it("splits header and JPEG", () => {
    const f = parseFrame(frame({ w: 1280, h: 800, top: 0, scale: 1, ts: 5 }, [0xff, 0xd8, 0xff]));
    expect(f?.header).toEqual({ w: 1280, h: 800, top: 0, scale: 1, ts: 5 });
    expect(Array.from(f!.jpeg)).toEqual([0xff, 0xd8, 0xff]);
  });
  it("rejects malformed buffers", () => {
    expect(parseFrame(new ArrayBuffer(2))).toBeNull();
    const bad = new ArrayBuffer(8);
    new DataView(bad).setUint32(0, 100, true);
    expect(parseFrame(bad)).toBeNull();
    const notJson = new ArrayBuffer(7);
    new DataView(notJson).setUint32(0, 3, true);
    new Uint8Array(notJson, 4, 3).set([0x7b, 0x7b, 0x7b]);
    expect(parseFrame(notJson)).toBeNull();
  });
});

describe("mapPoint", () => {
  const header = { w: 1280, h: 800, top: 0, scale: 1, ts: 0 };
  it("maps a contain-fitted frame to CSS pixels", () => {
    // Box 640x400 at (100, 50): scale 0.5, no letterbox.
    expect(mapPoint(100 + 320, 50 + 200, { left: 100, top: 50, width: 640, height: 400 }, header)).toEqual({ x: 640, y: 400 });
    // Box 640x600: frame 640x400 centred vertically (letterbox 100 px top and bottom).
    expect(mapPoint(0, 100, { left: 0, top: 0, width: 640, height: 600 }, header)).toEqual({ x: 0, y: 0 });
    expect(mapPoint(10, 50, { left: 0, top: 0, width: 640, height: 600 }, header)).toBeNull();
  });
  it("needs a frame size", () => {
    expect(mapPoint(1, 1, { left: 0, top: 0, width: 10, height: 10 }, { ...header, w: 0 })).toBeNull();
  });
});

describe("keyboard and mouse translation", () => {
  const ev = (key: string, mods: Partial<Record<"altKey" | "ctrlKey" | "metaKey" | "shiftKey", boolean>> = {}) => ({
    key,
    code: key.length === 1 ? `Key${key.toUpperCase()}` : key,
    keyCode: key.length === 1 ? key.toUpperCase().charCodeAt(0) : 13,
    altKey: false,
    ctrlKey: false,
    metaKey: false,
    shiftKey: false,
    ...mods,
  });
  it("printable keys carry text on keydown only", () => {
    expect(keyInput(ev("a"), "down")).toMatchObject({ type: "key", action: "down", key: "a", text: "a", modifiers: 0 });
    expect(keyInput(ev("a"), "up")).not.toHaveProperty("text");
    expect(keyInput(ev("Enter"), "down")).toMatchObject({ text: "\r" });
  });
  it("shortcuts send no text", () => {
    const k = keyInput(ev("a", { ctrlKey: true }), "down");
    expect(k).toMatchObject({ modifiers: 2 });
    expect(k).not.toHaveProperty("text");
  });
  it("ignores IME composition", () => {
    expect(keyInput({ ...ev("a"), isComposing: true }, "down")).toBeNull();
  });
  it("modifier bits and buttons", () => {
    expect(modifiersOf({ altKey: true, ctrlKey: true, metaKey: true, shiftKey: true })).toBe(15);
    expect([0, 1, 2, 5].map(mouseButton)).toEqual(["left", "middle", "right", "none"]);
  });
});

describe("store helpers", () => {
  const act = (p: Partial<AgentBrowserActivity>): AgentBrowserActivity => ({ sessionId: "s1", atMs: 1, tool: "browser_click", summary: "click", url: null, outcome: "ok", ...p });
  it("keeps a bounded per-session log", () => {
    let log = {};
    for (let i = 0; i < 5; i++) log = pushLog(log, act({ atMs: i }), 3);
    log = pushLog(log, act({ sessionId: "s2" }), 3);
    expect((log as Record<string, AgentBrowserActivity[]>).s1.map((e) => e.atMs)).toEqual([2, 3, 4]);
    expect((log as Record<string, AgentBrowserActivity[]>).s2).toHaveLength(1);
  });
  it("page reads stay out of the session activity log; decisions go in", () => {
    expect(isLoggedAction(act({ tool: "browser_snapshot" }))).toBe(false);
    expect(isLoggedAction(act({ tool: "browser_snapshot", outcome: "error" }))).toBe(true);
    expect(isLoggedAction(act({ tool: "browser_navigate" }))).toBe(true);
    expect(activityLevel(act({ tool: "confirm", outcome: "info" }))).toBe("needs");
    expect(activityLevel(act({ outcome: "blocked" }))).toBe("error");
    expect(activityLevel(act({ outcome: "denied" }))).toBe("info");
  });
  it("restart hint and capable agents", () => {
    const row = { enabled: true, launched: false } as AgentBrowserSession;
    expect(needsRestart(row, true)).toBe(true);
    expect(needsRestart(row, false)).toBe(false);
    expect(needsRestart({ ...row, launched: true }, true)).toBe(false);
    expect(isBrowserCapable("claude") && isBrowserCapable("codex")).toBe(true);
    expect(isBrowserCapable("powershell") || isBrowserCapable("generic")).toBe(false);
  });
  it("short URLs", () => {
    expect(shortUrl("http://localhost:5173/")).toBe("localhost:5173");
    expect(shortUrl("https://example.com/a/b?x=1")).toBe("example.com/a/b");
    expect(shortUrl("about:blank")).toBe("about:blank");
    expect(shortUrl(null)).toBe("");
  });
});

describe("session menu", () => {
  it("offers the Agent browser submenu only when the state carries the opt-in", async () => {
    const { buildSessionMenu } = await import("../menus/sessionMenu");
    const base = {
      exists: true,
      name: "builder",
      agent: "claude" as const,
      live: true,
      hasRun: true,
      role: null,
      muted: false,
      hidden: false,
      groupId: "g1",
      index: 0,
      count: 1,
      maximized: false,
      resume: { mode: "continue" as const },
    };
    const plain = buildSessionMenu("s1", { surface: "header" }, base);
    expect(plain.some((i) => i !== "separator" && i.label === "Agent browser")).toBe(false);
    const items = buildSessionMenu("s1", { surface: "header" }, { ...base, agentBrowser: { enabled: true, launched: false } });
    const sub = items.find((i) => i !== "separator" && i.label === "Agent browser");
    expect(sub).toBeDefined();
    const children = (sub as { children: { label: string; checked?: boolean; hint?: string }[] }).children;
    expect(children[0]).toMatchObject({ label: "Give this agent a browser", checked: true, hint: "restart to apply" });
    expect(children[1].label).toBe("Open agent browser view");
  });
});
