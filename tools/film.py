"""Render the DEEPSEA cinematic to an MP4 (24 fps, frame-exact, with offline-rendered audio).

Drives js/main.js MOVIE over CDP in the existing test tab (never opens a browser or tab):
each MOVIE.frame() advances the game by 1/24 s and steps an OfflineAudioContext to the same instant,
the frame is screenshotted (JPEG) and piped into ffmpeg (pinned to 4 cores). VRAM / GPU / RAM / temperature
are polled; the render pauses when a limit is near and stops cleanly (keeping what was rendered) if it stays there.

run:  taskset -c 0-3 uv run -q --with websocket-client --with imageio-ffmpeg python tools/film.py [--seconds N] [--out renders/name]
"""
import argparse, base64, json, os, subprocess, sys, threading, time, wave

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
import cdp  # noqa: E402

ap = argparse.ArgumentParser()
ap.add_argument('--seconds', type=float, default=1320, help='max film length (also the audio buffer size)')
ap.add_argument('--out', default=os.path.join(HERE, '..', 'renders', 'deepsea_longform_24fps'))
ap.add_argument('--w', type=int, default=1920)
ap.add_argument('--h', type=int, default=1080)
ap.add_argument('--quality', type=int, default=92)
ap.add_argument('--base', default='http://localhost:8990', help='game server as seen from Windows Chrome (8793-8892 are reserved by Windows)')
args = ap.parse_args()

FPS = 24
VRAM_PAUSE, VRAM_STOP = 2900, 3000          # MiB of 3072 (GTX 1060 3GB)
FREE_PAUSE, FREE_STOP = 2.0, 1.0            # GB of free Windows RAM
TEMP_PAUSE = 84                             # deg C
HEAP_STOP = 3500                            # MB page JS heap

os.makedirs(os.path.dirname(os.path.abspath(args.out)), exist_ok=True)
vid_path, wav_path, mp4_path, log_path = args.out + '_video.mp4', args.out + '_audio.wav', args.out + '.mp4', args.out + '.log'
logf = open(log_path, 'a', encoding='utf-8')


def log(*a):
    s = time.strftime('%H:%M:%S ') + ' '.join(str(x) for x in a)
    print(s, flush=True); logf.write(s + '\n'); logf.flush()


# ---- resource monitor (background thread; Windows RAM via PowerShell is slow, so it is sampled, not per frame) ----
mon = {'vram': 0, 'vtot': 3072, 'util': 0, 'temp': 0, 'free_gb': 99.0, 'chrome_mb': 0}


def poll_gpu():
    try:
        o = subprocess.run(['nvidia-smi', '--query-gpu=memory.used,memory.total,utilization.gpu,temperature.gpu',
                            '--format=csv,noheader,nounits'], capture_output=True, text=True, timeout=10).stdout.strip().split(',')
        mon.update(vram=int(o[0]), vtot=int(o[1]), util=int(o[2]), temp=int(o[3]))
    except Exception as e:
        log('nvidia-smi failed', e)


def poll_ram():
    try:
        ps = ("$o=Get-CimInstance Win32_OperatingSystem; [math]::Round($o.FreePhysicalMemory/1MB,2); "
              "(Get-CimInstance Win32_Process -Filter \"name='chrome.exe'\" | Where-Object { $_.CommandLine -like '*chrome_automation\\deepsea*' } | "
              "Measure-Object -Property WorkingSetSize -Sum).Sum/1MB")
        o = subprocess.run(['powershell.exe', '-NoProfile', '-Command', ps], capture_output=True, text=True, timeout=30).stdout.split()
        mon.update(free_gb=float(o[0]), chrome_mb=int(float(o[1])))
    except Exception as e:
        log('ram poll failed', e)


stop_mon = False


def monitor():
    n = 0
    while not stop_mon:
        poll_gpu()
        if n % 6 == 0: poll_ram()
        n += 1
        time.sleep(5)


threading.Thread(target=monitor, daemon=True).start()
poll_gpu(); poll_ram()
log('start', json.dumps(mon), 'out', os.path.abspath(mp4_path))

import imageio_ffmpeg  # noqa: E402
FF = imageio_ffmpeg.get_ffmpeg_exe()


def pinned(cmd):   # 4 cores, low priority
    return ['taskset', '-c', '0-3', 'nice', '-n', '10'] + cmd


tab, ws = cdp.pick_tab()
s = cdp.Session(ws)


