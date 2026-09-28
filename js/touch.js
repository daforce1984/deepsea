// Touch controls for phones / tablets: left thumb stick (swim / walk), right-side drag to look, action buttons.
// The stick writes analog values into the same `keys` map the keyboard uses (KeyW/S/A/D: 0..1); buttons either hold a
// key (ascend / descend / boost) or fire the same keydown the keyboard would (torch, depth gauge, dive in, ...).
export const isTouch = () => new URLSearchParams(location.search).has('mobile') ||
  (matchMedia('(pointer: coarse)').matches && navigator.maxTouchPoints > 0);

export function initTouch({ cam, state, keys, clamp }) {
  document.body.classList.add('touch');
  const $ = (id) => document.getElementById(id);
  const press = (code) => { document.dispatchEvent(new KeyboardEvent('keydown', { code, bubbles: true })); document.dispatchEvent(new KeyboardEvent('keyup', { code, bubbles: true })); };
  const ui = document.createElement('div');
  ui.id = 'touch';
  ui.innerHTML = `
    <div id="tLook"></div>
    <div id="tStick"><div class="ring"></div><div class="knob"></div></div>
    <div class="tcol" id="tRight">
      <button data-hold="KeyQ" class="dive">▲<small data-t="상승|Up"></small></button>
      <button data-hold="KeyE" class="dive">▼<small data-t="하강|Down"></small></button>
      <button data-hold="ShiftLeft" class="dive">≫<small data-t="부스트|Boost"></small></button>
    </div>
    <div class="trow" id="tTop">
      <button data-key="KeyF" class="dive" data-t="손전등|Torch"></button>
      <button data-key="Space" class="dive" data-t="심도계|Gauge"></button>
      <button id="tMenuBtn">☰</button>
    </div>
    <button id="tEntry" data-key="Space" data-t="바다로 뛰어들기|Dive in"></button>
    <div id="tMenu">
      <button data-key="Enter" data-t="시네마틱 자동 하강|Cinematic auto descent"></button>
      <button data-key="KeyV" data-t="자유 시점 토글|Toggle free look"></button>
      <button data-key="KeyB" data-t="호흡음 켜기/끄기|Breathing sound on/off"></button>
      <button id="tGyro"></button>
      <button data-key="KeyM" data-t="음소거|Mute"></button>
      <button data-key="KeyL">English / 한국어</button>
      <button id="tFull" data-t="전체 화면|Fullscreen"></button>
      <button data-key="Backquote" data-t="디버그 (이벤트)|Debug (events)"></button>
      <button id="tClose" data-t="닫기|Close"></button>
    </div>
`;
  document.body.appendChild(ui);

  // ---- left stick: appears where the thumb lands in the lower-left half ----
  const stick = $('tStick'), knob = stick.querySelector('.knob');
  let sid = null, sx = 0, sy = 0;
  const R = 56;
  const setMove = (x, y) => {   // x right, y forward, each -1..1
    keys.KeyW = Math.max(0, y); keys.KeyS = Math.max(0, -y);
    keys.KeyD = Math.max(0, x); keys.KeyA = Math.max(0, -x);
  };
  const lookEl = $('tLook');
  lookEl.addEventListener('touchstart', (e) => {
    for (const t of e.changedTouches) {
      // stick: left part of the screen (portrait: lower-left only, the upper area stays free for looking)
      if (sid === null && t.clientX < innerWidth * 0.45 && (innerWidth > innerHeight || t.clientY > innerHeight * 0.4) && !state.cine) {
        sid = t.identifier; sx = t.clientX; sy = t.clientY;
        stick.style.left = sx + 'px'; stick.style.top = sy + 'px'; stick.classList.add('on');
        knob.style.transform = 'translate(-50%,-50%)';
      } else if (lid === null) { lid = t.identifier; lx = t.clientX; ly = t.clientY; }
    }
    e.preventDefault();
  }, { passive: false });
  // ---- right side: drag to look (same scale as the mouse, a little faster for thumbs) ----
  let lid = null, lx = 0, ly = 0;
  lookEl.addEventListener('touchmove', (e) => {
    for (const t of e.changedTouches) {
      if (t.identifier === sid) {
        let dx = t.clientX - sx, dy = t.clientY - sy; const l = Math.hypot(dx, dy);
        if (l > R) { dx *= R / l; dy *= R / l; }
        knob.style.transform = `translate(calc(-50% + ${dx}px), calc(-50% + ${dy}px))`;
        const dz = (v) => { const a = Math.abs(v) / R; return a < 0.12 ? 0 : Math.sign(v) * Math.min(1, (a - 0.12) / 0.8); };
        setMove(dz(dx), -dz(dy));
      } else if (t.identifier === lid) {
        const dx = t.clientX - lx, dy = t.clientY - ly; lx = t.clientX; ly = t.clientY;
        if (state.cine) continue;
        cam.yaw -= dx * 0.0045;
        if (state.freeLook) cam.pitch = clamp(cam.pitch - dy * 0.0045, -1.45, 1.45);
      }
    }
    e.preventDefault();
  }, { passive: false });
  const end = (e) => {
    for (const t of e.changedTouches) {
      if (t.identifier === sid) { sid = null; stick.classList.remove('on'); setMove(0, 0); }
      if (t.identifier === lid) lid = null;
    }
  };
  lookEl.addEventListener('touchend', end); lookEl.addEventListener('touchcancel', end);

  // ---- buttons ----
  for (const b of ui.querySelectorAll('button[data-hold]')) {
    const k = b.dataset.hold;
    const on = (e) => { e.preventDefault(); keys[k] = true; b.classList.add('down'); };
    const off = (e) => { e.preventDefault(); keys[k] = false; b.classList.remove('down'); };
    b.addEventListener('touchstart', on, { passive: false }); b.addEventListener('touchend', off); b.addEventListener('touchcancel', off);
  }
  const menu = $('tMenu');
  for (const b of ui.querySelectorAll('button[data-key]')) {
    b.addEventListener('click', (e) => { e.stopPropagation(); press(b.dataset.key); if (menu.contains(b)) menu.classList.remove('on'); });
  }
  $('tMenuBtn').addEventListener('click', () => menu.classList.toggle('on'));
  $('tClose').addEventListener('click', () => menu.classList.remove('on'));
  $('tFull').addEventListener('click', () => {
    menu.classList.remove('on');
    try { if (!document.fullscreenElement) document.documentElement.requestFullscreen?.({ navigationUI: 'hide' })?.catch?.(() => {}); else document.exitFullscreen?.(); } catch (e) {}
  });

  // ---- gyroscope look: the phone's own rotation turns the view (deltas, so thumb-drag still works on top) ----
  const gyro = { on: true, prev: null, granted: false };
  const gyroLabel = () => { const b = $('tGyro'); b.dataset.t = gyro.on ? '자이로 끄기|Gyro look: ON' : '자이로 켜기|Gyro look: OFF'; const [ko, en] = b.dataset.t.split('|'); b.textContent = document.documentElement.lang === 'ko' ? ko : en; };
  const onOri = (e) => {
    if (!gyro.on || e.alpha == null || state.cine) { gyro.prev = null; return; }
    const d2r = Math.PI / 180, o = (screen.orientation?.angle ?? window.orientation ?? 0) * d2r;
    // device orientation → camera quaternion (W3C: ZXY intrinsic; as three.js DeviceOrientationControls)
    const x = e.beta * d2r / 2, y = e.alpha * d2r / 2, z = -e.gamma * d2r / 2;
    const c1 = Math.cos(x), c2 = Math.cos(y), c3 = Math.cos(z), s1 = Math.sin(x), s2 = Math.sin(y), s3 = Math.sin(z);
    let q = [s1 * c2 * c3 + c1 * s2 * s3, c1 * s2 * c3 - s1 * c2 * s3, c1 * c2 * s3 - s1 * s2 * c3, c1 * c2 * c3 + s1 * s2 * s3];
    const mul = (a, b) => [a[3] * b[0] + a[0] * b[3] + a[1] * b[2] - a[2] * b[1], a[3] * b[1] - a[0] * b[2] + a[1] * b[3] + a[2] * b[0], a[3] * b[2] + a[0] * b[1] - a[1] * b[0] + a[2] * b[3], a[3] * b[3] - a[0] * b[0] - a[1] * b[1] - a[2] * b[2]];
    q = mul(q, [-Math.SQRT1_2, 0, 0, Math.SQRT1_2]);            // camera looks out of the back of the screen
    q = mul(q, [0, 0, Math.sin(-o / 2), Math.cos(-o / 2)]);     // screen rotation (portrait / landscape)
    // forward = q · (0, 0, -1)
    const [qx, qy, qz, qw] = q;
    const f = [-(2 * (qx * qz + qw * qy)), -(2 * (qy * qz - qw * qx)), -(1 - 2 * (qx * qx + qy * qy))];
    const yaw = Math.atan2(-f[0], -f[2]), pitch = Math.asin(clamp(f[1], -1, 1));
    if (gyro.prev) {
      let dy = yaw - gyro.prev[0]; dy -= Math.round(dy / (2 * Math.PI)) * 2 * Math.PI;
      if (Math.abs(pitch) < 1.35) cam.yaw += dy;                  // yaw is undefined looking straight up/down
      if (state.freeLook) cam.pitch = clamp(cam.pitch + (pitch - gyro.prev[1]), -1.45, 1.45);
    }
    gyro.prev = [yaw, pitch];
  };
  const gyroStart = () => {   // call from a tap (iOS asks for permission)
    if (gyro.granted) return;
    const go = () => { gyro.granted = true; addEventListener('deviceorientation', onOri); };
    const DOE = window.DeviceOrientationEvent;
    if (DOE && typeof DOE.requestPermission === 'function') DOE.requestPermission().then((r) => { if (r === 'granted') go(); else gyro.on = false, gyroLabel(); }).catch(() => { gyro.on = false; gyroLabel(); });
    else if (DOE) go();
  };
  gyroLabel();
  $('tGyro').addEventListener('click', (e) => { e.stopPropagation(); gyro.on = !gyro.on; gyro.prev = null; if (gyro.on) gyroStart(); gyroLabel(); menu.classList.remove('on'); });
  document.addEventListener('keydown', (e) => { if (e.code === 'KeyL') setTimeout(gyroLabel, 0); });

  // ---- mode-dependent visibility (boat: stick + dive-in button; diving: swim buttons) ----
  let last = '';
  update.gyroStart = gyroStart;
  return update;
  function update() {
    const m = (state.started ? 'on ' : '') + state.mode + (state.cine ? ' cine' : '') + (state.dbg ? ' dbg' : '');
    if (m === last) return; last = m;
    ui.className = m;
    if (state.cine && sid !== null) { sid = null; stick.classList.remove('on'); setMove(0, 0); }
  }
}

