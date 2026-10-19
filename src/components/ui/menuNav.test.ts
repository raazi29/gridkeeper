import { describe, expect, it } from "vitest";
import { firstIndex, lastIndex, menuKey, moveIndex, placeMenu, typeaheadIndex, type NavItem } from "./menuNav";

const items: NavItem[] = [
  { label: "Copy", disabled: true },
  { label: "Paste" },
  "separator",
  { label: "Zoom", hasChildren: true },
  { label: "Close", disabled: true },
  { label: "Rename" },
];

describe("moveIndex", () => {
  it("skips separators and disabled items and wraps", () => {
    expect(firstIndex(items)).toBe(1);
    expect(lastIndex(items)).toBe(5);
    expect(moveIndex(items, 1, 1)).toBe(3);
    expect(moveIndex(items, 3, 1)).toBe(5);
    expect(moveIndex(items, 5, 1)).toBe(1); // wrap
    expect(moveIndex(items, 1, -1)).toBe(5); // wrap backwards
  });
  it("returns -1 when nothing is focusable", () => {
    expect(moveIndex([{ label: "x", disabled: true }, "separator"], -1, 1)).toBe(-1);
    expect(moveIndex([], 0, 1)).toBe(-1);
  });
});

describe("menuKey", () => {
  it("moves with arrows, Home and End", () => {
    expect(menuKey("ArrowDown", items, 1, 0)).toEqual({ type: "move", index: 3 });
    expect(menuKey("ArrowUp", items, 3, 0)).toEqual({ type: "move", index: 1 });
    expect(menuKey("Home", items, 5, 0)).toEqual({ type: "move", index: 1 });
    expect(menuKey("End", items, 1, 0)).toEqual({ type: "move", index: 5 });
  });
  it("opens a submenu with ArrowRight / Enter / Space on a parent item", () => {
    expect(menuKey("ArrowRight", items, 3, 0)).toEqual({ type: "open", index: 3 });
    expect(menuKey("Enter", items, 3, 0)).toEqual({ type: "open", index: 3 });
    expect(menuKey(" ", items, 3, 0)).toEqual({ type: "open", index: 3 });
  });
  it("ArrowRight on a leaf does nothing; Enter activates it", () => {
    expect(menuKey("ArrowRight", items, 1, 0)).toEqual({ type: "none" });
    expect(menuKey("Enter", items, 1, 0)).toEqual({ type: "activate", index: 1 });
  });
  it("never activates disabled items or separators", () => {
    expect(menuKey("Enter", items, 0, 0)).toEqual({ type: "none" });
    expect(menuKey("Enter", items, 2, 0)).toEqual({ type: "none" });
  });
  it("ArrowLeft closes a submenu level, but not the root menu", () => {
    expect(menuKey("ArrowLeft", items, 1, 1)).toEqual({ type: "close", scope: "level" });
    expect(menuKey("ArrowLeft", items, 1, 0)).toEqual({ type: "none" });
  });
  it("Escape closes one level in a submenu and the whole menu at the root; Tab closes all", () => {
    expect(menuKey("Escape", items, 1, 2)).toEqual({ type: "close", scope: "level" });
    expect(menuKey("Escape", items, 1, 0)).toEqual({ type: "close", scope: "all" });
    expect(menuKey("Tab", items, 1, 1)).toEqual({ type: "close", scope: "all" });
  });
  it("type-ahead jumps to the next enabled item starting with the letter", () => {
    expect(menuKey("r", items, 1, 0)).toEqual({ type: "move", index: 5 });
    expect(menuKey("c", items, 1, 0)).toEqual({ type: "none" }); // Copy and Close are disabled
    expect(typeaheadIndex(items, 5, "p")).toBe(1); // wraps
  });
});

describe("placeMenu", () => {
  const view = { width: 1000, height: 800 };
  const size = { width: 200, height: 300 };

  it("opens a context menu at the pointer", () => {
    expect(placeMenu({ x: 100, y: 100 }, size, view)).toEqual({ left: 100, top: 100 });
  });

  it("flips a context menu above the pointer near the bottom and shifts it left near the right edge", () => {
    expect(placeMenu({ x: 950, y: 700 }, size, view)).toEqual({ left: 796, top: 400 });
  });

  it("keeps a context menu inside the viewport when it fits neither below nor above the pointer", () => {
    expect(placeMenu({ x: 10, y: 200 }, { width: 200, height: 700 }, view)).toEqual({ left: 10, top: 4 });
  });

  it("hangs a dropdown below its button", () => {
    const rect = { top: 100, bottom: 122, left: 300, right: 400 };
    expect(placeMenu({ x: 300, y: 124, rect }, size, view)).toEqual({ left: 300, top: 124 });
  });

  it("opens a dropdown above its button near the bottom (never over the button)", () => {
    const rect = { top: 700, bottom: 722, left: 300, right: 400 };
    const p = placeMenu({ x: 300, y: 724, rect }, size, view);
    expect(p).toEqual({ left: 300, top: 398 });
    expect(p.top + size.height).toBeLessThanOrEqual(rect.top);
  });

  it("uses the roomier side when the dropdown fits on neither", () => {
    const rect = { top: 300, bottom: 322, left: 300, right: 400 };
    expect(placeMenu({ x: 300, y: 324, rect }, { width: 200, height: 600 }, view)).toEqual({ left: 300, top: 196 });
  });
});
