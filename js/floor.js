// Abyssal floor life: procedural rocks, cold-water coral colonies, methane seeps (bubble streams, bacterial mats,
// shrimp swarms), crab piles + lone crabs, and sediment dust kicked up by anything touching the bottom.
// Placement is deterministic per world cell (hash), so nothing ever pops: cells are populated well beyond sight.
import { m4, v3, clamp, lerp, smooth, rng, ORIGIN, rel } from './math.js';

// ---------------------------------------------------------------- noise helpers
function ih(x, y, z = 0) {
  let h = (Math.imul(x | 0, 374761393) + Math.imul(y | 0, 668265263) + Math.imul(z | 0, 2147483647)) >>> 0;
  h = Math.imul(h ^ (h >>> 13), 1274126177) >>> 0; h = (h ^ (h >>> 16)) >>> 0;
  return (h & 0xffffff) / 16777216;
}
function vn3(x, y, z, s = 0) {
  const ix = Math.floor(x), iy = Math.floor(y), iz = Math.floor(z), fx = x - ix, fy = y - iy, fz = z - iz;
  const u = fx * fx * (3 - 2 * fx), v = fy * fy * (3 - 2 * fy), w = fz * fz * (3 - 2 * fz);
  const c = (a, b, d) => ih(ix + a + s * 131, iy + b, iz + d);
  const x00 = lerp(c(0, 0, 0), c(1, 0, 0), u), x10 = lerp(c(0, 1, 0), c(1, 1, 0), u), x01 = lerp(c(0, 0, 1), c(1, 0, 1), u), x11 = lerp(c(0, 1, 1), c(1, 1, 1), u);
  return lerp(lerp(x00, x10, v), lerp(x01, x11, v), w);
}
const fbm3 = (x, y, z, s, oct = 4) => { let r = 0, a = 0.5; for (let i = 0; i < oct; i++) { r += a * vn3(x, y, z, s + i); x *= 2.03; y *= 2.03; z *= 2.03; a *= 0.5; } return r; };

