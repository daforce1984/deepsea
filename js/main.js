// DEEPSEA — first-person descent from a dive boat to the abyssal plain (4000 m). Fixed 24 fps.
import { Renderer, FRAME_FLOATS } from './renderer.js';
import { MAX_LIGHTS } from './shaders.js';
import { m4, v3, clamp, lerp, smooth, ORIGIN, relP } from './math.js';
import { loadGLB } from './gltf.js';
import { Audio } from './audio.js';
import { BOAT_S, World, FLOOR_DEPTH, ZONES, waveHeight } from './world.js';
import { Hands } from './hands.js';

const $ = (id) => document.getElementById(id);
const Q = new URLSearchParams(location.search);
const TORCH_RANGE = 65;   // m: beam march / shadow far plane
const showErr = (e) => { const el = $('err'); el.style.display = 'block'; el.textContent += (e?.stack || e) + '\n'; console.error(e); };
window.addEventListener('error', (e) => showErr(e.error || e.message));
window.addEventListener('unhandledrejection', (e) => showErr(e.reason));

// ---- water optics (Jerlov type I clear ocean; absorption a, scattering b, diffuse attenuation Kd) ----
const ABSORB = [0.33, 0.052, 0.016];
const KD = [0.357, 0.0598, 0.0192];
const E0 = 6.0;                                    // surface irradiance (HDR units)
const SUN_AIR = v3.norm([0.3597, 0.7880, -0.4995]);  // 52° elevation midday sun (matches SUN_AIR in shaders)
// Snell refraction of the sun into the water: sin(θw) = sin(θa) / 1.333
const SUN_UW = (() => { const h = Math.hypot(SUN_AIR[0], SUN_AIR[2]), sw = h / 1.333, cw = Math.sqrt(1 - sw * sw);
  return [SUN_AIR[0] / h * sw, cw, SUN_AIR[2] / h * sw]; })();
const FPS = 24;

const R = new Renderer();
const A = new Audio();
const canvas = $('c');
let world, hands;

const cam = { pos: [0, 2.1, 0], yaw: 0, pitch: 0, vel: [0, 0, 0], fov: 72 * Math.PI / 180, bob: 0 };
const state = { mode: 'boat', t: 0, frame: 0, torch: false, computer: false, exposure: 0.6, entryT: 0, zone: -1, started: false, fade: 0, flash: 0 };
const keys = {};
let prevVP = m4.ident(), prevOrigin = [0, 0, 0];
window.GAME = { cam, state, R, A, get world() { return world; }, get hands() { return hands; } };

async function boot() {
  await R.init(canvas);
  resize();
  window.addEventListener('resize', resize);
  const models = {};
  const list = ['shark', 'turtle', 'crab', 'crab_king_scan', 'angler', 'goblin_shark', 'reef_fish_barramundi', 'reef_fish_kingfish', 'boat', 'rocks_a'];
  const game = ['torch', 'divecomputer', 'sleeve', 'diveboat_hd'];
  await Promise.all([
    ...list.map(async (n) => { models[n] = await loadGLB(`assets/models/raw/${n}.glb`); }),
    ...game.map(async (n) => { models[n] = await loadGLB(`assets/models/game/${n}.glb`); }),
    ...['hand_left', 'hand_right'].map(async (n) => { models[n] = await loadGLB(`assets/models/raw/${n}.glb`); }),
    ...[['crab_scan', 'crab'], ['turtle_scan', 'sea_turtle']].map(async ([k, f]) => { models[k] = await loadGLB(`assets/models/raw2/${f}.glb`); }),
    ...['sunfish', 'tuna', 'dolphin'].map(async (n) => { models[n] = await loadGLB(`assets/models/raw4/${n}.glb`); }),
    (async () => { models.kingfish13 = await loadGLB('assets/models/raw13/kingfish.glb'); })(),   // yellowtail amberjack, CC-BY (see raw13/SOURCES.txt)
    (async () => { models.humpback = await loadGLB('assets/models/raw5/humpback.glb'); })(),
    (async () => { models.shark_rt = await loadGLB('assets/models/raw6/shark.glb'); })(),
    (async () => { models.deepfish = await loadGLB('assets/models/raw7/deepfish.glb'); })(),
    (async () => { models.squid = await loadGLB('assets/models/raw8/squid.glb'); })(),
    (async () => { models.manta_ray = await loadGLB('assets/models/raw12/manta.glb'); })(),   // 'Manta Ray Swim' by tferdin1 (CC-BY 4.0, recoloured/rigged)
    ...['neoscopelid', 'sea_toad', 'greeneye', 'armored_searobin', 'giant_isopod', 'gulper_eel'].map(async (n) => { models['r9_' + n] = await loadGLB(`assets/models/raw9/${n}.glb`); }),
    ...['spurdog', 'swell_shark', 'megalodon_rigged'].map(async (n) => { models['r9_' + n.replace('_rigged', '')] = await loadGLB(`assets/models/raw11/${n}.glb`); }),   // CC-BY 4.0 (see raw11/SOURCES.txt)   // CC-BY 4.0 scans (see raw9/SOURCES.txt)   // 'Japanese Flying Squid' by ffish.asia / floraZia.com (CC-BY 4.0, reshaped to giant-squid proportions)   // 'Amami Grenadier' by ffish.asia / floraZia.com (CC-BY 4.0, modified)
  ]);
  R.loadSky('assets/sky/rosendal_plains_1_2k.hdr', [0.3597, 0.7880, -0.4995]).catch((e) => console.warn('sky hdr', e));   // 'Rosendal Plains 1' (Dimitrios Savva, Jarod Guest) — Poly Haven, CC0: deep blue sky, white cumulus
  world = new World(R, A, models);
  hands = new Hands(R, models);
  for (const m of Object.values(models)) m.images?.forEach((im) => im.close?.());
  if (Q.has('view')) return viewer(models[Q.get('view')]);
  if (Q.has('depth')) { state.mode = 'dive'; cam.pos = [0, -parseFloat(Q.get('depth')), 0]; state.fade = 1; }
  $('go').textContent = '클릭하여 시작'; $('go').classList.remove('wait');
  $('start').addEventListener('click', start);
  $('goFloor').classList.remove('wait');
  $('goFloor').addEventListener('click', (e) => {
    e.stopPropagation();
    if (state.started) return;
    // skip the descent: hover ~2 m above the abyssal floor, eyes already adapted to the dark
    state.mode = 'dive'; state.fade = 1; state.exposure = 20; state.torch = true;   // torch already on down here
    cam.pos = [0, world.floorHeight(0, 0) + 2.2, 0]; cam.vel = [0, 0, 0]; cam.pitch = 0;
    start();
  });
  if (Q.has('auto')) start();
  requestAnimationFrame(tick);
}

