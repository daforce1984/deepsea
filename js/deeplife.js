// Mid-water deep-sea life (100 m – floor): lanternfish schools with photophores, silver hatchetfish, oarfish,
// glowing siphonophore chains, plus the deep biophony (fish drumming, distant sperm-whale clicks).
// All procedural meshes, instanced; animals only appear/disappear out of sight (World.outOfSight / hiddenSpawn).
import { m4, v3, clamp, lerp, smooth, ORIGIN, rel } from './math.js';
const sizeVar = (sg) => { let u = 0; for (let i = 0; i < 4; i++) u += Math.random(); return Math.exp((u - 2) * 1.732 * sg); };

// ---------------------------------------------------------------- mesh helpers
function lathe(L, NZ, NA, prof, opts = {}) {
  // body along Z (head +Z): prof(t) -> [halfWidth, halfHeight, yOffset]; t: 0 tail .. 1 snout
  const pos = [], nrm = [], uv = [], idx = [];
  for (let i = 0; i <= NZ; i++) {
    const t = i / NZ, z = (t - 0.5) * L, [w, h, yo] = prof(t);
    for (let j = 0; j < NA; j++) {
      const a = j / NA * Math.PI * 2, x = Math.cos(a) * w, y = Math.sin(a) * h + (yo || 0);
      pos.push(x, y, z);
      const nx = Math.cos(a) / Math.max(w, 1e-4), ny = Math.sin(a) / Math.max(h, 1e-4), nl = Math.hypot(nx, ny) || 1;
      nrm.push(nx / nl, ny / nl, 0); uv.push(j / NA, t);
    }
  }
  for (let i = 0; i < NZ; i++) for (let j = 0; j < NA; j++) { const a = i * NA + j, b = i * NA + (j + 1) % NA, c = a + NA, d = b + NA; idx.push(a, c, b, b, c, d); }
  // caps: closed snout and tail (no open-mouth holes)
  const tip = pos.length / 3; pos.push(0, prof(1)[2] || 0, L * 0.5 + 0.002); nrm.push(0, 0, 1); uv.push(0.5, 1);
  for (let j = 0; j < NA; j++) idx.push(NZ * NA + j, NZ * NA + (j + 1) % NA, tip);
  const tl = pos.length / 3; pos.push(0, prof(0)[2] || 0, -L * 0.5 - 0.002); nrm.push(0, 0, -1); uv.push(0.5, 0);
  for (let j = 0; j < NA; j++) idx.push((j + 1) % NA, j, tl);
  return { pos, nrm, uv, idx };
}
function addFin(m, pts, n = [1, 0, 0]) {       // flat double-sided fin polygon (fan from pts[0])
  const b = m.pos.length / 3;
  for (const p of pts) { m.pos.push(...p); m.nrm.push(...n); m.uv.push(0, 0); }
  for (let i = 1; i < pts.length - 1; i++) m.idx.push(b, b + i, b + i + 1);
}
function addSphere(m, c, r, nA = 6, nB = 4) {
  const b = m.pos.length / 3;
  for (let i = 0; i <= nB; i++) for (let j = 0; j <= nA; j++) {
    const th = i / nB * Math.PI, ph = j / nA * Math.PI * 2, n = [Math.sin(th) * Math.cos(ph), Math.cos(th), Math.sin(th) * Math.sin(ph)];
    m.pos.push(c[0] + n[0] * r, c[1] + n[1] * r, c[2] + n[2] * r); m.nrm.push(...n); m.uv.push(0, 0);
  }
  for (let i = 0; i < nB; i++) for (let j = 0; j < nA; j++) { const a = b + i * (nA + 1) + j, c2 = a + nA + 1; m.idx.push(a, c2, a + 1, a + 1, c2, c2 + 1); }
}
const f32 = (m) => ({ pos: new Float32Array(m.pos), nrm: new Float32Array(m.nrm), uv: new Float32Array(m.uv), idx: new Uint32Array(m.idx) });

