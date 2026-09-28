// Particle-driven hull foam.
// Foam particles live in the ocean's Lagrangian (undisplaced) xz coordinates, so when the surface shader looks the
// density up with the same coordinates the foam rides every wave exactly.  Each frame:
//   1. slap pass   : per hull-waterline direction, water height vs the heaving hull -> how hard the swell hits it
//   2. particle pass: dead particles respawn on the waterline where it is slapped, live ones drift outward, get
//                     stirred by curl noise, pushed out of the hull, spread and fade
//   3. splat pass  : particles are rasterised additively into a foam density texture around the boat

const N = 262144;          // particles (finer, denser lace; a third reserved for splashes / animals)
const NA = 256;            // waterline directions (radius table)
export const FOAM_EXTENT = 48;     // metres covered by the density texture (centred on the boat)
const RES = 2048;          // ~2.3 cm / texel

const COMMON = /* wgsl */`
struct P { t: vec4f, extent: vec4f, boat: mat4x4f, em: array<vec4f, 8>, emv: array<vec4f, 8> };   // t: time, dt, gain, n ; extent: size, cx, cz ; em: x, z, rate (~particles/s), radius ; emv: vx, vz
struct Particle { p: vec2f, v: vec2f, age: f32, life: f32, str: f32, size: f32 };
@group(0) @binding(0) var<uniform> U: P;
fn hash(n: u32) -> f32 { var x = n; x ^= x >> 16u; x *= 0x7feb352du; x ^= x >> 15u; x *= 0x846ca68bu; x ^= x >> 16u; return f32(x) / 4294967296.0; }
`;

