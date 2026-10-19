// Mission replay export — no external tools (no ffmpeg).
//
// Video: frames are painted onto a canvas in REAL time and captured with canvas.captureStream(30) +
// MediaRecorder (MP4/H.264 when the WebView supports it — Chromium ≥ 126 does — else WebM VP9/VP8).
// MediaRecorder cannot run faster than real time, so a 30 s video takes 30 s to render.
// GIF: frames are painted as fast as the encoder keeps up (12.5 fps, at most 960 px wide) and encoded by
// the pure-TS GIF89a encoder in a module worker (main-thread fallback when a worker can't start).
//
// Saving: the native save dialog runs in Rust (`replay_save_dialog`) BEFORE rendering, so the user never
// waits 30 s for a dialog; the bytes then travel as a raw IPC body (`replay_save_file`) and are written
// only to the path that dialog returned.

import { t } from "../i18n";
import { errorMessage, ipc } from "../lib/ipc";
import type { ReplayExportKind } from "../lib/types";
import { parseColor } from "../theme/themes";
import { createGifSession, delaySchedule } from "./gif";
import type { GifWorkerIn, GifWorkerOut } from "./gif.worker";
import { paletteColors } from "./palette";
import { ASPECTS, FPS, loadReplayFonts, paintFrame, type Aspect, type PaintOptions, type ReplayScene } from "./render";

export const GIF_FPS = 12.5;
export const GIF_MAX_W = 960;

export interface ExportSettings {
  aspect: Aspect;
  palette: PaintOptions["palette"];
  watermark: boolean;
}

export interface ExportProgress {
  phase: "render" | "encode" | "save";
  /** 0..1 */
  fraction: number;
}

export class ExportCancelled extends Error {
  constructor() {
    super("Export cancelled");
    this.name = "ExportCancelled";
  }
}

// ---- video --------------------------------------------------------------------------------------

const VIDEO_TYPES: { mime: string; ext: "mp4" | "webm" }[] = [
  { mime: "video/mp4;codecs=avc1.640028", ext: "mp4" },
  { mime: "video/mp4;codecs=avc1.4d0028", ext: "mp4" },
  { mime: "video/mp4;codecs=avc1", ext: "mp4" },
  { mime: "video/mp4", ext: "mp4" },
  { mime: "video/webm;codecs=vp9", ext: "webm" },
  { mime: "video/webm;codecs=vp8", ext: "webm" },
  { mime: "video/webm", ext: "webm" },
];

/** Best MediaRecorder type this WebView can record from a canvas; null when video export is impossible. */
export function pickVideoType(): { mime: string; ext: "mp4" | "webm" } | null {
  if (typeof MediaRecorder === "undefined" || typeof HTMLCanvasElement === "undefined" || !("captureStream" in HTMLCanvasElement.prototype)) return null;
  for (const t of VIDEO_TYPES) {
    try {
      if (MediaRecorder.isTypeSupported(t.mime)) return t;
    } catch {
      /* keep looking */
    }
  }
  return null;
}

function checkAbort(signal: AbortSignal) {
  if (signal.aborted) throw new ExportCancelled();
}

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/** Render the whole replay in real time into a video. */
export async function renderVideo(scene: ReplayScene, s: ExportSettings, signal: AbortSignal, onProgress: (p: ExportProgress) => void): Promise<{ bytes: Uint8Array; mime: string }> {
  const type = pickVideoType();
  if (!type) throw new Error(t("replay.errNoVideo"));
  const { w: W, h: H } = ASPECTS[s.aspect];
  await loadReplayFonts();
  checkAbort(signal);
  const canvas = document.createElement("canvas");
  canvas.width = W;
  canvas.height = H;
  // Attached (some engines only capture document canvases) but invisible and inert.
  canvas.setAttribute("aria-hidden", "true");
  canvas.style.cssText = "position:fixed;left:0;top:0;width:2px;height:2px;opacity:0.01;pointer-events:none;z-index:-1";
  document.body.appendChild(canvas);
  const ctx = canvas.getContext("2d", { alpha: false });
  if (!ctx) {
    canvas.remove();
    throw new Error(t("replay.errCanvas"));
  }
  const opts: PaintOptions = { width: W, height: H, palette: s.palette, watermark: s.watermark };
  paintFrame(ctx, scene, 0, opts);
  const stream = canvas.captureStream(FPS);
  const track = stream.getVideoTracks()[0] as (MediaStreamTrack & { requestFrame?: () => void }) | undefined;
  const bitrate = Math.round(Math.min(12e6, Math.max(2.5e6, W * H * FPS * 0.1)));
  const rec = new MediaRecorder(stream, { mimeType: type.mime, videoBitsPerSecond: bitrate });
  const chunks: Blob[] = [];
  rec.ondataavailable = (e) => {
    if (e.data && e.data.size > 0) chunks.push(e.data);
  };
  const stopped = new Promise<void>((resolve, reject) => {
    rec.onstop = () => resolve();
    rec.onerror = (e) => reject(new Error(`MediaRecorder failed: ${String((e as unknown as { error?: unknown }).error ?? "unknown error")}`));
  });
  const cleanup = () => {
    for (const t of stream.getTracks()) t.stop();
    canvas.remove();
  };
  try {
    rec.start(1000);
    const total = scene.plan.totalMs;
    const frameMs = 1000 / FPS;
    const t0 = performance.now();
    let frame = 0;
    for (;;) {
      if (signal.aborted) {
        rec.stop();
        await stopped.catch(() => {});
        throw new ExportCancelled();
      }
      const elapsed = performance.now() - t0;
      if (elapsed >= total) break;
      // Time comes from the wall clock, not the frame count: a late timer never stretches the video.
      paintFrame(ctx, scene, elapsed, opts);
      track?.requestFrame?.();
      onProgress({ phase: "render", fraction: elapsed / total });
      frame++;
      const next = t0 + frame * frameMs;
      await sleep(Math.max(0, next - performance.now()));
    }
    paintFrame(ctx, scene, total, opts);
    track?.requestFrame?.();
    await sleep(frameMs * 2);
    rec.stop();
    await stopped;
    onProgress({ phase: "encode", fraction: 1 });
    const blob = new Blob(chunks, { type: type.mime });
    if (blob.size === 0) throw new Error(t("replay.errNoData"));
    return { bytes: new Uint8Array(await blob.arrayBuffer()), mime: type.mime };
  } finally {
    if (rec.state !== "inactive") {
      try {
        rec.stop();
      } catch {
        /* already stopped */
      }
    }
    cleanup();
  }
}

