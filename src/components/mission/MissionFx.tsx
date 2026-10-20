// Mission Control effects (gold, Star Wars spirit): the effects flag, the entry jump and the opt-in briefing
// crawl (comet routing is in derive.ts, pulseFor). Everything is decorative and gated by one flag (the
// "Mission Control effects" toggle AND no reduced motion); CSS does the rest of the motion (mission.css,
// "effects"). The only canvases are the 0.76 s entry jump and the crawl (starfield painted once, text drawn per
// frame only while it plays). CSS loops pause while the window is in the background (:root[data-app-blurred]);
// a closed Mission Control is unmounted.

import { useEffect, useLayoutEffect, useRef, useState, type KeyboardEvent } from "react";
import { t as translate, useT } from "../../i18n";
import type { MissionDoc } from "../../lib/missionDoc";
import { useApp } from "../../store/appStore";
import { useEffectPrefs } from "../../theme/effectPrefs";

/** Effects on: the toggle is on and neither the setting nor the OS asks for reduced motion (`osReduced` is reactive). */
export function useMcFx(osReduced: boolean): boolean {
  const pref = useEffectPrefs((s) => s.mission);
  const reduce = useApp((s) => s.persisted.settings.reduceMotion);
  return pref && !reduce && !osReduced;
}

const ENTRY_JUMP_MS = 760;

/**
 * Hyperspace jump into Mission Control: gold streaks stretch out of the centre while the dark lifts, then the
 * canvas is removed. Its own canvas (the workspace-switch jump, HyperspaceJump.tsx, is a 0.2 s flash over the
 * grid); requestAnimationFrame only while it runs. Returns a disposer (safe to call twice).
 */
export function playEntryJump(panel: HTMLElement): () => void {
  const r = panel.getBoundingClientRect();
  if (r.width < 80 || r.height < 80) return () => {};
  const dpr = Math.min(1.5, window.devicePixelRatio || 1);
  const canvas = document.createElement("canvas");
  canvas.className = "mc-jump";
  canvas.setAttribute("aria-hidden", "true");
  canvas.width = Math.round(r.width * dpr);
  canvas.height = Math.round(r.height * dpr);
  const ctx = canvas.getContext("2d");
  if (!ctx) return () => {};
  panel.appendChild(canvas);

  const cs = getComputedStyle(panel);
  const v = (n: string, f: string) => cs.getPropertyValue(n).trim() || f;
  const light = document.documentElement.dataset.kind === "light";
  const colors = [v("--mc-gold", "#f3c14b"), v("--mc-gold-hi", "#fff0c2"), v("--mc-gold-deep", "#c98a1b")];
  const w = canvas.width;
  const h = canvas.height;
  const cx = w / 2;
  const cy = h / 2;
  const maxR = Math.hypot(cx, cy);
  const streaks = Array.from({ length: 280 }, (_, i) => ({
    cos: 0,
    sin: 0,
    angle: Math.random() * Math.PI * 2,
    delay: Math.random() * 0.4,
    speed: 0.6 + Math.random() * 0.9,
    width: (0.7 + Math.random() * 1.6) * dpr,
    color: colors[i % 9 === 0 ? 1 : i % 3 === 0 ? 2 : 0],
  }));
  for (const s of streaks) {
    s.cos = Math.cos(s.angle);
    s.sin = Math.sin(s.angle);
  }

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
    const p = (now - t0) / ENTRY_JUMP_MS;
    if (p >= 1) return dispose();
    ctx.globalCompositeOperation = "source-over";
    ctx.clearRect(0, 0, w, h);
    // The dark lifts as the jump ends (the panels assemble underneath from ~0.4 s).
    ctx.globalAlpha = (light ? 0.35 : 0.7) * (1 - p) ** 1.5;
    ctx.fillStyle = light ? "#fff" : "#000";
    ctx.fillRect(0, 0, w, h);
    if (!light) ctx.globalCompositeOperation = "lighter";
    // A gold core flares, then fades.
    const core = ctx.createRadialGradient(cx, cy, 0, cx, cy, maxR * 0.4);
    core.addColorStop(0, colors[1]);
    core.addColorStop(1, "rgba(0,0,0,0)");
    ctx.globalAlpha = 0.45 * Math.sin(Math.min(1, p * 1.6) * Math.PI);
    ctx.fillStyle = core;
    ctx.fillRect(0, 0, w, h);
    ctx.lineCap = "round";
    const fade = 1 - p ** 3;
    for (const s of streaks) {
      const q = (p - s.delay) / (1 - s.delay);
      if (q <= 0) continue;
      const head = maxR * (0.03 + 1.25 * s.speed * q ** 2.2);
      const tail = Math.max(0, head - maxR * s.speed * (0.03 + 0.5 * q ** 1.6));
      ctx.globalAlpha = Math.min(1, q * 5) * fade * 0.9;
      ctx.strokeStyle = s.color;
      ctx.lineWidth = s.width * (0.6 + q);
      ctx.beginPath();
      ctx.moveTo(cx + s.cos * tail, cy + s.sin * tail);
      ctx.lineTo(cx + s.cos * head, cy + s.sin * head);
      ctx.stroke();
    }
    raf = requestAnimationFrame(frame);
  };
  raf = requestAnimationFrame(frame);
  return dispose;
}

