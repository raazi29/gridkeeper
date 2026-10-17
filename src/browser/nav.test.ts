import { describe, expect, it } from "vitest";
import { frameBox } from "./frameHosts";
import { canGoBack, canGoForward, emptyNav, pushNav, stepNav, viewOf } from "./nav";

const own = "http://tauri.localhost";

describe("browser pane history", () => {
  it("pushes, steps back and forward, and drops forward entries on a new push", () => {
    let n = emptyNav("http://localhost:5173/");
    n = pushNav(n, "http://localhost:5173/about");
    n = pushNav(n, "http://localhost:5173/docs");
    expect(canGoBack(n)).toBe(true);
    expect(canGoForward(n)).toBe(false);
    n = stepNav(n, -1);
    expect(n.url).toBe("http://localhost:5173/about");
    expect(canGoForward(n)).toBe(true);
    n = pushNav(n, "http://localhost:3000/");
    expect(n.history).toEqual(["http://localhost:5173/", "http://localhost:5173/about", "http://localhost:3000/"]);
    expect(canGoForward(n)).toBe(false);
    expect(stepNav(emptyNav(), -1)).toEqual(emptyNav());
  });
  it("pushing the current URL reloads instead of adding an entry", () => {
    const n = pushNav(emptyNav("http://localhost:5173/"), "http://localhost:5173/");
    expect(n.history).toHaveLength(1);
    expect(n.nonce).toBe(1);
  });
});

describe("view selection", () => {
  const probe = (p: Partial<NonNullable<ReturnType<typeof emptyNav>["probe"]>>) => ({
    reachable: true,
    status: 200,
    frameable: true,
    reason: null,
    title: null,
    error: null,
    ...p,
  });
  it("start page, frame, refusal, unreachable, file and blocked", () => {
    expect(viewOf(undefined, own)).toBe("start");
    expect(viewOf(emptyNav(), own)).toBe("start");
    const n = emptyNav("https://github.com/");
    expect(viewOf(n, own)).toBe("frame"); // optimistic until the probe answers
    expect(viewOf({ ...n, probe: probe({ frameable: false }), probeUrl: n.url }, own)).toBe("refused");
    expect(viewOf({ ...n, probe: probe({ frameable: false }), probeUrl: n.url, forceFrame: true }, own)).toBe("frame");
    // A stale probe (other URL) is ignored.
    expect(viewOf({ ...n, probe: probe({ frameable: false }), probeUrl: "https://other/" }, own)).toBe("frame");
    const down = probe({ reachable: false, frameable: null, error: "Connection refused — is the server running?" });
    expect(viewOf({ ...emptyNav("http://localhost:5173/"), probe: down, probeUrl: "http://localhost:5173/" }, own)).toBe("unreachable");
    // No curl: unknown, just try the frame.
    const nocurl = probe({ reachable: false, frameable: null, error: "curl.exe not available" });
    expect(viewOf({ ...emptyNav("http://localhost:5173/"), probe: nocurl, probeUrl: "http://localhost:5173/" }, own)).toBe("frame");
    expect(viewOf(emptyNav("file:///C:/a.html"), own)).toBe("file");
    expect(viewOf(emptyNav("http://tauri.localhost/"), own)).toBe("blocked");
  });
});

describe("frame placement", () => {
  const host = (r: { left: number; top: number; width: number; height: number }, isConnected = true) => ({ getBoundingClientRect: () => r, isConnected });
  it("positions relative to the layer and hides collapsed / detached hosts", () => {
    expect(frameBox(host({ left: 110.4, top: 60, width: 400, height: 300.6 }), { left: 100, top: 50 })).toEqual({ left: 10, top: 10, width: 400, height: 301 });
    expect(frameBox(host({ left: 0, top: 0, width: 0, height: 0 }), { left: 0, top: 0 })).toBeNull(); // display:none group
    expect(frameBox(host({ left: 0, top: 0, width: 10, height: 10 }, false), { left: 0, top: 0 })).toBeNull();
    expect(frameBox(undefined, { left: 0, top: 0 })).toBeNull();
  });
});
