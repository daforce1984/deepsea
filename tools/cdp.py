#!/usr/bin/env python3
"""CDP helper for the user-visible Windows Chrome (single reused test tab).

Rules (AGENTS.md): never launch headless/background browsers, never create tabs.
The only tab used is the one saved in tools/.cdp_tab.json (or re-found by URL).

usage (run with: uv run --with websocket-client tools/cdp.py <cmd> ...):
  ensure                 start visible debug Chrome + relay if needed, pick test tab
  nav <url>              navigate the test tab
  eval <js>              evaluate JS (awaits promises), print result
  shot <out.png>         screenshot of the test tab
  reload [wait]          hard reload (ignore cache)
  click <x> <y>          real mouse click (user gesture)
  console                print recent console messages captured on connect (5s)
"""
import json, os, sys, time, socket, subprocess, base64, urllib.request

HERE = os.path.dirname(os.path.abspath(__file__))
STATE = os.path.join(HERE, '.cdp_tab.json')
DEBUG_PORT, RELAY_PORT = 9031, 9032
PROJECT_HINT = 'localhost:8795'
WIN_PY = '/mnt/c/Users/dafor/AppData/Local/Python/bin/python.exe'


def gateway_ip():
    for line in open('/proc/net/route'):
        f = line.split()
        if f[1] == '00000000':
            g = f[2]
            return '.'.join(str(int(g[i:i + 2], 16)) for i in (6, 4, 2, 0))
    return '127.0.0.1'


BASE = f'http://{gateway_ip()}:{RELAY_PORT}'


def http_json(path, timeout=3):
    with urllib.request.urlopen(BASE + path, timeout=timeout) as r:
        return json.loads(r.read().decode())


def reachable():
    try:
        http_json('/json/version', 2)
        return True
    except Exception:
        return False


def winpath(p):
    return subprocess.check_output(['wslpath', '-w', p]).decode().strip()


def win_port_listening(port):
    out = subprocess.run(['powershell.exe', '-NoProfile', '-Command',
                          f'(Get-NetTCPConnection -State Listen -LocalPort {port} -ErrorAction SilentlyContinue | Measure-Object).Count'],
                         capture_output=True, text=True).stdout.strip()
    return out not in ('', '0')


def ensure():
    if reachable():
        return
    if not win_port_listening(DEBUG_PORT):
        subprocess.Popen(['cmd.exe', '/c', winpath(os.path.join(HERE, 'chrome.bat'))],
                         stdin=subprocess.DEVNULL, stdout=subprocess.DEVNULL,
                         stderr=subprocess.DEVNULL, start_new_session=True, cwd='/mnt/c')
        for _ in range(40):
            time.sleep(1)
            if win_port_listening(DEBUG_PORT):
                break
        else:
            sys.exit('ERROR: chrome debug port never came up')
    if not win_port_listening(RELAY_PORT):
        subprocess.Popen([WIN_PY, winpath(os.path.join(HERE, 'cdp_relay.py')), str(RELAY_PORT), str(DEBUG_PORT)],
                         stdin=subprocess.DEVNULL, stdout=subprocess.DEVNULL,
                         stderr=subprocess.DEVNULL, start_new_session=True, cwd='/mnt/c')
    for _ in range(30):
        if reachable():
            return
        time.sleep(1)
    sys.exit('ERROR: relay not reachable at ' + BASE)


def pick_tab():
    pages = [t for t in http_json('/json/list') if t.get('type') == 'page']
    saved = None
    if os.path.exists(STATE):
        saved = json.load(open(STATE)).get('id')
    tab = next((t for t in pages if t['id'] == saved), None)
    if not tab:
        tab = next((t for t in pages if PROJECT_HINT in t.get('url', '')), None)
    if not tab:
        # freshly launched dedicated profile: its only blank tab becomes the test tab
        blanks = [t for t in pages if t.get('url', '') in ('about:blank', 'chrome://newtab/', 'chrome://new-tab-page/')]
        if len(pages) == 1 and blanks:
            tab = blanks[0]
    if not tab:
        sys.exit('ERROR: no suitable existing test tab (will not create one). pages=' +
                 json.dumps([(t['id'], t.get('url')) for t in pages]))
    json.dump({'id': tab['id'], 'url': tab.get('url')}, open(STATE, 'w'))
    ws = tab['webSocketDebuggerUrl'].replace('ws://127.0.0.1:%d' % DEBUG_PORT, 'ws://%s:%d' % (gateway_ip(), RELAY_PORT))
    ws = ws.replace('ws://localhost:%d' % DEBUG_PORT, 'ws://%s:%d' % (gateway_ip(), RELAY_PORT))
    return tab, ws


