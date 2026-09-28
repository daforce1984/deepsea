# Build assets/models/raw12/manta.glb from the CC-BY model "Manta Ray Swim" by tferdin1 (Sketchfab / Objaverse
# uid 2f2892de34de4ed2b562c8194ca5f3f6): a hand-sculpted giant manta (Mobula birostris type) with cephalic fins, eyes,
# five pairs of ventral gill slits, spotted belly, dorsal fin, pelvic fins and whip tail; 88.6k tris, 1024 px painted
# texture in saturated navy-blue / lavender, no normal map, skinned to a 31-joint FBX rig with a 3.6 s, non-exact-loop,
# ~0.6 Hz flap clip. Mesh top and bottom are open shells (single-sided sheets) -> material is double-sided.
# Usage:
#   blender --background --factory-startup --python manta.py -- <src.glb> <out.glb> [span_m] [--preview=<png>] [--old=<old.glb>]
# Steps
# - drops the source rig (bind-pose mesh kept), bakes all transforms: metres, wingspan (disc width, glTF X) = 4.5 m,
#   head (cephalic fins) -> glTF +Z, dorsal -> glTF +Y, bbox centred; the head end is detected from geometry
#   (wide bilobed cephalic-fin end vs. the thin whip tail) and asserted.
# - high-poly bake source = the full source mesh with a recoloured texture (navy/lavender paint mapped to realistic
#   oceanic-manta tones: near-black dorsal surface, white shoulder patches, white belly, dark ventral spots, grey
#   ventral wing margins) plus a fine skin relief (bump) for the normal bake. After the colour bake, up-facing texels
#   outside the shoulder-patch zone are darkened (removes the source's painted light-blue sheen streaks and pale crown),
#   using per-texel position/normal maps baked from the low poly.
# - low poly: symmetric collapse-decimation to <= 38k triangles, new UV layout (smart UV project), smooth normals.
# - Cycles CPU bakes: base colour 2048 px, tangent-space normal 1024 px (from the full-res source + skin relief),
#   AO 1024 px -> ORM (R = AO, G = roughness 0.55-0.70, B = metallic 0). Double-sided (open top/bottom shells).
# - new 16-joint rig (root, head/front spine, rear spine, 3 tail bones, 2 cephalic-fin bones, 4-bone chain per wing) with
#   smooth geometric weights (spanwise hat functions along each wing chain, body split along the axis), <= 4 influences.
# - exact-loop "Swim" clip: 96 frames at 24 fps = 4.0 s (0.25 Hz), symmetric wing beat with a travelling wave toward
#   the tips (0.35 rad phase lag per wing segment), spanwise-growing chord twist (leading edge down on the downstroke),
#   slight body heave/pitch, trailing tail wave, cephalic-fin flutter. Frame 0 is a near-flat wing pose so the game's
#   frame-0 span measurement matches the real span.
# Bakes and previews use Cycles on the CPU only (the GPU is reserved for the running WebGPU game).
import bpy, sys, math, mathutils, bmesh, os, numpy as np
from mathutils import Vector, Matrix, Quaternion

argv = sys.argv[sys.argv.index('--') + 1:]
POS = [a for a in argv if not a.startswith('--')]
FL = dict(a.lstrip('-').partition('=')[::2] for a in argv if a.startswith('--'))
SRC, OUT = POS[0], POS[1]
SPAN = float(POS[2]) if len(POS) > 2 else 4.5
PREVIEW, OLD = FL.get('preview'), FL.get('old')
assert os.path.isabs(OUT) and (PREVIEW is None or os.path.isabs(PREVIEW)), 'absolute output paths only'
MAX_TRIS = 38000
TEX_BASE, TEX_AUX = 2048, 1024
FPS, NFR = 24, 96                      # 4.0 s loop -> 0.25 Hz wing beat
NAME = 'manta'

bpy.ops.wm.read_factory_settings(use_empty=True)
sc = bpy.context.scene
bpy.ops.import_scene.gltf(filepath=SRC)
bpy.context.view_layer.update()

# ---------------------------------------------------------------- bind-pose mesh, rig removed
src = next(o for o in bpy.data.objects if o.type == 'MESH' and o.data.vertices and any(m.type == 'ARMATURE' for m in o.modifiers))
for m in list(src.modifiers): src.modifiers.remove(m)
M = src.matrix_world.copy(); src.parent = None; src.matrix_world = M
for o in list(bpy.data.objects):
    if o != src: bpy.data.objects.remove(o)