// ---- GIF ----------------------------------------------------------------------------------------

export function gifSize(aspect: Aspect): { w: number; h: number } {
  const { w, h } = ASPECTS[aspect];
  const scale = aspect === "landscape" ? GIF_MAX_W / w : aspect === "square" ? 720 / w : 540 / w;
  return { w: Math.round(w * scale), h: Math.round(h * scale) };
}

type Ctx2D = CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D;

function gifCanvas(w: number, h: number): { ctx: Ctx2D; dispose: () => void } {
  if (typeof OffscreenCanvas !== "undefined") {
    const c = new OffscreenCanvas(w, h);
    const ctx = c.getContext("2d", { willReadFrequently: true, alpha: false }) as OffscreenCanvasRenderingContext2D | null;
    if (ctx) return { ctx, dispose: () => {} };
  }
  const c = document.createElement("canvas");
  c.width = w;
  c.height = h;
  const ctx = c.getContext("2d", { willReadFrequently: true, alpha: false });
  if (!ctx) throw new Error(t("replay.errCanvas"));
  return { ctx, dispose: () => c.remove() };
}

interface Encoder {
  init(width: number, height: number, samples: Uint8ClampedArray[], seeds: [number, number, number][]): Promise<void>;
  frame(rgba: Uint8ClampedArray, delay: number): Promise<void>;
  finish(): Promise<Uint8Array>;
  dispose(): void;
}

/** Worker-backed encoder; at most `window` frames in flight (bounded memory). */
function workerEncoder(window = 3): Encoder | null {
  let worker: Worker;
  try {
    worker = new Worker(new URL("./gif.worker.ts", import.meta.url), { type: "module" });
  } catch {
    return null;
  }
  let failed: Error | null = null;
  const waiters: { resolve: (m: GifWorkerOut) => void; reject: (e: Error) => void }[] = [];
  let inflight = 0;
  let ackWaiter: (() => void) | null = null;
  worker.onmessage = (e: MessageEvent<GifWorkerOut>) => {
    const m = e.data;
    if (m.type === "ack") {
      inflight--;
      ackWaiter?.();
      ackWaiter = null;
      return;
    }
    if (m.type === "error") {
      failed = new Error(m.message);
      ackWaiter?.();
      for (const w of waiters.splice(0)) w.reject(failed);
      return;
    }
    waiters.shift()?.resolve(m);
  };
  worker.onerror = (e) => {
    failed = new Error(e.message || "GIF worker failed to start");
    ackWaiter?.();
    for (const w of waiters.splice(0)) w.reject(failed);
  };
  const post = (m: GifWorkerIn, transfer: Transferable[] = []) => worker.postMessage(m, transfer);
  const reply = () =>
    new Promise<GifWorkerOut>((resolve, reject) => {
      if (failed) reject(failed);
      else waiters.push({ resolve, reject });
    });
  return {
    async init(width, height, samples, seeds) {
      const bufs = samples.map((s) => s.buffer as ArrayBuffer);
      const r = reply();
      post({ type: "init", width, height, samples: bufs, seeds }, bufs);
      await r;
    },
    async frame(rgba, delay) {
      while (inflight >= window && !failed) await new Promise<void>((r) => (ackWaiter = r));
      if (failed) throw failed;
      inflight++;
      const buf = rgba.buffer as ArrayBuffer;
      post({ type: "frame", rgba: buf, delay }, [buf]);
    },
    async finish() {
      while (inflight > 0 && !failed) await new Promise<void>((r) => (ackWaiter = r));
      if (failed) throw failed;
      const r = reply();
      post({ type: "finish" });
      const m = await r;
      if (m.type !== "done") throw new Error("GIF worker: unexpected reply");
      return new Uint8Array(m.bytes);
    },
    dispose: () => worker.terminate(),
  };
}

