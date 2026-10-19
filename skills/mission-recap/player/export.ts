// Export for the standalone recap page. Same pipeline as the app (src/replay/export.ts), minus the
// app's native save dialog: the result is a Blob the page offers as a download.
//
// Video: frames painted in REAL time onto a canvas, captured with captureStream(30) + MediaRecorder
// (MP4/H.264 where the browser can, else WebM). GIF: frames painted as fast as the app's GIF89a encoder
// keeps up, encoded in an inline (blob:) worker; when a worker can't start (some file:// setups) the
// same encoder runs on the main thread.

import GifWorker from "../../../src/replay/gif.worker.ts?worker&inline";
import type { GifWorkerIn, GifWorkerOut } from "../../../src/replay/gif.worker";
import { createGifSession, delaySchedule } from "../../../src/replay/gif";
import { paletteColors } from "../../../src/replay/palette";
import { ASPECTS, FPS, loadReplayFonts, paintFrame, type Aspect, type PaintOptions, type ReplayScene } from "../../../src/replay/render";
import { parseColor } from "../../../src/theme/themes";

export const GIF_FPS = 12.5;

export interface ExportSettings {
  aspect: Aspect;
  palette: PaintOptions["palette"];
  watermark: boolean;
}

export interface ExportProgress {
  phase: "render" | "encode";
  fraction: number;
}

export interface ExportResult {
  blob: Blob;
  mime: string;
  ext: "mp4" | "webm" | "gif";
}

export class ExportCancelled extends Error {
  constructor() {
    super("Export cancelled");
    this.name = "ExportCancelled";
  }
}

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

function checkAbort(signal: AbortSignal) {
  if (signal.aborted) throw new ExportCancelled();
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

/** Best MediaRecorder type this browser can record from a canvas; null when video export is impossible. */
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

export async function exportVideo(scene: ReplayScene, s: ExportSettings, signal: AbortSignal, onProgress: (p: ExportProgress) => void): Promise<ExportResult> {
  const type = pickVideoType();
  if (!type) throw new Error("This browser cannot record video from a canvas. Export a GIF, or open the page in Chrome, Edge or Firefox.");
  const { w: W, h: H } = ASPECTS[s.aspect];
  await loadReplayFonts();
  checkAbort(signal);
  const canvas = document.createElement("canvas");
  canvas.width = W;
  canvas.height = H;
  canvas.setAttribute("aria-hidden", "true");
  canvas.style.cssText = "position:fixed;left:0;top:0;width:2px;height:2px;opacity:0.01;pointer-events:none;z-index:-1";
  document.body.appendChild(canvas);
  const ctx = canvas.getContext("2d", { alpha: false });
  if (!ctx) {
    canvas.remove();
    throw new Error("Could not create a 2D canvas");
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
      await sleep(Math.max(0, t0 + frame * frameMs - performance.now()));
    }
    paintFrame(ctx, scene, total, opts);
    track?.requestFrame?.();
    await sleep(frameMs * 2);
    rec.stop();
    await stopped;
    onProgress({ phase: "encode", fraction: 1 });
    const blob = new Blob(chunks, { type: type.mime.split(";")[0] });
    if (blob.size === 0) throw new Error("The recorder produced no data");
    return { blob, mime: type.mime, ext: type.ext };
  } finally {
    if (rec.state !== "inactive") {
      try {
        rec.stop();
      } catch {
        /* already stopped */
      }
    }
    for (const t of stream.getTracks()) t.stop();
    canvas.remove();
  }
}

// ---- GIF ----------------------------------------------------------------------------------------

/** Same sizes as the app: 960 px wide landscape, 720 px square, 540 px wide vertical. */
export function gifSize(aspect: Aspect): { w: number; h: number } {
  const { w, h } = ASPECTS[aspect];
  const scale = aspect === "landscape" ? 960 / w : aspect === "square" ? 720 / w : 540 / w;
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
  if (!ctx) throw new Error("Could not create a 2D canvas");
  return { ctx, dispose: () => c.remove() };
}

interface Encoder {
  init(width: number, height: number, samples: Uint8ClampedArray[], seeds: [number, number, number][]): Promise<void>;
  frame(rgba: Uint8ClampedArray, delay: number): Promise<void>;
  finish(): Promise<Uint8Array>;
  dispose(): void;
}

/** The app's GIF worker, inlined as a blob: worker; at most `window` frames in flight. */
function workerEncoder(window = 3): Encoder | null {
  let worker: Worker;
  try {
    worker = new GifWorker();
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
      // A worker that never answers (blocked by the browser) must not hang the export.
      await new Promise<void>((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error("GIF worker did not start")), 4000);
        r.then(
          () => {
            clearTimeout(timer);
            resolve();
          },
          (e: Error) => {
            clearTimeout(timer);
            reject(e);
          },
        );
      });
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

/** The same encoder on the main thread (yields between frames). */
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

export async function exportGif(scene: ReplayScene, s: ExportSettings, signal: AbortSignal, onProgress: (p: ExportProgress) => void): Promise<ExportResult> {
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
  let enc: Encoder | null = workerEncoder();
  try {
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
      await enc.frame(grab(ms), delays[i]);
      onProgress({ phase: "render", fraction: (i + 1) / frames });
      if (i % 4 === 3) await sleep(0);
    }
    onProgress({ phase: "encode", fraction: 1 });
    const bytes = await enc.finish();
    return { blob: new Blob([bytes as BlobPart], { type: "image/gif" }), mime: "image/gif", ext: "gif" };
  } finally {
    enc?.dispose();
    dispose();
  }
}
