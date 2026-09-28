"""Modern ~13.5 m dive boat -> GLB (Blender 5.x, background mode).

Usage (from WSL):
  B="/mnt/c/Program Files/Blender Foundation/Blender 5.2/blender.exe"
  "$B" --background --factory-startup --python "$(wslpath -w blender/diveboat.py)" -- \
       "$(wslpath -w .)" [--render] [--no-export]

  arg 1     project root (contains assets/); textures are read from assets/textures/boat
            (generate them first with blender/boat_textures.py)
  --render  after export, re-import the GLB into an empty scene and render preview PNGs
            (assets/models/game/diveboat_preview_*.png)

Conventions (Blender space; the glTF exporter maps Blender (x, y, z) -> glTF (x, z, -y)):
  * bow points to Blender -Y  == glTF +Z
  * design waterline is Blender z = 0 == glTF y = 0 (antifouling below, hull bottom < 0)
  * X = 0 centreline; the boat's overall length is centred on Y = 0 (glTF z = 0)
  * port side = Blender/glTF +X (left when facing the bow), starboard = -X
  * metres
"""
import bpy, bmesh, math, sys, os
from mathutils import Vector, Matrix

ARGS = sys.argv[sys.argv.index('--') + 1:] if '--' in sys.argv else []
ROOT = ARGS[0] if ARGS and not ARGS[0].startswith('--') else os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
TEX = os.path.join(ROOT, 'assets', 'textures', 'boat')
OUTDIR = os.path.join(ROOT, 'assets', 'models', 'game')
GLB = os.path.join(OUTDIR, 'diveboat.glb')

# ============================================================================ small math helpers
def clamp(x, a=0.0, b=1.0): return max(a, min(b, x))
def lerp(a, b, s): return a + (b - a) * s
def sstep(a, b, x):
    s = clamp((x - a) / (b - a)); return s * s * (3 - 2 * s)

# ============================================================================ hull definition
YB, YT = -6.05, 5.55            # stem top / transom (Blender y); bow toward -Y
L = YT - YB
def tt(y): return (YT - y) / L   # 0 at transom, 1 at stem
def yy(t): return YT - t * L

def zs(t): return 1.40 + 0.85 * t ** 2.2                                   # sheer height
def bs(t):                                                                  # sheer half-beam
    if t <= 0.4: return 2.2 - 0.12 * ((0.4 - t) / 0.4) ** 2
    u = (t - 0.4) / 0.6
    return max(2.2 * (1 - u ** 1.9), 0.035)
def bc(t):                                                                  # chine half-beam
    u = clamp((t - 0.3) / 0.56); return 1.80 * (1 - u ** 1.7)
def zk(t): return -0.72 if t < 0.55 else -0.72 + 2.82 * ((t - 0.55) / 0.45) ** 3   # keel / stem
def dr(t): return math.radians(20 + 28 * sstep(0.35, 0.95, t))              # deadrise
def zc(t): return zk(t) + bc(t) * math.tan(dr(t))                           # chine height
def zd(t): return lerp(0.55, zs(t) - 0.12, sstep(0.42, 0.62, t))            # deck height
def capw(t): return min(0.13, 0.6 * bs(t))                                  # gunwale cap width
DECK_AFT = 0.55

# half-section indices
I_CHINE, I_CHINE_OUT, I_STRIPE_LO, I_STRIPE_HI, I_SHEER, I_INNER = 5, 6, 11, 12, 13, 18

def half_section(t):
    """(x, z) from keel (x = 0) round the +x side, over the gunwale cap, down to the deck edge."""
    k, c, cz, sw, S = zk(t), bc(t), zc(t), bs(t), zs(t)
    pts = [(0.0, k)]
    for s in (0.2, 0.4, 0.6, 0.8, 1.0):
        pts.append((c * s, k + (cz - k) * s - 0.035 * math.sin(math.pi * s) * c / 1.8))
    g = min(1.0, c / 0.3)
    c0 = (c + 0.08 * g, cz + 0.012 * g)
    pts.append(c0)
    h = S - c0[1]
    f = min(1.0, h / 0.9)
    sa, sb = 1 - 0.30 * f / h, 1 - 0.18 * f / h
    kb = lerp(0.45, -0.30, sstep(0.35, 0.95, t))     # side bulge: convex aft -> flared (concave) bow
    for s in [sa * i / 5 for i in range(1, 6)] + [sb, 1.0]:
        pts.append((c0[0] + (sw - c0[0]) * (s + kb * s * (1 - s)), c0[1] + h * s))
    cw = capw(t); q = cw / 0.13
    pts += [(sw - 0.01 * q, S + 0.03), (sw - 0.04 * q, S + 0.05), (sw - cw + 0.02 * q, S + 0.05),
            (sw - cw, S + 0.025), (sw - cw, zd(t))]
    return pts

def hull_x(t, z):
    """outer hull half-width at height z (keel .. sheer)."""
    p = half_section(t)[:I_SHEER + 1]
    for a, b in zip(p, p[1:]):
        if a[1] <= z <= b[1] and b[1] > a[1]:
            s = (z - a[1]) / (b[1] - a[1]); return a[0] + (b[0] - a[0]) * s
    return p[-1][0] if z > p[-1][1] else 0.0

def hull_frame(t, z, side=1):
    """point, outward normal, forward tangent on the hull surface (side=+1 port / -1 stbd)."""
    d = 0.01
    P = Vector((side * hull_x(t, z), yy(t), z))
    Pf = Vector((side * hull_x(t + d, z), yy(t + d), z))
    Pu = Vector((side * hull_x(t, z + d), yy(t), z + d))
    fwd = (Pf - P).normalized(); up = (Pu - P).normalized()
    n = fwd.cross(up) if side > 0 else up.cross(fwd)
    if n.x * side < 0: n = -n
    return P, n.normalized(), fwd

# ============================================================================ materials
IMGS = {}
def img(name, noncolor=False):
    if name not in IMGS:
        im = bpy.data.images.load(os.path.join(TEX, name))
        if noncolor: im.colorspace_settings.name = 'Non-Color'
        IMGS[name] = im
    return IMGS[name]

MATS = {}
UVRULE = {}
def srgb(c): return tuple(((x / 255) ** 2.2) for x in c)

def pbr(name, col=(0.8, 0.8, 0.8), metal=0.0, rough=0.5, bc=None, nrm=None, mr=None, nstr=1.0,
        emit=None, estr=0.0, uv=('box', 1.0)):
    m = bpy.data.materials.new(name); m.use_nodes = True
    nt = m.node_tree; b = nt.nodes['Principled BSDF']
    b.inputs['Base Color'].default_value = (*col, 1)
    b.inputs['Metallic'].default_value = metal
    b.inputs['Roughness'].default_value = rough
    x = -700
    if bc:
        t = nt.nodes.new('ShaderNodeTexImage'); t.image = img(bc); t.location = (x, 300)
        nt.links.new(t.outputs['Color'], b.inputs['Base Color'])
    if mr:
        t = nt.nodes.new('ShaderNodeTexImage'); t.image = img(mr, True); t.location = (x, 0)
        sp = nt.nodes.new('ShaderNodeSeparateColor'); sp.location = (x + 300, 0)
        nt.links.new(t.outputs['Color'], sp.inputs['Color'])
        nt.links.new(sp.outputs['Green'], b.inputs['Roughness'])
        nt.links.new(sp.outputs['Blue'], b.inputs['Metallic'])
    if nrm:
        t = nt.nodes.new('ShaderNodeTexImage'); t.image = img(nrm, True); t.location = (x, -300)
        nm = nt.nodes.new('ShaderNodeNormalMap'); nm.location = (x + 300, -300); nm.inputs['Strength'].default_value = nstr
        nt.links.new(t.outputs['Color'], nm.inputs['Color'])
        nt.links.new(nm.outputs['Normal'], b.inputs['Normal'])
    if emit:
        b.inputs['Emission Color'].default_value = (*emit, 1)
        b.inputs['Emission Strength'].default_value = estr
    MATS[name] = m; UVRULE[name] = uv
    return m

