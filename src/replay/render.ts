// Mission replay: canvas painter. paintFrame(ctx, scene, ms, opts) draws one frame of the timelapse —
// title card, main scene (goal + progress, one row per agent, the task board, a comms ticker), end card —
// from the pure scene model in timeline.ts. Stateless per frame (scrubbing and export just call it with
// a different time); every animation is a function of video time and the REAL time an event happened.
//
// Works on a DOM canvas (preview, MediaRecorder export) and an OffscreenCanvas (GIF frames). No Path2D,
// no images, no fonts loaded here (the caller awaits document.fonts first): every glyph of the brand
// mark is drawn with plain paths, so the painter also runs against a stub context in unit tests.

import type { ReplayEvent } from "./events";
import { alpha, roleColor, type ReplayPalette } from "./palette";
import {
  agentCounters,
  boardProgress,
  buildTimeline,
  currentTask,
  formatClock,
  formatClockRange,
  formatCount,
  formatWall,
  makePlan,
  realToScene,
  sceneClock,
  stateAt,
  type AgentState,
  type ReplayPlan,
  type SceneClock,
  type SceneState,
  type TaskItem,
  type Timeline,
} from "./timeline";

export type Aspect = "landscape" | "square" | "vertical";

export const ASPECTS: Record<Aspect, { w: number; h: number; label: string }> = {
  landscape: { w: 1920, h: 1080, label: "16:9" },
  square: { w: 1080, h: 1080, label: "1:1" },
  vertical: { w: 1080, h: 1920, label: "9:16" },
};

export const FPS = 30;
export const REPO_URL = "github.com/raazi29/gridkeeper";

export interface ReplayFonts {
  ui: string;
  mono: string;
  display: string;
}

export const REPLAY_FONTS: ReplayFonts = {
  ui: '"Geist Variable", "Segoe UI Variable Text", "Segoe UI", system-ui, sans-serif',
  mono: '"Geist Mono Variable", "Cascadia Mono", Consolas, monospace',
  display: '"Space Grotesk Variable", "Geist Variable", "Segoe UI", sans-serif',
};

export interface PaintOptions {
  width: number;
  height: number;
  palette: ReplayPalette;
  /** "Made with Gridkeeper" on the end card and a small mark in the main scene. */
  watermark: boolean;
  /** No gradients / glows (GIF: fewer colours, smaller frame deltas). */
  flat?: boolean;
  fonts?: ReplayFonts;
}

export interface ReplayScene {
  tl: Timeline;
  plan: ReplayPlan;
  /** Optional end-card line from the flight log, e.g. "Day 7 streak · Captain". */
  flightLine?: string | null;
}

export function makeScene(events: readonly ReplayEvent[], lengthSec: number): ReplayScene {
  const tl = buildTimeline(events);
  return { tl, plan: makePlan(tl, lengthSec) };
}

type Ctx = CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D;

interface Rect {
  x: number;
  y: number;
  w: number;
  h: number;
}

interface P {
  ctx: Ctx;
  W: number;
  H: number;
  u: number;
  pal: ReplayPalette;
  f: ReplayFonts;
  flat: boolean;
  watermark: boolean;
  ms: number;
  scene: ReplayScene;
}

// ---- math ---------------------------------------------------------------------------------------

const clamp01 = (x: number) => (x < 0 ? 0 : x > 1 ? 1 : x);
const easeOut = (x: number) => 1 - (1 - clamp01(x)) ** 3;
const easeInOut = (x: number) => {
  const t = clamp01(x);
  return t < 0.5 ? 4 * t * t * t : 1 - (-2 * t + 2) ** 3 / 2;
};
const lerp = (a: number, b: number, t: number) => a + (b - a) * t;

/** Video ms since the main scene reached real time `t` (negative = not yet). */
function age(p: P, t: number): number {
  return p.ms - realToScene(p.scene.plan, t);
}

// ---- text ---------------------------------------------------------------------------------------

function font(p: P, weight: number, size: number, family: string): string {
  return `${weight} ${Math.max(1, Math.round(size * p.u * 10) / 10)}px ${family}`;
}

function setSpacing(ctx: Ctx, px: number) {
  const c = ctx as Ctx & { letterSpacing?: string };
  if (typeof c.letterSpacing === "string") c.letterSpacing = `${px.toFixed(2)}px`;
}

function fit(ctx: Ctx, text: string, maxW: number): string {
  if (maxW <= 0) return "";
  if (ctx.measureText(text).width <= maxW) return text;
  let lo = 0;
  let hi = text.length;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if (ctx.measureText(`${text.slice(0, mid).trimEnd()}…`).width <= maxW) lo = mid;
    else hi = mid - 1;
  }
  return lo > 0 ? `${text.slice(0, lo).trimEnd()}…` : "";
}

function wrap(ctx: Ctx, text: string, maxW: number, maxLines: number): string[] {
  const words = text.split(/\s+/).filter(Boolean);
  const lines: string[] = [];
  let cur = "";
  for (let i = 0; i < words.length; i++) {
    const next = cur ? `${cur} ${words[i]}` : words[i];
    if (ctx.measureText(next).width <= maxW || !cur) {
      cur = next;
      continue;
    }
    lines.push(cur);
    cur = words[i];
    if (lines.length === maxLines - 1) {
      cur = words.slice(i).join(" ");
      break;
    }
  }
  if (cur) lines.push(cur);
  return lines.slice(0, maxLines).map((l, i, all) => (i === all.length - 1 ? fit(ctx, l, maxW) : l));
}

function text(p: P, s: string, x: number, y: number, o: { size: number; weight?: number; family?: string; color: string; align?: CanvasTextAlign; base?: CanvasTextBaseline; spacing?: number; maxW?: number; a?: number }) {
  const { ctx } = p;
  ctx.font = font(p, o.weight ?? 400, o.size, o.family ?? p.f.ui);
  setSpacing(ctx, (o.spacing ?? 0) * o.size * p.u);
  ctx.fillStyle = o.color;
  ctx.textAlign = o.align ?? "left";
  ctx.textBaseline = o.base ?? "alphabetic";
  const prev = ctx.globalAlpha;
  if (o.a !== undefined) ctx.globalAlpha = prev * clamp01(o.a);
  const str = o.maxW !== undefined ? fit(ctx, s, o.maxW) : s;
  ctx.fillText(str, x, y);
  ctx.globalAlpha = prev;
  const w = ctx.measureText(str).width;
  setSpacing(ctx, 0);
  return w;
}

