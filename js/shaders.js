// WGSL sources. Water optics: per-channel absorption a, scattering b, diffuse attenuation Kd.
export const MAX_LIGHTS = 12;

export const COMMON = /* wgsl */`
struct Frame {
  viewProj: mat4x4f,
  invViewProj: mat4x4f,
  spotVP: mat4x4f,
  prevViewProj: mat4x4f,
  camPos: vec4f,   // w = time
  sunDir: vec4f,   // xyz toward sun (refracted underwater), w = surface irradiance E0
  absorb: vec4f,   // absorption per channel (1/m), w = scattering b (1/m)
  kd: vec4f,       // diffuse attenuation Kd per channel (1/m), w = exposure
  spotPos: vec4f,  // w = flashlight intensity (0 = off)
  spotDir: vec4f,  // w = cos(outer)
  spotP: vec4f,    // x cos(inner), y range, z underwater flag, w floor y
  res: vec4f,      // internal w, h, 1/w, 1/h
  misc: vec4f,     // x light count, y frame index, z sediment, w camera depth
  origin: vec4f,   // absolute camera position; all other positions are relative to it
  lightPos: array<vec4f, ${MAX_LIGHTS}>,
  lightCol: array<vec4f, ${MAX_LIGHTS}>,
  wake: vec4f,     // trailing tip vortex of a giant: xyz vortex origin (flipper tip), w accumulated swirl phase (rad)
  wakeAx: vec4f,   // xyz vortex axis (swim direction), w radius (m)
  wakeP: vec4f,    // x turbulent jitter amplitude (m), y trailing length (m)
  trailP: array<vec4f, 8>,   // diver wake samples: xyz position (camera-relative), w age (s)
  trailV: array<vec4f, 8>,   // xyz swim velocity at that moment, w strength
  rip: array<vec4f, 16>,     // surface disturbances: xz (camera-relative), age (s), amplitude (m)
};
@group(0) @binding(0) var<uniform> F: Frame;

const PI = 3.14159265;
const SUN_COL = vec3f(1.0, 0.96, 0.9);
const SPOT_COL = vec3f(1.0, 0.94, 0.86);
// ---- atmosphere (midday, mid-Atlantic): Rayleigh + Mie single scattering, Kasten–Young air mass ----
const SUN_AIR = vec3f(0.3597, 0.7880, -0.4995);   // 52° elevation (refracted to F.sunDir under water)
const SUN_E = 10.5;                                 // direct sun irradiance at sea level (HDR units) — harsh mid-Atlantic noon
fn airmass(cz: f32) -> f32 { let c = clamp(cz, 0.0, 1.0); return 1.0 / (c + 0.15 * pow(93.885 - degrees(acos(c)), -1.253)); }
fn sunTrans() -> vec3f {
  let tau = vec3f(5.8e-6, 13.5e-6, 33.1e-6) * 8000.0 + vec3f(9e-6 * 1200.0 * 1.1);
  return exp(-tau * airmass(SUN_AIR.y));
}
// ---- FFT ocean (3 cascades): displacement (Dx, h, Dz, dDx/dz) ----
@group(0) @binding(10) var oDisp0: texture_2d<f32>;
@group(0) @binding(11) var oDisp1: texture_2d<f32>;
@group(0) @binding(12) var oDisp2: texture_2d<f32>;
@group(0) @binding(13) var oSmp: sampler;
const OL = vec3f(512.0, 97.0, 17.7);
fn oceanDisp(xz: vec2f) -> vec4f {
  return textureSampleLevel(oDisp0, oSmp, xz / OL.x, 0.0) + textureSampleLevel(oDisp1, oSmp, xz / OL.y, 0.0) + textureSampleLevel(oDisp2, oSmp, xz / OL.z, 0.0);
}
// surface height at absolute xz: invert the choppy horizontal displacement
fn waveHeight(xz: vec2f, t: f32) -> f32 {
  var x0 = xz;
  for (var it = 0; it < 3; it++) { let d = oceanDisp(x0); x0 = xz - d.xz; }
  return oceanDisp(x0).y;
}
// signed height of a (relative) point above the sea surface; only evaluates waves near the surface
// water parted by animals breaking the surface: a crater where the body cuts through + expanding capillary-gravity rings
fn ripH(p: vec2f) -> f32 {
  var h = 0.0;
  for (var k = 0; k < 16; k++) {
    let R = F.rip[k]; if (R.w <= 0.0) { continue; }
    let r = length(p - R.xy); let age = R.z;
    let front = 0.3 + 1.2 * age;
    if (r > front + 2.5) { continue; }
    let w2 = 0.12 + 0.25 * age;
    let ang = atan2(p.y - R.xy.y, p.x - R.xy.x);
    let irr = 0.55 + 0.45 * sin(ang * 3.0 + R.z * 0.7 + R.xy.x) * sin(ang * 5.0 - R.xy.y);   // broken, uneven rings
    let ring = cos(8.0 * (r - front) + sin(ang * 2.0 + R.xy.y) * 1.5) * exp(-(r - front) * (r - front) / w2) * irr;
    h += R.w * exp(-age * 1.8) * (ring * 0.6 - 0.9 * exp(-r * r / 0.18) * exp(-age * 4.0));
  }
  return h;
}
fn aboveSea(p: vec3f) -> f32 {
  let y = p.y + F.origin.y;
  if (abs(y) > 1.5) { return y; }
  return y - waveHeight(p.xz + F.origin.xz, F.camPos.w);
}
@group(0) @binding(25) var skyTex: texture_2d<f32>;
// photographic sky (equirect HDRI) when loaded: F.wakeP.z = radiance scale (0 = analytic only), F.wakeP.w = u offset
fn skyHDR(d: vec3f, lod: f32) -> vec3f {
  let u = fract(atan2(d.x, -d.z) / 6.2831853 + 0.5 + F.wakeP.w);
  let v = 0.5 - asin(clamp(d.y, -1.0, 1.0)) / 3.14159265;
  return textureSampleLevel(skyTex, oSmp, vec2f(u, clamp(v, 0.001, 0.499)), lod).rgb * F.wakeP.z;   // (landscape on the photo's horizon is removed at load: hdr.js removeGround)
}
fn skyCol(d0: vec3f) -> vec3f { return skyColL(d0, 0.0); }
fn skyColL(d0: vec3f, lod: f32) -> vec3f {
  let d = normalize(vec3f(d0.x, max(d0.y, 0.0), d0.z));
  let mu = dot(d, SUN_AIR);
  let tR = vec3f(5.8e-6, 13.5e-6, 33.1e-6) * 8000.0; let tM = vec3f(9e-6 * 1200.0);
  let viewT = exp(-(tR + tM * 1.1) * airmass(d.y));
  let phR = 0.0597 * (1.0 + mu * mu);
  let g = 0.76; let phM = 0.0796 * (1.0 - g * g) / pow(1.0 + g * g - 2.0 * g * mu, 1.5);
  let scat = (tR * phR + tM * phM) / (tR + tM * 1.1);
  var L = SUN_E / 0.9 * sunTrans() * scat * (1.0 - viewT) * 3.0;          // x3: multiple scattering + sea albedo
  // clear maritime air: keep the deep blue (multiple scattering otherwise greys it out)
  let ll = dot(L, vec3f(0.2126, 0.7152, 0.0722));
  L = max(mix(vec3f(ll), L, 1.45 - 0.35 * pow(1.0 - d.y, 6.0)), vec3f(0.0));
  if (F.wakeP.z > 0.0) { L = skyHDR(d, lod); }                 // clouds + sky from the photograph, analytic sun disk on top
  // solar disk (0.53°) with limb darkening
  let cd = 0.99998;
  if (mu > cd) { let r = (1.0 - mu) / (1.0 - cd); L += SUN_E / 6.8e-5 * viewT * (1.0 - 0.6 * r); }
  return L;
}

// keep HDR finite in 16-bit float targets: clamp huge specular peaks, scrub NaN/inf
fn safeHDR(c: vec3f) -> vec3f {
  let bad = c != c;
  return select(clamp(c, vec3f(0.0), vec3f(3000.0)), vec3f(0.0), bad);
}
fn sigmaT() -> vec3f { return F.absorb.xyz + vec3f(F.absorb.w); }
fn downwell(y: f32) -> vec3f { return SUN_COL * F.sunDir.w * exp(-F.kd.xyz * max(-(y + F.origin.y), 0.0)); }  // y relative
fn hg(c: f32, g: f32) -> f32 { let g2 = g * g; return (1.0 - g2) / (4.0 * PI * pow(max(1.0 + g2 - 2.0 * g * c, 1e-4), 1.5)); }
fn ambPhase(c: f32) -> f32 { return mix(1.0 / (4.0 * PI), hg(c, 0.7), 0.55); }
// closed-form single scattering of the depth-attenuated downwelling light along a ray of length D
fn ambientInscatter(ro: vec3f, rd: vec3f, D: f32) -> vec3f {
  let k = sigmaT() - F.kd.xyz * rd.y;
  return F.absorb.w * ambPhase(rd.y) * downwell(ro.y) * (1.0 - exp(-k * D)) / k;
}
fn hash21(p: vec2f) -> f32 { var q = fract(p * vec2f(123.34, 456.21)); q += dot(q, q + 45.32); return fract(q.x * q.y); }
fn hash31(p: vec3f) -> f32 { var q = fract(p * 0.1031); q += dot(q, q.zyx + 31.32); return fract((q.x + q.y) * q.z); }
fn hash11(n: f32) -> f32 { return fract(sin(n * 12.9898) * 43758.5453); }
fn ihash(x: i32, y: i32) -> f32 {
  var h = u32(x) * 374761393u + u32(y) * 668265263u;
  h = (h ^ (h >> 13u)) * 1274126177u; h = h ^ (h >> 16u);
  return f32(h & 0xffffffu) / 16777216.0;
}
fn vnoise(p: vec2f) -> f32 {
  let i = vec2i(floor(p)); let f = fract(p); let u = f * f * (3.0 - 2.0 * f);
  return mix(mix(ihash(i.x, i.y), ihash(i.x + 1, i.y), u.x), mix(ihash(i.x, i.y + 1), ihash(i.x + 1, i.y + 1), u.x), u.y);
}
fn vnoise3(p: vec3f) -> f32 {
  let i = floor(p); let f = fract(p); let u = f * f * (3.0 - 2.0 * f);
  let a = mix(mix(hash31(i), hash31(i + vec3f(1, 0, 0)), u.x), mix(hash31(i + vec3f(0, 1, 0)), hash31(i + vec3f(1, 1, 0)), u.x), u.y);
  let b = mix(mix(hash31(i + vec3f(0, 0, 1)), hash31(i + vec3f(1, 0, 1)), u.x), mix(hash31(i + vec3f(0, 1, 1)), hash31(i + vec3f(1, 1, 1)), u.x), u.y);
  return mix(a, b, u.z);
}
fn ign(px: vec2f, fr: f32) -> f32 { let q = px + 5.588238 * (fr % 64.0); return fract(52.9829189 * fract(dot(q, vec2f(0.06711056, 0.00583715)))); }
// tileable water caustic (after Dave_Hoskins)
fn caustic(uv: vec2f, t: f32) -> f32 {
  let p = fract(uv) * 6.2831853 - vec2f(250.0);
  var i = p; var c = 1.0;
  for (var n = 0; n < 4; n++) {
    let tt = t * (1.0 - 3.5 / f32(n + 1));
    i = p + vec2f(cos(tt - i.x) + sin(tt + i.y), sin(tt - i.y) + cos(tt + i.x));
    c += 1.0 / length(vec2f(p.x / (sin(i.x + tt) / 0.005), p.y / (cos(i.y + tt) / 0.005)));
  }
  c = 1.17 - pow(c / 4.0, 1.4);
  return pow(abs(c), 8.0);
}
// caustic light factor on a surface at p (fades and blurs with depth)
fn causticAt(p: vec3f, n: vec3f) -> f32 {
  let depth = max(-(p.y + F.origin.y), 0.0);
  let fade = exp(-depth / 14.0) * smoothstep(-0.25, 0.6, n.y) * 1.6;
  if (fade < 0.01) { return 0.0; }
  let q = p.xz + F.origin.xz + F.sunDir.xz / max(F.sunDir.y, 0.2) * depth;
  let t = F.camPos.w * 0.6;
  let c = caustic(q * 0.23, t) + caustic(q * 0.23 + vec2f(0.013, 0.007), t);
  return fade * min(c, 3.0);
}
fn spotAtten(p: vec3f) -> vec4f { // rgb = radiance factor, a = cone
  let lv = p - F.spotPos.xyz; let dl = max(length(lv), 0.05); let l = lv / dl;
  let cd = dot(l, F.spotDir.xyz);
  var cone = smoothstep(F.spotDir.w, F.spotP.x, cd);
  // lamp reflector rings / hotspot (gobo)
  let a = acos(clamp(cd, -1.0, 1.0)) / max(acos(F.spotDir.w), 1e-3);
  cone *= (0.55 + 0.45 * exp(-a * a * 6.0)) * (1.0 + 0.035 * sin(a * 23.0));
  return vec4f(SPOT_COL * F.spotPos.w * exp(-sigmaT() * dl) / (dl * dl + 0.02) * (1.0 - smoothstep(F.spotP.y * 0.7, F.spotP.y, dl)), cone);
}
`;

