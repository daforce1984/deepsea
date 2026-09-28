"""Replace the cockpit / swim-platform teak of diveboat_hd with modelled planks.

Input : assets/models/game/diveboat_hd_base.glb  (output of diveboat_hd.py, kept untouched)
Output: assets/models/game/diveboat_hd.glb
Usage : "$B" --background --factory-startup --python "$(wslpath -w blender/diveboat_deck.py)" -- "$(wslpath -w .)" [--probe] [--render]

Planks: 0.10 m wide, 7 mm black caulking gaps (real geometry), staggered butt joints, 12 mm proud of the old deck,
2 mm bevelled top edges; clipped to the original deck outline with an exact boolean.  Own material Teak_Deck
(assets/textures/boat/deckteak_*.jpg, 2048 px), each plank segment gets a random strip/offset of the texture.
"""
import bpy, bmesh, sys, os, math, random
from mathutils import Vector

ARGS = sys.argv[sys.argv.index('--') + 1:] if '--' in sys.argv else []
ROOT = ARGS[0]
SRC = os.path.join(ROOT, 'assets', 'models', 'game', 'diveboat_hd_base.glb')
OUT = os.path.join(ROOT, 'assets', 'models', 'game', 'diveboat_hd.glb')
TEX = os.path.join(ROOT, 'assets', 'textures', 'boat')
def log(*a): print('[deck]', *a, flush=True)

bpy.ops.wm.read_factory_settings(use_empty=True)
bpy.ops.import_scene.gltf(filepath=SRC)
boat = next(o for o in bpy.context.scene.objects if o.type == 'MESH')
sp = bpy.data.objects['spawn_diver'].matrix_world.translation.copy()
ep = bpy.data.objects['entry_point'].matrix_world.translation.copy()
DECK_Z = sp.z - 1.65
log('boat', boat.name, 'mats', [m.name for m in boat.data.materials], 'spawn', tuple(round(c, 3) for c in sp), 'entry', tuple(round(c, 3) for c in ep), 'deckZ', round(DECK_Z, 3))

M = boat.matrix_world
bm = bmesh.new(); bm.from_mesh(boat.data); bm.faces.ensure_lookup_table()
def flat_faces(z0, tol=0.03):
    out = []
    for f in bm.faces:
        n = (M.to_3x3() @ f.normal).normalized()
        if n.z < 0.97: continue
        c = M @ f.calc_center_median()
        if abs(c.z - z0) < tol: out.append(f)
    return out
for name, z0 in (('cockpit', DECK_Z), ('platform', ep.z)):
    fs = flat_faces(z0)
    area = sum(f.calc_area() for f in fs)
    mats = {}
    for f in fs: mats[f.material_index] = mats.get(f.material_index, 0) + f.calc_area()
    xs = [(M @ v.co) for f in fs for v in f.verts]
    if xs:
        log(name, 'faces', len(fs), 'area', round(area, 2), 'mats', {boat.data.materials[k].name: round(a, 2) for k, a in mats.items()},
            'x', round(min(p.x for p in xs), 2), round(max(p.x for p in xs), 2), 'y', round(min(p.y for p in xs), 2), round(max(p.y for p in xs), 2),
            'z', round(min(p.z for p in xs), 3), round(max(p.z for p in xs), 3))
if '--probe' in ARGS: sys.exit(0)

# ---------------------------------------------------------------------------------------- separate the old deck surfaces
W, GAP, THK, BEV = 0.10, 0.007, 0.012, 0.0015
mi = {m.name: i for i, m in enumerate(boat.data.materials)}
sel = set()
for f in flat_faces(DECK_Z):
    if f.material_index == mi['Grand_Other_02']: sel.add(f.index)
for f in flat_faces(ep.z):
    if f.material_index == mi['Grand_Other_03'] and (M @ f.calc_center_median()).y > 6.5: sel.add(f.index)
