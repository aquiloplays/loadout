"""Detailed Minecraft skin for Clay (Java 1.8+). v2 - adds per-pixel shading,
fabric texture, and fine details (collar, button placket, pocket, belt+buckle,
pant seams, laced shoes, hair strands, defined face, textured beard).

Builds classic + slim, plus 3D-Skin-Layers-optimized variants of each.
"""
import random
from PIL import Image

random.seed(42)

# ----------------------------------------------------------------- palette
def sh(c, f):
    return (max(0, min(255, int(c[0]*f))),
            max(0, min(255, int(c[1]*f))),
            max(0, min(255, int(c[2]*f))), 255)

SKIN     = (240, 200, 168, 255)
SKIN_HI  = (251, 216, 186, 255)
SKIN_SH  = (214, 170, 138, 255)
SKIN_SH2 = (188, 144, 116, 255)
CHEEK    = (245, 202, 187, 255)
COLLAR   = (238, 236, 228, 255)
COLLAR_SH= (196, 194, 186, 255)
HAIR     = (58, 38, 26, 255)
HAIR_HI  = (88, 60, 42, 255)
HAIR_SH  = (40, 25, 17, 255)
BEARD    = (76, 52, 38, 255)
BEARD_HI = (104, 76, 56, 255)
BEARD_SH = (54, 36, 26, 255)
BROW     = (46, 30, 20, 255)
EYE_W    = (224, 222, 220, 255)
EYE_D    = (52, 60, 78, 255)
MOUTH    = (174, 116, 108, 255)
GLASS    = (24, 22, 26, 255)
GLASS_HI = (70, 70, 78, 255)
LENS     = (150, 170, 184, 255)
PANTS    = (203, 180, 138, 255)
PANTS_HI = (220, 200, 162, 255)
PANTS_SH = (176, 152, 112, 255)
PANTS_SH2= (150, 128, 92, 255)
BELT     = (92, 66, 46, 255)
BELT_SH  = (66, 46, 32, 255)
BUCKLE   = (206, 192, 150, 255)
SHOE     = (84, 64, 50, 255)
SHOE_HI  = (110, 86, 66, 255)
SHOE_SH  = (58, 44, 34, 255)
SOLE     = (208, 204, 196, 255)
LACE     = (224, 220, 210, 255)
BUTTON   = (242, 240, 232, 255)

STRIPES = [
    (228, 116, 150, 255),  # pink
    (92, 184, 196, 255),   # teal
    (236, 234, 224, 255),  # white
    (122, 182, 112, 255),  # green
    (96, 124, 206, 255),   # blue
    (236, 162, 92, 255),   # orange
]

def noise(c, amt):
    n = random.randint(-amt, amt)
    return (max(0, min(255, c[0]+n)), max(0, min(255, c[1]+n)),
            max(0, min(255, c[2]+n)), 255)

