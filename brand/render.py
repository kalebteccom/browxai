"""Regenerate the browxai brand raster assets from the vector mark.

The SVG mark is the source of truth; this script rasterizes the avatar, app
icon, and favicons from it so every size stays pixel-consistent.

    pip install cairosvg pillow
    python3 brand/render.py

Writes the PNG / ICO outputs next to this script (the brand/ directory).
"""

import os

import cairosvg
from PIL import Image

OUT = os.path.dirname(os.path.abspath(__file__))

MARK = '''<path d="M15.2 56.8A34 34 0 0 1 56.8 15.2" stroke="{c}" stroke-width="8" stroke-linecap="round" fill="none"/>
<path d="M80.8 39.2A34 34 0 0 1 39.2 80.8" stroke="{c}" stroke-width="8" stroke-linecap="round" fill="none"/>
<path d="M31 64L34.4 39.4L67.8 27.2L55.6 60.6Z" fill="{c}"/>'''

MARK_SMALL = '''<path d="M14.5 53.9A34 34 0 0 1 53.9 14.5" stroke="{c}" stroke-width="10" stroke-linecap="round" fill="none"/>
<path d="M81.5 42.1A34 34 0 0 1 42.1 81.5" stroke="{c}" stroke-width="10" stroke-linecap="round" fill="none"/>
<path d="M29.6 65.4L33.2 38.9L69.3 25.7L56.1 61.8Z" fill="{c}"/>'''

def svg_doc(size, bg, mark, color, coverage):
    s = size * coverage / 96.0
    off = (size - 96 * s) / 2.0
    bg_rect = f'<rect width="{size}" height="{size}" fill="{bg}"/>' if bg else ''
    return f'''<svg xmlns="http://www.w3.org/2000/svg" width="{size}" height="{size}" viewBox="0 0 {size} {size}">
{bg_rect}<g transform="translate({off:.1f},{off:.1f}) scale({s:.4f})">{mark.format(c=color)}</g></svg>'''

def render(svg, path, size):
    cairosvg.svg2png(bytestring=svg.encode(), write_to=path,
                     output_width=size, output_height=size)

# GitHub avatar: white mark on near-black, 64% coverage (GitHub crops to circle)
render(svg_doc(512, "#0D0D0F", MARK, "#FAFAF7", 0.60), f"{OUT}/browxai-avatar-512.png", 512)

# App icon: 1024, slightly more padding for OS masking grids
render(svg_doc(1024, "#0D0D0F", MARK, "#FAFAF7", 0.58), f"{OUT}/browxai-appicon-1024.png", 1024)

# Solid color standalone SVGs
for name, color in [("black", "#16161A"), ("white", "#FAFAF7")]:
    with open(f"{OUT}/browxai-mark-{name}.svg", "w") as f:
        f.write(f'<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 96 96" fill="none">{MARK.format(c=color)}</svg>')

# Favicon PNGs from the small-optimized cut, dark ink on transparent
for px in (16, 32, 48):
    render(svg_doc(96, None, MARK_SMALL, "#16161A", 1.0), f"{OUT}/favicon-{px}.png", px)

# Multi-resolution ICO
imgs = [Image.open(f"{OUT}/favicon-{px}.png") for px in (16, 32, 48)]
imgs[2].save(f"{OUT}/favicon.ico", format="ICO",
             sizes=[(16, 16), (32, 32), (48, 48)],
             append_images=imgs[:2])

print("\n".join(sorted(os.listdir(OUT))))
