// Per-machine on/off for theme effects (like the CRT scanline toggle in uiStore): they depend on the
// display and taste, not on the workspace, so they live in localStorage rather than the state file.

import { create } from "zustand";

export interface EffectPrefs {
  /** Lamp / focus-frame bloom for themes with `effects.glow`. */
  glow: boolean;
  /** Holographic scan band for themes with `effects.holo`. */
  holo: boolean;
  set: (patch: Partial<Pick<EffectPrefs, "glow" | "holo">>) => void;
}

const LS_EFFECTS = "gridkeeper.ui.effects";

function read(): Pick<EffectPrefs, "glow" | "holo"> {
  try {
    const raw = globalThis.localStorage?.getItem(LS_EFFECTS);
    if (raw) {
      const v = JSON.parse(raw) as Partial<EffectPrefs>;
      return { glow: v.glow !== false, holo: v.holo !== false };
    }
  } catch {
    /* storage unavailable */
  }
  return { glow: true, holo: true };
}

export const useEffectPrefs = create<EffectPrefs>()((set, get) => ({
  ...read(),
  set: (patch) => {
    set(patch);
    try {
      const { glow, holo } = get();
      globalThis.localStorage?.setItem(LS_EFFECTS, JSON.stringify({ glow, holo }));
    } catch {
      /* ignore */
    }
  },
}));