export const SHADOW_FN = /* wgsl */`
@group(0) @binding(1) var shadowMap: texture_depth_2d;
@group(0) @binding(2) var shadowSmp: sampler_comparison;
fn shadowVis(p: vec3f, bias: f32) -> f32 {
  let c = F.spotVP * vec4f(p, 1.0);
  if (c.w <= 0.0) { return 0.0; }
  let n = c.xyz / c.w;
  let uv = vec2f(n.x * 0.5 + 0.5, 0.5 - n.y * 0.5);
  if (any(uv < vec2f(0.0)) || any(uv > vec2f(1.0))) { return 0.0; }
  return textureSampleCompareLevel(shadowMap, shadowSmp, uv, n.z - bias);
}
const SHADOW_TS: f32 = 1.0 / 2048.0;
const POISSON = array<vec2f, 16>(
  vec2f(-0.94201624, -0.39906216), vec2f(0.94558609, -0.76890725), vec2f(-0.09418410, -0.92938870), vec2f(0.34495938, 0.29387760),
  vec2f(-0.91588581, 0.45771432), vec2f(-0.81544232, -0.87912464), vec2f(-0.38277543, 0.27676845), vec2f(0.97484398, 0.75648379),
  vec2f(0.44323325, -0.97511554), vec2f(0.53742981, -0.47373420), vec2f(-0.26496911, -0.41893023), vec2f(0.79197514, 0.19090188),
  vec2f(-0.24188840, 0.99706507), vec2f(-0.81409955, 0.91437590), vec2f(0.19984126, 0.78641367), vec2f(0.14383161, -0.14100790));
// 16-tap rotated Poisson PCF (hardware 2x2 compare per tap) -> soft, band-free penumbra
fn pcf16(uv: vec2f, z: f32, radius: f32, fragXY: vec2f) -> f32 {
  let ign = fract(52.9829189 * fract(dot(fragXY, vec2f(0.06711056, 0.00583715))));
  let a = ign * 6.2831853; let cs = cos(a); let sn = sin(a);
  var s = 0.0;
  for (var i = 0; i < 16; i++) {
    let o = POISSON[i]; let r = vec2f(o.x * cs - o.y * sn, o.x * sn + o.y * cs);
    s += textureSampleCompareLevel(shadowMap, shadowSmp, uv + r * radius * SHADOW_TS, z);
  }
  return s / 16.0;
}
fn sunShadow(p: vec3f, bias: f32) -> f32 {
  let c = F.spotVP * vec4f(p, 1.0);
  let n = c.xyz / c.w;
  let uv = vec2f(n.x * 0.5 + 0.5, 0.5 - n.y * 0.5);
  if (any(uv < vec2f(0.0)) || any(uv > vec2f(1.0)) || n.z > 1.0) { return 1.0; }
  // fade to lit at the edge of the shadow frustum instead of a hard seam
  let edge = smoothstep(0.0, 0.06, min(min(uv.x, uv.y), min(1.0 - uv.x, 1.0 - uv.y)));
  return mix(1.0, pcf16(uv, n.z - bias, 1.6, uv * 2048.0), edge);
}
fn shadowPCF(p: vec3f, bias: f32) -> f32 {
  let c = F.spotVP * vec4f(p, 1.0);
  if (c.w <= 0.0) { return 0.0; }
  let n = c.xyz / c.w;
  let uv = vec2f(n.x * 0.5 + 0.5, 0.5 - n.y * 0.5);
  if (any(uv < vec2f(0.0)) || any(uv > vec2f(1.0))) { return 0.0; }
  if (n.z >= 1.0) { return 1.0; }
  return pcf16(uv, n.z - bias, 1.8, uv * 2048.0);
}
`;

// Physically-motivated surface shading (sun downwelling + caustics, flashlight w/ shadow, bio point lights)
export const SHADE = /* wgsl */`
@group(0) @binding(17) var envCube: texture_cube<f32>;
@group(0) @binding(18) var envSmp: sampler;
@group(0) @binding(19) var foamMap: texture_2d<f32>;
const FOAM_EXTENT: f32 = 48.0;
const ENV_MIPS: f32 = 5.0;
// split-sum style prefiltered environment specular
fn envSpec(n: vec3f, v: vec3f, rough: f32, f0: vec3f) -> vec3f {
  let r = reflect(-v, n);
  let nv = max(dot(n, v), 0.0);
  let Fr = f0 + (max(vec3f(1.0 - rough), f0) - f0) * pow(1.0 - nv, 5.0);
  let lvl = sqrt(clamp(rough, 0.0, 1.0)) * ENV_MIPS;
  return Fr * textureSampleLevel(envCube, envSmp, r, lvl).rgb * (1.0 - 0.5 * rough * rough);
}
fn ggx(n: vec3f, l: vec3f, v: vec3f, rough: f32, f0: vec3f) -> vec3f {
  let h = normalize(l + v); let nh = max(dot(n, h), 0.0); let nl = max(dot(n, l), 0.0); let nv = max(dot(n, v), 1e-3);
  let a = rough * rough; let a2 = a * a; let d = nh * nh * (a2 - 1.0) + 1.0;
  let D = a2 / (PI * d * d);
  let k = a * 0.5; let G = nl / (nl * (1.0 - k) + k) * nv / (nv * (1.0 - k) + k);
  let Fr = f0 + (1.0 - f0) * pow(1.0 - max(dot(h, v), 0.0), 5.0);
  return D * G * Fr / (4.0 * nv * max(nl, 1e-3)) * nl;
}
fn shade(p: vec3f, n: vec3f, v: vec3f, alb: vec3f, rough: f32, metal: f32, ao: f32, sss: f32) -> vec3f {
  let dif = alb * (1.0 - metal);
  let f0 = mix(vec3f(0.04), alb, metal);
  var c = vec3f(0.0);
  if (aboveSea(p) < 0.0) {
    let e = downwell(p.y);
    let l = F.sunDir.xyz;
    let nl = dot(n, l);
    let cau = causticAt(p, n);
    let direct = e * 0.55 * (max(nl, 0.0) + sss * 0.25 * max(-nl, 0.0)) * (0.3 + cau);
    let hemi = e * (0.45 * (0.52 + 0.48 * n.y) + 0.025);
    c += (dif / PI * (direct + hemi)) * ao + ggx(n, l, v, rough, f0) * direct * 0.5;
    // environment reflection: the surrounding water light mirrored by the surface (strong for metallic/silver skin)
    // baked cube (water light field + bright zenith from the surface), rebaked as depth changes
    c += envSpec(n, v, rough, f0) * ao;
  } else {
    // harsh mid-Atlantic sun + sky dome + blue bounce from the sea
    let l = SUN_AIR;
    let sh = sunShadow(p + n * 0.03, 0.0015);
    let sunE = SUN_E * sunTrans();
    let nl = max(dot(n, l), 0.0);
    let skyIrr = vec3f(0.55, 0.78, 1.25) * 2.4;
    let seaIrr = vec3f(0.06, 0.16, 0.24) * 1.6;
    let amb = mix(seaIrr, skyIrr, n.y * 0.5 + 0.5);
    c += dif / PI * (sunE * nl * sh + amb * ao) + ggx(n, l, v, rough, f0) * sunE * sh;
    // baked sky + sea cube, horizon-occluded by the normal (no reflections from below the surface plane)
    let r = reflect(-v, n);
    let hor = clamp(1.0 + 1.5 * dot(r, n), 0.0, 1.0);
    c += envSpec(n, v, rough, f0) * ao * hor * hor;
  }
  if (F.spotPos.w > 0.0) {
    let sa = spotAtten(p);
    if (sa.a > 0.001) {
      let l = normalize(F.spotPos.xyz - p);
      let sh = shadowPCF(p + n * 0.02, 0.0004);
      let nl = dot(n, l);
      let wrap = max(nl, 0.0) + sss * 0.35 * max(-nl + 0.3, 0.0);
      c += sa.rgb * sa.a * sh * (dif / PI * wrap * ao + ggx(n, l, v, rough, f0));
    }
  }
  let nL = u32(F.misc.x);
  for (var i = 0u; i < nL; i++) {
    let lp = F.lightPos[i]; let lv = lp.xyz - p; let d = length(lv); let l = lv / max(d, 1e-3);
    if (d > lp.w) { continue; }
    let win = 1.0 - smoothstep(lp.w * 0.6, lp.w, d);
    let rad = F.lightCol[i].rgb * exp(-sigmaT() * d) / (d * d + 0.05) * win;
    c += rad * (dif / PI * (max(dot(n, l), 0.0) + sss * 0.4) + ggx(n, l, v, rough, f0));
  }
  return c;
}
// glossy clear coat (gelcoat / varnish) over the base layer: sharp env reflection + tight sun highlight
fn coatLayer(p: vec3f, n: vec3f, v: vec3f, coat: f32) -> vec3f {
  // wet under water the coat's index contrast vanishes (water n≈1.33 vs gelcoat ~1.5): its reflection nearly disappears
  var c = envSpec(n, v, 0.03, vec3f(0.04)) * select(0.12, 1.0, aboveSea(p) >= 0.0);
  if (aboveSea(p) >= 0.0) {
    c += ggx(n, SUN_AIR, v, 0.07, vec3f(0.04)) * SUN_E * sunTrans() * sunShadow(p + n * 0.03, 0.0015);
  }
  return c * coat;
}
// screen-space cotangent frame normal mapping (no tangents needed)
fn perturb(n: vec3f, p: vec3f, uv: vec2f, tn: vec3f) -> vec3f {
  let dp1 = dpdx(p); let dp2 = dpdy(p); let duv1 = dpdx(uv); let duv2 = dpdy(uv);
  let dp2p = cross(dp2, n); let dp1p = cross(n, dp1);
  let t = dp2p * duv1.x + dp1p * duv2.x; let b = dp2p * duv1.y + dp1p * duv2.y;
  let im = inverseSqrt(max(max(dot(t, t), dot(b, b)), 1e-12));
  return normalize(t * im * tn.x + b * im * tn.y + n * tn.z);
}
`;

// ---------------- mesh (static / skinned / instanced) ----------------
export function meshShader({ skin = false, inst = false, shadow = false }) {
  return /* wgsl */`
${COMMON}
${shadow ? '' : SHADOW_FN + SHADE}
struct Obj { model: mat4x4f, swim: vec4f, tint: vec4f, extra: vec4f, bounds: vec4f };
@group(1) @binding(0) var<uniform> O: Obj;
@group(1) @binding(1) var<storage, read> S: array<mat4x4f>;
struct Mat { color: vec4f, emissive: vec4f, pbr: vec4f, flags: vec4f };
${shadow ? '' : `
@group(2) @binding(0) var<uniform> M: Mat;
@group(2) @binding(1) var tBase: texture_2d<f32>;
@group(2) @binding(2) var tNorm: texture_2d<f32>;
@group(2) @binding(3) var tMR: texture_2d<f32>;
@group(2) @binding(4) var tEm: texture_2d<f32>;
@group(2) @binding(5) var smp: sampler;`}
struct VOut { @builtin(position) pos: vec4f, @location(0) wp: vec3f, @location(1) n: vec3f, @location(2) uv: vec2f, @location(3) glow: f32 };

// giant squid (flag: swim.x < 0): jet pulses of the mantle, flapping fins, arms and tentacles writhing in waves that
// run down them, each arm out of phase, bunching together after every jet stroke.  bounds.x = tip z, bounds.y = length
fn squidDeform(p: ptr<function, vec3f>, n: ptr<function, vec3f>, ph: f32) {
  let len = O.bounds.y; let t = F.camPos.w + ph;
  let s = clamp((O.bounds.x - (*p).z) / len, 0.0, 1.0);             // 0 mantle tip .. 1 tentacle ends
  let jet = 1.0 - 2.0 * clamp(O.swim.y, 0.0, 1.0);                 // jet stroke from the CPU (mantle squeezes as it thrusts)
  // mantle: contracts on the power stroke, refills slowly
  let mk = smoothstep(0.04, 0.18, s) * (1.0 - smoothstep(0.42, 0.55, s));
  let sq = 1.0 + 0.075 * jet * mk;
  (*p).x *= sq; (*p).y *= sq;
  // fins at the tip: slow undulating flaps
  let fk = 1.0 - smoothstep(0.08, 0.24, s);
  (*p).y += abs((*p).x) * 0.45 * sin(t * 1.9 - s * 8.0) * fk;
  // arms / tentacles: writhing travelling waves, phase set by the arm's angle round the axis, bunching after a jet
  let a = smoothstep(0.52, 1.0, s);
  if (a > 0.0) {
    let ang = atan2((*p).y, (*p).x);
    let w = t * 1.6 - a * 6.0 + ang * 2.0;
    let d = len * 0.07 * pow(a, 1.5);
    let bunch = 1.0 - 0.18 * a * (0.5 + 0.5 * sin(t * 1.05 - 1.4));
    (*p).x = (*p).x * bunch + d * sin(w);
    (*p).y = (*p).y * bunch + d * cos(w * 0.83 + 1.3);
    (*p).z += len * 0.02 * a * sin(t * 1.05 - 1.0);                  // trailing arms stretch and recoil with the stroke
    *n = normalize(*n + vec3f(cos(w), -sin(w * 0.83 + 1.3), 0.0) * 0.35 * a);
  }
}
fn swimDeform(p: ptr<function, vec3f>, n: ptr<function, vec3f>, ph: f32, spd: f32, bend: f32) {
  if (O.swim.x < 0.0) { squidDeform(p, n, ph); return; }
  let amp = O.swim.x;
  if (amp <= 0.0) { return; }
  let len = O.bounds.y;
  let s = clamp((O.bounds.x - (*p).z) / len, 0.0, 1.0);          // 0 head .. 1 tail
  // turning: the whole body flexes into an arc around its pivot (~1/3 back from the snout), head and tail toward the turn
  let dq = s - 0.33;
  (*p).x += bend * len * dq * dq;
  *n = normalize(*n + vec3f(0.0, 0.0, 2.0 * bend * dq) * (*n).x);
  let w = F.camPos.w * O.swim.y * spd + ph - s * O.swim.z;
  let env = 0.12 + s * s;
  (*p).x += amp * len * env * sin(w);
  let slope = amp * len * (2.0 * s / len * sin(w) - env * O.swim.z / len * cos(w));
  *n = normalize(*n + vec3f(0.0, 0.0, slope) * (*n).x);
  (*p).y += O.swim.w * len * s * s * sin(w * 0.5);              // gentle vertical undulation (sharks/turtles)
}
fn flap(p: ptr<function, vec3f>, ph: f32) {
  let w0 = O.bounds.z;
  if (w0 <= 0.0) { return; }
  let ax = abs((*p).x) - w0;
  if (ax <= 0.0) { return; }
  let front = select(0.6, 1.0, (*p).z > 0.0);
  let fr = select(1.1, O.swim.y, O.swim.y > 0.0);
  let a = sin(F.camPos.w * fr + ph + select(1.4, 0.0, (*p).z > 0.0)) * O.bounds.w * front;
  (*p).y += ax * a;
  (*p).z -= ax * abs(a) * 0.3;
}

@vertex fn vs(@location(0) ip: vec3f, @location(1) inrm: vec3f, @location(2) iuv: vec2f,
${skin ? '@location(3) j: vec4u, @location(4) w: vec4f,' : ''}
  @builtin(instance_index) ii: u32) -> VOut {
  var p = ip; var n = inrm; var M4 = O.model; var ph = O.extra.x; var spd = 1.0; var glow = 0.0; var bend = 0.0;
  ${inst ? `var im = S[ii]; ph = im[0][3]; spd = im[1][3]; glow = im[2][3]; bend = im[3][3] - 1.0; im[0][3] = 0.0; im[1][3] = 0.0; im[2][3] = 0.0; im[3][3] = 1.0; M4 = im * O.model;` : ''}
  swimDeform(&p, &n, ph, spd, bend);
  flap(&p, ph);
  ${skin ? `let sk = S[j.x] * w.x + S[j.y] * w.y + S[j.z] * w.z + S[j.w] * w.w; M4 = sk;` : ''}
  let wp = (M4 * vec4f(p, 1.0)).xyz;
  var o: VOut;
  o.pos = F.viewProj * vec4f(wp, 1.0);
  o.wp = wp; o.n = normalize((M4 * vec4f(n, 0.0)).xyz); o.uv = iuv; o.glow = glow;
  return o;
}
${shadow ? '' : `
@fragment fn fs(in: VOut, @builtin(front_facing) ff: bool) -> @location(0) vec4f {
  let bt = textureSample(tBase, smp, in.uv);
  let nt = textureSample(tNorm, smp, in.uv).xyz * 2.0 - 1.0;
  let mr = textureSample(tMR, smp, in.uv);
  let em = textureSample(tEm, smp, in.uv).rgb;
  var base = bt * M.color * O.tint;
  if (base.a < M.pbr.w) { discard; }
  var n = normalize(in.n);
  if (!ff) { n = -n; }
  if (O.extra.w > 2.5) {
    // silt settled on up-facing surfaces of rocks
    let wa = in.wp + F.origin.xyz; let nw = normalize(in.n);
    let dust = smoothstep(0.55, 0.95, nw.y + (vnoise(wa.xz * 3.0) - 0.5) * 0.4) * smoothstep(0.35, 0.75, vnoise(wa.xz * 7.0 + wa.y * 3.0));
    base = vec4f(mix(base.rgb, vec3f(0.5, 0.47, 0.41) * (0.85 + 0.3 * vnoise(wa.xz * 40.0)), dust * 0.55), base.a);
  } else if (O.extra.w > 0.5) {
    let wa = in.wp + F.origin.xyz;
    let mott = 0.85 + 0.3 * vnoise(wa.xz * 3.0 + wa.y * 2.0);
    base = vec4f(mix(vec3f(0.78, 0.8, 0.8), vec3f(0.2, 0.25, 0.29) * mott, smoothstep(-0.3, 0.2, normalize(in.n).y)) * O.tint.rgb, 1.0);
  }
  if (M.flags.x > 0.5) { n = perturb(n, in.wp, in.uv, normalize(vec3f(nt.xy * M.pbr.z, nt.z))); }
  let v = normalize(F.camPos.xyz - in.wp);
  let glossMap = M.flags.y > 1.5;
  let rough = select(clamp(M.pbr.y * mr.g, 0.06, 1.0), clamp(M.pbr.y * (1.0 - mr.g) + 0.12, 0.12, 1.0), glossMap);
  let metal = select(clamp(M.pbr.x * mr.b, 0.0, 1.0), 0.0, glossMap);
  var c = shade(in.wp, n, v, base.rgb, rough, metal, select(mix(1.0, mr.r, M.flags.y), 1.0, glossMap), O.extra.y);
  if (M.flags.w > 0.0) { c += coatLayer(in.wp, select(-1.0, 1.0, ff) * normalize(in.n), v, M.flags.w); }
  // rim wetness sheen for creatures in flashlight / bio light
  c += em * M.emissive.rgb * M.emissive.w * select(1.0, 1.4 / max(F.kd.w, 0.5), M.flags.z > 0.5) + O.extra.z * vec3f(0.2, 0.7, 1.0) * in.glow;
  return vec4f(safeHDR(c), 1.0);
}`}
`;
}

