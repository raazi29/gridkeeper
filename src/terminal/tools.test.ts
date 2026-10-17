import { describe, expect, it } from "vitest";
import { MEMORY_PRESSURE_PERCENT, memoryPressure, memoryPressureLabel, webglOverBudget } from "../lib/pressure";
import { findKeyAction, findLabel, queryError } from "./findState";
import { PASTE_MAX_BYTES, checkPaste, countLines, pasteTitle, utf8Length } from "./pasteGuard";
import { ZOOM_MAX_FONT, ZOOM_MIN_FONT, clampZoom, zoomStep } from "./zoom";
import { isLongGap } from "../lib/clockGap";

describe("paste guard", () => {
  it("counts lines, ignoring one trailing break", () => {
    expect(countLines("")).toBe(0);
    expect(countLines("a")).toBe(1);
    expect(countLines("a\n")).toBe(1);
    expect(countLines("a\nb")).toBe(2);
    expect(countLines("a\r\nb\r\n")).toBe(2);
    expect(countLines("a\rb\rc")).toBe(3);
    expect(countLines("\n\n")).toBe(2);
  });

  it("measures UTF-8 bytes", () => {
    expect(utf8Length("abc")).toBe(3);
    expect(utf8Length("é")).toBe(2);
    expect(utf8Length("€")).toBe(3);
    expect(utf8Length("😀")).toBe(4);
  });

  it("asks only for big pastes without bracketed paste, when enabled", () => {
    const lines = (n: number) => Array.from({ length: n }, (_, i) => `echo ${i}`).join("\n");
    expect(checkPaste(lines(20), { bracketed: false, enabled: true }).confirm).toBe(false);
    expect(checkPaste(lines(21), { bracketed: false, enabled: true })).toMatchObject({ confirm: true, lines: 21 });
    expect(checkPaste(lines(21) + "\n", { bracketed: false, enabled: true }).lines).toBe(21);
    expect(checkPaste(lines(500), { bracketed: true, enabled: true }).confirm).toBe(false);
    expect(checkPaste(lines(500), { bracketed: false, enabled: false }).confirm).toBe(false);
    const big = "x".repeat(PASTE_MAX_BYTES + 1);
    expect(checkPaste(big, { bracketed: false, enabled: true })).toMatchObject({ confirm: true, lines: 1 });
    expect(checkPaste("x".repeat(PASTE_MAX_BYTES), { bracketed: false, enabled: true }).confirm).toBe(false);
  });

  it("titles by lines, or by size for a long single line", () => {
    expect(pasteTitle({ confirm: true, lines: 312, bytes: 9000 }, "api")).toBe("Paste 312 lines into api?");
    expect(pasteTitle({ confirm: true, lines: 1, bytes: 200 * 1024 }, "api")).toBe("Paste 200 KiB into api?");
    expect(pasteTitle({ confirm: true, lines: 1500, bytes: 200 * 1024 }, "x")).toBe("Paste 1,500 lines into x?");
  });
});

describe("zoom", () => {
  it("clamps the offset to the font bounds", () => {
    expect(clampZoom(13, 2)).toBe(2);
    expect(clampZoom(13, 100)).toBe(ZOOM_MAX_FONT - 13);
    expect(clampZoom(13, -100)).toBe(ZOOM_MIN_FONT - 13);
    expect(clampZoom(13, Number.NaN)).toBe(0);
  });

  it("steps in, out and resets", () => {
    expect(zoomStep(13, 0, 1)).toBe(1);
    expect(zoomStep(13, 1, -1)).toBe(0);
    expect(zoomStep(13, 5, 0)).toBe(0);
    expect(zoomStep(31, 1, 1)).toBe(1); // already at 32
    expect(zoomStep(8, 0, -1)).toBe(0); // already at 8
    // A stale offset (global size changed) is re-clamped before stepping.
    expect(zoomStep(30, 10, -1)).toBe(1);
  });
});

describe("find bar", () => {
  it("maps keys", () => {
    expect(findKeyAction({ key: "Enter", shiftKey: false })).toBe("next");
    expect(findKeyAction({ key: "Enter", shiftKey: true })).toBe("prev");
    expect(findKeyAction({ key: "Escape", shiftKey: false })).toBe("close");
    expect(findKeyAction({ key: "F3", shiftKey: true })).toBe("prev");
    expect(findKeyAction({ key: "a", shiftKey: false })).toBe(null);
    expect(findKeyAction({ key: "Enter", shiftKey: false, ctrlKey: true })).toBe(null);
  });

  it("validates regexes only in regex mode", () => {
    expect(queryError("a(", true)).toBe("Invalid regex");
    expect(queryError("a(", false)).toBe(null);
    expect(queryError("a+", true)).toBe(null);
  });

  it("labels match feedback", () => {
    const base = { query: "err", regex: false, found: null, results: null };
    expect(findLabel({ ...base, query: "" })).toBe("");
    expect(findLabel(base)).toBe("");
    expect(findLabel({ ...base, found: false })).toBe("No results");
    expect(findLabel({ ...base, found: true, results: { index: 2, count: 7 } })).toBe("3 of 7");
    expect(findLabel({ ...base, results: { index: -1, count: 0 } })).toBe("No results");
    expect(findLabel({ ...base, results: { index: -1, count: 1000 } })).toBe("1000+ matches");
    expect(findLabel({ ...base, query: "(", regex: true, found: false })).toBe("Invalid regex");
  });
});

describe("memory pressure", () => {
  const GB = 1024 ** 3;
  it("flags use above the threshold", () => {
    expect(MEMORY_PRESSURE_PERCENT).toBe(85);
    expect(memoryPressure(13.5 * GB, 16 * GB)).toEqual({ percent: 84, high: false });
    expect(memoryPressure(14.6 * GB, 16 * GB)).toEqual({ percent: 91, high: true });
    expect(memoryPressureLabel({ percent: 91, high: true })).toBe("Memory 91% — close idle sessions");
  });

  it("never guesses from missing figures", () => {
    expect(memoryPressure(0, 16 * GB)).toBe(null);
    expect(memoryPressure(5, 0)).toBe(null);
    expect(memoryPressure(undefined, undefined)).toBe(null);
  });

  it("detects more visible panes than WebGL contexts", () => {
    expect(webglOverBudget(12)).toBe(false);
    expect(webglOverBudget(13)).toBe(true);
    expect(webglOverBudget(5, 4)).toBe(true);
  });
});

describe("resume detection", () => {
  it("treats only long gaps as a possible sleep", () => {
    expect(isLongGap(0, 59_000)).toBe(false);
    expect(isLongGap(0, 61_000)).toBe(true);
    expect(isLongGap(100_000, 50_000)).toBe(true); // clock moved backwards: resync too
  });
});
