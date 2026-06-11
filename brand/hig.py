"""Regenerate the browxai aurora app icons from the vector mark.

Produces the full-bleed production master, the Apple Icon Composer layers
(flat background + flat white glyph), and a squircle marketing preview, all in
the violet/aurora palette. The mark glyph is the source of truth; the palette
lives in the V dict below.

    pip install cairosvg pillow
    python3 brand/hig.py

For the favicons and standalone marks, see render.py.
"""

import io
import os

import cairosvg
from PIL import Image, ImageFilter

OUT = os.path.dirname(os.path.abspath(__file__))
LAYERS = f"{OUT}/icon-composer-layers"
os.makedirs(LAYERS, exist_ok=True)
S = 1024

ARC1 = "M17.2 59.8A33 33 0 0 1 59.8 17.2"
ARC2 = "M78.8 36.2A33 33 0 0 1 36.2 78.8"
KITE = "M31 64L34.4 39.4L67.8 27.2L55.6 60.6Z"

V = {
    "bg_top": "#341070", "bg_bot": "#9032E0",
    "glow": "rgba(236,72,153,0.42)", "glow_pos": (0.75, 0.18),
    "ink_top": "rgba(255,255,255,0.97)", "ink_bot": "rgba(255,255,255,0.74)",
    "spec": "rgba(255,255,255,0.95)", "refr": "rgba(40,8,80,0.30)",
}

# Concentric grid placement: ring outer diameter = 56% of tile.
# Mark's outer ring in the 96 grid = 76 units (r33 + 5 stroke), so:
# glyph box = 0.56 * 1024 * 96/76 = 724px
def geom(tile):
    box = 0.56 * tile * 96 / 76
    return box / 96, (S - box) / 2

def render_png(svg):
    return Image.open(io.BytesIO(cairosvg.svg2png(
        bytestring=svg.encode(), output_width=S, output_height=S))).convert("RGBA")

def bg_svg(full_bleed=True):
    return f'''<svg xmlns="http://www.w3.org/2000/svg" width="{S}" height="{S}">
<defs>
<linearGradient id="bg" x1="0" y1="0" x2="0" y2="1">
  <stop offset="0" stop-color="{V['bg_top']}"/><stop offset="1" stop-color="{V['bg_bot']}"/>
</linearGradient>
<radialGradient id="glow" cx="{V['glow_pos'][0]}" cy="{V['glow_pos'][1]}" r="0.75">
  <stop offset="0" stop-color="{V['glow']}"/><stop offset="1" stop-color="rgba(255,255,255,0)"/>
</radialGradient>
</defs>
<rect width="{S}" height="{S}" fill="url(#bg)"/>
<rect width="{S}" height="{S}" fill="url(#glow)"/>
</svg>'''

def mark_svg(scale, off, glass=True):
    inner = (f'<path d="{ARC1}" stroke="url(#ink)" stroke-width="10" fill="none"/>'
             f'<path d="{ARC2}" stroke="url(#ink)" stroke-width="10" fill="none"/>'
             f'<path d="{KITE}" fill="url(#ink)"/>')
    extras = ""
    if glass:
        extras = (f'<path d="M19.2 56.3A30 30 0 0 1 56.3 19.2" stroke="{V["refr"]}" stroke-width="0.9" fill="none"/>'
                  f'<path d="M76.8 39.7A30 30 0 0 1 39.7 76.8" stroke="{V["refr"]}" stroke-width="0.9" fill="none"/>'
                  f'<path d="M13.4 57.9A36 36 0 0 1 57.9 13.4" stroke="{V["spec"]}" stroke-width="0.9" fill="none"/>'
                  f'<path d="M82.6 38.1A36 36 0 0 1 38.1 82.6" stroke="{V["spec"]}" stroke-width="0.9" fill="none"/>'
                  f'<path d="M34.4 39.4L67.8 27.2" stroke="{V["spec"]}" stroke-width="1.1" fill="none"/>'
                  f'<path d="M31 64L34.4 39.4" stroke="rgba(255,255,255,0.55)" stroke-width="0.8" fill="none"/>')
    ink = ('<linearGradient id="ink" x1="0" y1="0" x2="0" y2="1">'
           f'<stop offset="0" stop-color="{V["ink_top"]}"/><stop offset="1" stop-color="{V["ink_bot"]}"/>'
           '</linearGradient>') if glass else \
          ('<linearGradient id="ink" x1="0" y1="0" x2="0" y2="1">'
           '<stop offset="0" stop-color="#FFFFFF"/><stop offset="1" stop-color="#FFFFFF"/></linearGradient>')
    return f'''<svg xmlns="http://www.w3.org/2000/svg" width="{S}" height="{S}">
<defs>{ink}</defs>
<g transform="translate({off:.1f},{off:.1f}) scale({scale:.4f})">{inner}{extras}</g></svg>'''