// ---------------- seafloor ----------------
export const FLOOR = /* wgsl */`
${COMMON}
${SHADOW_FN}
${SHADE}
struct Obj { model: mat4x4f, swim: vec4f, tint: vec4f, extra: vec4f, bounds: vec4f };
@group(1) @binding(0) var<uniform> O: Obj;
fn fbm(p: vec2f) -> f32 { var s = 0.0; var a = 0.5; var q = p; for (var i = 0; i < 4; i++) { s += a * vnoise(q); q = q * 2.03 + vec2f(1.7, 9.2); a *= 0.5; } return s; }
fn floorH(xz: vec2f) -> f32 {
  let dunes = sin(xz.x * 0.09 + fbm(xz * 0.02) * 4.0) * 0.6;
  return F.spotP.w + fbm(xz * 0.035) * 5.0 + dunes + fbm(xz * 0.25) * 0.35;
}
struct VOut { @builtin(position) pos: vec4f, @location(0) wp: vec3f, @location(1) xza: vec2f };
@vertex fn vs(@location(0) g: vec2f) -> VOut {
  let xz = g + O.model[3].xz;                        // absolute (snapped) xz
  let wp = vec3f(xz.x - F.origin.x, floorH(xz) - F.origin.y, xz.y - F.origin.z);
  var o: VOut; o.pos = F.viewProj * vec4f(wp, 1.0); o.wp = wp; o.xza = xz; return o;
}
@group(0) @binding(20) var sandN: texture_2d<f32>;
@group(0) @binding(21) var sandA: texture_2d<f32>;
@group(0) @binding(22) var sandSmp: sampler;
fn h21(p: vec2f) -> f32 { return fract(sin(dot(p, vec2f(127.1, 311.7))) * 43758.5453); }
// current ripples: asymmetric (gentle stoss, steep lee), crests bend and bifurcate, amplitude patchy
fn ripple(xz: vec2f) -> f32 {
  let w = vnoise(xz * 0.35) * 2.2 + vnoise(xz * 1.1) * 0.6;
  let ph = dot(xz, vec2f(0.93, 0.37)) * 9.0 + w * 3.0;                 // ~0.7 m wavelength sand waves
  let f = fract(ph / 6.2831853);
  let saw = smoothstep(0.0, 0.72, f) * (1.0 - smoothstep(0.72, 1.0, f));
  let ph2 = dot(xz, vec2f(0.88, 0.47)) * 31.0 + w * 7.0;               // ~20 cm secondary ripples
  let f2 = fract(ph2 / 6.2831853);
  let saw2 = smoothstep(0.0, 0.7, f2) * (1.0 - smoothstep(0.7, 1.0, f2));
  let amp = smoothstep(0.25, 0.7, vnoise(xz * 0.08 + 3.0));
  return (saw * 0.045 + saw2 * 0.012) * amp;
}
fn sandH(xz: vec2f, fine: f32) -> f32 {
  var h = floorH(xz) + ripple(xz);
  // lebensspuren: burrow openings with a raised rim, feeding pits
  let cell = floor(xz * 0.6); let fc = fract(xz * 0.6) - 0.5;
  if (h21(cell) > 0.9) {
    let o = vec2f(h21(cell + 3.1), h21(cell + 7.7)) - 0.5;
    let d = length(fc - o * 0.8) / 0.6;
    let sz = 0.5 + h21(cell + 1.3);
    h += (0.012 * exp(-pow((d - 0.05 * sz) / (0.03 * sz), 2.0)) - 0.02 * exp(-d * d / (0.0008 * sz * sz))) * fine;
  }
  return h;
}
@fragment fn fs(in: VOut) -> @location(0) vec4f {
  let xz = in.xza;
  let v = normalize(F.camPos.xyz - in.wp);
  let dist = length(F.camPos.xyz - in.wp);
  let fine = 1.0 - smoothstep(8.0, 30.0, dist);
  let e = 0.02 + dist * 0.002;
  let h0 = sandH(xz, fine);
  let hx = sandH(xz + vec2f(e, 0.0), fine); let hz = sandH(xz + vec2f(0.0, e), fine);
  var n = normalize(vec3f(h0 - hx, e, h0 - hz));
  // grain / micro-relief detail from the mip-mapped sand normal map at two scales (no shimmer at distance)
  let px = length(fwidth(xz));
  let gf = (1.0 - smoothstep(0.004, 0.02, px)) * fine;
  let sn1 = textureSample(sandN, sandSmp, xz * 1.0).xyz * 2.0 - 1.0;
  let sn2 = textureSample(sandN, sandSmp, xz * 0.23 + vec2f(0.37, 0.71)).xyz * 2.0 - 1.0;
  let dn = vec3f(sn1.x + sn2.x * 0.7, 0.0, -(sn1.y + sn2.y * 0.7));
  n = normalize(n + dn * 0.9);
  // albedo: pale foraminiferal ooze with darker lithic grains, fluffy phytodetritus in ripple troughs, tracks
  let g2 = vnoise(xz * 6.0); let g3 = vnoise(xz * 0.7 + 11.0);
  var alb = mix(vec3f(0.50, 0.47, 0.41), vec3f(0.62, 0.59, 0.52), g2) * (0.85 + 0.25 * g3);
  alb *= mix(1.0, textureSample(sandA, sandSmp, xz * 1.0).r * 1.05, 0.8) * mix(1.0, textureSample(sandA, sandSmp, xz * 0.23 + vec2f(0.37, 0.71)).r * 1.05, 0.5);
  let trough = 1.0 - smoothstep(0.0, 0.02, ripple(xz));
  let detr = smoothstep(0.55, 0.8, vnoise(xz * 2.3 + 4.0)) * (0.4 + 0.6 * trough);
  alb = mix(alb, vec3f(0.24, 0.23, 0.17), detr * 0.55);
  // meandering grazing trails (sea-cucumber / crab tracks)
  let tr = abs(vnoise(xz * vec2f(0.3, 0.3) + 17.0) - 0.5);
  alb *= 1.0 - (1.0 - smoothstep(0.0, 0.012, tr)) * 0.25 * fine;
  // sparse manganese nodules
  // sparse, half-buried manganese nodules (2–6 cm, knobbly), with a faint contact shadow
  let nc = floor(xz * 2.5); let nf = (fract(xz * 2.5) - 0.5) / 2.5;
  if (h21(nc + 91.0) > 0.93) {
    let o = (vec2f(h21(nc + 5.0), h21(nc + 2.0)) - 0.5) * 0.2; let q = nf - o;
    let r = (0.02 + 0.04 * h21(nc + 13.0)) * (0.85 + 0.3 * vnoise(xz * 90.0));
    let d = length(q);
    if (d < r) {
      alb = vec3f(0.07, 0.055, 0.045) * (0.7 + 0.6 * vnoise(xz * 140.0));
      n = normalize(mix(n, normalize(vec3f(q.x, sqrt(max(r * r - d * d, 0.0)) * 0.8, q.y)), 0.85));
    } else { alb *= 1.0 - 0.35 * exp(-pow((d - r) / (r * 0.35), 2.0)); }
  }
  // methane seeps: white Beggiatoa mats with orange patches, black reduced sediment rim
  var rough = 0.92;
  for (var i = 0; i < 4; i++) {
    var S = O.swim;
    if (i == 1) { S = O.tint; } if (i == 2) { S = O.extra; } if (i == 3) { S = O.bounds; }   // up to 4 seeps: x, z, radius, on
    if (S.w <= 0.0) { continue; }
    let d = length(xz - S.xy) / S.z;
    let edge = d + (vnoise(xz * 1.3 + S.xy) - 0.5) * 0.5 + (vnoise(xz * 5.0) - 0.5) * 0.15;
    let ring = exp(-pow((edge - 1.0) / 0.18, 2.0));
    alb = mix(alb, vec3f(0.05, 0.05, 0.05), ring * 0.8);
    let mat = 1.0 - smoothstep(0.75, 0.95, edge);
    let patchy = smoothstep(0.35, 0.6, vnoise(xz * 2.2 + S.xy * 0.1));
    let mcol = mix(vec3f(0.9, 0.9, 0.86), vec3f(0.85, 0.5, 0.18), smoothstep(0.55, 0.8, vnoise(xz * 1.4 + 7.0)));
    alb = mix(alb, mcol, mat * patchy);
    n = normalize(mix(n, vec3f(0.0, 1.0, 0.0), mat * patchy * 0.6));
    rough = mix(rough, 0.6, mat * patchy);
  }
  var c = shade(in.wp, n, v, alb, rough, 0.0, 1.0, 0.0);
  // quartz / foram glints under the lamp
  if (F.spotPos.w > 0.0 && gf > 0.0) {
    let sa = spotAtten(in.wp);
    let gl = step(0.985, h21(floor(xz * 300.0) + 1.7));
    c += sa.rgb * sa.a * gl * gf * ggx(normalize(n + vec3f(h21(floor(xz * 300.0)) - 0.5, 0.0, h21(floor(xz * 300.0) + 4.0) - 0.5) * 0.6), normalize(F.spotPos.xyz - in.wp), v, 0.08, vec3f(0.05)) * 0.6;
  }
  // beyond visibility nothing can light the floor: round off the square patch (corners) instead of drawing black ground
  if (length(in.wp.xz) > 68.0) { discard; }
  return vec4f(safeHDR(c), 1.0);
}
`;

