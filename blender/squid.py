# Build assets/models/raw8/squid.glb (giant squid, Architeuthis dux stand-in) from the CC-BY photogrammetry scan
# "スルメイカ Japanese Flying Squid, Todarodes pacificus" (ffish.asia / floraZia.com).
# Usage: blender --background --factory-startup --python squid.py -- <src.glb> <out.glb> [total_length_m] [mantle_m] [arms_m]
# No CC-BY/CC0 realistic Architeuthis exists in Objaverse 1.0, so the closest realistic squid scan (an ommastrephid
# with the same overall body plan) is re-proportioned to giant-squid size:
# - removes the colour-checker cube, joins the 18 scan chunks, welds seams, drops floating scan debris
# - unfolds the two feeding tentacles (the specimen was scanned with them folded back in a U along the mantle):
#   a centre line is fitted through each tentacle, and every vertex past the U-bend is re-embedded (same local
#   cross-section offsets) along a line that trails behind the arms; the tentacle stalks are lengthened
# - stretches the arm crown along the body axis (arms ~3 m), narrows the fins laterally (Architeuthis has small fins),
#   and enlarges the eyes (Architeuthis has the largest eyes of any animal, ~25 cm)
# - bakes all transforms: metres (mantle 2 m, total 10 m incl. tentacles), mantle tip / fins -> glTF +Z,
#   arms and tentacles trail toward -Z, dorsal -> +Y, left side -> +X, bbox centred at the origin
# - decimates 1.35M -> ~48k triangles; new UV layout; bakes from the full-resolution deformed scan:
#   base colour 2048 px, tangent-space normal map 1024 px, ambient occlusion -> ORM 1024 px
# - unlit scan material -> metallic-roughness PBR (metallic 0, wet skin roughness ~0.35-0.5)
# No rig / animation: the game's shader applies procedural swim deformation along the body (Z) axis.
# Bakes run with Cycles on the CPU only (GPU is reserved for the running WebGPU game).
import bpy, sys, math, mathutils, bmesh, heapq, numpy as np

argv = sys.argv[sys.argv.index('--') + 1:]
SRC, OUT = argv[0], argv[1]
TOTAL = float(argv[2]) if len(argv) > 2 else 10.0
MANTLE = float(argv[3]) if len(argv) > 3 else 2.0
ARMS = float(argv[4]) if len(argv) > 4 else 3.0
MAX_TRIS = 48000
TEX_BASE, TEX_AUX = 2048, 1024
# landmarks of this scan in its import frame (long axis = Blender X, mantle tip at +X, dorsal = +Z; measured from
# axial slice profiles and top/side renders)
X_MANTLE_OPENING = 1.35
X_CROWN = -4.3            # arm bases
FIN_START = 5.6           # fins span x = 5.6 .. tip
FIN_SCALE = 0.7           # lateral fin shrink
EYE_SCALE = 2.0           # eye enlargement
CLUB_LEN = 4.4            # tentacle club (sucker-bearing part) length in scan units
CLUB_NET = 1.4            # final club stretch relative to the uniform scale

bpy.ops.wm.read_factory_settings(use_empty=True)
sc = bpy.context.scene
bpy.ops.import_scene.gltf(filepath=SRC)

# ---- drop colour checker (12-face cube) and empties, join the scan chunks
for o in list(bpy.data.objects):
    if o.type == 'MESH' and len(o.data.polygons) < 100: bpy.data.objects.remove(o)
parts = [o for o in bpy.data.objects if o.type == 'MESH']
bpy.context.view_layer.update()
for o in parts:
    M = o.matrix_world.copy(); o.parent = None; o.matrix_world = M
for o in list(bpy.data.objects):
    if o.type != 'MESH': bpy.data.objects.remove(o)
bpy.ops.object.select_all(action='DESELECT')
for o in parts: o.select_set(True)
bpy.context.view_layer.objects.active = parts[0]
bpy.ops.object.transform_apply(location=True, rotation=True, scale=True)
bpy.ops.object.join()
hi = bpy.context.view_layer.objects.active
hi.name = 'scan_hi'