for a in list(bpy.data.actions): bpy.data.actions.remove(a)
src.vertex_groups.clear()
bpy.ops.object.select_all(action='DESELECT'); src.select_set(True); bpy.context.view_layer.objects.active = src
bpy.ops.object.transform_apply(location=True, rotation=True, scale=True)
src.name = 'src_hi'

V = np.array([v.co for v in src.data.vertices])
mn, mx = V.min(0), V.max(0); ext = mx - mn
print('SRC bbox', ext)
assert ext[0] > ext[2] * 4 and ext[1] > ext[2] * 4, 'expected a flat disc in the Blender XY plane'
# head end: the bilobed cephalic-fin end is wide, the whip-tail end is a thin rod
def end_width(lo_frac, hi_frac):
    t = (V[:, 1] - mn[1]) / ext[1]; s = V[(t >= lo_frac) & (t <= hi_frac)]
    return s[:, 0].max() - s[:, 0].min(), s
w_neg, _ = end_width(0.0, 0.04); w_pos, s_pos = end_width(0.96, 1.0)
head_pos_y = w_pos > w_neg
print('end widths: -Y %.2f  +Y %.2f  -> head at source %sY' % (w_neg, w_pos, '+' if head_pos_y else '-'))
assert max(w_neg, w_pos) > 8 * min(w_neg, w_pos), 'head/tail ends not distinguishable'
# (source up = Blender +Z: the dorsal texture is the dark one, checked below after the bake)
R = Matrix.Rotation(math.pi, 4, 'Z') if head_pos_y else Matrix.Identity(4)   # head -> Blender -Y (= glTF +Z)
k = SPAN / ext[0]
src.data.transform(Matrix.Scale(k, 4) @ R @ Matrix.Translation(-Vector((mn + mx) / 2)))
src.data.update()
bpy.ops.object.mode_set(mode='EDIT'); bpy.ops.mesh.select_all(action='SELECT')
bpy.ops.mesh.remove_doubles(threshold=SPAN * 2e-5)
bpy.ops.mesh.delete_loose()
bpy.ops.object.mode_set(mode='OBJECT')
V = np.array([v.co for v in src.data.vertices]); c = (V.min(0) + V.max(0)) / 2; V -= c
src.data.vertices.foreach_set('co', V.ravel()); src.data.update()
E = V.max(0) - V.min(0)
print('NORMALISED bbox (Blender x=span, y=length, z=thickness)', np.round(E, 4))
# geometric head check in the output frame: cephalic fins = two lobes at the -Y end, tail = thin rod at +Y
hs = V[V[:, 1] < V[:, 1].min() + 0.08 * E[1]]; ts = V[V[:, 1] > V[:, 1].max() - 0.08 * E[1]]
hist = np.histogram(hs[:, 0], bins=9, range=(hs[:, 0].min(), hs[:, 0].max()))[0]
print('head-end width %.3f m (x-histogram %s), tail-end width %.3f m' % (np.ptp(hs[:, 0]), hist.tolist(), np.ptp(ts[:, 0])))
assert np.ptp(hs[:, 0]) > 5 * np.ptp(ts[:, 0]) and hist[4] < max(hist[1], hist[-2]), 'head must be the bilobed -Y end'

# ---------------------------------------------------------------- recoloured source texture
src_img = None
for m in src.data.materials:
    for n in (m.node_tree.nodes if m and m.node_tree else []):
        if n.type == 'TEX_IMAGE' and n.image and n.image.colorspace_settings.name == 'sRGB':
            if src_img is None or n.image.size[0] > src_img.size[0]: src_img = n.image
print('source texture', src_img.name, tuple(src_img.size))
w_, h_ = src_img.size
A = np.array(src_img.pixels[:], np.float32).reshape(h_, w_, 4)
lin = A[..., :3]
srgb = np.where(lin <= 0.0031308, lin * 12.92, 1.055 * np.power(np.clip(lin, 0, 1), 1 / 2.4) - 0.055)
luma = srgb @ np.array([0.299, 0.587, 0.114], np.float32)
sat = srgb.max(-1) - srgb.min(-1)
# navy (luma ~0.12) -> near-black; painted light-blue highlight streaks (0.35-0.6) compressed; white/lavender -> white
def sstep(a, b, x): t = np.clip((x - a) / (b - a), 0, 1); return t * t * (3 - 2 * t)
v = 0.085 + 0.08 * np.clip(luma, 0, 1) + 0.70 * sstep(0.38, 0.88, luma)
tint = np.stack([0.96 + 0.05 * sstep(0.3, 0.8, luma), np.full_like(luma, 0.985), 1.0 + 0.03 * (1 - sstep(0.3, 0.8, luma))], -1)
out_s = np.clip(v[..., None] * tint, 0, 1)
out_l = np.where(out_s <= 0.04045, out_s / 12.92, np.power((out_s + 0.055) / 1.055, 2.4))
# write the recoloured texture into the source image buffer (Cycles re-generates 'GENERATED' images as blank)
rec = src_img
rec.pixels[:] = np.concatenate([out_l, A[..., 3:]], -1).ravel(); rec.update()
print('recoloured texture mean', float(np.array(rec.pixels[:]).reshape(-1, 4)[:, :3].mean()))
print('recolour: luma percentiles in', np.round(np.percentile(luma, [5, 50, 95]), 3), 'saturation mean', float(sat.mean()))

