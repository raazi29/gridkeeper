// Pure keybinding helpers (no store / DOM globals) so they can be unit-tested in plain node.
//
// Combo string format: modifiers in canonical order "ctrl+alt+shift+meta+<key>", lower-case.
// Keys: letters a-z, digits 0-9, "`", ",", ".", "/", ";", "'", "[", "]", "\\", "-", "=",
// and named keys: tab, enter, escape, space, backspace, delete, insert, home, end, pageup, pagedown,
// arrowup/down/left/right, f1..f24.

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
};

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

/** Human label, e.g. "Ctrl+Shift+P", "Alt+1", "Ctrl+Shift+PgDn". */
export function displayCombo(combo: string): string {
  const c = parseCombo(combo);
  if (!c) return combo;
  const names: Record<string, string> = {
    pagedown: "PgDn",
    pageup: "PgUp",
    arrowup: "↑",
    arrowdown: "↓",
    arrowleft: "←",
    arrowright: "→",
    escape: "Esc",
    space: "Space",
    tab: "Tab",
    enter: "Enter",
    backspace: "Backspace",
    delete: "Del",
  };
  const key = names[c.key] ?? (c.key.length === 1 ? c.key.toUpperCase() : c.key[0].toUpperCase() + c.key.slice(1));
  return [c.ctrl && "Ctrl", c.alt && "Alt", c.shift && "Shift", c.meta && "Win", key].filter(Boolean).join("+");
}

/** Convert a keyboard event to a canonical combo string, or null for bare modifier presses / IME. */
export function eventToCombo(e: KeyLike): string | null {
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
  return formatCombo({ ctrl: e.ctrlKey, alt: e.altKey, shift: e.shiftKey, meta: e.metaKey, key });
}

const SHELL_KEYS = new Set(["tab", "escape", "enter", "space", "backspace", "delete", "arrowup", "arrowdown", "arrowleft", "arrowright", "home", "end", "insert", "pageup", "pagedown"]);

/**
 * Combos the app must never claim because shells, readline, TUIs and coding agents rely on them.
 * Returns a human-readable reason, or null when the combo is allowed.
 */
export function forbiddenReason(combo: string): string | null {
  const c = parseCombo(combo);
  if (!c) return "Not a valid key combination";
  const { ctrl, alt, shift, meta, key } = c;
  if (/^f([1-9]|1[0-9]|2[0-4])$/.test(key)) return "Function keys are used by terminal apps";
  if (!ctrl && !alt && !meta) return "Needs Ctrl or Alt — plain and Shift+ keys go to the terminal";
  if (ctrl && alt) return "Ctrl+Alt is AltGr on many keyboard layouts";
  if (meta) return "Windows-key combinations are reserved by the OS";
  const letter = /^[a-z]$/.test(key);
  if (alt && !ctrl && (letter || SHELL_KEYS.has(key))) return "Alt+letter is used by shell readline";
  if (ctrl && !shift && !alt && (letter || /^[\[\]\\/@^_ ]$/.test(key) || key === "space")) return "Ctrl+letter is a terminal control key";
  if (ctrl && !alt && ["arrowup", "arrowdown", "arrowleft", "arrowright", "backspace", "delete", "home", "end", "enter", "escape", "space"].includes(key))
    return "Used for word navigation / editing in shells";
  if (ctrl && shift && (key === "c" || key === "v")) return "Reserved for terminal copy / paste";
  return null;
}

export function isForbiddenCombo(combo: string): boolean {
  return forbiddenReason(combo) !== null;
}

/**
 * Effective bindings: defaults overlaid with user overrides. "" in overrides unbinds a command.
 * Malformed or forbidden overrides are ignored (the default stays).
 * Returns combo -> command id.
 */
export function resolveBindings(overrides: Record<string, string> | undefined): Map<string, string> {
  const byCommand: Record<string, string> = { ...DEFAULT_BINDINGS };
  for (const [id, raw] of Object.entries(overrides ?? {})) {
    if (raw === "") {
      byCommand[id] = "";
      continue;
    }
    const n = normalizeCombo(raw);
    if (n && !isForbiddenCombo(n)) byCommand[id] = n;
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
export function bindingsByCommand(overrides: Record<string, string> | undefined): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [combo, id] of resolveBindings(overrides)) out[id] = combo;
  for (const id of Object.keys(DEFAULT_BINDINGS)) if (!(id in out)) out[id] = "";
  return out;
}
