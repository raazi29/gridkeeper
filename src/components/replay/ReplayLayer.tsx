// Mount point for mission replay (inside MissionLayer, once per app): installs the recorder — it must
// record while Mission Control is closed — and renders the Replay dialog when open.

import { useEffect } from "react";
import { installReplayRecorder } from "../../replay/recorder";
import { useReplay } from "../../store/replay";
import { ErrorBoundary } from "../ErrorBoundary";
import { ReplayDialog } from "./ReplayDialog";

export function ReplayLayer() {
  const open = useReplay((s) => s.dialog.open);
  useEffect(() => installReplayRecorder(), []);
  return (
    <ErrorBoundary key={open ? "open" : "closed"} scope="Mission replay">
      {open && <ReplayDialog />}
    </ErrorBoundary>
  );
}
