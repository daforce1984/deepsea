# Contact sheet of 1280x720 preview PNGs (each scaled to 640x360), row-major, <cols> columns.
#   blender --background --factory-startup --python blender/contact_sheet.py -- <out.png> <cols> <in1.png> <in2.png> ...
import bpy, sys, numpy as np
a = sys.argv[sys.argv.index('--') + 1:]; out, C, fs = a[0], int(a[1]), a[2:]
W, H = 640, 360; R = (len(fs) + C - 1) // C
sheet = np.zeros((R * H, C * W, 4), np.float32); sheet[..., 3] = 1
for i, f in enumerate(fs):
    im = bpy.data.images.load(f); im.scale(W, H)
    t = np.array(im.pixels[:], np.float32).reshape(H, W, 4)
    r = R - 1 - i // C; c = i % C            # image rows are bottom-up
    sheet[r * H:(r + 1) * H, c * W:(c + 1) * W] = t
img = bpy.data.images.new('s', C * W, R * H, alpha=False); img.pixels[:] = sheet.ravel()
img.filepath_raw = out; img.file_format = 'PNG'; img.save(); print('SHEET', out, fs)
