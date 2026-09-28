# Humpback whale build: Allie2k "Game-ready Humpback Whale" (CC-BY 4.0) -> rigged, animated GLB.
# Usage: blender --background --factory-startup --python humpback.py -- <src.glb> <out.glb>
import bpy, bmesh, sys, math, mathutils
from mathutils import Vector, Quaternion

argv = sys.argv[sys.argv.index('--') + 1:]
SRC, OUT = argv[0], argv[1]
LENGTH = 14.0          # snout -> fluke tip, metres
FIN_TARGET = 4.5       # pectoral fin length, metres
PERIOD = 7.0           # swim cycle, seconds
FPS = 30

bpy.ops.wm.read_factory_settings(use_empty=True)
bpy.ops.import_scene.gltf(filepath=SRC)
sc = bpy.context.scene

meshes = [o for o in sc.objects if o.type == 'MESH']
assert len(meshes) == 1
ob = meshes[0]
M = ob.matrix_world.copy()
ob.parent = None
ob.matrix_world = mathutils.Matrix.Identity(4)
ob.data.transform(M)
for o in list(sc.objects):
    if o is not ob:
        bpy.data.objects.remove(o, do_unlink=True)
bpy.context.view_layer.objects.active = ob
ob.select_set(True)

me = ob.data
# The source mesh is split into loose pieces: back, belly, jaw, and per side a fin "shoulder" patch plus
# upper/lower fin surfaces. Tag fin pieces (all verts on one side, min |x| > 6.7% of length) in vertex
# groups before welding, so the tags survive welding and subdivision.
bm = bmesh.new(); bm.from_mesh(me)
L0 = max(v.co.y for v in bm.verts) - min(v.co.y for v in bm.verts)
dl = bm.verts.layers.deform.verify()
for n in ('finL', 'finR', 'rootL', 'rootR'): ob.vertex_groups.new(name=n)
gi = {g.name: g.index for g in ob.vertex_groups}
bm.verts.ensure_lookup_table()
seen = set()
for v0 in bm.verts:
    if v0.index in seen: continue
    st = [v0]; comp = []; seen.add(v0.index)
    while st:
        x = st.pop(); comp.append(x)
        for e in x.link_edges:
            y = e.other_vert(x)
            if y.index not in seen: seen.add(y.index); st.append(y)
    xs = [v.co.x for v in comp]
    if min(xs) * max(xs) <= 0 or min(abs(x) for x in xs) < 0.067 * L0: continue
    side = 'L' if xs[0] > 0 else 'R'
    isroot = max(abs(x) for x in xs) < 0.095 * L0
    for v in comp:
        v[dl][gi['fin' + side]] = 1.0
        if isroot: v[dl][gi['root' + side]] = 1.0
# weld coincident vertices (UV seams are per-loop and survive)
bmesh.ops.remove_doubles(bm, verts=bm.verts, dist=L0 * 1e-4)
bm.to_mesh(me); bm.free()

# one Catmull-Clark level for a smoother silhouette (~30k tris)
mod = ob.modifiers.new('sub', 'SUBSURF'); mod.levels = 1; mod.render_levels = 1
mod.uv_smooth = 'PRESERVE_BOUNDARIES'
bpy.ops.object.modifier_apply(modifier='sub')
for p in me.polygons: p.use_smooth = True

def gw(v, name):
    for g in v.groups:
        if g.group == gi[name]: return g.weight
    return 0.0
fingrp = {side: set(v.index for v in me.vertices if gw(v, 'fin' + side) > 0.5) for side in 'LR'}
rootgrp = {side: set(v.index for v in me.vertices if gw(v, 'root' + side) > 0.5) for side in 'LR'}
for n in ('finL', 'finR', 'rootL', 'rootR'): ob.vertex_groups.remove(ob.vertex_groups[n])

# scale to LENGTH along Y (Blender), head is at -Y (-> glTF +Z)
bm = bmesh.new(); bm.from_mesh(me)
bm.verts.ensure_lookup_table()
ys = [v.co.y for v in bm.verts]
s = LENGTH / (max(ys) - min(ys))
bmesh.ops.scale(bm, vec=(s, s, s), verts=bm.verts)

