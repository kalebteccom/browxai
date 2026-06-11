"""Regenerate the browxai favicons and standalone marks.

Two sources of truth, both vector:
  - the mark glyph (the `MARK` paths) -> the solid-color standalone SVGs;
  - browxai-favicon.svg (the violet tile + white glyph) -> the raster favicons.

    pip install cairosvg pillow
    python3 brand/render.py

For the aurora app icons (full-bleed master, squircle, Icon Composer layers),
see hig.py.
"""

import os

import cairosvg
from PIL import Image

HERE = os.path.dirname(os.path.abspath(__file__))

MARK = (
    '<path d="M15.2 56.8A34 34 0 0 1 56.8 15.2" stroke="{c}" stroke-width="8" '
    'stroke-linecap="round" fill="none"/>'
    '<path d="M80.8 39.2A34 34 0 0 1 39.2 80.8" stroke="{c}" stroke-width="8" '
    'stroke-linecap="round" fill="none"/>'
    '<path d="M31 64L34.4 39.4L67.8 27.2L55.6 60.6Z" fill="{c}"/>'
)

# Solid-color standalone marks (the glyph; the header logo uses these).
for name, color in [("black", "#16161A"), ("white", "#FAFAF7")]:
    with open(f"{HERE}/browxai-mark-{name}.svg", "w") as f:
        f.write(
            '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 96 96" '
            f'fill="none">{MARK.format(c=color)}</svg>'
        )

# Raster favicons: rasterize the violet tile favicon at each size.
fav = open(f"{HERE}/browxai-favicon.svg", "rb").read()
for px in (16, 32, 48):
    cairosvg.svg2png(bytestring=fav, write_to=f"{HERE}/favicon-{px}.png",
                     output_width=px, output_height=px)
cairosvg.svg2png(bytestring=fav, write_to=f"{HERE}/apple-touch-icon.png",
                 output_width=180, output_height=180)

# Multi-resolution ICO.
imgs = [Image.open(f"{HERE}/favicon-{px}.png") for px in (16, 32, 48)]
imgs[2].save(f"{HERE}/favicon.ico", format="ICO",
             sizes=[(16, 16), (32, 32), (48, 48)], append_images=imgs[:2])

print("done")
