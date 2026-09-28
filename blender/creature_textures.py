"""PBR texture sets for the procedural deep-sea creatures (numpy + Pillow).
UV convention of the procedural meshes: u = around the body (0..1, periodic; u=0.25 back / dorsal, u=0.75 belly),
v = along the body (0 tail .. 1 head).  Output: assets/textures/creatures/<name>_{basecolor,normal,mr}.jpg (512 px)
Run: uv run --with numpy --with pillow python blender/creature_textures.py
"""
import os, sys
import numpy as np
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import boat_textures as bt
bt.OUT = os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), 'assets', 'textures', 'creatures')
os.makedirs(bt.OUT, exist_ok=True)
from boat_textures import pnoise, normal_from_height, save, rgb
S = 512
v, u = np.mgrid[0:S, 0:S] / S                       # row = v (image rows), col = u
v = 1 - v
back = np.cos((u - 0.25) * 2 * np.pi) * 0.5 + 0.5   # 1 on the back, 0 on the belly

def mr(rough, metal): out = np.zeros((S, S, 3)); out[..., 0] = 1; out[..., 1] = np.clip(rough, 0, 1); out[..., 2] = np.clip(metal, 0, 1); return out
def cells(nu, nv, stagger=True):
    x = u * nu; y = v * nv
    row = np.floor(y); x = x + (row % 2) * 0.5 * stagger
    fx = x - np.floor(x) - 0.5; fy = y - row - 0.5
    return fx, fy, np.floor(x) + row * 131

def scales(name, dark, silver, rough_back, metal_side):
    fx, fy, cid = cells(40, 28)
    d = np.sqrt(fx ** 2 + (fy * 1.3 + 0.15) ** 2)
    dome = np.clip(1 - d * 1.6, 0, 1)
    rim = np.exp(-((fy + 0.35) / 0.08) ** 2) * (np.abs(fx) < 0.48)          # overlapping posterior edge
    hgt = dome * 0.6 + rim * 0.5 + 0.15 * pnoise(S, S, 60, 250, 7, 0.6)
    jit = (np.sin(cid * 12.9898) * 43758.5453) % 1
    tone = 0.85 + 0.3 * jit[..., None]
    base = (rgb(dark) * back[..., None] ** 1.5 + rgb(silver) * (1 - back[..., None] ** 1.5)) * tone
    base = base * (0.8 + 0.2 * dome[..., None])
    save(name + '_basecolor.jpg', base); save(name + '_normal.jpg', normal_from_height(hgt, 5.0), q=93)
    save(name + '_mr.jpg', mr(0.18 + rough_back * back ** 2 + 0.1 * (1 - dome), metal_side * (1 - back ** 2) + 0.15))

def oar():
    streak = np.clip(np.sin(v * 70 + np.sin(u * 20 + v * 9) * 1.5) * 0.5 + 0.5, 0, 1) ** 8 * (back < 0.8)
    spots = (pnoise(S, S, 20, 60, 21, 0.5) > 0.78) * 1.0
    tub = pnoise(S, S, 120, 400, 22, 0.3)
    base = rgb((205, 210, 218)) * (1 - 0.55 * streak[..., None] - 0.45 * spots[..., None]) * (0.9 + 0.1 * tub[..., None])
    save('oar_basecolor.jpg', base); save('oar_normal.jpg', normal_from_height(tub * 0.6 - streak * 0.3, 4.0), q=93)
    save('oar_mr.jpg', mr(0.22 + 0.25 * streak + 0.1 * tub, 0.8 * (1 - streak)))

def chitin():
    seg = np.abs(np.sin(v * np.pi * 9))
    edge = np.clip(1 - seg / 0.12, 0, 1)
    gran = pnoise(S, S, 100, 400, 31, 0.4); pits = np.clip((pnoise(S, S, 40, 160, 32, 0.8) - 0.72) * 5, 0, 1)
    base = rgb((168, 158, 176)) * (0.85 + 0.25 * pnoise(S, S, 4, 30, 33, 1.0)[..., None]) * (1 - 0.45 * edge[..., None]) * (1 - 0.4 * pits[..., None])
    hgt = seg ** 0.3 * 0.7 + gran * 0.3 - pits * 0.6
    save('chitin_basecolor.jpg', base); save('chitin_normal.jpg', normal_from_height(hgt, 5.0), q=93); save('chitin_mr.jpg', mr(0.35 + 0.3 * pits + 0.15 * edge, 0.0))

def gel():
    veins = np.clip(1 - np.abs(pnoise(S, S, 6, 40, 41, 1.0) - 0.5) * 18, 0, 1)
    pap = np.clip(1 - np.hypot(*cells(22, 30)[:2]) * 3.2, 0, 1)
    base = rgb((150, 30, 42)) * (0.75 + 0.45 * pnoise(S, S, 3, 20, 42, 1.0)[..., None]) * (1 + 0.5 * veins[..., None]) + rgb((90, 20, 30)) * pap[..., None] * 0.4
    save('gel_basecolor.jpg', base); save('gel_normal.jpg', normal_from_height(pap * 0.8 + veins * 0.3 + pnoise(S, S, 40, 200, 43, 0.5) * 0.2, 3.0), q=93)
    save('gel_mr.jpg', mr(0.12 + 0.1 * pap, 0.0))

def legs():   # spider / isopod legs, antennae: joint bands along v, bristle speckle
    band = np.clip(1 - np.abs(((v * 3) % 1) - 0.5) / 0.06, 0, 1)
    bris = (pnoise(S, S, 200, 500, 51, 0.0) > 0.8) * 1.0
    base = rgb((215, 110, 70)) * (0.85 + 0.2 * pnoise(S, S, 5, 40, 52, 1.0)[..., None]) * (1 - 0.4 * band[..., None])
    save('leg_basecolor.jpg', base); save('leg_normal.jpg', normal_from_height(-band * 0.8 + bris * 0.5, 4.0), q=93); save('leg_mr.jpg', mr(0.45 + 0.2 * band, 0.0))

def shell():  # shrimp: carapace segments, red chromatophore speckles
    seg = np.abs(np.sin(v * np.pi * 7)); chrom = (pnoise(S, S, 80, 300, 61, 0.3) > 0.7) * 1.0
    base = rgb((235, 150, 120)) * (0.9 + 0.1 * seg[..., None]) * (1 - 0.35 * chrom[..., None]) + rgb((120, 10, 10)) * chrom[..., None] * 0.35
    save('shell_basecolor.jpg', base); save('shell_normal.jpg', normal_from_height(seg ** 0.3 * 0.6 + chrom * 0.2, 3.5), q=93); save('shell_mr.jpg', mr(0.28 + 0.1 * chrom, 0.0))

def polyp():  # flytrap anemone: radial ridges, papillae
    rid = np.abs(np.sin(u * np.pi * 36)) ** 0.5; pap = pnoise(S, S, 60, 250, 71, 0.5)
    base = rgb((240, 190, 150)) * (0.8 + 0.2 * rid[..., None]) * (0.9 + 0.2 * pap[..., None])
    save('polyp_basecolor.jpg', base); save('polyp_normal.jpg', normal_from_height(rid * 0.6 + pap * 0.3, 3.0), q=93); save('polyp_mr.jpg', mr(0.5 - 0.2 * rid, 0.0))

scales('lantern', (38, 42, 52), (150, 158, 172), 0.35, 0.75)
scales('hatchet', (70, 78, 92), (215, 222, 232), 0.25, 0.95)
oar(); chitin(); gel(); legs(); shell(); polyp()
