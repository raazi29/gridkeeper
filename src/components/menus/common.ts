// Building blocks shared by the context-menu builders (session / group / workspace / background).

import { openBrowserPane, promptOpenUrl } from "../../actions/browser";
import { bindingsByCommand, displayCombo } from "../../keybindings/combo";
import { launchOptions } from "../../lib/accounts";
import type { LayoutPreset } from "../../lib/types";
import { useApp } from "../../store/appStore";
import { useMission } from "../../store/mission";
import { useUi } from "../../store/uiStore";
import { quickLaunch } from "../QuickLaunch";
import { memoryPressureNow } from "../ResourceWarnings";
import type { MenuAction, MenuItem } from "../ui/Menu";

/** Display text of the shortcut bound to a command ("" when unbound). */
export function shortcutHint(commandId: string): string | undefined {
  const combo = bindingsByCommand(useApp.getState().persisted.settings.keybindings)[commandId];
  return combo ? displayCombo(combo) : undefined;
}

/** "New session ▸": one entry per agent / signed-in account (adds to `groupId`), plus the full dialog and formations. */
export function newSessionSubmenu(groupId: string | undefined, label = "New session"): MenuAction {
  const s = useApp.getState();
  const options = launchOptions(s.accounts, s.agents);
  const pressure = memoryPressureNow();
  const children: MenuItem[] = [];
  if (pressure) children.push({ label: pressure, disabled: true }, "separator");
  for (const o of options)
    children.push({
      label: o.hint ? `${o.label} · ${o.hint}` : o.label,
      disabled: o.disabled,
      onSelect: () => quickLaunch(o, groupId),
    });
  children.push(
    "separator",
    { label: "Browser", onSelect: () => void openBrowserPane({ groupId }) },
    { label: "Open URL…", hint: shortcutHint("browser.open"), onSelect: () => promptOpenUrl(groupId) },
    "separator",
    { label: "More options…", hint: shortcutHint("session.new"), onSelect: () => useUi.getState().openDialog({ kind: "newSession", groupId }) },
    formationItem(groupId),
  );
  return { label, children };
}

/**
 * Formation entry for a group: "here" only when the group is empty (the formation's first lane reuses
 * it); otherwise the formation creates its own groups, so the label does not promise "here".
 */
export function formationItem(groupId: string | undefined): MenuAction {
  let empty = false;
  if (groupId) for (const w of useApp.getState().persisted.workspaces) for (const g of w.groups) if (g.id === groupId) empty = g.sessionIds.length === 0;
  return {
    label: empty ? "Launch formation here…" : "Launch formation…",
    onSelect: () => useMission.getState().openFormation({ groupId: empty ? groupId : null }),
  };
}

/** "Split ▸": a new session in this group, laid out as columns or rows (New Session dialog). */
export function splitSubmenu(groupId: string | undefined): MenuAction {
  const open = (preset: LayoutPreset) => useUi.getState().openDialog({ kind: "newSession", groupId, preset });
  return {
    label: "Split",
    children: [
      { label: "New session in columns", hint: shortcutHint("session.splitColumns"), onSelect: () => open("columns") },
      { label: "New session in rows", hint: shortcutHint("session.splitRows"), onSelect: () => open("rows") },
    ],
  };
}

/** "Layout ▸": grid / columns / rows for a group (radio-style check marks). */
export function layoutSubmenu(groupId: string, current: LayoutPreset | undefined): MenuAction {
  const set = (preset: LayoutPreset) => useApp.getState().updateLayout(groupId, { preset, maximized: null });
  const item = (preset: LayoutPreset, label: string, cmd: string): MenuAction => ({
    label,
    checked: current === preset,
    hint: shortcutHint(cmd),
    onSelect: () => set(preset),
  });
  return {
    label: "Layout",
    children: [item("grid", "Grid", "layout.grid"), item("columns", "Columns", "layout.columns"), item("rows", "Rows", "layout.rows")],
  };
}
