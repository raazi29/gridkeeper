"""Generate the mark, wordmark lockups, favicon and banners as self-contained SVGs, then PNGs.

All type is baked to paths (Space Grotesk 600 for the wordmark, Geist / Geist Mono for
supporting text) so the SVGs render identically everywhere with no font installed.
The app-icon SVGs themselves are hand-written (../gridkeeper-icon*.svg); this script only
inlines gridkeeper-icon.svg into the banners.

Usage (from the repo root, with node_modules installed here or in a parent directory):
    python docs/assets/logo/tools/build_brand.py
"""
import re
import shutil
from pathlib import Path

from render import render
from textpaths import ink_x, text_path

ROOT = Path(__file__).resolve().parents[4]
ASSETS = ROOT / "docs" / "assets"
LOGO = ASSETS / "logo"


def find_font(pkg, file):
    for base in [ROOT, *ROOT.parents]:
        p = base / "node_modules" / "@fontsource-variable" / pkg / "files" / file
        if p.exists():
            return str(p)
    raise SystemExit(f"font not found: {pkg}/{file} (run npm install)")


GROTESK = find_font("space-grotesk", "space-grotesk-latin-wght-normal.woff2")
GEIST = find_font("geist", "geist-latin-wght-normal.woff2")
MONO = find_font("geist-mono", "geist-mono-latin-wght-normal.woff2")

# Brand colours (Deep Space theme, src/theme/themes.ts)
BG0 = "#07090d"
INK = "#e7ecf4"
INK_2 = "#a9b4c4"
ION = "#4cc2ff"
CYAN = "#41e2ff"
ION_FG = "#7dd3ff"
# On light surfaces (Daylight theme ink; a deeper ion blue that holds 3:1 on white)
INK_LIGHT = "#0e1c30"
ION_LIGHT = "#1d8fe6"

WORD = "GRIDKEEPER"
WORD_WGHT = 600
WORD_TRACK = 0.12

# Mark geometry, in the same 1024 coordinates as gridkeeper-icon.svg.
MARK_BOX = (172, 172, 680, 680)  # brackets incl. stroke, plus 3 units of air
BRACKETS = ("M196 358V250a54 54 0 0 1 54-54h108M666 196h108a54 54 0 0 1 54 54v108"
            "M828 666v108a54 54 0 0 1-54 54H666M358 828H250a54 54 0 0 1-54-54V666")
PANES = {"tl": (290, 290), "tr": (534, 290), "bl": (290, 534), "br": (534, 534)}


def mark_body(ink, lit, stroke=42, dim=0.5):
    p = PANES
    return (
        f'<path d="{BRACKETS}" fill="none" stroke="{ink}" stroke-width="{stroke}" '
        f'stroke-linecap="round" stroke-linejoin="round"/>'
        f'<rect x="{p["tl"][0]}" y="{p["tl"][1]}" width="200" height="200" rx="40" fill="{ink}"/>'
        f'<rect x="{p["tr"][0]}" y="{p["tr"][1]}" width="200" height="200" rx="40" fill="{lit}"/>'
        f'<rect x="{p["bl"][0]}" y="{p["bl"][1]}" width="200" height="200" rx="40" fill="{ink}" fill-opacity="{dim}"/>'
        f'<rect x="{p["br"][0]}" y="{p["br"][1]}" width="200" height="200" rx="40" fill="{ink}" fill-opacity="{dim}"/>'
    )


def nested_mark(x, y, size, ink, lit):
    bx, by, bw, bh = MARK_BOX
    return (f'<svg x="{x:g}" y="{y:g}" width="{size:g}" height="{size:g}" viewBox="{bx} {by} {bw} {bh}">'
            f"{mark_body(ink, lit)}</svg>")


