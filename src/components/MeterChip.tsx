// Cost & context meter UI bits: the per-pane chip (pane header, Fleet tile), the Mission Control card
// line, the workspace total and the one-time "turn on the cost meter" hint.
// Each subscribes to one session's meter entry and two primitive settings; nothing is polled.

import { memo, useMemo } from "react";
import { notify } from "../actions/notify";
import { t, useT } from "../i18n";
import { cardLine, chipModel, estimateNote, formatCost, workspaceCost, type ChipModel } from "../lib/meter";
import type { SessionId } from "../lib/types";
import { useApp } from "../store/appStore";
import { useMeter } from "../store/meter";
import "../styles/meter.css";

/** The chip model for one session (null = show nothing). */
export function useMeterChip(sessionId: SessionId): ChipModel | null {
  const agent = useApp((s) => s.persisted.sessions.find((m) => m.id === sessionId)?.agent);
  const preset = useApp((s) => s.persisted.sessions.find((m) => m.id === sessionId)?.preset ?? null);
  const enabled = useApp((s) => s.persisted.settings.costMeter ?? false);
  const meter = useMeter((s) => s.bySession[sessionId]);
  return useMemo(() => (agent ? chipModel({ agent, preset, enabled, meter }) : null), [agent, preset, enabled, meter]);
}

/** Pane header / Fleet tile chip: `$0.42 · 37%`, `meter off` or `n/a`. */
export const MeterChip = memo(function MeterChip({ sessionId, variant }: { sessionId: SessionId; variant: "pane" | "tile" }) {
  const t = useT();
  const chip = useMeterChip(sessionId);
  if (!chip) return null;
  const tone = chip.kind === "data" ? (chip.level === "warn" ? " is-warn" : "") : " is-muted";
  const base = variant === "pane" ? "pane-chip meter-chip" : "chip meter-chip meter-chip--tile";
  return (
    <span className={`${base}${tone}`} title={chip.tooltip} aria-label={t("meter.chipAria", { label: chip.label })} data-meter={chip.kind}>
      {chip.label}
    </span>
  );
});

/** Mission Control card line: `est. $0.42 · ctx 37%` (Claude panes with data only). */
export const MeterCardLine = memo(function MeterCardLine({ sessionId }: { sessionId: SessionId }) {
  useT(); // re-render on a language change (cardLine / the tooltip are translated)
  const chip = useMeterChip(sessionId);
  const meter = useMeter((s) => s.bySession[sessionId]);
  if (!chip || chip.kind !== "data" || !meter) return null;
  return (
    <div className={`mc-card-row mc-meter${chip.level === "warn" ? " is-warn" : ""}`} title={chip.tooltip}>
      {cardLine(meter)}
    </div>
  );
});

/** Mission Control status footer: `cost [ ~$3.10 ]` for the workspace's metered panes. */
export function WorkspaceCost({ ids }: { ids: readonly SessionId[] }) {
  const t = useT();
  const enabled = useApp((s) => s.persisted.settings.costMeter ?? false);
  const total = useMeter((s) => workspaceCost(ids, s.bySession));
  if (!enabled || total === null) return null;
  return <span title={`${t("meter.workspaceCostTitle")}\n${estimateNote()}`}>{t.rich("meter.workspaceCost", { cost: formatCost(total), b: (c) => <b>{c}</b> })}</span>;
}

export function enableCostMeter(): void {
  useApp.getState().updateSettings({ costMeter: true, costMeterHintDismissed: true });
  notify("info", t("meter.enabledToast"), 6000);
}

/** One-time hint while the meter is off and Claude panes are around. */
export function CostMeterHint({ ids, variant }: { ids: readonly SessionId[]; variant: "mc" | "fleet" }) {
  const t = useT();
  const show = useApp((s) => {
    const st = s.persisted.settings;
    if (st.costMeter || st.costMeterHintDismissed) return false;
    return s.persisted.sessions.some((m) => m.agent === "claude" && ids.includes(m.id));
  });
  if (!show) return null;
  return (
    <span className={`meter-hint meter-hint--${variant}`} title={t("meter.hintTitle")}>
      {t("meter.hintOff")}{" "}
      <button type="button" className="meter-hint-btn" onClick={enableCostMeter}>
        {t("meter.hintTurnOn")}
      </button>
      <button
        type="button"
        className="meter-hint-btn meter-hint-x"
        aria-label={t("meter.hintDismissAria")}
        title={t("meter.hintDismissTitle")}
        onClick={() => useApp.getState().updateSettings({ costMeterHintDismissed: true })}
      >
        ×
      </button>
    </span>
  );
}
