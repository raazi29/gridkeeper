"""Rasterize an SVG to a transparent PNG at an exact pixel size using headless Microsoft Edge.

Usage: python render.py <in.svg> <out.png> <width> [height]

The SVG is placed top-left at its exact CSS pixel size inside a window at least 1024 px
square (Edge clamps tiny windows), screenshotted with a transparent default background,
then cropped with Pillow. Fails loudly if the result has no alpha channel.
"""
import os
import subprocess
import sys
import tempfile
from pathlib import Path

from PIL import Image

EDGE = r"C:\Program Files (x86)\Microsoft\Edge\Application\msedge.exe"


def render(svg, out, w, h=None):
    h = h or w
    svg = Path(svg).resolve()
    out = Path(out).resolve()
    win_w, win_h = max(w, 1024), max(h, 1024)
    with tempfile.TemporaryDirectory() as td:
        page = Path(td) / "page.html"
        shot = Path(td) / "shot.png"
        page.write_text(
            "<!doctype html><html><head><meta charset='utf-8'><style>"
            "html,body{margin:0;padding:0;background:transparent;overflow:hidden}"
            f"img{{display:block;width:{w}px;height:{h}px}}"
            f"</style></head><body><img src='{svg.as_uri()}'></body></html>",
            encoding="utf-8",
        )
        subprocess.run(
            [
                EDGE,
                "--headless=new",
                "--disable-gpu",
                "--hide-scrollbars",
                "--no-first-run",
                "--force-device-scale-factor=1",
                "--default-background-color=00000000",
                f"--user-data-dir={Path(td) / 'profile'}",
                f"--window-size={win_w},{win_h}",
                f"--screenshot={shot}",
                page.as_uri(),
            ],
            check=True,
            capture_output=True,
            timeout=120,
        )
        im = Image.open(shot)
        im.load()
    if im.mode != "RGBA":
        raise SystemExit(f"{out.name}: screenshot has no alpha ({im.mode})")
    im = im.crop((0, 0, w, h))
    out.parent.mkdir(parents=True, exist_ok=True)
    im.save(out, optimize=True)
    return im


if __name__ == "__main__":
    a = sys.argv
    im = render(a[1], a[2], int(a[3]), int(a[4]) if len(a) > 4 else None)
    print(os.path.basename(a[2]), im.size, im.mode, "corner", im.getpixel((0, 0)))