async function start() {
  if (!state.started) {
    state.started = true;
    $('start').style.opacity = 0; setTimeout(() => ($('start').style.display = 'none'), 900);
    try { await A.init(); } catch (e) { console.warn(e); }
    A.loop('surface_waves', 'amb', state.mode === 'boat' ? 0.5 : 0);
    ['amb_shallow', 'amb_deep', 'amb_abyss'].forEach((n) => A.loop(n, 'amb', 0));
    A.loop('bubbles_loop', 'amb', 0);
    A.setUnderwater(state.mode !== 'boat');
    tip(state.mode === 'boat' ? '마우스로 둘러보기 · WASD 갑판 이동' : '');
    $('entryHint').style.opacity = state.mode === 'boat' ? 1 : 0;
    keysHelp(); lookHud(false);
  }
  lockPointer();
}
function lockPointer() { try { const r = canvas.requestPointerLock?.(); r?.catch?.(() => {}); } catch (e) { /* needs a user gesture */ } }
canvas.addEventListener('click', () => {
  if (!state.started || state.cine || state.dbg) return;   // cinematic / debug keep the cursor free
  if (document.pointerLockElement !== canvas) lockPointer();
});
// cinematic: cursor hidden; any mouse movement shows it, 3 s after the mouse stops it hides again
let cursorT = 0;
function cineCursor(show) {
  clearTimeout(cursorT);
  document.body.style.cursor = !state.cine || show ? '' : 'none';
  if (state.cine && show) cursorT = setTimeout(() => { if (state.cine) document.body.style.cursor = 'none'; }, 3000);
}
document.addEventListener('mousemove', (e) => {
  if (state.cine) { cineCursor(true); return; }
  if (document.pointerLockElement !== canvas) return;   // cinematic camera ignores the mouse
  cam.yaw -= e.movementX * 0.0022;
  if (state.freeLook) cam.pitch = clamp(cam.pitch - e.movementY * 0.0022, -1.45, 1.45);   // locked: horizontal only
});
document.addEventListener('keydown', (e) => {
  keys[e.code] = true;
  if (!state.started) return;
  if (e.code === 'KeyF' && state.mode !== 'boat') { state.torch = !state.torch; A.play('torch_click', 0.8, { bus: 'helmet' }); }
  if (e.code === 'Space') { e.preventDefault(); if (state.mode !== 'boat') { state.computer = !state.computer; if (state.computer) A.play('hud_beep', 0.35, { bus: 'helmet' }); } else beginEntry(); }
  if (e.code === 'KeyM') A.toggleMute();
  if (e.code === 'Backquote') {   // debug: scheduled events + force-start buttons
    state.dbg = !state.dbg; $('dbg').style.display = state.dbg ? '' : 'none';
    if (state.dbg) { try { document.exitPointerLock?.(); } catch (err) {} dbgRender(true); } else lockPointer();
  }
  if (e.code === 'Enter') {
    state.cine = !state.cine; cineHud();
    if (state.cine) { director.beats = {}; director.slow = 0; rig.init = false; }
    // cinematic: full screen, free cursor (auto-hidden); leaving it restores the window and mouse look
    if (state.cine) {
      try { document.exitPointerLock?.(); } catch (err) {}
      try { if (!document.fullscreenElement) document.documentElement.requestFullscreen?.({ navigationUI: 'hide' })?.catch?.(() => {}); } catch (err) {}
      cineCursor(false);
    } else {
      try { if (document.fullscreenElement) document.exitFullscreen?.()?.catch?.(() => {}); } catch (err) {}
      cineCursor(false); lockPointer();
    }
    if (state.cine && state.mode === 'boat') beginEntry();
  }
  if (e.code === 'KeyX') { R.aa = !R.aa; tip(R.aa ? '안티에일리어싱 ON (FXAA)' : '안티에일리어싱 OFF', 2); }
  if (e.code === 'KeyV') { state.freeLook = !state.freeLook; lookHud(); A.play('hud_beep', 0.25, { bus: 'helmet' }); }
  if (e.code === 'KeyB') { A.setBreath(!A.breathOn); breathHud(); }
  if (e.code === 'BracketRight' || e.code === 'Equal') { A.setBreath(true, A.breathVol + 0.1); breathHud(); }
  if (e.code === 'BracketLeft' || e.code === 'Minus') { A.setBreath(undefined, A.breathVol - 0.1); breathHud(); }
  if (e.code === 'KeyH') $('keys').style.display = $('keys').style.display === 'none' ? '' : 'none';
});
document.addEventListener('keyup', (e) => { keys[e.code] = false; });

// ---- debug overlay: what is scheduled, when, and buttons to force any event possible at this depth ----
let dbgLast = 0; const dbgPressed = {};   // event key → when its debug start button was pressed
function dbgRender(force) {
  if (!state.dbg || !world) return;
  const now = performance.now(); if (!force && now - dbgLast < 250) return; dbgLast = now;
  const depth = Math.max(0, -cam.pos[1]), t = state.t;
  const fmt = (v) => typeof v === 'number' ? (v <= 0 ? '곧' : v.toFixed(0) + '초 후') : (v || '—');
  const ev = world.eventCatalog(cam.pos, depth, t);
  const B = director.beats || {}, beats = [['bait', 22], ['cutlass', 40], ['whale', 38], ['manta', 48], ['cutlass2', 75], ['shark', 80], ['turtle', 230], ['mega', 340], ['jelly', 520], ['squid', 760], ['angler', 1150]];
  let h = `<h4>DEBUG · ${depth.toFixed(1)} m · ${state.mode}${state.cine ? ' · CINE' : ''}</h4>`;
  h += `<div class="row"><span>심해 자동 이벤트 (40–75초 주기)</span><span>${depth >= 150 ? fmt(world.evT) + (world.lastEv ? ' · 직전 ' + world.lastEv : '') : '150 m 이하에서'}</span></div>`;
  h += `<div class="row"><span>얕은 곳 고래쇼</span><span>${depth < 25 ? fmt(world.showT ?? 50) : '25 m 이내에서'}</span></div>`;
  h += '<h4 style="margin-top:10px">이벤트</h4>';
  const far = (d) => d == null ? '' : (d < 15 ? '~' + Math.round(d) : '~' + Math.round(d / 5) * 5) + ' m';   // approximate distance to the animal
  // group by the depth where each event starts; a divider only where a new zone begins
  const ZONES = [[0, '표층 · 0–200 m'], [200, '중층 · 200–1000 m'], [1000, '심층 · 1000 m –']];
  const zoneOf = (m) => ZONES.reduce((z, q, k) => (m >= q[0] ? k : z), 0);
  const order = ev.map((e, i) => i).sort((a, b) => ev[a].min - ev[b].min || a - b);
  const nowMs = performance.now(); let zone = -1;
  order.forEach((i) => {
    const e = ev[i], z = zoneOf(e.min);
    if (z !== zone) { zone = z; h += `<div class="zdiv ${zoneOf(depth) === z ? 'here' : ''}">${ZONES[z][1]}${zoneOf(depth) === z ? ' · 현재' : ''}</div>`; }
    // button state: running (the event reports it) → pressed and waiting (cue sent, animal on its way) → idle
    const live = typeof e.eta === 'string' && e.eta.startsWith('진행 중');
    if (live) delete dbgPressed[e.key];
    const pend = !live && dbgPressed[e.key] && nowMs - dbgPressed[e.key] < 20000;
    const btn = live ? '진행 중' : pend ? '시작됨…' : '시작';
    h += `<div class="row ${e.ok ? '' : 'off'} ${live ? 'live' : pend ? 'pend' : ''}"><span>${e.label} <small style="opacity:.6">${e.band || ''}</small></span><span>${e.ok && e.dist != null ? `<b style="color:#8fe">${far(e.dist)}</b> · ` : ''}${e.ok ? fmt(e.eta) : '수심 밖'} <button data-ev="${i}" ${e.ok && !live ? '' : 'disabled'}>${btn}</button></span></div>`;
  });
  if (state.cine) { h += '<h4 style="margin-top:10px">시네마틱 비트</h4>'; beats.forEach(([k, d]) => { h += `<div class="row ${B[k] ? 'off' : ''}"><span>${k}</span><span>${B[k] ? '완료' : d + ' m'}</span></div>`; }); }
  const el = $('dbg'); el.innerHTML = h;
  el.querySelectorAll('button[data-ev]').forEach((b) => b.onclick = (e) => { e.stopPropagation(); const x = world.eventCatalog(cam.pos, Math.max(0, -cam.pos[1]), state.t)[+b.dataset.ev]; if (x && x.ok) { x.fn(); dbgPressed[x.key] = performance.now(); tip('이벤트 시작: ' + x.label, 2); } dbgRender(true); });
}
function cineHud() {
  $('cine').style.display = state.cine ? '' : 'none';
  document.body.classList.toggle('cine', !!state.cine);
  tip(state.cine ? '시네마틱 하강 ON — Enter로 해제' : '시네마틱 하강 OFF', 2.5);
}
function lookHud(showTip = true) {
  $('look').textContent = state.freeLook ? 'FREE LOOK' : 'LOOK: HORIZONTAL';
  $('look').classList.toggle('on', !!state.freeLook);
  if (showTip) tip(state.freeLook ? '자유 시점 ON (V)' : '시점 고정: 좌우만 (V로 해제)', 2);
}
function breathHud() {
  const n = Math.round(A.breathVol * 10);
  tip(A.breathOn ? `호흡음 ON  ${'▮'.repeat(n)}${'▯'.repeat(10 - n)}  ${Math.round(A.breathVol * 100)}%` : '호흡음 OFF', 2);
}
function keysHelp() {
  $('keys').innerHTML = [['WASD', '수영'], ['E / Q', '하강 / 상승'], ['Shift', '추진기 부스트'], ['F', '손전등'], ['Space', '손목 심도계'], ['Enter', '시네마틱 자동 하강'], ['V', '자유 시점 토글'], ['X', '안티에일리어싱 (기본 ON)'], ['B', '호흡음 켜기/끄기'], ['[ / ]', '호흡음 볼륨'], ['M', '음소거'], ['H', '도움말 숨김']]
    .map(([k, d]) => `<kbd>${k}</kbd>${d}`).join('<br>');
}
let tipTimer = 0;
function tip(s, dur = 7) { $('tip').textContent = s; $('tip').style.opacity = s ? 1 : 0; tipTimer = dur; }