fins = {}
finv = set()
for side in 'LR':
    fv = [bm.verts[i] for i in fingrp[side]]
    finv |= set(fv)
    rootset = [bm.verts[i].co for i in rootgrp[side]]
    R = sum(rootset, Vector()) / len(rootset)
    T = max((v.co for v in fv), key=lambda c: (c - R).length).copy()
    a = (T - R).normalized(); Lf = (T - R).length
    fins[side] = dict(verts=fv, R=R, a=a, L=Lf)
    print('FIN', side, 'len before', round(Lf, 2), 'R', tuple(round(x, 2) for x in R), 'T', tuple(round(x, 2) for x in T), 'nv', len(fv))

# stretch fins along their axis toward FIN_TARGET (root fixed, linear ramp)
for side, F in fins.items():
    k = FIN_TARGET / F['L']
    for v in F['verts']:
        t = (v.co - F['R']).dot(F['a']) / F['L']
        # displacement grows linearly from 0 at t=0.1 to L*(k-1) at the tip -> uniform stretch
        d = F['L'] * (k - 1.0) * max(t - 0.1, 0.0) / 0.9
        v.co += F['a'] * d
    F['T'] = F['R'] + F['a'] * F['L'] * k
    F['L'] = F['L'] * k
    print('FIN', side, 'len after', round(F['L'], 2))

# centre bbox at origin
xs = [v.co.x for v in bm.verts]; ys = [v.co.y for v in bm.verts]; zs = [v.co.z for v in bm.verts]
c = Vector(((max(xs) + min(xs)) / 2, (max(ys) + min(ys)) / 2, (max(zs) + min(zs)) / 2))
bmesh.ops.translate(bm, vec=-c, verts=bm.verts)
for F in fins.values():
    F['R'] = F['R'] - c; F['T'] = F['T'] - c
bm.to_mesh(me)
ymin = min(v.co.y for v in me.vertices); ymax = max(v.co.y for v in me.vertices)

def ypos(sfrac):  # fraction from snout (0) to fluke tip (1)
    return ymin + (ymax - ymin) * sfrac

_fi = {x.index for x in finv}
bodyco = [v.co.copy() for v in me.vertices if v.index not in _fi]
def midz(sfrac, w=0.03):
    y0, y1 = ypos(sfrac - w), ypos(sfrac + w)
    zz = [co.z for co in bodyco if y0 <= co.y <= y1 and abs(co.x) < 1.0]
    return (min(zz) + max(zz)) / 2 if zz else 0.0

# ---- armature ----
arm_data = bpy.data.armatures.new('HumpbackRig')
arm = bpy.data.objects.new('HumpbackRig', arm_data)
sc.collection.objects.link(arm)
bpy.context.view_layer.objects.active = arm
bpy.ops.object.mode_set(mode='EDIT')
eb = arm_data.edit_bones
def P(sf):
    return Vector((0, ypos(sf), midz(sf)))
spine = [  # name, head s, tail s, parent
    ('Root', 0.36, 0.44, None),
    ('Chest', 0.36, 0.20, 'Root'),
    ('Head', 0.20, 0.02, 'Chest'),
    ('Spine1', 0.44, 0.56, 'Root'),
    ('Spine2', 0.56, 0.67, 'Spine1'),
    ('Spine3', 0.67, 0.77, 'Spine2'),
    ('Tail', 0.77, 0.87, 'Spine3'),
    ('Flukes', 0.87, 1.00, 'Tail'),
]
for n, h, t, par in spine:
    b = eb.new(n); b.head = P(h); b.tail = P(t); b.roll = 0
    if par: b.parent = eb[par]; b.use_connect = (n not in ('Chest', 'Spine1'))
for side, F in fins.items():
    Mid = F['R'] + F['a'] * F['L'] * 0.5
    b1 = eb.new('Fin1.' + side); b1.head = F['R']; b1.tail = Mid; b1.parent = eb['Chest']
    b2 = eb.new('Fin2.' + side); b2.head = Mid; b2.tail = F['T']; b2.parent = b1; b2.use_connect = True
    b1.roll = b2.roll = 0
bpy.ops.object.mode_set(mode='OBJECT')

# ---- skin weights ----
centers = [('Head', 0.09), ('Chest', 0.26), ('Root', 0.40), ('Spine1', 0.50), ('Spine2', 0.615),
           ('Spine3', 0.72), ('Tail', 0.82), ('Flukes', 0.93)]
def smooth(x):
    x = min(max(x, 0.0), 1.0); return x * x * (3 - 2 * x)