// ---------------- sea surface (Gerstner) ----------------
export const SURFACE = /* wgsl */`
${COMMON}
${SHADOW_FN}
${SHADE}
struct Obj { model: mat4x4f, swim: vec4f, tint: vec4f, extra: vec4f, bounds: vec4f };
@group(1) @binding(0) var<uniform> O: Obj;     // extra: boat x, z (absolute), half length, half beam; bounds.x: boat yaw
@group(0) @binding(23) var refrTex: texture_2d<f32>;
@group(0) @binding(24) var refrDepth: texture_depth_2d;
@group(0) @binding(14) var oSlope0: texture_2d<f32>;
@group(0) @binding(15) var oSlope1: texture_2d<f32>;
@group(0) @binding(16) var oSlope2: texture_2d<f32>;
struct VOut { @builtin(position) pos: vec4f, @location(0) wp: vec3f, @location(1) uxz: vec2f, @location(2) h: f32, @location(3) xza: vec2f, @location(4) n0: vec3f };
@vertex fn vs(@location(0) g: vec2f) -> VOut {
  let xz = g + floor(F.origin.xz / 8.0) * 8.0;           // undisplaced absolute xz
  let dist = length(xz - F.origin.xz);
  // fade the short cascades where the mesh can't resolve them
  // band-limit each cascade to what the (warped) grid can carry here: vertex spacing -> displacement mip level
  // (wavelengths shorter than ~2 vertex spacings are pre-averaged instead of aliasing into moiré)
  // isotropic (radial) estimate of the local vertex spacing -> smooth, circular LOD rings (no square/grid artefacts)
  let ur = pow(max(length(g) * 0.8 / 1600.0, 1e-4), 1.0 / 2.8);
  let sp = max(1600.0 * 2.8 * pow(ur, 1.8) * (2.0 / 220.0), 0.05);
  let lv = vec3f(log2(sp * 256.0 / OL.x), log2(sp * 256.0 / OL.y), log2(sp * 256.0 / OL.z)) - 0.5;
  let d = textureSampleLevel(oDisp0, oSmp, xz / OL.x, max(lv.x, 0.0))
        + textureSampleLevel(oDisp1, oSmp, xz / OL.y, max(lv.y, 0.0)) * (1.0 - smoothstep(6.0, 7.5, lv.y))
        + textureSampleLevel(oDisp2, oSmp, xz / OL.z, max(lv.z, 0.0)) * (1.0 - smoothstep(6.0, 7.5, lv.z));
  var pa = vec3f(xz.x + d.x, d.y, xz.y + d.z);
  pa.y += ripH(pa.xz - F.origin.xz);
  let wp = pa - F.origin.xyz;
  var o: VOut; o.pos = F.viewProj * vec4f(wp, 1.0); o.wp = wp; o.uxz = xz; o.h = d.y; o.xza = pa.xz; o.n0 = vec3f(0.0, 1.0, 0.0); return o;
}
fn cellHash(c: vec2f) -> vec2f { let q = vec2f(dot(c, vec2f(127.1, 311.7)), dot(c, vec2f(269.5, 183.3))); return fract(sin(q) * 43758.5453); }
// Worley F1/F2 with slowly drifting feature points
fn worley2(p: vec2f, t: f32) -> vec2f {
  let i = floor(p); let f = fract(p);
  var d1 = 8.0; var d2 = 8.0;
  for (var y = -1; y <= 1; y++) { for (var x = -1; x <= 1; x++) {
    let g = vec2f(f32(x), f32(y));
    let h = cellHash(i + g);
    let o = 0.5 + 0.45 * sin(t * (0.3 + h * 0.4) + 6.2831 * h);
    let d = length(g + o - f);
    if (d < d1) { d2 = d1; d1 = d; } else if (d < d2) { d2 = d; }
  } }
  return vec2f(d1, d2);
}
// sea foam as a fluid tracer (faked): the texture coordinates are advected through a divergence-free (curl) flow for a
// few steps, so structures are stretched into streaks and folded into filaments like real foam lines; the bubble raft is
// a ridged network whose gaps are irregular, sheared voids rather than round holes.
fn curlN(p: vec2f) -> vec2f {
  let e = 0.08;
  let n0 = vnoise(p); let nx = vnoise(p + vec2f(e, 0.0)); let ny = vnoise(p + vec2f(0.0, e));
  return vec2f(ny - n0, -(nx - n0)) / e;
}
fn foamLace(p0: vec2f, t: f32) -> f32 {
  // anisotropy: the surface drift (wind) stretches foam into streaks along it
  let wd = vec2f(0.93, 0.37); let cd = vec2f(-wd.y, wd.x);
  var p = vec2f(dot(p0, wd) * 0.55, dot(p0, cd));
  // advect through a slowly evolving curl flow (3 semi-Lagrangian steps, large then small eddies)
  p += curlN(p * 0.22 + vec2f(t * 0.015, 0.0)) * 0.9;
  p += curlN(p * 0.6 + vec2f(3.1, t * 0.02)) * 0.35;
  p += curlN(p * 1.7 + vec2f(t * 0.03, 7.7)) * 0.12;
  // ridged network (bubble-raft filaments) + fbm body, voids = low regions of a sheared field (no circles)
  var ridge = 0.0; var body = 0.0; var amp = 0.5; var q = p * 1.3;
  for (var i = 0; i < 5; i++) {
    let n = vnoise(q);
    ridge += amp * (1.0 - abs(n * 2.0 - 1.0));
    body += amp * n;
    q = q * 2.03 + vec2f(1.7, 9.2) + curlN(q * 0.5) * 0.15;
    amp *= 0.5;
  }
  let voids = smoothstep(0.30, 0.55, body / 0.97);
  return clamp((ridge / 0.97) * 0.55 + voids * 0.55 - 0.05, 0.0, 1.0);
}
// short-wave ripple field: many random directions (no parallel stripes), gusty patches ("cat's paws")
fn capillary(xz: vec2f, t: f32, dist: f32, pix: f32) -> vec2f {
  var g = vec2f(0.0);
  let paws = smoothstep(0.25, 0.8, vnoise(xz * 0.07 + vec2f(t * 0.03, t * 0.012)) * 0.7 + vnoise(xz * 0.23 - t * 0.02) * 0.3);
  for (var i = 0; i < 14; i++) {
    let fi = f32(i);
    let h = fract(sin(vec2f(fi * 12.9898, fi * 78.233)) * 43758.5453);
    let lam = 0.45 * pow(0.8, fi) * (0.8 + 0.4 * h.x);
    let fade = (1.0 - smoothstep(lam * 10.0, lam * 30.0, dist)) * smoothstep(3.0 * pix, 8.0 * pix, lam);
    if (fade <= 0.0) { continue; }
    let ang = 0.55 + (h.y - 0.5) * 3.4;                    // spread over ±100° around the wind
    let d = vec2f(cos(ang), sin(ang));
    let k = 6.2831853 / lam; let om = sqrt(9.81 * k + 0.074 * k * k * k / 1025.0);
    let th = k * dot(d, xz) - om * t + h.x * 40.0;
    let sl = (cos(th) + 0.4 * cos(2.0 * th + 0.5)) * k * lam * 0.011 * (0.5 + 0.5 * cos(dot(xz, d.yx) * k * 0.13 + h.y * 9.0));
    g += d * sl * fade;
  }
  return g * (0.35 + 0.65 * paws);
}
fn foamTex(xz: vec2f, t: f32) -> f32 {
  let a = vnoise(xz * 2.2 + vec2f(t * 0.07, 0.0));
  let b = vnoise(xz * 6.5 - vec2f(0.0, t * 0.11));
  let c = vnoise(xz * 17.0 + vec2f(t * 0.2));
  return smoothstep(0.25, 0.6, a * 0.5 + b * 0.32 + c * 0.18);
}
fn seaBody(v: vec3f) -> vec3f { return vec3f(0.0015, 0.016, 0.055); }   // deep Atlantic water-leaving radiance
@fragment fn fs(in: VOut, @builtin(front_facing) ff: bool) -> @location(0) vec4f {
  let t = F.camPos.w;
  let v = normalize(F.camPos.xyz - in.wp);
  let dist = length(in.wp);
  // wind gusts: patches of rougher water (cat's paws) and glassier lulls modulate the short cascade
  let gust = 0.45 + 1.1 * smoothstep(0.3, 0.8, vnoise(in.uxz * 0.011 + vec2f(t * 0.012, -t * 0.006)) * 0.7 + vnoise(in.uxz * 0.037 - vec2f(t * 0.02, 0.0)) * 0.3);
  let s0 = textureSample(oSlope0, oSmp, in.uxz / OL.x);
  let s1 = textureSample(oSlope1, oSmp, in.uxz / OL.y);
  // smallest cascade sampled twice (rotated/rescaled) to hide its 17.7 m tiling
  let rot = mat2x2f(0.799, 0.602, -0.602, 0.799);
  let s2 = (textureSample(oSlope2, oSmp, in.uxz / OL.z) * 0.6 + textureSample(oSlope2, oSmp, rot * in.uxz / (OL.z * 1.37)) * 0.4) * gust;
  let sl = s0 + s1 + s2;
  let dxz = textureSample(oDisp0, oSmp, in.uxz / OL.x).w + textureSample(oDisp1, oSmp, in.uxz / OL.y).w + textureSample(oDisp2, oSmp, in.uxz / OL.z).w * gust;   // pixel-footprint filtered
  let jac = (1.0 + sl.z) * (1.0 + sl.w) - dxz * dxz;
  // choppy-surface normal: slope divided by the horizontal compression
  var n = normalize(vec3f(-sl.x / max(1.0 + sl.z, 0.2), 1.0, -sl.y / max(1.0 + sl.w, 0.2)));
  // sharp capillary ripples (wind-aligned) instead of blob noise
  let pix = max(length(fwidth(in.uxz)), 1e-4);
  let cg = capillary(in.uxz, t, dist, pix) * gust;
  n = normalize(n + vec3f(-cg.x, 0.0, -cg.y));
  { let e = 0.04; let h0 = ripH(in.wp.xz); let gx = (ripH(in.wp.xz + vec2f(e, 0.0)) - h0) / e; let gz = (ripH(in.wp.xz + vec2f(0.0, e)) - h0) / e;
    n = normalize(n + vec3f(-gx, 0.0, -gz)); }
  let hF = textureSample(oDisp0, oSmp, in.uxz / OL.x).y + textureSample(oDisp1, oSmp, in.uxz / OL.y).y + textureSample(oDisp2, oSmp, in.uxz / OL.z).y;
  let nvar = length(fwidth(n));                                     // normal variation inside the pixel (uniform flow)
  let fromAir = ff;
  if (fromAir) {
    // ----- seen from the air -----
    let sh = sunShadow(in.wp + vec3f(0.0, 0.05, 0.0), 0.002);
    var r = reflect(-v, n); r.y = abs(r.y);
    let fres = 0.02 + 0.98 * pow(1.0 - max(dot(n, v), 0.0), 5.0);
    let rough = sqrt(pow(0.05 + min(dist * 0.00035, 0.22), 2.0) + min(nvar * nvar * 0.6, 0.25));
    let glint = (ggx(n, SUN_AIR, v, rough * 0.8, vec3f(0.02)) * 2.6 + ggx(n, SUN_AIR, v, rough * 2.5 + 0.08, vec3f(0.02)) * 0.5) * SUN_E * sunTrans() * sh;   // hard sun glints + broad glitter path
    // light scattered up through thin wave crests (turquoise), strongest looking toward the sun
    let crest = clamp(hF * 0.9 + 0.25, 0.0, 1.0);             // fragment height (vertex-interpolated height drew the grid)
    let sss = vec3f(0.01, 0.075, 0.07) * crest * (0.35 + 1.6 * pow(max(dot(-v, SUN_AIR) * 0.5 + 0.5, 0.0), 4.0)) * (0.6 + 0.4 * sh);
    // transmission: what lies under the surface (dolphin backs, hull, fish near the top) seen through the water,
    // refracted by the wave normal and absorbed/scattered with the path length below the surface
    var body = seaBody(v) * (0.6 + 0.4 * sh);
    {
      let res = vec2f(textureDimensions(refrTex));
      let suv = in.pos.xy / res;
      let ruv = clamp(suv + n.xz * vec2f(0.035, -0.035) * (1.0 - smoothstep(20.0, 80.0, dist)), vec2f(0.001), vec2f(0.999));
      let rd = textureLoad(refrDepth, vec2i(ruv * res), 0);
      if (rd < 1.0) {
        let ndc = vec2f(ruv.x * 2.0 - 1.0, 1.0 - ruv.y * 2.0);
        let hq = F.invViewProj * vec4f(ndc, rd, 1.0); let under = hq.xyz / hq.w;
        let path = length(under - in.wp);
        if (dot(under - in.wp, -v) > 0.0 && under.y + F.origin.y < 0.3) {   // really behind (below) this surface point
          let Tw = exp(-sigmaT() * path * 1.6);
          let seen = textureLoad(refrTex, vec2i(ruv * res), 0).rgb;
          body = seen * Tw * vec3f(0.55, 0.85, 0.95) + body * (1.0 - Tw);
        }
      }
    }
    var c = mix(body + sss, skyColL(r, clamp(log2(1.0 + dist * 0.04) + nvar * 8.0, 0.0, 6.0)), fres) + glint;
    // whitecaps where swell folds + wash around the hull
    let wcap = smoothstep(0.55, 0.05, jac) * (0.6 + 0.4 * gust);
    var foam = wcap;
    // hull foam from the particle simulation (same Lagrangian coords -> it rides the waves with the water)
    let fuv = (in.uxz - O.extra.xy) / FOAM_EXTENT + 0.5;
    var fd = 0.0;
    var fg = vec2f(0.0);
    if (all(fuv > vec2f(0.0)) && all(fuv < vec2f(1.0))) {
      fd = textureSampleLevel(foamMap, envSmp, fuv, 0.0).r;
      // foam raft thickness -> surface normal (rafts are a few cm thick, bubbly and domed)
      let px = 1.0 / 2048.0;
      fg = vec2f(textureSampleLevel(foamMap, envSmp, fuv + vec2f(px * 2.0, 0.0), 0.0).r - textureSampleLevel(foamMap, envSmp, fuv - vec2f(px * 2.0, 0.0), 0.0).r,
                 textureSampleLevel(foamMap, envSmp, fuv + vec2f(0.0, px * 2.0), 0.0).r - textureSampleLevel(foamMap, envSmp, fuv - vec2f(0.0, px * 2.0), 0.0).r);
    }
    foam = max(foam, (1.0 - exp(-fd * 0.6)) * 0.88);                     // never fully solid: bubble holes always show
    // coverage thresholds the foam body: dense wash fills in, the edges break into threads and islands
    // lace structure only where foam exists and is resolvable; far away it averages to its mean (same look, cheaper, no shimmer)
    let farL = smoothstep(90.0, 220.0, dist);
    var lace = 0.5;
    if (foam > 0.005 && farL < 1.0) { lace = mix(foamLace(in.uxz * 1.1, t), 0.5, farL); }
    let th = mix(0.72, 0.18, clamp(foam, 0.0, 1.0));
    // dense foam (opaque) + thin film around it (translucent), so edges fade into the water instead of cutting out
    let fk = smoothstep(0.03, 0.15, foam);
    // floating foam stays white ON the surface and thins by breaking into islands (the lace threshold rises), never
    // by turning into a translucent, sunken-looking tint; only breaking crests (whitecaps) aerate the water below
    let ft = (smoothstep(th, th + 0.08, lace) * 0.92 + smoothstep(th - 0.06, th, lace) * 0.06) * fk;
    c += vec3f(0.01, 0.085, 0.08) * wcap * (0.5 + 0.5 * sh) * 1.4;                        // breaking crests: aerated turquoise
    // volume: normal tilted by the raft thickness gradient, sun-lit crests, shadowed hollows and a darker wet rim
    let fnr = normalize(vec3f(-fg.x * 0.9, 1.0, fg.y * 0.9));
    let fsun = max(dot(fnr, SUN_AIR), 0.0);
    let hollow = 1.0 - 0.35 * smoothstep(0.0, 0.25, length(fg)) * (1.0 - fsun);
    let fcol = (SUN_E * sunTrans() * (0.35 + 0.65 * fsun) * sh + vec3f(0.55, 0.78, 1.25) * 2.4 * (0.75 + 0.25 * fnr.y)) * 0.85 / PI * hollow;
    c = mix(c, fcol * (0.62 + 0.4 * smoothstep(th - 0.05, th + 0.35, lace)), clamp(ft, 0.0, 0.95));
    // aerial perspective toward the horizon
    c = mix(c, skyCol(normalize(vec3f(-v.x, 0.015, -v.z))), 1.0 - exp(-dist * 0.00016));
    return vec4f(safeHDR(c), 1.0);
  }
  // ----- from below: Snell's window vs total internal reflection -----
  let nb = -n;
  let i = -v;
  let tr = refract(i, nb, 1.333);
  let refl = reflect(i, nb);
  let dn = ambientInscatter(in.wp, normalize(vec3f(refl.x, min(refl.y * 0.25, -0.02), refl.z)), 1e4) * 1.3;
  let cosI = clamp(dot(v, nb), 0.0, 1.0);
  let sinT2 = 1.777 * (1.0 - cosI * cosI);
  var Rf = 1.0;
  if (sinT2 < 1.0) {
    let cosT = sqrt(1.0 - sinT2);
    let rs = (1.333 * cosI - cosT) / (1.333 * cosI + cosT); let rp = (1.333 * cosT - cosI) / (1.333 * cosT + cosI);
    Rf = 0.5 * (rs * rs + rp * rp);
  }
  var sky = vec3f(0.0);
  if (dot(tr, tr) > 1e-4) { sky = min(skyCol(normalize(tr)), vec3f(80.0)) * 0.75; }
  var c = mix(sky, dn * 1.25, Rf);
  // floating foam seen from below: bright, diffusely lit rafts lying ON the surface (light soaks through the bubbles)
  {
    let fuv = (in.uxz - O.extra.xy) / FOAM_EXTENT + 0.5;
    if (all(fuv > vec2f(0.0)) && all(fuv < vec2f(1.0))) {
      let fd = textureSampleLevel(foamMap, envSmp, fuv, 0.0).r;
      let cov = (1.0 - exp(-fd * 0.6)) * 0.88;
      if (cov > 0.02) {
        let lace = foamLace(in.uxz * 1.1, t);
        let th = mix(0.72, 0.18, clamp(cov, 0.0, 1.0));
        let ftb = smoothstep(th, th + 0.08, lace) * smoothstep(0.03, 0.15, cov);
        let under = (SUN_E * sunTrans() * 0.05 + vec3f(0.35, 0.55, 0.7) * 0.9) * (0.7 + 0.3 * lace);
        c = mix(c, under, clamp(ftb, 0.0, 0.9));
      }
    }
  }
  // sparkle: sun glints refracted through ripple facets
  let gl = pow(max(dot(normalize(tr + vec3f(0.0, 1e-3, 0.0)), SUN_AIR), 0.0), 350.0) * (1.0 - Rf);
  c += vec3f(1.0, 0.97, 0.9) * gl * 40.0;
  return vec4f(safeHDR(c), 1.0);
}
`;