function measure(p: P, s: string, size: number, weight = 400, family = p.f.ui, spacing = 0): number {
  p.ctx.font = font(p, weight, size, family);
  setSpacing(p.ctx, spacing * size * p.u);
  const w = p.ctx.measureText(s).width;
  setSpacing(p.ctx, 0);
  return w;
}

// ---- shapes -------------------------------------------------------------------------------------

function rrect(ctx: Ctx, x: number, y: number, w: number, h: number, r: number) {
  const rr = Math.max(0, Math.min(r, w / 2, h / 2));
  ctx.beginPath();
  ctx.moveTo(x + rr, y);
  ctx.lineTo(x + w - rr, y);
  ctx.arcTo(x + w, y, x + w, y + rr, rr);
  ctx.lineTo(x + w, y + h - rr);
  ctx.arcTo(x + w, y + h, x + w - rr, y + h, rr);
  ctx.lineTo(x + rr, y + h);
  ctx.arcTo(x, y + h, x, y + h - rr, rr);
  ctx.lineTo(x, y + rr);
  ctx.arcTo(x, y, x + rr, y, rr);
  ctx.closePath();
}

function circle(ctx: Ctx, x: number, y: number, r: number) {
  ctx.beginPath();
  ctx.arc(x, y, Math.max(0, r), 0, Math.PI * 2);
}

/** The Gridkeeper mark (docs/assets/logo/gridkeeper-mark.svg), `size` px square at (x, y). */
export function drawMark(ctx: Ctx, x: number, y: number, size: number, ink: string, signal: string) {
  const k = size / 680;
  const X = (v: number) => x + (v - 172) * k;
  const Y = (v: number) => y + (v - 172) * k;
  ctx.save();
  ctx.strokeStyle = ink;
  ctx.lineWidth = 42 * k;
  ctx.lineCap = "round";
  ctx.lineJoin = "round";
  ctx.beginPath();
  ctx.moveTo(X(196), Y(358));
  ctx.lineTo(X(196), Y(250));
  ctx.arcTo(X(196), Y(196), X(250), Y(196), 54 * k);
  ctx.lineTo(X(358), Y(196));
  ctx.moveTo(X(666), Y(196));
  ctx.lineTo(X(774), Y(196));
  ctx.arcTo(X(828), Y(196), X(828), Y(250), 54 * k);
  ctx.lineTo(X(828), Y(358));
  ctx.moveTo(X(828), Y(666));
  ctx.lineTo(X(828), Y(774));
  ctx.arcTo(X(828), Y(828), X(774), Y(828), 54 * k);
  ctx.lineTo(X(666), Y(828));
  ctx.moveTo(X(358), Y(828));
  ctx.lineTo(X(250), Y(828));
  ctx.arcTo(X(196), Y(828), X(196), Y(774), 54 * k);
  ctx.lineTo(X(196), Y(666));
  ctx.stroke();
  const pane = (px: number, py: number, color: string, a: number) => {
    ctx.globalAlpha = a;
    ctx.fillStyle = color;
    rrect(ctx, X(px), Y(py), 200 * k, 200 * k, 40 * k);
    ctx.fill();
  };
  pane(290, 290, ink, 1);
  pane(534, 290, signal, 1);
  pane(290, 534, ink, 0.5);
  pane(534, 534, ink, 0.5);
  ctx.restore();
}

/** Mark + GRIDKEEPER wordmark (Space Grotesk 600, +0.12 em), centred on `cx`; returns its width. */
function drawLockup(p: P, cx: number, y: number, size: number, a = 1) {
  const cap = size * 0.7 * p.u;
  const mark = cap * 2.4;
  const gap = cap * 0.8;
  const tw = measure(p, "GRIDKEEPER", size, 600, p.f.display, 0.12);
  const total = mark + gap + tw;
  const x0 = cx - total / 2;
  const { ctx } = p;
  const prev = ctx.globalAlpha;
  ctx.globalAlpha = prev * a;
  drawMark(ctx, x0, y, mark, p.pal.text0, p.pal.accent);
  ctx.globalAlpha = prev;
  text(p, "GRIDKEEPER", x0 + mark + gap, y + mark / 2 + cap / 2, { size, weight: 600, family: p.f.display, color: p.pal.text0, spacing: 0.12, a });
  return total;
}

// ---- background ---------------------------------------------------------------------------------

function background(p: P) {
  const { ctx, W, H, pal, u } = p;
  ctx.globalAlpha = 1;
  ctx.fillStyle = pal.bg0;
  ctx.fillRect(0, 0, W, H);
  if (!p.flat) {
    const g = ctx.createRadialGradient(W * 0.18, H * 0.05, 0, W * 0.18, H * 0.05, Math.max(W, H) * 0.75);
    g.addColorStop(0, alpha(pal.accent, 0.1));
    g.addColorStop(1, alpha(pal.accent, 0));
    ctx.fillStyle = g;
    ctx.fillRect(0, 0, W, H);
  }
  // The keeper's grid: faint dots.
  const step = 48 * u;
  ctx.fillStyle = alpha(pal.text0, p.flat ? 0.05 : 0.045);
  const r = Math.max(1, 1.4 * u);
  for (let y = step / 2; y < H; y += step) for (let x = step / 2; x < W; x += step) ctx.fillRect(x - r / 2, y - r / 2, r, r);
}

// ---- layout -------------------------------------------------------------------------------------

interface Layout {
  stacked: boolean;
  m: number;
  header: Rect;
  progress: Rect;
  agents: Rect;
  tasks: Rect;
  ticker: Rect;
  tickerLines: number;
  /** Agent cards per row (2 when one column would squash the rows). */
  agentCols: number;
}

