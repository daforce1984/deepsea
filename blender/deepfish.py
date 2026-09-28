# Build assets/models/raw7/deepfish.glb from the CC-BY photogrammetry scan
# "ヘリダラ Amami Grenadier, Coryphaenoides marginatus" (ffish.asia / floraZia.com).
# Usage: blender --background --factory-startup --python deepfish.py -- <src.glb> <out.glb> [length_m]
# - removes the colour-checker cube, joins the 6 scan chunks, welds seams, drops floating scan debris
# - bakes all transforms: metres (default 1.0 m total length), head -> glTF +Z, up +Y, bbox centred at the origin
# - straightens the slight lateral bend of the scanned specimen (so procedural swim deformation is symmetric)
# - decimates 443k -> ~36k triangles; new UV layout; bakes from the full-resolution scan:
#   base colour 2048 px, tangent-space normal map 1024 px, ambient occlusion 1024 px
# - unlit scan material -> metallic-roughness PBR (metallic 0, roughness 0.5-0.75 from texture luminance, AO in ORM.R)
# No rig / animation: the game's shader applies procedural swim deformation along +Z to static meshes.
# Bakes run with Cycles on the CPU only (GPU is reserved for the running WebGPU game).
import bpy, sys, math, mathutils, bmesh, numpy as np

argv = sys.argv[sys.argv.index('--') + 1:]
SRC, OUT = argv[0], argv[1]
LENGTH = float(argv[2]) if len(argv) > 2 else 1.0
MAX_TRIS = 36000
TEX_BASE, TEX_AUX = 2048, 1024
UP_SIGN = -1          # this scan's dorsal side is Blender -Z after import (verified with side renders)

bpy.ops.wm.read_factory_settings(use_empty=True)
sc = bpy.context.scene
bpy.ops.import_scene.gltf(filepath=SRC)

# ---- drop colour checker (12-face cube) and empties, join the scan chunks
for o in list(bpy.data.objects):
    if o.type != 'MESH' or len(o.data.polygons) < 100:
        if o.type == 'MESH': bpy.data.objects.remove(o)
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

# ---- frame: long axis, head end (thick) vs tail (filament), lateral = thinnest mid-body axis
V = np.array([v.co for v in hi.data.vertices])
mn, mx = V.min(0), V.max(0); ext = mx - mn
ax = int(np.argmax(ext))
t = (V[:, ax] - mn[ax]) / ext[ax]
def sl_ext(a, b):
    s = V[(t >= a) & (t < b)]; return s.max(0) - s.min(0)
e0, e1 = sl_ext(0, 0.1), sl_ext(0.9, 1.0)
o2 = [i for i in range(3) if i != ax]
head_sign = -1 if np.prod(e0[o2]) > np.prod(e1[o2]) else 1
mid = sl_ext(0.4, 0.6)
lat = min(o2, key=lambda i: mid[i]); dv = [i for i in o2 if i != lat][0]
fwd = mathutils.Vector((0, 0, 0)); fwd[ax] = head_sign
up = mathutils.Vector((0, 0, 0)); up[dv] = UP_SIGN
print('SRC length', ext[ax], 'fwd', tuple(fwd), 'up', tuple(up))
c = mathutils.Vector((mn + mx) / 2)
src = mathutils.Matrix((fwd, up, fwd.cross(up))).transposed()
F, U = mathutils.Vector((0, -1, 0)), mathutils.Vector((0, 0, 1))   # Blender -Y = glTF +Z, Blender +Z = glTF +Y
dst = mathutils.Matrix((F, U, F.cross(U))).transposed()
R = (dst @ src.inverted()).to_4x4()
k = LENGTH / ext[ax]
hi.data.transform(mathutils.Matrix.Scale(k, 4) @ R @ mathutils.Matrix.Translation(-c))
hi.data.update()

# ---- weld chunk seams, remove floating debris
bpy.ops.object.mode_set(mode='EDIT'); bpy.ops.mesh.select_all(action='SELECT')
bpy.ops.mesh.remove_doubles(threshold=LENGTH * 2e-5)
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

# ---- straighten the lateral (X) bend of the specimen: subtract a smooth centre line x(y)
V = np.array([v.co for v in hi.data.vertices])
ys = np.linspace(V[:, 1].min(), V[:, 1].max(), 41)
cy, cx = [], []
for a, b in zip(ys[:-1], ys[1:]):
    s = V[(V[:, 1] >= a) & (V[:, 1] < b)]
    if len(s) > 20: cy.append((a + b) / 2); cx.append(np.median(s[:, 0]))
p = np.polyfit(cy, cx, 3)
V[:, 0] -= np.polyval(p, V[:, 1])
print('lateral bend removed, max offset', float(np.abs(np.polyval(p, np.array(cy))).max()))
mn, mx = V.min(0), V.max(0); V -= (mn + mx) / 2
hi.data.vertices.foreach_set('co', V.ravel())
hi.data.update()
print('FINAL bbox', mx - mn)