// ---------------------------------------------------------------- mesh builders
function icosphere(sub) {
  const t = (1 + Math.sqrt(5)) / 2;
  let V = [[-1, t, 0], [1, t, 0], [-1, -t, 0], [1, -t, 0], [0, -1, t], [0, 1, t], [0, -1, -t], [0, 1, -t], [t, 0, -1], [t, 0, 1], [-t, 0, -1], [-t, 0, 1]].map(v3.norm);
  let F = [[0, 11, 5], [0, 5, 1], [0, 1, 7], [0, 7, 10], [0, 10, 11], [1, 5, 9], [5, 11, 4], [11, 10, 2], [10, 7, 6], [7, 1, 8], [3, 9, 4], [3, 4, 2], [3, 2, 6], [3, 6, 8], [3, 8, 9], [4, 9, 5], [2, 4, 11], [6, 2, 10], [8, 6, 7], [9, 8, 1]];
  for (let s = 0; s < sub; s++) {
    const cache = new Map(), mid = (a, b) => { const k = a < b ? a + '_' + b : b + '_' + a; if (!cache.has(k)) { cache.set(k, V.length); V.push(v3.norm(v3.scale(v3.add(V[a], V[b]), 0.5))); } return cache.get(k); };
    const F2 = []; for (const [a, b, c] of F) { const ab = mid(a, b), bc = mid(b, c), ca = mid(c, a); F2.push([a, ab, ca], [b, bc, ab], [c, ca, bc], [ab, bc, ca]); } F = F2;
  }
  return { V, F };
}
function smoothNormals(P, F) {
  const N = P.map(() => [0, 0, 0]);
  for (const [a, b, c] of F) { const n = v3.cross(v3.sub(P[b], P[a]), v3.sub(P[c], P[a])); for (const i of [a, b, c]) { N[i][0] += n[0]; N[i][1] += n[1]; N[i][2] += n[2]; } }
  return N.map(v3.norm);
}
// flat-projected (per-triangle dominant axis) UVs on an unindexed copy, smooth normals kept
function boxUV(P, N, F, uvScale) {
  const pos = [], nrm = [], uv = [], idx = [];
  for (const [a, b, c] of F) {
    const fn = v3.cross(v3.sub(P[b], P[a]), v3.sub(P[c], P[a])), ax = [Math.abs(fn[0]), Math.abs(fn[1]), Math.abs(fn[2])];
    const d = ax[1] >= ax[0] && ax[1] >= ax[2] ? 1 : ax[0] >= ax[2] ? 0 : 2;
    for (const i of [a, b, c]) {
      const p = P[i]; pos.push(...p); nrm.push(...N[i]);
      uv.push(...(d === 1 ? [p[0], p[2]] : d === 0 ? [p[2], p[1]] : [p[0], p[1]]).map((x) => x * uvScale));
      idx.push(idx.length);
    }
  }
  return { pos: new Float32Array(pos), nrm: new Float32Array(nrm), uv: new Float32Array(uv), idx: new Uint32Array(idx) };
}
// weathered boulder: noise-displaced sphere with a few crisp fracture planes, flattened, bottom buried
function rockMesh(seed) {
  const { V, F } = icosphere(3), r = rng(seed * 977 + 13);
  const planes = [...Array(2 + Math.floor(r() * 3))].map(() => ({ n: v3.norm([r() - 0.5, (r() - 0.3) * 0.8, r() - 0.5]), d: 0.55 + r() * 0.3 }));
  const sq = [0.8 + r() * 0.5, 0.45 + r() * 0.35, 0.7 + r() * 0.5];
  const P = V.map((p) => {
    let k = 1 + 0.38 * (fbm3(p[0] * 1.3 + seed, p[1] * 1.3, p[2] * 1.3, seed) - 0.5) * 2 + 0.1 * (vn3(p[0] * 4.5, p[1] * 4.5, p[2] * 4.5, seed + 7) - 0.5);
    for (const pl of planes) { const dn = v3.dot(p, pl.n) * k; if (dn > pl.d) k *= pl.d / dn; }       // fracture facets
    let q = [p[0] * k * sq[0], p[1] * k * sq[1], p[2] * k * sq[2]];
    q[1] = Math.max(q[1], -0.28 * sq[1]);                                                          // bedded in the sediment
    return q;
  });
  return boxUV(P, smoothNormals(P, F), F, 0.45);
}
// generic tube along a polyline with radii, n sides
function tubes(segs, sides, out) {
  for (const s of segs) {
    const d = v3.norm(v3.sub(s.b, s.a)); let u = Math.abs(d[1]) < 0.9 ? v3.norm(v3.cross(d, [0, 1, 0])) : v3.norm(v3.cross(d, [1, 0, 0])); const w = v3.cross(d, u);
    const base = out.pos.length / 3, L = v3.dist(s.a, s.b);
    for (let e = 0; e < 2; e++) {
      const c = e ? s.b : s.a, rr = e ? s.rb : s.ra;
      for (let i = 0; i <= sides; i++) {
        const an = i / sides * Math.PI * 2, n = v3.add(v3.scale(u, Math.cos(an)), v3.scale(w, Math.sin(an)));
        out.pos.push(...v3.add(c, v3.scale(n, rr))); out.nrm.push(...n); out.uv.push(i / sides * 2, (s.v0 || 0) + e * L * 3);
      }
    }
    for (let i = 0; i < sides; i++) { const a = base + i, b = a + 1, c2 = a + sides + 1, d2 = c2 + 1; out.idx.push(a, c2, b, b, c2, d2); }
  }
}
const pack = (o) => ({ pos: new Float32Array(o.pos), nrm: new Float32Array(o.nrm), uv: new Float32Array(o.uv), idx: new Uint32Array(o.idx) });
// Lophelia pertusa thicket: dense mound of short, thick, zig-zag branches; a flared corallite cup at every node
function lopheliaMesh(seed) {
  const r = rng(seed), segs = [];
  const grow = (p, d, rad, depth) => {
    if (depth <= 0 || rad < 0.006) return;
    const L = 0.035 + r() * 0.03, nd = v3.norm(v3.add(d, [(r() - 0.5) * 1.1, 0.12 + r() * 0.2, (r() - 0.5) * 1.1]));
    const q = v3.add(p, v3.scale(nd, L));
    segs.push({ a: p, b: q, ra: rad, rb: rad * 0.95 });
    const cup = v3.norm(v3.add(nd, [(r() - 0.5) * 1.2, 0.3, (r() - 0.5) * 1.2]));
    segs.push({ a: q, b: v3.add(q, v3.scale(cup, 0.022)), ra: rad * 0.9, rb: rad * 1.35 });       // corallite cup
    grow(q, nd, rad * 0.95, depth - 1);
    if (r() < 0.8) grow(q, v3.norm(v3.add(nd, [(r() - 0.5) * 2.2, 0.05, (r() - 0.5) * 2.2])), rad * 0.9, depth - 1 - (r() < 0.5 ? 1 : 0));
  };
  for (let k = 0; k < 9; k++) { const a = k / 9 * 6.28 + r(), rr = 0.05 + r() * 0.12; grow([Math.cos(a) * rr, 0, Math.sin(a) * rr], v3.norm([Math.cos(a) * 0.7, 0.8, Math.sin(a) * 0.7]), 0.016, 8); }
  const o = { pos: [], nrm: [], uv: [], idx: [] }; tubes(segs, 5, o); return pack(o);
}
// gorgonian sea fan: planar dichotomous branching with fine anastomosing twigs
function fanMesh(seed) {
  const r = rng(seed), segs = [];
  const grow = (p, a, rad, depth, len) => {
    if (depth <= 0) return;
    const d = [Math.sin(a) * 1, Math.cos(a), (r() - 0.5) * 0.08], q = v3.add(p, v3.scale(v3.norm(d), len));
    segs.push({ a: p, b: q, ra: rad, rb: rad * 0.85 });
    const spread = 0.35 + r() * 0.25;
    grow(q, a - spread * (0.6 + r() * 0.5), rad * 0.78, depth - 1, len * (0.82 + r() * 0.12));
    grow(q, a + spread * (0.6 + r() * 0.5), rad * 0.78, depth - 1, len * (0.82 + r() * 0.12));
  };
  grow([0, 0, 0], 0, 0.02, 1, 0.12);
  grow([0, 0.12, 0], -0.35, 0.016, 8, 0.16); grow([0, 0.12, 0], 0.35, 0.016, 8, 0.16); grow([0, 0.12, 0], 0.0, 0.015, 7, 0.18);
  const o = { pos: [], nrm: [], uv: [], idx: [] }; tubes(segs, 4, o); return pack(o);
}
// glass sponge (Euplectella-like) vase: lathe with a sieve-plate top, double-sided
function spongeMesh(seed) {
  const r = rng(seed), S = 22, Rg = 18, H = 0.55 + r() * 0.35, pos = [], nrm = [], uv = [], idx = [];
  const prof = (t) => 0.035 + 0.07 * Math.sin(Math.min(t * 1.25, 1) * Math.PI * 0.62) + 0.02 * t;
  for (let j = 0; j <= Rg; j++) for (let i = 0; i <= S; i++) {
    const t = j / Rg, a = i / S * Math.PI * 2, rr = prof(t) * (1 + 0.04 * Math.sin(a * 3 + seed)), y = t * H;
    const dr = (prof(Math.min(t + 0.01, 1)) - prof(t)) / (0.01 * H);
    pos.push(Math.cos(a) * rr, y + 0.08 * Math.sin(t * 3 + a) * 0.1, Math.sin(a) * rr);
    const n = v3.norm([Math.cos(a), -dr, Math.sin(a)]); nrm.push(...n); uv.push(i / S * 3, t * 4);
  }
  for (let j = 0; j < Rg; j++) for (let i = 0; i < S; i++) { const a = j * (S + 1) + i, b = a + 1, c = a + S + 1, d = c + 1; idx.push(a, c, b, b, c, d); }
  return { pos: new Float32Array(pos), nrm: new Float32Array(nrm), uv: new Float32Array(uv), idx: new Uint32Array(idx) };
}
// seep shrimp (Alvinocaris-like): segmented body along +Z, rostrum, legs, tail fan (swim deform flexes the abdomen)
function shrimpMesh() {
  const segs = [], L = 0.07;
  const body = (t) => 0.0075 * Math.sin(Math.min(1, t * 1.1) * Math.PI * 0.9 + 0.2);
  for (let i = 0; i < 9; i++) { const t0 = i / 9, t1 = (i + 1) / 9; segs.push({ a: [0, 0.004 * Math.sin(t0 * 3), (0.5 - t0) * L], b: [0, 0.004 * Math.sin(t1 * 3), (0.5 - t1) * L], ra: body(t0) + 0.001, rb: body(t1) + 0.001 }); }
  segs.push({ a: [0, 0.002, L * 0.5], b: [0, 0.006, L * 0.72], ra: 0.0018, rb: 0.0004 });           // rostrum
  for (const s of [-1, 1]) {
    for (let k = 0; k < 5; k++) { const z = L * (0.3 - k * 0.07); segs.push({ a: [s * 0.004, -0.003, z], b: [s * 0.012, -0.013, z - 0.004], ra: 0.0009, rb: 0.0005 }); }
    segs.push({ a: [s * 0.002, 0, -L * 0.5], b: [s * 0.009, 0.001, -L * 0.62], ra: 0.0025, rb: 0.0006 }); // tail fan
  }
  const o = { pos: [], nrm: [], uv: [], idx: [] }; tubes(segs, 5, o); return pack(o);
}
// the two long antennae as their own mesh: base at z = 0.032, tips forward; swim deform (reversed axis) waves the tips
function antennaMesh() {
  const segs = [];
  for (const s of [-1, 1]) for (let i = 0; i < 8; i++) {
    const t0 = i / 8, t1 = (i + 1) / 8, p = (t) => [s * (0.003 + t * 0.028), 0.002 + t * 0.012 + Math.sin(t * 2.5) * 0.004, 0.032 + t * 0.085];
    segs.push({ a: p(t0), b: p(t1), ra: 0.0006 * (1 - t0 * 0.7), rb: 0.0006 * (1 - t1 * 0.7) });
  }
  const o = { pos: [], nrm: [], uv: [], idx: [] }; tubes(segs, 4, o); return pack(o);
}
// authigenic carbonate chimney: knobbly tapering tube with an open crater at the top (bubbles leave from y = 1)
function chimneyMesh(seed) {
  const r = rng(seed), S = 26, Rg = 24, P = [];
  const lean = (t) => [Math.sin(seed) * 0.1 * t * t, 0, Math.cos(seed) * 0.1 * t * t];
  for (let j = 0; j <= Rg; j++) for (let i = 0; i <= S; i++) {
    const t = j / Rg, a = i / S * Math.PI * 2, ca = Math.cos(a), sa = Math.sin(a);
    // craggy carbonate: lumpy knobs + fine porosity, a flared, ragged crater rim at the top
    let rr = lerp(0.22, 0.075, Math.pow(t, 0.7));
    rr *= 1 + 0.55 * (fbm3(ca * 1.6 + seed, t * 5, sa * 1.6, seed) - 0.5) * 2 + 0.18 * (vn3(ca * 6, t * 18, sa * 6, seed + 3) - 0.5) * 2;
    if (t > 0.9) rr *= 1 + (t - 0.9) * 4.5 * (0.7 + 0.6 * vn3(ca * 3, 1, sa * 3, seed + 9));
    const l = lean(t);
    P.push([ca * rr + l[0], t, sa * rr + l[2]]);
  }
  const F = [];
  for (let j = 0; j < Rg; j++) for (let i = 0; i < S; i++) { const a = j * (S + 1) + i, b = a + 1, c = a + S + 1, d = c + 1; F.push([a, c, b], [b, c, d]); }
  // crater: inner wall dropping into a dark throat
  const top = Rg * (S + 1), l1 = lean(1), inner = P.length;
  for (let i = 0; i <= S; i++) { const a = i / S * Math.PI * 2; P.push([Math.cos(a) * 0.05 + l1[0], 0.84, Math.sin(a) * 0.05 + l1[2]]); }
  for (let i = 0; i < S; i++) { const a = top + i, b = a + 1, c = inner + i, d = c + 1; F.push([a, c, b], [b, c, d]); }
  const c0 = P.length; P.push([l1[0], 0.8, l1[2]]);
  for (let i = 0; i < S; i++) F.push([inner + i, c0, inner + i + 1]);
  return boxUV(P, smoothNormals(P, F), F, 1.6);
}
// ---------------------------------------------------------------- the floor life system
export class FloorLife {
  constructor(R, world, floorH, FLOOR_DEPTH, models) {
    this.R = R; this.W = world; this.floorH = floorH; this.FD = FLOOR_DEPTH; this.ready = false;
    this.kinds = {};
    const mk = (key, meshes, max, matOpts, extra = {}) => {
      const gms = meshes.map((m) => R.mesh(m));
      this.kinds[key] = { gms, max, matOpts, mat: null, objs: gms.map(() => { const o = R.object(max * 64); o.data.set([0, 0, 0, 0], 16); o.data.set(extra.tint || [1, 1, 1, 1], 20); o.data.set(extra.extra || [0, 0.1, 0, 0], 24); o.data.set(extra.bounds || [0, 0, 0, 0], 28); return o; }), inst: gms.map(() => new Float32Array(max * 16)), count: gms.map(() => 0) };
    };
    mk('rock', [1, 2, 3, 4, 5, 6].map(rockMesh), 70, { tex: 'rock', rough: 1.0 }, { extra: [0, 0.05, 0, 3.0] });   // extra.w 3: sediment-dusted tops
    mk('lophelia', [11, 12, 13].map(lopheliaMesh), 40, { tex: 'coral', color: [1.0, 0.93, 0.9, 1], rough: 0.8, normalScale: 0.4 }, { extra: [0, 0.45, 0, 0] });
    mk('fan', [21, 22].map(fanMesh), 30, { tex: 'coral', color: [0.95, 0.42, 0.2, 1], rough: 0.85, normalScale: 0.4 }, { extra: [0, 0.4, 0, 0] });
    mk('sponge', [31, 32].map(spongeMesh), 24, { tex: 'coral', color: [0.92, 0.9, 0.82, 1], rough: 0.7 }, { extra: [0, 0.6, 0, 0] });
    mk('shrimp', [shrimpMesh()], 400, { tex: 'shell' }, { extra: [0, 0.6, 0, 0], bounds: [0.035, 0.07, 0, 0] });
    for (const o of this.kinds.shrimp.objs) o.data.set([0.12, 14.0, 5.0, 0], 16);        // abdomen flicks (spd 0 when perched)
    mk('antenna', [antennaMesh()], 400, { tex: 'shell' }, { extra: [0, 0.6, 0, 0], bounds: [0.032, -0.085, 0, 0] });
    for (const o of this.kinds.antenna.objs) o.data.set([0.09, 2.6, 2.2, 0], 16);        // slow antennal sweeping (reversed axis: tips move most)
    mk('chimney', [41, 42, 43].map(chimneyMesh), 40, { tex: 'rock', color: [0.95, 0.88, 0.76, 1], rough: 1.0 }, { extra: [0, 0.05, 0, 3.0] });
    addCrawlers(this, R);
    // crab piles use the static king-crab scan
    this.crabSp = world.sp.crabStatic || world.sp.crabscan;
    this.pile = { max: 160, objs: this.crabSp.gpu.prims.map(() => R.object(160 * 64)), inst: new Float32Array(160 * 16), count: 0 };
    // textures (async)
    const load = async (n) => createImageBitmap(await (await fetch(`assets/textures/floor/${n}.jpg`)).blob(), { colorSpaceConversion: 'none' });
    (async () => {
      const T = {};
      for (const k of ['rock', 'coral']) T[k] = { b: await load(k + '_basecolor'), n: await load(k + '_normal'), m: await load(k + '_mr') };
      const loadC = async (n) => createImageBitmap(await (await fetch(`assets/textures/creatures/${n}.jpg`)).blob(), { colorSpaceConversion: 'none' });
      for (const k of ['chitin', 'leg', 'shell', 'polyp']) T[k] = { b: await loadC(k + '_basecolor'), n: await loadC(k + '_normal'), m: await loadC(k + '_mr') };
      R.setSandTextures(await load('sand_normal'), await load('sand_albedo'));
      for (const k of Object.values(this.kinds)) {
        const t = k.matOpts.tex && T[k.matOpts.tex];
        const creature = ['chitin', 'leg', 'shell', 'polyp'].includes(k.matOpts.tex);
        k.mat = R.material({ color: creature ? [1, 1, 1, 1] : k.matOpts.color || [1, 1, 1, 1], rough: creature ? 1 : k.matOpts.rough, metal: creature ? 1 : 0, baseTex: t?.b, normalTex: t?.n, mrTex: t?.m, normalScale: k.matOpts.normalScale ?? 1.0, maxTex: 1024 });
      }
      this.ready = true;
    })().catch((e) => console.error('floor textures', e));
    // dust puffs (rendered by the particle shader, mode 3: two vec4 per puff)
    this.dustMax = 2400; this.dust = []; this.dustData = new Float32Array(this.dustMax * 8);
    const o = R.object(this.dustMax * 32);
    o.data.set([1, 1, 1, 0, 0, 0, 0, 0, 0.62, 0.56, 0.46, 1, 1, 0, 3, 1.8]);
    this.dustFx = { obj: o, count: 0, max: this.dustMax };
    this.seeps = []; this.shrimp = []; this.lone = [];
    this.forced = null;
  }

