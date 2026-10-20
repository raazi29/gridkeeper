// Mount point for the flight log (inside MissionLayer, once per app): installs the subscriptions — they
// must count while Mission Control is closed — registers the chime and renders the dialog when open.

import { useEffect } from "react";
import { useT } from "../../i18n";
import { installFlightLog, setFlightLogChime, useFlightLog } from "../../store/flightlog";
import { ErrorBoundary } from "../ErrorBoundary";
import { playChime } from "./chime";
import { FlightLogDialog } from "./FlightLogDialog";

export function FlightLogLayer() {
  const t = useT();
  const open = useFlightLog((s) => s.open && s.data.enabled);
  useEffect(() => {
    setFlightLogChime(playChime);
    const off = installFlightLog();
    return () => {
      off();
      setFlightLogChime(null);
    };
  }, []);
  return (
    <ErrorBoundary key={open ? "open" : "closed"} scope={t("flightLog.title")}>
      {open && <FlightLogDialog />}
    </ErrorBoundary>
  );
}