def build_materials():
    pbr('Hull_Gelcoat', bc='hull_gelcoat_basecolor.jpg', mr='hull_gelcoat_mr.jpg', nrm='gelcoat_normal.jpg', nstr=0.25, uv=('hull',))
    pbr('Hull_Stripe', srgb((18, 32, 70)), 0.0, 0.22, nrm='gelcoat_normal.jpg', nstr=0.25, uv=('hull',))
    pbr('Hull_Antifouling', bc='antifouling_basecolor.jpg', mr='antifouling_mr.jpg', nrm='antifouling_normal.jpg', uv=('box', 1.5))
    pbr('Deck_NonSkid', bc='deck_nonskid_basecolor.jpg', mr='deck_nonskid_mr.jpg', nrm='deck_nonskid_normal.jpg', uv=('box', 0.6))
    pbr('Gelcoat', bc='gelcoat_basecolor.jpg', mr='gelcoat_mr.jpg', nrm='gelcoat_normal.jpg', nstr=0.25, uv=('box', 2.0))
    pbr('Trim_Black', srgb((14, 15, 17)), 0.0, 0.3, uv=('box', 1.0))
    pbr('Glass', srgb((10, 16, 20)), 0.4, 0.04, uv=('box', 1.0))
    pbr('Stainless', bc='stainless_basecolor.jpg', mr='stainless_mr.jpg', nrm='stainless_normal.jpg', nstr=0.6, uv=('box', 0.5))
    pbr('Teak', bc='teak_basecolor.jpg', mr='teak_mr.jpg', nrm='teak_normal.jpg', uv=('teak', 1.0))
    pbr('Engine_White', srgb((236, 238, 240)), 0.0, 0.12, uv=('box', 1.0))
    pbr('Engine_Black', srgb((16, 16, 18)), 0.0, 0.18, uv=('box', 1.0))
    pbr('Tank_Aluminium', srgb((214, 216, 220)), 1.0, 0.32, nrm='stainless_normal.jpg', nstr=0.2, uv=('box', 0.5))
    pbr('Tank_Yellow', srgb((236, 184, 16)), 0.0, 0.3, uv=('box', 1.0))
    pbr('Tank_Blue', srgb((18, 74, 170)), 0.0, 0.3, uv=('box', 1.0))
    pbr('Fender_Blue', srgb((22, 62, 160)), 0.0, 0.42, uv=('box', 1.0))
    pbr('Rope', srgb((222, 220, 210)), 0.0, 0.9, uv=('box', 1.0))
    pbr('LifeRing', bc='lifering_basecolor.png', rough=0.55, uv=('keep',))
    pbr('DiveFlag', bc='diveflag_basecolor.png', rough=0.8, uv=('keep',))
    pbr('Light_Red', srgb((200, 20, 20)), 0.0, 0.2, emit=(1.0, 0.05, 0.03), estr=2.0)
    pbr('Light_Green', srgb((20, 200, 40)), 0.0, 0.2, emit=(0.05, 1.0, 0.1), estr=2.0)
    pbr('Light_White', srgb((230, 230, 225)), 0.0, 0.1, emit=(1.0, 0.95, 0.85), estr=1.5)

# ============================================================================ mesh helpers
OBJS = []
def mk(name, bm, mats, bevel=0.0, segs=2, smooth=True):
    if not bm.loops.layers.uv: bm.loops.layers.uv.new('UVMap')
    for f in bm.faces: f.smooth = smooth
    me = bpy.data.meshes.new(name); bm.to_mesh(me); bm.free()
    ob = bpy.data.objects.new(name, me); bpy.context.collection.objects.link(ob)
    for m in mats: me.materials.append(MATS[m] if isinstance(m, str) else m)
    if bevel > 0:
        mod = ob.modifiers.new('bev', 'BEVEL'); mod.width = bevel; mod.segments = segs
        mod.limit_method = 'ANGLE'; mod.angle_limit = math.radians(40)
    OBJS.append(ob)
    return ob

def quads(bm, rings, closed=True, mi=0):
    """faces between consecutive rings of BMVerts."""
    out = []
    for r0, r1 in zip(rings, rings[1:]):
        n = len(r0)
        for i in range(n if closed else n - 1):
            j = (i + 1) % n
            f = bm.faces.new((r0[i], r0[j], r1[j], r1[i])); f.material_index = mi; out.append(f)
    return out

def cap(bm, ring, mi=0, flip=False):
    f = bm.faces.new(list(reversed(ring)) if flip else ring); f.material_index = mi; return f

def box(name, size, loc, mat, bevel=0.01, segs=2, rot=(0, 0, 0)):
    bm = bmesh.new(); bmesh.ops.create_cube(bm, size=1.0)
    for v in bm.verts: v.co = Vector((v.co.x * size[0], v.co.y * size[1], v.co.z * size[2]))
    M = Matrix.Translation(loc) @ Matrix.Rotation(rot[2], 4, 'Z') @ Matrix.Rotation(rot[1], 4, 'Y') @ Matrix.Rotation(rot[0], 4, 'X')
    bmesh.ops.transform(bm, matrix=M, verts=bm.verts)
    return mk(name, bm, [mat], bevel, segs)

def hexa(name, c, mat, bevel=0.01, segs=2):
    """8 corners: bottom (x0y0, x1y0, x1y1, x0y1) then top in the same order."""
    bm = bmesh.new(); v = [bm.verts.new(p) for p in c]
    for f in ((0, 3, 2, 1), (4, 5, 6, 7), (0, 1, 5, 4), (1, 2, 6, 5), (2, 3, 7, 6), (3, 0, 4, 7)):
        bm.faces.new([v[i] for i in f])
    bmesh.ops.recalc_face_normals(bm, faces=bm.faces)
    return mk(name, bm, [mat], bevel, segs)

def fillet(pts, rad=0.12, n=4):
    pts = [Vector(p) for p in pts]
    if len(pts) < 3: return pts
    out = [pts[0]]
    for a, p, b in zip(pts, pts[1:], pts[2:]):
        da, db = (a - p), (b - p)
        if da.length < 1e-6 or db.length < 1e-6: continue
        ang = da.normalized().angle(db.normalized())
        if ang > math.radians(160): out.append(p); continue
        r = min(rad, 0.45 * da.length, 0.45 * db.length)
        p0 = p + da.normalized() * r; p1 = p + db.normalized() * r
        for i in range(n + 1):
            s = i / n
            out.append(p0 * (1 - s) ** 2 + p * 2 * s * (1 - s) + p1 * s * s)
    out.append(pts[-1])
    return out

def tube(name, pts, r, mat, segs=8, caps=True, rad=0.12, closed=False):
    pts = fillet(pts, rad) if rad > 0 else [Vector(p) for p in pts]
    bm = bmesh.new(); rings = []; n = len(pts)
    tans = []
    for i in range(n):
        a = pts[i - 1] if (closed or i > 0) else pts[i]
        b = pts[(i + 1) % n] if (closed or i < n - 1) else pts[i]
        tans.append((b - a).normalized())
    t0 = tans[0]; ref = Vector((0, 0, 1)) if abs(t0.z) < 0.9 else Vector((1, 0, 0))
    nrm = (ref - t0 * ref.dot(t0)).normalized()
    for i in range(n):
        t = tans[i]
        nrm = (nrm - t * nrm.dot(t)).normalized()
        bi = t.cross(nrm)
        rings.append([bm.verts.new(pts[i] + (nrm * math.cos(2 * math.pi * k / segs) + bi * math.sin(2 * math.pi * k / segs)) * r)
                      for k in range(segs)])
    if closed: rings.append(rings[0])
    quads(bm, rings)
    if caps and not closed:
        cap(bm, rings[0], flip=True); cap(bm, rings[-1])
    bmesh.ops.recalc_face_normals(bm, faces=bm.faces)
    return mk(name, bm, [mat])

