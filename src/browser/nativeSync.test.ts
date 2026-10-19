import { describe, expect, it } from "vitest";
import type { BrowserViewRect } from "../lib/types";
import { resolveEngine, nativeSupported } from "./engine";
import { coveredAt, decideVisibility, planView, sameRect, samplePoints, toViewRect, type PlanInput } from "./nativeSync";
import { canGoBack, canGoForward, emptyNav, pushNav, viewOf } from "./nav";

const own = "http://tauri.localhost";
const rect = (x = 10, y = 20, width = 400, height = 300, scale = 1.25): BrowserViewRect => ({ x, y, width, height, scale });

describe("engine choice", () => {
  it("native only where supported, not picked away and not failed", () => {
    expect(resolveEngine("native", true, false)).toBe("native");
    expect(resolveEngine(undefined, true, false)).toBe("native"); // settings from before the option
    expect(resolveEngine("frame", true, false)).toBe("frame");
    expect(resolveEngine("native", false, false)).toBe("frame");
    expect(resolveEngine("native", true, true)).toBe("frame");
    expect(nativeSupported("windows", true)).toBe(true);
    expect(nativeSupported("macos", true)).toBe(false);
    expect(nativeSupported("linux", true)).toBe(false);
    expect(nativeSupported("windows", false)).toBe(false); // plain browser (tests, vite preview)
  });
});

describe("rect -> bounds", () => {
  it("passes CSS px and the device pixel ratio through", () => {
    expect(toViewRect({ left: 10, top: 20, width: 400, height: 300 }, 1.5)).toEqual({ x: 10, y: 20, width: 400, height: 300, scale: 1.5 });
    expect(toViewRect({ left: 0, top: 0, width: 1, height: 1 }, 0).scale).toBe(1);
    expect(toViewRect({ left: 0, top: 0, width: 1, height: 1 }, Number.NaN).scale).toBe(1);
  });
  it("treats sub-pixel jitter as the same rect, a new scale as a change", () => {
    expect(sameRect(rect(), rect(10.2, 20.3))).toBe(true);
    expect(sameRect(rect(), rect(11))).toBe(false);
    expect(sameRect(rect(), { ...rect(), scale: 1.5 })).toBe(false);
    expect(sameRect(null, null)).toBe(true);
    expect(sameRect(rect(), null)).toBe(false);
  });
});

describe("occlusion hit test", () => {
  it("samples a grid no coarser than the step, inside the box", () => {
    const box = { left: 100, top: 50, width: 808, height: 408 };
    const pts = samplePoints(box, 80, 4);
    expect(pts.length).toBe(11 * 6);
    for (const [x, y] of pts) {
      expect(x).toBeGreaterThanOrEqual(104);
      expect(x).toBeLessThanOrEqual(904);
      expect(y).toBeGreaterThanOrEqual(54);
      expect(y).toBeLessThanOrEqual(454);
    }
    const xs = [...new Set(pts.map((p) => p[0]))].sort((a, b) => a - b);
    expect(xs[1] - xs[0]).toBeLessThanOrEqual(80);
    expect(samplePoints({ left: 0, top: 0, width: 6, height: 100 }, 80, 4)).toEqual([]);
    expect(samplePoints({ left: 0, top: 0, width: 20000, height: 20000 }, 80, 4, 400).length).toBeLessThanOrEqual(400);
  });

  it("finds anything on top of the host, ignores the host and its children", () => {
    const host = { contains: (el: unknown) => el === "snapshot" };
    const box = { left: 0, top: 0, width: 400, height: 300 };
    const pts = samplePoints(box);
    expect(coveredAt(pts, () => host, host)).toBe(false);
    expect(coveredAt(pts, () => "snapshot", host)).toBe(false);
    expect(coveredAt(pts, () => null, host)).toBe(false); // outside the viewport
    // A 120 x 100 menu at (150, 100) is found by the 80 px grid.
    const menu = (x: number, y: number) => (x >= 150 && x <= 270 && y >= 100 && y <= 200 ? "menu" : host);
    expect(coveredAt(pts, menu, host)).toBe(true);
    // A toast over a page the user types in is skipped when the caller says so.
    const toast = (x: number, y: number) => (x > 300 && y > 250 ? "toast" : host);
    expect(coveredAt(pts, toast, host)).toBe(true);
    expect(coveredAt(pts, toast, host, (el) => el === "toast")).toBe(false);
  });

  it("decides shown / occluded / parked", () => {
    const box = { left: 0, top: 0, width: 10, height: 10 };
    expect(decideVisibility({ box, pageVisible: true, dragging: false, covered: false })).toBe("shown");
    expect(decideVisibility({ box, pageVisible: true, dragging: false, covered: true })).toBe("occluded");
    expect(decideVisibility({ box, pageVisible: true, dragging: true, covered: false })).toBe("occluded");
    expect(decideVisibility({ box: null, pageVisible: true, dragging: false, covered: false })).toBe("parked");
    expect(decideVisibility({ box, pageVisible: false, dragging: false, covered: false })).toBe("parked");
  });
});

