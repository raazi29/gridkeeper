// Items for the pane header's "Role ▸" menu (same shape as PaneHeader's local menu items).

import { focusSession } from "../../actions/commands";
import { t } from "../../i18n";
import { BUILTIN_ROLES, isBuiltinRole, roleInfo } from "../../lib/roles";
import type { SessionId } from "../../lib/types";
import { useApp } from "../../store/appStore";

export interface RoleMenuItem {
  label: string;
  onSelect: () => void;
  separatorBefore?: boolean;
}

export function roleMenuItems(id: SessionId, current: string | null): RoleMenuItem[] {
  const set = (role: string | null) => useApp.getState().updateSessionMeta(id, { role });
  const mark = (on: boolean) => (on ? "  ✓" : "");
  const items: RoleMenuItem[] = [{ label: `${t("roles.none")}${mark(!current)}`, onSelect: () => set(null) }];
  for (const r of BUILTIN_ROLES) {
    const info = roleInfo(r)!;
    items.push({ label: `${info.glyph}  ${info.label}${mark(current === r)}`, onSelect: () => set(r) });
  }
  items.push({
    label: current && !isBuiltinRole(current) ? t("roles.menu.customCurrent", { role: current }) : t("roles.menu.custom"),
    separatorBefore: true,
    onSelect: () => {
      focusSession(id);
      useApp.getState().updateSettings({ inspectorOpen: true });
    },
  });
  return items;
}
