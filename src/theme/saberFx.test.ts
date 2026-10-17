import { describe, expect, it } from "vitest";
import { saberVoice } from "../audio/sounds";
import { DEFAULT_SETTINGS } from "../lib/types";
import { SABER_PRESETS, getSaber, resolveTheme } from "./saber";
import {
  DUEL_MS,
  IGNITE_MS,
  IGNITE_SETTLE_MS,
  RETRACT_MS,
  SOUND_GAP_MS,
  createDuelDetector,
  createRateLimiter,
  duelPartner,
  mixHex,
  nextSaberColor,
  resolveBlade,
  resolveSaberLevel,
} from "./saberFx";
import { THEMES, getTheme } from "./themes";

const saberDuel = getTheme("saber-duel");
const deepSpace = getTheme("deep-space");
const light = THEMES.find((t) => t.kind === "light" && !t.saber)!;

describe("saber effect level", () => {
  it("auto = full with Saber Duel, subtle everywhere else", () => {
    expect(saberDuel.saber).toBe(true);
    expect(resolveSaberLevel("auto", saberDuel, false)).toBe("full");
    for (const t of THEMES.filter((x) => !x.saber)) expect(resolveSaberLevel("auto", t, false), t.id).toBe("subtle");
  });

  it("explicit levels apply in every theme", () => {
    for (const t of THEMES)
      for (const m of ["off", "subtle", "full"] as const) expect(resolveSaberLevel(m, t, false), `${t.id}/${m}`).toBe(m);
  });

  it("reduced motion turns everything off", () => {
    for (const m of ["auto", "subtle", "full"] as const) {
      expect(resolveSaberLevel(m, saberDuel, true)).toBe("off");
      expect(resolveSaberLevel(m, deepSpace, true)).toBe("off");
    }
  });

  it("missing / unknown values behave like auto (older state files)", () => {
    expect(resolveSaberLevel(undefined, saberDuel, false)).toBe("full");
    expect(resolveSaberLevel("bogus", deepSpace, false)).toBe("subtle");
  });

  it("the default setting is auto with sound off", () => {
    expect(DEFAULT_SETTINGS.saberEffects).toBe("auto");
    expect(DEFAULT_SETTINGS.saberSound).toBe(false);
    expect(DEFAULT_SETTINGS.saberBladeFromTheme).toBe(true);
  });
});

describe("blade colour", () => {
  it("Saber Duel always uses the chosen preset (its accent)", () => {
    for (const p of SABER_PRESETS) {
      const b = resolveBlade(resolveTheme({ theme: "saber-duel", saberColor: p.id }), { saberColor: p.id, saberBladeFromTheme: true });
      expect(b).toEqual({ color: p.accent, core: p.core, preset: p.id });
    }
  });

  it("other themes follow their accent until a colour is picked", () => {
    const b = resolveBlade(deepSpace, { saberColor: "red", saberBladeFromTheme: true });
    expect(b.color).toBe(deepSpace.ui.accent);
    expect(b.preset).toBeNull();
    // the core is the accent pushed toward white
    expect(b.core).toBe(mixHex(deepSpace.ui.accent, "#ffffff", 0.72));
    expect(resolveBlade(deepSpace, {})).toEqual(b);
  });

  it("a picked colour applies to every theme", () => {
    for (const t of THEMES.filter((x) => x.kind === "dark")) {
      const b = resolveBlade(t, { saberColor: "green", saberBladeFromTheme: false });
      expect(b.color, t.id).toBe(getSaber("green").accent);
      expect(b.preset).toBe("green");
    }
  });

  it("a white blade stays visible on light themes", () => {
    const b = resolveBlade(light, { saberColor: "white", saberBladeFromTheme: false });
    expect(b.color).toBe(light.ui["text-2"]);
    expect(b.core).toBe("#ffffff");
  });

  it("unknown preset ids fall back to the default blade", () => {
    expect(resolveBlade(deepSpace, { saberColor: "nope", saberBladeFromTheme: false }).color).toBe(SABER_PRESETS[0].accent);
  });

  it("mixHex mixes and tolerates non-hex input", () => {
    expect(mixHex("#000000", "#ffffff", 0.5)).toBe("#808080");
    expect(mixHex("#f00", "#00f", 1)).toBe("#0000ff");
    expect(mixHex("#123456", "#ffffff", 0)).toBe("#123456");
    expect(mixHex("rgb(1,2,3)", "#ffffff", 0.5)).toBe("rgb(1,2,3)");
  });

  it("the duel rival differs from the blade", () => {
    for (const p of SABER_PRESETS) {
      const b = resolveBlade(saberDuel, { saberColor: p.id });
      expect(duelPartner(b, saberDuel)).not.toBe(b.color);
    }
    expect(duelPartner(resolveBlade(deepSpace, {}), deepSpace)).toBe(deepSpace.ui["accent-2"]);
  });

  it("cycling walks every preset and starts at the first from 'theme'", () => {
    expect(nextSaberColor("purple", true)).toBe(SABER_PRESETS[0].id);
    let id = SABER_PRESETS[0].id;
    const seen = new Set<string>();
    for (let i = 0; i < SABER_PRESETS.length; i++) {
      seen.add(id);
      id = nextSaberColor(id, false);
    }
    expect(seen.size).toBe(SABER_PRESETS.length);
    expect(id).toBe(SABER_PRESETS[0].id);
  });
});

