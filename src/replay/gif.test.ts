import { describe, expect, it } from "vitest";
import { buildPalette, createGifSession, delaySchedule, GifEncoder, lzwEncode, PaletteMapper, TRANSPARENT } from "./gif";

// ---- a small, independent GIF decoder (blocks + LZW) -----------------------------------------

function lzwDecode(data: Uint8Array, minCodeSize: number, expected: number): number[] {
  const clear = 1 << minCodeSize;
  const eoi = clear + 1;
  let size = minCodeSize + 1;
  let dict: number[][] = [];
  const reset = () => {
    dict = [];
    for (let i = 0; i < clear; i++) dict[i] = [i];
    dict[clear] = [];
    dict[eoi] = [];
    size = minCodeSize + 1;
  };
  reset();
  const out: number[] = [];
  let bit = 0;
  let prev: number[] | null = null;
  const read = () => {
    let code = 0;
    for (let i = 0; i < size; i++) {
      const byte = data[(bit + i) >> 3];
      if (byte === undefined) throw new Error("ran out of data");
      code |= ((byte >> ((bit + i) & 7)) & 1) << i;
    }
    bit += size;
    return code;
  };
  for (;;) {
    const code = read();
    if (code === clear) {
      reset();
      prev = null;
      continue;
    }
    if (code === eoi) break;
    let entry: number[];
    if (code < dict.length && dict[code]) entry = dict[code];
    else if (code === dict.length && prev) entry = [...prev, prev[0]];
    else throw new Error(`bad code ${code} (dict ${dict.length})`);
    out.push(...entry);
    if (prev) {
      dict.push([...prev, entry[0]]);
      if (dict.length === 1 << size && size < 12) size++;
    }
    prev = entry;
  }
  expect(out.length).toBe(expected);
  return out;
}

interface Frame {
  x: number;
  y: number;
  w: number;
  h: number;
  delay: number;
  transparent: number | null;
  disposal: number;
  pixels: number[];
}

function parseGif(b: Uint8Array) {
  let p = 0;
  const u8 = () => b[p++];
  const u16 = () => {
    const v = b[p] | (b[p + 1] << 8);
    p += 2;
    return v;
  };
  const ascii = (n: number) => {
    let s = "";
    for (let i = 0; i < n; i++) s += String.fromCharCode(u8());
    return s;
  };
  const subBlocks = () => {
    const parts: number[] = [];
    for (;;) {
      const n = u8();
      if (n === 0) break;
      for (let i = 0; i < n; i++) parts.push(u8());
    }
    return new Uint8Array(parts);
  };
  expect(ascii(6)).toBe("GIF89a");
  const width = u16();
  const height = u16();
  const packed = u8();
  expect(packed & 0x80).toBe(0x80);
  const tableSize = 2 << (packed & 7);
  u8();
  u8();
  const palette = Array.from(b.subarray(p, p + tableSize * 3));
  p += tableSize * 3;
  let loop: number | null = null;
  const frames: Frame[] = [];
  let gce: { delay: number; transparent: number | null; disposal: number } | null = null;
  for (;;) {
    const intro = u8();
    if (intro === 0x3b) break;
    if (intro === 0x21) {
      const label = u8();
      if (label === 0xff) {
        const n = u8();
        const id = ascii(n);
        const data = subBlocks();
        if (id === "NETSCAPE2.0") loop = data[1] | (data[2] << 8);
      } else if (label === 0xf9) {
        expect(u8()).toBe(4);
        const pk = u8();
        const delay = u16();
        const ti = u8();
        expect(u8()).toBe(0);
        gce = { delay, transparent: pk & 1 ? ti : null, disposal: (pk >> 2) & 7 };
      } else subBlocks();
      continue;
    }
    expect(intro).toBe(0x2c);
    const x = u16();
    const y = u16();
    const w = u16();
    const h = u16();
    expect(u8()).toBe(0); // no local table, not interlaced
    const min = u8();
    const data = subBlocks();
    frames.push({ x, y, w, h, delay: gce?.delay ?? 0, transparent: gce?.transparent ?? null, disposal: gce?.disposal ?? 0, pixels: lzwDecode(data, min, w * h) });
    gce = null;
  }
  expect(p).toBe(b.length);
  return { width, height, palette, loop, frames };
}