def lathe(name, prof, mat, segs=24, M=Matrix(), mats=None, mi=None):
    """prof: list of (r, z) around local Z; r == 0 ends collapse to a pole."""
    bm = bmesh.new(); rings = []
    for r, z in prof:
        rings.append([bm.verts.new((r * math.cos(2 * math.pi * k / segs), r * math.sin(2 * math.pi * k / segs), z)) for k in range(segs)])
    fs = quads(bm, rings)
    if mi:
        for f, k in zip(fs, [k for k in range(len(rings) - 1) for _ in range(segs)]): f.material_index = mi[k]
    bmesh.ops.remove_doubles(bm, verts=bm.verts, dist=1e-5)
    bmesh.ops.transform(bm, matrix=M, verts=bm.verts)
    bmesh.ops.recalc_face_normals(bm, faces=bm.faces)
    return mk(name, bm, mats or [mat])

def sellipse(a, b, n=24, e=2.0, cx=0.0, cy=0.0, z=0.0):
    out = []
    for k in range(n):
        th = 2 * math.pi * k / n; c, s = math.cos(th), math.sin(th)
        out.append((cx + a * math.copysign(abs(c) ** (2 / e), c), cy + b * math.copysign(abs(s) ** (2 / e), s), z))
    return out

def loft(name, loops, mats, mi=None, cap0=True, cap1=True, M=Matrix()):
    """loops: list of closed point lists (same count). mi: material index per band."""
    bm = bmesh.new()
    rings = [[bm.verts.new(p) for p in lp] for lp in loops]
    for k in range(len(rings) - 1):
        quads(bm, rings[k:k + 2], mi=(mi[k] if mi else 0))
    if cap0: cap(bm, rings[0], mi=(mi[0] if mi else 0))
    if cap1: cap(bm, rings[-1], mi=(mi[-1] if mi else 0))
    bmesh.ops.remove_doubles(bm, verts=bm.verts, dist=1e-5)
    bmesh.ops.transform(bm, matrix=M, verts=bm.verts)
    bmesh.ops.recalc_face_normals(bm, faces=bm.faces)
    return mk(name, bm, mats)

# ============================================================================ hull + deck (one closed shell)
def build_hull():
    N, MD = 72, 12
    ts = []
    for i in range(N):
        s = i / (N - 1)
        ts.append(0.997 * (0.55 * s + 0.45 * (1 - (1 - s) ** 2)))
    bm = bmesh.new()
    loops, decks = [], []
    for t in ts:
        h = half_section(t); y = yy(t)
        full = [(x, z) for x, z in reversed(h)] + [(-x, z) for x, z in h[1:]]   # +x inner -> keel -> -x inner
        loops.append([bm.verts.new((x, y, z)) for x, z in full])
        w = bs(t) - capw(t); cam = 0.06 * sstep(0.5, 0.7, t)
        row = []
        for k in range(1, MD):
            x = -w + 2 * w * k / MD
            row.append(bm.verts.new((x, y, zd(t) + cam * (1 - (x / w) ** 2))))
        decks.append(row)
    nl = len(loops[0]); half = I_INNER
    # material slots: 0 gelcoat, 1 stripe, 2 antifouling, 3 deck
    for i in range(N - 1):
        A, B = loops[i], loops[i + 1]
        for j in range(nl - 1):
            f = bm.faces.new((A[j], B[j], B[j + 1], A[j + 1]))
            h0 = half - j if j < half else j - half      # half index of edge start
            h1 = half - (j + 1) if j + 1 <= half else j + 1 - half
            lo, hi = min(h0, h1), max(h0, h1)
            f.material_index = 1 if (lo, hi) == (I_STRIPE_LO, I_STRIPE_HI) else 0
        # deck strip: -x inner (A[-1]) .. row .. +x inner (A[0])
        ra = [A[-1]] + decks[i] + [A[0]]
        rb = [B[-1]] + decks[i + 1] + [B[0]]
        for k in range(len(ra) - 1):
            f = bm.faces.new((ra[k], ra[k + 1], rb[k + 1], rb[k])); f.material_index = 3
    # transom & stem caps
    tr = loops[0] + list(reversed(decks[0]))
    cap(bm, tr, mi=0)
    cap(bm, loops[-1] + list(reversed(decks[-1])), mi=0)
    # sharp edges: chine, chine flat, sheer, deck edge
    sharp_idx = {I_CHINE, I_CHINE_OUT, I_SHEER, I_INNER}
    for i in range(N - 1):
        for hidx in sharp_idx:
            for j in (half - hidx, half + hidx):
                e = bm.edges.get((loops[i][j], loops[i + 1][j]))
                if e: e.smooth = False
    bmesh.ops.remove_doubles(bm, verts=bm.verts, dist=0.0008)
    bmesh.ops.recalc_face_normals(bm, faces=bm.faces)
    for zc_ in (0.06, 0.24):
        geom = bm.verts[:] + bm.edges[:] + bm.faces[:]
        bmesh.ops.bisect_plane(bm, geom=geom, plane_co=(0, 0, zc_), plane_no=(0, 0, 1))
    for f in bm.faces:
        if f.material_index == 3: continue
        z = f.calc_center_median().z
        if z < 0.06: f.material_index = 2
        elif z < 0.24: f.material_index = 1
    mk('hull', bm, ['Hull_Gelcoat', 'Hull_Stripe', 'Hull_Antifouling', 'Deck_NonSkid'])

    # rub rail with stainless insert along the sheer, round the stem
    path = []
    tsr = [0.003 + 0.994 * (i / 40) ** 0.8 for i in range(41)]
    for t in tsr: path.append((bs(t) + 0.004, yy(t), zs(t) - 0.015))
    tip = [(0.0, yy(0.997) - 0.03, zs(0.997) - 0.015)]
    full = path + tip + [(-x, y, z) for x, y, z in reversed(path)]
    tube('rubrail', full, 0.034, 'Trim_Black', segs=10, rad=0.1)
    full2 = [(x + (0.026 if x > 0 else -0.026 if x < 0 else 0), y - (0.026 if x == 0 else 0), z) for x, y, z in full]
    tube('rubrail_insert', full2, 0.013, 'Stainless', segs=6, rad=0.1)

# ============================================================================ transom, platform, deck furniture
GATE = (-1.62, -1.0)   # x-range of the transom walk-through (starboard side, -x)

def build_transom_and_platform():
    xi = bs(0) - capw(0)
    y0, y1 = YT - 0.12, YT
    ztop = zs(0) + 0.02
    box('transom_bulwark_a', (GATE[0] + xi, y1 - y0, ztop - DECK_AFT), ((GATE[0] - xi) / 2, (y0 + y1) / 2, (ztop + DECK_AFT) / 2), 'Gelcoat', 0.035, 3)
    box('transom_bulwark_b', (xi - GATE[1], y1 - y0, ztop - DECK_AFT), ((GATE[1] + xi) / 2, (y0 + y1) / 2, (ztop + DECK_AFT) / 2), 'Gelcoat', 0.035, 3)
    # swim platform (engine bracket) and teak inlay
    box('swim_platform', (4.0, 0.84, 0.16), (0, YT + 0.40, 0.34), 'Gelcoat', 0.05, 3)
    box('swim_platform_teak', (3.8, 0.70, 0.03), (0, YT + 0.41, 0.425), 'Teak', 0.008, 1)
    # platform underside support knees
    for x in (-1.6, -0.6, 0.6, 1.6):
        hexa('platform_knee', [(x - 0.06, YT - 0.02, -0.05), (x + 0.06, YT - 0.02, -0.05), (x + 0.06, YT + 0.05, -0.05), (x - 0.06, YT + 0.05, -0.05),
                               (x - 0.06, YT - 0.02, 0.27), (x + 0.06, YT - 0.02, 0.27), (x + 0.06, YT + 0.75, 0.27), (x - 0.06, YT + 0.75, 0.27)], 'Gelcoat', 0.02)