/** Same encoder on the main thread (yields between frames). */
function inlineEncoder(): Encoder {
  let session: ReturnType<typeof createGifSession> | null = null;
  return {
    async init(width, height, samples, seeds) {
      session = createGifSession({ width, height, samples, seeds });
    },
    async frame(rgba, delay) {
      session?.addFrame(rgba, delay);
      await sleep(0);
    },
    async finish() {
      if (!session) throw new Error("GIF encoder not initialised");
      return session.finish();
    },
    dispose: () => {
      session = null;
    },
  };
}

function rgbSeeds(colors: string[]): [number, number, number][] {
  const out: [number, number, number][] = [];
  for (const c of colors) {
    try {
      const [r, g, b] = parseColor(c);
      out.push([r, g, b]);
    } catch {
      /* skip */
    }
  }
  return out;
}

/** Render + encode an animated GIF (faster than real time; bounded by the encoder). */
export async function renderGif(scene: ReplayScene, s: ExportSettings, signal: AbortSignal, onProgress: (p: ExportProgress) => void): Promise<Uint8Array> {
  const { w, h } = gifSize(s.aspect);
  await loadReplayFonts();
  checkAbort(signal);
  const { ctx, dispose } = gifCanvas(w, h);
  const opts: PaintOptions = { width: w, height: h, palette: s.palette, watermark: s.watermark, flat: true };
  const plan = scene.plan;
  const grab = (ms: number): Uint8ClampedArray => {
    paintFrame(ctx, scene, ms, opts);
    return ctx.getImageData(0, 0, w, h).data as Uint8ClampedArray;
  };
  let enc = workerEncoder();
  try {
    // Palette from a few representative frames + the theme colours.
    const mainAt = (f: number) => plan.titleMs + plan.mainMs * f;
    const samples = [plan.titleMs * 0.7, mainAt(0.15), mainAt(0.45), mainAt(0.75), mainAt(0.97), plan.totalMs - 300].map(grab);
    const seeds = rgbSeeds(paletteColors(s.palette));
    try {
      if (!enc) throw new Error("no worker");
      await enc.init(w, h, samples.map((x) => x.slice()), seeds);
    } catch {
      enc?.dispose();
      enc = inlineEncoder();
      await enc.init(w, h, samples, seeds);
    }
    const frames = Math.max(1, Math.ceil((plan.totalMs / 1000) * GIF_FPS));
    const delays = delaySchedule(GIF_FPS, frames);
    for (let i = 0; i < frames; i++) {
      checkAbort(signal);
      const ms = Math.min(plan.totalMs, (i * 1000) / GIF_FPS);
      // getImageData returns a fresh buffer: handed (transferred) to the encoder as is.
      await enc.frame(grab(ms), delays[i]);
      onProgress({ phase: "render", fraction: (i + 1) / frames });
      if (i % 4 === 3) await sleep(0); // keep the UI responsive
    }
    onProgress({ phase: "encode", fraction: 1 });
    return await enc.finish();
  } finally {
    enc?.dispose();
    dispose();
  }
}

// ---- save ---------------------------------------------------------------------------------------

export interface ExportOutcome {
  path: string;
  bytes: number;
}

/**
 * Ask where to save (native dialog), render, save. Resolves null when the dialog is cancelled; rejects
 * with ExportCancelled when `signal` aborts.
 */
export async function exportReplay(
  scene: ReplayScene,
  kind: ReplayExportKind,
  baseName: string,
  s: ExportSettings,
  signal: AbortSignal,
  onProgress: (p: ExportProgress) => void,
): Promise<ExportOutcome | null> {
  const target = await ipc.replaySaveDialog(`${baseName}-replay`, kind);
  if (!target) return null;
  checkAbort(signal);
  let bytes: Uint8Array;
  if (kind === "gif") bytes = await renderGif(scene, s, signal, onProgress);
  else {
    const v = await renderVideo(scene, s, signal, onProgress);
    if (!v.mime.includes(kind)) throw new Error(t("replay.errMime", { mime: v.mime, kind }));
    bytes = v.bytes;
  }
  checkAbort(signal);
  onProgress({ phase: "save", fraction: 1 });
  try {
    const path = await ipc.replaySaveFile(target.token, bytes);
    return { path, bytes: bytes.length };
  } catch (e) {
    throw new Error(t("replay.errSave", { error: errorMessage(e) }));
  }
}