hm = bpy.data.materials.new('src_bake'); nt = hm.node_tree; nt.nodes.clear()
oo = nt.nodes.new('ShaderNodeOutputMaterial'); add = nt.nodes.new('ShaderNodeAddShader')
em = nt.nodes.new('ShaderNodeEmission'); pr = nt.nodes.new('ShaderNodeBsdfPrincipled')
ti = nt.nodes.new('ShaderNodeTexImage'); ti.image = rec
nt.links.new(ti.outputs['Color'], em.inputs['Color'])
# fine skin relief for the normal bake: object-space noise, ~1-2 cm grain + soft 10 cm undulation
tc = nt.nodes.new('ShaderNodeTexCoord')
n1 = nt.nodes.new('ShaderNodeTexNoise'); n1.inputs['Scale'].default_value = 70.0; n1.inputs['Detail'].default_value = 4.0
n2 = nt.nodes.new('ShaderNodeTexNoise'); n2.inputs['Scale'].default_value = 9.0; n2.inputs['Detail'].default_value = 2.0
nt.links.new(tc.outputs['Object'], n1.inputs['Vector']); nt.links.new(tc.outputs['Object'], n2.inputs['Vector'])
mix = nt.nodes.new('ShaderNodeMath'); mix.operation = 'MULTIPLY_ADD'
nt.links.new(n2.outputs['Fac'], mix.inputs[0]); mix.inputs[1].default_value = 2.5; nt.links.new(n1.outputs['Fac'], mix.inputs[2])
bump = nt.nodes.new('ShaderNodeBump'); bump.inputs['Strength'].default_value = 0.35; bump.inputs['Distance'].default_value = 0.0012
nt.links.new(mix.outputs[0], bump.inputs['Height']); nt.links.new(bump.outputs['Normal'], pr.inputs['Normal'])
nt.links.new(em.outputs[0], oo.inputs[0])      # EMIT bake: pure emission; switched to the bump BSDF for the normal bake
nt.nodes.remove(add)
src.data.materials.clear(); src.data.materials.append(hm)

# ---------------------------------------------------------------- low poly
lo = src.copy(); lo.data = src.data.copy(); lo.name = NAME; lo.data.name = NAME
sc.collection.objects.link(lo)
lo.data.calc_loop_triangles(); tris_hi = len(lo.data.loop_triangles)
bpy.ops.object.select_all(action='DESELECT'); lo.select_set(True); bpy.context.view_layer.objects.active = lo
d = lo.modifiers.new('dec', 'DECIMATE'); d.ratio = MAX_TRIS / tris_hi * 0.985
d.use_symmetry = True; d.symmetry_axis = 'X'
bpy.ops.object.modifier_apply(modifier='dec')
bpy.ops.object.mode_set(mode='EDIT'); bpy.ops.mesh.select_all(action='SELECT')
bpy.ops.mesh.quads_convert_to_tris()
bpy.ops.mesh.select_all(action='SELECT')
bpy.ops.uv.smart_project(angle_limit=math.radians(66), island_margin=0.003, area_weight=0.0, scale_to_bounds=False)
bpy.ops.object.mode_set(mode='OBJECT')
for u in [u.name for u in lo.data.uv_layers][1:]: lo.data.uv_layers.remove(lo.data.uv_layers[u])
lo.data.uv_layers[0].name = 'UVMap'
try: bpy.ops.mesh.customdata_custom_splitnormals_clear()
except Exception as e: print('no custom normals', e)
bpy.ops.object.shade_smooth()
lo.data.calc_loop_triangles(); TRIS = len(lo.data.loop_triangles)
print('TRIS', tris_hi, '->', TRIS); assert TRIS <= 40000

# ---------------------------------------------------------------- bakes (Cycles CPU)
sc.render.engine = 'CYCLES'; sc.cycles.device = 'CPU'; sc.cycles.samples = 1; sc.cycles.use_denoising = False
def new_img(name, size, color):
    im = bpy.data.images.new(name, size, size, alpha=False)
    im.colorspace_settings.name = 'sRGB' if color else 'Non-Color'; return im