function layout(p: P, s: SceneState): Layout {
  const { W, H, u } = p;
  const stacked = W / H < 1.3;
  if (!stacked) {
    const m = 72 * u;
    const header: Rect = { x: m, y: m - 8 * u, w: W - 2 * m, h: 150 * u };
    const progress: Rect = { x: m, y: header.y + header.h + 18 * u, w: W - 2 * m, h: 12 * u };
    const ticker: Rect = { x: m, y: H - 56 * u - 104 * u, w: W - 2 * m, h: 104 * u };
    const top = progress.y + progress.h + 46 * u;
    const bottom = ticker.y - 30 * u;
    const aw = (W - 2 * m) * 0.6 - 24 * u;
    const n = visibleAgents(p, s).length;
    const agentCols = n > 6 && (bottom - top - 38 * u) / n < 72 * u ? 2 : 1;
    return {
      stacked,
      m,
      header,
      progress,
      agents: { x: m, y: top, w: aw, h: bottom - top },
      tasks: { x: m + aw + 48 * u, y: top, w: W - 2 * m - aw - 48 * u, h: bottom - top },
      ticker,
      tickerLines: 2,
      agentCols,
    };
  }
  const m = 56 * u;
  const header: Rect = { x: m, y: m - 4 * u, w: W - 2 * m, h: 190 * u };
  const progress: Rect = { x: m, y: header.y + header.h + 14 * u, w: W - 2 * m, h: 12 * u };
  const tickerLines = H / W > 1.4 ? 3 : 2;
  const th = (tickerLines * 46 + 44) * u;
  const ticker: Rect = { x: m, y: H - 44 * u - th, w: W - 2 * m, h: th };
  const top = progress.y + progress.h + 40 * u;
  const bottom = ticker.y - 26 * u;
  const avail = bottom - top;
  const n = Math.max(1, visibleAgents(p, s).length);
  const tall = H / W > 1.4;
  const agentCols = n > (tall ? 7 : 3) ? 2 : 1;
  const want = 38 * u + Math.ceil(n / agentCols) * ((tall ? 104 : 84) + 10) * u;
  const ah = Math.min(want, avail * (tall ? 0.6 : 0.62));
  return {
    stacked,
    m,
    header,
    progress,
    agents: { x: m, y: top, w: W - 2 * m, h: ah },
    tasks: { x: m, y: top + ah + 28 * u, w: W - 2 * m, h: bottom - top - ah - 28 * u },
    ticker,
    tickerLines,
    agentCols,
  };
}

// ---- state helpers ------------------------------------------------------------------------------

/** Agents still on the team (removed ones disappear; stopped ones stay, dimmed). */
function visibleAgents(p: P, s: SceneState): AgentState[] {
  return s.agents.filter((a) => !(a.leftWhy === "removed" && !a.live && age(p, a.leftAt ?? 0) > 600));
}

function attnColor(p: P, a: AgentState): string {
  const { pal } = p;
  switch (a.attn) {
    case "working":
      return a.live ? pal.accent : pal.text2;
    case "needs":
      return pal.warn;
    case "done":
      return pal.ok;
    case "error":
      return pal.err;
    default:
      return a.live ? pal.text2 : pal.borderStrong;
  }
}

function attnLabel(a: AgentState): string {
  if (!a.live && a.attn !== "done" && a.attn !== "error") return a.leftWhy === "error" ? "stopped (error)" : "offline";
  switch (a.attn) {
    case "working":
      return "working";
    case "needs":
      return "needs you";
    case "done":
      return "done";
    case "error":
      return "error";
    default:
      return "idle";
  }
}

function taskColor(p: P, s: TaskItem["s"]): string {
  return s === "done" ? p.pal.ok : s === "doing" ? p.pal.accent : s === "blocked" ? p.pal.err : p.pal.text2;
}

// ---- header + progress --------------------------------------------------------------------------

function overline(p: P, s: string, x: number, y: number, color: string, size = 17, align: CanvasTextAlign = "left") {
  return text(p, s, x, y, { size, weight: 500, family: p.f.mono, color, spacing: 0.24, align });
}

function header(p: P, L: Layout, s: SceneState, clock: SceneClock) {
  const { u, pal } = p;
  const h = L.header;
  const goal = s.goal ?? "Untitled mission";
  const clockW = (L.stacked ? 250 : 330) * u;
  overline(p, "MISSION · REPLAY", h.x, h.y + 22 * u, pal.accent);
  const gsize = L.stacked ? 46 : 52;
  p.ctx.font = font(p, 600, gsize, p.f.display);
  const lines = wrap(p.ctx, goal, h.w - clockW - 24 * u, 2);
  const flash = s.goalAt ? 1 - clamp01(age(p, s.goalAt) / 900) : 0;
  lines.forEach((l, i) =>
    text(p, l, h.x, h.y + (78 + i * gsize * 1.12) * u, { size: gsize, weight: 600, family: p.f.display, color: flash > 0 ? mixColor(pal.text0, pal.accent, flash * 0.6) : pal.text0 }),
  );
  // Real-time clock (right).
  const rx = h.x + h.w;
  text(p, formatClock(clock.real), rx, h.y + (L.stacked ? 92 : 98) * u, { size: L.stacked ? 64 : 76, weight: 500, family: p.f.mono, color: pal.text0, align: "right" });
  const elapsed = Math.max(0, clock.real - p.scene.plan.map.t0);
  overline(p, `+${formatWall(elapsed).toUpperCase()}`, rx, h.y + (L.stacked ? 132 : 140) * u, pal.text2, 17, "right");
}

function mixColor(a: string, b: string, t: number): string {
  const pa = parseInt(a.slice(1), 16);
  const pb = parseInt(b.slice(1), 16);
  const ch = (v: number, s: number) => (v >> s) & 255;
  const m = (s: number) => Math.round(lerp(ch(pa, s), ch(pb, s), clamp01(t)));
  return `rgb(${m(16)}, ${m(8)}, ${m(0)})`;
}

function progressBar(p: P, L: Layout, s: SceneState) {
  const { ctx, u, pal } = p;
  const r = L.progress;
  const now = boardProgress(s.tasks);
  const k = easeOut(age(p, s.progAt) / 700);
  const fPrev = s.progPrev.total ? s.progPrev.done / s.progPrev.total : 0;
  const fNow = now.total ? now.done / now.total : 0;
  const f = lerp(fPrev, fNow, s.progAt ? k : 1);
  ctx.fillStyle = pal.bg2;
  rrect(ctx, r.x, r.y, r.w, r.h, r.h / 2);
  ctx.fill();
  ctx.strokeStyle = pal.border;
  ctx.lineWidth = Math.max(1, u);
  ctx.stroke();
  if (f > 0) {
    const w = Math.max(r.h, r.w * f);
    if (p.flat) ctx.fillStyle = now.done === now.total && now.total > 0 ? pal.ok : pal.accent;
    else {
      const g = ctx.createLinearGradient(r.x, 0, r.x + w, 0);
      g.addColorStop(0, pal.accent2);
      g.addColorStop(1, now.done === now.total && now.total > 0 ? pal.ok : pal.accent);
      ctx.fillStyle = g;
    }
    rrect(ctx, r.x, r.y, w, r.h, r.h / 2);
    ctx.fill();
    if (!p.flat && k < 1 && s.progAt) {
      // Leading-edge glint while the bar grows.
      ctx.fillStyle = alpha(pal.text0, 0.5 * (1 - k));
      circle(ctx, r.x + w - r.h / 2, r.y + r.h / 2, r.h * 0.9);
      ctx.fill();
    }
  }
  const label = now.total ? `${now.done} / ${now.total} TASKS · ${Math.round(fNow * 100)}%` : "NO TASKS ON THE BOARD YET";
  overline(p, label, r.x, r.y - 12 * u, now.total && now.done === now.total ? pal.ok : pal.text1, 16);
}