// ---------------- volumetric scattering (half res) ----------------
export const VOLUME = /* wgsl */`
${COMMON}
${SHADOW_FN}
@group(0) @binding(3) var depthTex: texture_depth_2d;
@group(0) @binding(4) var histTex: texture_2d<f32>;
@group(0) @binding(5) var histSmp: sampler;
@vertex fn vs(@builtin(vertex_index) i: u32) -> @builtin(position) vec4f {
  let p = vec2f(f32((i << 1u) & 2u), f32(i & 2u)); return vec4f(p * 2.0 - 1.0, 0.0, 1.0);
}
fn shaftPat(q: vec2f, t: f32) -> f32 {
  let a = vnoise(q * 0.22 + vec2f(t * 0.05, t * 0.03));
  let c = min(caustic(q * 0.23, t * 0.35), 2.5);
  let c2 = min(caustic(q * 0.09 + vec2f(0.37, 0.11), t * 0.25), 2.5);
  return a * 0.3 + c * c * 0.2 + c2 * 0.25;
}
fn tfbm(p: vec2f) -> f32 { var s = 0.0; var a = 0.5; var q = p; for (var i = 0; i < 4; i++) { s += a * vnoise(q); q = q * 2.03 + vec2f(1.7, 9.2); a *= 0.5; } return s; }
// same terrain as the FLOOR shader: silt haze must hug the real dunes, not a flat plane
fn terrainH(xz: vec2f) -> f32 { return F.spotP.w + tfbm(xz * 0.035) * 5.0 + sin(xz.x * 0.09 + tfbm(xz * 0.02) * 4.0) * 0.6; }
const maxDark: f32 = 42.0;                                      // torch / light in-scatter march length
@fragment fn fs(@builtin(position) fc: vec4f) -> @location(0) vec4f {
  let full = vec2i(fc.xy * 2.0);
  let dm = textureLoad(depthTex, full, 0);
  let uv = (fc.xy * 2.0 + 0.5) * F.res.zw;
  let ndc = vec2f(uv.x * 2.0 - 1.0, 1.0 - uv.y * 2.0);
  let ro = F.camPos.xyz;
  let h = F.invViewProj * vec4f(ndc, min(dm, 0.9999), 1.0);
  let wp = h.xyz / h.w;
  let rd = normalize(wp - ro);
  var D = 1e4;
  if (dm < 1.0) { D = length(wp - ro); }
  if (aboveSea(ro + rd * 0.35) > 0.0) { return vec4f(0.0, 0.0, 0.0, D); }
  var L = ambientInscatter(ro, rd, D);
  let st = sigmaT(); let b = F.absorb.w;
  let camDepth = F.misc.w;
  let doShaft = camDepth < 90.0;
  let doSpot = F.spotPos.w > 0.0;
  let nL = u32(F.misc.x);
  if (doShaft || doSpot || nL > 0u || F.misc.z > 0.0) {
    let maxD = min(D, maxDark);
    let N = 36;
    let j = fract(ign(fc.xy, F.misc.y) + hash21(fc.xy * 0.37 + vec2f(F.misc.y * 1.7, 3.1)) * 0.6180339);
    var prev = 0.0;
    let t = F.camPos.w;
    let sunPh = hg(dot(F.sunDir.xyz, rd), 0.8);
    let spotBack = F.spotP.y;
    for (var i = 0; i < N; i++) {
      let u = (f32(i) + j) / f32(N);
      let s = maxD * u * u;
      let ds = s - prev; prev = s;
      let p = ro + rd * s;
      var src = vec3f(0.0);
      if (doSpot) {
        let sa = spotAtten(p);
        if (sa.a > 0.001) {
          let l = normalize(p - F.spotPos.xyz);
          let c = dot(l, -rd);
          let ph = 0.75 * hg(c, 0.85) + 0.25 * hg(c, -0.35);
          let dl2 = dot(p - F.spotPos.xyz, p - F.spotPos.xyz);
          src += sa.rgb * sa.a * shadowVis(p, 0.0006) * ph * (dl2 + 0.02) / (dl2 + 0.35);
        }
      }
      if (doShaft) {
        let dep = max(-(p.y + F.origin.y), 0.0);
        let q = p.xz + F.origin.xz + F.sunDir.xz / max(F.sunDir.y, 0.2) * dep;
        let pat = shaftPat(q, t) - 0.48;
        src += downwell(p.y) * 0.55 * sunPh * pat * 7.0 * exp(-dep / 45.0);
      }
      for (var k = 0u; k < nL; k++) {
        let lp = F.lightPos[k]; let d = length(lp.xyz - p);
        if (d < lp.w) { src += F.lightCol[k].rgb * exp(-st * d) / (d * d + 0.08) * (1.0 / (4.0 * PI)) * (1.0 - smoothstep(lp.w * 0.5, lp.w, d)); }
      }
      // suspended sediment near the floor scatters the downwelling + lights more
      let sed = F.misc.z * exp(-max(p.y + F.origin.y - terrainH((p + F.origin.xyz).xz) - 0.3, 0.0) / 1.8) * (0.8 + 0.4 * vnoise3((p + F.origin.xyz) * 0.5 + vec3f(t * 0.3, 0.0, t * 0.1)));
      L += (src * (b + sed * 0.6)) * exp(-st * s) * ds;
    }
  }
  L = max(L, vec3f(0.0));
  // temporal accumulation: reproject this pixel's scene point into last frame's in-scatter
  // reproject the real hit point; open water / sky is a direction at infinity (no parallax) — the old 80 m clamp
  // mis-placed distant history under sideways motion and left a ghost line along the horizon
  var pc = F.prevViewProj * vec4f(ro + rd * D, 1.0);
  if (D >= 9999.0) { pc = F.prevViewProj * vec4f(rd, 0.0); }
  if (pc.w > 0.01) {
    let pn = pc.xy / pc.w;
    let huv = vec2f(pn.x * 0.5 + 0.5, 0.5 - pn.y * 0.5);
    if (all(huv > vec2f(0.0)) && all(huv < vec2f(1.0))) {
      let h = textureSampleLevel(histTex, histSmp, huv, 0.0);
      // history validity is decided on the distance the in-scatter was actually integrated over, not the surface
      // distance: in the dark only the torch (<= 42 m march) contributes, so a floor at 60 m and the open water behind
      // it carry identical in-scatter and must share history. Depth is read point-sampled (a filtered depth mixes the
      // two sides of a silhouette into a meaningless value and rejects a whole band of edge pixels every frame).
      let hd = textureLoad(histTex, clamp(vec2i(huv * vec2f(textureDimensions(histTex))), vec2i(0), vec2i(textureDimensions(histTex)) - 1), 0).a;
      let dcap = select(1e5, maxDark, camDepth > 150.0);
      let Dc = min(D, dcap); let hc0 = min(hd, dcap);
      let same = 1.0 - smoothstep(0.08, 0.3, abs(hc0 - Dc) / max(Dc, 0.5));
      // loose clamp only: the current sample is noisy, a tight clamp would drag the history back to the noise
      let hc = clamp(h.rgb, L * 0.6, L * 1.6 + vec3f(1e-4));   // moderate clamp: a loose one lets stale light trail behind moving edges
      let lightChange = 1.0;                                // torch switching is signalled explicitly (F.origin.w)
      // camera-attached light (torch beam) and fast turns: the reprojected history is wrong, so trust it less the
      // further the pixel moved on screen (full-res pixels) -> no smeared after-image while turning
      let motion = length((huv - uv) * F.res.xy);
      let mw = 1.0 - smoothstep(0.75, 8.0, motion);
      L = mix(L, hc, 0.8 * same * mw * lightChange * F.origin.w);
    }
  }
  return vec4f(L, D);
}
`;

// ---------------- composite: scene*T + inscatter (bilateral upsample) ----------------
export const COMPOSITE = /* wgsl */`
${COMMON}
@group(0) @binding(1) var sceneTex: texture_2d<f32>;
@group(0) @binding(2) var depthTex: texture_depth_2d;
@group(0) @binding(3) var volTex: texture_2d<f32>;
@vertex fn vs(@builtin(vertex_index) i: u32) -> @builtin(position) vec4f {
  let p = vec2f(f32((i << 1u) & 2u), f32(i & 2u)); return vec4f(p * 2.0 - 1.0, 0.0, 1.0);
}
@fragment fn fs(@builtin(position) fc: vec4f) -> @location(0) vec4f {
  let px = vec2i(fc.xy);
  let col = textureLoad(sceneTex, px, 0).rgb;
  let dm = textureLoad(depthTex, px, 0);
  let uv = fc.xy * F.res.zw;
  let ndc = vec2f(uv.x * 2.0 - 1.0, 1.0 - uv.y * 2.0);
  let h = F.invViewProj * vec4f(ndc, min(dm, 0.9999), 1.0);
  let wp = h.xyz / h.w;
  let rd = normalize(wp - F.camPos.xyz);
  var D = 1e4;
  if (dm < 1.0) { D = length(wp - F.camPos.xyz); }
  let wl = aboveSea(F.camPos.xyz + rd * 0.35);
  if (wl > 0.0) {
    let hz = skyCol(normalize(vec3f(rd.x, 0.015, rd.z)));
    if (dm >= 1.0) {
      if (rd.y >= 0.0) { return vec4f(skyCol(rd), 1.0); }
      // open ocean beyond the wave mesh: flat-ish sea with Fresnel sky reflection + broad glitter, hazed
      let fr = 0.02 + 0.98 * pow(1.0 - min(-rd.y, 1.0), 5.0);
      let r = vec3f(rd.x, -rd.y, rd.z);
      var c = mix(vec3f(0.0015, 0.016, 0.055), skyCol(r), fr);
      c += SUN_E * sunTrans() * 0.35 * pow(max(dot(r, SUN_AIR), 0.0), 300.0);
      let dd = (F.origin.y + 1.6) / max(-rd.y, 1e-3);
      return vec4f(mix(c, hz, 1.0 - exp(-dd * 0.00016)), 1.0);
    }
    return vec4f(mix(col, hz, 1.0 - exp(-D * 0.00016)), 1.0);
  }
  // bilateral upsample of half-res in-scatter
  let hp = fc.xy * 0.5 - 0.5;
  let b0 = vec2i(round(hp));
  let hs = vec2i(textureDimensions(volTex)) - 1;
  var acc = vec3f(0.0); var wsum = 0.0;
  for (var y = -1; y <= 1; y++) { for (var x = -1; x <= 1; x++) {
    let q = clamp(b0 + vec2i(x, y), vec2i(0), hs);
    let v = textureLoad(volTex, q, 0);
    let dd = vec2f(q) - hp;
    let bw = exp(-dot(dd, dd) * 0.9);
    let cap = select(1e5, 48.0, F.misc.w > 150.0);          // deep: in-scatter is identical beyond the torch march
    let va = min(v.a, cap); let Dc = min(D, cap);
    let dw = exp(-abs(va - Dc) / (0.04 * min(Dc, 400.0) + 0.05));
    let w = bw * dw + 1e-4;
    acc += v.rgb * w; wsum += w;
  } }
  let ins = acc / wsum;
  let T = exp(-sigmaT() * D);
  var o = col * T + ins;
  // water meniscus across the lens right at the waterline
  let band = 1.0 - smoothstep(0.0, 0.02, abs(wl));
  o = mix(o, o * 0.55 + vec3f(0.02, 0.05, 0.06), band * 0.8);
  return vec4f(safeHDR(o), 1.0);
}
`;

