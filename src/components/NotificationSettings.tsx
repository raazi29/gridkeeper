// Settings section: attention notifications (persisted in settings.notifications).

import { APP_NAME } from "../lib/brand";
import { DEFAULT_SETTINGS, type NotificationSettings as Notif } from "../lib/types";
import { useApp } from "../store/appStore";
import { Toggle } from "./ui/Field";
import "../styles/attention.css";

function useNotif(): [Notif, (patch: Partial<Notif>) => void] {
  const v = useApp((s) => s.persisted.settings.notifications) ?? DEFAULT_SETTINGS.notifications;
  const set = (patch: Partial<Notif>) => {
    const cur = useApp.getState().persisted.settings.notifications ?? DEFAULT_SETTINGS.notifications;
    useApp.getState().updateSettings({ notifications: { ...cur, ...patch } });
  };
  return [v, set];
}

export function NotificationSettings() {
  const [n, set] = useNotif();
  return (
    <div className="form attn-settings">
      <Toggle
        checked={n.enabled}
        onChange={(enabled) => set({ enabled })}
        label="Notify me when a session needs attention"
        hint={`Windows notification while ${APP_NAME} is in the background (the taskbar button flashes too); an in-app toast with a Jump button when the session is off screen.`}
      />
      <Toggle
        checked={n.onBell}
        disabled={!n.enabled}
        onChange={(onBell) => set({ onBell })}
        label="When an agent asks for input"
        hint="Terminal bell, notification escapes (OSC 9 / 777 / 99) and Claude Code's “waiting for you” status."
      />
      <Toggle
        checked={n.onIdle}
        disabled={!n.enabled}
        onChange={(onIdle) => set({ onIdle })}
        label="When a session finishes working"
        hint="Output stopped for 4 s after at least 3 s of activity, or the program reported “done”."
      />
      <Toggle checked={n.sound} disabled={!n.enabled} onChange={(sound) => set({ sound })} label="Play a short sound" hint="A quiet in-app blip with each alert." />
      <p className="hint attn-settings-note">
        Agents only ring the bell when asked to: for Claude Code set <span className="mono">preferredNotifChannel</span> to{" "}
        <span className="mono">terminal_bell</span>; for Codex set <span className="mono">tui.notification_condition = "always"</span>.
        Without that, {APP_NAME} still notices when output goes quiet.
      </p>
    </div>
  );
}
