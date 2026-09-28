#!/usr/bin/env python3
"""Pixabay audio via the existing deepsea CDP test tab (python port of ~/.codex/skills/pixabay).
Never launches a browser or creates a tab; navigates the saved test tab to Pixabay and back.
usage: uv run --with websocket-client tools/pixabay.py inspect "<query>"
       uv run --with websocket-client tools/pixabay.py get items.json ../assets/audio/src
items: [{"name":"amb","query":"underwater ambience","match":"regex on title"}]"""
import json, os, sys, time, base64, hashlib, urllib.parse
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import cdp

def ev(s, expr):
    r = s.call('Runtime.evaluate', expression=expr, awaitPromise=True, returnByValue=True)
    if 'exceptionDetails' in r:
        raise RuntimeError(r['exceptionDetails'].get('exception', {}).get('description') or r['exceptionDetails'].get('text'))
    return r['result'].get('value')

def search(s, q):
    s.call('Page.navigate', url='https://pixabay.com/sound-effects/search/%s/' % urllib.parse.quote(q))
    for _ in range(30):
        time.sleep(0.5)
        try:
            if ev(s, "document.readyState") == 'complete' and ev(s, "document.querySelectorAll('a[class*=\"title--\"]').length") > 0:
                break
        except Exception:
            pass
    time.sleep(0.8)
    ev(s, """(()=>{document.querySelector('#onetrust-reject-all-handler')?.click();for(const d of document.querySelectorAll('[role="dialog"]'))d.querySelector('[aria-label="Close"]')?.closest('button')?.click();})()""")

LIST = """[...document.querySelectorAll('a[class*="title--"]')].slice(0,30).map(a=>{const row=a.closest('[class*="audioRow"]');
 const d=row?.querySelector('[class*="duration"]')?.textContent||'';return {title:a.textContent.trim(),dur:d.trim(),author:row?.querySelector('a[href*="/users/"]')?.textContent||'',url:a.href}})"""

def main():
    cmd = sys.argv[1]
    cdp.ensure()
    tab, ws = cdp.pick_tab()
    home = tab.get('url')
    s = cdp.Session(ws)
    s.call('Page.enable')
    try:
        if cmd == 'inspect':
            for q in sys.argv[2:]:
                search(s, q)
                print('##', q, '|', ev(s, 'document.title'))
                for r in ev(s, LIST) or []:
                    print('  %-6s %-50s %s' % (r['dur'], r['title'][:50], r['author']))
        elif cmd == 'get':
            items = json.load(open(sys.argv[2])); out = sys.argv[3]
            os.makedirs(out, exist_ok=True)
            mpath = os.path.join(out, 'manifest.json')
            manifest = json.load(open(mpath)) if os.path.exists(mpath) else []
            have = {m['name'] for m in manifest}
            for it in items:
                if it['name'] in have or os.path.exists(os.path.join(out, it['name'] + '.mp3')):
                    print('skip', it['name']); continue
                search(s, it['query'])
                try:
                    r = ev(s, """(async()=>{
 const a=[...document.querySelectorAll('a[class*="title--"]')].find(a=>new RegExp(%s,'i').test(a.textContent));if(!a)throw Error('Matching track not found');
 const row=a.closest('[class*="audioRow"]');row.querySelector('[aria-label="Play"]')?.closest('button')?.click();await new Promise(r=>setTimeout(r,900));
 const audio=[...document.querySelectorAll('audio')].at(-1);audio?.pause();const src=audio?.src;if(!src||new URL(src).hostname!=='cdn.pixabay.com')throw Error('No public Pixabay audio source');
 const res=await fetch(src);if(!res.ok)throw Error('HTTP '+res.status);const b=new Uint8Array(await res.arrayBuffer());if(b.length>10000000)throw Error('too big');
 let bin='';for(let i=0;i<b.length;i+=32768)bin+=String.fromCharCode(...b.subarray(i,i+32768));
 return {title:a.textContent.trim(),author:row.querySelector('a[href*="/users/"]')?.textContent||'',page:a.href,download:src,b64:btoa(bin)};})()""" % json.dumps(it['match']))
                except Exception as e:
                    print('FAIL', it['name'], str(e)[:200]); continue
                data = base64.b64decode(r.pop('b64'))
                if any(m['download'] == r['download'] for m in manifest):
                    print('DUPLICATE source for', it['name'], '- skipped'); continue
                if len(data) < 256 or not (data[:3] == b'ID3' or (data[0] == 255 and data[1] & 224 == 224)):
                    print('not mp3', it['name']); continue
                open(os.path.join(out, it['name'] + '.mp3'), 'xb').write(data)
                manifest.append({'name': it['name'], **r, 'bytes': len(data), 'sha256': hashlib.sha256(data).hexdigest(),
                                 'downloadedAt': time.strftime('%Y-%m-%dT%H:%M:%S'), 'license': 'https://pixabay.com/service/license-summary/'})
                json.dump(manifest, open(mpath, 'w'), indent=1, ensure_ascii=False)
                print('ok', it['name'], len(data), r['title'], '/', r['author'])
    finally:
        s.call('Page.navigate', url=home)
        time.sleep(0.6)

if __name__ == '__main__':
    main()
