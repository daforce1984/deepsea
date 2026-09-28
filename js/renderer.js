// WebGPU renderer: shadow (flashlight) -> forward HDR -> volumetric (half) -> composite -> additive FX -> bloom -> final.
import * as SH from './shaders.js';
import { m4 } from './math.js';
import { FoamSim } from './foam.js';
import { loadHDR, hdrSun, uploadHDR, removeGround } from './hdr.js';
import { Ocean } from './ocean.js';

const GU = GPUBufferUsage, TU = GPUTextureUsage;
export const FRAME_FLOATS = 340;

export class Renderer {
  async init(canvas) {
    if (!navigator.gpu) throw Error('WebGPU unavailable');
    const adapter = await navigator.gpu.requestAdapter({ powerPreference: 'high-performance' });
    if (!adapter) throw Error('no WebGPU adapter');
    this.device = await adapter.requestDevice({ requiredLimits: { maxStorageBuffersPerShaderStage: Math.min(8, adapter.limits.maxStorageBuffersPerShaderStage), maxSampledTexturesPerShaderStage: Math.min(24, adapter.limits.maxSampledTexturesPerShaderStage) } });   // frame group: ocean, env cube, foam, sand, refraction
    this.device.lost.then((i) => console.error('GPU device lost', i.message));
    this.device.addEventListener?.('uncapturederror', (e) => console.error('WebGPU error:', e.error.message));
    this.canvas = canvas;
    this.ctx = canvas.getContext('webgpu');
    this.format = navigator.gpu.getPreferredCanvasFormat();
    this.ctx.configure({ device: this.device, format: this.format, alphaMode: 'opaque' });
    this.bytes = 0;
    this.frameData = new Float32Array(FRAME_FLOATS);
    this.frameBuf = this.buf(FRAME_FLOATS * 4, GU.UNIFORM | GU.COPY_DST);
    this.shadowFrameBuf = this.buf(FRAME_FLOATS * 4, GU.UNIFORM | GU.COPY_DST);
    this.finalBuf = this.buf(64, GU.UNIFORM | GU.COPY_DST);
    this.linSmp = this.device.createSampler({ magFilter: 'linear', minFilter: 'linear', addressModeU: 'clamp-to-edge', addressModeV: 'clamp-to-edge' });
    this.texSmp = this.device.createSampler({ magFilter: 'linear', minFilter: 'linear', mipmapFilter: 'linear', addressModeU: 'repeat', addressModeV: 'repeat', maxAnisotropy: 4 });
    this.cmpSmp = this.device.createSampler({ compare: 'less', magFilter: 'linear', minFilter: 'linear' });
    this.dummyStorage = this.buf(64 * 4, GU.STORAGE | GU.COPY_DST);
    this.shadowSize = 2048;
    this.shadowTex = this.tex([this.shadowSize, this.shadowSize], 'depth32float', TU.RENDER_ATTACHMENT | TU.TEXTURE_BINDING);
    // prefiltered environment cube (mip = roughness), baked on demand
    this.envSize = 128; this.envMips = 6;
    this.envCube = this.device.createTexture({ size: [this.envSize, this.envSize, 6], format: 'rgba16float', mipLevelCount: this.envMips, usage: TU.RENDER_ATTACHMENT | TU.TEXTURE_BINDING });
    this.bytes += this.envSize * this.envSize * 6 * 8 * 1.34;
    this.envSmp = this.device.createSampler({ magFilter: 'linear', minFilter: 'linear', mipmapFilter: 'linear' });
    this.skyTex = this.solidTexHalf();
    this.skyScale = 0; this.skyUOff = 0;
    this._layouts();
    this.ocean = new Ocean(this);
    this.foam = new FoamSim(this);
    this._pipelines();
    this._envInit();
    this.defaults = {
      white: this.solidTex([255, 255, 255, 255], 'rgba8unorm-srgb'),
      flat: this.solidTex([128, 128, 255, 255], 'rgba8unorm'),
      mr: this.solidTex([255, 255, 255, 255], 'rgba8unorm'),
      black: this.solidTex([255, 255, 255, 255], 'rgba8unorm-srgb'),
    };
    this.scale = 1;
  }

  buf(size, usage, data) {
    const b = this.device.createBuffer({ size: Math.ceil(size / 4) * 4, usage, mappedAtCreation: !!data });
    if (data) { new data.constructor(b.getMappedRange()).set(data); b.unmap(); }
    this.bytes += size;
    return b;
  }
  tex(size, format, usage, mips = 1) {
    const t = this.device.createTexture({ size, format, usage, mipLevelCount: mips });
    const bpp = format.startsWith('rgba16') ? 8 : 4;
    this.bytes += size[0] * size[1] * bpp * (mips > 1 ? 1.34 : 1);
    return t;
  }
  solidTex(rgba, format) {
    const t = this.tex([1, 1], format, TU.TEXTURE_BINDING | TU.COPY_DST);
    this.device.queue.writeTexture({ texture: t }, new Uint8Array(rgba), { bytesPerRow: 4 }, [1, 1]);
    return t;
  }

