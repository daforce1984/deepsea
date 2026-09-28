# Build assets/models/raw10/dolphin.glb from the CC-BY model "Dolphin model (with easy texture)" by Sky4gj
# (common bottlenose dolphin, Tursiops truncatus; hand-modelled in 3ds Max; no rig, blurry 1024 px placeholder texture).
# Usage: blender --background --factory-startup --python dolphin.py -- <src.glb> <out.glb> [length_m]
# - welds the body shell and the two eyeballs, bakes all transforms: metres (default 2.6 m), head -> glTF +Z,
#   dorsal -> +Y, bbox centred at the origin
# - high-poly bake source: quads rebuilt from the triangulated shell, Catmull-Clark level 2 (~190k faces) with fine skin
#   relief (low-frequency skin undulation, neck/throat creases, shallow rake-mark scars)
# - low poly: Catmull-Clark level 1 decimated to <= 38k triangles (rounder silhouette than the source), new UV layout
# - textures (new, authored here; the source texture is discarded):
#   base colour 2048 px: bottlenose countershading (dark dorsal cape dipping under the dorsal fin, grey flanks, pale
#   belly/throat/lower jaw with a pinkish ventral tint, faint eye-to-flipper stripe, darker eye patch, fins dark above /
#   lighter below, pale rake-mark scars, subtle mottling), tangent-space normal map 1024 px baked from the high poly,
#   ORM 1024 px (R = baked AO, G = roughness: wet skin 0.26-0.36, eyes 0.08, B = metallic 0)
# - 8-bone spine chain (head, chest=root, back, tail0-3 peduncle, fluke) with automatic (bone-heat) weights and an
#   exact-loop "Swim" clip: dorso-ventral fluke beat, 21 frames at 30 fps = 0.7 s (1.43 Hz), amplitude growing toward
#   the fluke, travelling wave head -> tail, slight counter-pitch of the head. Rest pose = straight body.
# Bakes run with Cycles on the CPU only (the GPU is reserved for the running WebGPU game).
import bpy, sys, math, mathutils, bmesh, numpy as np
from mathutils import Vector, noise

argv = sys.argv[sys.argv.index('--') + 1:]
SRC, OUT = argv[0], argv[1]
LENGTH = float(argv[2]) if len(argv) > 2 else 2.6
MAX_TRIS = 38000
TEX_BASE, TEX_AUX = 2048, 1024
UP_SIGN = 1           # source dorsal direction along the non-lateral short axis
FPS, NFRAMES = 30, 21          # 21 / 30 s = 0.7 s period -> 1.43 Hz tail beat
rng = np.random.default_rng(11)

bpy.ops.wm.read_factory_settings(use_empty=True)
sc = bpy.context.scene
bpy.ops.import_scene.gltf(filepath=SRC)
bpy.context.view_layer.update()

# ---- join body + eyes, bake transforms, weld the split-normal seams
parts = [o for o in bpy.data.objects if o.type == 'MESH']
for o in parts:
    M = o.matrix_world.copy(); o.parent = None; o.matrix_world = M
for o in list(bpy.data.objects):
    if o.type != 'MESH': bpy.data.objects.remove(o)
bpy.ops.object.select_all(action='DESELECT')
for o in parts: o.select_set(True)
body = max(parts, key=lambda o: len(o.data.vertices))
bpy.context.view_layer.objects.active = body
bpy.ops.object.transform_apply(location=True, rotation=True, scale=True)
bpy.ops.object.join()
src = bpy.context.view_layer.objects.active
src.name = 'src'
bmw = bmesh.new(); bmw.from_mesh(src.data)
bmesh.ops.remove_doubles(bmw, verts=bmw.verts, dist=max(src.dimensions) * 1e-6)
bmw.to_mesh(src.data); bmw.free(); src.data.update()