# ----------------------------------------------------------------- builder
def build(slim):
    img = Image.new("RGBA", (64, 64), (0, 0, 0, 0))
    px = img.load()
    def P(x, y, c): px[x, y] = c
    def rect(x0, y0, x1, y1, c):
        for y in range(y0, y1+1):
            for x in range(x0, x1+1):
                px[x, y] = c

    # ===================================================== HEAD
    # --- top (hair, strand texture)
    for y in range(0, 8):
        for x in range(8, 16):
            base = HAIR_HI if ((x + y) % 3 == 0) else HAIR
            P(x, y, noise(base, 8))
    # crown swirl highlight
    for x in range(10, 14): P(x, 2, noise(HAIR_HI, 6))
    # --- bottom (neck underside)
    rect(16, 0, 23, 7, SKIN_SH2)

    # --- right side (x0=0) and left side (x0=16): hair cap + skin + ear + jaw
    for sx, earside in ((0, 'r'), (16, 'l')):
        for y in range(8, 16):
            for x in range(sx, sx+8):
                P(x, y, noise(SKIN, 6))
        # hair on upper rows, with a diagonal sideburn down the front edge
        for y in range(8, 11):
            for x in range(sx, sx+8):
                P(x, y, noise(HAIR if y < 10 else HAIR_HI, 8))
        # sideburn down front edge (front edge is x=sx+7 for right, x=sx for left view)
        front_edge = sx+7 if earside == 'r' else sx
        for y in range(10, 14):
            P(front_edge, y, noise(BEARD, 8))
        # ear hint mid-side
        ear_x = sx+3
        P(ear_x, 11, SKIN_SH); P(ear_x, 12, SKIN_SH2)
        # jaw beard bottom rows
        for x in range(sx, sx+8):
            P(x, 14, noise(BEARD, 8)); P(x, 15, noise(BEARD_SH, 8))
        # edge shading (back/front darker)
        for y in range(11, 16):
            P(sx, y, sh(px[sx, y], 0.9)); P(sx+7, y, sh(px[sx+7, y], 0.92))

    # --- back of head (hair) with neck
    for y in range(8, 16):
        for x in range(24, 32):
            base = HAIR_HI if ((x + y) % 3 == 1) else HAIR
            P(x, y, noise(base, 8))
    # hairline V + neck skin at bottom
    rect(26, 14, 29, 15, SKIN_SH)
    for x in range(24, 32): P(x, 13, noise(HAIR_SH, 6))

    # --- FACE FRONT (8,8)-(15,15)  -- defined, friendly, light groomed beard
    fx, fy = 8, 8
    def F(c, r, col): px[fx+c, fy+r] = col
    for r in range(8):
        for c in range(8):
            F(c, r, noise(SKIN, 4))
    # hair fringe rows 0-1: wavy hairline, more forehead showing
    fringe = [HAIR, HAIR_HI, HAIR, HAIR, HAIR_HI, HAIR, HAIR, HAIR]
    for c in range(8): F(c, 0, noise(fringe[c], 8))
    for c in range(8):
        if c in (0, 7):    F(c, 1, noise(HAIR, 6))       # temples
        elif c in (2, 5):  F(c, 1, noise(HAIR, 8))       # slight fringe dips
        else:              F(c, 1, noise(SKIN, 4))       # forehead skin
    F(0, 2, noise(HAIR, 6)); F(7, 2, noise(HAIR, 6))     # temples
    # friendly eyebrows (thin, soft)
    F(2, 2, BROW); F(5, 2, BROW)
    # eyes: bright, defined, with catchlight highlight beside iris
    F(1, 3, SKIN_HI); F(6, 3, SKIN_HI)
    F(2, 3, EYE_W); F(5, 3, EYE_W)
    px[fx+2, fy+3] = EYE_D; px[fx+5, fy+3] = EYE_D       # iris
    F(3, 3, SKIN_HI); F(4, 3, SKIN)                      # nose bridge highlight
    # nose
    F(3, 4, SKIN); F(4, 4, SKIN_HI)
    F(3, 5, SKIN_SH)                                     # nostril shadow
    # warm cheeks (very subtle)
    F(1, 4, CHEEK); F(6, 4, CHEEK)
    # thin sideburns + short groomed beard (uniform + symmetric)
    F(0, 3, BEARD); F(7, 3, BEARD)
    F(0, 4, BEARD); F(7, 4, BEARD)
    F(0, 5, BEARD); F(7, 5, BEARD)
    F(0, 6, noise(BEARD, 4)); F(1, 6, noise(BEARD, 4))
    F(6, 6, noise(BEARD, 4)); F(7, 6, noise(BEARD, 4))
    for c in range(8):
        F(c, 7, SKIN_HI if c in (3, 4) else noise(BEARD, 4))   # beard, lit chin
    # gentle closed smile (small, centered)
    F(3, 6, MOUTH); F(4, 6, MOUTH)
    # face edge AO
    for r in range(3, 8):
        F(0, r, sh(px[fx+0, fy+r], 0.93)); F(7, r, sh(px[fx+7, fy+r], 0.93))

    # --- HAT overlay: glasses (frame + lenses + bridge + temples), row3
    hx, hy = 40, 8
    def H(c, r, col): px[hx+c, hy+r] = col
    H(0, 3, GLASS); H(1, 3, GLASS); H(2, 3, LENS); H(3, 3, GLASS)
    H(4, 3, GLASS); H(5, 3, LENS); H(6, 3, GLASS); H(7, 3, GLASS)
    H(2, 2, GLASS_HI); H(5, 2, GLASS_HI)            # frame top highlight

    # ===================================================== BODY (shirt)
    def stripe(col): return STRIPES[col % len(STRIPES)]
    def vstripe_face(x0, y0, w, h, off, detail=False):
        for cx in range(w):
            base = stripe(cx + off)
            for cy in range(h):
                c = noise(base, 5)
                if cx == w-1: c = sh(c, 0.9)         # right-edge fold shadow
                if cx == 0:   c = sh(c, 1.06)        # left-edge highlight
                if cy >= h-2: c = sh(c, 0.9)         # bottom AO (hem)
                px[x0+cx, y0+cy] = c

    # front 8x12 at (20,20)
    vstripe_face(20, 20, 8, 12, 0)
    # collared shirt: white folded collar with points + open neck
    rect(20, 20, 27, 20, COLLAR)                             # collar band
    px[22, 20] = COLLAR_SH; px[25, 20] = COLLAR_SH           # collar point shade
    px[23, 20] = SKIN_SH;  px[24, 20] = SKIN_SH              # open neck
    px[22, 21] = COLLAR_SH; px[25, 21] = COLLAR_SH           # collar point tips
    px[23, 21] = SKIN_SH2; px[24, 21] = SKIN_SH2            # neck shadow
    # button placket down center (cols 23-24), starting below the neck
    for y in range(22, 32):
        px[23, y] = sh(px[23, y], 1.08)                      # placket highlight
        px[24, y] = sh(px[24, y], 0.86)                      # placket shadow seam
    for y in (23, 25, 27, 29, 31):                           # buttons
        px[24, y] = BUTTON
        px[23, y] = sh(BUTTON, 0.96)
    # chest pocket (viewer left = cols 25-26, x=25-26, rows 3-5)
    px[25, 23] = sh(px[25, 23], 0.72); px[26, 23] = sh(px[26, 23], 0.72)  # opening
    px[26, 24] = sh(px[26, 24], 0.85)                        # pocket edge
    px[25, 24] = BUTTON                                      # tiny pocket button
    # a couple of fabric wrinkles near waist
    for (wx, wy) in ((21, 29), (26, 30), (22, 31)):
        px[wx, wy] = sh(px[wx, wy], 0.84)

    # back 8x12 at (32,20)
    vstripe_face(32, 20, 8, 12, 0)
    # right side (16,20) 4 wide, left side (28,20) 4 wide
    vstripe_face(16, 20, 4, 12, 0)
    vstripe_face(28, 20, 4, 12, 4)
    # shoulders top (20,16)8x4, hem/waist bottom (28,16)8x4
    vstripe_face(20, 16, 8, 4, 0)
    rect(28, 16, 35, 19, PANTS_SH)

    # ===================================================== ARMS
    def arm(faces, off, hand_detail=True):
        # faces: dict with right/front/left/back/top/bottom = (x0,y0,w,h)
        for key in ('right', 'front', 'left', 'back'):
            x0, y0, w, h = faces[key]
            so = {'right': off+5, 'front': off, 'left': off+2, 'back': off+3}[key]
            for cx in range(w):
                base = stripe(cx + so)
                for cy in range(h):
                    if cy <= 8:                              # long sleeve
                        c = noise(base, 5)
                        if cx == 0:   c = sh(c, 1.05)        # top-light
                        if cx == w-1: c = sh(c, 0.9)         # underside shadow
                        if cy == 8:   c = sh(c, 0.74)        # cuff fold shadow
                    elif cy == 9:                            # folded cuff band
                        c = sh(noise(base, 4), 1.06)
                    else:                                    # hand skin (cy 10-11)
                        c = noise(SKIN, 6)
                        if cx == 0:   c = sh(c, 1.05)
                        if cx == w-1: c = sh(c, 0.9)
                        if cy >= h-1: c = sh(c, 0.92)        # hand AO
                    px[x0+cx, y0+cy] = c
            # cuff button + finger separations on front/back
            if key in ('front', 'back'):
                px[x0 + w//2, y0+9] = BUTTON                 # cuff button
                if hand_detail and w >= 3:
                    px[x0+1, y0+h-1] = sh(px[x0+1, y0+h-1], 0.8)
                    if w >= 4: px[x0+2, y0+h-1] = sh(px[x0+2, y0+h-1], 0.8)
        # top sleeve cap + bottom hand underside
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
    arm(R, 0)
    arm(L, 2)

    # ===================================================== LEGS (pants + shoes)
    def leg(right_x, front_x, left_x, back_x, top_x, bot_x, outer_front, ys, yc):
        # sides (ys = row of face top, yc = row of top/bottom cap)
        for (xx, base) in ((right_x, PANTS), (front_x, PANTS),
                           (left_x, PANTS_SH), (back_x, PANTS_SH)):
            for cx in range(4):
                for cy in range(12):
                    c = noise(base, 6)
                    if cy <= 1:           c = noise(BELT, 5)       # belt
                    elif cy == 9:         c = sh(c, 0.82)         # pant hem
                    elif cy >= 10:        c = SHOE if cy == 10 else SHOE_SH
                    px[xx+cx, ys+cy] = c
        # belt buckle on front
        px[front_x+1, ys] = BUCKLE; px[front_x+2, ys] = sh(BUCKLE, 0.85)
        # outer side seam (vertical darker line) on front
        seam_col = front_x+3 if outer_front == 'r' else front_x
        for cy in range(2, 9): px[seam_col, ys+cy] = sh(px[seam_col, ys+cy], 0.86)
        # front pocket curve (diagonal) near top-outer
        pocket_x = front_x+2 if outer_front == 'r' else front_x+1
        px[pocket_x, ys+2] = sh(px[pocket_x, ys+2], 0.8)
        px[pocket_x+(1 if outer_front=='r' else -1), ys+3] = sh(px[front_x+1, ys+3], 0.8)
        # knee highlight
        for cx in range(1, 3): px[front_x+cx, ys+5] = PANTS_HI
        # shoe detail on front: laces + sole edge
        px[front_x+1, ys+10] = LACE; px[front_x+2, ys+10] = LACE  # laces
        px[front_x, ys+10] = SHOE_HI                              # toe highlight
        rect(front_x, ys+11, front_x+3, ys+11, SOLE)             # white sole
        # top (waist) & bottom (sole underside)
        rect(top_x, yc, top_x+3, yc+3, PANTS)
        rect(top_x, yc, top_x+3, yc, BELT)
        rect(bot_x, yc, bot_x+3, yc+3, SOLE)

    # right leg: faces at y20-31, caps at y16-19
    leg(0, 4, 8, 12, 4, 8, 'r', 20, 16)
    # left leg: faces at y52-63, caps at y48-51
    leg(16, 20, 24, 28, 20, 24, 'l', 52, 48)

    return img

# ----------------------------------------------------------------- 3D overlays
# Tone-based classifiers (robust to the per-pixel noise applied during paint).
def _bri(c): return (c[0] + c[1] + c[2]) / 3
def is_skin(c):
    r, g, b, _ = c
    return r > g >= b and 30 < (r - b) < 120 and (g - b) >= 8 and _bri(c) > 140
def is_hairbeard(c):
    r, g, b, _ = c
    return b < 66 and r >= g >= b - 4 and _bri(c) < 150
def is_pants(c):
    r, g, b, _ = c
    return r > g > b and 38 < (r - b) < 95 and (g - b) > 30 and _bri(c) > 110

def add_overlays(im):
    px = im.load()
    def copy(x0, y0, x1, y1, dx, dy, pred):
        src = {(x, y): px[x, y] for y in range(y0, y1+1) for x in range(x0, x1+1)}
        for (x, y), c in src.items():
            if c[3] != 0 and pred(c):
                px[x+dx, y+dy] = c
    copy(0, 0, 31, 15, 32, 0, is_hairbeard)                  # hat: 3D hair + beard
    copy(16, 16, 39, 31, 0, 16, lambda c: not is_skin(c))    # jacket: shirt (not neck skin)
    copy(40, 16, 55, 31, 0, 16, lambda c: not is_skin(c))    # R sleeve (not hand)
    copy(32, 48, 47, 63, 16, 0, lambda c: not is_skin(c))    # L sleeve (not hand)
    copy(0, 16, 15, 31, 0, 16, is_pants)                     # R pants (not shoe/belt)
    copy(16, 48, 31, 63, -16, 0, is_pants)                   # L pants (not shoe/belt)
    return im

# ----------------------------------------------------------------- render
def front_render(im, arm_w, out, scale=20):
    def grab(x, y, w, h): return im.crop((x, y, x+w, y+h))
    cw, ch = 16, 32
    canvas = Image.new("RGBA", (cw, ch), (44, 48, 56, 255))
    bx = 4
    canvas.alpha_composite(grab(8, 8, 8, 8), (bx, 0))
    canvas.alpha_composite(grab(40, 8, 8, 8), (bx, 0))
    canvas.alpha_composite(grab(20, 20, 8, 12), (bx, 8))
    canvas.alpha_composite(grab(20, 36, 8, 12), (bx, 8))           # jacket
    canvas.alpha_composite(grab(44, 20, arm_w, 12), (bx-arm_w, 8))
    canvas.alpha_composite(grab(44, 36, arm_w, 12), (bx-arm_w, 8)) # R sleeve ov
    canvas.alpha_composite(grab(36, 52, arm_w, 12), (bx+8, 8))
    canvas.alpha_composite(grab(52, 52, arm_w, 12), (bx+8, 8))     # L sleeve ov
    canvas.alpha_composite(grab(4, 20, 4, 12), (bx, 20))
    canvas.alpha_composite(grab(4, 36, 4, 12), (bx, 20))           # R pants ov
    canvas.alpha_composite(grab(20, 52, 4, 12), (bx+4, 20))
    canvas.alpha_composite(grab(4, 52, 4, 12), (bx+4, 20))         # L pants ov
    canvas.resize((cw*scale, ch*scale), Image.NEAREST).save(out)

# ----------------------------------------------------------------- outputs
for slim, tag, arm_w in [(False, "", 4), (True, "-slim", 3)]:
    base = build(slim)
    base.save(f"clay-minecraft-skin{tag}.png", "PNG")
    front_render(base, arm_w, f"clay-minecraft-skin{tag}-frontrender.png")
    base.resize((256, 256), Image.NEAREST).save(f"clay-minecraft-skin{tag}-preview.png")
    # 3D variant
    base3d = build(slim)
    add_overlays(base3d)
    base3d.save(f"clay-minecraft-skin-3d{tag}.png", "PNG")
    front_render(base3d, arm_w, f"clay-minecraft-skin-3d{tag}-render.png")
    print(f"built classic/slim={slim}: skin + 3d + renders")
print("done")
