// Resource-pressure warnings: a status-bar chip and a non-blocking notice shown before starting more
// sessions. Driven by the shared diagnostics poll; never shown from stale or missing figures.

import { memoryPressure, memoryPressureLabel } from "../lib/pressure";
import { isDiagnosticsLive, useUi } from "../store/uiStore";
import { useDiagnosticsPoll } from "./hooks";
import { formatMb } from "./util/text";
import "../styles/tools.css";

function usePressure() {
  return useUi((s) => memoryPressure(s.diag?.systemMemoryUsed, s.diag?.systemMemoryTotal));
}

/** Status-bar chip; renders only while memory use is above the threshold. */
export function MemoryPressureChip({ onClick }: { onClick: () => void }) {
  const p = usePressure();
  const detail = useUi((s) => (s.diag ? `${formatMb(s.diag.systemMemoryUsed)} of ${formatMb(s.diag.systemMemoryTotal)} in use` : ""));
  if (!p?.high) return null;
  return (
    <>
      <button type="button" className="sb-item sb-btn sb-warn" onClick={onClick} title={`System memory: ${detail}.\nStop or hide idle sessions before starting more.`}>
        <span className="dot is-warn" />
        {memoryPressureLabel(p)}
      </button>
      <span className="sb-div" />
    </>
  );
}

/** Non-blocking notice for the New Session dialog / quick-launch panel. Holds the poll while mounted. */
export function MemoryPressureNotice({ count = 1 }: { count?: number }) {
  useDiagnosticsPoll(true);
  const p = usePressure();
  if (!p?.high) return null;
  return (
    <div className="callout is-warn pressure-note" role="status">
      System memory is at {p.percent}%. Starting {count > 1 ? `${count} more sessions` : "another session"} may slow the PC down — consider closing idle sessions
      first.
    </div>
  );
}

/** One-shot check for menus (no poll of their own): the warning label, or null. */
export function memoryPressureNow(): string | null {
  if (!isDiagnosticsLive()) return null;
  const d = useUi.getState().diag;
  const p = memoryPressure(d?.systemMemoryUsed, d?.systemMemoryTotal);
  return p?.high ? `Memory ${p.percent}% — consider closing idle sessions` : null;
}