# ---- frame: long axis; head end = eyes' end; lateral = axis separating the two eyes; dorsal = dorsal-fin side
V = np.array([v.co for v in src.data.vertices])
mn, mx = V.min(0), V.max(0); ext = mx - mn
ax = int(np.argmax(ext))
bm = bmesh.new(); bm.from_mesh(src.data); bm.verts.ensure_lookup_table()
comps = []; seen = set()
for v0 in bm.verts:
    if v0.index in seen: continue
    st = [v0]; comp = []; seen.add(v0.index)
    while st:
        v = st.pop(); comp.append(v.index)
        for e in v.link_edges:
            w = e.other_vert(v)
            if w.index not in seen: seen.add(w.index); st.append(w)
    comps.append(comp)
bm.free()
comps.sort(key=len)
eyes = [V[c].mean(0) for c in comps[:-1] if len(c) < 0.05 * len(V)]
assert len(eyes) == 2, 'expected two eyeballs, got %d' % len(eyes)
ec = (eyes[0] + eyes[1]) / 2
head_sign = 1 if ec[ax] > (mn[ax] + mx[ax]) / 2 else -1
o2 = [i for i in range(3) if i != ax]
lat = max(o2, key=lambda i: abs(eyes[0][i] - eyes[1][i])); dv = [i for i in o2 if i != lat][0]
t = (V[:, ax] - mn[ax]) / ext[ax]
if head_sign < 0: t = 1 - t
# dorsal side: this model's back is +dv (source +Z; verified with side renders -- a percentile test is fooled by the
# down-angled flippers and the deep keel of the tail stock)
up_sign = UP_SIGN
fwd = Vector((0, 0, 0)); fwd[ax] = head_sign
up = Vector((0, 0, 0)); up[dv] = up_sign
print('SRC length', ext[ax], 'fwd', tuple(fwd), 'up', tuple(up))
c = Vector((mn + mx) / 2)
Rs = mathutils.Matrix((fwd, up, fwd.cross(up))).transposed()
F, U = Vector((0, -1, 0)), Vector((0, 0, 1))          # Blender -Y = glTF +Z (head), Blender +Z = glTF +Y (dorsal)
Rd = mathutils.Matrix((F, U, F.cross(U))).transposed()
R = (Rd @ Rs.inverted()).to_4x4()
k = LENGTH / ext[ax]
src.data.transform(mathutils.Matrix.Scale(k, 4) @ R @ mathutils.Matrix.Translation(-c))
src.data.update()
bpy.context.view_layer.objects.active = src; src.select_set(True)
bpy.ops.object.mode_set(mode='EDIT'); bpy.ops.mesh.select_all(action='SELECT')
bpy.ops.mesh.remove_doubles(threshold=LENGTH * 1e-5)
bpy.ops.mesh.tris_convert_to_quads(face_threshold=math.radians(40), shape_threshold=math.radians(40))
bpy.ops.mesh.normals_make_consistent(inside=False)
bpy.ops.object.mode_set(mode='OBJECT')
for u in [u.name for u in src.data.uv_layers]: src.data.uv_layers.remove(src.data.uv_layers[u])
src.data.materials.clear()
try: bpy.ops.mesh.customdata_custom_splitnormals_clear()
except Exception: pass
bpy.ops.object.shade_smooth()
# straighten the source's slight head-up / tail-down arch (body centre line z(y), quadratic fit) so the rest pose is
# level and the procedural Swim wave is symmetric; fins and features keep their shape (per-slice vertical shift only)
V = np.array([v.co for v in src.data.vertices])
mn, mx = V.min(0), V.max(0)
ys = np.linspace(mn[1], mx[1], 41); cy, cz = [], []
for y0_, y1_ in zip(ys[:-1], ys[1:]):
    s_ = V[(V[:, 1] >= y0_) & (V[:, 1] < y1_)]
    if len(s_) > 20:
        lo_, hi_ = np.percentile(s_[:, 2], [4, 70]); cy.append((y0_ + y1_) / 2); cz.append((lo_ + hi_) / 2)
