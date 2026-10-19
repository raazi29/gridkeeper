// Appearance extras: per-theme effect toggles (glow, holo band, scanlines), the saber effects row
// (level, blade colour, sound, test) and the hyperspace jump transition. Shown under the theme grid in Settings › Appearance.

import { useState } from "react";
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

/** Follow the theme accent (non-saber themes only). */
const THEME_SWATCH: SwatchOption = { id: "theme", name: "Theme", blade: "var(--accent)", core: "color-mix(in srgb, var(--accent) 30%, #ffffff)" };

/**
 * Blade colour presets. `withTheme` adds a leading "Theme" swatch (blade follows the theme accent) for
 * themes without their own blade. Picking a preset applies it to every theme.
 */
export function SaberPicker({ size = "md", withTheme = false }: { size?: "sm" | "md"; withTheme?: boolean }) {
  const saberColor = useApp((s) => s.persisted.settings.saberColor);
  const fromTheme = useApp((s) => s.persisted.settings.saberBladeFromTheme !== false);
  const options: SwatchOption[] = [
    ...(withTheme ? [THEME_SWATCH] : []),
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
      aria-label="Blade colour"
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
          title={p.id === THEME_SWATCH.id ? "Blade follows the theme accent" : `${p.name} blade`}
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
  const mode = useApp((s) => s.persisted.settings.saberEffects ?? "auto");
  const sound = useApp((s) => s.persisted.settings.saberSound ?? false);
  const reduced = useApp((s) => prefersReducedMotion(s.persisted.settings));
  const level = resolveSaberLevel(mode, theme, reduced);
  const [preview, setPreview] = useState(0);
  const now = reduced ? "Off while reduced motion is on." : level === "off" ? "Off." : `Now: ${level === "full" ? "Full" : "Subtle"}${mode === "auto" ? ` (${theme.name})` : ""}.`;
  return (
    <>
      <Field
        label="Saber effects"
        hint={`A blade ignites along a pane's top edge when you focus it or a session starts, and retracts when it exits. Full keeps the focused pane's blade lit, turns dividers into blades and crosses two blades by the bell when two sessions in a group finish together. Auto = Full with Saber Duel, Subtle elsewhere. ${now}`}
      >
        <Segmented<SaberEffectsMode>
          ariaLabel="Saber effects"
          value={mode}
          onChange={(v) => useApp.getState().updateSettings({ saberEffects: v })}
          options={[
            { value: "auto", label: "Auto", title: "Full with Saber Duel, Subtle elsewhere" },
            { value: "subtle", label: "Subtle", title: "Ignite / retract only" },
            { value: "full", label: "Full", title: "Lit focus blade, blade dividers, duel" },
            { value: "off", label: "Off" },
          ]}
        />
      </Field>
      <Field
        label="Blade colour"
        hint={theme.saber ? "The blade that frames the focused pane, and the accent everywhere else." : "Theme = this theme's accent. A colour you pick applies to every theme."}
      >
        <SaberPicker withTheme={!theme.saber} />
      </Field>
      <Toggle
        checked={sound}
        disabled={level === "off"}
        onChange={(v) => useApp.getState().updateSettings({ saberSound: v })}
        label="Blade sound"
        hint="A short synthesized ignite / retract when you focus a pane or start a session (never on output; at most one per 0.6 s). Uses the alert volume."
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
          Test ignite
        </Button>
      </div>
    </>
  );
}

/** Controls for whatever the current theme offers. Renders nothing for plain themes. */
export function ThemeEffects({ theme }: { theme: Theme }) {
  const glow = useEffectPrefs((s) => s.glow);
  const holo = useEffectPrefs((s) => s.holo);
  const scanlines = useUi((s) => s.scanlines);
  const reduceMotion = useApp((s) => s.persisted.settings.reduceMotion);
  const fx = theme.effects ?? {};
  if (!fx.glow && !fx.holo && !fx.scanlines) return null;
  return (
    <div className="theme-effects form" aria-label={`${theme.name} effects`}>
      {fx.glow && (
        <Toggle
          checked={glow}
          onChange={(v) => useEffectPrefs.getState().set({ glow: v })}
          label={theme.saber ? "Blade glow" : "Glow"}
          hint={theme.saber ? "Soft light around the focused pane's blade frame and status lamps." : "Status lamps and the focus line bloom slightly."}
        />
      )}
      {fx.holo && (
        <Toggle
          checked={holo}
          onChange={(v) => useEffectPrefs.getState().set({ holo: v })}
          disabled={reduceMotion}
          label="Holo scan band"
          hint="A faint band sweeps the focused pane's header now and then. GPU-composited; pauses when the window is in the background."
        />
      )}
      {fx.scanlines && (
        <Toggle checked={scanlines} onChange={(v) => useUi.getState().setScanlines(v)} disabled={reduceMotion} label="CRT scanlines" hint={`Static scanline overlay on panes (${theme.name} only).`} />
      )}
    </div>
  );
}

export function HyperspaceToggle() {
  const mode = useApp((s) => s.persisted.settings.hyperspaceTransition ?? "auto");
  return (
    <Field label="Hyperspace jump" hint="A 0.2 s star-streak flash when you switch workspaces. Never blocks input; off under reduced motion.">
      <Segmented<HyperspaceMode>
        ariaLabel="Hyperspace jump"
        value={mode}
        onChange={(v) => useApp.getState().updateSettings({ hyperspaceTransition: v })}
        options={[
          { value: "auto", label: "With Hyperspace theme", title: "Only while the Hyperspace theme is active" },
          { value: "on", label: "Always" },
          { value: "off", label: "Off" },
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
