// Palette commands for themes, saber effects, the welcome sheet and notification preferences. Kept out of
// commands.ts (one spread there) so the registry stays easy to scan.

import { igniteFocused } from "../layout/saberBlade";
import { selectActiveGroup, useApp } from "../store/appStore";
import { useUi } from "../store/uiStore";
import { currentSaberLevel } from "../theme/applyTheme";
import { getSaber } from "../theme/saber";
import { nextSaberColor } from "../theme/saberFx";
import { getTheme } from "../theme/themes";
import type { Command } from "./commands";
import { notify } from "./notify";
import { toggleDnd, toggleSessionMute } from "./notifyPrefs";

function focusedInActiveGroup(): string | null {
  const s = useApp.getState();
  const g = selectActiveGroup(s);
  const f = s.focusedSessionId;
  return g && f && g.sessionIds.includes(f) ? f : null;
}

/** Open the quick theme switcher from whichever entry point is on screen (status bar chip first). */
function openThemeSwitcher() {
  const el = document.querySelector<HTMLElement>("[data-theme-chip]") ?? document.querySelector<HTMLElement>("[data-theme-switcher]");
  if (el) el.click();
  else useUi.getState().openDialog({ kind: "settings", section: "appearance" });
}

export const EXPERIENCE_COMMANDS: Command[] = [
  { id: "theme.pick", title: "Choose theme…", category: "Theme", run: () => void setTimeout(openThemeSwitcher, 80) }, // after the palette has closed and restored focus
  { id: "view.welcome", title: "Show welcome", category: "View", run: () => useUi.getState().openDialog({ kind: "welcome" }) },
  { id: "notifications.dnd", title: "Toggle do not disturb", category: "View", run: () => toggleDnd() },
  {
    id: "notifications.muteSession",
    title: "Mute / unmute notifications for this session",
    category: "Session",
    run: () => {
      const id = focusedInActiveGroup();
      if (id) toggleSessionMute(id);
      else notify("info", "No session focused in this group");
    },
  },
  { id: "notifications.settings", title: "Notification settings…", category: "View", run: () => useUi.getState().openDialog({ kind: "settings", section: "notifications" }) },
  {
    id: "saber.ignite",
    title: "Saber: ignite focused pane",
    category: "Theme",
    // After the palette has closed and focus is back on the pane.
    run: () =>
      void setTimeout(() => {
        if (igniteFocused()) return;
        if (currentSaberLevel() === "off") notify("info", "Saber effects are off (Settings › Appearance › Saber)");
        else notify("info", "No pane focused");
      }, 80),
  },
  {
    id: "saber.cycleColor",
    title: "Saber: cycle colour",
    category: "Theme",
    run: () => {
      const s = useApp.getState().persisted.settings;
      const next = nextSaberColor(s.saberColor, s.saberBladeFromTheme !== false && !getTheme(s.theme).saber);
      useApp.getState().updateSettings({ saberColor: next, saberBladeFromTheme: false });
      notify("info", `Blade colour: ${getSaber(next).name}`);
      setTimeout(() => igniteFocused(), 80);
    },
  },
];
