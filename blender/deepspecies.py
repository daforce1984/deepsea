# Generic builder for assets/models/raw9/<species>.glb from CC-BY / CC0 scans and sculpts (Objaverse mirror of Sketchfab).
# Usage:
#   blender --background --factory-startup --python deepspecies.py -- <src.glb> <out.glb> <length_m> [flags]
# Flags (source axes are Blender world axes after glTF import, i.e. glTF +Y up = Blender +Z):
#   --fwd=+x|-x|+y|-y|+z|-z   head direction in the source (default: long axis, thicker end = head)
#   --up=+x|...               dorsal direction in the source (default: remaining axis with the larger mid-body extent, +)
#   --straighten              remove the specimen's lateral bend (cubic centre-line fit, fish scans lying on their side)
#   --tris=N                  triangle budget of the output mesh (default 25000)
#   --base=N                  base-colour texture size (default 1024)
#   --aux=N                   normal / ORM texture size (default 1024)
#   --color=r,g,b             flat linear base colour (used when the source has no texture; overrides the bake)
#   --rough=lo,hi             roughness range mapped from texture luminance (default 0.5,0.75)
#   --debris=f                drop loose parts smaller than f * vertex count (default 0.002)
#   --keep-small              keep separate mesh objects with < 100 faces (default: removed - helper cubes)
#   --preview=<png>           also render a 2x2 Cycles-CPU preview sheet (4 x 640x360 panels)
# Steps: drop helper cubes / colour checkers (non-dominant material), join parts, bake all transforms,
#   metres at the real species length, head -> glTF +Z, up -> glTF +Y (left side = +X), bbox centred at the origin,
#   weld seams, remove floating scan debris, optional straightening, decimate to the budget, new UVs, smooth normals;
#   bakes from the full-resolution source with Cycles on the CPU (GPU reserved for the running WebGPU game):
#   base colour (emission of the source texture), tangent-space normal map, ambient occlusion;
#   metallic-roughness material (metallic 0, roughness from luminance, AO in ORM.R), double-sided.
# No rig / animation: the game's shader swims static meshes procedurally along +Z.
import bpy, sys, math, mathutils, bmesh, os, numpy as np

argv = sys.argv[sys.argv.index('--') + 1:]
SRC, OUT, LENGTH = argv[0], argv[1], float(argv[2])
F = {}
for a in argv[3:]:
    k, _, v = a.lstrip('-').partition('=')
    F[k] = v if v else True
MAX_TRIS = int(F.get('tris', 25000))
TEX_BASE, TEX_AUX = int(F.get('base', 1024)), int(F.get('aux', 1024))
RLO, RHI = map(float, F.get('rough', '0.5,0.75').split(','))
DEBRIS = float(F.get('debris', 0.002))
NAME = os.path.splitext(os.path.basename(OUT))[0]
assert os.path.isabs(OUT), 'output path must be absolute'

def axis(s):
    v = mathutils.Vector((0, 0, 0)); v['xyz'.index(s[1])] = -1 if s[0] == '-' else 1; return v

PREVIEW_ONLY = bool(F.get('preview-only'))   # re-render the preview of an existing <out.glb>
bpy.ops.wm.read_factory_settings(use_empty=True)
sc = bpy.context.scene
bpy.ops.import_scene.gltf(filepath=OUT if PREVIEW_ONLY else SRC)
bpy.context.view_layer.update()

