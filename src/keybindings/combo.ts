// Pure keybinding helpers (no store / DOM globals) so they can be unit-tested in plain node.
//
// Combo string format: modifiers in canonical order "ctrl+alt+shift+meta+<key>", lower-case.
// Keys: letters a-z, digits 0-9, "`", ",", ".", "/", ";", "'", "[", "]", "\\", "-", "=",
// and named keys: tab, enter, escape, space, backspace, delete, insert, home, end, pageup, pagedown,
// arrowup/down/left/right, f1..f24.
//
// Platforms (every function takes an explicit `os`, defaulting to the detected one):
// - Windows / Linux: tokens are the physical keys. "ctrl" = Ctrl, "meta" = Win / Super.
// - macOS: "ctrl" is the PRIMARY modifier, i.e. ⌘ Command, and "meta" is the physical ⌃ Control key.
//   Stored bindings therefore mean the same thing everywhere ("ctrl+shift+p" = Ctrl+Shift+P on
//   Windows, ⇧⌘P on a Mac), saved settings keep working, and ⌃ Control combos (which belong to the
//   terminal on a Mac) can never collide with ⌘ ones. `eventToCombo` swaps the two physical keys on
//   macOS when reading an event; `displayCombo` shows ⌃⌥⇧⌘ glyphs there.

import { t, type MessageKey } from "../i18n";
import { OS, type Os } from "../lib/platform";

export interface Combo {
  ctrl: boolean;
  alt: boolean;
  shift: boolean;
  meta: boolean;
  key: string;
}

/** Minimal shape of a KeyboardEvent that the matcher needs (lets tests pass plain objects). */
export interface KeyLike {
  key: string;
  code: string;
  ctrlKey: boolean;
  altKey: boolean;
  shiftKey: boolean;
  metaKey: boolean;
  isComposing?: boolean;
}

/** Default bindings: command id -> combo. Configurable through settings.keybindings ("" = unbound). */
export const DEFAULT_BINDINGS: Record<string, string> = {
  "view.palette": "ctrl+shift+p",
  "session.new": "ctrl+shift+t",
  "workspace.new": "ctrl+shift+n",
  "session.close": "ctrl+shift+w",
  "session.next": "ctrl+tab",
  "session.prev": "ctrl+shift+tab",
  "session.focus1": "alt+1",
  "session.focus2": "alt+2",
  "session.focus3": "alt+3",
  "session.focus4": "alt+4",
  "session.focus5": "alt+5",
  "session.focus6": "alt+6",
  "session.focus7": "alt+7",
  "session.focus8": "alt+8",
  "session.focus9": "alt+9",
  "workspace.next": "ctrl+shift+pagedown",
  "workspace.prev": "ctrl+shift+pageup",
  "session.splitColumns": "ctrl+shift+d",
  "session.splitRows": "ctrl+shift+e",
  "session.maximize": "ctrl+shift+m",
  "view.toggleSidebar": "ctrl+shift+b",
  "view.toggleInspector": "ctrl+shift+i",
  "view.toggleDiagnostics": "ctrl+shift+`",
  "view.settings": "ctrl+,",
  "group.new": "ctrl+shift+g",
  "attention.next": "ctrl+shift+j",
  "view.fleet": "ctrl+shift+o",
  "session.broadcast": "ctrl+shift+k",
  "view.mission": "ctrl+shift+u",
  "terminal.find": "ctrl+shift+f",
  "terminal.zoomIn": "ctrl+shift+=",
  "terminal.zoomOut": "ctrl+shift+-",
  "terminal.zoomReset": "ctrl+shift+0",
  "view.changes": "ctrl+shift+h",
  "browser.open": "ctrl+shift+l",
};

/**
 * macOS differences from `DEFAULT_BINDINGS` (stored tokens: "ctrl" = ⌘, "meta" = ⌃).
 * ⌘Tab is the app switcher, ⌘` cycles windows and ⌥+digit types characters, so those defaults move.
 */
export const MAC_DEFAULT_OVERRIDES: Record<string, string> = {
  "session.next": "meta+tab", // ⌃⇥, like browser tabs on a Mac
  "session.prev": "meta+shift+tab", // ⌃⇧⇥
  "session.focus1": "ctrl+1", // ⌘1 … ⌘9
  "session.focus2": "ctrl+2",
  "session.focus3": "ctrl+3",
  "session.focus4": "ctrl+4",
  "session.focus5": "ctrl+5",
  "session.focus6": "ctrl+6",
  "session.focus7": "ctrl+7",
  "session.focus8": "ctrl+8",
  "session.focus9": "ctrl+9",
  "view.toggleDiagnostics": "ctrl+alt+`", // ⌥⌘`
};