cy, cz = np.array(cy), np.array(cz); keep = (cy > mn[1] + 0.04 * LENGTH) & (cy < mx[1] - 0.06 * LENGTH)
pz = np.polyfit(cy[keep], cz[keep], 2)
V[:, 2] -= np.polyval(pz, V[:, 1])
print('arch removed, max shift', float(np.abs(np.polyval(pz, cy)).max()))
mn, mx = V.min(0), V.max(0); V -= (mn + mx) / 2
src.data.vertices.foreach_set('co', V.ravel()); src.data.update()
mn, mx = V.min(0), V.max(0)
print('FINAL bbox', mx - mn, 'quads/tris', np.bincount([len(p.vertices) for p in src.data.polygons]))

def make_copy(name, levels):
    o = src.copy(); o.data = src.data.copy(); o.name = name; o.data.name = name
    sc.collection.objects.link(o)
    bpy.ops.object.select_all(action='DESELECT'); o.select_set(True); bpy.context.view_layer.objects.active = o
    m = o.modifiers.new('sub', 'SUBSURF'); m.levels = levels; m.render_levels = levels; m.quality = 3
    bpy.ops.object.modifier_apply(modifier='sub')
    return o

# ---- body frame helpers: along-body coordinate a (0 = snout tip, 1 = fluke tip), per-slice body centre / half-size
Y0, Y1 = mn[1], mx[1]
def slice_profile(P):
    a = (P[:, 1] - Y0) / (Y1 - Y0)
    nb = 60; bins = np.linspace(0, 1, nb + 1)
    zc, hz, hx = np.zeros(nb), np.zeros(nb), np.zeros(nb)
    for i in range(nb):
        s = P[(a >= bins[i]) & (a < bins[i + 1])]
        if len(s) < 8: zc[i], hz[i], hx[i] = np.nan, np.nan, np.nan; continue
        # body core: ignore fins with robust percentiles
        lo, hi = np.percentile(s[:, 2], [4, 70]); zc[i] = (lo + hi) / 2 + 0.0; hz[i] = max(1e-3, (hi - lo) / 2)
        hx[i] = max(1e-3, np.percentile(np.abs(s[:, 0]), 75))
    ok = ~np.isnan(zc); x = (bins[:-1] + bins[1:]) / 2
    zc, hz, hx = (np.interp(x, x[ok], q[ok]) for q in (zc, hz, hx))
    ker = np.array([1, 2, 3, 2, 1], float); ker /= ker.sum()
    sm = lambda q: np.convolve(np.pad(q, 2, mode='edge'), ker, 'valid')
    zc, hz, hx = sm(zc), sm(hz), sm(hx)
    return a, np.interp(a, x, zc), np.interp(a, x, hz), np.interp(a, x, hx)

def smooth(e0, e1, x):
    x = np.clip((x - e0) / (e1 - e0), 0, 1); return x * x * (3 - 2 * x)

def seg_dist(P, A, B):
    AB = B - A; t = np.clip(((P - A) @ AB) / (AB @ AB), 0, 1)
    return np.linalg.norm(P - (A + t[:, None] * AB), axis=1)

# ---- high poly with skin relief and painted vertex colours
hi = make_copy('hi', 2)
Pn = np.array([v.co for v in hi.data.vertices]); Nn = np.array([v.normal for v in hi.data.vertices])
nv = len(Pn); print('HIGH verts', nv)
a, zc, hz, hx = slice_profile(Pn)
h = (Pn[:, 2] - zc) / hz                     # -1 belly .. +1 back (body core)
xl = Pn[:, 0] / hx
r = np.sqrt(xl ** 2 + h ** 2)
# fins (dorsal, flippers, flukes) = thin parts: local thickness by casting a ray inward along -normal
from mathutils.bvhtree import BVHTree
bvh = BVHTree.FromObject(hi, bpy.context.evaluated_depsgraph_get())
thick = np.full(nv, 1.0)
for i in range(nv):
    n_ = Vector(Nn[i]); hit = bvh.ray_cast(Vector(Pn[i]) - n_ * 1e-4, -n_, 0.3)
    if hit[0] is not None: thick[i] = hit[3]