  // ---------------- dust: every kick is a small vortex; silt puffs roll with it, sand grains are flung up and settle
  kick(p, strength = 1, n = 3, spread = 0.15, up = 0.12) {
    if (this.dust.length > this.dustMax - 20) return;
    const cl = { c: [...p], w: (Math.random() < 0.5 ? -1 : 1) * (2.5 + Math.random() * 3.0) * Math.min(strength, 1.4), roll: (0.6 + Math.random() * 0.8) * strength, age: 0 };
    for (let i = 0; i < n * 3; i++) {
      const a = Math.random() * 6.28, rr = spread * (0.3 + Math.random() * 0.9);
      this.dust.push({ cl, off: [Math.cos(a) * rr, 0.02 + Math.random() * 0.05, Math.sin(a) * rr], v: [Math.cos(a) * 0.1 * strength, (0.04 + Math.random() * up) * strength, Math.sin(a) * 0.1 * strength],
        r0: 0.02 + Math.random() * 0.03 * strength, g: 0.04 + 0.06 * strength, age: 0, life: 4 + Math.random() * 5 * strength, a: (0.07 + Math.random() * 0.09) * Math.min(strength, 1.2), s: Math.random(), grain: 0 });
    }
    const ng = Math.round(n * 10 * Math.min(strength, 1.5));
    for (let i = 0; i < ng; i++) {
      const a = Math.random() * 6.28, rr = spread * Math.random() * 0.6;
      this.dust.push({ cl, off: [Math.cos(a) * rr, 0.01, Math.sin(a) * rr], v: [Math.cos(a) * (0.08 + Math.random() * 0.25) * strength, (0.12 + Math.random() * 0.45) * strength, Math.sin(a) * (0.08 + Math.random() * 0.25) * strength],
        r0: 0.002 + Math.random() * 0.003, g: 0, age: 0, life: 2.5 + Math.random() * 3.5, a: 0.8 + Math.random() * 0.2, s: Math.random(), grain: 1 });
    }
  }
  updateDust(dt, P) {
    const B = this.dustData; let n = 0; const keep = [], clouds = new Set();
    for (const d of this.dust) {
      d.age += dt; if (d.age > d.life) continue;
      const cl = d.cl; if (!clouds.has(cl)) { clouds.add(cl); cl.age += dt; cl.w *= Math.exp(-dt * 0.55); cl.roll *= Math.exp(-dt * 0.8); cl.c[0] += 0.02 * dt; cl.c[2] += 0.008 * dt; }
      // swirl: rotate about the cloud's vertical axis, faster near the core (differential rotation smears it into spiral arms)
      const rh = Math.hypot(d.off[0], d.off[2]), ang = cl.w * dt / (1 + rh * 6);
      const ca = Math.cos(ang), sa = Math.sin(ang), ox = d.off[0] * ca - d.off[2] * sa, oz = d.off[0] * sa + d.off[2] * ca;
      d.off[0] = ox; d.off[2] = oz;
      // toroidal roll: lift in the core, fall outside, spread outward
      d.v[1] += cl.roll * dt * (rh < 0.15 ? 0.25 : -0.1);
      if (d.grain) { d.v = v3.scale(d.v, Math.exp(-dt * 2.2)); d.v[1] -= 0.35 * dt; }            // sand grains: drag + settling
      else { d.v = v3.scale(d.v, Math.exp(-dt * 0.9)); d.v[1] -= 0.012 * dt; }
      d.off = v3.add(d.off, v3.scale(d.v, dt));
      const p = v3.add(cl.c, d.off);
      const fl = this.floorH(p[0], p[2]); if (p[1] < fl + 0.01) { d.off[1] += fl + 0.01 - p[1]; p[1] = fl + 0.01; d.v[1] = Math.abs(d.v[1]) * 0.15; if (d.grain) { d.v[0] *= 0.3; d.v[2] *= 0.3; } }
      const x = d.age / d.life, r = d.r0 + d.g * Math.sqrt(d.age);
      const a = d.a * smooth(0, d.grain ? 0.02 : 0.08, x) * (1 - smooth(d.grain ? 0.6 : 0.3, 1, x));
      if (n < this.dustMax) { B.set([p[0] - ORIGIN[0], p[1] - ORIGIN[1], p[2] - ORIGIN[2], r, a, d.s, d.grain, 0], n * 8); n++; keep.push(d); }
    }
    this.dust = keep; this.dustFx.count = n;
    if (n) this.R.device.queue.writeBuffer(this.dustFx.obj.sb, 0, B, 0, n * 8);
  }