def build_benches_and_tanks():
    y_a, y_b = 1.65, 4.75
    tank_mats = ['Tank_Aluminium', 'Tank_Yellow', 'Tank_Aluminium', 'Tank_Blue', 'Tank_Aluminium', 'Tank_Aluminium', 'Tank_Yellow', 'Tank_Aluminium']
    for side in (1, -1):
        xa = bs(tt(y_a)) - capw(tt(y_a)) + 0.01
        xb = bs(tt(y_b)) - capw(tt(y_b)) + 0.01
        d = 0.66
        def cs(x, y, z): return (side * x, y, z)
        c = [cs(xa - d, y_a, DECK_AFT - 0.01), cs(xa, y_a, DECK_AFT - 0.01), cs(xb, y_b, DECK_AFT - 0.01), cs(xb - d, y_b, DECK_AFT - 0.01),
             cs(xa - d, y_a, 0.93), cs(xa, y_a, 0.93), cs(xb, y_b, 0.93), cs(xb - d, y_b, 0.93)]
        if side < 0: c = [c[1], c[0], c[3], c[2], c[5], c[4], c[7], c[6]]
        hexa('bench', c, 'Gelcoat', 0.03, 3)
        # teak seat (front part) and tank rack board (rear part)
        seat = [cs(xa - d - 0.03, y_a - 0.02, 0.93), cs(xa - 0.30, y_a - 0.02, 0.93), cs(xb - 0.30, y_b + 0.02, 0.93), cs(xb - d - 0.03, y_b + 0.02, 0.93)]
        seat += [(p[0], p[1], 0.985) for p in seat]
        if side < 0: seat = [seat[1], seat[0], seat[3], seat[2], seat[5], seat[4], seat[7], seat[6]]
        hexa('bench_seat', seat, 'Teak', 0.012, 2)
        rack = [cs(xa - 0.29, y_a, 0.93), cs(xa - 0.02, y_a, 0.93), cs(xb - 0.02, y_b, 0.93), cs(xb - 0.29, y_b, 0.93)]
        rack += [(p[0], p[1], 0.96) for p in rack]
        if side < 0: rack = [rack[1], rack[0], rack[3], rack[2], rack[5], rack[4], rack[7], rack[6]]
        hexa('tank_rack', rack, 'Teak', 0.008, 1)
        # tanks
        n = 8
        for k in range(n):
            y = y_a + 0.25 + (y_b - y_a - 0.5) * k / (n - 1)
            x = side * (bs(tt(y)) - capw(tt(y)) - 0.15)
            mt = tank_mats[(k + (3 if side < 0 else 0)) % len(tank_mats)]
            prof = [(0.0, 0.62), (0.088, 0.62), (0.092, 0.64), (0.092, 1.20), (0.085, 1.25), (0.06, 1.285), (0.025, 1.30), (0.02, 1.33), (0.0, 1.33)]
            lathe('tank', prof, mt, 16, Matrix.Translation((x, y, 0)))
            box('valve', (0.05, 0.05, 0.07), (x, y, 1.36), 'Stainless', 0.01, 1)
            lathe('valve_knob', [(0.0, 0.0), (0.03, 0.0), (0.03, 0.025), (0.0, 0.025)], 'Engine_Black', 10,
                  Matrix.Translation((x, y, 1.405)))
            box('valve_port', (0.03, 0.06, 0.03), (x - side * 0.035, y, 1.36), 'Stainless', 0.008, 1)
        # stainless tank retaining bar in front of the tanks
        pa = (side * (xa - 0.27), y_a + 0.1, 0.96); pb = (side * (xb - 0.27), y_b - 0.1, 0.96)
        tube('tank_bar', [pa, (pa[0], pa[1] + 0.05, 1.17), (pb[0], pb[1] - 0.05, 1.17), pb], 0.016, 'Stainless', 8, rad=0.08)
    # rinse tank / camera table on the centreline
    box('rinse_tank', (0.8, 1.1, 0.62), (0, 2.2, DECK_AFT + 0.31), 'Gelcoat', 0.04, 3)
    box('rinse_lid', (0.84, 1.14, 0.04), (0, 2.2, DECK_AFT + 0.64), 'Teak', 0.01, 1)

# ============================================================================ wheelhouse, hardtop, mast
CAB_AFT, CAB_SIDE_END, CAB_APEX = 1.25, -1.35, -2.35

def wside(y, inset): return bs(tt(y)) - 0.10 - inset

def cabin_plan(inset, depth):
    pts = []
    wa = wside(CAB_AFT, inset) - 0.04
    for k in range(7):                               # aft wall +x -> -x   (pts 0..6)
        pts.append((lerp(wa - 0.12, -(wa - 0.12), k / 6), CAB_AFT))
    pts.append((-wa, CAB_AFT - 0.1))                 # corner (7)
    for k in range(7):                               # -x side going forward (8..14)
        y = lerp(CAB_AFT - 0.3, CAB_SIDE_END, k / 6); pts.append((-wside(y, inset), y))
    w0 = wside(CAB_SIDE_END, inset)
    for k in range(1, 10):                           # front arc (15..23)
        ph = math.pi * k / 10
        pts.append((-w0 * math.cos(ph), CAB_SIDE_END - depth * math.sin(ph) ** 0.85))
    for k in range(7):                               # +x side going aft (24..30)
        y = lerp(CAB_SIDE_END, CAB_AFT - 0.3, k / 6); pts.append((wside(y, inset), y))
    pts.append((wa, CAB_AFT - 0.1))                  # corner (31)
    return pts

def build_cabin():
    A = cabin_plan(0.0, 1.0); C = cabin_plan(0.10, 0.52); D = cabin_plan(0.115, 0.50)
    bm = bmesh.new()
    la = [bm.verts.new((x, y, (zd(tt(y)) - 0.05) if y < CAB_AFT - 0.05 else DECK_AFT - 0.02)) for x, y in A]
    lb = [bm.verts.new((x, y, 1.93)) for x, y in cabin_plan(0.012, 1.0)]
    lc = [bm.verts.new((x, y, 2.50)) for x, y in C]
    ld = [bm.verts.new((x, y, 2.66)) for x, y in D]
    wall = quads(bm, [la, lb]); band = quads(bm, [lb, lc]); top = quads(bm, [lc, ld])
    for f in wall + top: f.material_index = 0
    for f in band: f.material_index = 1
    groups = [[0], [3, 4, 5], [8, 9, 10], [11, 12, 13], [15, 16, 17], [18, 19, 20], [21, 22, 23], [24, 25, 26], [27, 28, 29]]
    for f in band[1:3]: f.material_index = 0    # door area on aft wall (+x half) is solid
    for g in groups:
        fs = [band[i] for i in g]
        res = bmesh.ops.inset_region(bm, faces=fs, thickness=0.04, depth=-0.012, use_even_offset=True)
        for f in fs: f.material_index = 2
        for f in res['faces']: f.material_index = 1
    bmesh.ops.recalc_face_normals(bm, faces=bm.faces)
    mk('wheelhouse', bm, ['Gelcoat', 'Trim_Black', 'Glass'])
    # aft door (+x half of the aft wall)
    box('door', (0.82, 0.05, 1.85), (0.66, CAB_AFT + 0.02, DECK_AFT + 0.93), 'Gelcoat', 0.02, 2)
    box('door_glass', (0.56, 0.03, 0.62), (0.66, CAB_AFT + 0.045, 1.95), 'Glass', 0.012, 1)
    box('door_handle', (0.03, 0.05, 0.16), (0.36, CAB_AFT + 0.07, 1.35), 'Stainless', 0.008, 1)
    # side nav lights (port red at +x, starboard green at -x)
    for side, m in ((1, 'Light_Red'), (-1, 'Light_Green')):
        y = -0.9; x = side * (wside(y, 0.0) + 0.03)
        box('navlight', (0.06, 0.18, 0.08), (x, y, 1.75), m, 0.012, 1)
    # windshield wipers
    for x in (-0.5, 0.5):
        y = CAB_APEX + 0.08 + 0.02 * abs(x)
        tube('wiper', [(x, y + 0.03, 1.94), (x + 0.28, y + 0.24, 2.36)], 0.008, 'Engine_Black', 5, rad=0)
    # life ring on the aft wall (-x half, below the window)
    build_lifering(Vector((-1.0, CAB_AFT + 0.07, 1.30)))

