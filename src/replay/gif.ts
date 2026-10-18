// Minimal GIF89a encoder for the mission replay (no dependencies, node-safe, unit-tested).
//
//   buildPalette()   median cut over a 15-bit colour histogram of a few sample frames + seed colours
//                    (the theme), 255 colours; index 255 is reserved for transparency.
//   PaletteMapper    RGBA → palette indices, nearest colour with a 32 768-entry cache (no dithering:
//                    UI text stays crisp).
//   GifEncoder       one global palette, looping (NETSCAPE2.0), frame deltas: each frame after the first
//                    is cropped to the box of changed pixels, unchanged pixels inside it are transparent
//                    (disposal "do not dispose"), identical frames extend the previous frame's delay.
//                    LZW with variable code size up to 12 bits (classic 5003-slot hash table).

export const TRANSPARENT = 255;
export const MAX_COLORS = 255;

// ---- byte output ----------------------------------------------------------------------------------

class Bytes {
  buf = new Uint8Array(1 << 16);
  len = 0;
  private ensure(n: number) {
    if (this.len + n <= this.buf.length) return;
    let cap = this.buf.length * 2;
    while (cap < this.len + n) cap *= 2;
    const next = new Uint8Array(cap);
    next.set(this.buf.subarray(0, this.len));
    this.buf = next;
  }
  byte(b: number) {
    this.ensure(1);
    this.buf[this.len++] = b & 0xff;
  }
  u16(v: number) {
    this.byte(v & 0xff);
    this.byte((v >> 8) & 0xff);
  }
  bytes(a: ArrayLike<number>) {
    this.ensure(a.length);
    this.buf.set(a, this.len);
    this.len += a.length;
  }
  ascii(s: string) {
    for (let i = 0; i < s.length; i++) this.byte(s.charCodeAt(i));
  }
  result(): Uint8Array {
    return this.buf.slice(0, this.len);
  }
}

// ---- palette ------------------------------------------------------------------------------------

const key15 = (r: number, g: number, b: number) => ((r >> 3) << 10) | ((g >> 3) << 5) | (b >> 3);

interface Box {
  keys: number[];
  count: number;
}

function channel(k: number, c: number): number {
  return c === 0 ? (k >> 10) & 31 : c === 1 ? (k >> 5) & 31 : k & 31;
}

/**
 * Median-cut palette. `samples` are RGBA buffers (any size); `seeds` are colours that must survive
 * (weighted heavily). Returns 768 bytes (256 RGB entries; entry 255 = transparent slot, black) and the
 * number of real colours (<= 255).
 */
