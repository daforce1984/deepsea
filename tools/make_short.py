"""1-minute vertical Short cut from the long-form film: empty stretches as timelapse, every creature at (near) real speed,
music from the game's own ambient cues (calm surface -> twilight -> abyss + tension), a low stinger on each deep encounter.
run: taskset -c 0-3 uv run -q --with imageio-ffmpeg --with pillow python tools/make_short.py
"""
import os, subprocess, math
import imageio_ffmpeg
from PIL import Image, ImageDraw, ImageFont

R = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
SRC = os.path.join(R, 'renders/deepsea_longform_24fps.mp4')
OUT = os.path.join(R, 'renders/deepsea_short_60s.mp4')
TMP = os.path.join(R, 'renders/short_tmp'); os.makedirs(TMP, exist_ok=True)
FF = imageio_ffmpeg.get_ffmpeg_exe()
FONT_B = '/mnt/c/Windows/Fonts/impact.ttf'; FONT_S = '/mnt/c/Windows/Fonts/segoeuib.ttf'
TOTAL = 60.0

# creature shots: (src start, src end, speed, caption, depth label, deep stinger?)
SHOTS = [
    (66, 72, 2.5, 'HUMPBACK', 'surface', False),
    (75.5, 80.5, 1.0, 'TAIL SLAP', 'surface', False),
    (104, 109, 2.0, 'DOLPHINS', '6 m', False),
    (187, 193, 2.5, 'MANTA RAYS', '15 m', False),
    (203, 211, 2.5, 'BAIT BALL', '21 m', False),
    (237, 240, 1.5, 'TUNA ATTACK', '21 m', False),
    (278, 290, 4.0, 'HUMPBACK PASS', '33 m', False),
    (375, 383, 3.0, 'GREAT WHITE', '61 m', True),
    (452, 466, 4.5, 'OARFISH', '165 m', True),
    (712, 720, 2.2, 'MEGALODON', '302 m', True),
    (818, 823, 2.0, 'JELLYFISH', '453 m', True),
    (843.5, 848, 1.5, 'HEADLESS CHICKEN MONSTER', '504 m', True),
    (929, 937, 2.5, 'GIANT SQUID', '707 m', True),
    (1092, 1101, 3.0, 'ANGLERFISH', '1,157 m', True),
    (1246, 1266, 6.0, 'ABYSSAL FLOOR', '3,995 m', True),
]
# timelapse gaps between shots; the opening deck shot gets a fixed 3 s
segs = []
prev = 0.0
fixed = sum((b - a) / s for a, b, s, *_ in SHOTS)
gaps = []
for sh in SHOTS:
    if sh[0] > prev + 0.5: gaps.append((prev, sh[0]))
    prev = sh[1]
rest = TOTAL - fixed - 3.0
w = [math.sqrt(b - a) for a, b in gaps[1:]]
gdur = [3.0] + [max(0.7, rest * x / sum(w)) for x in w]
k = sum(gdur[1:]); gdur = [3.0] + [d * (rest / k) for d in gdur[1:]]
gi = 0; prev = 0.0
for sh in SHOTS:
    if sh[0] > prev + 0.5:
        a, b = gaps[gi]; segs.append(dict(a=a, b=b, speed=(b - a) / gdur[gi], shot=None)); gi += 1
    segs.append(dict(a=sh[0], b=sh[1], speed=sh[2], shot=sh)); prev = sh[1]
t = 0.0
for s in segs:
    s['t0'] = t; s['dur'] = (s['b'] - s['a']) / s['speed']; t += s['dur']
print('total', round(t, 2), 's,', len(segs), 'segments')

# ---- captions (PNG overlays) ----
def caption(name, depth, path):
    im = Image.new('RGBA', (1080, 1920), (0, 0, 0, 0)); d = ImageDraw.Draw(im)
    f1 = ImageFont.truetype(FONT_S, 46); f2 = ImageFont.truetype(FONT_B, 92 if len(name) < 16 else 70)
    d.text((540, 1330), depth.upper(), font=f1, fill=(150, 230, 255, 255), anchor='mm', stroke_width=4, stroke_fill=(0, 0, 0, 220))
    d.text((540, 1415), name, font=f2, fill=(255, 255, 255, 255), anchor='mm', stroke_width=7, stroke_fill=(0, 0, 0, 230))
    im.save(path)
def title(path):
    im = Image.new('RGBA', (1080, 1920), (0, 0, 0, 0)); d = ImageDraw.Draw(im)
    f1 = ImageFont.truetype(FONT_B, 110); f2 = ImageFont.truetype(FONT_S, 44)
    d.text((540, 300), 'REALTIME DEEP SEA', font=f1, fill=(255, 226, 60, 255), anchor='mm', stroke_width=8, stroke_fill=(0, 0, 0, 230))
    d.text((540, 395), 'in a browser · made with AI', font=f2, fill=(220, 248, 255, 255), anchor='mm', stroke_width=5, stroke_fill=(0, 0, 0, 220))
    im.save(path)
title(os.path.join(TMP, 'title.png'))
caps = []
for i, s in enumerate(segs):
    if s['shot']:
        p = os.path.join(TMP, f'cap{i:02d}.png'); caption(s['shot'][3], s['shot'][4], p); caps.append((p, s['t0'] + 0.15, s['t0'] + s['dur'] - 0.1))

# ---- video graph ----
n = len(segs)
fc = [f"[0:v]split={n}" + ''.join(f'[s{i}]' for i in range(n))]
for i, s in enumerate(segs):
    fc.append(f"[s{i}]trim=start={s['a']}:end={s['b']},setpts=(PTS-STARTPTS)/{s['speed']:.5f},fps=24,crop=608:1080:656:0,scale=1080:1920:flags=lanczos,setsar=1[v{i}]")
