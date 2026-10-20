// Spend guard host (mounted once by Shell): installs the ledger / guard runtime (store/spend.ts) and shows the
// persistent banner of each workspace whose daily budget is used up: "raise budget" / "resume". Never stops agents.

import { memo, useEffect, useState, type ReactNode } from "react";
import { useShallow } from "zustand/react/shallow";
import { useT } from "../../i18n";
import { bannerFor, formatBudget, formatUsd, normalizeGuard, spendNote, spentToday, suggestRaise, type TripMark } from "../../lib/spend";
import type { SpendGuard } from "../../lib/types";
import { useApp } from "../../store/appStore";
import { installSpendGuard, raiseBudget, resumeGuard, useSpend } from "../../store/spend";
import { useDayTick } from "./SpendToday";
import "./spend.css";

interface BannerModel {
  id: string;
  name: string;
  spent: number;
  guard: SpendGuard;
  trip: TripMark;
}

const bold = (c: ReactNode) => <b>{c}</b>;

export function SpendGuardLayer() {
  const t = useT();
  useEffect(() => installSpendGuard(), []);
  const ledger = useSpend((s) => s.ledger);
  const guards = useApp((s) => s.persisted.settings.spendGuards);
  const names = useApp(useShallow((s) => s.persisted.workspaces.map((w) => `${w.id}\u0000${w.name}`)));
  const now = Date.now();
  const banners: BannerModel[] = [];
  if (ledger && guards) {
    for (const row of names) {
      const [id, name] = row.split("\u0000");
      const guard = normalizeGuard(guards[id]);
      if (!guard) continue;
      const spent = spentToday(ledger, id, now);
      const trip = bannerFor(ledger, id, spent, guard, now);
      if (trip) banners.push({ id, name, spent, guard, trip });
    }
  }
  // Midnight starts a new budget day: re-render then, but only while a banner shows.
  useDayTick(banners.length > 0);
  if (banners.length === 0) return null;
  return (
    <div className="spend-banners" role="region" aria-label={t("spend.banner.regionAria")}>
      {banners.map((b) => (
        <SpendBanner key={b.id} {...b} />
      ))}
    </div>
  );
}

const SpendBanner = memo(function SpendBanner({ id, name, spent, guard, trip }: BannerModel) {
  const t = useT();
  const [raising, setRaising] = useState(false);
  const [value, setValue] = useState(() => String(suggestRaise(spent, guard)));
  const paused = !!trip.pausedDir;
  const save = () => {
    const n = Number(value);
    if (Number.isFinite(n) && n > 0) {
      raiseBudget(id, n);
      setRaising(false);
    }
  };
  return (
    <div className="spend-banner" role="alert" title={spendNote()}>
      <span className="spend-banner-text">
        {t.rich(paused ? "spend.banner.textPaused" : "spend.banner.text", { name, spent: formatUsd(spent), budget: formatBudget(guard.budgetUsd), b: bold })}
      </span>
      {raising ? (
        <form
          className="spend-banner-form"
          onSubmit={(e) => {
            e.preventDefault();
            save();
          }}
        >
          <label className="spend-banner-label">
            $
            <input
              className="input mono spend-banner-input"
              type="number"
              min={1}
              step={1}
              value={value}
              aria-label={t("spend.banner.newBudgetAria", { name })}
              autoFocus
              onChange={(e) => setValue(e.currentTarget.value)}
              onKeyDown={(e) => e.key === "Escape" && setRaising(false)}
            />
          </label>
          <button type="submit" className="spend-banner-btn is-primary">
            {t("common.save")}
          </button>
          <button type="button" className="spend-banner-btn" onClick={() => setRaising(false)}>
            {t("common.cancel")}
          </button>
        </form>
      ) : (
        <button type="button" className="spend-banner-btn" onClick={() => setRaising(true)}>
          {t("spend.banner.raise")}
        </button>
      )}
      <button type="button" className="spend-banner-btn is-primary" onClick={() => resumeGuard(id)}>
        {t(paused ? "spend.banner.resume" : "spend.banner.dismiss")}
      </button>
    </div>
  );
});
