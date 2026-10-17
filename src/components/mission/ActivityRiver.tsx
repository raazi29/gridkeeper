// "Activity river": one smooth trail per session over the last 120 s; thickness and brightness follow
// the session's REAL output rate (bytes/s from the rate sampler, log-scaled), colour = role. 2D canvas,
// at most 10 fps, only while on screen and the document is visible; with reduced motion it redraws only
// when a new sample arrives.

import { memo, useEffect, useRef } from "react";
import type { SessionId } from "../../lib/types";
import { roleInfo } from "../../lib/roles";
import { RATE_HISTORY, useRates } from "../../store/rates";

const FRAME_MS = 100;

/** Trail half-thickness in px for a rate (log scale against the strip's peak). Pure; exported for tests. */
export function trailWidth(rate: number, peak: number, maxHalf: number): number {
  if (!(rate > 0) || !(peak > 0)) return 0.5;
  const k = Math.log1p(rate / 256) / Math.log1p(Math.max(peak, 2048) / 256);
  return 0.5 + Math.min(1, k) * (maxHalf - 0.5);
}

export const ActivityRiver = memo(function ActivityRiver({
  sessions,
  still,
}: {
  sessions: { id: SessionId; role: string | null }[];
  still: boolean;
}) {
  const canvas = useRef<HTMLCanvasElement>(null);
  const sessionsRef = useRef(sessions);
  sessionsRef.current = sessions;

  useEffect(() => {
    const el = canvas.current;
    if (!el) return;
    const ctx = el.getContext("2d");
    if (!ctx) return;
    let raf = 0;
    let last = 0;
    let onScreen = true;
    let colors = new Map<string, string>();
    let colorKey = "";

    const resolveColors = () => {
      const key = sessionsRef.current.map((s) => s.role ?? "").join(",");
      if (key === colorKey) return;
      colorKey = key;
      colors = new Map();
      // Resolve role CSS variables (theme-aware) through a probe element.
      const probe = document.createElement("span");
      el.parentElement?.appendChild(probe);
      for (const s of sessionsRef.current) {
        const r = s.role ?? "";
        if (colors.has(r)) continue;
        probe.style.color = roleInfo(r)?.color ?? "var(--role-custom)";
        colors.set(r, getComputedStyle(probe).color);
      }
      probe.remove();
    };

    const draw = (t: number) => {
      const dpr = window.devicePixelRatio || 1;
      const w = el.clientWidth;
      const h = el.clientHeight;
      if (w === 0 || h === 0) return;
      if (el.width !== Math.round(w * dpr) || el.height !== Math.round(h * dpr)) {
        el.width = Math.round(w * dpr);
        el.height = Math.round(h * dpr);
      }
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      ctx.clearRect(0, 0, w, h);
      resolveColors();
      const { hist, sampledAt } = useRates.getState();
      const list = sessionsRef.current;
      if (!list.length || sampledAt === null) return;
      let peak = 0;
      for (const s of list) for (const v of hist[s.id] ?? []) if (v > peak) peak = v;
      const step = w / (RATE_HISTORY - 1);
      // Smooth scroll between samples (frozen under reduced motion).
      const shift = still ? 0 : Math.min(1, Math.max(0, (Date.now() - sampledAt) / 1000)) * step;
      const n = list.length;
      const band = h / n;
      const maxHalf = Math.max(1, Math.min(9, band * 0.48 + (n > 12 ? 2 : 0)));
      list.forEach((s, i) => {
        const vals = hist[s.id];
        if (!vals || vals.length < 2) return;
        const y0 = band * (i + 0.5);
        const x0 = w - (vals.length - 1) * step - shift;
        const color = colors.get(s.role ?? "");
        if (!color) return;
        const top: [number, number][] = [];
        const bot: [number, number][] = [];
        vals.forEach((v, j) => {
          const x = x0 + j * step;
          const half = trailWidth(v, peak, maxHalf);
          // A gentle drift so neighbouring trails read as flows, not bars.
          const y = y0 + Math.sin((j + i * 7) / 9) * Math.min(2, band * 0.12);
          top.push([x, y - half]);
          bot.push([x, y + half]);
        });
        const path = new Path2D();
        path.moveTo(top[0][0], top[0][1]);
        for (let j = 1; j < top.length; j++) {
          const [px, py] = top[j - 1];
          const [x, y] = top[j];
          path.quadraticCurveTo(px, py, (px + x) / 2, (py + y) / 2);
        }
        for (let j = bot.length - 1; j >= 0; j--) path.lineTo(bot[j][0], bot[j][1]);
        path.closePath();
        const latest = vals[vals.length - 1];
        ctx.globalAlpha = 0.25 + 0.6 * Math.min(1, trailWidth(latest, peak, 1));
        ctx.fillStyle = color;
        ctx.fill(path);
      });
      ctx.globalAlpha = 1;
      last = t;
    };

    const loop = (t: number) => {
      raf = 0;
      if (!onScreen || document.visibilityState !== "visible") return;
      if (t - last >= FRAME_MS) draw(t);
      raf = requestAnimationFrame(loop);
    };
    const start = () => {
      if (still) {
        draw(performance.now());
        return;
      }
      if (!raf && onScreen && document.visibilityState === "visible") raf = requestAnimationFrame(loop);
    };
    const stop = () => {
      if (raf) cancelAnimationFrame(raf);
      raf = 0;
    };

    const io = new IntersectionObserver((entries) => {
      onScreen = entries.some((e) => e.isIntersecting);
      if (onScreen) start();
      else stop();
    });
    io.observe(el);
    const onVis = () => (document.visibilityState === "visible" ? start() : stop());
    document.addEventListener("visibilitychange", onVis);
    // Reduced motion: redraw on new samples only.
    const unsub = still ? useRates.subscribe(() => draw(performance.now())) : () => {};
    const ro = new ResizeObserver(() => draw(performance.now()));
    ro.observe(el);
    start();
    return () => {
      stop();
      io.disconnect();
      ro.disconnect();
      unsub();
      document.removeEventListener("visibilitychange", onVis);
    };
  }, [still]);

  return (
    <div className="mc-river">
      <span className="mc-river-label mc-micro">activity river · out rate per session</span>
      <span className="mc-river-note mc-micro">thickness = KB/s (log) · colour = role</span>
      <canvas ref={canvas} aria-label="Output rate of each session over the last 120 seconds" role="img" />
      <div className="mc-river-axis">
        <span>−120 s</span>
        <span>−60 s</span>
        <span>now</span>
      </div>
    </div>
  );
});
