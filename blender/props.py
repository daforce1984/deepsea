# Blender 5.x: futuristic dive props -> GLB (glTF: +Y up, forward -Z == Blender +Y)
import bpy, bmesh, math, sys, os
OUT = sys.argv[sys.argv.index('--') + 1]

def reset():
    bpy.ops.wm.read_factory_settings(use_empty=True)

def mat(name, col, metal=0.0, rough=0.5, emit=None, strength=0.0):
    m = bpy.data.materials.new(name); m.use_nodes = True
    b = m.node_tree.nodes['Principled BSDF']
    b.inputs['Base Color'].default_value = (*col, 1); b.inputs['Metallic'].default_value = metal; b.inputs['Roughness'].default_value = rough
    if emit:
        b.inputs['Emission Color'].default_value = (*emit, 1); b.inputs['Emission Strength'].default_value = strength
    return m

def lathe(name, profile, segs=40, material=None, axis='Y'):
    """profile: list of (radius, y) -> revolved mesh around Y"""
    bm = bmesh.new(); rings = []
    for r, y in profile:
        ring = []
        for i in range(segs):
            a = 2 * math.pi * i / segs
            ring.append(bm.verts.new((r * math.cos(a), y, r * math.sin(a))))
        rings.append(ring)
    for k in range(len(rings) - 1):
        for i in range(segs):
            j = (i + 1) % segs
            bm.faces.new((rings[k][i], rings[k][j], rings[k + 1][j], rings[k + 1][i]))
    me = bpy.data.meshes.new(name); bm.to_mesh(me); bm.free()
    ob = bpy.data.objects.new(name, me); bpy.context.collection.objects.link(ob)
    for p in me.polygons: p.use_smooth = True
    if material: me.materials.append(material)
    return ob

def box(name, size, loc, material, bevel=0.002, segs=3):
    bpy.ops.mesh.primitive_cube_add(size=1, location=loc)
    ob = bpy.context.object; ob.name = name; ob.scale = size
    bpy.ops.object.transform_apply(scale=True)
    m = ob.modifiers.new('bev', 'BEVEL'); m.width = bevel; m.segments = segs
    ob.data.materials.append(material)
    bpy.ops.object.shade_smooth()
    return ob

def export(path, objs):
    bpy.ops.object.select_all(action='DESELECT')
    for o in objs: o.select_set(True)
    bpy.ops.export_scene.gltf(filepath=path, export_format='GLB', use_selection=True, export_apply=True, export_yup=True)

# ---------------- flashlight (points +Y blender = -Z gltf) ----------------
reset()
body = mat('TorchBody', (0.035, 0.037, 0.042), 0.85, 0.32)
grip = mat('TorchGrip', (0.015, 0.015, 0.017), 0.0, 0.8)
trim = mat('TorchTrim', (0.05, 0.6, 0.9), 0.2, 0.3, (0.1, 0.75, 1.0), 6.0)
lens = mat('Lens', (0.9, 0.95, 1.0), 0.0, 0.05, (1.0, 0.95, 0.85), 40.0)
refl = mat('Reflector', (0.9, 0.9, 0.92), 1.0, 0.12)
objs = []
objs.append(lathe('torch_body', [(0.0, -0.12), (0.016, -0.12), (0.019, -0.117), (0.02, -0.11), (0.02, 0.02), (0.024, 0.04), (0.031, 0.065),
                                 (0.033, 0.07), (0.033, 0.098), (0.030, 0.102), (0.027, 0.102)], 48, body))
objs.append(lathe('torch_grip', [(0.0205, -0.095), (0.0215, -0.093), (0.0215, 0.005), (0.0205, 0.007)], 48, grip))
for y in (-0.085, -0.06, -0.035, -0.01):
    objs.append(lathe('ridge', [(0.0212, y), (0.023, y + 0.002), (0.023, y + 0.006), (0.0212, y + 0.008)], 48, grip))
objs.append(lathe('torch_trim', [(0.0335, 0.074), (0.0342, 0.075), (0.0342, 0.079), (0.0335, 0.08)], 48, trim))
objs.append(lathe('torch_trim2', [(0.0205, -0.105), (0.0212, -0.104), (0.0212, -0.1), (0.0205, -0.099)], 48, trim))
objs.append(lathe('reflector', [(0.008, 0.08), (0.027, 0.1)], 48, refl))
objs.append(lathe('lens', [(0.0, 0.0985), (0.027, 0.0985)], 48, lens))
objs.append(lathe('led', [(0.0, 0.082), (0.007, 0.082), (0.007, 0.084), (0.0, 0.085)], 24, lens))
b = box('switch', (0.012, 0.022, 0.006), (0, -0.03, 0.022), trim, 0.002)
objs.append(b)
export(os.path.join(OUT, 'torch.glb'), objs)