// ---------------- particles: marine snow / sediment / bubbles (additive) ----------------
export const PARTICLES = /* wgsl */`
${COMMON}
${SHADOW_FN}
struct P { box: vec4f, drift: vec4f, color: vec4f, params: vec4f, om: vec4f }; // params: x size, y count, z mode (0 snow, 1 sand, 2 bubble), w brightness; om: origin mod box (xyz), floor y relative (w)
@group(1) @binding(0) var<uniform> Pp: P;
@group(1) @binding(1) var<storage, read> B: array<vec4f>;   // bubbles: xyz pos, w radius
struct VOut { @builtin(position) pos: vec4f, @location(0) q: vec2f, @location(1) col: vec3f, @location(2) a: f32, @location(3) @interpolate(flat) seed: f32 };
const SNOW_MAX: f32 = 0.85;  // max exposed luminance of a flake (bloom threshold = 1.0)
fn snowPos(i: u32) -> vec3f {
  let fi = f32(i);
  let seed = vec3f(hash11(fi * 1.13), hash11(fi * 2.71 + 3.0), hash11(fi * 0.37 + 7.0));
  let t = F.camPos.w;
  let box = Pp.box.xyz;
  var p = seed * box + Pp.drift.xyz * t * (0.6 + 0.8 * hash11(fi * 5.3));
  p += vec3f(sin(t * 0.3 + fi), sin(t * 0.21 + fi * 1.7), cos(t * 0.25 + fi * 0.9)) * 0.15;
  return (fract((p - Pp.om.xyz) / box + 0.5) - 0.5) * box;        // relative to the camera
}
@vertex fn vs(@builtin(vertex_index) vi: u32, @builtin(instance_index) ii: u32) -> VOut {
  var o: VOut;
  let corner = vec2f(f32(vi & 1u), f32((vi >> 1u) & 1u)) * 2.0 - 1.0;
  let mode = u32(Pp.params.z);
  var wp: vec3f; var size = Pp.params.x * (0.5 + hash11(f32(ii) * 3.3));
  var dustA = 0.0;
  if (mode == 2u) { let b = B[ii]; wp = b.xyz; size = b.w; if (b.w <= 0.0) { o.pos = vec4f(0.0, 0.0, -2.0, 1.0); return o; } }
  if (mode >= 3u) { let b = B[ii * 2u]; let q = B[ii * 2u + 1u]; wp = b.xyz; size = b.w; dustA = q.x; if (q.x <= 0.0) { o.pos = vec4f(0.0, 0.0, -2.0, 1.0); return o; } }
  var boxFade = 1.0;
  if (mode < 2u) { let w0 = snowPos(ii); boxFade = 1.0 - smoothstep(Pp.box.x * 0.35, Pp.box.x * 0.5, length(w0 - F.camPos.xyz)); }
  if (mode >= 2u) {}
  else {
    wp = snowPos(ii);
    if (F.wakeAx.w > 0.0) {
      // flakes caught in a passing giant's tip vortex: swirl around the vortex axis + turbulent jitter
      let r = wp - F.wake.xyz; let ax = F.wakeAx.xyz;
      let u = dot(r, ax);
      let rp = r - ax * u; let d = length(rp);
      let win = smoothstep(6.0, -2.0, u) * exp(min(u, 0.0) / F.wakeP.y);
      let fall = exp(-d * d / (F.wakeAx.w * F.wakeAx.w)) * win;
      let ang = F.wake.w * fall * (1.0 + 2.5 / (1.0 + d * 0.4));
      let cs = cos(ang); let sn = sin(ang);
      let rr = rp * cs + cross(ax, rp) * sn;                      // Rodrigues (rp ⟂ ax)
      let fi = f32(ii);
      let tt = F.camPos.w;
      let jit = vec3f(sin(tt * 2.3 + fi * 1.1), sin(tt * 1.9 + fi * 2.3), cos(tt * 2.1 + fi * 0.7)) * F.wakeP.x * fall;
      wp = F.wake.xyz + ax * u + rr + jit;
    }
    // the diver's own wake: every recent fin-stroke sample leaves a small spinning eddy that drags flakes along
    // behind the swimmer and swirls them about the swim axis; eddies grow and fade with age
    for (var k = 0; k < 8; k++) {
      let T = F.trailP[k]; let V = F.trailV[k];
      if (V.w <= 0.0) { continue; }
      let sp = length(V.xyz); if (sp < 0.05) { continue; }
      let ax = V.xyz / sp;
      let r = wp - T.xyz; let u = dot(r, ax); let rp = r - ax * u; let d = length(rp);
      let R = 0.45 + 0.35 * T.w;
      let fall = exp(-d * d / (R * R)) * exp(-u * u / (R * R * 4.0)) * V.w;
      if (fall < 0.002) { continue; }
      let ang = fall * 2.2 * select(-1.0, 1.0, (k & 1) == 0);           // alternate stroke sides -> alternating eddies
      let cs = cos(ang); let sn = sin(ang);
      let rr = rp * cs + cross(ax, rp) * sn;
      wp = T.xyz + ax * (u + fall * 0.45) + rr * (1.0 + fall * 0.25);   // entrained forward + spun + nudged outward
    }
  }
  if (mode == 1u) {
    // sand: keep in a thin layer above the floor, swept by the bottom current
    let fi = f32(ii);
    let hgt = pow(hash11(fi * 9.1), 2.2) * 1.6;
    wp.y = Pp.om.w + 0.05 + hgt + 0.1 * sin(F.camPos.w * 1.3 + fi);
  }
  var sprayK = 0.0; var surfH = 0.0;
  if (mode == 4u) {
    sprayK = B[ii * 2u + 1u].w;
    let ay = wp.y + F.origin.y;
    if (abs(ay) < 3.0) { surfH = waveHeight(wp.xz + F.origin.xz, F.camPos.w) + ripH(wp.xz + F.origin.xz); }   // only drops near the water need the real surface
    if (sprayK > 2.5 && sprayK < 3.5) { wp.y = surfH + 0.025 - F.origin.y; }                        // floating clot rides the real waves
    else if (sprayK > 0.5 && sprayK < 1.5) { wp.y = max(ay, surfH + size * 0.25) - F.origin.y; }     // flying clot lands on a crest, never sinks
    else if (sprayK > 3.5) { wp.y = min(ay, surfH - size * 0.6) - F.origin.y; }                     // bubble cloud stays under the surface
    else if (sprayK < 0.5) { dustA *= smoothstep(surfH - 0.05, surfH + 0.02, ay); }                  // drops vanish into the water they hit
  }
  if (mode != 4u && wp.y + F.origin.y > -0.05) { o.pos = vec4f(0.0, 0.0, -2.0, 1.0); return o; }
  let camD = length(wp - F.camPos.xyz);
  // screen-space motion streak from camera movement
  let c0 = F.viewProj * vec4f(wp, 1.0);
  let c1 = F.prevViewProj * vec4f(wp, 1.0);
  if (c0.w < 0.05) { o.pos = vec4f(0.0, 0.0, -2.0, 1.0); return o; }
  let s0 = c0.xy / c0.w; let s1 = c1.xy / max(c1.w, 0.05);
  let toPx = F.res.xy * 0.5;
  let velPx = (s0 - s1) * toPx;
  var radPx = size * Pp.drift.w / c0.w * toPx.y;
  var fade = min(1.0, (radPx * radPx) / (0.8 * 0.8));
  radPx = max(radPx, 0.8);
  let vl = min(length(velPx), 60.0) * 0.5;                 // half-frame shutter: short streaks, not smeared lines
  var dirv = vec2f(1.0, 0.0); if (vl > 0.3) { dirv = normalize(velPx); }
  let perp = vec2f(-dirv.y, dirv.x);
  let offPx = dirv * corner.x * (radPx + vl * 0.5) + perp * corner.y * radPx;
  let center = s0 - dirv * vl * 0.5 / toPx;
  o.pos = vec4f((center + offPx / toPx) * c0.w, c0.z, c0.w);
  o.q = corner; o.seed = hash11(f32(ii) * 7.77);
  if (mode == 4u && sprayK > 2.5 && sprayK < 3.5) {
    // landed foam lies flat on the water: a horizontal patch (foreshortened by the view), not an upright billboard
    let fw = normalize(vec3f(wp.x - F.camPos.x, 0.0, wp.z - F.camPos.z) + vec3f(1e-4, 0.0, 0.0));
    let rt = vec3f(-fw.z, 0.0, fw.x);
    o.pos = F.viewProj * vec4f(wp + (rt * corner.x + fw * corner.y) * size * 1.3, 1.0);
    fade = 1.0;
  }
  fade *= radPx / (radPx + vl * 0.5);
  // lighting at particle (vertex): flashlight (w/ shadow), ambient downwelling, bio lights
  var L = downwell(wp.y) * 0.12;
  let airDrop = mode == 4u && wp.y + F.origin.y > surfH + 0.3;          // spray in the air: sun/sky lit only (skip torch, shadows, bio lights)
  if (F.spotPos.w > 0.0 && !airDrop) {
    let sa = spotAtten(wp);
    if (sa.a > 0.001) {
      let l = normalize(wp - F.spotPos.xyz);
      let back = dot(l, normalize(F.camPos.xyz - wp));
      L += sa.rgb * sa.a * shadowVis(wp, 0.0008) * (0.35 + 0.65 * pow(max(back, 0.0), 3.0) + 0.3 * pow(max(-back, 0.0), 2.0)) * 0.9;
    }
  }
  for (var k = 0u; k < select(u32(F.misc.x), 0u, airDrop); k++) {
    let lp = F.lightPos[k]; let d = length(lp.xyz - wp);
    if (d < lp.w) { L += F.lightCol[k].rgb * exp(-sigmaT() * d) / (d * d + 0.6) * 0.25 * (1.0 - smoothstep(lp.w * 0.5, lp.w, d)); }
  }
  o.col = L * Pp.color.rgb * Pp.params.w * exp(-sigmaT() * camD);
  o.a = fade * boxFade * smoothstep(0.3, 1.1, camD) * (1.0 - smoothstep(Pp.box.x * 0.35, Pp.box.x * 0.5, camD));   // wrap seam hidden before AND after wake displacement
  if (mode == 2u) { o.col = (L * 0.8 + downwell(wp.y) * 0.25 + vec3f(0.002)) * exp(-sigmaT() * camD) * Pp.params.w; o.a = 1.0; }
  if (mode == 4u) {   // spray droplets: sunlit white in air, bluish once back under water
    let air = wp.y + F.origin.y > surfH - 0.05;
    let sunLit = SUN_E * sunTrans() * 0.12 + vec3f(0.55, 0.78, 1.25) * 0.6;
    o.col = select(L * 1.5 + downwell(wp.y) * 0.2, sunLit, air) * Pp.params.w;
    o.a = dustA * min(1.0, 0.3 + radPx * 0.5); o.seed = -1.0 - B[ii * 2u + 1u].y;
    if (sprayK > 0.5 && sprayK < 3.5 && abs(sprayK - 2.0) > 0.5) {   // torn-off clot of foam (flying or floating): matte, diffusely lit bubble mass (not a glowing point)
      o.seed = select(10.0, 40.0, sprayK > 2.5) + B[ii * 2u + 1u].y;
      o.col = select(L * 1.1 + downwell(wp.y) * 0.15, (SUN_E * sunTrans() * 0.075 + vec3f(0.5, 0.7, 1.05) * 0.5) * vec3f(0.96, 0.98, 1.0), air) * Pp.params.w;
      o.a = dustA * min(1.0, radPx * 0.35);
    }
    if (sprayK > 1.5 && sprayK < 2.5) {   // exhaled mist: soft, back-lit condensation cloud
      o.seed = 20.0 + B[ii * 2u + 1u].y;
      let toSun = max(dot(normalize(wp - F.camPos.xyz), SUN_AIR), 0.0);
      o.col = (SUN_E * sunTrans() * (0.03 + 0.05 * pow(toSun, 6.0)) + vec3f(0.55, 0.72, 1.0) * 0.35) * Pp.params.w;
      o.a = dustA;
    }
    if (sprayK > 3.5) {   // underwater bubble cloud: milky white, lit by the light filtering down (and the torch)
      o.seed = 30.0 + B[ii * 2u + 1u].y;
      let dz = max(-(wp.y + F.origin.y), 0.0);
      let cc = downwell(wp.y) * 1.2 + SUN_E * sunTrans() * 0.035 * exp(-dz * 0.35) * vec3f(0.6, 0.85, 1.0) + L * 1.2;
      o.col = mix(cc, vec3f(dot(cc, vec3f(0.2126, 0.7152, 0.0722))), 0.85) * 0.7 * exp(-sigmaT() * camD) * Pp.params.w;   // milky white, only faintly tinted
      o.a = dustA * smoothstep(0.2, 1.0, camD);
    }
  }
  if (mode == 3u) {
    let qd = B[ii * 2u + 1u];
    if (qd.z > 0.5) { o.a = dustA * smoothstep(0.1, 0.4, camD) * min(1.0, 0.35 + radPx * 0.4); o.seed = -1.0 - qd.y; o.col *= 1.6; }   // sand grain: a crisp speck
    else { o.a = dustA * smoothstep(0.15, 0.8, camD) * min(1.0, radPx * radPx / 4.0); o.seed = qd.y; }
  }
  return o;
}
@fragment fn fs(in: VOut) -> @location(0) vec4f {
  var q = in.q;
  var r = length(q);
  if (u32(Pp.params.z) < 2u) {
    // irregular flake: random elongation, rotation and lobed outline per particle
    let s = in.seed; let an = s * 6.2831;
    let cs = vec2f(cos(an), sin(an));
    q = vec2f(q.x * cs.x - q.y * cs.y, q.x * cs.y + q.y * cs.x) * vec2f(1.0, 1.0 + 1.6 * fract(s * 13.1));
    let th = atan2(q.y, q.x);
    let lob = 1.0 + 0.35 * sin(th * (2.0 + floor(fract(s * 7.3) * 4.0)) + s * 40.0) + 0.2 * sin(th * 7.0 + s * 91.0);
    r = length(q) * lob;
  }
  if (r > 1.0) { discard; }
  var a = (1.0 - r * r);
  if (u32(Pp.params.z) == 4u && in.seed >= 30.0 && in.seed < 40.0) {
    // cloud of fine bubbles: soft lumpy body with bright specks of individual bubbles
    let s = fract(in.seed); let th = atan2(q.y, q.x);
    let rr = r / (0.8 + 0.12 * sin(th * 2.0 + s * 40.0) + 0.08 * sin(th * 3.0 + s * 17.0));
    if (rr > 1.0) { discard; }
    let g = q * 14.0 + vec2f(s * 31.0, s * 13.0);
    let h = fract(sin(dot(floor(g), vec2f(127.1, 311.7))) * 43758.5453);
    let speck = step(0.8, h) * (1.0 - smoothstep(0.15, 0.4, length(fract(g) - 0.5)));
    let a = pow(1.0 - rr * rr, 2.6) * (0.22 + 0.12 * sin(q.x * 3.3 + s * 9.0) * sin(q.y * 2.9 + s * 5.0)) + speck * 0.3 * (1.0 - rr) * (1.0 - rr);
    return vec4f(safeHDR(in.col * a * in.a), 0.0);
  }
  if (u32(Pp.params.z) == 4u && in.seed >= 20.0 && in.seed < 30.0) {
    let s = fract(in.seed); let th = atan2(q.y, q.x);
    let rr = r / (0.85 + 0.1 * sin(th * 2.0 + s * 40.0) + 0.05 * sin(th * 3.0 + s * 17.0));
    if (rr > 1.0) { discard; }
    let a = pow(1.0 - rr * rr, 2.2) * (0.75 + 0.25 * sin(q.x * 3.0 + s * 9.0) * sin(q.y * 2.6 + s * 5.0)) * 0.35;
    return vec4f(safeHDR(in.col * a * in.a), 0.0);
  }
  if (u32(Pp.params.z) == 4u && (in.seed >= 40.0 || (in.seed >= 10.0 && in.seed < 20.0))) {
    let flat = in.seed >= 40.0;
    // foam clot: an irregular cluster of bubbles.  Lumpy low-frequency outline, cell structure inside (bright bubble
    // caps, thin dim films between them), lit from above and self-shadowed underneath, crisp but soft-edged rim
    let s = fract(in.seed); let an = s * 6.2831;
    let cs = vec2f(cos(an), sin(an));
    let p = vec2f(q.x * cs.x - q.y * cs.y, q.x * cs.y + q.y * cs.x) * vec2f(1.0, 1.0 + 0.7 * fract(s * 13.1));
    // ragged clump: metaball of 5 sub-blobs (never a round disc), bubbly cells inside
    var fld = 0.0;
    for (var k = 0; k < 5; k++) {
      let fk = f32(k);
      let hc = fract(sin(vec3f(s * 91.7 + fk * 13.1, s * 47.3 + fk * 7.9, s * 23.9 + fk * 3.3)) * 43758.5453);
      let dd = p - (hc.xy - 0.5) * 0.9;
      let sz = 0.14 + 0.24 * hc.z;
      fld += exp(-dot(dd, dd) / (sz * sz));
    }
    if (fld < 0.4) { discard; }
    let rr = 1.0 - smoothstep(0.4, 1.1, fld);
    let g = p * 3.2 + vec2f(s * 17.0, s * 29.0);
    let gi = floor(g); var d1 = 9.0; var d2 = 9.0; var rad = 0.5;
    for (var j = -1; j <= 1; j++) { for (var i = -1; i <= 1; i++) {
      let c = gi + vec2f(f32(i), f32(j));
      let h = fract(sin(vec2f(dot(c, vec2f(127.1, 311.7)), dot(c, vec2f(269.5, 183.3)))) * 43758.5453);
      let dd = length(g - c - h);
      if (dd < d1) { d2 = d1; d1 = dd; rad = h.x; } else if (dd < d2) { d2 = dd; }
    } }
    let film = smoothstep(0.0, 0.12, d2 - d1);                      // dim film between neighbouring bubbles
    let cap = 1.0 - smoothstep(0.0, 0.55 + 0.25 * rad, d1);          // rounded bubble cap
    let shade = select(0.55 + 0.45 * smoothstep(-0.9, 0.7, q.y), 0.85, flat);   // lit top, shadowed underside (flat: evenly lit)
    let body = (0.45 + 0.55 * cap) * mix(0.35, 1.0, film) * shade;
    let rim = 1.0 - smoothstep(0.72, 1.0, rr);
    let c = in.col * body * rim * in.a;
    return vec4f(safeHDR(c), 0.0);
  }
  if (u32(Pp.params.z) >= 3u && in.seed < 0.0) {
    a = 1.0 - r * r;                                                      // sand grain
  } else if (u32(Pp.params.z) == 3u) {
    // silt cloud: soft billowing blob with a lumpy outline
    let th = atan2(q.y, q.x);
    let lump = 0.9 + 0.1 * sin(th * 2.0 + in.seed * 40.0) + 0.05 * sin(th * 3.0 + in.seed * 17.0);
    let rr = r / lump;
    if (rr > 1.0) { discard; }
    a = pow(1.0 - rr * rr, 2.6) * (0.8 + 0.2 * sin(q.x * 4.0 + in.seed * 9.0) * sin(q.y * 3.5 + in.seed * 3.0));
  }
  if (u32(Pp.params.z) == 2u) {
    // air bubble: mirror-like (total internal reflection) silvery rim, faint body, specular glint
    let rim = pow(r, 5.0);
    a = 0.12 + rim * 1.1 * (1.0 - smoothstep(0.93, 1.0, r)) + 1.2 * pow(max(1.0 - length(in.q - vec2f(-0.35, 0.4)) * 3.2, 0.0), 2.0);
  }
  var c = in.col * a * in.a;
  if (u32(Pp.params.z) != 2u) {
    // keep suspended matter out of the bloom: soft-cap each flake's on-screen (exposed) luminance below the bloom threshold
    let L = dot(c, vec3f(0.2126, 0.7152, 0.0722)) * F.kd.w;
    let knee = SNOW_MAX * 0.5;
    if (L > knee) { c *= (knee + knee * (1.0 - exp(-(L - knee) / knee))) / L; }
  }
  return vec4f(safeHDR(c), 0.0);
}
`;

