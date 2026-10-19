// Left sidebar: app mark, workspace list, footer buttons. Collapses to a 48px rail of initials.

import { memo, useState } from "react";
import { useShallow } from "zustand/react/shallow";
import { deleteWorkspaceFlow, switchWorkspace } from "../actions/commands";
import { notify } from "../actions/notify";
import { isLive, selectActiveWorkspace, useApp, type AppStore } from "../store/appStore";
import { useUi } from "../store/uiStore";
import { WorkspaceUnreadBadge } from "./AttentionBits";
import { APP_NAME } from "../lib/brand";
import { useT } from "../i18n";
import { useShortcut, withShortcut } from "./hooks";
import { AppMark, IconActivity, IconChevronLeft, IconChevronRight, IconPlus, IconSettings, IconUsers } from "./icons";
import { workspaceExtraItems } from "./menus/containerMenus";
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
  const t = useT();
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
    <aside className={`sidebar${collapsed ? " is-collapsed" : ""}`} aria-label={t("shell.sidebar.workspaces")}>
      <div className="sidebar-top">
        <div className="app-mark" title={APP_NAME}>
          <AppMark size={18} />
          {!collapsed && <span className="wordmark">{APP_NAME}</span>}
        </div>
        {!collapsed && (
          <button type="button" className="icon-btn icon-btn-sm" aria-label={t("shell.sidebar.collapse")} title={withShortcut(t("shell.sidebar.collapse"), scSidebar)} onClick={toggle}>
            <IconChevronLeft size={14} />
          </button>
        )}
      </div>

      {!collapsed && (
        <div className="sidebar-section-head">
          <span>{t("shell.sidebar.workspaces")}</span>
          <button type="button" className="icon-btn icon-btn-sm" aria-label={t("shell.sidebar.newWorkspace")} title={withShortcut(t("shell.sidebar.newWorkspace"), scNewWs)} onClick={() => ui().openDialog({ kind: "newWorkspace" })}>
            <IconPlus size={14} />
          </button>
        </div>
      )}

      <nav className="ws-list" role="list">
        {ids.map((id) => (
          <WorkspaceRow key={id} id={id} active={id === activeId} collapsed={collapsed} openMenu={menu.open} />
        ))}
        {collapsed ? (
          <button type="button" className="rail-btn" aria-label={t("shell.sidebar.newWorkspace")} title={withShortcut(t("shell.sidebar.newWorkspace"), scNewWs)} onClick={() => ui().openDialog({ kind: "newWorkspace" })}>
            <IconPlus size={14} />
          </button>
        ) : (
          <button type="button" className="ws-new" onClick={() => ui().openDialog({ kind: "newWorkspace" })} title={withShortcut(t("shell.sidebar.newWorkspace"), scNewWs)}>
            <IconPlus size={13} />
            <span>{t("shell.sidebar.newWorkspace")}</span>
          </button>
        )}
      </nav>

      <div className="sidebar-footer">
        <FooterButton collapsed={collapsed} label={t("shell.sidebar.accounts")} title={t("shell.sidebar.accountsTitle")} onClick={() => ui().openDialog({ kind: "profiles" })} icon={<IconUsers size={15} />} />
        <FooterButton collapsed={collapsed} label={t("shell.sidebar.settings")} title={withShortcut(t("shell.sidebar.settings"), scSettings)} onClick={() => ui().openDialog({ kind: "settings" })} icon={<IconSettings size={15} />} />
        <FooterButton collapsed={collapsed} label={t("shell.sidebar.diagnostics")} title={withShortcut(t("shell.sidebar.diagnostics"), scDiag)} onClick={() => ui().openDialog({ kind: "diagnostics" })} icon={<IconActivity size={15} />} />
        {collapsed && (
          <button type="button" className="rail-btn" aria-label={t("shell.sidebar.expand")} title={withShortcut(t("shell.sidebar.expand"), scSidebar)} onClick={toggle}>
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
  const t = useT();
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
    const dir = await pickFolder(t("shell.chooseProjectFolder"), projectDir);
    if (dir) {
      useApp.getState().updateWorkspace(id, { projectDir: dir });
      notify("info", t("shell.sidebar.folderSet", { dir }));
    }
  };

  const onContextMenu = (e: React.MouseEvent) =>
    openMenu(e, [
      { label: t("common.rename"), onSelect: () => setEditing(true) },
      { label: t("menu.workspace.changeFolder"), onSelect: () => void changeFolder() },
      {
        label: t("menu.workspace.duplicate"),
        hint: t("menu.workspace.duplicateHint"),
        onSelect: () => {
          const newId = useApp.getState().duplicateWorkspace(id);
          if (newId) {
            switchWorkspace(newId);
            notify("info", t("shell.sidebar.duplicated"));
          }
        },
      },
      "separator",
      ...workspaceExtraItems(id),
      "separator",
      { label: t("menu.workspace.delete"), danger: true, onSelect: () => void deleteWorkspaceFlow(id) },
    ]);

  const counts = running ? t("shell.sidebar.sessionCountRunning", { count: sessions, running }) : t("shell.sidebar.sessionCount", { count: sessions });
  const tooltip = `${name}${projectDir ? `\n${projectDir}` : ""}\n${counts}`;

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
            <span className="ws-running" title={t("shell.sidebar.running", { count: running })}>
              <span className="dot is-ok" />
              {running}
            </span>
          )}
          <span className="ws-count" title={t("shell.sidebar.sessionCount", { count: sessions })}>
            {sessions}
          </span>
        </span>
      </div>
      <div className="ws-dir mono">{projectDir ? basename(projectDir) : t("shell.sidebar.noProjectFolder")}</div>
    </div>
  );
});