// ---- agents -------------------------------------------------------------------------------------

function lamp(p: P, x: number, y: number, a: AgentState, r: number) {
  const { ctx, u, pal } = p;
  const color = attnColor(p, a);
  const t = p.ms / 1000;
  if (a.live && a.attn === "working") {
    // GIF (flat): a still ring, so idle stretches produce no frame deltas.
    const ph = p.flat ? 0.45 : (t * 0.9 + a.order * 0.37) % 1;
    ctx.strokeStyle = alpha(color, 0.55 * (1 - ph));
    ctx.lineWidth = 2 * u;
    circle(ctx, x, y, r + ph * 14 * u);
    ctx.stroke();
    if (!p.flat) {
      ctx.fillStyle = alpha(color, 0.18);
      circle(ctx, x, y, r * 2);
      ctx.fill();
    }
  } else if (a.attn === "needs") {
    const on = p.flat ? 1 : 0.5 + 0.5 * Math.sin(t * Math.PI * 2 * 1.4);
    ctx.strokeStyle = alpha(color, 0.35 + 0.5 * on);
    ctx.lineWidth = 2.5 * u;
    circle(ctx, x, y, r + 6 * u);
    ctx.stroke();
  }
  if (!a.live && a.attn !== "done" && a.attn !== "error") {
    ctx.strokeStyle = color;
    ctx.lineWidth = 2 * u;
    circle(ctx, x, y, r - u);
    ctx.stroke();
  } else if (a.attn === "idle") {
    ctx.strokeStyle = color;
    ctx.lineWidth = 2.2 * u;
    circle(ctx, x, y, r - u);
    ctx.stroke();
  } else {
    ctx.fillStyle = color;
    circle(ctx, x, y, r);
    ctx.fill();
    if (a.attn === "done") {
      ctx.strokeStyle = pal.bg0;
      ctx.lineWidth = 2.2 * u;
      ctx.lineCap = "round";
      ctx.beginPath();
      ctx.moveTo(x - r * 0.45, y + r * 0.02);
      ctx.lineTo(x - r * 0.1, y + r * 0.36);
      ctx.lineTo(x + r * 0.5, y - r * 0.35);
      ctx.stroke();
    }
  }
}

function rolePill(p: P, role: string | null, x: number, yMid: number, size: number): number {
  if (!role) return 0;
  const { ctx, u } = p;
  const c = roleColor(p.pal, role);
  const label = role.toUpperCase().slice(0, 12);
  const tw = measure(p, label, size, 600, p.f.mono, 0.1);
  const padX = 8 * u;
  const h = size * 1.55 * u;
  ctx.fillStyle = alpha(c, 0.14);
  rrect(ctx, x, yMid - h / 2, tw + padX * 2, h, 4 * u);
  ctx.fill();
  ctx.strokeStyle = alpha(c, 0.55);
  ctx.lineWidth = Math.max(1, u);
  ctx.stroke();
  text(p, label, x + padX, yMid + 0.5 * u, { size, weight: 600, family: p.f.mono, color: c, spacing: 0.1, base: "middle" });
  return tw + padX * 2;
}

function counterValue(p: P, prev: number, now: number, at: number): number {
  const k = easeOut(age(p, at) / 900);
  return Math.round(lerp(prev, now, k));
}

