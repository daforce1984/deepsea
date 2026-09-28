// GLB loader: meshes, materials, textures, node hierarchy, skins and TRS animations (CPU-sampled).
import { m4, quat, ORIGIN } from './math.js';

const COMP = { 5120: Int8Array, 5121: Uint8Array, 5122: Int16Array, 5123: Uint16Array, 5125: Uint32Array, 5126: Float32Array };
const NCOMP = { SCALAR: 1, VEC2: 2, VEC3: 3, VEC4: 4, MAT4: 16 };
const NORM_DIV = { 5120: 127, 5121: 255, 5122: 32767, 5123: 65535 };

export async function loadGLB(url) {
  const ab = await (await fetch(url)).arrayBuffer();
  const dv = new DataView(ab);
  if (dv.getUint32(0, true) !== 0x46546c67) throw Error('not glb: ' + url);
  let off = 12, json = null, bin = null;
  while (off < ab.byteLength) {
    const len = dv.getUint32(off, true), type = dv.getUint32(off + 4, true);
    if (type === 0x4e4f534a) json = JSON.parse(new TextDecoder().decode(new Uint8Array(ab, off + 8, len)));
    else if (type === 0x004e4942) bin = new Uint8Array(ab, off + 8, len);
    off += 8 + len;
  }
  return parseGLTF(json, bin, url);
}

function reader(json, bin) {
  return function read(idx, asFloat = true) {
    const acc = json.accessors[idx], nc = NCOMP[acc.type], T = COMP[acc.componentType];
    const out = asFloat ? new Float32Array(acc.count * nc) : new Uint32Array(acc.count * nc);
    if (acc.bufferView === undefined) return out;
    const bv = json.bufferViews[acc.bufferView];
    const base = (bv.byteOffset || 0) + (acc.byteOffset || 0), esz = T.BYTES_PER_ELEMENT;
    const stride = bv.byteStride || nc * esz;
    const dv = new DataView(bin.buffer, bin.byteOffset);
    const get = { 5120: 'getInt8', 5121: 'getUint8', 5122: 'getInt16', 5123: 'getUint16', 5125: 'getUint32', 5126: 'getFloat32' }[acc.componentType];
    const div = acc.normalized && asFloat ? NORM_DIV[acc.componentType] : 1;
    for (let i = 0; i < acc.count; i++) for (let c = 0; c < nc; c++) {
      const v = dv[get](base + i * stride + c * esz, true);
      out[i * nc + c] = div !== 1 ? Math.max(v / div, -1) : v;
    }
    return out;
  };
}

