// Appearance extras: per-theme effect toggles (glow, holo band, scanlines), the saber effects row
// (level, blade colour, sound, test) and the hyperspace jump transition. Shown under the theme grid in Settings › Appearance.

import { useState } from "react";
import { useT } from "../i18n";
import { igniteFocused, saberCue } from "../layout/saberBlade";
import type { HyperspaceMode, SaberEffectsMode } from "../lib/types";
import { useApp } from "../store/appStore";
import { useUi } from "../store/uiStore";
import { prefersReducedMotion } from "../theme/applyTheme";
import { useEffectPrefs } from "../theme/effectPrefs";
import { SABER_PRESETS, getSaber } from "../theme/saber";
import { resolveSaberLevel } from "../theme/saberFx";
import type { Theme } from "../theme/themes";
import { Button } from "./ui/Button";
import { Field, Segmented, Toggle } from "./ui/Field";
import "../styles/experience.css";

interface SwatchOption {
  id: string;
  name: string;
  blade: string;
  core: string;
}

/** Follow the theme accent (non-saber themes only). The name is translated at render time. */
const THEME_SWATCH: SwatchOption = { id: "theme", name: "", blade: "var(--accent)", core: "color-mix(in srgb, var(--accent) 30%, #ffffff)" };

/**
 * Blade colour presets. `withTheme` adds a leading "Theme" swatch (blade follows the theme accent) for
 * themes without their own blade. Picking a preset applies it to every theme.
 */
export function SaberPicker({ size = "md", withTheme = false }: { size?: "sm" | "md"; withTheme?: boolean }) {
  const t = useT();
  const saberColor = useApp((s) => s.persisted.settings.saberColor);
  const fromTheme = useApp((s) => s.persisted.settings.saberBladeFromTheme !== false);
  const options: SwatchOption[] = [
    ...(withTheme ? [{ ...THEME_SWATCH, name: t("appearance.swatchTheme") }] : []),
    ...SABER_PRESETS.map((p) => ({ id: p.id, name: p.name, blade: p.accent, core: p.core })),
  ];
  const current = withTheme && fromTheme ? THEME_SWATCH.id : getSaber(saberColor).id;
  const pick = (id: string) =>
    useApp.getState().updateSettings(id === THEME_SWATCH.id ? { saberBladeFromTheme: true } : { saberColor: id, saberBladeFromTheme: false });
  const move = (dir: 1 | -1) => {
    const i = options.findIndex((p) => p.id === current);
    pick(options[(i + dir + options.length) % options.length].id);
  };
  return (
    <div
      className={`saber-swatches saber-swatches--${size}`}
      role="radiogroup"
      aria-label={t("appearance.bladeColour")}
      onKeyDown={(e) => {
        if (e.key === "ArrowRight" || e.key === "ArrowDown") {
          e.preventDefault();
          move(1);
        } else if (e.key === "ArrowLeft" || e.key === "ArrowUp") {
          e.preventDefault();
          move(-1);
        }
      }}
    >
      {options.map((p) => (
        <button
          key={p.id}
          type="button"
          role="radio"
          aria-checked={p.id === current}
          tabIndex={p.id === current ? 0 : -1}
          className={`saber-swatch${p.id === current ? " is-selected" : ""}`}
          style={{ ["--blade" as string]: p.blade, ["--blade-core" as string]: p.core }}
          title={p.id === THEME_SWATCH.id ? t("appearance.swatchThemeTitle") : t("appearance.swatchTitle", { name: p.name })}
          onClick={() => pick(p.id)}
        >
          <span className="saber-swatch-beam" aria-hidden="true" />
          <span className="saber-swatch-name">{p.name}</span>
        </button>
      ))}
    </div>
  );
}