  // ---------------- placement helpers
  pushInst(k, variant, M) {
    const K = this.kinds[k]; if (K.count[variant] >= K.max) return;
    rel(M, K.inst[variant].subarray(K.count[variant] * 16, K.count[variant] * 16 + 16)); K.count[variant]++;
  }
  place(k, variant, x, z, yaw, s, sink = 0, tilt = [0, 0]) {
    const y = this.floorH(x, z) - sink * s;
    const M = m4.mul(m4.translate([x, y, z]), m4.mul(m4.mul(m4.rotX(tilt[0]), m4.rotZ(tilt[1])), m4.mul(m4.rotY(yaw), m4.scale([s, s, s]))));
    M[3] = 0; M[7] = 1; M[11] = 0; M[15] = 1;
    this.pushInst(k, variant, M);
  }

  update(dt, t, P, depth, D, cm, A) {
    const on = depth > this.FD - 140;
    for (const K of Object.values(this.kinds)) K.count.fill(0);
    this.pile.count = 0; this.seeps = [];
    this.updateDust(dt, P);
    if (!on) return;
    // first arrival: guarantee a seep + coral patch a little ahead of the diver
    if (!this.forced && depth > this.FD - 60) {
      const f = [-cm[8], 0, -cm[10]], fl = Math.hypot(f[0], f[2]) || 1;
      this.forced = { seep: [P[0] + f[0] / fl * 16, P[2] + f[2] / fl * 16], reef: [P[0] + f[0] / fl * 9 - f[2] / fl * 10, P[2] + f[2] / fl * 9 + f[0] / fl * 10] };
    }
    const cellsNear = (cell, R) => { const out = [], cx = Math.floor(P[0] / cell), cz = Math.floor(P[2] / cell); for (let dz = -R; dz <= R; dz++) for (let dx = -R; dx <= R; dx++) out.push([cx + dx, cz + dz]); return out; };
    // ---- rocks: sparse clusters (22 m cells, ~30%) + rare lone boulders
    for (const [ix, iz] of cellsNear(22, 3)) {
      const h = ih(ix, iz, 1); if (h > 0.3) continue;
      const cx = (ix + ih(ix, iz, 2)) * 22, cz = (iz + ih(ix, iz, 3)) * 22, n = 1 + Math.floor(ih(ix, iz, 4) * 4);
      for (let k = 0; k < n; k++) {
        const a = ih(ix, iz, 10 + k) * 6.28, d = k ? 0.8 + ih(ix, iz, 20 + k) * 2.5 : 0;
        const s = (k ? 0.18 + Math.pow(ih(ix, iz, 30 + k), 2) * 0.6 : 0.5 + Math.pow(ih(ix, iz, 5), 2) * 1.3);
        this.place('rock', Math.floor(ih(ix, iz, 40 + k) * 6), cx + Math.cos(a) * d, cz + Math.sin(a) * d, ih(ix, iz, 50 + k) * 6.28, s, 0.05, [(ih(ix, iz, 60 + k) - 0.5) * 0.3, (ih(ix, iz, 70 + k) - 0.5) * 0.3]);
      }
    }
    // ---- coral colonies (55 m cells, ~35%, plus the forced one): patch of bushes, fans and sponges on a rocky rise
    const reefs = [];
    for (const [ix, iz] of cellsNear(55, 2)) if (ih(ix, iz, 7) < 0.35) reefs.push({ x: (ix + 0.2 + ih(ix, iz, 8) * 0.6) * 55, z: (iz + 0.2 + ih(ix, iz, 9) * 0.6) * 55, id: ix * 7919 + iz });
    if (this.forced) reefs.push({ x: this.forced.reef[0], z: this.forced.reef[1], id: 424242 });
    for (const rf of reefs) {
      if (Math.hypot(rf.x - P[0], rf.z - P[2]) > 95) continue;
      const hh = (k) => ih(rf.id, k, 77);
      for (let k = 0; k < 3; k++) { const a = hh(k) * 6.28, d = hh(k + 3) * 2.5; this.place('rock', Math.floor(hh(k + 6) * 6), rf.x + Math.cos(a) * d, rf.z + Math.sin(a) * d, hh(k + 9) * 6, 0.6 + hh(k + 12) * 0.8, 0.1); }
      const n = 10 + Math.floor(hh(20) * 10);
      for (let k = 0; k < n; k++) {
        const a = hh(30 + k) * 6.28, d = Math.sqrt(hh(60 + k)) * 5.5, x = rf.x + Math.cos(a) * d, z = rf.z + Math.sin(a) * d, sel = hh(90 + k);
        if (sel < 0.5) this.place('lophelia', Math.floor(hh(120 + k) * 3), x, z, hh(150 + k) * 6.28, 0.9 + hh(180 + k) * 1.2, 0.02);
        else if (sel < 0.8) this.place('fan', Math.floor(hh(120 + k) * 2), x, z, hh(150 + k) * 6.28, 0.8 + hh(180 + k) * 1.3, 0.0, [(hh(210 + k) - 0.5) * 0.2, 0]);
        else this.place('sponge', Math.floor(hh(120 + k) * 2), x, z, hh(150 + k) * 6.28, 0.8 + hh(180 + k) * 0.8, 0.0);
      }
    }
    // ---- methane seeps (80 m cells, ~40%, plus the forced one)
    const seeps = [];
    for (const [ix, iz] of cellsNear(80, 1)) if (ih(ix, iz, 13) < 0.4) seeps.push({ x: (ix + 0.25 + ih(ix, iz, 14) * 0.5) * 80, z: (iz + 0.25 + ih(ix, iz, 15) * 0.5) * 80, id: ix * 104729 + iz });
    if (this.forced) seeps.push({ x: this.forced.seep[0], z: this.forced.seep[1], id: 999331 });
    seeps.sort((a, b) => Math.hypot(a.x - P[0], a.z - P[2]) - Math.hypot(b.x - P[0], b.z - P[2]));
    this.seeps = seeps.slice(0, 4);
    this.updateSeeps(dt, t, P, A);
    // ---- crabs: piles (30 m cells, ~30%) of stacked king crabs, slowly shifting
    for (const [ix, iz] of cellsNear(30, 2)) {
      if (ih(ix, iz, 17) > 0.3) continue;
      const cx = (ix + 0.3 + ih(ix, iz, 18) * 0.4) * 30, cz = (iz + 0.3 + ih(ix, iz, 19) * 0.4) * 30;
      if (Math.hypot(cx - P[0], cz - P[2]) > 70) continue;
      const n = 14 + Math.floor(ih(ix, iz, 21) * 20);
      for (let k = 0; k < n && this.pile.count < this.pile.max; k++) {
        // mound: rings stacked into a heap, upper crabs smaller and more tilted
        const layer = k < n * 0.55 ? 0 : k < n * 0.85 ? 1 : 2, a = ih(ix, iz, 100 + k) * 6.28;
        const rr = (layer === 0 ? 0.25 + Math.sqrt(ih(ix, iz, 200 + k)) * 0.75 : layer === 1 ? 0.15 + ih(ix, iz, 200 + k) * 0.45 : ih(ix, iz, 200 + k) * 0.2);
        const x = cx + Math.cos(a) * rr, z = cz + Math.sin(a) * rr, s = 0.55 + ih(ix, iz, 300 + k) * 0.35;
        const y = this.floorH(x, z) + layer * 0.09 * s + (layer ? 0.02 : 0);
        const ph = ih(ix, iz, 400 + k) * 6.28, jig = Math.sin(t * (0.3 + ih(ix, iz, 500 + k) * 0.5) + ph);
        const yaw = ih(ix, iz, 600 + k) * 6.28 + jig * 0.06 * (1 + layer), tx = (ih(ix, iz, 700 + k) - 0.5) * 0.35 * layer + jig * 0.02, tz = (ih(ix, iz, 800 + k) - 0.5) * 0.35 * layer;
        const M = m4.mul(m4.translate([x, y, z]), m4.mul(m4.mul(m4.rotX(tx), m4.rotZ(tz)), m4.mul(m4.rotY(yaw), m4.scale([s, s, s]))));
        M[3] = 0; M[7] = 1; M[11] = 0; M[15] = 1;
        rel(M, this.pile.inst.subarray(this.pile.count * 16, this.pile.count * 16 + 16)); this.pile.count++;
        // a crab shuffling on the heap now and then disturbs the silt
        if (Math.abs(jig) > 0.995 && Math.random() < dt * 0.6) this.kick([x, y, z], 0.5, 2, 0.1, 0.05);
      }
      this.pileSpots = this.pileSpots || new Map(); this.pileSpots.set(ix + ',' + iz, [cx, cz]);
    }
    this.updateCrawlers(dt, t, P, A);
    // ---- draws
    if (this.ready) for (const [key, K] of Object.entries(this.kinds)) K.gms.forEach((gm, i) => {
      if (!K.count[i]) return;
      this.R.device.queue.writeBuffer(K.objs[i].sb, 0, K.inst[i], 0, K.count[i] * 16);
      D.push({ gm, mat: K.mat, obj: K.objs[i], kind: 'inst', instances: K.count[i], shadow: key !== 'shrimp' });
    });
    if (this.pile.count) this.crabSp.gpu.prims.forEach((p, i) => {
      this.R.device.queue.writeBuffer(this.pile.objs[i].sb, 0, this.pile.inst, 0, this.pile.count * 16);
      D.push({ gm: p.gm, mat: p.mat, obj: this.pile.objs[i], kind: 'inst', instances: this.pile.count, shadow: true });
    });
  }

