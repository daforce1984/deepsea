// Ocean column: boat & surface, fish schools, manta, sharks, turtle, bioluminescent jellies, deep-sea fish, abyssal floor & crabs.
import { hullRadii } from './foam.js';
import { tr } from './i18n.js';
import { FloorLife } from './floor.js';
import { DeepLife } from './deeplife.js';
import { m4, v3, clamp, lerp, smooth, rng, ORIGIN, rel } from './math.js';
import { Pose } from './gltf.js';
import { GpuSpray } from './spray.js';

export const FLOOR_DEPTH = 4000;
export const BOAT_S = 1.15;   // the boat model reads a little small next to the diver: scaled up 15 %
export const ZONES = [
  { d: 0, name: 'EPIPELAGIC ZONE', sub: '표층 · 햇빛층  0 – 200 m', subEn: 'Sunlight zone  0 – 200 m' },
  { d: 200, name: 'MESOPELAGIC ZONE', sub: '중층 · 트와일라잇 존  200 – 1,000 m  (햇빛 1% 미만)', subEn: 'Twilight zone  200 – 1,000 m  (under 1% of sunlight)' },
  { d: 1000, name: 'BATHYPELAGIC ZONE', sub: '점심해층 · 미드나잇 존  1,000 – 4,000 m  (햇빛 없음)', subEn: 'Midnight zone  1,000 – 4,000 m  (no sunlight)' },
  { d: 3900, name: 'ABYSSAL PLAIN', sub: '심해저 평원  ~4,000 m · 수온 2°C · 400기압', subEn: 'Abyssal plain  ~4,000 m · 2 °C · 400 atm' },
];
export const FACTS = [
  { d: 12, s: '수심 10 m — 적색광 대부분 흡수 (Kd 650nm ≈ 0.36/m)' },
  { d: 40, s: '수심 40 m — 주황빛 소실, 세상이 청록색으로' },
  { d: 100, s: '수심 100 m — 노란빛 소실 · 수면광의 약 1% 만 도달' },
  { d: 250, s: '수심 250 m — 청색광(475 nm)도 1% 이하 · 박광층' },
  { d: 600, s: '수심 600 m — 인간의 눈이 햇빛을 감지할 수 있는 한계 부근' },
  { d: 1000, s: '수심 1,000 m — 완전한 어둠. 빛은 생물발광뿐' },
];

// ---- floor height (must match FLOOR shader: integer lattice hash value noise) ----
const ih01 = (id) => ihash(id | 0, 77);
// natural body-size spread: log-normal around 1 (sigma ≈ 0.14 -> most within ±25 %, a few runts and giants)
const gauss = () => { let u = 0; for (let i = 0; i < 4; i++) u += Math.random(); return (u - 2) * 1.732; };
export const sizeVar = (sigma = 0.14) => Math.exp(gauss() * sigma);
function ihash(x, y) {
  let h = (Math.imul(x | 0, 374761393) + Math.imul(y | 0, 668265263)) >>> 0;
  h = Math.imul(h ^ (h >>> 13), 1274126177) >>> 0; h = (h ^ (h >>> 16)) >>> 0;
  return (h & 0xffffff) / 16777216;
}
function vnoise(x, y) {
  const ix = Math.floor(x), iy = Math.floor(y), fx = x - ix, fy = y - iy;
  const ux = fx * fx * (3 - 2 * fx), uy = fy * fy * (3 - 2 * fy);
  const a = lerp(ihash(ix, iy), ihash(ix + 1, iy), ux), b = lerp(ihash(ix, iy + 1), ihash(ix + 1, iy + 1), ux);
  return lerp(a, b, uy);
}
function fbm(x, y) { let s = 0, a = 0.5; for (let i = 0; i < 4; i++) { s += a * vnoise(x, y); x = x * 2.03 + 1.7; y = y * 2.03 + 9.2; a *= 0.5; } return s; }
// sea-surface height: exact Gerstner swell of the surface mesh (matches WGSL waveHeight)
const SWELL = [[0.0, 71, 0.38, 0.45], [0.38, 46, 0.24, 0.5], [-0.47, 31, 0.15, 0.55], [0.74, 20, 0.09, 0.6], [-0.92, 13.5, 0.06, 0.62], [0.18, 8.8, 0.038, 0.66], [-0.28, 6.1, 0.025, 0.7], [1.05, 4.2, 0.017, 0.7]];
function gerstnerP(x, z, t) {
  let px = x, py = 0, pz = z;
  SWELL.forEach(([a, l, amp, st], i) => {
    const ang = 0.55 + a, dx = Math.cos(ang), dz = Math.sin(ang), k = 2 * Math.PI / l;
    const th = k * (dx * x + dz * z) - Math.sqrt(9.81 * k) * t + i * 1.7, q = st / (k * amp * 8);
    px += q * amp * dx * Math.cos(th); py += amp * Math.sin(th); pz += q * amp * dz * Math.cos(th);
  });
  return [px, py, pz];
}
export function waveHeight(x, z, t) {
  let x0 = x, z0 = z;
  for (let it = 0; it < 3; it++) { const p = gerstnerP(x0, z0, t); x0 += x - p[0]; z0 += z - p[2]; }
  return gerstnerP(x0, z0, t)[1];
}
export function floorH(x, z) {
  const dunes = Math.sin(x * 0.09 + fbm(x * 0.02, z * 0.02) * 4) * 0.6;
  return -FLOOR_DEPTH + fbm(x * 0.035, z * 0.035) * 5 + dunes + fbm(x * 0.25, z * 0.25) * 0.35;
}

// ---- model normalisation: forward -> +Z, up -> +Y, metres ----
const AX = { '+z': m4.ident(), '-z': m4.rotY(Math.PI), '+x': m4.rotY(-Math.PI / 2), '-x': m4.rotY(Math.PI / 2) };
function restPositions(model, animIndex) {
  const pose = new Pose(model);
  if (animIndex >= 0) pose.sample(animIndex, 0);
  pose.update(m4.ident());
  const pts = [];
  model.nodes.forEach((nd, ni) => {
    if (nd.mesh === undefined) return;
    for (const p of model.meshes[nd.mesh]) {
      const n = p.pos.length / 3, step = Math.max(1, Math.floor(n / 1500));
      for (let i = 0; i < n; i += step) {
        const v = [p.pos[i * 3], p.pos[i * 3 + 1], p.pos[i * 3 + 2]];
        if (p.joints && nd.skin !== undefined) {
          const jm = pose.jointMats[nd.skin]; let o = [0, 0, 0];
          for (let k = 0; k < 4; k++) {
            const w = p.weights[i * 4 + k]; if (!w) continue;
            const q = m4.xform(jm.subarray(p.joints[i * 4 + k] * 16, p.joints[i * 4 + k] * 16 + 16), v);
            o = v3.add(o, v3.scale(q, w));
          }
          pts.push(o);
        } else pts.push(m4.xform(pose.global[ni], v));
      }
    }
  });
  return pts;
}
// close a gaping mouth baked into a fish mesh (model +Z forward): per slice of the front of the head find the open gap
// between upper and lower jaw (largest empty vertical interval), then lift the lower jaw by that gap so it meets the
// upper jaw -- the head, eyes and snout keep their shape
function closeMouth(model, from = 0.75) {
  let z0 = 1e9, z1 = -1e9;
  for (const prims of model.meshes) for (const p of prims) for (let i = 2; i < p.pos.length; i += 3) { z0 = Math.min(z0, p.pos[i + 0]); z1 = Math.max(z1, p.pos[i]); }
  const zf = z0 + (z1 - z0) * from, NB = 30, ys = [...Array(NB)].map(() => []);
  const bin = (z) => Math.min(NB - 1, Math.max(0, Math.floor((z - zf) / (z1 - zf + 1e-9) * NB)));
  for (const prims of model.meshes) for (const p of prims) for (let i = 0; i < p.pos.length; i += 3) if (p.pos[i + 2] >= zf) ys[bin(p.pos[i + 2])].push(p.pos[i + 1]);
  const lo = new Float32Array(NB).fill(NaN), hi = new Float32Array(NB).fill(NaN), has = new Uint8Array(NB);
  for (let b = 0; b < NB; b++) {
    const a = ys[b].sort((x, y) => x - y); if (a.length < 3) continue;
    has[b] = 1;
    const H = a[a.length - 1] - a[0]; let g = 0, gi = -1;
    for (let k = 1; k < a.length; k++) if (a[k] - a[k - 1] > g) { g = a[k] - a[k - 1]; gi = k; }
    const mid = gi > 0 ? (a[gi] + a[gi - 1]) / 2 : 0, rel = H > 0 ? (mid - a[0]) / H : 0;
    if (gi > 0 && g > H * 0.25 && rel > 0.2 && rel < 0.8) { lo[b] = a[gi - 1]; hi[b] = a[gi]; }   // a mid-height gap = the gape
  }
  // the gape: from the tip back through slices that show it (empty slices skipped) to the first solid one
  let b0 = NB;
  for (let b = NB - 1; b >= 0; b--) { if (!has[b]) continue; if (isNaN(lo[b])) break; b0 = b; }
  if (b0 >= NB) return 0;
  // fill empty slices from the nearest measured ones
  for (let b = b0; b < NB; b++) if (isNaN(lo[b])) { let q = b; while (q < NB && isNaN(lo[q])) q++; if (q >= NB) { q = b; while (q >= b0 && isNaN(lo[q])) q--; } lo[b] = lo[q]; hi[b] = hi[q]; }
  let moved = 0;
  for (const prims of model.meshes) for (const p of prims) for (let i = 0; i < p.pos.length; i += 3) {
    const z = p.pos[i + 2]; if (z < zf) continue;
    const b = bin(z); if (b < b0) continue;
    const w = smooth(b0 - 0.5, b0 + 2.5, b);                                     // ease in from the mouth corner
    if (p.pos[i + 1] <= lo[b] + 1e-6) { p.pos[i + 1] += (hi[b] - lo[b]) * 0.97 * w; moved++; }
  }
  return moved;
}
function prepare(R, model, cfg) {
  if (cfg.closeMouth && !model._mouthClosed) { model._mouthClosed = closeMouth(model, cfg.closeMouth) || true; }
  const ai = cfg.anim ? model.anims.findIndex((a) => a.name.endsWith(cfg.anim)) : -1;
  if (cfg.raw) {   // already authored in metres, Y-up, facing +Z: keep as is
    const gpu = R.uploadModel(model, { maxTex: cfg.maxTex || 1024, matOverride: cfg.mat, matByName: cfg.matByName });
    const sc0 = cfg.scale || 1;
    return { model, gpu, pre: m4.scale([sc0, sc0, sc0]), size: [0, 0, 0], anim: ai, cfg, skinned: gpu.prims.some((p) => p.skin >= 0) };
  }
  const rot = m4.mul(AX[cfg.fwd || '+z'], cfg.upZ ? m4.rotX(-Math.PI / 2) : m4.ident());
  const pts = restPositions(model, ai).map((p) => m4.xform(rot, p));
  const mn = [1e9, 1e9, 1e9], mx = [-1e9, -1e9, -1e9];
  for (const p of pts) for (let k = 0; k < 3; k++) { mn[k] = Math.min(mn[k], p[k]); mx[k] = Math.max(mx[k], p[k]); }
  const ext = v3.sub(mx, mn);
  const axis = cfg.lenAxis ?? 2;
  const s = cfg.len / ext[axis];
  const c = [(mn[0] + mx[0]) / 2, cfg.ground ? mn[1] : (mn[1] + mx[1]) / 2, (mn[2] + mx[2]) / 2];
  const pre = m4.mul(m4.scale([s, s, s]), m4.mul(m4.translate(v3.scale(c, -1)), rot));
  const size = v3.scale(ext, s);
  const gpu = R.uploadModel(model, { pre, maxTex: cfg.maxTex || 1024, matOverride: cfg.mat, matByName: cfg.matByName, forceStatic: cfg.forceStatic });
  return { model, gpu, pre, size, anim: ai, cfg, skinned: gpu.prims.some((p) => p.skin >= 0) };
}

// one skinned/static creature instance -> per-primitive draw objects
class Creature {
  constructor(R, sp, extra = {}) {
    this.R = R; this.sp = sp; this.pose = sp.skinned ? new Pose(sp.model) : null;
    this.objs = sp.gpu.prims.map((p) => {
      const o = R.object(p.skin >= 0 ? sp.model.skins[p.skin].joints.length * 64 : 0);
      o.data.set([0, 0, 0, 0], 16); o.data.set(extra.tint || [1, 1, 1, 1], 20);
      o.data.set([extra.phase || 0, extra.sss || 0, 0, extra.counter ? 1 : 0], 24);
      o.data.set(extra.bounds || [0, 0, 0, 0], 28);
      return o;
    });
    this.animT = Math.random() * 10; this.visible = true; this.world = m4.ident();
  }
  set(world, dt, animSpeed = 1, animIndex = this.sp.anim) {
    this.world = world;
    if (this.pose) {
      this.animT += dt * animSpeed;
      if (animIndex >= 0) this.pose.sample(animIndex, this.animT);
      if (this.blend && this.blend.w > 0.001) this.pose.sample(this.blend.index, this.animT, this.blend.w);   // cross-fade toward a second clip
      if (this.bend) this.bend(this.pose);                                                                      // procedural bone offsets on top
      this.pose.update(m4.mul(world, this.sp.pre));
      this.sp.gpu.prims.forEach((p, i) => { if (p.skin >= 0) this.R.device.queue.writeBuffer(this.objs[i].sb, 0, this.pose.jointMats[p.skin]); });
    }
    for (const o of this.objs) rel(world, o.data.subarray(0, 16));
  }
  draws(out, shadow = true) {
    if (!this.visible) return;
    this.sp.gpu.prims.forEach((p, i) => out.push({ gm: p.gm, mat: p.mat, obj: this.objs[i], kind: p.skin >= 0 ? 'skin' : 'static', shadow }));
  }
}

// orientation matrix: model +Z along dir, optional bank
function orient(pos, dir, bank = 0, scale = 1) {
  const f = v3.norm(dir);
  let r = v3.cross([0, 1, 0], f); if (v3.len(r) < 1e-4) r = [1, 0, 0]; r = v3.norm(r);
  let u = v3.cross(f, r);
  if (bank) { const c = Math.cos(bank), s = Math.sin(bank); const r2 = v3.add(v3.scale(r, c), v3.scale(u, s)); u = v3.add(v3.scale(u, c), v3.scale(r, -s)); r = r2; }
  return m4.basis(v3.scale(r, scale), v3.scale(u, scale), v3.scale(f, scale), pos);
}
// how far a creature can still be seen (water transmittance ~5% in the clear shallows; darkness limits it deeper)
export function visRange(depth, glow = false) {
  const light = depth < 120 ? 1 : depth < 400 ? lerp(1, 0.3, (depth - 120) / 280) : 0.3;
  const r = 100 * light;
  return glow ? Math.max(r, 65) : Math.max(r, 28);
}
// rotate unit vector a toward unit vector b by at most `step` radians (picks a horizontal side when b is dead astern)
function rotateToward(a, b, step) {
  const c = clamp(v3.dot(a, b), -1, 1), ang = Math.acos(c);
  if (ang <= step || ang < 1e-5) return [...b];
  let p = [b[0] - a[0] * c, b[1] - a[1] * c, b[2] - a[2] * c]; let pl = Math.hypot(...p);
  if (pl < 1e-5) { p = [a[2], 0, -a[0]]; pl = Math.hypot(...p) || 1; }
  p = [p[0] / pl, p[1] / pl, p[2] / pl];
  return v3.norm([a[0] * Math.cos(step) + p[0] * Math.sin(step), a[1] * Math.cos(step) + p[1] * Math.sin(step), a[2] * Math.cos(step) + p[2] * Math.sin(step)]);
}
// persistent swimmer: steers toward a target, or keeps its heading when released
class Swimmer {
  constructor() { this.pos = null; this.dir = [1, 0, 0]; this.speed = 1; }
  spawnAround(P, dist, dy = 0, band = [-1e9, -1]) {
    const a = Math.random() * 6.28;
    this.pos = [P[0] + Math.cos(a) * dist, clamp(P[1] + dy, band[0], band[1]), P[2] + Math.sin(a) * dist];
    this.dir = v3.norm([-Math.cos(a), 0, -Math.sin(a)]);
  }
  spawnAt(p, P) { this.pos = [...p]; this.dir = v3.norm([P[0] - p[0], 0, P[2] - p[2]]); }
  step(dt, target, speed, turn, avoid = null) {
    let want = target && v3.len(v3.sub(target, this.pos)) > 0.05 ? v3.norm(v3.sub(target, this.pos)) : null;
    if (avoid && v3.len(avoid) > 1e-3) want = v3.norm(v3.add(want || this.dir, v3.scale(avoid, 2.0)));
    if (want) {
      // rotate toward the wanted heading: exponential approach, but never faster than turnCap rad/s (a body has to swing round)
      const k = Math.max(turn, avoid && v3.len(avoid) > 0.05 ? 0.8 : 0);
      const c = clamp(v3.dot(this.dir, want), -1, 1), ang = Math.acos(c);
      const step = Math.min(ang * (1 - Math.exp(-dt * k)), (this.turnCap ?? 0.9) * dt);
      this.dir = rotateToward(this.dir, want, step);
    }
    this.speed = lerp(this.speed, speed, 1 - Math.exp(-dt * 0.8));
    this.pos = v3.add(this.pos, v3.scale(this.dir, this.speed * dt));
  }
}
// audible only near: full volume within `full` metres, silent beyond `cut`
const nearVol = (d, full, cut) => (d >= cut ? 0 : 1 - smooth(full, cut, d));
// physically plausible fish motion: velocity-driven, capped acceleration and turn rate, heading = velocity
function steer(vel, desired, dt, aMax, turnMax, vMin, vMax) {
  let ax = desired[0] - vel[0], ay = desired[1] - vel[1], az = desired[2] - vel[2];
  const al = Math.hypot(ax, ay, az), k = al > aMax * dt ? aMax * dt / al : 1;
  let nx = vel[0] + ax * k, ny = vel[1] + ay * k, nz = vel[2] + az * k;
  const s0 = Math.hypot(vel[0], vel[1], vel[2]) || 1e-6;
  let s1 = Math.hypot(nx, ny, nz) || 1e-6;
  // limit turning: angle between old and new heading ≤ turnMax*dt
  const c = (vel[0] * nx + vel[1] * ny + vel[2] * nz) / (s0 * s1), maxA = turnMax * dt;
  if (c < Math.cos(maxA)) {
    const ux = vel[0] / s0, uy = vel[1] / s0, uz = vel[2] / s0;
    let px = nx / s1 - ux * c, py = ny / s1 - uy * c, pz = nz / s1 - uz * c; const pl = Math.hypot(px, py, pz) || 1e-6;
    px /= pl; py /= pl; pz /= pl;
    nx = ux * Math.cos(maxA) + px * Math.sin(maxA); ny = uy * Math.cos(maxA) + py * Math.sin(maxA); nz = uz * Math.cos(maxA) + pz * Math.sin(maxA);
    nx *= s1; ny *= s1; nz *= s1;
  }
  s1 = Math.hypot(nx, ny, nz) || 1e-6;
  const sc = clamp(s1, vMin, vMax) / s1;
  vel[0] = nx * sc; vel[1] = ny * sc; vel[2] = nz * sc;
  return al;
}
// fast pelagic swimmer (tuna): never brakes by 'reversing' — speed follows thrust (aMax) / drag (decel) toward the
// desired speed, and the heading rotates toward the desired direction at most turnMax (rad/s); pitch kept shallow
function steerFish(vel, des, dt, aMax, turnMax, vMin, vMax, decel = 1.2) {
  const s0 = Math.hypot(vel[0], vel[1], vel[2]) || 1e-6, dl = Math.hypot(des[0], des[1], des[2]) || 1e-6;
  const f = [vel[0] / s0, vel[1] / s0, vel[2] / s0], g = [des[0] / dl, des[1] / dl, des[2] / dl];
  const c = clamp(f[0] * g[0] + f[1] * g[1] + f[2] * g[2], -1, 1), ang = Math.acos(c), maxA = turnMax * dt;
  let h = g;
  if (ang > maxA) {
    let p = [g[0] - f[0] * c, g[1] - f[1] * c, g[2] - f[2] * c]; let pl = Math.hypot(...p);
    if (pl < 1e-5) { p = [f[2], 0, -f[0]]; pl = Math.hypot(...p) || 1; }        // target dead astern: pick a side
    p = [p[0] / pl, p[1] / pl, p[2] / pl];
    h = [f[0] * Math.cos(maxA) + p[0] * Math.sin(maxA), f[1] * Math.cos(maxA) + p[1] * Math.sin(maxA), f[2] * Math.cos(maxA) + p[2] * Math.sin(maxA)];
  }
  // a hard turn bleeds speed (induced drag) but the fish keeps swimming
  const want = clamp(dl * (1 - 0.35 * clamp(ang / 1.5, 0, 1)), vMin, vMax);
  const s1 = s0 < want ? Math.min(want, s0 + aMax * dt) : Math.max(want, s0 - decel * dt);
  vel[0] = h[0] * s1; vel[1] = h[1] * s1; vel[2] = h[2] * s1;
}
// write an instance matrix (model +Z along vel, banked by roll) directly into a Float32Array (camera-relative)
function instMat(out, o, p, v, roll, scale, ph, spd) {
  const vl = Math.hypot(v[0], v[1], v[2]) || 1e-6;
  const fx = v[0] / vl, fy = v[1] / vl, fz = v[2] / vl;
  let rx = fz, rz = -fx; const rl = Math.hypot(rx, rz) || 1e-6; rx /= rl; rz /= rl;           // right = up × f (y-up)
  const ux = fy * rz, uy = fz * rx - fx * rz, uz = -fy * rx;                                   // up = f × right
  const cr = Math.cos(roll), sr = Math.sin(roll);
  const Rx = rx * cr + ux * sr, Ry = uy * sr, Rz = rz * cr + uz * sr;   // (right has no y component)
  const Ux = ux * cr - rx * sr, Uy = uy * cr, Uz = uz * cr - rz * sr;
  out[o] = Rx * scale; out[o + 1] = Ry * scale; out[o + 2] = Rz * scale; out[o + 3] = ph;
  out[o + 4] = Ux * scale; out[o + 5] = Uy * scale; out[o + 6] = Uz * scale; out[o + 7] = spd;
  out[o + 8] = fx * scale; out[o + 9] = fy * scale; out[o + 10] = fz * scale; out[o + 11] = 0;
  out[o + 12] = p[0] - ORIGIN[0]; out[o + 13] = p[1] - ORIGIN[1]; out[o + 14] = p[2] - ORIGIN[2]; out[o + 15] = 1;
}
// procedural cutlassfish (Trichiurus): long ribbon body, pointed head, whip tail, long dorsal fin; head at +Z
function cutlassMesh(R) {
  const L = 1.2, NZ = 36, NA = 8, pos = [], nrm = [], uv = [], idx = [];
  for (let i = 0; i <= NZ; i++) {
    const t = i / NZ, z = (t - 0.5) * L;                          // t: 0 tail tip .. 1 snout
    const body = t < 0.45 ? Math.pow(t / 0.45, 1.3) : t > 0.9 ? Math.pow((1 - t) / 0.1, 0.6) : 1;
    const h = 0.05 * body + 0.001, w = 0.012 * body + 0.0005;
    for (let j = 0; j < NA; j++) {
      const a = j / NA * Math.PI * 2, x = Math.cos(a) * w, y = Math.sin(a) * h;
      pos.push(x, y, z);
      const nx = x / (w * w), ny = y / (h * h), nl = Math.hypot(nx, ny) || 1;
      nrm.push(nx / nl, ny / nl, 0); uv.push(j / NA, t);
    }
  }
  for (let i = 0; i < NZ; i++) for (let j = 0; j < NA; j++) {
    const a = i * NA + j, b = i * NA + (j + 1) % NA, c = a + NA, d = b + NA; idx.push(a, c, b, b, c, d);
  }
  // long dorsal fin along the back (thin double-sided strip)
  const fb = pos.length / 3;
  for (let i = 0; i <= 24; i++) {
    const t = 0.18 + i / 24 * 0.68, z = (t - 0.5) * L, body = t < 0.45 ? Math.pow(t / 0.45, 1.3) : 1, h = 0.05 * body;
    pos.push(0, h, z, 0, h + 0.016 * body, z); nrm.push(1, 0, 0, 1, 0, 0); uv.push(0, t, 1, t);
  }
  for (let i = 0; i < 24; i++) { const a = fb + i * 2; idx.push(a, a + 1, a + 2, a + 1, a + 3, a + 2); }
  const gm = R.mesh({ pos: new Float32Array(pos), nrm: new Float32Array(nrm), uv: new Float32Array(uv), idx: new Uint32Array(idx) });
  const mat = R.material({ color: [0.97, 0.98, 1.0, 1], metal: 1.0, rough: 0.1 });   // guanine mirror: near-perfect silver reflector with a slight sheen blur
  return { gm, mat, L };
}
// head-up hovering fish: +Z (head) tilted from vertical by `tilt` toward `yaw`
function vertMat(out, o, p, yaw, tilt, roll, scale, ph, spd) {
  const st = Math.sin(tilt), ct = Math.cos(tilt);
  const f = [st * Math.sin(yaw), ct, st * Math.cos(yaw)];
  let r = [Math.cos(yaw + roll), 0, -Math.sin(yaw + roll)];
  const d = r[0] * f[0] + r[2] * f[2]; r = v3.norm([r[0] - f[0] * d, -f[1] * d, r[2] - f[2] * d]);
  const u = v3.cross(f, r);
  out.set([r[0] * scale, r[1] * scale, r[2] * scale, ph, u[0] * scale, u[1] * scale, u[2] * scale, spd, f[0] * scale, f[1] * scale, f[2] * scale, 0,
    p[0] - ORIGIN[0], p[1] - ORIGIN[1], p[2] - ORIGIN[2], 1], o);
}
// procedural sardine: slim silver body (~70 tris) + forked tail, head at +Z
function sardineMesh(R) {
  const L = 0.22, NZ = 9, NA = 8, pos = [], nrm = [], uv = [], idx = [];
  for (let i = 0; i <= NZ; i++) {
    const t = i / NZ, z = (t - 0.5) * L;
    const prof = Math.pow(Math.sin(Math.PI * Math.min(0.999, 0.08 + t * 0.9)), 0.75);
    const w = 0.014 * prof, h = 0.024 * prof;
    for (let j = 0; j < NA; j++) {
      const a = j / NA * Math.PI * 2, x = Math.cos(a) * w, y = Math.sin(a) * h;
      pos.push(x, y, z); const nl = Math.hypot(x / (w * w + 1e-6), y / (h * h + 1e-6)) || 1;
      nrm.push(x / (w * w + 1e-6) / nl, y / (h * h + 1e-6) / nl, 0); uv.push(j / NA, t);
    }
  }
  for (let i = 0; i < NZ; i++) for (let j = 0; j < NA; j++) {
    const a = i * NA + j, b = i * NA + (j + 1) % NA, c = a + NA, d = b + NA; idx.push(a, c, b, b, c, d);
  }
  // close the snout and the tail end (an open tube end reads as a gaping mouth)
  { const tip = pos.length / 3; pos.push(0, 0.0005, L / 2 + 0.004); nrm.push(0, 0, 1); uv.push(0.5, 1); const r0 = NZ * NA;
    for (let j = 0; j < NA; j++) idx.push(r0 + j, r0 + (j + 1) % NA, tip);
    const tl = pos.length / 3; pos.push(0, 0, -L / 2 - 0.002); nrm.push(0, 0, -1); uv.push(0.5, 0);
    for (let j = 0; j < NA; j++) idx.push((j + 1) % NA, j, tl); }
  const base = pos.length / 3, zt = -L / 2;   // forked caudal fin
  pos.push(0, 0, zt + 0.01, 0, 0.03, zt - 0.035, 0, 0.004, zt - 0.02, 0, -0.03, zt - 0.035); nrm.push(1, 0, 0, 1, 0, 0, 1, 0, 0, 1, 0, 0); uv.push(0, 0, 0, 0, 0, 0, 0, 0);
  idx.push(base, base + 1, base + 2, base, base + 2, base + 3);
  const gm = R.mesh({ pos: new Float32Array(pos), nrm: new Float32Array(nrm), uv: new Float32Array(uv), idx: new Uint32Array(idx) });
  const mat = R.material({ color: [0.8, 0.85, 0.9, 1], metal: 0.75, rough: 0.25 });
  return { gm, mat, L };
}
const yawDir = (a, pitch = 0) => [Math.sin(a) * Math.cos(pitch), Math.sin(pitch), Math.cos(a) * Math.cos(pitch)];

