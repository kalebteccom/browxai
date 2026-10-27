# browxai brand kit

The official browxai mark and its derived assets. The vector mark is the source
of truth; the raster files are generated from it by [`render.py`](./render.py)
(favicons + marks) and [`hig.py`](./hig.py) (aurora app icons).

## The mark

An orbiting pair of arcs around a navigation-cursor glyph: a browser in motion,
driven toward a target. The glyph is one colour. App icons and favicons set it
on a violet tile.

## Icon palette

These colours live in the icon art only: the tile gradients, the app icons and
the social avatar.

| Token         | Hex       | Use                                     |
| ------------- | --------- | --------------------------------------- |
| Aurora deep   | `#341070` | Top of the app icon gradient (`hig.py`) |
| Aurora bright | `#9032E0` | Bottom of the app icon gradient         |
| Violet 700    | `#6D28D9` | Top of the favicon tile gradient        |
| Violet 600    | `#9333EA` | Bottom of the favicon tile gradient     |
| Pink glow     | `#EC4899` | Highlight in the app icons              |
| White         | `#FAFAF7` | The mark on dark surfaces               |
| Ink           | `#16161A` | The mark on light surfaces              |

## Site palette

The documentation site (`website/`) is flat: solid surfaces, 1px borders, no
gradients, glow, blur or glass. The tokens live in
`website/src/styles/brand-tokens.css`.

| Token                | Hex       | Use                         |
| -------------------- | --------- | --------------------------- |
| `--browx-accent`     | `#7e22ce` | The one accent, both themes |
| `--browx-violet-400` | `#c084fc` | Accent text on dark         |
| `--browx-violet-700` | `#7e22ce` | Accent text on light        |
| Dark canvas          | `#0c0a14` | Page background             |
| Dark sidebar         | `#100c1c` | Surfaces                    |
| Light canvas         | `#fbfaff` | Page background             |
| Light sidebar        | `#f5f1fd` | Surfaces                    |

Type is Poppins for headings, Inter for text and JetBrains Mono for code only.

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

The documentation site uses the tile and the favicons:

- `website/src/assets/browxai-tile.svg`: the header logo (the tile with the
  glyph).
- `website/public/favicon.svg`, `favicon.ico`, `favicon-16.png`,
  `favicon-32.png`, `apple-touch-icon.png`: the tile favicons.

When the brand changes, update the source SVGs here, run the scripts, then copy
the relevant files into `website/`.
