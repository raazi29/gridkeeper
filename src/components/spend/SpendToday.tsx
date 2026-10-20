// Spend guard UI bits: `today ~$4.20 / $10` for the Mission Control status line and Fleet workspace headers, and
// the day tick that re-renders them at local midnight (a single timer, only while mounted and visible).

import { memo, useEffect, useState, type ReactNode } from "react";
import { t as tr, useT, type MessageKey } from "../../i18n";
import { dayKey, formatBudget, formatUsd, guardLevel, msUntilNextDay, normalizeGuard, spendNote, spentToday, todayLabel } from "../../lib/spend";
import type { SpendGuard } from "../../lib/types";
import { useApp } from "../../store/appStore";
import { useSpend } from "../../store/spend";
import "./spend.css";

const ACTION_TEXT: Record<SpendGuard["action"], MessageKey> = {
  warn: "spend.actionText.warn",
  pause: "spend.actionText.pause",
  pauseNotify: "spend.actionText.pauseNotify",
};

const bold = (c: ReactNode) => <b>{c}</b>;

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
  const lines = [tr("spend.title.today", { spent: formatUsd(spent) })];
  if (g) lines.push(tr("spend.title.budget", { budget: formatBudget(g.budgetUsd), pct: g.warnPct, action: tr(ACTION_TEXT[g.action]) }));
  else lines.push(tr("spend.title.noBudget"));
  lines.push(spendNote());
  return lines.join("\n");
}

/** `today [ ~$4.20 / $10 ]` (Mission Control) or a `today ~$4.20 / $10` chip (Fleet). Nothing without data. */
export const SpendToday = memo(function SpendToday({ workspaceId, variant }: { workspaceId: string; variant: "mc" | "fleet" }) {
  const t = useT();
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
        {g
          ? t.rich("spend.today.mcBudget", { spent: formatUsd(spent), budget: formatBudget(g.budgetUsd), b: bold })
          : t.rich("spend.today.mc", { spent: formatUsd(spent), b: bold })}
      </span>
    );
  }
  return (
    <span className={`chip spend-chip is-${level}`} title={title} data-spend={level}>
      {todayLabel(spent, g)}
    </span>
  );
});
