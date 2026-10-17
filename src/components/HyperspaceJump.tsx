// Hyperspace jump: a 220 ms star-streak flash over the grid when the active workspace changes.
// One <canvas> is created for the transition and removed right after; it is pointer-events:none,
// drawn with requestAnimationFrame only while it runs, and never shown under reduced motion.
// Enabled by settings.hyperspaceTransition ("auto" = only with the Hyperspace theme).

import { useEffect } from "react";
import type { Settings } from "../lib/types";
import { useApp } from "../store/appStore";
import { prefersReducedMotion } from "../theme/applyTheme";

export const JUMP_MS = 220;

export function hyperspaceEnabled(s: Pick<Settings, "hyperspaceTransition" | "theme">): boolean {
  const mode = s.hyperspaceTransition ?? "auto";
  return mode === "on" || (mode === "auto" && s.theme === "hyperspace");
}

interface Streak {
  angle: number;
  /** Start radius as a fraction of the max radius. */
  r0: number;
  len: number;
  width: number;
  color: string;
}

function cssVar(name: string, fallback: string): string {
  const v = getComputedStyle(document.documentElement).getPropertyValue(name).trim();
  return v || fallback;
}

/** Run one jump; returns a disposer (safe to call twice). */
export function runHyperspaceJump(): () => void {
  const area = document.querySelector<HTMLElement>(".grid-area");
  const r = area?.getBoundingClientRect();
  if (!r || r.width < 80 || r.height < 80) return () => {};
  const dpr = Math.min(1.5, window.devicePixelRatio || 1);
  const canvas = document.createElement("canvas");
  canvas.className = "hyperspace-canvas";
  canvas.setAttribute("aria-hidden", "true");
  Object.assign(canvas.style, { left: `${r.left}px`, top: `${r.top}px`, width: `${r.width}px`, height: `${r.height}px` });
  canvas.width = Math.round(r.width * dpr);
  canvas.height = Math.round(r.height * dpr);
  const ctx = canvas.getContext("2d");
  if (!ctx) return () => {};
  document.body.appendChild(canvas);

  const light = document.documentElement.dataset.kind === "light";
  // Light themes: ink-coloured streaks drawn normally (additive blending would vanish on white).
  const colors = [cssVar("--accent", "#41e2ff"), cssVar("--accent-2", "#a77bff"), light ? cssVar("--text-1", "#3c4d63") : cssVar("--text-0", "#ffffff")];
  const w = canvas.width;
  const h = canvas.height;
  const cx = w / 2;
  const cy = h / 2;
  const maxR = Math.hypot(cx, cy);
  const streaks: Streak[] = Array.from({ length: 150 }, (_, i) => ({
    angle: Math.random() * Math.PI * 2,
    r0: 0.04 + Math.random() * 0.55,
    len: 0.18 + Math.random() * 0.5,
    width: (0.6 + Math.random() * 1.2) * dpr,
    color: colors[i % 7 === 0 ? 1 : i % 3 === 0 ? 0 : 2],
  }));

  let raf = 0;
  let disposed = false;
  const t0 = performance.now();
  const dispose = () => {
    if (disposed) return;
    disposed = true;
    cancelAnimationFrame(raf);
    canvas.remove();
  };

  const frame = (now: number) => {
    const p = Math.min(1, (now - t0) / JUMP_MS);
    if (p >= 1) {
      dispose();
      return;
    }
    // Ease in hard, fade out: a flash rather than a scene.
    const travel = p * p * (3 - 2 * p);
    const alpha = p < 0.3 ? p / 0.3 : 1 - (p - 0.3) / 0.7;
    ctx.clearRect(0, 0, w, h);
    ctx.globalCompositeOperation = "source-over";
    if (!light) {
      ctx.globalAlpha = 0.18 * alpha;
      ctx.fillStyle = "#000";
      ctx.fillRect(0, 0, w, h);
      ctx.globalCompositeOperation = "lighter";
    }
    ctx.lineCap = "round";
    for (const s of streaks) {
      const a = s.r0 * maxR + travel * maxR * 0.9;
      const b = a + s.len * maxR * (0.15 + travel);
      const cos = Math.cos(s.angle);
      const sin = Math.sin(s.angle);
      ctx.globalAlpha = alpha * 0.85;
      ctx.strokeStyle = s.color;
      ctx.lineWidth = s.width;
      ctx.beginPath();
      ctx.moveTo(cx + cos * a, cy + sin * a);
      ctx.lineTo(cx + cos * b, cy + sin * b);
      ctx.stroke();
    }
    raf = requestAnimationFrame(frame);
  };
  raf = requestAnimationFrame(frame);
  return dispose;
}

/** Mounted once (ExperienceLayer): watches the active workspace and plays the jump on change. */
export function HyperspaceJump() {
  useEffect(() => {
    let prev = useApp.getState().persisted.activeWorkspaceId;
    let dispose: (() => void) | null = null;
    const unsub = useApp.subscribe((st) => {
      const cur = st.persisted.activeWorkspaceId;
      if (cur === prev) return;
      const from = prev;
      prev = cur;
      // Not on boot / first workspace creation, only real switches.
      if (!from || !cur || !st.persisted.workspaces.some((w) => w.id === from)) return;
      const s = st.persisted.settings;
      if (!hyperspaceEnabled(s) || prefersReducedMotion(s) || document.visibilityState !== "visible") return;
      dispose?.();
      dispose = runHyperspaceJump();
    });
    return () => {
      unsub();
      dispose?.();
    };
  }, []);
  return null;
}