// ---------------- bioluminescent jellyfish (instanced, procedural, additive) ----------------
export const JELLY = /* wgsl */`
${COMMON}
${SHADOW_FN}
struct J { pos: vec4f, col: vec4f, dir: vec4f }; // pos.w = size, col.w = phase, dir.xyz = tilt axis, dir.w = kind
@group(1) @binding(0) var<storage, read> Js: array<J>;
struct VOut { @builtin(position) pos: vec4f, @location(0) wp: vec3f, @location(1) n: vec3f, @location(2) k: vec3f, @location(3) @interpolate(flat) ii: u32 };
@vertex fn vs(@location(0) a: vec4f, @builtin(instance_index) ii: u32) -> VOut {
  // a: x = angle, y = v (0 top..1 rim) or tentacle t, z = kind (0 bell outer, 1 bell inner, 2 tentacle, 3 oral arm), w = side
  let jj = Js[ii]; let t = F.camPos.w; let ph = jj.col.w; let sz = jj.pos.w;
  let pulse = sin(t * 1.6 + ph);
  let ang = a.x; let kind = u32(a.z);
  var p: vec3f; var n: vec3f;
  let cs = vec2f(cos(ang), sin(ang));
  if (kind <= 1u) {
    let v = a.y;
    let rr = sin(min(v, 1.0) * 1.62) * (1.0 + 0.18 * pulse * v * v) * (1.0 + 0.04 * sin(ang * 8.0) * v);
    let yy = cos(v * 1.5) * 0.75 * (1.0 - 0.12 * pulse) - v * v * 0.1;
    let inner = select(1.0, 0.86, kind == 1u);
    p = vec3f(cs.x * rr, yy, cs.y * rr) * inner;
    n = normalize(vec3f(cs.x * sin(v * 1.6), cos(v * 1.6) * 0.8, cs.y * sin(v * 1.6)));
  } else {
    let tt = a.y;
    let rim = sin(1.62) * (1.0 + 0.18 * pulse);
    let rad = select(rim * 0.97, 0.18, kind == 3u);
    let len = select(3.2, 1.3, kind == 3u);
    var base = vec3f(cs.x * rad, cos(1.5) * 0.75 - 0.1, cs.y * rad);
    let sway = vec3f(sin(t * 0.7 + ph + tt * 3.0 + ang * 2.0), 0.0, cos(t * 0.6 + ph * 1.3 + tt * 2.5 + ang)) * tt * tt * 0.35;
    p = base + vec3f(0.0, -tt * len, 0.0) + sway + vec3f(cs.x, 0.0, cs.y) * tt * 0.15 * (1.0 + pulse * 0.3);
    let wv = F.camPos.xyz - (jj.pos.xyz + p * sz);
    let side = normalize(cross(vec3f(0.0, 1.0, 0.0), wv));
    p += side * a.w * select(0.012, 0.045, kind == 3u) * (1.0 - tt * 0.6);
    n = normalize(wv);
  }
  let wp = jj.pos.xyz + p * sz;
  var o: VOut; o.pos = F.viewProj * vec4f(wp, 1.0); o.wp = wp; o.n = n; o.k = vec3f(a.y, f32(kind), ang); o.ii = ii;
  return o;
}
@fragment fn fs(in: VOut, @builtin(front_facing) ff: bool) -> @location(0) vec4f {
  let jj = Js[in.ii]; let t = F.camPos.w;
  let v = normalize(F.camPos.xyz - in.wp);
  let n = normalize(in.n);
  let kind = u32(in.k.y);
  let camD = length(F.camPos.xyz - in.wp);
  var glow = 0.0; var body = 0.0;
  let wave = 0.5 + 0.5 * sin(t * 2.2 + jj.col.w * 2.0 - in.k.x * 9.0);
  if (kind <= 1u) {
    let rim = pow(max(1.0 - abs(dot(n, v)), 0.0), 2.2);
    let canals = pow(0.5 + 0.5 * cos(in.k.z * 8.0), 18.0) * smoothstep(0.1, 0.9, in.k.x);
    let spots = smoothstep(0.85, 0.95, in.k.x) * pow(0.5 + 0.5 * cos(in.k.z * 16.0), 6.0);
    glow = canals * 0.5 + spots * 1.5 * wave + rim * 0.2;
    body = rim * 0.35 + 0.04;
    if (kind == 1u) { body *= 0.5; glow *= 0.6; }
  } else {
    glow = (0.3 + 0.9 * wave) * (1.0 - in.k.x * 0.7);
    body = 0.08;
  }
  let emissive = jj.col.rgb * glow * 0.09;
  // translucent body lit by flashlight + ambient
  var lit = downwell(in.wp.y) * 0.05;
  if (F.spotPos.w > 0.0) { let sa = spotAtten(in.wp); lit += sa.rgb * sa.a * 0.25; }
  let c = (emissive + lit * body * 0.4 * vec3f(0.8, 0.9, 1.0)) * exp(-sigmaT() * camD);
  return vec4f(safeHDR(c), 0.0);
}
`;

// ---------------- bloom + final ----------------
export const FULLSCREEN_VS = /* wgsl */`
@vertex fn vs(@builtin(vertex_index) i: u32) -> @builtin(position) vec4f {
  let p = vec2f(f32((i << 1u) & 2u), f32(i & 2u)); return vec4f(p * 2.0 - 1.0, 0.0, 1.0);
}`;

export const BLOOM_DOWN = /* wgsl */`
${FULLSCREEN_VS}
@group(0) @binding(0) var src: texture_2d<f32>;
@group(0) @binding(1) var smp: sampler;
@group(0) @binding(2) var<uniform> U: vec4f; // xy = 1/src size, z = first pass (threshold)
@fragment fn fs(@builtin(position) fc: vec4f) -> @location(0) vec4f {
  let dst = vec2f(textureDimensions(src)) * 0.5;
  let uv = fc.xy / dst; let o = U.xy;
  var c = textureSampleLevel(src, smp, uv, 0.0).rgb * 0.125;
  c += (textureSampleLevel(src, smp, uv + vec2f(-o.x, -o.y), 0.0).rgb + textureSampleLevel(src, smp, uv + vec2f(o.x, -o.y), 0.0).rgb
      + textureSampleLevel(src, smp, uv + vec2f(-o.x, o.y), 0.0).rgb + textureSampleLevel(src, smp, uv + vec2f(o.x, o.y), 0.0).rgb) * 0.125;
  c += (textureSampleLevel(src, smp, uv + vec2f(-2.0 * o.x, 0.0), 0.0).rgb + textureSampleLevel(src, smp, uv + vec2f(2.0 * o.x, 0.0), 0.0).rgb
      + textureSampleLevel(src, smp, uv + vec2f(0.0, -2.0 * o.y), 0.0).rgb + textureSampleLevel(src, smp, uv + vec2f(0.0, 2.0 * o.y), 0.0).rgb) * 0.0625;
  c += (textureSampleLevel(src, smp, uv + vec2f(-2.0 * o.x, -2.0 * o.y), 0.0).rgb + textureSampleLevel(src, smp, uv + vec2f(2.0 * o.x, -2.0 * o.y), 0.0).rgb
      + textureSampleLevel(src, smp, uv + vec2f(-2.0 * o.x, 2.0 * o.y), 0.0).rgb + textureSampleLevel(src, smp, uv + vec2f(2.0 * o.x, 2.0 * o.y), 0.0).rgb) * 0.03125;
  c = select(c, vec3f(0.0), c != c);
  if (U.z > 0.5) { let l = max(c.r, max(c.g, c.b)); c *= smoothstep(U.w * 0.5, U.w * 2.0, l); c = min(c, vec3f(U.w * 60.0)); }
  return vec4f(c, 1.0);
}`;

export const BLOOM_UP = /* wgsl */`
${FULLSCREEN_VS}
@group(0) @binding(0) var src: texture_2d<f32>;
@group(0) @binding(1) var smp: sampler;
@group(0) @binding(2) var<uniform> U: vec4f;
@fragment fn fs(@builtin(position) fc: vec4f) -> @location(0) vec4f {
  let dst = vec2f(textureDimensions(src)) * 2.0;
  let uv = fc.xy / dst; let o = U.xy;
  var c = textureSampleLevel(src, smp, uv, 0.0).rgb * 4.0;
  c += (textureSampleLevel(src, smp, uv + vec2f(-o.x, 0.0), 0.0).rgb + textureSampleLevel(src, smp, uv + vec2f(o.x, 0.0), 0.0).rgb
      + textureSampleLevel(src, smp, uv + vec2f(0.0, -o.y), 0.0).rgb + textureSampleLevel(src, smp, uv + vec2f(0.0, o.y), 0.0).rgb) * 2.0;
  c += textureSampleLevel(src, smp, uv + vec2f(-o.x, -o.y), 0.0).rgb + textureSampleLevel(src, smp, uv + vec2f(o.x, -o.y), 0.0).rgb
      + textureSampleLevel(src, smp, uv + vec2f(-o.x, o.y), 0.0).rgb + textureSampleLevel(src, smp, uv + vec2f(o.x, o.y), 0.0).rgb;
  return vec4f(c / 16.0 * U.z, 1.0);
}`;

export const FINAL = /* wgsl */`
${FULLSCREEN_VS}
struct U { res: vec4f, p: vec4f, q: vec4f, r: vec4f };   // r.x: clear-shallows grade amount  // p: x exposure, y bloom, z time, w underwater ; q: x flash (white-out), y vignette, z damage/red, w fade
@group(0) @binding(0) var comp: texture_2d<f32>;
@group(0) @binding(1) var bloomTex: texture_2d<f32>;
@group(0) @binding(2) var smp: sampler;
@group(0) @binding(3) var<uniform> Uf: U;
fn aces(x: vec3f) -> vec3f {
  let m1 = mat3x3f(0.59719, 0.07600, 0.02840, 0.35458, 0.90834, 0.13383, 0.04823, 0.01566, 0.83777);
  let m2 = mat3x3f(1.60475, -0.10208, -0.00327, -0.53108, 1.10813, -0.07276, -0.07367, -0.00605, 1.07602);
  let v = m1 * x; let a = v * (v + 0.0245786) - 0.000090537; let b = v * (0.983729 * v + 0.4329510) + 0.238081;
  return clamp(m2 * (a / b), vec3f(0.0), vec3f(1.0));
}
fn h(p: vec2f) -> f32 { var q = fract(p * vec2f(443.897, 441.423)); q += dot(q, q.yx + 19.19); return fract((q.x + q.y) * q.x); }
@fragment fn fs(@builtin(position) fc: vec4f) -> @location(0) vec4f {
  let uv = fc.xy * Uf.res.zw;
  let cc = uv - 0.5;
  let r2 = dot(cc, cc);
  // subtle visor refraction at the edge + chromatic aberration
  let warp = uv - cc * r2 * 0.06 * Uf.p.w;
  let ca = cc * r2 * 0.012;
  var col = vec3f(textureSampleLevel(comp, smp, warp + ca, 0.0).r, textureSampleLevel(comp, smp, warp, 0.0).g, textureSampleLevel(comp, smp, warp - ca, 0.0).b);
  col += textureSampleLevel(bloomTex, smp, warp, 0.0).rgb * Uf.p.y;
  col = select(min(col, vec3f(1e4)), vec3f(0.0), col != col);
  col *= Uf.p.x;
  // clear open-ocean shallows: teal-cyan cast (reference photos), fades with depth
  col *= mix(vec3f(1.0), vec3f(0.72, 1.1, 0.98), Uf.r.x);
  let lum = dot(col, vec3f(0.2126, 0.7152, 0.0722));
  let scot = Uf.p.w * max((1.0 - smoothstep(0.004, 0.12, lum)) * 0.75, Uf.q.z);
  col = mix(col, lum * vec3f(0.62, 0.85, 1.15), scot);
  // ACES shifts saturated blues toward purple: blend with a hue-preserving (luminance-driven) curve
  let lin = max(dot(col, vec3f(0.2126, 0.7152, 0.0722)), 1e-5);
  let hp = col * (aces(vec3f(lin)).x / lin);
  col = mix(aces(col), clamp(hp, vec3f(0.0), vec3f(1.0)), 0.55);
  col = pow(col, vec3f(1.0 / 2.2));
  let vig = 1.0 - Uf.q.y * smoothstep(0.18, 0.72, r2 * 1.9);
  col *= vig;
  col += (h(fc.xy) - 0.5) * (1.0 / 255.0);                  // static sub-LSB dither only (no animated film grain)
  col = mix(col, vec3f(1.0), Uf.q.x);
  col *= Uf.q.w;
  return vec4f(col, 1.0);
}`;

