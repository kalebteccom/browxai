# browxai brand kit

The official browxai mark and its derived assets. The vector mark is the source
of truth; every raster file is generated from it by [`render.py`](./render.py).

## The mark

An orbiting pair of arcs around a navigation-cursor glyph: a browser in motion,
driven toward a target. It is monochrome by design and reads at any size.

Use the documentation site's lime accent for UI (links, buttons); the mark
itself stays monochrome.

## Colors

| Token  | Hex       | Use                                 |
| ------ | --------- | ----------------------------------- |
| Ink    | `#16161A` | The mark on a light surface         |
| White  | `#FAFAF7` | The mark on a dark surface          |
| Canvas | `#0D0D0F` | The near-black background for icons |

## Files

| File                         | What it is                                                           |
| ---------------------------- | -------------------------------------------------------------------- |
| `browxai-mark.svg`           | The mark using `currentColor` — inherits the surrounding text color. |
| `browxai-mark-black.svg`     | The mark in ink (`#16161A`), for light backgrounds.                  |
| `browxai-mark-white.svg`     | The mark in white (`#FAFAF7`), for dark backgrounds.                 |
| `browxai-favicon.svg`        | Favicon; adapts to light/dark via `prefers-color-scheme`.            |
| `favicon.ico`                | Multi-resolution ICO (16/32/48) for legacy browsers.                 |
| `favicon-16.png` / `-32.png` | Raster favicons.                                                     |
| `browxai-appicon-1024.png`   | App / store icon: white mark on `#0D0D0F`, padded for OS mask grids. |
| `browxai-avatar-512.png`     | Social / GitHub-org avatar (GitHub crops to a circle).               |
| `render.py`                  | Regenerates every raster file from the vector mark.                  |

## Regenerating

```sh
pip install cairosvg pillow
python3 brand/render.py
```

## Where these are used

The documentation site (`website/`) consumes the mark and favicons:

- `website/src/assets/mark-light.svg` / `mark-dark.svg` — the header logo
  (ink on the light theme, white on the dark theme).
- `website/public/favicon.svg`, `favicon.ico`, `favicon-16.png`,
  `favicon-32.png`, `apple-touch-icon.png` — the browser/OS icons.

When the mark changes, update the source SVGs here, run `render.py`, then copy
the relevant files into `website/`.
