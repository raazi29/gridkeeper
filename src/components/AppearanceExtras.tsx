// Appearance extras: per-theme effect toggles (glow, holo band, scanlines), the Saber Duel blade colour
// and the hyperspace jump transition. Shown under the theme grid in Settings › Appearance.

import type { HyperspaceMode } from "../lib/types";
import { useApp } from "../store/appStore";
import { useUi } from "../store/uiStore";
import { useEffectPrefs } from "../theme/effectPrefs";
import { SABER_PRESETS, getSaber } from "../theme/saber";
import type { Theme } from "../theme/themes";
import { Field, Segmented, Toggle } from "./ui/Field";
import "../styles/experience.css";

export function SaberPicker({ size = "md" }: { size?: "sm" | "md" }) {
  const current = getSaber(useApp((s) => s.persisted.settings.saberColor)).id;
  const move = (dir: 1 | -1) => {
    const i = SABER_PRESETS.findIndex((p) => p.id === current);
    const next = SABER_PRESETS[(i + dir + SABER_PRESETS.length) % SABER_PRESETS.length];
    useApp.getState().updateSettings({ saberColor: next.id });
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
      {SABER_PRESETS.map((p) => (
        <button
          key={p.id}
          type="button"
          role="radio"
          aria-checked={p.id === current}
          tabIndex={p.id === current ? 0 : -1}
          className={`saber-swatch${p.id === current ? " is-selected" : ""}`}
          style={{ ["--blade" as string]: p.accent, ["--blade-core" as string]: p.core }}
          title={`${p.name} blade`}
          onClick={() => useApp.getState().updateSettings({ saberColor: p.id })}
        >
          <span className="saber-swatch-beam" aria-hidden="true" />
          <span className="saber-swatch-name">{p.name}</span>
        </button>
      ))}
    </div>
  );
}

/** Controls for whatever the current theme offers. Renders nothing for plain themes. */
export function ThemeEffects({ theme }: { theme: Theme }) {
  const glow = useEffectPrefs((s) => s.glow);
  const holo = useEffectPrefs((s) => s.holo);
  const scanlines = useUi((s) => s.scanlines);
  const reduceMotion = useApp((s) => s.persisted.settings.reduceMotion);
  const fx = theme.effects ?? {};
  if (!theme.saber && !fx.glow && !fx.holo && !fx.scanlines) return null;
  return (
    <div className="theme-effects form" aria-label={`${theme.name} effects`}>
      {theme.saber && (
        <Field label="Saber colour" hint="The blade that frames the focused pane, and the accent everywhere else.">
          <SaberPicker />
        </Field>
      )}
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
