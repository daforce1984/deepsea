"""Procedural PBR textures for the dive boat (numpy + Pillow).

Run (WSL):  uv run --with numpy --with pillow python blender/boat_textures.py [outdir]
Default outdir: assets/textures/boat (relative to the project root).

All tiling textures are periodic by construction (FFT-filtered noise, patterns with periods dividing
the image size).  metallicRoughness maps follow glTF: G = roughness, B = metallic (R = 255, unused).
Normal maps are OpenGL / glTF convention (+Y = +V).
"""
import os, sys
import numpy as np
from PIL import Image

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
OUT = sys.argv[1] if len(sys.argv) > 1 else os.path.join(ROOT, 'assets', 'textures', 'boat')
os.makedirs(OUT, exist_ok=True)


# ----------------------------------------------------------------------------- helpers
def pnoise(h, w, fmin, fmax, seed, beta=1.0, aniso=(1.0, 1.0)):
    """Periodic band-limited fractal noise in [0,1].  aniso=(ku, kv) stretches frequencies:
    large ku -> features short along u (x/columns)."""
    rng = np.random.default_rng(seed)
    wn = rng.standard_normal((h, w))
    F = np.fft.fft2(wn)
    fy = np.fft.fftfreq(h)[:, None] * h
    fx = np.fft.fftfreq(w)[None, :] * w
    f = np.sqrt((fx / aniso[0]) ** 2 + (fy / aniso[1]) ** 2)
    filt = np.where((f >= fmin) & (f <= fmax), 1.0 / np.maximum(f, 1e-6) ** beta, 0.0)
    n = np.real(np.fft.ifft2(F * filt))
    n -= n.min(); n /= max(n.max(), 1e-9)
    return n


def normal_from_height(hgt, strength):
    dx = (np.roll(hgt, -1, 1) - np.roll(hgt, 1, 1)) * 0.5 * strength
    dy = (np.roll(hgt, 1, 0) - np.roll(hgt, -1, 0)) * 0.5 * strength   # rows grow downward, V grows upward
    nx, ny, nz = -dx, -dy, np.ones_like(hgt)
    l = np.sqrt(nx * nx + ny * ny + nz * nz)
    n = np.stack([nx / l, ny / l, nz / l], -1)
    return (n * 0.5 + 0.5)


def mr_map(rough, metal=0.0):
    h, w = rough.shape
    out = np.zeros((h, w, 3))
    out[..., 0] = 1.0
    out[..., 1] = np.clip(rough, 0, 1)
    out[..., 2] = np.clip(metal if np.ndim(metal) else np.full((h, w), metal), 0, 1)
    return out