/** Composite frames (disposal 1 + transparency) into full canvases of indices. */
function composite(g: ReturnType<typeof parseGif>): number[][] {
  const canvas = new Array(g.width * g.height).fill(0);
  return g.frames.map((f) => {
    for (let yy = 0; yy < f.h; yy++)
      for (let xx = 0; xx < f.w; xx++) {
        const v = f.pixels[yy * f.w + xx];
        if (f.transparent !== null && v === f.transparent) continue;
        canvas[(f.y + yy) * g.width + f.x + xx] = v;
      }
    return canvas.slice();
  });
}

const PAL = new Uint8Array(768);
PAL.set([0, 0, 0, 255, 255, 255, 255, 0, 0, 0, 255, 0]);

describe("GIF encoder", () => {
  it("writes header, palette, loop block, frames and trailer, and decodes back", () => {
    const enc = new GifEncoder(4, 3, PAL);
    const f1 = Uint8Array.from([0, 1, 2, 3, 3, 2, 1, 0, 1, 1, 1, 1]);
    const f2 = f1.slice();
    f2[5] = 0; // one changed pixel
    enc.addFrame(f1, 10);
    enc.addFrame(f2, 10);
    const bytes = enc.finish();
    expect(Array.from(bytes.subarray(0, 6))).toEqual([0x47, 0x49, 0x46, 0x38, 0x39, 0x61]); // GIF89a
    expect(bytes[bytes.length - 1]).toBe(0x3b); // trailer
    const g = parseGif(bytes);
    expect([g.width, g.height, g.loop]).toEqual([4, 3, 0]);
    expect(g.palette.slice(0, 12)).toEqual([0, 0, 0, 255, 255, 255, 255, 0, 0, 0, 255, 0]);
    expect(g.frames).toHaveLength(2);
    expect(g.frames[0]).toMatchObject({ x: 0, y: 0, w: 4, h: 3, delay: 10, transparent: null, disposal: 1 });
    expect(g.frames[0].pixels).toEqual(Array.from(f1));
    // The delta frame is cropped to the changed pixel.
    expect(g.frames[1]).toMatchObject({ x: 1, y: 1, w: 1, h: 1, transparent: TRANSPARENT, disposal: 1 });
    const full = composite(g);
    expect(full[0]).toEqual(Array.from(f1));
    expect(full[1]).toEqual(Array.from(f2));
  });

  it("merges identical frames into a longer delay", () => {
    const enc = new GifEncoder(2, 2, PAL);
    const a = Uint8Array.from([0, 1, 1, 0]);
    enc.addFrame(a, 8);
    enc.addFrame(a.slice(), 8);
    enc.addFrame(a.slice(), 9);
    enc.addFrame(Uint8Array.from([1, 1, 1, 0]), 8);
    const g = parseGif(enc.finish());
    expect(g.frames.map((f) => f.delay)).toEqual([25, 8]);
    expect(enc.frames).toBe(2);
  });

  it("delta frames keep unchanged pixels transparent inside the box", () => {
    const W = 6;
    const H = 4;
    const a = new Uint8Array(W * H).fill(1);
    const b = a.slice();
    b[0] = 2;
    b[W * H - 1] = 3; // opposite corners: the box is the whole frame
    const enc = new GifEncoder(W, H, PAL);
    enc.addFrame(a, 5);
    enc.addFrame(b, 5);
    const g = parseGif(enc.finish());
    const d = g.frames[1];
    expect([d.x, d.y, d.w, d.h]).toEqual([0, 0, W, H]);
    expect(d.pixels.filter((v) => v === TRANSPARENT)).toHaveLength(W * H - 2);
    expect(composite(g)[1]).toEqual(Array.from(b));
  });

  it("LZW survives a full code table (clear codes) on noisy data", () => {
    const n = 200 * 150;
    const px = new Uint8Array(n);
    let seed = 12345;
    for (let i = 0; i < n; i++) {
      seed = (seed * 1103515245 + 12345) >>> 0;
      px[i] = (seed >>> 16) % 200;
    }
    const out: number[] = [];
    lzwEncode({ byte: (v) => out.push(v) }, px, 8);
    // Re-assemble sub-blocks and decode.
    let p = 1;
    const data: number[] = [];
    for (;;) {
      const len = out[p++];
      if (len === 0) break;
      for (let i = 0; i < len; i++) data.push(out[p++]);
    }
    expect(p).toBe(out.length);
    expect(lzwDecode(new Uint8Array(data), out[0], n)).toEqual(Array.from(px));
  });

  it("handles single-pixel and long uniform frames", () => {
    for (const [w, h] of [
      [1, 1],
      [300, 200],
    ]) {
      const enc = new GifEncoder(w, h, PAL);
      enc.addFrame(new Uint8Array(w * h).fill(2), 4);
      const g = parseGif(enc.finish());
      expect(g.frames[0].pixels.every((v) => v === 2)).toBe(true);
    }
    expect(() => new GifEncoder(0, 1, PAL)).toThrow();
    const enc = new GifEncoder(2, 2, PAL);
    expect(() => enc.addFrame(new Uint8Array(3), 1)).toThrow();
  });
});

