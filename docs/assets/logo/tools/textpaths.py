"""Convert brand type to baked SVG paths (no font dependency at render time).

Usage (CLI):  python textpaths.py <font.woff2> <wght> <size_px> <tracking_em> "TEXT"
prints JSON {"d": ..., "width": ..., "cap": ..., "ink": [left, right]} with the
baseline at y=0 and the pen starting at x=0.

Fonts are the bundled @fontsource-variable packages (Space Grotesk for the wordmark,
Geist / Geist Mono for taglines). Requires fontTools + brotli.
"""
import json
import sys
from functools import lru_cache

from fontTools.pens.boundsPen import BoundsPen
from fontTools.pens.svgPathPen import SVGPathPen
from fontTools.pens.transformPen import TransformPen
from fontTools.ttLib import TTFont
from fontTools.varLib import instancer


@lru_cache(maxsize=None)
def _font(path, wght):
    f = TTFont(path)
    if "fvar" in f:
        f = instancer.instantiateVariableFont(f, {"wght": wght})
    return f


def _fmt(precision):
    def ntos(v):
        s = f"{v:.{precision}f}".rstrip("0").rstrip(".")
        return "0" if s in ("-0", "") else s
    return ntos


def text_path(path, wght, text, size, tracking_em=0.0, x=0.0, y=0.0, precision=2):
    """Return (d, advance_width, cap_height) for `text` with its baseline at (x, y)."""
    f = _font(path, wght)
    s = size / f["head"].unitsPerEm
    cmap = f.getBestCmap()
    gs = f.getGlyphSet()
    hmtx = f["hmtx"]
    pen = SVGPathPen(gs, ntos=_fmt(precision))
    cx = x
    names = [cmap[ord(ch)] for ch in text]
    for i, name in enumerate(names):
        gs[name].draw(TransformPen(pen, (s, 0, 0, -s, cx, y)))
        cx += hmtx[name][0] * s
        if i < len(names) - 1:
            cx += tracking_em * size
    cap = getattr(f["OS/2"], "sCapHeight", 0) * s
    return pen.getCommands(), cx - x, cap


def ink_x(path, wght, text, size, tracking_em=0.0):
    """Horizontal ink extents relative to the pen origin."""
    f = _font(path, wght)
    s = size / f["head"].unitsPerEm
    gs = f.getGlyphSet()
    cmap = f.getBestCmap()
    hmtx = f["hmtx"]
    cx, lo, hi = 0.0, None, None
    names = [cmap[ord(ch)] for ch in text]
    for i, name in enumerate(names):
        bp = BoundsPen(gs)
        gs[name].draw(bp)
        if bp.bounds:
            a, _, b, _ = bp.bounds
            lo = cx + a * s if lo is None else min(lo, cx + a * s)
            hi = cx + b * s if hi is None else max(hi, cx + b * s)
        cx += hmtx[name][0] * s
        if i < len(names) - 1:
            cx += tracking_em * size
    return lo, hi


if __name__ == "__main__":
    font, wght, size, tr, text = sys.argv[1], float(sys.argv[2]), float(sys.argv[3]), float(sys.argv[4]), sys.argv[5]
    d, w, cap = text_path(font, wght, text, size, tr)
    print(json.dumps({"d": d, "width": w, "cap": cap, "ink": ink_x(font, wght, text, size, tr)}))
