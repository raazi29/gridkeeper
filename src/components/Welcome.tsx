// One-time welcome sheet: brand, a one-line pitch, theme + density, sounds / notifications and three
// tips. Shown once per machine (localStorage `gridkeeper.welcomed`); "Show welcome" in the palette
// reopens it. Every choice applies live and is an ordinary setting, so skipping loses nothing.

import { playSound } from "../audio/sounds";
import { getNotif, updateNotif, useNotif } from "../actions/notifyPrefs";
import { APP_NAME } from "../lib/brand";
import { osNotificationName } from "../lib/platform";
import type { UiDensity } from "../lib/types";
import { useApp } from "../store/appStore";
import { withSaber } from "../theme/saber";
import { THEMES, getTheme } from "../theme/themes";
import { IconBell, IconFleet } from "./AttentionBits";
import { useShortcut } from "./hooks";
import { AppMark, IconPlus, IconSearch } from "./icons";
import { ThemeCard } from "./ThemeCard";
import { Button } from "./ui/Button";
import { Segmented, Toggle } from "./ui/Field";
import { Modal } from "./ui/Modal";
import "../styles/experience.css";

const LS_WELCOMED = "gridkeeper.welcomed";

/** True when the sheet was already shown (or storage is unavailable, so it would nag every launch). */
export function hasBeenWelcomed(): boolean {
  try {
    return globalThis.localStorage?.getItem(LS_WELCOMED) === "1";
  } catch {
    return true;
  }
}

export function markWelcomed(): void {
  try {
    globalThis.localStorage?.setItem(LS_WELCOMED, "1");
  } catch {
    /* storage unavailable */
  }
}

export function WelcomeSheet({ onClose }: { onClose: () => void }) {
  const themeId = getTheme(useApp((s) => s.persisted.settings.theme)).id;
  const saberColor = useApp((s) => s.persisted.settings.saberColor);
  const density = useApp((s) => s.persisted.settings.uiDensity);
  const n = useNotif();
  const scPalette = useShortcut("view.palette");
  const scNew = useShortcut("session.new");
  const scFleet = useShortcut("view.fleet");

  const done = () => {
    markWelcomed();
    onClose();
  };

  return (
    <Modal
      title={`Welcome to ${APP_NAME}`}
      bare
      ariaLabel={`Welcome to ${APP_NAME}`}
      onClose={done}
      width={760}
      className="welcome"
      footer={
        <>
          <Button variant="ghost" onClick={done}>
            Skip
          </Button>
          <span className="welcome-foot-note">Everything here lives in Settings too.</span>
          <Button variant="primary" onClick={done} data-autofocus>
            Start
          </Button>
        </>
      }
    >
      <div className="welcome-hero">
        <span className="welcome-mark" aria-hidden="true">
          <AppMark size={34} />
        </span>
        <div className="welcome-hero-text">
          <h1 className="welcome-title">{APP_NAME}</h1>
          <p className="welcome-pitch">Every agent in one grid — Claude Code, Codex and shells side by side, and a keeper that tells you who needs you.</p>
        </div>
      </div>

      <section className="welcome-section">
        <div className="welcome-section-head">
          <span className="micro-label">Pick your look</span>
          <span className="welcome-hint">Applies instantly. Switch any time from the palette button or the theme chip in the status bar.</span>
        </div>
        <div className="welcome-themes" role="radiogroup" aria-label="Theme">
          {THEMES.map((t) => (
            <ThemeCard
              key={t.id}
              compact
              theme={withSaber(t, saberColor)}
              selected={t.id === themeId}
              tabIndex={t.id === themeId ? 0 : -1}
              onSelect={() => useApp.getState().updateSettings({ theme: t.id })}
            />
          ))}
        </div>
      </section>

      <section className="welcome-section welcome-prefs">
        <div className="welcome-pref">
          <span className="micro-label">Density</span>
          <Segmented<UiDensity>
            ariaLabel="Density"
            size="sm"
            value={density}
            onChange={(uiDensity) => useApp.getState().updateSettings({ uiDensity })}
            options={[
              { value: "compact", label: "Compact" },
              { value: "comfortable", label: "Comfortable" },
            ]}
          />
        </div>
        <div className="welcome-pref welcome-pref-toggles">
          <Toggle checked={n.enabled} onChange={(enabled) => updateNotif({ enabled })} label="Notify me when an agent needs me" hint={`${osNotificationName()} notification in the background, a toast with Jump in front.`} />
          <Toggle
            checked={n.sound}
            disabled={!n.enabled}
            onChange={(sound) => {
              updateNotif({ sound, soundSet: getNotif().soundSet === "none" ? "comm" : getNotif().soundSet });
              if (sound) playSound(getNotif().soundSet, "needsInput", getNotif().volume);
            }}
            label="Play sounds"
            hint="Quiet synthesized comm beeps. Pick a set and volume in Settings › Notifications."
          />
        </div>
      </section>

      <section className="welcome-tips" aria-label="Tips">
        <div className="welcome-tip">
          <span className="welcome-tip-icon" aria-hidden="true">
            <IconSearch size={15} />
          </span>
          <span className="welcome-tip-body">
            <b>Command palette</b>
            <span>Every action, session and theme.</span>
          </span>
          {scPalette && <kbd className="kbd">{scPalette}</kbd>}
        </div>
        <div className="welcome-tip">
          <span className="welcome-tip-icon" aria-hidden="true">
            <IconPlus size={15} />
          </span>
          <span className="welcome-tip-body">
            <b>+ New</b>
            <span>Start Claude, Codex or a shell in this workspace.</span>
          </span>
          {scNew && <kbd className="kbd">{scNew}</kbd>}
        </div>
        <div className="welcome-tip">
          <span className="welcome-tip-icon" aria-hidden="true">
            <IconFleet size={15} />
          </span>
          <span className="welcome-tip-body">
            <b>Fleet</b>
            <span>Every session at a glance; jump to whoever is waiting.</span>
          </span>
          {scFleet && <kbd className="kbd">{scFleet}</kbd>}
        </div>
      </section>
      <p className="welcome-note">
        <IconBell size={12} /> The bell in the status bar keeps every alert. Right-click it for Do not disturb; mute a noisy pane from its ⋯ menu.
      </p>
    </Modal>
  );
}
