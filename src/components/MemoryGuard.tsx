// Low-memory guard UI (store/memguard.ts, ADR-024): the banner shown once per entry into "low" / "critical",
// the status-bar chip while memory is not ok, and the per-pane hint for a held launch.

import { memo } from "react";
import { useT } from "../i18n";
import { isWindows } from "../lib/platform";
import type { SessionId } from "../lib/types";
import { useApp } from "../store/appStore";
import { dismissMemoryBanner, holdOn, levelOf, releaseHeld, showMemoryBanner, useMemGuard, warningsOn } from "../store/memguard";
import { IconClose, IconWarn } from "./icons";
import { Button } from "./ui/Button";
import { formatMb } from "./util/text";
import "../styles/tools.css";

/** Free / limit figures: always GB with one decimal (the banner compares them). */
export function formatGb(bytes: number): string {
  return `${(bytes / 1024 ** 3).toFixed(1)} GB`;
}

/** The open banner's figures come from the store: Rust sends a full status every 5 s while memory is short. */
export function MemoryBanner() {
  const t = useT();
  const enabled = useApp((s) => warningsOn(s.persisted.settings));
  const holding = useApp((s) => holdOn(s.persisted.settings));
  const visible = useMemGuard((s) => s.banner.visible);
  const status = useMemGuard((s) => s.status);
  const held = useMemGuard((s) => s.held);
  if (!enabled || visible === null || !status) return null;
  const critical = visible === "critical";
  const figures = { free: formatGb(status.freeBytes), limit: formatGb(status.limitBytes) };
  return (
    <div className={`banner mem-banner ${critical ? "is-error" : "is-warn"}`} role={critical ? "alert" : "status"}>
      <IconWarn size={14} />
      <div className="mem-banner-body">
        <div className="mem-banner-title">{critical ? t("memguard.bannerCritical", figures) : t("memguard.bannerLow", figures)}</div>
        {status.top.length > 0 && (
          <div className="mem-banner-top">
            <span>{t("memguard.topTitle")}</span>
            {status.top.map((c) => (
              <span key={c.name} className="mem-banner-prog" title={`PID ${c.pid}`}>
                <span className="mono">{c.name}</span>
                {c.count > 1 ? ` ×${c.count}` : ""} · {formatMb(c.bytes)}
              </span>
            ))}
          </div>
        )}
        {status.agentsBytes !== null && status.appBytes !== null && (
          <div className="mem-banner-meta">{t("memguard.share", { agents: formatMb(status.agentsBytes), app: formatMb(status.appBytes) })}</div>
        )}
        <div className="mem-banner-meta">{isWindows ? t("memguard.hintWindows") : t("memguard.hint")}</div>
        {critical && holding && (
          <div className="mem-banner-title">{held.length > 0 ? t("memguard.heldCount", { count: held.length }) : t("memguard.holdActive")}</div>
        )}
      </div>
      {held.length > 0 && (
        <Button size="sm" onClick={() => releaseHeld()}>
          {t("memguard.launchAnyway")}
        </Button>
      )}
      <button type="button" className="icon-btn icon-btn-sm" aria-label={t("common.dismiss")} onClick={dismissMemoryBanner}>
        <IconClose size={12} />
      </button>
    </div>
  );
}

/** Status-bar chip while memory is low or critical; opens the banner again. */
export function MemoryLevelChip() {
  const t = useT();
  const enabled = useApp((s) => warningsOn(s.persisted.settings));
  const status = useMemGuard((s) => s.status);
  const level = levelOf(status);
  if (!enabled || !status || level === "ok") return null;
  const critical = level === "critical";
  return (
    <>
      <button
        type="button"
        className={`sb-item sb-btn ${critical ? "sb-err" : "sb-warn"}`}
        onClick={showMemoryBanner}
        title={t("memguard.chipTitle", { free: formatGb(status.freeBytes), limit: formatGb(status.limitBytes) })}
      >
        <span className={`dot ${critical ? "is-err" : "is-warn"}`} />
        {critical ? t("memguard.chipCritical") : t("memguard.chipLow")}
      </button>
      <span className="sb-div" />
    </>
  );
}

/** Pane footer for a launch held by the guard, with "Launch anyway" for this pane only. */
export const HeldLaunchHint = memo(function HeldLaunchHint({ sessionId }: { sessionId: SessionId }) {
  const t = useT();
  const held = useMemGuard((s) => s.held.some((h) => h.id === sessionId));
  if (!held) return null;
  return (
    <div className="pane-exitbar">
      <span className="pane-exitbar-label is-error">{t("memguard.paneHeld")}</span>
      <span className="pane-exitbar-sep">·</span>
      <button type="button" className="pane-link" onClick={() => releaseHeld([sessionId])}>
        {t("memguard.launchAnyway")}
      </button>
    </div>
  );
});
