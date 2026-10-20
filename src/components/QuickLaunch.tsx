// One-click session launch: "+ New" dropdown in the workspace header and the agent buttons shown in an
// empty group (one entry per signed-in account per agent, see lib/accounts.ts). Starts immediately in
// the active group using the workspace's project folder; anything more specific (worktree, args, count)
// goes through the full New Session dialog.

import { runCommand } from "../actions/commands";
import { useMemo } from "react";
import { useT } from "../i18n";
import { newSession } from "../actions/sessions";
import { openBrowserPane, promptOpenUrl } from "../actions/browser";
import { launchOptions, type LaunchOption } from "../lib/accounts";
import { selectActiveGroup, selectActiveWorkspace, useApp } from "../store/appStore";
import { useUi } from "../store/uiStore";
import { useShortcut, withShortcut } from "./hooks";
import { IconPlus } from "./icons";
import { MemoryPressureNotice, memoryPressureNow } from "./ResourceWarnings";
import { useContextMenu, type MenuItem } from "./ui/Menu";

export type { LaunchOption };

function useLaunchOptions(): LaunchOption[] {
  // Select the stable store arrays themselves (deriving new objects inside a selector re-renders forever).
  const accounts = useApp((s) => s.accounts);
  const agents = useApp((s) => s.agents);
  // One card per signed-in account per agent ("Codex · work"); a plain card when an agent has none.
  return useMemo(() => launchOptions(accounts, agents), [accounts, agents]);
}

/** Workspace + group a launch goes to: the given group (any workspace), else the active one. */
function target(groupId?: string) {
  const s = useApp.getState();
  if (groupId)
    for (const w of s.persisted.workspaces) {
      const g = w.groups.find((x) => x.id === groupId);
      if (g) return { ws: w, group: g };
    }
  return { ws: selectActiveWorkspace(s), group: selectActiveGroup(s) };
}

/** Launch now, or fall back to the dialog when the workspace has no project folder yet. */
export function quickLaunch(o: LaunchOption, groupId?: string) {
  const { ws, group } = target(groupId);
  if (!ws || !group) return;
  if (!ws.projectDir) {
    useUi.getState().openDialog({ kind: "newSession", groupId: group.id });
    return;
  }
  newSession({ groupId: group.id, agent: o.agent, cwd: ws.projectDir, profileId: o.profileId ?? null, preset: o.preset ?? null });
}

function openFullDialog(groupId?: string) {
  useUi.getState().openDialog({ kind: "newSession", groupId: target(groupId).group?.id });
}

export interface QuickLaunchButtonProps {
  /** Target group; default = the active group. */
  groupId?: string;
  /** "primary" (header), "ghost" (tab row) or "icon" (pane header). */
  variant?: "primary" | "ghost" | "icon";
  label?: string;
}

export function QuickLaunchButton({ groupId, variant = "primary", label }: QuickLaunchButtonProps) {
  const t = useT();
  const options = useLaunchOptions();
  const menu = useContextMenu();
  const scNew = useShortcut("session.new");
  const scUrl = useShortcut("browser.open");
  const items: MenuItem[] = [
    ...options.map(
      (o): MenuItem => ({
        label: o.hint ? `${o.label} · ${o.hint}` : o.label,
        disabled: o.disabled,
        icon: o.color ? <span className="dot" style={{ background: o.color }} /> : undefined,
        onSelect: () => quickLaunch(o, groupId),
      }),
    ),
    "separator",
    { label: t("quickLaunch.browser"), onSelect: () => void openBrowserPane({ groupId: target(groupId).group?.id }) },
    { label: t("quickLaunch.openUrl"), hint: scUrl || undefined, onSelect: () => promptOpenUrl(target(groupId).group?.id) },
    "separator",
    { label: t("quickLaunch.moreOptions"), hint: scNew ?? undefined, onSelect: () => openFullDialog(groupId) },
    { label: t("quickLaunch.launchFormation"), onSelect: () => runCommand("formation.launch") },
  ];
  const open = (e: { currentTarget: HTMLElement; stopPropagation: () => void }) => {
    e.stopPropagation();
    // Non-blocking memory warning at the top of the menu (read when it opens).
    const pressure = memoryPressureNow();
    menu.openAt(e.currentTarget, pressure ? [{ label: pressure, disabled: true, onSelect: () => {} }, "separator", ...items] : items);
  };
  return (
    <>
      {variant === "icon" ? (
        <button type="button" className="pane-icon-btn" title={t("quickLaunch.addSessionTitle")} aria-label={t("quickLaunch.addSession")} onClick={open}>
          <IconPlus size={12} />
        </button>
      ) : (
        <button
          type="button"
          className={variant === "primary" ? "btn btn-sm btn-primary quick-launch" : "btn btn-sm btn-ghost quick-launch quick-launch--ghost"}
          title={withShortcut(t("quickLaunch.newSession"), scNew)}
          onClick={open}
        >
          <IconPlus size={13} />
          {label ?? t("quickLaunch.newSession")}
        </button>
      )}
      {menu.element}
    </>
  );
}

/** Large agent buttons for an empty group. */
export function QuickLaunchPanel() {
  const t = useT();
  const options = useLaunchOptions();
  const hasFolder = useApp((s) => !!selectActiveWorkspace(s)?.projectDir);
  return (
    <div className="quick-panel">
      <MemoryPressureNotice poll={false} />
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
        <button type="button" className="quick-card quick-card--browser" onClick={() => void openBrowserPane({})} title={t("quickLaunch.browserTitle")}>
          <span className="quick-card-title">{t("quickLaunch.browser")}</span>
          <span className="quick-card-hint">{t("quickLaunch.browserHint")}</span>
        </button>
        <button type="button" className="quick-card quick-card--browser" onClick={() => promptOpenUrl()}>
          <span className="quick-card-title">{t("quickLaunch.openUrl")}</span>
          <span className="quick-card-hint">localhost:5173, https://…</span>
        </button>
      </div>
      <button type="button" className="link-btn quick-panel-more" onClick={() => openFullDialog()}>
        {hasFolder ? t("quickLaunch.moreOptionsFull") : t("quickLaunch.chooseFolder")}
      </button>
    </div>
  );
}