def shadow_layer(scale, off):
    svg = f'''<svg xmlns="http://www.w3.org/2000/svg" width="{S}" height="{S}">
<g transform="translate({off:.1f},{off:.1f}) scale({scale:.4f})">
<path d="{ARC1}" stroke="black" stroke-width="10" fill="none"/>
<path d="{ARC2}" stroke="black" stroke-width="10" fill="none"/>
<path d="{KITE}" fill="black"/></g></svg>'''
    sh = render_png(svg)
    alpha = sh.split()[3].point(lambda a: int(a * 0.32))
    sh.putalpha(alpha)
    sh = sh.filter(ImageFilter.GaussianBlur(14))
    shifted = Image.new("RGBA", (S, S), (0, 0, 0, 0))
    shifted.paste(sh, (0, 12), sh)
    return shifted

# 1. Full-bleed production master (square, opaque, system masks it)
scale, off = geom(S)
master = render_png(bg_svg())
master.alpha_composite(shadow_layer(scale, off))
master.alpha_composite(render_png(mark_svg(scale, off, glass=True)))
master.convert("RGB").save(f"{OUT}/browxai-aurora-fullbleed-1024.png")

# 2. Icon Composer layers: flat background + flat white glyph, no baked effects
render_png(bg_svg()).convert("RGB").save(f"{LAYERS}/background.png")
render_png(mark_svg(scale, off, glass=False)).save(f"{LAYERS}/mark.png")

# 3. Marketing preview: squircle + Mac dock margin, glyph at the same 56% concentric ratio
SQ, M, R = 824, 100, 185
p_scale = 0.56 * SQ * 96 / 76 / 96
p_off = (S - p_scale * 96) / 2
mask_svg = f'''<svg xmlns="http://www.w3.org/2000/svg" width="{S}" height="{S}">
<rect x="{M}" y="{M}" width="{SQ}" height="{SQ}" rx="{R}" fill="white"/></svg>'''
mask = render_png(mask_svg).split()[3]
tile = render_png(bg_svg())
tile.alpha_composite(shadow_layer(p_scale, p_off))
tile.alpha_composite(render_png(mark_svg(p_scale, p_off, glass=True)))
edge = f'''<svg xmlns="http://www.w3.org/2000/svg" width="{S}" height="{S}">
<rect x="{M + 3}" y="{M + 3}" width="{SQ - 6}" height="{SQ - 6}" rx="{R - 3}" fill="none" stroke="rgba(0,0,0,0.28)" stroke-width="6"/>
<rect x="{M + 5}" y="{M + 5}" width="{SQ - 10}" height="{SQ - 10}" rx="{R - 5}" fill="none" stroke="rgba(255,255,255,0.30)" stroke-width="2.5"/>
</svg>'''
preview = Image.new("RGBA", (S, S), (0, 0, 0, 0))
preview.paste(tile, (0, 0), mask)
preview.alpha_composite(render_png(edge))
preview.save(f"{OUT}/browxai-glass-aurora-1024.png")

# Comparison sheet: old proportion note vs new, plus the production master
sheet = Image.new("RGBA", (1180, 420), (242, 240, 235, 255))
a = Image.open(f"{OUT}/browxai-aurora-fullbleed-1024.png").convert("RGBA").resize((320, 320), Image.LANCZOS)
b = Image.open(f"{OUT}/browxai-glass-aurora-1024.png").resize((320, 320), Image.LANCZOS)
c = Image.open(f"{LAYERS}/mark.png").resize((320, 320), Image.LANCZOS)
cbg = Image.new("RGBA", (320, 320), (40, 40, 46, 255))
cbg.alpha_composite(c)
sheet.paste(a, (60, 50), a)
sheet.paste(b, (430, 50), b)
sheet.paste(cbg, (800, 50), cbg)
sheet.save(f"{OUT}/aurora-hig-preview.png")
print("done")
