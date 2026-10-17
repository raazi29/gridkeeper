// One-click session launch: "+ New" dropdown in the workspace header and the agent buttons shown in an
// empty group (one entry per signed-in account per agent, see lib/accounts.ts). Starts immediately in
// the active group using the workspace's project folder; anything more specific (worktree, args, count)
// goes through the full New Session dialog.

import { useMemo } from "react";
import { newSession } from "../actions/sessions";
import { launchOptions, type LaunchOption } from "../lib/accounts";
import { selectActiveGroup, selectActiveWorkspace, useApp } from "../store/appStore";
import { useUi } from "../store/uiStore";
import { useShortcut, withShortcut } from "./hooks";
import { IconPlus } from "./icons";
import { useContextMenu, type MenuItem } from "./ui/Menu";

export type { LaunchOption };

function useLaunchOptions(): LaunchOption[] {
  // Select the stable store arrays themselves (deriving new objects inside a selector re-renders forever).
  const accounts = useApp((s) => s.accounts);
  const agents = useApp((s) => s.agents);
  // One card per signed-in account per agent ("Codex · work"); a plain card when an agent has none.
  return useMemo(() => launchOptions(accounts, agents), [accounts, agents]);
}

/** Launch now, or fall back to the dialog when the workspace has no project folder yet. */
export function quickLaunch(o: LaunchOption) {
  const s = useApp.getState();
  const ws = selectActiveWorkspace(s);
  const group = selectActiveGroup(s);
  if (!ws || !group) return;
  if (!ws.projectDir) {
    useUi.getState().openDialog({ kind: "newSession", groupId: group.id });
    return;
  }
  newSession({ groupId: group.id, agent: o.agent, cwd: ws.projectDir, profileId: o.profileId ?? null, preset: o.preset ?? null });
}

function openFullDialog() {
  const group = selectActiveGroup(useApp.getState());
  useUi.getState().openDialog({ kind: "newSession", groupId: group?.id });
}

export function QuickLaunchButton() {
  const options = useLaunchOptions();
  const menu = useContextMenu();
  const scNew = useShortcut("session.new");
  const items: MenuItem[] = [
    ...options.map(
      (o): MenuItem => ({
        label: o.hint ? `${o.label} · ${o.hint}` : o.label,
        disabled: o.disabled,
        icon: o.color ? <span className="dot" style={{ background: o.color }} /> : undefined,
        onSelect: () => quickLaunch(o),
      }),
    ),
    "separator",
    { label: "More options…", hint: scNew ?? undefined, onSelect: openFullDialog },
  ];
  return (
    <>
      <button
        type="button"
        className="btn btn-sm btn-primary quick-launch"
        title={withShortcut("New session", scNew)}
        onClick={(e) => menu.openAt(e.currentTarget, items)}
      >
        <IconPlus size={13} />
        New
      </button>
      {menu.element}
    </>
  );
}

/** Large agent buttons for an empty group. */
export function QuickLaunchPanel() {
  const options = useLaunchOptions();
  const hasFolder = useApp((s) => !!selectActiveWorkspace(s)?.projectDir);
  return (
    <div className="quick-panel">
      <div className="quick-panel-grid">
        {options.map((o) => (
          <button key={o.key} type="button" className="quick-card" disabled={o.disabled} onClick={() => quickLaunch(o)}>
            <span className="quick-card-title">{o.label}</span>
            {o.hint && (
              <span className="quick-card-hint">
                <span className="dot" style={{ background: o.color }} />
                {o.hint}
              </span>
            )}
          </button>
        ))}
      </div>
      <button type="button" className="link-btn quick-panel-more" onClick={openFullDialog}>
        {hasFolder ? "More options (worktree, arguments, several at once)…" : "Choose a folder and options…"}
      </button>
    </div>
  );
}
