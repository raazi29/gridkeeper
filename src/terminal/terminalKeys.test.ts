import { describe, expect, it } from "vitest";
import { clipboardKeyAction, copyHint, keyLetter, linkHint, linkModifierHeld, pasteHint, type TermKeyLike } from "./terminalKeys";

function k(key: string, mods: Partial<Pick<TermKeyLike, "ctrlKey" | "altKey" | "shiftKey" | "metaKey">> = {}, code = `Key${key.toUpperCase()}`): TermKeyLike {
  return { key, code, ctrlKey: false, altKey: false, shiftKey: false, metaKey: false, ...mods };
}

describe("clipboard keys on Windows / Linux (Windows Terminal behaviour)", () => {
  for (const os of ["windows", "linux"] as const) {
    it(`${os}: Ctrl+C copies and clears a selection, else goes to the program`, () => {
      expect(clipboardKeyAction(k("c", { ctrlKey: true }), true, os)).toBe("copy-clear");
      expect(clipboardKeyAction(k("c", { ctrlKey: true }), false, os)).toBe("pass");
      expect(clipboardKeyAction(k("C", { ctrlKey: true, shiftKey: true }), false, os)).toBe("copy");
      expect(clipboardKeyAction(k("v", { ctrlKey: true }), false, os)).toBe("paste");
      expect(clipboardKeyAction(k("V", { ctrlKey: true, shiftKey: true }), false, os)).toBe("paste");
    });
    it(`${os}: AltGr, Win/Super and other keys go to xterm`, () => {
      expect(clipboardKeyAction(k("c", { ctrlKey: true, altKey: true }), true, os)).toBe("pass");
      expect(clipboardKeyAction(k("v", { ctrlKey: true, metaKey: true }), true, os)).toBe("pass");
      expect(clipboardKeyAction(k("v", { metaKey: true }), true, os)).toBe("pass");
      expect(clipboardKeyAction(k("d", { ctrlKey: true }), true, os)).toBe("pass");
    });
  }
  it("non-Latin layouts use the physical key", () => {
    expect(keyLetter({ key: "с", code: "KeyC" })).toBe("c");
    expect(clipboardKeyAction(k("м", { ctrlKey: true }, "KeyV"), false, "windows")).toBe("paste");
  });
});

describe("clipboard keys on macOS", () => {
  it("⌘C copies a selection (keeping it), ⌘V pastes", () => {
    expect(clipboardKeyAction(k("c", { metaKey: true }), true, "macos")).toBe("copy");
    expect(clipboardKeyAction(k("c", { metaKey: true }), false, "macos")).toBe("pass");
    expect(clipboardKeyAction(k("v", { metaKey: true }), false, "macos")).toBe("paste");
    expect(clipboardKeyAction(k("V", { metaKey: true, shiftKey: true }), false, "macos")).toBe("paste");
  });
  it("⌃C always reaches the program, even with a selection; ⌃V too", () => {
    expect(clipboardKeyAction(k("c", { ctrlKey: true }), true, "macos")).toBe("pass");
    expect(clipboardKeyAction(k("v", { ctrlKey: true }), false, "macos")).toBe("pass");
    expect(clipboardKeyAction(k("C", { ctrlKey: true, shiftKey: true }), true, "macos")).toBe("pass");
  });
  it("⌥ and ⌃⌘ combos go to xterm", () => {
    expect(clipboardKeyAction(k("c", { metaKey: true, altKey: true }), true, "macos")).toBe("pass");
    expect(clipboardKeyAction(k("v", { metaKey: true, ctrlKey: true }), true, "macos")).toBe("pass");
  });
});

describe("links and hints", () => {
  it("opens links with Ctrl+click, ⌘-click on macOS", () => {
    expect(linkModifierHeld({ ctrlKey: true, metaKey: false }, "windows")).toBe(true);
    expect(linkModifierHeld({ ctrlKey: false, metaKey: true }, "windows")).toBe(false);
    expect(linkModifierHeld({ ctrlKey: true, metaKey: false }, "linux")).toBe(true);
    expect(linkModifierHeld({ ctrlKey: false, metaKey: true }, "macos")).toBe(true);
    expect(linkModifierHeld({ ctrlKey: true, metaKey: false }, "macos")).toBe(false);
    expect(linkHint("windows")).toBe("Ctrl+click: open in browser · Ctrl+Shift+click: open in a Gridkeeper browser pane");
    expect(linkHint("macos")).toMatch(/^⌘-click/);
  });
  it("menu hints follow the platform", () => {
    expect(copyHint("windows")).toBe("Ctrl+Shift+C");
    expect(pasteHint("windows")).toBe("Ctrl+V");
    expect(copyHint("macos")).toBe("⌘C");
    expect(pasteHint("macos")).toBe("⌘V");
  });
});