function resize() {
  const dpr = Math.min(window.devicePixelRatio || 1, 1.5);
  const cw = window.innerWidth * dpr, ch = window.innerHeight * dpr;
  const maxH = parseInt(Q.get('h') || '900');   // higher internal resolution: finer edges (AA)
  const s = Math.min(1, maxH / ch);
  R.resize(Math.round(cw * s), Math.round(ch * s));
}

function beginEntry() {
  if (state.mode !== 'boat') return;
  state.entryHigh = null;
  if (world.walk && state.deckH !== undefined && state.deckH > world.walk.deck + 0.5) {
    // upper deck: walk to the nearest side edge and jump off it (a ~4 m drop, well clear of the hull)
    const dp = state.deckPos, h = state.deckH, sg = dp[0] >= 0 ? 1 : -1;
    let xe = dp[0]; for (let x = dp[0]; Math.abs(x) < 3; x += 0.05 * sg) { if (world.walkStep(x, dp[1], h) === null) break; xe = x; }
    state.entryHigh = { from: [dp[0], state.eyeH ?? h, dp[1]], edge: [xe, h, dp[1]], sg, yaw0: cam.yaw };
  }
  state.mode = 'entry'; state.entryT = 0; tip(''); $('entryHint').style.opacity = 0;
}

// ---------------------------------------------------------------- update
function camMatrix() {
  const b = cam.bob;
  return m4.mul(m4.mul(m4.translate(cam.pos), m4.rotY(cam.yaw)), m4.mul(m4.rotX(cam.pitch), m4.rotZ(b * 0.012)));
}

