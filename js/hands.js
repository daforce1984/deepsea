// First-person gear: rigged WebXR hands in dive gloves, suit sleeves, dive torch (spot light source) and wrist dive computer.
import { m4, v3, clamp, lerp, smooth, rel } from './math.js';
import { Pose, decompose } from './gltf.js';

const FINGERS = ['index-finger', 'middle-finger', 'ring-finger', 'pinky-finger'];
const PH = ['phalanx-proximal', 'phalanx-intermediate', 'phalanx-distal'];
const qAxis = (ax, a) => { const s = Math.sin(a / 2); return [ax[0] * s, ax[1] * s, ax[2] * s, Math.cos(a / 2)]; };
const qMul = (a, b) => [a[3] * b[0] + a[0] * b[3] + a[1] * b[2] - a[2] * b[1], a[3] * b[1] - a[0] * b[2] + a[1] * b[3] + a[2] * b[0], a[3] * b[2] + a[0] * b[1] - a[1] * b[0] + a[2] * b[3], a[3] * b[3] - a[0] * b[0] - a[1] * b[1] - a[2] * b[2]];
const ortho = (F, P) => { const f = v3.norm(F); const p = v3.norm(v3.sub(P, v3.scale(f, v3.dot(P, f)))); return [f, p, v3.cross(f, p)]; };
// rotation taking model basis (Fm,Pm,Tm) to target basis (F,P,T), placed so model point `pivot` lands on `at`
function frame(Bm, Bt, pivot, at) {
  const R = new Float32Array(16); R[15] = 1;
  for (let c = 0; c < 3; c++) for (let r = 0; r < 3; r++) R[c * 4 + r] = Bt[0][r] * Bm[0][c] + Bt[1][r] * Bm[1][c] + Bt[2][r] * Bm[2][c];
  const p = m4.xform(R, pivot); R[12] = at[0] - p[0]; R[13] = at[1] - p[1]; R[14] = at[2] - p[2];
  return R;
}

// tileable rubber/neoprene grain as a tangent-space normal map
function rubberGrain(n) {
  const c = new OffscreenCanvas(n, n), g = c.getContext('2d'), img = g.createImageData(n, n);
  const h = new Float32Array(n * n);
  for (let i = 0; i < n * n; i++) h[i] = Math.random();
  const blur = (a) => { const o = new Float32Array(n * n); for (let y = 0; y < n; y++) for (let x = 0; x < n; x++) { let s = 0; for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) s += a[((y + dy + n) % n) * n + ((x + dx + n) % n)]; o[y * n + x] = s / 9; } return o; };
  const hh = blur(h);
  for (let y = 0; y < n; y++) for (let x = 0; x < n; x++) {
    const dx = hh[y * n + (x + 1) % n] - hh[y * n + (x - 1 + n) % n], dy = hh[((y + 1) % n) * n + x] - hh[((y - 1 + n) % n) * n + x];
    const nx = -dx * 3, ny = -dy * 3, l = Math.hypot(nx, ny, 1), o = (y * n + x) * 4;
    img.data[o] = (nx / l * 0.5 + 0.5) * 255; img.data[o + 1] = (ny / l * 0.5 + 0.5) * 255; img.data[o + 2] = (1 / l * 0.5 + 0.5) * 255; img.data[o + 3] = 255;
  }
  g.putImageData(img, 0, 0);
  return c;
}

