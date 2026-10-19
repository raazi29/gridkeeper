// Resource-pressure thresholds (pure; unit-tested). Inputs come from the shared diagnostics poll.

import { MAX_WEBGL } from "../terminal/webglBudget";
import { t } from "../i18n";

/** System memory use (percent of physical RAM) above which starting more sessions is discouraged. */
export const MEMORY_PRESSURE_PERCENT = 85;

export interface MemoryPressure {
  /** Rounded percent of physical memory in use. */
  percent: number;
  high: boolean;
}

/** null when the figures are missing or nonsensical (never a guessed value). */
export function memoryPressure(used: number | undefined | null, total: number | undefined | null): MemoryPressure | null {
  if (!used || !total || !Number.isFinite(used) || !Number.isFinite(total) || total <= 0 || used < 0) return null;
  const percent = Math.min(100, Math.round((used / total) * 100));
  return { percent, high: used / total > MEMORY_PRESSURE_PERCENT / 100 };
}

/** Short status-bar text for high memory use. */
export function memoryPressureLabel(p: MemoryPressure): string {
  return t("resources.pressureLabel", { percent: p.percent });
}

/**
 * More visible terminals in one group than WebGL contexts the app will create: the rest are drawn by the
 * (slower) DOM renderer.
 */
export function webglOverBudget(visibleInGroup: number, max = MAX_WEBGL): boolean {
  return visibleInGroup > max;
}
