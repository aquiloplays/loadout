"""Generate a Minecraft player skin (Java 1.8+, 64x64, classic arms) for Clay.
Hand-painted from photo-sampled colors: light skin, dark brown hair+beard,
black-frame glasses, colorful vertical-striped button-up, khaki pants.
"""
from PIL import Image

W = H = 64
img = Image.new("RGBA", (W, H), (0, 0, 0, 0))
px = img.load()

# ---- palette (sampled / tuned from photo) ----
SKIN      = (240, 200, 168, 255)
SKIN_SH   = (214, 172, 140, 255)   # shadowed skin
SKIN_HI   = (250, 214, 184, 255)
HAIR      = (58, 38, 26, 255)
HAIR_HI   = (80, 54, 38, 255)
BEARD     = (74, 50, 36, 255)
GLASS     = (26, 24, 28, 255)
EYE       = (64, 48, 40, 255)
PANTS     = (203, 180, 138, 255)
PANTS_SH  = (182, 158, 118, 255)
SHOE      = (84, 66, 52, 255)
SHOE_SH   = (66, 50, 40, 255)
NEUTRAL   = (0, 0, 0, 0)

# vibrant vertical-stripe palette for the button-up
STRIPES = [
    (228, 116, 150, 255),  # pink
    (92, 184, 196, 255),   # teal/cyan
    (236, 234, 224, 255),  # white
    (122, 182, 112, 255),  # green
    (96, 124, 206, 255),   # blue
    (236, 162, 92, 255),   # warm orange
]

def rect(x0, y0, x1, y1, c):
    for y in range(y0, y1 + 1):
        for x in range(x0, x1 + 1):
            px[x, y] = c

def stripe_color(col):
    """vertical stripe -> color by column index"""
    return STRIPES[col % len(STRIPES)]

def fill_stripes(x0, y0, x1, y1, top_rows_collar=False):
    """fill a face region with vertical stripes (column = x)"""
    for x in range(x0, x1 + 1):
        c = stripe_color(x - x0)
        for y in range(y0, y1 + 1):
            px[x, y] = c

# =====================================================================
# HEAD  (front face at 8,8)-(15,15)
# =====================================================================
# head top -> hair
rect(8, 0, 15, 7, HAIR)
# head bottom -> neck/skin
rect(16, 0, 23, 7, SKIN_SH)

# head right side (0,8)-(7,15)
rect(0, 8, 7, 15, SKIN)
rect(0, 8, 7, 9, HAIR)          # hair on top
px_set = None
rect(0, 14, 7, 15, BEARD)       # jaw/beard low
# head left side (16,8)-(23,15)
rect(16, 8, 23, 15, SKIN)
rect(16, 8, 23, 9, HAIR)
rect(16, 14, 23, 15, BEARD)
# head back (24,8)-(31,15)
rect(24, 8, 31, 15, HAIR)
rect(24, 13, 31, 15, SKIN_SH)   # neck at back-bottom

# ---- FACE FRONT (8,8)-(15,15), local 0..7 ----
fx, fy = 8, 8
def F(col, row, c):
    px[fx + col, fy + row] = c

# base skin fill
rect(8, 8, 15, 15, SKIN)
# hair fringe rows 0-1
for col in range(8):
    F(col, 0, HAIR if col not in (0,) else HAIR_HI)
    F(col, 1, HAIR)
# hair sides row 2 (temples)
F(0, 2, HAIR); F(7, 2, HAIR)
# brow shading row2 slight
# eyes row 3 (under glasses) cols 2 and 5
F(2, 3, EYE); F(5, 3, EYE)
F(1, 3, SKIN_HI); F(6, 3, SKIN_HI)
# cheeks row4 subtle highlight
F(3, 4, SKIN_HI); F(4, 4, SKIN_HI)
# nose hint row4 center-bottom
F(3, 5, SKIN_SH)
# beard: sideburns + jaw + chin
F(0, 4, BEARD); F(7, 4, BEARD)        # sideburns
F(0, 5, BEARD); F(7, 5, BEARD)
F(0, 6, BEARD); F(1, 6, BEARD); F(6, 6, BEARD); F(7, 6, BEARD)
rect(8, 8+7, 15, 8+7, BEARD)          # chin full beard row7
F(0, 5, BEARD)
# mustache row5 (cols1-2 and 5-6)
F(1, 5, BEARD); F(6, 5, BEARD)
# mouth gap row6 center stays skin
F(3, 6, SKIN_SH); F(4, 6, SKIN_SH)

# =====================================================================
# HAT / HEAD OVERLAY  (front at 40,8)-(47,15)  -> glasses
# =====================================================================
hx, hy = 40, 8
LENS = (150, 168, 182, 255)           # subtle glass tint
def Hv(col, row, c):
    px[hx + col, hy + row] = c
# clean two-lens glasses on eye row (row3): frame black, lens centers tinted, bridge + temples
Hv(0, 3, GLASS)                       # left temple
Hv(1, 3, GLASS)                       # left lens frame
Hv(2, 3, LENS)                        # left lens glass (over eye)
Hv(3, 3, GLASS)                       # bridge
Hv(4, 3, GLASS)                       # bridge
Hv(5, 3, LENS)                        # right lens glass (over eye)
Hv(6, 3, GLASS)                       # right lens frame
Hv(7, 3, GLASS)                       # right temple

# =====================================================================
# BODY  (front 8x12 at 20,20)-(27,31)
# =====================================================================
# front shirt stripes
fill_stripes(20, 20, 27, 31)
# collar: top row darker / skin neck hint
for x in range(20, 28):
    # keep stripe but darken top row slightly as collar fold
    c = stripe_color(x - 20)
    px[x, 20] = tuple(max(0, v - 30) if i < 3 else 255 for i, v in enumerate(c))
