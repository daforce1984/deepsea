"""High-res teak for the modelled cockpit deck: 8 plank strips stacked along V (one strip = one plank's face),
grain running along U, no baked seams (the caulking gaps are real geometry).  2048 px, strip = 256 px = 0.1 m wide,
U repeat = 1.6 m of plank length.
Run (WSL):  uv run --with numpy --with pillow python blender/deck_teak_tex.py
"""
import os, sys
import numpy as np
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from boat_textures import pnoise, normal_from_height, mr_map, save, rgb

S, P = 2048, 8
rng = np.random.default_rng(7)
j, i = np.meshgrid(np.arange(S), np.arange(S))
pw = S // P; pk = i // pw; iv = i % pw
col = np.zeros((S, S, 3)); hgt = np.zeros((S, S)); rough = np.zeros((S, S))
g_lo = pnoise(S, S, 1, 24, 11, 1.0, aniso=(14.0, 1.0))
g_hi = pnoise(S, S, 24, 500, 12, 0.5, aniso=(30.0, 1.0))
pores = pnoise(S, S, 300, 1000, 13, 0.0, aniso=(6.0, 1.0))
warp = pnoise(S, S, 1, 10, 14, 1.0, aniso=(3.0, 1.0))
dirt = pnoise(S, S, 2, 40, 15, 1.2)
for p in range(P):
    m = pk == p
    tone = rng.uniform(-0.1, 0.1); freq = rng.uniform(0.18, 0.4); ph = rng.uniform(0, 6.28)
    rings = 0.5 + 0.5 * np.sin((iv + warp * 70 + g_lo * 30) * freq + ph)
    late = rings ** 4                                         # dark latewood lines
    g = 0.5 * late + 0.35 * g_hi + 0.15 * pores
    base = rgb((168, 124, 80)) * (1 + tone)
    c = base * (0.9 + 0.22 * g_hi[..., None]) * (1 - 0.28 * late[..., None]) * (1 - 0.1 * (pores[..., None] > 0.7))
    wz = rng.uniform(0.15, 0.55)                               # sun-bleached silver-grey teak
    c = c * (1 - wz) + rgb((170, 158, 140)) * wz * (0.88 + 0.22 * g[..., None])
    c = c * (0.92 + 0.12 * dirt[..., None])
    # plank edge darkening + slight crown (worn rounded edges)
    e = np.minimum(iv, pw - 1 - iv) / pw
    crown = np.clip(e * 12, 0, 1)
    c = c * (0.8 + 0.2 * crown[..., None])
    col[m] = c[m]
    hgt[m] = (0.35 * (1 - late) + 0.25 * g_hi + 0.6 * crown)[m]
    rough[m] = (0.58 + 0.15 * late + 0.1 * pores + 0.05 * tone)[m]
save('deckteak_basecolor.jpg', col, q=92)
save('deckteak_normal.jpg', normal_from_height(hgt, 2.2), q=93)
save('deckteak_mr.jpg', mr_map(rough, 0.0), q=92)