for f in bm.faces: f.select_set(f.index in sel)
bm.to_mesh(boat.data); bm.free()
log('deck faces selected', len(sel))
bpy.context.view_layer.objects.active = boat
for o in bpy.context.scene.objects: o.select_set(o == boat)
bpy.ops.object.mode_set(mode='EDIT'); bpy.ops.mesh.separate(type='SELECTED'); bpy.ops.object.mode_set(mode='OBJECT')
region = next(o for o in bpy.context.scene.objects if o.type == 'MESH' and o != boat)
region.name = 'deck_region'
bpy.context.view_layer.objects.active = region
for o in bpy.context.scene.objects: o.select_set(o == region)
bpy.ops.object.transform_apply(location=True, rotation=True, scale=True)
# make normals point up
rbm = bmesh.new(); rbm.from_mesh(region.data)
bmesh.ops.remove_doubles(rbm, verts=rbm.verts, dist=0.0005)
rbm.normal_update()
for f in rbm.faces:
    if f.normal.z < 0: f.normal_flip()
rbm.normal_update()
log('region faces down after flip', sum(1 for f in rbm.faces if f.normal.z < 0))
rbm.to_mesh(region.data); rbm.free()

# ---------------------------------------------------------------------------------------- materials
def img(name, colorspace):
    im = bpy.data.images.load(os.path.join(TEX, name)); im.colorspace_settings.name = colorspace; return im
teak = bpy.data.materials.new('Teak_Deck'); teak.use_nodes = True
nt = teak.node_tree; bs = nt.nodes['Principled BSDF']
tb = nt.nodes.new('ShaderNodeTexImage'); tb.image = img('deckteak_basecolor.jpg', 'sRGB')
tn = nt.nodes.new('ShaderNodeTexImage'); tn.image = img('deckteak_normal.jpg', 'Non-Color')
tm = nt.nodes.new('ShaderNodeTexImage'); tm.image = img('deckteak_mr.jpg', 'Non-Color')
nm = nt.nodes.new('ShaderNodeNormalMap'); sc_ = nt.nodes.new('ShaderNodeSeparateColor')
nt.links.new(tb.outputs['Color'], bs.inputs['Base Color'])
nt.links.new(tn.outputs['Color'], nm.inputs['Color']); nt.links.new(nm.outputs['Normal'], bs.inputs['Normal'])
nt.links.new(tm.outputs['Color'], sc_.inputs['Color'])
nt.links.new(sc_.outputs['Green'], bs.inputs['Roughness']); nt.links.new(sc_.outputs['Blue'], bs.inputs['Metallic'])
caulk = bpy.data.materials.new('Deck_Caulk'); caulk.use_nodes = True
cb = caulk.node_tree.nodes['Principled BSDF']; cb.inputs['Base Color'].default_value = (0.012, 0.011, 0.01, 1); cb.inputs['Roughness'].default_value = 0.85

# ---------------------------------------------------------------------------------------- planks
planks = region.copy(); planks.data = region.data.copy(); planks.name = 'deck_planks'
bpy.context.scene.collection.objects.link(planks)
region.data.materials.clear(); region.data.materials.append(caulk)
planks.data.materials.clear(); planks.data.materials.append(teak)
region.data.transform(__import__('mathutils').Matrix.Translation((0, 0, 0.0015)))   # caulk sits just above the old surface
bpy.context.view_layer.objects.active = planks
for o in bpy.context.scene.objects: o.select_set(o == planks)
mn = Vector((min(v.co.x for v in planks.data.vertices), min(v.co.y for v in planks.data.vertices), min(v.co.z for v in planks.data.vertices)))
mx = Vector((max(v.co.x for v in planks.data.vertices), max(v.co.y for v in planks.data.vertices), max(v.co.z for v in planks.data.vertices)))
log('region bbox', tuple(round(c, 3) for c in mn), tuple(round(c, 3) for c in mx))
# strip seams every W along x, staggered butt joints per strip; slice the deck surface, drop the gap faces, extrude up
rnd = random.Random(5)
k0, k1 = math.floor(mn.x / W) - 1, math.ceil(mx.x / W) + 1
joints = {}
for k in range(k0, k1 + 1):
    y = mn.y + rnd.uniform(0.2, 2.4); js = []
    while y < mx.y - 0.15:
        js.append(y); y += rnd.uniform(2.2, 3.4)
    joints[k] = js
