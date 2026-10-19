// Test-run badge for a folder (agent cards, sign-off cards): `tests ✓ 412 · 38s` / `tests ✗ 3 failed` /
// `tests … 0:12`. Click opens the read-only log. Renders nothing until the folder has a run. While a run
// is active the elapsed time ticks once a second (only then; no timer otherwise).

import { useEffect, useState, type MouseEvent } from "react";
import { useT } from "../../i18n";
import { ensureTestRuns, latestRunFor, openTestLog, useTestRuns } from "../../store/testrun";
import { badgeText, badgeTitle, badgeTone, isActiveStatus } from "./format";
import "../../styles/testrun.css";

/** Wall clock that ticks every second while `active` (a caller's clock can be passed instead). */
export function useTicking(active: boolean, external?: number): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!active || external !== undefined) return;
    setNow(Date.now());
    const t = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(t);
  }, [active, external]);
  return external ?? now;
}

export function TestBadge({ path, now, className }: { path: string | null | undefined; now?: number; className?: string }) {
  const t = useT();
  const run = useTestRuns((s) => latestRunFor(s, path));
  useEffect(() => {
    void ensureTestRuns();
  }, []);
  const clock = useTicking(!!run && isActiveStatus(run.status), now);
  if (!run) return null;
  const open = (e: MouseEvent) => {
    e.stopPropagation();
    openTestLog(run.id);
  };
  return (
    <button
      type="button"
      tabIndex={-1}
      className={`tr-badge is-${badgeTone(run.status)}${className ? ` ${className}` : ""}`}
      title={badgeTitle(run)}
      aria-label={t("testrun.badge.aria", { badge: badgeText(run, clock) })}
      onMouseDown={(e) => e.preventDefault()}
      onClick={open}
    >
      {badgeText(run, clock)}
    </button>
  );
}

/** Flask icon for "run tests" buttons (16px grid, currentColor). */
export function IconFlask({ size = 16 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth={1.4} strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" focusable="false">
      <path d="M6 2h4M6.5 2v4.2L3 12.6A1 1 0 0 0 3.9 14h8.2a1 1 0 0 0 .9-1.4L9.5 6.2V2" />
      <path d="M4.6 10h6.8" />
    </svg>
  );
}
