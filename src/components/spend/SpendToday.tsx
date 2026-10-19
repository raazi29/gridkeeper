// Spend guard UI bits: `today ~$4.20 / $10` for the Mission Control status line and Fleet workspace headers, and
// the day tick that re-renders them at local midnight (a single timer, only while mounted and visible).

import { memo, useEffect, useState } from "react";
import { dayKey, formatBudget, formatUsd, guardLevel, msUntilNextDay, normalizeGuard, spentToday, SPEND_NOTE, todayLabel } from "../../lib/spend";
import type { SpendGuard } from "../../lib/types";
import { useApp } from "../../store/appStore";
import { useSpend } from "../../store/spend";
import "./spend.css";

const ACTION_TEXT: Record<SpendGuard["action"], string> = {
  warn: "warn only",
  pause: "pause Autopilot",
  pauseNotify: "pause Autopilot and notify",
};

/** The local day; re-rendered at midnight while `active` and the window is visible (re-checked when it shows). */
export function useDayTick(active = true): string {
  const [day, setDay] = useState(() => dayKey(Date.now()));
  useEffect(() => {
    if (!active || typeof document === "undefined") return;
    let timer: ReturnType<typeof setTimeout> | null = null;
    const arm = () => {
      if (timer !== null) clearTimeout(timer);
      timer = null;
      setDay(dayKey(Date.now()));
      if (document.visibilityState === "visible") timer = setTimeout(arm, msUntilNextDay(Date.now()) + 1000);
    };
    arm();
    document.addEventListener("visibilitychange", arm);
    return () => {
      if (timer !== null) clearTimeout(timer);
      document.removeEventListener("visibilitychange", arm);
    };
  }, [active]);
  return day;
}

export function spendTitle(spent: number, g: SpendGuard | null): string {
  const lines = [`Today (since local midnight) in this workspace's Claude panes: ~${formatUsd(spent)}.`];
  if (g) lines.push(`Daily budget ${formatBudget(g.budgetUsd)}; warning at ${g.warnPct}%; at 100%: ${ACTION_TEXT[g.action]}. Agents are never stopped.`);
  else lines.push("No daily budget set (Settings › Agents › Spend guard).");
  lines.push(SPEND_NOTE);
  return lines.join("\n");
}

/** `today [ ~$4.20 / $10 ]` (Mission Control) or a `today ~$4.20 / $10` chip (Fleet). Nothing without data. */
export const SpendToday = memo(function SpendToday({ workspaceId, variant }: { workspaceId: string; variant: "mc" | "fleet" }) {
  const enabled = useApp((s) => s.persisted.settings.costMeter ?? false);
  const rawGuard = useApp((s) => s.persisted.settings.spendGuards?.[workspaceId]);
  const ledger = useSpend((s) => s.ledger);
  useDayTick(enabled);
  if (!enabled || !ledger) return null;
  const g = normalizeGuard(rawGuard);
  const spent = spentToday(ledger, workspaceId, Date.now());
  if (!g && spent <= 0) return null;
  const level = g ? guardLevel(spent, g) : "ok";
  const title = spendTitle(spent, g);
  if (variant === "mc") {
    return (
      <span className={`spend-today is-${level}`} title={title} data-spend={level}>
        today [ <b>~{formatUsd(spent)}</b>
        {g ? ` / ${formatBudget(g.budgetUsd)}` : ""} ]
      </span>
    );
  }
  return (
    <span className={`chip spend-chip is-${level}`} title={title} data-spend={level}>
      {todayLabel(spent, g)}
    </span>
  );
});