  _layouts() {
    const d = this.device, V = GPUShaderStage.VERTEX, Fr = GPUShaderStage.FRAGMENT, VF = V | Fr;
    const L = (entries) => d.createBindGroupLayout({ entries });
    this.frameLayout = L([
      { binding: 0, visibility: VF, buffer: {} },
      { binding: 1, visibility: VF, texture: { sampleType: 'depth' } },
      { binding: 2, visibility: VF, sampler: { type: 'comparison' } },
      { binding: 10, visibility: VF, texture: { sampleType: 'float' } },
      { binding: 11, visibility: VF, texture: { sampleType: 'float' } },
      { binding: 12, visibility: VF, texture: { sampleType: 'float' } },
      { binding: 13, visibility: VF, sampler: {} },
      { binding: 14, visibility: VF, texture: { sampleType: 'float' } },
      { binding: 15, visibility: VF, texture: { sampleType: 'float' } },
      { binding: 16, visibility: VF, texture: { sampleType: 'float' } },
      { binding: 17, visibility: VF, texture: { sampleType: 'float', viewDimension: 'cube' } },
      { binding: 18, visibility: VF, sampler: {} },
      { binding: 19, visibility: VF, texture: { sampleType: 'float' } },
      { binding: 20, visibility: VF, texture: { sampleType: 'float' } },
      { binding: 21, visibility: VF, texture: { sampleType: 'float' } },
      { binding: 22, visibility: VF, sampler: {} },
      { binding: 23, visibility: VF, texture: { sampleType: 'float' } },   // scene behind the sea surface (refraction)
      { binding: 24, visibility: VF, texture: { sampleType: 'depth' } },
      { binding: 25, visibility: VF, texture: { sampleType: 'float' } },   // equirect sky HDRI
    ]);
    this.shadowFrameLayout = L([{ binding: 0, visibility: VF, buffer: {} }]);
    this.objLayout = L([
      { binding: 0, visibility: VF, buffer: {} },
      { binding: 1, visibility: VF, buffer: { type: 'read-only-storage' } },
    ]);
    const t = (b, st = 'float') => ({ binding: b, visibility: Fr, texture: { sampleType: st } });
    this.matLayout = L([{ binding: 0, visibility: Fr, buffer: {} }, t(1), t(2), t(3), t(4), { binding: 5, visibility: Fr, sampler: {} }]);
    this.volLayout = L([
      { binding: 0, visibility: Fr, buffer: {} },
      { binding: 1, visibility: Fr, texture: { sampleType: 'depth' } },
      { binding: 2, visibility: Fr, sampler: { type: 'comparison' } },
      { binding: 3, visibility: Fr, texture: { sampleType: 'depth' } },
      { binding: 4, visibility: Fr, texture: { sampleType: 'float' } },
      { binding: 5, visibility: Fr, sampler: {} },
      { binding: 10, visibility: Fr, texture: { sampleType: 'float' } },
      { binding: 11, visibility: Fr, texture: { sampleType: 'float' } },
      { binding: 12, visibility: Fr, texture: { sampleType: 'float' } },
      { binding: 13, visibility: Fr, sampler: {} },
    ]);
    this.compLayout = L([{ binding: 0, visibility: Fr, buffer: {} }, t(1, 'unfilterable-float'), t(2, 'depth'), t(3, 'unfilterable-float'),
      { binding: 10, visibility: Fr, texture: { sampleType: 'float' } },
      { binding: 11, visibility: Fr, texture: { sampleType: 'float' } },
      { binding: 12, visibility: Fr, texture: { sampleType: 'float' } },
      { binding: 13, visibility: Fr, sampler: {} },
      { binding: 25, visibility: Fr, texture: { sampleType: 'float' } },
    ]);
    this.envLayout = L([{ binding: 0, visibility: Fr, buffer: {} }, { binding: 13, visibility: Fr, sampler: {} }, { binding: 25, visibility: Fr, texture: { sampleType: 'float' } }]);
    this.jellyLayout = L([{ binding: 0, visibility: VF, buffer: { type: 'read-only-storage' } }]);
    this.postLayout = L([t(0), { binding: 1, visibility: Fr, sampler: {} }, { binding: 2, visibility: Fr, buffer: {} }]);
    this.finalLayout = L([t(0), t(1), { binding: 2, visibility: Fr, sampler: {} }, { binding: 3, visibility: Fr, buffer: {} }]);
    this.blitLayout = L([t(0), { binding: 1, visibility: Fr, sampler: {} }]);
    this.PL = (...bgl) => d.createPipelineLayout({ bindGroupLayouts: bgl });
    this.frameBG = null;
  }

  _module(code, label) {
    const m = this.device.createShaderModule({ code, label });
    m.getCompilationInfo().then((info) => {
      for (const msg of info.messages) if (msg.type === 'error') console.error(`[${label}] ${msg.lineNum}:${msg.linePos} ${msg.message}`);
    });
    return m;
  }