function agentRow(p: P, s: SceneState, a: AgentState, r: Rect, compact: boolean, fade: number) {
  const { ctx, u, pal } = p;
  const dim = a.live ? 1 : 0.5;
  ctx.save();
  ctx.globalAlpha = fade * dim;
  // Card.
  ctx.fillStyle = pal.bg1;
  rrect(ctx, r.x, r.y, r.w, r.h, 10 * u);
  ctx.fill();
  const changed = 1 - clamp01(age(p, a.attnAt) / 800);
  const color = attnColor(p, a);
  ctx.strokeStyle = changed > 0 && a.attnAt ? mixColor(pal.border, color, changed) : pal.border;
  ctx.lineWidth = Math.max(1, (1 + changed * 1.5) * u);
  ctx.stroke();
  if (changed > 0 && a.attnAt && !p.flat) {
    ctx.fillStyle = alpha(color, 0.12 * changed);
    rrect(ctx, r.x, r.y, r.w, r.h, 10 * u);
    ctx.fill();
  }
  // Role stripe.
  ctx.fillStyle = roleColor(pal, a.role);
  rrect(ctx, r.x, r.y + 10 * u, 4 * u, r.h - 20 * u, 2 * u);
  ctx.fill();

  const lampR = (compact ? 8 : 10) * u;
  const lx = r.x + 30 * u;
  const midY = r.y + r.h / 2;
  const nameSize = compact ? 23 : 28;
  const counters = agentCounters(s, a);
  const task = currentTask(s, a);

  // Counters (right).
  let rightW = 0;
  if (counters && (counters.hw.ahead || counters.hw.ins || counters.hw.del || counters.hw.files)) {
    const c = counterValue(p, counters.prev.ahead, counters.hw.ahead, counters.at);
    const ins = counterValue(p, counters.prev.ins, counters.hw.ins, counters.at);
    const del = counterValue(p, counters.prev.del, counters.hw.del, counters.at);
    const tick = 1 - clamp01(age(p, counters.at) / 900);
    const rx = r.x + r.w - 22 * u;
    const top = `${c} ${c === 1 ? "commit" : "commits"}`;
    const lineSize = compact ? 18 : 21;
    if (compact) {
      const dw = text(p, `−${formatCount(del)}`, rx, midY, { size: lineSize, family: p.f.mono, color: pal.err, align: "right", base: "middle" });
      const iw = text(p, `+${formatCount(ins)}`, rx - dw - 10 * u, midY, { size: lineSize, family: p.f.mono, color: pal.ok, align: "right", base: "middle" });
      const cw = text(p, top, rx - dw - iw - 24 * u, midY, { size: lineSize, family: p.f.mono, color: tick > 0 ? mixColor(pal.text1, pal.text0, tick) : pal.text1, align: "right", base: "middle" });
      rightW = dw + iw + cw + 46 * u;
    } else {
      const cw = text(p, top, rx, midY - 6 * u, { size: lineSize + 2, weight: 500, family: p.f.mono, color: tick > 0 ? mixColor(pal.text0, pal.accent, tick) : pal.text0, align: "right" });
      const dw = text(p, `−${formatCount(del)}`, rx, midY + 24 * u, { size: lineSize - 2, family: p.f.mono, color: pal.err, align: "right" });
      const iw = text(p, `+${formatCount(ins)}`, rx - dw - 12 * u, midY + 24 * u, { size: lineSize - 2, family: p.f.mono, color: pal.ok, align: "right" });
      rightW = Math.max(cw, dw + iw + 12 * u) + 34 * u;
    }
  }

  lamp(p, lx, compact ? midY : midY - 14 * u, a, lampR);
  const nx = r.x + 56 * u;
  const nameY = compact ? midY : midY - 6 * u;
  const nameW = text(p, a.name, nx, nameY, { size: nameSize, weight: 600, color: pal.text0, base: compact ? "middle" : "alphabetic", maxW: r.w * 0.36 });
  const pw = rolePill(p, a.role, nx + nameW + 12 * u, compact ? midY : nameY - nameSize * 0.34 * u, compact ? 13 : 14);
  const kindX = nx + nameW + 12 * u + (pw ? pw + 10 * u : 0);
  let afterKind = kindX;
  const kindRoom = r.x + r.w - rightW - kindX - 12 * u;
  if (a.agent && !compact && kindRoom >= measure(p, a.agent, 17, 400, p.f.mono)) afterKind += text(p, a.agent, kindX, nameY, { size: 17, family: p.f.mono, color: pal.text2 }) + 10 * u;

  const label = attnLabel(a);
  const lineText = task ? `${task.s === "doing" ? "▸" : "·"} ${task.text}` : label === "working" ? "working…" : label;
  const lineColor = a.attn === "needs" ? pal.warn : a.attn === "error" ? pal.err : task?.s === "doing" ? pal.text1 : pal.text2;
  if (compact) {
    const tx = Math.max(afterKind, kindX) + 10 * u;
    text(p, lineText, tx, midY, { size: 18, color: lineColor, base: "middle", maxW: Math.max(0, r.x + r.w - rightW - tx - 10 * u) });
  } else {
    const ty = midY + 26 * u;
    const state = a.attn === "needs" ? "NEEDS YOU · " : "";
    const sw = state ? text(p, state, nx, ty, { size: 16, weight: 600, family: p.f.mono, color: pal.warn, spacing: 0.1 }) : 0;
    text(p, lineText, nx + sw, ty, { size: 20, color: lineColor, maxW: Math.max(0, r.x + r.w - rightW - nx - sw - 12 * u) });
  }
  ctx.restore();
}

function agentsPanel(p: P, L: Layout, s: SceneState) {
  const { u, pal } = p;
  const r = L.agents;
  const agents = visibleAgents(p, s);
  const working = agents.filter((a) => a.live && a.attn === "working").length;
  const needs = agents.filter((a) => a.attn === "needs").length;
  overline(p, "TEAM", r.x, r.y + 16 * u, pal.text1);
  const meta = [`${agents.length} ${agents.length === 1 ? "AGENT" : "AGENTS"}`, working ? `${working} WORKING` : "", needs ? `${needs} NEED YOU` : ""].filter(Boolean).join(" · ");
  overline(p, meta, r.x + r.w, r.y + 16 * u, needs ? pal.warn : pal.text2, 16, "right");
  const top = r.y + 38 * u;
  const avail = r.y + r.h - top;
  if (agents.length === 0) {
    text(p, "No agents recorded yet", r.x, top + 40 * u, { size: 22, color: pal.text2 });
    return;
  }
  const gap = 10 * u;
  const minH = 58 * u;
  const maxH = (L.stacked ? 104 : 108) * u;
  const cols = Math.max(1, L.agentCols);
  let rows = agents;
  let more = 0;
  const capacity = Math.max(1, Math.floor((avail + gap) / (minH + gap))) * cols;
  if (agents.length > capacity) {
    // Keep the busiest visible: live + recently changed first, roster order otherwise.
    const ranked = [...agents].sort((a, b) => Number(b.live) - Number(a.live) || b.attnAt - a.attnAt);
    const keep = new Set(ranked.slice(0, capacity - 1).map((a) => a.slug));
    rows = agents.filter((a) => keep.has(a.slug));
    more = agents.length - rows.length;
  }
  const cells = rows.length + (more ? 1 : 0);
  const lines = Math.ceil(cells / cols);
  const rowH = Math.max(minH, Math.min(maxH, (avail - gap * (lines - 1)) / lines));
  const cellW = (r.w - gap * (cols - 1)) / cols;
  const compact = rowH < 84 * u;
  const cell = (i: number) => ({ x: r.x + (i % cols) * (cellW + gap), y: top + Math.floor(i / cols) * (rowH + gap) });
  rows.forEach((a, i) => {
    const appear = easeOut(age(p, a.joinedAt) / 500);
    const leaving = a.leftWhy === "removed" ? 1 - clamp01(age(p, a.leftAt ?? 0) / 600) : 1;
    const dx = (1 - appear) * 40 * u;
    const c = cell(i);
    agentRow(p, s, a, { x: c.x + dx, y: c.y, w: cellW, h: rowH }, compact, appear * leaving);
  });
  if (more) {
    const c = cell(rows.length);
    text(p, `+${more} more`, c.x + 20 * u, c.y + rowH / 2, { size: 20, color: pal.text2, base: "middle" });
  }
}

// ---- tasks --------------------------------------------------------------------------------------