lm = bpy.data.materials.new(NAME + '_skin'); lo.data.materials.clear(); lo.data.materials.append(lm)
lnt = lm.node_tree; bake_node = lnt.nodes.new('ShaderNodeTexImage')
def bake(kind, img, s2a):
    bake_node.image = img; lnt.nodes.active = bake_node
    bpy.ops.object.select_all(action='DESELECT')
    if s2a: src.select_set(True)
    lo.select_set(True); bpy.context.view_layer.objects.active = lo
    sc.render.bake.use_selected_to_active = s2a
    sc.render.bake.cage_extrusion = SPAN * 0.0008      # thin wing edges: top and bottom sheets are mm apart
    sc.render.bake.max_ray_distance = 0.0
    bpy.ops.object.bake(type=kind, normal_space='TANGENT', use_clear=True, margin=8)
    print('baked', kind, 'mean', float(np.mean(np.array(img.pixels[:], np.float32).reshape(-1, 4)[:, :3])))
base = new_img(NAME + '_basecolor', TEX_BASE, True)
bake('EMIT', base, True)
# ---- dorsal clean-up: the source paint has light-blue "sheen" streaks on the dark back and a pale crown between the
# eyes; M. birostris is uniformly black above except the two white shoulder patches. Bake per-texel position + normal
# of the low poly, then darken up-facing texels outside the shoulder-patch zone (belly, fin insides, mouth untouched).
def geo_bake(socket_name, size):
    im = bpy.data.images.new('geo_' + socket_name, size, size, alpha=False, float_buffer=True)
    im.colorspace_settings.name = 'Non-Color'
    ge = lnt.nodes.new('ShaderNodeNewGeometry'); vm = lnt.nodes.new('ShaderNodeVectorMath'); vm.operation = 'MULTIPLY_ADD'
    vm.inputs[1].default_value = (0.1, 0.1, 0.1) if socket_name == 'Position' else (0.5, 0.5, 0.5)
    vm.inputs[2].default_value = (0.5, 0.5, 0.5)
    em2 = lnt.nodes.new('ShaderNodeEmission'); o2 = lnt.nodes.new('ShaderNodeOutputMaterial'); o2.is_active_output = True
    lnt.links.new(ge.outputs[socket_name], vm.inputs[0]); lnt.links.new(vm.outputs[0], em2.inputs['Color']); lnt.links.new(em2.outputs[0], o2.inputs[0])
    bake('EMIT', im, False)
    q = np.array(im.pixels[:], np.float32).reshape(size, size, 4)[..., :3]
    for n_ in (ge, vm, em2, o2): lnt.nodes.remove(n_)
    bpy.data.images.remove(im)
    return (q - 0.5) / (0.1 if socket_name == 'Position' else 0.5)
GP = geo_bake('Position', TEX_BASE); GN = geo_bake('Normal', TEX_BASE)
bb_ = np.array(base.pixels[:], np.float32).reshape(TEX_BASE, TEX_BASE, 4)
col = bb_[..., :3]; lum_b = col @ np.array([0.2126, 0.7152, 0.0722], np.float32)
gx, gy = np.abs(GP[..., 0]), GP[..., 1]
up = sstep(0.15, 0.5, GN[..., 2])
# shoulder patches: behind the eyes, either side of the midline (measured on the source paint)
shoulder = sstep(0.10, 0.18, gx) * (1 - sstep(0.80, 1.0, gx)) * sstep(-1.55, -1.40, gy) * (1 - sstep(-0.55, -0.35, gy))
dark = 0.012 + 0.10 * np.minimum(col, 0.12)                   # near-black with a little of the paint's variation
kill = (up * (1 - shoulder))[..., None]
col = col * (1 - kill) + dark * kill
bb_[..., :3] = col; base.pixels[:] = bb_.ravel()
print('dorsal clean-up: texels darkened', int((kill[..., 0] > 0.5).sum()), 'shoulder texels', int((shoulder * up > 0.5).sum()))
nt.links.new(pr.outputs[0], oo.inputs[0])
nrm = new_img(NAME + '_normal', TEX_AUX, False); bake('NORMAL', nrm, True)
a = np.array(nrm.pixels[:], np.float32).reshape(-1, 4); n = a[:, :3] * 2 - 1
bad = n[:, 2] < 0.35; xy = n[:, :2]; l = np.linalg.norm(xy, axis=1, keepdims=True) + 1e-6
n[bad, 2] = 0.35; n[bad, :2] = xy[bad] / l[bad] * math.sqrt(1 - 0.35 ** 2)
n /= np.linalg.norm(n, axis=1, keepdims=True); a[:, :3] = n * 0.5 + 0.5; nrm.pixels[:] = a.ravel()
print('normal texels clamped', int(bad.sum()), 'of', len(a))
src.hide_render = True
sc.cycles.samples = 32; sc.world = bpy.data.worlds.new('w')
ao = new_img(NAME + '_ao', TEX_AUX, False); bake('AO', ao, False)

