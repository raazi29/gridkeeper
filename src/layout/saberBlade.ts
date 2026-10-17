// Saber blade on a pane's top edge: ignites when the pane gains focus or its session starts, retracts
// when the session exits. JS only decides *when* (a short-lived data-anim attribute on the blade element,
// re-keyed so the same animation can replay); the animation itself is CSS (transform/opacity, see
// signature.css). Nothing runs while idle: no timers, no rAF — the only timer is a 450 ms fallback that
// exists during an animation. Hidden / parked panes never animate.

import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import { create } from "zustand";
import { playSaber, type SaberCue } from "../audio/sounds";
import type { SessionId } from "../lib/types";
import { useApp } from "../store/appStore";
import { currentSaberLevel } from "../theme/applyTheme";
import { createRateLimiter, SOUND_GAP_MS } from "../theme/saberFx";

export type BladeAnim = "ignite" | "retract";

// ---- user gestures -------------------------------------------------------------------------------

/** A pointer / key press this recently makes a focus change or start "user-initiated" (sound allowed). */
const GESTURE_MS = 900;
let lastGesture = Number.NEGATIVE_INFINITY;
if (typeof window !== "undefined") {
  const mark = () => (lastGesture = performance.now());
  window.addEventListener("pointerdown", mark, { capture: true, passive: true });
  window.addEventListener("keydown", mark, { capture: true, passive: true });
}
const recentGesture = () => performance.now() - lastGesture < GESTURE_MS;

// ---- sound ---------------------------------------------------------------------------------------

const soundAllowed = createRateLimiter(SOUND_GAP_MS);

/** Blade sound if enabled (settings.saberSound), effects on, volume > 0; at most one per 600 ms. */
export function saberCue(cue: SaberCue): void {
  const s = useApp.getState().persisted.settings;
  if (!s.saberSound || currentSaberLevel(s) === "off") return;
  const volume = s.notifications?.volume ?? 50;
  if (volume <= 0 || !soundAllowed(performance.now())) return;
  playSaber(cue, volume);
}

// ---- manual ignition (palette command, "Test ignite") -------------------------------------------

interface SaberBus {
  target: SessionId | null;
  n: number;
}
const useSaberBus = create<SaberBus>()(() => ({ target: null, n: 0 }));

/** Ignite the focused pane's blade (with sound when enabled). False when no pane is focused / effects are off. */
export function igniteFocused(): boolean {
  const id = useApp.getState().focusedSessionId;
  if (!id || currentSaberLevel() === "off") return false;
  useSaberBus.setState((s) => ({ target: id, n: s.n + 1 }));
  saberCue("ignite");
  return true;
}

// ---- the pane hook -------------------------------------------------------------------------------

export interface BladeState {
  /** Re-key the blade element with this so a repeated animation restarts. */
  key: number;
  anim: BladeAnim | null;
  onAnimationEnd: () => void;
}

/**
 * `live`: the pane has something running (terminal session starting/running, or a browser pane).
 * `visible`: the pane is on screen (its group shown, view not hidden).
 */
export function useSaberBlade(sessionId: SessionId, focused: boolean, live: boolean, visible: boolean): BladeState {
  const [fx, setFx] = useState<{ key: number; anim: BladeAnim | null }>({ key: 0, anim: null });
  const prev = useRef({ focused, live });
  const pulse = useSaberBus((s) => (s.target === sessionId ? s.n : 0));
  const prevPulse = useRef(pulse);
  const fallback = useRef<number | undefined>(undefined);

  const play = useCallback((anim: BladeAnim) => {
    setFx((f) => ({ key: f.key + 1, anim }));
    window.clearTimeout(fallback.current);
    // animationend never fires if the pane is hidden mid-animation: drop the attribute (and will-change) anyway.
    fallback.current = window.setTimeout(() => setFx((f) => (f.anim ? { ...f, anim: null } : f)), 450);
  }, []);

  useLayoutEffect(() => {
    const was = prev.current;
    prev.current = { focused, live };
    const manual = pulse !== prevPulse.current;
    prevPulse.current = pulse;
    if (!visible) return;
    if (manual && pulse > 0) {
      play("ignite"); // sound already played by igniteFocused()
      return;
    }
    const level = currentSaberLevel();
    if (level === "off") return;
    const user = recentGesture();
    if (live && !was.live) {
      play("ignite");
      if (user) saberCue("ignite");
    } else if (!live && was.live) {
      // Subtle: only the pane you are looking at; full: every visible pane.
      if (focused || level === "full") play("retract");
      if (user && focused) saberCue("retract");
    } else if (focused && !was.focused && live) {
      play("ignite");
      if (user) saberCue("ignite");
    }
  }, [focused, live, visible, pulse, play]);

  useEffect(() => () => window.clearTimeout(fallback.current), []);

  const onAnimationEnd = useCallback(() => {
    window.clearTimeout(fallback.current);
    setFx((f) => (f.anim ? { ...f, anim: null } : f));
  }, []);

  return { key: fx.key, anim: fx.anim, onAnimationEnd };
}
