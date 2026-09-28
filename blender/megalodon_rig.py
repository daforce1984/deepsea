# Rig + animate assets/models/raw11/megalodon.glb ("Megalodon" by phonlaphat, CC-BY 4.0, modified) -> megalodon_rigged.glb
# Usage (absolute paths only):
#   blender --background --factory-startup --python megalodon_rig.py -- <megalodon.glb> <megalodon_rigged.glb> [--preview=<png>]
#   blender --background --factory-startup --python megalodon_rig.py -- <any> <megalodon_rigged.glb> --preview=<png> --preview-only
# What it does
# - merges the glTF UV-seam vertex splits, clears custom normals (smooth shading)
# - source: head at glTF -Z (Blender +Y). Output: rotated 180 deg about up -> head at glTF +Z (Blender -Y), up +Y,
#   bbox centred, 20 m long (x1.25)
# - the sculpt has a real mouth pocket (palate + floor, closed fold at the back) but no teeth: the lip margins are found
#   by horizontal ray casts through the gape, and a row of serrated triangular teeth is modelled along the upper and lower
#   margins (~8 cm tall at the front, smaller toward the corners), material 'megalodon_teeth' (roughness 0.25)
# - mouth pocket faces (red texels) -> material 'megalodon_mouth' (same texture, dark red-pink tint); two cheek membranes
#   (skinned head->jaw) close the lateral gape so the open mouth never shows through the head
# - armature: root, head, spine_01..04, tail_01, caudal_fin, jaw, upper_jaw, pectoral_{L,R}_{root,mid}
#   automatic weights for the spine chain, then jaw / upper jaw / pectoral / teeth / membrane weights set explicitly
# - clips "Swim" and "Gape": 77 frames @ 24 fps (3.208 s), exact loops, identical body motion (seamless switching)
import bpy, bmesh, sys, os, math, numpy as np, mathutils
from mathutils import Vector, Matrix, Quaternion
from mathutils.bvhtree import BVHTree

argv = sys.argv[sys.argv.index('--') + 1:]
POS = [a for a in argv if not a.startswith('--')]
F = dict((a[2:].split('=', 1) + ['1'])[:2] for a in argv if a.startswith('--'))
SRC, OUT = POS[0], POS[1]
assert os.path.isabs(OUT) or OUT[1:3] == ':\\', 'output path must be absolute'
LENGTH = 20.0
NF = 77                       # loop length in frames (3.208 s @ 24 fps)
TOOTH_H = 0.08                # front tooth height (m, final scale)
INSET = 0.03                  # tooth row behind the lip edge (source m)

sc = bpy.context.scene


def smooth(e0, e1, x):
    t = np.clip((np.asarray(x, dtype=np.float64) - e0) / (e1 - e0), 0.0, 1.0)
    return t * t * (3 - 2 * t)


# ---------------------------------------------------------------------------------------------------------------------
# weight regions, all in SOURCE coordinates (Blender: head +Y, snout y=+8, up +Z, source length 16 m)
HINGE_Y, HINGE_Z = 4.9, -1.12
PEC_ROOT = np.array([1.60, 2.60, -1.50]); PEC_TIP = np.array([4.02, 1.49, -2.52])


def gape_z(x, y):
    """z of the parting surface between upper and lower jaw (source coords)."""
    fx = np.clip(np.abs(x) / 0.9, 0, 1)
    zfront = -1.15 - 0.17 * (1 - fx * fx)
    b = np.clip((y - 4.6) / 0.8, 0, 1)
    return -1.12 + (zfront + 1.12) * b


def jaw_w(P):
    x, y, z = P[:, 0], P[:, 1], P[:, 2]
    zg = gape_z(x, y)
    hw = 0.03 + 0.15 * smooth(5.8, 5.0, y)             # sharp split at the lips, soft near the corners / hinge
    below = smooth(zg + hw, zg - hw, z)
    return below * smooth(HINGE_Y - 0.7, HINGE_Y + 0.2, y)


def upper_jaw_w(P):
    x, y, z = P[:, 0], P[:, 1], P[:, 2]
    above = 1 - smooth(gape_z(x, y) + 0.03, gape_z(x, y) - 0.03, z)
    return 0.8 * smooth(6.2, 6.75, y) * smooth(-0.6, -0.9, z) * smooth(0.95, 0.6, np.abs(x)) * above


def pec_w(P, side):
    """side +1: source +x fin.  returns (w_root, w_mid)"""
    r = PEC_ROOT * np.array([side, 1, 1]); t = PEC_TIP * np.array([side, 1, 1])
    d = t - r; L = np.linalg.norm(d); d /= L
    s = (P - r) @ d
    region = (np.sign(P[:, 0]) == side) & (P[:, 1] > 0.2) & (P[:, 1] < 4.3) & (P[:, 2] < -0.9)
    w = smooth(0.0, 0.5, s) * region
    m = smooth(0.35, 0.6, s / L)
    return w * (1 - m), w * m