def body_weights(y):
    sf = (y - ymin) / (ymax - ymin)
    if sf <= centers[0][1]: return {centers[0][0]: 1.0}
    if sf >= centers[-1][1]: return {centers[-1][0]: 1.0}
    for (n0, s0), (n1, s1) in zip(centers, centers[1:]):
        if s0 <= sf <= s1:
            w = smooth((sf - s0) / (s1 - s0)); return {n0: 1 - w, n1: w}
groups = {}
for n in [b.name for b in arm_data.bones]:
    groups[n] = ob.vertex_groups.new(name=n)
finidx = {}
for side, F in fins.items():
    for v in F['verts']: finidx[v.index] = side
for v in me.vertices:
    W = body_weights(v.co.y)
    side = finidx.get(v.index)
    if side:
        F = fins[side]
        t = (v.co - F['R']).dot(F['a']) / F['L']
        wf = smooth(t / 0.18)
        wt = smooth((t - 0.35) / 0.35)
        W = {k: x * (1 - wf) for k, x in W.items()}
        W['Fin1.' + side] = wf * (1 - wt)
        W['Fin2.' + side] = wf * wt
    for k, x in W.items():
        if x > 1e-4: groups[k].add([v.index], x, 'REPLACE')

ob.parent = arm
am = ob.modifiers.new('Armature', 'ARMATURE'); am.object = arm

# ---- material: metallic-roughness, non-metal ----
for m in me.materials:
    for n in m.node_tree.nodes:
        if n.type == 'BSDF_PRINCIPLED':
            n.inputs['Metallic'].default_value = 0.0
            n.inputs['Roughness'].default_value = 0.55
    m.name = 'HumpbackSkin'
ob.name = 'Humpback'; me.name = 'Humpback'

# ---- Swim action ----
sc.render.fps = FPS
N = int(PERIOD * FPS)
sc.frame_start = 0; sc.frame_end = N
act = bpy.data.actions.new('Swim')
arm.animation_data_create(); arm.animation_data.action = act
pb = arm.pose.bones
for p in pb: p.rotation_mode = 'QUATERNION'
LAT = Vector((1, 0, 0))   # armature lateral axis -> pitch (dorso-ventral) bending
# (amplitude deg, phase lag rad)
spine_anim = {'Head': (1.2, -0.6), 'Chest': (1.0, -0.3), 'Root': (1.6, 0.0), 'Spine1': (2.2, 0.35),
              'Spine2': (3.2, 0.75), 'Spine3': (4.6, 1.15), 'Tail': (6.5, 1.55), 'Flukes': (10.0, 2.0)}
def local_axis(bname, axis_arm):
    return (arm_data.bones[bname].matrix_local.to_3x3().inverted() @ axis_arm).normalized()
STEP = 3
for f in list(range(0, N, STEP)) + [N]:
    ph = 2 * math.pi * (f % N) / N
    for n, (A, lag) in spine_anim.items():
        ang = math.radians(A) * math.sin(ph - lag)
        # bones pointing toward the head get the opposite sign so the whole body waves coherently
        dirsign = -1 if n in ('Chest', 'Head') else 1
        q = Quaternion(local_axis(n, LAT), dirsign * ang)
        pb[n].rotation_quaternion = q
        pb[n].keyframe_insert('rotation_quaternion', frame=f)
    for side, sgn in (('L', 1), ('R', -1)):
        F = fins[side]
        flap_axis = Vector((0, 1, 0)) * sgn          # rotation about body axis -> fin tip up/down
        twist_axis = F['a']
        for bn, A, tw, lag in (('Fin1.' + side, 5.0, 4.0, 0.9), ('Fin2.' + side, 3.0, 2.0, 1.4)):
            q = Quaternion(local_axis(bn, flap_axis), math.radians(A) * math.sin(ph - lag)) @ \
                Quaternion(local_axis(bn, twist_axis), math.radians(tw) * math.sin(ph - lag - 1.2))
            pb[bn].rotation_quaternion = q
            pb[bn].keyframe_insert('rotation_quaternion', frame=f)

sc.frame_set(0)
tris = sum(len(p.vertices) - 2 for p in me.polygons)
print('TRIS', tris, 'VERTS', len(me.vertices))
bpy.ops.export_scene.gltf(filepath=OUT, export_format='GLB', export_yup=True, export_apply=False,
                          export_animations=True, export_animation_mode='ACTIONS', export_force_sampling=True,
                          export_frame_range=False, export_skins=True, export_morph=False,
                          export_image_format='AUTO', export_draco_mesh_compression_enable=False,
                          export_cameras=False, export_lights=False)
print('EXPORTED', OUT)