export function buildPalette(samples: readonly ArrayLike<number>[], seeds: readonly [number, number, number][] = [], maxColors = MAX_COLORS): { palette: Uint8Array; count: number } {
  const hist = new Float64Array(32768);
  let total = 0;
  for (const s of samples) {
    for (let i = 0; i + 3 < s.length; i += 4) {
      hist[key15(s[i], s[i + 1], s[i + 2])]++;
      total++;
    }
  }
  const seedWeight = Math.max(1, total / 64);
  for (const [r, g, b] of seeds) hist[key15(r, g, b)] += seedWeight;
  const keys: number[] = [];
  let count = 0;
  for (let k = 0; k < 32768; k++)
    if (hist[k] > 0) {
      keys.push(k);
      count += hist[k];
    }
  const palette = new Uint8Array(768);
  if (keys.length === 0) return { palette, count: 1 };
  const boxes: Box[] = [{ keys, count }];
  const limit = Math.max(1, Math.min(MAX_COLORS, maxColors));
  while (boxes.length < limit) {
    // Split the box with the largest (population × widest channel range).
    let best = -1;
    let bestScore = 0;
    let bestCh = 0;
    for (let i = 0; i < boxes.length; i++) {
      const b = boxes[i];
      if (b.keys.length < 2) continue;
      let lo = [31, 31, 31];
      let hi = [0, 0, 0];
      for (const k of b.keys)
        for (let c = 0; c < 3; c++) {
          const v = channel(k, c);
          if (v < lo[c]) lo[c] = v;
          if (v > hi[c]) hi[c] = v;
        }
      const ranges = [hi[0] - lo[0], hi[1] - lo[1], hi[2] - lo[2]];
      const ch = ranges[1] >= ranges[0] && ranges[1] >= ranges[2] ? 1 : ranges[0] >= ranges[2] ? 0 : 2;
      const score = Math.sqrt(b.count) * (ranges[ch] + 1);
      if (score > bestScore) {
        bestScore = score;
        best = i;
        bestCh = ch;
      }
      lo = hi;
    }
    if (best < 0) break;
    const b = boxes[best];
    b.keys.sort((x, y) => channel(x, bestCh) - channel(y, bestCh));
    let acc = 0;
    let cut = 1;
    for (let i = 0; i < b.keys.length - 1; i++) {
      acc += hist[b.keys[i]];
      if (acc >= b.count / 2) {
        cut = i + 1;
        break;
      }
      cut = i + 1;
    }
    const a = b.keys.slice(0, cut);
    const c = b.keys.slice(cut);
    const sum = (ks: number[]) => ks.reduce((n, k) => n + hist[k], 0);
    boxes.splice(best, 1, { keys: a, count: sum(a) }, { keys: c, count: sum(c) });
  }
  boxes.forEach((b, i) => {
    let r = 0;
    let g = 0;
    let bl = 0;
    let w = 0;
    for (const k of b.keys) {
      const h = hist[k];
      r += (channel(k, 0) * 8 + 4) * h;
      g += (channel(k, 1) * 8 + 4) * h;
      bl += (channel(k, 2) * 8 + 4) * h;
      w += h;
    }
    palette[i * 3] = Math.round(r / w);
    palette[i * 3 + 1] = Math.round(g / w);
    palette[i * 3 + 2] = Math.round(bl / w);
  });
  // Exact seed colours where a box landed close by (crisp theme colours instead of bucket averages).
  for (const [r, g, b] of seeds) {
    let bi = 0;
    let bd = Infinity;
    for (let i = 0; i < boxes.length; i++) {
      const d = (palette[i * 3] - r) ** 2 + (palette[i * 3 + 1] - g) ** 2 + (palette[i * 3 + 2] - b) ** 2;
      if (d < bd) {
        bd = d;
        bi = i;
      }
    }
    if (bd <= 3 * 12 * 12) {
      palette[bi * 3] = r;
      palette[bi * 3 + 1] = g;
      palette[bi * 3 + 2] = b;
    }
  }
  return { palette, count: boxes.length };
}

export class PaletteMapper {
  private cache = new Int16Array(32768).fill(-1);
  constructor(
    private palette: Uint8Array,
    private count: number,
  ) {}

  nearest(r: number, g: number, b: number): number {
    const p = this.palette;
    let best = 0;
    let bd = Infinity;
    for (let i = 0; i < this.count; i++) {
      const dr = p[i * 3] - r;
      const dg = p[i * 3 + 1] - g;
      const db = p[i * 3 + 2] - b;
      // Perceptual-ish weights (green matters most).
      const d = 2 * dr * dr + 4 * dg * dg + 3 * db * db;
      if (d < bd) {
        bd = d;
        best = i;
      }
    }
    return best;
  }

  /** RGBA → indices (alpha ignored: frames are opaque). */
  map(rgba: ArrayLike<number>, out = new Uint8Array(rgba.length >> 2)): Uint8Array {
    const cache = this.cache;
    for (let i = 0, j = 0; j < out.length; i += 4, j++) {
      const k = key15(rgba[i], rgba[i + 1], rgba[i + 2]);
      let idx = cache[k];
      if (idx < 0) {
        idx = this.nearest(((k >> 10) & 31) * 8 + 4, ((k >> 5) & 31) * 8 + 4, (k & 31) * 8 + 4);
        cache[k] = idx;
      }
      out[j] = idx;
    }
    return out;
  }
}

// ---- LZW ----------------------------------------------------------------------------------------

const HSIZE = 5003;
const MAX_BITS = 12;
const MAX_CODE = 1 << MAX_BITS;

/**
 * GIF LZW of `pixels` (indices < 2^minCodeSize), written as the min-code-size byte, data sub-blocks and
 * the block terminator. Follows the classic compress/GIFEncoder scheme (code width grows after the code
 * that made the table outgrow it; a full table emits a clear code).
 */