export class Hands {
  constructor(R, models) {
    this.R = R;
    this.torchPos = [0, 0, 0]; this.torchDir = [0, 0, -1]; this.torchPower = 0; this.raise = 0;
    this.draws = []; this.light = null;
    const gear = { gear: true };
    this.torch = this.staticModel(models.torch, gear);
    this.dc = this.staticModel(models.divecomputer, gear);
    const grain = rubberGrain(256);   // shared rubber/neoprene grain
    const suit = { gear: true, matByName: { Suit: { rough: 0.75, color: [0.016, 0.017, 0.019, 1], normalTex: null }, SuitPlate: { rough: 0.55 } } };
    this.sleeveR = this.staticModel(models.sleeve, suit);
    this.sleeveL = this.staticModel(models.sleeve, suit);
    this.lens = this.torch.gpu.mats[models.torch.materials.findIndex((m) => m.name === 'Lens')];
    // live dive-computer screen
    this.cv = document.createElement('canvas'); this.cv.width = 256; this.cv.height = 224;
    this.screenTex = R.device.createTexture({ size: [256, 224], format: 'rgba8unorm-srgb', usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST | GPUTextureUsage.RENDER_ATTACHMENT });
    const si = models.divecomputer.materials.findIndex((m) => m.name === 'Screen');
    const screenMat = R.material({ color: [0, 0, 0, 1], emissive: [1, 1, 1], emissiveStrength: 1.2, emTex: this.screenTex, rough: 0.45, gear: true });
    this.dc.gpu.prims.forEach((p) => { if (p.mat === this.dc.gpu.mats[si]) p.mat = screenMat; });
    // gloved hands
    // matte rubber: fine grain normal map (tileable noise) + high roughness
    const glove = { color: [0.018, 0.019, 0.021, 1], rough: 0.7, metal: 0.0, baseTex: null, normalTex: null, mrTex: null };   // smooth matte rubber
    this.hands = ['hand_right', 'hand_left'].map((n, i) => {
      const model = models[n];
      const gpu = R.uploadModel(model, { matOverride: glove });
      const pose = new Pose(model);
      const objs = gpu.prims.map((p) => R.object(p.skin >= 0 ? model.skins[p.skin].joints.length * 64 : 0));
      const idx = (name) => pose.find(name);
      const wrist = idx('wrist');
      pose.update(m4.ident());
      const wristRest = [pose.global[wrist][12], pose.global[wrist][13], pose.global[wrist][14]];
      const fingers = FINGERS.map((f) => PH.map((ph) => idx(`${f}-${ph}`)));
      const thumb = ['thumb-metacarpal', 'thumb-phalanx-proximal', 'thumb-phalanx-distal'].map(idx);
      const tips = FINGERS.map((f) => idx(`${f}-tip`)), thumbTip = idx('thumb-tip');
      const side = i === 0 ? -1 : 1; // palm faces -X (right) / +X (left) in the rest pose
      return { model, gpu, pose, objs, wristRest, fingers, thumb, tips, thumbTip, Bm: ortho([0, -1, 0], [side, 0, 0]) };
    });
    this.aim = null; this.sway = [0, 0, 0]; this.lastScreen = -1; this.maxDepth = 0; this.diveTime = 0; this.prevDepth = 0; this.rate = 0;
  }
  staticModel(model, over) {
    const { matByName, ...mo } = over || {};
    const gpu = this.R.uploadModel(model, { matOverride: mo, matByName });
    return { gpu, objs: gpu.prims.map(() => this.R.object()) };
  }
  pushStatic(m, world) {
    m.gpu.prims.forEach((p, i) => { rel(world, m.objs[i].data.subarray(0, 16)); this.draws.push({ gm: p.gm, mat: p.mat, obj: m.objs[i], kind: 'static', shadow: false }); });
  }
  // The WebXR hand skeleton is flat (every joint is a child of the Armature), so finger chains are
  // posed with explicit forward kinematics: each joint bends about its own local X at its pivot and
  // carries every joint further down the chain with it.
  poseHand(h, curls, thumbCurl, spread = 0) {
    const L = h.pose.local, N = h.model.nodes;
    h.pose.reset();
    if (this.debugCurl !== undefined) { curls = curls.map((c) => c.map(() => this.debugCurl)); }
    const rest = (j) => m4.trs(N[j].t, N[j].r, N[j].s);
    const bend = (chain, angles, preYaw = 0) => {
      const M = chain.map((j) => (j >= 0 ? rest(j) : null));
      angles.forEach((a, k) => {
        const piv = M[k]; if (!piv) return;
        const p = [piv[12], piv[13], piv[14]];
        let R = m4.rotAxis(v3.norm([piv[0], piv[1], piv[2]]), -a);
        if (k === 0 && preYaw) R = m4.mul(m4.rotAxis(v3.norm([piv[4], piv[5], piv[6]]), preYaw), R);
        const X = m4.mul(m4.translate(p), m4.mul(R, m4.translate([-p[0], -p[1], -p[2]])));
        for (let i = k; i < M.length; i++) if (M[i]) M[i] = m4.mul(X, M[i]);
      });
      chain.forEach((j, i) => { if (j < 0) return; const d = decompose(M[i]); L[j].t = d.t; L[j].r = d.r; L[j].s = d.s; });
    };
    h.fingers.forEach((chain, fi) => bend([...chain, h.tips[fi]], curls[fi], (fi - 1.5) * spread));
    bend([...h.thumb, h.thumbTip], thumbCurl);
  }
  placeHand(h, F, P, wrist) {
    const root = frame(h.Bm, ortho(F, P), h.wristRest, wrist);
    h.pose.update(root);
    h.gpu.prims.forEach((p, i) => {
      if (p.skin >= 0) this.R.device.queue.writeBuffer(h.objs[i].sb, 0, h.pose.jointMats[p.skin]);
      else rel(root, h.objs[i].data.subarray(0, 16));
      this.draws.push({ gm: p.gm, mat: p.mat, obj: h.objs[i], kind: p.skin >= 0 ? 'skin' : 'static', shadow: false });
    });
  }
  sleeve(m, F, P, wrist, elbow) {
    const [f, p] = ortho(F, P);
    const Z = v3.norm(v3.sub(elbow, wrist));
    const Y = v3.norm(v3.sub(v3.scale(p, -1), v3.scale(Z, v3.dot(v3.scale(p, -1), Z)))), X = v3.cross(Y, Z);
    const k = 1.08;   // slightly wider than the glove's wrist so the surfaces never coincide
    this.pushStatic(m, m4.basis(v3.scale(X, k), v3.scale(Y, k), Z, v3.add(wrist, v3.scale(f, 0.004))));
  }
  jointPos(h, j) { const g = h.pose.global[j]; return [g[12], g[13], g[14]]; }
  // least-squares circle through points projected on the plane normal to axis A -> centre (3D)
  fitAxis(pts, A) {
    const u = v3.norm(v3.cross(A, Math.abs(A[1]) < 0.9 ? [0, 1, 0] : [1, 0, 0])), w = v3.cross(A, u);
    const o = pts[0], P2 = pts.map((p) => { const d = v3.sub(p, o); return [v3.dot(d, u), v3.dot(d, w)]; });
    let sxx = 0, sxy = 0, syy = 0, sx = 0, sy = 0, sz = 0, sxz = 0, syz = 0; const n = P2.length;
    for (const [x, y] of P2) { const z = x * x + y * y; sxx += x * x; sxy += x * y; syy += y * y; sx += x; sy += y; sz += z; sxz += x * z; syz += y * z; }
    // solve [sxx sxy sx; sxy syy sy; sx sy n] [a b c] = -[sxz syz sz]  (x^2+y^2+ax+by+c=0)
    const M = [[sxx, sxy, sx], [sxy, syy, sy], [sx, sy, n]], r = [-sxz, -syz, -sz];
    const det = (m) => m[0][0] * (m[1][1] * m[2][2] - m[1][2] * m[2][1]) - m[0][1] * (m[1][0] * m[2][2] - m[1][2] * m[2][0]) + m[0][2] * (m[1][0] * m[2][1] - m[1][1] * m[2][0]);
    const D = det(M); if (Math.abs(D) < 1e-18) return null;
    const col = (k) => M.map((row, i) => row.map((v, j) => (j === k ? r[i] : v)));
    const a = det(col(0)) / D, b = det(col(1)) / D;
    const cx = -a / 2, cy = -b / 2;
    let meanA = 0; for (const p of pts) meanA += v3.dot(v3.sub(p, o), A); meanA /= n;
    return v3.add(o, v3.add(v3.add(v3.scale(u, cx), v3.scale(w, cy)), v3.scale(A, meanA)));
  }