export class World {
  constructor(R, A, models) {
    this.R = R; this.A = A; this.rand = rng(7);
    // the dive boat's twin propellers are baked into the hull mesh: split those triangles into their own polished
    // silver (stainless/bronze-polished) part
    { const M = models.diveboat_hd, bi = M?.materials.findIndex((q) => q.name === 'Grand_Base');
      if (M && bi >= 0 && !M.materials.some((q) => q.name === 'Propeller_Silver')) {
        const pi = M.materials.length;
        M.materials.push({ ...M.materials[bi], name: 'Propeller_Silver', color: [0.93, 0.93, 0.95, 1], baseTex: null, mrTex: null, normalTex: null, metal: 1, rough: 0.22 });
        for (const prims of M.meshes) for (let q = prims.length - 1; q >= 0; q--) {
          const p = prims[q]; if (p.material !== bi) continue;
          const inProp = (t) => { let x = 0, y = 0, z = 0; for (let j = 0; j < 3; j++) { const v = p.idx[t * 3 + j] * 3; x += p.pos[v]; y += p.pos[v + 1]; z += p.pos[v + 2]; }
            x /= 3; y /= 3; z /= 3; return Math.abs(x) > 0.12 && Math.abs(x) < 1.15 && y > -1.4 && y < -0.42 && z > -5.85 && z < -5.15; };
          const keep = [], prop = [];
          for (let t = 0; t < p.idx.length / 3; t++) (inProp(t) ? prop : keep).push(p.idx[t * 3], p.idx[t * 3 + 1], p.idx[t * 3 + 2]);
          if (!prop.length) continue;
          p.idx = new Uint32Array(keep);
          prims.push({ ...p, idx: new Uint32Array(prop), material: pi });
        }
      } }
    const P = (name, cfg) => prepare(R, models[name], cfg);
    this.sp = {
      barra: P('reef_fish_barramundi', { len: 0.62, fwd: '+z', maxTex: 512 }),
      king: P('kingfish13', { len: 0.85, fwd: '+z', maxTex: 1024 }),   // yellowtail amberjack (Seriola lalandi), realistic PBR, replaces the low-poly kingfish
      shark: P('shark_rt', { raw: true, anim: 'Swim', maxTex: 1024 }),   // 'Animated Swimming Great White Shark Loop' by LasquetiSpice (CC-BY 4.0, modified)
      manta: P('manta_ray', { len: 4.5, fwd: '+z', anim: 'Swim', lenAxis: 0 }),   // giant oceanic manta wingspan
      turtle: P('turtle_scan', { len: 1.2, fwd: '+z', anim: 'Swim', matByName: { Retop_Material: { glossMap: true, rough: 0.9, metal: 0, coat: 0.3 } } }),   // source stores a GLOSS map in the roughness slot -> inverted; wet skin/scute sheen as a clear coat
      angler: P('angler', { len: 0.8, fwd: '+z', anim: 'Swimming_Normal' }),
      goblin: P('goblin_shark', { len: 3.2, fwd: '+z', anim: 'Swimming_Normal' }),
      squid: P('squid', { raw: true, maxTex: 2048 }),   // 10 m giant squid: mantle tip +Z, arms/tentacles trailing -Z
      grenadier: P('deepfish', { len: 1.0, fwd: '+z', maxTex: 2048 }),   // abyssal rattail scan (Coryphaenoides), 1 m
      crab: P('crab_scan', { len: 1.07, fwd: '+z', anim: 'Walk', lenAxis: 0, ground: true, mat: { rough: 0.55 } }),
      crabStatic: P('crab_scan', { len: 1.07, fwd: '+z', anim: 'Walk', lenAxis: 0, ground: true, mat: { rough: 0.55 }, forceStatic: true }),   // rest pose, instanced in crab heaps
      crabscan: P('crab_king_scan', { len: 0.32, fwd: '+z', ground: true, maxTex: 512, lenAxis: 0 }),
      boat: P('diveboat_hd', { raw: true, maxTex: 2048, matByName: { Grand_Base: { coat: 0.08 },   // matte gelcoat (was a glossy clear coat)
        Propeller_Silver: { coat: 0.0 }, Grand_Wood_01: { coat: 0.35, rough: 0.55 }, Grand_Wood_02: { coat: 0.35, rough: 0.6 }, Teak_Deck: { coat: 0.0 } } }),
      sunfish: P('sunfish', { len: 2.0, fwd: '+z', anim: 'Swim' }),
      tuna: P('tuna', { len: 2.0, fwd: '+z', forceStatic: true, closeMouth: 0.78, mat: { metal: 0.65, rough: 0.16, coat: 0.7 } }),   // bluefin: mirror-bright metallic back + wet clear-coat sheen
      dolphin: P('dolphin', { len: 2.6, fwd: '+z', anim: 'Swim', matByName: { DolphinBody: { mrTex: null, rough: 0.55, metal: 0 } } }),   // satin wet skin, not polished
      humpback: P('humpback', { raw: true, scale: 31 / 13.87, anim: 'Swim', maxTex: 1024, mat: { rough: 0.3, normalScale: 0.45 } }),   // large adult: 15.5 m   // 'Game-ready Humpback Whale' by Allie2k (CC-BY 4.0, rigged/modified)
      rocks: P('rocks_a', { len: 3.0, fwd: '+z', ground: true, lenAxis: 0 }),
    };
    this.walkAnim = this.sp.crab.anim;
    this.idleAnim = models.crab_scan.anims.findIndex((a) => /idle/i.test(a.name));
    this.fastAnim = -1;
    this.draws = [];
    // ---- boat ----
    this.boat = new Creature(R, this.sp.boat, {});
    // diver spawn (aft dive deck, eye height) and entry point (edge of the swim platform), boat-local
    const nodePos = (name) => { const i = this.sp.boat.model.nodes.findIndex((n) => n.name === name); const g = this.sp.boat.gpu.globals[i]; return g ? [g[12], g[13], g[14]] : null; };
    this.spawnLocal = nodePos('spawn_diver') || [0, 2.562, -5.629];
    this.entryLocal = nodePos('entry_point') || [0, 0.116, -7.469];
    this.spawnLocal = [this.spawnLocal[0], this.spawnLocal[1] - 1.65 + 1.65 / BOAT_S, this.spawnLocal[2]];   // eye 1.65 m above the deck in world metres
    this.deckSpot = this.spawnLocal;
    this.entryCurve = this.buildEntryCurve();
    this.buildWalkMap();
    // ---- surface & floor ----
    this.surface = { pipe: 'surface', grid: R.grid(220, 1600, 2.8), obj: R.object(), visible: true };
    this.boatFoot = [0, 0.1, 7.3, 2.3, 0];
    R.foam.setRadii(hullRadii(this.sp.boat.model, 0.02));
    this.hullProbes = [[0, 7.3], [0, -7.3], [2.3, 0], [-2.3, 0]];   // bow, stern, port, starboard   // hull footprint for surface foam: x, z, half length, half beam, yaw
    this.floor = { pipe: 'floor', grid: R.grid(140, 70, 1), obj: R.object(), visible: false };   // uniform 1 m cells, snapped: vertices never swim; only as far as anything can light it (torch fades out by 65 m)
    // ---- schools (instanced) ----
    this.schools = [
      this.makeSchool(this.sp.barra, 140, 5.5, [18, -14, -10], 0.9),
      this.makeSchool(this.sp.barra, 90, 4.0, [-16, -30, 14], 1.1),
      this.makeSchool(this.sp.king, 220, 6.5, [6, -45, 22], 1.4),
    ];
    // ---- bluefin tuna school (fast, 10–100 m) ----
    const tuna = this.makeSchool(this.sp.tuna, 24, 6.0, [30, -40, -20], 0.8);
    // 2 m, ~150 kg: strong thrust along the body but a wide turning circle (≈ 0.8 rad/s cruising, 1.6 rad/s in a strike)
    Object.assign(tuna, { band: [-100, -8], onDepth: 120, speed: 6.0, range: 1.6, avoid: 3.0, shadow: false, predator: true, aMax: 3.2, turnMax: 0.8, turnHunt: 1.6, vMax: 9, slotK: 0.3, len: 2.0 });
    tuna.obj.forEach((o) => { o.data.set([0.03, 9.0, 3.5, 0], 16); });   // thunniform: stiff body, small fast tail sweep
    this.schools.push(tuna);
    // ---- dolphin pod (0–40 m) & ocean sunfish (2–60 m) ----
    this.dolphins = [...Array(5)].map((_, i) => ({ c: new Creature(R, this.sp.dolphin, { sss: 0.15 }), i, pos: null, off: [(i - 2) * 2.4, (i % 2) * 1.2, (i % 3) * 2.0 - 2], ph: i * 1.3 }));
    this.pod = { ang: 0, r: 16, dash: 20, dashing: 0, dir: [1, 0, 0], pos: null, clickT: 3 };
    this.sunfish = { c: new Creature(R, this.sp.sunfish, { sss: 0.3 }), pos: null, dir: [1, 0, 0], t: 0 };
    this.whale = { c: new Creature(R, this.sp.humpback, { sss: 0.1 }), sw: null, wait: 12, callT: 8 };
    {
      // body flex for the surface show: the spine really bends (tail stock arches up, head tucks down) instead of the
      // whole whale pitching like a plank.  bendV = [chest, spine1, spine2, spine3, tail, flukes], radians about the
      // bones' lateral axis (+ = tail up / head down)
      const W = this.whale, M = models.humpback, ids = ['Chest', 'Spine1', 'Spine2', 'Spine3', 'Tail', 'Flukes'].map((n) => M.nodes.findIndex((x) => x.name === n));
      W.bendV = [0, 0, 0, 0, 0, 0]; W.flukeNode = ids[5]; W.tailNode = ids[4];
      const qx = (r, a) => { const h = a * 0.5, sx = Math.sin(h), cw = Math.cos(h); return [r[3] * sx + r[0] * cw, r[1] * cw + r[2] * sx, r[2] * cw - r[1] * sx, r[3] * cw - r[0] * sx]; };
      W.c.bend = (pose) => { ids.forEach((id, k) => { if (id >= 0 && Math.abs(W.bendV[k]) > 1e-4) pose.local[id].r = qx(pose.local[id].r, W.bendV[k]); }); };
    }
    // ---- EVENT: sardine murmuration / bait ball (~3500 fish, instanced, physically steered) ----
    const sm = sardineMesh(R), SN = 3500;
    this.swarm = { n: SN, mesh: sm, active: false, pos: new Float32Array(SN * 3), vel: new Float32Array(SN * 3), roll: new Float32Array(SN), ph: new Float32Array(SN),
      inst: new Float32Array(SN * 16), obj: R.object(SN * 64), center: null, t: 0, count: 0 };
    this.swarm.obj.data.set([0.12, 14.0, 6.0, 0], 16);                 // swim deform: amp, freq, wave
    this.swarm.obj.data.set([1, 1, 1, 1], 20);
    this.swarm.obj.data.set([0, 0.2, 0, 1], 24);                       // extra.w = countershading (dark back, silver belly)
    this.swarm.obj.data.set([sm.L / 2, sm.L, 0, 0], 28);
    for (let i = 0; i < SN; i++) this.swarm.ph[i] = Math.random() * 6.28;
    // ---- EVENT: manta squadron ----
    this.squad = { mantas: [...Array(8)].map((_, i) => ({ c: new Creature(R, this.sp.manta, { sss: 0.2 }), vel: [1.5, 0, 0], pos: null, slot: [((i + 1) >> 1) * (i % 2 ? -3.2 : 3.2), -((i + 1) >> 1) * 0.6, -((i + 1) >> 1) * 3.8], anim: 0.7 + Math.random() * 0.3 })), active: false, lead: null };
    this.events = {};
    // ---- cutlassfish groups hovering head-up, mirror-silver: a loose group and a dense swaying 'forest' ----
    const cm0 = cutlassMesh(R);
    const mkGroup = (n, zone, spread, tilt, swayAmp, sync) => {
      const g = { n, zone, spread, swayAmp, sync, mesh: cm0, obj: R.object(n * 64), inst: new Float32Array(n * 16), center: null,
        fish: [...Array(n)].map(() => ({ p: null, yaw: Math.random() * 6.28, tilt: tilt[0] + Math.random() * (tilt[1] - tilt[0]), ph: Math.random() * 6.28, sc: sizeVar(0.16),
          off: [(Math.random() - 0.5) * spread[0], (Math.random() - 0.5) * spread[1], (Math.random() - 0.5) * spread[0]], v: [0, 0, 0] })) };
      g.obj.data.set([0.035, 3.0, 7.0, 0], 16); g.obj.data.set([1, 1, 1, 1], 20); g.obj.data.set([0, 0, 0, 0], 24); g.obj.data.set([cm0.L / 2, cm0.L, 0, 0], 28);
      return g;
    };
    this.cutlassGroups = [
      mkGroup(28, [25, 70], [12, 7], [0.03, 0.14], 0.05, 0.3),       // loose group (sunlit water)
      mkGroup(64, [60, 115], [8, 5], [0.0, 0.06], 0.07, 1.0),        // dense forest: near-vertical, swaying in unison as a slow wave
    ];
    this.cutlass = this.cutlassGroups[0];
    // ---- creatures ----
    this.manta = { c: new Creature(R, this.sp.manta, { sss: 0.2 }), ang: 0, r: 16 };
    this.sharks = [0, 1, 2].map((i) => ({ c: new Creature(R, this.sp.shark, { sss: 0.08 }), i, pos: [30 + i * 10, -120, 0], dir: [1, 0, 0], mode: 'circle', timer: 6 + i * 7, ang: i * 2.1, r: 15 + i * 4, dy: (i - 1) * 3, passed: false, speed: 1.0 }));
    this.turtle = { c: new Creature(R, this.sp.turtle, { sss: 0.15 }), active: false, wait: 5, t: 0 };
    this.TURTLE_SCALE = 60 / 1.2;                                 // scan is normalised to 1.2 m -> 60 m colossus
    this.TURTLE_ANIM = 0.3;                                       // real swim clip slowed for the giant (~8.5 s per stroke)
    this.push = [0, 0, 0];
    this.anglers = [0, 1, 2, 3].map((i) => ({ c: new Creature(R, this.sp.angler, { sss: 0.3 }), pos: [0, 0, 0], ang: i * 1.6, r: 7 + i * 3.5, dy: (i % 2 ? 2 : -2.5), sp: 0.35 + i * 0.05 }));
    this.goblin = { c: new Creature(R, this.sp.goblin, { sss: 0.35, tint: [1.0, 0.85, 0.85, 1] }), ang: 0, r: 13 };
    // scanned deep-sea specimens (raw9): mid-water swimmers and floor dwellers
    const SPEC = [
      { key: 'neoscopelid', len: 0.2, n: 6, band: [200, 1100], mode: 'swim', speed: 0.35, swim: [0.1, 9, 5, 0] },
      { key: 'gulper_eel', len: 1.0, n: 2, band: [500, 3000], mode: 'swim', speed: 0.25, swim: [0.14, 2.2, 6, 0.02], glow: [0, 0.024, -0.375], glowCol: [0.9, 0.2, 0.35] },
      { key: 'sea_toad', len: 0.35, n: 3, band: [3800, 4100], mode: 'floor', speed: 0.08, swim: [0.03, 3, 3, 0] },
      { key: 'greeneye', len: 0.25, n: 4, band: [3800, 4100], mode: 'hover', speed: 0.2, swim: [0.08, 6, 4, 0] },
      { key: 'armored_searobin', len: 0.3, n: 3, band: [3800, 4100], mode: 'floor', speed: 0.12, swim: [0.05, 5, 4, 0] },
      { key: 'giant_isopod', len: 0.35, n: 2, band: [3800, 4100], mode: 'floor', speed: 0.0, swim: [0, 0, 0, 0] },
      { key: 'spurdog', len: 1.0, n: 5, band: [150, 1000], mode: 'swim', speed: 0.55, swim: [0.07, 2.6, 3.2, 0], tint: [0.4, 0.4, 0.43, 1], flip: true, mat: { rough: 1.35 } },   // live grey-brown; model head is at -Z                 // deep-water dogfish, cruising in a loose pack
      { key: 'swell_shark', len: 0.8, n: 3, band: [3800, 4100], mode: 'hover', speed: 0.15, swim: [0.09, 2.0, 3.0, 0], tint: [0.6, 0.58, 0.55, 1], flip: true, mat: { rough: 1.35 } },
    ];
    this.specimens = SPEC.flatMap((sd) => {
      const L0 = { neoscopelid: 0.2, gulper_eel: 0.75, sea_toad: 0.25, greeneye: 0.18, armored_searobin: 0.22, giant_isopod: 0.3, spurdog: 1.0, swell_shark: 0.4 }[sd.key];
      sd.scale = sd.len / L0;                                  // static meshes: scale goes into the world matrix
      const sp = prepare(R, models['r9_' + sd.key], { raw: true, maxTex: 1024, mat: sd.mat });
      return [...Array(sd.n)].map((_, i) => {
        const c = new Creature(R, sp, { sss: 0.25, bounds: sd.flip ? [-L0 / 2, -L0, 0, 0] : [L0 / 2, L0, 0, 0], tint: sd.tint });   // flip: negative length = head at -Z for the swim wave   // swim deform runs in model units
        for (const o of c.objs) o.data.set(sd.swim, 16);
        return { sd, c, sw: null, i, t: Math.random() * 5, rest: 0 };
      });
    });
    // megalodon (Otodus megalodon, ~16 m): reconstructed as a stockier, darker great white (same rigged model scaled up)
    // 'Megalodon' by phonlaphat (CC-BY 4.0), rigged here: 20 m, head at +Z, clips Swim + Gape (jaw drops, teeth bared), serrated teeth
    this.sp.megalodon = prepare(R, models.r9_megalodon, { raw: true, maxTex: 2048, anim: 'Swim' });
    this.mega = { c: new Creature(R, this.sp.megalodon, { sss: 0.05 }), active: false, wait: 60, t: 0 };
    {
      const M = models.r9_megalodon, hi = M.nodes.findIndex((n) => n.name === 'head');
      this.mega.gape = M.anims.findIndex((a) => a.name.endsWith('Gape'));
      this.mega.c.blend = { index: this.mega.gape, w: 0 };   // (kept at 0: the jaw is posed directly, see jawAng)
      // eyes ride on the head bone: eye (model space) -> head-bone space, re-posed every frame
      const pz = this.mega.c.pose; pz.reset(); pz.update(this.sp.megalodon.pre);
      this.mega.headNode = hi;
      // eye opening (between the sculpted lids, ~15 cm tall) at (±1.03, -0.53, 8.59), socket facing (±0.84, 0.29, 0.46):
      // the eyeball sits 4.5 cm back inside the lids, its rest gaze along the socket axis
      const inv = m4.invert(pz.global[hi]);
      this.mega.eyeHead = [1, -1].map((sx) => { const n = v3.norm([sx * 0.84, 0.29, 0.46]); return m4.xform(inv, v3.sub([sx * 1.03, -0.53, 8.59], v3.scale(n, 0.045))); });
      this.mega.eyeRestHead = [1, -1].map((sx) => v3.norm(m4.xdir(inv, v3.norm([sx * 0.84, 0.29, 0.46]))));
      // the jaw is driven procedurally (slow, deliberate), not by the looping Gape clip
      const ji = M.nodes.findIndex((n) => n.name === 'jaw'); this.mega.jawNode = ji; this.mega.jawAng = 0;
      const qx = (r, a) => { const h = a * 0.5, sx = Math.sin(h), cw = Math.cos(h); return [r[3] * sx + r[0] * cw, r[1] * cw + r[2] * sx, r[2] * cw - r[1] * sx, r[3] * cw - r[0] * sx]; };
      this.mega.c.bend = (pose) => { if (ji >= 0 && this.mega.jawAng > 1e-3) pose.local[ji].r = qx(pose.local[ji].r, this.mega.jawAng); };
    }
    // megalodon eyeballs: separate glossy spheres (iris + pupil painted procedurally) that roll to follow the diver
    {
      const S = 18, Rg = 14, pos = [], nrm = [], uv = [], idx = [];
      for (let j = 0; j <= Rg; j++) for (let i = 0; i <= S; i++) {
        const th = j / Rg * Math.PI, ph = i / S * Math.PI * 2, n = [Math.sin(th) * Math.cos(ph), Math.sin(th) * Math.sin(ph), Math.cos(th)];
        pos.push(...n); nrm.push(...n); uv.push(i / S, j / Rg);                     // v = 0 at the front pole (+Z) = pupil
      }
      for (let j = 0; j < Rg; j++) for (let i = 0; i < S; i++) { const a = j * (S + 1) + i, b = a + S + 1; idx.push(a, b, a + 1, a + 1, b, b + 1); }
      const cv = new OffscreenCanvas(64, 256), g = cv.getContext('2d');
      const grd = g.createLinearGradient(0, 0, 0, 256);
      grd.addColorStop(0, '#020203'); grd.addColorStop(0.16, '#040506');            // pupil
      grd.addColorStop(0.19, '#23303a'); grd.addColorStop(0.3, '#3a4a55');           // steel-blue iris
      grd.addColorStop(0.34, '#12171b'); grd.addColorStop(1, '#0b0d0f');             // dark sclera
      g.fillStyle = grd; g.fillRect(0, 0, 64, 256);
      this.megaEye = { gm: R.mesh({ pos: new Float32Array(pos), nrm: new Float32Array(nrm), uv: new Float32Array(uv), idx: new Uint32Array(idx) }),
        mat: R.material({ color: [0.8, 0.8, 0.8, 1], baseTex: cv, rough: 0.38, metal: 0 }), objs: [R.object(), R.object()], look: [null, null] };   // wet but not mirror-like
    }
    // giant squid: one slow, close pass out of the dark (600–1300 m); arms and tentacles ripple behind the mantle
    this.squid = { c: new Creature(R, this.sp.squid, { sss: 0.35, tint: [1.3, 0.78, 0.72, 1], bounds: [5.0, 10.0, 0, 0] }), active: false, wait: 25, t: 0 };
    for (const o of this.squid.c.objs) o.data.set([-1, 0, 3.2, 0], 16);   // swim.x < 0: squid deformation (jet mantle, fins, writhing arms)
    // abyssal grenadiers (rattails): hover head-down just above the floor, long tail sculling slowly
    this.grenadiers = [0, 1, 2, 3].map((i) => {
      const c = new Creature(R, this.sp.grenadier, { sss: 0.15, bounds: [0.5, 1.0, 0, 0] });
      for (const o of c.objs) o.data.set([0.07, 4.2 + i * 0.3, 5.0, 0], 16);
      return { c, sw: null, sc: 0.85 + i * 0.12, ph: i * 1.7, tgt: null, retarget: 0 };
    });
    this.lureLocal = this.findLure(models.angler);
    this.crabs = [...Array(14)].map((_, i) => ({ c: new Creature(R, this.sp.crab, { sss: 0.2 }), pos: null, heading: 0, speed: 0.22, walk: true, timer: 2 + i }));
    // floor props (instanced)
    this.props = [
      { sp: this.sp.crabscan, obj: null, max: 24 },
      { sp: this.sp.rocks, obj: null, max: 40 },
    ].map((p) => ({ ...p, objs: p.sp.gpu.prims.map(() => { const o = R.object(p.max * 64); return o; }), inst: new Float32Array(p.max * 16), count: 0 }));
    this.floorLife = new FloorLife(R, this, floorH, FLOOR_DEPTH);
    this.deepLife = new DeepLife(R, this);
    // ---- jellies ----
    this.initJelly();
    // ---- particles ----
    this.snow = this.makeFx(42000, [26, 26, 26], [0.0, -0.035, 0.012], [0.9, 0.95, 1.0], 0.0022, 0, 1.3);
    this.sand = this.makeFx(7000, [30, 30, 30], [0.55, 0.0, 0.18], [1.0, 0.85, 0.65], 0.006, 1, 1.4);
    const PBN = 8000;   // bubble plumes (splash-entrained air): typed arrays, no per-bubble objects
    this.pb = { N: PBN, n: 0, p: new Float32Array(PBN * 3), v: new Float32Array(PBN * 3), r: new Float32Array(PBN), age: new Float32Array(PBN), k: new Int16Array(PBN) };
    this.plumes = []; this.bubSurf = [];
    this.bubbleMax = 1400 + PBN;
    this.bubbleData = new Float32Array(this.bubbleMax * 4);
    this.bubbles = [];
    this.bub = this.makeFx(this.bubbleMax, [1, 1, 1], [0, 0, 0], [1, 1, 1], 0.004, 2, 1.0, true);
    this.sprayMax = 24000; this.spray = [];
    // lobtail spray: simulated on the GPU (js/spray.js) into the same instance buffer, after the CPU spray slots;
    // a 1-in-40 CPU proxy set (typed arrays) tracks landings for the drop sounds and the surface foam
    const GN = 400000, BN = 16000;
    this.bulk = { N: BN, n: 0, p: new Float32Array(BN * 3), v: new Float32Array(BN * 3), r: new Float32Array(BN), age: new Float32Array(BN), s: new Float32Array(BN), dr: new Float32Array(BN) };
    this.sprayData = new Float32Array(this.sprayMax * 8); this.sprayZero = new Float32Array(this.sprayMax * 8); this.sprayHi = 0;
    { const o = R.object((this.sprayMax + GN) * 32); o.data.set([1, 1, 1, 0, 0, 0, 0, 0, 1, 1, 1, 1, 1, 0, 4, 1.0]); this.sprayFx = { obj: o, count: 0, max: this.sprayMax + GN };
      this.gpuSpray = new GpuSpray(R, o.sb, this.sprayMax, GN); this.proxyK = 0; }
    this.ripples = [];
    this.fx = [this.snow, this.sand, this.floorLife.dustFx, this.sprayFx];   // bubbles are drawn by their own shader (this.bub)
    this.breathT = 0;
    this.viewer = null;
  }

  findLure(model) {
    const mi = model.materials.findIndex((m) => /lure|light|bulb|glow/i.test(m.name));
    if (mi < 0) return [0, 0.25, 0.5];
    // lure centre in normalised space (rest pose)
    const sp = this.sp.angler; const pose = new Pose(model); if (sp.anim >= 0) pose.sample(sp.anim, 0); pose.update(sp.pre);
    let acc = [0, 0, 0], n = 0;
    model.nodes.forEach((nd) => {
      if (nd.mesh === undefined) return;
      for (const p of model.meshes[nd.mesh]) {
        if (!p.joints) continue;
        const idx = new Set(); // vertices used by lure material primitive
        if (p.material !== mi) continue;
        for (let i = 0; i < p.pos.length / 3; i++) {
          const v = [p.pos[i * 3], p.pos[i * 3 + 1], p.pos[i * 3 + 2]]; let o = [0, 0, 0];
          for (let k = 0; k < 4; k++) { const w = p.weights[i * 4 + k]; if (!w) continue; const j = p.joints[i * 4 + k]; o = v3.add(o, v3.scale(m4.xform(pose.jointMats[nd.skin].subarray(j * 16, j * 16 + 16), v), w)); }
          acc = v3.add(acc, o); n++;
        }
      }
    });
    this.lureMat = mi;
    return n ? v3.scale(acc, 1 / n) : [0, 0.25, 0.5];
  }

  makeSchool(sp, n, radius, home, speedScale) {
    const r = this.rand;
    const obj = sp.gpu.prims.map(() => { const o = this.R.object(n * 64); o.data.set([0.09, 7.5 * speedScale, 5.5, 0], 16); o.data.set([sp.size[2] / 2, sp.size[2], 0, 0], 28); o.data.set([0, 0.25, 0, 0], 24); o.data.set(sp.pre ? m4.ident() : m4.ident(), 0); return o; });
    const cohort = 0.7 + r() * 0.7;                          // fish school with others of their year class: schools differ, members are similar
    const members = [...Array(n)].map(() => {
      const a = r() * Math.PI * 2, rr = Math.cbrt(r()) * radius;
      return { off: [Math.cos(a) * rr, (r() - 0.5) * radius * 0.5, Math.sin(a) * rr * 1.6], ph: r() * 6.28, spd: 0.8 + r() * 0.5, sc: cohort * sizeVar(0.11), cur: null, wob: r() * 100 };
    });
    return { sp, n, radius, center: [...home], home, vel: [0.8, 0, 0], heading: [1, 0, 0], members, obj, inst: new Float32Array(n * 16), target: [...home], retarget: 0, count: 0, band: [-85, -3.5], onDepth: 95, speed: 1.3, range: 1, avoid: 4.5, shadow: true };
  }