describe("view plan", () => {
  const base: PlanInput = {
    exists: true,
    busy: false,
    sent: { vis: "shown", rect: rect() },
    appliedNonce: 1,
    wantUrl: "https://github.com/",
    nonce: 1,
    vis: "shown",
    rect: rect(),
    snapFresh: false,
  };

  it("creates lazily: only when the pane is on screen, uncovered and shows a page", () => {
    const fresh = { ...base, exists: false, sent: null, appliedNonce: -1 };
    expect(planView(fresh)).toEqual([{ kind: "create", url: "https://github.com/", rect: rect() }]);
    expect(planView({ ...fresh, vis: "occluded" })).toEqual([]);
    expect(planView({ ...fresh, vis: "parked", rect: null })).toEqual([]);
    expect(planView({ ...fresh, wantUrl: null })).toEqual([]);
    expect(planView({ ...fresh, busy: true })).toEqual([]);
  });

  it("does nothing when nothing changed, re-places on a move", () => {
    expect(planView(base)).toEqual([]);
    expect(planView({ ...base, rect: rect(50) })).toEqual([{ kind: "show", rect: rect(50) }]);
  });

  it("an overlay on top: snapshot first, then hide; restore afterwards", () => {
    expect(planView({ ...base, vis: "occluded" })).toEqual([{ kind: "snapshot" }]);
    expect(planView({ ...base, vis: "occluded", snapFresh: true })).toEqual([{ kind: "hide", vis: "occluded", rect: rect() }]);
    const hidden = { ...base, sent: { vis: "occluded" as const, rect: rect() } };
    expect(planView({ ...hidden, vis: "occluded" })).toEqual([]);
    expect(planView(hidden)).toEqual([{ kind: "show", rect: rect() }]);
    expect(planView({ ...base, busy: true, vis: "occluded" })).toEqual([]);
  });

  it("parks off-screen panes and panes showing a card, without a snapshot", () => {
    expect(planView({ ...base, vis: "parked", rect: null })).toEqual([{ kind: "hide", vis: "parked", rect: null }]);
    expect(planView({ ...base, wantUrl: null })).toEqual([{ kind: "hide", vis: "parked", rect: rect() }]);
    const parked = { ...base, sent: { vis: "parked" as const, rect: null } };
    expect(planView({ ...parked, vis: "parked", rect: null })).toEqual([]);
    expect(planView({ ...parked, vis: "occluded" })).toEqual([{ kind: "hide", vis: "occluded", rect: rect() }]);
  });

  it("loads again when Gridkeeper asks for a load (nonce), not for the page's own navigations", () => {
    expect(planView({ ...base, nonce: 2 })).toEqual([{ kind: "navigate", url: "https://github.com/" }]);
    expect(planView({ ...base, nonce: 2, wantUrl: null })).toEqual([{ kind: "hide", vis: "parked", rect: rect() }]);
  });
});

describe("nav with the native engine", () => {
  it("shows every site and file: pages; keeps the unreachable card for dev servers", () => {
    const refused = { ...emptyNav("https://github.com/"), probe: { reachable: true, status: 200, frameable: false, reason: "X-Frame-Options: DENY", title: null, error: null }, probeUrl: "https://github.com/" };
    expect(viewOf(refused, own, "frame")).toBe("refused");
    expect(viewOf(refused, own, "native")).toBe("frame");
    expect(viewOf(emptyNav("file:///C:/a.html"), own, "native")).toBe("frame");
    expect(viewOf(emptyNav("http://tauri.localhost/"), own, "native")).toBe("blocked");
    const down = {
      ...emptyNav("http://localhost:5173/"),
      probe: { reachable: false, status: null, frameable: null, reason: null, title: null, error: "Connection refused — is the server running?" },
      probeUrl: "http://localhost:5173/",
    };
    expect(viewOf(down, own, "native")).toBe("unreachable");
  });

  it("history buttons follow the view's report when there is one", () => {
    const n = pushNav(emptyNav("http://localhost:5173/"), "http://localhost:5173/a");
    expect(canGoBack(n)).toBe(true);
    expect(canGoBack({ ...n, live: { title: "", canGoBack: false, canGoForward: true } })).toBe(false);
    expect(canGoForward({ ...n, live: { title: "", canGoBack: false, canGoForward: true } })).toBe(true);
  });

  it("every Gridkeeper-initiated load bumps the nonce", () => {
    const a = emptyNav("http://localhost:5173/");
    expect(pushNav(a, "http://localhost:5173/x").nonce).toBe(a.nonce + 1);
    expect(pushNav(a, "http://localhost:5173/").nonce).toBe(a.nonce + 1);
  });
});