  // Arm in moving water: mass–spring–damper (shoulder/elbow muscles) driven by quadratic drag of the relative flow
  // F = ½ρ·Cd·A·|u|·u, plus alternating vortex-shedding lift (Strouhal).  Everything in camera-local coords
  // (x right, y up, z forward).  Returns { off: displacement (m), bend: drag-driven wrist deflection vector }.
  armDrag(key, flow, dt, t, area, stiff) {
    const S = this.drag[key] || (this.drag[key] = { x: [0, 0, 0], v: [0, 0, 0], ph: Math.random() * 6.28, F: [0, 0, 0] });
    const rho = 1025, Cd = 1.05, m = 2.4, c = 2 * 0.45 * Math.sqrt(stiff * m), n = 4, h = Math.min(dt, 0.1) / n;
    for (let i = 0; i < n; i++) {
      const u = v3.sub(flow, S.v), ul = v3.len(u);
      let F = v3.scale(u, 0.5 * rho * Cd * area * ul);
      if (ul > 0.15) {                                                   // vortex shedding off the forearm (D ≈ 9 cm, St ≈ 0.2)
        S.ph += h * 2 * Math.PI * 0.2 * ul / 0.09;
        let side = v3.cross(v3.scale(u, 1 / ul), [0, 1, 0]); if (v3.len(side) < 0.2) side = v3.cross(v3.scale(u, 1 / ul), [1, 0, 0]);
        F = v3.add(F, v3.scale(v3.norm(side), 0.5 * rho * area * ul * ul * 0.12 * Math.sin(S.ph)));
      }
      S.F = F;
      const a = v3.scale(v3.sub(v3.sub(F, v3.scale(S.x, stiff)), v3.scale(S.v, c)), 1 / m);
      S.v = v3.add(S.v, v3.scale(a, h)); S.x = v3.add(S.x, v3.scale(S.v, h));
    }
    const l = v3.len(S.x); if (l > 0.2) { S.x = v3.scale(S.x, 0.2 / l); S.v = v3.scale(S.v, 0.5); }
    return { off: S.x, force: S.F };
  }
  // rotate direction d about the axis that turns `from` toward `to` by angle a
  bendDir(d, force, fwd, gain, maxA) {
    const fl = v3.len(force); if (fl < 1e-3) return d;
    const ax = v3.cross(fwd, v3.scale(force, 1 / fl)); const al = v3.len(ax); if (al < 1e-4) return d;
    return v3.norm(m4.xdir(m4.rotAxis(v3.scale(ax, 1 / al), Math.min(fl * gain, maxA) * al), d));
  }
  update(dt, t, cm, cam, state, depth) {
    this.draws.length = 0; this.light = null;
    const cr = [cm[0], cm[1], cm[2]], cu = [cm[4], cm[5], cm[6]], cf = [-cm[8], -cm[9], -cm[10]], P0 = [cm[12], cm[13], cm[14]];
    const at = (x, y, z) => v3.add(P0, v3.add(v3.add(v3.scale(cr, x), v3.scale(cu, y)), v3.scale(cf, z)));
    // F brings the torch hand up (light comes on once it is in place) or lowers it out of view
    this.tin = lerp(this.tin ?? 0, state.torch ? 1 : 0, 1 - Math.exp(-dt * (state.torch ? 6 : 5)));
    const kin = smooth(0, 1, this.tin);
    this.torchPower = lerp(this.torchPower, state.torch && this.tin > 0.85 ? 1 : 0, 1 - Math.exp(-dt * 25));
    if (state.mode === 'dive') { this.diveTime += dt; this.maxDepth = Math.max(this.maxDepth, depth); }
    this.rate = lerp(this.rate, (depth - this.prevDepth) / dt, 1 - Math.exp(-dt * 2)); this.prevDepth = depth;
    if (state.mode === 'boat') return;
    // swimming sway (fin kicks), torch aim lags the view like a real arm
    const sp = v3.len(cam.vel);
    const sw = [Math.sin(t * 1.9) * 0.006 * (1 + sp * 0.4), Math.sin(t * 3.8) * 0.004 * (1 + sp * 0.4), 0];
    this.aim = this.aim ? v3.norm(v3.lerp(this.aim, cf, 1 - Math.exp(-dt * 7))) : cf;
    // ---- water flow past the arms: body velocity (actual camera motion, incl. cinematic) + turning ----
    this.drag = this.drag || {};
    let bv = [0, 0, 0];
    if (this.prevP0 && dt > 0) { bv = v3.scale(v3.sub(P0, this.prevP0), 1 / dt); if (v3.len(bv) > 25) bv = [0, 0, 0]; }
    this.prevP0 = [...P0];
    this.bodyV = this.bodyV ? v3.lerp(this.bodyV, bv, 1 - Math.exp(-dt * 10)) : bv;
    let om = [0, 0, 0];
    if (this.prevCf && dt > 0) { om = v3.scale(v3.cross(this.prevCf, cf), 1 / dt); }
    this.prevCf = [...cf];
    const underW = depth > 0.3 ? 1 : 0;
    const loc = (w) => [v3.dot(w, cr), v3.dot(w, cu), v3.dot(w, cf)];
    const flowAt = (rLoc) => {                                            // water velocity relative to a point on the body
      const rW = v3.add(v3.add(v3.scale(cr, rLoc[0]), v3.scale(cu, rLoc[1])), v3.scale(cf, rLoc[2]));
      return v3.scale(loc(v3.scale(v3.add(this.bodyV, v3.cross(om, rW)), -1)), underW);
    };
    const toW = (x) => v3.add(v3.add(v3.scale(cr, x[0]), v3.scale(cu, x[1])), v3.scale(cf, x[2]));
    const dR = this.armDrag('R', flowAt([0.17, -0.2, 0.3]), dt, t, 0.032, 800);   // torch arm: forearm + fist + torch
    const dL = this.armDrag('L', flowAt([-0.23, -0.27, 0.24]), dt, t, 0.028, state.computer ? 1600 : 700);
    const offR = toW(dR.off), offL = toW(dL.off);
    const fR = toW(dR.force), fL = toW(dL.force);
    // ---- right hand: fist wrapped around the torch barrel, index finger at the lamp end ----
    const R = this.hands[0];
    const A = this.aim;
    // palm-up grip: torch cradled diagonally across the palm (lamp out between thumb and index,
    // tail at the heel of the hand), fingers wrapped around from below, thumb resting on the switch
    const ro = this.debugR || [0.17, -0.2, 0.3];
    const wristR = at(ro[0] + sw[0] + (1 - kin) * 0.05, ro[1] + sw[1] - (1 - kin) * 0.3, ro[2] - (1 - kin) * 0.12);
    const rgt = v3.norm(v3.cross(A, cu)), upA = v3.norm(v3.cross(rgt, A));
    const g = 50 * Math.PI / 180;
    // wrist rolled ~30° to the left about the barrel axis
    const roll = m4.rotAxis(v3.scale(A, -1), 30 * Math.PI / 180);
    let Fr = v3.norm(m4.xdir(roll, v3.add(v3.scale(rgt, -Math.sin(g)), v3.scale(A, Math.cos(g)))));   // knuckles forward-left
    let Pr = v3.norm(m4.xdir(roll, v3.add(upA, v3.scale(rgt, -0.25))));                                // palm up, slightly inward
    // drag: the wrist is pushed back with the flow and the hand bends at the wrist
    Fr = this.bendDir(Fr, fR, Fr, 0.006, 0.25); Pr = this.bendDir(Pr, fR, Fr, 0.006, 0.25);
    wristR[0] += offR[0]; wristR[1] += offR[1]; wristR[2] += offR[2];
    const elbowR = v3.add(v3.add(wristR, v3.scale(offR, -0.6)), v3.add(v3.scale(Fr, -0.3), v3.scale(upA, -0.1)));
    this.poseHand(R, [[0.75, 1.2, 0.8], [0.8, 1.25, 0.8], [0.85, 1.25, 0.75], [0.9, 1.2, 0.75]], [0.25, 0.45, 0.35]);
    const nR = this.draws.length;
    this.placeHand(R, Fr, Pr, wristR);
    this.sleeve(this.sleeveR, Fr, Pr, wristR, elbowR);
    // barrel axis through the curled fingers, slid along its axis so the switch sits under the thumb tip
    const pts = [];
    R.fingers.slice(1, 3).forEach((chain) => chain.forEach((j) => pts.push(this.jointPos(R, j))));
    ['middle-finger-tip', 'ring-finger-tip'].map((n) => R.pose.find(n)).filter((j) => j >= 0).forEach((j) => pts.push(this.jointPos(R, j)));
    const c = this.fitAxis(pts, A) || v3.add(wristR, v3.scale(Fr, 0.08));
    const tp = R.thumbTip >= 0 ? this.jointPos(R, R.thumbTip) : c;
    const Zt = v3.scale(A, -1);
    const Xt = v3.norm(v3.cross(cu, Zt)), Yt = v3.cross(Zt, Xt);
    const o = v3.add(c, v3.scale(A, clamp(v3.dot(v3.sub(tp, c), A) + 0.03, -0.02, 0.09)));
    const torchW = m4.basis(Xt, Yt, Zt, o);
    this.pushStatic(this.torch, torchW);
    if (kin < 0.02) this.draws.length = nR;                            // fully lowered: not drawn
    this.torchPos = m4.xform(torchW, [0, 0, -0.105]);
    this.torchDir = this.bendDir(A, fR, A, 0.003, 0.1);
    if (this.lens) { this.lens.data[7] = 0.02 + this.torchPower * 40; this.R.device.queue.writeBuffer(this.lens.ub, 0, this.lens.data); }
    // ---- left hand: relaxed low, or raised to read the wrist computer ----
    const target = state.computer ? 1 : 0;
    this.raise = lerp(this.raise, target, 1 - Math.exp(-dt * 5));
    const k = smooth(0, 1, this.raise);
    const L = this.hands[1];
    let Fl = v3.norm(v3.lerp(v3.add(cf, v3.add(v3.scale(cr, 0.3), v3.scale(cu, -0.25))), v3.add(cr, v3.add(v3.scale(cu, 0.08), v3.scale(cf, 0.35))), k));
    let Pl = v3.norm(v3.lerp(v3.add(v3.scale(cu, -1), v3.scale(cr, 0.3)), v3.add(v3.scale(cf, 0.9), v3.scale(cu, -0.5)), k));   // raised: back of wrist turned toward the eye
    Fl = this.bendDir(Fl, fL, Fl, 0.007 * (1 - 0.7 * k), 0.28); Pl = this.bendDir(Pl, fL, Fl, 0.007 * (1 - 0.7 * k), 0.28);
    const wristL = v3.add(v3.lerp(at(-0.23 - sw[0], -0.27 + sw[1], 0.24), at(-0.09, -0.145 + Math.sin(t * 1.3) * 0.003, 0.3), k), offL);   // chest height, not in the face
    const c0 = lerp(0.25, 0.45, k);
    this.poseHand(L, [[c0, c0 + 0.1, 0.2], [c0 + 0.05, c0 + 0.15, 0.25], [c0 + 0.1, c0 + 0.2, 0.3], [c0 + 0.15, c0 + 0.25, 0.3]], [0.1, 0.2, 0.1], 0.05);
    this.placeHand(L, Fl, Pl, wristL);
    const elbowL = v3.add(v3.lerp(at(-0.3, -0.55, 0.0), at(-0.33, -0.27, 0.2), k), v3.scale(offL, 0.4));
    this.sleeve(this.sleeveL, Fl, Pl, wristL, elbowL);
    const [fl, pl] = ortho(Fl, Pl);
    // computer strapped on top of the wrist, aligned with the forearm (not the hand)
    const fa = v3.norm(v3.sub(wristL, elbowL));
    const Ydc = v3.norm(v3.sub(v3.scale(pl, -1), v3.scale(fa, v3.dot(v3.scale(pl, -1), fa)))), Xdc = fa, Zdc = v3.cross(Xdc, Ydc);
    const dk = 1.1;   // strap scaled with the wider sleeve
    const dcW = m4.basis(v3.scale(Xdc, dk), v3.scale(Ydc, dk), v3.scale(Zdc, dk), v3.add(wristL, v3.add(v3.scale(fa, -0.04), v3.scale(Ydc, 0.034 * dk))));
    this.pushStatic(this.dc, dcW);
    this.dcPos = m4.xform(dcW, [0, 0.014, 0]);
    this.light = { p: v3.add(this.dcPos, v3.scale(Ydc, 0.05)), c: [0.004, 0.018, 0.024].map((x) => x * (0.3 + k)), r: 1.2 };
    if (t - this.lastScreen > 0.25) { this.lastScreen = t; this.drawScreen(depth, state, t, cam); }
  }

