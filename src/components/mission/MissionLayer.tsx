// Mount point for Mission Control: installs the activity log once (it must record while the overlay is
// closed) and renders the overlay and the formation dialog as siblings (so the dialog's key events never
// bubble into the overlay). Mounted once by Shell.

import { useEffect } from "react";
import { cancelAllStarterPrompts } from "../../actions/starterPrompt";
import { installActivity } from "../../store/activity";
import { useMission } from "../../store/mission";
import { ErrorBoundary } from "../ErrorBoundary";
import { ReplayLayer } from "../replay/ReplayLayer";
import { FormationDialog } from "./Formations";
import { MissionControl } from "./MissionControl";

export function MissionLayer() {
  const open = useMission((s) => s.open);
  const formationOpen = useMission((s) => s.formationOpen);
  useEffect(() => {
    const off = installActivity();
    return () => {
      off();
      cancelAllStarterPrompts();
    };
  }, []);
  // Separate boundaries; Mission Control's is remounted on every open, so one render error never leaves
  // the button / Ctrl+Shift+U / palette "stuck" on an error card.
  return (
    <>
      <ErrorBoundary key={open ? "open" : "closed"} scope="Mission Control">
        {open && <MissionControl />}
      </ErrorBoundary>
      <ErrorBoundary scope="Formations">{formationOpen && <FormationDialog />}</ErrorBoundary>
      <ReplayLayer />
    </>
  );
}