def build():
    global lo, bsdf, nt, base
    # ---- keep only the specimen: meshes of the dominant material (drops colour checkers), no tiny helper cubes
    meshes = [o for o in bpy.data.objects if o.type == 'MESH']
    area = {}
    for o in meshes:
        for p in o.data.polygons:
            m = o.data.materials[p.material_index].name if o.data.materials else ''
            area[m] = area.get(m, 0) + 1
    dom = max(area, key=area.get)
    keep = []
    for o in meshes:
        mats = [m.name for m in o.data.materials if m]
        if (not F.get('keep-small') and len(o.data.polygons) < 100) or (mats and dom not in mats):
            print('drop object', o.name, len(o.data.polygons), mats)
            bpy.data.objects.remove(o)
        else:
            keep.append(o)
    for o in keep:
        M = o.matrix_world.copy(); o.parent = None; o.matrix_world = M
    for o in list(bpy.data.objects):
        if o.type != 'MESH': bpy.data.objects.remove(o)
    bpy.ops.object.select_all(action='DESELECT')
    for o in keep:
        o.select_set(True)
        if o.data.users > 1: o.data = o.data.copy()
    bpy.context.view_layer.objects.active = keep[0]
    bpy.ops.object.transform_apply(location=True, rotation=True, scale=True)
    if len(keep) > 1: bpy.ops.object.join()
    hi = bpy.context.view_layer.objects.active
    hi.name = 'src_hi'

    # ---- frame
    V = np.array([v.co for v in hi.data.vertices])
    mn, mx = V.min(0), V.max(0); ext = mx - mn
    if 'fwd' in F:
        fwd = axis(F['fwd']); ax = int(np.argmax(np.abs(fwd)))
    else:
        ax = int(np.argmax(ext))
        t = (V[:, ax] - mn[ax]) / ext[ax]
        o2 = [i for i in range(3) if i != ax]
        def sl(a, b):
            s = V[(t >= a) & (t < b)]; e = s.max(0) - s.min(0); return e[o2[0]] * e[o2[1]]
        fwd = mathutils.Vector((0, 0, 0)); fwd[ax] = -1 if sl(0, 0.1) > sl(0.9, 1.0) else 1
    if 'up' in F:
        up = axis(F['up'])
    else:
        t = (V[:, ax] - mn[ax]) / ext[ax]
        s = V[(t > 0.3) & (t < 0.7)]; e = s.max(0) - s.min(0)
        o2 = [i for i in range(3) if i != ax]
        up = mathutils.Vector((0, 0, 0)); up[max(o2, key=lambda i: e[i])] = 1
    print('SRC extent', tuple(ext), 'fwd', tuple(fwd), 'up', tuple(up))
    c = mathutils.Vector((mn + mx) / 2)
    src = mathutils.Matrix((fwd, up, fwd.cross(up))).transposed()
    Fw, Up = mathutils.Vector((0, -1, 0)), mathutils.Vector((0, 0, 1))   # Blender -Y = glTF +Z, Blender +Z = glTF +Y
    dst = mathutils.Matrix((Fw, Up, Fw.cross(Up))).transposed()
    R = (dst @ src.inverted()).to_4x4()
    k = LENGTH / ext[ax]
    hi.data.transform(mathutils.Matrix.Scale(k, 4) @ R @ mathutils.Matrix.Translation(-c))
    hi.data.update()

    # ---- weld seams, remove floating debris
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
    drop = [v for comp in comps if len(comp) < DEBRIS * len(bm.verts) for v in comp]
    print('components', len(comps), 'sizes', [len(x) for x in comps[:8]], 'dropping verts', len(drop))
    bmesh.ops.delete(bm, geom=drop, context='VERTS')
    bm.to_mesh(hi.data); bm.free()

    V = np.array([v.co for v in hi.data.vertices])
    if F.get('straighten'):
        ys = np.linspace(V[:, 1].min(), V[:, 1].max(), 41)
        cy, cx = [], []
        for a, b in zip(ys[:-1], ys[1:]):
            s = V[(V[:, 1] >= a) & (V[:, 1] < b)]
            if len(s) > 20: cy.append((a + b) / 2); cx.append(np.median(s[:, 0]))
        p = np.polyfit(cy, cx, 3)
        V[:, 0] -= np.polyval(p, V[:, 1])
        print('lateral bend removed, max offset', float(np.abs(np.polyval(p, np.array(cy))).max()))
    # rescale so the final length is exact after cleanup / straightening, centre the bbox
    k = LENGTH / (V[:, 1].max() - V[:, 1].min()); V *= k
    mn, mx = V.min(0), V.max(0); V -= (mn + mx) / 2
    hi.data.vertices.foreach_set('co', V.ravel())
    hi.data.update()
    print('FINAL bbox (Blender x,y,z)', tuple(float(x) for x in np.round(V.max(0) - V.min(0), 4)))

    # ---- high-poly material -> pure emission of the source texture (for the colour bake)
    FLAT = tuple(map(float, F['color'].split(','))) if 'color' in F else None
    src_img = None
    for m in hi.data.materials:
        if m and m.node_tree:
            for n in m.node_tree.nodes:
                if n.type == 'TEX_IMAGE' and n.image and (src_img is None or n.image.size[0] > src_img.size[0]):
                    src_img = n.image
    has_uv = len(hi.data.uv_layers) > 0
    if FLAT is None and (src_img is None or not has_uv):
        col = (0.2, 0.2, 0.2)
        for m in hi.data.materials:
            b = m and m.node_tree and next((n for n in m.node_tree.nodes if n.type == 'BSDF_PRINCIPLED'), None)
            if b: col = tuple(b.inputs['Base Color'].default_value)[:3]; break
        FLAT = col
    print('source texture', src_img and (src_img.name, tuple(src_img.size)), 'flat colour', FLAT)
    hm = bpy.data.materials.new('src_emit'); nt = hm.node_tree; nt.nodes.clear()
    em = nt.nodes.new('ShaderNodeEmission'); oo = nt.nodes.new('ShaderNodeOutputMaterial')
    nt.links.new(em.outputs[0], oo.inputs[0])
    if FLAT is None:
        ti = nt.nodes.new('ShaderNodeTexImage'); ti.image = src_img
        nt.links.new(ti.outputs['Color'], em.inputs['Color'])
    hi.data.materials.clear(); hi.data.materials.append(hm)

    # ---- low-poly: decimate, smooth, new UVs
    lo = hi.copy(); lo.data = hi.data.copy(); lo.name = NAME; lo.data.name = NAME
    sc.collection.objects.link(lo)
    lo.data.calc_loop_triangles(); tris_hi = len(lo.data.loop_triangles)
    bpy.ops.object.select_all(action='DESELECT'); lo.select_set(True); bpy.context.view_layer.objects.active = lo
    if tris_hi > MAX_TRIS:
        d = lo.modifiers.new('dec', 'DECIMATE'); d.ratio = MAX_TRIS / tris_hi * 0.985
        bpy.ops.object.modifier_apply(modifier='dec')
    if not lo.data.uv_layers: lo.data.uv_layers.new(name='UVMap')   # smart_project needs an existing layer
    bpy.ops.object.mode_set(mode='EDIT'); bpy.ops.mesh.select_all(action='SELECT')
    bpy.ops.mesh.remove_doubles(threshold=LENGTH * 1e-5)
    bpy.ops.mesh.delete_loose()
    bpy.ops.mesh.select_all(action='SELECT')      # delete_loose / remove_doubles can leave nothing selected
    bpy.ops.mesh.quads_convert_to_tris()
    bpy.ops.mesh.normals_make_consistent(inside=False)
    bpy.ops.uv.smart_project(angle_limit=math.radians(60), island_margin=0.004, area_weight=0.0, scale_to_bounds=False)
    bpy.ops.object.mode_set(mode='OBJECT')
    for u in [u.name for u in lo.data.uv_layers if u != lo.data.uv_layers.active]:
        lo.data.uv_layers.remove(lo.data.uv_layers[u])
    lo.data.uv_layers[0].name = 'UVMap'
    lo.data.uv_layers.active = lo.data.uv_layers[0]
    uvs = np.array([d.uv for d in lo.data.uv_layers[0].data])
    print('UV islands check: unique uv', len(np.unique(uvs.round(5), axis=0)), 'of', len(uvs))
    try:
        bpy.ops.mesh.customdata_custom_splitnormals_clear()
    except Exception as e:
        print('no custom normals', e)
    bpy.ops.object.shade_smooth()
    lo.data.calc_loop_triangles(); TRIS = len(lo.data.loop_triangles)
    print('TRIS', tris_hi, '->', TRIS)
    assert TRIS <= MAX_TRIS

    # ---- bakes (Cycles CPU)
    sc.render.engine = 'CYCLES'; sc.cycles.device = 'CPU'
    sc.cycles.samples = 1; sc.cycles.use_denoising = False
    sc.render.bake.margin = 8
    def new_img(name, size, color):
        im = bpy.data.images.new(name, size, size, alpha=False)
        im.colorspace_settings.name = 'sRGB' if color else 'Non-Color'
        return im
    lm = bpy.data.materials.new(NAME + '_skin'); lo.data.materials.clear(); lo.data.materials.append(lm)
    nt = lm.node_tree
    bake_node = nt.nodes.new('ShaderNodeTexImage')
    def bake(kind, img, selected_to_active):
        bake_node.image = img; nt.nodes.active = bake_node
        bpy.ops.object.select_all(action='DESELECT')
        if selected_to_active: hi.select_set(True)
        lo.select_set(True); bpy.context.view_layer.objects.active = lo
        sc.render.bake.use_selected_to_active = selected_to_active
        sc.render.bake.cage_extrusion = LENGTH * 0.0012   # thin fins / legs: larger values hit the far side
        sc.render.bake.max_ray_distance = LENGTH * 0.004
        bpy.ops.object.bake(type=kind, normal_space='TANGENT', use_clear=True, margin=8)
        print('baked', kind, img.name)

    base = None
    if FLAT is None:
        base = new_img(NAME + '_basecolor', TEX_BASE, True); bake('EMIT', base, True)
    nrm = new_img(NAME + '_normal', TEX_AUX, False); bake('NORMAL', nrm, True)
    # clamp tangent-space normals to <= ~70 deg (thin fins / legs: rays hitting the far surface give inverted normals)
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
    ao = new_img(NAME + '_ao', TEX_AUX, False)
    sc.world = bpy.data.worlds.new('w')
    bake('AO', ao, False)
    bpy.data.objects.remove(hi)

    # ---- ORM: R = AO (softened), G = roughness from luminance (darker patches rougher), B = 0
    def px(img, w):
        n = img.size[0]
        a = np.array(img.pixels[:], dtype=np.float32).reshape(n, n, 4)
        f = n // w
        return a.reshape(w, f, w, f, 4).mean((1, 3)) if f > 1 else a
    aov = 0.35 + 0.65 * px(ao, TEX_AUX)[..., 0]
    if base is not None:
        b = px(base, TEX_AUX); lum = 0.2126 * b[..., 0] + 0.7152 * b[..., 1] + 0.0722 * b[..., 2]
        cov = lum > 0.01
        lo5, hi95 = np.percentile(lum[cov], 5), np.percentile(lum[cov], 95)
        ln = np.clip((lum - lo5) / max(1e-4, hi95 - lo5), 0, 1)
        rough = RHI - (RHI - RLO) * ln
    else:
        cov = np.ones_like(aov, bool)
        rough = RLO + (RHI - RLO) * (1 - px(ao, TEX_AUX)[..., 0])   # crevices a little rougher
    orm = np.stack([aov, rough, np.zeros_like(rough), np.ones_like(rough)], -1)
    ormimg = new_img(NAME + '_orm', TEX_AUX, False)
    ormimg.pixels[:] = orm.ravel()
    print('ROUGH range', float(rough[cov].min()), float(rough[cov].max()), 'mean', float(rough[cov].mean()))
    for im in [i for i in (base, nrm, ormimg) if i]:
        im.file_format = 'PNG'; im.pack()
    bpy.data.images.remove(ao)

    # ---- final metallic-roughness material
    nt.nodes.clear()
    out = nt.nodes.new('ShaderNodeOutputMaterial'); bsdf = nt.nodes.new('ShaderNodeBsdfPrincipled')
    nt.links.new(bsdf.outputs[0], out.inputs[0])
    if base is not None:
        tb = nt.nodes.new('ShaderNodeTexImage'); tb.image = base
        nt.links.new(tb.outputs['Color'], bsdf.inputs['Base Color'])
    else:
        bsdf.inputs['Base Color'].default_value = (*FLAT, 1)
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
    lm.use_backface_culling = False     # fins / appendages are single-sheet surfaces
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
    print('EXPORTED', OUT, 'tris', TRIS)


