// Renders the single active dialog from uiStore.

import { useUi } from "../store/uiStore";
import { DiagnosticsPanel } from "./DiagnosticsPanel";
import { NewSessionDialog } from "./NewSessionDialog";
import { NewWorkspaceDialog } from "./NewWorkspaceDialog";
import { OpenUrlDialog } from "../browser/OpenUrlDialog";
import { ProfilesDialog } from "./ProfilesDialog";
import { SettingsDialog } from "./SettingsDialog";
import { WelcomeSheet } from "./Welcome";

export function DialogHost() {
  const dialog = useUi((s) => s.dialog);
  const close = useUi((s) => s.closeDialog);
  if (!dialog) return null;
  switch (dialog.kind) {
    case "newSession":
      return <NewSessionDialog groupId={dialog.groupId} preset={dialog.preset} onClose={close} />;
    case "newWorkspace":
      return <NewWorkspaceDialog onClose={close} />;
    case "settings":
      return <SettingsDialog onClose={close} />;
    case "profiles":
      return <ProfilesDialog onClose={close} />;
    case "diagnostics":
      return <DiagnosticsPanel onClose={close} />;
    case "welcome":
      return <WelcomeSheet onClose={close} />;
    case "openUrl":
      return <OpenUrlDialog groupId={dialog.groupId} onClose={close} />;
  }
}