def px(img, w):
    s = img.size[0]; q = np.array(img.pixels[:], np.float32).reshape(s, s, 4); f = s // w
    return q.reshape(w, f, w, f, 4).mean((1, 3)) if f > 1 else q
aov = 0.4 + 0.6 * px(ao, TEX_AUX)[..., 0]
b = px(base, TEX_AUX); lum = b[..., :3] @ np.array([0.2126, 0.7152, 0.0722], np.float32)
# dark dorsal skin a little rougher (0.68), pale belly slightly smoother (0.57), +small AO-driven variation
rough = 0.68 - 0.11 * sstep(0.05, 0.5, lum) + 0.03 * (1 - px(ao, TEX_AUX)[..., 0])
rough = np.clip(rough, 0.55, 0.70)
orm = np.stack([aov, rough, np.zeros_like(rough), np.ones_like(rough)], -1)
ormimg = new_img(NAME + '_orm', TEX_AUX, False); ormimg.pixels[:] = orm.ravel()
cov = lum > 0.002
print('ROUGH', float(rough[cov].min()), float(rough[cov].max()), 'mean', float(rough[cov].mean()))
for im in (base, nrm, ormimg): im.file_format = 'PNG'; im.pack()
bpy.data.images.remove(ao)

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
gn = lnt.nodes.new('ShaderNodeGroup'); gn.node_tree = g; lnt.links.new(sep.outputs['Red'], gn.inputs['Occlusion'])
lm.use_backface_culling = False
for ca in [x.name for x in lo.data.color_attributes]: lo.data.color_attributes.remove(lo.data.color_attributes[ca])
# dorsal must be the dark side: compare baked colour of up- vs down-facing faces
up_l, dn_l = [], []
uvl = lo.data.uv_layers[0].data; bs = np.array(base.pixels[:], np.float32).reshape(TEX_BASE, TEX_BASE, 4)
for p in list(lo.data.polygons)[::7]:
    uv = np.mean([uvl[li].uv[:] for li in p.loop_indices], 0)
    col = bs[min(TEX_BASE - 1, int(uv[1] * TEX_BASE)), min(TEX_BASE - 1, int(uv[0] * TEX_BASE)), :3].mean()
    if p.normal.z > 0.7: up_l.append(col)
    elif p.normal.z < -0.7: dn_l.append(col)
print('mean baked colour: up-facing %.3f  down-facing %.3f' % (np.mean(up_l), np.mean(dn_l)))
assert np.mean(up_l) < np.mean(dn_l) * 0.5, 'dorsal (+Z) should be the dark side'
bpy.data.objects.remove(src)

# ---------------------------------------------------------------- rig
V = np.array([v.co for v in lo.data.vertices]); HALF = SPAN / 2
ax = np.abs(V[:, 0]); Y = V[:, 1]
def zmid(sel):
    return float(np.median(V[sel, 2])) if sel.any() else 0.0
JW = [0.30, 0.75, 1.20, 1.65]                                   # wing joints (|x|, m); tip at HALF
zw = [zmid((ax > j - 0.05) & (ax < j + 0.05)) for j in JW] + [zmid(ax > HALF - 0.1)]
ywing = [float(np.median(Y[(ax > j - 0.05) & (ax < j + 0.05) & (Y > -1.3)])) for j in JW] + [float(np.median(Y[ax > HALF - 0.1]))]
zc = zmid(ax < 0.1)
YH, YT = float(Y.min()), float(Y.max())
arm_d = bpy.data.armatures.new('MantaRig'); arm = bpy.data.objects.new('MantaRig', arm_d); sc.collection.objects.link(arm)
bpy.ops.object.select_all(action='DESELECT'); arm.select_set(True); bpy.context.view_layer.objects.active = arm
bpy.ops.object.mode_set(mode='EDIT')
eb = arm_d.edit_bones
def bone(name, h, t, parent=None, conn=False):
    bb = eb.new(name); bb.head = Vector(h); bb.tail = Vector(t)
    if parent: bb.parent = eb[parent]; bb.use_connect = conn
    return bb