  _pipelines() {
    const d = this.device;
    const HDR = 'rgba16float';
    const vbStatic = [
      { arrayStride: 12, attributes: [{ shaderLocation: 0, offset: 0, format: 'float32x3' }] },
      { arrayStride: 12, attributes: [{ shaderLocation: 1, offset: 0, format: 'float32x3' }] },
      { arrayStride: 8, attributes: [{ shaderLocation: 2, offset: 0, format: 'float32x2' }] },
    ];
    const vbSkin = [...vbStatic,
      { arrayStride: 16, attributes: [{ shaderLocation: 3, offset: 0, format: 'uint32x4' }] },
      { arrayStride: 16, attributes: [{ shaderLocation: 4, offset: 0, format: 'float32x4' }] }];
    this.meshPipes = {}; this.shadowPipes = {};
    for (const kind of ['static', 'skin', 'inst']) {
      const opts = { skin: kind === 'skin', inst: kind === 'inst' };
      const mod = this._module(SH.meshShader(opts), 'mesh-' + kind);
      const buffers = kind === 'skin' ? vbSkin : vbStatic;
      this.meshPipes[kind] = d.createRenderPipeline({
        layout: this.PL(this.frameLayout, this.objLayout, this.matLayout),
        vertex: { module: mod, entryPoint: 'vs', buffers },
        fragment: { module: mod, entryPoint: 'fs', targets: [{ format: HDR }] },
        primitive: { topology: 'triangle-list', cullMode: 'none' },
        depthStencil: { format: 'depth32float', depthWriteEnabled: true, depthCompare: 'less' },
      });
      const smod = this._module(SH.meshShader({ ...opts, shadow: true }), 'shadow-' + kind);
      this.shadowPipes[kind] = d.createRenderPipeline({
        layout: this.PL(this.shadowFrameLayout, this.objLayout),
        vertex: { module: smod, entryPoint: 'vs', buffers },
        primitive: { topology: 'triangle-list', cullMode: 'none' },
        depthStencil: { format: 'depth32float', depthWriteEnabled: true, depthCompare: 'less', depthBias: 2, depthBiasSlopeScale: 2.5 },
      });
    }
    const grid = [{ arrayStride: 8, attributes: [{ shaderLocation: 0, offset: 0, format: 'float32x2' }] }];
    const mk = (code, label, extra = {}) => {
      const mod = this._module(code, label);
      return d.createRenderPipeline({
        layout: this.PL(this.frameLayout, this.objLayout),
        vertex: { module: mod, entryPoint: 'vs', buffers: grid },
        fragment: { module: mod, entryPoint: 'fs', targets: [{ format: HDR }] },
        primitive: { topology: 'triangle-list', cullMode: 'none' },
        depthStencil: { format: 'depth32float', depthWriteEnabled: true, depthCompare: 'less' }, ...extra,
      });
    };
    this.floorPipe = mk(SH.FLOOR, 'floor');
    this.surfacePipe = mk(SH.SURFACE, 'surface');
    const fsq = (code, label, layouts, format, blend) => {
      const mod = this._module(code, label);
      return d.createRenderPipeline({
        layout: this.PL(...layouts), vertex: { module: mod, entryPoint: 'vs' },
        fragment: { module: mod, entryPoint: 'fs', targets: [{ format, blend }] }, primitive: { topology: 'triangle-list' },
      });
    };
    this.volPipe = fsq(SH.VOLUME, 'volume', [this.volLayout], HDR);
    this.compPipe = fsq(SH.COMPOSITE, 'composite', [this.compLayout], HDR);
    const add = { color: { srcFactor: 'one', dstFactor: 'one', operation: 'add' }, alpha: { srcFactor: 'one', dstFactor: 'one', operation: 'add' } };
    this.bloomDown = fsq(SH.BLOOM_DOWN, 'bloom-down', [this.postLayout], HDR);
    this.bloomUp = fsq(SH.BLOOM_UP, 'bloom-up', [this.postLayout], HDR, add);
    this.finalPipe = fsq(SH.FINAL, 'final', [this.finalLayout], this.format);
    this.finalLdrPipe = fsq(SH.FINAL, 'final-ldr', [this.finalLayout], 'rgba8unorm');
    this.fxaaPipe = fsq(SH.FXAA, 'fxaa', [this.blitLayout], this.format);
    this.aa = true;
    this.blitPipes = {
      'rgba8unorm': fsq(SH.BLIT, 'blit', [this.blitLayout], 'rgba8unorm'),
      'rgba8unorm-srgb': fsq(SH.BLIT, 'blit-srgb', [this.blitLayout], 'rgba8unorm-srgb'),
    };
    const pmod = this._module(SH.PARTICLES, 'particles');
    this.partPipe = d.createRenderPipeline({
      layout: this.PL(this.frameLayout, this.objLayout),
      vertex: { module: pmod, entryPoint: 'vs' },
      fragment: { module: pmod, entryPoint: 'fs', targets: [{ format: HDR, blend: add }] },
      primitive: { topology: 'triangle-strip' },
      depthStencil: { format: 'depth32float', depthWriteEnabled: false, depthCompare: 'less' },
    });
    const bmod = this._module(SH.BUBBLE, 'bubble');
    this.bubblePipe = d.createRenderPipeline({
      layout: this.PL(this.frameLayout, this.objLayout),
      vertex: { module: bmod, entryPoint: 'vs' },
      fragment: { module: bmod, entryPoint: 'fs', targets: [{ format: HDR, blend: { color: { srcFactor: 'one', dstFactor: 'one-minus-src-alpha', operation: 'add' }, alpha: { srcFactor: 'one', dstFactor: 'one-minus-src-alpha', operation: 'add' } } }] },
      primitive: { topology: 'triangle-strip' },
      depthStencil: { format: 'depth32float', depthWriteEnabled: false, depthCompare: 'less' },
    });
    const jmod = this._module(SH.JELLY, 'jelly');
    this.jellyPipe = d.createRenderPipeline({
      layout: this.PL(this.frameLayout, this.jellyLayout),
      vertex: { module: jmod, entryPoint: 'vs', buffers: [{ arrayStride: 16, attributes: [{ shaderLocation: 0, offset: 0, format: 'float32x4' }] }] },
      fragment: { module: jmod, entryPoint: 'fs', targets: [{ format: HDR, blend: add }] },
      primitive: { topology: 'triangle-list', cullMode: 'none' },
      depthStencil: { format: 'depth32float', depthWriteEnabled: false, depthCompare: 'less' },
    });
  }