describe("palette + mapping", () => {
  it("keeps seed colours exactly and maps pixels to their nearest entry", () => {
    const img = new Uint8ClampedArray(64 * 4);
    for (let i = 0; i < 64; i++) img.set(i < 32 ? [7, 9, 13, 255] : [76, 194, 255, 255], i * 4);
    const seeds: [number, number, number][] = [
      [7, 9, 13],
      [76, 194, 255],
      [255, 92, 108],
    ];
    const { palette, count } = buildPalette([img], seeds);
    expect(count).toBeGreaterThanOrEqual(3);
    expect(count).toBeLessThanOrEqual(255);
    const colors = Array.from({ length: count }, (_, i) => `${palette[i * 3]},${palette[i * 3 + 1]},${palette[i * 3 + 2]}`);
    for (const s of seeds) expect(colors).toContain(s.join(","));
    const m = new PaletteMapper(palette, count);
    const idx = m.map(Uint8ClampedArray.from([8, 9, 12, 255, 250, 90, 110, 255]));
    expect(colors[idx[0]]).toBe("7,9,13");
    expect(colors[idx[1]]).toBe("255,92,108");
  });

  it("limits a colourful image to 255 colours and never uses the transparent slot", () => {
    const img = new Uint8ClampedArray(4096 * 4);
    for (let i = 0; i < 4096; i++) img.set([(i * 37) & 255, (i * 91) & 255, (i * 13) & 255, 255], i * 4);
    const { palette, count } = buildPalette([img]);
    expect(count).toBe(255);
    const idx = new PaletteMapper(palette, count).map(img);
    expect(Math.max(...idx)).toBeLessThan(TRANSPARENT);
  });

  it("a session encodes RGBA frames end to end", () => {
    const w = 8;
    const h = 8;
    const frame = (c: number[]) => {
      const a = new Uint8ClampedArray(w * h * 4);
      for (let i = 0; i < w * h; i++) a.set([...c, 255], i * 4);
      return a;
    };
    const s = createGifSession({ width: w, height: h, samples: [frame([10, 20, 30]), frame([200, 100, 50])], seeds: [] });
    s.addFrame(frame([10, 20, 30]), 8);
    s.addFrame(frame([200, 100, 50]), 8);
    const g = parseGif(s.finish());
    expect(g.frames).toHaveLength(2);
  });
});

describe("delay schedule", () => {
  it("adds up exactly", () => {
    const d = delaySchedule(12.5, 25);
    expect(d.every((x) => x === 8)).toBe(true);
    const d12 = delaySchedule(12, 12);
    expect(d12.reduce((a, b) => a + b, 0)).toBe(100);
    expect(Math.max(...d12) - Math.min(...d12)).toBeLessThanOrEqual(1);
  });
});
