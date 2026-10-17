// Pane grid geometry (pure).

import type { LayoutPreset } from "../lib/types";

/** Number of panes in each row, top to bottom. */
export function computeRows(preset: LayoutPreset, n: number): number[] {
  if (n <= 0) return [];
  if (preset === "columns") return [n];
  if (preset === "rows") return Array.from({ length: n }, () => 1);
  // grid: near-square; the last row's panes stretch to fill the width.
  const cols = Math.ceil(Math.sqrt(n));
  const rows = Math.ceil(n / cols);
  const out = Array.from({ length: rows }, () => cols);
  out[rows - 1] = n - cols * (rows - 1);
  return out;
}

/** Split a flat id list into rows according to `computeRows`. */
export function chunkRows<T>(items: readonly T[], preset: LayoutPreset): T[][] {
  const counts = computeRows(preset, items.length);
  const out: T[][] = [];
  let i = 0;
  for (const c of counts) {
    out.push(items.slice(i, i + c));
    i += c;
  }
  return out;
}

/** Signature of a layout shape; persisted sizes are keyed by it so they only apply to the same shape. */
export function layoutSignature(preset: LayoutPreset, n: number): string {
  return `${preset}:${n}`;
}

/** Key for the outer (vertical, row heights) sizes. */
export function rowsKey(sig: string): string {
  return `${sig}:rows`;
}

/** Key for one row's pane widths. */
export function rowKey(sig: string, row: number): string {
  return `${sig}:r${row}`;
}

/**
 * Validate persisted sizes for `count` panels: must be finite, positive, and sum to ~100.
 * Returns normalized percentages or null when unusable.
 */
export function validSizes(sizes: readonly number[] | undefined, count: number): number[] | null {
  if (!sizes || sizes.length !== count || count === 0) return null;
  if (sizes.some((s) => !Number.isFinite(s) || s <= 0)) return null;
  const sum = sizes.reduce((a, b) => a + b, 0);
  if (Math.abs(sum - 100) > 1) return null;
  return sizes.map((s) => (s * 100) / sum);
}

/** Equal split percentages. */
export function equalSizes(count: number): number[] {
  return Array.from({ length: count }, () => 100 / count);
}