const SIM = /* wgsl */`${COMMON}
@group(0) @binding(1) var<storage, read_write> parts: array<Particle>;
@group(0) @binding(2) var<storage, read_write> slap: array<vec4f>;     // x: slap strength, y: prev rel height
@group(0) @binding(3) var<storage, read> radii: array<vec4f>;          // x: waterline radius, yz: outward normal
@group(0) @binding(4) var d0: texture_2d<f32>;
@group(0) @binding(5) var d1: texture_2d<f32>;
@group(0) @binding(6) var d2: texture_2d<f32>;
@group(0) @binding(7) var smp: sampler;
@group(0) @binding(8) var dens: texture_2d<f32>;                     // last frame's splatted foam density
const L = vec3f(512.0, 97.0, 17.7);
fn waterH(xz: vec2f) -> f32 {
  return textureSampleLevel(d0, smp, xz / L.x, 0.0).y + textureSampleLevel(d1, smp, xz / L.y, 0.0).y + textureSampleLevel(d2, smp, xz / L.z, 0.0).y;
}
fn jacAt(xz: vec2f) -> f32 {                  // horizontal compression of the water surface (1 = none, <1 converging)
  let a = textureSampleLevel(d0, smp, xz / L.x, 1.0); let b = textureSampleLevel(d1, smp, xz / L.y, 1.0);
  let e = 0.5;
  let ax = textureSampleLevel(d0, smp, (xz + vec2f(e, 0.0)) / L.x, 1.0).x + textureSampleLevel(d1, smp, (xz + vec2f(e, 0.0)) / L.y, 1.0).x;
  let az = textureSampleLevel(d0, smp, (xz + vec2f(0.0, e)) / L.x, 1.0).z + textureSampleLevel(d1, smp, (xz + vec2f(0.0, e)) / L.y, 1.0).z;
  return (1.0 + (ax - a.x - b.x) / e) * (1.0 + (az - a.z - b.z) / e);
}
fn hullR(ang: f32) -> vec3f {                  // radius + outward normal at an angle (linear interp)
  let f = (ang / 6.2831853 + 1.0) * ${NA}.0; let i0 = u32(floor(f)) % ${NA}u; let i1 = (i0 + 1u) % ${NA}u; let w = fract(f);
  let a = radii[i0]; let b = radii[i1];
  return vec3f(mix(a.x, b.x, w), normalize(mix(a.yz, b.yz, w)));
}
@compute @workgroup_size(64) fn slapPass(@builtin(global_invocation_id) id: vec3u) {
  let i = id.x; if (i >= ${NA}u) { return; }
  let ang = (f32(i) + 0.5) / ${NA}.0 * 6.2831853;
  let r = radii[i].x;
  let local = vec2f(cos(ang), sin(ang)) * r;
  let hull = U.boat * vec4f(local.x, 0.0, local.y, 1.0);             // waterline point as the hull heaves / pitches / rolls
  let wp = hull.xz + radii[i].yz * 0.15;
  let rel = waterH(wp) - hull.y;                                       // water above the design waterline here
  var s = slap[i];
  let dt = max(U.t.y, 1e-3);
  let rate = (rel - s.y) / dt;
  s.y = rel;
  // water rushing up the topsides (and falling back) churns foam; deep immersion keeps a steady wash
  s.x = mix(s.x, max(rate, 0.0) * 1.4 + abs(rate) * 0.4 + max(rel, 0.0) * 0.6 + 0.05, 1.0 - exp(-dt * 6.0));
  slap[i] = s;
}
fn curl(p: vec2f, t: f32) -> vec2f {
  // divergence-free stirring from the gradient of a smooth scalar field
  let e = 0.35;
  let f = p * 0.45 + vec2f(t * 0.03, -t * 0.02);
  let n = sin(f.x * 1.7 + sin(f.y * 1.3 + t * 0.1)) * cos(f.y * 1.9 + sin(f.x * 0.8)) + 0.5 * sin(f.x * 3.1 - f.y * 2.7 + t * 0.2);
  let nx = sin((f.x + e) * 1.7 + sin(f.y * 1.3 + t * 0.1)) * cos(f.y * 1.9 + sin((f.x + e) * 0.8)) + 0.5 * sin((f.x + e) * 3.1 - f.y * 2.7 + t * 0.2);
  let ny = sin(f.x * 1.7 + sin((f.y + e) * 1.3 + t * 0.1)) * cos((f.y + e) * 1.9 + sin(f.x * 0.8)) + 0.5 * sin(f.x * 3.1 - (f.y + e) * 2.7 + t * 0.2);
  return vec2f(ny - n, -(nx - n)) / e;
}
fn denAt(p: vec2f) -> f32 {                  // saturated foam coverage 0..1 at a point (previous frame)
  let uv = (p - U.extent.yz) / U.extent.x + 0.5;
  if (any(uv < vec2f(0.002)) || any(uv > vec2f(0.998))) { return 0.0; }
  let d = textureSampleLevel(dens, smp, uv, 0.0).x;
  return d / (1.0 + d);
}
fn denGrad(p: vec2f, e: f32) -> vec2f {
  return vec2f(denAt(p + vec2f(e, 0.0)) - denAt(p - vec2f(e, 0.0)), denAt(p + vec2f(0.0, e)) - denAt(p - vec2f(0.0, e))) / (2.0 * e);
}
fn tearPot(p: vec2f, t: f32) -> f32 {          // slowly evolving up/down-welling pattern of the surface layer
  let a = p * 0.55 + vec2f(sin(t * 0.031) * 3.0, cos(t * 0.027) * 3.0);
  let b = p * 1.3 + vec2f(-t * 0.045, t * 0.038);
  return sin(a.x + sin(a.y * 1.3)) * sin(a.y * 1.1 - sin(a.x * 0.9)) + 0.45 * sin(b.x * 1.1 + sin(b.y)) * sin(b.y * 0.9 + 1.7 * sin(b.x * 0.7 + t * 0.05));
}
@compute @workgroup_size(64) fn simPass(@builtin(global_invocation_id) id: vec3u) {
  let i = id.x; if (i >= ${N}u) { return; }
  var q = parts[i];
  let dt = U.t.y; let t = U.t.x;
  let seed = i * 7919u + u32(t * 97.0) * 104729u;
  q.age += dt;
  if (q.age >= q.life) {
    // respawn on the waterline, preferring where the swell is slapping the hull
    let k = u32(hash(seed) * ${NA}.0) % ${NA}u;
    let sl = slap[k].x;
    let pool = (i % 3u) == 0u;                // a third of the particles are reserved for free emitters (the hull wash
                                              // would otherwise keep nearly every particle alive and starve splashes)
    if (!pool && hash(seed + 1u) < min(sl * U.t.z * dt, 0.9)) {
      let ang = (f32(k) + hash(seed + 2u)) / ${NA}.0 * 6.2831853;
      let h = hullR(ang);
      let local = vec2f(cos(ang), sin(ang)) * h.x;
      let hull = U.boat * vec4f(local.x, 0.0, local.y, 1.0);
      q.p = hull.xz + h.yz * (0.02 + 0.25 * hash(seed + 3u) * hash(seed + 3u));
      let out = 0.25 + 0.9 * min(sl, 1.5) * hash(seed + 4u);
      q.v = h.yz * out + vec2f(hash(seed + 5u) - 0.5, hash(seed + 6u) - 0.5) * 0.25;
      q.age = 0.0;
      q.life = 3.0 + 12.0 * pow(hash(seed + 7u), 2.0) * (0.6 + 0.4 * min(sl, 1.5));
      q.str = (0.5 + 0.6 * min(sl, 1.2) * (0.5 + hash(seed + 8u))) * 0.5;   // ~2.7x the particles: each one fainter + smaller
      q.size = (0.035 + 0.09 * hash(seed + 9u)) * 0.75;   // ~0.7x linear (half the area) at twice the count
    } else {
      q.str = 0.0; q.life = 0.0;
      // free emitters (animals breaking the surface): spawn a churned patch at the emitter, carried with its motion
      let nE = max(u32(U.extent.w), 1u);
      let e = u32(hash(seed + 11u) * f32(nE)) % nE; let E = U.em[e];
      if (pool && E.z > 0.0 && hash(seed + 12u) < E.z * dt / 14000.0) {
        // churned water breaks into clumps and streaks: every particle belongs to one of a few dozen sub-clumps
        // (fixed per particle group) scattered mostly near the centre, and sits in a stretched strand around it
        let g = i / 48u;
        let ca = hash(g * 13u + 7u + u32(t * 3.0) * 977u) * 6.2831853; let cr = pow(hash(g * 29u + 3u + u32(t * 3.0) * 613u), 1.6) * E.w;
        let cc = E.xy + vec2f(cos(ca), sin(ca)) * cr;
        // most groups are ragged blobs of varied size; some are short strands in random directions (never radial)
        let sd = vec2f(cos(hash(g * 41u + 1u) * 6.2831853), sin(hash(g * 41u + 1u) * 6.2831853));
        let strand = hash(g * 43u + 5u) < 0.3;
        let gs = 0.08 + 0.3 * hash(g * 5u + 9u);                            // clump size
        let u1 = hash(seed + 13u); let u2 = hash(seed + 14u);
        let gauss = sqrt(-2.0 * log(max(u1, 1e-4))) * vec2f(cos(u2 * 6.2831853), sin(u2 * 6.2831853));
        var off = gauss * gs * 0.5;
        if (strand) { off = sd * (u1 - 0.5) * (0.3 + 0.5 * hash(g * 7u + 2u)) + vec2f(-sd.y, sd.x) * (u2 - 0.5) * 0.08; }
        q.p = cc + off;
        let dir = normalize(cc - E.xy + vec2f(1e-3));
        q.v = U.emv[e].xy * 0.3 + dir * (0.02 + 0.1 * hash(seed + 15u));   // spreads slowly; the flow does the rest
        q.age = 0.0; q.life = 2.0 + 8.0 * pow(hash(seed + 16u), 2.0);   // splash foam: a few seconds, a few patches linger ~10 s
        q.str = 0.35 + 0.35 * hash(seed + 17u); q.size = 0.025 + 0.055 * hash(seed + 18u);
      }
    }
    parts[i] = q; return;
  }
  // surface flow: wind-driven Stokes drift + convergence toward compressed water (foam gathers in lines where the
  // surface converges, as in real windrows), plus the wash of animals moving through (emitters drag nearby foam)
  let drift = vec2f(0.06, 0.024);
  let e = 0.35;
  let j0 = jacAt(q.p); let jx = jacAt(q.p + vec2f(e, 0.0)); let jz = jacAt(q.p + vec2f(0.0, e));
  let conv = -vec2f(jx - j0, jz - j0) / e * 0.35;                     // move toward lower Jacobian (convergence)
  var wash = vec2f(0.0);
  for (var k = 0; k < 8; k++) {
    let E = U.em[k]; if (E.z <= 0.0) { continue; }
    let r = q.p - E.xy; let d2 = dot(r, r); let R = E.w * 3.0 + 1.0;
    let f = exp(-d2 / (R * R));
    wash += (U.emv[k].xy * 0.15 + normalize(r + vec2f(1e-4)) * 0.12) * f;   // nudged along + aside (foam mostly stays where the water was churned)
  }
  let relax = select(0.35, 1.6, (i % 3u) == 0u);             // splash foam loses its launch speed fast (no sliding sheets)
  q.v += (drift + conv - q.v) * (1.0 - exp(-dt * relax)) + wash * dt * 1.5;
  // rafts merge and split: bubbles cling to neighbouring foam (surface tension / capillary attraction pulls floating
  // rafts together), while patches of up- and down-welling (a divergent flow that drifts and changes) stretch rafts
  // until they neck and tear apart, then carry the pieces into convergence zones where they meet and fuse again
  let dHere = denAt(q.p);
  let coh = denGrad(q.p, 0.12) * 0.022 + denGrad(q.p, 0.4) * 0.05 * (1.0 - dHere);   // near: tighten edges; far: stray bubbles drift in
  let et = 0.3;
  let t0 = tearPot(q.p, t);
  let tear = -vec2f(tearPot(q.p + vec2f(et, 0.0), t) - t0, tearPot(q.p + vec2f(0.0, et), t) - t0) / et * 0.07;
  q.p += (q.v + curl(q.p, t) * 0.08 + coh + tear) * dt;
  // stay out of the hull
  let rel = q.p - U.boat[3].xz;
  let ang = atan2(rel.y, rel.x);
  let h = hullR(ang);
  let d = length(rel) - h.x;
  if (d < 0.02) { q.p += h.yz * (0.02 - d); q.v -= h.yz * min(dot(q.v, h.yz), 0.0); }
  parts[i] = q;
}
`;