// lanternfish (Myctophidae ~9 cm): blunt head, huge eye, forked tail; photophores in two ventral rows
function lanternMesh() {
  const L = 0.09, m = lathe(L, 12, 8, (t) => { const p = Math.pow(Math.sin(Math.PI * Math.min(0.999, 0.1 + t * 0.88)), 0.6); return [0.0075 * p, 0.012 * p, 0]; });
  addFin(m, [[0, 0, -L * 0.42], [0, 0.014, -L * 0.62], [0, 0.002, -L * 0.52], [0, -0.014, -L * 0.62]]);
  addFin(m, [[0, 0.011, 0.0], [0, 0.02, -0.012], [0, 0.011, -0.02]]);
  const eyes = { pos: [], nrm: [], uv: [], idx: [] };
  for (const s of [-1, 1]) addSphere(eyes, [s * 0.006, 0.003, L * 0.36], 0.0042);
  const ph = { pos: [], nrm: [], uv: [], idx: [] };
  for (const s of [-1, 1]) for (let k = 0; k < 9; k++) { const z = L * (0.3 - k * 0.085); addSphere(ph, [s * 0.0052, -0.0085 + k * 0.0003, z], 0.0011, 4, 3); }
  addSphere(ph, [0, 0.0105, -L * 0.36], 0.0014, 4, 3);                            // supracaudal gland
  return { body: f32(m), eyes: f32(eyes), ph: f32(ph), L };
}
// silver hatchetfish (Argyropelecus ~7 cm): deep, laterally flat, keel-like belly
function hatchetMesh() {
  const L = 0.07, m = lathe(L, 12, 10, (t) => {
    const deep = t > 0.25 ? Math.pow(Math.sin(Math.PI * Math.min(1, (t - 0.25) / 0.78)), 0.5) : 0.25 + t * 1.2;
    return [0.0045 * (0.4 + 0.6 * deep), 0.022 * deep, -0.008 * deep];
  });
  addFin(m, [[0, 0, -L * 0.45], [0, 0.011, -L * 0.62], [0, -0.011, -L * 0.62]]);
  const eyes = { pos: [], nrm: [], uv: [], idx: [] };
  for (const s of [-1, 1]) addSphere(eyes, [s * 0.004, 0.009, L * 0.33], 0.0045);
  const ph = { pos: [], nrm: [], uv: [], idx: [] };
  for (const s of [-1, 1]) for (let k = 0; k < 10; k++) addSphere(ph, [s * 0.0025, -0.028 + Math.sin(k / 9 * Math.PI) * 0.004, L * (0.25 - k * 0.055)], 0.0012, 4, 3);
  return { body: f32(m), eyes: f32(eyes), ph: f32(ph), L };
}
// oarfish (Regalecus ~6 m): silver ribbon, crimson dorsal fin along the whole back and a crest of long rays on the head
function oarMesh() {
  const L = 6.0, m = lathe(L, 60, 8, (t) => { const p = t < 0.9 ? Math.pow(Math.min(1, t / 0.4), 0.5) : Math.pow((1 - t) / 0.1, 0.5); return [0.035 * p + 0.002, 0.13 * p + 0.004, 0]; });
  const fin = { pos: [], nrm: [], uv: [], idx: [] };
  const NZ = 80;
  for (let i = 0; i <= NZ; i++) { const t = 0.02 + i / NZ * 0.9, z = (t - 0.5) * L, h = 0.13 * Math.pow(Math.min(1, t / 0.4), 0.5); fin.pos.push(0, h, z, 0, h + 0.07 + 0.015 * Math.sin(i * 1.7), z); fin.nrm.push(1, 0, 0, 1, 0, 0); fin.uv.push(0, t, 1, t); }
  for (let i = 0; i < NZ; i++) { const a = i * 2; fin.idx.push(a, a + 1, a + 2, a + 1, a + 3, a + 2); }
  for (let k = 0; k < 7; k++) { const z = L * 0.43 - k * 0.035; addFin(fin, [[0, 0.12, z], [0.004, 0.55 - k * 0.04, z - 0.12 - k * 0.02], [0, 0.12, z - 0.02]]); }   // head crest rays
  return { body: f32(m), fin: f32(fin), L };
}
// siphonophore nectophore / bell (~6 cm): open cup
function bellMesh() {
  const m = { pos: [], nrm: [], uv: [], idx: [] }, S = 10, R = 6;
  for (let j = 0; j <= R; j++) for (let i = 0; i <= S; i++) {
    const t = j / R, a = i / S * Math.PI * 2, r = 0.03 * Math.sin(t * Math.PI * 0.55 + 0.25), y = 0.035 * Math.cos(t * Math.PI * 0.55);
    m.pos.push(Math.cos(a) * r, y, Math.sin(a) * r); m.nrm.push(Math.cos(a), 0.4, Math.sin(a)); m.uv.push(i / S, t);
  }
  for (let j = 0; j < R; j++) for (let i = 0; i < S; i++) { const a = j * (S + 1) + i, b = a + 1, c = a + S + 1, d = c + 1; m.idx.push(a, c, b, b, c, d); }
  return f32(m);
}

