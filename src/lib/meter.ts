// Cost & context meter: pure formatting, thresholds, totals and chip models (no React, no stores).
// Numbers come from Claude Code's status line JSON via src-tauri/src/meter; cost is Claude Code's own
// estimate at list price.

import { t, type MessageKey } from "../i18n";
import type { AgentKind, SessionMeter } from "./types";

/** Context use at or above this is shown in the warning colour. */
export const CONTEXT_WARN_PCT = 80;

// Texts are functions (not constants) so they follow the UI language.
export const estimateNote = (): string => t("meter.estimateNote");
export const compactHint = (): string => t("meter.compactHint");
export const codexNa = (): string => t("meter.codexNa");
export const geminiNa = (): string => t("meter.geminiNa");
const OFF_NOTES: Record<string, MessageKey> = {
  customSettings: "meter.offCustomSettings",
  managed: "meter.offManaged",
  unavailable: "meter.offUnavailable",
};

const isNum = (n: number | null | undefined): n is number => typeof n === "number" && Number.isFinite(n);

export function formatCost(usd: number | null | undefined): string {
  if (!isNum(usd)) return "—";
  if (usd <= 0) return "$0.00";
  if (usd < 0.01) return "<$0.01";
  if (usd < 1000) return `$${usd.toFixed(2)}`;
  return `$${(usd / 1000).toFixed(1).replace(/\.0$/, "")}k`;
}

export function formatPct(p: number | null | undefined): string {
  if (!isNum(p)) return "—";
  if (p > 0 && p < 1) return "<1%";
  return `${Math.round(p)}%`;
}

export function formatTokens(n: number | null | undefined): string {
  if (!isNum(n)) return "—";
  if (n < 1000) return `${Math.round(n)}`;
  if (n < 10_000) return `${(n / 1000).toFixed(1).replace(/\.0$/, "")}k`;
  if (n < 1_000_000) return `${Math.round(n / 1000)}k`;
  return `${(n / 1_000_000).toFixed(1).replace(/\.0$/, "")}M`;
}

export function formatDuration(ms: number | null | undefined): string {
  if (!isNum(ms)) return "—";
  const s = ms / 1000;
  if (s < 10) return `${s.toFixed(1).replace(/\.0$/, "")}s`;
  if (s < 60) return `${Math.round(s)}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ${Math.round(s - m * 60)}s`;
  return `${Math.floor(m / 60)}h ${m % 60}m`;
}

export type ContextLevel = "ok" | "warn";

export function contextLevel(pct: number | null | undefined): ContextLevel {
  return isNum(pct) && pct >= CONTEXT_WARN_PCT ? "warn" : "ok";
}

/** The pane has status line data (from this run or an earlier one). */
export function hasData(m: SessionMeter | null | undefined): m is SessionMeter {
  return !!m && m.updatedMs !== null && m.updatedMs !== undefined;
}

/** Cost shown for a pane: the running total across /clear, else the current conversation's. */
export function paneCost(m: SessionMeter | null | undefined): number | null {
  if (!hasData(m)) return null;
  return isNum(m.paneCostUsd) ? m.paneCostUsd : isNum(m.costUsd) ? m.costUsd : null;
}

/** Sum of the pane costs of `ids` that have data; null when none has. */
export function workspaceCost(ids: readonly string[], bySession: Readonly<Record<string, SessionMeter | undefined>>): number | null {
  let total: number | null = null;
  for (const id of ids) {
    const c = paneCost(bySession[id]);
    if (c !== null) total = (total ?? 0) + c;
  }
  return total;
}

/** Pane header / Fleet chip text: `$0.42 · 37%` (cost · context used). */
export function meterLabel(m: SessionMeter): string {
  const cost = paneCost(m);
  const parts: string[] = [];
  if (cost !== null) parts.push(formatCost(cost));
  if (isNum(m.contextPct)) parts.push(formatPct(m.contextPct));
  return parts.join(" · ") || t("meter.labelFallback");
}

/** Mission Control card line: `est. $0.42 · ctx 37%`. */
export function cardLine(m: SessionMeter): string {
  const cost = paneCost(m);
  const parts: string[] = [];
  if (cost !== null) parts.push(t("meter.cardCost", { cost: formatCost(cost) }));
  if (isNum(m.contextPct)) parts.push(t("meter.cardContext", { pct: formatPct(m.contextPct) }));
  return parts.join(" · ") || t("meter.cardCost", { cost: "—" });
}

export function meterTooltip(m: SessionMeter): string {
  const lines: string[] = [];
  const cost = paneCost(m);
  if (cost !== null) {
    const conversation = isNum(m.costUsd) && Math.abs(m.costUsd - cost) > 0.005 ? formatCost(m.costUsd) : null;
    lines.push(conversation ? t("meter.tipCostConversation", { cost: formatCost(cost), conversation }) : t("meter.tipCost", { cost: formatCost(cost) }));
  }
  if (isNum(m.contextPct)) {
    const pct = formatPct(m.contextPct);
    const size = isNum(m.contextSize) ? formatTokens(m.contextSize) : null;
    const io = isNum(m.inputTokens) || isNum(m.outputTokens) ? { input: formatTokens(m.inputTokens), output: formatTokens(m.outputTokens) } : null;
    if (size && io) lines.push(t("meter.tipContextSizeTokens", { pct, size, ...io }));
    else if (size) lines.push(t("meter.tipContextSize", { pct, size }));
    else if (io) lines.push(t("meter.tipContextTokens", { pct, ...io }));
    else lines.push(t("meter.tipContext", { pct }));
  }
  if (m.model) lines.push(t("meter.tipModel", { model: m.model }));
  if (isNum(m.apiDurationMs)) lines.push(t("meter.tipApiTime", { duration: formatDuration(m.apiDurationMs) }));
  if (isNum(m.fiveHourPct) || isNum(m.sevenDayPct)) {
    const w = [
      isNum(m.fiveHourPct) ? t("meter.fiveHour", { pct: formatPct(m.fiveHourPct) }) : "",
      isNum(m.sevenDayPct) ? t("meter.sevenDay", { pct: formatPct(m.sevenDayPct) }) : "",
    ];
    lines.push(t("meter.tipPlanLimits", { limits: w.filter(Boolean).join(" · ") }));
  }
  if (contextLevel(m.contextPct) === "warn") lines.push(compactHint());
  if (m.chained) lines.push(t("meter.tipChained"));
  if (m.note) lines.push(m.note); // from the Rust host (English)
  lines.push(estimateNote());
  return lines.join("\n");
}

export type ChipModel =
  | { kind: "data"; label: string; tooltip: string; level: ContextLevel }
  | { kind: "off" | "na"; label: string; tooltip: string };

/** What a pane shows for its meter (null = nothing). `enabled` = the Settings toggle. */
export function chipModel(o: { agent: AgentKind; preset?: string | null; enabled: boolean; meter?: SessionMeter | null }): ChipModel | null {
  if (!o.enabled) return null;
  if (o.agent === "codex") return { kind: "na", label: t("meter.na"), tooltip: codexNa() };
  if (o.agent === "generic" && o.preset === "gemini") return { kind: "na", label: t("meter.na"), tooltip: geminiNa() };
  if (o.agent !== "claude" || !o.meter) return null;
  const m = o.meter;
  if (m.status === "customSettings" || m.status === "managed" || m.status === "unavailable") {
    return { kind: "off", label: t("meter.off"), tooltip: m.note ?? t(OFF_NOTES[m.status]) };
  }
  if (hasData(m)) return { kind: "data", label: meterLabel(m), tooltip: meterTooltip(m), level: contextLevel(m.contextPct) };
  return null;
}