/** Open tasks shown in the crawl (the rest is summed up): keeps it under a minute. */
const CRAWL_TASKS = 12;
/** The crawl text starts rising once the title has receded (mission.css: intro 0–4 s, title 4–9 s). */
const CRAWL_START_MS = 7500;

interface CrawlBlock {
  text: string;
  kind: "ep" | "title" | "body" | "task" | "end";
}

function crawlBlocks(doc: MissionDoc, title: string): CrawlBlock[] {
  const open = doc.tasks.filter((t) => t.state !== "done");
  const shown = open.slice(0, CRAWL_TASKS);
  const out: CrawlBlock[] = [
    { kind: "ep", text: translate("mcNode.crawl.episode", { title, done: doc.tasks.length - open.length, total: doc.tasks.length }) },
    { kind: "title", text: doc.goal ?? translate("mcNode.crawl.defaultTitle") },
  ];
  if (doc.context) out.push({ kind: "body", text: doc.context });
  out.push({
    kind: "body",
    text: open.length === 0 ? translate("mcNode.crawl.allDone") : translate("mcNode.crawl.remaining", { count: open.length }),
  });
  for (const t of shown) out.push({ kind: "task", text: `${t.state === "blocked" ? "!" : "◆"} ${t.text}${t.owners.length ? ` — ${t.owners.map((o) => `@${o}`).join(" ")}` : ""}` });
  if (open.length > shown.length) out.push({ kind: "body", text: translate("mcNode.crawl.more", { count: open.length - shown.length }) });
  out.push({ kind: "end", text: translate("mcNode.crawl.end") });
  return out;
}

/**
 * Draws the crawl: lines on a plane tilted away from the viewer, rising and shrinking toward a vanishing line
 * above the top edge (per-line projection: CSS 3D text renders sheared in WebView2). requestAnimationFrame
 * only while it runs; calls `onEnd` once the last line has receded. Returns a disposer.
 */
function runCrawl(c: HTMLCanvasElement, blocks: CrawlBlock[], fonts: { mono: string; display: string }, onEnd: () => void): () => void {
  const ctx = c.getContext("2d");
  if (!ctx) return () => {};
  const dpr = Math.min(1.5, window.devicePixelRatio || 1);
  const W = (c.width = Math.round(c.clientWidth * dpr));
  const H = (c.height = Math.round(c.clientHeight * dpr));
  const base = Math.max(20, Math.min(42, c.clientWidth * 0.028)) * dpr;
  const col = Math.min(W * 0.72, base * 36);
  const lines: { text: string; font: string; y: number; center: boolean }[] = [];
  let y = 0;
  for (const b of blocks) {
    const size = base * (b.kind === "title" ? 1.6 : b.kind === "ep" ? 0.8 : 1);
    const font = `${b.kind === "title" ? 700 : 600} ${size}px ${b.kind === "title" ? fonts.display : fonts.mono}`;
    ctx.font = font;
    const center = b.kind !== "body" && b.kind !== "task";
    let line = "";
    for (const word of (b.kind === "title" || b.kind === "ep" ? b.text.toUpperCase() : b.text).split(/\s+/)) {
      const next = line ? `${line} ${word}` : word;
      if (line && ctx.measureText(next).width > col) {
        lines.push({ text: line, font, y, center });
        y += size * 1.45;
        line = word;
      } else line = next;
    }
    lines.push({ text: line, font, y, center });
    y += size * (b.kind === "task" ? 1.6 : 2.3);
  }
  // Plane geometry: tilt θ, viewer distance f; the vanishing line sits just above the top edge.
  const tilt = 0.85;
  const sin = Math.sin(tilt);
  const cos = Math.cos(tilt);
  const f = H * 1.05 * Math.tan(tilt);
  const speed = H * 0.16; // plane px per second
  const gone = 0.3; // depth factor where a line has faded out (about the upper quarter of the screen)
  let raf = 0;
  let disposed = false;
  const t0 = performance.now();
  const dispose = () => {
    disposed = true;
    cancelAnimationFrame(raf);
  };
  const frame = (now: number) => {
    const o = ((now - t0) / 1000) * speed; // how far the plane has moved up, in plane px
    ctx.clearRect(0, 0, W, H);
    ctx.fillStyle = "#f3c14b";
    ctx.textBaseline = "alphabetic";
    let visible = false;
    for (const l of lines) {
      const s = o - l.y; // distance of this line beyond the bottom edge, along the plane
      if (s < 0) continue;
      const k = f / (f + s * sin);
      if (k < gone) continue;
      visible = true;
      ctx.globalAlpha = Math.min(1, (k - gone) / 0.2);
      ctx.font = l.font;
      // Width shrinks with depth (k), height also foreshortens with the tilt (cos·k²), as on a real plane.
      ctx.setTransform(k, 0, 0, cos * k * k, W / 2, H - s * cos * k);
      ctx.textAlign = l.center ? "center" : "left";
      ctx.fillText(l.text, l.center ? 0 : -col / 2, 0);
    }
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    if (!visible && o > y) {
      dispose();
      onEnd();
      return;
    }
    raf = requestAnimationFrame(frame);
  };
  raf = requestAnimationFrame(frame);
  return () => {
    if (!disposed) dispose();
  };
}