# ---- weld chunk seams, remove floating debris
bpy.ops.object.mode_set(mode='EDIT'); bpy.ops.mesh.select_all(action='SELECT')
bpy.ops.mesh.remove_doubles(threshold=2e-4)
bpy.ops.mesh.delete_loose()
bpy.ops.object.mode_set(mode='OBJECT')
bm = bmesh.new(); bm.from_mesh(hi.data); bm.verts.ensure_lookup_table()
seen = set(); comps = []
for v0 in bm.verts:
    if v0.index in seen: continue
    stack = [v0]; comp = []; seen.add(v0.index)
    while stack:
        v = stack.pop(); comp.append(v)
        for e in v.link_edges:
            w = e.other_vert(v)
            if w.index not in seen: seen.add(w.index); stack.append(w)
    comps.append(comp)
comps.sort(key=len, reverse=True)
drop = [v for comp in comps if len(comp) < 0.002 * len(bm.verts) for v in comp]
print('components', len(comps), 'sizes', [len(x) for x in comps[:6]], 'dropping verts', len(drop))
bmesh.ops.delete(bm, geom=drop, context='VERTS')
bm.to_mesh(hi.data); bm.free()

V = np.array([v.co for v in hi.data.vertices], dtype=np.float64)
TIP = V[:, 0].max(); X_ARMTIP = V[:, 0].min()
k = MANTLE / (TIP - X_MANTLE_OPENING)                  # metres per scan unit
fa = (ARMS / k) / (X_CROWN - X_ARMTIP)                 # axial stretch of the arm crown
xt_target = TIP - TOTAL / k                            # tentacle tip x (scan units, after the stretch)
print('SRC tip', TIP, 'arm tip', X_ARMTIP, 'scale', k, 'arm stretch', fa)

# ---- eyes: darkest texels on each side of the head (sampled from the scan texture at the vertex UVs)
me = hi.data
uv = np.zeros(len(me.loops) * 2); me.uv_layers[0].data.foreach_get('uv', uv); uv = uv.reshape(-1, 2)
lv = np.zeros(len(me.loops), np.int64); me.loops.foreach_get('vertex_index', lv)
pm = np.zeros(len(me.polygons), np.int64); me.polygons.foreach_get('material_index', pm)
ls = np.zeros(len(me.polygons), np.int64); me.polygons.foreach_get('loop_start', ls)
lt = np.zeros(len(me.polygons), np.int64); me.polygons.foreach_get('loop_total', lt)
loop_mat = np.repeat(pm, lt)
vuv = np.zeros((len(V), 2)); vmat = np.zeros(len(V), np.int64)
vuv[lv] = uv; vmat[lv] = loop_mat
lum = np.ones(len(V))
for mi, mat in enumerate(me.materials):
    img = next((n.image for n in mat.node_tree.nodes if n.type == 'TEX_IMAGE' and n.image), None)
    if img is None: continue
    w, h = img.size
    px = np.array(img.pixels[:], dtype=np.float32).reshape(h, w, 4)
    sel = vmat == mi
    ix = np.clip((vuv[sel, 0] % 1) * w, 0, w - 1).astype(int); iy = np.clip((vuv[sel, 1] % 1) * h, 0, h - 1).astype(int)
    c = px[iy, ix]; lum[sel] = 0.2126 * c[:, 0] + 0.7152 * c[:, 1] + 0.0722 * c[:, 2]
EYES = []
for sg in (1, -1):
    head = (V[:, 0] > -3.8) & (V[:, 0] < -2.0) & (sg * V[:, 1] > 0.55) & (V[:, 2] > -0.35) & (V[:, 2] < 0.6)   # lateral head surface
    thr = np.percentile(lum[head], 1.5)
    d = V[head & (lum <= thr)]
    c0 = np.median(d, 0)
    d = d[np.linalg.norm(d - c0, axis=1) < 0.5]
    c0 = d.mean(0); r = np.percentile(np.linalg.norm(d - c0, axis=1), 90)
    EYES.append((c0, r))
    print('EYE (scan units) side', sg, 'centre', c0.round(3), 'dark radius', round(float(r), 3))