export function lzwEncode(o: { byte(b: number): void }, pixels: ArrayLike<number>, minCodeSize = 8): void {
  o.byte(minCodeSize);
  const clear = 1 << minCodeSize;
  const eoi = clear + 1;
  const initBits = minCodeSize + 1;
  const htab = new Int32Array(HSIZE).fill(-1);
  const codetab = new Int32Array(HSIZE);
  const block = new Uint8Array(255);
  let blockLen = 0;
  let acc = 0;
  let accBits = 0;
  let nBits = initBits;
  let maxcode = (1 << nBits) - 1;
  let freeEnt = clear + 2;
  let clearFlg = false;

  const flushBlock = () => {
    if (blockLen === 0) return;
    o.byte(blockLen);
    for (let i = 0; i < blockLen; i++) o.byte(block[i]);
    blockLen = 0;
  };
  const emitByte = (b: number) => {
    block[blockLen++] = b;
    if (blockLen === 255) flushBlock();
  };
  const output = (code: number) => {
    acc |= code << accBits;
    accBits += nBits;
    while (accBits >= 8) {
      emitByte(acc & 0xff);
      acc >>>= 8;
      accBits -= 8;
    }
    if (freeEnt > maxcode || clearFlg) {
      if (clearFlg) {
        nBits = initBits;
        maxcode = (1 << nBits) - 1;
        clearFlg = false;
      } else {
        nBits++;
        maxcode = nBits === MAX_BITS ? MAX_CODE : (1 << nBits) - 1;
      }
    }
  };

  output(clear);
  if (pixels.length > 0) {
    let ent = pixels[0];
    outer: for (let i = 1; i < pixels.length; i++) {
      const c = pixels[i];
      const fcode = (c << MAX_BITS) + ent;
      let h = (c << 4) ^ ent; // xor hashing (hshift 4 for HSIZE 5003)
      if (htab[h] === fcode) {
        ent = codetab[h];
        continue;
      }
      if (htab[h] >= 0) {
        const disp = h === 0 ? 1 : HSIZE - h;
        do {
          h -= disp;
          if (h < 0) h += HSIZE;
          if (htab[h] === fcode) {
            ent = codetab[h];
            continue outer;
          }
        } while (htab[h] >= 0);
      }
      output(ent);
      ent = c;
      if (freeEnt < MAX_CODE) {
        codetab[h] = freeEnt++;
        htab[h] = fcode;
      } else {
        htab.fill(-1);
        freeEnt = clear + 2;
        clearFlg = true;
        output(clear);
      }
    }
    output(ent);
  }
  output(eoi);
  while (accBits > 0) {
    emitByte(acc & 0xff);
    acc >>>= 8;
    accBits -= 8;
  }
  flushBlock();
  o.byte(0);
}

// ---- encoder ------------------------------------------------------------------------------------

export interface GifOptions {
  /** 0 = loop forever (default); null = play once (no NETSCAPE block). */
  loop?: number | null;
}

interface Pending {
  x: number;
  y: number;
  w: number;
  h: number;
  pixels: Uint8Array;
  delay: number;
  transparent: boolean;
}

export class GifEncoder {
  private out = new Bytes();
  private prev: Uint8Array | null = null;
  private pending: Pending | null = null;
  private done = false;
  frames = 0;

  constructor(
    readonly width: number,
    readonly height: number,
    palette: Uint8Array,
    opts: GifOptions = {},
  ) {
    if (width < 1 || height < 1 || width > 65535 || height > 65535) throw new Error(`bad GIF size ${width}x${height}`);
    const o = this.out;
    o.ascii("GIF89a");
    o.u16(width);
    o.u16(height);
    o.byte(0xf7); // global colour table, 8-bit resolution, 256 entries
    o.byte(0); // background colour index
    o.byte(0); // pixel aspect ratio
    const table = new Uint8Array(768);
    table.set(palette.subarray(0, 768));
    o.bytes(table);
    const loop = opts.loop === undefined ? 0 : opts.loop;
    if (loop !== null) {
      o.byte(0x21);
      o.byte(0xff);
      o.byte(11);
      o.ascii("NETSCAPE2.0");
      o.byte(3);
      o.byte(1);
      o.u16(loop);
      o.byte(0);
    }
  }

