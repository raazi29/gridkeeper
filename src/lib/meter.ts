// Cost & context meter: pure formatting, thresholds, totals and chip models (no React, no stores).
// Numbers come from Claude Code's status line JSON via src-tauri/src/meter; cost is Claude Code's own
// estimate at list price.

import type { AgentKind, SessionMeter } from "./types";

/** Context use at or above this is shown in the warning colour. */
export const CONTEXT_WARN_PCT = 80;

export const ESTIMATE_NOTE =
  "Estimated by Claude Code at list price; on a subscription this is API-equivalent value, not a bill.";
export const COMPACT_HINT = "Context nearly full — consider /compact";
export const CODEX_NA = "Codex doesn't report usage to other programs; enable its token footer in the pane (/statusline in Codex).";
export const GEMINI_NA = "Gemini CLI: not metered (it reports no usage to other programs).";
export const OFF_NOTES: Record<string, string> = {
  customSettings: "meter off: custom --settings",
  managed: "meter unavailable: managed settings own the status line",
  unavailable: "meter unavailable for this pane",
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
  return parts.join(" · ") || "meter";
}

/** Mission Control card line: `est. $0.42 · ctx 37%`. */
export function cardLine(m: SessionMeter): string {
  const cost = paneCost(m);
  const parts: string[] = [];
  if (cost !== null) parts.push(`est. ${formatCost(cost)}`);
  if (isNum(m.contextPct)) parts.push(`ctx ${formatPct(m.contextPct)}`);
  return parts.join(" · ") || "est. —";
}

export function meterTooltip(m: SessionMeter): string {
  const lines: string[] = [];
  const cost = paneCost(m);
  if (cost !== null) {
    const conv = isNum(m.costUsd) && Math.abs(m.costUsd - cost) > 0.005 ? ` (${formatCost(m.costUsd)} in the current conversation)` : "";
    lines.push(`Estimated cost: ${formatCost(cost)} in this pane${conv}`);
  }
  if (isNum(m.contextPct)) {
    const size = isNum(m.contextSize) ? ` of ${formatTokens(m.contextSize)} tokens` : "";
    const io = isNum(m.inputTokens) || isNum(m.outputTokens) ? ` (${formatTokens(m.inputTokens)} in · ${formatTokens(m.outputTokens)} out)` : "";
    lines.push(`Context: ${formatPct(m.contextPct)}${size}${io}`);
  }
  if (m.model) lines.push(`Model: ${m.model}`);
  if (isNum(m.apiDurationMs)) lines.push(`API time: ${formatDuration(m.apiDurationMs)}`);
  if (isNum(m.fiveHourPct) || isNum(m.sevenDayPct)) {
    const w = [isNum(m.fiveHourPct) ? `5-hour ${formatPct(m.fiveHourPct)}` : "", isNum(m.sevenDayPct) ? `7-day ${formatPct(m.sevenDayPct)}` : ""];
    lines.push(`Plan limits used: ${w.filter(Boolean).join(" · ")}`);
  }
  if (contextLevel(m.contextPct) === "warn") lines.push(COMPACT_HINT);
  if (m.chained) lines.push("Your own status line still runs in the pane.");
  if (m.note) lines.push(m.note);
  lines.push(ESTIMATE_NOTE);
  return lines.join("\n");
}

export type ChipModel =
  | { kind: "data"; label: string; tooltip: string; level: ContextLevel }
  | { kind: "off" | "na"; label: string; tooltip: string };

/** What a pane shows for its meter (null = nothing). `enabled` = the Settings toggle. */
export function chipModel(o: { agent: AgentKind; preset?: string | null; enabled: boolean; meter?: SessionMeter | null }): ChipModel | null {
  if (!o.enabled) return null;
  if (o.agent === "codex") return { kind: "na", label: "n/a", tooltip: CODEX_NA };
  if (o.agent === "generic" && o.preset === "gemini") return { kind: "na", label: "n/a", tooltip: GEMINI_NA };
  if (o.agent !== "claude" || !o.meter) return null;
  const m = o.meter;
  if (m.status === "customSettings" || m.status === "managed" || m.status === "unavailable") {
    return { kind: "off", label: "meter off", tooltip: m.note ?? OFF_NOTES[m.status] };
  }
  if (hasData(m)) return { kind: "data", label: meterLabel(m), tooltip: meterTooltip(m), level: contextLevel(m.contextPct) };
  return null;
}