def build_lifering(c, R=0.34, r=0.055, nu=28, nv=10):
    bm = bmesh.new(); uvl = bm.loops.layers.uv.new('UVMap')
    grid = []
    for i in range(nu + 1):
        a = 2 * math.pi * i / nu; row = []
        for j in range(nv + 1):
            b = 2 * math.pi * j / nv
            rr = R + r * math.cos(b)
            row.append((Vector((c.x + rr * math.cos(a), c.y + r * math.sin(b), c.z + rr * math.sin(a))), i / nu, j / nv))
        grid.append(row)
    vmap = {}
    def V(i, j):
        key = (i % nu, j % nv)
        if key not in vmap: vmap[key] = bm.verts.new(grid[i][j][0])
        return vmap[key]
    for i in range(nu):
        for j in range(nv):
            f = bm.faces.new((V(i, j), V(i + 1, j), V(i + 1, j + 1), V(i, j + 1)))
            for lp, (ii, jj) in zip(f.loops, ((i, j), (i + 1, j), (i + 1, j + 1), (i, j + 1))):
                lp[uvl].uv = (grid[ii][jj][1], grid[ii][jj][2])
    bmesh.ops.recalc_face_normals(bm, faces=bm.faces)
    mk('lifering', bm, ['LifeRing'])
    # retaining bracket
    box('lifering_hook', (0.08, 0.06, 0.05), (c.x, c.y - 0.03, c.z + R + 0.07), 'Stainless', 0.01, 1)

HT_W, HT_AFT, HT_SIDE_END, HT_APEX = 2.06, 4.30, -0.9, -2.08
def hardtop_plan(off):
    pts = []
    w = HT_W + off; ya = HT_AFT + off; rc = 0.35 + off
    # aft edge +x -> -x
    for k in range(6): pts.append((lerp(w - rc, -(w - rc), k / 5), ya))
    for k in range(1, 4):                          # -x aft corner
        a = math.pi / 2 + (math.pi / 2) * k / 4
        pts.append((-(w - rc) + rc * math.cos(a), ya - rc + rc * math.sin(a)))
    for k in range(6): pts.append((-w, lerp(ya - rc, HT_SIDE_END, k / 5)))
    dep = HT_SIDE_END - (HT_APEX - off)
    for k in range(1, 12):
        ph = math.pi * k / 12
        pts.append((-w * math.cos(ph), HT_SIDE_END - dep * math.sin(ph) ** 0.8))
    for k in range(6): pts.append((w, lerp(HT_SIDE_END, ya - rc, k / 5)))
    for k in range(1, 4):
        a = (math.pi / 2) * k / 4
        pts.append(((w - rc) + rc * math.cos(a), ya - rc + rc * math.sin(a)))
    return pts

def build_hardtop():
    prof = [(-0.05, 2.60), (-0.012, 2.615), (0.0, 2.64), (0.0, 2.70), (-0.015, 2.735), (-0.05, 2.755), (-0.11, 2.765)]
    loops = [[(x, y, z) for x, y in hardtop_plan(o)] for o, z in prof]
    loft('hardtop', loops, ['Gelcoat'])
    # posts on the aft gunwale
    yp = HT_AFT - 0.28
    for side in (1, -1):
        t = tt(yp); x = side * (bs(t) - 0.10)
        tube('hardtop_post', [(x, yp, zs(t) + 0.04), (x, yp, 2.61)], 0.038, 'Stainless', 12, rad=0)
        lathe('post_base', [(0.0, 0.0), (0.065, 0.0), (0.065, 0.02), (0.04, 0.05), (0.0, 0.05)], 'Stainless', 12,
              Matrix.Translation((x, yp, zs(t) + 0.04)))
        # grab rail under the hardtop edge
        gx = side * 1.75
        tube('hardtop_grab', [(gx, 1.5, 2.6), (gx, 1.6, 2.45), (gx, 3.8, 2.45), (gx, 3.9, 2.6)], 0.016, 'Stainless', 8, rad=0.07)
    # mast / radar pylon on the hardtop
    rings = [(2.74, 0.30, 0.40, 0.55), (2.78, 0.29, 0.39, 0.56), (3.05, 0.22, 0.30, 0.66), (3.30, 0.15, 0.22, 0.76), (3.36, 0.14, 0.21, 0.78)]
    loft('mast', [sellipse(a, b, 24, 3.0, 0.0, cy, z) for z, a, b, cy in rings], ['Gelcoat'])
    lathe('radar_dome', [(0.0, 3.36), (0.30, 3.36), (0.33, 3.39), (0.33, 3.52), (0.30, 3.58), (0.18, 3.62), (0.0, 3.63)], 'Gelcoat', 32,
          mats=['Gelcoat', 'Trim_Black'], mi=[0, 1, 0, 0, 0, 0])
    # all-round light on a short pole behind the dome, dive flag staff
    tube('light_pole', [(0.0, 0.98, 3.30), (0.0, 1.02, 3.95)], 0.018, 'Stainless', 8, rad=0)
    lathe('allround_light', [(0.0, 3.95), (0.035, 3.95), (0.035, 4.03), (0.025, 4.05), (0.0, 4.05)], 'Light_White', 12,
          Matrix.Translation((0.0, 1.02, 0.0)))
    tube('flag_staff', [(0.12, 0.92, 3.25), (0.12, 0.98, 4.30)], 0.012, 'Stainless', 6, rad=0)
    build_flag(0.12, 0.99, 3.82, 4.22, 0.55)
    # VHF whips (fiberglass) at the forward hardtop corners, GPS puck, searchlight, horn
    for side in (1, -1):
        x = side * 1.80
        box('antenna_mount', (0.06, 0.06, 0.10), (x, -0.5, 2.81), 'Stainless', 0.01, 1)
        tube('vhf_whip', [(x, -0.5, 2.85), (x * 1.02, -0.35, 5.2)], 0.013, 'Gelcoat', 6, rad=0)
    lathe('gps', [(0.0, 2.765), (0.07, 2.765), (0.07, 2.80), (0.05, 2.83), (0.0, 2.84)], 'Gelcoat', 16, Matrix.Translation((0.5, 2.8, 0)))
    lathe('searchlight', [(0.0, 0.0), (0.09, 0.0), (0.10, 0.10), (0.10, 0.2), (0.0, 0.2)], 'Stainless', 16,
          Matrix.Translation((0.0, -1.6, 2.88)) @ Matrix.Rotation(math.radians(90), 4, 'X'), mats=['Stainless', 'Light_White'], mi=[0, 0, 0, 1])
    box('searchlight_base', (0.08, 0.08, 0.12), (0.0, -1.5, 2.80), 'Stainless', 0.01, 1)