fin = smooth(0.06, 0.03, thick) * (np.abs(xl) + np.abs(h) > 0.6)
print('fin verts', int((fin > 0.5).sum()), 'of', nv)
# eyes: the two small separate shells
eye_mask = np.zeros(nv, bool)
bmh = bmesh.new(); bmh.from_mesh(hi.data); bmh.verts.ensure_lookup_table()
seen = np.zeros(nv, bool); hcomps = []
for v0 in bmh.verts:
    if seen[v0.index]: continue
    st = [v0]; comp = []; seen[v0.index] = True
    while st:
        v = st.pop(); comp.append(v.index)
        for e in v.link_edges:
            w = e.other_vert(v)
            if not seen[w.index]: seen[w.index] = True; st.append(w)
    hcomps.append(comp)
bmh.free()
hcomps.sort(key=len)
for cmp in hcomps[:-1]: eye_mask[cmp] = True
eye_c = [Pn[cmp].mean(0) for cmp in hcomps[:-1]]
print('eyes at', [tuple(np.round(e, 3)) for e in eye_c])

# relief (metres, along the normal)
nz1 = np.array([noise.noise(Vector(p * 18.0)) for p in Pn])
nz2 = np.array([noise.noise(Vector(p * 55.0 + 3.1)) for p in Pn])
disp = 0.00035 * nz1 + 0.00012 * nz2
# neck / throat creases behind the head (lower and lateral surfaces)
for a0, d in ((0.185, 0.0007), (0.2, 0.0009), (0.215, 0.0006)):
    disp -= d * np.exp(-((a - a0) / 0.0035) ** 2) * smooth(0.4, -0.2, h) * (1 - fin)
# blowhole-to-melon ridge softening is in the source geometry; add rake-mark scars (paired shallow grooves)
scar = np.zeros(nv)
Q = np.stack([a * (Y1 - Y0), h * hz], 1)            # metres along the body, metres above the slice centre
for i in range(16):
    side = 1 if i % 2 else -1
    A = np.array([rng.uniform(0.25, 0.75) * (Y1 - Y0), rng.uniform(-0.3, 0.7) * float(np.median(hz))])
    ang = rng.uniform(-0.6, 0.6) + (math.pi / 2 if rng.random() < 0.4 else 0)
    dirv = np.array([math.cos(ang), math.sin(ang)]); perp = np.array([-dirv[1], dirv[0]])
    L = rng.uniform(0.05, 0.14)
    for kk in range(int(rng.integers(2, 4))):        # tooth rake: 2-3 parallel lines ~1 cm apart
        A2 = A + perp * 0.011 * kk; B2 = A2 + dirv * L
        dd = seg_dist(Q, A2, B2)
        m = np.exp(-(dd / 0.0022) ** 2) * (np.sign(Pn[:, 0]) == side) * (np.abs(xl) > 0.35) * (1 - fin)
        scar = np.maximum(scar, m * rng.uniform(0.5, 1.0))
disp -= 0.0003 * scar
disp[eye_mask] = 0
Pn2 = Pn + Nn * disp[:, None]
hi.data.vertices.foreach_set('co', Pn2.ravel()); hi.data.update()