  makeFx(count, box, drift, color, size, mode, bright, storage = false) {
    const o = this.R.object(storage ? this.bubbleMax * 16 : 0);
    o.data.set([box[0], box[1], box[2], 0, drift[0], drift[1], drift[2], 0, color[0], color[1], color[2], 1, size, count, mode, bright]);
    return { obj: o, count, max: count };
  }

  initJelly() {
    const verts = [], idx = [];
    const add = (a) => { verts.push(...a); return verts.length / 4 - 1; };
    const S = 28, Rg = 12;
    for (const kind of [0, 1]) {
      const base = verts.length / 4;
      for (let j = 0; j <= Rg; j++) for (let i = 0; i <= S; i++) add([i / S * Math.PI * 2, j / Rg, kind, 0]);
      for (let j = 0; j < Rg; j++) for (let i = 0; i < S; i++) {
        const a = base + j * (S + 1) + i, b = a + 1, c = a + S + 1, d = c + 1; idx.push(a, c, b, b, c, d);
      }
    }
    const strip = (ang, kind, segs) => {
      const base = verts.length / 4;
      for (let s = 0; s <= segs; s++) { add([ang, s / segs, kind, -1]); add([ang, s / segs, kind, 1]); }
      for (let s = 0; s < segs; s++) { const a = base + s * 2; idx.push(a, a + 1, a + 2, a + 1, a + 3, a + 2); }
    };
    for (let k = 0; k < 20; k++) strip(k / 20 * Math.PI * 2, 2, 22);
    for (let k = 0; k < 4; k++) strip(k / 4 * Math.PI * 2 + 0.4, 3, 12);
    const R = this.R, GU = GPUBufferUsage;
    const vb = R.buf(verts.length * 4, GU.VERTEX | GU.COPY_DST, new Float32Array(verts));
    const ib = R.buf(idx.length * 4, GU.INDEX | GU.COPY_DST, new Uint32Array(idx));
    this.jMax = 40;
    const sb = R.buf(this.jMax * 48, GU.STORAGE | GU.COPY_DST);
    const bg = R.device.createBindGroup({ layout: R.jellyLayout, entries: [{ binding: 0, resource: { buffer: sb } }] });
    this.jData = new Float32Array(this.jMax * 12);
    this.jellies = [...Array(this.jMax)].map(() => null);
    this.jelly = { vb, ib, indexCount: idx.length, sb, bg, count: 0 };
  }

  floorHeight(x, z) { return floorH(x, z); }
  // hull buoyancy from the FFT sea: probe heights at bow, stern, port, starboard (smoothed = hull inertia)
  // eye-height curve for the stern entry, clearing the real rail/transom geometry (sampled from the boat mesh)
  buildEntryCurve() {
    const m = this.sp.boat.model, G = this.sp.boat.gpu.globals, a = this.spawnLocal, e = this.entryLocal;
    const z0 = a[2], z1 = e[2] + 0.3, N = 120, top = new Float32Array(N + 1).fill(-1e9);
    const xmin = Math.min(a[0], e[0]) - 0.45, xmax = Math.max(a[0], e[0]) + 0.45;
    m.nodes.forEach((nd, ni) => {
      if (nd.mesh === undefined) return;
      const M = G[ni];
      for (const p of m.meshes[nd.mesh]) for (let i = 0; i < p.pos.length / 3; i++) {
        const x0 = p.pos[i * 3], y0 = p.pos[i * 3 + 1], zz = p.pos[i * 3 + 2];
        const x = M[0] * x0 + M[4] * y0 + M[8] * zz + M[12], y = M[1] * x0 + M[5] * y0 + M[9] * zz + M[13], z = M[2] * x0 + M[6] * y0 + M[10] * zz + M[14];
        if (x < xmin || x > xmax || y < 0.95 || y > 2.6) continue;          // above the deck, below the flybridge overhang
        const k = (z - z0) / (z1 - z0);
        if (k < -0.02 || k > 1.02) continue;
        const j = Math.round(clamp(k, 0, 1) * N); top[j] = Math.max(top[j], y);
      }
    });
    // head must clear obstacles by 0.45 m (+ body width window), then smooth the envelope
    const need = new Float32Array(N + 1);
    for (let j = 0; j <= N; j++) { let mx = -1e9; for (let w = -8; w <= 8; w++) { const q = j + w; if (q >= 0 && q <= N) mx = Math.max(mx, top[q]); } need[j] = mx > -1e8 ? mx + 0.45 : -1e9; }
    const eye = 1.65 / BOAT_S, curve = new Float32Array(N + 1);
    for (let j = 0; j <= N; j++) {
      const k = j / N, base = lerp(a[1], e[1] + eye, smooth(0.45, 0.9, k));
      curve[j] = Math.max(base, need[j]);
    }
    for (let it = 0; it < 6; it++) for (let j = 1; j < N; j++) curve[j] = Math.max(curve[j], (curve[j - 1] + curve[j + 1]) / 2);   // round the corners
    this.entryTop = Math.max(...Array.from(top).filter((v) => v > -1e8));
    return (k) => { const f = clamp(k, 0, 1) * N, j = Math.floor(f), t = f - j; return lerp(curve[j], curve[Math.min(j + 1, N)], t); };
  }
  // walkable boat (all decks + stairs): a layered height map.  Per 0.1 m cell and 0.1 m height bin: 'floor' where an
  // upward-facing surface is, 'wall' where steep geometry (bulkheads, rails, stair stringers) is, 'solid' for anything.
  // You stand on the nearest floor within a step (±0.4 m) of your feet, need head room above it and a body's width of
  // clear space at body height around you -- so stairs are climbed tread by tread and the flybridge is reachable.
  buildWalkMap() {
    const m = this.sp.boat.model, G = this.sp.boat.gpu.globals, C = 0.1, X0 = -2.6, Z0 = -7.9, NX = 52, NZ = 158, Y0 = -1.3, NB = 72;
    const floor = new Uint8Array(NX * NZ * NB), wall = new Uint8Array(NX * NZ * NB), solid = new Uint8Array(NX * NZ * NB);
    const deck = this.spawnLocal[1] - 1.65 / BOAT_S;
    m.nodes.forEach((nd, ni) => {
      if (nd.mesh === undefined) return;
      const M = G[ni];
      const T = (P, i) => { const x0 = P[i * 3], y0 = P[i * 3 + 1], zz = P[i * 3 + 2]; return [M[0] * x0 + M[4] * y0 + M[8] * zz + M[12], M[1] * x0 + M[5] * y0 + M[9] * zz + M[13], M[2] * x0 + M[6] * y0 + M[10] * zz + M[14]]; };
      for (const p of m.meshes[nd.mesh]) {
        const I = p.idx, P = p.pos, nt = I.length / 3;
        for (let t = 0; t < nt; t++) {
          const a = T(P, I[t * 3]), b = T(P, I[t * 3 + 1]), c = T(P, I[t * 3 + 2]);
          if (Math.max(a[1], b[1], c[1]) < deck - 0.6 || Math.min(a[1], b[1], c[1]) > Y0 + NB * 0.1) continue;
          const nrm = v3.cross(v3.sub(b, a), v3.sub(c, a)), nl = v3.len(nrm); if (nl < 1e-9) continue;
          const up = Math.abs(nrm[1] / nl) > 0.7;
          const e = Math.max(v3.dist(a, b), v3.dist(b, c), v3.dist(c, a));
          const n = Math.min(300, Math.max(1, Math.ceil(e / (C * 0.5))));
          for (let i = 0; i <= n; i++) for (let j = 0; j <= n - i; j++) {
            const u = i / n, v = j / n, w = 1 - u - v;
            const x = a[0] * w + b[0] * u + c[0] * v, y = a[1] * w + b[1] * u + c[1] * v, z = a[2] * w + b[2] * u + c[2] * v;
            const ix = Math.floor((x - X0) / C), iz = Math.floor((z - Z0) / C), ib = Math.floor((y - Y0) / 0.1);
            if (ix < 0 || iz < 0 || ix >= NX || iz >= NZ || ib < 0 || ib >= NB) continue;
            const k = (iz * NX + ix) * NB + ib;
            solid[k] = 1; if (up) floor[k] = 1; else wall[k] = 1;
          }
        }
      }
    });
    this.walk = { C, X0, Z0, NX, NZ, Y0, NB, floor, wall, solid, deck };
  }
  // try to stand at (x, z) with feet near height h: returns the floor height there, or null if you can't
  walkStep(x, z, h) {
    const W = this.walk; if (!W) return null;
    const ix = Math.floor((x - W.X0) / W.C), iz = Math.floor((z - W.Z0) / W.C);
    if (ix < 2 || iz < 2 || ix >= W.NX - 2 || iz >= W.NZ - 2) return null;
    const hb = Math.floor((h - W.Y0) / 0.1), base = (iz * W.NX + ix) * W.NB;
    // candidate floors: tops of every floor slab within a step (-0.45 .. +0.45 m); try the highest first, so walking
    // into a stair puts you on the next tread rather than on the deck underneath it
    for (let top = Math.min(W.NB - 1, hb + 4); top >= Math.max(0, hb - 5); top--) {
      if (!W.floor[base + top] || (top + 1 < W.NB && W.floor[base + top + 1])) continue;   // not the top of a slab
      let ok = true;
      for (let b = top + 3; b <= Math.min(W.NB - 1, top + 11) && ok; b++) if (W.solid[base + b]) ok = false;   // head room (duck on steep stairs)
      // body room at knee-hip height, 10 cm around: handrails (higher) and the next riser (lower) don't count
      for (const [dx, dz] of [[0, 0], [1, 0], [-1, 0], [0, 1], [0, -1]]) {
        if (!ok) break;
        const q = ((iz + dz) * W.NX + ix + dx) * W.NB;
        for (let b = top + 5; b <= top + 8; b++) if (b < W.NB && W.wall[q + b]) { ok = false; break; }
      }
      if (ok) return W.Y0 + (top + 1) * 0.1;
    }
    return null;
  }
  walkable(x, z) { return this.walkStep(x, z, this.walk ? this.walk.deck : 0) !== null; }
  boatMatrix(t) {
    const oc = this.R.ocean, b = this.boatState || (this.boatState = { y: 0, pitch: 0, roll: 0, t: -1 });
    if (oc.probeValid && b.t !== t) {
      const dt = b.t < 0 ? 1 : Math.min(t - b.t, 0.2); b.t = t;
      const [hb, hs, hp, hst] = [oc.heights[1], oc.heights[2], oc.heights[3], oc.heights[4]];
      const k = 1 - Math.exp(-dt * 1.6);
      b.y = lerp(b.y, (hb + hs + hp + hst) / 4 - 0.02, k);
      b.pitch = lerp(b.pitch, Math.atan2(hs - hb, 14.6), k);
      b.roll = lerp(b.roll, Math.atan2(hp - hst, 4.6), k);
    }
    return m4.mul(m4.translate([0, b.y, 0]), m4.mul(m4.mul(m4.rotX(b.pitch), m4.rotZ(b.roll)), m4.scale([BOAT_S, BOAT_S, BOAT_S])));
  }
  boatHeave(t) { return { y: Math.sin(t * 0.9) * 0.18 + Math.sin(t * 1.7 + 1) * 0.06, roll: Math.sin(t * 0.7) * 0.02, pitch: Math.sin(t * 0.55 + 2) * 0.012 }; }
  burst(pos, n) {
    for (let i = 0; i < n; i++) this.bubbles.push({ p: v3.add(pos, [(Math.random() - 0.5) * 1.5, -Math.random() * 2.2, (Math.random() - 0.5) * 1.5]), v: [0, 0.3 + Math.random() * 0.8, 0], r: 0.003 + Math.random() * Math.random() * 0.03, age: 0 });
  }

  viewerModel(model) {
    const name = Object.keys(this.sp).find((k) => this.sp[k].model === model);
    this.viewer = new Creature(this.R, this.sp[name] || this.sp.shark, {});
    console.log('viewer', name, this.sp[name]?.size, model.materials.map((m) => m.name), model.anims.map((a) => a.name));
  }

  // --------------------------------------------------------------- per-frame
  update(dt, t, cam, cm, depth, state) {
    this.push = [0, 0, 0];
    this.foamEmit = []; this.camRight = [cm[0], cm[1], cm[2]];
    this.cmLast = cm; this.camFwd = [-cm[8], -cm[9], -cm[10]]; this.depth = depth; this.wake = null; this.wakeBest = 0; this.buffet = 0;
    this.startle = (this.startle || 0) * Math.exp(-dt / 14);          // fright fades over ~half a minute
    if ((this.evClose || 0) > 0) { this.evClose -= dt; this.cineClose = true; }   // an ambient event is bringing things close
    this.collectBodies();
    const D = this.draws; D.length = 0;
    const P = cam.pos; this.camP = P;
    const R = this.R, q = R.device.queue;
    if (this.viewer) {
      const ang = parseFloat(new URLSearchParams(location.search).get('rot') || '0') * Math.PI / 180 + t * 0.0;
      this.viewer.set(m4.mul(m4.translate([P[0], P[1], P[2] - Math.max(2, this.viewer.sp.size[2] * 1.6)]), m4.rotY(ang)), dt);
      this.viewer.draws(D);
    }
    // boat (visible from surface & shallow)
    const bh = this.boatHeave(t);
    this.boat.visible = depth < 120;
    this.boatM = this.boatMatrix(t);
    this.boat.set(this.boatM, dt);
    this.boat.draws(D, depth < 1);
    // foam density window (48 m) follows the view: centred ~14 m ahead of the diver, snapped to whole texels so the
    // splatted foam doesn't shimmer as it moves (the boat's hull foam shows whenever the boat is inside the window)
    { const f = v3.norm([this.camFwd?.[0] ?? 0, 0, this.camFwd?.[2] ?? 1]), tx = 48 / 2048 * 4;
      this.foamCentre = [Math.round((P[0] + f[0] * 14) / tx) * tx, Math.round((P[2] + f[2] * 14) / tx) * tx]; }
    const bf = this.boatFoot; this.surface.obj.data.set([this.foamCentre[0], this.foamCentre[1], bf[2], bf[3]], 24); this.surface.obj.data[28] = bf[4];
    R.writeObj(this.surface.obj);
    this.surface.visible = depth < 260;
    this.floor.visible = depth > FLOOR_DEPTH - 160;
    if (this.floor.visible) {
      const s = 1.0; this.floor.obj.data.set([Math.floor(P[0] / s) * s, 0, Math.floor(P[2] / s) * s], 12);
      const sp = this.floorLife.seeps || [];
      for (let i = 0; i < 4; i++) { const q = sp[i]; this.floor.obj.data.set(q ? [q.x, q.z, 3.5 + ih01(q.id) * 3, 1] : [0, 0, 1, 0], 16 + i * 4); }
      R.writeObj(this.floor.obj);
    }
    // ---- predators (sharks, dolphins, tuna) for prey escape responses ----
    const PR = this.predators = [];
    this.sharks?.forEach((sh) => sh.spawned && sh.c.visible && PR.push({ p: sh.pos, r: 11 }));
    this.dolphins?.forEach((d) => d.c.visible && d.pos && PR.push({ p: d.pos, r: 7 }));
    if (this.whale?.sw?.pos) PR.push({ p: this.whale.sw.pos, r: 20 });   // humpbacks feed on bait fish
    this.schools.forEach((sc) => sc.predator && sc.count && sc.members.forEach((m) => m.cur && PR.push({ p: m.cur, r: 5 })));
    // the diver is a big, strange animal to small fish: they give way, more when approached fast
    { const dv = v3.len(this.camVel || [0, 0, 0]); PR.push({ p: P, r: 2.8 + Math.min(dv, 3) * 1.6, diver: true }); }
    // ---- fish schools (3–80 m) ----
    for (const sc of this.schools) this.updateSchool(sc, dt, t, P, depth);
    // ---- manta (15–130 m) ----
    {
      const m = this.manta, inZone = depth > 10 && depth < 150, vis = visRange(depth);
      if (!m.sw) { m.sw = new Swimmer(); m.sw.turnCap = 0.5; }
      if (!m.sw.pos && inZone) { m.sw.spawnAt(this.hiddenSpawn(P, m.seen ? vis + 5 : 30, 6, [-140, -6]), P); m.seen = true; }
      if (m.sw.pos) {
        m.ang += dt * 0.07;
        const tgt = inZone ? [P[0] + Math.cos(m.ang) * m.r, clamp(P[1] + 6 + Math.sin(t * 0.1) * 3, -140, -8), P[2] + Math.sin(m.ang) * m.r] : null;
        const far = v3.dist(m.sw.pos, P);
        m.sw.step(dt, tgt, far > 30 ? 2.2 : 1.1, 0.35, this.avoid(m.sw.pos, 2.3, 'manta', 3));
        m.c.visible = true;
        m.c.set(orient(m.sw.pos, m.sw.dir, -0.25), dt, 0.8);
        m.c.draws(D);
        if (this.outOfSight(m.sw.pos, P, 4)) m.sw.pos = null;
      } else m.c.visible = false;
    }
    // ---- sharks (50–320 m) ----
    this.updateSharks(dt, t, P, cm, depth, D);
    this.updateDolphins(dt, t, P, cm, depth, D);
    this.updateWhale(dt, t, P, cm, depth, D);
    // showcase events (once per dive, when the diver first reaches the depth)
    const E = this.events;
    // recurring bait balls (12–70 m); each one gets a random hunter: tuna, dolphins, or none
    if (depth > 20 && !E.bait) { E.bait = true; this.baitT = 0; }
    if (E.bait && !this.swarm.active && depth > 12 && depth < 70) {
      this.baitT -= dt;
      if (this.baitT <= 0) {
        this.startSwarm(P, t);
        const r = Math.random();
        this.swarm.hunter = r < 0.45 ? 'tuna' : r < 0.85 ? 'dolphin' : null;
        this.baitT = 90 + Math.random() * 90;
      }
    }
    if (depth > 36 && depth < 150 && !E.whale) { E.whale = true; this.whale.closeNext = true; this.whale.wait = 0; this.whale.sw && (this.whale.sw.pos = null); }
    if (depth > 46 && depth < 150 && !E.manta) { E.manta = true; this.startSquadron(P); }
    this.updateSwarm(dt, t, P, cm, depth);
    this.updateSquadron(dt, t, P, depth, D);
    this.updateCutlass(dt, t, P, depth, D);
    this.updateSunfish(dt, t, P, depth, D);
    // ---- colossal turtle (180–420 m): a 60 m silhouette swims past close by ----
    this.updateTurtle(dt, t, P, cm, depth, D);
    // ---- jellies (450–1700 m) ----
    this.updateJellies(dt, t, P, depth);
    // ---- deep-sea fish (1100–3950 m) ----
    this.lightList = [];
    for (let i = 0; i < MAXJ(this); i++) { const j = this.jellies[i]; if (j && j.fade > 0.05) this.lightList.push({ p: v3.add(j.p, [0, -j.s * 0.3, 0]), c: v3.scale(j.col, 0.35 * j.s * j.fade * (0.7 + 0.3 * Math.sin(t * 2.2 + j.ph))), r: 7 }); }
    {
      const on = depth > 1100, vis = visRange(depth, true);
      for (const a of this.anglers) {
        if (!a.sw) a.sw = new Swimmer();
        if (!a.sw.pos) { if (!on) { a.c.visible = false; continue; } a.sw.spawnAt(this.hiddenSpawn(P, vis + 5, a.dy, [-FLOOR_DEPTH + 3, -1]), P); }
        a.ang += dt * a.sp / a.r;
        let tgt = on ? [P[0] + Math.cos(a.ang) * a.r, clamp(P[1] + a.dy + Math.sin(t * 0.2 + a.r) * 1.5, -FLOOR_DEPTH + 3, 0), P[2] + Math.sin(a.ang) * a.r] : null;
        // cinematic: one angler at a time drifts up to ~1.5 m in front of the mask, hangs there, then slips away
        if (on && this.cineClose && a === this.anglers[this.closeAngler ?? 0]) {
          this.anglerPassT = (this.anglerPassT ?? 0) + dt;
          if (this.anglerPassT < 14) { const f = this.camFwd; tgt = v3.add(P, v3.add(v3.scale(f, 1.5), [0.4 * Math.sin(t * 0.3), -0.15, 0])); }
          else if (this.anglerPassT > 22) { this.anglerPassT = 0; this.closeAngler = ((this.closeAngler ?? 0) + 1) % this.anglers.length; }
        }
        const far = tgt ? v3.dist(a.sw.pos, tgt) : 0;
        a.sw.step(dt, tgt, far > 10 ? 1.4 : a.sp, 0.5, this.avoid(a.sw.pos, 0.6, 'ang' + this.anglers.indexOf(a), 2));
        if (this.outOfSight(a.sw.pos, P, 2)) { a.sw.pos = null; a.c.visible = false; continue; }
        a.c.visible = true;
        const w = orient(a.sw.pos, a.sw.dir, 0.0);
        a.c.set(w, dt, 0.7);
        a.c.draws(D);
        const lp = m4.xform(w, this.lureLocal);
        const flick = 0.75 + 0.25 * Math.sin(t * 3.1 + a.r) * Math.sin(t * 7.3 + a.r * 2);
        this.lightList.push({ p: lp, c: [0.25 * flick, 0.75 * flick, 1.0 * flick], r: 6 });
      }
      const g = this.goblin, gon = false, gvis = visRange(depth);   // retired: replaced by grenadiers on the floor
      if (!g.sw) g.sw = new Swimmer();
      if (!g.sw.pos && gon) g.sw.spawnAt(this.hiddenSpawn(P, gvis + 5, -3, [-FLOOR_DEPTH + 2.5, -1]), P);
      if (g.sw.pos) {
        g.ang -= dt * 0.9 / g.r;
        const tgt = gon ? [P[0] + Math.cos(g.ang) * g.r, clamp(P[1] - 3 + Math.sin(t * 0.13) * 2, -FLOOR_DEPTH + 2.5, 0), P[2] + Math.sin(g.ang) * g.r] : null;
        g.sw.step(dt, tgt, tgt && v3.dist(g.sw.pos, tgt) > 10 ? 1.6 : 0.9, 0.4, this.avoid(g.sw.pos, 1.6, 'gob', 3));
        g.c.visible = true;
        g.c.set(orient(g.sw.pos, g.sw.dir, 0.15), dt, 0.6);
        g.c.draws(D);
        if (this.outOfSight(g.sw.pos, P, 2, gvis)) { g.sw.pos = null; g.c.visible = false; }
      } else g.c.visible = false;
    }
    // ---- abyssal floor: crabs, props ----
    this.updateFloor(dt, t, P, depth, D);
    this.deepLife.update(dt, t, P, depth, D, cm);
    this.deepEvents(dt, t, P, depth);
    this.updateSquid(dt, t, P, cm, depth, D);
    this.updateMega(dt, t, P, cm, depth, D);
    this.updateSpecimens(dt, t, P, depth, D);
    // ---- particles ----
    // never switch flakes on/off in view: fade in just below the surface, continuous brightness curve with depth
    this.snow.count = depth > 0.05 ? this.snow.max : 0;
    this.snow.obj.data[15] = lerp(lerp(2.2, 0.8, smooth(5, 60, depth)), 1.6, smooth(110, 190, depth)) * smooth(0.1, 2.5, depth);
    for (const f of this.fx) f.obj.data[7] = 1 / Math.tan((cam.fovE || cam.fov) / 2);
    this.sand.count = depth > FLOOR_DEPTH - 25 ? this.sand.max : 0;
    this.sand.obj.data[15] = 1.4 * smooth(FLOOR_DEPTH - 25, FLOOR_DEPTH - 12, depth);   // fade in, never pop
    this.updateBubbles(dt, t, P, cm, depth, state);
    this.updateSpray(dt);
    const md = (a, b) => ((a % b) + b) % b;
    for (const f of this.fx) {
      const d = f.obj.data, bx = [d[0], d[1], d[2]];
      d[16] = md(P[0], bx[0]); d[17] = md(P[1], bx[1]); d[18] = md(P[2], bx[2]); d[19] = -FLOOR_DEPTH - P[1];
      R.writeObj(f.obj);
    }
  }

  // a creature may only be removed once nobody could still see it: well beyond the visibility range, or beyond it and
  // behind the diver's view.  `vr` overrides the visibility range (e.g. glowing animals).
  outOfSight(pos, P, radius = 2, vr) {
    const v = (vr ?? visRange(this.depth ?? 0)) + radius;
    const d = v3.sub(pos, P), dl = v3.len(d);
    if (dl > v * 1.3 + 8) return true;
    if (dl < v + 4) return false;
    const f = this.camFwd || [0, 0, -1];
    return (d[0] * f[0] + d[1] * f[1] + d[2] * f[2]) / dl < 0.2;    // outside a generous view cone
  }
  schoolGone(sc, P) {
    for (let i = 0; i < sc.n; i++) { const m = sc.members[i]; if (m.cur && !this.outOfSight(m.cur, P, 1)) return false; }
    return this.outOfSight(sc.center, P, sc.radius);
  }

  updateSchool(sc, dt, t, P, depth) {
    const inZone = depth < sc.onDepth && depth > (sc.minOn || 0);
    const vis = visRange(depth) + sc.radius;
    if (sc.count === 0) {
      if (!inZone) return;
      // first appearance near the diver (still at the surface); later ones arrive from beyond visibility
      sc.center = this.hiddenSpawn(P, sc.seen ? vis + 6 : 20 + Math.random() * 10, 0, sc.band);
      sc.vel = v3.scale(v3.norm([P[0] - sc.center[0], 0, P[2] - sc.center[2]]), 1); sc.heading = v3.norm(sc.vel);
      sc.members.forEach((m) => { m.cur = null; m.vel = null; m.roll = 0; });
      sc.count = sc.n; sc.seen = true; sc.retarget = 0;
    }
    const dist = v3.dist(sc.center, P);
    if (this.schoolGone(sc, P)) { sc.count = 0; return; }        // every member beyond sight
    sc.retarget -= dt;
    if (!inZone) {
      sc.target = v3.add(sc.center, v3.scale([sc.heading[0], 0, sc.heading[2]], 60));   // swim off on its own course
    } else if (sc.predator && this.swarm?.active && this.swarm.hunter === 'tuna' && !this.swarm.leaving && v3.dist(this.swarm.center, sc.center) < 90) {
      // hunting run: tear through the bait ball, overshoot, come round again
      if (sc.retarget <= 0 || !sc.huntPass) { sc.retarget = 5 + Math.random() * 3; const side = v3.norm([Math.random() - 0.5, 0, Math.random() - 0.5]); sc.huntPass = v3.add(this.swarm.center, v3.scale(side, 4)); }
      sc.target = v3.add(sc.huntPass, v3.scale(v3.norm(v3.sub(sc.huntPass, sc.center)), 25));
    } else if (sc.retarget <= 0 || sc.huntPass) {
      sc.huntPass = null;
      sc.retarget = 8 + Math.random() * 8;
      const a = Math.random() * 6.28, rr = 12 + Math.random() * 14;
      sc.target = [P[0] + Math.cos(a) * rr * sc.range, clamp(P[1] + (Math.random() - 0.4) * 8, sc.band[0], sc.band[1]), P[2] + Math.sin(a) * rr * sc.range];
    }
    const to = v3.sub(sc.target, sc.center);
    const want = v3.scale(v3.norm(to), Math.min(sc.speed * (dist > 35 ? 2.2 : 1), v3.len(to) * 0.2 + 0.4));
    if (sc.predator) steerFish(sc.vel, v3.scale(v3.norm(to), Math.max(sc.speed * 0.7, v3.len(want))), dt, 1.5, 0.45, sc.speed * 0.5, sc.vMax);   // the school itself cruises and wheels, never stops
    else sc.vel = v3.lerp(sc.vel, want, 1 - Math.exp(-dt * 0.5));
    sc.center = v3.add(sc.center, v3.scale(sc.vel, dt));
    if (v3.len(sc.vel) > 0.05) { sc.heading = v3.norm(v3.lerp(sc.heading, v3.norm(sc.vel), 1 - Math.exp(-dt * 0.8))); sc.heading[1] = clamp(sc.heading[1], -0.25, 0.25); sc.heading = v3.norm(sc.heading); }
    const yaw = Math.atan2(sc.heading[0], sc.heading[2]);
    const cy = Math.cos(yaw), sy = Math.sin(yaw);
    const inst = sc.inst;
    for (let i = 0; i < sc.n; i++) {
      const m = sc.members[i];
      const o = m.off, w = m.wob;
      const lx = o[0] + Math.sin(t * 0.37 + w) * 0.6, ly = o[1] + Math.sin(t * 0.29 + w * 1.3) * 0.4, lz = o[2] + Math.sin(t * 0.21 + w * 0.7) * 0.8;
      let p = [sc.center[0] + lx * cy + lz * sy, sc.center[1] + ly, sc.center[2] - lx * sy + lz * cy];
      // part around the diver
      const d = v3.sub(p, P), dl = v3.len(d);
      if (dl < sc.avoid) p = v3.add(p, v3.scale(d, (sc.avoid - dl) / Math.max(dl, 0.1) * 0.9));
      // physically steered toward its formation slot: velocity-driven, limited acceleration and turn rate
      if (!m.cur) { m.cur = p; m.vel = v3.scale(sc.heading, sc.speed * 0.6); }
      let des = v3.add(v3.scale(v3.sub(p, m.cur), sc.slotK ?? 0.9), sc.vel);
      if (sc.predator) des = v3.add(des, v3.scale(this.avoid(m.cur, 0.8, 'tuna' + i, 1.5), 4.0));   // tuna keep spacing & avoid big animals
      // escape response: dart away from nearby predators (fast-start burst)
      let fleeing = 0;
      if (!sc.predator) for (const pr of this.predators) {
        const ex = m.cur[0] - pr.p[0], ey = m.cur[1] - pr.p[1], ez = m.cur[2] - pr.p[2], ed = Math.hypot(ex, ey, ez);
        if (ed < pr.r && ed > 1e-3) { const k = (pr.r - ed) / pr.r * 7 / ed; des = v3.add(des, [ex * k, ey * k * 0.5, ez * k]); fleeing = Math.max(fleeing, (pr.r - ed) / pr.r); }
      }
      const lastV = [...m.vel];
      if (fleeing > 0) steer(m.vel, des, dt, 16, 8, 0.35, Math.max(sc.speed * 2.6, 4.5));
      else if (sc.predator) steerFish(m.vel, des, dt, sc.aMax, (sc.huntPass && sc.turnHunt) || sc.turnMax, 2.0, sc.vMax);
      else steer(m.vel, des, dt, sc.aMax || 3.5, sc.turnMax || 2.8, 0.35, sc.vMax || sc.speed * 2.6);
      m.cur = v3.add(m.cur, v3.scale(m.vel, dt));
      const vel = m.vel;
      const hl = Math.hypot(vel[0], vel[2]) || 1e-3;
      const dir = v3.norm([vel[0], clamp(vel[1], -0.3 * hl, 0.3 * hl), vel[2]]);
      const turn = ((vel[2] - lastV[2]) * vel[0] - (vel[0] - lastV[0]) * vel[2]) / (hl * hl * dt + 1e-6);
      m.roll = lerp(m.roll || 0, clamp(-turn * 0.25, -0.5, 0.5), 1 - Math.exp(-dt * 3));
      // body flexes with the path curvature (yaw rate / speed), a little ahead of the heading change
      const spdNow = Math.max(v3.len(vel), 0.3), L = sc.len || 1;
      m.bend = lerp(m.bend || 0, clamp(-turn / spdNow * L * 0.5, -0.35, 0.35), 1 - Math.exp(-dt * 6));
      const M = orient(m.cur, dir, m.roll, m.sc);
      M[3] = m.ph; M[7] = m.spd * (1 + Math.min(v3.len(vel), 3) * 0.3); M[11] = 0; M[15] = 1 + m.bend;
      rel(M, inst.subarray(i * 16, i * 16 + 16));
    }
    const q = this.R.device.queue;
    sc.sp.gpu.prims.forEach((p, i) => {
      const o = sc.obj[i];
      o.data.set(m4.ident(), 0);
      q.writeBuffer(o.sb, 0, inst, 0, sc.n * 16);
      this.draws.push({ gm: p.gm, mat: p.mat, obj: o, kind: 'inst', instances: sc.n, shadow: sc.shadow });
    });
  }