def build_flag(x, y0, z0, z1, wlen):
    bm = bmesh.new(); uvl = bm.loops.layers.uv.new('UVMap')
    nx, th = 6, 0.004
    rows = []
    for s in (-1, 1):
        r = []
        for i in range(nx + 1):
            u = i / nx; y = y0 + wlen * u
            dx = 0.035 * math.sin(u * 5.0) * u
            r.append([bm.verts.new((x + dx + s * th, y, z0)), bm.verts.new((x + dx + s * th, y, z1))])
        rows.append(r)
    for s, r in zip((-1, 1), rows):
        for i in range(nx):
            vs = (r[i][0], r[i + 1][0], r[i + 1][1], r[i][1])
            if s < 0: vs = vs[::-1]
            f = bm.faces.new(vs)
            for lp in f.loops:
                lp[uvl].uv = ((lp.vert.co.y - y0) / wlen, (lp.vert.co.z - z0) / (z1 - z0))
    bmesh.ops.recalc_face_normals(bm, faces=bm.faces)
    mk('dive_flag', bm, ['DiveFlag'])

# ============================================================================ rails, cleats, fenders, foredeck gear
def rail_pt(t, h, off=0.065):
    return (bs(t) - off * min(1, bs(t) / 0.2), yy(t), zs(t) + 0.05 + h)

def build_rails():
    # bow rail: from the cabin front corner round the pulpit and back, top + mid rail
    t0, t1 = 0.585, 0.972
    ts = [lerp(t0, t1, (i / 14) ** 0.9) for i in range(15)]
    for h, r in ((0.66, 0.019), (0.34, 0.013)):
        side = [rail_pt(t, h) for t in ts]
        ty = yy(t1); w = side[-1][0]; zt = side[-1][2]
        tip = []
        for k in range(1, 6):
            ph = math.pi * k / 6
            tip.append((w * math.cos(ph), ty - 0.34 * math.sin(ph), zt + 0.02 * math.sin(ph)))
        start = [rail_pt(t0, 0.0)] if h > 0.5 else []
        path = start + side + tip + [(-x, y, z) for x, y, z in reversed(side)] + [(-x, y, z) for x, y, z in start]
        tube('bow_rail', path, r, 'Stainless', 8, rad=0.1)
    for t in (0.66, 0.74, 0.82, 0.89, 0.945):
        for s in (1, -1):
            a = rail_pt(t, 0.0); b = rail_pt(t, 0.66)
            tube('stanchion', [(s * a[0], a[1], a[2] - 0.02), (s * b[0], b[1], b[2])], 0.014, 'Stainless', 8, rad=0)
            lathe('stanchion_base', [(0.0, 0.0), (0.035, 0.0), (0.035, 0.012), (0.018, 0.05), (0.0, 0.05)], 'Stainless', 8,
                  Matrix.Translation((s * a[0], a[1], a[2] - 0.02)))
    # aft gunwale grab rails, turning across the transom to the gate
    y_a = CAB_AFT + 0.25
    for s in (1, -1):
        ts2 = [tt(lerp(y_a, YT - 0.25, i / 10)) for i in range(11)]
        pts = [rail_pt(tt(y_a), 0.0, 0.045)] + [rail_pt(t, 0.30, 0.045) for t in ts2]
        # transom top run: +x side runs to the gate's +x edge, -x side to the gate's -x edge
        xend = GATE[1] if s > 0 else GATE[0]
        zt = zs(0) + 0.02
        corner = (bs(0) - 0.12, YT - 0.06, zt + 0.30)
        pts = [(s * p[0], p[1], p[2]) for p in pts] + [(s * corner[0], corner[1], corner[2]),
                                                       (xend + (0.08 if s > 0 else -0.08), YT - 0.06, zt + 0.30), (xend + (0.08 if s > 0 else -0.08), YT - 0.06, zt)]
        tube('aft_rail', pts, 0.017, 'Stainless', 8, rad=0.12)
        for y in (2.4, 3.3, 4.6):
            t = tt(y); a = rail_pt(t, 0.0, 0.045); b = rail_pt(t, 0.30, 0.045)
            tube('aft_stanchion', [(s * a[0], a[1], a[2] - 0.02), (s * b[0], b[1], b[2])], 0.014, 'Stainless', 8, rad=0)

def cleat(p, yaw):
    M = Matrix.Translation(p) @ Matrix.Rotation(yaw, 4, 'Z')
    for dy in (-0.05, 0.05):
        box('cleat_post', (0.035, 0.03, 0.06), M @ Vector((0, dy, 0.03)), 'Stainless', 0.01, 1, rot=(0, 0, yaw))
    box('cleat_horn', (0.04, 0.28, 0.03), M @ Vector((0, 0, 0.065)), 'Stainless', 0.013, 2, rot=(0, 0, yaw))

def build_fittings():
    # cleats on the gunwale cap: bow pair, spring pair (aft of cabin), stern pair
    for t in (0.90, 0.30, 0.03):
        for s in (1, -1):
            x = s * (bs(t) - capw(t) * 0.5)
            ang = math.atan2(bs(t + 0.01) - bs(t), L * 0.01) * s
            cleat(Vector((x, yy(t), zs(t) + 0.05)), -ang)
    for s in (1, -1):   # platform cleats
        cleat(Vector((s * 1.85, YT + 0.62, 0.435)), 0.0)
    # fenders hanging over the aft topsides
    for s in (1, -1):
        for y in (2.35, 3.55, 4.75):
            t = tt(y); zf = 0.95
            x = s * (hull_x(t, zf) + 0.125)
            prof = [(0.0, -0.33), (0.03, -0.33), (0.07, -0.31), (0.10, -0.27), (0.115, -0.22), (0.115, 0.22), (0.10, 0.27), (0.07, 0.31), (0.03, 0.33), (0.0, 0.33)]
            lathe('fender', prof, 'Fender_Blue', 14, Matrix.Translation((x, y, zf)))
            tube('fender_line', [(x, y, zf + 0.33), (x * 0.99, y, zs(t) + 0.12), (s * (bs(t) - 0.05), y, zs(t) + 0.36)], 0.009, 'Rope', 5, rad=0.05)
    # foredeck: hatch, windlass, anchor roller and anchor
    t = tt(-3.6)
    zdk = zd(t) + 0.06
    box('hatch_frame', (0.72, 0.72, 0.08), (0, -3.6, zdk + 0.03), 'Gelcoat', 0.025, 2)
    box('hatch_lid', (0.64, 0.64, 0.03), (0, -3.6, zdk + 0.08), 'Glass', 0.01, 1)
    t = tt(-5.35); zdk = zd(t) + 0.06
    box('windlass', (0.24, 0.32, 0.16), (0, -5.35, zdk + 0.06), 'Stainless', 0.03, 2)
    lathe('windlass_drum', [(0.0, -0.1), (0.07, -0.1), (0.08, -0.09), (0.08, 0.09), (0.07, 0.1), (0.0, 0.1)], 'Stainless', 12,
          Matrix.Translation((0, -5.35, zdk + 0.1)) @ Matrix.Rotation(math.radians(90), 4, 'Y'))
    zt = zs(0.997) + 0.05
    hexa('anchor_roller', [(-0.06, YB + 0.45, zt - 0.08), (0.06, YB + 0.45, zt - 0.08), (0.06, YB - 0.30, zt - 0.02), (-0.06, YB - 0.30, zt - 0.02),
                           (-0.06, YB + 0.45, zt + 0.02), (0.06, YB + 0.45, zt + 0.02), (0.06, YB - 0.30, zt + 0.06), (-0.06, YB - 0.30, zt + 0.06)], 'Stainless', 0.02)
    # anchor hanging in the roller: shank + fluke
    tube('anchor_shank', [(0, YB - 0.05, zt + 0.02), (0, YB - 0.30, zt - 0.05), (0, YB - 0.38, zt - 0.35)], 0.022, 'Stainless', 8, rad=0.05)
    hexa('anchor_fluke', [(-0.15, YB - 0.30, zt - 0.34), (0.15, YB - 0.30, zt - 0.34), (0.015, YB - 0.30, zt - 0.66), (-0.015, YB - 0.30, zt - 0.66),
                          (-0.15, YB - 0.40, zt - 0.36), (0.15, YB - 0.40, zt - 0.36), (0.015, YB - 0.36, zt - 0.66), (-0.015, YB - 0.36, zt - 0.66)], 'Stainless', 0.012)
    # hull portholes (forward cabin), oriented to the hull surface
    for s in (1, -1):
        for t in (0.655, 0.715, 0.775):
            z = 1.18 + (t - 0.655) * 0.8
            P, n, fwd = hull_frame(t, z, s)
            up = n.cross(fwd).normalized()
            if up.z < 0: up = -up
            fx = n.cross(up).normalized()
            M = Matrix((( fx.x, up.x, n.x, P.x), (fx.y, up.y, n.y, P.y), (fx.z, up.z, n.z, P.z), (0, 0, 0, 1)))
            loops = [sellipse(0.19, 0.075, 20, 2.6, z=-0.02), sellipse(0.19, 0.075, 20, 2.6, z=0.01), sellipse(0.18, 0.066, 20, 2.6, z=0.018),
                     sellipse(0.15, 0.048, 20, 2.6, z=0.016), sellipse(0.15, 0.048, 20, 2.6, z=0.006)]
            loft('porthole', loops, ['Stainless', 'Glass'], mi=[0, 0, 0, 0, 1], cap0=False, M=M)