# ---------------- dive computer (screen faces +Z blender = +Y gltf, i.e. up from wrist back) ----------------
reset()
shell = mat('DCShell', (0.03, 0.032, 0.036), 0.6, 0.35)
bez = mat('DCBezel', (0.25, 0.27, 0.3), 1.0, 0.22)
strap = mat('DCStrap', (0.02, 0.02, 0.022), 0.0, 0.75)
glow = mat('DCGlow', (0.05, 0.6, 0.9), 0.0, 0.3, (0.1, 0.8, 1.0), 5.0)
screen = mat('Screen', (0.0, 0.0, 0.0), 0.0, 0.1, (1, 1, 1), 1.0)
objs = []
objs.append(box('dc_shell', (0.052, 0.046, 0.012), (0, 0, 0.006), shell, 0.004, 4))
objs.append(box('dc_bezel', (0.054, 0.048, 0.003), (0, 0, 0.0115), bez, 0.0012, 2))
bpy.ops.mesh.primitive_plane_add(size=1, location=(0, 0, 0.0137))   # 0.6 mm above the bezel (no z-fighting)
sc = bpy.context.object; sc.name = 'dc_screen'; sc.scale = (0.044, 0.038, 1); bpy.ops.object.transform_apply(scale=True)
sc.data.materials.append(screen); objs.append(sc)
for x in (-0.028, 0.028):
    objs.append(box('dc_btn', (0.004, 0.008, 0.005), (x, 0.01, 0.006), glow, 0.001, 2))
# strap: ring around the wrist (wrist axis = blender Y), wrist center below the unit
bm = bmesh.new()
R, W, T, S = 0.036, 0.024, 0.004, 48
bmesh.ops.create_circle(bm, segments=S, radius=1)
me = bpy.data.meshes.new('strap'); bm.free()
prof = []
# strap clears the suit sleeve (r ~34 mm horizontal / ~28 mm vertical) by >= 2 mm everywhere
st = lathe('dc_strap', [(0.0365, -0.012), (0.0400, -0.0115), (0.0400, 0.0115), (0.0365, 0.012), (0.0365, -0.012)], 56, strap)
st.rotation_euler = (0, 0, 0); st.location = (0, 0, -0.034)
st.scale = (1.0, 1.0, 0.85)
objs.append(st)
export(os.path.join(OUT, 'divecomputer.glb'), objs)

# ---------------- forearm sleeve (wrist at origin, extends -Y blender = +Z gltf, i.e. back toward elbow) ----------------
reset()
suit = mat('Suit', (0.018, 0.02, 0.024), 0.0, 0.55)
plate = mat('SuitPlate', (0.06, 0.065, 0.075), 0.7, 0.3)
strip = mat('SuitGlow', (0.05, 0.6, 0.9), 0.0, 0.3, (0.1, 0.8, 1.0), 4.0)
objs = []
prof = []
for i in range(17):
    t = i / 16; y = -t * 0.34
    r = 0.028 + 0.017 * math.sin(min(t * 1.4, 1) * math.pi / 2) + 0.002 * math.sin(t * 40)
    prof.append((r, y))
sl = lathe('sleeve', prof, 40, suit); sl.scale = (1.0, 1.0, 0.82); objs.append(sl)
objs.append(lathe('cuff', [(0.029, 0.006), (0.0315, 0.004), (0.0315, -0.02), (0.0305, -0.024)], 40, plate))
objs[-1].scale = (1.0, 1.0, 0.84)
c2 = lathe('cuffglow', [(0.0318, -0.009), (0.0322, -0.0095), (0.0322, -0.0125), (0.0318, -0.013)], 40, strip); c2.scale = (1, 1, 0.84); objs.append(c2)
pl = box('armplate', (0.03, 0.14, 0.01), (0, -0.16, 0.036), plate, 0.004, 3); pl.rotation_euler = (math.radians(-5), 0, 0); objs.append(pl)
g2 = box('armstrip', (0.004, 0.11, 0.004), (0.0, -0.16, 0.0415), strip, 0.0015, 2); objs.append(g2)
export(os.path.join(OUT, 'sleeve.glb'), objs)
print('DONE props')