  updateDolphins(dt, t, P, cm, depth, D) {
    const pod = this.pod, on = depth < 45, vis = visRange(depth);
    if (!pod.snd && this.A.ctx) pod.snd = this.A.presence('dolphins_talk', 1.0);
    if (!pod.sw) { pod.sw = new Swimmer(); pod.sw.turnCap = 0.8; }
    if (!pod.sw.pos) {
      if (!on) { this.dolphins.forEach((d) => (d.c.visible = false)); if (pod.snd) pod.snd.set(0, 0); return; }
      pod.sw.spawnAt(this.hiddenSpawn(P, pod.seen ? vis + 6 : 25, 2, [-30, -1.8]), P); pod.seen = true;
    }
    // pod circles the diver, periodically dashing straight past
    pod.dash -= dt;
    if (on && pod.dash <= 0 && !pod.dashing) { pod.dashing = 1; pod.dashT = 0; pod.from = [...pod.sw.pos]; const th = v3.norm([P[0] - pod.from[0], 0, P[2] - pod.from[2]]); pod.to = [P[0] + th[0] * 30 - th[2] * 3, P[1] - 1, P[2] + th[2] * 30 + th[0] * 3]; }
    let center, dir;
    const S = this.swarm, hunting = on && S?.active && S.hunter === 'dolphin' && !S.leaving;
    if (hunting) {
      pod.hunt = pod.hunt || { phase: 'herd', t: 0, dash: null };
      const H = pod.hunt; H.t += dt;
      let tgt, spd;
      if (H.phase === 'herd') {          // circle the ball, compressing it
        const a = H.t * 0.55 + (pod.huntAng || 0);
        tgt = [S.center[0] + Math.cos(a) * 9, S.center[1] + Math.sin(H.t * 0.7) * 2, S.center[2] + Math.sin(a) * 9]; spd = 4.5;
        if (H.t > 7 + Math.random() * 3) { H.phase = 'dash'; H.t = 0; const th = v3.norm(v3.sub(S.center, pod.sw.pos)); H.dash = v3.add(S.center, v3.scale(th, 14)); }
      } else {                           // strike straight through the middle and out the other side
        tgt = H.dash; spd = 7.5;
        if (H.t > 4 || v3.dist(pod.sw.pos, H.dash) < 3) { H.phase = 'herd'; H.t = 0; pod.huntAng = Math.atan2(pod.sw.pos[2] - S.center[2], pod.sw.pos[0] - S.center[0]); }
      }
      pod.sw.step(dt, tgt, spd, H.phase === 'dash' ? 1.6 : 1.1, this.avoid(pod.sw.pos, 4, 'pod', 3));
      center = pod.sw.pos; dir = pod.sw.dir;
      pod.clickT = Math.min(pod.clickT, 1.2);   // busy echolocation while hunting
    } else if (!on) {   // diver left the shallows: the pod carries on and fades out with distance
      pod.sw.step(dt, null, 3.5, 0); center = pod.sw.pos; dir = pod.sw.dir;
      if (this.outOfSight(center, P, 8)) { pod.sw.pos = null; }
    } else if (pod.dashing && !hunting) {
      pod.dashT += dt / 14;
      pod.sw.step(dt, pod.to, 5.5, 0.9, this.avoid(pod.sw.pos, 4, 'pod', 3));
      center = pod.sw.pos; dir = pod.sw.dir;
      if (pod.dashT >= 1 || v3.dist(center, pod.to) < 4) { pod.dashing = 0; pod.dash = 25 + Math.random() * 25; pod.ang = Math.atan2(center[2] - P[2], center[0] - P[0]); }
    } else {
      pod.ang += dt * 2.6 / pod.r;
      // near the surface the pod's circle is centred ahead of the diver, so most of its surfacing happens in view
      const cOff = P[1] > -12 ? v3.scale(v3.norm([this.camFwd[0], 0, this.camFwd[2]]), pod.r * 0.8) : [0, 0, 0];
      let tgt = [P[0] + cOff[0] + Math.cos(pod.ang + 0.4) * pod.r, clamp(P[1] + 2, -30, -1.8), P[2] + cOff[2] + Math.sin(pod.ang + 0.4) * pod.r];
      // playful: when the diver is shallow the pod comes round in front of the mask and weaves through the view
      if (P[1] > -25) {
        pod.playT = (pod.playT ?? 20) - dt;
        if (pod.playT < 0) { pod.playT = 40 + Math.random() * 30; pod.playing = 16 + Math.random() * 8; }
        if (pod.playing > 0) {
          pod.playing -= dt;
          const f = v3.norm([this.camFwd[0], 0, this.camFwd[2]]), r = [-f[2], 0, f[0]];
          const sw = Math.sin(t * 0.45) * 7;
          tgt = v3.add(P, v3.add(v3.scale(f, 9 + 2 * Math.sin(t * 0.3)), v3.scale(r, sw)));
          tgt[1] = clamp(P[1] + 0.5 + Math.sin(t * 0.6) * 1.5, -30, -1.8);
        }
      }
      const far = v3.dist(pod.sw.pos, tgt);
      pod.sw.step(dt, tgt, far > 12 ? 5.5 : 2.8, 0.9, this.avoid(pod.sw.pos, 4, 'pod', 3));
      center = pod.sw.pos; dir = pod.sw.dir;
    }
    pod.pos = center;
    const side = v3.norm(v3.cross([0, 1, 0], dir));
    for (const d of this.dolphins) {
      // porpoising: gentle vertical undulation along the path
      // formation slot around the pod centre; the animal itself swims there with inertia and a limited turn rate
      const slot = v3.add(center, v3.add(v3.add(v3.scale(side, d.off[0]), [0, d.off[1] + Math.sin(t * 0.9 + d.ph) * 0.8, 0]), v3.scale(dir, d.off[2])));
      slot[1] = Math.min(slot[1], -1.8);
      // breathing: every 15–40 s each dolphin arcs up so its back and blowhole break the surface, then dives again
      // surface activity where the diver is looking: dolphins in front of the mask breathe/leap sooner, those behind hold on
      const toD = d.cur ? v3.norm([d.cur[0] - P[0], 0, d.cur[2] - P[2]]) : [0, 0, 0], fh = v3.norm([this.camFwd[0], 0, this.camFwd[2]]);
      const inView = v3.dot(toD, fh);
      d.breathT = (d.breathT ?? 5 + d.i * 4 + Math.random() * 10) - dt * (inView > 0.5 ? 2.5 : inView > 0 ? 1.0 : 0.35);
      if (d.breathT <= 0 && slot[1] > -14 && !d.surf) { d.surf = 5.0; d.breathT = 15 + Math.random() * 25; }
      if (d.surf > 0) { d.surf -= dt; slot[1] = d.surf > 1.6 ? 0.25 : -2.4; if (d.surf <= 0) d.surf = 0; }
      if (!d.cur || v3.dist(d.cur, slot) > 40) { d.cur = [...slot]; d.vel = v3.scale(dir, Math.max(pod.sw.speed, 1.5)); d.roll = 0; }
      const podV = v3.scale(dir, pod.sw.speed);
      let des = v3.add(podV, v3.scale(v3.sub(slot, d.cur), 0.45));
      des = v3.add(des, v3.scale(this.avoid(d.cur, 0.9, 'dolph' + d.i, 2.5), 3.0));   // swerve around other big animals
      const lastV = [...d.vel];
      // leap: a surfacing dolphin near the diver sometimes powers out of the water; ballistic flight, then re-entry
      if (d.surf > 0 && !d.jump && d.cur[1] > -1.2 && !d.jumped && (pod.playing > 0 || Math.random() < 0.004)) {
        d.jumped = true;
        if (Math.random() < (pod.playing > 0 ? 0.6 : 0.3)) { const f = v3.norm([d.vel[0], 0, d.vel[2]]); d.jump = true; const hs = 6.5 + Math.random() * 1.5; d.vel = [f[0] * hs, 4.3 + Math.random() * 1.3, f[2] * hs]; }   // fast, low arc: ~0.9-1.1 s in the air, 1-1.6 m high
      }
      if (d.surf <= 0) d.jumped = false;
      if (d.jump) {
        const air = d.cur[1] > -0.3;
        d.jt = (d.jt || 0) + dt;
        if (air) { d.vel[1] -= 9.81 * dt; d.vel = v3.scale(d.vel, Math.exp(-dt * 0.08)); d.flew = true; }   // ballistic, a little air drag
        else if (d.flew) { d.vel = v3.scale(d.vel, Math.exp(-dt * 1.6)); d.vel[1] = Math.min(d.vel[1], -0.6); }   // re-entry: the water brakes the plunge, it keeps going down
        else d.vel[1] -= 3 * dt;                                                 // powering up to the surface
        d.cur = v3.add(d.cur, v3.scale(d.vel, dt));
        // back to swimming once it is under again (never hovers at the surface), or after 3 s whatever happens
        if ((d.flew && !air && d.cur[1] < -0.9) || d.jt > 3) { d.jump = false; d.flew = false; d.jt = 0; d.surf = 0; d.vel[1] = Math.max(d.vel[1], -1.2); }
      } else {
        steerFish(d.vel, des, dt, 3.5, 1.3, 1.5, 9);        // ~2.3 m, 150 kg: tight but not instant turns
        { const h = Math.hypot(d.vel[0], d.vel[2]); const lim = d.surf > 0 ? 0.8 : 0.35; d.vel[1] = clamp(d.vel[1], -lim * h, lim * h); }   // shallow porpoising pitch
        d.cur = v3.add(d.cur, v3.scale(d.vel, dt));
        { const lim = d.surf > 0 ? -0.05 : -1.0;                                      // back + blowhole just breaking the surface
          if (d.cur[1] > lim) d.cur[1] = d.surf > 0 ? lim : Math.max(lim, d.cur[1] - 1.2 * dt); }   // after a breath it slides back under (never pops down)
      }
      // at the surface: churned foam + white water where the body cuts through, bubbles, splash / blow sounds
      {
        const sp = Math.hypot(d.vel[0], d.vel[2]), fw = [d.vel[0] / (sp || 1), 0, d.vel[2] / (sp || 1)];
        const wet = 1 - smooth(0.2, 0.9, Math.abs(d.cur[1] + 0.1));            // back / blowhole at the waterline
        if (wet > 0.05 && sp > 0.5) {
          const L = 2.6 * (d.sz || 1);
          this.foamEmit.push({ x: d.cur[0] + fw[0] * L * 0.2, z: d.cur[2] + fw[2] * L * 0.2, rate: 4500 * wet * Math.min(sp / 3, 1.5), r: 0.35, vx: d.vel[0] * 0.3, vz: d.vel[2] * 0.3 });
          this.foamEmit.push({ x: d.cur[0] - fw[0] * L * 0.45, z: d.cur[2] - fw[2] * L * 0.45, rate: 3500 * wet * Math.min(sp / 3, 1.5), r: 0.5, vx: d.vel[0] * 0.15, vz: d.vel[2] * 0.15 });   // fluke wash
          if (this.bubbles.length < this.bubbleMax - 60 && Math.random() < dt * 25 * wet) this.bubbles.push({ p: [d.cur[0] - fw[0] * L * 0.4 + (Math.random() - 0.5) * 0.4, d.cur[1] - 0.3 - Math.random() * 0.5, d.cur[2] - fw[2] * L * 0.4 + (Math.random() - 0.5) * 0.4], v: [0, 0.2, 0], r: 0.002 + Math.random() * Math.random() * 0.012, age: 0, ph: Math.random() * 6 });
        }
        const up = d.cur[1] > -0.35;
        const L2 = 2.6 * (d.sz || 1);
        if (wet > 0.2 && sp > 0.5) {
          // the dorsal fin / back cuts the water: a sheet of spray peels off both sides, rings spread from the cut
          d.ripT = (d.ripT || 0) - dt;
          if (d.ripT <= 0) { d.ripT = 0.35; this.ripples.push({ x: d.cur[0], z: d.cur[2], age: 0, amp: 0.02 * wet }); }
          const n = Math.floor(dt * 70 * wet + Math.random());
          for (let k = 0; k < n; k++) this.sprayDrop(v3.add(d.cur, [0, 0.25, 0]), fw, sp * 0.35, 0.6 + Math.random() * 1.2, 1.4);
        }
        if (up !== !!d.above) {
          d.above = up;
          const rel = v3.sub(d.cur, this.camP || d.cur), dist = v3.len(rel) || 1, pan = this.camRight ? v3.dot(v3.scale(rel, 1 / dist), this.camRight) : 0;
          const vol = 1 - smooth(6, 45, dist);
          // the surface parts: a crater + big ring, and a burst of spray
          this.ripples.push({ x: d.cur[0] + fw[0] * L2 * 0.3, z: d.cur[2] + fw[2] * L2 * 0.3, age: 0, amp: up ? 0.09 : 0.07 });
          const nb = up ? 140 : 90;
          if (!up) this.foamCloud(v3.sub(d.cur, v3.scale(fw, L2 * 0.3)), 10, 0.5, 1.2);   // re-entry drags a trail of air down with it
          (this.churns ||= []).push({ x: d.cur[0] + fw[0] * L2 * (up ? 0.3 : -0.3), z: d.cur[2] + fw[2] * L2 * (up ? 0.3 : -0.3), rate: 9000, r: 0.45, grow: 1.2, age: 0, dur: 0.7 });   // the water it breaks boils white on the spot
          for (let k = 0; k < nb * 0.15 && this.spray.length < this.sprayMax; k++) { const a = Math.random() * 6.28, spd = 1 + Math.random() * 2.2; this.spray.push({ p: [d.cur[0] + (Math.random() - 0.5), 0.1, d.cur[2] + (Math.random() - 0.5)], v: [Math.cos(a) * spd * 0.5 + fw[0] * sp * 0.3, spd, Math.sin(a) * spd * 0.5 + fw[2] * sp * 0.3], r: 0.03 + Math.random() * 0.06, age: 0, s: Math.random(), gen: 1, foam: true }); }
          for (let k = 0; k < nb; k++) this.sprayDrop([d.cur[0] + fw[0] * L2 * (up ? 0.3 : -0.3), 0.05, d.cur[2] + fw[2] * L2 * (up ? 0.3 : -0.3)], fw, up ? sp * 0.5 : sp * 0.2, 1.2 + Math.random() * (up ? 3.2 : 2.2), up ? 1.8 : 1.3);
          if (vol > 0.02) {
            // water sounds taken from the surf recording (a real wave wash), trimmed short; plus the blow when it surfaces
            this.A.play((up ? 'dolphin_out_' : 'dolphin_in_') + (1 + ((Math.random() * 3) | 0)), (up ? 0.95 : 1.0) * vol, { pan, pos: [d.cur[0], 0.2, d.cur[2]], rate: 0.92 + Math.random() * 0.16 });   // cut from the surf recording (tools: see SOURCES)
            if (up) this.A.bio?.('blow', 0.5 * vol, pan, false, [d.cur[0], 0.4, d.cur[2]]);
          }
        }
      }
      const pos = d.cur;
      d.pos = pos;
      const hl = Math.hypot(d.vel[0], d.vel[2]) || 1e-3;
      const yawRate = ((d.vel[2] - lastV[2]) * d.vel[0] - (d.vel[0] - lastV[0]) * d.vel[2]) / (hl * hl * dt + 1e-6);
      d.roll = lerp(d.roll, clamp(-yawRate * 0.45, -0.7, 0.7) + Math.sin(t * 0.5 + d.ph) * 0.08, 1 - Math.exp(-dt * 2.5));   // bank into the turn
      d.c.visible = true;
      d.sz = d.sz || clamp(sizeVar(0.07), 0.93, 1.15);   // adults only (no calves)
      // fluke-beat rate from speed: one beat (= one 2.625 s clip cycle) per ~0.8 body lengths travelled;
      // accelerating works harder, coasting glides with a slow beat
      const spdD = v3.len(d.vel), acc = (spdD - (d.lastSpd ?? spdD)) / Math.max(dt, 1e-3); d.lastSpd = spdD;
      const beatHz = spdD / (0.8 * 2.6 * d.sz) * clamp(1 + acc * 0.35, 0.55, 1.5);
      const inAir = d.jump && d.cur[1] > -0.3;                          // no thrust in the air: the flukes hold still
      d.beat = lerp(d.beat ?? 1, inAir ? 0.12 : clamp(beatHz * 2.625, 0.35, 8.0), 1 - Math.exp(-dt * (inAir ? 6 : 2.5)));
      d.c.set(orient(pos, d.vel, d.roll, d.sz), dt, d.beat);
      d.c.draws(D);
    }
    // sound: chatter swells with proximity; occasional clicks / calls
    const rel = v3.sub(center, P), dist = v3.len(rel), pan = v3.dot(v3.norm(rel), [cm[0], cm[1], cm[2]]);
    // with the diver's head out of the water, dolphin voices only carry when a dolphin is itself above the surface
    const headOut = P[1] > -0.4;
    const anyUp = this.dolphins.some((d) => d.above || d.jump);
    const prox = nearVol(dist, 8, 30) * (headOut ? (anyUp ? 1 : 0) : 1);
    if (pod.snd) pod.snd.set(0.9 * prox, pan * 0.7, 0, center);
    pod.clickT -= dt;
    if (pod.clickT <= 0) {
      pod.clickT = 2 + Math.random() * 5;
      const n = ['dolphin_click', 'dolphin_chitter', 'dolphin_noise', 'dolphin_call'][(Math.random() * 4) | 0];
      if (prox > 0.02) this.A.play(n, 0.8 * prox, { pan: pan * 0.8, pos: center, rate: 0.95 + Math.random() * 0.15 });
    }
  }
  // humpback whale: slow passes by the diver (8–200 m); its song carries far beyond sight
  updateWhale(dt, t, P, cm, depth, D) {
    const w = this.whale, on = (depth > 8 && depth < 200) || !!this.whaleShowCue || !!w?.ev, vis = visRange(depth);
    if (!w.snd && this.A.ctx) w.snd = this.A.presence('humpback_dive', 1.0);
    if (!w.sw) { w.sw = new Swimmer(); w.sw.turnCap = 0.12; }   // 14 m, 30 t
    if (!w.sw.pos) {
      w.c.visible = false;
      if (w.snd) w.snd.set(0, 0);
      if (!on) return;
      w.wait -= dt;
      if (w.wait > 0) return;
      // start a pass: enter from beyond visibility on a line that passes 12–20 m beside the diver
      const a = Math.random() * 6.28, dir = [Math.cos(a), 0, Math.sin(a)], side = [-dir[2], 0, dir[0]];
      const close = !!w.closeNext; w.closeNext = false; w.close = close;
      const off = (Math.random() < 0.5 ? -1 : 1) * (close ? 12 + Math.random() * 2 : 20 + Math.random() * 12);
      const start = v3.add(P, v3.add(v3.scale(dir, -(vis + 12)), v3.scale(side, off)));
      start[1] = clamp(P[1] + (close ? -1.8 : (Math.random() - 0.3) * 6), -190, -6);
      w.sw.pos = start; w.sw.dir = dir; w.passDir = dir; w.passY = start[1];
    }
    // ---- surface show (diver near the surface): blow at the surface, lobtail (tail slaps), then a fluke-up dive ----
    if (!w.ev && this.whaleShowCue && P[1] > -25 && w.sw.pos) { this.whaleShowCue = false; w.ev = { st: 'rise', t: 0, slaps: 0, pitch: 0 }; const f = v3.norm([this.camFwd[0], 0, this.camFwd[2]]); w.ev.at = v3.add(P, v3.add(v3.scale(f, 42 + Math.random() * 8), v3.scale([-f[2], 0, f[0]], (Math.random() - 0.5) * 10))); w.ev.at[1] = -1.3;
      // come up from the deep straight ahead (not from the side): start below and beyond the surface point, facing the diver
      // (never pops: if the whale is already in view it simply swims there from where it is)
      if (!w.c.visible || this.outOfSight(w.sw.pos, P, 16)) { w.sw.pos = v3.add(w.ev.at, v3.add(v3.scale(f, 75), [0, -17, 0])); w.sw.dir = v3.norm([w.ev.at[0] - w.sw.pos[0], 0, w.ev.at[2] - w.sw.pos[2]]); w.sw.speed = 3.5; } }
    if (!w.ev && w.bendV.some((b) => Math.abs(b) > 1e-3)) w.bendV = w.bendV.map((b) => lerp(b, 0, 1 - Math.exp(-dt)));
    if (w.ev) { if (this.whaleShow(w, dt, t, P, cm, D)) return; }
    // glide straight along the pass, gently following the diver's depth band
    const tgt = v3.add(w.sw.pos, v3.scale(w.passDir, 30));
    if (on && !w.close) w.passY = lerp(w.passY, clamp(P[1] + 2, -190, -6), 1 - Math.exp(-dt * 0.05));
    tgt[1] = w.passY + Math.sin(t * 0.15) * 1.5;
    const dNow = v3.dist(w.sw.pos, P);
    const wav = this.avoid(w.sw.pos, 10, 'whale', 6).map((x, k) => x * 0.6);
    w.sw.step(dt, tgt, dNow > 30 && v3.dot(v3.sub(w.sw.pos, P), w.passDir) < 0 ? 3.2 : 1.6, 0.15, wav);   // cruise in from afar, glide past slowly
    const rel = v3.sub(w.sw.pos, P), d = v3.len(rel);
    const ahead = v3.dot(rel, w.passDir);
    if (ahead > vis + 14) { w.sw.pos = null; w.wait = 40 + Math.random() * 50; return; }   // gone past, out of sight
    w.c.visible = true;
    w.c.set(orient(w.sw.pos, w.sw.dir, Math.sin(t * 0.2) * 0.06), dt, 0.55);
    w.c.draws(D);
    { const beat = Math.sin(w.c.animT * 2.4);                          // 31 m of whale: a big, slow fluke vortex
      this.wakeFrom(v3.sub(w.sw.pos, v3.scale(w.sw.dir, 31 * 0.47)), w.sw.dir, P, t, dt, { key: 'whale', R: 14, rc: 4.5, v: 1.6 * clamp(w.sw.speed / 1.6, 0.5, 2), L: 40, sgn: beat >= 0 ? 1 : -1, pulse: 0.5 + 0.5 * Math.abs(beat) }); }
    // song swells with proximity (audible well beyond sight), calls now and then
    const pan = v3.dot(v3.norm(rel), [cm[0], cm[1], cm[2]]);
    const prox = nearVol(d, 12, 45);
    if (w.snd) w.snd.set(0.95 * prox, pan * 0.7, 0, w.sw.pos);
    w.callT -= dt;
    if (w.callT <= 0) {
      w.callT = 6 + Math.random() * 8;
      const n = ['humpback_call', 'humpback_song', 'humpback_haunt', 'humpback_baleines'][(Math.random() * 4) | 0];
      if (prox > 0.02) this.A.play(n, 0.9 * prox, { pan: pan * 0.7, pos: w.sw.pos, rate: 0.85 + Math.random() * 0.2 });
    }
    // a 14 m animal pushes water as it passes close
    if (d < 35) this.push = v3.add(this.push || [0, 0, 0], v3.scale(v3.norm([-rel[0], 0, -rel[2]]), (w.close ? 0.9 : 0.25) * (1 - d / 35)));
    if (w.close && !w.closestDone && ahead > -2) { w.closestDone = true; this.A.play('whoosh_deep', 1.0, { rate: 0.32, pan: pan * 0.8, pos: w.sw.pos }); this.A.play('humpback_call', 0.9, { pan: pan * 0.6, pos: w.sw.pos, rate: 0.8 }); }
    if (!w.close) w.closestDone = false;
  }
  whaleShow(w, dt, t, P, cm, D) {
    const E = w.ev; E.t += dt;
    const rel = v3.sub(w.sw.pos, P), d = v3.len(rel), pan = v3.dot(v3.norm(rel), [cm[0], cm[1], cm[2]]), vol = 1 - smooth(20, 120, d);
    let dir = w.sw.dir;
    const L = 31;   // 2x a real adult: a colossal humpback
    const splash = (p, n, sp, amp, loud, rad = 3.2) => {
      this.ripples.push({ x: p[0], z: p[2], age: 0, amp });
      for (let k = 0; k < n; k++) {                              // crown sheet thrown up and out all round the fluke
        const a = Math.random() * 6.28, rr = Math.random() * rad, up = 0.55 + Math.random() * 0.45;
        const out = [Math.cos(a), 0, Math.sin(a)], spd = sp * (0.35 + Math.random() * 0.9);
        if (this.spray.length < this.sprayMax) this.spray.push({ p: [p[0] + out[0] * rr, 0.1, p[2] + out[2] * rr], v: [out[0] * spd * (1 - up) * 1.6, spd * up * 1.25, out[2] * spd * (1 - up) * 1.6], r: 0.01 + Math.random() * Math.random() * 0.06, age: 0, s: Math.random(), gen: 0 });
      }
      (this.churns ||= []).push({ x: p[0], z: p[2], rate: 14000 * amp, r: rad * 0.35, grow: 1.2, age: 0, dur: 1.0 });   // churned white water boils up for ~1.4 s, then spreads with the flow
      this.foamCloud(p, Math.min(260, Math.round(n * 0.07)), rad, 4.5 * amp / 0.55);   // the fluke drives a huge cloud of air down
      // clots of white foam / spume torn off and thrown up with the spray
      for (let k = 0; k < (loud > 1 ? 0 : n * 0.18) && this.spray.length < this.sprayMax; k++) {   // (the lobtail's water is all particles: no clot sprites)
        const a = Math.random() * 6.28, spd = sp * (0.3 + Math.random() * 0.6);
        this.spray.push({ p: [p[0] + Math.cos(a) * Math.random() * rad * 0.8, 0.15, p[2] + Math.sin(a) * Math.random() * rad * 0.8], v: [Math.cos(a) * spd * 0.6, spd, Math.sin(a) * spd * 0.6], r: 0.06 + Math.random() * 0.14, age: 0, s: Math.random(), gen: 1, foam: true });
      }
      if (vol > 0.01) {
        if (loud > 1) { const v = Math.min(1.6, loud * vol * 1.2); this.A.play('slap_big', 1.6 * v, { pos: p, pan, rate: 0.8 }); this.A.play('slap_rock', 1.3 * v, { pos: p, pan, rate: 0.62 }); this.A.bio?.('slap', Math.min(1, v), pan, false, p); this.A.slice?.('surface_waves', 0.7 * vol, { dur: 2.6, rate: 0.5, pan, pos: p, att: 0.05 }); }   // the lobtail
        else { this.A.slice?.('surface_waves', loud * vol, { dur: 1.6, rate: 0.7 + Math.random() * 0.15, pan, pos: p, att: 0.01 }); this.A.play('rumble', 0.7 * loud * vol, { rate: 0.5, pan, pos: p }); }
      }
    };
    // local blowhole / back points (model: head at +Z, back crest ~1.55 m above the axis, blowhole ~3.5 m behind the snout tip)
    const pitchDir = (pt) => { const fl = v3.norm([w.sw.dir[0], 0, w.sw.dir[2]]); return v3.norm([fl[0] * Math.cos(pt), Math.sin(pt), fl[2] * Math.cos(pt)]); };
    const hole = (dd) => { const up = v3.norm(v3.cross(v3.cross(dd, [0, 1, 0]), dd)); return v3.add(w.sw.pos, v3.add(v3.scale(dd, L * 0.23), v3.scale(up[1] < 0 ? v3.scale(up, -1) : up, 3.0))); };
    if (E.st === 'rise') {                                     // swim up to the surface point, staying fully submerged
      // a long, shallow glide path: level cruise at depth, then a gentle (<= ~12 deg) climb that meets breathing depth
      // right at the surface point -- no steep pop-up, no snapping when the breath begins
      const tgt = v3.add(E.at, [0, -3.2, 0]), hd = Math.hypot(tgt[0] - w.sw.pos[0], tgt[2] - w.sw.pos[2]);
      // steer level toward the point; depth follows the glide path (rate-limited), the body pitches with its climb
      w.sw.step(dt, [tgt[0], w.sw.pos[1], tgt[2]], hd > 30 ? 3.5 : 2.0, 0.3, null);
      w.sw.dir = v3.norm([w.sw.dir[0], 0, w.sw.dir[2]]);
      const y0 = w.sw.pos[1], yWant = tgt[1] - Math.max(0, hd - 4) * 0.19;
      w.sw.pos[1] = Math.min(-4.2, y0 + clamp(yWant - y0, -0.7 * dt, 0.7 * dt));
      E.vy = lerp(E.vy || 0, (w.sw.pos[1] - y0) / Math.max(dt, 1e-3), 1 - Math.exp(-dt * 2));
      E.pitch = Math.atan2(E.vy, Math.max(0.5, w.sw.speed));
      dir = v3.norm([w.sw.dir[0] * Math.cos(E.pitch), Math.sin(E.pitch), w.sw.dir[2] * Math.cos(E.pitch)]);
      const past = v3.dot([tgt[0] - w.sw.pos[0], 0, tgt[2] - w.sw.pos[2]], w.sw.dir) < 0;
      if (hd < 7 || past || E.t > 45) { E.st = 'blow'; E.t = 0; E.blown = 0; E.cyc = 0; E.y0 = w.sw.pos[1]; }
    } else if (E.st === 'blow') {
      // a real humpback breath: it glides just under the surface, the blowhole breaks the water and it exhales
      // explosively (a bushy 4–5 m column + drifting mist), then the back rolls forward and only a low arch of back
      // and the dorsal hump shows before it slips under again.  Three breaths ~6.5 s apart.
      const T = 6.5, k = Math.floor(E.t / T), ph = (E.t % T) / T;
      if (k !== E.cyc) { E.cyc = k; E.puffed = false; }
      const up = smooth(0.0, 0.3, ph) * (1 - smooth(0.62, 0.95, ph));      // how far the back is lifted
      const yC = lerp(-4.0, -2.75, up);                                      // back crest (3.1 m above the axis) -0.9 m -> ~+0.35 m: a low arch
      // turn broadside and cruise across the diver's view (never straight into the diver), ~20–25 m off
      { const toW = v3.norm([w.sw.pos[0] - P[0], 0, w.sw.pos[2] - P[2]]), tan0 = [-toW[2], 0, toW[0]];
        const tan = v3.dot(tan0, w.sw.dir) >= 0 ? tan0 : v3.scale(tan0, -1);
        const dW = Math.hypot(w.sw.pos[0] - P[0], w.sw.pos[2] - P[2]);
        const want = v3.norm(v3.add(tan, v3.scale(toW, clamp((36 - dW) * 0.08, -0.5, 0.6))));   // hold the range
        const fl = v3.norm([w.sw.dir[0], 0, w.sw.dir[2]]), cr = fl[0] * want[2] - fl[2] * want[0];
        const ang = clamp(Math.atan2(cr, v3.dot(fl, want)), -0.14 * dt, 0.14 * dt), c = Math.cos(ang), sn = Math.sin(ang);
        w.sw.dir = [fl[0] * c - fl[2] * sn, 0, fl[0] * sn + fl[2] * c]; }
      w.sw.pos = v3.add(w.sw.pos, v3.scale(v3.norm([w.sw.dir[0], 0, w.sw.dir[2]]), 1.8 * dt));
      w.sw.pos[1] = lerp(w.sw.pos[1], yC, 1 - Math.exp(-dt * (k === 0 && ph < 0.3 ? 1.2 : 3)));
      // head up while surfacing, then the body rolls forward (nose down) so the arch travels back along the body
      E.pitch = lerp(E.pitch, 0.03 * (1 - smooth(0.25, 0.45, ph)) - 0.05 * smooth(0.4, 0.8, ph) * (1 - smooth(0.9, 1.0, ph)), 1 - Math.exp(-dt * 2.5));
      // the roll-through is a flex of the body: the head tucks and the back humps (both ends down), then a slow, weak
      // fluke stroke (tail stock down, fluke trailing) pushes it on under -- all through the spine, not a rigid tilt
      { const arch = 0.14 * smooth(0.35, 0.6, ph) * (1 - smooth(0.75, 0.95, ph));
        const stroke = Math.sin(clamp((ph - 0.72) / 0.28, 0, 1) * Math.PI);
        const bt = [arch * 0.9, -arch * 0.5, -arch * 0.7, -arch * 0.5 - 0.1 * stroke, -0.18 * stroke, 0.12 * stroke];
        w.bendV = w.bendV.map((b, k) => lerp(b, bt[k], 1 - Math.exp(-dt * 2.2))); }
      dir = pitchDir(E.pitch);
      const bh = hole(dir);
      if (!E.puffed && E.blown < 3 && ph > 0.2 && bh[1] > -0.12) {
        E.puffed = true; E.blown++;
        // explosive exhalation: dense core jet + bushy spreading plume of droplets falling back as a light rain
        for (let k2 = 0; k2 < 480; k2++) {
          if (this.spray.length >= this.sprayMax) break;
          const a = Math.random() * 6.28, rr = Math.random() * 0.18, core = Math.random() < 0.45, sp = core ? 0.2 + Math.random() * 0.6 : 0.6 + Math.random() * 1.8;
          this.spray.push({ p: [bh[0] + Math.cos(a) * rr, Math.max(bh[1], 0) + 0.1, bh[2] + Math.sin(a) * rr], v: [Math.cos(a) * sp + 0.5, (core ? 10.5 : 7.5) + Math.random() * 3.5, Math.sin(a) * sp + 0.2], r: 0.006 + Math.random() * Math.random() * 0.03, age: Math.random() * 0.15, s: Math.random() });
        }
        // condensed breath: a cloud of fine mist that billows out at the top and drifts downwind for several seconds
        for (let k2 = 0; k2 < 130; k2++) {
          if (this.spray.length >= this.sprayMax) break;
          const a = Math.random() * 6.28, sp = 0.3 + Math.random() * 1.4, h = Math.random();
          this.spray.push({ p: [bh[0] + Math.cos(a) * 0.15, Math.max(bh[1], 0) + 0.2, bh[2] + Math.sin(a) * 0.15], v: [Math.cos(a) * sp * (0.5 + h), 2.5 + h * 5.5, Math.sin(a) * sp * (0.5 + h)], r: 0.2 + Math.random() * 0.3, age: 0, s: Math.random(), gen: 1, mist: true });
        }
        this.ripples.push({ x: bh[0], z: bh[2], age: 0, amp: 0.08 });
        this.foamEmit.push({ x: bh[0], z: bh[2], rate: 3000, r: 1.4, vx: dir[0] * 1.3, vz: dir[2] * 1.3 });
        if (vol > 0.01) { this.A.bio?.('bigblow', 0.9 * vol, pan, false, bh); this.A.play('whoosh_deep', 0.6 * vol, { rate: 0.6, pan, pos: bh }); }
      }
      // water sheeting off the back while it is out: a thin wash of foam along the arch
      if (up > 0.6) { const bk = v3.add(w.sw.pos, v3.scale(dir, -L * 0.05)); this.foamEmit.push({ x: bk[0], z: bk[2], rate: 1200, r: 2.6, vx: dir[0] * 1.3, vz: dir[2] * 1.3 }); }
      if (E.t > T * 3) { E.st = 'lob'; E.t = 0; }
    } else if (E.st === 'lob') {
      // one lobtail.  The whale tips only moderately head-down; the lift comes from the spine itself arching, so the
      // tail stock and fluke curl up out of the water (~3 m) while the body stays under.  A pause at the top, then the
      // whole rear of the body whips down through the curve and slams the fluke flat onto the surface -- and it dives.
      const hold = 5.2, up = E.t < hold;
      // wind-up with momentum: it keeps swimming forward and noses down into the water, so the body travels along the
      // arc (the peduncle arches up behind a diving head) instead of pivoting on the spot.  Pitch and spine bend are
      // damped springs: they ease in, build and settle.  The downstroke is a stiff spring (a violent whip).
      const spring = (x, v, target, k) => { const c = 2 * Math.sqrt(k); v += (k * (target - x) - c * v) * dt; return [x + v * dt, v]; };
      const bt = up ? [0.22, 0.14, 0.26, 0.34, 0.3, 0.12].map((x) => x * smooth(0.3, 2.6, E.t) * (1 + 0.08 * smooth(4, hold, E.t))) : [0.1, -0.08, -0.12, -0.16, -0.18, -0.3];
      E.bv = E.bv || [0, 0, 0, 0, 0, 0];
      w.bendV = w.bendV.map((b, k) => { const r = spring(b, E.bv[k], bt[k], up ? 1.6 : 70); E.bv[k] = r[1]; return r[0]; });
      { const r = spring(E.pitch, E.pv || 0, up ? -0.5 * smooth(0, 2.2, E.t) : -0.42, up ? 1.3 : 12); E.pitch = r[0]; E.pv = r[1]; }
      const flat = v3.norm([w.sw.dir[0], 0, w.sw.dir[2]]);
      dir = v3.norm([flat[0] * Math.cos(E.pitch), Math.sin(E.pitch), flat[2] * Math.cos(E.pitch)]);
      // forward momentum along the (pitched) body axis, bleeding off as the tail comes up and stalls at the top
      E.fv = lerp(E.fv ?? 1.8, up ? lerp(1.7, 0.2, smooth(0.5, 4.0, E.t)) : 0.4, 1 - Math.exp(-dt * 1.2));
      w.sw.pos = v3.add(w.sw.pos, v3.scale(dir, E.fv * dt));
      // fluke tip from the posed skeleton (previous frame); a gentle depth trim keeps it ~5.5 m up at the top
      const G = w.c.pose?.global, fb = G && G[w.flukeNode], tb = G && G[w.tailNode];
      let tip = v3.sub(w.sw.pos, v3.scale(dir, L * 0.47));
      if (fb && tb) { const f = [fb[12], fb[13], fb[14]], tl = [tb[12], tb[13], tb[14]]; tip = v3.add(f, v3.scale(v3.norm(v3.sub(f, tl)), 2.8)); }
      if (up && E.t > 2.5) w.sw.pos[1] = clamp(w.sw.pos[1] + clamp(5.5 - tip[1], -1, 1) * dt * 0.35, -14, -3.5);
      if (!E.slapped && !up && (E.lastTip ?? tip[1]) > 0.3 && tip[1] <= 0.3) {
        E.slapped = true; E.slaps = 1;
        const H = this.flukeSplash(w, L, 360000);                                    // ~10x the water, bursting over the fluke's whole area
        const cen = H ? v3.add(H.root, v3.scale(H.df, H.chord * 0.6)) : [tip[0], 0, tip[2]];
        splash(cen, 2400, 16, 0.9, 1.6, H ? H.span : 11.0);                          // sound, rings, foam clots, underwater air, churn
        if (H) for (const sg of [-1, 1]) {                                            // white water boils up along the whole span
          const q = v3.add(cen, v3.scale(H.lat, sg * H.span * 0.6));
          (this.churns ||= []).push({ x: q[0], z: q[2], rate: 12000, r: H.span * 0.3, grow: 1.0, age: 0, dur: 1.0 });
          this.foamCloud(q, 120, H.span * 0.35, 5);
        }
        this.startle = Math.max(this.startle || 0, 0.6); this.buffet = Math.max(this.buffet || 0, 0.8 * (1 - smooth(15, 60, d)));
        E.st = 'dive'; E.t = 0; E.afterSlap = true;
      }
      E.lastTip = tip[1];
      if (E.t > 12 && !E.slapped) { E.st = 'dive'; E.t = 0; }
    } else {                                                   // sound down
      // after the slam it drives itself down with big, slow fluke strokes (a bending wave running chest -> flukes),
      // picks up speed with inertia, steepens briefly then levels into a cruise -- no rigid glide at a fixed angle
      const tgtPitch = E.afterSlap ? -0.62 + 0.5 * smooth(4, 12, E.t) : -1.25;   // noses down steeply first so the flukes follow under
      E.pitch = lerp(E.pitch, tgtPitch, 1 - Math.exp(-dt * (E.afterSlap ? 1.2 : 1.2)));
      E.spd = lerp(E.spd ?? 0.6, E.t < 5 ? 2.8 : 2.2, 1 - Math.exp(-dt * 0.7));
      const thrust = (0.55 + 0.45 * (1 - smooth(3, 10, E.t))) * 0.7 * smooth(0.6, 2.2, E.t), om = 6.2831853 * (0.32 + 0.1 * thrust);
      E.ph = (E.ph || 0) + om * dt;
      const amp = [0.015, 0.025, 0.04, 0.06, 0.085, 0.12];
      w.bendV = w.bendV.map((b, k) => lerp(b, amp[k] * thrust * Math.sin(E.ph - k * 0.55), 1 - Math.exp(-dt * 4)));
      const flat = v3.norm([w.sw.dir[0], 0, w.sw.dir[2]]);
      dir = v3.norm([flat[0] * Math.cos(E.pitch), Math.sin(E.pitch), flat[2] * Math.cos(E.pitch)]);
      w.sw.pos = v3.add(w.sw.pos, v3.scale(dir, E.spd * dt));
      const tip = v3.sub(w.sw.pos, v3.scale(dir, L * 0.47));
      if (!E.afterSlap && (E.lastTip ?? -1) > 0 && tip[1] <= 0) splash(tip, 120, 3, 0.18, 0.6);
      E.lastTip = tip[1];
      // hand over to the ordinary cruise with the SAME heading/pitch/speed/depth: no snap, it just swims on
      if (E.t > 14) { w.ev = null; w.sw.dir = dir; w.sw.speed = E.spd; w.passDir = flat; w.passY = w.sw.pos[1]; w.wait = 120; }
    }
    w.c.visible = true;
    w.c.set(orient(w.sw.pos, dir, 0), dt, E.st === 'lob' ? 0.15 : E.st === 'dive' ? 0.2 : 0.5);   // lobtail / dive: the spine drives the motion, the swim clip idles
    w.c.draws(D);
    this.wakeFrom(v3.sub(w.sw.pos, v3.scale(dir, L * 0.47)), dir, P, t, dt, { key: 'whale', R: 14, rc: 4.5, v: E.st === 'dive' ? 2.2 : 1.2, L: 40, sgn: 1, pulse: E.st === 'dive' ? 0.6 + 0.4 * Math.abs(Math.sin(E.ph || 0)) : 0.6 });
    const prox = nearVol(d, 15, 60);
    if (w.snd) w.snd.set(0.8 * prox, pan * 0.7, 0, w.sw.pos);
    return true;
  }
  startSwarm(P, t) {
    const S = this.swarm, a = Math.random() * 6.28;
    S.center = this.hiddenSpawn(P, 18, 1, [-70, -4]); S.cvel = [0, 0, 0]; S.t = 0; S.active = true; S.leaving = false;
    for (let i = 0; i < S.n; i++) {
      const u = Math.random() * 6.28, v = Math.acos(2 * Math.random() - 1), r = 3 + Math.random() * 4;
      S.pos[i * 3] = S.center[0] + Math.sin(v) * Math.cos(u) * r; S.pos[i * 3 + 1] = S.center[1] + Math.cos(v) * r * 0.6; S.pos[i * 3 + 2] = S.center[2] + Math.sin(v) * Math.sin(u) * r;
      S.vel[i * 3] = -Math.sin(u) * 1.5; S.vel[i * 3 + 1] = 0; S.vel[i * 3 + 2] = Math.cos(u) * 1.5;
    }
  }
  // bait ball / murmuration: swirl + breathing shell + travelling waves, parts around the diver; every fish is physically steered
  updateSwarm(dt, t, P, cm, depth) {
    const S = this.swarm;
    if (!S.active) { S.count = 0; return; }
    S.t += dt;
    if (S.t > 100 || depth > 80) S.leaving = true;
    // centre drifts around the diver (or away when the event ends)
    const ang = S.t * 0.08;
    const goal = S.leaving ? v3.add(S.center, v3.scale(v3.norm(v3.sub(S.center, P)), 20)) : [P[0] + Math.cos(ang) * 11, clamp(P[1] + 1.5 + Math.sin(S.t * 0.13) * 2, -70, -6), P[2] + Math.sin(ang) * 11];
    const to = v3.sub(goal, S.center), tl = v3.len(to);
    S.cvel = v3.lerp(S.cvel, v3.scale(v3.norm(to), Math.min(S.leaving ? 3 : 1.4, tl * 0.4)), 1 - Math.exp(-dt * 0.4));
    S.center = v3.add(S.center, v3.scale(S.cvel, dt));
    if (S.leaving && this.outOfSight(S.center, P, 14)) { S.active = false; S.count = 0; return; }
    const C = S.center, R0 = 5.5 + 1.8 * Math.sin(S.t * 0.35) + 1.2 * Math.sin(S.t * 0.83 + 1);   // breathing radius
    const spin = Math.sin(S.t * 0.07) > -0.3 ? 1 : -1;                   // occasional reversal of the swirl
    const des = [0, 0, 0], vv = [0, 0, 0];
    for (let i = 0; i < S.n; i++) {
      const o = i * 3, px = S.pos[o], py = S.pos[o + 1], pz = S.pos[o + 2];
      let dx = px - C[0], dy = py - C[1], dz = pz - C[2];
      const rh = Math.hypot(dx, dz) || 1e-3, r3 = Math.hypot(dx, dy * 1.6, dz) || 1e-3;
      const ph = S.ph[i];
      // swirl around the vertical axis + pull toward a shell of radius R (layered by fish index)
      const Ri = R0 * (0.55 + 0.45 * ((i * 0.618) % 1));
      const pull = (Ri - r3) * 0.9;
      const sw = 1.6 + 0.4 * Math.sin(ph);
      des[0] = (-dz / rh) * sw * spin + dx / r3 * pull + S.cvel[0];
      des[2] = (dx / rh) * sw * spin + dz / r3 * pull + S.cvel[2];
      des[1] = dy / r3 * pull * 0.6 + Math.sin(S.t * 0.9 + rh * 0.5 + ph * 0.2) * 0.5 + S.cvel[1] - dy * 0.15;
      // flee the diver: open a hole / split the ball
      const ex = px - P[0], ey = py - P[1], ez = pz - P[2], ed = Math.hypot(ex, ey, ez) || 1e-3;
      if (ed < 5) { const k = (5 - ed) * 2.2 / ed; des[0] += ex * k; des[1] += ey * k; des[2] += ez * k; }
      let fl = 0;
      for (const pr of this.predators) {
        const qx = px - pr.p[0], qy = py - pr.p[1], qz = pz - pr.p[2], qd = Math.hypot(qx, qy, qz);
        if (qd < pr.r + 2 && qd > 1e-3) { const k = (pr.r + 2 - qd) / (pr.r + 2) * 9 / qd; des[0] += qx * k; des[1] += qy * k * 0.6; des[2] += qz * k; fl = 1; }
      }
      vv[0] = S.vel[o]; vv[1] = S.vel[o + 1]; vv[2] = S.vel[o + 2];
      const acc = fl ? steer(vv, des, dt, 22, 10, 0.7, 6.5) : steer(vv, des, dt, 7.0, 4.5, 0.7, 4.0);
      S.vel[o] = vv[0]; S.vel[o + 1] = vv[1]; S.vel[o + 2] = vv[2];
      S.pos[o] = px + vv[0] * dt; S.pos[o + 1] = Math.min(py + vv[1] * dt, -0.6); S.pos[o + 2] = pz + vv[2] * dt;
      // bank into the turn (lateral acceleration), smoothed
      const sp = Math.hypot(vv[0], vv[2]) || 1e-3;
      const lat = ((des[2] - vv[2]) * vv[0] - (des[0] - vv[0]) * vv[2]) / sp;
      S.roll[i] = lerp(S.roll[i], clamp(-lat * 0.25, -0.7, 0.7), 1 - Math.exp(-dt * 4));
      instMat(S.inst, i * 16, [S.pos[o], S.pos[o + 1], S.pos[o + 2]], vv, S.roll[i], (S.sz || (S.sz = Float32Array.from({ length: S.n }, () => (Math.random() < 0.35 ? 0.78 : 1.08) * sizeVar(0.17))))[i], ph, 0.8 + Math.hypot(vv[0], vv[1], vv[2]) * 0.4);
    }
    S.count = S.n;
    this.R.device.queue.writeBuffer(S.obj.sb, 0, S.inst);
    this.draws.push({ gm: S.mesh.gm, mat: S.mesh.mat, obj: S.obj, kind: 'inst', instances: S.n, shadow: false });
    // the rush of thousands of tails when the ball sweeps close
    const d = v3.dist(C, P);
    S.rushT = (S.rushT || 0) - dt;
    if (d < 12 && S.rushT <= 0) { S.rushT = 2.5 + Math.random() * 2; this.A.play('whoosh_move', 0.35 * (1 - d / 12) + 0.1, { rate: 1.2 + Math.random() * 0.3 }); }
  }
  // cutlassfish stand head-up, swaying; drift away slowly when the diver comes close; distance-based despawn
  updateCutlass(dt, t, P, depth, D) {
    for (const C of this.cutlassGroups) {
      const inZone = depth > C.zone[0] && depth < C.zone[1], vis = visRange(depth) + 8;
      if (!C.center) {
        if (!inZone) continue;
        C.center = this.hiddenSpawn(P, 16, -12, [-C.zone[1] + 5, -C.zone[0] - 2]);   // behind and below, out of view: the diver sinks into them
        C.fish.forEach((f) => { f.p = v3.add(C.center, f.off); f.v = [0, 0, 0]; });
      }
      if (v3.dist(C.center, P) > vis) { C.center = null; continue; }
      for (let i = 0; i < C.n; i++) {
        const f = C.fish[i];
        const home = v3.add(C.center, f.off);
        const e = v3.sub(f.p, P), ed = v3.len(e);
        const flee = ed < 4 ? v3.scale(v3.norm([e[0] * 0.5, e[1] + (e[1] >= 0 ? 1 : -1), e[2] * 0.5]), (4 - ed) * 0.35) : [0, 0, 0];
        const des = v3.add(v3.scale(v3.sub(home, f.p), 0.08), v3.add(flee, [0, Math.sin(t * 0.4 + f.ph) * 0.05, 0]));
        f.v = v3.lerp(f.v, des, 1 - Math.exp(-dt * 1.2));
        f.p = v3.add(f.p, v3.scale(f.v, dt));
        // sway: a slow wave travelling through the group (sync) mixed with each fish's own rhythm
        const wave = t * 0.35 - (f.off[0] + f.off[2]) * 0.18 * C.sync + f.ph * (1 - C.sync);
        const sway = Math.sin(wave) * C.swayAmp;
        const swayYaw = C.sync > 0.5 ? 0.6 : f.yaw;                 // the forest leans the same way as the wave passes
        vertMat(C.inst, i * 16, f.p, C.sync > 0.5 ? swayYaw : f.yaw + Math.sin(t * 0.1 + f.ph) * 0.05, f.tilt + sway, 0, f.sc, f.ph, 0.5 + v3.len(f.v) * 2);
        if (C.sync <= 0.5) f.yaw += Math.sin(t * 0.1 + f.ph) * 0.05 * dt;
      }
      this.R.device.queue.writeBuffer(C.obj.sb, 0, C.inst);
      D.push({ gm: C.mesh.gm, mat: C.mesh.mat, obj: C.obj, kind: 'inst', instances: C.n, shadow: true });
    }
  }
  startSquadron(P) {
    const Q = this.squad, a = Math.random() * 6.28, vis = 60;
    const dir = [Math.cos(a), 0, Math.sin(a)];
    Q.lead = new Swimmer(); Q.lead.turnCap = 0.4; Q.lead.pos = v3.add(P, [-dir[0] * vis + dir[2] * 3, 7, -dir[2] * vis - dir[0] * 3]); Q.lead.dir = dir; Q.lead.speed = 1.6;
    Q.path = dir; Q.active = true; Q.t = 0;
    Q.mantas.forEach((m) => { m.pos = null; m.vel = v3.scale(dir, 1.6); });
  }
  // manta squadron: leader glides over the diver, wingmen hold a loose V with turn-limited steering
  updateSquadron(dt, t, P, depth, D) {
    const Q = this.squad;
    if (!Q.active) { Q.mantas.forEach((m) => (m.c.visible = false)); return; }
    Q.t += dt;
    const L = Q.lead, vis = visRange(depth);
    const tgt = v3.add(L.pos, v3.scale(Q.path, 20)); tgt[1] = clamp(P[1] + 6 + Math.sin(Q.t * 0.2) * 1.5, -150, -4);
    L.step(dt, tgt, 1.7, 0.2, this.avoid(L.pos, 6, 'sq-lead', 4));
    const f = L.dir, r = v3.norm(v3.cross([0, 1, 0], f)), u = [0, 1, 0];
    for (const m of Q.mantas) {
      const slot = v3.add(L.pos, v3.add(v3.add(v3.scale(r, m.slot[0]), v3.scale(u, m.slot[1] + Math.sin(t * 0.3 + m.slot[0]) * 0.4)), v3.scale(f, m.slot[2])));
      if (!m.pos) m.pos = [...slot];
      const des = v3.add(v3.add(v3.scale(v3.sub(slot, m.pos), 0.8), v3.scale(f, L.speed)), v3.scale(this.avoid(m.pos, 2.3, 'sq' + Q.mantas.indexOf(m), 2.5), 3.0));
      steer(m.vel, des, dt, 1.2, 0.6, 0.8, 2.6);
      m.pos = v3.add(m.pos, v3.scale(m.vel, dt));
      const lat = v3.dot(v3.sub(des, m.vel), v3.cross(u, v3.norm(m.vel)));
      m.bank = lerp(m.bank || 0, clamp(-lat * 0.4, -0.45, 0.45), 1 - Math.exp(-dt * 1.5));
      m.c.visible = true;
      m.c.set(orient(m.pos, m.vel, m.bank), dt, m.anim);
      m.c.draws(D);
    }
    if (v3.dot(v3.sub(L.pos, P), Q.path) > vis + 15) Q.active = false;   // passed by and out of sight
  }
  updateSunfish(dt, t, P, depth, D) {
    const f = this.sunfish, on = depth < 60 && depth > 1, vis = visRange(depth);
    if (!f.sw) { f.sw = new Swimmer(); f.sw.turnCap = 0.3; }
    if (!f.sw.pos) {
      if (!on) { f.c.visible = false; return; }
      f.sw.spawnAt(this.hiddenSpawn(P, f.seen ? vis + 5 : 20, 2, [-55, -2]), P); f.seen = true; f.ang = Math.random() * 6.28;
    }
    f.c.visible = true;
    // slow drift around the diver; basks on its side near the surface when the diver is shallow
    f.ang += dt * 0.35 / 14;
    const tgt = on ? [P[0] + Math.cos(f.ang) * 11, clamp(P[1] + 1.5, -55, -2), P[2] + Math.sin(f.ang) * 11] : null;
    const far = tgt ? v3.dist(f.sw.pos, tgt) : 0;
    f.sw.step(dt, tgt, far > 15 ? 1.2 : Math.min(0.45, far * 0.3 + 0.05), 0.3, this.avoid(f.sw.pos, 1.4, 'sun', 3));
    f.pos = f.sw.pos; f.dir = f.sw.dir;
    if (!on && this.outOfSight(f.pos, P, 3)) { f.sw.pos = null; f.c.visible = false; return; }
    f.roll = lerp(f.roll || 0, 0.06 * Math.sin(t * 0.25), 1 - Math.exp(-dt * 0.3));   // upright: dorsal fin up, anal fin down
    f.c.set(orient(f.pos, [f.dir[0], 0, f.dir[2]], f.roll), dt, 0.25);   // very slow fin strokes (~8 s)
    f.c.draws(D);
  }

