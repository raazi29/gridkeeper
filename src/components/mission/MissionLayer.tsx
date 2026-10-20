// Mount point for Mission Control: installs the activity log, the state history (timeline) and the lead control
// engine once (they must work while the overlay is closed) and renders the overlay and the formation dialog as siblings (so the
// dialog's key events never bubble into the overlay). Mounted once by Shell.

import { useEffect } from "react";
import { installLeadControl } from "../../actions/leadControl";
import { cancelAllStarterPrompts } from "../../actions/starterPrompt";
import { useT } from "../../i18n";
import { installActivity } from "../../store/activity";
import { useMission } from "../../store/mission";
import { installStateHistory } from "../../store/stateHistory";
import { ErrorBoundary } from "../ErrorBoundary";
import { FlightLogLayer } from "../flightlog/FlightLogLayer";
import { ReplayLayer } from "../replay/ReplayLayer";
import { FormationDialog } from "./Formations";
import { MissionControl } from "./MissionControl";

export function MissionLayer() {
  const t = useT();
  const open = useMission((s) => s.open);
  const formationOpen = useMission((s) => s.formationOpen);
  useEffect(() => {
    const off = installActivity();
    const offHistory = installStateHistory(); // the timeline view needs history from before it opens
    const offLead = installLeadControl();
    return () => {
      off();
      offHistory();
      offLead();
      cancelAllStarterPrompts();
    };
  }, []);
  // Separate boundaries; Mission Control's is remounted on every open, so one render error never leaves
  // the button / Ctrl+Shift+U / palette "stuck" on an error card.
  return (
    <>
      <ErrorBoundary key={open ? "open" : "closed"} scope={t("mc.scope.missionControl")}>
        {open && <MissionControl />}
      </ErrorBoundary>
      <ErrorBoundary scope={t("mc.scope.formations")}>{formationOpen && <FormationDialog />}</ErrorBoundary>
      <ReplayLayer />
      <FlightLogLayer />
    </>
  );
}