// 'headless chicken monster' (Enypniastes eximia ~25 cm): translucent crimson sea cucumber, webbed veil at the front
function chickenMesh() {
  const L = 0.25, m = lathe(L, 16, 12, (t) => { const p = Math.pow(Math.sin(Math.PI * Math.min(0.999, 0.05 + t * 0.92)), 0.7); return [0.045 * p, 0.05 * p, 0]; });
  const veil = { pos: [], nrm: [], uv: [], idx: [] };
  const NV = 14, z0 = L * 0.38;
  veil.pos.push(0, 0.02, z0); veil.nrm.push(0, 0, 1); veil.uv.push(0, 0);
  for (let i = 0; i <= NV; i++) { const a = (i / NV - 0.5) * 3.6; veil.pos.push(Math.sin(a) * 0.13, 0.03 + Math.cos(a) * 0.1, z0 + 0.05 + 0.02 * Math.cos(i * 1.3)); veil.nrm.push(0, 0.3, 1); veil.uv.push(i / NV, 1); }
  for (let i = 0; i < NV; i++) veil.idx.push(0, i + 1, i + 2);
  const legs = { pos: [], nrm: [], uv: [], idx: [] };                 // tube-feet fringe under the rear
  for (let k = 0; k < 10; k++) addSphere(legs, [(k % 2 ? 1 : -1) * 0.03, -0.05, -L * 0.1 - (k >> 1) * 0.02], 0.009, 4, 3);
  return { body: f32(m), veil: f32(veil), legs: f32(legs), L };
}
// comb jelly (ctenophore ~15 cm): ghostly oval, 8 comb rows that scatter rainbow light
function combMesh() {
  const body = lathe(0.15, 14, 16, (t) => { const p = Math.sin(Math.PI * Math.min(0.999, 0.03 + t * 0.94)); return [0.05 * Math.pow(p, 0.7), 0.05 * Math.pow(p, 0.7), 0]; });
  const rows = [0, 1, 2, 3].map(() => ({ pos: [], nrm: [], uv: [], idx: [] }));
  for (let r = 0; r < 8; r++) { const a = r / 8 * Math.PI * 2, M = rows[r % 4]; for (let k = 0; k < 14; k++) { const t = 0.12 + k / 13 * 0.76, p = Math.sin(Math.PI * t); addSphere(M, [Math.cos(a) * 0.051 * Math.pow(p, 0.7), Math.sin(a) * 0.051 * Math.pow(p, 0.7), (t - 0.5) * 0.15], 0.0035, 4, 3); } }
  return { body: f32(body), rows: rows.map(f32) };
}
// ---------------------------------------------------------------- system
export class DeepLife {
  constructor(R, world) {
    this.R = R; this.W = world;
    const kind = (meshes, max, extra = {}) => {
      const parts = meshes.map(([mesh, mat]) => ({ gm: R.mesh(mesh), mat: R.material(mat), spec: mat, obj: R.object(max * 64) }));
      for (const p of parts) { p.obj.data.set(extra.swim || [0, 0, 0, 0], 16); p.obj.data.set([1, 1, 1, 1], 20); p.obj.data.set(extra.extra || [0, 0.25, 0, 0], 24); p.obj.data.set(extra.bounds || [0, 0, 0, 0], 28); }
      return { parts, max, inst: new Float32Array(max * 16), n: 0 };
    };
    const lm = lanternMesh(), hm = hatchetMesh(), om = oarMesh(), bm = bellMesh(), cm = chickenMesh(), qm = combMesh();
    const glow = (c, s) => ({ color: [c[0], c[1], c[2], 1], emissive: c, emissiveStrength: s, rough: 0.4, gear: true });   // gear: emissive in screen units (independent of eye adaptation)
    this.K = {
      lantern: kind([[lm.body, { color: [1, 1, 1, 1], metal: 0.75, rough: 1, tex: 'lantern' }], [lm.eyes, { color: [0.02, 0.02, 0.03, 1], metal: 0.2, rough: 0.05 }], [lm.ph, glow([0.25, 0.65, 1.0], 1.1)]], 240,
        { swim: [0.1, 13, 6, 0], bounds: [lm.L / 2, lm.L, 0, 0], extra: [0, 0.2, 0, 1] }),
      hatchet: kind([[hm.body, { color: [1, 1, 1, 1], metal: 0.7, rough: 1, tex: 'hatchet' }], [hm.eyes, { color: [0.03, 0.03, 0.04, 1], metal: 0.2, rough: 0.05 }], [hm.ph, glow([0.3, 0.55, 1.0], 0.9)]], 90,
        { swim: [0.05, 9, 4, 0], bounds: [hm.L / 2, hm.L, 0, 0] }),
      oar: kind([[om.body, { color: [1, 1, 1, 1], metal: 1, rough: 1, tex: 'oar' }], [om.fin, { color: [0.85, 0.12, 0.1, 1], rough: 0.6 }]], 2,
        { swim: [0.035, 1.6, 9, 0.02], bounds: [om.L / 2, om.L, 0, 0], extra: [0, 0.3, 0, 0] }),
      bell: kind([[bm, glow([0.2, 0.8, 0.9], 0.45)]], 320, { swim: [0, 0, 0, 0] }),
      chicken: kind([[cm.body, { color: [1, 1, 1, 1], metal: 1, rough: 1, tex: 'gel', emissive: [0.4, 0.06, 0.1], emissiveStrength: 0.012, gear: true }], [cm.veil, { color: [1.1, 1, 1, 1], metal: 1, rough: 1, tex: 'gel', emissive: [0.4, 0.06, 0.1], emissiveStrength: 0.015, gear: true }], [cm.legs, { color: [0.9, 0.4, 0.4, 1], rough: 0.5 }]], 4,
        { swim: [0.06, 1.2, 2.5, 0.12], bounds: [cm.L / 2, cm.L, 0, 0], extra: [0, 0.8, 0, 0] }),
      comb: kind([[qm.body, { color: [0.05, 0.07, 0.09, 1], rough: 0.1, emissive: [0.15, 0.25, 0.35], emissiveStrength: 0.12, gear: true }],
        ...qm.rows.map((r, i) => [r, glow([[1, 0.25, 0.3], [0.3, 1, 0.4], [0.25, 0.5, 1], [0.9, 0.35, 1]][i], 0.9)])], 4, { swim: [0, 0, 0, 0] }),
    };
    this.schools = [0, 1, 2].map((i) => ({ sp: 'lantern', n: 80, band: [180, 1300], center: null, vel: [0.3, 0, 0], fish: null, seed: i }));
    this.hatchGroups = [0, 1].map((i) => ({ n: 30, band: [300, 1100], center: null, fish: null, seed: i }));
    this.oar = { band: [150, 1000], pos: null, dir: [1, 0, 0], vert: 0, t: 0 };
    this.siphs = [0, 1].map((i) => ({ n: 150, band: [500, 3200], pos: null, ph: i * 2.1 }));
    this.drumT = 5; this.clickT = 8;
    this.chickens = [0, 1, 2].map((i) => ({ band: [450, 2600], p: null, ph: i * 2.3, i }));
    // PBR texture sets (assets/textures/creatures): swap the materials in once loaded
    const load = async (n) => createImageBitmap(await (await fetch(`assets/textures/creatures/${n}.jpg`)).blob(), { colorSpaceConversion: 'none' });
    (async () => {
      const cache = {};
      for (const K of Object.values(this.K)) for (const p of K.parts) {
        const t = p.spec.tex; if (!t) continue;
        cache[t] = cache[t] || { b: await load(t + '_basecolor'), n: await load(t + '_normal'), m: await load(t + '_mr') };
        p.mat = R.material({ ...p.spec, baseTex: cache[t].b, normalTex: cache[t].n, mrTex: cache[t].m, normalScale: 1.0 });
      }
    })().catch((e) => console.error('creature textures', e));
    this.combs = [0, 1, 2, 3].map((i) => ({ band: [250, 2200], p: null, spin: Math.random() * 6.28, i }));
  }