# ---------------------------------------------------------------------------------------------------------------------
def build():
    bpy.ops.wm.read_factory_settings(use_empty=True)
    sc = bpy.context.scene
    sc.render.fps = 24
    bpy.ops.import_scene.gltf(filepath=SRC)
    body = next(o for o in bpy.data.objects if o.type == 'MESH')
    for o in list(bpy.data.objects):
        if o != body: bpy.data.objects.remove(o)
    body.data.transform(body.matrix_world); body.matrix_world = Matrix()
    me = body.data
    skin_old = me.materials[0]; skin_old.name = '_old_skin'
    me.materials.append(bpy.data.materials.new('_ph1')); me.materials.append(bpy.data.materials.new('_ph2'))
    base_img = bpy.data.images['megalodon_basecolor']
    nrm_img = bpy.data.images['megalodon_normal']
    orm_old = bpy.data.images['megalodon_orm']

    # ---- merge seam splits, classify mouth pocket faces by their (red) texels
    bm = bmesh.new(); bm.from_mesh(me)
    n0 = len(bm.verts)
    bmesh.ops.remove_doubles(bm, verts=bm.verts, dist=1e-4)
    print('merged verts', n0, '->', len(bm.verts))
    V = np.array([v.co[:] for v in bm.verts])
    mn, mx = V.min(0), V.max(0)
    ctr = (mn + mx) / 2
    L0 = mx[1] - mn[1]
    S = LENGTH / L0
    print('source length', L0, 'scale', S, 'centre', ctr)
    W, H = base_img.size
    px = np.array(base_img.pixels[:], dtype=np.float32).reshape(H, W, 4)
    uvl = bm.loops.layers.uv.active
    nmouth = 0
    for f in bm.faces:
        u = np.mean([l[uvl].uv for l in f.loops], 0)
        col = px[min(H - 1, int(u[1] * H)), min(W - 1, int(u[0] * W))]
        c = f.calc_center_median()
        if col[0] > 0.12 and col[0] > col[1] * 1.5 and c.y > 4.3 and abs(c.x) < 1.25 and -1.75 < c.z < -0.8:
            f.material_index = 1; nmouth += 1
        else:
            f.material_index = 0
    print('mouth faces', nmouth)
    bm.to_mesh(me); me.update()
    bvh = BVHTree.FromBMesh(bm)

    # ---- lip margins by horizontal ray casts through the gape, fanned about the mouth centre C
    C = Vector((0.0, 4.7))

    def scan(th):
        # rays from outside the head toward C: lips stop them near the rim, rays through the gape go deep
        d = Vector((math.sin(th), math.cos(th), 0.0))
        o0 = Vector((C.x + 5.0 * d.x, C.y + 5.0 * d.y, 0.0))
        zs = np.arange(-1.80, -0.85, 0.004)
        hits = [bvh.ray_cast(Vector((o0.x, o0.y, z)), -d, 6.0)[0] for z in zs]
        rr = np.array([(Vector((h.x, h.y)) - C).length if h is not None else 0.0 for h in hits])
        # upper lip margin: first big drop of the hit radius scanning downward (rays below it pass into the pocket)
        iu = None
        for i in range(len(zs) - 2, 0, -1):
            if rr[i] < rr[i + 1] - 0.4: iu = i + 1; break
        if iu is None: return None
        rlow = rr[:iu].max()
        il = max(j for j in range(iu) if rr[j] >= rlow - 0.12)
        pu, pl = hits[iu], hits[il]
        if pu is None or pl is None: return None
        return dict(th=th, d=d, zu=zs[iu], zl=zs[il], gap=zs[iu] - zs[il], pu=pu, pl=pl)

    rims = {}
    for deg in range(-80, 81):
        r = scan(math.radians(deg))
        if r and r['gap'] > 0.03: rims[deg] = r
    # keep the contiguous run through 0
    keep = [0]
    for sgn in (1, -1):
        k = sgn
        while k in rims: keep.append(k); k += sgn
    rims = {k: rims[k] for k in sorted(keep) if k in rims}
    degs = sorted(rims)
    print('gape open from %d to %d deg; front gap %.3f m (source)' % (degs[0], degs[-1], rims[0]['gap']))
    for k in degs[::8]:
        r = rims[k]; print('  th %3d gap %.3f upper %s lower %s' % (k, r['gap'], tuple(round(c, 3) for c in r['pu']), tuple(round(c, 3) for c in r['pl'])))

    # ---- teeth
    tb = bmesh.new()
    tooth_w = []                                # per tooth vertex: (is_lower, root point)
    H0 = TOOTH_H / S

    def polyline(key, side):
        ks = [k for k in degs if k * side >= 0]
        ks.sort(key=lambda k: abs(k))
        P = np.array([rims[k][key][:] for k in ks]); G = np.array([rims[k]['gap'] for k in ks])
        seg = np.linalg.norm(np.diff(P, axis=0), axis=1)
        return P, G, np.concatenate([[0], np.cumsum(seg)])

    def tooth(root, T, N, lower, h, w, frac):
        V0 = Vector((0, 0, 1)) if lower else Vector((0, 0, -1))
        distal = (0.05 + 0.2 * frac) if lower else (0.1 + 0.35 * frac)
        v = (V0 + N * (-0.22) + T * distal).normalized()
        u = (T - T.dot(v) * v).normalized()
        n = u.cross(v).normalized()
        if n.dot(N) < 0: n = -n
        Ht = h * 1.3                                  # 0.3 h buried in the gum
        base = root - V0 * (0.3 * h) + N * 0.004
        K = 5
        outline = [(-w / 2, 0.0), (w / 2, 0.0)]
        def edge(a, b, sgn):
            pts = []
            ex, ey = b[0] - a[0], b[1] - a[1]; el = math.hypot(ex, ey)
            nx, ny = ey / el * sgn, -ex / el * sgn          # outward in the blade plane
            for k in range(1, 2 * K):
                t = k / (2 * K)
                off = 0.05 * w * math.sin(math.pi * t) + (0.022 * Ht if k % 2 else -0.004 * Ht) * (0.3 + t)
                pts.append((a[0] + ex * t + nx * off, a[1] + ey * t + ny * off))
            return pts
        outline += edge((w / 2, 0.0), (0.0, Ht), 1)
        outline.append((0.0, Ht))
        outline += edge((0.0, Ht), (-w / 2, 0.0), 1)
        def P3(a, b, c):
            c = c - 0.12 * Ht * (b / Ht) ** 2             # tip curls lingually
            return base + u * a + v * b + n * c
        vs = [tb.verts.new(P3(a, b, 0.0)) for a, b in outline]
        cf = tb.verts.new(P3(0.0, 0.33 * Ht, 0.14 * w))
        cb = tb.verts.new(P3(0.0, 0.33 * Ht, -0.2 * w))
        nn = len(vs)
        for i in range(nn):
            a, b = vs[i], vs[(i + 1) % nn]
            f1 = tb.faces.new((cf, a, b)); f2 = tb.faces.new((cb, b, a))
            f1.smooth = f2.smooth = False
        for _ in range(nn + 2): tooth_w.append((lower, root.copy()))

    nteeth = 0
    for key, lower in (('pu', False), ('pl', True)):
        for side in (1, -1):
            P, G, s = polyline(key, side)
            total = s[-1]
            pos = 0.0; first = True
            while True:
                frac = pos / total
                h = H0 * (1.0 - 0.45 * frac ** 1.3) * (0.92 if lower else 1.0)
                gi = np.interp(pos, s, G)
                h = min(h, 0.42 * gi)
                w = h * (0.72 if lower else 0.88)
                if first: pos = w * 0.55; first = False; continue
                if pos > total - 0.3 * w or h < 0.022 / S: break
                i = min(np.searchsorted(s, pos), len(s) - 1); i = max(i, 1)
                t = (pos - s[i - 1]) / max(s[i] - s[i - 1], 1e-9)
                root = Vector(P[i - 1] + (P[i] - P[i - 1]) * t)
                T = Vector(P[min(i + 1, len(P) - 1)] - P[max(i - 2, 0)]); T.z = 0; T.normalize()
                Nh = Vector((root.x - C.x, root.y - C.y, 0)).normalized()
                N = (Nh - Nh.dot(T) * T).normalized()
                root = root - N * INSET + Vector((0, 0, -0.008 if lower else 0.008))
                tooth(root, T, N, lower, h, w, frac)
                nteeth += 1
                pos += w * 1.06
    print('teeth', nteeth)
    tme = bpy.data.meshes.new('teeth'); tb.to_mesh(tme); tb.free()
    teeth = bpy.data.objects.new('teeth', tme); sc.collection.objects.link(teeth)

    # ---- cheek membranes closing the lateral gape (rows: 0 = palate/head ... ROWS = floor/jaw)
    ROWS = 5
    mb = bmesh.new(); memb_w = []
    for side in (1, -1):
        ks = [k for k in degs if k * side >= 20]
        ks.sort(key=lambda k: abs(k))
        ks = ks + [ks[-1] + side * j for j in (2, 4)]
        cols = []
        for k in ks:
            ref = rims[k] if k in rims else rims[ks[-3]]
            d = Vector((math.sin(math.radians(k)), math.cos(math.radians(k)), 0))
            rm = min((Vector(ref['pu'][:2]) - C).length, (Vector(ref['pl'][:2]) - C).length) - 0.16
            o = Vector((C.x + rm * d.x, C.y + rm * d.y, 0.5 * (ref['zu'] + ref['zl'])))
            top = bvh.ray_cast(o, Vector((0, 0, 1)), 0.6)[0]
            bot = bvh.ray_cast(o, Vector((0, 0, -1)), 0.6)[0]
            if top is None or bot is None: continue
            top = top + Vector((0, 0, 0.012)); bot = bot - Vector((0, 0, 0.012))
            cols.append([top.lerp(bot, j / ROWS) for j in range(ROWS + 1)])
        for _ in range(3):   # relax the ray-hit jitter between columns
            cols = [cols[0]] + [[(cols[i - 1][j] + cols[i][j] * 2 + cols[i + 1][j]) / 4 for j in range(ROWS + 1)]
                                for i in range(1, len(cols) - 1)] + [cols[-1]]
        vv = []
        for c in cols:
            vv.append([mb.verts.new(p) for p in c])
            for j, p in enumerate(c): memb_w.append((j / ROWS, c[-1].copy()))
        for i in range(len(vv) - 1):
            for j in range(ROWS):
                f = mb.faces.new((vv[i][j], vv[i + 1][j], vv[i + 1][j + 1], vv[i][j + 1])); f.smooth = True
        print('membrane side', side, 'columns', len(cols))
    mme = bpy.data.meshes.new('membrane'); mb.to_mesh(mme); mb.free()
    uvm = mme.uv_layers.new(name='UVMap')
    zmn = min(v.co.z for v in mme.vertices); zmx = max(v.co.z for v in mme.vertices)
    ymn = min(v.co.y for v in mme.vertices); ymx = max(v.co.y for v in mme.vertices)
    for l in mme.loops:   # map into the red palate block of the atlas
        p = mme.vertices[l.vertex_index].co
        uvm.data[l.index].uv = (0.33 + 0.05 * (p.z - zmn) / (zmx - zmn), 0.86 + 0.04 * (p.y - ymn) / (ymx - ymn))
    memb = bpy.data.objects.new('membrane', mme); sc.collection.objects.link(memb)
    bm.free()

    # ---- orient / scale: rotate 180 deg about up, scale to 20 m, centre -> head at Blender -Y = glTF +Z
    Mfin = Matrix.Rotation(math.pi, 4, 'Z') @ Matrix.Scale(S, 4) @ Matrix.Translation(-Vector(ctr))
    def fin(p): return Mfin @ Vector(p)
    Pbody = np.array([v.co[:] for v in me.vertices])          # source coords for the weight rules
    me.transform(Mfin); tme.transform(Mfin); mme.transform(Mfin)
    for o in (body, teeth, memb): o.data.update()

    # ---- armature (final coords)
    def cz(y):   # body centre line z (source coords)
        return float(np.interp(y, [-8, -6.3, -4.9, -3.0, -0.8, 1.6, 4.0, 6.0, 7.6], [-0.35, -0.55, -0.52, -0.45, -0.40, -0.35, -0.44, -0.55, -0.5]))
    ad = bpy.data.armatures.new('megalodon_rig'); arm = bpy.data.objects.new('megalodon_rig', ad)
    sc.collection.objects.link(arm)
    bpy.context.view_layer.objects.active = arm; arm.select_set(True)
    bpy.ops.object.mode_set(mode='EDIT')
    def eb(name, h, t, parent=None, deform=True):
        b = ad.edit_bones.new(name); b.head = fin(h); b.tail = fin(t); b.roll = 0.0
        if parent: b.parent = ad.edit_bones[parent]
        b.use_connect = False; b.use_deform = deform
        return b
    eb('root', (0, 0.0, cz(0)), (0, -1.0, cz(0)), None, False)
    chain = [('head', 4.0, 7.6), ('spine_01', 4.0, 1.6), ('spine_02', 1.6, -0.8), ('spine_03', -0.8, -3.0),
             ('spine_04', -3.0, -4.9), ('tail_01', -4.9, -6.3), ('caudal_fin', -6.3, -8.0)]
    par = 'root'
    for n, y0, y1 in chain:
        eb(n, (0, y0, cz(y0)), (0, y1, cz(y1)), par); par = n
    eb('jaw', (0, HINGE_Y, HINGE_Z), (0, 6.65, -1.55), 'head')
    eb('upper_jaw', (0, 6.3, -0.85), (0, 7.0, -1.05), 'head')
    for side, tag in ((1, 'R'), (-1, 'L')):        # source +x becomes final -x = the shark's right side
        r = PEC_ROOT * [side, 1, 1]; t = PEC_TIP * [side, 1, 1]; m = r + (t - r) * 0.45
        eb('pectoral_%s_root' % tag, r, m, 'spine_01')
        eb('pectoral_%s_mid' % tag, m, t, 'pectoral_%s_root' % tag)
    bpy.ops.object.mode_set(mode='OBJECT')
    SPINE = [n for n, _, _ in chain]
    for b in ad.bones: b.use_deform = b.name in SPINE

    # ---- automatic weights for the spine chain. Bone heat fails on the sculpt itself (overlapping shells, eyes, the
    # thin mouth pocket), so it runs on a watertight voxel-remeshed proxy and is transferred back by nearest-surface
    # barycentric interpolation.
    pme = me.copy(); proxy = bpy.data.objects.new('proxy', pme); sc.collection.objects.link(proxy)
    rmod = proxy.modifiers.new('rm', 'REMESH'); rmod.mode = 'VOXEL'; rmod.voxel_size = 0.05
    dmod = proxy.modifiers.new('dc', 'DECIMATE'); dmod.ratio = 0.25
    dg = bpy.context.evaluated_depsgraph_get()
    pm2 = bpy.data.meshes.new_from_object(proxy.evaluated_get(dg))
    proxy.modifiers.clear(); proxy.data = pm2; bpy.data.meshes.remove(pme)
    print('proxy verts', len(pm2.vertices))
    bpy.ops.object.select_all(action='DESELECT')
    proxy.select_set(True); arm.select_set(True); bpy.context.view_layer.objects.active = arm
    bpy.ops.object.parent_set(type='ARMATURE_AUTO')
    Wp = np.zeros((len(pm2.vertices), len(SPINE)))
    gi = {g.index: SPINE.index(g.name) for g in proxy.vertex_groups if g.name in SPINE}
    for v in pm2.vertices:
        for g in v.groups:
            if g.group in gi: Wp[v.index, gi[g.group]] = g.weight
    print('proxy verts without heat weights:', int((Wp.sum(1) < 1e-4).sum()))
    PV = np.array([v.co[:] for v in pm2.vertices])
    pbvh = BVHTree.FromPolygons([v.co for v in pm2.vertices], [p.vertices[:] for p in pm2.polygons])
    polys = [p.vertices[:] for p in pm2.polygons]
    nv = len(me.vertices)
    Wa = np.zeros((nv, len(SPINE)))
    for v in me.vertices:
        loc, _, fi, _ = pbvh.find_nearest(v.co)
        if fi is None: continue
        ids = list(polys[fi]); dd = np.linalg.norm(PV[ids] - np.array(loc[:]), axis=1)
        wi = 1.0 / (dd + 1e-4); Wa[v.index] = (Wp[ids] * wi[:, None]).sum(0) / wi.sum()
    bpy.data.objects.remove(proxy); bpy.data.meshes.remove(pm2)
    body.parent = arm
    am = body.modifiers.new('Armature', 'ARMATURE'); am.object = arm
    for b in ad.bones: b.use_deform = b.name != 'root'
    miss = Wa.sum(1) < 1e-4
    print('auto-weight verts without spine weight:', int(miss.sum()))
    # fallback / eyes: linear blend along the chain by source y
    def chain_w(y):   # tent weights over the bone mid-points
        mids = [5.8, 2.8, 0.4, -1.9, -3.95, -5.6, -7.15]
        w = np.zeros((len(y), len(SPINE)))
        for i in range(len(SPINE)):
            e = np.zeros(len(SPINE)); e[i] = 1
            w[:, i] = np.interp(-y, [-m for m in mids], e)
        return w / np.maximum(w.sum(1, keepdims=True), 1e-6)
    eyes = (np.abs(np.abs(Pbody[:, 0]) - 0.82) < 0.12) & (Pbody[:, 1] > 6.75) & (Pbody[:, 2] > -0.55) & (Pbody[:, 2] < -0.3)
    Wa[miss] = chain_w(Pbody[miss, 1])
    Wa[eyes] = 0; Wa[eyes, 0] = 1
    Wa /= Wa.sum(1, keepdims=True)

    wj = jaw_w(Pbody); wu = upper_jaw_w(Pbody) * (1 - wj)
    pR = pec_w(Pbody, 1); pL = pec_w(Pbody, -1)
    special = {'jaw': wj, 'upper_jaw': wu, 'pectoral_R_root': pR[0], 'pectoral_R_mid': pR[1],
               'pectoral_L_root': pL[0], 'pectoral_L_mid': pL[1]}
    tot = sum(special.values())
    rest = np.clip(1 - tot, 0, 1)
    # the head region is rigid to the head bone (auto weights leak spine_01 into the snout/jaw)
    headmask = smooth(4.3, 5.2, Pbody[:, 1])
    Wa = Wa * (1 - headmask[:, None]); Wa[:, 0] += headmask
    Wfin = {n: Wa[:, i] * rest for i, n in enumerate(SPINE)}
    Wfin.update(special)
    for g in list(body.vertex_groups): body.vertex_groups.remove(g)
    for n, w in Wfin.items():
        vg = body.vertex_groups.new(name=n)
        for i in np.nonzero(w > 1e-3)[0]:
            vg.add([int(i)], float(w[i]), 'REPLACE')
    print('weights: jaw verts %d, upper_jaw %d, pectoral R %d L %d' % ((wj > 0.5).sum(), (wu > 0.3).sum(), ((pR[0] + pR[1]) > 0.5).sum(), ((pL[0] + pL[1]) > 0.5).sum()))

    # teeth: lower -> jaw, upper -> head (+ upper_jaw at the front)
    Rt = np.array([p[:] for _, p in tooth_w])
    wut = upper_jaw_w(Rt)
    for n in ('head', 'jaw', 'upper_jaw'): teeth.vertex_groups.new(name=n)
    for i, (lower, _) in enumerate(tooth_w):
        if lower: teeth.vertex_groups['jaw'].add([i], 1.0, 'REPLACE')
        else:
            teeth.vertex_groups['head'].add([i], float(1 - wut[i]), 'REPLACE')
            if wut[i] > 1e-3: teeth.vertex_groups['upper_jaw'].add([i], float(wut[i]), 'REPLACE')
    # membranes: row fraction x jaw weight of the floor attachment
    Rb = np.array([p[:] for _, p in memb_w]); wjb = jaw_w(Rb - np.array([0, 0, 0.0]))
    wjb = np.maximum(wjb, jaw_w(Rb + np.array([0, 0, -0.05])))
    for n in ('head', 'jaw'): memb.vertex_groups.new(name=n)
    for i, (t, _) in enumerate(memb_w):
        w = t * wjb[i]
        memb.vertex_groups['jaw'].add([i], float(w), 'REPLACE')
        memb.vertex_groups['head'].add([i], float(1 - w), 'REPLACE')

    # ---- materials
    # skin: roughness remapped into 0.55-0.70 from the old ORM green channel, AO kept, metallic 0
    a = np.array(orm_old.pixels[:], dtype=np.float32).reshape(orm_old.size[1], orm_old.size[0], 4)
    g = a[..., 1]; rough = 0.55 + 0.15 * np.clip((g - g.min()) / max(g.max() - g.min(), 1e-6), 0, 1)
    orm = np.stack([a[..., 0], rough, np.zeros_like(rough), np.ones_like(rough)], -1)
    orm_old.name = '_old_orm'
    ormimg = bpy.data.images.new('megalodon_orm', orm_old.size[0], orm_old.size[1], alpha=False)
    ormimg.colorspace_settings.name = 'Non-Color'; ormimg.pixels[:] = orm.ravel(); ormimg.file_format = 'PNG'; ormimg.pack()
    print('skin roughness range %.3f..%.3f mean %.3f' % (rough.min(), rough.max(), rough.mean()))
    nrm_img.colorspace_settings.name = 'Non-Color'

    def pbr(name, base=None, tint=None, color=None, rough_tex=None, rough_val=0.5, normal=True, ao=False):
        mat = bpy.data.materials.new(name); mat.use_nodes = True
        nt = mat.node_tree; nt.nodes.clear()
        out = nt.nodes.new('ShaderNodeOutputMaterial'); bsdf = nt.nodes.new('ShaderNodeBsdfPrincipled')
        nt.links.new(bsdf.outputs[0], out.inputs[0])
        if base is not None:
            tx = nt.nodes.new('ShaderNodeTexImage'); tx.image = base
            if tint is not None:
                mix = nt.nodes.new('ShaderNodeMix'); mix.data_type = 'RGBA'; mix.blend_type = 'MULTIPLY'
                mix.inputs['Factor'].default_value = 1.0
                nt.links.new(tx.outputs['Color'], mix.inputs[6]); mix.inputs[7].default_value = tint
                nt.links.new(mix.outputs[2], bsdf.inputs['Base Color'])
            else:
                nt.links.new(tx.outputs['Color'], bsdf.inputs['Base Color'])
        else:
            bsdf.inputs['Base Color'].default_value = color
        if normal:
            tn = nt.nodes.new('ShaderNodeTexImage'); tn.image = nrm_img
            nm = nt.nodes.new('ShaderNodeNormalMap'); nt.links.new(tn.outputs['Color'], nm.inputs['Color'])
            nt.links.new(nm.outputs[0], bsdf.inputs['Normal'])
        if rough_tex is not None:
            to = nt.nodes.new('ShaderNodeTexImage'); to.image = rough_tex
            sep = nt.nodes.new('ShaderNodeSeparateColor'); nt.links.new(to.outputs['Color'], sep.inputs[0])
            nt.links.new(sep.outputs['Green'], bsdf.inputs['Roughness'])
            if ao:
                gg = bpy.data.node_groups.get('glTF Material Output')
                if gg is None:
                    gg = bpy.data.node_groups.new('glTF Material Output', 'ShaderNodeTree')
                    gg.interface.new_socket('Occlusion', in_out='INPUT', socket_type='NodeSocketFloat')
                gn = nt.nodes.new('ShaderNodeGroup'); gn.node_tree = gg
                nt.links.new(sep.outputs['Red'], gn.inputs['Occlusion'])
        else:
            bsdf.inputs['Roughness'].default_value = rough_val
        bsdf.inputs['Metallic'].default_value = 0.0
        mat.use_backface_culling = False
        return mat

    m_skin = pbr('megalodon_skin', base=base_img, rough_tex=ormimg, ao=True)
    m_mouth = pbr('megalodon_mouth', base=base_img, tint=(0.62, 0.30, 0.33, 1.0), rough_val=0.45)
    m_teeth = pbr('megalodon_teeth', color=(0.90, 0.88, 0.80, 1.0), rough_val=0.25, normal=False)
    me.materials[0] = m_skin; me.materials[1] = m_mouth; me.materials[2] = m_teeth
    for n_ in ('_ph1', '_ph2'): bpy.data.materials.remove(bpy.data.materials[n_])
    tme.materials.append(m_teeth); mme.materials.append(m_mouth)
    bpy.data.materials.remove(skin_old)

    # ---- smooth normals on the body, join teeth + membranes into one skinned mesh
    bpy.ops.object.select_all(action='DESELECT'); body.select_set(True); bpy.context.view_layer.objects.active = body
    try:
        bpy.ops.mesh.customdata_custom_splitnormals_clear()
    except Exception as e:
        print('no custom normals', e)
    bpy.ops.object.shade_smooth()
    teeth.select_set(True); memb.select_set(True)
    bpy.ops.object.join()
    for a_ in [a_.name for a_ in me.color_attributes]: me.color_attributes.remove(me.color_attributes[a_])
    body.name = 'megalodon'; me.name = 'megalodon'
    # keep weights normalised to 4 influences
    bpy.ops.object.mode_set(mode='WEIGHT_PAINT')
    bpy.ops.object.vertex_group_limit_total(group_select_mode='ALL', limit=4)
    bpy.ops.object.vertex_group_normalize_all(group_select_mode='ALL', lock_active=False)
    bpy.ops.object.mode_set(mode='OBJECT')
    me.calc_loop_triangles(); print('TRIS', len(me.loop_triangles))
    for mi, mt in enumerate(me.materials):
        print('  material', mt.name, sum(1 for t in me.loop_triangles if t.material_index == mi), 'tris')
    body.parent = arm; body.matrix_parent_inverse = Matrix()
    mod = next(m for m in body.modifiers if m.type == 'ARMATURE'); mod.object = arm

    # ---- animation
    animate(arm)

    for im in list(bpy.data.images):
        if im.users == 0: bpy.data.images.remove(im)
    bpy.ops.object.select_all(action='DESELECT'); arm.select_set(True); body.select_set(True)
    bpy.ops.export_scene.gltf(filepath=OUT, export_format='GLB', export_image_format='AUTO', use_selection=True,
                              export_animations=True, export_animation_mode='ACTIONS', export_force_sampling=True,
                              export_skins=True, export_def_bones=False, export_yup=True, export_apply=False,
                              export_draco_mesh_compression_enable=False, export_lights=False, export_cameras=False)
    print('EXPORTED', OUT)