bone('root', (0, 0, zc), (0, -0.35, zc))
bone('spine_front', (0, -0.05, zc), (0, -1.45, zc), 'root')
bone('spine_rear', (0, 0.05, zc), (0, 0.9, zc), 'root')
bone('tail1', (0, 0.9, zc), (0, 1.35, zc), 'spine_rear', True)
bone('tail2', (0, 1.35, zc), (0, 1.8, zc), 'tail1', True)
bone('tail3', (0, 1.8, zc), (0, YT, zc), 'tail2', True)
cx = float(np.median(ax[(Y < YH + 0.35) & (ax > 0.1)])) if ((Y < YH + 0.35) & (ax > 0.1)).any() else 0.22
for s, S in ((1, 'L'), (-1, 'R')):
    bone('ceph_' + S, (s * cx, -1.5, zc), (s * cx, YH, zc - 0.05), 'spine_front')
    for i in range(4):
        h = (s * JW[i], ywing[i], zw[i]); t = (s * (JW[i + 1] if i < 3 else HALF), ywing[i + 1], zw[i + 1])
        bone('wing%d_%s' % (i + 1, S), h, t, 'root' if i == 0 else 'wing%d_%s' % (i, S), i > 0)
for bb in eb: bb.align_roll(Vector((0, 0, 1)))
bpy.ops.object.mode_set(mode='OBJECT')
print('rig: wing joint z', np.round(zw, 3), 'y', np.round(ywing, 3), 'cephalic x', round(cx, 3), 'body z', round(zc, 3))

# smooth geometric weights
BW = 0.18
s_k = [sstep(j - BW, j + BW, ax) for j in JW] + [np.zeros_like(ax)]
watt = sstep(-1.45, -1.2, Y)                                   # no wing influence on the head / cephalic zone
W = {}
wing_tot = s_k[0] * watt
for i in range(4):
    wi = (s_k[i] - s_k[i + 1]) * watt
    W['wing%d_L' % (i + 1)] = np.where(V[:, 0] > 0, wi, 0); W['wing%d_R' % (i + 1)] = np.where(V[:, 0] < 0, wi, 0)
body = 1 - wing_tot
ceph = sstep(1.45, 1.68, -Y) * sstep(0.08, 0.14, ax) * (1 - sstep(0.40, 0.48, ax))
W['ceph_L'] = body * ceph * (V[:, 0] > 0); W['ceph_R'] = body * ceph * (V[:, 0] < 0)
rb = body * (1 - ceph)
rear = sstep(-0.4, 0.4, Y)
t1, t2, t3 = sstep(0.8, 1.0, Y), sstep(1.25, 1.45, Y), sstep(1.7, 1.9, Y)
W['spine_front'] = rb * (1 - rear); W['spine_rear'] = rb * rear * (1 - t1)
W['tail1'] = rb * rear * (t1 - t2); W['tail2'] = rb * rear * (t2 - t3); W['tail3'] = rb * rear * t3
names = list(W); Wm = np.stack([W[n_] for n_ in names], 1); Wm[Wm < 1e-3] = 0
# keep the 4 largest influences, renormalise
if (Wm > 0).sum(1).max() > 4:
    idx = np.argsort(-Wm, 1)[:, 4:]; np.put_along_axis(Wm, idx, 0, 1)
Wm /= Wm.sum(1, keepdims=True)
print('influences per vertex max', int((Wm > 0).sum(1).max()), 'weight sums', float(Wm.sum(1).min()), float(Wm.sum(1).max()))
for j, n_ in enumerate(names):
    vg = lo.vertex_groups.new(name=n_)
    for val in np.unique(np.round(Wm[:, j], 4)):
        if val <= 0: continue
        ids = np.where(np.round(Wm[:, j], 4) == val)[0]
        vg.add(ids.tolist(), float(val), 'REPLACE')
lo.parent = arm
am = lo.modifiers.new('Armature', 'ARMATURE'); am.object = arm

# ---------------------------------------------------------------- Swim clip (exact loop)
sc.render.fps = FPS; sc.frame_start = 0; sc.frame_end = NFR
arm.animation_data_create()
act = bpy.data.actions.new('Swim'); arm.animation_data.action = act
for pb in arm.pose.bones: pb.rotation_mode = 'QUATERNION'
D = math.radians
AMP = [8.0, 10.0, 12.0, 12.0]           # flap (deg) per wing segment, root -> tip
TW = [0.0, 2.0, 4.0, 6.0]               # chord twist (deg)
LAG = 0.35                              # rad per segment: wave travels toward the tips
MIR = Matrix.Diagonal((-1, 1, 1))
def local_q(pb, Rarm):
    Mr = pb.bone.matrix_local.to_3x3()
    return (Mr.inverted() @ Rarm @ Mr).to_quaternion()