# ---- optional preview sheet: Cycles CPU, 4 panels of 640x360 (side, 3/4 front, top, clay side)
def look(cam, f, u):
    f = mathutils.Vector(f).normalized(); u = mathutils.Vector(u); z = -f
    x = u.cross(z).normalized(); y = z.cross(x)
    cam.matrix_world = mathutils.Matrix((x, y, z)).transposed().to_4x4()

def preview(PV):
    assert os.path.isabs(PV), 'preview path must be absolute'
    lo = next(o for o in bpy.data.objects if o.type == 'MESH')
    mat = lo.data.materials[0]; nt = mat.node_tree
    bsdf = next(n for n in nt.nodes if n.type == 'BSDF_PRINCIPLED')
    sc.render.engine = 'CYCLES'; sc.cycles.device = 'CPU'
    sc.cycles.samples = 24; sc.cycles.use_denoising = False
    sc.render.resolution_x, sc.render.resolution_y = 640, 360; sc.render.resolution_percentage = 100
    sc.render.film_transparent = False
    if sc.world is None: sc.world = bpy.data.worlds.new('w')
    w = sc.world; w.use_nodes = True
    bg = next(n for n in w.node_tree.nodes if n.type == 'BACKGROUND')
    bg.inputs[0].default_value = (0.05, 0.06, 0.07, 1); bg.inputs[1].default_value = 1.0
    for nm_, d, en in (('key', (-0.5, 0.3, -1.0), 4.0), ('fill', (0.8, -0.6, -0.3), 1.2)):
        L = bpy.data.lights.new(nm_, 'SUN'); L.energy = en
        ob = bpy.data.objects.new(nm_, L); sc.collection.objects.link(ob); look(ob, d, (0, 0, 1) if abs(d[2]) < 0.9 else (0, 1, 0))
    V = np.array([lo.matrix_world @ v.co for v in lo.data.vertices]); e = V.max(0) - V.min(0)
    cam = bpy.data.objects.new('cam', bpy.data.cameras.new('cam')); sc.collection.objects.link(cam); sc.camera = cam
    cam.data.type = 'ORTHO'; cam.data.clip_end = LENGTH * 20
    views = [('side', (-1, 0, 0), (0, 0, 1), max(e[1], e[2] * 16 / 9) * 1.1),
             ('front34', (-0.7, 0.6, -0.35), (0, 0, 1), max(e) * 1.05),
             ('top', (0, 0, -1), (1, 0, 0), max(e[1], e[0] * 16 / 9) * 1.1),
             ('clay', (-1, 0, 0), (0, 0, 1), max(e[1], e[2] * 16 / 9) * 1.1)]
    tiles = []
    tmp = os.path.splitext(PV)[0] + '_tmp.png'
    for name, f, u, scale in views:
        if name == 'clay':
            for l in [l for l in nt.links if l.to_socket == bsdf.inputs['Base Color']]: nt.links.remove(l)
            bsdf.inputs['Base Color'].default_value = (0.55, 0.55, 0.55, 1)
        look(cam, f, u); cam.location = -mathutils.Vector(f).normalized() * LENGTH * 4
        cam.data.ortho_scale = scale
        sc.render.filepath = tmp
        bpy.ops.render.render(write_still=True)
        im = bpy.data.images.load(tmp); a = np.array(im.pixels[:], dtype=np.float32).reshape(360, 640, 4)
        tiles.append(a.copy()); bpy.data.images.remove(im)
    sheet = np.concatenate([np.concatenate(tiles[2:4], 1), np.concatenate(tiles[0:2], 1)], 0)   # rows bottom-up
    out_img = bpy.data.images.new('sheet', 1280, 720, alpha=False)
    out_img.pixels[:] = sheet.ravel(); out_img.filepath_raw = PV; out_img.file_format = 'PNG'; out_img.save()
    os.remove(tmp)
    print('PREVIEW', PV)

if not PREVIEW_ONLY:
    build()
if F.get('preview'):
    preview(F['preview'])
