// GIF encoding off the main thread (mission replay export). Same-origin module worker bundled by Vite,
// so the app's CSP (`script-src 'self'`) allows it. Protocol:
//   in:  { type: "init", width, height, samples: ArrayBuffer[], seeds }   → out: { type: "ready", colors }
//        { type: "frame", rgba: ArrayBuffer, delay }                      → out: { type: "ack" }
//        { type: "finish" }                                               → out: { type: "done", bytes: ArrayBuffer }
//   any failure                                                           → out: { type: "error", message }

import { createGifSession, type GifSession } from "./gif";

export type GifWorkerIn =
  | { type: "init"; width: number; height: number; samples: ArrayBuffer[]; seeds: [number, number, number][] }
  | { type: "frame"; rgba: ArrayBuffer; delay: number }
  | { type: "finish" };

export type GifWorkerOut = { type: "ready"; colors: number } | { type: "ack" } | { type: "done"; bytes: ArrayBuffer } | { type: "error"; message: string };

interface WorkerScope {
  postMessage(m: GifWorkerOut, transfer?: Transferable[]): void;
  onmessage: ((e: MessageEvent<GifWorkerIn>) => void) | null;
}

const scope = self as unknown as WorkerScope;
let session: GifSession | null = null;

scope.onmessage = (e) => {
  const m = e.data;
  try {
    if (m.type === "init") {
      session = createGifSession({ width: m.width, height: m.height, samples: m.samples.map((b) => new Uint8ClampedArray(b)), seeds: m.seeds });
      scope.postMessage({ type: "ready", colors: session.colors });
    } else if (m.type === "frame") {
      if (!session) throw new Error("GIF worker: frame before init");
      session.addFrame(new Uint8ClampedArray(m.rgba), m.delay);
      scope.postMessage({ type: "ack" });
    } else if (m.type === "finish") {
      if (!session) throw new Error("GIF worker: finish before init");
      const bytes = session.finish();
      session = null;
      const buf = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;
      scope.postMessage({ type: "done", bytes: buf }, [buf]);
    }
  } catch (err) {
    session = null;
    scope.postMessage({ type: "error", message: err instanceof Error ? err.message : String(err) });
  }
};
