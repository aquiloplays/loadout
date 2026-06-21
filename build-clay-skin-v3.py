"""Clay's Minecraft skin -- v3 "aesthetic / persona" face style.
Matches the NameMC aesthetic look: big soft eyes (colored top, white bottom),
smooth shaded skin, voluminous fluffy hair pushed onto the hat layer for 3D
volume, minimal nose/mouth, clean-shaven w/ light stubble (no glasses).
Body = the approved collared button-up w/ cuffed sleeves + khaki pants.

Outputs classic + slim, plus 3D-Skin-Layers variants of each.
"""
import random
from PIL import Image

random.seed(42)

def sh(c, f):
    return (max(0, min(255, int(c[0]*f))), max(0, min(255, int(c[1]*f))),
            max(0, min(255, int(c[2]*f))), 255)

# ---- palette ----
SKIN     = (240, 200, 168, 255)
SKIN_HI  = (251, 218, 188, 255)
SKIN_SH  = (216, 172, 140, 255)
SKIN_SH2 = (190, 146, 118, 255)
CHEEK    = (246, 198, 182, 255)
STUBBLE  = (170, 134, 110, 255)   # very light beard hint
BEARD    = (74, 54, 44, 255)      # short beard
PUPIL    = (46, 50, 60, 255)      # dark slate pupil (cool, so it isn't read as hair)
# fluffy dark warm-brown hair (close to the reference)
HAIR     = (50, 38, 32, 255)
HAIR_HI  = (86, 66, 54, 255)
HAIR_SH  = (32, 24, 20, 255)
# big aesthetic eyes (warm brown to honor Clay's eye color)
EYE_TOP  = (122, 138, 154, 255)   # soft blue-grey iris (aesthetic style)
EYE_W    = (233, 235, 237, 255)   # white shine
MOUTH    = (196, 150, 142, 255)
COLLAR   = (238, 236, 228, 255)
COLLAR_SH= (196, 194, 186, 255)
PANTS    = (203, 180, 138, 255)
PANTS_HI = (220, 200, 162, 255)
PANTS_SH = (176, 152, 112, 255)
PANTS_SH2= (150, 128, 92, 255)
BELT     = (92, 66, 46, 255)
BUCKLE   = (206, 192, 150, 255)
SHOE     = (84, 64, 50, 255)
SHOE_HI  = (110, 86, 66, 255)
SHOE_SH  = (58, 44, 34, 255)
SOLE     = (208, 204, 196, 255)
LACE     = (224, 220, 210, 255)
BUTTON   = (242, 240, 232, 255)
STRIPES = [
    (228, 116, 150, 255), (92, 184, 196, 255), (236, 234, 224, 255),
    (122, 182, 112, 255), (96, 124, 206, 255), (236, 162, 92, 255),
]

def noise(c, amt):
    n = random.randint(-amt, amt)
    return (max(0, min(255, c[0]+n)), max(0, min(255, c[1]+n)),
            max(0, min(255, c[2]+n)), 255)

# tone classifiers (robust to noise) for overlay derivation
def _bri(c): return (c[0]+c[1]+c[2]) / 3
def is_skin(c):
    r, g, b, _ = c
    return r > g >= b and 30 < (r-b) < 120 and (g-b) >= 8 and _bri(c) > 140
def is_hair(c):
    r, g, b, _ = c
    return b < 60 and r >= g >= b-4 and _bri(c) < 130
def is_pants(c):
    r, g, b, _ = c
    return r > g > b and 38 < (r-b) < 95 and (g-b) > 30 and _bri(c) > 110