# ---- deformation helpers (numpy)
def smoothstep(t):
    t = np.clip(t, 0, 1); return t * t * (3 - 2 * t)

def smooth(L, w):
    out = L.copy()
    for i in range(len(L)):
        a, b = max(0, i - w), min(len(L), i + w + 1); out[i] = L[a:b].mean(0)
    out[0], out[-1] = L[0], L[-1]
    return out

def resample(L, ds):
    seg = np.linalg.norm(np.diff(L, axis=0), axis=1); s = np.concatenate([[0], np.cumsum(seg)])
    t = np.arange(0, s[-1], ds)
    return np.stack([np.interp(t, s, L[:, i]) for i in range(3)], 1)

def centreline(P, start_hint, step=0.08):
    # voxel centroids -> neighbour graph -> Dijkstra from the node nearest start_hint to the farthest node
    key = np.floor(P / step).astype(np.int64)
    _, inv = np.unique(key, axis=0, return_inverse=True); inv = inv.ravel()
    n = inv.max() + 1
    C = np.zeros((n, 3)); np.add.at(C, inv, P); C /= np.bincount(inv, minlength=n)[:, None]
    D = np.sqrt(((C[:, None, :] - C[None, :, :]) ** 2).sum(-1))
    adj = D < step * 1.9
    s0 = int(np.argmin(((C - start_hint) ** 2).sum(1)))
    dist = np.full(n, np.inf); prev = np.full(n, -1); dist[s0] = 0; hq = [(0.0, s0)]
    while hq:
        d, u = heapq.heappop(hq)
        if d > dist[u]: continue
        for v in np.nonzero(adj[u])[0]:
            nd = d + D[u, v]
            if nd < dist[v]: dist[v] = nd; prev[v] = u; heapq.heappush(hq, (nd, v))
    e = int(np.argmax(np.where(np.isfinite(dist), dist, -1)))
    path = []; u = e
    while u != -1: path.append(u); u = prev[u]
    return resample(smooth(C[path[::-1]], 5), 0.05)

def project(P, L):
    # nearest centre-line sample -> arc length s and local cross-section coords (a: 'up' N, b: side B)
    T = np.gradient(L, axis=0); T /= np.linalg.norm(T, axis=1, keepdims=True)
    Z = np.array([0, 0, 1.0])
    N = Z - (T @ Z)[:, None] * T; N /= np.linalg.norm(N, axis=1, keepdims=True)
    B = np.cross(T, N)
    idx = np.empty(len(P), np.int64)
    for i in range(0, len(P), 20000):
        q = P[i:i + 20000]
        idx[i:i + 20000] = np.argmin(((q[:, None, :] - L[None, :, :]) ** 2).sum(-1), 1)
    ds = np.linalg.norm(np.diff(L, axis=0), axis=1).mean()
    R = P - L[idx]
    return idx * ds + (R * T[idx]).sum(1), (R * N[idx]).sum(1), (R * B[idx]).sum(1), T, ds

def refine(P, L, it=2):
    # move each centre-line sample to the centroid of the points projecting onto it
    for _ in range(it):
        s, a, b, T, ds = project(P, L)
        idx = np.clip(np.round(s / ds).astype(int), 0, len(L) - 1)
        C = L.copy(); cnt = np.bincount(idx, minlength=len(L))
        acc = np.zeros_like(L); np.add.at(acc, idx, P)
        ok = cnt > 10; C[ok] = acc[ok] / cnt[ok, None]
        L = resample(smooth(C, 4), ds)
    return L

