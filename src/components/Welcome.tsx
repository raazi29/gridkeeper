// One-time welcome sheet: brand, a one-line pitch, theme + density, sounds / notifications and three
// tips. Shown once per machine (localStorage `gridkeeper.welcomed`); "Show welcome" in the palette
// reopens it. Every choice applies live and is an ordinary setting, so skipping loses nothing.

import { playSound } from "../audio/sounds";
import { getNotif, updateNotif, useNotif } from "../actions/notifyPrefs";
import { useT } from "../i18n";
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
  const t = useT();
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
      title={t("welcome.title", { app: APP_NAME })}
      bare
      ariaLabel={t("welcome.title", { app: APP_NAME })}
      onClose={done}
      width={760}
      className="welcome"
      footer={
        <>
          <Button variant="ghost" onClick={done}>
            {t("welcome.skip")}
          </Button>
          <span className="welcome-foot-note">{t("welcome.footNote")}</span>
          <Button variant="primary" onClick={done} data-autofocus>
            {t("welcome.start")}
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
          <p className="welcome-pitch">{t("welcome.pitch")}</p>
        </div>
      </div>

      <section className="welcome-section">
        <div className="welcome-section-head">
          <span className="micro-label">{t("welcome.pickLook")}</span>
          <span className="welcome-hint">{t("welcome.pickLookHint")}</span>
        </div>
        <div className="welcome-themes" role="radiogroup" aria-label={t("settings.appearance.theme")}>
          {THEMES.map((th) => (
            <ThemeCard
              key={th.id}
              compact
              theme={withSaber(th, saberColor)}
              selected={th.id === themeId}
              tabIndex={th.id === themeId ? 0 : -1}
              onSelect={() => useApp.getState().updateSettings({ theme: th.id })}
            />
          ))}
        </div>
      </section>

      <section className="welcome-section welcome-prefs">
        <div className="welcome-pref">
          <span className="micro-label">{t("settings.appearance.density")}</span>
          <Segmented<UiDensity>
            ariaLabel={t("settings.appearance.density")}
            size="sm"
            value={density}
            onChange={(uiDensity) => useApp.getState().updateSettings({ uiDensity })}
            options={[
              { value: "compact", label: t("settings.appearance.densityCompact") },
              { value: "comfortable", label: t("settings.appearance.densityComfortable") },
            ]}
          />
        </div>
        <div className="welcome-pref welcome-pref-toggles">
          <Toggle
            checked={n.enabled}
            onChange={(enabled) => updateNotif({ enabled })}
            label={t("welcome.notify")}
            hint={t("welcome.notifyHint", { system: osNotificationName() })}
          />
          <Toggle
            checked={n.sound}
            disabled={!n.enabled}
            onChange={(sound) => {
              updateNotif({ sound, soundSet: getNotif().soundSet === "none" ? "comm" : getNotif().soundSet });
              if (sound) playSound(getNotif().soundSet, "needsInput", getNotif().volume);
            }}
            label={t("welcome.sounds")}
            hint={t("welcome.soundsHint")}
          />
        </div>
      </section>

      <section className="welcome-tips" aria-label={t("welcome.tips")}>
        <div className="welcome-tip">
          <span className="welcome-tip-icon" aria-hidden="true">
            <IconSearch size={15} />
          </span>
          <span className="welcome-tip-body">
            <b>{t("palette.title")}</b>
            <span>{t("welcome.tipPalette")}</span>
          </span>
          {scPalette && <kbd className="kbd">{scPalette}</kbd>}
        </div>
        <div className="welcome-tip">
          <span className="welcome-tip-icon" aria-hidden="true">
            <IconPlus size={15} />
          </span>
          <span className="welcome-tip-body">
            <b>{t("welcome.tipNewTitle")}</b>
            <span>{t("welcome.tipNew")}</span>
          </span>
          {scNew && <kbd className="kbd">{scNew}</kbd>}
        </div>
        <div className="welcome-tip">
          <span className="welcome-tip-icon" aria-hidden="true">
            <IconFleet size={15} />
          </span>
          <span className="welcome-tip-body">
            <b>{t("welcome.tipFleetTitle")}</b>
            <span>{t("welcome.tipFleet")}</span>
          </span>
          {scFleet && <kbd className="kbd">{scFleet}</kbd>}
        </div>
      </section>
      <p className="welcome-note">
        <IconBell size={12} /> {t("welcome.note")}
      </p>
    </Modal>
  );
}
