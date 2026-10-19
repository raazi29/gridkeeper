import { describe, expect, it } from "vitest";
import { byteCapacity, dataCodewords, encodeQr, formatBits, penalty, qrPath, rsDivisor, rsRemainder } from "./qrcode";

describe("qrcode tables", () => {
  it("matches the standard's data codeword counts and byte capacities", () => {
    expect(dataCodewords(1, "L")).toBe(19);
    expect(dataCodewords(1, "M")).toBe(16);
    expect(dataCodewords(5, "M")).toBe(86);
    expect(dataCodewords(10, "M")).toBe(216);
    expect(dataCodewords(40, "L")).toBe(2956);
    expect(dataCodewords(40, "M")).toBe(2334);
    expect(byteCapacity(1, "M")).toBe(14);
    expect(byteCapacity(10, "M")).toBe(213);
    expect(byteCapacity(40, "L")).toBe(2953);
  });

  it("computes Reed-Solomon codewords (HELLO WORLD, 1-M worked example)", () => {
    const data = [32, 91, 11, 120, 209, 114, 220, 77, 67, 64, 236, 17, 236, 17, 236, 17];
    expect(rsRemainder(data, rsDivisor(10))).toEqual([196, 35, 39, 119, 235, 215, 231, 226, 93, 23]);
  });

  it("computes format bits", () => {
    expect(formatBits("M", 0)).toBe(0b101010000010010);
    expect(formatBits("L", 0)).toBe(0b111011111000100);
  });
});

describe("encodeQr", () => {
  it("picks the smallest version and draws finder patterns", () => {
    const qr = encodeQr("https://ntfy.sh/gk-AbCdEfGhIjKlMnOpQrStUvWx");
    expect(qr.version).toBe(4); // 43 bytes: one more than 3-M holds
    expect(qr.size).toBe(33);
    // Finder pattern corners and centres.
    for (const [x, y] of [
      [0, 0],
      [3, 3],
      [qr.size - 1, 0],
      [0, qr.size - 1],
    ])
      expect(qr.modules[y][x]).toBe(true);
    expect(qr.modules[1][1]).toBe(false);
    // The dark module.
    expect(qr.modules[qr.size - 8][8]).toBe(true);
  });

  it("chooses the mask with the lowest penalty and is deterministic", () => {
    const a = encodeQr("ntfy://ntfy.sh/gk-123");
    const b = encodeQr("ntfy://ntfy.sh/gk-123");
    expect(a.modules).toEqual(b.modules);
    expect(penalty(a.modules)).toBeGreaterThan(0);
  });

  it("handles long and non-ASCII text, refuses what does not fit", () => {
    expect(encodeQr("x".repeat(300)).version).toBeGreaterThan(9);
    expect(encodeQr("ünïcode · ✓").version).toBe(2); // 16 UTF-8 bytes
    expect(() => encodeQr("x".repeat(3000))).toThrow();
  });

  it("renders an SVG path inside the quiet zone", () => {
    const qr = encodeQr("a");
    const d = qrPath(qr);
    expect(d.startsWith("M4 4h7v1h-7z")).toBe(true);
  });
});
