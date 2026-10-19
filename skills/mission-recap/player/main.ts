/// <reference types="vite/client" />
// Mission recap player: the page recap.mjs writes (one self-contained HTML file, works offline from
// file://). Reads the events JSON from <script id="recap-data">, paints the timelapse with Gridkeeper's
// own replay renderer (src/replay/*), and exports MP4 / WebM / GIF as a download.
//
// Built into ../scripts/player.js (one IIFE, fonts and the GIF worker inlined):
//   npx vite build --config skills/mission-recap/player/vite.config.ts
//
// Headless use (recap.mjs --mp4 / --gif drives this over the DevTools protocol):
//   window.GridkeeperRecap.ready                  resolves once fonts are in and the first frame painted
//   window.GridkeeperRecap.render("video"|"gif")  -> { size, mime, ext }
//   window.GridkeeperRecap.chunk(offset, size)    -> base64 slice of the last result

import css from "./player.css?inline";
import geistLatin from "@fontsource-variable/geist/files/geist-latin-wght-normal.woff2";
import geistLatinExt from "@fontsource-variable/geist/files/geist-latin-ext-wght-normal.woff2";
import geistMono from "@fontsource-variable/geist-mono/files/geist-mono-latin-wght-normal.woff2";
import grotesk from "@fontsource-variable/space-grotesk/files/space-grotesk-latin-wght-normal.woff2";
import { goalSlug, toEvent, type ReplayEvent } from "../../../src/replay/events";
import { paletteFromTheme, type ReplayPalette } from "../../../src/replay/palette";
import { ASPECTS, drawMark, loadReplayFonts, makeScene, paintFrame, REPO_URL, type Aspect, type ReplayScene } from "../../../src/replay/render";
import { formatClockRange, formatCount, formatWall, LENGTHS, type ReplayLength } from "../../../src/replay/timeline";
import { DEFAULT_THEME_ID, getTheme, THEMES } from "../../../src/theme/themes";
import { ExportCancelled, exportGif, exportVideo, gifSize, pickVideoType, type ExportProgress, type ExportResult } from "./export";

interface RecapData {
  format?: number;
  source?: "git" | "recording";
  goal?: string | null;
  baseName?: string;
  options?: { aspect?: string; length?: number; watermark?: boolean; theme?: string };
  events?: unknown[];
}

type Kind = "video" | "gif";

// ---- fonts (inlined: the page never fetches anything) -------------------------------------------

const LATIN = "U+0000-00FF,U+0131,U+0152-0153,U+02BB-02BC,U+02C6,U+02DA,U+02DC,U+0304,U+0308,U+0329,U+2000-206F,U+20AC,U+2122,U+2191,U+2193,U+2212,U+2215,U+FEFF,U+FFFD";
const LATIN_EXT = "U+0100-02BA,U+02BD-02C5,U+02C7-02CC,U+02CE-02D7,U+02DD-02FF,U+0304,U+0308,U+0329,U+1D00-1DBF,U+1E00-1E9F,U+1EF2-1EFF,U+2020,U+20A0-20AB,U+20AD-20C0,U+2113,U+2C60-2C7F,U+A720-A7FF";

function registerFonts() {
  if (typeof FontFace === "undefined" || !document.fonts) return;
  const faces: [string, string, string, string][] = [
    ["Geist Variable", geistLatin, "100 900", LATIN],
    ["Geist Variable", geistLatinExt, "100 900", LATIN_EXT],
    ["Geist Mono Variable", geistMono, "100 900", LATIN],
    ["Space Grotesk Variable", grotesk, "300 700", LATIN],
  ];
  for (const [family, url, weight, unicodeRange] of faces) {
    try {
      document.fonts.add(new FontFace(family, `url(${url}) format("woff2")`, { weight, style: "normal", unicodeRange }));
    } catch {
      /* system fallback fonts */
    }
  }
}

// ---- data ---------------------------------------------------------------------------------------

function readData(): RecapData {
  try {
    const raw = document.getElementById("recap-data")?.textContent ?? "";
    const v = JSON.parse(raw) as RecapData;
    return v && typeof v === "object" ? v : {};
  } catch {
    return {};
  }
}

