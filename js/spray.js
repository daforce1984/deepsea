// GPU spray: the lobtail's hundreds of thousands of drops are simulated in a compute shader (gravity, size-dependent air
// drag, landing, fade) and written straight into the particle instance buffer the renderer already draws (after the
// CPU-side spray slots).  The CPU only uploads new drops, in contiguous batches into a ring.
const STEP = /* wgsl */`
struct U { o: vec4f, p: vec4f };            // o: origin xyz, dt ; p: out offset (drops), count, time, 0
@group(0) @binding(0) var<uniform> u: U;
@group(0) @binding(1) var<storage, read_write> P: array<vec4f>;     // 2 per drop: pos.xyz + r, vel.xyz + age
@group(0) @binding(2) var<storage, read_write> O: array<vec4f>;     // renderer instances: 2 per drop
fn hash(n: u32) -> f32 { var x = n; x ^= x >> 16u; x *= 0x7feb352du; x ^= x >> 15u; x *= 0x846ca68bu; x ^= x >> 16u; return f32(x) / 4294967296.0; }
@compute @workgroup_size(128) fn step(@builtin(global_invocation_id) id: vec3u) {
  let i = id.x; if (i >= u32(u.p.y)) { return; }
  var a = P[i * 2u]; var b = P[i * 2u + 1u];
  let oi = (u32(u.p.x) + i) * 2u;
  if (a.w <= 0.0) { O[oi + 1u] = vec4f(0.0); return; }                 // empty slot
  let dt = u.o.w;
  b.w += dt;
  let dr = exp(-dt * (0.12 + 0.0022 / a.w));                            // air drag by size: fine drops hang as mist
  b = vec4f((b.xyz + vec3f(0.0, -9.81 * dt, 0.0)) * dr, b.w);
  a = vec4f(a.xyz + b.xyz * dt, a.w);
  if (a.y < -0.02 || b.w > 10.0) { a.w = 0.0; P[i * 2u] = a; O[oi + 1u] = vec4f(0.0); return; }   // landed / expired
  P[i * 2u] = a; P[i * 2u + 1u] = b;
  let alpha = (0.55 + 0.3 * min(1.0, a.w / 0.02)) * (1.0 - smoothstep(5.0, 9.0, b.w));
  O[oi] = vec4f(a.xyz - u.o.xyz, max(0.024, a.w * 1.4));
  O[oi + 1u] = vec4f(alpha, hash(i * 7u + 3u), 1.0, 0.0);
}
`;

export class GpuSpray {
  constructor(R, out, outOffset, N) {
    const d = R.device, GU = GPUBufferUsage;
    this.R = R; this.N = N; this.head = 0; this.live = 0; this.lastSpawnT = -1e9; this.t = 0; this.outOffset = outOffset;
    this.P = R.buf(N * 32, GU.STORAGE | GU.COPY_DST);
    d.queue.writeBuffer(this.P, 0, new Float32Array(N * 8));
    this.ub = R.buf(32, GU.UNIFORM | GU.COPY_DST);
    const mod = R._module(STEP, 'gpu-spray');
    this.pipe = d.createComputePipeline({ layout: 'auto', compute: { module: mod, entryPoint: 'step' } });
    this.bg = d.createBindGroup({ layout: this.pipe.getBindGroupLayout(0), entries: [{ binding: 0, resource: { buffer: this.ub } }, { binding: 1, resource: { buffer: this.P } }, { binding: 2, resource: { buffer: out } }] });
    this.u = new Float32Array(8);
    this.stage = new Float32Array(0); this.sn = 0;
  }
  // queue drops (absolute positions): x, y, z, vx, vy, vz, r
  add(x, y, z, vx, vy, vz, r) {
    if (this.sn * 8 >= this.stage.length) { const s = new Float32Array(Math.max(8 * 4096, this.stage.length * 2)); s.set(this.stage); this.stage = s; }
    this.stage.set([x, y, z, r, vx, vy, vz, 0], this.sn * 8); this.sn++;
  }
  get active() { return this.t - this.lastSpawnT < 11; }
  // upload queued drops into the ring (contiguous chunks) and run the step; call once per frame before drawing
  update(enc, dt, origin) {
    const q = this.R.device.queue;
    this.t += dt;
    if (this.sn) {
      let off = 0, left = this.sn;
      while (left > 0) {
        const n = Math.min(left, this.N - this.head);
        q.writeBuffer(this.P, this.head * 32, this.stage, off * 8, n * 8);
        this.head = (this.head + n) % this.N; off += n; left -= n;
      }
      this.sn = 0; this.lastSpawnT = this.t;
    }
    if (!this.active) return;
    this.u.set([origin[0], origin[1], origin[2], dt, this.outOffset, this.N, this.t, 0]);
    q.writeBuffer(this.ub, 0, this.u);
    const p = enc.beginComputePass();
    p.setPipeline(this.pipe); p.setBindGroup(0, this.bg); p.dispatchWorkgroups(Math.ceil(this.N / 128));
    p.end();
  }
}