for f in range(NFR + 1):
    ph = 2 * math.pi * f / NFR
    Rs = {}
    for i in range(4):
        th = D(AMP[i]) * math.sin(ph - (i - 1.5) * LAG)         # >0: tip up; centred lag -> near-flat frame 0
        tw = -D(TW[i]) * math.cos(ph - (i - 1.5) * LAG)         # leading edge (-Y) down while the wing moves down
        RL = Matrix.Rotation(th, 3, Vector((0, -1, 0))) @ Matrix.Rotation(tw, 3, Vector((1, 0, 0)))
        Rs['wing%d_L' % (i + 1)] = RL; Rs['wing%d_R' % (i + 1)] = MIR @ RL @ MIR
    Rs['root'] = Matrix.Rotation(D(1.2) * math.sin(ph + 0.6), 3, 'X')             # gentle body pitch
    Rs['spine_front'] = Matrix.Rotation(D(1.0) * math.sin(ph + 0.3), 3, 'X')
    Rs['spine_rear'] = Matrix.Rotation(-D(1.5) * math.sin(ph - 0.6), 3, 'X')
    for i, tb_ in enumerate(('tail1', 'tail2', 'tail3')):
        Rs[tb_] = Matrix.Rotation(-D(2.5 + 1.5 * i) * math.sin(ph - 1.0 - 0.6 * i), 3, 'X') @ \
                  Matrix.Rotation(D(1.5 + i) * math.sin(ph + 0.8 * i), 3, 'Z')
    cl = Matrix.Rotation(D(4.0) * math.sin(ph + 0.9), 3, 'X') @ Matrix.Rotation(D(3.0) * math.sin(ph + 0.4), 3, 'Z')
    Rs['ceph_L'] = cl; Rs['ceph_R'] = MIR @ cl @ MIR
    for n_, Rm in Rs.items():
        pb = arm.pose.bones[n_]; pb.rotation_quaternion = local_q(pb, Rm)
        pb.keyframe_insert('rotation_quaternion', frame=f)
    rootb = arm.pose.bones['root']
    rootb.location = rootb.bone.matrix_local.to_3x3().inverted() @ Vector((0, 0, -0.03 * math.cos(ph + 0.3)))
    rootb.keyframe_insert('location', frame=f)
# measure
def evalV(f):
    sc.frame_set(f); dg = bpy.context.evaluated_depsgraph_get(); m_ = lo.evaluated_get(dg).to_mesh()
    return np.array([lo.matrix_world @ v.co for v in m_.vertices])
V0 = evalV(0); tipz = []
for f in range(0, NFR + 1, 4):
    Vf = evalV(f); tipz.append(float(Vf[Vf[:, 0].argmax(), 2]))
Vend = evalV(NFR)
print('frame-0 span %.4f m (rest %.4f)  loop error %.2e m  tip z range %.3f..%.3f m' %
      (np.ptp(V0[:, 0]), SPAN, np.abs(Vend - V0).max(), min(tipz), max(tipz)))
sc.frame_set(0)

for m_ in list(bpy.data.materials):
    if m_.users == 0: bpy.data.materials.remove(m_)
for im in list(bpy.data.images):
    if im.users == 0: bpy.data.images.remove(im)
bpy.ops.object.select_all(action='DESELECT'); lo.select_set(True); arm.select_set(True)
bpy.ops.export_scene.gltf(filepath=OUT, export_format='GLB', export_image_format='AUTO', use_selection=True,
                          export_animations=True, export_animation_mode='ACTIONS', export_force_sampling=True,
                          export_frame_range=True, export_anim_single_armature=True, export_def_bones=False,
                          export_morph=False, export_yup=True, export_apply=False, export_skins=True,
                          export_draco_mesh_compression_enable=False, export_lights=False, export_cameras=False)
print('EXPORTED', OUT, 'tris', TRIS)

