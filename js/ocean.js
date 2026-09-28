// FFT ocean (Tessendorf): 3 cascades × 256² — wind sea + Atlantic swell spectrum, evolved and inverse-FFT'd on the GPU.
// Outputs per cascade: disp (Dx, h, Dz, dDx/dz) and slope (dh/dx, dh/dz, dDx/dx, dDz/dz, mipmapped).
import { rng } from './math.js';

export const N = 256;
export const CASCADES = [512.0, 97.0, 17.7];      // tile sizes (m) – non-commensurate to hide tiling
const K_SPLIT = [2 * Math.PI / 97 * 4, 2 * Math.PI / 17.7 * 4];   // band limits between cascades (rad/m)
const CHOPS = [1.15, 1.6, 1.95];   // horizontal choppiness per cascade: pointed, trochoidal crests with broad troughs (below fold-over)

const GU = GPUBufferUsage, TU = GPUTextureUsage;

const SPECTRUM = /* wgsl */`
@group(0) @binding(0) var h0t: texture_2d<f32>;
@group(0) @binding(1) var outA: texture_storage_2d<rgba32float, write>;
@group(0) @binding(2) var outB: texture_storage_2d<rgba32float, write>;
@group(0) @binding(3) var<uniform> P: vec4f;   // x time, y tile size L
fn cmul(a: vec2f, b: vec2f) -> vec2f { return vec2f(a.x * b.x - a.y * b.y, a.x * b.y + a.y * b.x); }
fn pk(x: vec2f, y: vec2f) -> vec2f { return vec2f(x.x - y.y, x.y + y.x); }   // x + i*y (both spectra of real fields)
@compute @workgroup_size(16, 16) fn main(@builtin(global_invocation_id) id: vec3u) {
  let n = vec2f(id.xy) - ${N / 2}.0;
  let k = 6.2831853 * n / P.y; let kl = max(length(k), 1e-6);
  let om = sqrt(9.81 * kl);
  let h0 = textureLoad(h0t, id.xy, 0);
  let c = cos(om * P.x); let s = sin(om * P.x);
  let h = cmul(h0.xy, vec2f(c, s)) + cmul(h0.zw, vec2f(c, -s));
  let ih = vec2f(-h.y, h.x);
  let dx = -ih * (k.x / kl); let dz = -ih * (k.y / kl);
  let hx = ih * k.x; let hz = ih * k.y;
  let dxx = h * (k.x * k.x / kl); let dzz = h * (k.y * k.y / kl); let dxz = h * (k.x * k.y / kl);
  textureStore(outA, id.xy, vec4f(pk(h, dx), pk(dz, hx)));
  textureStore(outB, id.xy, vec4f(pk(hz, dxx), pk(dzz, dxz)));
}`;

// radix-2 inverse FFT of one row (or column) per workgroup, two packed complex values per texel
const FFT = /* wgsl */`
@group(0) @binding(0) var src: texture_2d<f32>;
@group(0) @binding(1) var dst: texture_storage_2d<rgba32float, write>;
var<workgroup> buf: array<vec4f, ${N * 2}>;
fn cm(a: vec2f, b: vec2f) -> vec2f { return vec2f(a.x * b.x - a.y * b.y, a.x * b.y + a.y * b.x); }
fn fft(i: u32) -> vec4f {
  var src_off = 0u; var dst_off = ${N}u;
  var m = 1u;
  loop {
    if (m >= ${N}u) { break; }
    let k = i % (2u * m); let j = k % m; let base = i - k;
    let a = buf[src_off + base + j]; let b = buf[src_off + base + j + m];
    let ang = 3.14159265 * f32(j) / f32(m);
    let w = vec2f(cos(ang), sin(ang));
    let wb = vec4f(cm(w, b.xy), cm(w, b.zw));
    buf[dst_off + i] = select(a + wb, a - wb, k >= m);
    workgroupBarrier();
    let t = src_off; src_off = dst_off; dst_off = t;
    m = m * 2u;
  }
  return buf[src_off + i];
}
@compute @workgroup_size(${N}) fn rows(@builtin(local_invocation_id) l: vec3u, @builtin(workgroup_id) w: vec3u) {
  let i = l.x;
  buf[reverseBits(i) >> ${32 - Math.log2(N)}u] = textureLoad(src, vec2u(i, w.x), 0);
  workgroupBarrier();
  textureStore(dst, vec2u(i, w.x), fft(i));
}
@compute @workgroup_size(${N}) fn cols(@builtin(local_invocation_id) l: vec3u, @builtin(workgroup_id) w: vec3u) {
  let i = l.x;
  buf[reverseBits(i) >> ${32 - Math.log2(N)}u] = textureLoad(src, vec2u(w.x, i), 0);
  workgroupBarrier();
  textureStore(dst, vec2u(w.x, i), fft(i));
}`;

