# browxai brand kit

The official browxai mark and its derived assets. The vector mark is the source
of truth; the raster files are generated from it by [`render.py`](./render.py)
(favicons + marks) and [`hig.py`](./hig.py) (aurora app icons).

## The mark

An orbiting pair of arcs around a navigation-cursor glyph: a browser in motion,
driven toward a target. The glyph is monochrome; on icons it sits on a violet
"aurora" tile with a soft glass treatment.

## Palette (aurora)

| Token         | Hex       | Use                                   |
| ------------- | --------- | ------------------------------------- |
| Aurora deep   | `#341070` | Top of the icon gradient              |
| Aurora bright | `#9032E0` | Bottom of the icon gradient           |
| Violet 700    | `#6D28D9` | Tile gradient top / deep accent       |
| Violet 600    | `#9333EA` | Tile gradient bottom / primary accent |
| Pink glow     | `#EC4899` | The aurora highlight glow             |
| White         | `#FAFAF7` | The mark and ink on dark surfaces     |
| Ink           | `#16161A` | The mark on light surfaces            |

The documentation site (`website/`) carries this palette: a violet accent and
glass / aurora surfaces. The mark stays monochrome in the header.

## Files

| File                                                  | What it is                                                          |
| ----------------------------------------------------- | ------------------------------------------------------------------- |
| `browxai-mark.svg`                                    | The glyph using `currentColor`.                                     |
| `browxai-mark-black.svg` / `-white.svg`               | The glyph in ink / white, for light / dark surfaces.                |
| `browxai-favicon.svg`                                 | Tile favicon: violet gradient square + white glyph.                 |
| `favicon.ico`                                         | Multi-resolution ICO (16/32/48).                                    |
| `favicon-16.png` / `-32.png`                          | Raster favicons.                                                    |
| `apple-touch-icon.png`                                | 180px touch icon (the tile).                                        |
| `browxai-aurora-fullbleed-1024.png`                   | App-store icon master: glass glyph on the full-bleed aurora.        |
| `browxai-glass-aurora-1024.png`                       | Squircle marketing preview (Mac-dock margin + edge highlight).      |
| `browxai-avatar-512.png`                              | Social / GitHub-org avatar (aurora; GitHub crops to a circle).      |
| `icon-composer-layers/`                               | Flat background + flat glyph for Apple Icon Composer (no baked fx). |
| `aurora-hig-preview.png` / `favicon-tile-preview.png` | Reference renders.                                                  |
| `render.py`                                           | Regenerates the favicons + standalone marks.                        |
| `hig.py`                                              | Regenerates the aurora app icons (palette lives in its `V` dict).   |

## Regenerating

```sh
pip install cairosvg pillow
python3 brand/render.py   # favicons + marks
python3 brand/hig.py      # aurora app icons + Icon Composer layers
```

## Where these are used

The documentation site consumes the mark and favicons:

- `website/src/assets/mark-light.svg` / `mark-dark.svg` — the header logo
  (the monochrome glyph: ink on the light theme, white on the dark theme).
- `website/public/favicon.svg`, `favicon.ico`, `favicon-16.png`,
  `favicon-32.png`, `apple-touch-icon.png` — the tile favicons.

When the brand changes, update the source SVGs here, run the scripts, then copy
the relevant files into `website/`.
