# Cycles-CPU preview sheet for an existing (possibly rigged, multi-material) GLB: side (left flank), 3/4 front (top row),
# head close-up side, top (bottom row); 4 x 640x360 panels.
#   blender --background --factory-startup --python blender/glb_preview.py -- <in.glb> <out.png> [samples]
import bpy, sys, os, mathutils, numpy as np
a = sys.argv[sys.argv.index('--') + 1:]
SRC, PV = a[0], a[1]; SAMPLES = int(a[2]) if len(a) > 2 else 24
bpy.ops.wm.read_factory_settings(use_empty=True)
bpy.ops.import_scene.gltf(filepath=SRC)
sc = bpy.context.scene
for o in list(bpy.data.objects):
    if o.type == 'MESH' and o.parent is None and not o.modifiers and len(o.data.vertices) < 100: bpy.data.objects.remove(o)   # importer bone shapes
ms = [o for o in sc.objects if o.type == 'MESH']
dg = bpy.context.evaluated_depsgraph_get()
P = []
for o in ms:
    e = o.evaluated_get(dg); me = e.to_mesh(); P += [o.matrix_world @ v.co for v in me.vertices]; e.to_mesh_clear()
P = np.array(P); mn, mx = P.min(0), P.max(0); c = (mn + mx) / 2; e = mx - mn; L = float(e[1])
sc.render.engine = 'CYCLES'; sc.cycles.device = 'CPU'; sc.cycles.samples = SAMPLES; sc.cycles.use_denoising = False
sc.render.resolution_x, sc.render.resolution_y = 640, 360
w = bpy.data.worlds.new('w'); sc.world = w; w.use_nodes = True
bg = next(n for n in w.node_tree.nodes if n.type == 'BACKGROUND'); bg.inputs[0].default_value = (0.05, 0.06, 0.07, 1)
def look(ob, f, u):
    f = mathutils.Vector(f).normalized(); u = mathutils.Vector(u); z = -f
    x = u.cross(z).normalized(); y = z.cross(x); ob.matrix_world = mathutils.Matrix((x, y, z)).transposed().to_4x4()
for nm, d, en in (('key', (-0.5, 0.3, -1.0), 4.0), ('fill', (0.8, -0.6, -0.3), 1.2)):
    Lt = bpy.data.lights.new(nm, 'SUN'); Lt.energy = en; ob = bpy.data.objects.new(nm, Lt); sc.collection.objects.link(ob); look(ob, d, (0, 0, 1))
cam = bpy.data.objects.new('cam', bpy.data.cameras.new('cam')); sc.collection.objects.link(cam); sc.camera = cam
cam.data.type = 'ORTHO'; cam.data.clip_end = L * 20
head = mathutils.Vector((c[0], mn[1] + L * 0.12, c[2]))
views = [((-1, 0, 0), (0, 0, 1), max(e[1], e[2] * 16 / 9) * 1.1, mathutils.Vector(c)),
         ((-0.7, 0.6, -0.35), (0, 0, 1), max(e) * 1.05, mathutils.Vector(c)),
         ((-1, 0, 0), (0, 0, 1), L * 0.3, head),
         ((0, 0, -1), (1, 0, 0), max(e[1], e[0] * 16 / 9) * 1.1, mathutils.Vector(c))]
tiles = []; tmp = os.path.splitext(PV)[0] + '_tmp.png'
for f, u, s, tgt in views:
    look(cam, f, u); cam.location = tgt - mathutils.Vector(f).normalized() * L * 4; cam.data.ortho_scale = s
    sc.render.filepath = tmp; bpy.ops.render.render(write_still=True)
    im = bpy.data.images.load(tmp); tiles.append(np.array(im.pixels[:], np.float32).reshape(360, 640, 4)); bpy.data.images.remove(im)
os.remove(tmp)
sheet = np.concatenate([np.concatenate(tiles[2:4], 1), np.concatenate(tiles[0:2], 1)], 0)
img = bpy.data.images.new('sheet', 1280, 720, alpha=False); img.pixels[:] = sheet.ravel(); img.filepath_raw = PV; img.file_format = 'PNG'; img.save()
print('PREVIEW', PV)
