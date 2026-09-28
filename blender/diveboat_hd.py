"""Downloaded "2002 Grand Banks" trawler (BoatUS Foundation, CC-BY 4.0) -> game-ready diveboat_hd.glb.

Usage (from WSL, Blender 5.2, background):
  B="/mnt/c/Program Files/Blender Foundation/Blender 5.2/blender.exe"
  "$B" --background --factory-startup --python "$(wslpath -w blender/diveboat_hd.py)" -- "$(wslpath -w .)" [--render]

  arg 1     project root (contains assets/)
  --render  after export, re-import the GLB and render assets/models/game/diveboat_hd_preview_*.png

Source: assets/models/raw3/grand_banks_2002_src.glb
  (Objaverse mirror of https://sketchfab.com/3d-models/2002-grand-banks-14564c5ec6ee4f11a3ea8e213b981cb1)

Conventions (same as blender/diveboat.py; exporter maps Blender (x, y, z) -> glTF (x, z, -y)):
  * metres; bow -> Blender -Y == glTF +Z; port side = +X
  * design waterline (top of the blue antifouling paint, measured from the base-colour texture) at z = 0
  * X = 0 centreline, overall length (pulpit tip .. swim-platform edge) centred on Y = 0
Processing:
  * delete Object_3 (84.5k triangles of sub-millimetre CAD hardware, total area 0.026 m^2, invisible)
  * merge split vertices, dissolve degenerate faces, decimate (collapse) to <= ~190k triangles
  * clear imported custom normals, smooth by angle (sharp edges > 35 deg), keep doubleSided materials
  * Fire-extinguisher BLEND material -> OPAQUE; glass stays BLEND
  * textures (all <= 1024 px) re-encoded as JPEG q90 on export; no Draco / KTX2
  * empties spawn_diver (cockpit, eye height 1.65 m above teak deck) and entry_point (swim-platform aft edge)
"""
import bpy, bmesh, math, sys, os
from mathutils import Vector

ARGS = sys.argv[sys.argv.index('--') + 1:] if '--' in sys.argv else []
ROOT = ARGS[0] if ARGS and not ARGS[0].startswith('--') else os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
SRC = os.path.join(ROOT, 'assets', 'models', 'raw3', 'grand_banks_2002_src.glb')
OUTDIR = os.path.join(ROOT, 'assets', 'models', 'game')
GLB = os.path.join(OUTDIR, 'diveboat_hd.glb')
TARGET_TRIS = 190000
EYE = 1.65


def log(*a):
    print('[diveboat_hd]', *a, flush=True)


def tri_count(objs):
    return sum(sum(len(p.vertices) - 2 for p in o.data.polygons) for o in objs)


def meshes():
    return [o for o in bpy.context.scene.objects if o.type == 'MESH']


# ---------------------------------------------------------------------------------------- import
bpy.ops.wm.read_factory_settings(use_empty=True)
bpy.ops.import_scene.gltf(filepath=SRC)
sc = bpy.context.scene

bpy.data.objects.remove(bpy.data.objects['Object_3'], do_unlink=True)  # invisible micro-hardware

# bake the Sketchfab root transforms (0.927 scale, -90 deg X) into the meshes, drop empties
for o in meshes():
    mw = o.matrix_world.copy()
    o.parent = None
    o.matrix_world = mw
for o in list(sc.objects):
    if o.type != 'MESH':
        bpy.data.objects.remove(o, do_unlink=True)
bpy.ops.object.select_all(action='SELECT')
bpy.context.view_layer.objects.active = meshes()[0]
bpy.ops.object.transform_apply(location=True, rotation=True, scale=True)

# join the 65k-vertex chunks of the atlas material into one hull object
base = [o for o in meshes() if o.data.materials and o.data.materials[0].name == 'Grand_Base']
bpy.ops.object.select_all(action='DESELECT')
for o in base:
    o.select_set(True)
bpy.context.view_layer.objects.active = base[0]
bpy.ops.object.join()
base[0].name = 'GB_Base'
log('tris after cleanup', tri_count(meshes()))

# ---------------------------------------------------------------------------------------- measure
dg = bpy.context.evaluated_depsgraph_get()
img = bpy.data.materials['Grand_Base'].node_tree.nodes
base_img = [n.image for n in img if n.type == 'TEX_IMAGE' and any(l.to_socket.name == 'Base Color' for l in n.outputs[0].links)][0]
W, H = base_img.size
PIX = base_img.pixels[:]