const isAspect = (v: unknown): v is Aspect => typeof v === "string" && v in ASPECTS;
const isLength = (v: unknown): v is ReplayLength => (LENGTHS as readonly number[]).includes(v as number);

// ---- tiny DOM helper ----------------------------------------------------------------------------

type Attrs = Record<string, string | number | boolean | null | undefined | ((e: Event) => void)>;

function h<K extends keyof HTMLElementTagNameMap>(tag: K, attrs: Attrs = {}, ...kids: (Node | string | null | undefined | false)[]): HTMLElementTagNameMap[K] {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (v === null || v === undefined || v === false) continue;
    if (typeof v === "function") el.addEventListener(k.replace(/^on/, ""), v as EventListener);
    else if (k === "class") el.className = String(v);
    else if (v === true) el.setAttribute(k, "");
    else el.setAttribute(k, String(v));
  }
  for (const c of kids) if (c !== null && c !== undefined && c !== false) el.append(c);
  return el;
}

const SVG_NS = "http://www.w3.org/2000/svg";
function icon(path: string): SVGSVGElement {
  const svg = document.createElementNS(SVG_NS, "svg");
  svg.setAttribute("viewBox", "0 0 24 24");
  svg.setAttribute("aria-hidden", "true");
  const p = document.createElementNS(SVG_NS, "path");
  p.setAttribute("d", path);
  svg.append(p);
  return svg;
}
const PLAY = "M8 5.5v13a1 1 0 0 0 1.52.85l10.4-6.5a1 1 0 0 0 0-1.7L9.52 4.65A1 1 0 0 0 8 5.5z";
const PAUSE = "M7 5h3.5v14H7zM13.5 5H17v14h-3.5z";
const RESTART = "M12 5V2L7 6l5 4V7a5 5 0 1 1-5 5H5a7 7 0 1 0 7-7z";

const fmtSec = (ms: number) => `${Math.floor(ms / 60000)}:${String(Math.floor((ms % 60000) / 1000)).padStart(2, "0")}`;

function fmtBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(0)} KB`;
  return `${(n / 1024 / 1024).toFixed(1)} MB`;
}

function download(blob: Blob, name: string) {
  const url = URL.createObjectURL(blob);
  const a = h("a", { href: url, download: name, style: "display:none" });
  document.body.append(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 120_000);
}

function blobBase64(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const r = new FileReader();
    r.onload = () => {
      const s = String(r.result ?? "");
      resolve(s.slice(s.indexOf(",") + 1));
    };
    r.onerror = () => reject(r.error ?? new Error("read failed"));
    r.readAsDataURL(blob);
  });
}

// ---- app ----------------------------------------------------------------------------------------

function setChromeColors(p: ReplayPalette) {
  const s = document.documentElement.style;
  const vars: Record<string, string> = {
    "--bg0": p.bg0,
    "--bg1": p.bg1,
    "--bg2": p.bg2,
    "--bg3": p.bg3,
    "--line": p.border,
    "--line2": p.borderStrong,
    "--t0": p.text0,
    "--t1": p.text1,
    "--t2": p.text2,
    "--accent": p.accent,
    "--accent2": p.accent2,
    "--ok": p.ok,
    "--warn": p.warn,
    "--err": p.err,
  };
  for (const [k, v] of Object.entries(vars)) s.setProperty(k, v);
}

function main() {
  const style = document.createElement("style");
  style.textContent = css;
  document.head.append(style);
  registerFonts();
  const chrome = paletteFromTheme(getTheme(DEFAULT_THEME_ID));
  setChromeColors(chrome);

  const data = readData();
  const events = (Array.isArray(data.events) ? data.events : [])
    .map(toEvent)
    .filter((e): e is ReplayEvent => !!e)
    .sort((a, b) => a.t - b.t);
  const root = document.getElementById("recap-root") ?? document.body.appendChild(h("div", { id: "recap-root" }));
  root.textContent = "";

  const opt = data.options ?? {};
  const state = {
    aspect: (isAspect(opt.aspect) ? opt.aspect : "landscape") as Aspect,
    length: (isLength(opt.length) ? opt.length : 30) as ReplayLength,
    watermark: opt.watermark !== false,
    theme: typeof opt.theme === "string" ? getTheme(opt.theme).id : DEFAULT_THEME_ID,
  };
  const baseName = (data.baseName && /^[a-z0-9-]+$/.test(data.baseName) ? data.baseName : null) ?? goalSlug(data.goal ?? null);

  let readyResolve: () => void = () => {};
  const ready = new Promise<void>((r) => (readyResolve = r));

  if (events.length === 0) {
    root.append(
      h("div", { class: "empty" }, h("h1", {}, "Nothing to replay"), h("p", {}, "This recap has no events. Re-run recap.mjs with an earlier --since.")),
    );
    readyResolve();
    return;
  }

  let scene: ReplayScene = makeScene(events, state.length);
  let palette = paletteFromTheme(getTheme(state.theme));
  const video = pickVideoType();
  const videoLabel = video?.ext === "mp4" ? "MP4" : "WebM";
  const stats = () => scene.tl.stats;

  // ---- header ----
  const mark = h("canvas", { class: "mark", width: 64, height: 64, "aria-hidden": "true" });
  const goalText = scene.tl.final.goal ?? data.goal ?? "Mission recap";
  const st0 = stats();
  const metaBits = [
    `${st0.agents} ${st0.agents === 1 ? "agent" : "agents"}`,
    st0.commits ? `${formatCount(st0.commits)} ${st0.commits === 1 ? "commit" : "commits"}` : "",
    st0.tasksTotal ? `${st0.tasksDone}/${st0.tasksTotal} tasks` : "",
    `${formatClockRange(st0.startT, st0.endT)} (${formatWall(st0.wallMs)})`,
  ].filter(Boolean);
  const header = h(
    "header",
    { class: "top" },
    h("div", { class: "brand" }, mark, h("span", {}, "Mission recap")),
    h("h1", { class: "goal" }, goalText),
    h("p", { class: "meta" }, metaBits.join("  ·  ")),
  );

  // ---- stage + transport ----
  const canvas = h("canvas", { class: "preview", "aria-label": "Recap preview" });
  const overlay = h("button", { class: "overlay", type: "button", "aria-label": "Play" }, icon(PLAY));
  const stage = h("div", { class: "stage" }, canvas, overlay);
  const playBtn = h("button", { class: "play", type: "button", "aria-label": "Play" }, icon(PLAY));
  const slider = h("input", { class: "scrub", type: "range", min: 0, max: scene.plan.totalMs, step: 1, value: 0, "aria-label": "Position" });
  const timeLabel = h("span", { class: "time" }, "0:00 / 0:00");
  const transport = h("div", { class: "transport" }, playBtn, slider, timeLabel);

  // ---- panel ----
  const seg = <T extends string | number>(name: string, items: { value: T; label: string }[], current: T, onPick: (v: T) => void) => {
    const btns = items.map((it) =>
      h("button", { type: "button", class: "seg-btn", role: "radio", "aria-checked": String(it.value === current), "data-v": String(it.value) }, it.label),
    );
    btns.forEach((b, i) =>
      b.addEventListener("click", () => {
        btns.forEach((x) => x.setAttribute("aria-checked", String(x === b)));
        onPick(items[i].value);
      }),
    );
    return h("div", { class: "seg", role: "radiogroup", "aria-label": name }, ...btns);
  };
  const field = (label: string, control: Node) => h("div", { class: "field" }, h("div", { class: "label" }, label), control);

  const aspectSeg = seg(
    "Format",
    (Object.keys(ASPECTS) as Aspect[]).map((a) => ({ value: a, label: ASPECTS[a].label })),
    state.aspect,
    (v) => {
      state.aspect = v;
      onLayoutChange();
    },
  );
  const lengthSeg = seg(
    "Length",
    LENGTHS.map((n) => ({ value: n, label: `${n} s` })),
    state.length,
    (v) => {
      state.length = v;
      rebuildScene();
    },
  );
  const themeSel = h("select", { class: "select", "aria-label": "Theme" }, ...THEMES.map((t) => h("option", { value: t.id, selected: t.id === state.theme }, t.name)));
  themeSel.addEventListener("change", () => {
    state.theme = themeSel.value;
    palette = paletteFromTheme(getTheme(state.theme));
    if (!raf) paint(time);
  });
  const wmInput = h("input", { type: "checkbox", checked: state.watermark });
  wmInput.addEventListener("change", () => {
    state.watermark = wmInput.checked;
    if (!raf) paint(time);
  });
  const wmToggle = h(
    "label",
    { class: "switch" },
    wmInput,
    h("span", { class: "track", "aria-hidden": "true" }),
    h("span", { class: "switch-text" }, h("span", {}, "Watermark"), h("small", {}, "Made with Gridkeeper on the end card")),
  );

  const videoBtn = h("button", { type: "button", class: "btn primary", disabled: !video }, video ? `Export ${videoLabel}` : "No video export");
  const gifBtn = h("button", { type: "button", class: "btn" }, "Export GIF");
  const hint = h("p", { class: "hint" });
  const barFill = h("span");
  const progLabel = h("span", { class: "prog-label" });
  const cancelBtn = h("button", { type: "button", class: "link" }, "Cancel");
  const progress = h("div", { class: "progress", hidden: true }, h("div", { class: "bar" }, barFill), h("div", { class: "prog-row" }, progLabel, cancelBtn));
  const status = h("p", { class: "status", role: "status", "aria-live": "polite" });

  const st = stats();
  const fact = (k: string, v: Node | string) => [h("dt", {}, k), h("dd", {}, v)];
  const lines = h("span", {}, h("span", { class: "plus" }, `+${formatCount(st.ins)}`), " ", h("span", { class: "minus" }, `−${formatCount(st.del)}`));
  const facts = h(
    "dl",
    { class: "facts" },
    ...fact("Agents", String(st.agents)),
    ...fact("Tasks done", st.tasksTotal ? `${st.tasksDone} / ${st.tasksTotal}` : "no board"),
    ...fact("Commits", formatCount(st.commits)),
    ...fact("Lines", lines),
    ...fact("Wall time", formatWall(st.wallMs)),
  );
  const fromRecording = data.source === "recording";
  const privacy = h(
    "p",
    { class: "privacy" },
    fromRecording
      ? "Made from a Gridkeeper mission recording: task changes, agent states, commit counts and short messages. No terminal output, paths or e-mail addresses."
      : "Made from git history on this machine: branch names, commit times, commit and line counts, commit subjects (file names removed) and the task board. No file contents, diffs, paths or e-mail addresses.",
    " This page works offline and makes no network requests.",
  );

  const panel = h(
    "aside",
    { class: "panel" },
    field("Format", aspectSeg),
    field("Length", lengthSeg),
    field("Theme", themeSel),
    wmToggle,
    h("div", { class: "export" }, h("div", { class: "btn-row" }, videoBtn, gifBtn), hint, progress, status),
    h("div", { class: "section-label" }, "In this recap"),
    facts,
    privacy,
  );

  const footer = h(
    "footer",
    { class: "foot" },
    "Made with ",
    h("a", { href: `https://${REPO_URL}`, target: "_blank", rel: "noopener noreferrer" }, "Gridkeeper"),
    ` · ${REPO_URL}`,
  );

  root.append(h("div", { class: "app" }, header, h("main", { class: "body" }, h("section", { class: "stage-col" }, stage, transport), panel), footer));

  const mctx = mark.getContext("2d");
  if (mctx) drawMark(mctx, 4, 4, 56, chrome.text0, chrome.accent);

  // ---- preview -------------------------------------------------------------------------------------
  let time = 0;
  let raf = 0;
  let fontsReady = false;
  let exporting: { abort: AbortController; kind: Kind } | null = null;

  const setPlayIcon = (on: boolean) => {
    const atEnd = !on && time >= scene.plan.totalMs - 50;
    playBtn.replaceChildren(icon(on ? PAUSE : atEnd ? RESTART : PLAY));
    playBtn.setAttribute("aria-label", on ? "Pause" : atEnd ? "Replay" : "Play");
    overlay.hidden = on || exporting !== null;
  };

  function sizeCanvas() {
    const a = ASPECTS[state.aspect];
    const dpr = Math.min(2, Math.max(1, window.devicePixelRatio || 1));
    const k = 0.5 * dpr;
    const w = Math.round(a.w * k);
    const hh = Math.round(a.h * k);
    if (canvas.width !== w || canvas.height !== hh) {
      canvas.width = w;
      canvas.height = hh;
    }
    // Fit the stage box (and the window height on wide screens).
    const boxW = stage.clientWidth || 640;
    const top = stage.getBoundingClientRect().top + window.scrollY;
    const wide = window.matchMedia("(min-width: 980px)").matches;
    const maxH = wide ? Math.max(240, window.innerHeight - top - 96) : Math.max(220, window.innerHeight * 0.72);
    let cw = boxW;
    let ch = (cw * a.h) / a.w;
    if (ch > maxH) {
      ch = maxH;
      cw = (ch * a.w) / a.h;
    }
    canvas.style.width = `${Math.round(cw)}px`;
    canvas.style.height = `${Math.round(ch)}px`;
    stage.style.height = `${Math.round(ch)}px`;
  }

  function paint(ms: number) {
    const ctx = canvas.getContext("2d", { alpha: false });
    if (!ctx) return;
    time = Math.max(0, Math.min(scene.plan.totalMs, ms));
    paintFrame(ctx, scene, time, { width: canvas.width, height: canvas.height, palette, watermark: state.watermark });
    slider.value = String(Math.round(time));
    timeLabel.textContent = `${fmtSec(time)} / ${fmtSec(scene.plan.totalMs)}`;
  }

  function stop() {
    cancelAnimationFrame(raf);
    raf = 0;
    setPlayIcon(false);
  }

  function play() {
    if (!fontsReady || exporting) return;
    cancelAnimationFrame(raf);
    const from = time >= scene.plan.totalMs - 50 ? 0 : time;
    const t0 = performance.now() - from;
    const tick = () => {
      const ms = performance.now() - t0;
      if (ms >= scene.plan.totalMs) {
        paint(scene.plan.totalMs);
        raf = 0;
        setPlayIcon(false);
        return;
      }
      paint(ms);
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    setPlayIcon(true);
  }

  const toggle = () => (raf ? stop() : play());

  function updateHint() {
    const a = ASPECTS[state.aspect];
    const g = gifSize(state.aspect);
    const v = video ? `${videoLabel} ${a.w}×${a.h}, records in real time (${state.length} s); keep this tab in front.` : "This browser cannot record canvas video; use Chrome, Edge or Firefox for MP4/WebM.";
    hint.textContent = `${v} GIF ${g.w}×${g.h}, 12.5 fps.`;
  }

  function rebuildScene() {
    const ratio = scene.plan.totalMs ? time / scene.plan.totalMs : 0;
    scene = makeScene(events, state.length);
    slider.max = String(scene.plan.totalMs);
    updateHint();
    if (raf) {
      stop();
      time = ratio * scene.plan.totalMs;
      play();
    } else paint(ratio * scene.plan.totalMs);
  }

  function onLayoutChange() {
    sizeCanvas();
    updateHint();
    if (!raf) paint(time);
  }

  overlay.addEventListener("click", play);
  playBtn.addEventListener("click", toggle);
  canvas.addEventListener("click", toggle);
  slider.addEventListener("input", () => {
    stop();
    paint(Number(slider.value));
  });
  window.addEventListener("resize", () => {
    sizeCanvas();
    if (!raf) paint(time);
  });
  document.addEventListener("keydown", (e) => {
    const tag = (e.target as HTMLElement | null)?.tagName;
    if (exporting || e.altKey || e.ctrlKey || e.metaKey || tag === "INPUT" || tag === "SELECT" || tag === "TEXTAREA") return;
    if (e.key === " " && tag !== "BUTTON") {
      e.preventDefault();
      toggle();
    } else if (e.key === "ArrowLeft" || e.key === "ArrowRight") {
      e.preventDefault();
      stop();
      paint(time + (e.key === "ArrowLeft" ? -1000 : 1000));
    } else if (e.key === "Home" || e.key === "End") {
      e.preventDefault();
      stop();
      paint(e.key === "Home" ? 0 : scene.plan.totalMs);
    }
  });

  // ---- export --------------------------------------------------------------------------------------
  const controls = [videoBtn, gifBtn, themeSel, wmInput, ...aspectSeg.querySelectorAll("button"), ...lengthSeg.querySelectorAll("button")] as (HTMLButtonElement | HTMLInputElement | HTMLSelectElement)[];
  let lastResult: ExportResult | null = null;
  let lastLogged = -1;

  function setBusy(kind: Kind | null) {
    for (const c of controls) c.disabled = kind !== null || (c === videoBtn && !video);
    progress.hidden = kind === null;
    root.classList.toggle("is-exporting", kind !== null);
    setPlayIcon(false);
  }

  function onProgress(kind: Kind, p: ExportProgress) {
    barFill.style.width = `${Math.round(p.fraction * 100)}%`;
    progLabel.textContent =
      p.phase === "encode"
        ? kind === "gif"
          ? "Finishing the GIF…"
          : "Finishing the video…"
        : kind === "gif"
          ? `Encoding GIF… ${Math.round(p.fraction * 100)}%`
          : `Recording in real time… ${fmtSec(p.fraction * scene.plan.totalMs)} / ${fmtSec(scene.plan.totalMs)}`;
    const pct = Math.floor(p.fraction * 20) * 5;
    if (pct !== lastLogged) {
      lastLogged = pct;
      console.info("[recap]", p.phase, pct);
    }
  }

  async function render(kind: Kind): Promise<ExportResult> {
    if (exporting) throw new Error("An export is already running");
    await ready;
    stop();
    const abort = new AbortController();
    exporting = { abort, kind };
    lastLogged = -1;
    status.textContent = "";
    status.classList.remove("is-error");
    setBusy(kind);
    onProgress(kind, { phase: "render", fraction: 0 });
    try {
      const settings = { aspect: state.aspect, palette, watermark: state.watermark };
      const res = kind === "gif" ? await exportGif(scene, settings, abort.signal, (p) => onProgress(kind, p)) : await exportVideo(scene, settings, abort.signal, (p) => onProgress(kind, p));
      lastResult = res;
      return res;
    } finally {
      exporting = null;
      setBusy(null);
      paint(time);
    }
  }

  async function exportAndSave(kind: Kind) {
    try {
      const res = await render(kind);
      const name = `${baseName}-recap.${res.ext}`;
      download(res.blob, name);
      status.textContent = `Saved ${name} (${fmtBytes(res.blob.size)}).`;
    } catch (e) {
      if (e instanceof ExportCancelled) status.textContent = "Export cancelled.";
      else {
        status.textContent = `Export failed: ${e instanceof Error ? e.message : String(e)}`;
        status.classList.add("is-error");
      }
    }
  }

  videoBtn.addEventListener("click", () => void exportAndSave("video"));
  gifBtn.addEventListener("click", () => void exportAndSave("gif"));
  cancelBtn.addEventListener("click", () => exporting?.abort.abort());

  // ---- headless API ----------------------------------------------------------------------------------
  const api = {
    ready,
    info: () => ({ goal: goalText, totalMs: scene.plan.totalMs, video: video?.mime ?? null, aspect: state.aspect, stats: stats() }),
    async render(kind: Kind) {
      const res = await render(kind);
      return { size: res.blob.size, mime: res.mime, ext: res.ext };
    },
    async chunk(offset: number, size: number) {
      if (!lastResult) throw new Error("nothing rendered yet");
      return blobBase64(lastResult.blob.slice(offset, offset + size));
    },
  };
  (window as unknown as { GridkeeperRecap: typeof api }).GridkeeperRecap = api;

  // ---- start -------------------------------------------------------------------------------------------
  updateHint();
  sizeCanvas();
  setPlayIcon(false);
  void loadReplayFonts().then(() => {
    fontsReady = true;
    sizeCanvas();
    const reduced = window.matchMedia?.("(prefers-reduced-motion: reduce)").matches;
    const headless = /HeadlessChrome/.test(navigator.userAgent);
    if (reduced || headless) paint(scene.plan.titleMs + scene.plan.mainMs * 0.6);
    else {
      paint(0);
      play();
    }
    readyResolve();
  });
}

if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", main);
else main();
