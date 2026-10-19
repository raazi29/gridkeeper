// Mount point for mission replay (inside MissionLayer, once per app): installs the recorder — it must
// record while Mission Control is closed — and renders the Replay dialog when open.

import { useEffect } from "react";
import { useT } from "../../i18n";
import { installReplayRecorder } from "../../replay/recorder";
import { useReplay } from "../../store/replay";
import { ErrorBoundary } from "../ErrorBoundary";
import { ReplayDialog } from "./ReplayDialog";

export function ReplayLayer() {
  const t = useT();
  const open = useReplay((s) => s.dialog.open);
  useEffect(() => installReplayRecorder(), []);
  return (
    <ErrorBoundary key={open ? "open" : "closed"} scope={t("replay.title")}>
      {open && <ReplayDialog />}
    </ErrorBoundary>
  );
}