# ---- high-poly material -> pure emission of the scan texture (for the colour bake)
scan_img = next(n.image for m in hi.data.materials for n in m.node_tree.nodes if n.type == 'TEX_IMAGE' and n.image)
print('scan texture', scan_img.name, tuple(scan_img.size))
hm = bpy.data.materials.new('scan_emit'); nt = hm.node_tree; nt.nodes.clear()
ti = nt.nodes.new('ShaderNodeTexImage'); ti.image = scan_img
em = nt.nodes.new('ShaderNodeEmission'); oo = nt.nodes.new('ShaderNodeOutputMaterial')
nt.links.new(ti.outputs['Color'], em.inputs['Color']); nt.links.new(em.outputs[0], oo.inputs[0])
hi.data.materials.clear(); hi.data.materials.append(hm)

# ---- low-poly: decimate, smooth, new UVs
lo = hi.copy(); lo.data = hi.data.copy(); lo.name = 'deepfish'; lo.data.name = 'deepfish'
sc.collection.objects.link(lo)
lo.data.calc_loop_triangles(); tris_hi = len(lo.data.loop_triangles)
bpy.ops.object.select_all(action='DESELECT'); lo.select_set(True); bpy.context.view_layer.objects.active = lo
d = lo.modifiers.new('dec', 'DECIMATE'); d.ratio = MAX_TRIS / tris_hi * 0.99
bpy.ops.object.modifier_apply(modifier='dec')
bpy.ops.object.mode_set(mode='EDIT'); bpy.ops.mesh.select_all(action='SELECT')
bpy.ops.mesh.remove_doubles(threshold=LENGTH * 1e-5)
bpy.ops.mesh.delete_loose()
bpy.ops.mesh.quads_convert_to_tris()
bpy.ops.mesh.normals_make_consistent(inside=False)
bpy.ops.uv.smart_project(angle_limit=math.radians(60), island_margin=0.004, area_weight=0.0, scale_to_bounds=False)
bpy.ops.object.mode_set(mode='OBJECT')
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
lm = bpy.data.materials.new('deepfish_skin'); lo.data.materials.clear(); lo.data.materials.append(lm)
nt = lm.node_tree
bake_node = nt.nodes.new('ShaderNodeTexImage')
def bake(kind, img, selected_to_active):
    bake_node.image = img; nt.nodes.active = bake_node
    bpy.ops.object.select_all(action='DESELECT')
    if selected_to_active: hi.select_set(True)
    lo.select_set(True); bpy.context.view_layer.objects.active = lo
    sc.render.bake.use_selected_to_active = selected_to_active
    sc.render.bake.cage_extrusion = LENGTH * 0.0012   # thin fins: larger values hit the far side
    sc.render.bake.max_ray_distance = LENGTH * 0.004
    bpy.ops.object.bake(type=kind, normal_space='TANGENT', use_clear=True, margin=8)
    print('baked', kind, img.name)

base = new_img('deepfish_basecolor', TEX_BASE, True); bake('EMIT', base, True)
nrm = new_img('deepfish_normal', TEX_AUX, False); bake('NORMAL', nrm, True)
# On the paper-thin fins some rays hit the back of the opposite fin surface and give inward-pointing normals
# (black blotches when lit). Clamp every tangent-space normal to <= ~70 deg from the surface normal.
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
ao = new_img('deepfish_ao', TEX_AUX, False)
sc.world = bpy.data.worlds.new('w')
bake('AO', ao, False)
bpy.data.objects.remove(hi)

# ---- ORM: R = AO (softened), G = roughness from luminance (darker/matte patches rougher), B = 0
def px(img, w):
    # read pixels directly (copies of generated images come back blank) and box-downsample to w
    n = img.size[0]
    a = np.array(img.pixels[:], dtype=np.float32).reshape(n, n, 4)
    f = n // w
    return a.reshape(w, f, w, f, 4).mean((1, 3)) if f > 1 else a
b = px(base, TEX_AUX); lum = 0.2126 * b[..., 0] + 0.7152 * b[..., 1] + 0.0722 * b[..., 2]
cov = lum > 0.01                     # texels covered by UV islands (rest of the atlas is black)
lo5, hi95 = np.percentile(lum[cov], 5), np.percentile(lum[cov], 95)
ln = (lum - lo5) / max(1e-4, hi95 - lo5)
rough = np.clip(0.72 - 0.2 * np.clip(ln, 0, 1), 0.5, 0.75)
aov = 0.35 + 0.65 * px(ao, TEX_AUX)[..., 0]
orm = np.stack([aov, rough, np.zeros_like(rough), np.ones_like(rough)], -1)
ormimg = new_img('deepfish_orm', TEX_AUX, False)
ormimg.pixels[:] = orm.ravel()
print('ROUGH range', float(rough[cov].min()), float(rough[cov].max()), 'mean', float(rough[cov].mean()))
for im in (base, nrm, ormimg):
    im.file_format = 'PNG'; im.pack()
bpy.data.images.remove(ao)

# ---- final metallic-roughness material
nt.nodes.clear()
out = nt.nodes.new('ShaderNodeOutputMaterial'); bsdf = nt.nodes.new('ShaderNodeBsdfPrincipled')
nt.links.new(bsdf.outputs[0], out.inputs[0])
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
lm.use_backface_culling = False     # fins are single-sided scan surfaces
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