  resize(w, h) {
    w = Math.max(64, w | 0); h = Math.max(64, h | 0);
    if (this.W === w && this.H === h) return;
    for (const t of [this.hdr, this.depth, ...(this.vols || []), this.comp, this.bloom, this.ldr]) t?.destroy();
    this.W = w; this.H = h;
    this.canvas.width = w; this.canvas.height = h;
    const RA = TU.RENDER_ATTACHMENT | TU.TEXTURE_BINDING;
    this.hdr = this.tex([w, h], 'rgba16float', RA | TU.COPY_SRC);
    this.depth = this.tex([w, h], 'depth32float', RA | TU.COPY_SRC);
    this.refr?.destroy(); this.refrDepth?.destroy();
    this.refr = this.tex([w, h], 'rgba16float', TU.TEXTURE_BINDING | TU.COPY_DST);
    this.refrDepth = this.tex([w, h], 'depth32float', TU.TEXTURE_BINDING | TU.COPY_DST);
    this.vols = [0, 1].map(() => this.tex([Math.ceil(w / 2), Math.ceil(h / 2)], 'rgba16float', RA)); this.volIdx = 0;
    this.comp = this.tex([w, h], 'rgba16float', RA);
    this.ldr = this.tex([w, h], 'rgba8unorm', RA);
    this.bloomMips = 5;
    this.bloom = this.tex([Math.max(1, w >> 1), Math.max(1, h >> 1)], 'rgba16float', RA, this.bloomMips);
    const d = this.device;
    const oc = this.ocean;
    const ocE = [0, 1, 2].map((i) => ({ binding: 10 + i, resource: oc.dispViews[i] })).concat([{ binding: 13, resource: oc.sampler }]);
    this.frameBG = d.createBindGroup({ layout: this.frameLayout, entries: [
      { binding: 0, resource: { buffer: this.frameBuf } }, { binding: 1, resource: this.shadowTex.createView() }, { binding: 2, resource: this.cmpSmp },
      ...ocE, ...[0, 1, 2].map((i) => ({ binding: 14 + i, resource: oc.slopeViews[i] })),
      { binding: 17, resource: this.envCube.createView({ dimension: 'cube' }) }, { binding: 18, resource: this.envSmp },
      { binding: 19, resource: this.foam.view },
      { binding: 20, resource: (this.sandN || this.defaults.flat).createView() }, { binding: 21, resource: (this.sandA || this.defaults.white).createView() },
      { binding: 22, resource: this.texSmp },
      { binding: 23, resource: this.refr.createView() }, { binding: 24, resource: this.refrDepth.createView() },
      { binding: 25, resource: this.skyTex.createView() }] });
    this.shadowFrameBG = d.createBindGroup({ layout: this.shadowFrameLayout, entries: [{ binding: 0, resource: { buffer: this.shadowFrameBuf } }] });
    // ping-pong: pass k writes vols[k] reading history vols[1-k]; composite reads vols[k]
    this.volBGs = [0, 1].map((k) => d.createBindGroup({ layout: this.volLayout, entries: [
      { binding: 0, resource: { buffer: this.frameBuf } }, { binding: 1, resource: this.shadowTex.createView() },
      { binding: 2, resource: this.cmpSmp }, { binding: 3, resource: this.depth.createView() },
      { binding: 4, resource: this.vols[1 - k].createView() }, { binding: 5, resource: this.linSmp }, ...ocE] }));
    this.compBGs = [0, 1].map((k) => d.createBindGroup({ layout: this.compLayout, entries: [
      { binding: 0, resource: { buffer: this.frameBuf } }, { binding: 1, resource: this.hdr.createView() },
      { binding: 2, resource: this.depth.createView() }, { binding: 3, resource: this.vols[k].createView() }, ...ocE, { binding: 25, resource: this.skyTex.createView() }] }));
    this.bloomViews = [...Array(this.bloomMips)].map((_, i) => this.bloom.createView({ baseMipLevel: i, mipLevelCount: 1 }));
    this.bloomBufs = this.bloomBufs || [...Array(12)].map(() => this.buf(16, GU.UNIFORM | GU.COPY_DST));
    const pbg = (view, ub) => d.createBindGroup({ layout: this.postLayout, entries: [{ binding: 0, resource: view }, { binding: 1, resource: this.linSmp }, { binding: 2, resource: { buffer: ub } }] });
    this.bloomDownBG = [pbg(this.comp.createView(), this.bloomBufs[0])];
    for (let i = 1; i < this.bloomMips; i++) this.bloomDownBG.push(pbg(this.bloomViews[i - 1], this.bloomBufs[i]));
    this.bloomUpBG = [];
    for (let i = this.bloomMips - 1; i > 0; i--) this.bloomUpBG.push(pbg(this.bloomViews[i], this.bloomBufs[6 + i]));
    this.finalBG = d.createBindGroup({ layout: this.finalLayout, entries: [
      { binding: 0, resource: this.comp.createView() }, { binding: 1, resource: this.bloomViews[0] },
      { binding: 2, resource: this.linSmp }, { binding: 3, resource: { buffer: this.finalBuf } }] });
    this.fxaaBG = d.createBindGroup({ layout: this.blitLayout, entries: [{ binding: 0, resource: this.ldr.createView() }, { binding: 1, resource: this.linSmp }] });
    // bloom texel offsets
    const bw = (lvl) => [Math.max(1, (w >> 1) >> lvl), Math.max(1, (h >> 1) >> lvl)];
    d.queue.writeBuffer(this.bloomBufs[0], 0, new Float32Array([1 / w, 1 / h, 1, 0]));
    for (let i = 1; i < this.bloomMips; i++) { const [sw, sh] = bw(i - 1); d.queue.writeBuffer(this.bloomBufs[i], 0, new Float32Array([1 / sw, 1 / sh, 0, 0])); }
    for (let i = this.bloomMips - 1; i > 0; i--) { const [sw, sh] = bw(i); d.queue.writeBuffer(this.bloomBufs[6 + i], 0, new Float32Array([1 / sw, 1 / sh, 1, 0])); }
  }

