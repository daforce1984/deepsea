"""Trim/loop/normalise Pixabay sources (assets/audio/src) -> assets/audio/game/*.ogg"""
import subprocess, numpy as np, os, imageio_ffmpeg
FF = imageio_ffmpeg.get_ffmpeg_exe(); SR = 44100
SRC = 'assets/audio/src'; OUT = 'assets/audio/game'
def dec(p, ch):
    raw = subprocess.run([FF, '-v', 'error', '-i', p, '-f', 's16le', '-ac', str(ch), '-ar', str(SR), '-'], capture_output=True, check=True).stdout
    return np.frombuffer(raw, np.int16).astype(np.float32).reshape(-1, ch) / 32768
def enc(p, x):
    ch = x.shape[1]
    subprocess.run([FF, '-v', 'error', '-y', '-f', 's16le', '-ac', str(ch), '-ar', str(SR), '-i', '-', '-c:a', 'libvorbis', '-q:a', '4', p],
                   input=(np.clip(x, -1, 1) * 32767).astype(np.int16).tobytes(), check=True)
def trim(x, th=0.01):
    e = np.abs(x).max(1); i = np.where(e > th * e.max())[0]
    return x[max(0, i[0] - 200): i[-1] + 2000] if len(i) else x
def norm(x, pk): m = np.abs(x).max(); return x * (pk / m) if m > 1e-5 else x
def loop(x, start, length, xf=1.5):
    x = x[int(start * SR): int((start + length + xf) * SR)]; n = int(xf * SR)
    body = x[:-n].copy(); r = np.linspace(0, 1, n)[:, None]
    body[:n] = body[:n] * r + x[-n:] * (1 - r); return body
def fade(x, a=0.005, b=0.05):
    x = x.copy(); na, nb = int(a * SR), int(b * SR)
    x[:na] *= np.linspace(0, 1, na)[:, None]; x[-nb:] *= np.linspace(1, 0, nb)[:, None]; return x
L = {  # name: (channels, loop_start, loop_len) ; loop_len None = one-shot
 'slap_big': (2, 0, None), 'slap_rock': (2, 0, None),
 'amb_shallow': (2, 5, 50), 'amb_deep': (2, 10, 55), 'amb_abyss': (2, 20, 60), 'surface_waves': (2, 1, 26),
 'breath_mask': (1, 0, None), 'breath_scuba': (1, 0, None), 'bubbles_loop': (1, 0, 5.5), 'whale_low': (1, 0, None), 'dolphins_talk': (1, 2, 30), 'humpback_dive': (2, 3, 45),
}
os.makedirs(OUT, exist_ok=True)
for f in sorted(os.listdir(SRC)):
    if not f.endswith('.mp3'): continue
    n = f[:-4]; ch, st, ln = L.get(n, (1, 0, None))
    x = dec(os.path.join(SRC, f), ch); dur = len(x) / SR
    if ln:
        ln = min(ln, dur - st - 1.6); y = norm(loop(x, st, ln), 0.6)
    else:
        y = fade(norm(trim(x), 0.85))
    enc(os.path.join(OUT, n + '.ogg'), y)
    print(f'{n:14s} src {dur:6.1f}s -> {len(y)/SR:5.1f}s ch{ch}')