def fcurves(act):
    out = []
    for L in act.layers:
        for s in L.strips:
            for cb in s.channelbags:
                out += list(cb.fcurves)
    return out


def animate(arm):
    sc = bpy.context.scene
    ad = arm.data
    for pb in arm.pose.bones:
        pb.rotation_mode = 'QUATERNION'
    Rrest = {b.name: b.matrix_local.to_3x3() for b in ad.bones}
    def lq(name, axis_arm, deg):        # local quaternion for a rotation about an armature-space axis
        a = (Rrest[name].inverted() @ Vector(axis_arm)).normalized()
        return Quaternion(a, math.radians(deg))
    def lv(name, v_arm):
        return Rrest[name].inverted() @ Vector(v_arm)
    Z = (0, 0, 1); X = (1, 0, 0); Y = (0, 1, 0)
    # world yaw per chain bone: amplitude (deg) grows toward the caudal fin; travelling wave (phase lag along body)
    chain = ['head', 'spine_01', 'spine_02', 'spine_03', 'spine_04', 'tail_01', 'caudal_fin']
    amp = [1.6, 0.8, 2.4, 5.0, 9.5, 16.0, 24.0]
    pos = [0.05, 0.25, 0.40, 0.55, 0.70, 0.80, 0.90]
    TAU = 2 * math.pi

    def pose(u, clip):
        P = {}
        prev = 0.0
        for n, A, s in zip(chain, amp, pos):
            yaw = A * math.sin(TAU * u - TAU * 0.6 * s)
            P[n] = lq(n, Z, yaw - prev); prev = yaw
        opn = 0.0
        if clip == 'Gape':
            opn = float(smooth(0.04, 0.34, u) * (1 - smooth(0.46, 0.96, u)))
        jaw = -3.0 + 2.5 * (0.5 - 0.5 * math.cos(TAU * u)) + 30.0 * opn
        P['jaw'] = lq('jaw', X, jaw)
        P['upper_jaw'] = lq('upper_jaw', X, -3.0 * opn)
        loc_up = lv('upper_jaw', (0, -0.05 * opn, -0.04 * opn))
        for tag, sgn, ph in (('L', 1, 0.0), ('R', -1, 0.9)):
            pitch = 8.0 * math.sin(TAU * u + 0.6 + ph)
            dih = 5.0 * math.sin(TAU * 2 * u + 1.3 + ph) + 9.0 * opn      # + = tip down
            q = lq('pectoral_%s_root' % tag, Y, sgn * dih) @ lq('pectoral_%s_root' % tag, Rrest['pectoral_%s_root' % tag] @ Vector((0, 1, 0)), pitch)
            P['pectoral_%s_root' % tag] = q
            P['pectoral_%s_mid' % tag] = lq('pectoral_%s_mid' % tag, Y, sgn * 3.5 * math.sin(TAU * u + 0.1 + ph))
        return P, loc_up

    arm.animation_data_create()
    for clip in ('Swim', 'Gape'):
        act = bpy.data.actions.new(clip); act.use_fake_user = True
        arm.animation_data.action = act
        for pb in arm.pose.bones:
            pb.rotation_quaternion = (1, 0, 0, 0); pb.location = (0, 0, 0)
        for f in range(NF + 1):
            u = (f % NF) / NF
            P, loc_up = pose(u, clip)
            for n, q in P.items():
                pb = arm.pose.bones[n]
                q = q.copy()
                if q.dot(pb.rotation_quaternion) < 0: q.negate()
                pb.rotation_quaternion = q
                pb.keyframe_insert('rotation_quaternion', frame=f, group=n)
            pbu = arm.pose.bones['upper_jaw']; pbu.location = loc_up
            pbu.keyframe_insert('location', frame=f, group='upper_jaw')
        for fc in fcurves(act):
            for kp in fc.keyframe_points: kp.interpolation = 'LINEAR'
        act.use_frame_range = True; act.frame_start = 0; act.frame_end = NF
        print('ACTION', clip, 'frames 0..%d = %.4f s' % (NF, NF / 24))
    arm.animation_data.action = bpy.data.actions['Swim']
    sc.frame_start = 0; sc.frame_end = NF; sc.frame_set(0)


