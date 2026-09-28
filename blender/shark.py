# Build assets/models/raw6/shark.glb from the CC-BY "Animated Swimming Great White Shark Loop" (LasquetiSpice).
# Usage: blender --background --factory-startup --python shark.py -- <src.glb> <out.glb>
# - removes stray helper mesh, empties and the 32 s root-motion "Circling" clip
# - bakes all node transforms: metres, 4.5 m long, head -> glTF +Z, up +Y, bbox centred at the origin
# - decimates 51k -> <40k triangles (vertex weights kept)
# - spec/gloss material -> metallic-roughness (metallic 0, roughness 0.5-0.8 from the gloss map, AO in ORM)
# - "Swimming" -> "Swim" retimed to 38 frames @24 fps (1.583 s) with an exact loop; "Biting" -> "Bite"
import bpy, sys, math, mathutils, numpy as np

argv = sys.argv[sys.argv.index('--') + 1:]
SRC, OUT = argv[0], argv[1]
LENGTH = 4.5
MAX_TRIS = 39000
SWIM_FRAMES = 38

bpy.ops.wm.read_factory_settings(use_empty=True)
sc = bpy.context.scene
sc.render.fps = 24
bpy.ops.import_scene.gltf(filepath=SRC)

arm = next(o for o in bpy.data.objects if o.type == 'ARMATURE')
mesh = next(o for o in bpy.data.objects if o.type == 'MESH' and o.find_armature() == arm)
for o in list(bpy.data.objects):
    if o.type == 'MESH' and o != mesh:
        bpy.data.objects.remove(o)          # stray 42-vert "Icosphere"
if 'Circling' in bpy.data.actions:
    bpy.data.actions.remove(bpy.data.actions['Circling'])

def fcurves(act):
    out = []
    for L in act.layers:
        for s in L.strips:
            for cb in s.channelbags:
                out += list(cb.fcurves)
    return out

arm.animation_data.action = None
for pb in arm.pose.bones:
    pb.matrix_basis = mathutils.Matrix()
bpy.context.view_layer.update()

# ---- world-space frame of the rest pose
Mw = mesh.matrix_world.copy()
P = np.array([Mw @ v.co for v in mesh.data.vertices])
mn, mx = P.min(0), P.max(0)
lip = arm.matrix_world @ arm.data.bones['Center_upper_Lip.10_10'].head_local
dfin = arm.matrix_world @ arm.data.bones['DorsalFin3.28_28'].head_local
c = mathutils.Vector((mn + mx) / 2)
fwd = (lip - c); ax = max(range(3), key=lambda i: abs(fwd[i]))
fwd = mathutils.Vector([0, 0, 0]); fwd[ax] = math.copysign(1, (lip - c)[ax])
up = (dfin - c); up -= up.dot(fwd) * fwd; up.normalize()
aup = max(range(3), key=lambda i: abs(up[i])); up = mathutils.Vector([0, 0, 0]); up[aup] = math.copysign(1, (dfin - c)[aup])
L = (mx - mn)[ax]
print('SRC length', L, 'fwd', tuple(fwd), 'up', tuple(up))
# target: forward = Blender -Y (glTF +Z), up = Blender +Z (glTF +Y)
src = mathutils.Matrix((fwd, up, fwd.cross(up))).transposed()
dst = mathutils.Matrix((mathutils.Vector((0, -1, 0)), mathutils.Vector((0, 0, 1)),
                        mathutils.Vector((0, -1, 0)).cross(mathutils.Vector((0, 0, 1))))).transposed()
R = (dst @ src.inverted()).to_4x4()
k = LENGTH / L
T = mathutils.Matrix.Scale(k, 4) @ R @ mathutils.Matrix.Translation(-c)

# bone-local location keys scale with the armature's total world scale
s_arm = arm.matrix_world.to_scale()[0] * k
for act in bpy.data.actions:
    for fc in fcurves(act):
        if fc.data_path.endswith('.location'):
            for kp in fc.keyframe_points:
                kp.co[1] *= s_arm; kp.handle_left[1] *= s_arm; kp.handle_right[1] *= s_arm