async function parseGLTF(json, bin, url) {
  const read = reader(json, bin);
  // images -> ImageBitmap
  const images = await Promise.all((json.images || []).map(async (im) => {
    const bv = json.bufferViews[im.bufferView];
    const blob = new Blob([bin.subarray(bv.byteOffset || 0, (bv.byteOffset || 0) + bv.byteLength)], { type: im.mimeType });
    return createImageBitmap(blob, { colorSpaceConversion: 'none' });
  }));
  const texImg = (t) => (t === undefined ? null : images[json.textures[t.index].source] ?? null);
  const materials = (json.materials || []).map((m) => {
    const pbr = m.pbrMetallicRoughness || {};
    return {
      name: m.name || '',
      color: pbr.baseColorFactor || [1, 1, 1, 1],
      metal: pbr.metallicFactor ?? 1, rough: pbr.roughnessFactor ?? 1,
      emissive: m.emissiveFactor || [0, 0, 0],
      baseTex: texImg(pbr.baseColorTexture), normalTex: texImg(m.normalTexture), mrTex: texImg(pbr.metallicRoughnessTexture),
      emTex: texImg(m.emissiveTexture), alphaMode: m.alphaMode || 'OPAQUE', doubleSided: !!m.doubleSided,
      normalScale: m.normalTexture?.scale ?? 1,
      specTexSame: m.extensions?.KHR_materials_specular?.specularColorTexture?.index !== undefined && m.extensions.KHR_materials_specular.specularColorTexture.index === pbr.metallicRoughnessTexture?.index,
    };
  });
  const meshes = (json.meshes || []).map((me) => me.primitives.filter(p => (p.mode ?? 4) === 4).map((p) => {
    const a = p.attributes, pos = read(a.POSITION);
    const n = pos.length / 3;
    let idx = p.indices !== undefined ? read(p.indices, false) : Uint32Array.from({ length: n }, (_, i) => i);
    const nrm = a.NORMAL !== undefined ? read(a.NORMAL) : computeNormals(pos, idx);
    const uv = a.TEXCOORD_0 !== undefined ? read(a.TEXCOORD_0) : new Float32Array(n * 2);
    const joints = a.JOINTS_0 !== undefined ? read(a.JOINTS_0, false) : null;
    const weights = a.WEIGHTS_0 !== undefined ? read(a.WEIGHTS_0) : null;
    if (weights) for (let i = 0; i < n; i++) { // renormalise
      const s = weights[i * 4] + weights[i * 4 + 1] + weights[i * 4 + 2] + weights[i * 4 + 3] || 1;
      for (let c = 0; c < 4; c++) weights[i * 4 + c] /= s;
    }
    const acc = json.accessors[a.POSITION];
    return { pos, nrm, uv, joints, weights, idx, material: p.material ?? -1, min: acc.min, max: acc.max };
  }));
  const nodes = (json.nodes || []).map((nd, i) => {
    let t = nd.translation || [0, 0, 0], r = nd.rotation || [0, 0, 0, 1], s = nd.scale || [1, 1, 1];
    if (nd.matrix) { const d = decompose(nd.matrix); t = d.t; r = d.r; s = d.s; }
    return { i, name: nd.name || 'node' + i, t: [...t], r: [...r], s: [...s], children: nd.children || [], mesh: nd.mesh, skin: nd.skin, parent: -1 };
  });
  nodes.forEach((nd) => nd.children.forEach((c) => (nodes[c].parent = nd.i)));
  const skins = (json.skins || []).map((sk) => ({
    joints: sk.joints, ibm: sk.inverseBindMatrices !== undefined ? read(sk.inverseBindMatrices) : null,
  }));
  const anims = (json.animations || []).map((an) => {
    let dur = 0;
    const channels = an.channels.filter(c => c.target.node !== undefined && c.target.path !== 'weights').map((c) => {
      const s = an.samplers[c.sampler], times = read(s.input), vals = read(s.output);
      dur = Math.max(dur, times[times.length - 1]);
      return { node: c.target.node, path: c.target.path, times, vals, interp: s.interpolation || 'LINEAR' };
    });
    return { name: an.name || '', channels, dur };
  });
  const scene = json.scenes ? json.scenes[json.scene || 0].nodes : nodes.filter(n => n.parent < 0).map(n => n.i);
  return { url, nodes, meshes, materials, skins, anims, scene, images };
}

function computeNormals(pos, idx) {
  const n = new Float32Array(pos.length);
  for (let i = 0; i < idx.length; i += 3) {
    const a = idx[i] * 3, b = idx[i + 1] * 3, c = idx[i + 2] * 3;
    const e1 = [pos[b] - pos[a], pos[b + 1] - pos[a + 1], pos[b + 2] - pos[a + 2]], e2 = [pos[c] - pos[a], pos[c + 1] - pos[a + 1], pos[c + 2] - pos[a + 2]];
    const f = [e1[1] * e2[2] - e1[2] * e2[1], e1[2] * e2[0] - e1[0] * e2[2], e1[0] * e2[1] - e1[1] * e2[0]];
    for (const v of [a, b, c]) { n[v] += f[0]; n[v + 1] += f[1]; n[v + 2] += f[2]; }
  }
  for (let i = 0; i < n.length; i += 3) { const l = Math.hypot(n[i], n[i + 1], n[i + 2]) || 1; n[i] /= l; n[i + 1] /= l; n[i + 2] /= l; }
  return n;
}