  // ---------- resources ----------
  uploadImage(img, srgb, maxSize = 1024) {
    const d = this.device;
    let w = img.width, h = img.height;
    const s = Math.min(1, maxSize / Math.max(w, h));
    const tw = Math.max(1, Math.round(w * s)), th = Math.max(1, Math.round(h * s));
    const mips = Math.floor(Math.log2(Math.max(tw, th))) + 1;
    const format = srgb ? 'rgba8unorm-srgb' : 'rgba8unorm';
    const t = this.tex([tw, th], format, TU.TEXTURE_BINDING | TU.COPY_DST | TU.RENDER_ATTACHMENT, mips);
    const src = s < 1 ? this._resize(img, tw, th) : img;
    d.queue.copyExternalImageToTexture({ source: src }, { texture: t }, [tw, th]);
    const enc = d.createCommandEncoder();
    for (let m = 1; m < mips; m++) {
      const bg = d.createBindGroup({ layout: this.blitLayout, entries: [{ binding: 0, resource: t.createView({ baseMipLevel: m - 1, mipLevelCount: 1 }) }, { binding: 1, resource: this.linSmp }] });
      const p = enc.beginRenderPass({ colorAttachments: [{ view: t.createView({ baseMipLevel: m, mipLevelCount: 1 }), loadOp: 'clear', storeOp: 'store', clearValue: [0, 0, 0, 0] }] });
      p.setPipeline(this.blitPipes[format]); p.setBindGroup(0, bg); p.draw(3); p.end();
    }
    d.queue.submit([enc.finish()]);
    return t;
  }
  _resize(img, w, h) {
    const c = new OffscreenCanvas(w, h); const g = c.getContext('2d');
    g.drawImage(img, 0, 0, w, h); return c;
  }

  material(m = {}) {
    const d = this.device;
    const ub = this.buf(64, GU.UNIFORM | GU.COPY_DST);
    const data = new Float32Array([...(m.color || [1, 1, 1, 1]), ...(m.emissive || [0, 0, 0]), m.emissiveStrength ?? 1,
      m.metal ?? 0, m.rough ?? 0.7, m.normalScale ?? 1, m.alphaCutoff ?? (m.alphaMode === 'MASK' ? 0.5 : -1),
      m.normalTex ? 1 : 0, m.glossMap && m.mrTex ? 2 : 0, m.gear ? 1 : 0, m.coat ?? 0]);
    d.queue.writeBuffer(ub, 0, data);
    const view = (img, srgb, def) => (img ? (img.createView ? img : this.uploadImage(img, srgb, m.maxTex || 1024)) : def).createView();
    const bg = d.createBindGroup({ layout: this.matLayout, entries: [
      { binding: 0, resource: { buffer: ub } },
      { binding: 1, resource: view(m.baseTex, true, this.defaults.white) },
      { binding: 2, resource: view(m.normalTex, false, this.defaults.flat) },
      { binding: 3, resource: view(m.mrTex, false, this.defaults.mr) },
      { binding: 4, resource: view(m.emTex, true, this.defaults.black) },
      { binding: 5, resource: this.texSmp }] });
    return { bg, ub, data };
  }

  mesh(p) {
    const V = GU.VERTEX | GU.COPY_DST;
    const g = { pos: this.buf(p.pos.byteLength, V, p.pos), nrm: this.buf(p.nrm.byteLength, V, p.nrm), uv: this.buf(p.uv.byteLength, V, p.uv),
      count: p.idx.length, skinned: !!p.joints };
    const idx = p.idx instanceof Uint32Array ? p.idx : new Uint32Array(p.idx);
    g.ib = this.buf(idx.byteLength, GU.INDEX | GU.COPY_DST, idx);
    if (p.joints) { g.jnt = this.buf(p.joints.byteLength, V, p.joints); g.wgt = this.buf(p.weights.byteLength, V, p.weights); }
    return g;
  }

  // model: parsed glTF. Static meshes get node transforms baked; skinned meshes keep bind-space vertices.
  uploadModel(model, opts = {}) {
    const { nodes, meshes, materials } = model;
    const mats = materials.map((m) => this.material({ ...m, ...(opts.matOverride || {}), ...((opts.matByName || {})[m.name] || {}), maxTex: opts.maxTex }));
    const defMat = this.material({ color: [0.6, 0.6, 0.6, 1], rough: 0.6 });
    const prims = [];
    const globals = restGlobals(model);
    nodes.forEach((nd, ni) => {
      if (nd.mesh === undefined) return;
      for (const p of meshes[nd.mesh]) {
        const mm = materials[p.material];
        if (mm && mm.alphaMode === 'BLEND' && (mm.color?.[3] ?? 1) < 0.3) continue;   // near-clear glass: skip (no transparency pass)
        let q = p;
        const stat = opts.forceStatic || !p.joints || nd.skin === undefined;   // forceStatic: bake the rest pose (for instancing)
        if (stat) q = bake(p, opts.pre ? m4.mul(opts.pre, globals[ni]) : globals[ni]);
        prims.push({ gm: this.mesh(q), mat: q.material >= 0 ? mats[q.material] : defMat, skin: stat ? -1 : nd.skin });
      }
    });
    return { model, prims, mats, globals };
  }