  // ---------------- seeps: carbonate chimneys venting bubbles, rubble field, resident shrimp
  seepLayout(sp) {
    if (sp.layout) return sp.layout;
    const h = (k) => ih(sp.id, k, 91);
    const chim = [];
    const nC = 3 + Math.floor(h(0) * 4);
    for (let k = 0; k < nC; k++) {
      const a = h(10 + k) * 6.28, r = k ? 0.8 + h(20 + k) * 2.4 : 0.2, x = sp.x + Math.cos(a) * r, z = sp.z + Math.sin(a) * r;
      const H = 0.35 + h(30 + k) * (k ? 0.8 : 1.3), v = Math.floor(h(40 + k) * 3), yaw = h(50 + k) * 6.28;
      const y = this.floorH(x, z) - 0.04;
      // the crater sits at local (lean, 0.93·H, lean): recompute that point in world space for the bubble source
      const seed = 41 + v, lx = Math.sin(seed) * 0.1, lz = Math.cos(seed) * 0.1, cy = Math.cos(yaw), sy = Math.sin(yaw);
      const s = H;
      chim.push({ x, z, y, H, v, yaw, top: [x + (lx * cy + lz * sy) * s, y + 0.86 * H, z + (-lx * sy + lz * cy) * s], rad: 0.05 * s });
    }
    const rocks = [];
    const nR = 10 + Math.floor(h(1) * 8);
    for (let k = 0; k < nR; k++) {
      const a = h(60 + k) * 6.28, r = 0.6 + Math.sqrt(h(70 + k)) * 4.5, x = sp.x + Math.cos(a) * r, z = sp.z + Math.sin(a) * r;
      const s = 0.22 + Math.pow(h(80 + k), 1.5) * 0.8;
      rocks.push({ x, z, s, v: Math.floor(h(90 + k) * 6), yaw: h(100 + k) * 6.28, top: this.floorH(x, z) + s * 0.45 });
    }
    return (sp.layout = { chim, rocks });
  }
  updateSeeps(dt, t, P, A) {
    const W = this.W;
    this.shrimpState = this.shrimpState || new Map();
    this.layouts = this.layouts || new Map();
    let nearest = 1e9;
    for (const s of this.seeps) {
      if (!this.layouts.has(s.id)) this.layouts.set(s.id, this.seepLayout({ ...s }));
      const L = this.layouts.get(s.id);
      const y0 = this.floorH(s.x, s.z), d = Math.hypot(s.x - P[0], y0 - P[1], s.z - P[2]);
      nearest = Math.min(nearest, d);
      for (const c of L.chim) this.place('chimney', c.v, c.x, c.z, c.yaw, c.H, 0.04);
      for (const r of L.rocks) this.place('rock', r.v, r.x, r.z, r.yaw, r.s, 0.12, [0.15 * Math.sin(r.yaw * 3), 0.12 * Math.cos(r.yaw * 5)]);
      if (d > 70) continue;
      // bubble streams from the chimney craters, in irregular bursts
      L.chim.forEach((c, v) => {
        const burst = 0.5 + 0.5 * Math.sin(t * (0.6 + ih(s.id, v, 13)) + v * 2.1);
        if (W.bubbles.length < W.bubbleMax - 200 && Math.random() < dt * (1.5 + 9 * burst * burst)) {
          const r0 = 0.004 + Math.random() * Math.random() * 0.009, jx = (Math.random() - 0.5) * c.rad, jz = (Math.random() - 0.5) * c.rad;
          W.bubbles.push({ p: [c.top[0] + jx, c.top[1], c.top[2] + jz], v: [0, 0.1, 0], r: r0, r0, y0: c.top[1], age: 0, ph: Math.random() * 6, seep: true });
        }
      });
      // resident shrimp: mostly perched (on chimneys, rubble, sand) sweeping their antennae; a few wander one by one.
      // They never leave the seep field (leash ~5 m from its centre).
      let sw = this.shrimpState.get(s.id);
      if (!sw) {
        const perches = [];
        L.chim.forEach((c) => { for (let k = 0; k < 7; k++) { const a = Math.random() * 6.28, hh = 0.15 + Math.random() * 0.8; const rr = lerp(0.2, 0.07, Math.pow(hh, 0.8)) * c.H; perches.push({ p: [c.x + Math.cos(a) * rr * 1.05, c.y + hh * c.H, c.z + Math.sin(a) * rr * 1.05], n: [Math.cos(a), 0.2, Math.sin(a)] }); } });
        L.rocks.forEach((r) => { if (r.s > 0.2) for (let k = 0; k < 2; k++) perches.push({ p: [r.x + (Math.random() - 0.5) * r.s * 0.6, r.top, r.z + (Math.random() - 0.5) * r.s * 0.6], n: [0, 1, 0] }); });
        sw = [...Array(70)].map((_, i) => {
          const q = { ph: Math.random() * 6.28, mode: Math.random() < 0.8 ? 'perch' : 'walk', t: 2 + Math.random() * 10, v: [0, 0, 0], yaw: Math.random() * 6.28 };
          if (q.mode === 'perch' && perches.length) { const pc = perches[(Math.random() * perches.length) | 0]; q.p = [...pc.p]; q.n = pc.n; }
          else { const a = Math.random() * 6.28, r = Math.random() * 4; q.p = [s.x + Math.cos(a) * r, 0, s.z + Math.sin(a) * r]; q.p[1] = this.floorH(q.p[0], q.p[2]) + 0.05; q.mode = 'walk'; q.n = [0, 1, 0]; }
          return q;
        });
        sw.perches = perches; this.shrimpState.set(s.id, sw);
      }
      for (const q of sw) {
        q.t -= dt;
        const dv = v3.sub(q.p, P), dd = v3.len(dv);
        if (dd < 1.1 && q.mode !== 'swim') { q.mode = 'swim'; q.t = 0.8 + Math.random() * 0.8; q.v = v3.scale(v3.norm([dv[0], 0.6, dv[2]]), 0.9); }   // tail-flip escape
        const home = [s.x, 0, s.z], off = [q.p[0] - s.x, 0, q.p[2] - s.z], ol = Math.hypot(off[0], off[2]);
        if (q.mode === 'perch') {
          if (q.t <= 0) { q.t = 3 + Math.random() * 12; if (Math.random() < 0.15) { q.mode = 'walk'; q.t = 2 + Math.random() * 5; q.n = [0, 1, 0]; q.p[1] = this.floorH(q.p[0], q.p[2]) + 0.05; } else q.yaw += (Math.random() - 0.5) * 1.2; }
        } else if (q.mode === 'walk') {
          q.yaw += Math.sin(t * 0.9 + q.ph) * dt * 0.8;
          if (ol > 4.5) q.yaw = Math.atan2(-off[0], -off[2]) + (Math.random() - 0.5) * 0.4;              // turn back toward the vents
          const sp = 0.04 + 0.03 * Math.max(0, Math.sin(t * 1.3 + q.ph));
          q.p[0] += Math.sin(q.yaw) * sp * dt; q.p[2] += Math.cos(q.yaw) * sp * dt; q.p[1] = this.floorH(q.p[0], q.p[2]) + 0.05;   // above the ripple crests
          if (q.t <= 0) {
            q.t = 4 + Math.random() * 10;
            if (Math.random() < 0.8 && sw.perches.length) { const pc = sw.perches[(Math.random() * sw.perches.length) | 0]; q.target = pc; q.mode = 'swim'; q.t = 3 + v3.dist(q.p, pc.p) / 0.3; q.v = [0, 0.15, 0]; }
          }
        } else {   // swim: short hop, then settle on a perch or the sand, always inside the seep field
          const tgt = q.target ? q.target.p : [s.x + off[0] * Math.min(1, 3.5 / Math.max(ol, 0.01)), this.floorH(q.p[0], q.p[2]) + 0.3, s.z + off[2] * Math.min(1, 3.5 / Math.max(ol, 0.01))];
          const to = v3.sub(tgt, q.p);
          const tl = v3.len(to); q.v = v3.add(v3.scale(q.v, Math.exp(-dt * 2.5)), v3.scale(v3.norm(to), dt * (tl < 0.4 ? 1.0 : 2.2)));
          if (ol > 5) q.v = v3.add(q.v, v3.scale(v3.norm([-off[0], 0, -off[2]]), dt * 2));
          q.p = v3.add(q.p, v3.scale(q.v, dt));
          const fl = this.floorH(q.p[0], q.p[2]); if (q.p[1] < fl + 0.05) q.p[1] = fl + 0.05;
          if (v3.len(to) < 0.05 || q.t <= 0) {
            if (q.target && v3.len(to) < 0.8) { q.p = [...q.target.p]; q.n = q.target.n; q.mode = 'perch'; }
            else { q.mode = 'walk'; q.n = [0, 1, 0]; q.p[1] = fl + 0.05; }
            q.target = null; q.t = 4 + Math.random() * 10;
          }
          if (Math.hypot(q.v[0], q.v[2]) > 0.05) q.yaw = Math.atan2(q.v[0], q.v[2]);
        }
        // orientation: stand on the local surface (floor / rock top / chimney side), body along yaw
        const up = v3.norm(q.n || [0, 1, 0]);
        let f = [Math.sin(q.yaw), 0, Math.cos(q.yaw)];
        if (q.mode === 'swim') f = v3.norm(q.v);
        f = v3.norm(v3.sub(f, v3.scale(up, v3.dot(f, up)))); if (!isFinite(f[0])) f = [1, 0, 0];
        const rr = v3.norm(v3.cross(up, f)), u = v3.cross(f, rr);
        const SC = 4 * (q.sz = q.sz || Math.exp(((Math.random() + Math.random() + Math.random() + Math.random()) - 2) * 1.732 * 0.16));                                                      // ~28 cm seep shrimp
        const M = m4.basis(v3.scale(rr, SC), v3.scale(u, SC), v3.scale(f, SC), v3.add(q.p, v3.scale(up, 0.012 * SC)));
        const bodySpd = q.mode === 'swim' ? 1.8 : q.mode === 'walk' ? 0.25 : 0;
        M[3] = q.ph; M[7] = bodySpd; M[11] = 0; M[15] = 1;
        this.pushInst('shrimp', 0, M);
        const M2 = new Float64Array(M); M2[3] = q.ph * 3.1; M2[7] = q.mode === 'swim' ? 2.5 : 1.0;
        this.pushInst('antenna', 0, M2);
      }
    }
    // bubbling of the nearest seep
    if (A.ctx) {
      if (!this.hiss) this.hiss = A.presence?.('bubbles_loop', 0.8) || A.turbulence?.();
      if (this.hiss) this.hiss.set(0.45 * (1 - smooth(3, 30, nearest)), 0, 0.8);
    }
  }
}

