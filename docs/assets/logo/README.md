# Gridkeeper brand assets

## Concept

**The keeper watching the grid.** A 2×2 grid of terminal panes sits inside four HUD corner
brackets, like a target frame on a flight-deck display. Three panes are ink; one is lit in the
signal colour. That lit pane is the agent that needs you. On the app icon it glows ion blue into
a cyan core, and at large sizes it shows a waiting `>_` prompt.

This is the same construction as `AppMark` in `src/components/icons.tsx`, which the app UI
uses: panes top-left full ink, top-right lit, bottom row ink at 50 %.

The app icon puts the mark on a deep-space tile (Windows 11 rounded square, corner radius 22 %)
with a cool radial falloff, a vignette, a top-lit rim and a few faint star specks. The specks
stay outside the brackets so the mark itself stays clean.

## Size-tuned variants

Small icons are drawn separately, not shrunk from the big one. Brackets, glow and the prompt
glyph turn to mush below about 40 px, so the small variants keep only the tile, a 1 px cool rim
(so the dark tile still shows on the dark Windows taskbar) and the 2×2 grid with one lit pane,
with every edge on a whole pixel.

| File | Use at | Notes |
| --- | --- | --- |
| `gridkeeper-icon-small.svg` | 16 px | 16 px grid: panes 5 px, gap 2 px, margin 2 px |
| `gridkeeper-icon-24.svg` | 24 px | Windows 11 taskbar at 100 % scale. Panes 8, gap 2, margin 3 |
| `gridkeeper-icon-32.svg` | 32 px | 16 px design at 2×, 1 px rim, slight gradient on the lit pane |
| `gridkeeper-icon-mid.svg` | 40–96 px | Full icon without specks or prompt glyph, heavier brackets |
| `gridkeeper-icon.svg` | 128 px and up | Full detail; the master for `gridkeeper-icon-1024.png` |

`src-tauri/icons/icon.ico` holds 16, 24, 32, 48, 64 and 256, each rendered from the variant
for its size.

## Colours

| Role | Hex | Source |
| --- | --- | --- |
| Space (background) | `#07090d` | Deep Space `bg-0` |
| Ink | `#e7ecf4` | Deep Space `text-0` |
| Ink, secondary | `#a9b4c4` | taglines |
| Signal: ion blue | `#4cc2ff` | Deep Space `accent` |
| Signal core: cyan | `#41e2ff` → `#84ebff` | Hyperspace `accent`, lit-pane core |
| Signal as text | `#7dd3ff` | Deep Space `accent-fg` (overlines) |
| Ink on light | `#0e1c30` | Daylight `text-0` |
| Signal on light | `#1d8fe6` | deeper ion blue, at least 3:1 on white |

Type: **Space Grotesk 600**, uppercase, tracking +0.12 em, for the wordmark. Geist for
taglines, Geist Mono (tracking +0.24 em) for HUD overlines. In every SVG here the text is
converted to paths, so no fonts are needed to render them.

## Clear space and minimum size

- **Clear space:** keep at least one pane width clear on every side of the mark or lockup. A
  pane is about 29 % of the mark's height. The lockup SVGs already include this padding.
- **Lockup:** the mark is 2.4× the wordmark's cap height, and the gap between them is 0.8 cap
  heights. Don't rescale the two parts separately.
- **Minimum size:** mark 16 px (use the small tile icon below 24 px), lockup 180 px wide (about a 13 px cap height).
- **Don't:** recolour the ink panes, light more than one pane, move the lit pane (always
  top-right), add outlines or shadows to the mark, or set the wordmark in another font.

## Files

```
docs/assets/logo/
  gridkeeper-icon.svg              full-detail app icon (1024 artboard)
  gridkeeper-icon-mid.svg          40-96 px variant
  gridkeeper-icon-32.svg           32 px variant
  gridkeeper-icon-24.svg           24 px variant
  gridkeeper-icon-small.svg        16 px variant (also public/favicon.svg)
  gridkeeper-icon-1024.png         master raster, transparent corners (input to `tauri icon`)
  gridkeeper-icon-512.png / -256.png
  gridkeeper-mark.svg              mark only, transparent, light ink (for dark backgrounds)
  gridkeeper-mark-on-light.svg     mark only, dark ink (for light backgrounds)
  gridkeeper-mark-512.png / gridkeeper-mark-on-light-512.png
  gridkeeper-wordmark.svg          mark + GRIDKEEPER, light-on-dark (transparent)
  gridkeeper-wordmark-on-light.svg mark + GRIDKEEPER, dark-on-light (transparent)
  gridkeeper-wordmark@2x.png / gridkeeper-wordmark-on-light@2x.png
  tools/                           generators (see below)
docs/assets/social-preview.svg/.png   1280x640 GitHub social preview
docs/assets/hero-banner.svg/.png      1600x400 README hero
public/favicon.svg                    web favicon (the 16 px tile icon)
src-tauri/icons/*                     Tauri bundle icons
```

## Rebuilding

Requires Python 3 with Pillow, fontTools and brotli, Microsoft Edge (used headless to
rasterize), and `node_modules` installed (for the fonts and the Tauri CLI).

```sh
# 1. masters, lockups, banners, favicon (renders every PNG in docs/assets)
python docs/assets/logo/tools/build_brand.py
# 2. Tauri icon set from the 1024 master (also writes icon.icns; delete android/ and ios/ if created)
npx tauri icon docs/assets/logo/gridkeeper-icon-1024.png -o src-tauri/icons
# 3. replace the Windows sizes and icon.ico with the size-tuned renders
python docs/assets/logo/tools/build_icons.py
```

`tools/render.py <svg> <png> <w> [h]` rasterizes any single SVG at an exact size with a
transparent background. `tools/textpaths.py` converts brand type to SVG path data.