def straighten(P, L, s_cut, Lb, D, stalk_sigma, s_club, club_sigma):
    """identity up to arc length s_cut; then the tangent turns smoothly to D over Lb; the stalk after the bend is
    lengthened by stalk_sigma and the club (s > s_club) by club_sigma. Cross-section offsets are preserved."""
    s, a, b, T, ds = project(P, L)
    ss = np.arange(0, s.max() + ds * 2, ds * 0.5)
    r = 1 + (stalk_sigma - 1) * smoothstep((ss - (s_cut + Lb)) / 0.6)
    r = r + (club_sigma - r) * smoothstep((ss - s_club) / 0.6)
    uu = np.concatenate([[0], np.cumsum((r[1:] + r[:-1]) / 2 * np.diff(ss))])
    ic = int(s_cut / ds); t0 = T[ic]; D = D / np.linalg.norm(D)
    du = ds * 0.25
    U = np.arange(0, uu[-1] + du, du)
    sU = np.interp(U, uu, ss)
    wb = smoothstep((sU - s_cut) / Lb)
    tt = (1 - wb)[:, None] * t0 + wb[:, None] * D; tt /= np.linalg.norm(tt, axis=1, keepdims=True)
    pos = np.zeros((len(U), 3)); iU0 = np.searchsorted(U, s_cut)
    pos[:iU0 + 1] = L[np.clip(np.round(U[:iU0 + 1] / ds).astype(int), 0, len(L) - 1)]
    pos[iU0] = L[ic] + t0 * (U[iU0] - ic * ds)
    for i in range(iU0 + 1, len(U)): pos[i] = pos[i - 1] + tt[i] * du
    Zv = np.array([0, 0, 1.0])
    Nt = Zv - (tt @ Zv)[:, None] * tt; Nt /= np.linalg.norm(Nt, axis=1, keepdims=True); Bt = np.cross(tt, Nt)
    u = np.interp(s, ss, uu); kk = np.clip(np.round(u / du).astype(int), 0, len(U) - 1)
    new = pos[kk] + tt[kk] * (u - U[kk])[:, None] + a[:, None] * Nt[kk] + b[:, None] * Bt[kk]
    keep = s < s_cut
    new[keep] = P[keep]
    return new

def axial_stretch(x, x0, f, ramp=1.0):
    # for x < x0 stretch distances along -X by f (smooth ramp of the stretch rate over 'ramp' units)
    xs = np.linspace(min(x.min(), x0) - 1, x0 + 1, 40000)
    rate = 1 + (f - 1) * smoothstep((x0 - xs) / ramp)
    cum = np.concatenate([[0], np.cumsum((rate[1:] + rate[:-1]) / 2 * np.diff(xs))])
    cum -= cum[-1]
    return np.where(x < x0 + 1, (x0 + 1) + np.interp(x, xs, cum), x)

# ---- 1. unfold + lengthen the two feeding tentacles
out = V.copy()
S_CUT, LB = 0.15, 1.2
for sg in (1, -1):
    m = (((sg * V[:, 1] > 1.55) & (V[:, 0] > -6.8) & (V[:, 0] < 1.6) & ((V[:, 0] < 0.8) | (sg * V[:, 1] > 1.9)))
         | ((sg * V[:, 1] > 1.3) & (V[:, 0] > -6.35) & (V[:, 0] < -5.5)))
    P = V[m]
    L = refine(P, centreline(P, np.array([-5.7, sg * 1.3, -0.45])))
    s_club = len(L) * 0.05 - CLUB_LEN
    Dd = np.array([-1, -sg * 0.04, 0.0])
    def tipx(sig):
        nw = straighten(L[-1:].copy(), L, S_CUT, LB, Dd, sig, s_club, CLUB_NET / fa)
        return axial_stretch(np.array([nw[0, 0], X_CROWN + 3]), X_CROWN, fa)[0]
    lo_, hi_ = 1.0, 30.0
    for _ in range(40):
        mid = (lo_ + hi_) / 2
        if tipx(mid) > xt_target: lo_ = mid
        else: hi_ = mid
    print('tentacle side', sg, 'verts', int(m.sum()), 'centre line', round(len(L) * 0.05, 2), 'stalk stretch', round(mid, 3))
    out[m] = straighten(P, L, S_CUT, LB, Dd, mid, s_club, CLUB_NET / fa)