def ev(expr, await_=True):
    r = s.call('Runtime.evaluate', expression=expr, awaitPromise=await_, returnByValue=True)
    if 'exceptionDetails' in r:
        raise RuntimeError(json.dumps(r['exceptionDetails'])[:800])
    return r['result'].get('value')


ff = None
k = 0
try:
    # same session for the override and its removal (Emulation overrides outlive a session otherwise)
    s.call('Emulation.setDeviceMetricsOverride', width=args.w, height=args.h, deviceScaleFactor=1, mobile=False)
    s.call('Page.navigate', url=f'{args.base}/index.html?h={args.h}')
    for _ in range(120):
        time.sleep(1)
        try:
            if ev('!!(window.GAME && GAME.world && window.MOVIE)', False): break
        except Exception: pass
    time.sleep(2)
    info = ev(f'MOVIE.init({{ seconds: {args.seconds} }})')
    log('movie init', info)

    ff = subprocess.Popen(pinned([FF, '-hide_banner', '-loglevel', 'error', '-y', '-f', 'image2pipe', '-c:v', 'mjpeg', '-framerate', str(FPS), '-i', '-',
                                  '-c:v', 'libx264', '-preset', 'medium', '-crf', '18', '-pix_fmt', 'yuv420p', '-threads', '4',
                                  '-x264-params', 'threads=4', '-movflags', '+faststart', vid_path]), stdin=subprocess.PIPE)
    t0 = time.time(); last = t0; maxk = int((args.seconds - 1) * FPS)
    while k < maxk:
        # ---- resource guard: pause near the limits, stop cleanly if they persist ----
        waited = 0
        while (mon['vram'] > VRAM_PAUSE or mon['free_gb'] < FREE_PAUSE or mon['temp'] > TEMP_PAUSE):
            if mon['vram'] >= VRAM_STOP or mon['free_gb'] < FREE_STOP or waited > 180:
                raise RuntimeError('resource limit: ' + json.dumps(mon))
            if waited % 15 == 0: log('pause (resources)', json.dumps(mon))
            time.sleep(3); waited += 3; poll_gpu()
            if waited % 15 == 0: poll_ram()
        r = ev('MOVIE.frame()')
        k = r['k']
        if r.get('heapMB', 0) > HEAP_STOP:
            raise RuntimeError('page heap too large: %s' % r)
        shot = s.call('Page.captureScreenshot', format='jpeg', quality=args.quality)
        ff.stdin.write(base64.b64decode(shot['data']))
        if k % 48 == 0 or r.get('end'):
            now = time.time()
            log(f"f{k} t={r['t']}s depth={r['depth']}m {r['ph']} {r['ev']} | {48 / max(now - last, 1e-3):.1f} fps render, "
                f"elapsed {(now - t0) / 60:.1f} min | VRAM {mon['vram']}/{mon['vtot']} GPU {mon['util']}% {mon['temp']}C | "
                f"free RAM {mon['free_gb']} GB, chrome {mon['chrome_mb']} MB, heap {r['heapMB']} MB")
            last = now
        if r.get('end'): break
    log('frames done', k)
except Exception as e:
    log('STOPPED:', e)
finally:
    if ff:
        ff.stdin.close(); ff.wait()
        log('video written', vid_path, os.path.getsize(vid_path) if os.path.exists(vid_path) else 0)
    try:
        if k > 0:
            a = ev('MOVIE.finish()')
            log('audio', a)
            n = (a['bytes'] + (6 << 20) - 1) // (6 << 20)
            with wave.open(wav_path, 'wb') as w:
                w.setnchannels(2); w.setsampwidth(2); w.setframerate(a['sr'])
                for i in range(n):
                    w.writeframes(base64.b64decode(ev(f'MOVIE.chunk({i})', False)))
            log('audio written', wav_path)
            subprocess.run(pinned([FF, '-hide_banner', '-loglevel', 'error', '-y', '-i', vid_path, '-i', wav_path, '-c:v', 'copy',
                                   '-af', 'loudnorm=I=-18:TP=-1.5:LRA=14', '-ar', '48000', '-c:a', 'aac', '-b:a', '192k', '-shortest', '-threads', '4', '-movflags', '+faststart', mp4_path]), check=True)
            log('DONE', os.path.abspath(mp4_path), os.path.getsize(mp4_path))
    except Exception as e:
        log('audio/mux failed:', e)
    try:
        s.call('Emulation.clearDeviceMetricsOverride')
        s.call('Page.navigate', url=args.base + '/index.html')   # back to the plain test page (film mode off)
    except Exception as e:
        log('cleanup failed', e)
    stop_mon = True
