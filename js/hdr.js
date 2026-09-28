// Radiance .hdr (RGBE, new-style RLE) loader -> rgba16float mip chain for an equirectangular sky
function f2h(v) {   // float32 -> float16 bits
  const f = new Float32Array(1), i = new Uint32Array(f.buffer); f[0] = v; const x = i[0];
  const s = (x >>> 16) & 0x8000; let e = ((x >>> 23) & 0xff) - 127 + 15, m = x & 0x7fffff;
  if (e >= 31) return s | 0x7bff;
  if (e <= 0) { if (e < -10) return s; m = (m | 0x800000) >> (1 - e); return s | (m >> 13); }
  return s | (e << 10) | (m >> 13);
}
export async function loadHDR(url) {
  const b = new Uint8Array(await (await fetch(url)).arrayBuffer());
  let p = 0; const line = () => { let s = ''; while (b[p] !== 10) s += String.fromCharCode(b[p++]); p++; return s; };
  while (line() !== '') { /* header */ }
  const dims = line().split(' '), H = +dims[1], W = +dims[3];
  const rgbe = new Uint8Array(W * H * 4), scan = new Uint8Array(W * 4);
  for (let y = 0; y < H; y++) {
    p += 4;                                                   // 2,2,hi,lo
    for (let c = 0; c < 4; c++) {
      let x = 0;
      while (x < W) {
        let n = b[p++];
        if (n > 128) { n -= 128; const v = b[p++]; for (let k = 0; k < n; k++) scan[(x + k) * 4 + c] = v; }
        else { for (let k = 0; k < n; k++) scan[(x + k) * 4 + c] = b[p++]; }
        x += n;
      }
    }
    rgbe.set(scan, y * W * 4);
  }
  const f = new Float32Array(W * H * 4);
  for (let i = 0; i < W * H; i++) { const e = rgbe[i * 4 + 3]; const s = e ? Math.pow(2, e - 136) : 0; f[i * 4] = rgbe[i * 4] * s; f[i * 4 + 1] = rgbe[i * 4 + 1] * s; f[i * 4 + 2] = rgbe[i * 4 + 2] * s; f[i * 4 + 3] = 1; }
  return { W, H, f };
}
// strip landscape from the horizon band (trees / bushes / hills in a sky photo would stand on the open sea):
// per column find where real sky ends above the horizon (blue sky or bright, colourless cloud), fill everything
// below with that column's sky colour, then blur the filled band sideways into a smooth horizon haze
const clamp01 = (v) => Math.max(0, Math.min(1, v));
export function removeGround(img, maxDeg = 30) {
  const { W, H, f } = img, hz = Math.floor(H / 2), lim = Math.round(maxDeg / 180 * H);
  const lum = (i) => f[i * 4] * 0.2126 + f[i * 4 + 1] * 0.7152 + f[i * 4 + 2] * 0.0722;
  // reference sky brightness from a band at 20-35 deg elevation
  const ref = []; for (let y = hz - Math.round(35 / 180 * H); y < hz - Math.round(20 / 180 * H); y += 4) for (let x = 0; x < W; x += 8) ref.push(lum(y * W + x));
  ref.sort((a, b) => a - b); const Lref = ref[ref.length >> 1] || 1;
  const isSky = (i) => {
    const r = f[i * 4], g = f[i * 4 + 1], b = f[i * 4 + 2], mx = Math.max(r, g, b), mn = Math.min(r, g, b), L = lum(i);
    if (b > r * 1.12 && b >= g * 1.0 && L > Lref * 0.35) return true;              // blue sky
    return mx > 0 && (mx - mn) / mx < 0.16 && L > Lref * 0.75;                        // white cloud
  };
  const bnd = new Int32Array(W).fill(hz);
  for (let x = 0; x < W; x++) {
    let run = 0;
    for (let y = hz - lim; y < hz; y++) {                                              // from ~16 deg down toward the horizon
      if (!isSky(y * W + x)) { if (++run >= 2) { bnd[x] = y - run; break; } } else run = 0;
    }
  }
  const b2 = new Int32Array(W); for (let x = 0; x < W; x++) { let m = hz; for (let k = -4; k <= 4; k++) m = Math.min(m, bnd[(x + k + W) % W]); b2[x] = Math.max(hz - lim, m - 2); }
  if (b2.every((v) => v >= hz - 1)) return 0;
  { const sm = new Float32Array(W); for (let x = 0; x < W; x++) { let t = 0; for (let k = -16; k <= 16; k++) t += b2[(x + k + W) % W]; sm[x] = t / 33; }
    for (let x = 0; x < W; x++) b2[x] = Math.min(b2[x], Math.round(sm[x])); }                // smooth the cut line (no stair steps)
  // fill colour: the average clear-sky colour at each elevation (taken only from pixels above each column's
  // boundary), so the band is a smooth horizon gradient -- no per-column blocks or streaks
  const top = Math.min(...b2);
  const rowC = new Float32Array(H * 3), rowN = new Float32Array(H);
  for (let x = 0; x < W; x++) for (let y = top - 26; y < hz; y++) {
    if (y >= b2[x] - 3) continue;
    const i = (y * W + x) * 4;
    if (!(f[i + 2] > f[i] * 1.08)) continue;                                        // clear blue sky only (clouds would make the band pale)
    rowC[y * 3] += f[i]; rowC[y * 3 + 1] += f[i + 1]; rowC[y * 3 + 2] += f[i + 2]; rowN[y]++;
  }
  let last = null;
  for (let y = top - 26; y < H; y++) {
    if (y < hz && rowN[y] > W * 0.02) { for (let c = 0; c < 3; c++) rowC[y * 3 + c] /= rowN[y]; last = y; }
    else if (last !== null) for (let c = 0; c < 3; c++) rowC[y * 3 + c] = rowC[last * 3 + c];
  }
  // fill colour: one reference row just above the highest cut (clear-blue pixels only), blurred very wide sideways,
  // so it has no blocks; the last ~7 deg above the horizon blend into the global horizon haze
  const yr = Math.max(0, top - 30), refC = new Float32Array(W * 3), refN = new Float32Array(W);
  for (let x = 0; x < W; x++) for (let y = yr - 6; y <= yr; y++) {
    const i = (y * W + x) * 4; if (!(f[i + 2] > f[i] * 1.12 && f[i + 2] > f[i + 1] * 1.0)) continue;
    refC[x * 3] += f[i]; refC[x * 3 + 1] += f[i + 1]; refC[x * 3 + 2] += f[i + 2]; refN[x]++;
  }
  const RR = 220, fillR = new Float32Array(W * 3);
  for (let x = 0; x < W; x++) { const acc = [0, 0, 0]; let n = 0;
    for (let k = -RR; k <= RR; k += 2) { const q = (x + k + W) % W; if (!refN[q]) continue; for (let c = 0; c < 3; c++) acc[c] += refC[q * 3 + c]; n += refN[q]; }
    for (let c = 0; c < 3; c++) fillR[x * 3 + c] = n ? acc[c] / n : rowC[yr * 3 + c]; }
  let filled = 0;
  for (let x = 0; x < W; x++) {
    if (b2[x] >= hz - 1) continue;
    for (let y = b2[x] - 18; y < H; y++) {
      const i = (y * W + x) * 4;
      const t = Math.pow(clamp01(1 - (hz - y) / (5 / 180 * H)), 1.5);
      const k = y >= b2[x] ? 1 : Math.pow((y - (b2[x] - 18)) / 18, 1.6);
      const yy = Math.min(y, hz - 1), e = clamp01((y - yr) / Math.max(1, hz - yr));   // 0 at the reference row .. 1 at the horizon
      const g = 1 + 0.55 * e * e * e;                                                            // clear sky brightens toward the horizon
      const L = (fillR[x * 3] * 0.2126 + fillR[x * 3 + 1] * 0.7152 + fillR[x * 3 + 2] * 0.0722);
      for (let c = 0; c < 3; c++) {
        const pale = fillR[x * 3 + c] + (L * [0.9, 1.0, 1.1][c] - fillR[x * 3 + c]) * 0.25 * e * e;   // ...and pales
        const fc = pale * g * (1 - t) + rowC[yy * 3 + c] * t; f[i + c] = f[i + c] * (1 - k) + fc * k; }
      filled++;
    }
  }
  return filled;
}
// sun pixel (brightest) -> azimuth/elevation in the equirect frame used by the shader
export function hdrSun(img) {
  let best = 0, bi = 0; const { W, H, f } = img;
  for (let i = 0; i < W * H; i++) { const l = f[i * 4] * 0.2126 + f[i * 4 + 1] * 0.7152 + f[i * 4 + 2] * 0.0722; if (l > best) { best = l; bi = i; } }
  return { u: (bi % W + 0.5) / W, v: (Math.floor(bi / W) + 0.5) / H };
}
// upload with CPU box-filtered mips; the sun core is clamped (the renderer draws its own analytic sun disk)
export function uploadHDR(R, img, clampL = 40) {
  let { W, H, f } = img; const d = R.device;
  f = f.slice(); for (let i = 0; i < W * H; i++) { const l = f[i * 4] * 0.2126 + f[i * 4 + 1] * 0.7152 + f[i * 4 + 2] * 0.0722; if (l > clampL) { const k = clampL / l; f[i * 4] *= k; f[i * 4 + 1] *= k; f[i * 4 + 2] *= k; } }
  const mips = Math.floor(Math.log2(Math.max(W, H))) + 1 - 4;
  const tex = R.tex([W, H], 'rgba16float', GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST, mips);
  let w = W, h = H, cur = f;
  for (let m = 0; m < mips; m++) {
    const half = new Uint16Array(w * h * 4); for (let i = 0; i < half.length; i++) half[i] = f2h(cur[i]);
    d.queue.writeTexture({ texture: tex, mipLevel: m }, half, { bytesPerRow: w * 8 }, [w, h]);
    if (m === mips - 1) break;
    const nw = Math.max(1, w >> 1), nh = Math.max(1, h >> 1), nx = new Float32Array(nw * nh * 4);
    for (let y = 0; y < nh; y++) for (let x = 0; x < nw; x++) for (let c = 0; c < 4; c++) {
      const a = (yy, xx) => cur[((Math.min(yy, h - 1)) * w + Math.min(xx, w - 1)) * 4 + c];
      nx[(y * nw + x) * 4 + c] = 0.25 * (a(2 * y, 2 * x) + a(2 * y, 2 * x + 1) + a(2 * y + 1, 2 * x) + a(2 * y + 1, 2 * x + 1));
    }
    cur = nx; w = nw; h = nh;
  }
  return tex;
}