# back (32,20)-(39,31) stripes
fill_stripes(32, 20, 39, 31)
# right side (16,20)-(19,31)
for x in range(16, 20):
    c = stripe_color((x - 16))
    rect(x, 20, x, 31, c)
# left side (28,20)-(31,31)
for x in range(28, 32):
    c = stripe_color((x - 28) + 4)
    rect(x, 20, x, 31, c)
# body top (20,16)-(27,19) shoulders -> stripe tops
fill_stripes(20, 16, 27, 19)
# body bottom (28,16)-(35,19) -> shirt hem / pants waistband
rect(28, 16, 35, 19, PANTS_SH)

# =====================================================================
# RIGHT ARM (classic 4px) front (44,20)-(47,31)
# sleeve top ~5 rows stripes, forearm+hand skin
# =====================================================================
def arm(front_x0, front_y0, right_x0, top_x0, bottom_x0, back_x0, sleeve_off):
    # front
    for x in range(front_x0, front_x0 + 4):
        c = stripe_color((x - front_x0) + sleeve_off)
        rect(x, front_y0, x, front_y0 + 4, c)            # sleeve
        rect(x, front_y0 + 5, x, front_y0 + 11, SKIN)    # bare forearm + hand
    # mark hand bottom 2 rows slightly shadow
    rect(front_x0, front_y0 + 10, front_x0 + 3, front_y0 + 11, SKIN_SH)

# RIGHT ARM cube faces (top16): top(44,16),bottom(48,16),right(40,20),front(44,20),left(48,20),back(52,20)
# right face (skin/sleeve)
rect(40, 20, 43, 24, STRIPES[5]); rect(40, 25, 43, 31, SKIN)
# front face
for x in range(44, 48):
    c = stripe_color((x - 44))
    rect(x, 20, x, 24, c)
    rect(x, 25, x, 31, SKIN)
rect(44, 30, 47, 31, SKIN_SH)     # hand
# left face
rect(48, 20, 51, 24, STRIPES[2]); rect(48, 25, 51, 31, SKIN)
# back face
for x in range(52, 56):
    c = stripe_color((x - 52) + 3)
    rect(x, 20, x, 24, c)
    rect(x, 25, x, 31, SKIN)
# arm top (shoulder) sleeve
rect(44, 16, 47, 19, STRIPES[0])
# arm bottom (hand underside) skin
rect(48, 16, 51, 19, SKIN_SH)

# =====================================================================
# LEFT ARM (1.8+) top48: top(36,48),bottom(40,48),right(32,52),front(36,52),left(40,52),back(44,52)
# =====================================================================
rect(32, 52, 35, 56, STRIPES[1]); rect(32, 57, 35, 63, SKIN)        # right
for x in range(36, 40):                                            # front
    c = stripe_color((x - 36) + 2)
    rect(x, 52, x, 56, c)
    rect(x, 57, x, 63, SKIN)
rect(36, 62, 39, 63, SKIN_SH)                                       # hand
rect(40, 52, 43, 56, STRIPES[4]); rect(40, 57, 43, 63, SKIN)        # left
for x in range(44, 48):                                            # back
    c = stripe_color((x - 44) + 1)
    rect(x, 52, x, 56, c)
    rect(x, 57, x, 63, SKIN)
rect(36, 48, 39, 51, STRIPES[3])                                    # top sleeve
rect(40, 48, 43, 51, SKIN_SH)                                       # bottom hand

# =====================================================================
# RIGHT LEG  top16: top(4,16),bottom(8,16),right(0,20),front(4,20),left(8,20),back(12,20)
# khaki pants + brown shoe bottom 2 rows
# =====================================================================
def leg(rx, fx_, lx, bx, topx, botx):
    rect(rx, 20, rx + 3, 31, PANTS)      # right
    rect(fx_, 20, fx_ + 3, 31, PANTS)    # front
    rect(lx, 20, lx + 3, 31, PANTS_SH)   # left (shadow side)
    rect(bx, 20, bx + 3, 31, PANTS_SH)   # back
    # shoes bottom 2 rows on all 4 side faces
    for (sx) in (rx, fx_, lx, bx):
        rect(sx, 30, sx + 3, 31, SHOE)
    rect(topx, 16, topx + 3, 19, PANTS)  # top (waist)
    rect(botx, 16, botx + 3, 19, SHOE_SH)  # bottom (sole)

leg(0, 4, 8, 12, 4, 8)     # right leg
# LEFT LEG (1.8+) top48: top(20,48),bottom(24,48),right(16,52),front(20,52),left(24,52),back(28,52)
rect(16, 52, 19, 63, PANTS)
rect(20, 52, 23, 63, PANTS)
rect(24, 52, 27, 63, PANTS_SH)
rect(28, 52, 31, 63, PANTS_SH)
for sx in (16, 20, 24, 28):
    rect(sx, 62, sx + 3, 63, SHOE)
rect(20, 48, 23, 51, PANTS)
rect(24, 48, 27, 51, SHOE_SH)

# =====================================================================
out = r"C:\Users\bishe\Desktop\Aquilo\Loadout\clay-minecraft-skin.png"
img.save(out, "PNG")
print("saved", out, img.size, img.mode)

# preview 256x256 nearest-neighbor
prev = img.resize((256, 256), Image.NEAREST)
pout = r"C:\Users\bishe\Desktop\Aquilo\Loadout\clay-minecraft-skin-preview.png"
prev.convert("RGBA").save(pout, "PNG")
print("preview", pout, prev.size)