/**
 * The briefing: an opening crawl of the mission goal, context and open tasks in gold perspective text over a
 * starfield. Opt-in (the board's "▶ briefing" button); click, Esc, Enter or Space skips; it closes itself at
 * the end. A real dialog: the briefing is also in the DOM as text for screen readers (the canvas is decor).
 */
export function Briefing({ doc, title, onClose }: { doc: MissionDoc; title: string; onClose: () => void }) {
  const t = useT();
  const root = useRef<HTMLDivElement>(null);
  const stars = useRef<HTMLCanvasElement>(null);
  const text = useRef<HTMLCanvasElement>(null);
  const done = useRef(onClose);
  done.current = onClose;
  const [blocks] = useState(() => crawlBlocks(doc, title));

  useLayoutEffect(() => {
    const el = root.current;
    const c = stars.current;
    if (!el) return;
    el.focus({ preventScroll: true });
    const ctx = c?.getContext("2d");
    if (!c || !ctx) return;
    // Starfield: painted once, never animated.
    const dpr = Math.min(1.5, window.devicePixelRatio || 1);
    c.width = Math.round(el.clientWidth * dpr);
    c.height = Math.round(el.clientHeight * dpr);
    for (let i = 0; i < 420; i++) {
      const r = Math.random();
      ctx.globalAlpha = 0.25 + Math.random() * 0.75;
      ctx.fillStyle = r < 0.12 ? "#ffd979" : r < 0.2 ? "#bcd4ff" : "#ffffff";
      const s = (r < 0.04 ? 1.8 : Math.random() < 0.8 ? 0.8 : 1.2) * dpr;
      ctx.fillRect(Math.random() * c.width, Math.random() * c.height, s, s);
    }
  }, []);

  useEffect(() => {
    let dispose = () => {};
    const cs = getComputedStyle(document.documentElement);
    const fonts = { mono: cs.getPropertyValue("--font-mono").trim() || "monospace", display: cs.getPropertyValue("--font-display").trim() || "sans-serif" };
    const timer = setTimeout(() => {
      if (text.current) dispose = runCrawl(text.current, blocks, fonts, () => done.current());
    }, CRAWL_START_MS);
    return () => {
      clearTimeout(timer);
      dispose();
    };
  }, [blocks]);

  const onKey = (e: KeyboardEvent) => {
    e.stopPropagation(); // never reaches Mission Control's keys (Esc would close it)
    if (e.key === "Escape" || e.key === "Enter" || e.key === " " || e.key === "Tab") {
      e.preventDefault();
      onClose();
    }
  };

  return (
    <div ref={root} className="mc-crawl" role="dialog" aria-modal="true" aria-label={t("mcNode.crawl.aria")} tabIndex={-1} onKeyDown={onKey} onClick={onClose}>
      <canvas ref={stars} className="mc-crawl-stars" aria-hidden="true" />
      <p className="mc-crawl-intro" aria-hidden="true">
        {t("mcNode.crawl.intro")}
      </p>
      <div className="mc-crawl-logo" aria-hidden="true">
        <span>mission</span>
        <span>control</span>
      </div>
      <canvas ref={text} className="mc-crawl-stars" aria-hidden="true" />
      <div className="mc-sr">
        {blocks.map((b, i) => (
          <p key={i}>{b.text}</p>
        ))}
      </div>
      <div className="mc-crawl-skip" aria-hidden="true">
        {t("mcNode.crawl.skip")}
      </div>
    </div>
  );
}

