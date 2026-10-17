import { describe, expect, it } from "vitest";
import {
  DEFAULT_BINDINGS,
  bindingsByCommand,
  displayCombo,
  eventToCombo,
  forbiddenReason,
  isForbiddenCombo,
  normalizeCombo,
  parseCombo,
  resolveBindings,
  type KeyLike,
} from "./combo";

function ev(key: string, code: string, mods: Partial<Pick<KeyLike, "ctrlKey" | "altKey" | "shiftKey" | "metaKey">> = {}): KeyLike {
  return { key, code, ctrlKey: false, altKey: false, shiftKey: false, metaKey: false, ...mods };
}

describe("parseCombo / normalizeCombo", () => {
  it("parses and canonicalises modifier order and case", () => {
    expect(parseCombo("Shift+Ctrl+P")).toEqual({ ctrl: true, alt: false, shift: true, meta: false, key: "p" });
    expect(normalizeCombo("shift+ctrl+p")).toBe("ctrl+shift+p");
    expect(normalizeCombo("Ctrl+Shift+PgDn")).toBe("ctrl+shift+pagedown");
    expect(normalizeCombo("alt+1")).toBe("alt+1");
    expect(normalizeCombo("ctrl+,")).toBe("ctrl+,");
    expect(normalizeCombo("ctrl++")).toBe("ctrl++");
  });
  it("rejects malformed input", () => {
    expect(parseCombo("")).toBeNull();
    expect(parseCombo("ctrl+")).toBeNull();
    expect(parseCombo("ctrl+shift")).toBeNull();
    expect(parseCombo("hyper+x")).toBeNull();
  });
  it("formats for display", () => {
    expect(displayCombo("ctrl+shift+p")).toBe("Ctrl+Shift+P");
    expect(displayCombo("ctrl+shift+pagedown")).toBe("Ctrl+Shift+PgDn");
    expect(displayCombo("ctrl+shift+`")).toBe("Ctrl+Shift+`");
  });
});

describe("eventToCombo", () => {
  it("lower-cases shifted letters", () => {
    expect(eventToCombo(ev("P", "KeyP", { ctrlKey: true, shiftKey: true }))).toBe("ctrl+shift+p");
  });
  it("uses e.code for digits so Shift / AZERTY layouts still match", () => {
    expect(eventToCombo(ev("&", "Digit1", { altKey: true }))).toBe("alt+1");
    expect(eventToCombo(ev("!", "Digit1", { altKey: true, shiftKey: true }))).toBe("alt+shift+1");
  });
  it("uses e.code for backquote and comma", () => {
    expect(eventToCombo(ev("~", "Backquote", { ctrlKey: true, shiftKey: true }))).toBe("ctrl+shift+`");
    expect(eventToCombo(ev("Dead", "Backquote", { ctrlKey: true, shiftKey: true }))).toBe("ctrl+shift+`");
    expect(eventToCombo(ev(",", "Comma", { ctrlKey: true }))).toBe("ctrl+,");
  });
  it("maps named keys", () => {
    expect(eventToCombo(ev("Tab", "Tab", { ctrlKey: true }))).toBe("ctrl+tab");
    expect(eventToCombo(ev("Tab", "Tab", { ctrlKey: true, shiftKey: true }))).toBe("ctrl+shift+tab");
    expect(eventToCombo(ev("PageDown", "PageDown", { ctrlKey: true, shiftKey: true }))).toBe("ctrl+shift+pagedown");
    expect(eventToCombo(ev(" ", "Space", { ctrlKey: true }))).toBe("ctrl+space");
  });
  it("falls back to physical key on non-latin layouts", () => {
    expect(eventToCombo(ev("З", "KeyP", { ctrlKey: true, shiftKey: true }))).toBe("ctrl+shift+p");
  });
  it("ignores bare modifiers and IME composition", () => {
    expect(eventToCombo(ev("Control", "ControlLeft", { ctrlKey: true }))).toBeNull();
    expect(eventToCombo(ev("Shift", "ShiftLeft", { shiftKey: true }))).toBeNull();
    expect(eventToCombo({ ...ev("a", "KeyA"), isComposing: true })).toBeNull();
  });
  it("keeps AltGr (ctrl+alt) distinct from alt", () => {
    expect(eventToCombo(ev("1", "Digit1", { ctrlKey: true, altKey: true }))).toBe("ctrl+alt+1");
  });
});

