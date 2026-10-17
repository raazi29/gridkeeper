// Palette commands for themes, the welcome sheet and notification preferences. Kept out of
// commands.ts (one spread there) so the registry stays easy to scan.

import { selectActiveGroup, useApp } from "../store/appStore";
import { useUi } from "../store/uiStore";
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
];