  object(storageBytes = 0) {
    const d = this.device;
    const ub = this.buf(128, GU.UNIFORM | GU.COPY_DST);
    const sb = storageBytes ? this.buf(storageBytes, GU.STORAGE | GU.COPY_DST) : this.dummyStorage;
    const bg = d.createBindGroup({ layout: this.objLayout, entries: [{ binding: 0, resource: { buffer: ub } }, { binding: 1, resource: { buffer: sb } }] });
    const data = new Float32Array(32);
    data.set([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1]); data.set([1, 1, 1, 1], 20);
    return { ub, sb, bg, data };
  }
  writeObj(o) { this.device.queue.writeBuffer(o.ub, 0, o.data); }

  grid(n, size, warp = 1) {
    const v = new Float32Array((n + 1) * (n + 1) * 2); let k = 0;
    for (let j = 0; j <= n; j++) for (let i = 0; i <= n; i++) {
      let x = i / n * 2 - 1, z = j / n * 2 - 1;
      if (warp !== 1) { x = Math.sign(x) * Math.pow(Math.abs(x), warp); z = Math.sign(z) * Math.pow(Math.abs(z), warp); }
      v[k++] = x * size; v[k++] = z * size;
    }
    const idx = new Uint32Array(n * n * 6); k = 0;
    for (let j = 0; j < n; j++) for (let i = 0; i < n; i++) {
      const a = j * (n + 1) + i, b = a + 1, c = a + n + 1, dd = c + 1;
      idx.set([a, c, b, b, c, dd], k); k += 6;
    }
    return { vb: this.buf(v.byteLength, GU.VERTEX | GU.COPY_DST, v), ib: this.buf(idx.byteLength, GU.INDEX | GU.COPY_DST, idx), count: idx.length };
  }

  // ---------- frame ----------
  // S: { frame: Float32Array(FRAME_FLOATS), shadowFrame, spotOn, draws:[{gm,mat,obj,kind,instances,shadow}], floor, surface, fx:[...], jelly, finalU }
  // tiling sand detail maps for the floor shader (rebuilds the frame bind group)
  setSandTextures(nImg, aImg) {
    this.sandN = this.uploadImage(nImg, false, 1024); this.sandA = this.uploadImage(aImg, false, 1024);
    const w = this.W, h = this.H; this.W = -1; this.resize(w, h);
  }
  solidTexHalf() { const t = this.device.createTexture({ size: [1, 1], format: 'rgba16float', usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST }); this.device.queue.writeTexture({ texture: t }, new Uint16Array(4), { bytesPerRow: 8 }, [1, 1]); return t; }
  _skyBG() { return (this.envFrameBG = this.device.createBindGroup({ layout: this.envLayout, entries: [{ binding: 0, resource: { buffer: this.frameBuf } }, { binding: 13, resource: this.ocean.sampler }, { binding: 25, resource: this.skyTex.createView() }] })); }
  // photographic cloudy sky (Poly Haven CC0): calibrated to the analytic sky level, rotated so its sun sits on SUN_AIR
  async loadSky(url, sunAir) {
    const img = await loadHDR(url);
    removeGround(img);
    const sun = hdrSun(img);
    this.skyTex = uploadHDR(this, img, 40);
    let sum = 0, n = 0; const { W, H, f } = img;
    for (let y = 0; y < H / 2; y += 4) for (let x = 0; x < W; x += 4) { const i = (y * W + x) * 4, l = f[i] * 0.2126 + f[i + 1] * 0.7152 + f[i + 2] * 0.0722; if (l < 20) { sum += l; n++; } }
    this.skyScale = 0.4 / (sum / n);                              // analytic sky mean luminance ≈ 0.4 (upper hemisphere)
    const phiS = Math.atan2(sunAir[0], -sunAir[2]);
    this.skyUOff = sun.u - (phiS / (Math.PI * 2) + 0.5);
    this.envFrameBG = null;
    const w = this.W, h = this.H; this.W = -1; this.resize(w, h);  // rebuild bind groups with the new texture
  }
  _envInit() {
    const d = this.device;
    const ubl = d.createBindGroupLayout({ entries: [{ binding: 0, visibility: GPUShaderStage.FRAGMENT, buffer: {} }] });
    const m = this._module(SH.ENV_BAKE, 'env-bake');
    this.envPipe = d.createRenderPipeline({ layout: this.PL(this.envLayout, ubl), vertex: { module: m, entryPoint: 'vs' },
      fragment: { module: m, entryPoint: 'fs', targets: [{ format: 'rgba16float' }] }, primitive: { topology: 'triangle-list' } });
    this.envFrameBG = null;   // built in _skyBG() (needs the sky texture)
    this.envJobs = [];
    for (let lvl = 0; lvl < this.envMips; lvl++) for (let f = 0; f < 6; f++) {
      const ub = this.buf(16, GU.UNIFORM | GU.COPY_DST);
      d.queue.writeBuffer(ub, 0, new Float32Array([f, lvl, 0, this.envSize >> lvl]));
      this.envJobs.push({ f, lvl, ub, bg: d.createBindGroup({ layout: ubl, entries: [{ binding: 0, resource: { buffer: ub } }] }),
        view: this.envCube.createView({ dimension: '2d', baseArrayLayer: f, arrayLayerCount: 1, baseMipLevel: lvl, mipLevelCount: 1 }) });
    }
  }
  // bake all faces/mips for the given medium (0 air, 1 water) using the current frame uniforms
  _envBake(enc, mode) {
    for (const j of this.envJobs) {
      this.device.queue.writeBuffer(j.ub, 8, new Float32Array([mode]));
      const p = enc.beginRenderPass({ colorAttachments: [{ view: j.view, loadOp: 'clear', storeOp: 'store', clearValue: [0, 0, 0, 1] }] });
      p.setPipeline(this.envPipe); p.setBindGroup(0, this.envFrameBG || this._skyBG()); p.setBindGroup(1, j.bg); p.draw(3); p.end();
    }
  }

