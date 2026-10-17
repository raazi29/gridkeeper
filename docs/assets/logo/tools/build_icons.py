"""Rebuild the Windows-facing icons in src-tauri/icons from the size-tuned SVGs.

Run after `npx tauri icon docs/assets/logo/gridkeeper-icon-1024.png` (which downsamples the
1024 master for every size and leaves the small sizes muddy). This re-renders each PNG at its
exact size from the variant drawn for that size and rebuilds icon.ico from those renders:

    <= 16  gridkeeper-icon-small.svg   (16 px grid)
    17-28  gridkeeper-icon-24.svg      (24 px grid, Windows 11 taskbar at 100 %)
    29-40  gridkeeper-icon-32.svg      (32 px grid)
    41-96  gridkeeper-icon-mid.svg     (no star specks / prompt glyph, heavier brackets)
    > 96   gridkeeper-icon.svg         (full detail)

Usage (from the repo root): python docs/assets/logo/tools/build_icons.py
"""
from pathlib import Path

from PIL import Image

from render import render

ROOT = Path(__file__).resolve().parents[4]
LOGO = ROOT / "docs" / "assets" / "logo"
ICONS = ROOT / "src-tauri" / "icons"


def variant(size):
    if size <= 16:
        return "gridkeeper-icon-small.svg"
    if size <= 28:
        return "gridkeeper-icon-24.svg"
    if size <= 40:
        return "gridkeeper-icon-32.svg"
    if size <= 96:
        return "gridkeeper-icon-mid.svg"
    return "gridkeeper-icon.svg"


PNGS = {
    "32x32.png": 32,
    "64x64.png": 64,
    "128x128.png": 128,
    "128x128@2x.png": 256,
    "icon.png": 512,
    "Square30x30Logo.png": 30,
    "Square44x44Logo.png": 44,
    "Square71x71Logo.png": 71,
    "Square89x89Logo.png": 89,
    "Square107x107Logo.png": 107,
    "Square142x142Logo.png": 142,
    "Square150x150Logo.png": 150,
    "Square284x284Logo.png": 284,
    "Square310x310Logo.png": 310,
    "StoreLogo.png": 50,
}
ICO_SIZES = [16, 24, 32, 48, 64, 256]


def main():
    for name, size in PNGS.items():
        render(LOGO / variant(size), ICONS / name, size)
        print(f"{name:24} {size:4}px  <- {variant(size)}")

    frames = []
    for size in ICO_SIZES:
        tmp = ICONS / f".ico-{size}.png"
        frames.append(render(LOGO / variant(size), tmp, size).convert("RGBA"))
        tmp.unlink()
    ico = ICONS / "icon.ico"
    big = frames[-1]
    big.save(ico, format="ICO", sizes=[(s, s) for s in ICO_SIZES], append_images=frames[:-1])
    with Image.open(ico) as im:
        print("icon.ico sizes:", sorted(im.info["sizes"]))


if __name__ == "__main__":
    main()