  push(k, M) { const K = this.K[k]; if (K.n >= K.max) return; rel(M, K.inst.subarray(K.n * 16, K.n * 16 + 16)); K.n++; }
  mat(p, dir, roll, sc, ph, spd, bend = 0) {
    const f = v3.norm(dir); let r = v3.cross([0, 1, 0], f); r = v3.len(r) < 1e-4 ? [1, 0, 0] : v3.norm(r); let u = v3.cross(f, r);
    if (roll) { const c = Math.cos(roll), s = Math.sin(roll); const r2 = v3.add(v3.scale(r, c), v3.scale(u, s)); u = v3.add(v3.scale(u, c), v3.scale(r, -s)); r = r2; }
    const M = m4.basis(v3.scale(r, sc), v3.scale(u, sc), v3.scale(f, sc), p); M[3] = ph; M[7] = spd; M[11] = 0; M[15] = 1 + bend; return M;
  }

  update(dt, t, P, depth, D, cm) {
    const W = this.W, A = W.A;
    for (const K of Object.values(this.K)) K.n = 0;
    const inBand = (b) => depth > b[0] && depth < b[1];
    const pan = (p) => { const d = v3.norm(v3.sub(p, P)); return d[0] * cm[0] + d[1] * cm[1] + d[2] * cm[2]; };
    const torch = W.torchOn ? { p: W.torchP, d: W.torchD } : null;
    const inBeam = (p) => { if (!torch) return 0; const d = v3.sub(p, torch.p), l = v3.len(d); return l < 25 ? smooth(0.85, 0.95, v3.dot(d, torch.d) / l) * (1 - l / 25) : 0; };

    // ---- lanternfish schools: milling, dart away from the torch beam (they flee bright light)
    for (const S of this.schools) {
      if (!S.center) {
        if (!inBand(S.band)) continue;
        S.center = W.hiddenSpawn(P, S.seen ? 30 : 10 + S.seed * 6, (Math.random() - 0.5) * 6); S.seen = true;
        S.fish = [...Array(S.n)].map(() => ({ off: [(Math.random() - 0.5) * 5, (Math.random() - 0.5) * 2.5, (Math.random() - 0.5) * 5], p: null, v: [0, 0, 0], ph: Math.random() * 6.28, sc: (S.cohort = S.cohort || 0.75 + Math.random() * 0.6) * sizeVar(0.12) }));
      }
      const home = v3.add(P, [Math.sin(t * 0.05 + S.seed * 2) * 14, Math.sin(t * 0.07 + S.seed) * 3, Math.cos(t * 0.04 + S.seed * 2) * 14]);
      S.vel = v3.lerp(S.vel, v3.scale(v3.norm(v3.sub(home, S.center)), inBand(S.band) ? 0.35 : 0.6), 1 - Math.exp(-dt * 0.3));
      if (!inBand(S.band)) S.vel = v3.add(S.vel, [0, depth < S.band[0] ? -0.2 : 0.2, 0].map((x) => x * dt));
      S.center = v3.add(S.center, v3.scale(S.vel, dt));
      let flee = 0;
      for (const f of S.fish) {
        const slot = v3.add(S.center, f.off);
        if (!f.p) { f.p = [...slot]; f.v = v3.scale(S.vel, 1); }
        let acc = v3.scale(v3.sub(slot, f.p), 0.8);
        const b = inBeam(f.p); if (b > 0) { const aw = v3.norm(v3.cross(torch.d, [0, 1, 0])); acc = v3.add(acc, v3.scale(v3.dot(v3.sub(f.p, torch.p), aw) > 0 ? aw : v3.scale(aw, -1), 9 * b)); flee = Math.max(flee, b); }
        const fr = 2.5 + Math.min(v3.len(W.camVel || [0, 0, 0]), 3) * 1.5;   // flee the approaching diver
        const dd = v3.sub(f.p, P), dl = v3.len(dd); if (dl < fr) acc = v3.add(acc, v3.scale(dd, (fr - dl) / Math.max(dl, 0.1) * 10));
        f.v = v3.add(v3.scale(f.v, Math.exp(-dt * 1.4)), v3.scale(acc, dt));
        const sp = v3.len(f.v); if (sp > 2.2) f.v = v3.scale(f.v, 2.2 / sp);
        f.p = v3.add(f.p, v3.scale(f.v, dt));
        const dir = sp > 0.05 ? [f.v[0], clamp(f.v[1], -0.3 * sp, 0.3 * sp), f.v[2]] : S.vel;
        this.push('lantern', this.mat(f.p, dir, 0, f.sc * 1.3, f.ph, 0.6 + sp * 1.2));
      }
      if (flee > 0.3 && t - (S.lastFlee || 0) > 2.5) { S.lastFlee = t; A.bio('swish', 0.25 * flee * (1 - smooth(4, 20, v3.dist(S.center, P))), pan(S.center)); }
      if (!inBand(S.band) && W.outOfSight(S.center, P, 4)) S.center = null;
      else if (W.outOfSight(S.center, P, 4) && v3.dist(S.center, P) > 60) S.center = null;
    }
    // ---- hatchetfish: small loose groups hovering, slowly turning; mirror flanks flash in the torch
    for (const G of this.hatchGroups) {
      if (!G.center) {
        if (!inBand(G.band)) continue;
        G.center = W.hiddenSpawn(P, G.seen ? 26 : 8 + G.seed * 5, (Math.random() - 0.5) * 4); G.seen = true;
        G.fish = [...Array(G.n)].map(() => ({ sc: 1.4 * sizeVar(0.14), off: [(Math.random() - 0.5) * 3, (Math.random() - 0.5) * 2, (Math.random() - 0.5) * 3], yaw: Math.random() * 6.28, yv: 0, ph: Math.random() * 6.28 }));
      }
      G.center = v3.add(G.center, v3.scale([Math.sin(t * 0.03 + G.seed) * 0.15, 0.02 * Math.sin(t * 0.1), Math.cos(t * 0.03 + G.seed) * 0.15], dt));
      for (const f of G.fish) {
        f.yv += ((Math.random() - 0.5) * 0.8 - f.yv * 0.6) * dt; f.yaw += f.yv * dt;
        let p = v3.add(G.center, v3.add(f.off, [0, 0.08 * Math.sin(t * 0.7 + f.ph), 0]));
        // shy: scoot away from the diver (keeps an offset that relaxes back when the diver leaves)
        const dd = v3.sub(p, P), dl = v3.len(dd), fr = 2.2 + Math.min(v3.len(W.camVel || [0, 0, 0]), 3);
        f.esc = v3.lerp(f.esc || [0, 0, 0], dl < fr ? v3.scale(dd, (fr - dl) / Math.max(dl, 0.1) * 1.6) : [0, 0, 0], 1 - Math.exp(-dt * (dl < fr ? 3 : 0.4)));
        p = v3.add(p, f.esc);
        this.push('hatchet', this.mat(p, [Math.sin(f.yaw), 0.05 * Math.sin(t * 0.5 + f.ph), Math.cos(f.yaw)], 0.08 * Math.sin(t * 0.4 + f.ph), f.sc, f.ph, 0.4));
      }
      if (W.outOfSight(G.center, P, 3) && (!inBand(G.band) || v3.dist(G.center, P) > 50)) G.center = null;
    }
    // ---- oarfish: one giant ribbon gliding by, sometimes hanging vertically head-up
    const O = this.oar;
    if (!O.pos && inBand(O.band) && (O.wait = (O.wait ?? 20) - dt) <= 0 && !W.stageBusy?.('oar')) {
      const f = v3.norm([W.camFwd[0], 0, W.camFwd[2]]), side = Math.random() < 0.5 ? -1 : 1, r = [-f[2], 0, f[0]];
      const close = W.cineClose ? 2.5 : 5 + Math.random() * 4;
      O.pos = v3.add(P, v3.add(v3.scale(r, side * 34), v3.add(v3.scale(f, close), [0, (Math.random() - 0.5) * 2, 0])));
      O.dir = v3.scale(r, -side); O.t = 0; O.vert = 0; O.passed = false;
    }
    if (O.pos) {
      O.t += dt;
      O.vert = lerp(O.vert, O.t > 30 && O.t < 45 ? 1 : 0, 1 - Math.exp(-dt * 0.3));        // pauses to hang vertically mid-pass
      const sp = 0.45 * (1 - O.vert * 0.9);
      O.pos = v3.add(O.pos, v3.scale(O.dir, sp * dt));
      const dir = v3.norm(v3.lerp(O.dir, [0, 1, 0], O.vert * 0.97));
      this.push('oar', this.mat(O.pos, dir, 0, 1, 0, 0.6 + sp));
      const dd = v3.dist(O.pos, P);
      if (!O.passed && dd < 6) { O.passed = true; A.bio('swish', 0.35, pan(O.pos)); A.play?.('creature_move', 0.25, { rate: 0.5, pan: pan(O.pos) }); }
      if (O.t > 60 && W.outOfSight(O.pos, P, 3)) { O.pos = null; O.wait = 90 + Math.random() * 90; }
    }
    // ---- siphonophores: 6–10 m glowing chains drifting in slow S-curves
    for (const S of this.siphs) {
      if (!S.pos) {
        if (!inBand(S.band)) continue;
        S.pos = W.hiddenSpawn(P, S.seen ? 30 : 12, (Math.random() - 0.5) * 6); S.seen = true; S.axis = v3.norm([Math.random() - 0.5, (Math.random() - 0.5) * 0.6, Math.random() - 0.5]);
        S.vel = null;
        if (W.cineClose) {   // close encounter: start just outside the field of view to the side, drift across in front of the mask
          const f = v3.norm([W.camFwd[0], 0, W.camFwd[2]]), r = [-f[2], 0, f[0]], sd = Math.random() < 0.5 ? -1 : 1;
          S.pos = v3.add(P, v3.add(v3.scale(r, sd * 9), v3.add(v3.scale(f, 2.5), [0, 1.2, 0]))); S.axis = v3.norm([f[0] + r[0] * 0.3, 0.15, f[2] + r[2] * 0.3]);
          S.vel = v3.scale(r, -sd * 0.22);
        }
      }
      S.pos = v3.add(S.pos, v3.scale(S.vel ? v3.add(S.vel, [0, 0.01 * Math.sin(t * 0.1 + S.ph), 0]) : [0.03, 0.01 * Math.sin(t * 0.1 + S.ph), 0.02], dt));
      const side = v3.norm(v3.cross(S.axis, [0, 1, 0])), up = v3.cross(side, S.axis);
      for (let k = 0; k < S.n; k++) {
        const s = k * 0.055, w = Math.sin(s * 0.7 - t * 0.35 + S.ph) * 0.6, w2 = Math.cos(s * 0.45 - t * 0.25 + S.ph) * 0.4;
        const p = v3.add(S.pos, v3.add(v3.scale(S.axis, s), v3.add(v3.scale(side, w), v3.scale(up, w2))));
        const pulse = 0.6 + 0.4 * Math.sin(t * 2.2 - k * 0.3);
        const M = this.mat(p, [S.axis[0], S.axis[1], S.axis[2]], k * 0.9, (k < 12 ? 1.2 : 0.55) * pulse, 0, 0);
        this.push('bell', M);
      }
      const mid = v3.add(S.pos, v3.scale(S.axis, S.n * 0.0275));
      if (W.lightList) W.lightList.push({ p: mid, c: [0.03, 0.12, 0.14], r: 7 });
      const dd = v3.dist(mid, P);
      if (dd < 7 && t - (S.lastShim || 0) > 5 + Math.random() * 4) { S.lastShim = t; A.bio('shimmer', 0.18 * (1 - dd / 7), pan(mid)); }
      if (W.outOfSight(S.pos, P, 8) && (!inBand(S.band) || dd > 60)) S.pos = null;
    }
    // ---- headless chicken monsters: rise with slow veil pulses, sink, tumble head-down now and then
    for (const c of this.chickens) {
      if (!c.p) { if (!inBand(c.band)) continue; c.p = W.hiddenSpawn(P, c.seen ? 22 : 6 + c.i * 4, (Math.random() - 0.5) * 4); c.seen = true; c.yaw = Math.random() * 6.28; c.drift = null; if (W.cineClose) { const f = v3.norm([W.camFwd[0], 0, W.camFwd[2]]), r = [-f[2], 0, f[0]], sd = Math.random() < 0.5 ? -1 : 1; c.p = v3.add(P, v3.add(v3.scale(r, sd * 4.5), v3.add(v3.scale(f, 1.8), [0, -0.8, 0]))); c.drift = v3.scale(r, -sd * 0.12); } }
      const pulse = Math.max(0, Math.sin(t * 0.9 + c.ph));
      c.p = v3.add(c.p, [0.02 * Math.sin(t * 0.1 + c.i) * dt, (0.12 * pulse - 0.04) * dt, 0.02 * Math.cos(t * 0.1 + c.i) * dt]);
      if (c.drift) c.p = v3.add(c.p, v3.scale(c.drift, dt));
      c.yaw += 0.05 * dt;
      const pitch = 1.1 + 0.25 * Math.sin(t * 0.15 + c.ph);                  // mostly head-up, veil working like a bell
      const dir = [Math.sin(c.yaw) * Math.cos(pitch), Math.sin(pitch), Math.cos(c.yaw) * Math.cos(pitch)];
      this.push('chicken', this.mat(c.p, dir, 0, 1.0, c.ph, 0.6 + pulse));
      if (W.outOfSight(c.p, P, 1) && (!inBand(c.band) || v3.dist(c.p, P) > 40)) c.p = null;
    }
    // ---- comb jellies: slowly rotating ghosts, rainbow comb rows rippling
    for (const c of this.combs) {
      if (!c.p) { if (!inBand(c.band)) continue; c.p = W.hiddenSpawn(P, c.seen ? 18 : 3 + c.i * 3, (Math.random() - 0.5) * 3); c.seen = true; c.axis = v3.norm([Math.random() - 0.5, 1.5, Math.random() - 0.5]); }
      c.spin += dt * 0.6; c.p = v3.add(c.p, v3.scale(c.axis, 0.03 * dt));
      const M = this.mat(c.p, c.axis, c.spin, 1.0, 0, 0);
      this.push('comb', M);
      const dd = v3.dist(c.p, P);
      if (dd < 3 && t - (c.lastShim || 0) > 6) { c.lastShim = t; A.bio('shimmer', 0.12 * (1 - dd / 3), pan(c.p)); }
      if (W.outOfSight(c.p, P, 1) && (!inBand(c.band) || dd > 35)) c.p = null;
    }
    // ---- deep biophony
    if (depth > 150) {
      this.drumT -= dt;
      if (this.drumT <= 0) { this.drumT = 6 + Math.random() * 16; A.bio(Math.random() < 0.7 ? 'drum' : 'grunt', 0.12 + Math.random() * 0.25, Math.random() * 1.6 - 0.8); }
    }
    if (depth > 300 && depth < 2000) {
      this.clickT -= dt;
      if (this.clickT <= 0) { this.clickT = 25 + Math.random() * 40; A.bio(Math.random() < 0.75 ? 'click' : 'creak', 0.35 + Math.random() * 0.35, Math.random() * 1.6 - 0.8, true); }
    }
    // ---- draws
    for (const [key, K] of Object.entries(this.K)) {
      if (!K.n) continue;
      for (const p of K.parts) {
        this.R.device.queue.writeBuffer(p.obj.sb, 0, K.inst, 0, K.n * 16); this.R.writeObj(p.obj);
        D.push({ gm: p.gm, mat: p.mat, obj: p.obj, kind: 'inst', instances: K.n, shadow: key === 'oar' });
      }
    }
  }
}