  updateTurtle(dt, t, P, cm, depth, D) {
    const tu = this.turtle, on = depth > 180 && depth < 420;
    if (!on && !tu.active) { tu.c.visible = false; if (tu.snd) tu.snd.set(0, 0); if (tu.turb) tu.turb.set(0, 0); return; }
    if (!tu.snd && this.A.ctx) tu.snd = this.A.presence('rumble', 0.45);
    if (!tu.active) {
      tu.wait -= dt; tu.c.visible = false; if (tu.snd) tu.snd.set(0, 0); if (tu.turb) tu.turb.set(0, 0);
      if (tu.wait > 0 || !on || this.stageBusy('turtle')) return;
      // new pass: 60 m body / 63 m flipper span -> centre line 44–50 m to the side, slightly above eye level so it
      // crosses the (horizontal-look) field of view; the nearest flipper tip stays ~12 m away
      const a = Math.random() * 6.28, dir = [Math.cos(a), 0, Math.sin(a)], side = [-dir[2], 0, dir[0]];
      // close pass: centre line 36–38 m to the side (half flipper span 31 m) -> the nearest flipper tip sweeps by ~5 m
      // away at about eye level; the head and shell fill the view as it slides past
      const off = (Math.random() < 0.5 ? -1 : 1) * (this.cineClose ? 33.4 + Math.random() * 0.8 : 36 + Math.random() * 2);   // cinematic: flipper tip ~2.5 m
      tu.dir = dir; tu.side = side; tu.off = off; tu.dy = this.cineClose ? 0.5 + Math.random() : 1 + Math.random() * 2; tu.offAdj = 0; tu.phase = 0;
      tu.s = -150; tu.active = true; tu.closest = false; tu.lastFlap = 0; tu.startled = false;
    }
    tu.s += dt * 3.0;
    if (tu.s > 150) { tu.active = false; tu.wait = 40 + Math.random() * 40; return; }
    // path is anchored to the diver horizontally at spawn time but follows the diver's depth smoothly
    if (!tu.anchor || tu.s < -149) tu.anchor = [P[0], P[2]];
    if (on) tu.y = tu.y === undefined ? P[1] + tu.dy : lerp(tu.y, P[1] + tu.dy, 1 - Math.exp(-dt * 0.15));
    if (!on && v3.dist([tu.anchor[0] + tu.dir[0] * tu.s, tu.y, tu.anchor[1] + tu.dir[2] * tu.s], P) > visRange(depth) + 40) { tu.active = false; tu.wait = 10; return; }
    // keep-out: if the diver swims into the colossus' swept volume (ellipsoid around body + flipper sweep), it veers away
    {
      const o = tu.off + (tu.offAdj || 0);
      const c = [tu.anchor[0] + tu.dir[0] * tu.s + tu.side[0] * o, tu.y, tu.anchor[1] + tu.dir[2] * tu.s + tu.side[2] * o];
      const r = v3.sub(P, c);
      const lx = v3.dot(r, tu.side), ly = r[1], lz = v3.dot(r, tu.dir);
      const e = Math.hypot(lx / (this.cineClose ? 31.5 : 33.5), ly / 14, lz / 36);
      if (e < 1) tu.offAdj = (tu.offAdj || 0) - Math.sign(lx || tu.off) * (1 - e) * 14 * dt;
    }
    const offNow = tu.off + (tu.offAdj || 0);
    const pos = [tu.anchor[0] + tu.dir[0] * tu.s + tu.side[0] * offNow, tu.y + Math.sin(t * 0.12) * 1.5, tu.anchor[1] + tu.dir[2] * tu.s + tu.side[2] * offNow];
    tu.c.visible = true;
    tu.c.set(orient(pos, [tu.dir[0], Math.sin(t * 0.12) * 0.05, tu.dir[2]], Math.sin(t * 0.1) * 0.05, this.TURTLE_SCALE), dt, this.TURTLE_ANIM);
    tu.c.draws(D);
    // ---- sound ----
    const rel = v3.sub(pos, P), d = v3.len(rel);
    const surfD = Math.max(d - 26, 0);                                   // ~distance to the nearest part of the animal
    const prox = nearVol(surfD, 6, 55);
    const pan = v3.dot(v3.norm(rel), [cm[0], cm[1], cm[2]]);
    const radial = v3.dot(v3.norm(rel), tu.dir) * -3.0;               // approaching -> slightly higher pitch
    if (tu.snd) tu.snd.set(1.25 * prox, pan * 0.8, 0.45 * (1 + radial * 0.02));
    const dur = this.sp.turtle.model.anims[this.sp.turtle.anim]?.dur || 2.54;
    const flap = Math.sin((tu.c.animT % dur) / dur * Math.PI * 2);
    if (tu.lastFlap > 0 && flap <= 0 && prox > 0.08) {                // flipper downstroke (from the swim clip)
      this.A.play('whoosh_deep', 1.1 * prox, { rate: 0.26 + Math.random() * 0.05, pan: pan * 0.7 });
      this.A.play('creature_move', 0.7 * prox, { rate: 0.33, pan: pan * 0.7 });
      this.A.play('rumble', 0.6 * prox, { rate: 0.4 + Math.random() * 0.05, pan: pan * 0.6 });
    }
    tu.lastFlap = flap;
    // startle: the first time the colossus looms close in the dark
    if (!tu.startled && surfD < 28) { tu.startled = true; this.startle = 1; this.A.gasp?.(); }
    if (!tu.closest && tu.s > -10) {
      tu.closest = true;
      this.A.play('whoosh_move', 1.0, { rate: 0.3, pan: pan * 0.6 }); this.A.play('rumble', 1.0, { rate: 0.55, pan: pan * 0.5 });
    }
    // ---- trailing tip vortex from the near fore-flipper (axis = swim direction, like a wingtip vortex) ----
    const sgn = Math.sign(v3.dot(v3.sub(P, pos), tu.side)) || 1;
    const tip = v3.add(pos, v3.add(v3.scale(tu.side, sgn * 29), [0, -2 * flap, 0]));
    const R = 13, rc = 5, Lw = 35;                                          // influence radius, core radius, wake length (m)
    const r = v3.sub(P, tip), u = v3.dot(r, tu.dir), rp = v3.sub(r, v3.scale(tu.dir, u)), dp = v3.len(rp);
    const win = smooth(6, -2, u) * Math.exp(Math.min(u, 0) / Lw);
    const stroke = 0.65 + 0.7 * Math.max(0, -flap);
    // Lamb–Oseen swirl speed at the diver (peaks ≈ 1.8 m/s at the core edge)
    const vth = (dp > 1e-3 ? 3.2 * rc / dp * (1 - Math.exp(-(dp * dp) / (rc * rc))) : 0) * win * stroke * smooth(R * 2.2, R * 0.6, dp);
    const tang = dp > 1e-3 ? v3.scale(v3.norm(v3.cross(v3.scale(tu.dir, sgn), rp)), vth) : [0, 0, 0];
    const churn = [Math.sin(t * 2.7) + Math.sin(t * 4.1 + 1.3) * 0.5, Math.sin(t * 3.3 + 2) * 0.6, Math.cos(t * 2.9) + Math.sin(t * 5.3) * 0.4];
    this.push = v3.add(this.push, v3.add(v3.scale(tang, 1.3), v3.scale(churn, vth * 0.45)));
    this.buffet = Math.max(this.buffet || 0, clamp(vth / 1.8, 0, 1));
    // flakes swirl: phase accumulates while the vortex is strong near the diver's surroundings
    tu.phase = (tu.phase || 0) + dt * 0.55 * stroke * smooth(90, 20, d);
    this.wake = { o: tip, ax: v3.scale(tu.dir, sgn), phase: tu.phase, R: R * 1.2, jit: 0.25 + 0.35 * Math.max(0, -flap), L: Lw }; this.wakeBest = 1e9;
    if (!tu.turb && this.A.ctx) tu.turb = this.A.turbulence();
    if (tu.turb) tu.turb.set(1.4 * clamp(vth / 1.8, 0, 1) + 0.25 * prox * win, pan * 0.5, clamp(vth / 1.8, 0, 1));
  }