const depth0 = () => Math.max(0, -cam.pos[1]);
// ---- simulated diver head/body for the cinematic camera ----
// head: fast damped spring (saccade-like glance with a soft settle), limited range relative to the body;
// body: slow fin-kick turn against water drag, only when the head stays turned; idle gaze = discrete fixations.
const wrapA = (a) => Math.atan2(Math.sin(a), Math.cos(a));
const rig = { init: false, by: 0, byv: 0, hy: 0, hyv: 0, hp: 0, hpv: 0, gy: 0, gp: 0, fixT: 0, turnT: 0, lastTarget: null, wristT: 30 };
function spring(x, v, target, freq, damp, dt) {
  const k = (2 * Math.PI * freq) ** 2, c = 2 * damp * Math.sqrt(k);
  v += (k * (target - x) - c * v) * dt;
  return [x + v * dt, v];
}
function diverLook(dt, target, mood) {
  if (!rig.init) { rig.init = true; rig.by = cam.yaw; rig.hy = 0; rig.hp = cam.pitch; rig.byv = rig.hyv = rig.hpv = 0; rig.gy = cam.yaw; rig.gp = cam.pitch; }
  const tense = mood === 'tension';
  // --- choose where to look ---
  rig.commit = Math.max(0, (rig.commit || 0) - dt);
  if (target) {
    const d = v3.sub(target, cam.pos);
    const ny = Math.atan2(-d[0], -d[2]), np = clamp(Math.atan2(d[1], Math.hypot(d[0], d[2])), -0.9, 0.7);
    // commit to what we're watching: switch to a different subject only after 2.5 s (or when tense / nearby in view)
    const jump = Math.abs(wrapA(ny - rig.gy)) > 0.9;
    if (!jump || rig.commit <= 0 || tense) {
      if (jump) rig.commit = 4.0;
      rig.gy = ny; rig.gp = np;
    }
    rig.fixT = 0.6;
  } else {
    rig.fixT -= dt;
    if (rig.fixT <= -1.0) {     // after losing a subject for ~1.5 s, next fixation point: a modest glance around the body's heading
      rig.fixT = 3.0 + Math.random() * 4;
      rig.gy = rig.by + (Math.random() - 0.5) * 1.0;
      rig.gp = (Math.random() - 0.6) * 0.5;
    }
    rig.wristT -= dt;
    if (rig.wristT <= 0 && !state.computer) { rig.wristT = 35 + Math.random() * 40; state.computer = true; rig.wristOff = 3.2; }   // glance at the dive computer
  }
  if (rig.wristOff > 0) { rig.wristOff -= dt; rig.gp = -0.55; rig.gy = rig.by - 0.25; if (rig.wristOff <= 0) state.computer = false; }
  const newTarget = target && rig.commit > 2.3;   // just switched subject
  rig.lastTarget = target;
  // --- head: fast spring toward the gaze, relative to the body, limited range ---
  const hyT = clamp(wrapA(rig.gy - rig.by), -1.2, 1.2), hpT = clamp(rig.gp, -0.9, 0.7);
  // slow, critically damped head turns with a speed cap (~45°/s, ~70°/s when tense): unhurried, no snap or overshoot
  const hf = tense ? 0.75 : target ? 0.42 : 0.3, hd = 1.0, vmax = tense ? 1.2 : 0.8;
  [rig.hy, rig.hyv] = spring(rig.hy, rig.hyv, hyT, hf, hd, dt);
  [rig.hp, rig.hpv] = spring(rig.hp, rig.hpv, hpT, hf * 0.85, hd, dt);
  rig.hyv = clamp(rig.hyv, -vmax, vmax); rig.hpv = clamp(rig.hpv, -vmax * 0.7, vmax * 0.7);
  // --- body: turns only if the head stays turned; slow, drag-limited fin turn ---
  // body re-aligns only when the gaze sits beyond a comfortable head turn for a while (head does the tracking)
  rig.turnT = Math.abs(hyT) > 0.8 ? rig.turnT + dt : Math.max(0, rig.turnT - dt * 2);
  const bodyGoal = rig.turnT > 1.6 ? rig.gy - Math.sign(wrapA(rig.gy - rig.by)) * 0.35 : rig.by;
  const bf = tense ? 0.35 : 0.18;
  let e = wrapA(bodyGoal - rig.by);
  const k = (2 * Math.PI * bf) ** 2, c = 2 * 1.0 * Math.sqrt(k);
  rig.byv += (k * e - c * rig.byv) * dt;
  rig.byv = clamp(rig.byv, -0.21, 0.21);                    // ~12°/s max body yaw rate (slow fin turn against drag)
  rig.by = wrapA(rig.by + rig.byv * dt);
  // --- micro-motion: breath buoyancy, fin-kick rhythm, tiny head noise ---
  const t = state.t;
  const kick = Math.sin(t * 1.7);
  cam.yaw = rig.by + rig.hy + Math.sin(t * 0.63) * 0.006 + Math.sin(t * 1.37) * 0.003;
  cam.pitch = clamp(rig.hp + kick * 0.008 + Math.sin(t * 0.91) * 0.004, -1.4, 1.4);
  cam.bob = kick * 0.6 + rig.byv * 8;                        // roll into body turns + kick rhythm
  cam.pos[1] += (state.exhaling ? -0.004 : 0.003) * dt * 24 * 0.25;   // lungs change buoyancy
}
// ---- cinematic director: pacing (relaxed / tense / awe / arrival) + music ----
const director = { mood: null, hold: 0, pauseT: 45, pausing: 0 };
function direct(dt, depth, under) {
  const W = world, P = cam.pos;
  const whaleD = W.whale?.sw?.pos ? v3.dist(W.whale.sw.pos, P) : 1e9;
  const tu = W.turtle, turtleD = tu?.active && tu.c.visible ? v3.dist([tu.c.world[12], tu.c.world[13], tu.c.world[14]], P) : 1e9;
  // music only for special moments; otherwise silence (ambience only)
  const sw = W.swarm, sq = W.squad;
  const swarmNear = sw?.active && v3.dist(sw.center, P) < 28, squadNear = sq?.active && sq.lead && v3.dist(sq.lead.pos, P) < 35;
  const once = director.once || (director.once = {});
  const moment = (key, cond, dur) => { if (cond && once[key] === undefined) once[key] = state.t; return once[key] !== undefined && state.t - once[key] < dur; };
  let want = null;
  if (!under || depth < 40) want = null;                           // the opening (boat, surface, first 40 m): no music, only the sea
  else if ((W.threat || 0) > 0.3) want = 'tension';
  else if (whaleD < 45 || turtleD < 70) want = 'awe';
  else if (swarmNear || squadNear) want = 'calm_surface';
  else if (moment('floor', depth >= FLOOR_DEPTH - 20, 90)) want = 'arrival';
  else if (moment('jelly', depth > 480 && depth < 1500, 60)) want = 'twilight';
  else if (moment('angler', depth > 1150, 50)) want = 'abyss';
  director.hold -= dt;
  const strong = (m) => m === 'tension' || m === 'awe';
  if (want !== director.mood && (director.hold <= 0 || (want === 'tension' && director.mood !== 'tension'))) {
    director.mood = want; director.hold = want ? (strong(want) ? 9 : 8) : 3;
    A.music(want, want === 'tension' ? 2 : want ? 5 : 6);          // fade in 2–5 s, fade out ~6 s
  }
  if (A.ctx && (A.curMusic ?? null) !== director.mood) A.music(director.mood, 5);   // (re)start once audio is available
  if (A.ctx) A.setMusicLevel(0.1);   // background music at 10%
  return director.mood;
}
function update(dt) {
  state.t += dt; state.frame++;
  const t = state.t;
  const fwd = [-Math.sin(cam.yaw) * Math.cos(cam.pitch), Math.sin(cam.pitch), -Math.cos(cam.yaw) * Math.cos(cam.pitch)];
  const right = [Math.cos(cam.yaw), 0, -Math.sin(cam.yaw)];
  if (state.mode === 'boat') {
    // standing on the aft dive deck, riding the swell with the boat
    const bm = world.boatMatrix(t);
    // walk the cockpit deck with WASD (boat-local plane; blocked by the cabin, rails and fittings)
    state.deckPos = state.deckPos || [world.spawnLocal[0], world.spawnLocal[2]];
    if (state.deckH === undefined) state.deckH = world.walkStep(state.deckPos[0], state.deckPos[1], world.walk?.deck ?? 0) ?? (world.walk?.deck ?? 0);
    let mx = 0, mz = 0;
    if (keys.KeyW) { mx += fwd[0]; mz += fwd[2]; } if (keys.KeyS) { mx -= fwd[0]; mz -= fwd[2]; }
    if (keys.KeyD) { mx += right[0]; mz += right[2]; } if (keys.KeyA) { mx -= right[0]; mz -= right[2]; }
    const ml = Math.hypot(mx, mz);
    if (ml > 0 && !state.cine) {
      const step = 1.3 * dt / ml, dp = state.deckPos;
      const nx = dp[0] + mx * step, nz = dp[1] + mz * step;
      // step onto the nearest floor within reach (stairs climb tread by tread); slide along obstacles
      let h;
      if ((h = world.walkStep(nx, nz, state.deckH)) !== null) { dp[0] = nx; dp[1] = nz; state.deckH = h; }
      else if ((h = world.walkStep(nx, dp[1], state.deckH)) !== null) { dp[0] = nx; state.deckH = h; }
      else if ((h = world.walkStep(dp[0], nz, state.deckH)) !== null) { dp[1] = nz; state.deckH = h; }
      state.walkPh = (state.walkPh || 0) + dt * 7;
    }
    const stepBob = ml > 0 ? Math.abs(Math.sin(state.walkPh || 0)) * 0.03 : 0;
    state.eyeH = lerp(state.eyeH ?? state.deckH, state.deckH, 1 - Math.exp(-dt * 12));        // smooth over each stair tread
    cam.pos = m4.xform(bm, [state.deckPos[0], state.eyeH + 1.65 / BOAT_S - stepBob, state.deckPos[1]]);
    cam.bob = (world.boatState?.roll || 0) * 40;
  } else if (state.mode === 'entry') {
    state.entryT += dt;
    const e = state.entryT;
    const bm = world.boatMatrix(t);
    const eye = 1.65 / BOAT_S, walk = 2.2;   // boat-local units
    const H = state.entryHigh;
    if (H) {
      const walkH = 1.3, yawOut = -H.sg * Math.PI / 2;                           // face out over the side
      if (e < walkH) {                                                           // walk to the edge, step up onto it
        const k = smooth(0, 1, e / walkH), hop = Math.sin(Math.PI * smooth(0.7, 1, e / walkH)) * 0.25;
        cam.pos = m4.xform(bm, [lerp(H.from[0], H.edge[0], k), lerp(H.from[1], H.edge[1], k) + eye + hop, H.from[2]]);
        const bv = m4.xdir(bm, [H.sg * 2.8, 1.8, 0]);                           // the jump: out and a little up
        cam.vel = [bv[0], bv[1], bv[2]];
        cam.pitch = lerp(cam.pitch, -0.25, dt * 3);
      } else {
        if (cam.pos[1] > 0) cam.vel[1] -= 9.8 * dt;
        else cam.vel = [cam.vel[0] * Math.pow(0.05, dt), lerp(cam.vel[1], -0.9, 1 - Math.pow(0.004, dt)), cam.vel[2] * Math.pow(0.05, dt)];
        cam.pos = v3.add(cam.pos, v3.scale(cam.vel, dt));
        if (cam.pos[1] < 0.25 && !state.splashed) {
          state.splashed = true; state.flash = 1;
          A.play('entry_splash', 1.1, { bus: 'helmet' }); setTimeout(() => A.play('entry_under', 0.9), 280);
          world.burst(cam.pos, 220);
        }
        if (cam.pos[1] < -2.2 || e > walkH + 7) { state.mode = 'dive'; state.entryHigh = null; tip('F 손전등 · Space 손목 심도계 · E 하강 (Shift 부스트)', 9); }
        cam.pitch = lerp(cam.pitch, cam.pos[1] > 0 ? -0.55 : -0.08, dt * 2);
      }
      let dy = yawOut - cam.yaw; dy = Math.atan2(Math.sin(dy), Math.cos(dy)); cam.yaw += dy * Math.min(1, dt * 3);
    } else if (e < walk) { // climb over the stern rail, drop onto the swim platform, walk to its edge
      const k = smooth(0, 1, e / walk);
      const a = state.deckPos ? [state.deckPos[0], world.spawnLocal[1], state.deckPos[1]] : world.spawnLocal, b = [world.entryLocal[0], world.entryLocal[1] + eye, world.entryLocal[2] + 0.3];
      const local = [lerp(a[0], b[0], k), world.entryCurve(k), lerp(a[2], b[2], k)];   // head clears the real rail geometry
      cam.pos = m4.xform(bm, local);
      cam.vel = [0, 0.6, -1.8];
    } else {        // giant stride off the platform edge
      if (cam.pos[1] > 0) cam.vel[1] -= 9.8 * dt;
      else {   // water brakes the plunge, then a slow sink through the surface (half-above / half-below view)
        cam.vel = [cam.vel[0] * Math.pow(0.05, dt), lerp(cam.vel[1], -0.9, 1 - Math.pow(0.004, dt)), cam.vel[2] * Math.pow(0.05, dt)];
      }
      cam.pos = v3.add(cam.pos, v3.scale(cam.vel, dt));
      if (cam.pos[1] < 0.25 && !state.splashed) {
        state.splashed = true; state.flash = 1;
        A.play('entry_splash', 1.0, { bus: 'helmet' });                              // real surface impact (heard in air)
        setTimeout(() => A.play('entry_under', 0.9), 280);                             // then the muffled rush of bubbles under water
        world.burst(cam.pos, 160);
      }
      if (cam.pos[1] < -2.2 || e > walk + 6) {
        state.mode = 'dive';
        tip('F 손전등 · Space 손목 심도계 · E 하강 (Shift 부스트)', 9);
      }
    }
    if (!H) { cam.pitch = lerp(cam.pitch, e < walk ? -0.35 : -0.08, dt * 2); cam.yaw = lerp(cam.yaw, 0, dt * 3); }
  } else {
    // swimming: neutral buoyancy, thruster-assisted
    const boost = keys.ShiftLeft || keys.ShiftRight ? 9 : 1;
    const acc = [0, 0, 0];
    const add = (v, s) => { acc[0] += v[0] * s; acc[1] += v[1] * s; acc[2] += v[2] * s; };
    if (keys.KeyW) add(fwd, 1); if (keys.KeyS) add(fwd, -0.6);
    if (keys.KeyD) add(right, 0.7); if (keys.KeyA) add(right, -0.7);
    if (keys.KeyE || keys.KeyC) acc[1] -= 1; if (keys.KeyQ) acc[1] += 1;
    if (state.cine) {
      // cinematic descent: pacing follows the director's mood
      const mood = state.mood, d0 = depth0();
      const floorY0 = world.floorHeight(cam.pos[0], cam.pos[2]);
      const hAbove = cam.pos[1] - floorY0;
      let target = world.interest(cam.pos, d0);
      if (mood === 'tension' && world.threatPos) target = world.threatPos;
      if (mood === 'awe') target = world.whale?.sw?.pos || (world.turtle?.active ? [world.turtle.c.world[12], world.turtle.c.world[13], world.turtle.c.world[14]] : target);
      let vy = d0 < 60 ? 1.8 : d0 < 400 ? 3.2 : d0 < 1100 ? 6 : 25;
      if (target && world.interestDist < 18) vy = Math.min(vy, 1.5);
      if (mood === 'tension') vy = 0.3;
      if (mood === 'awe') vy = 0.15;
      // scripted encounter beats (once per dive): cue the animal, slow down while it plays out
      const B = director.beats || (director.beats = {});
      const beat = (key, depthAt, fn, slow) => { if (d0 > depthAt && !B[key]) { B[key] = true; fn(); director.slow = slow; } };
      beat('bait', 22, () => {}, 28);                        // sardine murmuration (triggered by the world at 20 m)
      beat('whale', 38, () => {}, 26);                       // humpback close pass
      beat('manta', 48, () => {}, 26);                       // manta squadron
      beat('shark', 80, () => { world.sharks.forEach((sh, i) => { sh.timer = 2 + i * 12; }); }, 26);
      beat('cutlass', 40, () => {}, 22);                     // hovering cutlassfish (sunlit)
      beat('cutlass2', 75, () => {}, 24);                    // swaying cutlassfish forest
      beat('turtle', 230, () => { world.turtle.wait = 0; }, 30);
      beat('mega', 340, () => { world.megaCue = true; }, 34);                 // megalodon looms out of the dark
      beat('jelly', 520, () => { world.jellyPassT = 0; }, 16);
      beat('squid', 760, () => { world.squidCue = true; }, 40);   // giant squid rises out of the dark
      beat('angler', 1150, () => { world.anglerPassT = 0; }, 18);
      director.slow = Math.max(0, (director.slow || 0) - dt);
      if (director.slow > 0 && mood !== 'tension' && mood !== 'awe') vy = Math.min(vy, 0.6);
      // relaxed beats: every 40–70 s stop and slowly look around
      director.pauseT -= dt;
      if (mood !== 'tension' && mood !== 'awe' && director.pauseT <= 0 && !director.pausing) { director.pausing = 9; director.pauseT = 40 + Math.random() * 30; }
      if (director.pausing > 0) { director.pausing -= dt; vy = 0.1; target = null; }
      vy *= smooth(2.5, 25, hAbove);
      const fwdH = [-Math.sin(cam.yaw), 0, -Math.cos(cam.yaw)];
      const want = v3.add([0, -vy, 0], v3.scale(fwdH, hAbove < 6 ? 0.8 : 0.25));
      cam.vel = v3.lerp(cam.vel, want, 1 - Math.exp(-dt * (mood === 'tension' ? 1.5 : 0.6)));
      // lens: tight + handheld in tension, wide in awe
      const fovT = (mood === 'tension' ? 60 : 72) * Math.PI / 180;   // no wide-angle in awe: it shrinks giants
      cam.fov = lerp(cam.fov, fovT, 1 - Math.exp(-dt * (mood === 'tension' ? 1.2 : 0.4)));
      diverLook(dt, target, mood);
      if (d0 > 150 && !state.torch) { state.torch = true; A.play('torch_click', 0.6, { bus: 'helmet' }); }
    } else cam.fov = lerp(cam.fov, 72 * Math.PI / 180, 1 - Math.exp(-dt * 2));
    const al = state.cine ? 0 : v3.len(acc);
    const maxV = state.cine ? 30 : 3.2 * boost;
    const a = al > 0 ? v3.scale(acc, (4.5 * boost) / al) : [0, 0, 0];
    cam.vel = v3.add(cam.vel, v3.scale(a, dt));
    const drag = state.cine ? 1 : Math.exp(-dt * (al > 0 ? 1.2 : 1.8));
    cam.vel = v3.scale(cam.vel, drag);
    const sp = v3.len(cam.vel); if (sp > maxV) cam.vel = v3.scale(cam.vel, maxV / sp);
    cam.vel = v3.add(cam.vel, v3.scale(world.push || [0, 0, 0], dt));
    cam.pos = v3.add(cam.pos, v3.scale(cam.vel, dt));
    const floorY = world.floorHeight(cam.pos[0], cam.pos[2]);
    if (cam.pos[1] < floorY + 1.3) { cam.pos[1] = floorY + 1.3; cam.vel[1] = Math.max(cam.vel[1], 0); }
    const wh = R.ocean.probeValid ? R.ocean.heights[0] : 0;   // FFT surface height at the camera (GPU probe)
    if (cam.pos[1] > wh + 0.02) { cam.pos[1] = lerp(cam.pos[1], wh + 0.02, 1 - Math.exp(-dt * 8)); cam.vel[1] = Math.min(cam.vel[1], 0); }
    else if (!state.cine && cam.pos[1] > wh - 0.6 && !(keys.KeyE || keys.KeyC) && cam.vel[1] > -0.5) {
      // floating at the surface: the head rides the swell at the waterline
      cam.pos[1] = lerp(cam.pos[1], wh + 0.02, 1 - Math.exp(-dt * 3));
    }
    // gentle fin-kick sway
    if (!state.cine) cam.bob = Math.sin(t * 1.9) * (0.4 + Math.min(sp, 4) * 0.4);
    // buffeted by a giant's wake: the body is rolled and twisted by the vortex
    const bf = world.buffet || 0;
    if (bf > 0.01) {
      cam.bob += (Math.sin(t * 2.3) * 1.6 + Math.sin(t * 5.1 + 1.7) * 0.7) * bf * 3.0;
      cam.yaw += (Math.sin(t * 1.7 + 0.5) + Math.sin(t * 3.9) * 0.5) * bf * 0.35 * dt;
      cam.pitch += Math.sin(t * 2.9 + 1.1) * bf * 0.25 * dt;
    }
    cam.pos[1] += Math.sin(t * 0.8) * 0.004;
  }
  if (!state.freeLook && !state.cine && state.mode !== 'entry') cam.pitch = lerp(cam.pitch, 0, 1 - Math.exp(-dt * 4));
  state.flash = Math.max(0, state.flash - dt * 1.6);
  state.fade = Math.min(1, state.fade + dt * 0.7);
  const depth = Math.max(0, -cam.pos[1]);
  const under = state.mode === 'dive' || (state.mode === 'entry' && cam.pos[1] < 0);
  // eye adaptation toward the ambient water brightness (capped: the deep stays dark)
  let target;
  if (!under) target = 0.95;
  else {
    const e = KD.map((k) => E0 * Math.exp(-k * depth));
    const lum = 0.2126 * e[0] + 0.7152 * e[1] + 0.0722 * e[2];
    const bNow = depth < 150 ? lerp(0.018, 0.022, depth / 150) : 0.022;   // metering keeps the reference turbidity (clearer shallows must not push exposure up)
    const Lw = 0.035 * lum * (bNow / 0.045);          // ~ horizontal water luminance (scales with scattering)
    target = clamp(0.35 / Math.pow(Lw + 1e-7, 0.85), 0.5, 26);
    target *= lerp(1.6, 1.0, smooth(10, 45, depth));            // bright, clear shallows: the top 10 m are sunlit and luminous
    target = lerp(0.95, target, smooth(0.15, 1.5, depth));   // at the waterline the eye still sees the sunlit world above
    // torch-lit metering: expose for the surface the lamp is actually hitting (floor under the beam), like a camera would
    if (state.torch && hands.torchDir && hands.torchPos) {
      const o = hands.torchPos, d = hands.torchDir;
      let hit = 0;
      for (let s = 0.5; s < 30; s *= 1.25) { const p = [o[0] + d[0] * s, o[1] + d[1] * s, o[2] + d[2] * s]; if (p[1] < world.floorHeight(p[0], p[2])) { hit = s; break; } }
      const obj = world.beamHit ? world.beamHit(o, d) : 0;
      if (obj && (!hit || obj < hit)) hit = obj * 1.15;          // an animal in the beam is the subject: expose for it
      if (hit) {
        const sig = 0.06, rad = 0.5 / Math.PI * 6.5 * (hands.torchPower || 0) / (hit * hit + 0.02) * Math.exp(-2 * sig * hit);
        if (rad > 1e-4) target = Math.min(target, clamp(0.6 / rad, 0.5, 26));
      }
    }
  }
  state.exposure = lerp(state.exposure, target, 1 - Math.exp(-dt * (target > state.exposure ? (under && depth < 15 ? 2.2 : 0.8) : 1.5)));   // in the bright shallows the eye adapts at once
  // zone banner
  if (under) {
    let z = 0; ZONES.forEach((zz, i) => { if (depth >= zz.d) z = i; });
    if (z !== state.zone) { state.zone = z; showZone(ZONES[z]); }
  }
  if (tipTimer > 0) { tipTimer -= dt; if (tipTimer <= 0) $('tip').style.opacity = 0; }
  // audio mix
  if (A.ctx) {
    A.setUnderwater(under);
    A.setLoop('surface_waves', under ? 0 : 0.55, 0.2);
    // the deeper, the quieter: overall level falls off, and the deep ambience arrives only in occasional swells
    // separated by silences that grow longer with depth
    const lvl = lerp(1, 0.08, smooth(0, 3600, depth)) * lerp(1, 0.75, smooth(200, 700, depth));
    const G = state.ambGate || (state.ambGate = { on: false, t: 3, v: 0 });
    G.t -= dt;
    if (G.t <= 0) {
      G.on = !G.on;
      const silence = lerp(5, 60, smooth(150, 3500, depth));
      G.t = G.on ? 8 + Math.random() * 8 : silence * (0.6 + Math.random() * 0.8);
    }
    G.v = lerp(G.v, G.on || depth < 150 ? 1 : 0, 1 - Math.exp(-dt / 3));   // slow swell in / fade out
    A.setLoop('amb_shallow', under ? 0.55 * (1 - smooth(60, 250, depth)) * lvl : 0);
    A.setLoop('amb_deep', under ? 0.6 * smooth(80, 300, depth) * (1 - smooth(1200, 2500, depth)) * lvl * G.v : 0, 1.5);
    A.setLoop('amb_abyss', under ? 0.7 * smooth(1000, 2200, depth) * lvl * G.v : 0, 1.5);
    A.setLoop('bubbles_loop', under ? 0.08 : 0, 0.3);
  }
  // exertion: swimming effort, thruster boost, close predators
  const fright = Math.max(world.startle || 0, (world.buffet || 0) * 0.8);
  const effort = clamp(v3.len(cam.vel) / 6, 0, 1) * 0.6 + (keys.ShiftLeft || keys.ShiftRight ? 0.3 : 0) + (world.threat || 0) * 0.5 + fright * 0.95;
  state.exertion = lerp(state.exertion || 0, clamp(effort, 0, 1), 1 - Math.exp(-dt * (effort > (state.exertion || 0) ? (fright > 0.5 ? 4 : 0.8) : 0.15)));
  state.exhaling = A.breathe(state.exertion, under && state.mode === 'dive');
  // depth announcements (voice + caption), once per stage on the way down
  if (under && A.voiceLines && state.mode === 'dive') {
    state.vIdx = state.vIdx ?? A.voiceLines.findIndex(([d]) => d > depth + 1);
    const L = A.voiceLines[state.vIdx];
    if (state.vIdx >= 0 && L && depth >= L[0]) { A.voice(L[1]); tip(L[3] || L[2], 4); state.vIdx++; }
  }
  // occasional distant whale calls
  if (under && A.ctx && state.mode === 'dive') {
    state.whaleT = (state.whaleT ?? 25 + Math.random() * 30) - dt;
    if (state.whaleT <= 0) { if (Math.random() < 1 - smooth(1000, 1500, depth)) A.whale(); state.whaleT = 45 + Math.random() * 65; }   // whales don't reach the deep
  }
  ORIGIN[0] = cam.pos[0]; ORIGIN[1] = cam.pos[1]; ORIGIN[2] = cam.pos[2];
  state.mood = direct(dt, depth, under);
  const cm = camMatrix();
  world.camVel = cam.vel;
  world.cineClose = !!state.cine && depth0() > 150;
  world.torchOn = state.torch && hands.torchPower > 0.5; world.torchP = hands.torchPos; world.torchD = hands.torchDir;   // after dark every cinematic encounter passes close by
  if (A.ctx) A.setListener([cm[12], cm[13], cm[14]], [-cm[8], -cm[9], -cm[10]], [cm[4], cm[5], cm[6]]);   // 3D sound follows the head
  world.update(dt, t, cam, cm, depth, state);
  hands.update(dt, t, cm, cam, state, depth);
  return { cm, depth, under };
}

