import { describe, expect, it } from "vitest";
import { MAX_WRITE_BYTES, splitForWrite } from "./writeChunks";

const utf8 = (s: string) => new TextEncoder().encode(s).length;

describe("splitForWrite", () => {
  it("returns nothing for empty input and one chunk for small input", () => {
    expect(splitForWrite("")).toEqual([]);
    expect(splitForWrite("ls -la\r")).toEqual(["ls -la\r"]);
  });

  it("splits a 1 MB ASCII paste into ≤64 KiB chunks that rejoin exactly", () => {
    const big = "x".repeat(1024 * 1024 + 17);
    const parts = splitForWrite(big);
    expect(parts.length).toBe(17);
    expect(parts.join("")).toBe(big);
    for (const p of parts) expect(utf8(p)).toBeLessThanOrEqual(MAX_WRITE_BYTES);
  });

  it("respects UTF-8 byte length for multibyte text", () => {
    const s = "é漢".repeat(50_000); // 2 + 3 bytes
    const parts = splitForWrite(s, 1000);
    expect(parts.join("")).toBe(s);
    for (const p of parts) expect(utf8(p)).toBeLessThanOrEqual(1000);
  });

  it("never splits a surrogate pair", () => {
    const s = ("a" + "😀").repeat(20_000);
    const parts = splitForWrite(s, 7);
    expect(parts.join("")).toBe(s);
    for (const p of parts) {
      const first = p.charCodeAt(0);
      const last = p.charCodeAt(p.length - 1);
      expect(first >= 0xdc00 && first <= 0xdfff).toBe(false);
      expect(last >= 0xd800 && last <= 0xdbff).toBe(false);
      expect(utf8(p)).toBeLessThanOrEqual(7);
    }
  });
});
