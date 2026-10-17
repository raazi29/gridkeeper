// Terminal-group tabs row (~30px).

import { memo, useState } from "react";
import { useShallow } from "zustand/react/shallow";
import { activateGroup, deleteGroupFlow, runCommand } from "../actions/commands";
import { isLive, selectActiveGroup, selectActiveWorkspace, useApp, type AppStore } from "../store/appStore";
import { GroupUnreadBadge } from "./AttentionBits";
import { useShortcut, withShortcut } from "./hooks";
import { IconMaximize, IconPlus } from "./icons";
import { useContextMenu } from "./ui/Menu";

function findGroup(s: AppStore, groupId: string) {
  for (const w of s.persisted.workspaces) for (const g of w.groups) if (g.id === groupId) return g;
  return undefined;
}

export function GroupTabs() {
  const wsId = useApp((s) => selectActiveWorkspace(s)?.id);
  const groupIds = useApp(useShallow((s) => selectActiveWorkspace(s)?.groups.map((g) => g.id) ?? []));
  const activeGroupId = useApp((s) => selectActiveGroup(s)?.id ?? null);
  const maximizedName = useApp((s) => {
    const g = activeGroupId ? findGroup(s, activeGroupId) : undefined;
    const m = g?.layout.maximized;
    return m ? (s.persisted.sessions.find((x) => x.id === m)?.name ?? null) : null;
  });
  const scGroup = useShortcut("group.new");
  const scMax = useShortcut("session.maximize");
  const menu = useContextMenu();
  if (!wsId) return null;

  return (
    <div className="group-tabs" role="tablist" aria-label="Terminal groups">
      {groupIds.map((gid) => (
        <GroupTab key={gid} workspaceId={wsId} groupId={gid} active={gid === activeGroupId} canDelete={groupIds.length > 1} openMenu={menu.open} />
      ))}
      <button type="button" className="tab-add" aria-label="New group" title={withShortcut("New group", scGroup)} onClick={() => runCommand("group.new")}>
        <IconPlus size={13} />
      </button>
      <div className="group-tabs-spacer" />
      {maximizedName && (
        <button
          type="button"
          className="chip chip-accent"
          title={withShortcut("Restore layout", scMax)}
          onClick={() => activeGroupId && useApp.getState().updateLayout(activeGroupId, { maximized: null })}
        >
          <IconMaximize size={11} />
          <span>{maximizedName}</span>
        </button>
      )}
      {menu.element}
    </div>
  );
}

const GroupTab = memo(function GroupTab({
  workspaceId,
  groupId,
  active,
  canDelete,
  openMenu,
}: {
  workspaceId: string;
  groupId: string;
  active: boolean;
  canDelete: boolean;
  openMenu: ReturnType<typeof useContextMenu>["open"];
}) {
  const name = useApp((s) => findGroup(s, groupId)?.name ?? "");
  const count = useApp((s) => findGroup(s, groupId)?.sessionIds.length ?? 0);
  const running = useApp((s) => {
    const g = findGroup(s, groupId);
    let n = 0;
    if (g) for (const id of g.sessionIds) if (isLive(s.runtime[id])) n++;
    return n;
  });
  const [editing, setEditing] = useState(false);

  const commit = (v: string) => {
    setEditing(false);
    const t = v.trim();
    if (t && t !== name) useApp.getState().renameGroup(groupId, t);
  };

  const showMenu = (e: { clientX: number; clientY: number; preventDefault?: () => void }) =>
    openMenu(e, [
      { label: "Rename", onSelect: () => setEditing(true) },
      "separator",
      { label: "Delete group…", danger: true, disabled: !canDelete, onSelect: () => void deleteGroupFlow(groupId) },
    ]);

  return (
    <div
      role="tab"
      aria-selected={active}
      tabIndex={active ? 0 : -1}
      className={`group-tab${active ? " is-active" : ""}`}
      title={editing ? undefined : `${name} — ${count} session${count === 1 ? "" : "s"}${running ? `, ${running} running` : ""}\nDouble-click to rename`}
      onClick={() => !editing && activateGroup(workspaceId, groupId)}
      onDoubleClick={() => setEditing(true)}
      onContextMenu={showMenu}
      onKeyDown={(e) => {
        if (editing) return;
        if (e.key === "F2") {
          e.preventDefault();
          setEditing(true);
        } else if (e.key === "ContextMenu") {
          e.preventDefault();
          const r = e.currentTarget.getBoundingClientRect();
          showMenu({ clientX: r.left, clientY: r.bottom + 2 });
        } else if (e.key === "ArrowRight" || e.key === "ArrowLeft") {
          const sib = (e.key === "ArrowRight" ? e.currentTarget.nextElementSibling : e.currentTarget.previousElementSibling) as HTMLElement | null;
          if (sib?.getAttribute("role") === "tab") {
            e.preventDefault();
            sib.click();
            sib.focus();
          }
        }
      }}
    >
      {running > 0 && <span className="dot is-ok" aria-hidden="true" />}
      {editing ? (
        <input
          className="inline-edit"
          defaultValue={name}
          autoFocus
          spellCheck={false}
          size={Math.max(6, name.length + 1)}
          onFocus={(e) => e.currentTarget.select()}
          onClick={(e) => e.stopPropagation()}
          onBlur={(e) => commit(e.currentTarget.value)}
          onKeyDown={(e) => {
            e.stopPropagation();
            if (e.key === "Enter") commit(e.currentTarget.value);
            else if (e.key === "Escape") setEditing(false);
          }}
        />
      ) : (
        <span className="group-tab-name">{name}</span>
      )}
      <GroupUnreadBadge groupId={groupId} />
      <span className="group-tab-count">{count}</span>
    </div>
  );
});