/** Default bindings for a platform: command id -> combo. */
export function defaultBindings(os: Os = OS): Record<string, string> {
  return os === "macos" ? { ...DEFAULT_BINDINGS, ...MAC_DEFAULT_OVERRIDES } : DEFAULT_BINDINGS;
}

const CODE_KEYS: Record<string, string> = {
  Backquote: "`",
  Comma: ",",
  Period: ".",
  Slash: "/",
  Semicolon: ";",
  Quote: "'",
  BracketLeft: "[",
  BracketRight: "]",
  Backslash: "\\",
  Minus: "-",
  Equal: "=",
};

const KEY_ALIASES: Record<string, string> = {
  " ": "space",
  spacebar: "space",
  esc: "escape",
  return: "enter",
  del: "delete",
  ins: "insert",
  up: "arrowup",
  down: "arrowdown",
  left: "arrowleft",
  right: "arrowright",
  pgup: "pageup",
  pgdn: "pagedown",
  control: "ctrl",
  cmd: "meta",
  win: "meta",
  option: "alt",
  plus: "+",
};

const MODIFIER_KEYS = new Set(["control", "shift", "alt", "meta", "os", "altgraph", "capslock", "numlock"]);

/** Parse "Ctrl+Shift+P" style strings. Returns null for malformed input. */
export function parseCombo(input: string): Combo | null {
  const s = input.trim().toLowerCase();
  if (!s) return null;
  // Allow "+" as a key: "ctrl++" -> ["ctrl", "+"]
  const parts = s.endsWith("++") ? [...s.slice(0, -2).split("+"), "+"] : s.split("+");
  const c: Combo = { ctrl: false, alt: false, shift: false, meta: false, key: "" };
  for (let i = 0; i < parts.length; i++) {
    const raw = parts[i].trim();
    const p = KEY_ALIASES[raw] ?? raw;
    const last = i === parts.length - 1;
    if (!last) {
      if (p === "ctrl") c.ctrl = true;
      else if (p === "alt") c.alt = true;
      else if (p === "shift") c.shift = true;
      else if (p === "meta") c.meta = true;
      else return null;
    } else {
      if (!p || p === "ctrl" || p === "alt" || p === "shift" || p === "meta") return null;
      c.key = p;
    }
  }
  return c;
}

export function formatCombo(c: Combo): string {
  const mods = [c.ctrl && "ctrl", c.alt && "alt", c.shift && "shift", c.meta && "meta"].filter(Boolean);
  return [...mods, c.key].join("+");
}

/** Canonicalise a user/config combo string; null when malformed. */
export function normalizeCombo(input: string): string | null {
  const c = parseCombo(input);
  return c ? formatCombo(c) : null;
}

/** Human label, e.g. "Ctrl+Shift+P", "Alt+1", "Ctrl+Shift+PgDn"; on macOS "⇧⌘P", "⌘1", "⌃⇥". */
export function displayCombo(combo: string, os: Os = OS): string {
  const c = parseCombo(combo);
  if (!c) return combo;
  if (os === "macos") {
    const mac: Record<string, string> = {
      pagedown: t("keys.pageDown"),
      pageup: t("keys.pageUp"),
      arrowup: "↑",
      arrowdown: "↓",
      arrowleft: "←",
      arrowright: "→",
      escape: t("keys.escape"),
      space: t("keys.space"),
      tab: "⇥",
      enter: "↩",
      backspace: "⌫",
      delete: "⌦",
    };
    const key = mac[c.key] ?? (c.key.length === 1 ? c.key.toUpperCase() : c.key[0].toUpperCase() + c.key.slice(1));
    // Apple's order: ⌃ Control, ⌥ Option, ⇧ Shift, ⌘ Command ("meta" token = ⌃, "ctrl" token = ⌘).
    return [c.meta && "⌃", c.alt && "⌥", c.shift && "⇧", c.ctrl && "⌘", key].filter(Boolean).join("");
  }
  // Key caps follow the UI language where keyboards print them differently (Strg / Maj / Mayús …).
  const names: Record<string, string> = {
    pagedown: t("keys.pageDown"),
    pageup: t("keys.pageUp"),
    arrowup: "↑",
    arrowdown: "↓",
    arrowleft: "←",
    arrowright: "→",
    escape: t("keys.escape"),
    space: t("keys.space"),
    tab: t("keys.tab"),
    enter: t("keys.enter"),
    backspace: t("keys.backspace"),
    delete: t("keys.delete"),
    insert: t("keys.insert"),
    home: t("keys.home"),
    end: t("keys.end"),
  };
  const key = names[c.key] ?? (c.key.length === 1 ? c.key.toUpperCase() : c.key[0].toUpperCase() + c.key.slice(1));
  return [c.ctrl && t("keys.ctrl"), c.alt && t("keys.alt"), c.shift && t("keys.shift"), c.meta && (os === "linux" ? t("keys.super") : t("keys.win")), key].filter(Boolean).join("+");
}