# ---- 2. smaller fins: compress the part of the fins outside the (linearly tapering) mantle half-width
fin = out[:, 0] > FIN_START
wm = 1.4 * np.clip((TIP - out[:, 0]) / (TIP - FIN_START), 0, 1)
ay = np.abs(out[:, 1]); f = fin & (ay > wm)
out[f, 1] = np.sign(out[f, 1]) * (wm[f] + (ay[f] - wm[f]) * FIN_SCALE)

# ---- 3. larger eyes: smooth radial scaling about the pupil (monotonic falloff, no folding)
r_eye = min(r for c0, r in EYES)       # the smaller (cleaner) detection; same size on both sides
EYES = [(c0, r_eye) for c0, r in EYES]
for c0, r in EYES:
    R = max(r, 0.15) * 2.6
    d = out - c0; dist = np.linalg.norm(d, axis=1)
    g = 1 + (EYE_SCALE - 1) * (1 - smoothstep(dist / R))
    sel = dist < R
    out[sel] = c0 + d[sel] * g[sel, None]

# ---- 4. stretch the arm crown along the body axis
out[:, 0] = axial_stretch(out[:, 0], X_CROWN, fa)

# ---- 5. to glTF frame: scan +X (mantle tip) -> glTF +Z (Blender -Y), scan +Z (dorsal) -> glTF +Y (Blender +Z),
#         scan +Y -> glTF +X (Blender +X); metres; bbox centred
Bl = np.stack([out[:, 1], -out[:, 0], out[:, 2]], 1) * k
mn, mx = Bl.min(0), Bl.max(0); ctr = (mn + mx) / 2; Bl -= ctr
me.vertices.foreach_set('co', Bl.astype(np.float32).ravel())
me.update()
print('FINAL bbox (Blender XYZ, m)', (mx - mn).round(3))
for (c0, r), sg in zip(EYES, (1, -1)):
    rel = c0.copy()
    # eye centre in final coords (head is not moved by the stretch; X_CROWN > eye x)
    gl = np.array([rel[1], rel[2], rel[0]]) * k - np.array([ctr[0], ctr[2], -ctr[1]])
    print('EYE glTF (x,y,z) m', gl.round(3), 'visible dark-eye diameter m', round(float(2 * r * EYE_SCALE * k), 3))

# ---- high-poly material -> pure emission of the scan texture (for the colour bake)
for mat in me.materials:
    img = next((n.image for n in mat.node_tree.nodes if n.type == 'TEX_IMAGE' and n.image), None)
    nt = mat.node_tree; nt.nodes.clear()
    ti = nt.nodes.new('ShaderNodeTexImage'); ti.image = img
    em = nt.nodes.new('ShaderNodeEmission'); oo = nt.nodes.new('ShaderNodeOutputMaterial')
    nt.links.new(ti.outputs['Color'], em.inputs['Color']); nt.links.new(em.outputs[0], oo.inputs[0])

# ---- low-poly: decimate, smooth, new UVs
lo = hi.copy(); lo.data = hi.data.copy(); lo.name = 'squid'; lo.data.name = 'squid'
sc.collection.objects.link(lo)
lo.data.calc_loop_triangles(); tris_hi = len(lo.data.loop_triangles)
bpy.ops.object.select_all(action='DESELECT'); lo.select_set(True); bpy.context.view_layer.objects.active = lo
d = lo.modifiers.new('dec', 'DECIMATE'); d.ratio = MAX_TRIS / tris_hi * 0.99
bpy.ops.object.modifier_apply(modifier='dec')
bpy.ops.object.mode_set(mode='EDIT'); bpy.ops.mesh.select_all(action='SELECT')
bpy.ops.mesh.remove_doubles(threshold=1e-4)
bpy.ops.mesh.delete_loose()
bpy.ops.mesh.quads_convert_to_tris()
bpy.ops.mesh.normals_make_consistent(inside=False)
bpy.ops.object.mode_set(mode='OBJECT')
# UVs: smart-project a smoothed copy (the decimated scan surface is too noisy for smart project: thousands of tiny
# islands), then copy the UVs back loop-for-loop (identical topology)
sm = lo.copy(); sm.data = lo.data.copy(); sc.collection.objects.link(sm)
bpy.ops.object.select_all(action='DESELECT'); sm.select_set(True); bpy.context.view_layer.objects.active = sm
mod = sm.modifiers.new('sm', 'SMOOTH'); mod.factor = 0.6; mod.iterations = 12
bpy.ops.object.modifier_apply(modifier='sm')
bpy.ops.object.mode_set(mode='EDIT'); bpy.ops.mesh.select_all(action='SELECT')
bpy.ops.uv.smart_project(angle_limit=math.radians(66), island_margin=0.002, area_weight=0.0, scale_to_bounds=False)
try:
    bpy.ops.uv.pack_islands(rotate=True, margin=0.002, shape_method='CONCAVE')
