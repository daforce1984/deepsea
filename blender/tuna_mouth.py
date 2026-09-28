# Close the hanging-open mouth of assets/models/raw4/tuna.glb -> assets/models/raw13/tuna.glb (2026-09-28).
# Edits the GLB binary in place (vertex positions + normals of the lower jaw only), so the rig, skin weights, "Swim"
# animation, materials, textures, scale (2.0 m), orientation (head +Z, up +Y) and everything else stay byte-identical.
# Needs numpy, so run it with Blender's Python (CPU only, nothing is rendered):
#   blender --background --factory-startup --python blender/tuna_mouth.py -- <in.glb> <out.glb> [hz,hy,tz,ty,deg]
# Jaw parameters (glTF frame, metres): every vertex with z > hz below the line hinge (hz,hy) -> (tz,ty) is rotated by
# deg about the X axis through the hinge (positive = lower jaw up). Default: 0.799,-0.100,0.945,-0.0333,27
# (hinge at the gape corner, measured on a Workbench side close-up of the source head).
import sys, json, struct, math
import numpy as np

a = sys.argv[sys.argv.index('--') + 1:] if '--' in sys.argv else sys.argv[1:]
SRC, OUT = a[0], a[1]
hz, hy, tz, ty, deg = map(float, (a[2] if len(a) > 2 else '0.799,-0.100,0.945,-0.0333,27').split(','))

b = bytearray(open(SRC, 'rb').read())
jl = struct.unpack('<I', b[12:16])[0]
j = json.loads(bytes(b[20:20 + jl]))
bin0 = 20 + jl + 8                                   # start of the BIN chunk payload

def view(acc_i):
    acc = j['accessors'][acc_i]; bv = j['bufferViews'][acc['bufferView']]
    assert acc['componentType'] == 5126 and acc['type'] == 'VEC3'
    stride = bv.get('byteStride', 12); assert stride == 12, 'interleaved buffers not handled'
    off = bin0 + bv.get('byteOffset', 0) + acc.get('byteOffset', 0)
    return acc, off, acc['count']

done = set(); total = 0
for me in j['meshes']:
    for p in me['primitives']:
        ia = p['attributes']['POSITION']
        if ia in done: continue
        done.add(ia)
        acc, off, n = view(ia)
        P = np.frombuffer(bytes(b[off:off + n * 12]), np.float32).reshape(n, 3).copy()
        line = hy + (ty - hy) * (P[:, 2] - hz) / (tz - hz)
        sel = (P[:, 2] > hz) & (P[:, 1] < line)
        r = math.radians(deg); c, s = math.cos(r), math.sin(r)
        dz, dy = P[sel, 2] - hz, P[sel, 1] - hy
        P[sel, 2] = hz + dz * c - dy * s
        P[sel, 1] = hy + dz * s + dy * c
        b[off:off + n * 12] = P.astype(np.float32).tobytes()
        acc['min'] = [float(x) for x in P.min(0)]; acc['max'] = [float(x) for x in P.max(0)]
        if 'NORMAL' in p['attributes']:
            _, noff, _ = view(p['attributes']['NORMAL'])
            N = np.frombuffer(bytes(b[noff:noff + n * 12]), np.float32).reshape(n, 3).copy()
            nz, ny = N[sel, 2].copy(), N[sel, 1].copy()
            N[sel, 2] = nz * c - ny * s; N[sel, 1] = nz * s + ny * c
            b[noff:noff + n * 12] = N.astype(np.float32).tobytes()
        total += int(sel.sum())
        print('mesh', me.get('name'), 'POSITION accessor', ia, 'jaw verts rotated', int(sel.sum()), 'of', n)
assert total > 0

js = json.dumps(j, separators=(',', ':')).encode()
js += b' ' * ((4 - len(js) % 4) % 4)
rest = bytes(b[20 + jl:])                              # BIN chunk header + payload (modified in place)
outb = struct.pack('<III', 0x46546C67, 2, 12 + 8 + len(js) + len(rest)) + struct.pack('<II', len(js), 0x4E4F534A) + js + rest
open(OUT, 'wb').write(outb)
print('WROTE', OUT, len(outb), 'bytes; jaw rotated', deg, 'deg about hinge z=%.3f y=%.3f' % (hz, hy))