function showZone(z) {
  const el = $('zone'); el.querySelector('b').textContent = z.name; el.querySelector('span').textContent = z.sub;
  el.classList.add('show'); clearTimeout(showZone.tm); showZone.tm = setTimeout(() => el.classList.remove('show'), 5200);
  if (A.ctx && state.zone > 0) A.play('sonar', 0.25, { bus: 'helmet' });
}

// ---------------------------------------------------------------- render
const frame = new Float32Array(FRAME_FLOATS), sframe = new Float32Array(FRAME_FLOATS), finalU = new Float32Array(16);
function render({ cm, depth, under }) {
  const W = R.W, H = R.H;
  // camera-relative: the view has no translation; prev view-proj re-based onto the current origin
  const cmR = new Float64Array(cm); cmR[12] = cmR[13] = cmR[14] = 0;
  const view = m4.invert(cmR);
  const near = 0.03, far = 3000;
  const proj = m4.persp(cam.fov, W / H, near, far);
  const vp = m4.mul(proj, view);
  const ivp = m4.invert(vp);
  // flashlight (from the torch in the right hand)
  const sp = relP(hands.torchPos), sd = hands.torchDir;
  const outer = 0.72, inner = 0.26;          // ~41° half-angle wide dive light with a softer hotspot
  const up = Math.abs(sd[1]) > 0.95 ? [1, 0, 0] : [0, 1, 0];
  // under water: torch spot shadow; in air: orthographic sun shadow over the boat around the camera
  const nearSurface = cam.pos[1] > -1.5;
  const spotVP = !nearSurface ? m4.mul(m4.persp(outer * 2 + 0.05, 1, 0.08, TORCH_RANGE), m4.lookAt(sp, v3.add(sp, sd), up))
    : m4.mul(m4.ortho(30, 30, 1, 160), m4.lookAt(v3.scale(SUN_AIR, 80), [0, 0, 0], [0, 0, 1]));
  const lights = world.lights(cam.pos);
  if (hands.light && lights.length < MAX_LIGHTS) lights.push(hands.light);
  const clr = 1 - smooth(10, 40, depth);                          // the sunlit top ~10 m: glass-clear, then blends to open-ocean water
  const b = lerp(depth < 150 ? lerp(0.018, 0.022, depth / 150) : 0.022, 0.008, clr);   // crystal-clear Atlantic shallows
  const sediment = smooth(FLOOR_DEPTH - 30, FLOOR_DEPTH - 2, depth) * 0.025;
  const torchOn = state.torch && under;
  const prevRel = m4.mul(prevVP, m4.translate([ORIGIN[0] - prevOrigin[0], ORIGIN[1] - prevOrigin[1], ORIGIN[2] - prevOrigin[2]]));
  frame.set(vp, 0); frame.set(ivp, 16); frame.set(spotVP, 32); frame.set(prevRel, 48);
  frame.set([0, 0, 0, state.t], 64);
  frame.set([SUN_UW[0], SUN_UW[1], SUN_UW[2], E0], 68);
  frame.set([ABSORB[0], ABSORB[1] * (1 - 0.5 * clr), ABSORB[2] * (1 - 0.5 * clr), b], 72);   // red keeps its physical absorption
  frame.set([KD[0], KD[1], KD[2], state.exposure], 76);
  frame.set([sp[0], sp[1], sp[2], torchOn ? hands.torchPower * 6.5 : 0], 80);
  frame.set([sd[0], sd[1], sd[2], Math.cos(outer)], 84);
  frame.set([Math.cos(inner), TORCH_RANGE, under ? 1 : 0, -FLOOR_DEPTH], 88);
  frame.set([W, H, 1 / W, 1 / H], 92);
  frame.set([lights.length, state.frame, sediment, depth], 96);
  // volumetric history weight: drop the temporal history while the torch is switching (on/off + ramp) so the whole
  // beam appears at once instead of depth edges running ahead of the rest
  if (state.torch !== state.lastTorch) { state.lastTorch = state.torch; state.histReset = 0.6; }
  state.histReset = Math.max(0, (state.histReset || 0) - 1 / 24);   // render() runs once per fixed 24 fps step
  const pw = hands.torchPower || 0;
  const histW = state.histReset > 0 || (pw > 0.01 && pw < 0.99) ? 0 : 1;
  frame.set([ORIGIN[0], ORIGIN[1], ORIGIN[2], histW], 100);
  const wk = world.wake;
  if (wk && under) {
    const o = relP(wk.o);
    frame.set([o[0], o[1], o[2], wk.phase, wk.ax[0], wk.ax[1], wk.ax[2], wk.R, wk.jit, wk.L, 0, 0], 200);
  } else frame.fill(0, 200, 212);
  frame[210] = R.skyScale || 0; frame[211] = R.skyUOff || 0;   // photographic sky parameters (wakeP.zw)
  // diver wake trail: a sample every 0.2 s while swimming (from the fins, behind the body), aging and fading
  {
    const tr = state.trail || (state.trail = []);
    state.trailT = (state.trailT || 0) - 1 / 24;
    const sp = v3.len(cam.vel);
    if (under && state.trailT <= 0 && sp > 0.15) {
      state.trailT = 0.2;
      const f = v3.scale(cam.vel, 1 / sp);
      tr.unshift({ p: v3.sub(cam.pos, v3.add(v3.scale(f, 0.5), [0, 0.35, 0])), v: [...cam.vel], age: 0 });
      if (tr.length > 8) tr.pop();
    }
    frame.fill(0, 212, 340);
    (world.ripples || []).forEach((r, i) => { const q = relP([r.x, 0, r.z]); frame.set([q[0], q[2], r.age, r.amp], 276 + i * 4); });
    tr.forEach((q, i) => {
      q.age += 1 / 24;
      const w = Math.min(1, v3.len(q.v) / 1.5) * Math.exp(-q.age / 2.2);
      const r = relP(q.p);
      frame.set([r[0], r[1], r[2], q.age], 212 + i * 4);
      frame.set([q.v[0], q.v[1], q.v[2], w], 244 + i * 4);
    });
  }
  for (let i = 0; i < MAX_LIGHTS; i++) {
    const L = lights[i];
    const lp = L ? relP(L.p) : null;
    frame.set(L ? [lp[0], lp[1], lp[2], L.r] : [0, 0, 0, 0], 104 + i * 4);
    frame.set(L ? [L.c[0], L.c[1], L.c[2], 0] : [0, 0, 0, 0], 152 + i * 4);
  }
  sframe.set(frame); sframe.set(spotVP, 0);
  finalU.set([W, H, 1 / W, 1 / H, state.exposure, under ? 0.075 : 0.1, state.t, under ? 1 : 0, state.flash * 0.8, under ? lerp(0.28, 0.55, smooth(10, 60, depth)) : 0.18, under ? smooth(30, 260, depth) * 0.55 : 0, state.fade, under ? 1 - smooth(15, 60, depth) : 0, 0, 0, 0]);
  const draws = [...world.draws, ...hands.draws];
  const probes = [[cam.pos[0], cam.pos[2]], ...world.hullProbes];
  // environment cube: rebake on medium change, every ~1.5 m of depth, and every 4 s at the surface (sun/sky static)
  const envMode = cam.pos[1] > 0 ? 0 : 1;
  let envBake = null;
  if (envMode !== state.envMode || (envMode === 1 && Math.abs(cam.pos[1] - state.envY) > 1.5) || state.t - (state.envT ?? -99) > 4) {
    envBake = envMode; state.envMode = envMode; state.envY = cam.pos[1]; state.envT = state.t;
  }
  const bf = world.boatFoot;
  dbgRender(false);
  R.render({ foam: depth0() < 60 ? { dt: 1 / 24, boatM: world.boatM, centre: world.foamCentre || [bf[0], bf[1]], emit: world.foamEmit || [] } : null, envBake, time: state.t, probes, frame, shadowFrame: sframe, finalU, bloomThreshold: 1.0 / state.exposure, spotOn: torchOn || nearSurface, draws, floor: world.floor, surface: world.surface, fx: world.fx, jelly: world.jelly, bubbles: world.bub, gpuSpray: world.gpuSpray, origin: [ORIGIN[0], ORIGIN[1], ORIGIN[2]] });
  prevVP = vp; prevOrigin = [ORIGIN[0], ORIGIN[1], ORIGIN[2]];
}

