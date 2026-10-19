// Mount point of the Brain (long-term project memory), rendered once by Shell: installs the capture engine
// (suggestions from the board, reviews and lead decisions; it must work while the panel is closed), renders the
// panel and the "add memory" dialog as siblings, and the "remember…" selection chip while Mission Control is open.

import { useEffect } from "react";
import { installBrainCapture } from "../../actions/brainCapture";
import { useT } from "../../i18n";
import { useBrain } from "../../store/brain";
import { useMission } from "../../store/mission";
import { ErrorBoundary } from "../ErrorBoundary";
import { BrainPanel } from "./BrainPanel";
import { ComposeDialog } from "./ComposeDialog";
import { RememberChip } from "./RememberChip";
import "../../styles/brain.css";

export function BrainLayer() {
  const t = useT();
  const open = useBrain((s) => s.open);
  const composing = useBrain((s) => s.compose !== null);
  const missionOpen = useMission((s) => s.open);
  useEffect(() => installBrainCapture(), []);
  return (
    <>
      <ErrorBoundary key={open ? "open" : "closed"} scope={t("brain.layer.scope")}>
        {open && <BrainPanel />}
      </ErrorBoundary>
      <ErrorBoundary key={composing ? "compose" : "idle"} scope={t("brain.layer.scopeCompose")}>
        {composing && <ComposeDialog />}
      </ErrorBoundary>
      {missionOpen && <RememberChip />}
    </>
  );
}