function taskBox(p: P, x: number, y: number, size: number, t: TaskItem) {
  const { ctx, u, pal } = p;
  const a = age(p, t.at);
  const pop = t.prev !== null && a >= 0 && a < 450 ? 1 + 0.35 * Math.sin((a / 450) * Math.PI) : 1;
  const s = size * pop;
  const bx = x + (size - s) / 2;
  const by = y + (size - s) / 2;
  const c = taskColor(p, t.s);
  ctx.lineWidth = 2 * u;
  if (t.s === "done") {
    ctx.fillStyle = c;
    rrect(ctx, bx, by, s, s, 5 * u);
    ctx.fill();
    const k = t.prev !== null ? easeOut(a / 380) : 1;
    ctx.strokeStyle = pal.bg0;
    ctx.lineWidth = 2.6 * u;
    ctx.lineCap = "round";
    ctx.lineJoin = "round";
    const p1 = [bx + s * 0.24, by + s * 0.52];
    const p2 = [bx + s * 0.43, by + s * 0.7];
    const p3 = [bx + s * 0.77, by + s * 0.3];
    ctx.beginPath();
    ctx.moveTo(p1[0], p1[1]);
    if (k < 0.4) ctx.lineTo(lerp(p1[0], p2[0], k / 0.4), lerp(p1[1], p2[1], k / 0.4));
    else {
      ctx.lineTo(p2[0], p2[1]);
      const k2 = (k - 0.4) / 0.6;
      ctx.lineTo(lerp(p2[0], p3[0], k2), lerp(p2[1], p3[1], k2));
    }
    ctx.stroke();
  } else if (t.s === "doing") {
    ctx.strokeStyle = c;
    rrect(ctx, bx, by, s, s, 5 * u);
    ctx.stroke();
    const pulse = p.flat ? 0.8 : 0.55 + 0.45 * Math.sin((p.ms / 1000) * Math.PI * 2 * 0.8 + t.order);
    ctx.fillStyle = alpha(c, 0.35 + 0.5 * pulse);
    rrect(ctx, bx + s * 0.27, by + s * 0.27, s * 0.46, s * 0.46, 2.5 * u);
    ctx.fill();
  } else if (t.s === "blocked") {
    ctx.fillStyle = alpha(c, 0.2);
    rrect(ctx, bx, by, s, s, 5 * u);
    ctx.fill();
    ctx.strokeStyle = c;
    ctx.stroke();
    text(p, "!", bx + s / 2, by + s / 2 + u, { size: 16, weight: 700, family: p.f.mono, color: c, align: "center", base: "middle" });
  } else {
    ctx.strokeStyle = alpha(pal.text2, 0.9);
    rrect(ctx, bx, by, s, s, 5 * u);
    ctx.stroke();
  }
}

function tasksPanel(p: P, L: Layout, s: SceneState) {
  const { ctx, u, pal } = p;
  const r = L.tasks;
  const prog = boardProgress(s.tasks);
  overline(p, "TASKS", r.x, r.y + 16 * u, pal.text1);
  const doing = s.tasks.filter((t) => t.s === "doing").length;
  const blocked = s.tasks.filter((t) => t.s === "blocked").length;
  const meta = [`${prog.done} / ${prog.total} DONE`, doing ? `${doing} IN PROGRESS` : "", blocked ? `${blocked} BLOCKED` : ""].filter(Boolean).join(" · ");
  overline(p, meta, r.x + r.w, r.y + 16 * u, blocked ? pal.err : pal.text2, 16, "right");
  const top = r.y + 38 * u;
  const avail = r.y + r.h - top;
  if (avail < 30 * u) return;
  if (s.tasks.length === 0) {
    text(p, "The mission board has no tasks yet", r.x, top + 36 * u, { size: 21, color: pal.text2 });
    return;
  }
  const rowH = Math.max(36 * u, Math.min(54 * u, avail / s.tasks.length));
  const total = s.tasks.length * rowH;
  const maxScroll = Math.max(0, total - avail);
  const idx = (key: string | null) => (key ? s.tasks.findIndex((t) => t.key === key) : -1);
  const target = (key: string | null) => {
    const i = idx(key);
    return i < 0 ? 0 : Math.max(0, Math.min(maxScroll, i * rowH - avail / 2 + rowH / 2));
  };
  const scroll = maxScroll > 0 ? lerp(target(s.focus.prevKey), target(s.focus.key), easeInOut(age(p, s.focus.at) / 600)) : 0;

  ctx.save();
  ctx.beginPath();
  ctx.rect(r.x - 8 * u, top, r.w + 16 * u, avail);
  ctx.clip();
  const box = Math.min(24 * u, rowH * 0.55);
  s.tasks.forEach((t, i) => {
    const y = top + i * rowH - scroll;
    if (y + rowH < top || y > top + avail) return;
    const a = age(p, t.at);
    const isNew = t.prev === null && a >= 0 && a < 450;
    const appear = isNew ? easeOut(a / 450) : 1;
    ctx.save();
    ctx.globalAlpha = appear;
    const dx = (1 - appear) * 50 * u;
    const flash = t.prev !== null && a >= 0 ? 1 - clamp01(a / 700) : 0;
    if (flash > 0) {
      ctx.fillStyle = alpha(taskColor(p, t.s), 0.16 * flash);
      rrect(ctx, r.x - 6 * u + dx, y + 3 * u, r.w + 12 * u, rowH - 6 * u, 6 * u);
      ctx.fill();
    }
    taskBox(p, r.x + dx, y + (rowH - box) / 2, box, t);
    const tx = r.x + box + 16 * u + dx;
    const owners = t.o.length ? t.o.map((o) => `@${o}`).join(" ") : "";
    let ow = 0;
    if (owners && r.w > 420 * u) ow = text(p, owners, r.x + r.w, y + rowH / 2, { size: 16, family: p.f.mono, color: pal.text2, align: "right", base: "middle", maxW: r.w * 0.3 }) + 16 * u;
    const color = t.s === "done" ? pal.text2 : t.s === "blocked" ? pal.err : t.s === "doing" ? pal.text0 : pal.text1;
    text(p, t.text, tx, y + rowH / 2, { size: Math.min(22, rowH / u / 2.1), weight: t.s === "doing" ? 500 : 400, color, base: "middle", maxW: r.x + r.w - ow - tx });
    ctx.restore();
  });
  ctx.restore();
  if (maxScroll > 0 && !p.flat) {
    // Fade the clipped edges.
    const fh = 26 * u;
    if (scroll > 1) {
      const g = ctx.createLinearGradient(0, top, 0, top + fh);
      g.addColorStop(0, pal.bg0);
      g.addColorStop(1, alpha(pal.bg0, 0));
      ctx.fillStyle = g;
      ctx.fillRect(r.x - 8 * u, top, r.w + 16 * u, fh);
    }
    if (scroll < maxScroll - 1) {
      const g = ctx.createLinearGradient(0, top + avail - fh, 0, top + avail);
      g.addColorStop(0, alpha(pal.bg0, 0));
      g.addColorStop(1, pal.bg0);
      ctx.fillStyle = g;
      ctx.fillRect(r.x - 8 * u, top + avail - fh, r.w + 16 * u, fh);
    }
  }
}