const SPLAT = /* wgsl */`${COMMON}
@group(0) @binding(1) var<storage, read> parts: array<Particle>;
struct VO { @builtin(position) pos: vec4f, @location(0) q: vec2f, @location(1) a: f32, @location(2) @interpolate(flat) id: u32 };
@vertex fn vs(@builtin(vertex_index) vi: u32, @builtin(instance_index) ii: u32) -> VO {
  var o: VO;
  let q = parts[ii];
  if (q.str <= 0.0 || q.life <= 0.0) { o.pos = vec4f(0.0, 0.0, -2.0, 1.0); return o; }
  let x = q.age / q.life;
  let corner = vec2f(f32(vi & 1u), f32((vi >> 1u) & 1u)) * 2.0 - 1.0;
  let r = q.size * (1.0 + 1.5 * x);                       // bubble raft spreads as it ages
  // stretched by the flow into streaks: the quad is aligned with the particle's drift and elongated by its speed
  let ax = vec2f(cos(hash(ii * 5u + 1u) * 6.2831853), sin(hash(ii * 5u + 1u) * 6.2831853));   // random orientation (no radial rays)
  let el = 1.0 + 0.6 * hash(ii * 11u + 3u);
  let off = (ax * corner.x * el + vec2f(-ax.y, ax.x) * corner.y / sqrt(el)) * r * 1.3;
  let fade = smoothstep(0.0, 0.06, x) * (1.0 - smoothstep(0.3, 1.0, x));
  if (q.str * fade < 0.004) { o.pos = vec4f(0.0, 0.0, -2.0, 1.0); return o; }   // invisible: don't rasterise
  let c = (q.p + off - U.extent.yz) / U.extent.x * 2.0;
  o.pos = vec4f(c.x, -c.y, 0.5, 1.0);
  o.q = corner; o.a = q.str * fade / pow(1.0 + 1.5 * x, 2.0) * 0.8; o.id = ii;   // bubbles conserve area as the raft spreads
  return o;
}
@fragment fn fs(in: VO) -> @location(0) vec4f {
  // a raft is a clump of bubbles, never a stamped disc: the footprint is a metaball of 4 random sub-blobs of
  // different sizes (ragged, asymmetric, sometimes pinched in two), with a bubble-cell texture inside
  var fld = 0.0;
  for (var k = 0u; k < 4u; k++) {
    let hk = vec3f(hash(in.id * 17u + k * 3u), hash(in.id * 17u + k * 3u + 1u), hash(in.id * 17u + k * 3u + 2u));
    let c = (hk.xy - 0.5) * 0.7;
    let s = 0.2 + 0.3 * hk.z;   // blobs fill the (tight) quad
    let dd = in.q - c;
    fld += exp(-dot(dd, dd) / (s * s));
  }
  if (fld < 0.35) { discard; }
  // cheap bubbly mottling (the fine lace comes from thousands of overlapping clumps, not per-pixel cells)
  let h1 = hash(in.id * 3u + 2u) * 40.0;
  let cells = 0.7 + 0.3 * sin(in.q.x * 7.0 + h1) * sin(in.q.y * 6.3 - h1 * 0.7);
  let m = smoothstep(0.35, 0.8, fld) * cells;
  return vec4f(in.a * m, 0.0, 0.0, 1.0);
}
`;