export const TOUCH_CSS = `
  body.touch #keys, body.touch #entryHint { display: none; }
  body.touch .tip { bottom: 19%; white-space: normal; width: 80vw; }
  #touch { position: fixed; inset: 0; z-index: 20; pointer-events: none; display: none; font-family: 'Noto Sans KR', sans-serif; -webkit-user-select: none; user-select: none; }
  #touch.on { display: block; }
  #touch button { pointer-events: auto; touch-action: none; -webkit-tap-highlight-color: transparent; background: rgba(0, 20, 30, .38); color: #bff4ff;
    border: 1px solid rgba(127, 232, 255, .45); border-radius: 50%; font: 600 18px 'Rajdhani', 'Noto Sans KR', sans-serif; }
  #touch button.down { background: rgba(127, 232, 255, .35); color: #04141a; }
  #touch button small { display: block; font: 500 9px 'Noto Sans KR'; letter-spacing: .05em; opacity: .8; }
  #tLook { position: absolute; inset: 0; pointer-events: auto; touch-action: none; }
  #tStick { position: absolute; width: 0; height: 0; opacity: 0; transition: opacity .15s; }
  #tStick.on { opacity: 1; }
  #tStick .ring { position: absolute; width: 112px; height: 112px; left: -56px; top: -56px; border-radius: 50%; border: 1.5px solid rgba(127, 232, 255, .45); background: rgba(0, 20, 30, .25); }
  #tStick .knob { position: absolute; width: 48px; height: 48px; left: 0; top: 0; border-radius: 50%; background: rgba(127, 232, 255, .4); transform: translate(-50%, -50%); }
  .tcol { position: absolute; right: max(16px, env(safe-area-inset-right)); bottom: max(18px, env(safe-area-inset-bottom)); display: flex; flex-direction: column; gap: 12px; }
  .tcol button { width: 62px; height: 62px; line-height: 1; }
  .trow { position: absolute; right: max(16px, env(safe-area-inset-right)); top: 12px; display: flex; gap: 8px; }
  .trow button { border-radius: 18px !important; height: 36px; padding: 0 14px; font-size: 13px !important; }
  #tEntry { position: absolute; left: 50%; bottom: max(22px, env(safe-area-inset-bottom)); transform: translateX(-50%); border-radius: 26px !important; padding: 12px 30px; font-size: 16px !important; letter-spacing: .15em; display: none; }
  #touch.boat #tEntry { display: block; }
  #touch.boat .dive, #touch.cine .tcol, #touch.cine #tEntry { display: none; }
  #tMenu { position: absolute; right: 16px; top: 56px; display: none; flex-direction: column; gap: 6px; padding: 10px; background: rgba(0, 10, 18, .88); border: 1px solid rgba(127, 232, 255, .35); border-radius: 10px; }
  #tMenu.on { display: flex; }
  #tMenu button { border-radius: 8px !important; padding: 9px 16px; font-size: 14px !important; text-align: left; }
  @media (orientation: portrait) {
    .tcol { gap: 10px; } .tcol button { width: 56px; height: 56px; }
    .trow { top: max(10px, env(safe-area-inset-top)); }
    #start h1 { letter-spacing: .25em; }
  }
  #dbg { z-index: 30; }
  @media (max-width: 900px) { #dbg { left: 8px; right: 8px; width: auto; top: 56px; max-height: 70vh; font-size: 11px; } }
  body.touch #look { top: 12px; }
  body.touch #perf { display: none; }
`;
