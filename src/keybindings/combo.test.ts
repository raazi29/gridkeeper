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
  defaultBindings,
  MAC_DEFAULT_OVERRIDES,
  type KeyLike,
} from "./combo";

// Pinned platforms: the default `os` follows the host (vitest's Node `navigator.platform`), and CI runs on
// Windows, Linux and macOS. Everything that asserts Windows behaviour passes W explicitly.
const W = "windows" as const;
const MAC = "macos" as const;
const LINUX = "linux" as const;

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
    expect(displayCombo("ctrl+shift+p", W)).toBe("Ctrl+Shift+P");
    expect(displayCombo("ctrl+shift+pagedown", W)).toBe("Ctrl+Shift+PgDn");
    expect(displayCombo("ctrl+shift+`", W)).toBe("Ctrl+Shift+`");
  });
});

describe("eventToCombo", () => {
  it("lower-cases shifted letters", () => {
    expect(eventToCombo(ev("P", "KeyP", { ctrlKey: true, shiftKey: true }), W)).toBe("ctrl+shift+p");
  });
  it("uses e.code for digits so Shift / AZERTY layouts still match", () => {
    expect(eventToCombo(ev("&", "Digit1", { altKey: true }), W)).toBe("alt+1");
    expect(eventToCombo(ev("!", "Digit1", { altKey: true, shiftKey: true }), W)).toBe("alt+shift+1");
  });
  it("uses e.code for backquote and comma", () => {
    expect(eventToCombo(ev("~", "Backquote", { ctrlKey: true, shiftKey: true }), W)).toBe("ctrl+shift+`");
    expect(eventToCombo(ev("Dead", "Backquote", { ctrlKey: true, shiftKey: true }), W)).toBe("ctrl+shift+`");
    expect(eventToCombo(ev(",", "Comma", { ctrlKey: true }), W)).toBe("ctrl+,");
  });
  it("maps named keys", () => {
    expect(eventToCombo(ev("Tab", "Tab", { ctrlKey: true }), W)).toBe("ctrl+tab");
    expect(eventToCombo(ev("Tab", "Tab", { ctrlKey: true, shiftKey: true }), W)).toBe("ctrl+shift+tab");
    expect(eventToCombo(ev("PageDown", "PageDown", { ctrlKey: true, shiftKey: true }), W)).toBe("ctrl+shift+pagedown");
    expect(eventToCombo(ev(" ", "Space", { ctrlKey: true }), W)).toBe("ctrl+space");
  });
  it("falls back to physical key on non-latin layouts", () => {
    expect(eventToCombo(ev("З", "KeyP", { ctrlKey: true, shiftKey: true }), W)).toBe("ctrl+shift+p");
  });
  it("ignores bare modifiers and IME composition", () => {
    expect(eventToCombo(ev("Control", "ControlLeft", { ctrlKey: true }), W)).toBeNull();
    expect(eventToCombo(ev("Shift", "ShiftLeft", { shiftKey: true }), W)).toBeNull();
    expect(eventToCombo({ ...ev("a", "KeyA"), isComposing: true }, W)).toBeNull();
  });
  it("keeps AltGr (ctrl+alt) distinct from alt", () => {
    expect(eventToCombo(ev("1", "Digit1", { ctrlKey: true, altKey: true }), W)).toBe("ctrl+alt+1");
  });
});

describe("forbidden combos", () => {
  const forbidden = [
    "ctrl+c", "ctrl+v", "ctrl+d", "ctrl+z", "ctrl+r", "ctrl+l", "ctrl+a", "ctrl+e", "ctrl+k", "ctrl+u", "ctrl+w",
    "ctrl+arrowleft", "ctrl+shift+arrowright", "tab", "shift+tab", "escape", "enter", "shift+enter", "arrowup",
    "alt+b", "alt+f", "alt+shift+x", "f1", "f5", "ctrl+f5", "shift+f10", "a", "shift+a", "ctrl+alt+1",
    "ctrl+shift+c", "ctrl+shift+v", "ctrl+backspace", "ctrl+space",
  ];
  for (const c of forbidden) it(`forbids ${c}`, () => expect(isForbiddenCombo(c, W)).toBe(true));

  it("allows every default binding", () => {
    for (const [id, combo] of Object.entries(DEFAULT_BINDINGS)) {
      expect(forbiddenReason(combo, W), `${id} = ${combo}`).toBeNull();
    }
  });
  it("defaults are unique", () => {
    const combos = Object.values(DEFAULT_BINDINGS);
    expect(new Set(combos).size).toBe(combos.length);
  });
});