export class FoamSim {
  constructor(R, radii = new Float32Array(NA * 4)) {
    const d = R.device, GU = GPUBufferUsage, TU = GPUTextureUsage;
    this.R = R;
    this.ub = R.buf(352, GU.UNIFORM | GU.COPY_DST);
    this.parts = R.buf(N * 32, GU.STORAGE);
    this.slap = R.buf(NA * 16, GU.STORAGE);
    this.radii = R.buf(NA * 16, GU.STORAGE | GU.COPY_DST);
    d.queue.writeBuffer(this.radii, 0, radii);
    this.tex = R.tex([RES, RES], 'r16float', TU.RENDER_ATTACHMENT | TU.TEXTURE_BINDING);
    this.view = this.tex.createView();
    const simMod = R._module(SIM, 'foam-sim');
    this.pSlap = d.createComputePipeline({ layout: 'auto', compute: { module: simMod, entryPoint: 'slapPass' } });
    this.pSim = d.createComputePipeline({ layout: 'auto', compute: { module: simMod, entryPoint: 'simPass' } });
    const oc = R.ocean;
    const simRes = [{ buffer: this.ub }, { buffer: this.parts }, { buffer: this.slap }, { buffer: this.radii }, oc.dispViews[0], oc.dispViews[1], oc.dispViews[2], oc.sampler];
    const bgFor = (p, used) => d.createBindGroup({ layout: p.getBindGroupLayout(0), entries: used.map((b) => ({ binding: b, resource: simRes[b] })) });
    this.bgSlap = bgFor(this.pSlap, [0, 2, 3, 4, 5, 6, 7]);
    simRes[8] = this.view;
    this.bgSim = bgFor(this.pSim, [0, 1, 2, 3, 4, 5, 7, 8]);   // 'auto' layout: only the bindings simPass actually uses (jacAt samples d0, d1)
    const sm = R._module(SPLAT, 'foam-splat');
    const add = { color: { srcFactor: 'one', dstFactor: 'one', operation: 'add' }, alpha: { srcFactor: 'one', dstFactor: 'one', operation: 'add' } };
    this.pSplat = d.createRenderPipeline({ layout: 'auto', vertex: { module: sm, entryPoint: 'vs' },
      fragment: { module: sm, entryPoint: 'fs', targets: [{ format: 'r16float', blend: add }] }, primitive: { topology: 'triangle-strip' } });
    this.bgSplat = d.createBindGroup({ layout: this.pSplat.getBindGroupLayout(0), entries: [{ binding: 0, resource: { buffer: this.ub } }, { binding: 1, resource: { buffer: this.parts } }] });
    this.u = new Float32Array(88);
    this.ready = false;
    this.gain = 2.8;           // twice the rafts at half the size: same coverage, finer structure
    this.active = true;
  }
  setRadii(radii) { this.R.device.queue.writeBuffer(this.radii, 0, radii); this.ready = true; }
  // boatM: float64 boat matrix (absolute world); centre: absolute xz the texture is centred on
  update(enc, t, dt, boatM, centre, emit = []) {
    if (!this.active || !this.ready) return;
    const u = this.u;
    u.set([t, Math.min(dt, 0.1), this.gain, N, FOAM_EXTENT, centre[0], centre[1], Math.min(emit.length, 8)]);
    u.set(boatM, 8);
    u.fill(0, 24, 88);
    emit.slice(0, 8).forEach((e, i) => { u.set([e.x, e.z, e.rate, e.r], 24 + i * 4); u.set([e.vx || 0, e.vz || 0, 0, 0], 56 + i * 4); });
    this.R.device.queue.writeBuffer(this.ub, 0, u);
    let p = enc.beginComputePass();
    p.setPipeline(this.pSlap); p.setBindGroup(0, this.bgSlap); p.dispatchWorkgroups(Math.ceil(NA / 64));
    p.setPipeline(this.pSim); p.setBindGroup(0, this.bgSim); p.dispatchWorkgroups(Math.ceil(N / 64));
    p.end();
    const r = enc.beginRenderPass({ colorAttachments: [{ view: this.view, loadOp: 'clear', storeOp: 'store', clearValue: [0, 0, 0, 0] }] });
    r.setPipeline(this.pSplat); r.setBindGroup(0, this.bgSplat); r.draw(4, N); r.end();
  }
}