for o in (arm, mesh):
    M = o.matrix_world.copy(); o.parent = None; o.matrix_world = T @ M
for o in list(bpy.data.objects):
    if o not in (arm, mesh):
        bpy.data.objects.remove(o)
bpy.context.view_layer.update()
for o in (mesh, arm):
    bpy.ops.object.select_all(action='DESELECT'); o.select_set(True); bpy.context.view_layer.objects.active = o
    bpy.ops.object.transform_apply(location=True, rotation=True, scale=True)
mesh.parent = arm
mesh.matrix_parent_inverse = mathutils.Matrix()
for m in mesh.modifiers:
    if m.type == 'ARMATURE': m.object = arm

# ---- decimate
me = mesh.data
me.calc_loop_triangles(); tris = len(me.loop_triangles)
bpy.ops.object.select_all(action='DESELECT'); mesh.select_set(True); bpy.context.view_layer.objects.active = mesh
bpy.ops.object.mode_set(mode='EDIT'); bpy.ops.mesh.select_all(action='SELECT')
bpy.ops.mesh.remove_doubles(threshold=0.0002)
bpy.ops.mesh.delete_loose()
bpy.ops.object.mode_set(mode='OBJECT')
me.calc_loop_triangles(); tris = len(me.loop_triangles)
# The mouth interior (gums/throat, ~18k tris, normals face into the cavity) is decimated hard first so the
# visible body keeps its full resolution; a global pass only runs if still over budget.
# Mouth-interior faces are identified by their UV island (the pink palate/throat atlas block, top-right).
uvl = me.uv_layers.active.data
mvs = set(); nmf = 0
for p in me.polygons:
    us = [uvl[l].uv for l in p.loop_indices]
    if all(u.x > 0.6 and u.y > 0.7 for u in us):
        mvs.update(p.vertices); nmf += 1
print('mouth interior faces', nmf)
if mvs and tris > MAX_TRIS:
    vg = mesh.vertex_groups.new(name='_mouth_int'); vg.add(list(mvs), 1.0, 'REPLACE')
    d = mesh.modifiers.new('decm', 'DECIMATE'); d.ratio = 0.3; d.vertex_group = vg.name; d.vertex_group_factor = 1000.0
    bpy.ops.object.modifier_move_to_index(modifier='decm', index=0)
    bpy.ops.object.modifier_apply(modifier='decm')
    mesh.vertex_groups.remove(mesh.vertex_groups['_mouth_int'])
    me.calc_loop_triangles(); tris = len(me.loop_triangles); print('after mouth decimate', tris)
if tris > MAX_TRIS:
    d = mesh.modifiers.new('dec', 'DECIMATE'); d.ratio = MAX_TRIS / tris * 0.995
    bpy.ops.object.modifier_move_to_index(modifier='dec', index=0)
    bpy.ops.object.modifier_apply(modifier='dec')
try:
    bpy.ops.mesh.customdata_custom_splitnormals_clear()
except Exception as e:
    print('no custom normals', e)
bpy.ops.object.shade_smooth()
me.calc_loop_triangles(); print('TRIS', len(me.loop_triangles))

# ---- material: metallic-roughness
old = me.materials[0]
imgs = {}
for n in old.node_tree.nodes:
    if n.type == 'TEX_IMAGE' and n.image: imgs[n.image.name] = n.image
base = imgs['Image_0']   # KHR spec-gloss diffuseTexture = image 0 in the source
nrm = next(n.inputs['Color'].links[0].from_node.image for n in old.node_tree.nodes if n.type == 'NORMAL_MAP')
def px(img, w=1024):
    im = img.copy()
    if tuple(im.size) != (w, w): im.scale(w, w)
    a = np.array(im.pixels[:], dtype=np.float32).reshape(w, w, 4)
    bpy.data.images.remove(im); return a
