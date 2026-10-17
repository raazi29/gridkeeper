// Left sidebar: app mark, workspace list, footer buttons. Collapses to a 48px rail of initials.

import { memo, useState } from "react";
import { useShallow } from "zustand/react/shallow";
import { deleteWorkspaceFlow, switchWorkspace } from "../actions/commands";
import { notify } from "../actions/notify";
import { isLive, selectActiveWorkspace, useApp, type AppStore } from "../store/appStore";
import { useUi } from "../store/uiStore";
import { WorkspaceUnreadBadge } from "./AttentionBits";
import { APP_NAME } from "../lib/brand";
import { useShortcut, withShortcut } from "./hooks";
import { AppMark, IconActivity, IconChevronLeft, IconChevronRight, IconPlus, IconSettings, IconUsers } from "./icons";
import { useContextMenu } from "./ui/Menu";
import { basename, initials } from "./util/text";
import { pickFolder } from "./util/pick";

function countSessions(s: AppStore, wsId: string): number {
  const ws = s.persisted.workspaces.find((w) => w.id === wsId);
  let n = 0;
  if (ws) for (const g of ws.groups) n += g.sessionIds.length;
  return n;
}

function countRunning(s: AppStore, wsId: string): number {
  const ws = s.persisted.workspaces.find((w) => w.id === wsId);
  let n = 0;
  if (ws) for (const g of ws.groups) for (const id of g.sessionIds) if (isLive(s.runtime[id])) n++;
  return n;
}

export function Sidebar() {
  const collapsed = useApp((s) => s.persisted.settings.sidebarCollapsed);
  const ids = useApp(useShallow((s) => s.persisted.workspaces.map((w) => w.id)));
  const activeId = useApp((s) => selectActiveWorkspace(s)?.id);
  const scNewWs = useShortcut("workspace.new");
  const scSidebar = useShortcut("view.toggleSidebar");
  const scSettings = useShortcut("view.settings");
  const scDiag = useShortcut("view.toggleDiagnostics");
  const menu = useContextMenu();
  const toggle = () => useApp.getState().updateSettings({ sidebarCollapsed: !collapsed });
  const ui = useUi.getState;

  return (
    <aside className={`sidebar${collapsed ? " is-collapsed" : ""}`} aria-label="Workspaces">
      <div className="sidebar-top">
        <div className="app-mark" title={APP_NAME}>
          <AppMark size={18} />
          {!collapsed && <span className="wordmark">{APP_NAME}</span>}
        </div>
        {!collapsed && (
          <button type="button" className="icon-btn icon-btn-sm" aria-label="Collapse sidebar" title={withShortcut("Collapse sidebar", scSidebar)} onClick={toggle}>
            <IconChevronLeft size={14} />
          </button>
        )}
      </div>

      {!collapsed && (
        <div className="sidebar-section-head">
          <span>Workspaces</span>
          <button type="button" className="icon-btn icon-btn-sm" aria-label="New workspace" title={withShortcut("New workspace", scNewWs)} onClick={() => ui().openDialog({ kind: "newWorkspace" })}>
            <IconPlus size={14} />
          </button>
        </div>
      )}

      <nav className="ws-list" role="list">
        {ids.map((id) => (
          <WorkspaceRow key={id} id={id} active={id === activeId} collapsed={collapsed} openMenu={menu.open} />
        ))}
        {collapsed ? (
          <button type="button" className="rail-btn" aria-label="New workspace" title={withShortcut("New workspace", scNewWs)} onClick={() => ui().openDialog({ kind: "newWorkspace" })}>
            <IconPlus size={14} />
          </button>
        ) : (
          <button type="button" className="ws-new" onClick={() => ui().openDialog({ kind: "newWorkspace" })} title={withShortcut("New workspace", scNewWs)}>
            <IconPlus size={13} />
            <span>New workspace</span>
          </button>
        )}
      </nav>

      <div className="sidebar-footer">
        <FooterButton collapsed={collapsed} label="Profiles" title="Claude account profiles" onClick={() => ui().openDialog({ kind: "profiles" })} icon={<IconUsers size={15} />} />
        <FooterButton collapsed={collapsed} label="Settings" title={withShortcut("Settings", scSettings)} onClick={() => ui().openDialog({ kind: "settings" })} icon={<IconSettings size={15} />} />
        <FooterButton collapsed={collapsed} label="Diagnostics" title={withShortcut("Diagnostics", scDiag)} onClick={() => ui().openDialog({ kind: "diagnostics" })} icon={<IconActivity size={15} />} />
        {collapsed && (
          <button type="button" className="rail-btn" aria-label="Expand sidebar" title={withShortcut("Expand sidebar", scSidebar)} onClick={toggle}>
            <IconChevronRight size={14} />
          </button>
        )}
      </div>
      {menu.element}
    </aside>
  );
}

