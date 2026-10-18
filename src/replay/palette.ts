// Mission replay colours: resolved from a Gridkeeper theme (pure data) or from the live CSS variables of
// the running app (so the active theme, including a Saber Duel blade accent, is what the video shows).

import { getTheme, mixHex, parseColor, type Theme } from "../theme/themes";
import { normalizeRole } from "../lib/roles";

export interface ReplayPalette {
  kind: "dark" | "light";
  bg0: string;
  bg1: string;
  bg2: string;
  bg3: string;
  border: string;
  borderStrong: string;
  text0: string;
  text1: string;
  text2: string;
  accent: string;
  accent2: string;
  ok: string;
  warn: string;
  err: string;
  info: string;
  roles: Record<string, string>;
  roleCustom: string;
}

/** Same bases as the --role-* variables in styles/mission.css (mixed toward the text colour). */
const ROLE_BASE: Record<string, [string, number]> = {
  lead: ["#b69cff", 0.24],
  scout: ["#5aa9ff", 0.24],
  builder: ["#ff9a3d", 0.22],
  reviewer: ["#34c98a", 0.24],
  verifier: ["#ff6fae", 0.24],
};

/** #rrggbb of any colour the theme files use (#rgb, #rrggbbaa, rgb(a)) — alpha dropped. */
export function hex6(c: string, fallback = "#000000"): string {
  try {
    const [r, g, b] = parseColor(c);
    const h = (n: number) => Math.round(Math.max(0, Math.min(255, n))).toString(16).padStart(2, "0");
    return `#${h(r)}${h(g)}${h(b)}`;
  } catch {
    return fallback;
  }
}

type Base = Omit<ReplayPalette, "roles" | "roleCustom">;

function withRoles(p: Base): ReplayPalette {
  const roles: Record<string, string> = {};
  for (const [id, [base, t]] of Object.entries(ROLE_BASE)) roles[id] = mixHex(base, p.text0, t);
  return { ...p, roles, roleCustom: p.text1 };
}

export function paletteFromTheme(t: Theme): ReplayPalette {
  const u = t.ui;
  return withRoles({
    kind: t.kind,
    bg0: hex6(u["bg-0"]),
    bg1: hex6(u["bg-1"]),
    bg2: hex6(u["bg-2"]),
    bg3: hex6(u["bg-3"]),
    border: hex6(u.border),
    borderStrong: hex6(u["border-strong"]),
    text0: hex6(u["text-0"], "#ffffff"),
    text1: hex6(u["text-1"], "#cccccc"),
    text2: hex6(u["text-2"], "#888888"),
    accent: hex6(u.accent, "#4cc2ff"),
    accent2: hex6(u["accent-2"], "#8b9dff"),
    ok: hex6(u.ok, "#3ddc97"),
    warn: hex6(u.warn, "#f5b84a"),
    err: hex6(u.err, "#ff5c6c"),
    info: hex6(u.info, "#6aa8ff"),
  });
}

/** Palette from the live CSS variables on :root (falls back to the theme's data for anything unreadable). */
export function activePalette(themeId: string | null | undefined): ReplayPalette {
  const base = paletteFromTheme(getTheme(themeId));
  if (typeof document === "undefined" || typeof getComputedStyle !== "function") return base;
  const cs = getComputedStyle(document.documentElement);
  const v = (name: string, fb: string) => {
    const raw = cs.getPropertyValue(`--${name}`).trim();
    return raw && /^(#|rgb)/.test(raw) ? hex6(raw, fb) : fb;
  };
  return withRoles({
    kind: base.kind,
    bg0: v("bg-0", base.bg0),
    bg1: v("bg-1", base.bg1),
    bg2: v("bg-2", base.bg2),
    bg3: v("bg-3", base.bg3),
    border: v("border", base.border),
    borderStrong: v("border-strong", base.borderStrong),
    text0: v("text-0", base.text0),
    text1: v("text-1", base.text1),
    text2: v("text-2", base.text2),
    accent: v("accent", base.accent),
    accent2: v("accent-2", base.accent2),
    ok: v("ok", base.ok),
    warn: v("warn", base.warn),
    err: v("err", base.err),
    info: v("info", base.info),
  });
}

export function roleColor(p: ReplayPalette, role: string | null | undefined): string {
  const id = normalizeRole(role);
  return (id && p.roles[id]) || p.roleCustom;
}

/** `#rrggbb` + alpha → rgba() string. */
export function alpha(hex: string, a: number): string {
  const [r, g, b] = parseColor(hex);
  return `rgba(${r}, ${g}, ${b}, ${Math.max(0, Math.min(1, a)).toFixed(3)})`;
}

/** Every opaque colour the painter can draw with (seed for the GIF palette). */
export function paletteColors(p: ReplayPalette): string[] {
  return [p.bg0, p.bg1, p.bg2, p.bg3, p.border, p.borderStrong, p.text0, p.text1, p.text2, p.accent, p.accent2, p.ok, p.warn, p.err, p.info, ...Object.values(p.roles), p.roleCustom];
}
