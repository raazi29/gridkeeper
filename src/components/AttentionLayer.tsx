// Mount point for the attention features: installs the event wiring once and renders the Fleet,
// Broadcast and Comms overlays when open. Mounted once by Shell.

import { useEffect } from "react";
import { installAttention } from "../actions/attentionNotify";
import { useT } from "../i18n";
import { useAttentionUi } from "../store/attention";
import { BroadcastDialog } from "./Broadcast";
import { CommsPanel } from "./Comms";
import { ErrorBoundary } from "./ErrorBoundary";
import { FleetOverlay } from "./Fleet";

export function AttentionLayer() {
  const t = useT();
  const overlay = useAttentionUi((s) => s.overlay);
  const commsOpen = useAttentionUi((s) => s.commsOpen);
  useEffect(() => installAttention(), []);
  return (
    <ErrorBoundary scope={t("errors.scopeAttention")}>
      {overlay === "fleet" && <FleetOverlay />}
      {overlay === "broadcast" && <BroadcastDialog />}
      {commsOpen && <CommsPanel />}
    </ErrorBoundary>
  );
}