# colours (sRGB, converted to linear for the float colour attribute)
def C(*v): return np.array(v, float)
cape, flank, belly, pink, eyec = C(.25, .28, .31), C(.5, .53, .56), C(.86, .85, .84), C(.87, .78, .77), C(.03, .03, .035)
# cape boundary: high at the melon, dips toward the flank under the dorsal fin, rises again on the tail stock
cape_line = 0.6 - 0.28 * np.exp(-((a - 0.45) / 0.2) ** 2) - 0.1 * smooth(0.1, 0.25, a) + 0.1 * smooth(0.7, 0.9, a)
cape_line += 0.05 * np.array([noise.noise(Vector((q * 9.0, 0, 7.7))) for q in a])
kc = smooth(cape_line - 0.35, cape_line + 0.3, h)
# belly boundary: high on the lower jaw / throat, low along the flank, wavy
belly_line = -0.2 + 0.25 * smooth(0.22, 0.06, a) - 0.25 * smooth(0.6, 0.88, a)
belly_line += 0.04 * np.sin(a * 40.0) * smooth(0.25, 0.4, a) + 0.05 * np.array([noise.noise(Vector((q * 12.0, 3.3, 0))) for q in a])
kb = smooth(belly_line + 0.15, belly_line - 0.2, h)
col = flank[None] * np.ones((nv, 1))
col = col * (1 - kc[:, None]) + cape * kc[:, None]
bel = belly[None] * (1 - smooth(0.5, 0.62, a) * smooth(0.78, 0.66, a))[:, None] + pink[None] * (smooth(0.5, 0.62, a) * smooth(0.78, 0.66, a))[:, None]
col = col * (1 - kb[:, None]) + bel * kb[:, None]
# upper rostrum a little lighter grey, lip line darker
col = col * (1 + 0.08 * smooth(0.06, 0.0, a)[:, None] * (h > 0)[:, None])
# fins: dark above, mid grey below (flukes lighter underneath)
fin_col = cape[None] * smooth(-0.3, 0.3, Nn[:, 2])[:, None] + (flank * 1.05)[None] * smooth(0.3, -0.3, Nn[:, 2])[:, None]
col = col * (1 - fin[:, None]) + fin_col * fin[:, None]
# eye patch + faint eye-to-flipper stripe + eye-to-blowhole line (typical bottlenose markings)
pect = Pn[(a > 0.2) & (a < 0.34) & (fin > 0.5) & (h < 0.2)]
for e in eye_c:
    sgn = np.sign(e[0])
    d = np.linalg.norm(Pn - e, axis=1)
    col *= (1 - 0.3 * np.exp(-(d / 0.03) ** 2))[:, None]
    ps = pect[np.sign(pect[:, 0]) == sgn]
    if len(ps):
        root = ps[np.argmin(np.abs(ps[:, 0]))]           # insertion of the flipper (closest to the midline)
        dd = seg_dist(Pn, e, root)
        col *= (1 - 0.2 * np.exp(-(dd / 0.012) ** 2) * (np.sign(Pn[:, 0]) == sgn))[:, None]
    dd = seg_dist(Pn, e, np.array([e[0] * 0.3, e[1] + 0.14, e[2] + 0.1]))
    col *= (1 - 0.1 * np.exp(-(dd / 0.01) ** 2) * (np.sign(Pn[:, 0]) == sgn))[:, None]
# scars pale, mottling
col = col + (0.16 * scar)[:, None]
col *= (1 + 0.05 * nz1 + 0.03 * nz2)[:, None]
col[eye_mask] = eyec
col = np.clip(col, 0, 1)
lin = np.where(col <= 0.04045, col / 12.92, ((col + 0.055) / 1.055) ** 2.4)
rough = np.clip(0.28 + 0.06 * kb - 0.02 * kc + 0.03 * nz2 + 0.05 * scar, 0.24, 0.4)
rough[eye_mask] = 0.08
ca = hi.data.color_attributes.new('col', 'FLOAT_COLOR', 'POINT')
ca.data.foreach_set('color', np.concatenate([lin, np.ones((nv, 1))], 1).astype(np.float32).ravel())
ra = hi.data.color_attributes.new('rough', 'FLOAT_COLOR', 'POINT')
ra.data.foreach_set('color', np.stack([rough, rough, rough, np.ones(nv)], 1).astype(np.float32).ravel())

hm = bpy.data.materials.new('hi_emit'); nt = hm.node_tree; nt.nodes.clear()
at = nt.nodes.new('ShaderNodeVertexColor'); at.layer_name = 'col'
tc = nt.nodes.new('ShaderNodeTexCoord')
nz = nt.nodes.new('ShaderNodeTexNoise'); nz.inputs['Scale'].default_value = 140.0; nz.inputs['Detail'].default_value = 4.0
nt.links.new(tc.outputs['Object'], nz.inputs['Vector'])
mr = nt.nodes.new('ShaderNodeMapRange'); mr.inputs['To Min'].default_value = 0.955; mr.inputs['To Max'].default_value = 1.045
nt.links.new(nz.outputs['Fac'], mr.inputs['Value'])
mu = nt.nodes.new('ShaderNodeVectorMath'); mu.operation = 'SCALE'
nt.links.new(at.outputs['Color'], mu.inputs[0]); nt.links.new(mr.outputs['Result'], mu.inputs['Scale'])
em = nt.nodes.new('ShaderNodeEmission'); oo = nt.nodes.new('ShaderNodeOutputMaterial')
nt.links.new(mu.outputs[0], em.inputs['Color']); nt.links.new(em.outputs[0], oo.inputs[0])
hi.data.materials.append(hm)