def nested_icon(x, y, size):
    """Inline the full app icon (SVG-as-image cannot load external files)."""
    src = (LOGO / "gridkeeper-icon.svg").read_text(encoding="utf-8")
    inner = re.sub(r"^.*?<svg[^>]*>", "", src, flags=re.S)
    inner = re.sub(r"</svg>\s*$", "", inner)
    inner = re.sub(r"<title>.*?</title>", "", inner)
    return f'<svg x="{x:g}" y="{y:g}" width="{size:g}" height="{size:g}" viewBox="0 0 1024 1024">{inner}</svg>'


def word(x_ink, baseline, cap, fill, wght=WORD_WGHT, track=WORD_TRACK, text=WORD, font=GROTESK, cap_ratio=0.70):
    """Text whose ink starts exactly at x_ink; returns (svg, ink_right)."""
    size = cap / cap_ratio
    lo, hi = ink_x(font, wght, text, size, track)
    d, _, _ = text_path(font, wght, text, size, track, x=x_ink - lo, y=baseline)
    return f'<path d="{d}" fill="{fill}"/>', x_ink - lo + hi


def svg_doc(w, h, body, title="Gridkeeper", desc=None):
    d = f"<desc>{desc}</desc>" if desc else ""
    return (f'<svg xmlns="http://www.w3.org/2000/svg" width="{w:g}" height="{h:g}" viewBox="0 0 {w:g} {h:g}">'
            f"<title>{title}</title>{d}\n{body}\n</svg>\n")


def write(name, text):
    p = ASSETS / name
    p.write_text(text, encoding="utf-8", newline="\n")
    return p


# ---------------------------------------------------------------- mark + wordmark

def build_marks():
    bx, by, bw, bh = MARK_BOX
    for name, ink, lit in [("gridkeeper-mark.svg", INK, ION), ("gridkeeper-mark-on-light.svg", INK_LIGHT, ION_LIGHT)]:
        body = mark_body(ink, lit)
        write(f"logo/{name}",
              f'<svg xmlns="http://www.w3.org/2000/svg" width="128" height="128" viewBox="{bx} {by} {bw} {bh}">'
              f"<title>Gridkeeper</title>\n{body}\n</svg>\n")


def build_wordmarks():
    mark = 120.0
    pane = 200 * mark / MARK_BOX[2]  # clear space unit = one pane
    pad = round(pane)
    cap = 50.0
    gap = 40.0
    cy = pad + mark / 2
    out = []
    for name, ink, lit in [("gridkeeper-wordmark.svg", INK, ION), ("gridkeeper-wordmark-on-light.svg", INK_LIGHT, ION_LIGHT)]:
        m = nested_mark(pad, pad, mark, ink, lit)
        t, right = word(pad + mark + gap, cy + cap / 2, cap, ink)
        w = round(right + pad)
        h = round(mark + 2 * pad)
        write(f"logo/{name}", svg_doc(w, h, m + t, desc="Gridkeeper mark and wordmark, type converted to paths"))
        out.append((name, w, h))
    return out


# ---------------------------------------------------------------- banners