  updateSpecimens(dt, t, P, depth, D) {
    const vis = visRange(depth);
    for (const s of this.specimens) {
      const sd = s.sd, on = depth > sd.band[0] && depth < sd.band[1];
      if (!s.sw) { s.sw = new Swimmer(); s.sw.turnCap = 0.6; }
      if (!s.sw.pos) {
        if (!on) { s.c.visible = false; continue; }
        let p = this.hiddenSpawn(P, s.seen ? vis + 3 : 4 + Math.random() * 12, (Math.random() - 0.5) * 4);
        if (sd.mode !== 'swim') p = [p[0], floorH(p[0], p[2]) + (sd.mode === 'hover' ? 0.3 + Math.random() * 0.5 : 0.02), p[2]];
        if (sd.mode === 'swim' && this.cineClose && s.i === 0) { const f = v3.norm([this.camFwd[0], 0, this.camFwd[2]]); p = v3.add(P, v3.add(v3.scale([-f[2], 0, f[0]], 6), v3.scale(f, 2))); }   // just outside the view, then it swims in
        s.sw.spawnAt(p, P); s.seen = true; s.yaw = Math.random() * 6.28; s.tgt = null;
      }
      s.t -= dt;
      let dir;
      if (sd.mode === 'floor') {
        // sit still on the sediment, now and then shuffle a short way (searobins 'walk' on their fin rays)
        if (s.t <= 0) { s.t = 6 + Math.random() * 14; s.move = sd.speed > 0 && Math.random() < 0.5 ? 1.5 + Math.random() * 2 : 0; s.yaw += (Math.random() - 0.5) * 1.5; }
        const sp = s.move > 0 ? sd.speed : 0; s.move -= dt;
        const fw = [Math.sin(s.yaw), 0, Math.cos(s.yaw)];
        s.sw.pos = v3.add(s.sw.pos, v3.scale(fw, sp * dt)); s.sw.pos[1] = floorH(s.sw.pos[0], s.sw.pos[2]) + 0.02;
        if (sp > 0 && Math.random() < dt * 3) this.floorLife.kick([s.sw.pos[0], s.sw.pos[1], s.sw.pos[2]], 0.25, 1, 0.08, 0.04);
        dir = fw;
        for (const o of s.c.objs) o.data[17] = sp > 0 ? sd.swim[1] : 0.4;
      } else {
        if (s.t <= 0 || !s.tgt) {
          s.t = 5 + Math.random() * 8;
          const a = Math.random() * 6.28, r = 3 + Math.random() * 10;
          const x = P[0] + Math.cos(a) * r, z = P[2] + Math.sin(a) * r;
          s.tgt = sd.mode === 'hover' ? [x, floorH(x, z) + 0.3 + Math.random() * 0.6, z] : [x, P[1] + (Math.random() - 0.5) * 5, z];
        }
        s.sw.step(dt, on ? s.tgt : null, sd.speed * (0.7 + 0.3 * Math.sin(t * 0.4 + s.i)), 0.4, this.avoid(s.sw.pos, sd.len * 0.5, 'spec' + sd.key + s.i, 1));
        if (sd.mode === 'hover') s.sw.pos[1] = Math.max(s.sw.pos[1], floorH(s.sw.pos[0], s.sw.pos[2]) + 0.2);
        const aw = v3.sub(s.sw.pos, P), ad = v3.len(aw); if (ad < 1.2) s.sw.pos = v3.add(s.sw.pos, v3.scale(aw, (1.2 - ad) / ad * dt * 2));
        dir = s.sw.dir;
      }
      s.c.visible = true;
      s.sz = s.sz || sizeVar(0.15);
      const W = orient(s.sw.pos, sd.flip ? v3.scale(dir, -1) : dir, 0, sd.scale * s.sz);
      s.c.set(W, dt, 1);
      s.c.draws(D);
      if (sd.glow && this.lightList) { const gp = m4.xform(W, sd.glow); const fl = 0.6 + 0.4 * Math.sin(t * 2.3 + s.i * 3); this.lightList.push({ p: gp, c: v3.scale(sd.glowCol, 0.12 * fl), r: 3 }); }
      if (this.outOfSight(s.sw.pos, P, 1) && (!on || v3.dist(s.sw.pos, P) > 35)) { s.sw.pos = null; s.c.visible = false; }
    }
  }

  updateMega(dt, t, P, cm, depth, D) {
    const q = this.mega, on = depth > 250 && depth < 1000, L = 16;
    if (!q.active) {
      q.c.visible = false; if (q.snd) q.snd.set(0, 0);
      q.wait -= dt;
      if (!on || (q.wait > 0 && !this.megaCue) || (!this.megaCue && this.stageBusy('mega'))) return;   // an explicit cue (director / beat / debug) goes ahead
      this.megaCue = false;
      // looms out of the dark ahead, glides past close enough to count the gill slits, then banks away into the black
      const f = v3.norm([this.camFwd[0], 0, this.camFwd[2]]), r = [-f[2], 0, f[0]], side = Math.random() < 0.5 ? -1 : 1;
      // it swims in toward the diver and stops with its head alongside: the near eye ~2.5 m away, a little ahead of the mask
      q.pa = v3.add(P, v3.add(v3.scale(f, 55), v3.add(v3.scale(r, side * 8), [0, -5, 0])));
      q.pm = v3.add(P, v3.add(v3.scale(f, 2.2 + 8.6), v3.add(v3.scale(r, side * 0.4), [0, 0.5, 0])));   // the curve's tilt puts the near eye ~2.5 m from the mask   // body centre at the stop
      q.pb = v3.add(P, v3.add(v3.scale(f, -45), v3.add(v3.scale(r, side * 28), [0, -12, 0])));
      q.dwell = 0; q.side = side; q.eyeSnd = false; q.leaveT = 0; q.base = [...P]; q.shiftHold = null;
      q.u = 0; q.active = true; q.closeDone = false; q.dir = v3.norm(v3.sub(q.pm, q.pa));
      if (!q.snd && this.A.ctx) q.snd = this.A.presence('rumble', 0.3);
    }
    const C = v3.sub(v3.scale(q.pm, 2), v3.scale(v3.add(q.pa, q.pb), 0.5));
    const shift = q.u < 0.62 ? v3.sub(P, q.base) : (q.shiftHold = q.shiftHold || v3.sub(P, q.base));   // the approach and the stare follow the diver
    const B = (u) => v3.add(v3.lerp(v3.lerp(q.pa, C, u), v3.lerp(C, q.pb, u), u), shift);
    // slow down into the stop, hang there looking at the diver, then glide off
    // no stopping: it cruises in, eases to ~1 m/s as it glides past the diver's side (eye rolling to follow), and
    // powers away -- one continuous pass
    if (q.u >= 0.45) q.dwell += dt;
    if (q.u >= 0.62) q.leaveT = (q.leaveT || 0) + dt;
    const speed = q.u < 0.5 ? lerp(3.0, 1.0, smooth(0.22, 0.5, q.u)) : lerp(1.0, 2.4, smooth(0.5, 0.8, q.u));
    const p0 = B(q.u), seg = Math.max(v3.dist(p0, B(Math.min(1, q.u + 0.002))), 1e-4);
    q.u = Math.min(1, q.u + speed * dt * 0.002 / seg);
    const pos = B(q.u), want = v3.norm(v3.sub(B(Math.min(1, q.u + 0.02)), pos));
    const lastDir = q.dir; q.dir = v3.norm(v3.lerp(q.dir, want, 1 - Math.exp(-dt * 1.2)));
    const yawRate = Math.atan2(v3.cross(lastDir, q.dir)[1], v3.dot(lastDir, q.dir)) / Math.max(dt, 1e-3);
    q.bank = lerp(q.bank || 0, clamp(-yawRate * 2.5, -0.35, 0.35), 1 - Math.exp(-dt * 0.8));
    const W = orient(pos, q.dir, q.bank, 1);                                          // rigged model: 20 m, head at +Z
    q.c.visible = true;
    // the jaw sags open and the teeth show while it hangs there studying the diver, closing again as it glides off
    q.c.blend.w = 0;
    // the jaw sags open very slowly while it studies the diver (~4 s), hangs, and closes just as slowly as it moves off
    { const want = q.u >= 0.36 && q.u < 0.6 ? 0.26 : 0; const rate = 0.058;             // rad/s: ~15° over ~4.5 s, open as it passes alongside
      q.jawAng += clamp(want - q.jawAng, -rate * dt, rate * dt) ; }
    q.c.set(W, dt, lerp(0.75, 0.45, smooth(0.3, 0.5, q.u) * (1 - smooth(0, 4, q.leaveT || 0))));   // slow tail beat for a 20 m body
    q.c.draws(D);
    q.pos = pos;
    { const beat = Math.sin(q.c.animT * 1.95);                         // 20 m shark: slow, heavy tail strokes shed alternating vortices
      this.wakeFrom(v3.sub(pos, v3.scale(q.dir, 9.5)), q.dir, P, t, dt, { key: 'mega', R: 8, rc: 2.4, v: 1.1 + speed * 0.6, L: 25, sgn: beat >= 0 ? 1 : -1, pulse: 0.4 + 0.6 * Math.abs(beat) }); }
    // eyeballs: look at the diver (limited to ±40° around the resting gaze), with a slow, deliberate roll
    {
      const E = this.megaEye;
      [1, -1].forEach((sx, k) => {
        const HB = q.c.pose.global[q.headNode];
        const cW = m4.xform(HB, q.eyeHead[k]), restW = v3.norm(m4.xdir(HB, q.eyeRestHead[k]));
        let want = v3.norm(v3.sub(P, cW));
        const c = v3.dot(want, restW), lim = 0.44;                             // the eye rolls within ±25° of the socket axis
        if (c < Math.cos(lim)) want = v3.norm(v3.add(v3.scale(restW, Math.cos(lim)), v3.scale(v3.norm(v3.sub(want, v3.scale(restW, c))), Math.sin(lim))));
        E.look[k] = E.look[k] ? v3.norm(v3.lerp(E.look[k], want, 1 - Math.exp(-dt * 1.4))) : restW;
        const f = E.look[k]; let rr = v3.cross([0, 1, 0], f); rr = v3.len(rr) < 1e-3 ? [1, 0, 0] : v3.norm(rr); const u = v3.cross(f, rr);
        const r = 0.085;
        const M = m4.basis(v3.scale(rr, r), v3.scale(u, r), v3.scale(f, r), cW);
        rel(M, E.objs[k].data.subarray(0, 16)); this.R.writeObj(E.objs[k]);
        D.push({ gm: E.gm, mat: E.mat, obj: E.objs[k], kind: 'static', shadow: false });
      });
      if (q.dwell > 0.5 && !q.eyeSnd && v3.dist(pos, P) < 14) { q.eyeSnd = true; this.A.play('rumble', 0.8, { rate: 0.35 }); this.startle = 1; this.A.gasp?.(); }
    }
    const relM = v3.sub(pos, P), d = v3.len(relM), pan = v3.dot(v3.norm(relM), [cm[0], cm[1], cm[2]]);
    const prox = nearVol(Math.max(0, d - 6), 4, 45);
    if (q.snd) q.snd.set(1.0 * prox, pan * 0.7, 0.22);
    if (t - (q.lastSweep || 0) > 3.8 && prox > 0.1) { q.lastSweep = t; this.A.play('whoosh_deep', 0.8 * prox, { rate: 0.22, pan }); }
    if (!q.closeDone && d < 12) { q.closeDone = true; this.startle = 1; this.A.gasp?.(); this.A.play('rumble', 1.0, { rate: 0.4, pan }); this.threat = Math.max(this.threat || 0, 1); }
    if (d < 12) { const k = (1 - d / 12) * Math.min(1, speed / 1.6); this.push = v3.add(this.push, v3.add(v3.scale(q.dir, 0.9 * k), v3.scale(v3.norm([-relM[0], 0, -relM[2]]), 0.5 * k))); }   // still water while it hangs there
    if (q.u >= 1 && this.outOfSight(pos, P, 8)) { q.active = false; q.wait = 400 + Math.random() * 300; }
  }

  // ---- deep-water event director: even if the diver just hangs still, something happens every 40–75 s ----
  // ---- event catalogue: every event that can happen at this depth, its trigger and its current countdown (debug) ----
  eventCatalog(P, depth, t) {
    const D = depth, L = [], FD = FLOOR_DEPTH;
    // band: depths (m) where it can happen; pos(): where the animal is now (debug shows the approximate distance)
    const add = (key, label, ok, eta, fn, band = '', pos = null) => { const p = pos && pos(); L.push({ key, label, ok, eta, fn, band, live: typeof eta === 'string' && eta.startsWith(RUN), min: key === 'floor' ? FD - 120 : parseFloat(band) || 0, dist: p ? v3.dist(p, P) : null }); };
    const nearest = (list, get) => { let b = null, bd = 1e9; for (const x of list || []) { const q = get(x); if (!q) continue; const dd = v3.dist(q, P); if (dd < bd) { bd = dd; b = q; } } return b; };
    const sw = this.swarm, w = this.whale, tu = this.turtle, sq = this.squid, mg = this.mega, oar = this.deepLife?.oar;
    const RUN = tr('진행 중', 'running');
    add('bait', tr('정어리 군무 (bait ball)', 'Sardine bait ball'), D > 12 && D < 70, sw.active ? RUN : this.events.bait ? this.baitT : tr('20 m 도달 시', 'at 20 m'), () => { this.startSwarm(P, t); const r = Math.random(); sw.hunter = r < 0.45 ? 'tuna' : r < 0.85 ? 'dolphin' : null; this.baitT = 90 + Math.random() * 90; }, '12–70 m', () => sw.active && sw.center);
    add('whalePass', tr('혹등고래 근접 통과', 'Humpback close pass'), D > 8 && D < 200, w.sw?.pos ? RUN : w.wait, () => { w.closeNext = true; w.wait = 0; if (w.sw) w.sw.pos = null; }, '8–200 m', () => w.sw?.pos);
    add('whaleShow', tr('혹등고래 숨쉬기 + 꼬리치기', 'Humpback breathing + lobtail'), D < 25, w.ev ? RUN + ': ' + w.ev.st : this.showT ?? 50, () => { this.whaleShowCue = true; w.wait = 0; if (w.sw) w.sw.pos = null; w.ev = null; }, '0–25 m', () => w.sw?.pos);
    add('manta', tr('만타 편대', 'Manta squadron'), D > 10 && D < 150, this.squad.active ? RUN : this.events.manta ? tr('1회 완료', 'done once') : tr('46 m 도달 시', 'at 46 m'), () => this.startSquadron(P), '10–150 m', () => this.squad.active && this.squad.lead?.pos);
    add('dolphinPlay', tr('돌고래 장난 (시야 앞)', 'Dolphins playing (in view)'), D < 45, this.pod.playing > 0 ? RUN : this.pod.playT ?? 20, () => { this.pod.playT = 0; }, '0–45 m', () => this.pod.pos);
    add('dolphinJump', tr('돌고래 점프', 'Dolphin leaps'), D < 45, this.pod.playing > 0 ? RUN : '', () => { this.pod.playing = 18; this.dolphins.forEach((d) => { d.breathT = 0.1 + Math.random(); d.surf = 0; d.jumped = false; }); }, '0–45 m', () => this.pod.pos);
    add('shark', tr('상어 근접 통과', 'Shark close pass'), D > 45 && D < 340, Math.min(...this.sharks.map((s) => s.timer)), () => { this.evClose = 25; this.sharks.forEach((s, i) => { s.timer = 0.5 + i * 6; }); }, '45–340 m', () => nearest(this.sharks, (x) => x.spawned && x.pos));
    add('turtle', tr('거대 거북이', 'Giant turtle'), D > 180 && D < 420, tu.active ? RUN : tu.wait, () => { tu.active = false; tu.wait = 0; }, '180–420 m', () => tu.active && [tu.c.world[12], tu.c.world[13], tu.c.world[14]]);
    add('mega', tr('메갈로돈', 'Megalodon'), D > 250 && D < 1000, mg.active ? RUN : mg.wait, () => { this.megaCue = true; }, '250–1000 m', () => mg.active && mg.pos);
    add('squid', tr('대왕오징어', 'Giant squid'), D > 600 && D < 1300, sq.active ? RUN : sq.wait, () => { this.squidCue = true; }, '600–1300 m', () => sq.active && sq.pos);
    add('oar', tr('산갈치', 'Oarfish'), D > 150 && D < 1000, oar?.pos ? RUN : oar?.wait ?? 20, () => { if (oar) { oar.pos = null; oar.wait = 0; } this.evClose = 30; }, '150–1000 m', () => oar?.pos);
    add('jelly', tr('해파리 근접', 'Jellyfish close'), D > 420 && D < 1800, '', () => { this.evClose = 22; this.jellyPassT = 0; }, '420–1800 m', null);
    add('chicken', tr('머리 없는 닭 괴물', 'Headless chicken monster'), D > 450 && D < 2600, '', () => { const c = this.deepLife.chickens.find((q) => !q.p || this.outOfSight(q.p, P, 1)) || this.deepLife.chickens[0]; c.p = null; this.evClose = 15; }, '450–2600 m', () => nearest(this.deepLife.chickens, (x) => x.p));
    add('siph', tr('관해파리 사슬', 'Siphonophore chain'), D > 500 && D < 3200, '', () => { const S2 = this.deepLife.siphs.find((q) => !q.pos || this.outOfSight(q.pos, P, 8)) || this.deepLife.siphs[0]; S2.pos = null; this.evClose = 12; }, '500–3200 m', () => nearest(this.deepLife.siphs, (x) => x.pos));
    add('angler', tr('아귀 근접', 'Anglerfish close'), D > 1100, '', () => { this.evClose = 24; this.anglerPassT = 0; }, tr('1100 m – 바닥', '1100 m – floor'), () => nearest(this.anglers, (x) => x.pos));
    add('floor', tr('민태 통과 (바닥)', 'Grenadiers passing (floor)'), D > FD - 120, '', () => { this.evClose = 18; if (this.grenadiers?.[0]) this.grenadiers[0].passT = 0; }, tr('바닥 120 m 위부터', 'from 120 m above floor'), () => nearest(this.grenadiers, (x) => x.sw?.pos || x.pos));
    return L;
  }
  // one big encounter at a time: is another big animal event already on stage?
  stageBusy(except = null) {
    const on = (k, v) => k !== except && !!v;
    return on('mega', this.mega?.active) || on('squid', this.squid?.active) || on('turtle', this.turtle?.active) ||
      on('oar', this.deepLife?.oar?.pos) || on('shark', this.sharks?.some((sh) => sh.spawned && sh.mode === 'pass'));
  }
  // a big body swimming past sheds a vortex from its tail: Lamb–Oseen swirl about the swim axis behind the tail tip.
  // It pushes/buffets the diver and the strongest one near the diver also swirls the marine snow (shader wake).
  //   tip: tail tip (world), dir: swim direction, o: { R influence, rc core, v peak swirl m/s, L wake length, sgn side,
  //   pulse 0..1 stroke strength, key }
  wakeFrom(tip, dir, P, t, dt, o) {
    const r = v3.sub(P, tip), u = v3.dot(r, dir), rp = v3.sub(r, v3.scale(dir, u)), dp = v3.len(rp);
    const win = smooth(4, -2, u) * Math.exp(Math.min(u, 0) / o.L);
    const vth = (dp > 1e-3 ? o.v * o.rc / dp * (1 - Math.exp(-(dp * dp) / (o.rc * o.rc))) : 0) * win * o.pulse * smooth(o.R * 2.2, o.R * 0.6, dp);
    if (vth > 1e-3) {
      const tang = v3.scale(v3.norm(v3.cross(v3.scale(dir, o.sgn), rp)), vth);
      const churn = [Math.sin(t * 2.7) + Math.sin(t * 4.1 + 1.3) * 0.5, Math.sin(t * 3.3 + 2) * 0.6, Math.cos(t * 2.9) + Math.sin(t * 5.3) * 0.4];
      this.push = v3.add(this.push, v3.add(v3.scale(tang, 1.2), v3.scale(churn, vth * 0.4)));
      this.buffet = Math.max(this.buffet || 0, clamp(vth / 1.8, 0, 1));
    }
    this.wakePh = this.wakePh || {}; this.wakePh[o.key] = (this.wakePh[o.key] || 0) + dt * 0.55 * o.pulse * smooth(70, 15, v3.dist(tip, P));
    const score = vth + 0.02 * smooth(60, 10, v3.dist(tip, P)) * o.pulse;             // strongest / nearest one drives the snow swirl
    if (score > (this.wakeBest || 0)) { this.wakeBest = score; this.wake = { o: tip, ax: v3.scale(dir, o.sgn), phase: this.wakePh[o.key], R: o.R * 1.2, jit: 0.2 + 0.3 * o.pulse, L: o.L }; }
    return vth;
  }
  deepEvents(dt, t, P, depth) {
    if (depth < 150) {
      // shallow: now and then a humpback comes up to the surface nearby to blow and slap its tail
      this.showT = (this.showT ?? 50) - dt;
      if (depth < 25 && this.showT <= 0) { this.showT = 150 + Math.random() * 90; this.whaleShowCue = true; this.whale.wait = Math.min(this.whale.wait, 0); }
      this.evT = Math.max(this.evT ?? 30, 20); return;
    }
    this.evT = (this.evT ?? 30) - dt;
    if (this.evT > 0) return;
    if (this.stageBusy()) { this.evT = 8; return; }                  // wait for the current encounter to finish
    const big = this.mega?.active || this.squid?.active || this.turtle?.active;
    const D = depth, L = [];
    const add = (key, w, fn) => { if (key !== this.lastEv) L.push({ key, w, fn }); };
    if (!big) {
      if (D > 250 && D < 1000) add('mega', 1.0, () => { this.megaCue = true; });
      if (D > 600 && D < 1300) add('squid', 1.2, () => { this.squidCue = true; });
      if (D > 180 && D < 420) add('turtle', 1.0, () => { this.turtle.wait = 0; });
    }
    if (D > 150 && D < 340) add('shark', 1.2, () => { this.evClose = 25; this.sharks.forEach((sh, i) => { sh.timer = Math.min(sh.timer, 1 + i * 6); }); });
    if (D > 150 && D < 1000 && !this.deepLife.oar.pos) add('oar', 1.0, () => { this.deepLife.oar.wait = 0; this.evClose = 30; });
    if (D > 420 && D < 1800) add('jelly', 0.8, () => { this.evClose = 22; this.jellyPassT = 0; });
    if (D > 450 && D < 2600) add('chicken', 0.7, () => { const c = this.deepLife.chickens.find((q) => !q.p || this.outOfSight(q.p, P, 1)); if (c) { c.p = null; c.seen = false; } this.evClose = 15; });
    if (D > 500 && D < 3200) add('siph', 0.7, () => { const S = this.deepLife.siphs.find((q) => !q.pos || this.outOfSight(q.pos, P, 8)); if (S) { S.pos = null; } this.evClose = 12; });
    if (D > 1100) add('angler', 1.0, () => { this.evClose = 24; this.anglerPassT = 0; });
    if (D > FLOOR_DEPTH - 120) add('floor', 1.0, () => { this.evClose = 18; if (this.grenadiers?.[0]) this.grenadiers[0].passT = 0; });
    if (!L.length) { this.evT = 10; return; }
    let r = Math.random() * L.reduce((a, e) => a + e.w, 0), pick = L[0];
    for (const e of L) { r -= e.w; if (r <= 0) { pick = e; break; } }
    pick.fn(); this.lastEv = pick.key;
    this.evT = 40 + Math.random() * 35;
  }