def sample_color(obj, poly_index, hit):
    me = obj.data
    poly = me.polygons[poly_index]
    vs = [obj.matrix_world @ me.vertices[v].co for v in poly.vertices]
    uvl = me.uv_layers.active.data
    uvs = [uvl[li].uv for li in poly.loop_indices]
    a, b, c = vs[0], vs[1], vs[2]
    v0, v1, v2 = b - a, c - a, hit - a
    d00, d01, d11, d20, d21 = v0.dot(v0), v0.dot(v1), v1.dot(v1), v2.dot(v0), v2.dot(v1)
    den = d00 * d11 - d01 * d01 or 1e-12
    v = (d11 * d20 - d01 * d21) / den
    w = (d00 * d21 - d01 * d20) / den
    u = 1 - v - w
    uv = uvs[0] * u + uvs[1] * v + uvs[2] * w
    px = int((uv.x % 1.0) * W) % W
    py = int((uv.y % 1.0) * H) % H
    i = (py * W + px) * 4
    return PIX[i:i + 3]


def classify(col):
    r, g, b = col
    if b > 0.35 and b > r + 0.2:
        return 'blue'
    if max(col) < 0.12:
        return 'black'
    return 'other'


def waterline_at(y):
    """Scan the port topside at station y from below; return top of the blue antifouling."""
    top_blue = None
    z = -3.4
    while z < -0.5:
        r = sc.ray_cast(dg, Vector((6.0, y, z)), Vector((-1, 0, 0)))
        if r[0] and r[4].name == 'GB_Base':
            if classify(sample_color(r[4], r[3], r[1])) == 'blue':
                top_blue = z
        z += 0.005
    return top_blue