describe("forbidden combos", () => {
  const forbidden = [
    "ctrl+c", "ctrl+v", "ctrl+d", "ctrl+z", "ctrl+r", "ctrl+l", "ctrl+a", "ctrl+e", "ctrl+k", "ctrl+u", "ctrl+w",
    "ctrl+arrowleft", "ctrl+shift+arrowright", "tab", "shift+tab", "escape", "enter", "shift+enter", "arrowup",
    "alt+b", "alt+f", "alt+shift+x", "f1", "f5", "ctrl+f5", "shift+f10", "a", "shift+a", "ctrl+alt+1",
    "ctrl+shift+c", "ctrl+shift+v", "ctrl+backspace", "ctrl+space",
  ];
  for (const c of forbidden) it(`forbids ${c}`, () => expect(isForbiddenCombo(c)).toBe(true));

  it("allows every default binding", () => {
    for (const [id, combo] of Object.entries(DEFAULT_BINDINGS)) {
      expect(forbiddenReason(combo), `${id} = ${combo}`).toBeNull();
    }
  });
  it("defaults are unique", () => {
    const combos = Object.values(DEFAULT_BINDINGS);
    expect(new Set(combos).size).toBe(combos.length);
  });
});

describe("resolveBindings", () => {
  it("maps defaults combo -> command", () => {
    const m = resolveBindings({});
    expect(m.get("ctrl+shift+p")).toBe("view.palette");
    expect(m.get("alt+3")).toBe("session.focus3");
    expect(m.get("ctrl+c")).toBeUndefined();
  });
  it("binds the attention commands by default", () => {
    const m = resolveBindings({});
    expect(m.get("ctrl+shift+j")).toBe("attention.next");
    expect(m.get("ctrl+shift+o")).toBe("view.fleet");
    expect(m.get("ctrl+shift+k")).toBe("session.broadcast");
    for (const c of ["ctrl+shift+j", "ctrl+shift+o", "ctrl+shift+k"]) expect(forbiddenReason(c)).toBeNull();
  });
  it("applies overrides, unbinding and ignores forbidden ones", () => {
    const m = resolveBindings({ "view.palette": "ctrl+shift+y", "session.new": "", "group.new": "ctrl+c" });
    expect(m.get("ctrl+shift+y")).toBe("view.palette");
    expect(m.get("ctrl+shift+p")).toBeUndefined();
    expect(m.get("ctrl+shift+t")).toBeUndefined();
    expect(m.get("ctrl+shift+g")).toBe("group.new");
    expect(m.get("ctrl+c")).toBeUndefined();
  });
  it("user override wins a collision with a default", () => {
    const m = resolveBindings({ "view.palette": "ctrl+shift+t" });
    expect(m.get("ctrl+shift+t")).toBe("view.palette");
    expect(bindingsByCommand({ "view.palette": "ctrl+shift+t" })["session.new"]).toBe("");
  });
});

describe("Mission Control binding", () => {
  it("binds view.mission to an allowed, unique combo", () => {
    expect(DEFAULT_BINDINGS["view.mission"]).toBe("ctrl+shift+u");
    expect(forbiddenReason("ctrl+shift+u")).toBeNull();
    expect(resolveBindings({}).get("ctrl+shift+u")).toBe("view.mission");
    const combos = Object.values(DEFAULT_BINDINGS);
    expect(new Set(combos).size).toBe(combos.length);
  });
});
