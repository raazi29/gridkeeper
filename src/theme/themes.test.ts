// WCAG contrast gate for every shipped theme. Thresholds and why:
//   terminal foreground on background      ≥ 7    (AAA body text; this is what you read all day)
//   UI primary text on bg-0/1/2            ≥ 7
//   UI secondary text (text-1) on bg-0/1/2 ≥ 4.5  (AA: it sits on sidebar/header surfaces, not just the canvas)
//   UI muted labels (text-2) on bg-0/1/2   ≥ 3    (AA large / non-essential micro-labels)
//   accent / status colours used as text   ≥ 4.5 on bg-1 and bg-2
//   text on an accent fill                 ≥ 4.5
//   accent as a non-text indicator         ≥ 3    (WCAG 1.4.11)
//   ANSI normal + bright colours           ≥ 4.5, except:
//     - `black` on dark themes is excluded: on a black background it is by definition (near) invisible;
//       programs use it as a background colour, not as text.
//     - `brightBlack` (dim grey for comments / hints) needs ≥ 3.
//   foreground over the selection highlight ≥ 4.5, cursor vs background ≥ 3.

import { describe, expect, it } from "vitest";
import { THEMES, UI_TOKENS, contrast, getTheme, parseColor, xtermTheme, type TerminalPalette } from "./themes";

const ANSI: (keyof TerminalPalette)[] = [
  "black",
  "red",
  "green",
  "yellow",
  "blue",
  "magenta",
  "cyan",
  "white",
  "brightBlack",
  "brightRed",
  "brightGreen",
  "brightYellow",
  "brightBlue",
  "brightMagenta",
  "brightCyan",
  "brightWhite",
];

/** Composite an rgba() colour over an opaque background. */
function over(fg: string, bg: string): string {
  const [r, g, b, a] = parseColor(fg);
  const [br, bgc, bb] = parseColor(bg);
  const h = (v: number) => Math.round(v).toString(16).padStart(2, "0");
  return `#${h(r * a + br * (1 - a))}${h(g * a + bgc * (1 - a))}${h(b * a + bb * (1 - a))}`;
}

describe("theme registry", () => {
  it("has unique ids and at least 8 themes", () => {
    const ids = THEMES.map((t) => t.id);
    expect(new Set(ids).size).toBe(ids.length);
    expect(ids.length).toBeGreaterThanOrEqual(8);
  });
  it("falls back to the default for unknown ids", () => {
    expect(getTheme("does-not-exist").id).toBe(THEMES[0].id);
    expect(getTheme(undefined).id).toBe(THEMES[0].id);
  });
  it("xterm theme carries every ANSI colour", () => {
    for (const t of THEMES) {
      const x = xtermTheme(t.id) as Record<string, unknown>;
      for (const k of ANSI) expect(x[k], `${t.id}.${k}`).toBe(t.terminal[k]);
      expect(x.selectionInactiveBackground).toMatch(/^rgba\(/);
    }
  });
});

for (const t of THEMES) {
  describe(`theme ${t.name}`, () => {
    const u = t.ui;
    const term = t.terminal;
    const surfaces = ["bg-0", "bg-1", "bg-2"] as const;
    const check = (label: string, fg: string, bg: string, min: number) => {
      const ratio = contrast(fg, bg);
      expect(ratio, `${t.id}: ${label} ${fg} on ${bg} = ${ratio.toFixed(2)} (min ${min})`).toBeGreaterThanOrEqual(min);
    };

    it("defines every base token with a parseable value", () => {
      for (const k of UI_TOKENS) {
        expect(u[k], `${t.id}.${k}`).toBeTruthy();
        if (!k.startsWith("radius")) expect(() => parseColor(u[k])).not.toThrow();
      }
    });

    it("terminal foreground ≥ 7:1", () => check("foreground", term.foreground, term.background, 7));

    it("UI text contrast", () => {
      for (const s of surfaces) {
        check("text-0", u["text-0"], u[s], 7);
        check("text-1", u["text-1"], u[s], 4.5);
        check("text-2", u["text-2"], u[s], 3);
      }
    });

    it("accent and status text contrast", () => {
      for (const s of ["bg-1", "bg-2"] as const) {
        for (const k of ["accent-fg", "ok-fg", "warn-fg", "err-fg"] as const) check(k, u[k], u[s], 4.5);
        check("accent indicator", u.accent, u[s], 3);
      }
      check("on-accent", u["on-accent"], u.accent, 4.5);
    });

    it("ANSI colours are readable on the terminal background", () => {
      for (const k of ANSI) {
        if (k === "black" && t.kind === "dark") continue;
        check(k, term[k], term.background, k === "brightBlack" ? 3 : 4.5);
      }
    });

    it("selection and cursor stay readable", () => {
      check("foreground on selection", term.foreground, over(term.selectionBackground, term.background), 4.5);
      check("cursor", term.cursor, term.background, 3);
    });
  });
}
