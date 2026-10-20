// Resource-pressure warnings: a status-bar chip and a non-blocking notice shown before starting more
// sessions. Driven by the shared diagnostics poll; never shown from stale or missing figures.

import { useMemo } from "react";
import { memoryPressure, memoryPressureLabel } from "../lib/pressure";
import { isDiagnosticsLive, useUi } from "../store/uiStore";
import { useDiagnosticsPoll } from "./hooks";
import { formatMb } from "./util/text";
import { t, useT } from "../i18n";
import "../styles/tools.css";

function usePressure() {
  // Select primitives only: a selector that builds a new object every call makes React re-render forever.
  const used = useUi((s) => s.diag?.systemMemoryUsed);
  const total = useUi((s) => s.diag?.systemMemoryTotal);
  return useMemo(() => memoryPressure(used, total), [used, total]);
}

/** Status-bar chip; renders only while memory use is above the threshold. */
export function MemoryPressureChip({ onClick }: { onClick: () => void }) {
  const t = useT();
  const p = usePressure();
  const used = useUi((s) => s.diag?.systemMemoryUsed ?? 0);
  const total = useUi((s) => s.diag?.systemMemoryTotal ?? 0);
  if (!p?.high) return null;
  return (
    <>
      <button type="button" className="sb-item sb-btn sb-warn" onClick={onClick} title={t("resources.chipTitle", { used: formatMb(used), total: formatMb(total) })}>
        <span className="dot is-warn" />
        {memoryPressureLabel(p)}
      </button>
      <span className="sb-div" />
    </>
  );
}

/**
 * Non-blocking notice before starting sessions. With `poll` (transient dialogs) it holds the diagnostics
 * poll while mounted; without it (always-visible places like the empty-group panel) it only uses figures
 * another view is already polling, so an idle window gains no timer.
 */
export function MemoryPressureNotice({ count = 1, poll = true }: { count?: number; poll?: boolean }) {
  const t = useT();
  useDiagnosticsPoll(poll);
  const p = usePressure();
  if (!p?.high || (!poll && !isDiagnosticsLive())) return null;
  return (
    <div className="callout is-warn pressure-note" role="status">
      {t("resources.notice", { percent: p.percent, count: Math.max(1, count) })}
    </div>
  );
}

/** One-shot check for menus (no poll of their own): the warning label, or null. */
export function memoryPressureNow(): string | null {
  if (!isDiagnosticsLive()) return null;
  const d = useUi.getState().diag;
  const p = memoryPressure(d?.systemMemoryUsed, d?.systemMemoryTotal);
  return p?.high ? t("resources.pressureMenu", { percent: p.percent }) : null;
}