// ---- ticker -------------------------------------------------------------------------------------

function speakerColor(p: P, s: SceneState, slug: string): string {
  const a = s.agents.find((x) => x.slug === slug);
  return a ? roleColor(p.pal, a.role) : slug === "you" ? p.pal.accent : p.pal.text1;
}

function ticker(p: P, L: Layout, s: SceneState) {
  const { ctx, u, pal } = p;
  const r = L.ticker;
  ctx.strokeStyle = pal.border;
  ctx.lineWidth = Math.max(1, u);
  ctx.beginPath();
  ctx.moveTo(r.x, r.y);
  ctx.lineTo(r.x + r.w, r.y);
  ctx.stroke();
  overline(p, "COMMS", r.x, r.y + 30 * u, pal.text2, 15);
  let wmW = 0;
  if (p.watermark) {
    const mark = 22 * u;
    const tw = measure(p, "gridkeeper", 17, 500, p.f.mono, 0.08);
    const x = r.x + r.w - tw;
    text(p, "gridkeeper", x, r.y + 30 * u, { size: 17, weight: 500, family: p.f.mono, color: pal.text2, spacing: 0.08 });
    ctx.save();
    ctx.globalAlpha = 0.85;
    drawMark(ctx, x - mark - 8 * u, r.y + 30 * u - mark * 0.78, mark, pal.text1, pal.accent);
    ctx.restore();
    wmW = tw + mark + 16 * u;
  }
  const lineH = 44 * u;
  const lines = L.tickerLines;
  const msgs = s.msgs.slice(-lines);
  const baseY = r.y + 30 * u + 22 * u;
  if (msgs.length === 0) {
    text(p, "comms quiet", r.x, baseY + lineH * 0.6, { size: 20, color: pal.text2, a: 0.7 });
    return;
  }
  const newest = msgs[msgs.length - 1];
  const k = easeOut(age(p, newest.t) / 420);
  const shift = (1 - k) * lineH;
  ctx.save();
  ctx.beginPath();
  ctx.rect(r.x, baseY - 6 * u, r.w, lines * lineH + 8 * u);
  ctx.clip();
  msgs.forEach((m, i) => {
    const slot = lines - msgs.length + i; // newest in the last slot
    const y = baseY + slot * lineH + lineH * 0.62 + shift;
    const isNew = i === msgs.length - 1;
    const a = isNew ? k : 1 - (msgs.length - 1 - i) * 0.22;
    const to = m.to.length === 0 ? "team" : m.to.length > 3 ? `${m.to.length} agents` : m.to.join(", ");
    let x = r.x;
    x += text(p, m.from, x, y, { size: 19, weight: 600, family: p.f.mono, color: speakerColor(p, s, m.from), a });
    x += text(p, " → ", x, y, { size: 19, family: p.f.mono, color: pal.text2, a });
    x += text(p, to, x, y, { size: 19, weight: 600, family: p.f.mono, color: m.to.length === 1 ? speakerColor(p, s, m.to[0]) : pal.text1, a, maxW: r.w * 0.3 });
    x += 16 * u;
    text(p, m.text, x, y, { size: 21, color: pal.text0, a, maxW: Math.max(0, r.x + r.w - x - (slot === 0 ? wmW + 16 * u : 0)) });
  });
  ctx.restore();
}

// ---- cards --------------------------------------------------------------------------------------

function titleCard(p: P, fade: number) {
  const { W, H, u, pal } = p;
  const tl = p.scene.tl;
  const ms = p.ms;
  const stagger = (i: number) => easeOut((ms - i * 120) / 500);
  const stacked = W / H < 1.3;
  const cx = W / 2;
  const goal = tl.final.goal ?? "Mission replay";
  const st = tl.stats;
  const top = stacked ? H * 0.3 : H * 0.27;
  p.ctx.save();
  p.ctx.globalAlpha = fade;
  drawLockup(p, cx, top - 20 * u - (1 - stagger(0)) * 20 * u, 30, stagger(0));
  overline(p, "MISSION REPLAY", cx, top + 120 * u, pal.accent, 19, "center");
  const gsize = stacked ? 74 : 84;
  p.ctx.font = font(p, 600, gsize, p.f.display);
  const lines = wrap(p.ctx, goal, W - (stacked ? 140 : 360) * u, 3);
  const k = stagger(1);
  lines.forEach((l, i) =>
    text(p, l, cx, top + (210 + i * gsize * 1.1) * u + (1 - k) * 24 * u, { size: gsize, weight: 600, family: p.f.display, color: pal.text0, align: "center", a: k }),
  );
  const y2 = top + (210 + lines.length * gsize * 1.1 + 40) * u;
  const facts = [`${st.agents} ${st.agents === 1 ? "agent" : "agents"}`, st.tasksTotal ? `${st.tasksTotal} tasks` : "", formatWall(st.wallMs)].filter(Boolean).join("  ·  ");
  text(p, facts, cx, y2, { size: 34, weight: 500, color: pal.text1, align: "center", a: stagger(2) });
  const len = Math.round(p.scene.plan.totalMs / 1000);
  text(p, `${formatClockRange(st.startT, st.endT)}  ·  replayed in ${len} s`, cx, y2 + 52 * u, { size: 22, family: p.f.mono, color: pal.text2, align: "center", a: stagger(3) });
  p.ctx.restore();
}

