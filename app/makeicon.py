#!/usr/bin/env python3
"""
makeicon.py — FreeCoffee app + PWA icon generator (pure python3 stdlib).

WHY THIS PATH (documented for build.sh): this script renders every icon by
writing raw PNG files with zlib + struct only — no Pillow, no network, no
external tools. Shapes (rounded square, cup body, handle, saucer, steam) are
rasterized with analytic anti-aliasing (signed-distance coverage with a ~1px
feather), so no supersampling pass is needed and the 1024px master renders in
seconds. The documented fallback (a Swift/CoreGraphics icongen.swift compiled
by build.sh) proved unnecessary: this path is deterministic and reliable on
stock macOS python3.

Outputs (paths relative to this file's app/ directory):
  icon_1024.png                       — master icon
  FreeCoffee.iconset/icon_*.png       — every size iconutil needs
                                       (16/32/64/128/256/512/1024 as @1x/@2x)
  ../assets/icons/icon-192.png        — PWA icon (purpose: any)
  ../assets/icons/icon-512.png        — PWA icon (purpose: any)
  ../assets/icons/icon-maskable-512.png — PWA icon (purpose: maskable)

Design: espresso-black rounded square (#14100D family) with a coffee-gold
cup glyph (#E0A93E): cup body, handle, saucer bar, and two steam wisps.

build.sh then runs:  iconutil -c icns FreeCoffee.iconset -o AppIcon.icns
"""

import math
import os
import struct
import zlib

# ---------------------------------------------------------------------------
# Palette (matches assets/css/styles.css :root)
# ---------------------------------------------------------------------------
BG_TOP = (26, 20, 15)          # subtle vertical gradient, near --panel #1A140F
BG_BOTTOM = (12, 9, 7)         # near --bg #14100D
CUP_COLOR = (224, 169, 62)     # #E0A93E — accent coffee gold
STEAM_COLOR = (239, 190, 90)   # #EFBE5A — gold-bright, slightly lighter steam

CORNER = 0.225               # macOS-style corner radius (fraction of canvas)


def clamp(v, lo=0.0, hi=1.0):
    return lo if v < lo else (hi if v > hi else v)


def rounded_rect_alpha(x, y, x0, y0, x1, y1, r, feather):
    """Coverage of an axis-aligned rounded rect; `feather` softens the edge."""
    cx = (x0 + x1) * 0.5
    cy = (y0 + y1) * 0.5
    hw = (x1 - x0) * 0.5 - r
    hh = (y1 - y0) * 0.5 - r
    dx = abs(x - cx) - hw
    dy = abs(y - cy) - hh
    if dx > 0.0 and dy > 0.0:
        d = math.hypot(dx, dy) - r
    else:
        d = (dx if dx > dy else dy) - r
    return clamp(0.5 - d / feather)


def render(size, maskable=False):
    """Render the FreeCoffee icon at `size`×`size`, RGBA bytearray.

    maskable=False → rounded-square tile with transparent corners.
    maskable=True  → full-bleed square; the whole glyph is scaled uniformly
                     about the center into the ~80% safe circle.
    """
    s = 0.82 if maskable else 1.0      # uniform center-scale of the glyph
    feather = 1.0 / size               # ≈1px analytic AA

    def T(v):
        """Scale a unit coordinate about the canvas center."""
        return (v - 0.5) * s + 0.5

    # ---- Scene, in unit coordinates (y grows downward) --------------------
    # Cup body: rounded rect, slightly tapered look via two stacked rects is
    # overkill — one rounded rect reads cleanly at 16px.
    cup_x0, cup_x1 = T(0.24), T(0.62)
    cup_y0, cup_y1 = T(0.33), T(0.72)
    cup_r = 0.055 * s

    # Handle: a ring to the right of the body — outer circle minus inner
    # circle, clipped to the right half so it merges into the cup.
    hd_cx, hd_cy = T(0.655), T(0.475)
    hd_ro = 0.115 * s
    hd_ri = 0.058 * s

    # Saucer: a wide flat bar under the cup.
    sc_x0, sc_x1 = T(0.17), T(0.83)
    sc_y0, sc_y1 = T(0.765), T(0.815)
    sc_r = 0.02 * s

    # Steam: two vertical capsules rising from the cup mouth, the right one
    # slightly taller. Rendered as rounded rects (capsules).
    st1 = (T(0.335), T(0.135), T(0.375), T(0.27))   # x0, y0, x1, y1 (left)
    st2 = (T(0.475), T(0.10), T(0.515), T(0.27))    # right, taller
    st_r = 0.019 * s

    px = bytearray(size * size * 4)
    inv = 1.0 / size

    for y in range(size):
        uy = (y + 0.5) * inv
        # Background: vertical gradient color for this row.
        t = uy
        br = BG_TOP[0] + (BG_BOTTOM[0] - BG_TOP[0]) * t
        bg = BG_TOP[1] + (BG_BOTTOM[1] - BG_TOP[1]) * t
        bb = BG_TOP[2] + (BG_BOTTOM[2] - BG_TOP[2]) * t
        row = y * size * 4
        for x in range(size):
            ux = (x + 0.5) * inv
            abg = 1.0 if maskable else rounded_rect_alpha(
                ux, uy, 0.0, 0.0, 1.0, 1.0, CORNER, feather)
            if abg <= 0.0:
                continue  # fully transparent corner
            rr = br
            gg = bg
            bb2 = bb

            # --- Coffee cup glyph (gold) ---------------------------------
            cov = 0.0

            # Cup body.
            a = rounded_rect_alpha(ux, uy, cup_x0, cup_y0, cup_x1, cup_y1,
                                   cup_r, feather)
            cov = max(cov, a)

            # Handle ring: outer circle minus inner circle, right half only
            # (x past the cup's right wall) so it visually attaches.
            dxo = math.hypot(ux - hd_cx, uy - hd_cy)
            outer = clamp(0.5 - (dxo - hd_ro) * size)
            inner = clamp(0.5 - (dxo - hd_ri) * size)
            ring = clamp(outer - inner)
            if ux > cup_x1 - 0.02 * s:      # keep the ring off the body
                cov = max(cov, ring)

            # Saucer bar.
            a = rounded_rect_alpha(ux, uy, sc_x0, sc_y0, sc_x1, sc_y1,
                                   sc_r, feather)
            cov = max(cov, a)

            # Steam capsules.
            for (sx0, sy0, sx1, sy1) in (st1, st2):
                a = rounded_rect_alpha(ux, uy, sx0, sy0, sx1, sy1,
                                       st_r, feather)
                cov = max(cov, a)

            if cov > 0.0:
                # Steam gets the lighter tone; everything else CUP_COLOR.
                in_steam = (st1[0] - st_r <= ux <= st1[2] + st_r and st1[1] - st_r <= uy <= st1[3] + st_r) or \
                           (st2[0] - st_r <= ux <= st2[2] + st_r and st2[1] - st_r <= uy <= st2[3] + st_r)
                c = STEAM_COLOR if in_steam else CUP_COLOR
                rr += (c[0] - rr) * cov
                gg += (c[1] - gg) * cov
                bb2 += (c[2] - bb2) * cov

            o = row + x * 4
            px[o] = int(rr + 0.5)
            px[o + 1] = int(gg + 0.5)
            px[o + 2] = int(bb2 + 0.5)
            px[o + 3] = int(abg * 255.0 + 0.5)
    return px