const RESOLVE = (CHOP) => /* wgsl */`
@group(0) @binding(0) var ta: texture_2d<f32>;
@group(0) @binding(1) var tb: texture_2d<f32>;
@group(0) @binding(2) var disp: texture_storage_2d<rgba16float, write>;
@group(0) @binding(3) var slope: texture_storage_2d<rgba16float, write>;
@compute @workgroup_size(16, 16) fn main(@builtin(global_invocation_id) id: vec3u) {
  let sg = select(1.0, -1.0, ((id.x + id.y) & 1u) == 1u);
  let a = textureLoad(ta, id.xy, 0) * sg; let b = textureLoad(tb, id.xy, 0) * sg;
  // a = (h, Dx, Dz, dh/dx)   b = (dh/dz, dDx/dx, dDz/dz, dDx/dz)
  textureStore(disp, id.xy, vec4f(a.y * ${CHOP}, a.x, a.z * ${CHOP}, b.w * ${CHOP}));
  textureStore(slope, id.xy, vec4f(a.w, b.x, b.y * ${CHOP}, b.z * ${CHOP}));
}`;

const MIP = /* wgsl */`
@group(0) @binding(0) var src: texture_2d<f32>;
@group(0) @binding(1) var dst: texture_storage_2d<rgba16float, write>;
@compute @workgroup_size(8, 8) fn main(@builtin(global_invocation_id) id: vec3u) {
  let dim = textureDimensions(dst);
  if (id.x >= dim.x || id.y >= dim.y) { return; }
  let p = vec2i(id.xy) * 2; let sd = vec2i(textureDimensions(src)) - 1;
  let c = textureLoad(src, min(p, sd), 0) + textureLoad(src, min(p + vec2i(1, 0), sd), 0)
        + textureLoad(src, min(p + vec2i(0, 1), sd), 0) + textureLoad(src, min(p + vec2i(1, 1), sd), 0);
  textureStore(dst, id.xy, c * 0.25);
}`;

// height probe: invert horizontal displacement at up to 8 points (absolute xz)
const PROBE = /* wgsl */`
@group(0) @binding(0) var d0: texture_2d<f32>;
@group(0) @binding(1) var d1: texture_2d<f32>;
@group(0) @binding(2) var d2: texture_2d<f32>;
@group(0) @binding(3) var smp: sampler;
@group(0) @binding(4) var<uniform> pts: array<vec4f, 8>;
@group(0) @binding(5) var<storage, read_write> outp: array<vec4f, 8>;
fn D(xz: vec2f) -> vec4f {
  return textureSampleLevel(d0, smp, xz / ${CASCADES[0]}, 0.0) + textureSampleLevel(d1, smp, xz / ${CASCADES[1]}, 0.0) + textureSampleLevel(d2, smp, xz / ${CASCADES[2]}, 0.0);
}
@compute @workgroup_size(8) fn main(@builtin(local_invocation_id) l: vec3u) {
  let xz = pts[l.x].xy;
  var x0 = xz;
  for (var i = 0; i < 4; i++) { let d = D(x0); x0 = xz - d.xz; }
  outp[l.x] = vec4f(D(x0).y, 0.0, 0.0, 0.0);
}`;