  updateSquid(dt, t, P, cm, depth, D) {
    const q = this.squid, on = depth > 600 && depth < 1300;
    if (!q.active) {
      q.c.visible = false; if (q.snd) q.snd.set(0, 0);
      q.wait -= dt;
      if (!on || (q.wait > 0 && !this.squidCue) || (!this.squidCue && this.stageBusy('squid'))) return;
      this.squidCue = false;
      // rises from below and behind, sweeps past the diver's side (cinematic: ~2.5 m from the mask), climbs away
      const f = v3.norm([this.camFwd[0], 0, this.camFwd[2]]), r = [-f[2], 0, f[0]], side = Math.random() < 0.5 ? -1 : 1;
      const gap = this.cineClose ? 2.2 : 4.5;
      q.pa = v3.add(P, v3.add(v3.scale(f, 14), v3.add(v3.scale(r, side * 30), [0, -22, 0])));
      q.pm = v3.add(P, v3.add(v3.scale(f, 3.5), v3.add(v3.scale(r, side * gap), [0, -0.5, 0])));
      q.pb = v3.add(P, v3.add(v3.scale(f, -8), v3.add(v3.scale(r, -side * 26), [0, 16, 0])));
      q.u = 0; q.active = true; q.closeDone = false;
      if (!q.snd && this.A.ctx) q.snd = this.A.presence('rumble', 0.35);
    }
    // quadratic Bézier through pa → (control) → pb that passes the close point; constant ground speed, jet pulses
    const B = (u) => { const a = v3.lerp(q.pa, v3.sub(v3.scale(q.pm, 2), v3.scale(v3.add(q.pa, q.pb), 0.5)), u), b = v3.lerp(v3.sub(v3.scale(q.pm, 2), v3.scale(v3.add(q.pa, q.pb), 0.5)), q.pb, u); return v3.lerp(a, b, u); };
    const pulse = Math.pow(Math.max(0, Math.sin(t * 1.1)), 3);
    const speed = 0.9 + 1.6 * pulse;
    const p0 = B(q.u), p1 = B(Math.min(1, q.u + 0.002)), seg = Math.max(v3.dist(p0, p1), 1e-4);
    q.u = Math.min(1, q.u + speed * dt * 0.002 / seg);
    const pos = B(q.u), dir = v3.norm(v3.sub(B(Math.min(1, q.u + 0.01)), pos));
    // body centre is 5 m behind the mantle tip; orient mantle-first along the path
    const ctr = v3.sub(pos, v3.scale(dir, 3.0));
    q.c.visible = true;
    q.c.set(orient(ctr, dir, 0.15 * Math.sin(t * 0.3)), dt, 1);
    this.wakeFrom(v3.sub(ctr, v3.scale(dir, 6)), dir, P, t, dt, { key: 'squid', R: 6, rc: 2, v: 1.2, L: 20, sgn: 1, pulse: 0.7 });   // the arms trail a turbulent wake
    for (const o of q.c.objs) o.data[17] = pulse;   // swim.x stays -1 (squid deform); swim.y = jet stroke, synced to the thrust
    q.c.draws(D);
    q.pos = ctr;
    const rel = v3.sub(ctr, P), d = v3.len(rel), pan = v3.dot(v3.norm(rel), [cm[0], cm[1], cm[2]]);
    const prox = nearVol(Math.max(0, d - 4), 3, 30);
    if (q.snd) q.snd.set(0.9 * prox, pan * 0.7, 0.3);
    if (pulse > 0.95 && prox > 0.1 && t - (q.lastJet || 0) > 2) { q.lastJet = t; this.A.play('whoosh_deep', 0.7 * prox, { rate: 0.35, pan }); this.A.bio?.('swish', 0.4 * prox, pan); }
    if (!q.closeDone && d < 7) { q.closeDone = true; this.startle = Math.max(this.startle || 0, 1); this.A.gasp?.(); this.A.play('rumble', 0.9, { rate: 0.5, pan }); }
    // its jet wash rocks the diver when it slides past
    if (d < 9) this.push = v3.add(this.push, v3.scale(v3.norm([-rel[0], -rel[1] * 0.3, -rel[2]]), 0.6 * (1 - d / 9) * (0.3 + pulse)));
    if (q.u >= 1 && this.outOfSight(ctr, P, 6)) { q.active = false; q.wait = 240 + Math.random() * 200; }
  }

  updateSharks(dt, t, P, cm, depth, D) {
    const on = depth > 45 && depth < 340;
    this.threat = 0;
    const camFwd = [-cm[8], -cm[9], -cm[10]];
    const vis = visRange(depth);
    for (const s of this.sharks) {
      if (!s.spawned) {
        if (!on) { s.c.visible = false; continue; }
        s.spawned = true; s.ang = Math.random() * 6.28; s.mode = 'circle'; s.timer = 8 + s.i * 9;
        s.pos = [P[0] + Math.cos(s.ang) * (vis + 4), P[1] + s.dy, P[2] + Math.sin(s.ang) * (vis + 4)];
      }
      s.c.visible = true;
      if (!on) {   // left its depth band: cruise away on its own heading until out of sight
        s.pos = v3.add(s.pos, v3.scale(s.dir, 1.2 * dt));
        s.c.set(orient(s.pos, s.dir, 0), dt, 0.5);
        s.c.draws(D);
        if (this.outOfSight(s.pos, P, 3)) { s.spawned = false; s.c.visible = false; }
        continue;
      }
      s.timer -= dt;
      let target, speed;
      if (s.mode === 'circle') {
        s.ang += dt * 1.0 / s.r;
        target = [P[0] + Math.cos(s.ang) * s.r, P[1] + s.dy + Math.sin(t * 0.2 + s.i) * 2, P[2] + Math.sin(s.ang) * s.r];
        speed = 1.1;
        if (this.cineClose && s.timer > 6) s.timer = 6;
        if (s.timer <= 0 && !this.sharks.some((o) => o.mode === 'pass')) {
          // brush past the diver: come in from the side of view, cross close in front
          s.mode = 'pass'; s.passed = false;
          const side = Math.random() < 0.5 ? -1 : 1;
          const rightV = [cm[0], 0, cm[2]];
          const fw = v3.norm([camFwd[0], 0, camFwd[2]]);
          s.pa = v3.add(P, v3.add(v3.scale(rightV, side * 22), v3.scale(fw, 6 + Math.random() * 4)));
          s.pa[1] = P[1] + (Math.random() - 0.5) * 2;
          const mid = v3.add(P, v3.add(v3.scale(fw, 1.6 + Math.random() * 1.2), [0, -0.3 + Math.random() * 0.6, 0]));
          s.pb = v3.add(mid, v3.sub(mid, s.pa));
          s.pos = v3.lerp(s.pos, s.pa, 0.0); s.pathT = 0; s.pmid = mid;
        }
      }
      if (s.mode === 'pass') {
        s.pathT += dt * 2.0 / v3.dist(s.pa, s.pb);
        // quadratic path from wherever it is through the close point
        const k = clamp(s.pathT + 0.12, 0, 1);            // steer toward a point a little ahead on the path
        target = v3.lerp(v3.lerp(s.pa, s.pmid, k), v3.lerp(s.pmid, s.pb, k), k);
        speed = 2.0;
        const dd = v3.dist(s.pos, P);
        if (!s.passed && dd < 4.5) {
          s.passed = true;
          const rel = v3.sub(s.pos, P); const pan = v3.dot(v3.norm(rel), [cm[0], cm[1], cm[2]]);
          this.A.play('whoosh_deep', 0.9, { pan }); this.A.play('whoosh_move', 0.5, { pan: -pan * 0.5, rate: 0.8 });
        }
        if (s.pathT >= 1) { s.mode = 'circle'; s.timer = 14 + Math.random() * 14; s.ang = Math.atan2(s.pos[2] - P[2], s.pos[0] - P[0]); }
      }
      // physical steering: velocity-driven, minimum turn radius ~4 m (turn rate = speed / radius), limited acceleration
      const to = v3.sub(target, s.pos);
      const av = this.avoid(s.pos, 1.1, 'shark' + s.i, 3);
      const want = v3.norm(v3.add(v3.len(to) > 0.01 ? v3.norm(to) : s.dir, v3.scale(av, 2.0)));
      s.speed = lerp(s.speed, speed, 1 - Math.exp(-dt * 0.4));
      if (!s.vel) s.vel = v3.scale(s.dir, s.speed);
      const lastDir = s.dir;
      const des = v3.scale([want[0], clamp(want[1], -0.35, 0.35), want[2]], s.speed);   // gentle pitch
      steer(s.vel, des, dt, 1.2, Math.max(0.12, s.speed / 4.0), 0.6, 3.0);
      s.dir = v3.norm(s.vel);
      s.pos = v3.add(s.pos, v3.scale(s.vel, dt));
      const yawRate = Math.atan2(v3.cross(lastDir, s.dir)[1], v3.dot(lastDir, s.dir)) / dt;
      s.bank = lerp(s.bank || 0, clamp(-yawRate * 0.6, -0.35, 0.35), 1 - Math.exp(-dt * 1.2));   // roll into the turn
      const th = 1 - clamp((v3.dist(s.pos, P) - 3) / 12, 0, 1);
      if (th > this.threat) { this.threat = th; this.threatPos = s.pos; }
      s.sz = s.sz || sizeVar(0.15);
      s.c.set(orient(s.pos, s.dir, s.bank, s.sz), dt, 0.3 + s.speed * 0.18);
      s.c.draws(D);
      { // each tail stroke sheds a vortex, alternating side: a reverse Kármán street behind the shark
        const beat = Math.sin(s.c.animT * 6.2831853 * 0.9), len = 3.4 * (s.sz || 1);
        const tail = v3.sub(s.pos, v3.scale(s.dir, len * 0.5)), side = v3.norm(v3.cross([0, 1, 0], s.dir));
        this.wakeFrom(v3.add(tail, v3.scale(side, beat * 0.35 * len * 0.2)), s.dir, P, t, dt, { key: 'shark' + s.i, R: 3.5 * (s.sz || 1), rc: 0.9, v: 1.1 * Math.min(2, s.speed), L: 10, sgn: beat >= 0 ? 1 : -1, pulse: 0.35 + 0.65 * Math.abs(beat) });
      }
    }
  }

  updateJellies(dt, t, P, depth) {
    const on = depth > 420 && depth < 1800;
    const J = this.jData;
    let n = 0;
    const cols = [[0.15, 0.65, 1.0], [0.1, 0.9, 0.75], [0.35, 0.4, 1.0], [0.7, 0.3, 1.0], [0.1, 0.55, 1.0]];
    for (let i = 0; i < this.jMax; i++) {
      let j = this.jellies[i];
      const jv = visRange(depth, true);
      if (j && v3.dist(j.p, P) > (j.close ? 9 : jv)) { j = this.jellies[i] = null; }
      if (!j && !on) continue;
      if (!j) {
        const f0 = this.camFwd || [0, 0, -1], fa = Math.atan2(f0[2], f0[0]);
        const rr = this.jSeeded ? jv * (0.85 + Math.random() * 0.1) : 4 + Math.random() * (jv - 8);
        const a = rr < jv * 0.8 ? fa + Math.PI + (Math.random() - 0.5) * 2.4 : Math.random() * 6.28, e = (Math.random() - 0.5) * 1.6;
        j = this.jellies[i] = { p: [P[0] + Math.cos(a) * Math.cos(e) * rr, P[1] + Math.sin(e) * rr * 0.7, P[2] + Math.sin(a) * Math.cos(e) * rr], s: 0.12 + Math.pow(Math.random(), 3) * 0.55,
          col: cols[(Math.random() * cols.length) | 0], ph: Math.random() * 6.28, fade: 0, v: [(Math.random() - 0.5) * 0.05, 0, (Math.random() - 0.5) * 0.05] };
      }
      j.fade = Math.min(1, j.fade + dt * 0.25);
      const jfd = 1 - smooth(jv * 0.7, jv, v3.dist(j.p, P));   // dims into the distance before recycling
      const pulse = Math.max(0, Math.sin(t * 1.6 + j.ph - 1.2));
      j.p = v3.add(j.p, v3.scale(v3.add(j.v, [0, 0.06 * pulse - 0.012, 0]), dt * 1.2));
      J.set([j.p[0] - ORIGIN[0], j.p[1] - ORIGIN[1], j.p[2] - ORIGIN[2], j.s, j.col[0] * j.fade * jfd, j.col[1] * j.fade * jfd, j.col[2] * j.fade * jfd, j.ph, 0, 1, 0, 0], n * 12); n++;
    }
    // cinematic: every ~10 s one jelly drifts right across the mask, 1–2 m away
    if (on && this.cineClose) {
      this.jellyPassT = (this.jellyPassT ?? 0) - dt;
      if (this.jellyPassT <= 0) {
        this.jellyPassT = 9 + Math.random() * 5;
        const f = v3.norm([this.camFwd[0], 0, this.camFwd[2]]), r = [-f[2], 0, f[0]], side = Math.random() < 0.5 ? -1 : 1;
        const i = (Math.random() * this.jMax) | 0, d = 1.2 + Math.random() * 0.9;
        this.jellies[i] = { p: v3.add(P, v3.add(v3.scale(f, d), v3.add(v3.scale(r, side * 4.5), [0, 0.6 + Math.random() * 0.6, 0]))), s: 0.25 + Math.random() * 0.25,
          col: cols[(Math.random() * cols.length) | 0], ph: Math.random() * 6.28, fade: 0, v: v3.scale(r, -side * 0.28), close: true };
      }
    }
    if (on) this.jSeeded = true;
    this.jelly.count = n;
    if (n) this.R.device.queue.writeBuffer(this.jelly.sb, 0, J, 0, n * 12);
  }

  updateFloor(dt, t, P, depth, D) {
    const on = depth > FLOOR_DEPTH - 120;
    for (const g of this.grenadiers) {
      if (!g.sw) { g.sw = new Swimmer(); g.sw.turnCap = 0.5; }
      if (!g.sw.pos) {
        if (!on) { g.c.visible = false; continue; }
        const p0 = this.hiddenSpawn(P, g.seen ? visRange(depth) + 4 : 8 + Math.random() * 8, 0);
        g.sw.spawnAt([p0[0], floorH(p0[0], p0[2]) + 1.0, p0[2]], P); g.seen = true; g.retarget = 0;
      }
      g.retarget -= dt;
      if (g.retarget <= 0 || !g.tgt) {
        g.retarget = 6 + Math.random() * 10;
        const a = Math.random() * 6.28, r = 4 + Math.random() * 12, x = P[0] + Math.cos(a) * r, z = P[2] + Math.sin(a) * r;
        g.tgt = [x, floorH(x, z) + 0.5 + Math.random() * 0.9, z];
      }
      if (on && this.cineClose && g === this.grenadiers[0]) {
        g.passT = (g.passT ?? 0) - dt;
        if (g.passT <= 0) { g.passT = 16; const f = v3.norm([this.camFwd[0], 0, this.camFwd[2]]); const x = P[0] + f[0] * 1.6 - f[2] * 6, z = P[2] + f[2] * 1.6 + f[0] * 6; g.tgt = [x, Math.max(floorH(x, z) + 0.6, P[1] - 0.6), z]; g.retarget = 14; }
      }
      const tg = on ? g.tgt : null;
      g.sw.step(dt, tg, 0.22 + 0.12 * Math.sin(t * 0.3 + g.ph), 0.35, this.avoid(g.sw.pos, 0.5, 'gren' + g.ph, 1.5));
      const fl = floorH(g.sw.pos[0], g.sw.pos[2]); g.sw.pos[1] = Math.max(g.sw.pos[1], fl + 0.35);
      // shy of the diver
      const aw = v3.sub(g.sw.pos, P), ad = v3.len(aw); if (ad < 2.5) g.sw.pos = v3.add(g.sw.pos, v3.scale(aw, (2.5 - ad) / ad * dt * 1.5));
      // grenadier posture: nose down ~25° toward the sediment while foraging
      const d = v3.norm([g.sw.dir[0], 0, g.sw.dir[2]]);
      const pitch = -0.42 + 0.08 * Math.sin(t * 0.4 + g.ph);
      g.c.visible = true;
      g.c.set(orient(g.sw.pos, [d[0] * Math.cos(pitch), Math.sin(pitch), d[2] * Math.cos(pitch)], 0.04 * Math.sin(t * 0.5 + g.ph), g.sc), dt);
      g.c.draws(D);
      if (!on && this.outOfSight(g.sw.pos, P, 1)) { g.sw.pos = null; g.c.visible = false; }
      else if (on && this.outOfSight(g.sw.pos, P, 1) && v3.dist(g.sw.pos, P) > 40) g.sw.pos = null;
    }
    for (const c of this.crabs) {
      c.c.visible = on;
      if (!on) { c.pos = null; continue; }
      if (!c.pos || (this.outOfSight(c.pos, P, 0.5) && Math.hypot(c.pos[0] - P[0], c.pos[2] - P[2]) > 26)) {
        // half the walkers forage around a crab pile, the rest wander alone
        const piles = [...(this.floorLife.pileSpots?.values() || [])].filter((q) => Math.hypot(q[0] - P[0], q[1] - P[2]) < 45);
        c.home = piles.length && Math.random() < 0.5 ? piles[(Math.random() * piles.length) | 0] : null;
        c.pos = c.home ? [c.home[0] + (Math.random() - 0.5) * 5, 0, c.home[1] + (Math.random() - 0.5) * 5] : this.hiddenSpawn(P, c.pos ? 24 : 5 + Math.random() * 16, 0);
        c.heading = Math.random() * 6.28;
      }
      c.timer -= dt;
      if (c.timer <= 0) { c.walk = Math.random() < 0.65; c.timer = 2 + Math.random() * 5; c.turn = (Math.random() - 0.5) * 0.8; }
      if (c.walk) {
        c.heading += (c.turn || 0) * dt;
        if (c.home) {   // drift back toward the heap
          const hx = c.home[0] - c.pos[0], hz = c.home[1] - c.pos[2], hd = Math.hypot(hx, hz);
          if (hd > 3.5) { const want = Math.atan2(hz, hx); c.heading += Math.sign(Math.sin(want - c.heading - Math.PI / 2)) * 0.6 * dt; }
        }
        c.stepT = (c.stepT || 0) - dt;
        if (c.stepT <= 0) { c.stepT = 0.35 + Math.random() * 0.3; this.floorLife.kick([c.pos[0], c.pos[1], c.pos[2]], 0.35 + c.speed, 2, 0.18, 0.06); }
        // crabs scuttle sideways (local +X)
        const side = [Math.cos(c.heading), 0, -Math.sin(c.heading)];
        c.pos = v3.add(c.pos, v3.scale(side, c.speed * dt));
      }
      const y = floorH(c.pos[0], c.pos[2]);
      c.pos[1] = y;
      const e = 0.3;
      const nx = floorH(c.pos[0] - e, c.pos[2]) - floorH(c.pos[0] + e, c.pos[2]), nz = floorH(c.pos[0], c.pos[2] - e) - floorH(c.pos[0], c.pos[2] + e);
      const up = v3.norm([nx, 2 * e, nz]);
      const f0 = [Math.sin(c.heading), 0, Math.cos(c.heading)];
      const r = v3.norm(v3.cross(up, f0)), f = v3.cross(r, up);
      c.sz = c.sz || sizeVar(0.18);
      const w = m4.basis(v3.scale(r, c.sz), v3.scale(up, c.sz), v3.scale(f, c.sz), c.pos);
      c.c.set(w, dt, c.walk ? 1.1 : 0.6, c.walk ? this.walkAnim : this.idleAnim);
      c.c.draws(D);
    }
    this.floorLife.update(dt, t, P, depth, D, this.cmLast, this.A);
    this.floorKicks(dt, t, P, depth);
  }

  // anything moving close over the silt stirs it up
  floorKicks(dt, t, P, depth) {
    if (depth < FLOOR_DEPTH - 30) return;
    const FL = this.floorLife;
    const near = (p, h) => p && p[1] - floorH(p[0], p[2]) < h;
    // diver's fins (behind and below the body) when swimming low
    const cv = this.camVel || [0, 0, 0], csp = v3.len(cv);
    if (near(P, 2.2) && csp > 0.25 && Math.random() < dt * 8 * csp) {
      const fin = v3.add(P, v3.add(v3.scale(v3.norm([cv[0], 0, cv[2]]), -0.9), [0, -1.4, 0]));
      if (near(fin, 0.6)) FL.kick([fin[0], floorH(fin[0], fin[2]), fin[2]], Math.min(1.3, csp * 0.7), 3, 0.3, 0.25);
    }
    // big fish sweeping low: tail wash behind the body
    const fish = [];
    if (this.goblin?.sw?.pos) fish.push([this.goblin.sw.pos, this.goblin.sw.dir, this.goblin.sw.speed || 1, 1.6]);
    this.grenadiers?.forEach((g) => g.sw?.pos && g.c.visible && fish.push([g.sw.pos, g.sw.dir, g.sw.speed || 0.3, 0.5]));
    this.anglers?.forEach((a) => a.sw?.pos && fish.push([a.sw.pos, a.sw.dir, a.sw.speed || 0.5, 0.4]));
    for (const [p, d, sp, L] of fish) {
      const tail = v3.add(p, v3.scale(d, -L));
      const hgt = tail[1] - floorH(tail[0], tail[2]);
      if (hgt < 1.5 && Math.random() < dt * 6 * sp * (1.5 - hgt)) FL.kick([tail[0], floorH(tail[0], tail[2]), tail[2]], clamp(sp * (1.6 - hgt), 0.4, 1.5), 3, 0.25 * L, 0.2);
    }
  }

  updateBubbles(dt, t, P, cm, depth, state) {
    const under = cam => cam[1] < -0.3;
    // exhale cycle from the full-face mask exhaust valves (either side of the chin)
    if (state.mode === 'dive') {
      if (state.exhaling) {
        const r = [cm[0], cm[1], cm[2]], f = [-cm[8], -cm[9], -cm[10]];
        // exhale burst from the helmet valve above the head: many small bubbles, a few large wobbling caps
        const nNew = Math.random() < 0.9 ? 2 + (Math.random() < 0.4 ? 1 : 0) : 0;
        for (let k = 0; k < nNew; k++) {
          const j = [(Math.random() - 0.5) * 0.1, Math.random() * 0.05, (Math.random() - 0.5) * 0.08];
          const p = v3.add(P, v3.add(v3.add([0, 0.24 + j[1], 0], v3.scale(r, j[0])), v3.scale(f, -0.1 + j[2])));
          const big = Math.random() < 0.08;
          const rad = big ? 0.009 + Math.random() * 0.011 : 0.0018 + Math.random() * Math.random() * 0.005;
          this.bubbles.push({ p, v: [(Math.random() - 0.5) * 0.15, 0.1, (Math.random() - 0.5) * 0.15], r: rad, age: 0, ph: Math.random() * 6.28 });
        }
      }
    }
    const B = this.bubbleData; let n = 0;
    const keep = [];
    for (const b of this.bubbles) {
      b.age += dt;
      const rise = 0.2 + Math.min(b.r, 0.02) * 12.5;                 // ~0.22 m/s (2 mm) … ~0.45 m/s (2 cm caps)
      const zz = 0.04 + Math.min(b.r, 0.02) * 6;                        // larger bubbles zig-zag/rock more
      b.v = v3.lerp(b.v, [Math.sin(t * 6 + (b.ph || 0)) * zz, rise, Math.cos(t * 5 + (b.ph || 0) * 1.3) * zz], 1 - Math.exp(-dt * 2.5));
      b.p = v3.add(b.p, v3.scale(b.v, dt));
      if (b.seep) b.r = b.r0 * (1 - smooth(6, 14, b.p[1] - b.y0));        // methane dissolves: the bubble shrinks away as it rises
      if (b.seep ? (b.r < 0.0004 || this.outOfSight(b.p, P, 0.5, 30)) : (b.age > 7 || b.p[1] > -0.05 || v3.dist(b.p, P) > 14)) continue;
      if (n < this.bubbleMax) { B.set([b.p[0] - ORIGIN[0], b.p[1] - ORIGIN[1], b.p[2] - ORIGIN[2], b.r], n * 4); n++; keep.push(b); }
    }
    this.bubbles = keep;
    this.updatePlumes(dt, t);
    { const K = this.pb; for (let i = 0; i < K.n && n < this.bubbleMax; i++) { B[n * 4] = K.p[i * 3] - ORIGIN[0]; B[n * 4 + 1] = K.p[i * 3 + 1] - ORIGIN[1]; B[n * 4 + 2] = K.p[i * 3 + 2] - ORIGIN[2]; B[n * 4 + 3] = K.r[i]; n++; } }
    this.bub.count = n;
    if (n) this.R.device.queue.writeBuffer(this.bub.obj.sb, 0, B, 0, n * 4);
  }