# ============================================================================ outboards & ladder
def build_outboard(x0, y0):
    dz = -0.17
    R = [  # z, half-width, half-length, centre-y, exponent, material (0 white, 1 black)
        (1.50, 0.12, 0.26, 0.44, 3.2, 0), (1.49, 0.22, 0.40, 0.44, 3.2, 0), (1.46, 0.27, 0.47, 0.43, 3.2, 0),
        (1.38, 0.295, 0.50, 0.42, 3.2, 0), (1.10, 0.30, 0.50, 0.42, 3.2, 0), (1.06, 0.302, 0.502, 0.42, 3.2, 2),
        (1.02, 0.302, 0.502, 0.42, 3.2, 0), (0.90, 0.295, 0.48, 0.42, 3.0, 0),
        (0.87, 0.285, 0.46, 0.42, 2.8, 1), (0.70, 0.25, 0.40, 0.40, 2.6, 1), (0.54, 0.18, 0.32, 0.36, 2.4, 1),
        (0.40, 0.12, 0.26, 0.32, 2.2, 1), (0.15, 0.085, 0.24, 0.30, 2.2, 1), (-0.40, 0.085, 0.22, 0.30, 2.2, 1),
        (-0.44, 0.085, 0.22, 0.30, 2.2, 1), (-0.45, 0.20, 0.37, 0.35, 2.2, 1), (-0.47, 0.20, 0.37, 0.35, 2.2, 1),
        (-0.48, 0.085, 0.22, 0.30, 2.2, 1), (-0.60, 0.075, 0.20, 0.30, 2.2, 1), (-0.66, 0.07, 0.18, 0.30, 2.2, 1)]
    loops = [sellipse(a, b, 28, e, x0, y0 + cy, z + dz) for z, a, b, cy, e, m in R]
    mi = [R[k][5] for k in range(len(R) - 1)]          # band k uses the material of its upper ring
    loft('outboard', loops, ['Engine_White', 'Engine_Black', 'Stainless'], mi=mi + [1])
    # gearcase torpedo, skeg, prop
    zc_ = -0.77 + dz * 0 - 0.03
    lathe('gearcase', [(0.0, -0.05), (0.05, 0.0), (0.078, 0.1), (0.085, 0.3), (0.07, 0.52), (0.055, 0.56), (0.0, 0.57)], 'Engine_Black', 14,
          Matrix.Translation((x0, y0 + 0.05, zc_)) @ Matrix.Rotation(math.radians(-90), 4, 'X'))
    hexa('skeg', [(x0 - 0.012, y0 + 0.30, zc_ - 0.05), (x0 + 0.012, y0 + 0.30, zc_ - 0.05), (x0 + 0.012, y0 + 0.58, zc_ - 0.05), (x0 - 0.012, y0 + 0.58, zc_ - 0.05),
                  (x0 - 0.008, y0 + 0.36, zc_ - 0.30), (x0 + 0.008, y0 + 0.36, zc_ - 0.30), (x0 + 0.008, y0 + 0.50, zc_ - 0.28), (x0 - 0.008, y0 + 0.50, zc_ - 0.28)],
         'Engine_Black', 0.006)
    yp = y0 + 0.64
    lathe('prop_hub', [(0.0, -0.02), (0.05, -0.02), (0.055, 0.06), (0.04, 0.14), (0.0, 0.16)], 'Stainless', 12,
          Matrix.Translation((x0, yp - 0.03, zc_)) @ Matrix.Rotation(math.radians(-90), 4, 'X'))
    for k in range(3):
        a = 2 * math.pi * k / 3
        bm = bmesh.new()
        outl = [(0.05 + 0.13 * (0.5 - 0.5 * math.cos(math.pi * u)), 0.055 * math.sin(math.pi * u) + 0.02 * u) for u in [i / 8 for i in range(9)]]
        top = [bm.verts.new((r, w, 0.006)) for r, w in outl] + [bm.verts.new((r, -w * 0.8, 0.006)) for r, w in reversed(outl[1:-1])]
        bot = [bm.verts.new((v.co.x, v.co.y, -0.006)) for v in top]
        cap(bm, top); cap(bm, bot, flip=True); quads(bm, [top, bot])
        R_ = Vector((math.cos(a), 0, math.sin(a))); T_ = Vector((-math.sin(a), 0, math.cos(a)))
        Mb = Matrix(((R_.x, T_.x, 0), (R_.y, T_.y, -1), (R_.z, T_.z, 0))).to_4x4()
        M = Matrix.Translation((x0, yp + 0.04, zc_)) @ Mb @ Matrix.Rotation(math.radians(28), 4, 'X')
        bmesh.ops.transform(bm, matrix=M, verts=bm.verts)
        bmesh.ops.recalc_face_normals(bm, faces=bm.faces)
        mk('prop_blade', bm, ['Stainless'])
    # clamp bracket to the swim platform
    box('engine_bracket', (0.30, 0.16, 0.34), (x0, y0 + 0.02, 0.30), 'Engine_Black', 0.03, 2)

def build_ladder():
    xs = (1.20, 1.58)
    ye = YT + 0.84
    for x in xs:
        tube('ladder_rail', [(x, ye - 0.30, 0.44), (x, ye - 0.26, 1.28), (x, ye - 0.02, 1.30), (x, ye + 0.06, 0.60), (x, ye + 0.06, -1.05)],
             0.019, 'Stainless', 8, rad=0.12)
        lathe('ladder_foot', [(0.0, 0.0), (0.04, 0.0), (0.04, 0.02), (0.0, 0.03)], 'Stainless', 8, Matrix.Translation((x, ye - 0.30, 0.44)))
    for z in (0.18, -0.12, -0.42, -0.72, -1.0):
        box('ladder_step', (xs[1] - xs[0] + 0.02, 0.09, 0.025), ((xs[0] + xs[1]) / 2, ye + 0.08, z), 'Stainless', 0.008, 1)