def build(slim, make3d):
    img = Image.new("RGBA", (64, 64), (0, 0, 0, 0))
    px = img.load()
    def rect(x0, y0, x1, y1, c):
        for y in range(y0, y1+1):
            for x in range(x0, x1+1):
                px[x, y] = c

    # ===================================================== HEAD
    # top: full fluffy hair w/ chunky highlight strands
    for y in range(0, 8):
        for x in range(8, 16):
            px[x, y] = noise(HAIR_HI if (x*3 + y) % 4 == 0 else HAIR, 9)
    rect(16, 0, 23, 7, SKIN_SH2)                        # bottom (neck)

    # sides: hair comes down low (covers ears, to jaw), skin jaw at bottom
    for sx in (0, 16):
        for y in range(8, 16):
            for x in range(sx, sx+8):
                px[x, y] = noise(SKIN, 3)
        for y in range(8, 14):                          # hair rows
            for x in range(sx, sx+8):
                px[x, y] = noise(HAIR_HI if (x + y) % 4 == 0 else HAIR, 8)
        rect(sx, 14, sx+7, 15, noise(SKIN_SH, 3)[:3]+(255,))  # jaw
        for x in range(sx, sx+8):
            px[x, 14] = noise(SKIN_SH, 3); px[x, 15] = noise(SKIN_SH2, 3)

    # back: full hair + neck at very bottom
    for y in range(8, 16):
        for x in range(24, 32):
            px[x, y] = noise(HAIR_HI if (x + y) % 4 == 1 else HAIR, 8)
    rect(26, 14, 29, 15, SKIN_SH)

    # ---- FACE FRONT (8,8)-(15,15) : aesthetic style ----
    fx, fy = 8, 8
    def F(c, r, col): px[fx+c, fy+r] = col
    # smooth shaded skin base
    for r in range(8):
        for c in range(8):
            base = SKIN
            if c in (0, 7): base = SKIN_SH          # side shading
            elif c in (1, 6): base = SKIN_HI        # cheek-light
            if r == 7: base = sh(base, 0.96)        # subtle jaw shadow
            F(c, r, noise(base, 2))
    # fluffy bangs (rows 0-2), hairline pushed up; row 3 = forehead skin + side hair
    for r in range(3):
        for c in range(8):
            F(c, r, noise(HAIR_HI if (c + r) % 4 == 0 else HAIR, 8))
    for c in range(8):
        F(c, 3, noise(SKIN_HI, 2))            # forehead skin (clean hairline, no eye contact)
    # big soft eyes w/ pupils: iris (top row) + pupil & white shine (bottom row)
    F(1, 4, EYE_TOP); F(2, 4, EYE_TOP); F(5, 4, EYE_TOP); F(6, 4, EYE_TOP)
    F(1, 5, EYE_W);   F(2, 5, PUPIL);   F(5, 5, PUPIL);   F(6, 5, EYE_W)
    # (eyes are bordered by skin on all sides -- no hair touching them)
    # nose: faint shadow
    F(4, 6, SKIN_SH)
    # clean-shaven: smooth skin lower face + soft mouth
    F(3, 7, MOUTH); F(4, 7, MOUTH)

    # ---- HAT overlay: fluffy 3D hair volume (mirror all base-head hair) ----
    for y in range(0, 16):
        for x in range(0, 32):
            c = px[x, y]
            if c[3] != 0 and is_hair(c):
                px[x+32, y] = c

    # ===================================================== BODY (collared shirt)
    def stripe(col): return STRIPES[col % len(STRIPES)]
    def vstripe_face(x0, y0, w, h, off):
        for cx in range(w):
            base = stripe(cx + off)
            for cy in range(h):
                c = noise(base, 5)
                if cx == w-1: c = sh(c, 0.9)
                if cx == 0:   c = sh(c, 1.06)
                if cy >= h-2: c = sh(c, 0.9)
                px[x0+cx, y0+cy] = c
    vstripe_face(20, 20, 8, 12, 0)
    rect(20, 20, 27, 20, COLLAR)
    px[22, 20] = COLLAR_SH; px[25, 20] = COLLAR_SH
    px[23, 20] = SKIN_SH;  px[24, 20] = SKIN_SH
    px[22, 21] = COLLAR_SH; px[25, 21] = COLLAR_SH
    px[23, 21] = SKIN_SH2; px[24, 21] = SKIN_SH2
    for y in range(22, 32):
        px[23, y] = sh(px[23, y], 1.08); px[24, y] = sh(px[24, y], 0.86)
    for y in (23, 25, 27, 29, 31):
        px[24, y] = BUTTON; px[23, y] = sh(BUTTON, 0.96)
    px[25, 23] = sh(px[25, 23], 0.72); px[26, 23] = sh(px[26, 23], 0.72)
    px[26, 24] = sh(px[26, 24], 0.85); px[25, 24] = BUTTON
    for (wx, wy) in ((21, 29), (26, 30), (22, 31)):
        px[wx, wy] = sh(px[wx, wy], 0.84)
    vstripe_face(32, 20, 8, 12, 0)
    vstripe_face(16, 20, 4, 12, 0)
    vstripe_face(28, 20, 4, 12, 4)
    vstripe_face(20, 16, 8, 4, 0)
    rect(28, 16, 35, 19, PANTS_SH)

    # ===================================================== ARMS (cuffed sleeves)
    def arm(faces, off, hand_detail=True):
        for key in ('right', 'front', 'left', 'back'):
            x0, y0, w, h = faces[key]
            so = {'right': off+5, 'front': off, 'left': off+2, 'back': off+3}[key]
            for cx in range(w):
                base = stripe(cx + so)
                for cy in range(h):
                    if cy <= 8:
                        c = noise(base, 5)
                        if cx == 0:   c = sh(c, 1.05)
                        if cx == w-1: c = sh(c, 0.9)
                        if cy == 8:   c = sh(c, 0.74)
                    elif cy == 9:
                        c = sh(noise(base, 4), 1.06)
                    else:
                        c = noise(SKIN, 6)
                        if cx == 0:   c = sh(c, 1.05)
                        if cx == w-1: c = sh(c, 0.9)
                        if cy >= h-1: c = sh(c, 0.92)
                    px[x0+cx, y0+cy] = c
            if key in ('front', 'back'):
                px[x0 + w//2, y0+9] = BUTTON
                if hand_detail and w >= 3:
                    px[x0+1, y0+h-1] = sh(px[x0+1, y0+h-1], 0.8)
                    if w >= 4: px[x0+2, y0+h-1] = sh(px[x0+2, y0+h-1], 0.8)
        x0, y0, w, h = faces['top'];    rect(x0, y0, x0+w-1, y0+h-1, sh(STRIPES[0], 0.95))
        x0, y0, w, h = faces['bottom']; rect(x0, y0, x0+w-1, y0+h-1, SKIN_SH)
    if slim:
        R = dict(right=(40,20,4,12), front=(44,20,3,12), left=(47,20,4,12),
                 back=(51,20,3,12), top=(44,16,3,4), bottom=(47,16,3,4))
        L = dict(right=(32,52,4,12), front=(36,52,3,12), left=(39,52,4,12),
                 back=(43,52,3,12), top=(36,48,3,4), bottom=(39,48,3,4))
    else:
        R = dict(right=(40,20,4,12), front=(44,20,4,12), left=(48,20,4,12),
                 back=(52,20,4,12), top=(44,16,4,4), bottom=(48,16,4,4))
        L = dict(right=(32,52,4,12), front=(36,52,4,12), left=(40,52,4,12),
                 back=(44,52,4,12), top=(36,48,4,4), bottom=(40,48,4,4))
    arm(R, 0); arm(L, 2)

    # ===================================================== LEGS (pants + shoes)
    def leg(right_x, front_x, left_x, back_x, top_x, bot_x, outer_front, ys, yc):
        for (xx, base) in ((right_x, PANTS), (front_x, PANTS),
                           (left_x, PANTS_SH), (back_x, PANTS_SH)):
            for cx in range(4):
                for cy in range(12):
                    c = noise(base, 6)
                    if cy == 0:    c = sh(c, 0.92)        # subtle waistband (no belt)
                    elif cy == 9:  c = sh(c, 0.82)        # pant hem
                    elif cy >= 10: c = SHOE if cy == 10 else SHOE_SH
                    px[xx+cx, ys+cy] = c
        seam_col = front_x+3 if outer_front == 'r' else front_x
        for cy in range(2, 9): px[seam_col, ys+cy] = sh(px[seam_col, ys+cy], 0.86)
        pocket_x = front_x+2 if outer_front == 'r' else front_x+1
        px[pocket_x, ys+2] = sh(px[pocket_x, ys+2], 0.8)
        px[pocket_x+(1 if outer_front=='r' else -1), ys+3] = sh(px[front_x+1, ys+3], 0.8)
        for cx in range(1, 3): px[front_x+cx, ys+5] = PANTS_HI
        px[front_x+1, ys+10] = LACE; px[front_x+2, ys+10] = LACE
        px[front_x, ys+10] = SHOE_HI
        rect(front_x, ys+11, front_x+3, ys+11, SOLE)
        rect(top_x, yc, top_x+3, yc+3, PANTS)
        rect(bot_x, yc, bot_x+3, yc+3, SOLE)
    leg(0, 4, 8, 12, 4, 8, 'r', 20, 16)
    leg(16, 20, 24, 28, 20, 24, 'l', 52, 48)

    # ===================================================== 3D clothing overlays
    if make3d:
        def copy(x0, y0, x1, y1, dx, dy, pred):
            src = {(x, y): px[x, y] for y in range(y0, y1+1) for x in range(x0, x1+1)}
            for (x, y), c in src.items():
                if c[3] != 0 and pred(c):
                    px[x+dx, y+dy] = c
        copy(16, 16, 39, 31, 0, 16, lambda c: not is_skin(c))   # jacket
        copy(40, 16, 55, 31, 0, 16, lambda c: not is_skin(c))   # R sleeve
        copy(32, 48, 47, 63, 16, 0, lambda c: not is_skin(c))   # L sleeve
        copy(0, 16, 15, 31, 0, 16, is_pants)                    # R pants
        copy(16, 48, 31, 63, -16, 0, is_pants)                  # L pants

        # glasses -- ONLY on the 3D-mod hat layer (extrudes in 3D; the plain
        # skins stay glasses-free). Light frame: top/bottom rims + bridge + hinges,
        # leaving the eyes open so they read clean (not goggles).
        GL = (30, 28, 33, 255)
        def HG(c, r): px[40+c, 8+r] = GL
        HG(1, 3); HG(2, 3); HG(5, 3); HG(6, 3)        # top rims
        HG(1, 6); HG(2, 6); HG(5, 6); HG(6, 6)        # bottom rims
        HG(3, 4); HG(4, 4)                            # nose bridge
        HG(0, 4); HG(7, 4)                            # hinges / temple starts

    return img

# --------------------------------------------------- skin file format
def save_skin(rgba, path):
    """Save as 8-bit palette PNG + tRNS (index 0 transparent) -- the exact
    encoding of Clay's confirmed-working reference skin. Binary alpha, no dither."""
    im = rgba.convert("RGBA"); w, h = im.size; apx = im.load()
    rgb = Image.new("RGB", (w, h)); opx = rgb.load()
    for y in range(h):
        for x in range(w):
            r, g, b, a = apx[x, y]
            opx[x, y] = (r, g, b) if a == 255 else (0, 0, 0)
    q = rgb.quantize(colors=255, dither=Image.Dither.NONE); qpx = q.load()
    out = Image.new("P", (w, h)); npx = out.load()
    for y in range(h):
        for x in range(w):
            npx[x, y] = 0 if apx[x, y][3] == 0 else qpx[x, y] + 1
    out.putpalette([0, 0, 0] + q.getpalette()[:255 * 3])
    out.save(path, "PNG", optimize=True, transparency=0)

# ----------------------------------------------------------------- render
def front_render(im, arm_w, out, scale=20):
    def grab(x, y, w, h): return im.crop((x, y, x+w, y+h))
    cw, ch = 16, 32
    canvas = Image.new("RGBA", (cw, ch), (238, 238, 240, 255))
    bx = 4
    canvas.alpha_composite(grab(8, 8, 8, 8), (bx, 0))
    canvas.alpha_composite(grab(40, 8, 8, 8), (bx, 0))
    canvas.alpha_composite(grab(20, 20, 8, 12), (bx, 8))
    canvas.alpha_composite(grab(20, 36, 8, 12), (bx, 8))
    canvas.alpha_composite(grab(44, 20, arm_w, 12), (bx-arm_w, 8))
    canvas.alpha_composite(grab(44, 36, arm_w, 12), (bx-arm_w, 8))
    canvas.alpha_composite(grab(36, 52, arm_w, 12), (bx+8, 8))
    canvas.alpha_composite(grab(52, 52, arm_w, 12), (bx+8, 8))
    canvas.alpha_composite(grab(4, 20, 4, 12), (bx, 20))
    canvas.alpha_composite(grab(4, 36, 4, 12), (bx, 20))
    canvas.alpha_composite(grab(20, 52, 4, 12), (bx+4, 20))
    canvas.alpha_composite(grab(4, 52, 4, 12), (bx+4, 20))
    canvas.resize((cw*scale, ch*scale), Image.NEAREST).save(out)

def head_render(im, out):
    head = Image.new("RGBA", (8, 8), (238, 238, 240, 255))
    head.alpha_composite(im.crop((8, 8, 16, 16)))
    head.alpha_composite(im.crop((40, 8, 48, 16)))
    head.resize((360, 360), Image.NEAREST).save(out)

# ----------------------------------------------------------------- outputs
for slim, tag, arm_w in [(False, "", 4), (True, "-slim", 3)]:
    base = build(slim, False)
    save_skin(base, f"clay-minecraft-skin{tag}.png")          # palette + tRNS format
    front_render(base, arm_w, f"clay-minecraft-skin{tag}-frontrender.png")
    base.resize((256, 256), Image.NEAREST).save(f"clay-minecraft-skin{tag}-preview.png")
    base3d = build(slim, True)
    save_skin(base3d, f"clay-minecraft-skin-3d{tag}.png")     # palette + tRNS format
    front_render(base3d, arm_w, f"clay-minecraft-skin-3d{tag}-render.png")
    print(f"built slim={slim}")
head_render(build(False, False), "_face-check.png")
print("done")