# ---- low poly: subdiv 1, decimate, UVs
lo = make_copy('dolphin', 1)
lo.data.calc_loop_triangles(); t_hi = len(lo.data.loop_triangles)
d = lo.modifiers.new('dec', 'DECIMATE'); d.ratio = MAX_TRIS / t_hi * 0.99
bpy.ops.object.modifier_apply(modifier='dec')
bpy.ops.object.mode_set(mode='EDIT'); bpy.ops.mesh.select_all(action='SELECT')
bpy.ops.mesh.quads_convert_to_tris()
bpy.ops.mesh.normals_make_consistent(inside=False)
bpy.ops.uv.smart_project(angle_limit=math.radians(66), island_margin=0.003, area_weight=0.0, scale_to_bounds=False)
bpy.ops.object.mode_set(mode='OBJECT')
lo.data.uv_layers[0].name = 'UVMap'
bpy.ops.object.shade_smooth()
lo.data.calc_loop_triangles(); print('TRIS', t_hi, '->', len(lo.data.loop_triangles))

# ---- bakes (Cycles CPU)
sc.render.engine = 'CYCLES'; sc.cycles.device = 'CPU'
sc.cycles.samples = 1; sc.cycles.use_denoising = False
def new_img(name, size, color):
    im = bpy.data.images.new(name, size, size, alpha=False)
    im.colorspace_settings.name = 'sRGB' if color else 'Non-Color'
    return im
lm = bpy.data.materials.new('dolphin_skin'); lo.data.materials.clear(); lo.data.materials.append(lm)
lnt = lm.node_tree
bake_node = lnt.nodes.new('ShaderNodeTexImage')
def bake(kind, img, sel):
    bake_node.image = img; lnt.nodes.active = bake_node
    bpy.ops.object.select_all(action='DESELECT')
    if sel: hi.select_set(True)
    lo.select_set(True); bpy.context.view_layer.objects.active = lo
    sc.render.bake.use_selected_to_active = sel
    sc.render.bake.cage_extrusion = 0.004
    sc.render.bake.max_ray_distance = 0.012
    bpy.ops.object.bake(type=kind, normal_space='TANGENT', use_clear=True, margin=8)
    print('baked', kind, img.name)
base = new_img('dolphin_basecolor', TEX_BASE, True); bake('EMIT', base, True)
nrm = new_img('dolphin_normal', TEX_AUX, False); bake('NORMAL', nrm, True)
a_ = np.array(nrm.pixels[:], dtype=np.float32).reshape(-1, 4)
n_ = a_[:, :3] * 2 - 1; bad = n_[:, 2] < 0.5
xy = n_[:, :2]; l_ = np.linalg.norm(xy, axis=1, keepdims=True) + 1e-6
n_[bad, 2] = 0.5; n_[bad, :2] = xy[bad] / l_[bad] * math.sqrt(1 - 0.25)
n_ /= np.linalg.norm(n_, axis=1, keepdims=True); a_[:, :3] = n_ * 0.5 + 0.5
nrm.pixels[:] = a_.ravel(); print('normal texels clamped', int(bad.sum()))
# roughness: switch the high-poly emission to the 'rough' attribute
at.layer_name = 'rough'; nt.links.new(at.outputs['Color'], em.inputs['Color'])
rimg = new_img('dolphin_rough', TEX_AUX, False); bake('EMIT', rimg, True)
hi.hide_render = True
sc.cycles.samples = 32
sc.world = bpy.data.worlds.new('w')
ao = new_img('dolphin_ao', TEX_AUX, False); bake('AO', ao, False)
bpy.data.objects.remove(hi)
aov = np.array(ao.pixels[:], np.float32).reshape(TEX_AUX, TEX_AUX, 4)[..., 0]
rv = np.array(rimg.pixels[:], np.float32).reshape(TEX_AUX, TEX_AUX, 4)[..., 0]
orm = np.stack([0.35 + 0.65 * aov, rv, np.zeros_like(rv), np.ones_like(rv)], -1)
ormimg = new_img('dolphin_orm', TEX_AUX, False); ormimg.pixels[:] = orm.ravel()
print('ROUGH', float(np.percentile(rv, 5)), float(np.percentile(rv, 95)))
for im in (base, nrm, ormimg):
    im.file_format = 'PNG'; im.pack()