def backdrop(w, h, glow_x, glow_y, glow_r, grid=40, frame=36):
    """Flight-deck backdrop: deep space, fading HUD grid, corner brackets, star specks."""
    lines = []
    for x in range(grid, w, grid):
        lines.append(f"M{x} 0V{h}")
    for y in range(grid, h, grid):
        lines.append(f"M0 {y}H{w}")
    f, a = frame, 34
    corners = (f"M{f} {f + a}V{f}H{f + a}M{w - f - a} {f}H{w - f}V{f + a}"
               f"M{w - f} {h - f - a}V{h - f}H{w - f - a}M{f + a} {h - f}H{f}V{h - f - a}")
    # deterministic, sparse specks (no randomness so rebuilds are byte-stable)
    specks = []
    seed = 7
    for i in range(46):
        seed = (seed * 1103515245 + 12345) % 2**31
        x = seed % w
        seed = (seed * 1103515245 + 12345) % 2**31
        y = seed % h
        r = 0.8 + (i % 3) * 0.45
        o = 0.12 + (i % 5) * 0.06
        specks.append(f'<circle cx="{x}" cy="{y}" r="{r:.2f}" opacity="{o:.2f}"/>')
    return f"""<defs>
  <radialGradient id="bgGlow" cx="{glow_x}" cy="{glow_y}" r="{glow_r}" gradientUnits="userSpaceOnUse">
    <stop offset="0" stop-color="#14243d"/><stop offset="0.5" stop-color="#0a101a"/><stop offset="1" stop-color="{BG0}"/>
  </radialGradient>
  <radialGradient id="gridFade" cx="{glow_x}" cy="{glow_y}" r="{max(w, h) * 0.75}" gradientUnits="userSpaceOnUse">
    <stop offset="0" stop-color="#fff" stop-opacity="1"/><stop offset="1" stop-color="#fff" stop-opacity="0"/>
  </radialGradient>
  <mask id="gridMask"><rect width="{w}" height="{h}" fill="url(#gridFade)"/></mask>
  <linearGradient id="scan" x1="0" y1="0" x2="1" y2="0">
    <stop offset="0" stop-color="{ION}" stop-opacity="0"/><stop offset="0.5" stop-color="{ION}" stop-opacity="0.55"/><stop offset="1" stop-color="{CYAN}" stop-opacity="0"/>
  </linearGradient>
</defs>
<rect width="{w}" height="{h}" fill="url(#bgGlow)"/>
<g mask="url(#gridMask)"><path d="{''.join(lines)}" stroke="{INK}" stroke-opacity="0.05" stroke-width="1"/></g>
<g fill="#d6e8ff">{''.join(specks)}</g>
<path d="{corners}" fill="none" stroke="{INK}" stroke-opacity="0.32" stroke-width="2"/>"""


def mini_grid(x, y, w, h, cols, rows, lit, gap=14):
    """A wireframe terminal grid (the product), one pane lit."""
    pw = (w - gap * (cols - 1)) / cols
    ph = (h - gap * (rows - 1)) / rows
    out = ['<g>']
    k = 0
    for r in range(rows):
        for c in range(cols):
            px, py = x + c * (pw + gap), y + r * (ph + gap)
            on = (c, r) == lit
            stroke = ION if on else INK
            so = 0.85 if on else 0.16
            fill = ION if on else "#0a0e15"
            fo = 0.1 if on else 0.9
            if on:
                out.append(f'<rect x="{px:.1f}" y="{py:.1f}" width="{pw:.1f}" height="{ph:.1f}" rx="10" fill="{ION}" '
                           f'opacity="0.35" filter="url(#paneGlow)"/>')
            out.append(f'<rect x="{px:.1f}" y="{py:.1f}" width="{pw:.1f}" height="{ph:.1f}" rx="10" fill="{fill}" '
                       f'fill-opacity="{fo}" stroke="{stroke}" stroke-opacity="{so}" stroke-width="1.5"/>')
            # title-bar lamp + a few "output" bars
            out.append(f'<circle cx="{px + 16:.1f}" cy="{py + 16:.1f}" r="3.5" fill="{ION if on else INK}" '
                       f'fill-opacity="{0.95 if on else 0.25}"/>')
            widths = [0.62, 0.44, 0.7, 0.3, 0.52, 0.38][(k % 3):(k % 3) + 4]
            for i, fw in enumerate(widths):
                by = py + 36 + i * 13
                if by + 5 > py + ph - 10:
                    break
                out.append(f'<rect x="{px + 12:.1f}" y="{by:.1f}" width="{(pw - 24) * fw:.1f}" height="5" rx="2.5" '
                           f'fill="{INK}" fill-opacity="{0.22 if on else 0.09}"/>')
            if on:
                cy_ = py + ph - 22
                out.append(f'<path d="M{px + 14:.1f} {cy_ - 6:.1f}l6 6-6 6" fill="none" stroke="{ION_FG}" '
                           f'stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/>'
                           f'<rect x="{px + 26:.1f}" y="{cy_ - 7:.1f}" width="8" height="14" rx="1" fill="{ION_FG}"/>')
            k += 1
    out.append("</g>")
    return "".join(out)


