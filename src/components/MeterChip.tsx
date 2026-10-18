// Cost & context meter UI bits: the per-pane chip (pane header, Fleet tile), the Mission Control card
// line, the workspace total and the one-time "turn on the cost meter" hint.
// Each subscribes to one session's meter entry and two primitive settings; nothing is polled.

import { memo, useMemo } from "react";
import { notify } from "../actions/notify";
import { cardLine, chipModel, formatCost, workspaceCost, ESTIMATE_NOTE, type ChipModel } from "../lib/meter";
import type { SessionId } from "../lib/types";
import { useApp } from "../store/appStore";
import { useMeter } from "../store/meter";
import "../styles/meter.css";

export const METER_HINT_TITLE =
  "Shows Claude Code's own cost estimate and context use for each Claude pane. Gridkeeper reads only the numbers " +
  "Claude Code hands to its status line command (cost, context, tokens, model, rate limits), never transcripts or " +
  "credentials. Applies to Claude panes started after you turn it on.";

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
  const chip = useMeterChip(sessionId);
  if (!chip) return null;
  const tone = chip.kind === "data" ? (chip.level === "warn" ? " is-warn" : "") : " is-muted";
  const base = variant === "pane" ? "pane-chip meter-chip" : "chip meter-chip meter-chip--tile";
  return (
    <span className={`${base}${tone}`} title={chip.tooltip} aria-label={`Cost meter: ${chip.label}`} data-meter={chip.kind}>
      {chip.label}
    </span>
  );
});

/** Mission Control card line: `est. $0.42 · ctx 37%` (Claude panes with data only). */
export const MeterCardLine = memo(function MeterCardLine({ sessionId }: { sessionId: SessionId }) {
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
  const enabled = useApp((s) => s.persisted.settings.costMeter ?? false);
  const total = useMeter((s) => workspaceCost(ids, s.bySession));
  if (!enabled || total === null) return null;
  return (
    <span title={`Estimated cost of this workspace's Claude panes (sum of each pane's total).\n${ESTIMATE_NOTE}`}>
      cost [ <b>~{formatCost(total)}</b> ]
    </span>
  );
}

export function enableCostMeter(): void {
  useApp.getState().updateSettings({ costMeter: true, costMeterHintDismissed: true });
  notify("info", "Cost meter on: Claude panes started from now on report cost and context. Restart a running pane to apply.", 6000);
}

/** One-time hint while the meter is off and Claude panes are around. */
export function CostMeterHint({ ids, variant }: { ids: readonly SessionId[]; variant: "mc" | "fleet" }) {
  const show = useApp((s) => {
    const st = s.persisted.settings;
    if (st.costMeter || st.costMeterHintDismissed) return false;
    return s.persisted.sessions.some((m) => m.agent === "claude" && ids.includes(m.id));
  });
  if (!show) return null;
  return (
    <span className={`meter-hint meter-hint--${variant}`} title={METER_HINT_TITLE}>
      cost meter off ·{" "}
      <button type="button" className="meter-hint-btn" onClick={enableCostMeter}>
        turn on
      </button>
      <button
        type="button"
        className="meter-hint-btn meter-hint-x"
        aria-label="Dismiss the cost meter hint"
        title="Dismiss (Settings › Agents has the switch)"
        onClick={() => useApp.getState().updateSettings({ costMeterHintDismissed: true })}
      >
        ×
      </button>
    </span>
  );
}
