import { describe, expect, it } from "vitest";
import { rightClickDecision } from "./menuBridge";

describe("rightClickDecision", () => {
  it("menu mode (default) opens the menu, whatever is selected", () => {
    expect(rightClickDecision({ mode: "menu", mouseTracking: false, shift: false, hasSelection: false })).toBe("menu");
    expect(rightClickDecision({ mode: "menu", mouseTracking: false, shift: false, hasSelection: true })).toBe("menu");
    expect(rightClickDecision({ mode: undefined, mouseTracking: false, shift: false, hasSelection: false })).toBe("menu");
  });

  it("a program with mouse tracking gets plain right-clicks; Shift+right-click is ours", () => {
    expect(rightClickDecision({ mode: "menu", mouseTracking: true, shift: false, hasSelection: true })).toBe("program");
    expect(rightClickDecision({ mode: "paste", mouseTracking: true, shift: false, hasSelection: false })).toBe("program");
    expect(rightClickDecision({ mode: "menu", mouseTracking: true, shift: true, hasSelection: false })).toBe("menu");
  });

  it("paste mode copies a selection, else pastes (Windows Terminal style)", () => {
    expect(rightClickDecision({ mode: "paste", mouseTracking: false, shift: false, hasSelection: true })).toBe("copy");
    expect(rightClickDecision({ mode: "paste", mouseTracking: false, shift: false, hasSelection: false })).toBe("paste");
    // Shift+right-click with mouse tracking keeps the previous copy-or-paste behaviour.
    expect(rightClickDecision({ mode: "paste", mouseTracking: true, shift: true, hasSelection: false })).toBe("paste");
  });

  it("paste mode keeps the menu reachable with Shift+right-click", () => {
    expect(rightClickDecision({ mode: "paste", mouseTracking: false, shift: true, hasSelection: true })).toBe("menu");
  });
});