class Session:
    def __init__(self, ws_url):
        import websocket
        self.ws = websocket.create_connection(ws_url, timeout=120, suppress_origin=True, max_size=None) \
            if 'max_size' in websocket.create_connection.__code__.co_varnames else \
            websocket.create_connection(ws_url, timeout=120, suppress_origin=True)
        self.n = 0
        self.events = []

    def call(self, method, **params):
        self.n += 1
        mid = self.n
        self.ws.send(json.dumps({'id': mid, 'method': method, 'params': params}))
        while True:
            msg = json.loads(self.ws.recv())
            if msg.get('id') == mid:
                if 'error' in msg:
                    raise RuntimeError(msg['error'])
                return msg.get('result', {})
            self.events.append(msg)


def main():
    if len(sys.argv) < 2:
        sys.exit(__doc__)
    cmd = sys.argv[1]
    ensure()
    tab, ws = pick_tab()
    if cmd == 'ensure':
        print('tab', tab['id'], tab.get('url'))
        return
    s = Session(ws)
    if cmd == 'nav':
        s.call('Page.enable')
        s.call('Page.navigate', url=sys.argv[2])
        time.sleep(float(sys.argv[3]) if len(sys.argv) > 3 else 2)
        print('navigated', sys.argv[2])
    elif cmd == 'reload':
        s.call('Page.enable')
        s.call('Page.reload', ignoreCache=True)
        time.sleep(float(sys.argv[2]) if len(sys.argv) > 2 else 3)
        print('reloaded')
    elif cmd == 'front':
        s.call('Page.bringToFront')
        print('front')
    elif cmd == 'call':
        # call <Domain.method> '<json params>' : raw CDP command on the test tab (never Target.* tab creation)
        if sys.argv[2].startswith('Target.'): raise SystemExit('Target.* not allowed')
        print(json.dumps(s.call(sys.argv[2], **(json.loads(sys.argv[3]) if len(sys.argv) > 3 else {})), ensure_ascii=False)[:2000])
    elif cmd == 'eval':
        r = s.call('Runtime.evaluate', expression=sys.argv[2], awaitPromise=True, returnByValue=True)
        print(json.dumps(r.get('result', {}).get('value', r), ensure_ascii=False, indent=1))
    elif cmd == 'shot':
        r = s.call('Page.captureScreenshot', format='png')
        open(sys.argv[2], 'wb').write(base64.b64decode(r['data']))
        print('saved', sys.argv[2])
    elif cmd == 'shots':
        # shots <outdir> <t1> <t2> ... : freeze film at each time and capture (scaled jpeg)
        out = sys.argv[2]
        os.makedirs(out, exist_ok=True)
        s.call('Runtime.evaluate', expression="document.querySelector('#start').style.display='none'")
        for tt in sys.argv[3:]:
            s.call('Runtime.evaluate', expression=f'FILM.freeze({tt})')
            # wait until the frozen frame has really been rendered and presented (heavy frames can take >0.5 s)
            s.call('Runtime.evaluate', awaitPromise=True, expression='new Promise(r=>requestAnimationFrame(()=>requestAnimationFrame(()=>FILM.R.device.queue.onSubmittedWorkDone().then(()=>requestAnimationFrame(()=>r(1))))))')
            time.sleep(0.2)
            r = s.call('Page.captureScreenshot', format='jpeg', quality=85)
            fn = os.path.join(out, 't%06.1f.jpg' % float(tt))
            open(fn, 'wb').write(base64.b64decode(r['data']))
            print('saved', fn)
    elif cmd == 'click':
        x, y = float(sys.argv[2]), float(sys.argv[3])
        for t in ('mouseMoved', 'mousePressed', 'mouseReleased'):
            s.call('Input.dispatchMouseEvent', type=t, x=x, y=y, button='left', clickCount=1)
        print('clicked')
    elif cmd == 'console':
        s.call('Runtime.enable')
        s.call('Log.enable')
        end = time.time() + float(sys.argv[2] if len(sys.argv) > 2 else 5)
        s.ws.settimeout(1)
        while time.time() < end:
            try:
                s.events.append(json.loads(s.ws.recv()))
            except Exception:
                pass
        for e in s.events:
            m = e.get('method')
            if m == 'Runtime.consoleAPICalled' and e['params']['type'] in ('error', 'warning', 'log', 'info'):
                print(e['params']['type'], ' '.join(str(a.get('value', a.get('description', ''))) for a in e['params']['args']))
            elif m == 'Runtime.exceptionThrown':
                print('EXC', json.dumps(e['params']['exceptionDetails'])[:800])
            elif m == 'Log.entryAdded':
                print('LOG', e['params']['entry'].get('level'), e['params']['entry'].get('text'))
    else:
        sys.exit(__doc__)


if __name__ == '__main__':
    main()
