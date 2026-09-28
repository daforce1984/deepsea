"""Tileable PBR textures for the abyssal floor props (numpy + Pillow).
Run (WSL):  uv run --with numpy --with pillow python blender/floor_textures.py
rock_*  : basalt / manganese-crusted boulder: dark crust, botryoidal bumps, pits, pale foraminifera specks, rust stains
coral_* : cold-water coral skin: packed corallite cups (polyps) with pale rims
"""
import os, sys
import numpy as np
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import boat_textures as bt
bt.OUT = os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), 'assets', 'textures', 'floor')
os.makedirs(bt.OUT, exist_ok=True)
from boat_textures import pnoise, normal_from_height, mr_map, save, rgb

def worley(S, n, seed):
    rng = np.random.default_rng(seed)
    pts = rng.random((n, 2)) * S
    y, x = np.mgrid[0:S, 0:S].astype(np.float32)
    d1 = np.full((S, S), 1e9, np.float32); d2 = d1.copy()
    for px, py in pts:
        for ox in (-S, 0, S):
            for oy in (-S, 0, S):
                d = np.hypot(x - (px + ox), y - (py + oy))
                m = d < d1; d2 = np.where(m, d1, np.minimum(d2, d)); d1 = np.where(m, d, d1)
    return d1, d2

def rock(S=1024):
    lo = pnoise(S, S, 1, 12, 1, 1.2); mid = pnoise(S, S, 8, 60, 2, 1.0); hi = pnoise(S, S, 60, 400, 3, 0.6)
    d1, d2 = worley(S, 180, 4)
    bot = np.clip(1 - d1 / 42, 0, 1) ** 0.7                                  # botryoidal Mn-nodule bumps
    pits = np.clip((pnoise(S, S, 30, 200, 5, 0.8) - 0.72) * 6, 0, 1)
    hgt = 0.45 * lo + 0.35 * mid + 0.25 * hi + 0.5 * bot - 0.8 * pits
    crack = np.clip(1 - np.abs(d2 - d1) / 3.0, 0, 1) * (lo > 0.45)
    hgt -= 0.6 * crack
    base = rgb((38, 34, 31)) * (0.75 + 0.5 * mid[..., None])
    base = base * (1 - 0.35 * bot[..., None]) + rgb((20, 17, 15)) * 0.35 * bot[..., None]   # manganese crust darker on bumps
    rust = np.clip((pnoise(S, S, 3, 30, 6, 1.0) - 0.55) * 4, 0, 1)
    base = base * (1 - 0.45 * rust[..., None]) + rgb((92, 58, 34)) * 0.45 * rust[..., None]
    fora = (pnoise(S, S, 250, 500, 7, 0.0) > 0.83) * (hi > 0.5)              # pale foraminifera specks
    base = np.where(fora[..., None], rgb((170, 165, 150)), base)
    base = base * (1 - 0.6 * pits[..., None]) * (1 - 0.5 * crack[..., None])
    rough = 0.72 + 0.18 * hi - 0.15 * bot
    save('rock_basecolor.jpg', base, q=92); save('rock_normal.jpg', normal_from_height(hgt, 5.0), q=93); save('rock_mr.jpg', mr_map(rough, 0.0))

def coral(S=512):
    d1, d2 = worley(S, 420, 11)
    cup = np.clip(1 - d1 / 9.0, 0, 1)
    rim = np.exp(-((d1 - 6.5) / 1.6) ** 2)
    ridge = np.clip(1 - (d2 - d1) / 2.5, 0, 1)
    hgt = rim * 0.8 - cup ** 2 * 0.9 + 0.2 * pnoise(S, S, 20, 120, 12, 0.8) + 0.3 * ridge
    tone = 0.85 + 0.25 * pnoise(S, S, 2, 20, 13, 1.0)
    base = np.ones((S, S, 3)) * tone[..., None]
    base = base * (1 - 0.35 * cup[..., None] ** 2) + 0.12 * rim[..., None]    # greyscale: tinted per species in the material colour
    rough = 0.55 + 0.25 * cup
    save('coral_basecolor.jpg', np.clip(base, 0, 1), q=92); save('coral_normal.jpg', normal_from_height(hgt, 3.0), q=93); save('coral_mr.jpg', mr_map(rough, 0.0))

if len(sys.argv) < 2: rock(); coral()

def sand(S=1024):
    """1 m tile of abyssal ooze: grains (~1–3 mm), micro-ripples, pits, clumps — height -> normal; albedo variation"""
    g1 = pnoise(S, S, 250, 500, 21, 0.2)            # grains
    g2 = pnoise(S, S, 60, 250, 22, 0.7)             # grain clusters
    g3 = pnoise(S, S, 8, 60, 23, 1.2)               # clumps / tiny mounds
    d1, d2 = worley(S, 90, 24)
    pits = np.clip(1 - d1 / 7.0, 0, 1) ** 2 * (pnoise(S, S, 2, 12, 25, 1.0) > 0.55)
    hgt = 0.35 * g1 + 0.35 * g2 + 0.5 * g3 - 0.6 * pits
    save('sand_normal.jpg', normal_from_height(hgt, 6.0), q=94)
    alb = 0.85 + 0.25 * g2 + 0.12 * (g1 - 0.5) - 0.2 * pits
    dark = (pnoise(S, S, 300, 500, 26, 0.0) > 0.86)
    alb = np.where(dark, alb * 0.55, alb)
    save('sand_albedo.jpg', np.repeat(np.clip(alb, 0, 1)[..., None], 3, -1), q=92)

if __name__ == '__main__' and len(sys.argv) > 1 and sys.argv[1] == 'sand':
    sand()
