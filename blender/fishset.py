# Fish-set variant of deepsharks.py / deepspecies.py (assets/models/raw13). Builder for small-budget school fish and single
# deep-sea animals from CC-BY / CC0 scans and sculpts (Objaverse mirror of Sketchfab). Blender 5.2, CPU only (Cycles CPU bakes /
# previews, Workbench probe renders).
# Usage:
#   blender --background --factory-startup --python fishset.py -- <src.glb> <out.glb> <length_m> [flags]
#   (Windows Blender from WSL: pass Windows paths, e.g. $(wslpath -w ...); output / preview / probe paths must be absolute)
# Flags (source axes are Blender world axes after glTF import, i.e. glTF +Y up = Blender +Z):
#   --fwd=+x|-x|+y|-y|+z|-z   head direction in the source (default: long axis, thicker end = head)
#   --up=+x|...               dorsal direction in the source (default: remaining axis with the larger mid-body extent, +)
#   --roll=deg                extra roll about the body axis after orienting (fix a tilted specimen; + = dorsal toward +X)
#   --straighten              remove the specimen's lateral bend (cubic centre-line fit, fish scans lying on their side)
#   --tris=N                  triangle budget of the output mesh (default 25000)
#   --base=N                  base-colour texture size (default 1024)
#   --aux=N                   normal / ORM texture size (default 1024)
#   --color=r,g,b             flat linear base colour (used when the source has no texture; overrides the bake)
#   --rough=lo,hi             roughness range mapped from texture luminance (default 0.5,0.75)
#   --debris=f                drop loose parts smaller than f * vertex count (default 0.002)
#   --keep-small              keep separate mesh objects with < 100 faces (default: removed - helper cubes / colour checkers)
#   --keep-mats               keep mesh objects of every material (multi-atlas scans, eyes); each material bakes its own colour
#   --drop-mats=a,b           drop mesh parts whose material name contains any of these substrings
#   --debruise                desaturate reddish post-mortem bruising in the baked base colour (towards the local skin tone)
#   --jaw=hz,hy,tz,ty,deg     close an open mouth: in the final glTF frame (metres, head +Z, up +Y), every vertex in front
#                             of the hinge (z > hz) and below the line hinge (hz,hy) -> lower-lip point (tz,ty) is rotated
#                             by deg about the X axis through the hinge (positive = lower jaw up); applied to the
#                             full-resolution source before decimating and baking. May be given several times as --jaw2=..
#   --silver=lo,hi[,metal,rough]  silver/mirror scales: texels with luminance above lo..hi (smoothstep) and low
#                             saturation get metallic up to <metal> (default 0.7) and roughness <rough> (default 0.28)
#   --cage=f --ray=f          bake cage extrusion / max ray distance as fractions of the length (defaults 0.0012 / 0.004;
#                             hard-decimated meshes need larger values)
#   --grade=sat,gain          scale the baked base colour's saturation / brightness (painted sources)
#   --samples=N               preview Cycles samples (default 24)
#   --preview=<png>           also render a 2x2 Cycles-CPU preview sheet (4 x 640x360 panels: side, 3/4 front, top, clay side)
#   --probe=<png>             stop after orienting/scaling and render a Workbench side close-up of the head (front 30 %)
#                             for choosing --jaw parameters; prints the pixel -> metre mapping
#   --preview-only            re-render the preview of an existing <out.glb> (src ignored)
# Steps: drop helper cubes / colour checkers, apply armature poses (rigged sources), join parts, bake all transforms,
#   metres at the real species length, head -> glTF +Z, up -> glTF +Y (left side = +X), bbox centred at the origin,
#   weld seams, remove floating scan debris, optional straightening, optional jaw closing, decimate to the budget, new UVs,
#   smooth normals; bakes from the full-resolution source with Cycles on the CPU (GPU reserved for the running WebGPU game):
#   base colour (emission of the source texture), tangent-space normal map, ambient occlusion;
#   metallic-roughness material (ORM: R = AO, G = roughness, B = metallic), double-sided.
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