  render(S) {
    const d = this.device, q = d.queue;
    q.writeBuffer(this.frameBuf, 0, S.frame);
    q.writeBuffer(this.shadowFrameBuf, 0, S.shadowFrame);
    q.writeBuffer(this.finalBuf, 0, S.finalU);
    q.writeBuffer(this.bloomBufs[0], 0, new Float32Array([1 / this.W, 1 / this.H, 1, S.bloomThreshold ?? 1]));
    for (const dr of S.draws) if (dr.obj.dirty !== false) this.writeObj(dr.obj);
    const enc = d.createCommandEncoder();
    this.ocean.update(enc, S.time, S.probes || []);
    if (S.envBake != null) this._envBake(enc, S.envBake);
    if (S.foam) this.foam.update(enc, S.time, S.foam.dt, S.foam.boatM, S.foam.centre, S.foam.emit);
    if (S.gpuSpray) S.gpuSpray.update(enc, 1 / 24, S.origin);   // lobtail drops: GPU step writes the instances drawn below
    const drawMesh = (p, dr, shadow) => {
      const g = dr.gm;
      p.setPipeline((shadow ? this.shadowPipes : this.meshPipes)[dr.kind]);
      p.setBindGroup(1, dr.obj.bg);
      if (!shadow) p.setBindGroup(2, dr.mat.bg);
      p.setVertexBuffer(0, g.pos); p.setVertexBuffer(1, g.nrm); p.setVertexBuffer(2, g.uv);
      if (dr.kind === 'skin') { p.setVertexBuffer(3, g.jnt); p.setVertexBuffer(4, g.wgt); }
      p.setIndexBuffer(g.ib, 'uint32');
      p.drawIndexed(g.count, dr.instances || 1);
    };
    // 1. flashlight shadow map
    if (S.spotOn) {
      const p = enc.beginRenderPass({ colorAttachments: [], depthStencilAttachment: { view: this.shadowTex.createView(), depthClearValue: 1, depthLoadOp: 'clear', depthStoreOp: 'store' } });
      p.setBindGroup(0, this.shadowFrameBG);
      for (const dr of S.draws) if (dr.shadow && (dr.instances ?? 1) > 0) drawMesh(p, dr, true);
      p.end();
    }
    // 2. forward HDR
    {
      const p = enc.beginRenderPass({
        colorAttachments: [{ view: this.hdr.createView(), loadOp: 'clear', storeOp: 'store', clearValue: [0, 0, 0, 1] }],
        depthStencilAttachment: { view: this.depth.createView(), depthClearValue: 1, depthLoadOp: 'clear', depthStoreOp: 'store' },
      });
      p.setBindGroup(0, this.frameBG);
      for (const dr of S.draws) if ((dr.instances ?? 1) > 0) drawMesh(p, dr, false);
      const grid = (pp, g, pipe) => { pp.setPipeline(pipe); pp.setBindGroup(1, g.obj.bg); pp.setVertexBuffer(0, g.grid.vb); pp.setIndexBuffer(g.grid.ib, 'uint32'); pp.drawIndexed(g.grid.count); };
      if (S.floor?.visible) grid(p, S.floor, this.floorPipe);
      p.end();
      if (S.surface?.visible) {
        // everything under (and behind) the surface is done: snapshot colour + depth so the sea can refract/transmit it
        enc.copyTextureToTexture({ texture: this.hdr }, { texture: this.refr }, [this.W, this.H]);
        enc.copyTextureToTexture({ texture: this.depth }, { texture: this.refrDepth }, [this.W, this.H]);
        const p2 = enc.beginRenderPass({
          colorAttachments: [{ view: this.hdr.createView(), loadOp: 'load', storeOp: 'store' }],
          depthStencilAttachment: { view: this.depth.createView(), depthLoadOp: 'load', depthStoreOp: 'store' },
        });
        p2.setBindGroup(0, this.frameBG);
        grid(p2, S.surface, this.surfacePipe);
        p2.end();
      }
    }
    // 3. volumetric in-scatter (half res)
    {
      this.volIdx ^= 1;
      const p = enc.beginRenderPass({ colorAttachments: [{ view: this.vols[this.volIdx].createView(), loadOp: 'clear', storeOp: 'store', clearValue: [0, 0, 0, 0] }] });
      p.setPipeline(this.volPipe); p.setBindGroup(0, this.volBGs[this.volIdx]); p.draw(3); p.end();
    }
    // 4. composite + 5. additive FX
    {
      const p = enc.beginRenderPass({ colorAttachments: [{ view: this.comp.createView(), loadOp: 'clear', storeOp: 'store', clearValue: [0, 0, 0, 1] }] });
      p.setPipeline(this.compPipe); p.setBindGroup(0, this.compBGs[this.volIdx]); p.draw(3); p.end();
      const f = enc.beginRenderPass({
        colorAttachments: [{ view: this.comp.createView(), loadOp: 'load', storeOp: 'store' }],
        depthStencilAttachment: { view: this.depth.createView(), depthReadOnly: true },
      });
      f.setBindGroup(0, this.frameBG);
      if (S.jelly && S.jelly.count > 0) {
        f.setPipeline(this.jellyPipe); f.setBindGroup(1, S.jelly.bg);
        f.setVertexBuffer(0, S.jelly.vb); f.setIndexBuffer(S.jelly.ib, 'uint32'); f.drawIndexed(S.jelly.indexCount, S.jelly.count);
      }
      f.setPipeline(this.partPipe);
      for (const ps of S.fx) if (ps.count > 0) { f.setBindGroup(1, ps.obj.bg); f.draw(4, ps.count); }
      if (S.bubbles && S.bubbles.count > 0) { f.setPipeline(this.bubblePipe); f.setBindGroup(1, S.bubbles.obj.bg); f.draw(4, S.bubbles.count); }
      f.end();
    }
    // 6. bloom
    for (let i = 0; i < this.bloomMips; i++) {
      const p = enc.beginRenderPass({ colorAttachments: [{ view: this.bloomViews[i], loadOp: 'clear', storeOp: 'store', clearValue: [0, 0, 0, 1] }] });
      p.setPipeline(this.bloomDown); p.setBindGroup(0, this.bloomDownBG[i]); p.draw(3); p.end();
    }
    for (let k = 0; k < this.bloomMips - 1; k++) {
      const target = this.bloomMips - 2 - k;
      const p = enc.beginRenderPass({ colorAttachments: [{ view: this.bloomViews[target], loadOp: 'load', storeOp: 'store' }] });
      p.setPipeline(this.bloomUp); p.setBindGroup(0, this.bloomUpBG[k]); p.draw(3); p.end();
    }
    // 7. final
    const screen = this.ctx.getCurrentTexture().createView();
    if (this.aa) {   // tone-map into an 8-bit buffer, then FXAA to the screen
      const p = enc.beginRenderPass({ colorAttachments: [{ view: this.ldr.createView(), loadOp: 'clear', storeOp: 'store', clearValue: [0, 0, 0, 1] }] });
      p.setPipeline(this.finalLdrPipe); p.setBindGroup(0, this.finalBG); p.draw(3); p.end();
      const q2 = enc.beginRenderPass({ colorAttachments: [{ view: screen, loadOp: 'clear', storeOp: 'store', clearValue: [0, 0, 0, 1] }] });
      q2.setPipeline(this.fxaaPipe); q2.setBindGroup(0, this.fxaaBG); q2.draw(3); q2.end();
    } else {
      const p = enc.beginRenderPass({ colorAttachments: [{ view: screen, loadOp: 'clear', storeOp: 'store', clearValue: [0, 0, 0, 1] }] });
      p.setPipeline(this.finalPipe); p.setBindGroup(0, this.finalBG); p.draw(3); p.end();
    }
    q.submit([enc.finish()]);
    this.ocean.afterSubmit();
  }
}