function FooterButton({ collapsed, label, title, onClick, icon }: { collapsed: boolean; label: string; title: string; onClick: () => void; icon: React.ReactNode }) {
  return (
    <button type="button" className={collapsed ? "rail-btn" : "footer-btn"} aria-label={label} title={title} onClick={onClick}>
      {icon}
      {!collapsed && <span>{label}</span>}
    </button>
  );
}

const WorkspaceRow = memo(function WorkspaceRow({
  id,
  active,
  collapsed,
  openMenu,
}: {
  id: string;
  active: boolean;
  collapsed: boolean;
  openMenu: ReturnType<typeof useContextMenu>["open"];
}) {
  const name = useApp((s) => s.persisted.workspaces.find((w) => w.id === id)?.name ?? "");
  const projectDir = useApp((s) => s.persisted.workspaces.find((w) => w.id === id)?.projectDir ?? null);
  const sessions = useApp((s) => countSessions(s, id));
  const running = useApp((s) => countRunning(s, id));
  const [editing, setEditing] = useState(false);

  const commitRename = (value: string) => {
    setEditing(false);
    const v = value.trim();
    if (v && v !== name) useApp.getState().renameWorkspace(id, v);
  };

  const changeFolder = async () => {
    const dir = await pickFolder("Choose project folder", projectDir);
    if (dir) {
      useApp.getState().updateWorkspace(id, { projectDir: dir });
      notify("info", `Project folder set to ${dir}. Existing sessions keep their own working directory.`);
    }
  };

  const onContextMenu = (e: React.MouseEvent) =>
    openMenu(e, [
      { label: "Rename", onSelect: () => setEditing(true) },
      { label: "Change project folder…", onSelect: () => void changeFolder() },
      {
        label: "Duplicate configuration",
        hint: "no processes",
        onSelect: () => {
          const newId = useApp.getState().duplicateWorkspace(id);
          if (newId) {
            switchWorkspace(newId);
            notify("info", "Workspace duplicated. Sessions are defined but not started.");
          }
        },
      },
      "separator",
      { label: "Delete workspace…", danger: true, onSelect: () => void deleteWorkspaceFlow(id) },
    ]);

  const tooltip = `${name}${projectDir ? `\n${projectDir}` : ""}\n${sessions} session${sessions === 1 ? "" : "s"}${running ? ` · ${running} running` : ""}`;

  if (collapsed) {
    return (
      <button
        type="button"
        role="listitem"
        className={`rail-ws${active ? " is-active" : ""}`}
        title={tooltip}
        aria-label={name}
        aria-current={active || undefined}
        onClick={() => switchWorkspace(id)}
        onContextMenu={onContextMenu}
      >
        <span className="rail-initials">{initials(name)}</span>
        {running > 0 && <span className="dot is-ok rail-dot" />}
        <WorkspaceUnreadBadge workspaceId={id} compact />
      </button>
    );
  }

  return (
    <div
      role="listitem"
      className={`ws-row${active ? " is-active" : ""}`}
      aria-current={active || undefined}
      title={editing ? undefined : tooltip}
      onClick={() => !editing && switchWorkspace(id)}
      onDoubleClick={() => setEditing(true)}
      onContextMenu={onContextMenu}
      tabIndex={editing ? -1 : 0}
      onKeyDown={(e) => {
        if (editing) return;
        if (e.key === "Enter" || e.key === " ") {
          e.preventDefault();
          switchWorkspace(id);
        } else if (e.key === "F2") {
          e.preventDefault();
          setEditing(true);
        } else if (e.key === "ContextMenu" || (e.shiftKey && e.key === "F10")) {
          e.preventDefault();
          const r = e.currentTarget.getBoundingClientRect();
          onContextMenu({ clientX: r.left + 24, clientY: r.bottom, preventDefault: () => {} } as unknown as React.MouseEvent);
        }
      }}
    >
      <div className="ws-row-main">
        {editing ? (
          <input
            className="inline-edit"
            defaultValue={name}
            autoFocus
            spellCheck={false}
            onFocus={(e) => e.currentTarget.select()}
            onClick={(e) => e.stopPropagation()}
            onBlur={(e) => commitRename(e.currentTarget.value)}
            onKeyDown={(e) => {
              e.stopPropagation();
              if (e.key === "Enter") commitRename(e.currentTarget.value);
              else if (e.key === "Escape") setEditing(false);
            }}
          />
        ) : (
          <span className="ws-name">{name}</span>
        )}
        <span className="ws-meta">
          <WorkspaceUnreadBadge workspaceId={id} />
          {running > 0 && (
            <span className="ws-running" title={`${running} running`}>
              <span className="dot is-ok" />
              {running}
            </span>
          )}
          <span className="ws-count" title={`${sessions} session${sessions === 1 ? "" : "s"}`}>
            {sessions}
          </span>
        </span>
      </div>
      <div className="ws-dir mono">{projectDir ? basename(projectDir) : "no project folder"}</div>
    </div>
  );
});