export class Ocean {
  constructor(R) {
    this.R = R; const d = R.device;
    const mk = (fmt, usage, mips = 1) => R.tex([N, N], fmt, usage, mips);
    this.mips = Math.log2(N) + 1;
    // generate all cascades, then scale to the target significant wave height Hs = 4σ
    const specs = CASCADES.map((L, ci) => this.initialSpectrum(L, ci));
    let vs = 0; for (const a of specs) for (let i = 0; i < a.length; i += 4) vs += a[i] * a[i] + a[i + 1] * a[i + 1] + a[i + 2] * a[i + 2] + a[i + 3] * a[i + 3];
    const HS = 1.3, sc = (HS / 4) / Math.sqrt(Math.max(vs, 1e-12));
    for (const a of specs) for (let i = 0; i < a.length; i++) a[i] *= sc;
    this.cas = CASCADES.map((L, ci) => {
      const h0 = mk('rgba32float', TU.TEXTURE_BINDING | TU.COPY_DST);
      d.queue.writeTexture({ texture: h0 }, specs[ci], { bytesPerRow: N * 16 }, [N, N]);
      return {
        L, h0,
        A: mk('rgba32float', TU.TEXTURE_BINDING | TU.STORAGE_BINDING),
        B: mk('rgba32float', TU.TEXTURE_BINDING | TU.STORAGE_BINDING),
        disp: mk('rgba16float', TU.TEXTURE_BINDING | TU.STORAGE_BINDING, this.mips),   // mipmapped: distant vertices take band-limited waves (no moiré)
        slope: mk('rgba16float', TU.TEXTURE_BINDING | TU.STORAGE_BINDING, this.mips),
        ub: R.buf(16, GU.UNIFORM | GU.COPY_DST),
      };
    });
    this.tmp = mk('rgba32float', TU.TEXTURE_BINDING | TU.STORAGE_BINDING);
    const cp = (code, entryPoint = 'main') => d.createComputePipeline({ layout: 'auto', compute: { module: R._module(code, 'ocean-' + entryPoint), entryPoint } });
    this.pSpec = cp(SPECTRUM); this.pRows = cp(FFT, 'rows'); this.pCols = cp(FFT, 'cols'); this.pRes = CHOPS.map((c) => cp(RESOLVE(c.toFixed(3)))); this.pMip = cp(MIP); this.pProbe = cp(PROBE);
    const bg = (p, res) => d.createBindGroup({ layout: p.getBindGroupLayout(0), entries: res.map((r, i) => ({ binding: i, resource: r })) });
    const v = (t, lvl = 0) => t.createView({ baseMipLevel: lvl, mipLevelCount: 1 });
    this.sampler = d.createSampler({ magFilter: 'linear', minFilter: 'linear', mipmapFilter: 'linear', addressModeU: 'repeat', addressModeV: 'repeat', maxAnisotropy: 8 });
    for (const c of this.cas) {
      c.bgSpec = bg(this.pSpec, [c.h0.createView(), c.A.createView(), c.B.createView(), { buffer: c.ub }]);
      c.bgRowsA = bg(this.pRows, [c.A.createView(), this.tmp.createView()]); c.bgColsA = bg(this.pCols, [this.tmp.createView(), c.A.createView()]);
      c.bgRowsB = bg(this.pRows, [c.B.createView(), this.tmp.createView()]); c.bgColsB = bg(this.pCols, [this.tmp.createView(), c.B.createView()]);
      c.bgRes = bg(this.pRes[this.cas.indexOf(c)], [c.A.createView(), c.B.createView(), v(c.disp), v(c.slope)]);
      c.bgMipD = []; for (let m = 1; m < this.mips; m++) c.bgMipD.push(bg(this.pMip, [v(c.disp, m - 1), v(c.disp, m)]));
      c.bgMip = []; for (let m = 1; m < this.mips; m++) c.bgMip.push(bg(this.pMip, [v(c.slope, m - 1), v(c.slope, m)]));
    }
    // probes (camera + boat hull points) read back to the CPU
    this.probeU = R.buf(8 * 16, GU.UNIFORM | GU.COPY_DST);
    this.probeS = R.buf(8 * 16, GU.STORAGE | GU.COPY_SRC);
    this.probeR = [0, 1].map(() => d.createBuffer({ size: 8 * 16, usage: GU.MAP_READ | GU.COPY_DST }));
    this.probeBusy = [false, false]; this.probeIdx = 0;
    this.bgProbe = bg(this.pProbe, [this.cas[0].disp.createView(), this.cas[1].disp.createView(), this.cas[2].disp.createView(), this.sampler, { buffer: this.probeU }, { buffer: this.probeS }]);
    this.heights = new Float32Array(8); this.probePts = new Float32Array(32); this.probeValid = false;
    // views for rendering (disp without mips, slope mipmapped)
    this.dispViews = this.cas.map((c) => c.disp.createView());
    this.slopeViews = this.cas.map((c) => c.slope.createView());
  }

