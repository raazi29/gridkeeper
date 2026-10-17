// App shell. STUB — implemented by the shell-UI owner.
// Renders: Sidebar | (WorkspaceHeader + GroupTabs + group grids) | Inspector, StatusBar, CommandPalette, dialogs, Toasts.
// Every visited group's <GroupGrid> stays mounted (display:none when inactive) so terminals keep their state.

import { GroupGrid } from "../layout/GroupGrid";
import { selectActiveGroup, useApp } from "../store/appStore";

export function Shell() {
  const group = useApp(selectActiveGroup);
  return <div style={{ height: "100%" }}>{group && <GroupGrid groupId={group.id} active />}</div>;
}