  /** Add a frame of palette indices (width × height), shown for `delayCs` hundredths of a second. */
  addFrame(indices: Uint8Array, delayCs: number): void {
    if (this.done) throw new Error("GIF already finished");
    const { width: W, height: H } = this;
    if (indices.length !== W * H) throw new Error("frame size mismatch");
    const delay = Math.max(1, Math.round(delayCs));
    const prev = this.prev;
    if (!prev) {
      this.pending = { x: 0, y: 0, w: W, h: H, pixels: indices.slice(), delay, transparent: false };
      this.prev = indices.slice();
      return;
    }
    let x0 = W;
    let y0 = H;
    let x1 = -1;
    let y1 = -1;
    for (let y = 0; y < H; y++) {
      const row = y * W;
      for (let x = 0; x < W; x++)
        if (indices[row + x] !== prev[row + x]) {
          if (x < x0) x0 = x;
          if (x > x1) x1 = x;
          if (y < y0) y0 = y;
          if (y > y1) y1 = y;
        }
    }
    if (x1 < 0) {
      // Identical: the frame on screen just stays longer.
      if (this.pending) this.pending.delay += delay;
      return;
    }
    this.flushPending();
    const w = x1 - x0 + 1;
    const h = y1 - y0 + 1;
    const px = new Uint8Array(w * h);
    for (let y = 0; y < h; y++) {
      const src = (y0 + y) * W + x0;
      for (let x = 0; x < w; x++) {
        const v = indices[src + x];
        px[y * w + x] = v === prev[src + x] ? TRANSPARENT : v;
      }
    }
    this.pending = { x: x0, y: y0, w, h, pixels: px, delay, transparent: true };
    prev.set(indices);
  }

  private flushPending() {
    const f = this.pending;
    if (!f) return;
    this.pending = null;
    const o = this.out;
    // Graphic control extension: disposal 1 (leave in place), optional transparency.
    o.byte(0x21);
    o.byte(0xf9);
    o.byte(4);
    o.byte((1 << 2) | (f.transparent ? 1 : 0));
    o.u16(Math.min(65535, f.delay));
    o.byte(f.transparent ? TRANSPARENT : 0);
    o.byte(0);
    // Image descriptor (no local table, not interlaced).
    o.byte(0x2c);
    o.u16(f.x);
    o.u16(f.y);
    o.u16(f.w);
    o.u16(f.h);
    o.byte(0);
    lzwEncode(o, f.pixels, 8);
    this.frames++;
  }

  finish(): Uint8Array {
    if (!this.done) {
      this.flushPending();
      this.out.byte(0x3b);
      this.done = true;
    }
    return this.out.result();
  }
}

/** Frame delays in centiseconds for `fps` that add up exactly over time (e.g. 12 fps → 8, 8, 9, 8, …). */
export function delaySchedule(fps: number, frames: number): number[] {
  const out: number[] = [];
  let acc = 0;
  for (let i = 0; i < frames; i++) {
    const next = Math.round(((i + 1) * 100) / fps);
    out.push(Math.max(1, next - acc));
    acc = next;
  }
  return out;
}

// ---- one encoding job (used by the worker, and on the main thread when workers are unavailable) ---

export interface GifSessionInit {
  width: number;
  height: number;
  /** RGBA sample frames for the palette. */
  samples: ArrayLike<number>[];
  /** Theme colours that must be in the palette. */
  seeds: [number, number, number][];
}

export interface GifSession {
  addFrame(rgba: ArrayLike<number>, delayCs: number): void;
  finish(): Uint8Array;
  readonly colors: number;
}

export function createGifSession(init: GifSessionInit): GifSession {
  const { palette, count } = buildPalette(init.samples, init.seeds);
  const mapper = new PaletteMapper(palette, count);
  const enc = new GifEncoder(init.width, init.height, palette);
  const indices = new Uint8Array(init.width * init.height);
  return {
    colors: count,
    addFrame(rgba, delayCs) {
      mapper.map(rgba, indices);
      enc.addFrame(indices, delayCs);
    },
    finish: () => enc.finish(),
  };
}