/**
 * Convert a keyboard event to a canonical combo string, or null for bare modifier presses / IME.
 * macOS: ⌘ (metaKey) becomes the "ctrl" token and ⌃ (ctrlKey) the "meta" token (see the header).
 */
export function eventToCombo(e: KeyLike, os: Os = OS): string | null {
  if (e.isComposing) return null;
  const k = e.key ?? "";
  if (MODIFIER_KEYS.has(k.toLowerCase()) || k === "Dead" || k === "Unidentified" || k === "Process") {
    // Dead/Unidentified keys still have a usable physical code for punctuation.
    if (!(CODE_KEYS[e.code] && (k === "Dead" || k === "Unidentified"))) return null;
  }
  let key: string;
  if (/^Digit[0-9]$/.test(e.code)) key = e.code.slice(5);
  else if (/^Numpad[0-9]$/.test(e.code)) key = e.code.slice(6);
  else if (CODE_KEYS[e.code]) key = CODE_KEYS[e.code];
  else if (/^[a-z]$/i.test(k)) key = k.toLowerCase();
  else if (/^Key[A-Z]$/.test(e.code) && k.length === 1) key = e.code.slice(3).toLowerCase(); // non-latin layouts
  else {
    const lk = k.toLowerCase();
    key = KEY_ALIASES[lk] ?? lk;
  }
  if (!key) return null;
  const mac = os === "macos";
  return formatCombo({ ctrl: mac ? e.metaKey : e.ctrlKey, alt: e.altKey, shift: e.shiftKey, meta: mac ? e.ctrlKey : e.metaKey, key });
}

const SHELL_KEYS = new Set(["tab", "escape", "enter", "space", "backspace", "delete", "arrowup", "arrowdown", "arrowleft", "arrowright", "home", "end", "insert", "pageup", "pagedown"]);

/**
 * Combos the app must never claim because shells, readline, TUIs and coding agents rely on them.
 * Returns a human-readable reason (in the UI language), or null when the combo is allowed.
 */
export function forbiddenReason(combo: string, os: Os = OS): string | null {
  const key = forbiddenReasonKey(combo, os);
  return key ? t(key) : null;
}

function forbiddenReasonKey(combo: string, os: Os): MessageKey | null {
  const c = parseCombo(combo);
  if (!c) return "keys.reason.invalid";
  if (os === "macos") return forbiddenReasonMac(c);
  const { ctrl, alt, shift, meta, key } = c;
  if (/^f([1-9]|1[0-9]|2[0-4])$/.test(key)) return "keys.reason.functionKeys";
  if (!ctrl && !alt && !meta) return "keys.reason.needsModifier";
  if (ctrl && alt) return "keys.reason.ctrlAlt";
  if (meta) return os === "linux" ? "keys.reason.superReserved" : "keys.reason.winReserved";
  const letter = /^[a-z]$/.test(key);
  if (alt && !ctrl && (letter || SHELL_KEYS.has(key))) return "keys.reason.altLetter";
  if (ctrl && !shift && !alt && (letter || /^[\[\]\\/@^_ ]$/.test(key) || key === "space")) return "keys.reason.ctrlLetter";
  if (ctrl && !alt && ["arrowup", "arrowdown", "arrowleft", "arrowright", "backspace", "delete", "home", "end", "enter", "escape", "space"].includes(key))
    return "keys.reason.wordNavigation";
  if (ctrl && shift && (key === "c" || key === "v")) return "keys.reason.copyPaste";
  return null;
}

const ARROWS_AND_EDIT = ["arrowup", "arrowdown", "arrowleft", "arrowright", "backspace", "delete", "home", "end", "enter", "escape"];