describe("resolveBindings", () => {
  it("maps defaults combo -> command", () => {
    const m = resolveBindings({}, W);
    expect(m.get("ctrl+shift+p")).toBe("view.palette");
    expect(m.get("alt+3")).toBe("session.focus3");
    expect(m.get("ctrl+c")).toBeUndefined();
  });
  it("binds the attention commands by default", () => {
    const m = resolveBindings({}, W);
    expect(m.get("ctrl+shift+j")).toBe("attention.next");
    expect(m.get("ctrl+shift+o")).toBe("view.fleet");
    expect(m.get("ctrl+shift+k")).toBe("session.broadcast");
    for (const c of ["ctrl+shift+j", "ctrl+shift+o", "ctrl+shift+k"]) expect(forbiddenReason(c, W)).toBeNull();
  });
  it("applies overrides, unbinding and ignores forbidden ones", () => {
    const m = resolveBindings({ "view.palette": "ctrl+shift+y", "session.new": "", "group.new": "ctrl+c" }, W);
    expect(m.get("ctrl+shift+y")).toBe("view.palette");
    expect(m.get("ctrl+shift+p")).toBeUndefined();
    expect(m.get("ctrl+shift+t")).toBeUndefined();
    expect(m.get("ctrl+shift+g")).toBe("group.new");
    expect(m.get("ctrl+c")).toBeUndefined();
  });
  it("user override wins a collision with a default", () => {
    const m = resolveBindings({ "view.palette": "ctrl+shift+t" }, W);
    expect(m.get("ctrl+shift+t")).toBe("view.palette");
    expect(bindingsByCommand({ "view.palette": "ctrl+shift+t" }, W)["session.new"]).toBe("");
  });
});

describe("built-in tools bindings", () => {
  it("binds view.changes and browser.open to allowed, unique combos", () => {
    expect(DEFAULT_BINDINGS["view.changes"]).toBe("ctrl+shift+h");
    expect(DEFAULT_BINDINGS["browser.open"]).toBe("ctrl+shift+l");
    for (const c of ["ctrl+shift+h", "ctrl+shift+l"]) expect(forbiddenReason(c, W)).toBeNull();
    expect(resolveBindings({}, W).get("ctrl+shift+h")).toBe("view.changes");
    expect(resolveBindings({}, W).get("ctrl+shift+l")).toBe("browser.open");
    const combos = Object.values(DEFAULT_BINDINGS);
    expect(new Set(combos).size).toBe(combos.length);
  });
});

describe("Mission Control binding", () => {
  it("binds view.mission to an allowed, unique combo", () => {
    expect(DEFAULT_BINDINGS["view.mission"]).toBe("ctrl+shift+u");
    expect(forbiddenReason("ctrl+shift+u", W)).toBeNull();
    expect(resolveBindings({}, W).get("ctrl+shift+u")).toBe("view.mission");
    const combos = Object.values(DEFAULT_BINDINGS);
    expect(new Set(combos).size).toBe(combos.length);
  });
});