bpy.data.images.remove(ao); bpy.data.images.remove(rimg)

# ---- final metallic-roughness material
lnt.nodes.clear()
out = lnt.nodes.new('ShaderNodeOutputMaterial'); bsdf = lnt.nodes.new('ShaderNodeBsdfPrincipled')
lnt.links.new(bsdf.outputs[0], out.inputs[0])
tb = lnt.nodes.new('ShaderNodeTexImage'); tb.image = base; lnt.links.new(tb.outputs['Color'], bsdf.inputs['Base Color'])
tn = lnt.nodes.new('ShaderNodeTexImage'); tn.image = nrm
nm = lnt.nodes.new('ShaderNodeNormalMap'); lnt.links.new(tn.outputs['Color'], nm.inputs['Color']); lnt.links.new(nm.outputs[0], bsdf.inputs['Normal'])
to = lnt.nodes.new('ShaderNodeTexImage'); to.image = ormimg
sep = lnt.nodes.new('ShaderNodeSeparateColor'); lnt.links.new(to.outputs['Color'], sep.inputs[0])
lnt.links.new(sep.outputs['Green'], bsdf.inputs['Roughness']); lnt.links.new(sep.outputs['Blue'], bsdf.inputs['Metallic'])
g = bpy.data.node_groups.new('glTF Material Output', 'ShaderNodeTree')
g.interface.new_socket('Occlusion', in_out='INPUT', socket_type='NodeSocketFloat')
gn = lnt.nodes.new('ShaderNodeGroup'); gn.node_tree = g
lnt.links.new(sep.outputs['Red'], gn.inputs['Occlusion'])
lm.use_backface_culling = True       # closed shell
for cattr in [x.name for x in lo.data.color_attributes]:
    lo.data.color_attributes.remove(lo.data.color_attributes[cattr])
bpy.data.objects.remove(src)

# ---- armature: 8-bone spine chain along the body axis (Blender -Y = head). Root = chest.
V = np.array([v.co for v in lo.data.vertices])
Yh, Yt = V[:, 1].min(), V[:, 1].max()
al, zcl, _, _ = slice_profile(V)
def P(aa):
    zz = float(np.interp(aa, np.sort(al), zcl[np.argsort(al)]))
    return Vector((0.0, Yh + aa * (Yt - Yh), zz))
arm_d = bpy.data.armatures.new('DolphinRig'); arm = bpy.data.objects.new('DolphinRig', arm_d)
sc.collection.objects.link(arm)
bpy.ops.object.select_all(action='DESELECT'); arm.select_set(True); bpy.context.view_layer.objects.active = arm
bpy.ops.object.mode_set(mode='EDIT')
eb = arm_d.edit_bones
def bone(name, a0, a1, parent=None, conn=False):
    b = eb.new(name); b.head = P(a0); b.tail = P(a1); b.roll = 0.0
    if parent: b.parent = eb[parent]; b.use_connect = conn
    return b
bone('chest', 0.30, 0.44)
bone('head', 0.30, 0.02, 'chest')
bone('back', 0.44, 0.56, 'chest', True)
bone('tail0', 0.56, 0.66, 'back', True)
bone('tail1', 0.66, 0.75, 'tail0', True)
bone('tail2', 0.75, 0.83, 'tail1', True)
bone('peduncle', 0.83, 0.895, 'tail2', True)
bone('fluke', 0.895, 1.0, 'peduncle', True)
for b in eb: b.align_roll(Vector((0, 0, 1)))
bpy.ops.object.mode_set(mode='OBJECT')
BONES = ['head', 'chest', 'back', 'tail0', 'tail1', 'tail2', 'peduncle', 'fluke']