  // Wind sea (Phillips, 7 m/s) + Atlantic swell (~95 m, narrow band), split into cascade bands.
  initialSpectrum(L, ci) {
    const out = new Float32Array(N * N * 4), r = rng(1234 + ci * 7919);
    const gauss = () => { const u = Math.max(r(), 1e-9), v = r(); return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v); };
    const dk = 2 * Math.PI / L, V = 7.0, Lw = V * V / 9.81;
    const wd = [Math.cos(0.55), Math.sin(0.55)], sd = [Math.cos(0.95), Math.sin(0.95)];
    const ks = 2 * Math.PI / 95;
    const kLo = ci === 0 ? 0 : K_SPLIT[ci - 1], kHi = ci === 2 ? Infinity : K_SPLIT[ci];
    const spec = (kx, kz) => {
      const k = Math.hypot(kx, kz); if (k < 1e-6 || k < kLo || k >= kHi) return 0;
      const c = (kx * wd[0] + kz * wd[1]) / k, cs = (kx * sd[0] + kz * sd[1]) / k;
      const wind = 3.2e-3 * Math.exp(-1 / ((k * Lw) ** 2)) / k ** 4 * Math.pow(Math.max(c, 0) * 0.85 + Math.abs(c) * 0.15, 4) * Math.exp(-((k * 0.03) ** 2));
      const swell = 0.9 * Math.exp(-(((k - ks) / (0.3 * ks)) ** 2)) * Math.pow(Math.max(cs, 0), 24) / (k * ks);
      return wind + swell;
    };
    const amp = (kx, kz) => Math.sqrt(spec(kx, kz) * dk * dk / 2);
    const G = [];
    for (let i = 0; i < N * N; i++) G.push([gauss(), gauss()]);
    for (let y = 0; y < N; y++) for (let x = 0; x < N; x++) {
      const kx = (x - N / 2) * dk, kz = (y - N / 2) * dk;
      const a = amp(kx, kz), am = amp(-kx, -kz);
      const g = G[y * N + x], gm = G[((N - y) % N) * N + ((N - x) % N)];
      const o = (y * N + x) * 4;
      out[o] = g[0] * a; out[o + 1] = g[1] * a;
      out[o + 2] = gm[0] * am; out[o + 3] = -gm[1] * am;     // conj(h0(-k))
    }
    return out;
  }

  // enqueue the per-frame ocean update + height probes (points: absolute [x,z] list, ≤ 8)
  update(enc, t, points) {
    const q = this.R.device.queue;
    for (const c of this.cas) q.writeBuffer(c.ub, 0, new Float32Array([t, c.L, 0, 0]));
    points.slice(0, 8).forEach((p, i) => { this.probePts[i * 4] = p[0]; this.probePts[i * 4 + 1] = p[1]; });
    q.writeBuffer(this.probeU, 0, this.probePts);
    const p = enc.beginComputePass();
    const G = N / 16;
    for (const c of this.cas) {
      p.setPipeline(this.pSpec); p.setBindGroup(0, c.bgSpec); p.dispatchWorkgroups(G, G);
      p.setPipeline(this.pRows); p.setBindGroup(0, c.bgRowsA); p.dispatchWorkgroups(N);
      p.setPipeline(this.pCols); p.setBindGroup(0, c.bgColsA); p.dispatchWorkgroups(N);
      p.setPipeline(this.pRows); p.setBindGroup(0, c.bgRowsB); p.dispatchWorkgroups(N);
      p.setPipeline(this.pCols); p.setBindGroup(0, c.bgColsB); p.dispatchWorkgroups(N);
      p.setPipeline(this.pRes[this.cas.indexOf(c)]); p.setBindGroup(0, c.bgRes); p.dispatchWorkgroups(G, G);
      p.setPipeline(this.pMip);
      for (let m = 1; m < this.mips; m++) { const s = Math.max(1, N >> m); p.setBindGroup(0, c.bgMip[m - 1]); p.dispatchWorkgroups(Math.ceil(s / 8), Math.ceil(s / 8)); }
      for (let m = 1; m < this.mips; m++) { const s = Math.max(1, N >> m); p.setBindGroup(0, c.bgMipD[m - 1]); p.dispatchWorkgroups(Math.ceil(s / 8), Math.ceil(s / 8)); }
    }
    p.setPipeline(this.pProbe); p.setBindGroup(0, this.bgProbe); p.dispatchWorkgroups(1);
    p.end();
    const i = this.probeIdx;
    if (!this.probeBusy[i]) { enc.copyBufferToBuffer(this.probeS, 0, this.probeR[i], 0, 8 * 16); this.pendingCopy = i; } else this.pendingCopy = -1;
  }
  // call after queue.submit
  afterSubmit() {
    const i = this.pendingCopy; if (i < 0 || i === undefined) return;
    this.probeBusy[i] = true; this.probeIdx ^= 1;
    this.probeR[i].mapAsync(GPUMapMode.READ).then(() => {
      const f = new Float32Array(this.probeR[i].getMappedRange());
      for (let k = 0; k < 8; k++) this.heights[k] = f[k * 4];
      this.probeR[i].unmap(); this.probeBusy[i] = false; this.probeValid = true;
    }).catch(() => { this.probeBusy[i] = false; });
  }
}