// ---------------------------------------------------------------- loop (fixed 24 fps)
let next = 0, fpsN = 0, fpsT = 0, fps = 0, cpuMs = 0;
function tick(now) {
  requestAnimationFrame(tick);
  const step = 1000 / FPS;
  if (!next) next = now;
  if (now < next - 6) return;
  next += step;
  if (now - next > 250) next = now + step;
  const t0 = performance.now();
  try {
    const u = update(1 / FPS);
    render(u);
  } catch (e) { showErr(e); throw e; }
  cpuMs = lerp(cpuMs, performance.now() - t0, 0.1);
  fpsN++;
  if (now - fpsT > 1000) {
    fps = fpsN * 1000 / (now - fpsT); fpsN = 0; fpsT = now;
    const mem = performance.memory ? (performance.memory.usedJSHeapSize / 1048576).toFixed(0) + 'MB heap · ' : '';
    $('perf').textContent = `${fps.toFixed(1)} fps · cpu ${cpuMs.toFixed(1)}ms · ${mem}gpu ~${(R.bytes / 1048576).toFixed(0)}MB · ${R.W}×${R.H}`;
    window.GAME.stats = { fps, cpuMs, gpuMB: R.bytes / 1048576, heapMB: performance.memory ? performance.memory.usedJSHeapSize / 1048576 : 0 };
  }
}

// debug: advance frames synchronously (works while the window is hidden/minimised)
window.GAME.step = async (n = 1) => {
  for (let i = 0; i < n; i++) { render(update(1 / FPS)); if (i % 6 === 5) await R.device.queue.onSubmittedWorkDone(); }
  await R.device.queue.onSubmittedWorkDone();
  return { depth: -cam.pos[1], exposure: state.exposure };
};
// ---------------------------------------------------------------- model viewer (debug): ?view=<name>
function viewer(model) {
  $('start').style.display = 'none';
  state.mode = 'dive'; cam.pos = [0, -8, 0];
  world.viewerModel(model);
  state.fade = 1;
  requestAnimationFrame(tick);
}

boot().catch(showErr);