def probe(hi, V, path):
    # Workbench side close-up of the front 30 % (glTF z from zmax-0.3L to zmax), right flank, head to the right
    assert os.path.isabs(path)
    sc.render.engine = 'BLENDER_WORKBENCH'
    sh = sc.display.shading; sh.light = 'STUDIO'; sh.color_type = 'TEXTURE'
    W_, H_ = 1200, 800
    sc.render.resolution_x, sc.render.resolution_y = W_, H_; sc.render.resolution_percentage = 100
    cam = bpy.data.objects.new('pc', bpy.data.cameras.new('pc')); sc.collection.objects.link(cam); sc.camera = cam
    cam.data.type = 'ORTHO'; cam.data.clip_start = LENGTH * 1e-4; cam.data.clip_end = LENGTH * 10
    frac = float(F.get('probe-frac', 0.3))
    span = LENGTH * frac                              # horizontal extent in metres
    zmax = float(-V[:, 1].min()); zc = zmax - span / 2
    cam.data.ortho_scale = span
    # camera on -X (right flank) looking toward +X; screen right = glTF +Z (head) = Blender -Y, screen up = Blender +Z
    x = mathutils.Vector((0, -1, 0)); y = mathutils.Vector((0, 0, 1)); z = x.cross(y)
    cam.matrix_world = mathutils.Matrix((x, y, z)).transposed().to_4x4()
    cam.location = (-LENGTH * 3, -zc, 0)
    sc.render.filepath = path
    bpy.ops.render.render(write_still=True)
    mpp = span / W_
    print('PROBE', path, 'pixel (u,v) -> glTF z = %.5f + u*%.6f ; y = %.5f - v*%.6f' % (zc - span / 2, mpp, (H_ / 2) * mpp, mpp))
    print('PROBE zmax', zmax, 'ymin', float(V[:, 2].min()), 'ymax', float(V[:, 2].max()))

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
        dropm = [d for d in F.get('drop-mats', '').split(',') if d]
        if (not F.get('keep-small') and len(o.data.polygons) < 100) or (mats and dom not in mats and not F.get('keep-mats')) \
                or any(d in m for d in dropm for m in mats):
            print('drop object', o.name, len(o.data.polygons), mats)
            bpy.data.objects.remove(o)
        else:
            keep.append(o)
    dg = bpy.context.evaluated_depsgraph_get()
    for o in keep:                     # rigged sources: freeze the evaluated (posed) mesh, drop the armature modifier
        if o.modifiers:
            me = bpy.data.meshes.new_from_object(o.evaluated_get(dg), preserve_all_data_layers=True, depsgraph=dg)
            o.modifiers.clear(); o.data = me
            print('applied modifiers on', o.name)
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
    if 'roll' in F:
        hi.data.transform(mathutils.Matrix.Rotation(math.radians(float(F['roll'])), 4, 'Y'))
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
    # ---- optional jaw closing (glTF frame: z = -Blender y, y = Blender z)
    for key in [k_ for k_ in F if k_.startswith('jaw')]:
        hz, hy, tz, ty, deg = map(float, F[key].split(','))
        gz, gy = -V[:, 1], V[:, 2]
        line = hy + (ty - hy) * (gz - hz) / (tz - hz)
        sel = (gz > hz) & (gy < line)
        a = math.radians(deg)
        dz, dy = gz[sel] - hz, gy[sel] - hy
        # rotate about the X axis through the hinge: positive angle turns the jaw tip (+z) upward (+y)
        nz = hz + dz * math.cos(a) - dy * math.sin(a)
        ny = hy + dz * math.sin(a) + dy * math.cos(a)
        V[sel, 1] = -nz; V[sel, 2] = ny
        print('jaw', key, 'rotated verts', int(sel.sum()), 'deg', deg)
        k = LENGTH / (V[:, 1].max() - V[:, 1].min()); V *= k
        mn, mx = V.min(0), V.max(0); V -= (mn + mx) / 2
    hi.data.vertices.foreach_set('co', V.ravel())
    hi.data.update()
    if 'probe' in F:
        probe(hi, V, F['probe']); return
    print('FINAL bbox (Blender x,y,z)', tuple(float(x) for x in np.round(V.max(0) - V.min(0), 4)))

    # ---- high-poly materials -> pure emission of each material's own base colour (texture x factor, or flat)
    FLAT = tuple(map(float, F['color'].split(','))) if 'color' in F else None
    has_uv = len(hi.data.uv_layers) > 0
    any_tex = False
    for m in hi.data.materials:
        if not (m and m.node_tree): continue
        nt = m.node_tree
        b = next((n for n in nt.nodes if n.type == 'BSDF_PRINCIPLED'), None)
        tex = next((n for n in nt.nodes if n.type == 'TEX_IMAGE' and n.image), None)
        src_sock, col = None, (0.2, 0.2, 0.2)
        if b and b.inputs['Base Color'].is_linked:
            src_sock = b.inputs['Base Color'].links[0].from_socket
        elif tex is not None:
            src_sock = tex.outputs['Color']
        elif b:
            col = tuple(b.inputs['Base Color'].default_value)[:3]
        if FLAT is not None or not has_uv: src_sock = None
        if src_sock is not None: any_tex = True
        em = nt.nodes.new('ShaderNodeEmission'); oo = nt.nodes.new('ShaderNodeOutputMaterial')
        for n in nt.nodes:
            if n.type == 'OUTPUT_MATERIAL' and n != oo: n.is_active_output = False
        oo.is_active_output = True
        nt.links.new(em.outputs[0], oo.inputs[0])
        if src_sock is not None: nt.links.new(src_sock, em.inputs['Color'])
        else: em.inputs['Color'].default_value = (*(FLAT or col), 1)
        print('material', m.name, 'emission from', src_sock and src_sock.node.name, 'flat', None if src_sock else (FLAT or col))
    if FLAT is None and not any_tex:
        FLAT = (0.2, 0.2, 0.2)
    print('flat colour', FLAT)

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
    bpy.ops.uv.smart_project(angle_limit=math.radians(60), island_margin=4.0 / min(TEX_BASE, TEX_AUX), area_weight=0.0, scale_to_bounds=False)
    bpy.ops.mesh.select_all(action='SELECT')
    try:   # tighter packing (smart_project leaves up to a third of the square empty on long fish islands)
        bpy.ops.uv.pack_islands(udim_source='CLOSEST_UDIM', rotate=True, rotate_method='ANY', scale=True, merge_overlap=False,
                                margin_method='FRACTION', margin=4.0 / min(TEX_BASE, TEX_AUX), shape_method='CONCAVE')
    except Exception as e:
        print('pack_islands failed', e)
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
    SENT = np.array([1.0, 0.0, 1.0, 1.0], np.float32)     # sentinel colour: texels no bake ray wrote
    def bake_once(kind, img, selected_to_active, cage, ray, clear=True):
        bake_node.image = img; nt.nodes.active = bake_node
        bpy.ops.object.select_all(action='DESELECT')
        if selected_to_active: hi.select_set(True)
        lo.select_set(True); bpy.context.view_layer.objects.active = lo
        sc.render.bake.use_selected_to_active = selected_to_active
        sc.render.bake.cage_extrusion = LENGTH * cage     # thin fins: larger values hit the far side
        sc.render.bake.max_ray_distance = LENGTH * ray
        bpy.ops.object.bake(type=kind, normal_space='TANGENT', use_clear=clear, margin=0 if not clear else 8)
    def bake(kind, img, selected_to_active):
        cage, ray = float(F.get('cage', 0.0012)), float(F.get('ray', 0.004))
        if not selected_to_active:
            bake_once(kind, img, False, cage, ray); print('baked', kind, img.name); return
        # pass 1 with the requested cage / ray into a sentinel-filled image (no clear, no margin), pass 2 with a 4x ray
        # for the texels pass 1 missed (fin tips / decimated edges outside the source surface), then flood the
        # remaining holes and the island margins from valid neighbours
        n_ = img.size[0]
        img.pixels[:] = np.tile(SENT, n_ * n_)
        bake_once(kind, img, True, cage, ray, clear=False)
        a = np.array(img.pixels[:], np.float32).reshape(n_, n_, 4)
        miss = np.all(np.abs(a - SENT) < 1e-3, -1)
        m1 = int(miss.sum())
        tmp = bpy.data.images.new('tmp_' + img.name, n_, n_, alpha=False)
        tmp.colorspace_settings.name = img.colorspace_settings.name
        tmp.pixels[:] = np.tile(SENT, n_ * n_)
        bake_once(kind, tmp, True, cage * 2, ray * 4, clear=False)
        b2 = np.array(tmp.pixels[:], np.float32).reshape(n_, n_, 4); bpy.data.images.remove(tmp)
        ok2 = ~np.all(np.abs(b2 - SENT) < 1e-3, -1)
        fill = miss & ok2
        a[fill] = b2[fill]; miss &= ~fill
        # flood fill (dilation) of everything still unwritten: islands' missed texels + outside-island margin
        for it in range(24):
            if not miss.any(): break
            acc = np.zeros_like(a[..., :3]); cnt = np.zeros(miss.shape, np.float32)
            for dy, dx in ((1, 0), (-1, 0), (0, 1), (0, -1), (1, 1), (-1, -1), (1, -1), (-1, 1)):
                sh = np.roll(np.roll(a[..., :3], dy, 0), dx, 1); ok = np.roll(np.roll(~miss, dy, 0), dx, 1)
                acc += sh * ok[..., None]; cnt += ok
            grow = miss & (cnt > 0)
            a[grow, :3] = acc[grow] / cnt[grow, None]; a[grow, 3] = 1
            miss &= ~grow
        if miss.any():
            a[miss, :3] = a[~miss, :3].mean(0)
        img.pixels[:] = a.ravel()
        print('baked', kind, img.name, 'pass1 unwritten', m1, 'filled by pass2', int(fill.sum()), 'of', n_ * n_)

    base = None
    if FLAT is None:
        base = new_img(NAME + '_basecolor', TEX_BASE, True); bake('EMIT', base, True)
        if F.get('debruise'):
            n_ = base.size[0]
            a = np.array(base.pixels[:], dtype=np.float32).reshape(n_, n_, 4)
            r, g, bl = a[..., 0], a[..., 1], a[..., 2]
            red = np.clip(((r - np.maximum(g, bl)) - 0.04) / 0.10, 0, 1)      # redness weight 0..1
            gb = (g + bl) / 2
            tone = np.stack([gb * 1.06, g * 1.0 + (gb - g) * 0.3, bl], -1)       # skin tone: grey-brown without the red cast
            tone[..., 0] = np.maximum(tone[..., 0], gb)
            a[..., :3] = a[..., :3] * (1 - red[..., None]) + tone * red[..., None]
            base.pixels[:] = a.ravel()
            print('debruised texels', int((red > 0.5).sum()), 'of', n_ * n_)
    if F.get('grade') and base is not None:      # --grade=sat,gain: desaturate / darken the baked colour (painted sources)
        gs, gg = map(float, F['grade'].split(','))
        n_ = base.size[0]; a_ = np.array(base.pixels[:], np.float32).reshape(n_, n_, 4)
        l_ = (0.2126 * a_[..., 0] + 0.7152 * a_[..., 1] + 0.0722 * a_[..., 2])[..., None]
        a_[..., :3] = np.clip((l_ + (a_[..., :3] - l_) * gs) * gg, 0, 1)
        base.pixels[:] = a_.ravel(); print('graded base colour sat', gs, 'gain', gg)
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
    metal = np.zeros_like(rough)
    if 'silver' in F and base is not None:
        sv = list(map(float, F['silver'].split(','))) + [0.7, 0.28][len(F['silver'].split(',')) - 2:]
        slo, shi, smet, srgh = sv[:4]
        mxc = b[..., :3].max(-1); mnc = b[..., :3].min(-1)
        sat = (mxc - mnc) / np.maximum(mxc, 1e-4)
        t = np.clip((lum - slo) / max(1e-4, shi - slo), 0, 1); w = t * t * (3 - 2 * t)
        w *= 1 - np.clip((sat - 0.12) / 0.2, 0, 1)                      # coloured (yellow fins, olive back) stays dielectric
        metal = smet * w
        rough = rough * (1 - w) + srgh * w
        print('SILVER texels (w>0.5)', int((w[cov] > 0.5).sum()), 'of', int(cov.sum()), 'metal mean', float(metal[cov].mean()))
    orm = np.stack([aov, rough, metal, np.ones_like(rough)], -1)
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
    if 'silver' in F and base is not None:
        nt.links.new(sep.outputs['Blue'], bsdf.inputs['Metallic'])
    else:
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

    # decimation moves the silhouette a little: re-centre the low-poly bbox and scale it to the exact length
    VL = np.array([v.co for v in lo.data.vertices]); mnl, mxl = VL.min(0), VL.max(0)
    kl = LENGTH / (mxl[1] - mnl[1]); VL = (VL - (mnl + mxl) / 2) * kl
    lo.data.vertices.foreach_set('co', VL.ravel()); lo.data.update()
    print('LOWPOLY recentred, scale', float(kl), 'final extent (x, len, h)', tuple(float(x) for x in np.round(VL.max(0) - VL.min(0), 4)))
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
    sc.cycles.samples = int(F.get('samples', 24)); sc.cycles.use_denoising = False
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