fc.append(''.join(f'[v{i}]' for i in range(n)) + f'concat=n={n}:v=1:a=0[vc]')
inputs = ['-i', SRC, '-loop', '1', '-t', str(TOTAL), '-i', os.path.join(TMP, 'title.png')]
last = 'vc'
fc.append(f"[{last}][1:v]overlay=0:0:enable='between(t,0.3,4.2)'[o0]"); last = 'o0'
for j, (p, a, b) in enumerate(caps):
    inputs += ['-loop', '1', '-t', str(TOTAL), '-i', p]
    fc.append(f"[{last}][{j + 2}:v]overlay=0:0:enable='between(t,{a:.2f},{b:.2f})'[o{j + 1}]"); last = f'o{j + 1}'
fc.append(f"[{last}]fade=t=in:st=0:d=0.6,fade=t=out:st={TOTAL - 1.2}:d=1.2,trim=duration={TOTAL}[vout]")
vid = os.path.join(TMP, 'video.mp4')
subprocess.run(['nice', '-n', '10', FF, '-hide_banner', '-loglevel', 'error', '-y', *inputs, '-filter_complex', ';'.join(fc), '-map', '[vout]',
                '-c:v', 'libx264', '-preset', 'medium', '-crf', '18', '-pix_fmt', 'yuv420p', '-r', '24', '-threads', '4', vid], check=True)
print('video ok')

# ---- audio: ambient score that darkens with depth + a stinger on each deep encounter ----
M = os.path.join(R, 'assets/music'); G = os.path.join(R, 'assets/audio/game')
t_of = {s['shot'][3]: s['t0'] for s in segs if s['shot']}
x_twi = t_of['GREAT WHITE'] - 4.0          # surface -> twilight as the light goes
x_aby = t_of['OARFISH'] - 2.0              # twilight -> abyss
x_ten = t_of['MEGALODON'] - 3.0            # tension creeps in under the abyss
slap_t = t_of['TAIL SLAP']
ain = ['-i', f'{M}/calm_surface.mp3', '-i', f'{M}/twilight.mp3', '-i', f'{M}/abyss.mp3', '-i', f'{M}/tension.mp3',
       '-ss', '75.5', '-t', '5', '-i', SRC, '-i', f'{G}/whoosh_deep.ogg', '-i', f'{G}/rumble.ogg']
af = [
    f"[0:a]atrim=0:{x_twi + 4},asetpts=N/SR/TB,volume=1.0,afade=t=out:st={x_twi}:d=4[m0]",
    f"[1:a]atrim=0:{x_aby + 4 - x_twi},asetpts=N/SR/TB,afade=t=in:d=4,afade=t=out:st={x_aby - x_twi}:d=4,adelay={int(x_twi * 1000)}:all=1[m1]",
    f"[2:a]atrim=0:{TOTAL - x_aby},asetpts=N/SR/TB,afade=t=in:d=4,volume=1.25,adelay={int(x_aby * 1000)}:all=1[m2]",
    f"[3:a]atrim=0:{TOTAL - x_ten},asetpts=N/SR/TB,afade=t=in:d=5,volume=0.8,adelay={int(x_ten * 1000)}:all=1[m3]",
    f"[4:a]afade=t=in:d=0.2,afade=t=out:st=4.2:d=0.8,volume=1.6,adelay={int(slap_t * 1000)}:all=1[fx]",
]
stings = [s for s in segs if s['shot'] and s['shot'][5]]
for i, s in enumerate(stings):
    src = 5 if i % 2 == 0 else 6
    af.append(f"[{src}:a]atrim=0:3.5,asetpts=N/SR/TB,afade=t=out:st=2.5:d=1,volume=0.9,adelay={int(max(0, s['t0'] - 0.25) * 1000)}:all=1[st{i}]")
    ain += []
# the stinger inputs are reused: split them
uses = {5: [i for i in range(len(stings)) if i % 2 == 0], 6: [i for i in range(len(stings)) if i % 2 == 1]}
af2 = af[:5]
for src, ids in uses.items():
    af2.append(f"[{src}:a]asplit={len(ids)}" + ''.join(f'[q{src}_{k}]' for k in range(len(ids))))
    for k, i in enumerate(ids):
        s = stings[i]
        af2.append(f"[q{src}_{k}]atrim=0:3.5,asetpts=N/SR/TB,afade=t=out:st=2.5:d=1,volume=0.9,adelay={int(max(0, s['t0'] - 0.25) * 1000)}:all=1[st{i}]")
mix = '[m0][m1][m2][m3][fx]' + ''.join(f'[st{i}]' for i in range(len(stings)))
af2.append(f"{mix}amix=inputs={5 + len(stings)}:normalize=0,atrim=0:{TOTAL},afade=t=out:st={TOTAL - 2}:d=2,loudnorm=I=-14:TP=-1.5:LRA=11,aresample=48000[aout]")
aud = os.path.join(TMP, 'audio.m4a')
subprocess.run(['nice', '-n', '10', FF, '-hide_banner', '-loglevel', 'error', '-y', *ain, '-filter_complex', ';'.join(af2), '-map', '[aout]',
                '-c:a', 'aac', '-b:a', '192k', '-threads', '4', aud], check=True)
print('audio ok')
subprocess.run([FF, '-hide_banner', '-loglevel', 'error', '-y', '-i', vid, '-i', aud, '-c', 'copy', '-shortest', '-movflags', '+faststart', OUT], check=True)
print('DONE', OUT, os.path.getsize(OUT))
for s in segs: print(f"{s['t0']:6.2f}s  {s['dur']:5.2f}s  x{s['speed']:6.1f}  {s['shot'][3] if s['shot'] else '(timelapse)'}")