describe("macOS: ⌘ is the primary modifier", () => {
  it("reads ⌘ as the stored ctrl token and ⌃ as meta", () => {
    expect(eventToCombo(ev("p", "KeyP", { metaKey: true, shiftKey: true }), MAC)).toBe("ctrl+shift+p");
    expect(eventToCombo(ev("1", "Digit1", { metaKey: true }), MAC)).toBe("ctrl+1");
    expect(eventToCombo(ev("Tab", "Tab", { ctrlKey: true }), MAC)).toBe("meta+tab");
    expect(eventToCombo(ev("c", "KeyC", { ctrlKey: true }), MAC)).toBe("meta+c");
    // ⌥ types characters: the physical key still names the combo.
    expect(eventToCombo(ev("π", "KeyP", { metaKey: true, altKey: true }), MAC)).toBe("ctrl+alt+p");
    expect(eventToCombo(ev("Meta", "MetaLeft", { metaKey: true }), MAC)).toBeNull();
  });
  it("matches saved bindings with ⌘ (same stored string as Ctrl on Windows)", () => {
    const m = resolveBindings({ "view.palette": "ctrl+shift+y" }, MAC);
    expect(m.get(eventToCombo(ev("Y", "KeyY", { metaKey: true, shiftKey: true }), MAC)!)).toBe("view.palette");
    // Physical Ctrl+Shift+Y on a Mac is a different combo and does not fire it.
    expect(m.get(eventToCombo(ev("Y", "KeyY", { ctrlKey: true, shiftKey: true }), MAC)!)).toBeUndefined();
    expect(resolveBindings({}, MAC).get("ctrl+shift+p")).toBe("view.palette");
  });
  it("displays ⌃⌥⇧⌘ glyphs in Apple's order", () => {
    expect(displayCombo("ctrl+shift+p", MAC)).toBe("⇧⌘P");
    expect(displayCombo("ctrl+alt+`", MAC)).toBe("⌥⌘`");
    expect(displayCombo("meta+shift+tab", MAC)).toBe("⌃⇧⇥");
    expect(displayCombo("ctrl+,", MAC)).toBe("⌘,");
    expect(displayCombo("ctrl+shift+pagedown", MAC)).toBe("⇧⌘PgDn");
  });
  it("keeps terminal and system keys out of reach", () => {
    const forbidden = [
      // ⌃ Control combos belong to the terminal
      "meta+c", "meta+d", "meta+z", "meta+r", "meta+l", "meta+a", "meta+e", "meta+u", "meta+k", "meta+w", "meta+shift+p", "ctrl+meta+f",
      // copy / paste / cut / select all / undo / redo
      "ctrl+c", "ctrl+v", "ctrl+x", "ctrl+a", "ctrl+z", "ctrl+shift+z", "ctrl+shift+c", "ctrl+shift+v",
      // macOS app and system shortcuts
      "ctrl+q", "ctrl+h", "ctrl+m", "ctrl+w", "ctrl+tab", "ctrl+shift+tab", "ctrl+space", "ctrl+`", "ctrl+shift+`",
      "ctrl+shift+3", "ctrl+shift+4", "ctrl+shift+5", "ctrl+shift+q", "ctrl+alt+escape", "ctrl+alt+h", "ctrl+alt+m", "ctrl+alt+d",
      // line editing, Option typing, plain keys, function keys
      "ctrl+arrowleft", "ctrl+backspace", "ctrl+shift+arrowright", "alt+b", "alt+f", "alt+arrowleft", "a", "shift+a", "tab", "escape", "f5", "ctrl+f5",
    ];
    for (const c of forbidden) expect(forbiddenReason(c, MAC), c).not.toBeNull();
  });
  it("allows ⌘ shortcuts that are free on a Mac, ⌃⇥ and ⌥⌘", () => {
    for (const c of ["ctrl+t", "ctrl+k", "ctrl+1", "ctrl+,", "meta+tab", "meta+shift+tab", "ctrl+alt+`", "ctrl+alt+p", "ctrl+shift+p"])
      expect(forbiddenReason(c, MAC), c).toBeNull();
  });
  it("has allowed, unique defaults that differ only where macOS needs it", () => {
    const d = defaultBindings(MAC);
    for (const [id, combo] of Object.entries(d)) expect(forbiddenReason(combo, MAC), `${id} = ${combo}`).toBeNull();
    expect(new Set(Object.values(d)).size).toBe(Object.values(d).length);
    expect(Object.keys(d).sort()).toEqual(Object.keys(DEFAULT_BINDINGS).sort());
    for (const id of Object.keys(DEFAULT_BINDINGS))
      if (!(id in MAC_DEFAULT_OVERRIDES)) expect(d[id], id).toBe(DEFAULT_BINDINGS[id]);
    expect(d["session.next"]).toBe("meta+tab");
    expect(d["session.focus1"]).toBe("ctrl+1");
    expect(resolveBindings({}, MAC).get("meta+tab")).toBe("session.next");
    // The Windows defaults are untouched.
    expect(defaultBindings(W)).toBe(DEFAULT_BINDINGS);
    expect(bindingsByCommand({}, MAC)["session.focus3"]).toBe("ctrl+3");
  });
  it("ignores saved overrides that macOS forbids (the default stays)", () => {
    const m = resolveBindings({ "view.palette": "ctrl+c" }, MAC);
    expect(m.get("ctrl+c")).toBeUndefined();
    expect(m.get("ctrl+shift+p")).toBe("view.palette");
  });
});

describe("Linux", () => {
  it("uses the Windows rules and defaults, naming the Super key", () => {
    expect(defaultBindings(LINUX)).toBe(DEFAULT_BINDINGS);
    expect(displayCombo("ctrl+shift+p", LINUX)).toBe("Ctrl+Shift+P");
    expect(displayCombo("meta+e", LINUX)).toBe("Super+E");
    expect(displayCombo("meta+e", W)).toBe("Win+E");
    expect(forbiddenReason("meta+e", LINUX)).toMatch(/Super/);
    expect(eventToCombo(ev("P", "KeyP", { ctrlKey: true, shiftKey: true }), LINUX)).toBe("ctrl+shift+p");
    for (const c of ["ctrl+c", "ctrl+d", "ctrl+shift+c", "ctrl+shift+v", "alt+b", "ctrl+alt+1"]) expect(isForbiddenCombo(c, LINUX), c).toBe(true);
    for (const combo of Object.values(DEFAULT_BINDINGS)) expect(forbiddenReason(combo, LINUX), combo).toBeNull();
  });
});