def save(name, arr, q=90):
    arr = np.clip(arr, 0, 1)
    img = Image.fromarray((arr * 255 + 0.5).astype(np.uint8))
    p = os.path.join(OUT, name)
    if name.endswith('.jpg'):
        img.save(p, quality=q, subsampling=0 if 'normal' in name else 2)
    else:
        img.save(p, optimize=True)
    print('wrote', p, img.size, os.path.getsize(p) // 1024, 'KB')


def rgb(c):
    return np.array(c, dtype=np.float64)[None, None, :] / 255.0


# ----------------------------------------------------------------------------- hull gelcoat
# UV: u = y / 3 m (tiles along the hull), v = (z + 0.1) / 2.5 m (non tiling: v = 0 is 0.1 m below
# the waterline, v = 1 is 2.4 m above it).  Image row 0 = v 1.
def hull_gelcoat(S=1024):
    v = 1.0 - (np.arange(S)[:, None] + 0.5) / S          # per-row v
    z = v * 2.5 - 0.1                                     # metres above the waterline
    blot = pnoise(S, S, 2, 24, 11, 1.2)
    fine = pnoise(S, S, 60, 400, 12, 0.5)
    # vertical rain / grime streaks: long in V, thin in U
    streak = pnoise(S, S, 3, 90, 13, 0.9, aniso=(1.0, 12.0))
    streak = np.clip((streak - 0.55) * 3.0, 0, 1)
    streak_mask = np.clip((z - 0.3) / 1.4, 0, 1) ** 0.7   # streaks run down from the gunwale
    # waterline scum: yellow-brown film just above the boot stripe, wavy upper edge
    wav = pnoise(S, S, 4, 40, 14, 1.0, aniso=(1.0, 40.0))
    edge = 0.33 + (wav - 0.5) * 0.18
    scum = np.clip((edge - z) / 0.12, 0, 1) * np.clip((z - 0.12) / 0.05 + 1, 0, 1)
    scum *= 0.55 + 0.45 * pnoise(S, S, 8, 120, 15, 0.7)
    spray = np.clip((0.75 - z) / 0.5, 0, 1) * np.clip(pnoise(S, S, 20, 200, 16, 0.6) - 0.52, 0, 1) * 3

    base = rgb((238, 238, 234)) * (0.975 + 0.035 * (blot[..., None] - 0.5)) * (0.99 + 0.02 * fine[..., None])
    grime = rgb((170, 162, 146))
    col = base * (1 - 0.18 * (streak * streak_mask)[..., None]) + grime * (0.18 * streak * streak_mask)[..., None]
    scumc = rgb((168, 150, 108))
    a = np.clip(scum * 0.55 + spray * 0.12, 0, 0.7)[..., None]
    col = col * (1 - a) + scumc * a
    save('hull_gelcoat_basecolor.jpg', col)
    rough = 0.16 + 0.06 * blot + 0.18 * streak * streak_mask + 0.35 * scum + 0.03 * fine
    save('hull_gelcoat_mr.jpg', mr_map(rough, 0.0))


def gelcoat_tile(S=512):
    blot = pnoise(S, S, 2, 20, 21, 1.2)
    fine = pnoise(S, S, 40, 256, 22, 0.5)
    dirt = np.clip((pnoise(S, S, 3, 60, 23, 1.0) - 0.6) * 2.5, 0, 1)
    col = rgb((240, 240, 236)) * (0.975 + 0.04 * (blot[..., None] - 0.5)) * (0.99 + 0.02 * fine[..., None])
    col = col * (1 - 0.12 * dirt[..., None]) + rgb((175, 168, 152)) * 0.12 * dirt[..., None]
    save('gelcoat_basecolor.jpg', col)
    save('gelcoat_mr.jpg', mr_map(0.2 + 0.08 * blot + 0.2 * dirt, 0.0))
    # orange-peel normal shared by all gelcoat surfaces
    peel = pnoise(S, S, 40, 200, 24, 0.6)
    save('gelcoat_normal.jpg', normal_from_height(peel, 0.6))


# ----------------------------------------------------------------------------- antifouling
def antifouling(S=512):
    mott = pnoise(S, S, 2, 30, 31, 1.1)
    roller = pnoise(S, S, 10, 160, 32, 0.8, aniso=(1.0, 3.0))
    fine = pnoise(S, S, 80, 256, 33, 0.3)
    slime = np.clip((pnoise(S, S, 3, 40, 34, 1.0) - 0.62) * 2.5, 0, 1)
    col = rgb((112, 22, 18)) * (0.85 + 0.3 * mott[..., None]) * (0.95 + 0.1 * fine[..., None])
    col = col * (1 - 0.35 * slime[..., None]) + rgb((70, 58, 36)) * 0.35 * slime[..., None]
    save('antifouling_basecolor.jpg', col)
    save('antifouling_mr.jpg', mr_map(0.72 + 0.12 * roller + 0.08 * fine - 0.1 * slime, 0.0))
    save('antifouling_normal.jpg', normal_from_height(roller * 0.6 + fine * 0.4, 3.0))


# ----------------------------------------------------------------------------- non-skid deck
def nonskid(S=1024, P=16):
    j, i = np.meshgrid(np.arange(S), np.arange(S))
    a = ((i + j) % P) / P
    b = ((i - j) % P) / P
    da = np.abs(a - 0.5) * 2
    db = np.abs(b - 0.5) * 2
    d = np.maximum(da, db)                        # 0 at cell centre, 1 at edge
    bump = np.clip((0.82 - d) / 0.3, 0, 1)        # flat-topped diamonds with sloped sides
    fine = pnoise(S, S, 100, 512, 41, 0.3)
    wear = pnoise(S, S, 2, 30, 42, 1.1)
    hgt = bump * (0.85 + 0.15 * fine) + 0.1 * fine
    # scuffs: dark rubber marks and worn patches
    scuff = np.clip((pnoise(S, S, 4, 80, 43, 0.9, aniso=(1.0, 2.5)) - 0.64) * 3.5, 0, 1)
    worn = np.clip((wear - 0.62) * 3, 0, 1)
    col = rgb((196, 199, 200)) * (0.93 + 0.07 * bump[..., None]) * (0.96 + 0.06 * wear[..., None])
    col = col * (1 - 0.35 * scuff[..., None]) + rgb((92, 90, 86)) * 0.35 * scuff[..., None]
    col = col * (1 - 0.15 * (worn * bump)[..., None]) + rgb((225, 225, 222)) * 0.15 * (worn * bump)[..., None]
    save('deck_nonskid_basecolor.jpg', col)
    save('deck_nonskid_normal.jpg', normal_from_height(hgt, 5.0), q=92)
    rough = 0.78 - 0.18 * bump * worn + 0.08 * fine - 0.1 * scuff
    save('deck_nonskid_mr.jpg', mr_map(rough, 0.0))


# ----------------------------------------------------------------------------- stainless (brushed)
def stainless(S=512):
    brush = pnoise(S, S, 4, 256, 51, 0.4, aniso=(40.0, 1.0))   # long along U
    blot = pnoise(S, S, 2, 16, 52, 1.0)
    col = rgb((206, 206, 204)) * (0.95 + 0.07 * brush[..., None]) * (0.97 + 0.05 * blot[..., None])
    save('stainless_basecolor.jpg', col)
    save('stainless_mr.jpg', mr_map(0.14 + 0.12 * brush + 0.06 * blot, 1.0))
    save('stainless_normal.jpg', normal_from_height(brush, 1.5))


# ----------------------------------------------------------------------------- teak
def teak(S=1024, planks=8):
    rng = np.random.default_rng(61)
    j, i = np.meshgrid(np.arange(S), np.arange(S))
    pw = S // planks
    pk = i // pw
    iv = i % pw
    col = np.zeros((S, S, 3)); hgt = np.zeros((S, S)); rough = np.zeros((S, S))
    grain_lo = pnoise(S, S, 1, 20, 62, 1.0, aniso=(12.0, 1.0))
    grain_hi = pnoise(S, S, 20, 300, 63, 0.6, aniso=(25.0, 1.0))
    warp = pnoise(S, S, 1, 8, 64, 1.0, aniso=(3.0, 1.0))
    for p in range(planks):
        m = pk == p
        tone = rng.uniform(-0.08, 0.08)
        freq = rng.uniform(0.25, 0.45)
        rings = 0.5 + 0.5 * np.sin((iv + warp * 60 + grain_lo * 25) * freq + p * 3.1)
        g = 0.55 * rings ** 3 + 0.45 * grain_hi
        c = rgb((170, 128, 84)) * (1 + tone) * (0.86 + 0.2 * g[..., None])
        # silvery weathering on some planks
        wz = rng.uniform(0.0, 0.35)
        c = c * (1 - wz) + rgb((165, 150, 132)) * wz * (0.9 + 0.2 * g[..., None])
        col[m] = c[m]
        hgt[m] = (0.3 * g)[m]
        rough[m] = (0.62 + 0.12 * g + 0.05 * tone)[m]
        # butt joint (plank end) at a random column, wraps around
        jc = rng.integers(0, S)
        dj = np.abs(((j - jc + S // 2) % S) - S // 2)
        bm = m & (dj < 3)
        col[bm] = rgb((22, 17, 12))[0, 0]; hgt[bm] = -0.8; rough[bm] = 0.9
    seam = (iv < 5) | (iv > pw - 2)
    col[seam] = rgb((18, 16, 14))[0, 0]
    hgt[seam] = -1.0
    rough[seam] = 0.92
    save('teak_basecolor.jpg', col)
    save('teak_normal.jpg', normal_from_height(hgt, 3.0), q=92)
    save('teak_mr.jpg', mr_map(rough, 0.0))


# ----------------------------------------------------------------------------- life ring
def lifering(W=256, H=64):
    u = (np.arange(W)[None, :] + 0.5) / W
    band = ((u * 8).astype(int) % 2) == 1          # 4 white bands around the ring
    col = np.where(band[..., None], rgb((236, 236, 230)), rgb((238, 88, 20)))
    col = np.broadcast_to(col, (H, W, 3)).copy()
    col *= (0.95 + 0.05 * pnoise(H, W, 4, 60, 71, 0.8))[..., None]
    save('lifering_basecolor.png', col)


# ----------------------------------------------------------------------------- diver-down flag
def diveflag(W=192, H=128):
    # u = 0 at the hoist (staff), v = 1 at the top.  Red field, white diagonal from top-hoist to bottom-fly.
    uu = (np.arange(W)[None, :] + 0.5) / W
    vv = 1.0 - (np.arange(H)[:, None] + 0.5) / H
    d = np.abs((1.0 - vv) - uu) / np.sqrt(2)
    white = d < 0.085
    col = np.where(white[..., None], rgb((240, 240, 236)), rgb((200, 22, 26)))
    col = col * (0.93 + 0.07 * pnoise(H, W, 2, 30, 81, 1.0))[..., None]
    save('diveflag_basecolor.png', col)


if __name__ == '__main__':
    hull_gelcoat(); gelcoat_tile(); antifouling(); nonskid(); stainless(); teak(); lifering(); diveflag()
    print('textures ->', OUT)