export const BLIT = /* wgsl */`
${FULLSCREEN_VS}
@group(0) @binding(0) var src: texture_2d<f32>;
@group(0) @binding(1) var smp: sampler;
@fragment fn fs(@builtin(position) fc: vec4f) -> @location(0) vec4f {
  let dst = vec2f(textureDimensions(src)) * 0.5;
  return textureSampleLevel(src, smp, fc.xy / max(floor(dst), vec2f(1.0)), 0.0);
}`;

// ---------------- FXAA (post tone-map, on the gamma-encoded image) ----------------
export const FXAA = /* wgsl */`
${FULLSCREEN_VS}
@group(0) @binding(0) var src: texture_2d<f32>;
@group(0) @binding(1) var smp: sampler;
fn luma(c: vec3f) -> f32 { return dot(c, vec3f(0.299, 0.587, 0.114)); }
@fragment fn fs(@builtin(position) fc: vec4f) -> @location(0) vec4f {
  let res = vec2f(textureDimensions(src)); let px = 1.0 / res; let uv = fc.xy * px;
  let rgbM = textureSampleLevel(src, smp, uv, 0.0).rgb;
  let lNW = luma(textureSampleLevel(src, smp, uv + vec2f(-1.0, -1.0) * px, 0.0).rgb);
  let lNE = luma(textureSampleLevel(src, smp, uv + vec2f(1.0, -1.0) * px, 0.0).rgb);
  let lSW = luma(textureSampleLevel(src, smp, uv + vec2f(-1.0, 1.0) * px, 0.0).rgb);
  let lSE = luma(textureSampleLevel(src, smp, uv + vec2f(1.0, 1.0) * px, 0.0).rgb);
  let lM = luma(rgbM);
  let lMin = min(lM, min(min(lNW, lNE), min(lSW, lSE)));
  let lMax = max(lM, max(max(lNW, lNE), max(lSW, lSE)));
  if (lMax - lMin < max(0.0156, lMax * 0.063)) { return vec4f(rgbM, 1.0); }   // stronger: treat fainter edges too
  var dir = vec2f(-((lNW + lNE) - (lSW + lSE)), (lNW + lSW) - (lNE + lSE));
  let red = max((lNW + lNE + lSW + lSE) * 0.25 * 0.125, 1.0 / 128.0);
  let rcp = 1.0 / (min(abs(dir.x), abs(dir.y)) + red);
  dir = clamp(dir * rcp, vec2f(-8.0), vec2f(8.0)) * px;
  let rgbA = 0.5 * (textureSampleLevel(src, smp, uv + dir * (1.0 / 3.0 - 0.5), 0.0).rgb + textureSampleLevel(src, smp, uv + dir * (2.0 / 3.0 - 0.5), 0.0).rgb);
  let rgbB = rgbA * 0.5 + 0.25 * (textureSampleLevel(src, smp, uv - dir * 0.5, 0.0).rgb + textureSampleLevel(src, smp, uv + dir * 0.5, 0.0).rgb);
  let lB = luma(rgbB);
  var outc = select(rgbB, rgbA, lB < lMin || lB > lMax);
  // sub-pixel aliasing (thin rails, wires, distant crests): blend toward the local average by how much the centre
  // pixel stands out from its neighbourhood
  let avgL = (lNW + lNE + lSW + lSE) * 0.25;
  let sub = clamp(abs(avgL - lM) / max(lMax - lMin, 1e-4), 0.0, 1.0);
  let blend = sub * sub * 0.6;
  let avgC = 0.25 * (textureSampleLevel(src, smp, uv + vec2f(-0.5, -0.5) * px, 0.0).rgb + textureSampleLevel(src, smp, uv + vec2f(0.5, -0.5) * px, 0.0).rgb
                   + textureSampleLevel(src, smp, uv + vec2f(-0.5, 0.5) * px, 0.0).rgb + textureSampleLevel(src, smp, uv + vec2f(0.5, 0.5) * px, 0.0).rgb);
  outc = mix(outc, avgC, blend);
  return vec4f(outc, 1.0);
}`;

// ---------------- exhaled air bubbles: sphere/spheroid impostors with water->air optics ----------------
export const BUBBLE = /* wgsl */`
${COMMON}
${SHADOW_FN}
@group(1) @binding(0) var<uniform> Pp: vec4f;
@group(1) @binding(1) var<storage, read> B: array<vec4f>;   // xyz position (camera-relative), w radius (m)
struct VOut { @builtin(position) pos: vec4f, @location(0) q: vec2f, @location(1) @interpolate(flat) id: u32,
  @location(2) R: vec3f, @location(3) U: vec3f, @location(4) Bk: vec3f, @location(5) wp: vec3f, @location(6) r: f32 };
@vertex fn vs(@builtin(vertex_index) vi: u32, @builtin(instance_index) ii: u32) -> VOut {
  var o: VOut;
  let b = B[ii];
  if (b.w <= 0.0) { o.pos = vec4f(0.0, 0.0, -2.0, 1.0); return o; }
  let corner = vec2f(f32(vi & 1u), f32((vi >> 1u) & 1u)) * 2.0 - 1.0;
  let toCam = normalize(F.camPos.xyz - b.xyz);
  var R = normalize(cross(vec3f(0.0, 1.0, 0.0), toCam)); if (length(cross(vec3f(0.0, 1.0, 0.0), toCam)) < 1e-3) { R = vec3f(1.0, 0.0, 0.0); }
  let U = cross(toCam, R);
  // large bubbles flatten into wobbling caps
  let big = clamp((b.w - 0.004) / 0.012, 0.0, 1.0);
  let t = F.camPos.w * 9.0 + f32(ii) * 1.7;
  // oblate along WORLD vertical (real rising caps), not along the screen axis: seen from below they stay round
  let sx = 1.0 + big * (0.12 + 0.05 * sin(t));
  let sy = 1.0 - big * (0.25 + 0.05 * sin(t + 1.3));
  var off = (R * corner.x + U * corner.y) * b.w;
  off = vec3f(off.x * sx, off.y * sy, off.z * sx);
  let wp = b.xyz + off;
  o.pos = F.viewProj * vec4f(wp, 1.0); o.q = corner; o.id = ii; o.R = R; o.U = U; o.Bk = toCam; o.wp = b.xyz; o.r = b.w;
  return o;
}
@fragment fn fs(in: VOut) -> @location(0) vec4f {
  let rr = dot(in.q, in.q);
  if (rr > 1.0) { discard; }
  let nz = sqrt(1.0 - rr);
  let n = normalize(in.R * in.q.x + in.U * in.q.y + in.Bk * nz);
  let v = in.Bk;
  // water -> air Fresnel: total internal reflection toward the rim
  let cosI = clamp(dot(n, v), 0.0, 1.0);
  let sinT2 = 1.777 * (1.0 - cosI * cosI);
  var Fr = 1.0;
  if (sinT2 < 1.0) {
    let cosT = sqrt(1.0 - sinT2);
    let rs = (1.333 * cosI - cosT) / (1.333 * cosI + cosT); let rp = (1.333 * cosT - cosI) / (1.333 * cosT + cosI);
    Fr = 0.5 * (rs * rs + rp * rp);
  }
  // mirror rim reflects the surrounding water and the bright light from the surface above
  let rf = reflect(-v, n);
  let env = ambientInscatter(in.wp, rf, 60.0) * 1.6 + ambientInscatter(in.wp, -v, 60.0) * 0.5 + downwell(in.wp.y) * 0.35 * pow(max(rf.y, 0.0), 4.0);
  // interior: water seen through the bubble (slightly brighter) + focus spot of light refracted from above
  let interior = ambientInscatter(in.wp, -v, 60.0) * 1.15 + downwell(in.wp.y) * 0.08 * exp(-(in.q.x * in.q.x + (in.q.y + 0.4) * (in.q.y + 0.4)) * 10.0);
  var col = env * Fr;
  // torch / bioluminescent glints
  if (F.spotPos.w > 0.0) {
    let sa = spotAtten(in.wp);
    if (sa.a > 0.001) {
      let l = normalize(F.spotPos.xyz - in.wp);
      col += min(sa.rgb * sa.a, vec3f(3.0)) * (pow(max(dot(n, normalize(l + v)), 0.0), 180.0) * 0.6 + Fr * 0.04);   // small glint, not a lamp
    }
  }
  for (var k = 0u; k < u32(F.misc.x); k++) {
    let lp = F.lightPos[k]; let d = length(lp.xyz - in.wp);
    if (d < lp.w) { let l = (lp.xyz - in.wp) / d; col += F.lightCol[k].rgb / (d * d + 0.3) * pow(max(dot(n, normalize(l + v)), 0.0), 120.0) * 2.0; }
  }
  let T = exp(-sigmaT() * length(F.camPos.xyz - in.wp));
  // the rim mirrors the surrounding water (about as bright as what it hides) -> keep it translucent so it never reads as a dark outline
  let a = clamp(Fr * 0.45 + 0.03, 0.0, 1.0);
  let prem = safeHDR((col + interior * (1.0 - a) * 0.15) * T);
  return vec4f(prem, a * dot(T, vec3f(0.3333)));
}`;

// ---- environment cube bake: one face/mip per draw, GGX-prefiltered analytic radiance ----
export const ENV_BAKE = /* wgsl */`
${COMMON}
@group(1) @binding(0) var<uniform> B: vec4f;   // face, level, mode (0 air, 1 water), size
fn seaFromAbove(d: vec3f) -> vec3f {
  let cosT = max(-d.y, 0.0);
  let fr = 0.02 + 0.98 * pow(1.0 - cosT, 5.0);
  let r = vec3f(d.x, -d.y, d.z);
  return mix(vec3f(0.0015, 0.016, 0.055) * 1.2 + vec3f(0.004, 0.02, 0.03), skyCol(r), fr);
}
fn envRad(d: vec3f) -> vec3f {
  if (B.z < 0.5) {
    if (d.y >= 0.0) { return min(skyCol(d), vec3f(30.0)); }
    return seaFromAbove(d);
  }
  let p = F.camPos.xyz;
  // Snell's window: the whole sky squeezed into a 48.6° cone overhead, bright rim at its edge, dimmed by depth
  let win = smoothstep(0.62, 0.7, d.y);
  let rim = exp(-pow((d.y - 0.665) / 0.035, 2.0)) * 0.6;
  let sunLobe = pow(max(dot(d, F.sunDir.xyz), 0.0), 64.0) * 4.0;
  let zen = downwell(p.y) * (0.9 * win + rim + sunLobe * win) * 0.55;
  return ambientInscatter(p, d, 80.0) * 1.4 + zen;
}
fn faceDir(f: i32, u: f32, v: f32) -> vec3f {
  switch f {
    case 0: { return normalize(vec3f(1.0, -v, -u)); }
    case 1: { return normalize(vec3f(-1.0, -v, u)); }
    case 2: { return normalize(vec3f(u, 1.0, v)); }
    case 3: { return normalize(vec3f(u, -1.0, -v)); }
    case 4: { return normalize(vec3f(u, -v, 1.0)); }
    default: { return normalize(vec3f(-u, -v, -1.0)); }
  }
}
@vertex fn vs(@builtin(vertex_index) i: u32) -> @builtin(position) vec4f {
  let p = vec2f(f32((i << 1u) & 2u), f32(i & 2u)) * 2.0 - 1.0; return vec4f(p, 0.0, 1.0);
}
@fragment fn fs(@builtin(position) fc: vec4f) -> @location(0) vec4f {
  let uv = fc.xy / B.w * 2.0 - 1.0;
  let N = faceDir(i32(B.x), uv.x, uv.y);
  let rough = (B.y / 5.0) * (B.y / 5.0);
  if (B.y < 0.5) { return vec4f(envRad(N), 1.0); }
  let a = max(rough * rough, 1e-4);
  let up = select(vec3f(1.0, 0.0, 0.0), vec3f(0.0, 1.0, 0.0), abs(N.y) < 0.99);
  let T = normalize(cross(up, N)); let Bt = cross(N, T);
  var acc = vec3f(0.0); var w = 0.0;
  let NS = 48u;
  for (var k = 0u; k < NS; k++) {
    // Hammersley + GGX half-vector
    var bits = k; bits = (bits << 16u) | (bits >> 16u); bits = ((bits & 0x55555555u) << 1u) | ((bits & 0xAAAAAAAAu) >> 1u);
    bits = ((bits & 0x33333333u) << 2u) | ((bits & 0xCCCCCCCCu) >> 2u); bits = ((bits & 0x0F0F0F0Fu) << 4u) | ((bits & 0xF0F0F0F0u) >> 4u);
    bits = ((bits & 0x00FF00FFu) << 8u) | ((bits & 0xFF00FF00u) >> 8u);
    let xi = vec2f(f32(k) / f32(NS), f32(bits) * 2.3283064365386963e-10);
    let phi = 6.2831853 * xi.x;
    let ct = sqrt((1.0 - xi.y) / (1.0 + (a * a - 1.0) * xi.y)); let st = sqrt(1.0 - ct * ct);
    let H = T * (st * cos(phi)) + Bt * (st * sin(phi)) + N * ct;
    let L = normalize(2.0 * dot(N, H) * H - N);
    let nl = dot(N, L);
    if (nl > 0.0) { acc += envRad(L) * nl; w += nl; }
  }
  return vec4f(acc / max(w, 1e-4), 1.0);
}`;