stations = [-4.0, -2.0, 0.0, 2.0, 4.0, 5.5]
wl = {y: waterline_at(y) for y in stations}
log('antifouling top per station (raw z):', {k: (round(v, 3) if v else None) for k, v in wl.items()})
vals = sorted(v for v in wl.values() if v is not None)
DWL = vals[len(vals) // 2]  # median: the boot stripe sweeps up a little toward the bow
log('design waterline (raw z) =', round(DWL, 3))


def ray_down(x, y, z0=10.0, skip_above=None):
    """List of (z, object) hits straight down."""
    out = []
    o = Vector((x, y, z0))
    for _ in range(12):
        r = sc.ray_cast(dg, o, Vector((0, 0, -1)))
        if not r[0]:
            break
        out.append((r[1].z, r[4].name))
        o = r[1] - Vector((0, 0, 0.003))
    return out


# cockpit teak deck (Object_11) under the flybridge overhang, and the swim platform (Object_12)
SPAWN_Y = 5.7
deck = [z for z, n in ray_down(0.0, SPAWN_Y) if n == 'Object_11' and -2.2 < z < -1.2]
DECK_Z = max(deck)
plat_y = None
y = 6.5
while y < 8.0:
    h = [z for z, n in ray_down(0.0, y) if n == 'Object_12']
    if h:
        plat_y, PLAT_Z = y, max(h)
    y += 0.01
log('cockpit deck z (raw) =', round(DECK_Z, 3), ' swim platform aft edge y/z (raw) =', round(plat_y, 3), round(PLAT_Z, 3))

# ---------------------------------------------------------------------------------------- clean + decimate
for o in meshes():
    bpy.context.view_layer.objects.active = o
    bm = bmesh.new()
    bm.from_mesh(o.data)
    bmesh.ops.remove_doubles(bm, verts=bm.verts, dist=0.0002)
    bmesh.ops.dissolve_degenerate(bm, edges=bm.edges, dist=0.00005)
    bmesh.ops.triangulate(bm, faces=bm.faces)
    bm.to_mesh(o.data)
    bm.free()
    if o.data.has_custom_normals:
        with bpy.context.temp_override(object=o, active_object=o, selected_objects=[o], selected_editable_objects=[o]):
            bpy.ops.mesh.customdata_custom_splitnormals_clear()

total = tri_count(meshes())
small = sum(tri_count([o]) for o in meshes() if tri_count([o]) < 5000)
big = [o for o in meshes() if tri_count([o]) >= 5000]
ratio = min(1.0, (TARGET_TRIS - small) / max(1, total - small))
log('tris before decimation', total, 'ratio for big meshes', round(ratio, 3))
for o in big:
    m = o.modifiers.new('dec', 'DECIMATE')
    m.decimate_type = 'COLLAPSE'
    m.ratio = ratio
    m.use_collapse_triangulate = True
    with bpy.context.temp_override(object=o, active_object=o):
        bpy.ops.object.modifier_apply(modifier=m.name)

for o in meshes():
    o.data.set_sharp_from_angle(angle=math.radians(35))
    for p in o.data.polygons:
        p.use_smooth = True

# ---------------------------------------------------------------------------------------- materials
ext = bpy.data.materials.get('Grand_Fire_Exstinguisher')
if ext:
    ext.surface_render_method = 'DITHERED'
    bsdf = ext.node_tree.nodes.get('Principled BSDF')
    for l in list(bsdf.inputs['Alpha'].links):
        ext.node_tree.links.remove(l)
    bsdf.inputs['Alpha'].default_value = 1.0
    if hasattr(ext, 'blend_method'):
        ext.blend_method = 'OPAQUE'

# ---------------------------------------------------------------------------------------- recentre
mn = Vector((1e9,) * 3)
mx = -mn
for o in meshes():
    for v in o.data.vertices:
        mn = Vector(map(min, mn, v.co))
        mx = Vector(map(max, mx, v.co))
shift = Vector((-(mn.x + mx.x) / 2, -(mn.y + mx.y) / 2, -DWL))
for o in meshes():
    o.data.transform(__import__('mathutils').Matrix.Translation(shift))
log('bbox after recentre', tuple(round(c, 3) for c in mn + shift), tuple(round(c, 3) for c in mx + shift))

# final: join everything into one node
bpy.ops.object.select_all(action='SELECT')
bpy.context.view_layer.objects.active = bpy.data.objects['GB_Base']
bpy.ops.object.join()
boat = bpy.context.view_layer.objects.active
boat.name = 'diveboat_hd'
boat.data.name = 'diveboat_hd'

spawn = Vector((0.0, SPAWN_Y, DECK_Z + EYE)) + shift
entry = Vector((0.0, plat_y, PLAT_Z)) + shift
for name, p in (('spawn_diver', spawn), ('entry_point', entry)):
    e = bpy.data.objects.new(name, None)
    e.empty_display_type = 'ARROWS'
    e.location = p
    sc.collection.objects.link(e)
    log(name, 'blender', tuple(round(c, 3) for c in p), 'glTF', (round(p.x, 3), round(p.z, 3), round(-p.y, 3)))
log('deck surface glTF y =', round(DECK_Z - DWL, 3), ' swim platform glTF y =', round(PLAT_Z - DWL, 3))
log('final tris', tri_count([boat]))

# ---------------------------------------------------------------------------------------- export
os.makedirs(OUTDIR, exist_ok=True)
bpy.ops.export_scene.gltf(
    filepath=GLB, export_format='GLB', export_yup=True, export_apply=True,
    export_image_format='JPEG', export_jpeg_quality=90,
    export_draco_mesh_compression_enable=False,
    export_cameras=False, export_lights=False, export_extras=False,
    export_copyright='"2002 Grand Banks" by BoatUS Foundation (https://sketchfab.com/boatusfoundation), CC-BY 4.0, modified',
)
log('exported', GLB, os.path.getsize(GLB) / 1e6, 'MB')

# ---------------------------------------------------------------------------------------- previews
if '--render' in ARGS:
    bpy.ops.wm.read_factory_settings(use_empty=True)
    bpy.ops.import_scene.gltf(filepath=GLB)
    sc = bpy.context.scene
    sp = bpy.data.objects['spawn_diver'].matrix_world.translation.copy()
    w = bpy.data.worlds.new('w'); sc.world = w; w.use_nodes = True
    w.node_tree.nodes['Background'].inputs[0].default_value = (0.55, 0.7, 0.9, 1)
    w.node_tree.nodes['Background'].inputs[1].default_value = 0.9
    sun = bpy.data.objects.new('sun', bpy.data.lights.new('sun', 'SUN'))
    sun.data.energy = 4; sun.data.angle = math.radians(1)
    sun.rotation_euler = (math.radians(20), 0, math.radians(35))  # midday, high sun
    sc.collection.objects.link(sun)
    # water plane (preview only) at the waterline, semi-transparent
    bpy.ops.mesh.primitive_plane_add(size=60, location=(0, 0, 0))
    wp = bpy.context.object
    wm = bpy.data.materials.new('water'); wm.use_nodes = True
    b = wm.node_tree.nodes['Principled BSDF']
    b.inputs['Base Color'].default_value = (0.02, 0.12, 0.2, 1); b.inputs['Roughness'].default_value = 0.1
    b.inputs['Alpha'].default_value = 0.6
    wm.surface_render_method = 'BLENDED'
    wp.data.materials.append(wm)
    cam = bpy.data.objects.new('cam', bpy.data.cameras.new('cam')); sc.collection.objects.link(cam); sc.camera = cam
    cam.data.clip_start = 0.02
    sc.render.engine = 'BLENDER_EEVEE'
    sc.render.resolution_x, sc.render.resolution_y = 1400, 875
    sc.view_settings.view_transform = 'Standard'

    def shot(name, loc, tgt, lens):
        cam.location = loc; cam.data.lens = lens
        cam.rotation_euler = (Vector(tgt) - Vector(loc)).to_track_quat('-Z', 'Y').to_euler()
        sc.render.filepath = os.path.join(OUTDIR, 'diveboat_hd_preview_' + name + '.png')
        bpy.ops.render.render(write_still=True)

    shot('bow34', (11, -16, 4.5), (0, -1, 1.0), 35)
    shot('aftdeck_pov', tuple(sp), (sp.x, sp.y + 3.0, sp.z - 1.9), 16)
    shot('side', (26, 0, 1.5), (0, 0, 1.0), 45)