gloss = px(imgs['Image_1'])   # LA png -> gloss in alpha (glossinessFactor 0.608)
ao = px(imgs['Image_3'])
rough = np.clip(1.0 - 0.608 * gloss[..., 3] + 0.12, 0.5, 0.8)
orm = np.stack([ao[..., 0], rough, np.zeros_like(rough), np.ones_like(rough)], -1)
ormimg = bpy.data.images.new('shark_orm', 1024, 1024, alpha=False)
ormimg.colorspace_settings.name = 'Non-Color'
ormimg.pixels[:] = orm.ravel(); ormimg.file_format = 'PNG'; ormimg.pack()
base.name = 'shark_basecolor'; nrm.name = 'shark_normal'
print('ROUGH mean', float(rough.mean()))

mat = bpy.data.materials.new('shark_skin')
nt = mat.node_tree; nt.nodes.clear()
out = nt.nodes.new('ShaderNodeOutputMaterial'); bsdf = nt.nodes.new('ShaderNodeBsdfPrincipled')
nt.links.new(bsdf.outputs[0], out.inputs[0])
tb = nt.nodes.new('ShaderNodeTexImage'); tb.image = base
nt.links.new(tb.outputs['Color'], bsdf.inputs['Base Color'])
tn = nt.nodes.new('ShaderNodeTexImage'); tn.image = nrm; nrm.colorspace_settings.name = 'Non-Color'
nm = nt.nodes.new('ShaderNodeNormalMap'); nt.links.new(tn.outputs['Color'], nm.inputs['Color']); nt.links.new(nm.outputs[0], bsdf.inputs['Normal'])
to = nt.nodes.new('ShaderNodeTexImage'); to.image = ormimg
sep = nt.nodes.new('ShaderNodeSeparateColor'); nt.links.new(to.outputs['Color'], sep.inputs[0])
nt.links.new(sep.outputs['Green'], bsdf.inputs['Roughness'])
bsdf.inputs['Metallic'].default_value = 0.0
g = bpy.data.node_groups.new('glTF Material Output', 'ShaderNodeTree')
g.interface.new_socket('Occlusion', in_out='INPUT', socket_type='NodeSocketFloat')
gn = nt.nodes.new('ShaderNodeGroup'); gn.node_tree = g
nt.links.new(sep.outputs['Red'], gn.inputs['Occlusion'])
mat.use_backface_culling = False
me.materials.clear(); me.materials.append(mat)
keep = next((u for u in me.uv_layers if u.active_render), me.uv_layers[0]).name
for u in [u.name for u in me.uv_layers if u.name != keep]:
    me.uv_layers.remove(me.uv_layers[u])
for a in [a.name for a in me.color_attributes]:
    me.color_attributes.remove(me.color_attributes[a])
print('UV kept', keep)
bpy.data.materials.remove(old)

# ---- animations
sw = bpy.data.actions['Swimming']; sw.name = 'Swim'
f0, f1 = sw.frame_range
kf = SWIM_FRAMES / (f1 - f0)
for fc in fcurves(sw):
    kps = fc.keyframe_points
    for kp in kps:
        for p in (kp.co, kp.handle_left, kp.handle_right): p[0] = (p[0] - f0) * kf
    kps[-1].co[1] = kps[0].co[1]            # exact loop
    fc.update()
sw.use_frame_range = True; sw.frame_start = 0; sw.frame_end = SWIM_FRAMES
if 'Biting' in bpy.data.actions:
    b = bpy.data.actions['Biting']; b.name = 'Bite'
for a in bpy.data.actions:
    a.use_fake_user = True
arm.animation_data.action = sw
arm.animation_data.action_slot = sw.slots[0]
arm.name = 'shark_rig'; arm.data.name = 'shark_rig'; mesh.name = 'shark'; me.name = 'shark'
sc.frame_start = 0; sc.frame_end = SWIM_FRAMES; sc.frame_set(0)

for im in list(bpy.data.images):
    if im.users == 0: bpy.data.images.remove(im)

bpy.ops.export_scene.gltf(filepath=OUT, export_format='GLB', export_image_format='AUTO',
                          export_animations=True, export_animation_mode='ACTIONS', export_force_sampling=True,
                          export_skins=True, export_def_bones=False, export_yup=True, export_apply=False,
                          export_draco_mesh_compression_enable=False, export_lights=False, export_cameras=False)
print('EXPORTED', OUT)