def write_png(path, w, h, rgba):
    """Minimal PNG writer: 8-bit RGBA, filter 0 scanlines, zlib IDAT."""
    def chunk(tag, data):
        return (struct.pack('>I', len(data)) + tag + data +
                struct.pack('>I', zlib.crc32(tag + data) & 0xFFFFFFFF))

    ihdr = struct.pack('>IIBBBBB', w, h, 8, 6, 0, 0, 0)
    stride = w * 4
    raw = bytearray()
    for y in range(h):
        raw.append(0)
        raw += rgba[y * stride:(y + 1) * stride]
    with open(path, 'wb') as f:
        f.write(b'\x89PNG\r\n\x1a\n')
        f.write(chunk(b'IHDR', ihdr))
        f.write(chunk(b'IDAT', zlib.compress(bytes(raw), 9)))
        f.write(chunk(b'IEND', b''))


def halve(rgba, w):
    """2×2 box-filter downscale (RGBA bytearray w×w → w/2×w/2)."""
    nw = w // 2
    out = bytearray(nw * nw * 4)
    for oy in range(nw):
        r0 = (oy * 2) * w * 4
        r1 = r0 + w * 4
        orow = oy * nw * 4
        for ox in range(nw):
            x0 = ox * 8  # ox*2 pixels × 4 channels
            for c in range(4):
                s = (rgba[r0 + x0 + c] + rgba[r0 + x0 + 4 + c] +
                     rgba[r1 + x0 + c] + rgba[r1 + x0 + 4 + c])
                out[orow + ox * 4 + c] = s >> 2
    return out


def main():
    app_dir = os.path.dirname(os.path.abspath(__file__))
    root_dir = os.path.dirname(app_dir)
    icons_dir = os.path.join(root_dir, 'assets', 'icons')
    iconset_dir = os.path.join(app_dir, 'FreeCoffee.iconset')
    os.makedirs(icons_dir, exist_ok=True)
    os.makedirs(iconset_dir, exist_ok=True)

    print('==> rendering 1024×1024 master (pure-stdlib PNG writer)')
    master = render(1024)
    master_path = os.path.join(app_dir, 'icon_1024.png')
    write_png(master_path, 1024, 1024, master)
    print('    wrote ' + master_path)

    # Iconset sizes (16, 32, 64, 128, 256, 512, 1024) via box-filter chain.
    sizes = {}
    cur, w = master, 1024
    for target in (512, 256, 128, 64, 32, 16):
        cur = halve(cur, w)
        w //= 2
        sizes[w] = cur
    sizes[1024] = master
    iconset_names = {
        16: ['icon_16x16.png'], 32: ['icon_16x16@2x.png', 'icon_32x32.png'],
        64: ['icon_32x32@2x.png'], 128: ['icon_128x128.png'],
        256: ['icon_128x128@2x.png', 'icon_256x256.png'],
        512: ['icon_256x256@2x.png', 'icon_512x512.png'],
        1024: ['icon_512x512@2x.png'],
    }
    for s in (16, 32, 64, 128, 256, 512, 1024):
        for name in iconset_names[s]:
            write_png(os.path.join(iconset_dir, name), s, s, sizes[s])
    print('    wrote FreeCoffee.iconset/ (%d PNGs)' % sum(len(v) for v in iconset_names.values()))

    # PWA icons: same art; 192 and maskable rendered natively at target size.
    print('==> rendering PWA icons (assets/icons/)')
    write_png(os.path.join(icons_dir, 'icon-192.png'), 192, 192, render(192))
    write_png(os.path.join(icons_dir, 'icon-512.png'), 512, 512, sizes[512])
    write_png(os.path.join(icons_dir, 'icon-maskable-512.png'), 512, 512, render(512, maskable=True))
    print('    wrote icon-192.png, icon-512.png, icon-maskable-512.png')
    print('==> icons done')


if __name__ == '__main__':
    main()