export function decompose(m) {
  const sx = Math.hypot(m[0], m[1], m[2]), sy = Math.hypot(m[4], m[5], m[6]), sz = Math.hypot(m[8], m[9], m[10]);
  const r00 = m[0] / sx, r11 = m[5] / sy, r22 = m[10] / sz, tr = r00 + r11 + r22;
  let q;
  if (tr > 0) { const S = Math.sqrt(tr + 1) * 2; q = [(m[6] / sy - m[9] / sz) / S, (m[8] / sz - m[2] / sx) / S, (m[1] / sx - m[4] / sy) / S, 0.25 * S]; }
  else if (r00 > r11 && r00 > r22) { const S = Math.sqrt(1 + r00 - r11 - r22) * 2; q = [0.25 * S, (m[4] / sy + m[1] / sx) / S, (m[8] / sz + m[2] / sx) / S, (m[6] / sy - m[9] / sz) / S]; }
  else if (r11 > r22) { const S = Math.sqrt(1 + r11 - r00 - r22) * 2; q = [(m[4] / sy + m[1] / sx) / S, 0.25 * S, (m[9] / sz + m[6] / sy) / S, (m[8] / sz - m[2] / sx) / S]; }
  else { const S = Math.sqrt(1 + r22 - r00 - r11) * 2; q = [(m[8] / sz + m[2] / sx) / S, (m[9] / sz + m[6] / sy) / S, 0.25 * S, (m[1] / sx - m[4] / sy) / S]; }
  return { t: [m[12], m[13], m[14]], r: q, s: [sx, sy, sz] };
}

// Per-instance pose state: local TRS (copy), animation sampling, global & joint matrices.
export class Pose {
  constructor(model) {
    this.model = model;
    this.local = model.nodes.map(n => ({ t: [...n.t], r: [...n.r], s: [...n.s] }));
    this.global = model.nodes.map(() => new Float64Array(16));
    this.order = [];
    const visit = (i) => { this.order.push(i); model.nodes[i].children.forEach(visit); };
    model.nodes.filter(n => n.parent < 0).forEach(n => visit(n.i));
    this.jointMats = model.skins.map(sk => new Float32Array(sk.joints.length * 16));
  }
  reset() { this.model.nodes.forEach((n, i) => { const l = this.local[i]; l.t = [...n.t]; l.r = [...n.r]; l.s = [...n.s]; }); }
  // weight<1 blends from current local pose toward the sampled animation
  sample(animIndex, time, weight = 1) {
    const an = this.model.anims[animIndex];
    if (!an) return;
    const t = an.dur > 0 ? ((time % an.dur) + an.dur) % an.dur : 0;
    for (const c of an.channels) {
      const ts = c.times, n = ts.length;
      let k = 0;
      if (t >= ts[n - 1]) k = n - 1; else { let lo = 0, hi = n - 1; while (hi - lo > 1) { const mid = (lo + hi) >> 1; if (ts[mid] <= t) lo = mid; else hi = mid; } k = lo; }
      const k2 = Math.min(k + 1, n - 1), f = k2 === k || c.interp === 'STEP' ? 0 : (t - ts[k]) / (ts[k2] - ts[k]);
      const nc = c.path === 'rotation' ? 4 : 3, cs = c.interp === 'CUBICSPLINE' ? 3 : 1, o = cs === 3 ? nc : 0;
      const va = Array.from({ length: nc }, (_, j) => c.vals[(k * cs) * nc + o + j]);
      const vb = Array.from({ length: nc }, (_, j) => c.vals[(k2 * cs) * nc + o + j]);
      const L = this.local[c.node];
      if (c.path === 'rotation') {
        const q = quat.slerp(va, vb, f);
        L.r = weight >= 1 ? q : quat.slerp(L.r, q, weight);
      } else {
        const v = va.map((a, j) => a + (vb[j] - a) * f);
        const cur = c.path === 'translation' ? L.t : L.s;
        const nv = cur.map((a, j) => a + (v[j] - a) * weight);
        if (c.path === 'translation') L.t = nv; else L.s = nv;
      }
    }
  }
  update(root) {
    const { nodes } = this.model;
    for (const i of this.order) {
      const L = this.local[i], lm = m4.trs(L.t, L.r, L.s), p = nodes[i].parent;
      m4.mul(p < 0 ? root : this.global[p], lm, this.global[i]);
    }
    this.model.skins.forEach((sk, si) => {
      const out = this.jointMats[si], tmp = new Float64Array(16);
      sk.joints.forEach((j, k) => {
        const ibm = sk.ibm ? sk.ibm.subarray(k * 16, k * 16 + 16) : m4.ident();
        m4.mul(this.global[j], ibm, tmp); tmp[12] -= ORIGIN[0]; tmp[13] -= ORIGIN[1]; tmp[14] -= ORIGIN[2]; out.set(tmp, k * 16);
      });
    });
  }
  find(name) { return this.model.nodes.findIndex(n => n.name === name); }
}
