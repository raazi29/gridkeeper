// App shell: Sidebar | (WorkspaceHeader + GroupTabs + group grids) | Inspector, StatusBar, overlays.
// Every group of every workspace visited this run keeps its <GroupGrid> mounted (display:none when
// inactive) so terminals keep their state across workspace / group switches.

import { useEffect, useState } from "react";
import { useShallow } from "zustand/react/shallow";
import { installFocusTracking } from "../actions/commands";
import { installResumeWatch } from "../actions/resume";
import { installKeybindings } from "../keybindings";
import { installNativeMenu } from "../lib/nativeMenu";
import { isMac } from "../lib/platform";
import { GroupGrid } from "../layout/GroupGrid";
import { selectActiveGroup, selectActiveWorkspace, useApp } from "../store/appStore";
import { useUi } from "../store/uiStore";
import { AttentionLayer } from "./AttentionLayer";
import { BrainLayer } from "./brain/BrainLayer";
import { CommandPalette } from "./CommandPalette";
import { ConfirmDialog } from "./ConfirmDialog";
import { ContextMenuHost } from "./ContextMenuHost";
import { DialogHost } from "./DialogHost";
import { ExperienceLayer } from "./ExperienceLayer";
import { GroupTabs } from "./GroupTabs";
import { IconClose, IconWarn } from "./icons";
import { Inspector } from "./Inspector";
import { MissionLayer } from "./mission/MissionLayer";
import { SkillsLayer } from "./skills/SkillsPanel";
import { Sidebar } from "./Sidebar";
import { StatusBar } from "./StatusBar";
import { Toasts } from "./Toasts";
import { Button } from "./ui/Button";
import { WorkspaceHeader } from "./WorkspaceHeader";
import { BrowserLayer } from "../browser/BrowserLayer";
import { ChangesDrawer } from "./ChangesDrawer";
import { installPortsWatch } from "../store/ports";
import { installMeterWatch } from "../store/meter";
import "../browser/browser.css";

export function Shell() {
  const activeWsId = useApp((s) => selectActiveWorkspace(s)?.id);
  const inspectorOpen = useApp((s) => s.persisted.settings.inspectorOpen);
  const collapsed = useApp((s) => s.persisted.settings.sidebarCollapsed);
  const changesOpen = useUi((s) => s.changesOpen);

  useEffect(() => {
    const offKeys = installKeybindings();
    // macOS only: the native app menu's custom items (Windows / Linux have no native menu).
    const offMenu = isMac ? installNativeMenu() : () => {};
    const offFocus = installFocusTracking();
    const offResume = installResumeWatch();
    const offPorts = installPortsWatch();
    const offMeter = installMeterWatch();
    const onNewSession = (e: Event) => {
      const detail = (e as CustomEvent<{ groupId?: string } | undefined>).detail;
      const groupId = detail?.groupId ?? selectActiveGroup(useApp.getState())?.id;
      useUi.getState().openDialog({ kind: "newSession", groupId });
    };
    window.addEventListener("gridkeeper:new-session", onNewSession);
    return () => {
      offKeys();
      offMenu();
      offFocus();
      offResume();
      offPorts();
      offMeter();
      window.removeEventListener("gridkeeper:new-session", onNewSession);
    };
  }, []);

  useEffect(() => {
    if (activeWsId) useUi.getState().markVisited(activeWsId);
  }, [activeWsId]);

  return (
    <div className={`shell${collapsed ? " sidebar-collapsed" : ""}`}>
      <div className="shell-body">
        <Sidebar />
        <main className="main">
          <LoadErrorBanner />
          <WorkspaceHeader />
          <GroupTabs />
          <div className="work-row">
            <GridArea />
            {changesOpen && <ChangesDrawer />}
            {inspectorOpen && <Inspector />}
          </div>
        </main>
      </div>
      <StatusBar />
      <CommandPalette />
      <DialogHost />
      <ConfirmDialog />
      <Toasts />
      <AttentionLayer />
      <MissionLayer />
      <SkillsLayer />
      <BrainLayer />
      <ExperienceLayer />
      <ContextMenuHost />
    </div>
  );
}

function GridArea() {
  const visited = useUi((s) => s.visited);
  const activeGroupId = useApp((s) => selectActiveGroup(s)?.id);
  const groupIds = useApp(
    useShallow((s) => {
      const out: string[] = [];
      for (const w of s.persisted.workspaces) if (visited[w.id]) for (const g of w.groups) out.push(g.id);
      return out;
    }),
  );
  // The active group renders even before the visited-effect runs (first paint).
  const ids = activeGroupId && !groupIds.includes(activeGroupId) ? [...groupIds, activeGroupId] : groupIds;
  return (
    <div className="grid-area">
      {!activeGroupId && <NoWorkspace />}
      {ids.map((gid) => {
        const active = gid === activeGroupId;
        return (
          <div key={gid} className="grid-slot" style={active ? undefined : { display: "none" }}>
            <GroupGrid groupId={gid} active={active} />
          </div>
        );
      })}
      <BrowserLayer />
    </div>
  );
}

function NoWorkspace() {
  const hasWorkspace = useApp((s) => s.persisted.workspaces.length > 0);
  return (
    <div className="empty-state">
      <span>{hasWorkspace ? "This workspace has no groups." : "No workspace yet."}</span>
      <Button
        variant="primary"
        onClick={() => {
          const ws = selectActiveWorkspace(useApp.getState());
          if (ws) useApp.getState().createGroup(ws.id, "Main");
          else useUi.getState().openDialog({ kind: "newWorkspace" });
        }}
      >
        {hasWorkspace ? "Create group" : "Create workspace"}
      </Button>
    </div>
  );
}

function LoadErrorBanner() {
  const loadError = useApp((s) => s.loadError);
  const [dismissed, setDismissed] = useState<string | null>(null);
  if (!loadError || dismissed === loadError) return null;
  return (
    <div className="banner is-error" role="alert">
      <IconWarn size={14} />
      <span className="banner-text">
        Could not load saved workspaces: <span className="mono">{loadError}</span>. Changes in this run may overwrite the saved file.
      </span>
      <button type="button" className="icon-btn icon-btn-sm" aria-label="Dismiss" onClick={() => setDismissed(loadError)}>
        <IconClose size={12} />
      </button>
    </div>
  );
}