# ============================================================================ assembly / export
def finalize():
    dg = bpy.context.evaluated_depsgraph_get()
    for ob in list(OBJS):
        me = bpy.data.meshes.new_from_object(ob.evaluated_get(dg), preserve_all_data_layers=True, depsgraph=dg)
        me.transform(ob.matrix_world)
        old = ob.data; ob.modifiers.clear(); ob.data = me; ob.matrix_world = Matrix()
        bpy.data.meshes.remove(old)
    bpy.ops.object.select_all(action='DESELECT')
    for ob in OBJS: ob.select_set(True)
    bpy.context.view_layer.objects.active = OBJS[0]
    bpy.ops.object.join()
    boat = bpy.context.view_layer.objects.active
    boat.name = 'DiveBoat'; boat.data.name = 'DiveBoat'
    # centre the overall length on Y = 0
    ys = [v.co.y for v in boat.data.vertices]
    yoff = -(min(ys) + max(ys)) / 2
    boat.data.transform(Matrix.Translation((0, yoff, 0)))
    # UVs from world-space rules per material
    bm = bmesh.new(); bm.from_mesh(boat.data)
    uvl = bm.loops.layers.uv.get('UVMap') or bm.loops.layers.uv.new('UVMap')
    names = [m.name for m in boat.data.materials]
    for f in bm.faces:
        rule = UVRULE.get(names[f.material_index], ('box', 1.0))
        if rule[0] == 'keep': continue
        n = f.normal; ax = max(range(3), key=lambda i: abs(n[i]))
        for lp in f.loops:
            co = lp.vert.co
            if rule[0] == 'hull':
                lp[uvl].uv = ((co.y - yoff) / 3.0, (co.z + 0.1) / 2.5)
                continue
            s = rule[1]
            if ax == 0: u, v = co.y, co.z
            elif ax == 1: u, v = co.x, co.z
            else: u, v = (co.y, co.x) if rule[0] == 'teak' else (co.x, co.y)
            lp[uvl].uv = (u / s, v / s)
    bm.to_mesh(boat.data); bm.free()
    bpy.ops.object.select_all(action='DESELECT'); boat.select_set(True)
    bpy.context.view_layer.objects.active = boat
    bpy.ops.object.shade_smooth_by_angle(angle=math.radians(50), keep_sharp_edges=True)
    return boat, yoff

def add_empty(name, loc):
    e = bpy.data.objects.new(name, None); e.empty_display_type = 'ARROWS'; e.empty_display_size = 0.4
    e.location = loc; bpy.context.collection.objects.link(e); return e

def build_and_export():
    bpy.ops.wm.read_factory_settings(use_empty=True)
    build_materials()
    build_hull()
    build_transom_and_platform()
    build_benches_and_tanks()
    build_cabin()
    build_hardtop()
    build_rails()
    build_fittings()
    for x in (-0.60, 0.60):
        build_outboard(x, YT + 0.86)
    build_ladder()
    boat, yoff = finalize()
    # spawn: aft dive deck, starboard (-x) side near the transom gate, eye height 1.65 m above the deck.
    # Identity rotation: the node's -Z (glTF) faces aft, +Y is up.
    sp = add_empty('spawn_diver', (sum(GATE) / 2, YT - 0.62 + yoff, DECK_AFT + 1.65))
    ep = add_empty('entry_point', (sum(GATE) / 2, YT + 0.82 + yoff, 0.44))
    os.makedirs(OUTDIR, exist_ok=True)
    bpy.ops.object.select_all(action='DESELECT')
    for o in (boat, sp, ep): o.select_set(True)
    bpy.ops.export_scene.gltf(filepath=GLB, export_format='GLB', use_selection=True, export_apply=True, export_yup=True,
                              export_image_format='AUTO', export_materials='EXPORT', export_extras=False, export_cameras=False,
                              export_lights=False, export_animations=False)
    tris = sum(len(p.vertices) - 2 for p in boat.data.polygons)
    print('EXPORTED', GLB, 'tris~', tris, 'yoff', round(yoff, 4))
    print('spawn_diver (blender)', tuple(round(c, 3) for c in sp.location), 'entry_point', tuple(round(c, 3) for c in ep.location))

# ============================================================================ preview renders
def look_at(cam, target):
    d = Vector(target) - cam.location
    cam.rotation_euler = d.to_track_quat('-Z', 'Y').to_euler()

def render_previews():
    bpy.ops.wm.read_factory_settings(use_empty=True)
    bpy.ops.import_scene.gltf(filepath=GLB)
    sc = bpy.context.scene
    for eng in ('BLENDER_EEVEE', 'BLENDER_EEVEE_NEXT', 'CYCLES'):
        try: sc.render.engine = eng; break
        except TypeError: pass
    if sc.render.engine == 'CYCLES': sc.cycles.samples = 48
    else:
        try: sc.eevee.taa_render_samples = 64
        except Exception: pass
    sc.render.resolution_x, sc.render.resolution_y = 1600, 900
    sc.view_settings.view_transform = 'AgX'
    # world: physical sky if available
    w = bpy.data.worlds.new('sky'); sc.world = w; w.use_nodes = True
    nt = w.node_tree; bgn = nt.nodes['Background']
    try:
        sky = nt.nodes.new('ShaderNodeTexSky')
        items = [i.identifier for i in sky.bl_rna.properties['sky_type'].enum_items]
        for pref in ('NISHITA', 'MULTIPLE_SCATTERING', 'SINGLE_SCATTERING', 'HOSEK_WILKIE'):
            if pref in items: sky.sky_type = pref; break
        try:
            sky.sun_elevation = math.radians(48); sky.sun_rotation = math.radians(210)
        except Exception: pass
        nt.links.new(sky.outputs['Color'], bgn.inputs['Color'])
        bgn.inputs['Strength'].default_value = 0.12
    except Exception as ex:
        print('sky fallback', ex); bgn.inputs['Color'].default_value = (0.45, 0.62, 0.9, 1)
    sun = bpy.data.objects.new('sun', bpy.data.lights.new('sun', 'SUN')); sc.collection.objects.link(sun)
    sun.data.energy = 4.5; sun.data.angle = math.radians(0.8)
    sun.rotation_euler = (math.radians(42), 0, math.radians(210 - 90 + 180))
    # sea
    bpy.ops.mesh.primitive_plane_add(size=400, location=(0, 0, 0)); sea = bpy.context.object
    sm = bpy.data.materials.new('sea'); sm.use_nodes = True; b = sm.node_tree.nodes['Principled BSDF']
    b.inputs['Base Color'].default_value = (0.01, 0.06, 0.08, 1); b.inputs['Roughness'].default_value = 0.12
    sea.data.materials.append(sm)
    cam = bpy.data.objects.new('cam', bpy.data.cameras.new('cam')); sc.collection.objects.link(cam); sc.camera = cam
    views = [
        ('bow34', (-11.5, -15.0, 5.2), (0.0, -1.2, 1.2), 35, True),
        ('side', (-26.0, 0.0, 2.2), (0.0, 0.0, 1.0), 40, True),
        ('aftdeck', (4.2, 14.0, 6.0), (0.0, 3.0, 0.9), 30, True),
        ('profile', (-26.0, 0.0, 0.8), (0.0, 0.0, 0.9), 40, False),
        ('hull_bow_low', (-7.0, -15.0, -2.2), (0.0, -2.0, 0.2), 32, False),
    ]
    spn = bpy.data.objects.get('spawn_diver')
    if spn:   # eye-level view from the diver spawn, looking forward over the dive deck
        p = spn.matrix_world.translation
        views.append(('deck_pov', tuple(p), (p.x + 1.0, p.y - 6.0, p.z - 1.2), 22, True))
    for name, loc, tgt, lens, water in views:
        cam.location = loc; look_at(cam, tgt); cam.data.lens = lens
        sea.hide_render = not water
        sc.render.filepath = os.path.join(OUTDIR, 'diveboat_preview_%s.png' % name)
        bpy.ops.render.render(write_still=True)
        print('rendered', sc.render.filepath)

if __name__ == '__main__':
    if '--no-export' not in ARGS: build_and_export()
    if '--render' in ARGS: render_previews()