  // ---- surface spray droplets (ballistic) and surface ripples ----
  sprayDrop(p, fw, carry, speed, spread) {
    if (this.spray.length >= this.sprayMax) return;
    const a = Math.random() * 6.28, side = [-fw[2], 0, fw[0]], s = Math.random() < 0.5 ? -1 : 1;
    const dir = v3.norm(v3.add(v3.add(v3.scale(side, s * (0.6 + Math.random() * 0.6)), v3.scale([Math.cos(a), 0, Math.sin(a)], 0.4 * spread)), [0, 1.2 + Math.random(), 0]));
    this.spray.push({ p: [p[0] + (Math.random() - 0.5) * 0.4, p[1], p[2] + (Math.random() - 0.5) * 0.4], v: v3.add(v3.scale(dir, speed), v3.scale(fw, carry)), r: 0.012 + Math.random() * Math.random() * 0.045, age: 0, s: Math.random() });
  }
  // entrained air: a plunging splash drives a white cloud of bubbles under the surface that billows and rises back up
  foamCloud(p, n, spread, depth) {
    // the entrained air is a plume of real bubbles (rendered as bubbles); a few faint haze puffs give it body
    this.plumeAt(p, Math.min(2500, n * 22), spread, depth);
    n = Math.ceil(n * 0.35);
    for (let k = 0; k < n && this.spray.length < this.sprayMax; k++) {
      const a = Math.random() * 6.28, rr = Math.sqrt(Math.random()) * spread;
      this.spray.push({ p: [p[0] + Math.cos(a) * rr, -0.15 - Math.random() * depth, p[2] + Math.sin(a) * rr], v: [Math.cos(a) * 0.4 * Math.random(), -0.4 * Math.random(), Math.sin(a) * 0.4 * Math.random()], r: 0.5 + Math.random() * 0.8, age: 0, s: Math.random(), cloud: true, life: 5 + Math.random() * 6 });
    }
  }
  // splash-entrained bubble plume: the impact drives air down in a cone, it rolls up into a vortex ring and swirl,
  // then the bubbles race back to the surface (big ones fastest, the plume core carries the rest) and burst into foam
  plumeAt(p, n, spread, depth) {
    const B = this.pb, id = this.plumes.length ? (this.plumes[this.plumes.length - 1].id + 1) % 30000 : 0;
    const P = { id, c: [p[0], -Math.min(depth, 6) * 0.45, p[2]], R0: Math.max(0.4, spread * 0.55), spin: (Math.random() < 0.5 ? -1 : 1) * (0.8 + Math.random() * 0.6), age: 0, str: 1 };
    this.plumes.push(P); if (this.plumes.length > 12) this.plumes.shift();
    for (let k = 0; k < n && B.n < B.N; k++) {
      const i = B.n++, a = Math.random() * 6.28, rr = Math.sqrt(Math.random()) * spread, d = Math.pow(Math.random(), 0.7) * depth;
      B.p[i * 3] = p[0] + Math.cos(a) * rr * (0.5 + d / Math.max(depth, 0.1)); B.p[i * 3 + 1] = -0.1 - d; B.p[i * 3 + 2] = p[2] + Math.sin(a) * rr * (0.5 + d / Math.max(depth, 0.1));
      const dn = 0.8 + Math.random() * 2.2;                                        // still being driven down at first
      B.v[i * 3] = Math.cos(a) * (0.3 + Math.random()) ; B.v[i * 3 + 1] = -dn; B.v[i * 3 + 2] = Math.sin(a) * (0.3 + Math.random());
      B.r[i] = 0.0012 + Math.pow(Math.random(), 2.2) * 0.009; B.age[i] = -Math.random() * 0.15; B.k[i] = id;
    }
  }
  updatePlumes(dt, t) {
    const B = this.pb, plumes = this.plumes;
    for (const P of plumes) { P.age += dt; P.c[1] = Math.min(-0.3, P.c[1] + dt * 0.35 * Math.exp(-P.age * 0.15)); P.str = Math.exp(-P.age * 0.22); }
    const byId = new Map(plumes.map((q) => [q.id, q]));
    let i = 0;
    while (i < B.n) {
      B.age[i] += dt;
      const P = byId.get(B.k[i]), r = B.r[i];
      let x = B.p[i * 3], y = B.p[i * 3 + 1], z = B.p[i * 3 + 2];
      // target velocity: buoyant rise (terminal speed grows with size) + plume updraft + vortex ring + swirl + turbulence
      let tx = 0, ty = Math.min(0.9, 0.2 + r * 95), tz = 0;
      if (P) {
        const dx = x - P.c[0], dz = z - P.c[2], rho = Math.hypot(dx, dz) + 1e-4, ux = dx / rho, uz = dz / rho, s = P.str;
        ty += 0.55 * s * Math.exp(-(rho * rho) / (P.R0 * P.R0 * 1.8));
        const qx = rho - P.R0, qy = y - P.c[1], g = Math.exp(-(qx * qx + qy * qy) / (P.R0 * P.R0 * 1.2)) * 1.3 * s;   // vortex ring
        tx += ux * (-qy) * g; tz += uz * (-qy) * g; ty += qx * g;
        const sw = P.spin * 0.6 * s * Math.exp(-rho / (P.R0 * 1.5));                 // swirl about the plume axis
        tx += -uz * sw; tz += ux * sw;
      }
      const ph = i * 0.37 + t * 2.3;                                                  // wobble / turbulence
      tx += Math.sin(ph) * 0.12 + Math.sin(t * 1.7 + y * 3.1 + i) * 0.08; tz += Math.cos(ph * 1.13) * 0.12 + Math.cos(t * 1.5 + x * 2.7 + i) * 0.08;
      const k = 1 - Math.exp(-dt * (B.age[i] < 0.25 ? 1.2 : 3.0));
      B.v[i * 3] += (tx - B.v[i * 3]) * k; B.v[i * 3 + 1] += (ty - B.v[i * 3 + 1]) * k; B.v[i * 3 + 2] += (tz - B.v[i * 3 + 2]) * k;
      x += B.v[i * 3] * dt; y += B.v[i * 3 + 1] * dt; z += B.v[i * 3 + 2] * dt;
      if (y > -0.06 || B.age[i] > 25) {                                              // reached the surface: bursts into foam
        if (y > -0.06 && (i % 4) === 0) this.bubSurf.push([x, 0, z]);
        const l = --B.n;
        if (i !== l) { for (let c = 0; c < 3; c++) { B.p[i * 3 + c] = B.p[l * 3 + c]; B.v[i * 3 + c] = B.v[l * 3 + c]; } B.r[i] = B.r[l]; B.age[i] = B.age[l]; B.k[i] = B.k[l]; }
        continue;
      }
      B.p[i * 3] = x; B.p[i * 3 + 1] = y; B.p[i * 3 + 2] = z;
      i++;
    }
    this.plumes = plumes.filter((P) => P.age < 30);
  }
  bulkDrop(x, y, z, vx, vy, vz, r) {
    this.gpuSpray.add(x, y, z, vx, vy, vz, r);
    if ((this.proxyK = (this.proxyK + 1) % 40) !== 0) return;          // CPU proxy for landings (sound / foam)
    const B = this.bulk; if (B.n >= B.N) return;
    const i = B.n++;
    B.p[i * 3] = x; B.p[i * 3 + 1] = y; B.p[i * 3 + 2] = z; B.v[i * 3] = vx; B.v[i * 3 + 1] = vy; B.v[i * 3 + 2] = vz; B.r[i] = r; B.age[i] = 0; B.s[i] = Math.random(); B.dr[i] = Math.exp(-(1 / 24) * (0.12 + 0.0022 / r));   // per-frame air drag, by size
  }
  // the fluke slamming flat onto the water: water bursts out over the fluke's whole planform (hitbox from the posed
  // skeleton: ~1/3 body length span, swept-back wings, notched middle) -- a crown sheet off every edge, jets from under
  // the middle, the densest wall thrown sideways off the wing tips
  flukeSplash(w, L, n) {
    const G = w.c.pose?.global, fb = G && G[w.flukeNode], tb = G && G[w.tailNode], W = w.c.world;
    if (!fb || !tb) return null;
    const root = [fb[12], 0, fb[14]];
    let df = v3.norm([fb[12] - tb[12], 0, fb[14] - tb[14]]);
    let lat = v3.norm([W[0], 0, W[2]]);
    const span = L * 0.16, chord = L * 0.1;                     // half-span ~5 m, root chord ~3 m for a 31 m whale
    (this.bursts ||= []).push({ root, df, lat, span, chord, n, done: 0, t: 0, dur: 0.45 });
    return { root, df, lat, span, chord };
  }
  // a fluke burst unfolds over ~half a second: first the violent jets and the sheet torn off the leading edges, then
  // the broad, lower crown collapsing outward.  Drops leave in coherent ligaments (30-60 drops sharing a velocity),
  // so the spray shows sheets and streamers rather than uniform static
  updateBursts(dt) {
    if (!this.bursts?.length) return;
    for (const U of this.bursts) {
      U.t += dt;
      const want = Math.min(U.n, Math.round(U.n * smooth(0, U.dur, U.t))), k0 = U.t / U.dur;
      while (U.done < want && this.bulk.n < this.bulk.N) {
        const sgn = Math.random() < 0.5 ? -1 : 1, s = Math.pow(Math.random(), 0.7);
        const cl = U.chord * (1 - 0.65 * s), lead = 0.25 * U.chord + s * 0.45 * U.chord;
        const edge = Math.random() < 0.55, c = edge ? (Math.random() < 0.5 ? 0 : 1) : Math.random();
        const px = U.root[0] + U.df[0] * (lead + c * cl) + U.lat[0] * sgn * s * U.span, pz = U.root[2] + U.df[2] * (lead + c * cl) + U.lat[2] * sgn * s * U.span;
        const ox = U.lat[0] * sgn * (0.4 + 0.9 * s) + U.df[0] * (c - 0.45) * 1.2, oz = U.lat[2] * sgn * (0.4 + 0.9 * s) + U.df[2] * (c - 0.45) * 1.2;
        const jet = !edge && Math.random() < 0.25;
        const early = 1.25 - 0.55 * k0;                               // later water is thrown lower and wider
        let up = (jet ? 20 + Math.random() * 14 : 6.5 + Math.pow(Math.random(), 1.6) * 26) * early;   // crown ~2x the earlier height (tops out ~40-50 m)
        let out = (jet ? 1 + Math.random() * 2 : 3 + Math.random() * 9) * (0.8 + 0.5 * k0);
        const az = (Math.random() - 0.5) * 0.9, ca = Math.cos(az), sa = Math.sin(az);   // fan the ligament direction
        const vx = (ox * ca - oz * sa) * out, vz = (ox * sa + oz * ca) * out;
        const m = 4 + (Math.random() * 7) | 0;                              // small loose groups, not bundles
        for (let j = 0; j < m && U.done < U.n; j++, U.done++) {
          const f = 1 + (Math.random() - 0.5) * 0.5, lj = Math.random();
          // drop sizes: mostly fine spray, a few heavy drops (they carry furthest)
          const rr = 0.003 + Math.pow(Math.random(), 3) * 0.05;
          this.bulkDrop(px + (Math.random() - 0.5) * 0.8, 0.1 + lj * 0.6, pz + (Math.random() - 0.5) * 0.8,
            vx * f + (Math.random() - 0.5) * 2.2, up * (f - 0.15 * lj) + (Math.random() - 0.5) * 2, vz * f + (Math.random() - 0.5) * 2.2, rr);
        }
      }
    }
    this.bursts = this.bursts.filter((U) => U.done < U.n && U.t < U.dur + 0.5);
  }
  updateSpray(dt) {
    this.updateBursts(dt);
    const B = this.sprayData; let n = 0; const keep = [], impacts = [];
    const put = (q, a, kind) => { B.set([q.p[0] - ORIGIN[0], q.p[1] - ORIGIN[1], q.p[2] - ORIGIN[2], q.r, a, q.s, 1, kind], n * 8); n++; keep.push(q); };
    for (const q of this.spray) {
      q.age += dt;
      if (q.cloud) {   // underwater bubble cloud: rises (buoyant), spreads, thins; breaks out as a boil of foam at the surface
        q.v = v3.lerp(q.v, [0.05, 0.3 + q.r * 0.8, 0.02], 1 - Math.exp(-dt * 0.9)); q.p = v3.add(q.p, v3.scale(q.v, dt)); q.r *= 1 + dt * 0.12;
        if (q.p[1] > -0.12 || q.age > q.life) { if (q.p[1] > -0.12 && Math.random() < 0.5) impacts.push(q.p); continue; }
        put(q, 0.14 * smooth(0, 0.4, q.age) * (1 - smooth(q.life * 0.5, q.life, q.age)) * smooth(-0.1, -0.5, q.p[1]), 4); continue;
      }
      if (q.float) {   // foam clot landed: floats on the waves (shader puts it on the real surface), drifts, slowly breaks up
        q.v = v3.lerp(q.v, [0.06, 0, 0.024], 1 - Math.exp(-dt * 0.6)); q.p = v3.add(q.p, v3.scale(q.v, dt)); q.p[1] = 0; q.r *= 1 + dt * 0.06;
        if (q.age > q.life) continue;
        put(q, 0.85 * (1 - smooth(q.life * 0.4, q.life, q.age)), 3); continue;
      }
      if (q.mist) { q.v = v3.add(v3.scale(q.v, Math.exp(-dt * 1.3)), v3.scale([0.9, -0.05, 0.35], 1 - Math.exp(-dt * 0.8))); q.r *= 1 + dt * 0.6; }   // breath mist: billows, slows, drifts downwind
      else { q.v[1] -= 9.81 * dt; q.v = v3.scale(q.v, Math.exp(-dt * (q.foam ? 1.6 : 0.4))); }   // foam clots are light and draggy
      q.p = v3.add(q.p, v3.scale(q.v, dt));
      if (q.p[1] < -0.02 || q.age > 5) {
        if (q.foam && q.p[1] < -0.02) { impacts.push(q.p, q.p, q.p); continue; }   // a landed clot becomes surface foam (the particle sim draws it as lace)
        if (q.p[1] < -0.02) {
          // big drops plunge and carry a little air down: small rising bubble puffs
          if ((q.gen || 0) < 1 && q.r > 0.035 && Math.random() < 0.3) this.foamCloud(q.p, 1, 0.1, 0.4);
          // impact: tiny secondary splash, a ring, and foam where the rain of drops lands
          if ((q.gen || 0) < 1 && q.r > 0.012 && this.spray.length < this.sprayMax - 10 && Math.random() < 3000 / Math.max(3000, this.spray.length)) for (let k = 0; k < 3; k++) { const a = Math.random() * 6.28; this.spray.push({ p: [q.p[0], 0.02, q.p[2]], v: [Math.cos(a) * 0.8, 1.2 + Math.random() * 1.5, Math.sin(a) * 0.8], r: q.r * 0.35, age: 0, s: Math.random(), gen: 1 }); }
          if (q.r > 0.02 && Math.random() < 0.25) this.ripples.push({ x: q.p[0], z: q.p[2], age: 0, amp: 0.015 });
          if (q.r > 0.008) impacts.push(q.p);
        }
        continue;
      }
      put(q, q.mist ? 0.45 * smooth(0, 0.3, q.age) * (1 - smooth(0.8, 4.5, q.age)) : 1.0 * (1 - smooth(1.8, 3, q.age)), q.mist ? 2 : q.foam ? 1 : 0);
    }
    // bulk drops: ballistic with light drag; die into the water (every 40th landing feeds the foam emitters)
    // audible landings: drops within 60 m become grains (capped per frame; the cap is compensated in loudness)
    const AB = this.A.dropBuf, cap = AB ? AB.length / 4 : 0, P0 = this.camP || [0, 0, 0], CR = this.camRight || [1, 0, 0];
    let na = 0, seen = 0;
    const hear = (x, z, r) => {
      const dx = x - P0[0], dz = z - P0[2], dd = dx * dx + dz * dz; if (dd > 3600) return;
      seen++;
      let k = na; if (na >= cap) { k = (Math.random() * seen) | 0; if (k >= cap) return; } else na++;   // reservoir sample
      const d = Math.sqrt(dd) + 0.5, pan = (dx * CR[0] + dz * CR[2]) / d;
      AB[k * 4] = pan; AB[k * 4 + 1] = 1 / (1 + d * 0.18) ; AB[k * 4 + 2] = r; AB[k * 4 + 3] = Math.random() * dt;
    };
    { const K = this.bulk; let i = 0;
      while (i < K.n) {
        K.age[i] += dt;
        const dr = K.dr[i];                                                // air drag by size (precomputed): fine droplets slow and hang as mist
        K.v[i * 3 + 1] -= 9.81 * dt; K.v[i * 3] *= dr; K.v[i * 3 + 1] *= dr; K.v[i * 3 + 2] *= dr;
        K.p[i * 3] += K.v[i * 3] * dt; K.p[i * 3 + 1] += K.v[i * 3 + 1] * dt; K.p[i * 3 + 2] += K.v[i * 3 + 2] * dt;
        if (K.p[i * 3 + 1] < -0.02 || K.age[i] > 10) {
          if (K.p[i * 3 + 1] < -0.02) { impacts.push([K.p[i * 3], 0, K.p[i * 3 + 2]]); if (AB) for (let k = 0; k < 6; k++) hear(K.p[i * 3] + (Math.random() - 0.5) * 1.5, K.p[i * 3 + 2] + (Math.random() - 0.5) * 1.5, K.r[i]); }   // each proxy stands for 40 drops
          const l = --K.n;                                             // swap-remove
          if (i !== l) { K.p[i * 3] = K.p[l * 3]; K.p[i * 3 + 1] = K.p[l * 3 + 1]; K.p[i * 3 + 2] = K.p[l * 3 + 2]; K.v[i * 3] = K.v[l * 3]; K.v[i * 3 + 1] = K.v[l * 3 + 1]; K.v[i * 3 + 2] = K.v[l * 3 + 2]; K.r[i] = K.r[l]; K.age[i] = K.age[l]; K.s[i] = K.s[l]; K.dr[i] = K.dr[l]; }
          continue;
        }
        i++;
      } }
    if (na) {                                                            // loudness of the unsent landings folds into the sent ones
      const comp = seen > na ? Math.sqrt(seen / na) : 1, u = this.camP && this.camP[1] < -0.3 ? 0.35 : 1;
      if (comp !== 1 || u !== 1) for (let k = 0; k < na; k++) AB[k * 4 + 1] *= Math.min(comp, 6) * u;
      this.A.drops(AB, na);
    }
    // lasting churn (big splashes keep boiling up white water for a moment; the patch widens as it does)
    this.churns = (this.churns || []).filter((c) => (c.age += dt) < c.dur);
    for (const c of this.churns) if (this.foamEmit.length < 8) { const k = c.age / c.dur; this.foamEmit.push({ x: c.x, z: c.z, rate: c.rate * (1 - k) * (1 - k), r: c.r * (1 + c.grow * k), vx: 0, vz: 0 }); }
    if (this.bubSurf.length) { for (const q of this.bubSurf) impacts.push(q); this.bubSurf = []; }   // plume bubbles bursting at the surface
    // landing zones -> a few foam emitters (the foam sim takes 8): cluster impacts on a 3 m grid, strongest first
    if (impacts.length) {
      const cells = new Map();
      for (const p of impacts) { const k = Math.floor(p[0] / 1.5) + ',' + Math.floor(p[2] / 1.5); const c = cells.get(k) || { x: 0, z: 0, n: 0 }; c.x += p[0]; c.z += p[2]; c.n++; cells.set(k, c); }
      [...cells.values()].sort((a, b) => b.n - a.n).slice(0, Math.max(0, 8 - this.foamEmit.length)).forEach((c) => this.foamEmit.push({ x: c.x / c.n, z: c.z / c.n, rate: 90 * c.n, r: 0.35, vx: 0, vz: 0 }));   // drops landing: scattered small bits, not one round patch
    }
    this.spray = keep;
    if (n) this.R.device.queue.writeBuffer(this.sprayFx.obj.sb, 0, B, 0, n * 8);
    const gpu = this.gpuSpray.active || this.gpuSpray.sn > 0;
    if (gpu && this.sprayHi > n) this.R.device.queue.writeBuffer(this.sprayFx.obj.sb, n * 32, this.sprayZero, 0, (this.sprayHi - n) * 8);   // stale CPU slots before the GPU block
    this.sprayHi = gpu ? n : Math.max(this.sprayHi, n);
    this.sprayFx.count = gpu ? this.sprayMax + this.gpuSpray.N : n;
    for (const r of this.ripples) r.age += dt;
    this.ripples = this.ripples.filter((r) => r.age < 3.0).sort((a, b) => b.amp * Math.exp(-b.age) - a.amp * Math.exp(-a.age)).slice(0, 16);
  }

  // ---- big-animal collision avoidance: bodies from the previous frame ----
  collectBodies() {
    const B = this.bodies = [], sph = (p, r, tag) => p && B.push({ p, r, tag });
    const axis = (p, dir, r, n, span, tag) => { for (let k = 0; k < n; k++) sph(v3.add(p, v3.scale(dir, (k - (n - 1) / 2) * span)), r, tag); };
    const w = this.whale; if (w?.sw?.pos) axis(w.sw.pos, w.sw.dir, 6.4, 3, 5.0 * (31 / 14), 'whale');
    const tu = this.turtle; if (tu?.active && tu.c.visible) axis([tu.c.world[12], tu.c.world[13], tu.c.world[14]], tu.dir, 14, 3, 20, 'turtle');
    this.sharks?.forEach((sh, i) => { if (sh.spawned && sh.c.visible) axis(sh.pos, sh.dir, 1.1, 2, 1.6, 'shark' + i); });
    this.dolphins?.forEach((d, i) => d.c.visible && sph(d.pos, 0.9, 'dolph' + i));
    if (this.sunfish?.sw?.pos) sph(this.sunfish.sw.pos, 1.4, 'sun');
    if (this.manta?.sw?.pos) sph(this.manta.sw.pos, 2.3, 'manta');
    this.squad?.active && this.squad.mantas.forEach((m, i) => m.pos && sph(m.pos, 2.3, 'sq' + i));
    this.anglers?.forEach((a, i) => a.sw?.pos && sph(a.sw.pos, 0.6, 'ang' + i));
    if (this.goblin?.sw?.pos) sph(this.goblin.sw.pos, 1.6, 'gob');
    if (this.squid?.active && this.squid.pos) sph(this.squid.pos, 2.0, 'squid');
    if (this.mega?.active && this.mega.pos) { sph(v3.add(this.mega.pos, v3.scale(this.mega.dir, 4)), 2.4, 'mega'); sph(this.mega.pos, 2.6, 'mega'); sph(v3.sub(this.mega.pos, v3.scale(this.mega.dir, 5)), 2.0, 'mega'); }
    this.grenadiers?.forEach((g) => g.sw?.pos && sph(g.sw.pos, 0.5, 'gren' + g.ph));
    this.schools?.forEach((sc) => sc.predator && sc.count && sc.members.forEach((m, i) => m.cur && sph(m.cur, 0.8, 'tuna' + i)));
  }
  // nearest animal the torch beam is lighting (for camera-like exposure metering): distance or 0
  beamHit(o, d) {
    let best = 0;
    const test = (p, r = 0.3) => { if (!p) return; const v = v3.sub(p, o), t = v3.dot(v, d); if (t < 0.3 || t > 25) return; const perp = v3.len(v3.sub(v, v3.scale(d, t))); if (perp < r + t * 0.25 && (!best || t < best)) best = t; };
    (this.bodies || []).forEach((b) => test(b.p, b.r));
    this.specimens?.forEach((s) => s.c.visible && s.sw?.pos && test(s.sw.pos, s.sd.len * 0.4));
    this.grenadiers?.forEach((g) => g.c.visible && g.sw?.pos && test(g.sw.pos, 0.4));
    this.crabs?.forEach((c) => c.pos && test(c.pos, 0.4));
    this.deepLife?.chickens.forEach((c) => test(c.p, 0.2));
    this.deepLife?.combs.forEach((c) => test(c.p, 0.1));
    return best;
  }
  // push away from other big bodies within (r1 + r2 + margin); bigger bodies push harder
  avoid(pos, r, tag, margin = 3) {
    let ax = 0, ay = 0, az = 0;
    for (const b of this.bodies || []) {
      if (b.tag === tag) continue;
      const dx = pos[0] - b.p[0], dy = pos[1] - b.p[1], dz = pos[2] - b.p[2], reach = r + b.r + margin;
      if (Math.abs(dx) > reach || Math.abs(dy) > reach || Math.abs(dz) > reach) continue;
      const d = Math.hypot(dx, dy, dz) || 1e-3;
      if (d >= reach) continue;
      const k = Math.pow((reach - d) / reach, 2) * (0.5 + b.r / (r + b.r)) / d;
      ax += dx * k; ay += dy * k * 0.7; az += dz * k;
    }
    return [ax, ay, az];
  }
  // a spawn point the diver cannot see: beyond visibility, or behind the camera (≥110° from the view direction)
  hiddenSpawn(P, dist, dy = 0, band = [-1e9, -1]) {
    const vis = visRange(Math.max(0, -P[1]));
    const f = this.camFwd || [0, 0, -1], fa = Math.atan2(f[2], f[0]);
    const a = dist >= vis ? Math.random() * 6.28 : fa + Math.PI + (Math.random() - 0.5) * 2 * 1.2;   // ±69° around 'behind'
    return [P[0] + Math.cos(a) * dist, clamp(P[1] + dy, band[0], band[1]), P[2] + Math.sin(a) * dist];
  }
  // most interesting visible creature near the diver (for the cinematic camera)
  interest(P, depth) {
    const vis = Math.min(visRange(depth) * 0.6, 25), c = [];
    const add = (p, w) => { if (!p) return; const d = v3.dist(p, P); if (d < vis && d > 1.5 && p[1] - P[1] < d * 0.6) c.push({ p, s: w / (1 + d * 0.08), d }); };
    this.sharks.forEach((s) => s.spawned && s.c.visible && add(s.pos, s.mode === 'pass' ? 6 : 3));
    if (this.whale.sw?.pos) add(this.whale.sw.pos, this.whale.close ? 12 : 9);
    if (this.swarm.active) add(this.swarm.center, 8);
    this.cutlassGroups?.forEach((g) => g.center && add(g.center, 6));
    if (this.squad.active && this.squad.lead) add(this.squad.lead.pos, 8);
    if (this.turtle.active && this.turtle.c.visible) add([this.turtle.c.world[12], this.turtle.c.world[13], this.turtle.c.world[14]], 8);
    if (this.pod.sw?.pos) add(this.pod.sw.pos, 4);
    if (this.sunfish.sw?.pos) add(this.sunfish.sw.pos, 3);
    if (this.manta.sw?.pos) add(this.manta.sw.pos, 3);
    this.anglers.forEach((a) => a.sw?.pos && add(a.sw.pos, 4));
    if (this.goblin.sw?.pos) add(this.goblin.sw.pos, 4);
    if (this.squid?.active) add(this.squid.pos, 12);
    if (this.mega?.active && this.mega.pos) add(this.mega.pos, 14);
    this.specimens?.forEach((sp) => sp.sw?.pos && sp.c.visible && add(sp.sw.pos, sp.sd.key === 'gulper_eel' ? 5 : 2.5));
    this.schools.forEach((sc) => sc.count && add(sc.center, 1.5));
    this.crabs.forEach((cr) => cr.pos && cr.c.visible && add(cr.pos, 2.5));
    let best = null, near = 1e9;
    for (const j of this.jellies) if (j && j.fade > 0.5) { const d = v3.dist(j.p, P); if (d < near) { near = d; best = j.p; } }
    if (best) add(best, 2);
    c.sort((a, b) => b.s - a.s);
    this.interestDist = c[0] ? c[0].d : 1e9;
    return c[0] ? c[0].p : null;
  }
  lights(camPos) {
    const L = (this.lightList || []).map((l) => ({ ...l, d: v3.dist(l.p, camPos) })).filter((l) => l.d < 40);
    L.sort((a, b) => a.d - b.d);
    return L.slice(0, 12);
  }
}
const MAXJ = (w) => w.jMax;