// Waterline radius table from the hull mesh: intersect every triangle with the plane y = wl (boat-local),
// take the outermost crossing per direction, smooth, and derive outward normals.
export function hullRadii(model, wl = 0.02) {
  const R = new Float32Array(NA).fill(0);
  for (const prims of model.meshes) for (const pr of prims) {
    const P = pr.pos, I = pr.idx;
    for (let k = 0; k < I.length; k += 3) {
      const a = I[k] * 3, b = I[k + 1] * 3, c = I[k + 2] * 3;
      const ys = [P[a + 1] - wl, P[b + 1] - wl, P[c + 1] - wl];
      if ((ys[0] > 0 && ys[1] > 0 && ys[2] > 0) || (ys[0] < 0 && ys[1] < 0 && ys[2] < 0)) continue;
      const vs = [a, b, c];
      for (let e = 0; e < 3; e++) {
        const i0 = vs[e], i1 = vs[(e + 1) % 3], y0 = ys[e], y1 = ys[(e + 1) % 3];
        if ((y0 > 0) === (y1 > 0) || y0 === y1) continue;
        const s = y0 / (y0 - y1);
        const x = P[i0] + (P[i1] - P[i0]) * s, z = P[i0 + 2] + (P[i1 + 2] - P[i0 + 2]) * s;
        const ang = Math.atan2(z, x);
        const j = ((Math.floor((ang / (Math.PI * 2) + 1) * NA) % NA) + NA) % NA;
        R[j] = Math.max(R[j], Math.hypot(x, z));
      }
    }
  }
  // fill gaps, smooth
  for (let it = 0; it < 3; it++) for (let j = 0; j < NA; j++) if (!R[j]) R[j] = Math.max(R[(j + NA - 1) % NA], R[(j + 1) % NA]);
  const S = new Float32Array(NA);
  for (let j = 0; j < NA; j++) { let s = 0, w = 0; for (let o = -2; o <= 2; o++) { const ww = 3 - Math.abs(o); s += R[(j + o + NA) % NA] * ww; w += ww; } S[j] = s / w; }
  const out = new Float32Array(NA * 4);
  for (let j = 0; j < NA; j++) {
    const a = (j + 0.5) / NA * Math.PI * 2, da = Math.PI * 2 / NA;
    const r = S[j], dr = (S[(j + 1) % NA] - S[(j + NA - 1) % NA]) / (2 * da);
    // outward normal of the polar curve r(a): n ∝ r·(cos, sin) − dr·(−sin, cos)
    let nx = r * Math.cos(a) + dr * Math.sin(a), nz = r * Math.sin(a) - dr * Math.cos(a);
    const l = Math.hypot(nx, nz) || 1;
    out.set([r, nx / l, nz / l, 0], j * 4);
  }
  return out;
}