# ---------------------------------------------------------------------------------------------------------------------
def look(ob, f, u):
    f = Vector(f).normalized(); u = Vector(u); z = -f
    x = u.cross(z).normalized(); y = z.cross(x)
    ob.matrix_world = Matrix((x, y, z)).transposed().to_4x4()


def preview(PV):
    bpy.ops.wm.read_factory_settings(use_empty=True)
    sc = bpy.context.scene; sc.render.fps = 24
    bpy.ops.import_scene.gltf(filepath=OUT)
    arm = next(o for o in bpy.data.objects if o.type == 'ARMATURE')
    body = max((o for o in bpy.data.objects if o.type == 'MESH'), key=lambda o: len(o.data.vertices))
    def verts():
        e = body.evaluated_get(bpy.context.evaluated_depsgraph_get())
        m = e.to_mesh(); V = np.array([body.matrix_world @ v.co for v in m.vertices]); e.to_mesh_clear(); return V
    def use(clip, f):
        act = bpy.data.actions[clip]
        arm.animation_data.action = act
        if hasattr(arm.animation_data, 'action_slot') and act.slots: arm.animation_data.action_slot = act.slots[0]
        sc.frame_set(f)
    # ---- geometry checks in glTF space (x, y, z)_gltf = (x, z, -y)_blender
    for a in bpy.data.actions: print('clip', a.name, 'range', tuple(a.frame_range))
    use('Swim', 0)
    arm.animation_data.action = None
    for pb in arm.pose.bones: pb.matrix_basis = Matrix()
    bpy.context.view_layer.update()
    me = body.data
    V = np.array([v.co[:] for v in me.vertices]); G = np.stack([V[:, 0], V[:, 2], -V[:, 1]], 1)
    print('glTF bbox min', G.min(0).round(3), 'max', G.max(0).round(3), 'length', round(float(np.ptp(G[:, 2])), 3))
    zf, zb = G[:, 2].max(), G[:, 2].min()
    front = G[G[:, 2] > zf - 1.0]; back = G[G[:, 2] < zb + 1.0]
    print('+Z end (1 m slab): height %.2f width %.2f   -Z end: height %.2f width %.2f' % (np.ptp(front[:, 1]), np.ptp(front[:, 0]), np.ptp(back[:, 1]), np.ptp(back[:, 0])))
    # eyes: darkest texels near the snout
    img = next(i for i in bpy.data.images if i.size[0] >= 2048)
    W, H = img.size; px = np.array(img.pixels[:], dtype=np.float32).reshape(H, W, 4)
    uv = me.uv_layers.active.data
    lum = np.zeros(len(V)); cnt = np.zeros(len(V))
    for l in me.loops:
        u_ = uv[l.index].uv; c = px[min(H - 1, max(0, int(u_[1] * H))), min(W - 1, max(0, int(u_[0] * W)))]
        lum[l.vertex_index] += c[:3].mean(); cnt[l.vertex_index] += 1
    lum /= np.maximum(cnt, 1)
    head = (G[:, 2] > zf - 3.0) & (G[:, 1] > -1.2) & (lum < 0.05) & (np.abs(G[:, 0]) > 0.7)
    for sgn in (1, -1):
        e = G[head & (np.sign(G[:, 0]) == sgn)]
        if len(e): print('eye %+d glTF' % sgn, e.mean(0).round(3), 'n', len(e))
    jb = arm.data.bones['jaw']
    hj = arm.matrix_world @ jb.head_local
    print('jaw hinge glTF', (round(hj.x, 3), round(hj.z, 3), round(-hj.y, 3)))
    for b in arm.data.bones:
        h = arm.matrix_world @ b.head_local
        print('bone %-18s parent %-16s head glTF (%.2f, %.2f, %.2f)' % (b.name, b.parent.name if b.parent else '-', h.x, h.z, -h.y))
    # ---- loop check
    for clip in ('Swim', 'Gape'):
        use(clip, 0); a0 = verts(); use(clip, NF); a1 = verts()
        print('loop err %s: %.2e m' % (clip, np.abs(a0 - a1).max()))
    use('Swim', 0); s0 = verts(); use('Gape', 0); g0 = verts()
    print('Swim vs Gape frame 0 max diff %.2e m' % np.abs(s0 - g0).max())
    # frame of maximum tail sweep and jaw opening
    tail = arm.pose.bones['caudal_fin']
    best = max(range(NF), key=lambda f: (use('Swim', f), abs((arm.matrix_world @ tail.tail).x))[1])
    use('Gape', 0)
    jaw = arm.pose.bones['jaw']
    fopen = max(range(NF), key=lambda f: (use('Gape', f), -(arm.matrix_world @ jaw.tail).z)[1])
    print('max sweep frame', best, 'max gape frame', fopen)

    # ---- render
    sc.render.engine = 'CYCLES'; sc.cycles.device = 'CPU'
    sc.cycles.samples = int(F.get('samples', 24)); sc.cycles.use_denoising = False
    sc.render.resolution_x, sc.render.resolution_y = 640, 360; sc.render.resolution_percentage = 100
    w = bpy.data.worlds.new('w'); sc.world = w; w.use_nodes = True
    bg = next(n for n in w.node_tree.nodes if n.type == 'BACKGROUND')
    bg.inputs[0].default_value = (0.05, 0.065, 0.08, 1); bg.inputs[1].default_value = 1.0
    for nm_, d, en in (('key', (-0.4, 0.3, -1.0), 4.0), ('fill', (0.7, -0.5, -0.2), 1.3), ('rim', (0.2, 1.0, 0.3), 1.0)):
        Ld = bpy.data.lights.new(nm_, 'SUN'); Ld.energy = en
        ob = bpy.data.objects.new(nm_, Ld); sc.collection.objects.link(ob); look(ob, d, (0, 0, 1))
    cam = bpy.data.objects.new('cam', bpy.data.cameras.new('cam')); sc.collection.objects.link(cam); sc.camera = cam
    cam.data.clip_start = 0.05; cam.data.clip_end = 200
    views = [  # clip, frame, ortho?, target, dir, up, scale/lens, dist
        ('Swim', 0, True, (0, 0, 0), (-1, 0, 0), (0, 0, 1), 22.5, 40),                        # side, left flank
        ('Gape', fopen, False, (0, -7.4, -1.6), (-0.62, 0.72, 0.3), (0, 0, 1), 32, 9.5),       # 3/4 front-low, jaw open
        ('Swim', best, True, (0, 0, 0), (0, 0, -1), (-1, 0, 0), 22.5, 40),                     # top, mid sweep
        ('Gape', fopen, False, (0, -7.8, -1.9), (0.12, 1.0, 0.1), (0, 0, 1), 30, 7.5),         # front close-up
    ]
    tiles = []
    tmp = os.path.splitext(PV)[0] + '_tmp.png'
    for clip, f, ortho, tgt, d, up, sc_, dist in views:
        use(clip, f)
        look(cam, d, up); cam.location = Vector(tgt) - Vector(d).normalized() * dist
        if ortho: cam.data.type = 'ORTHO'; cam.data.ortho_scale = sc_
        else: cam.data.type = 'PERSP'; cam.data.lens = sc_
        sc.render.filepath = tmp
        bpy.ops.render.render(write_still=True)
        im = bpy.data.images.load(tmp); a = np.array(im.pixels[:], dtype=np.float32).reshape(360, 640, 4)
        tiles.append(a.copy()); bpy.data.images.remove(im)
    sheet = np.concatenate([np.concatenate(tiles[2:4], 1), np.concatenate(tiles[0:2], 1)], 0)   # rows bottom-up
    out_img = bpy.data.images.new('sheet', 1280, 720, alpha=False)
    out_img.pixels[:] = sheet.ravel(); out_img.filepath_raw = PV; out_img.file_format = 'PNG'; out_img.save()
    os.remove(tmp)
    print('PREVIEW', PV)


if 'preview-only' not in F:
    build()
if F.get('preview'):
    preview(F['preview'])