function restGlobals(model) {
  const { nodes } = model, g = [];
  const trs = (n) => {
    const [x, y, z, w] = n.r, s = n.s, t = n.t;
    const m = new Float32Array(16);
    const x2 = x + x, y2 = y + y, z2 = z + z;
    m[0] = (1 - (y * y2 + z * z2)) * s[0]; m[1] = (x * y2 + w * z2) * s[0]; m[2] = (x * z2 - w * y2) * s[0];
    m[4] = (x * y2 - w * z2) * s[1]; m[5] = (1 - (x * x2 + z * z2)) * s[1]; m[6] = (y * z2 + w * x2) * s[1];
    m[8] = (x * z2 + w * y2) * s[2]; m[9] = (y * z2 - w * x2) * s[2]; m[10] = (1 - (x * x2 + y * y2)) * s[2];
    m[12] = t[0]; m[13] = t[1]; m[14] = t[2]; m[15] = 1; return m;
  };
  const mul = (a, b) => { const o = new Float32Array(16); for (let c = 0; c < 4; c++) for (let r = 0; r < 4; r++) o[c * 4 + r] = a[r] * b[c * 4] + a[4 + r] * b[c * 4 + 1] + a[8 + r] * b[c * 4 + 2] + a[12 + r] * b[c * 4 + 3]; return o; };
  const visit = (i, parent) => { g[i] = parent ? mul(parent, trs(nodes[i])) : trs(nodes[i]); nodes[i].children.forEach((c) => visit(c, g[i])); };
  nodes.filter((n) => n.parent < 0).forEach((n) => visit(n.i, null));
  return g;
}
function bake(p, m) {
  const n = p.pos.length / 3, pos = new Float32Array(p.pos.length), nrm = new Float32Array(p.nrm.length);
  for (let i = 0; i < n; i++) {
    const x = p.pos[i * 3], y = p.pos[i * 3 + 1], z = p.pos[i * 3 + 2];
    pos[i * 3] = m[0] * x + m[4] * y + m[8] * z + m[12]; pos[i * 3 + 1] = m[1] * x + m[5] * y + m[9] * z + m[13]; pos[i * 3 + 2] = m[2] * x + m[6] * y + m[10] * z + m[14];
    const a = p.nrm[i * 3], b = p.nrm[i * 3 + 1], c = p.nrm[i * 3 + 2];
    const nx = m[0] * a + m[4] * b + m[8] * c, ny = m[1] * a + m[5] * b + m[9] * c, nz = m[2] * a + m[6] * b + m[10] * c, l = Math.hypot(nx, ny, nz) || 1;
    nrm[i * 3] = nx / l; nrm[i * 3 + 1] = ny / l; nrm[i * 3 + 2] = nz / l;
  }
  return { ...p, pos, nrm, joints: null, weights: null };
}
