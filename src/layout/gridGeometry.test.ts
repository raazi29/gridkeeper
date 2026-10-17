import { describe, expect, it } from "vitest";
import { chunkRows, computeRows, equalSizes, layoutSignature, rowKey, rowsKey, validSizes } from "./gridGeometry";

describe("computeRows", () => {
  it("grid is near-square and the last row holds the remainder", () => {
    expect(computeRows("grid", 0)).toEqual([]);
    expect(computeRows("grid", 1)).toEqual([1]);
    expect(computeRows("grid", 2)).toEqual([2]);
    expect(computeRows("grid", 3)).toEqual([2, 1]);
    expect(computeRows("grid", 4)).toEqual([2, 2]);
    expect(computeRows("grid", 5)).toEqual([3, 2]);
    expect(computeRows("grid", 6)).toEqual([3, 3]);
    expect(computeRows("grid", 7)).toEqual([3, 3, 1]);
    expect(computeRows("grid", 9)).toEqual([3, 3, 3]);
    expect(computeRows("grid", 10)).toEqual([4, 4, 2]);
    expect(computeRows("grid", 16)).toEqual([4, 4, 4, 4]);
  });

  it("always accounts for every pane", () => {
    for (let n = 1; n <= 40; n++) {
      for (const p of ["grid", "columns", "rows"] as const) {
        const r = computeRows(p, n);
        expect(r.reduce((a, b) => a + b, 0)).toBe(n);
        expect(r.every((x) => x >= 1)).toBe(true);
      }
    }
  });

  it("columns = one row, rows = one pane per row", () => {
    expect(computeRows("columns", 3)).toEqual([3]);
    expect(computeRows("rows", 3)).toEqual([1, 1, 1]);
  });
});

describe("chunkRows", () => {
  it("splits ids in order", () => {
    expect(chunkRows(["a", "b", "c", "d", "e"], "grid")).toEqual([
      ["a", "b", "c"],
      ["d", "e"],
    ]);
  });
});

describe("size keys and validation", () => {
  it("signature encodes preset and count", () => {
    const sig = layoutSignature("grid", 5);
    expect(sig).toBe("grid:5");
    expect(rowsKey(sig)).toBe("grid:5:rows");
    expect(rowKey(sig, 1)).toBe("grid:5:r1");
  });

  it("validates persisted sizes", () => {
    expect(validSizes(undefined, 2)).toBeNull();
    expect(validSizes([50, 50], 3)).toBeNull();
    expect(validSizes([50, -1], 2)).toBeNull();
    expect(validSizes([10, 10], 2)).toBeNull();
    expect(validSizes([30, 70], 2)).toEqual([30, 70]);
    expect(validSizes([33.3, 33.3, 33.3], 3)!.reduce((a, b) => a + b, 0)).toBeCloseTo(100);
    expect(equalSizes(4)).toEqual([25, 25, 25, 25]);
  });
});