# ---------------------------------------------------------------- preview sheet (Cycles CPU, 640x360 panels)
if PREVIEW:
    def look(ob, f, u):
        f = Vector(f).normalized(); u = Vector(u); z = -f; x = u.cross(z).normalized(); y = z.cross(x)
        ob.matrix_world = Matrix((x, y, z)).transposed().to_4x4()
    sc.cycles.samples = 24; sc.cycles.use_denoising = False
    sc.render.resolution_x, sc.render.resolution_y = 640, 360; sc.render.resolution_percentage = 100
    w = sc.world; w.use_nodes = True
    bg = next(n_ for n_ in w.node_tree.nodes if n_.type == 'BACKGROUND')
    bg.inputs[0].default_value = (0.05, 0.07, 0.09, 1); bg.inputs[1].default_value = 1.0
    for nm_, dd, en in (('key', (-0.4, 0.3, -1.0), 4.0), ('fill', (0.7, -0.5, 0.45), 1.5)):
        Lt = bpy.data.lights.new(nm_, 'SUN'); Lt.energy = en
        ob = bpy.data.objects.new(nm_, Lt); sc.collection.objects.link(ob); look(ob, dd, (0, 0, 1) if abs(dd[2]) < 0.9 else (0, 1, 0))
    cam = bpy.data.objects.new('cam', bpy.data.cameras.new('cam')); sc.collection.objects.link(cam); sc.camera = cam
    cam.data.type = 'ORTHO'; cam.data.clip_end = 200
    old = None
    if OLD:
        before = set(bpy.data.objects)
        bpy.ops.import_scene.gltf(filepath=OLD)
        new = [o for o in bpy.data.objects if o not in before]
        oms = [o for o in new if o.type == 'MESH']
        bpy.context.view_layer.update()
        P = np.array([o.matrix_world @ v.co for o in oms for v in o.data.vertices])
        omn, omx = P.min(0), P.max(0); ks = SPAN / (omx[0] - omn[0])
        oroot = bpy.data.objects.new('old_root', None); sc.collection.objects.link(oroot)
        for o in new:
            if o.parent is None: o.parent = oroot
        oroot.matrix_world = Matrix.Scale(ks, 4) @ Matrix.Translation(-Vector((omn + omx) / 2))
        old = oroot
        for o in new:
            if o.animation_data: o.animation_data.action = None
            o.hide_render = True
        print('old model: span scale', ks, 'bbox', omx - omn)
    tiles = []; tmp = os.path.splitext(PREVIEW)[0] + '_tmp.png'
    def shot(f, u, scale, frame=0, target=(0, 0, 0)):
        sc.frame_set(frame); look(cam, f, u)
        cam.location = Vector(target) - Vector(f).normalized() * 30; cam.data.ortho_scale = scale
        sc.render.filepath = tmp; bpy.ops.render.render(write_still=True)
        im = bpy.data.images.load(tmp); q = np.array(im.pixels[:], np.float32).reshape(360, 640, 4).copy()
        bpy.data.images.remove(im); tiles.append(q)
    shot((0, 0, -1), (-1, 0, 0), 8.3)                       # dorsal, head left
    shot((0, 0, 1), (-1, 0, 0), 8.3)                        # ventral, head left
    shot((-1, 0, 0), (0, 0, 1), 5.0)                        # side (head left)
    shot((-0.55, 0.75, -0.45), (0, 0, 1), 4.6)              # 3/4 front-top
    shot((0, 1, 0.05), (0, 0, 1), 5.0, NFR // 4)            # front: wings up
    shot((0, 1, 0.05), (0, 0, 1), 5.0, 3 * NFR // 4)        # front: wings down
    shot((-0.35, 0.8, 0.5), (0, 0, 1), 1.9, 0, (0, -1.6, -0.1))   # head close-up from below-front (cephalic fins, mouth, gills)
    # clay (normal-map detail)
    for l_ in [l_ for l_ in lnt.links if l_.to_socket == bsdf.inputs['Base Color']]: lnt.links.remove(l_)
    bsdf.inputs['Base Color'].default_value = (0.5, 0.5, 0.5, 1)
    shot((-0.55, 0.75, -0.45), (0, 0, 1), 4.6)
    lnt.links.new(tb.outputs['Color'], bsdf.inputs['Base Color'])
    if old:
        # side by side, same span: old (left) vs new (right), dorsal and 3/4 views
        old.matrix_world = Matrix.Translation(Vector((-2.5, 0, 0))) @ old.matrix_world
        for o in new: o.hide_render = o.type != 'MESH' or o.name.startswith('Icosphere')
        arm.location.x = 2.5; bpy.context.view_layer.update()
        shot((0, 0, -1), (0, -1, 0), 12.0)
        shot((-0.45, 0.7, -0.55), (0, 0, 1), 10.0)
    rows = [np.concatenate(tiles[i:i + 2], 1) for i in range(0, len(tiles), 2)]
    sheet = np.concatenate(rows[::-1], 0)
    img = bpy.data.images.new('sheet', 1280, sheet.shape[0], alpha=False)
    img.pixels[:] = sheet.ravel(); img.filepath_raw = PREVIEW; img.file_format = 'PNG'; img.save()
    os.remove(tmp); print('PREVIEW', PREVIEW)