GLOW_DEF = ('<defs><filter id="paneGlow" x="-50%" y="-50%" width="200%" height="200%">'
            '<feGaussianBlur stdDeviation="14"/></filter></defs>')


def build_social():
    w, h = 1280, 640
    body = [backdrop(w, h, 330, 300, 760), GLOW_DEF]
    icon = 208
    body.append(nested_icon(108, 112, icon))
    tx = 126
    over, _ = word(tx, 392, 12, ION_FG, wght=500, track=0.24, text="MULTI-AGENT TERMINAL GRID  /  WINDOWS",
                   font=MONO, cap_ratio=0.71)
    wm, wr = word(tx, 474, 54, INK)
    tag, _ = word(tx, 530, 27, INK_2, wght=420, track=-0.005, text="Every agent in one grid.", font=GEIST, cap_ratio=0.71)
    body += [over, wm, tag]
    # right: the product, as a wireframe grid
    assert wr < 700, wr
    body.append(mini_grid(752, 128, 410, 384, 3, 3, (1, 0), gap=12))
    body.append(f'<rect x="752" y="536" width="410" height="1.5" fill="url(#scan)"/>')
    write("social-preview.svg", svg_doc(w, h, "\n".join(body),
                                        desc="Gridkeeper: every agent in one grid. Social preview 1280x640."))


def build_hero():
    w, h = 1600, 400
    body = [backdrop(w, h, 260, 200, 700), GLOW_DEF]
    icon = 192
    body.append(nested_icon(96, 104, icon))
    tx = 96 + icon + 44
    over, _ = word(tx, 150, 11.5, ION_FG, wght=500, track=0.24, text="MULTI-AGENT TERMINAL GRID  /  WINDOWS",
                   font=MONO, cap_ratio=0.71)
    wm, wr = word(tx, 232, 60, INK)
    tag, _ = word(tx, 288, 26, INK_2, wght=420, track=-0.005, text="Every agent in one grid.", font=GEIST, cap_ratio=0.71)
    body += [over, wm, tag]
    body.append(mini_grid(1004, 72, 500, 256, 4, 2, (2, 0), gap=12))
    body.append(f'<rect x="1004" y="344" width="500" height="1.5" fill="url(#scan)"/>')
    write("hero-banner.svg", svg_doc(w, h, "\n".join(body),
                                     desc="Gridkeeper: every agent in one grid. README hero banner 1600x400."))


def main():
    build_marks()
    lockups = build_wordmarks()
    build_social()
    build_hero()
    shutil.copyfile(LOGO / "gridkeeper-icon-small.svg", ROOT / "public" / "favicon.svg")

    render(LOGO / "gridkeeper-icon.svg", LOGO / "gridkeeper-icon-1024.png", 1024)
    render(LOGO / "gridkeeper-icon.svg", LOGO / "gridkeeper-icon-512.png", 512)
    render(LOGO / "gridkeeper-icon.svg", LOGO / "gridkeeper-icon-256.png", 256)
    render(LOGO / "gridkeeper-mark.svg", LOGO / "gridkeeper-mark-512.png", 512)
    render(LOGO / "gridkeeper-mark-on-light.svg", LOGO / "gridkeeper-mark-on-light-512.png", 512)
    for name, w, h in lockups:
        render(LOGO / name, LOGO / name.replace(".svg", "@2x.png"), w * 2, h * 2)
    render(ASSETS / "social-preview.svg", ASSETS / "social-preview.png", 1280, 640)
    render(ASSETS / "hero-banner.svg", ASSETS / "hero-banner.png", 1600, 400)
    print("lockups:", lockups)


if __name__ == "__main__":
    main()