bpy.ops.object.select_all(action='DESELECT'); lo.select_set(True); arm.select_set(True)
bpy.context.view_layer.objects.active = arm
bpy.ops.object.parent_set(type='ARMATURE_AUTO')
# verify / repair: every vertex needs weights (bone heat can miss the detached eyeballs)
gidx = {vg.index: vg.name for vg in lo.vertex_groups}
W = np.zeros((len(lo.data.vertices), len(BONES)))
for v in lo.data.vertices:
    for gg in v.groups:
        if gidx[gg.group] in BONES: W[v.index, BONES.index(gidx[gg.group])] = gg.weight
empty = W.sum(1) < 1e-4
print('auto-weight empty verts', int(empty.sum()))
if empty.any():
    from mathutils.kdtree import KDTree
    good = np.where(~empty)[0]; kd = KDTree(len(good))
    for j, i in enumerate(good): kd.insert(V[i], j)
    kd.balance()
    for i in np.where(empty)[0]:
        j = kd.find(V[i])[1]; W[i] = W[good[j]]
        for bi, name in enumerate(BONES):
            if W[i, bi] > 0: lo.vertex_groups[name].add([int(i)], float(W[i, bi]), 'REPLACE')
# limit to 4 influences, normalise
bpy.ops.object.select_all(action='DESELECT'); lo.select_set(True); bpy.context.view_layer.objects.active = lo
bpy.ops.object.vertex_group_limit_total(group_select_mode='ALL', limit=4)
bpy.ops.object.vertex_group_normalize_all(group_select_mode='ALL', lock_active=False)

# ---- Swim clip: exact loop, pitch about the bone's local X (lateral) axis
sc.render.fps = FPS; sc.frame_start = 0; sc.frame_end = NFRAMES
act = bpy.data.actions.new('Swim')
arm.animation_data_create(); arm.animation_data.action = act
AMP = {'head': -0.035, 'chest': 0.02, 'back': 0.035, 'tail0': 0.055, 'tail1': 0.08, 'tail2': 0.1, 'peduncle': 0.13, 'fluke': 0.3}
PH = {'head': 0.0, 'chest': 0.0, 'back': 0.35, 'tail0': 0.7, 'tail1': 1.05, 'tail2': 1.4, 'peduncle': 1.75, 'fluke': 1.75 + 1.1}
for pb in arm.pose.bones: pb.rotation_mode = 'QUATERNION'
for f in range(NFRAMES + 1):
    ph = 2 * math.pi * f / NFRAMES
    for name in BONES:
        pb = arm.pose.bones[name]
        ang = AMP[name] * math.sin(ph - PH[name])
        pb.rotation_quaternion = mathutils.Quaternion((1, 0, 0), ang)
        pb.keyframe_insert('rotation_quaternion', frame=f)
# measure fluke-tip heave for the log
tips = []
for f in range(NFRAMES):
    sc.frame_set(f); bpy.context.view_layer.update()
    tips.append((arm.matrix_world @ arm.pose.bones['fluke'].tail).z)
print('fluke tip heave peak-to-peak (m)', max(tips) - min(tips))
sc.frame_set(0)

# ---- export
for m in list(bpy.data.materials):
    if m.users == 0: bpy.data.materials.remove(m)
for im in list(bpy.data.images):
    if im.users == 0: bpy.data.images.remove(im)
bpy.ops.object.select_all(action='DESELECT'); lo.select_set(True); arm.select_set(True)
bpy.ops.export_scene.gltf(filepath=OUT, export_format='GLB', export_image_format='AUTO', use_selection=True,
                          export_animations=True, export_animation_mode='ACTIONS', export_force_sampling=True,
                          export_frame_range=True, export_anim_single_armature=True, export_def_bones=True,
                          export_morph=False, export_yup=True, export_apply=False, export_skins=True,
                          export_draco_mesh_compression_enable=False, export_lights=False, export_cameras=False)
print('EXPORTED', OUT)