  drawScreen(depth, state, t, cam) {
    const g = this.cv.getContext('2d'), W = 256, H = 224;
    g.fillStyle = '#01080c'; g.fillRect(0, 0, W, H);
    g.strokeStyle = 'rgba(40,200,255,0.10)'; g.lineWidth = 1;
    for (let x = 0; x < W; x += 16) { g.beginPath(); g.moveTo(x, 0); g.lineTo(x, H); g.stroke(); }
    const C = '#6ff0ff', D = 'rgba(110,240,255,0.55)', warn = '#ffb347';
    const temp = depth < 60 ? 26 - depth * 0.05 : depth < 1000 ? 23 - 19 * (1 - Math.exp(-(depth - 60) / 260)) : Math.max(1.8, 4.2 - (depth - 1000) * 0.0008);
    const bar = 1.013 + depth * 0.1005;
    const mm = Math.floor(this.diveTime / 60), ss = Math.floor(this.diveTime % 60);
    const light = 100 * Math.exp(-0.0598 * depth) * 0.7 + 100 * Math.exp(-0.0192 * depth) * 0.3;
    g.textBaseline = 'alphabetic';
    g.fillStyle = D; g.font = '600 15px Rajdhani, sans-serif'; g.fillText('DEPTH', 14, 26);
    g.fillText(depth >= 3900 ? 'ABYSSAL' : depth >= 1000 ? 'MIDNIGHT' : depth >= 200 ? 'TWILIGHT' : 'SUNLIT', 170, 26);
    g.fillStyle = C; g.font = '700 70px Rajdhani, sans-serif';
    const ds = depth < 1000 ? depth.toFixed(1) : Math.round(depth).toLocaleString('en-US');
    g.fillText(ds, 12, 92); const w = g.measureText(ds).width;
    g.font = '600 26px Rajdhani, sans-serif'; g.fillText('m', 18 + w, 92);
    // ascent/descent rate
    const r = this.rate;
    g.fillStyle = Math.abs(r) > 9 ? warn : C; g.font = '600 20px Rajdhani, sans-serif';
    g.fillText(`${r > 0.05 ? '▼' : r < -0.05 ? '▲' : '■'} ${Math.abs(r).toFixed(1)} m/s`, 150, 122);
    g.fillStyle = D; g.font = '600 15px Rajdhani, sans-serif';
    g.fillText('MAX', 14, 120); g.fillStyle = C; g.fillText(`${this.maxDepth.toFixed(0)} m`, 50, 120);
    g.fillStyle = 'rgba(110,240,255,0.25)'; g.fillRect(12, 132, W - 24, 1);
    const cells = [['TIME', `${mm}:${String(ss).padStart(2, '0')}`], ['TEMP', `${temp.toFixed(1)}°C`], ['PRESS', `${bar.toFixed(1)} bar`], ['LIGHT', light < 0.01 ? '0 %' : light < 1 ? `${light.toFixed(2)} %` : `${light.toFixed(0)} %`]];
    cells.forEach(([k, v], i) => {
      const x = 14 + (i % 2) * 122, y = 156 + Math.floor(i / 2) * 40;
      g.fillStyle = D; g.font = '600 13px Rajdhani, sans-serif'; g.fillText(k, x, y);
      g.fillStyle = C; g.font = '700 22px Rajdhani, sans-serif'; g.fillText(v, x, y + 22);
    });
    // heading tick + torch state
    const hd = ((-cam.yaw * 180 / Math.PI) % 360 + 360) % 360;
    g.fillStyle = D; g.font = '600 13px Rajdhani, sans-serif'; g.fillText(`HDG ${hd.toFixed(0).padStart(3, '0')}°`, 150, 48);
    g.fillStyle = state.torch ? C : 'rgba(110,240,255,0.25)'; g.fillText(state.torch ? 'LAMP ON' : 'LAMP OFF', 150, 64);
    if (Math.floor(t * 2) % 2 === 0 && depth > 3000) { g.fillStyle = warn; g.fillText('● NDL --', 205, 64); }
    this.R.device.queue.copyExternalImageToTexture({ source: this.cv, flipY: false }, { texture: this.screenTex }, [W, H]);
  }
}