except Exception as e:
    print('pack_islands fallback', e); bpy.ops.uv.pack_islands(rotate=True, margin=0.002)
bpy.ops.object.mode_set(mode='OBJECT')
suv = np.zeros(len(sm.data.loops) * 2, np.float32); sm.data.uv_layers.active.data.foreach_get('uv', suv)
lo.data.uv_layers.active.data.foreach_set('uv', suv)
bpy.data.objects.remove(sm)
bpy.ops.object.select_all(action='DESELECT'); lo.select_set(True); bpy.context.view_layer.objects.active = lo
for u in [u.name for u in lo.data.uv_layers if u != lo.data.uv_layers.active]:
    lo.data.uv_layers.remove(lo.data.uv_layers[u])
lo.data.uv_layers[0].name = 'UVMap'
lo.data.uv_layers.active = lo.data.uv_layers[0]
try:
    bpy.ops.mesh.customdata_custom_splitnormals_clear()
except Exception as e:
    print('no custom normals', e)
bpy.ops.object.shade_smooth()
lo.data.calc_loop_triangles(); print('TRIS', tris_hi, '->', len(lo.data.loop_triangles))

# ---- bakes (Cycles CPU)
sc.render.engine = 'CYCLES'; sc.cycles.device = 'CPU'
sc.cycles.samples = 1; sc.cycles.use_denoising = False
sc.render.bake.margin = 8
def new_img(name, size, color):
    im = bpy.data.images.new(name, size, size, alpha=False)
    im.colorspace_settings.name = 'sRGB' if color else 'Non-Color'
    return im
lm = bpy.data.materials.new('squid_skin'); lo.data.materials.clear(); lo.data.materials.append(lm)
nt = lm.node_tree
bake_node = nt.nodes.new('ShaderNodeTexImage')
def bake(kind, img, selected_to_active):
    bake_node.image = img; nt.nodes.active = bake_node
    bpy.ops.object.select_all(action='DESELECT')
    if selected_to_active: hi.select_set(True)
    lo.select_set(True); bpy.context.view_layer.objects.active = lo
    sc.render.bake.use_selected_to_active = selected_to_active
    sc.render.bake.cage_extrusion = 0.01         # metres; thin fins/arm webs: larger values hit the far side
    sc.render.bake.max_ray_distance = 0.04
    bpy.ops.object.bake(type=kind, normal_space='TANGENT', use_clear=True, margin=8)
    print('baked', kind, img.name)

base = new_img('squid_basecolor', TEX_BASE, True); bake('EMIT', base, True)
nrm = new_img('squid_normal', TEX_AUX, False); bake('NORMAL', nrm, True)
# clamp tangent-space normals to <= ~70 deg (back-face hits on the thin fins / arm protective membranes)
a = np.array(nrm.pixels[:], dtype=np.float32).reshape(-1, 4)
n = a[:, :3] * 2 - 1
bad = n[:, 2] < 0.35
xy = n[:, :2]; l = np.linalg.norm(xy, axis=1, keepdims=True) + 1e-6
n[bad, 2] = 0.35; n[bad, :2] = xy[bad] / l[bad] * math.sqrt(1 - 0.35 ** 2)
n /= np.linalg.norm(n, axis=1, keepdims=True)
a[:, :3] = n * 0.5 + 0.5
nrm.pixels[:] = a.ravel()
print('normal texels clamped', int(bad.sum()), 'of', len(a))
hi.hide_render = True
sc.cycles.samples = 32
ao = new_img('squid_ao', TEX_AUX, False)
sc.world = bpy.data.worlds.new('w')
bake('AO', ao, False)
bpy.data.objects.remove(hi)