pbm = bmesh.new(); pbm.from_mesh(planks.data)
def cut(co, no):
    geom = pbm.verts[:] + pbm.edges[:] + pbm.faces[:]
    bmesh.ops.bisect_plane(pbm, geom=geom, plane_co=co, plane_no=no)
for k in range(k0, k1 + 1):
    for x in (k * W - GAP / 2, k * W + GAP / 2): cut(Vector((x, 0, 0)), Vector((1, 0, 0)))
for yj in sorted({round(y, 4) for js in joints.values() for y in js}):
    for y in (yj - 0.003, yj + 0.003): cut(Vector((0, y, 0)), Vector((0, 1, 0)))
def in_gap(c):
    k = math.floor(c.x / W + 0.5)
    if abs(c.x - k * W) < GAP / 2: return True
    ks = math.floor(c.x / W)
    return any(abs(c.y - yj) < 0.003 for yj in joints.get(ks, []))
bmesh.ops.delete(pbm, geom=[f for f in pbm.faces if in_gap(f.calc_center_median())], context='FACES')
bmesh.ops.dissolve_limit(pbm, angle_limit=math.radians(2.0), verts=pbm.verts[:], edges=pbm.edges[:])
ex = bmesh.ops.extrude_face_region(pbm, geom=pbm.faces[:])
top = [e for e in ex['geom'] if isinstance(e, bmesh.types.BMVert)]
bmesh.ops.translate(pbm, verts=top, vec=Vector((0, 0, THK)))
bmesh.ops.recalc_face_normals(pbm, faces=pbm.faces[:])
pbm.to_mesh(planks.data); pbm.free()
bv = planks.modifiers.new('bev', 'BEVEL'); bv.width = BEV; bv.segments = 1; bv.limit_method = 'ANGLE'; bv.angle_limit = math.radians(50)
bpy.ops.object.modifier_apply(modifier='bev')

# UVs: u along the plank (1.6 m repeat), v = random texture strip per plank segment
pbm = bmesh.new(); pbm.from_mesh(planks.data)
uvl = pbm.loops.layers.uv.verify()
seg_cache = {}
for f in pbm.faces:
    c = f.calc_center_median()
    k = math.floor(c.x / W)
    si = sum(1 for yj in joints.get(k, []) if c.y > yj)
    key = (k, si)
    if key not in seg_cache: seg_cache[key] = (rnd.randrange(8), rnd.uniform(0, 1.6), rnd.random() < 0.5)
    s, off, flip = seg_cache[key]
    for l in f.loops:
        p = l.vert.co
        fx = min(max((p.x - k * W) / W, 0.0), 1.0)
        if flip: fx = 1 - fx
        l[uvl].uv = ((p.y + off) / 1.6, 1.0 - (s + 0.03 + 0.94 * fx) / 8.0)
pbm.to_mesh(planks.data); pbm.free()
for p in planks.data.polygons: p.use_smooth = False
log('plank tris', sum(len(p.vertices) - 2 for p in planks.data.polygons), 'segments', len(seg_cache))

# ---------------------------------------------------------------------------------------- join + export
for o in bpy.context.scene.objects: o.select_set(o in (boat, region, planks))
bpy.context.view_layer.objects.active = boat
bpy.ops.object.join()
bpy.ops.export_scene.gltf(
    filepath=OUT, export_format='GLB', export_yup=True, export_apply=True,
    export_image_format='JPEG', export_jpeg_quality=92,
    export_draco_mesh_compression_enable=False, export_cameras=False, export_lights=False, export_extras=False,
    export_copyright='"2002 Grand Banks" by BoatUS Foundation (https://sketchfab.com/boatusfoundation), CC-BY 4.0, modified',
)
log('exported', OUT, round(os.path.getsize(OUT) / 1e6, 2), 'MB')