describe("timing budget", () => {
  it("every event animation is short", () => {
    expect(IGNITE_MS).toBeLessThanOrEqual(300);
    expect(IGNITE_SETTLE_MS).toBeLessThanOrEqual(400);
    expect(RETRACT_MS).toBeLessThanOrEqual(200);
    expect(DUEL_MS).toBeLessThanOrEqual(600);
  });
});

describe("sound rate limit", () => {
  it("allows at most one sound per gap", () => {
    const allow = createRateLimiter(SOUND_GAP_MS);
    expect(allow(1000)).toBe(true);
    expect(allow(1000)).toBe(false);
    expect(allow(1599)).toBe(false);
    expect(allow(1600)).toBe(true);
    expect(allow(1700)).toBe(false);
    expect(allow(2300)).toBe(true);
  });

  it("rejected calls do not extend the window", () => {
    const allow = createRateLimiter(600);
    expect(allow(0)).toBe(true);
    for (let t = 50; t < 600; t += 50) expect(allow(t)).toBe(false);
    expect(allow(600)).toBe(true);
  });

  it("blade voices: ignite rises and opens, retract falls, closes and is softer", () => {
    const ig = saberVoice("ignite");
    const re = saberVoice("retract");
    expect(ig.dur).toBeGreaterThanOrEqual(0.2);
    expect(ig.dur).toBeLessThanOrEqual(0.3);
    expect(ig.f1).toBeGreaterThan(ig.f0);
    expect(ig.cutoff1).toBeGreaterThan(ig.cutoff0);
    expect(re.f1).toBeLessThan(re.f0);
    expect(re.cutoff1).toBeLessThan(re.cutoff0);
    expect(re.dur).toBeLessThan(ig.dur);
    expect(re.gain).toBeLessThan(ig.gain);
    for (const v of [ig, re]) {
      expect(v.detune).toBeGreaterThan(0);
      expect(v.gain).toBeLessThanOrEqual(1);
    }
  });
});

describe("duel detector", () => {
  it("two sessions of one group finishing within 1.5 s duel", () => {
    const d = createDuelDetector(1500);
    expect(d("g1", "a", 0)).toBe(false);
    expect(d("g1", "b", 1400)).toBe(true);
  });

  it("too far apart, same session or different groups do not", () => {
    const d = createDuelDetector(1500);
    expect(d("g1", "a", 0)).toBe(false);
    expect(d("g1", "b", 1600)).toBe(false);
    expect(d("g1", "b", 2000)).toBe(false); // same session again
    expect(d("g2", "c", 2100)).toBe(false); // other group
    expect(d("g1", "a", 3000)).toBe(true); // b finished at 2000, a at 3000
  });

  it("a duel consumes both finishes", () => {
    const d = createDuelDetector(1500);
    d("g", "a", 0);
    expect(d("g", "b", 100)).toBe(true);
    expect(d("g", "c", 200)).toBe(false);
  });
});