# ---- ORM: R = AO (softened), G = roughness (wet skin: darker chromatophore patches a bit rougher), B = 0
def px(img, w):
    n = img.size[0]
    a = np.array(img.pixels[:], dtype=np.float32).reshape(n, n, 4)
    f = n // w
    return a.reshape(w, f, w, f, 4).mean((1, 3)) if f > 1 else a
b = px(base, TEX_AUX); lum = 0.2126 * b[..., 0] + 0.7152 * b[..., 1] + 0.0722 * b[..., 2]
cov = lum > 0.01
lo5, hi95 = np.percentile(lum[cov], 5), np.percentile(lum[cov], 95)
ln = (lum - lo5) / max(1e-4, hi95 - lo5)
rough = np.clip(0.48 - 0.13 * np.clip(ln, 0, 1), 0.33, 0.5)
aov = 0.35 + 0.65 * px(ao, TEX_AUX)[..., 0]
orm = np.stack([aov, rough, np.zeros_like(rough), np.ones_like(rough)], -1)
ormimg = new_img('squid_orm', TEX_AUX, False)
ormimg.pixels[:] = orm.ravel()
print('ROUGH range', float(rough[cov].min()), float(rough[cov].max()), 'mean', float(rough[cov].mean()))
for im in (base, nrm, ormimg):
    im.file_format = 'PNG'; im.pack()
bpy.data.images.remove(ao)

# ---- final metallic-roughness material
nt.nodes.clear()
out_n = nt.nodes.new('ShaderNodeOutputMaterial'); bsdf = nt.nodes.new('ShaderNodeBsdfPrincipled')
nt.links.new(bsdf.outputs[0], out_n.inputs[0])
tb = nt.nodes.new('ShaderNodeTexImage'); tb.image = base
nt.links.new(tb.outputs['Color'], bsdf.inputs['Base Color'])
tn = nt.nodes.new('ShaderNodeTexImage'); tn.image = nrm
nm = nt.nodes.new('ShaderNodeNormalMap'); nt.links.new(tn.outputs['Color'], nm.inputs['Color']); nt.links.new(nm.outputs[0], bsdf.inputs['Normal'])
to = nt.nodes.new('ShaderNodeTexImage'); to.image = ormimg
sep = nt.nodes.new('ShaderNodeSeparateColor'); nt.links.new(to.outputs['Color'], sep.inputs[0])
nt.links.new(sep.outputs['Green'], bsdf.inputs['Roughness'])
bsdf.inputs['Metallic'].default_value = 0.0
g = bpy.data.node_groups.new('glTF Material Output', 'ShaderNodeTree')
g.interface.new_socket('Occlusion', in_out='INPUT', socket_type='NodeSocketFloat')
gn = nt.nodes.new('ShaderNodeGroup'); gn.node_tree = g
nt.links.new(sep.outputs['Red'], gn.inputs['Occlusion'])
lm.use_backface_culling = False     # fins / arm membranes are single-sided scan surfaces
for a in [a.name for a in lo.data.color_attributes]:
    lo.data.color_attributes.remove(lo.data.color_attributes[a])
for m in list(bpy.data.materials):
    if m.users == 0: bpy.data.materials.remove(m)
for im in list(bpy.data.images):
    if im.users == 0: bpy.data.images.remove(im)

bpy.ops.object.select_all(action='DESELECT'); lo.select_set(True)
bpy.ops.export_scene.gltf(filepath=OUT, export_format='GLB', export_image_format='AUTO', use_selection=True,
                          export_animations=False, export_yup=True, export_apply=False,
                          export_draco_mesh_compression_enable=False, export_lights=False, export_cameras=False)
print('EXPORTED', OUT)
