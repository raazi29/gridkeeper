import { describe, expect, it } from "vitest";
import {
  centerOn,
  clampPan,
  clampZoom,
  fitView,
  intersects,
  minimapScale,
  normRect,
  parseView,
  revealView,
  sameView,
  stepZoom,
  toCanvas,
  toScreen,
  visibleRect,
  wheelZoomFactor,
  zoomAt,
  ZOOM_MAX,
  ZOOM_MIN,
} from "./viewport";

describe("zoom", () => {
  it("clamps to 25–200 %", () => {
    expect(clampZoom(0.01)).toBe(ZOOM_MIN);
    expect(clampZoom(9)).toBe(ZOOM_MAX);
    expect(clampZoom(Number.NaN)).toBe(1);
    expect(clampZoom(1.3)).toBe(1.3);
  });

  it("keeps the point under the cursor in place", () => {
    const v = { x: 40, y: -20, k: 1 };
    const before = toCanvas(v, 300, 200);
    const z = zoomAt(v, 1.5, 300, 200);
    const after = toCanvas(z, 300, 200);
    expect(after.x).toBeCloseTo(before.x, 2);
    expect(after.y).toBeCloseTo(before.y, 2);
    expect(z.k).toBe(1.5);
  });

  it("steps through the stops and stops at the limits", () => {
    expect(stepZoom(1, 1)).toBe(1.1);
    expect(stepZoom(1, -1)).toBe(0.9);
    expect(stepZoom(1.05, 1)).toBe(1.1);
    expect(stepZoom(1.05, -1)).toBe(1);
    expect(stepZoom(2, 1)).toBe(ZOOM_MAX);
    expect(stepZoom(0.25, -1)).toBe(ZOOM_MIN);
  });

  it("turns wheel deltas into gentle factors", () => {
    expect(wheelZoomFactor(-100)).toBeGreaterThan(1.09);
    expect(wheelZoomFactor(-100)).toBeLessThan(1.12);
    expect(wheelZoomFactor(100)).toBeLessThan(1);
    expect(wheelZoomFactor(-3, 1)).toBeCloseTo(wheelZoomFactor(-48), 6); // lines -> px
    expect(wheelZoomFactor(-100000)).toBeCloseTo(Math.exp(0.3), 6); // capped
  });
});

describe("pan limits", () => {
  const content = { w: 1000, h: 2000 };
  const viewport = { w: 1000, h: 600 };
  it("never lets the canvas leave the viewport", () => {
    const far = clampPan({ x: 5000, y: 5000, k: 1 }, content, viewport, 96);
    expect(far).toEqual({ x: 1000 - 96, y: 600 - 96, k: 1 });
    const back = clampPan({ x: -5000, y: -5000, k: 1 }, content, viewport, 96);
    expect(back).toEqual({ x: 96 - 1000, y: 96 - 2000, k: 1 });
  });
  it("leaves a view inside the limits alone", () => {
    expect(clampPan({ x: 0, y: -300, k: 1 }, content, viewport)).toEqual({ x: 0, y: -300, k: 1 });
  });
  it("uses the scaled size", () => {
    expect(clampPan({ x: -5000, y: 0, k: 0.5 }, content, viewport, 96).x).toBe(96 - 500);
  });
});

describe("fit, reveal, centre", () => {
  it("fits the whole canvas, centred, never above 100 %", () => {
    const v = fitView({ w: 1000, h: 2000 }, { w: 1000, h: 600 }, 20);
    expect(v.k).toBeCloseTo((600 - 40) / 2000, 4);
    expect(v.x).toBeCloseTo((1000 - 1000 * v.k) / 2, 1);
    expect(fitView({ w: 300, h: 200 }, { w: 1000, h: 600 }).k).toBe(1);
    expect(fitView({ w: 0, h: 0 }, { w: 1000, h: 600 })).toEqual({ x: 0, y: 0, k: 1 });
  });

  it("reveals a box with the smallest pan", () => {
    const vp = { w: 800, h: 600 };
    const v = { x: 0, y: 0, k: 1 };
    expect(revealView(v, { x: 100, y: 100, w: 50, h: 50 }, vp, 20)).toEqual(v); // already visible
    expect(revealView(v, { x: 100, y: 900, w: 50, h: 50 }, vp, 20).y).toBe(600 - 20 - 950);
    expect(revealView(v, { x: -300, y: 10, w: 50, h: 50 }, vp, 20).x).toBe(320);
    const big = revealView(v, { x: 0, y: 1000, w: 50, h: 900 }, vp, 20);
    expect(big.y).toBe(20 - 1000); // larger than the viewport: top aligned
  });

  it("centres a point", () => {
    expect(centerOn({ x: 0, y: 0, k: 2 }, 100, 50, { w: 800, h: 600 })).toEqual({ x: 200, y: 200, k: 2 });
  });
});

describe("coordinates", () => {
  it("round-trips screen and canvas points", () => {
    const v = { x: 37, y: -120, k: 0.75 };
    const c = toCanvas(v, 410, 333);
    const s = toScreen(v, c.x, c.y);
    expect(s.x).toBeCloseTo(410, 6);
    expect(s.y).toBeCloseTo(333, 6);
  });
  it("frames the visible part for the minimap", () => {
    expect(visibleRect({ x: -100, y: -50, k: 2 }, { w: 800, h: 600 })).toEqual({ x: 50, y: 25, w: 400, h: 300 });
    expect(minimapScale({ w: 2000, h: 1000 }, { w: 200, h: 140 })).toBe(0.1);
  });
  it("parses stored views defensively", () => {
    expect(parseView({ x: 1, y: 2, k: 5 })).toEqual({ x: 1, y: 2, k: 2 });
    expect(parseView({ x: "1", y: 2, k: 1 })).toBeNull();
    expect(parseView(null)).toBeNull();
    expect(parseView({ x: Infinity, y: 0, k: 1 })).toBeNull();
    expect(sameView({ x: 1, y: 1, k: 1 }, { x: 1.2, y: 0.9, k: 1.0001 })).toBe(true);
  });
});

describe("rubber band", () => {
  it("normalises any drag direction and hit-tests", () => {
    expect(normRect(50, 80, 10, 20)).toEqual({ x: 10, y: 20, w: 40, h: 60 });
    expect(intersects({ x: 0, y: 0, w: 10, h: 10 }, { x: 9, y: 9, w: 5, h: 5 })).toBe(true);
    expect(intersects({ x: 0, y: 0, w: 10, h: 10 }, { x: 10, y: 0, w: 5, h: 5 })).toBe(false);
  });
});