function endCard(p: P, fade: number, phaseMs: number) {
  const { ctx, W, H, u, pal } = p;
  const st = p.scene.tl.stats;
  const goal = p.scene.tl.final.goal ?? "Mission replay";
  const stacked = W / H < 1.3;
  const complete = st.tasksTotal > 0 && st.tasksDone === st.tasksTotal;
  const k = easeOut(phaseMs / 900);
  ctx.save();
  ctx.globalAlpha = fade;
  const top = stacked ? H * (H / W > 1.4 ? 0.2 : 0.12) : H * 0.13;
  overline(p, complete ? "MISSION COMPLETE" : "MISSION REPLAY", W / 2, top, complete ? pal.ok : pal.accent, 20, "center");
  const gsize = stacked ? 52 : 56;
  ctx.font = font(p, 600, gsize, p.f.display);
  const lines = wrap(ctx, goal, W - 220 * u, 2);
  lines.forEach((l, i) => text(p, l, W / 2, top + (78 + i * gsize * 1.12) * u, { size: gsize, weight: 600, family: p.f.display, color: pal.text0, align: "center" }));
  const gridTop = top + (78 + lines.length * gsize * 1.12 + 44) * u;
  const n = (v: number) => formatCount(Math.round(v * k));
  const tiles: { label: string; value: string; color?: string; extra?: string; extraColor?: string }[] = [
    { label: "TASKS DONE", value: st.tasksTotal ? `${n(st.tasksDone)}/${st.tasksTotal}` : "—", color: complete ? pal.ok : pal.text0 },
    { label: "COMMITS", value: n(st.commits) },
    { label: "FILES CHANGED", value: n(st.files) },
    { label: "LINES", value: `+${n(st.ins)}`, color: pal.ok, extra: ` −${n(st.del)}`, extraColor: pal.err },
    { label: "AGENTS", value: String(st.agents) },
    { label: "WALL TIME", value: formatWall(st.wallMs) },
  ];
  const cols = stacked ? 2 : 3;
  const gap = 22 * u;
  const gw = Math.min(W - 2 * (stacked ? 56 : 160) * u, stacked ? 980 * u : 1500 * u);
  const tw = (gw - gap * (cols - 1)) / cols;
  const th = (stacked ? 168 : 178) * u;
  const gx = (W - gw) / 2;
  tiles.forEach((t, i) => {
    const c = i % cols;
    const row = Math.floor(i / cols);
    const x = gx + c * (tw + gap);
    const y = gridTop + row * (th + gap);
    const appear = easeOut((phaseMs - i * 70) / 450);
    ctx.save();
    ctx.globalAlpha = fade * appear;
    ctx.fillStyle = pal.bg1;
    rrect(ctx, x, y + (1 - appear) * 16 * u, tw, th, 12 * u);
    ctx.fill();
    ctx.strokeStyle = pal.border;
    ctx.lineWidth = Math.max(1, u);
    ctx.stroke();
    const vy = y + th * 0.56 + (1 - appear) * 16 * u;
    const vsize = stacked ? 64 : 72;
    const w1 = measure(p, t.value, vsize, 600, p.f.display);
    const w2 = t.extra ? measure(p, t.extra, vsize * 0.62, 600, p.f.display) : 0;
    const sx = x + tw / 2 - (w1 + w2) / 2;
    text(p, t.value, sx, vy, { size: vsize, weight: 600, family: p.f.display, color: t.color ?? pal.text0 });
    if (t.extra) text(p, t.extra, sx + w1, vy, { size: vsize * 0.62, weight: 600, family: p.f.display, color: t.extraColor ?? pal.text1 });
    overline(p, t.label, x + tw / 2, y + th - 30 * u + (1 - appear) * 16 * u, pal.text2, 16, "center");
    ctx.restore();
  });
  const rows = Math.ceil(tiles.length / cols);
  const after = gridTop + rows * (th + gap) + 30 * u;
  const range = formatClockRange(st.startT, st.endT);
  const flight = p.scene.flightLine?.trim() || "";
  // The flight-log line gets its own row when it clears the watermark, else it joins the time range.
  const flightY = after + 52 * u;
  const floor = p.watermark ? H - (stacked ? 110 : 80) * u - 44 * u : H - 40 * u;
  const ownRow = !!flight && flightY <= floor;
  text(p, flight && !ownRow ? `${range}  ·  ${flight}` : range, W / 2, after + 10 * u, { size: 24, family: p.f.mono, color: pal.text1, align: "center", maxW: W - 80 * u });
  if (ownRow) text(p, flight, W / 2, flightY, { size: 24, weight: 500, color: pal.accent, align: "center", maxW: W - 80 * u });
  if (p.watermark) {
    const y = H - (stacked ? 110 : 80) * u;
    const msg = `Made with Gridkeeper  ·  ${REPO_URL}`;
    const tw2 = measure(p, msg, 24, 500);
    const mark = 34 * u;
    const x = W / 2 - (tw2 + mark + 14 * u) / 2;
    drawMark(ctx, x, y - mark * 0.8, mark, pal.text0, pal.accent);
    text(p, msg, x + mark + 14 * u, y, { size: 24, weight: 500, color: pal.text1 });
  }
  ctx.restore();
}

// ---- frame --------------------------------------------------------------------------------------

function mainScene(p: P, s: SceneState, clock: SceneClock, fade: number) {
  const L = layout(p, s);
  p.ctx.save();
  p.ctx.globalAlpha = fade;
  header(p, L, s, clock);
  progressBar(p, L, s);
  agentsPanel(p, L, s);
  tasksPanel(p, L, s);
  ticker(p, L, s);
  p.ctx.restore();
}

/** Draw the frame at video time `sceneMs` (0 … plan.totalMs). */
export function paintFrame(ctx: Ctx, scene: ReplayScene, sceneMs: number, opts: PaintOptions): void {
  const W = opts.width;
  const H = opts.height;
  const p: P = { ctx, W, H, u: Math.min(W, H) / 1080, pal: opts.palette, f: opts.fonts ?? REPLAY_FONTS, flat: !!opts.flat, watermark: opts.watermark, ms: sceneMs, scene };
  const clock = sceneClock(scene.plan, sceneMs);
  ctx.save();
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  ctx.globalAlpha = 1;
  background(p);
  const XF = 320;
  if (clock.phase === "title") {
    const out = 1 - easeInOut((clock.phaseMs - (clock.phaseLen - XF)) / XF);
    titleCard(p, out);
  } else if (clock.phase === "main") {
    const fadeIn = easeInOut(clock.phaseMs / XF);
    const fadeOut = 1 - easeInOut((clock.phaseMs - (clock.phaseLen - XF)) / XF);
    mainScene(p, stateAt(scene.tl, clock.real), clock, Math.min(fadeIn, fadeOut));
  } else {
    endCard(p, easeInOut(clock.phaseMs / XF), clock.phaseMs);
  }
  ctx.restore();
}

/** Fonts the painter uses; await before the first frame so canvas text never falls back mid-video. */
export async function loadReplayFonts(timeoutMs = 2500): Promise<void> {
  if (typeof document === "undefined" || !document.fonts) return;
  const loads = [
    '400 20px "Geist Variable"',
    '600 20px "Geist Variable"',
    '500 20px "Geist Mono Variable"',
    '600 20px "Geist Mono Variable"',
    '600 20px "Space Grotesk Variable"',
  ].map((f) => document.fonts.load(f).catch(() => []));
  await Promise.race([Promise.all(loads), new Promise((r) => setTimeout(r, timeoutMs))]);
}