/** ⌘ + key (no ⌥ / ⌃) taken by macOS or the standard Edit menu, by Shift state. */
const MAC_CMD_RESERVED: Record<string, MessageKey> = {
  c: "keys.reason.macCopyPaste",
  v: "keys.reason.macCopyPaste",
  x: "keys.reason.macCopyPaste",
  a: "keys.reason.macSelectAll",
  z: "keys.reason.macUndo",
  q: "keys.reason.macQuit",
  h: "keys.reason.macHide",
  m: "keys.reason.macMinimize",
  w: "keys.reason.macCloseWindow",
  tab: "keys.reason.macAppSwitcher",
  space: "keys.reason.macSpotlight",
  "`": "keys.reason.macCycleWindows",
};
const MAC_CMD_SHIFT_RESERVED: Record<string, MessageKey> = {
  c: "keys.reason.copyPaste",
  v: "keys.reason.copyPaste",
  z: "keys.reason.macRedo",
  q: "keys.reason.macLogOut",
  tab: "keys.reason.macAppSwitcher",
  "`": "keys.reason.macCycleWindows",
  "3": "keys.reason.macScreenshots",
  "4": "keys.reason.macScreenshots",
  "5": "keys.reason.macScreenshots",
};
/** ⌥⌘ + key reserved by macOS. */
const MAC_CMD_OPT_RESERVED: Record<string, MessageKey> = {
  escape: "keys.reason.macForceQuit",
  d: "keys.reason.macDock",
  h: "keys.reason.macHideOthers",
  m: "keys.reason.macMinimizeAll",
  w: "keys.reason.macCloseAll",
  space: "keys.reason.macFinderSearch",
};

/**
 * macOS rules. Tokens: "ctrl" = ⌘ Command, "meta" = ⌃ Control (see the header). ⌃ Control combos go to
 * the terminal (^C, ^D, ^Z, ^R …), except ⌃⇥ / ⌃⇧⇥ which terminals don't use; ⌘ combos are free unless
 * macOS or the Edit menu owns them; ⌥ Option types characters and moves by word.
 */
function forbiddenReasonMac(c: Combo): MessageKey | null {
  const { ctrl, alt, shift, meta, key } = c;
  if (/^f([1-9]|1[0-9]|2[0-4])$/.test(key)) return "keys.reason.functionKeys";
  if (!ctrl && !alt && !meta) return "keys.reason.macNeedsModifier";
  if (meta) {
    if (!ctrl && !alt && key === "tab") return null;
    return "keys.reason.macControl";
  }
  const letter = /^[a-z]$/.test(key);
  if (alt && !ctrl) {
    if (letter || SHELL_KEYS.has(key)) return "keys.reason.macOption";
    return null;
  }
  // ⌘ held from here on.
  if (ARROWS_AND_EDIT.includes(key)) return "keys.reason.macArrows";
  if (alt) return MAC_CMD_OPT_RESERVED[key] ?? null;
  return (shift ? MAC_CMD_SHIFT_RESERVED[key] : MAC_CMD_RESERVED[key]) ?? null;
}

export function isForbiddenCombo(combo: string, os: Os = OS): boolean {
  return forbiddenReasonKey(combo, os) !== null;
}

/**
 * Effective bindings: the platform's defaults overlaid with user overrides. "" in overrides unbinds a
 * command. Malformed or forbidden overrides are ignored (the default stays).
 * Returns combo -> command id.
 */
export function resolveBindings(overrides: Record<string, string> | undefined, os: Os = OS): Map<string, string> {
  const byCommand: Record<string, string> = { ...defaultBindings(os) };
  for (const [id, raw] of Object.entries(overrides ?? {})) {
    if (raw === "") {
      byCommand[id] = "";
      continue;
    }
    const n = normalizeCombo(raw);
    if (n && !isForbiddenCombo(n, os)) byCommand[id] = n;
  }
  const map = new Map<string, string>();
  for (const [id, combo] of Object.entries(byCommand)) {
    if (!combo) continue;
    // Later user overrides win over defaults that collide on the same combo.
    if (map.has(combo) && !(id in (overrides ?? {}))) continue;
    map.set(combo, id);
  }
  return map;
}

/** Command id -> effective combo ("" when unbound). */
export function bindingsByCommand(overrides: Record<string, string> | undefined, os: Os = OS): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [combo, id] of resolveBindings(overrides, os)) out[id] = combo;
  for (const id of Object.keys(DEFAULT_BINDINGS)) if (!(id in out)) out[id] = "";
  return out;
}
