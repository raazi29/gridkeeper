// Mount point for the flight log (inside MissionLayer, once per app): installs the subscriptions — they
// must count while Mission Control is closed — registers the chime and renders the dialog when open.

import { useEffect } from "react";
import { installFlightLog, setFlightLogChime, useFlightLog } from "../../store/flightlog";
import { ErrorBoundary } from "../ErrorBoundary";
import { playChime } from "./chime";
import { FlightLogDialog } from "./FlightLogDialog";

export function FlightLogLayer() {
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
    <ErrorBoundary key={open ? "open" : "closed"} scope="Flight log">
      {open && <FlightLogDialog />}
    </ErrorBoundary>
  );
}
