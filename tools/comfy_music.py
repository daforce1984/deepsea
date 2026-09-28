"""Generate DEEPSEA music cues with MiniMax Music 3 on the ComfyUI server (API graph built from the saved workflow).
usage: uv run python tools/comfy_music.py [cue_id ...]   env COMFY=http://192.168.0.148:8188 SEED=..."""
import json, os, sys, time, random, urllib.request, urllib.parse
ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
BASE = os.environ.get('COMFY', 'http://192.168.0.148:8188')
CUES = json.load(open(os.path.join(ROOT, 'assets', 'music', 'cues.json')))
LYR = "[Intro]\n[Instrumental]\n\n[Verse]\n[Instrumental]\n\n[Build]\n[Instrumental]\n\n[Climax]\n[Instrumental]\n\n[Outro]\n[Instrumental]\n"
want = set(sys.argv[1:])

def req(path, data=None, timeout=60):
    r = urllib.request.Request(BASE + path, data=json.dumps(data).encode() if data is not None else None, headers={'Content-Type': 'application/json'})
    with urllib.request.urlopen(r, timeout=timeout) as f:
        return f.read()

def graph(cue, seed):
    d = float(cue['dur'])
    return {
        '6': {'class_type': 'UNETLoader', 'inputs': {'unet_name': 'minimax_music3_dit_fp16.safetensors', 'weight_dtype': 'default'}},
        '3': {'class_type': 'CLIPLoader', 'inputs': {'clip_name': 'minimax_music3_text_encoder_pruned_int8_convrot.safetensors', 'type': 'minimax', 'device': 'default'}},
        '7': {'class_type': 'VAELoader', 'inputs': {'vae_name': 'minimax_music3_dav.safetensors'}},
        '13': {'class_type': 'MiniMaxMusic3TextEncode', 'inputs': {'clip': ['3', 0], 'caption': cue['caption'], 'lyrics': cue.get('lyrics', LYR), 'seed': seed, 'max_duration': d, 'cfg_scale': 1.7, 'top_k': 50}},
        '10': {'class_type': 'ConditioningZeroOut', 'inputs': {'conditioning': ['13', 0]}},
        '15': {'class_type': 'EmptyMiniMaxMusic3LatentAudio', 'inputs': {'seconds': d, 'batch_size': 1}},
        '9': {'class_type': 'KSampler', 'inputs': {'model': ['6', 0], 'positive': ['13', 0], 'negative': ['10', 0], 'latent_image': ['15', 0], 'seed': seed, 'steps': 30, 'cfg': 1.7, 'sampler_name': 'euler', 'scheduler': 'simple', 'denoise': 1.0}},
        '12': {'class_type': 'VAEDecodeAudio', 'inputs': {'samples': ['9', 0], 'vae': ['7', 0]}},
        '35': {'class_type': 'SaveAudioMP3', 'inputs': {'audio': ['12', 0], 'filename_prefix': f"audio/deepsea_{cue['id']}", 'quality': 'V0'}},
    }

for cue in CUES:
    if want and cue['id'] not in want: continue
    seed = int(os.environ.get('SEED', random.randrange(1, 2**40)))
    try:
        pid = json.loads(req('/prompt', {'prompt': graph(cue, seed), 'client_id': 'deepsea'}))['prompt_id']
    except urllib.error.HTTPError as e:
        print(cue['id'], 'REJECTED', e.read().decode()[:1500], flush=True); continue
    print(cue['id'], 'queued', pid, 'seed', seed, flush=True)
    t0 = time.time()
    while True:
        time.sleep(5)
        h = json.loads(req('/history/' + pid))
        if pid in h:
            st = h[pid].get('status', {})
            if st.get('status_str') == 'error':
                print(cue['id'], 'ERROR', json.dumps(st)[:1200], flush=True); break
            outs = [a for o in h[pid]['outputs'].values() for a in o.get('audio', [])]
            if outs:
                a = outs[0]
                q = urllib.parse.urlencode({'filename': a['filename'], 'subfolder': a.get('subfolder', ''), 'type': a.get('type', 'output')})
                dst = os.path.join(ROOT, 'assets', 'music', cue['id'] + '.mp3')
                if os.path.exists(dst): os.replace(dst, dst.replace('.mp3', f'.prev{int(time.time())}.mp3'))
                open(dst, 'wb').write(req('/view?' + q, timeout=300))
                print(cue['id'], 'saved', dst, f'{time.time() - t0:.0f}s', flush=True)
                break
        if time.time() - t0 > 1800:
            print(cue['id'], 'TIMEOUT', flush=True); break