/** Settings › Appearance › Saber: effect level, blade colour, sound and a test ignition (every theme). */
export function SaberSettings({ theme }: { theme: Theme }) {
  const t = useT();
  const mode = useApp((s) => s.persisted.settings.saberEffects ?? "auto");
  const sound = useApp((s) => s.persisted.settings.saberSound ?? false);
  const reduced = useApp((s) => prefersReducedMotion(s.persisted.settings));
  const level = resolveSaberLevel(mode, theme, reduced);
  const [preview, setPreview] = useState(0);
  const now = reduced
    ? t("appearance.saberNowReduced")
    : level === "off"
      ? t("appearance.saberNowOff")
      : mode === "auto"
        ? level === "full"
          ? t("appearance.saberNowFullAuto", { theme: theme.name })
          : t("appearance.saberNowSubtleAuto", { theme: theme.name })
        : level === "full"
          ? t("appearance.saberNowFull")
          : t("appearance.saberNowSubtle");
  return (
    <>
      <Field label={t("appearance.saberEffects")} hint={t("appearance.saberEffectsHint", { now })}>
        <Segmented<SaberEffectsMode>
          ariaLabel={t("appearance.saberEffects")}
          value={mode}
          onChange={(v) => useApp.getState().updateSettings({ saberEffects: v })}
          options={[
            { value: "auto", label: t("appearance.saberAuto"), title: t("appearance.saberAutoTitle") },
            { value: "subtle", label: t("appearance.saberSubtle"), title: t("appearance.saberSubtleTitle") },
            { value: "full", label: t("appearance.saberFull"), title: t("appearance.saberFullTitle") },
            { value: "off", label: t("common.off") },
          ]}
        />
      </Field>
      <Field label={t("appearance.bladeColour")} hint={theme.saber ? t("appearance.bladeColourHintSaber") : t("appearance.bladeColourHint")}>
        <SaberPicker withTheme={!theme.saber} />
      </Field>
      <Toggle
        checked={sound}
        disabled={level === "off"}
        onChange={(v) => useApp.getState().updateSettings({ saberSound: v })}
        label={t("appearance.bladeSound")}
        hint={t("appearance.bladeSoundHint")}
      />
      <div className="saber-test">
        <span className="saber-preview" aria-hidden="true">
          <span key={preview} className="saber-preview-blade" data-anim={preview ? "ignite" : undefined} />
        </span>
        <Button
          size="sm"
          onClick={() => {
            setPreview((n) => n + 1);
            if (!igniteFocused()) saberCue("ignite");
          }}
        >
          {t("appearance.testIgnite")}
        </Button>
      </div>
    </>
  );
}

/** Controls for whatever the current theme offers. Renders nothing for plain themes. */
export function ThemeEffects({ theme }: { theme: Theme }) {
  const t = useT();
  const glow = useEffectPrefs((s) => s.glow);
  const holo = useEffectPrefs((s) => s.holo);
  const scanlines = useUi((s) => s.scanlines);
  const reduceMotion = useApp((s) => s.persisted.settings.reduceMotion);
  const fx = theme.effects ?? {};
  if (!fx.glow && !fx.holo && !fx.scanlines) return null;
  return (
    <div className="theme-effects form" aria-label={t("appearance.themeEffectsAria", { theme: theme.name })}>
      {fx.glow && (
        <Toggle
          checked={glow}
          onChange={(v) => useEffectPrefs.getState().set({ glow: v })}
          label={theme.saber ? t("appearance.bladeGlow") : t("appearance.glow")}
          hint={theme.saber ? t("appearance.bladeGlowHint") : t("appearance.glowHint")}
        />
      )}
      {fx.holo && (
        <Toggle
          checked={holo}
          onChange={(v) => useEffectPrefs.getState().set({ holo: v })}
          disabled={reduceMotion}
          label={t("appearance.holo")}
          hint={t("appearance.holoHint")}
        />
      )}
      {fx.scanlines && (
        <Toggle
          checked={scanlines}
          onChange={(v) => useUi.getState().setScanlines(v)}
          disabled={reduceMotion}
          label={t("appearance.scanlines")}
          hint={t("appearance.scanlinesHint", { theme: theme.name })}
        />
      )}
    </div>
  );
}

export function HyperspaceToggle() {
  const t = useT();
  const mode = useApp((s) => s.persisted.settings.hyperspaceTransition ?? "auto");
  return (
    <Field label={t("appearance.hyperspace")} hint={t("appearance.hyperspaceHint")}>
      <Segmented<HyperspaceMode>
        ariaLabel={t("appearance.hyperspace")}
        value={mode}
        onChange={(v) => useApp.getState().updateSettings({ hyperspaceTransition: v })}
        options={[
          { value: "auto", label: t("appearance.hyperspaceAuto"), title: t("appearance.hyperspaceAutoTitle") },
          { value: "on", label: t("appearance.hyperspaceAlways") },
          { value: "off", label: t("common.off") },
        ]}
      />
    </Field>
  );
}

export function MissionFxToggle() {
  const on = useEffectPrefs((s) => s.mission);
  const reduceMotion = useApp((s) => s.persisted.settings.reduceMotion);
  return (
    <Toggle
      checked={on}
      onChange={(v) => useEffectPrefs.getState().set({ mission: v })}
      disabled={reduceMotion}
      label="Mission Control effects"
      hint="Gold hyperspace entry, energy on the connectors, lit borders on working agents and the briefing crawl. Pauses when the window is in the background; off under reduced motion."
    />
  );
}
