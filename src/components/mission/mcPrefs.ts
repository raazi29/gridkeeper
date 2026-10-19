// Mission Control layout choices of this device (activity river / session log folded, session log height),
// kept in localStorage like the mission board's collapse. Best effort: without storage the defaults apply.

import { useCallback, useState } from "react";

const PREFIX = "gridkeeper.mc.";

export function readPref<T>(key: string, fallback: T): T {
  try {
    const v = localStorage.getItem(PREFIX + key);
    return v === null ? fallback : (JSON.parse(v) as T);
  } catch {
    return fallback;
  }
}

export function writePref(key: string, value: unknown): void {
  try {
    localStorage.setItem(PREFIX + key, JSON.stringify(value));
  } catch {
    /* storage unavailable: the choice lasts until Mission Control closes */
  }
}

/** useState backed by a stored preference; `fallback` runs only when nothing is stored. */
export function usePref<T>(key: string, fallback: () => T): [T, (next: T) => void] {
  const [value, setValue] = useState<T>(() => readPref(key, fallback()));
  const set = useCallback(
    (next: T) => {
      setValue(next);
      writePref(key, next);
    },
    [key],
  );
  return [value, set];
}

/** Session log height limits (px): it never takes more than half the window. */
export function clampLogHeight(h: number, viewportHeight: number): number {
  const max = Math.max(96, Math.round(viewportHeight * 0.5));
  return Math.round(Math.min(max, Math.max(72, h)));
}