// ================================================================= crawlers: giant isopods, giant sea spiders, flytrap anemones
function tubeUnit(sides = 6, taper = 0.6) {   // unit tube along +Z (z 0..1), radius 1 at base, taper at tip
  const pos = [], nrm = [], uv = [], idx = [];
  for (let e = 0; e <= 4; e++) { const z = e / 4, r = lerp(1, taper, z); for (let i = 0; i <= sides; i++) { const a = i / sides * Math.PI * 2; pos.push(Math.cos(a) * r, Math.sin(a) * r, z); nrm.push(Math.cos(a), Math.sin(a), 0); uv.push(i / sides, z); } }
  for (let e = 0; e < 4; e++) for (let i = 0; i < sides; i++) { const a = e * (sides + 1) + i, b = a + 1, c = a + sides + 1, d = c + 1; idx.push(a, c, b, b, c, d); }
  return { pos: new Float32Array(pos), nrm: new Float32Array(nrm), uv: new Float32Array(uv), idx: new Uint32Array(idx) };
}
// Bathynomus: segmented armoured dome, flat underside; 0.36 m
function isopodBody() {
  const L = 0.36, NZ = 28, NA = 16, pos = [], nrm = [], uv = [], idx = [];
  for (let i = 0; i <= NZ; i++) {
    const t = i / NZ, z = (t - 0.5) * L;
    const seg = 1 + 0.06 * Math.pow(Math.abs(Math.sin(t * Math.PI * 9)), 0.4);                       // tergite ridges
    const w = 0.075 * Math.pow(Math.sin(Math.PI * Math.min(0.999, 0.06 + t * 0.9)), 0.45) * seg, h = 0.05 * Math.pow(Math.sin(Math.PI * Math.min(0.999, 0.04 + t * 0.94)), 0.6) * seg;
    for (let j = 0; j < NA; j++) {
      const a = j / (NA - 1) * Math.PI, x = Math.cos(a) * w, y = Math.sin(a) * h;
      pos.push(x, y, z); const n = v3.norm([Math.cos(a) / Math.max(w, 1e-3), Math.sin(a) / Math.max(h, 1e-3), 0]); nrm.push(...n); uv.push(j / NA * 2, t * 6);
    }
  }
  for (let i = 0; i < NZ; i++) for (let j = 0; j < NA - 1; j++) { const a = i * NA + j, b = a + 1, c = a + NA, d = c + 1; idx.push(a, c, b, b, c, d); }
  return { pos: new Float32Array(pos), nrm: new Float32Array(nrm), uv: new Float32Array(uv), idx: new Uint32Array(idx), L };
}
function blob(r = 1) { const { V, F } = icosphere(1); const P = V.map((p) => v3.scale(p, r)); return boxUV(P, P.map(v3.norm), F, 1); }
// Venus flytrap anemone crown: cup + ring of tentacles (opens/closes by instance scale)
function flytrapCrown() {
  const o = { pos: [], nrm: [], uv: [], idx: [] }, segs = [];
  for (let k = 0; k < 18; k++) { const a = k / 18 * 6.28; const b = [Math.cos(a) * 0.05, 0.02, Math.sin(a) * 0.05]; segs.push({ a: b, b: [Math.cos(a) * 0.13, 0.09, Math.sin(a) * 0.13], ra: 0.012, rb: 0.004 }); }
  segs.push({ a: [0, -0.02, 0], b: [0, 0.03, 0], ra: 0.03, rb: 0.055 });
  tubes(segs, 5, o); return pack(o);
}
// two-bone leg: hip -> knee -> foot, knee bends upward / outward (spider-like)
function ik2(hip, foot, l1, l2, out) {
  const d = v3.sub(foot, hip), dl = Math.min(v3.len(d), l1 + l2 - 1e-3), dn = v3.norm(d);
  const a = (l1 * l1 + dl * dl - l2 * l2) / (2 * l1 * dl), h = Math.sqrt(Math.max(0, l1 * l1 - a * a * l1 * l1 * 0 - (a * l1) * (a * l1)));
  const up = v3.norm(v3.add(v3.sub([0, 1, 0], v3.scale(dn, dn[1])), v3.scale(out, 0.3)));
  return v3.add(hip, v3.add(v3.scale(dn, a * l1), v3.scale(up, h)));
}
export function addCrawlers(FL, R) {
  const mkI = (key, gm, max, mat, extra = [0, 0.3, 0, 0]) => { const obj = R.object(max * 64); obj.data.set([0, 0, 0, 0], 16); obj.data.set([1, 1, 1, 1], 20); obj.data.set(extra, 24); FL.kinds[key] = { gms: [R.mesh(gm)], max, matOpts: mat, mat: null, objs: [obj], inst: [new Float32Array(max * 16)], count: [0] }; };
  mkI('isoBody', isopodBody(), 12, { tex: 'chitin' });
  mkI('isoLeg', tubeUnit(5, 0.5), 12 * 34, { tex: 'chitin' });
  mkI('eyeDark', blob(1), 40, { color: [0.03, 0.03, 0.035, 1], rough: 0.1 });
  mkI('spiderBody', blob(1), 10, { tex: 'leg' });
  mkI('spiderLeg', tubeUnit(5, 0.75), 10 * 20, { tex: 'leg' });
  mkI('flyStalk', tubeUnit(8, 0.7), 40, { tex: 'polyp' });
  mkI('flyCrown', flytrapCrown(), 40, { tex: 'polyp' }, [0, 0.5, 0, 0]);
  FL.isopods = [...Array(5)].map((_, i) => ({ p: null, yaw: Math.random() * 6.28, ph: Math.random() * 6.28, walk: 1, t: 0, i }));
  FL.spiders = [...Array(4)].map((_, i) => ({ p: null, yaw: Math.random() * 6.28, ph: Math.random() * 6.28, t: 0, i }));
}
// oriented segment instance: unit tube from a to b with radius r
FloorLife.prototype.seg = function (key, a, b, r) {
  const d = v3.sub(b, a), L = v3.len(d); if (L < 1e-4) return;
  const f = v3.scale(d, 1 / L); let x = v3.cross([0, 1, 0], f); x = v3.len(x) < 1e-3 ? [1, 0, 0] : v3.norm(x); const y = v3.cross(f, x);
  const M = m4.basis(v3.scale(x, r), v3.scale(y, r), v3.scale(f, L), a); M[3] = 0; M[7] = 1; M[11] = 0; M[15] = 1;
  this.pushInst(key, 0, M);
};
FloorLife.prototype.updateCrawlers = function (dt, t, P, A) {
  const fh = this.floorH, W = this.W;
  const place = (c, r0) => { const q = W.hiddenSpawn(P, c.seen ? 24 : r0, 0); c.p = [q[0], fh(q[0], q[2]), q[2]]; c.seen = true; };
  // ---- giant isopods: slow march, 14 legs in a metachronal wave, antennae sweeping
  for (const c of this.isopods) {
    if (!c.p) place(c, 4 + c.i * 3);
    c.t -= dt; if (c.t <= 0) { c.t = 3 + Math.random() * 6; c.walk = Math.random() < 0.75 ? 1 : 0; c.turn = (Math.random() - 0.5) * 0.6; }
    const sp = 0.06 * c.walk; c.yaw += (c.turn || 0) * dt * c.walk; c.ph += dt * 5 * c.walk;
    const fw = [Math.sin(c.yaw), 0, Math.cos(c.yaw)], rt = [fw[2], 0, -fw[0]];
    c.p[0] += fw[0] * sp * dt; c.p[2] += fw[2] * sp * dt; c.p[1] = fh(c.p[0], c.p[2]);
    const body = v3.add(c.p, [0, 0.07, 0]);
    const M = m4.basis(rt, [0, 1, 0], fw, body); M[3] = 0; M[7] = 0; M[11] = 0; M[15] = 1; this.pushInst('isoBody', 0, M);
    for (const s of [-1, 1]) {
      this.pushInst('eyeDark', 0, (() => { const E = m4.basis(v3.scale(rt, 0.012), [0, 0.012, 0], v3.scale(fw, 0.018), v3.add(body, v3.add(v3.scale(fw, 0.16), v3.add(v3.scale(rt, s * 0.045), [0, 0.012, 0])))); E[3] = 0; E[7] = 0; E[11] = 0; E[15] = 1; return E; })());
      for (let k = 0; k < 7; k++) {
        const z = 0.12 - k * 0.04, ph = c.ph - k * 0.9 + (s > 0 ? Math.PI : 0), lift = Math.max(0, Math.sin(ph)) * 0.025;
        const hip = v3.add(body, v3.add(v3.scale(fw, z), v3.add(v3.scale(rt, s * 0.06), [0, -0.035, 0])));
        const foot0 = v3.add(c.p, v3.add(v3.scale(fw, z + Math.cos(ph) * 0.025 * c.walk), v3.scale(rt, s * 0.14)));
        const foot = [foot0[0], fh(foot0[0], foot0[2]) + lift, foot0[2]];
        const knee = ik2(hip, foot, 0.07, 0.08, v3.scale(rt, s));
        this.seg('isoLeg', hip, knee, 0.008); this.seg('isoLeg', knee, foot, 0.006);
      }
      // antennae
      const base = v3.add(body, v3.add(v3.scale(fw, 0.17), v3.scale(rt, s * 0.03)));
      const tip = v3.add(base, v3.add(v3.scale(fw, 0.2), v3.add(v3.scale(rt, s * (0.12 + 0.05 * Math.sin(t * 1.3 + s))), [0, 0.03 + 0.02 * Math.sin(t * 0.9 + c.i), 0])));
      this.seg('isoLeg', base, tip, 0.004);
    }
    const d = v3.dist(c.p, P);
    if (c.walk && d < 3 && Math.random() < dt * 2) A.bio?.('click', 0.04 * (1 - d / 3), 0);
    if (Math.random() < dt * 1.5 * c.walk) this.kick([c.p[0] - fw[0] * 0.15, c.p[1], c.p[2] - fw[2] * 0.15], 0.3, 1, 0.1, 0.04);
    if (d > 30 && W.outOfSight(c.p, P, 1)) c.p = null;
  }
  // ---- giant sea spiders (Colossendeis): tiny body on stilt legs, deliberate slow steps
  for (const c of this.spiders) {
    if (!c.p) place(c, 6 + c.i * 4);
    c.ph += dt * 1.1; c.yaw += Math.sin(t * 0.13 + c.i) * dt * 0.15;
    const fw = [Math.sin(c.yaw), 0, Math.cos(c.yaw)], rt = [fw[2], 0, -fw[0]];
    c.p[0] += fw[0] * 0.035 * dt; c.p[2] += fw[2] * 0.035 * dt; c.p[1] = fh(c.p[0], c.p[2]);
    const body = v3.add(c.p, [0, 0.28 + 0.015 * Math.sin(c.ph * 2), 0]);
    const B = m4.basis(v3.scale(rt, 0.025), [0, 0.02, 0], v3.scale(fw, 0.06), body); B[3] = 0; B[7] = 0; B[11] = 0; B[15] = 1; this.pushInst('spiderBody', 0, B);
    this.seg('spiderLeg', v3.add(body, v3.scale(fw, 0.05)), v3.add(body, v3.add(v3.scale(fw, 0.13), [0, -0.03, 0])), 0.008);   // proboscis
    for (let k = 0; k < 8; k++) {
      const s = k < 4 ? -1 : 1, i = k % 4, ang = (i - 1.5) * 0.55;
      const dir = v3.add(v3.scale(rt, s * Math.cos(ang)), v3.scale(fw, Math.sin(ang)));
      const ph = c.ph + (i % 2 ? Math.PI : 0) + (s > 0 ? Math.PI * 0.5 : 0), lift = Math.max(0, Math.sin(ph)) * 0.06;
      const hip = v3.add(body, v3.scale(dir, 0.03));
      const f0 = v3.add(c.p, v3.add(v3.scale(dir, 0.42), v3.scale(fw, Math.cos(ph) * 0.05)));
      const foot = [f0[0], fh(f0[0], f0[2]) + lift, f0[2]];
      const knee = ik2(hip, foot, 0.3, 0.36, dir);
      this.seg('spiderLeg', hip, knee, 0.006); this.seg('spiderLeg', knee, foot, 0.0045);
    }
    if (v3.dist(c.p, P) > 30 && W.outOfSight(c.p, P, 1)) c.p = null;
  }
  // ---- Venus flytrap anemones on the rocks of every coral colony / seep (deterministic), slowly opening and closing
  for (const [key, L] of (this.layouts || new Map())) {
    L.rocks.forEach((r, k) => {
      if (r.s < 0.35 || k % 3) return;
      const top = [r.x, r.top + 0.02, r.z];
      const H = 0.25 + (k % 5) * 0.04;
      this.seg('flyStalk', top, v3.add(top, [0.03 * Math.sin(k), H, 0.03 * Math.cos(k)]), 0.02);
      const open = 0.75 + 0.25 * Math.sin(t * 0.25 + k);
      const c = v3.add(top, [0.03 * Math.sin(k), H, 0.03 * Math.cos(k)]);
      const M = m4.basis([open * 1.2, 0, 0], [0, 1.2, 0], [0, 0, open * 1.2], c); M[3] = 0; M[7] = 0; M[11] = 0; M[15] = 1; this.pushInst('flyCrown', 0, M);
    });
  }
};
