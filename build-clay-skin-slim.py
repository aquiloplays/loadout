"""Slim (Alex, 3px arms) variant of Clay's Minecraft skin.
Identical head/body/legs to the classic build; only the arm UV regions differ
(front/back arm faces are 3px wide instead of 4px).
"""
from PIL import Image

W = H = 64
img = Image.new("RGBA", (W, H), (0, 0, 0, 0))
px = img.load()

SKIN      = (240, 200, 168, 255)
SKIN_SH   = (214, 172, 140, 255)
SKIN_HI   = (250, 214, 184, 255)
HAIR      = (58, 38, 26, 255)
HAIR_HI   = (80, 54, 38, 255)
BEARD     = (74, 50, 36, 255)
GLASS     = (26, 24, 28, 255)
EYE       = (64, 48, 40, 255)
LENS      = (150, 168, 182, 255)
PANTS     = (203, 180, 138, 255)
PANTS_SH  = (182, 158, 118, 255)
SHOE      = (84, 66, 52, 255)
SHOE_SH   = (66, 50, 40, 255)
STRIPES = [
    (228, 116, 150, 255), (92, 184, 196, 255), (236, 234, 224, 255),
    (122, 182, 112, 255), (96, 124, 206, 255), (236, 162, 92, 255),
]

def rect(x0, y0, x1, y1, c):
    for y in range(y0, y1 + 1):
        for x in range(x0, x1 + 1):
            px[x, y] = c

def stripe_color(col):
    return STRIPES[col % len(STRIPES)]

def fill_stripes(x0, y0, x1, y1):
    for x in range(x0, x1 + 1):
        c = stripe_color(x - x0)
        for y in range(y0, y1 + 1):
            px[x, y] = c

# ===== HEAD (identical to classic) =====
rect(8, 0, 15, 7, HAIR)
rect(16, 0, 23, 7, SKIN_SH)
rect(0, 8, 7, 15, SKIN); rect(0, 8, 7, 9, HAIR); rect(0, 14, 7, 15, BEARD)
rect(16, 8, 23, 15, SKIN); rect(16, 8, 23, 9, HAIR); rect(16, 14, 23, 15, BEARD)
rect(24, 8, 31, 15, HAIR); rect(24, 13, 31, 15, SKIN_SH)

fx, fy = 8, 8
def F(col, row, c): px[fx + col, fy + row] = c
rect(8, 8, 15, 15, SKIN)
for col in range(8):
    F(col, 0, HAIR if col else HAIR_HI); F(col, 1, HAIR)
F(0, 2, HAIR); F(7, 2, HAIR)
F(2, 3, EYE); F(5, 3, EYE); F(1, 3, SKIN_HI); F(6, 3, SKIN_HI)
F(3, 4, SKIN_HI); F(4, 4, SKIN_HI); F(3, 5, SKIN_SH)
F(0, 4, BEARD); F(7, 4, BEARD); F(0, 5, BEARD); F(7, 5, BEARD)
F(0, 6, BEARD); F(1, 6, BEARD); F(6, 6, BEARD); F(7, 6, BEARD)
rect(8, 15, 15, 15, BEARD)
F(1, 5, BEARD); F(6, 5, BEARD); F(3, 6, SKIN_SH); F(4, 6, SKIN_SH)

# hat overlay: glasses
hx, hy = 40, 8
def Hv(col, row, c): px[hx + col, hy + row] = c
Hv(0,3,GLASS); Hv(1,3,GLASS); Hv(2,3,LENS); Hv(3,3,GLASS)
Hv(4,3,GLASS); Hv(5,3,LENS); Hv(6,3,GLASS); Hv(7,3,GLASS)

# ===== BODY (identical) =====
fill_stripes(20, 20, 27, 31)
for x in range(20, 28):
    c = stripe_color(x - 20)
    px[x, 20] = tuple(max(0, v - 30) if i < 3 else 255 for i, v in enumerate(c))
fill_stripes(32, 20, 39, 31)
for x in range(16, 20): rect(x, 20, x, 31, stripe_color(x - 16))
for x in range(28, 32): rect(x, 20, x, 31, stripe_color((x - 28) + 4))
fill_stripes(20, 16, 27, 19)
rect(28, 16, 35, 19, PANTS_SH)

# ===== SLIM RIGHT ARM (3px wide) top16 =====
# right face (40,20)-(43,31) depth4 ; front (44,20)-(46,31) 3w ;
# left (47,20)-(50,31) depth4 ; back (51,20)-(53,31) 3w
# top (44,16)-(46,19) 3w ; bottom (47,16)-(49,19) 3w
def sleeve_skin(x0, x1, base_off):
    for x in range(x0, x1 + 1):
        c = stripe_color((x - x0) + base_off)
        rect(x, 20, x, 24, c)      # sleeve (5 rows)
        rect(x, 25, x, 31, SKIN)   # bare forearm + hand
# right arm
rect(40, 20, 43, 24, STRIPES[5]); rect(40, 25, 43, 31, SKIN)      # right face
sleeve_skin(44, 46, 0)                                            # front 3w
rect(44, 30, 46, 31, SKIN_SH)                                     # hand shadow
rect(47, 20, 50, 24, STRIPES[2]); rect(47, 25, 50, 31, SKIN)     # left face
sleeve_skin(51, 53, 3)                                            # back 3w
rect(44, 16, 46, 19, STRIPES[0])                                 # top sleeve
rect(47, 16, 49, 19, SKIN_SH)                                    # bottom hand

# ===== SLIM LEFT ARM (3px wide) top48 =====
# right (32,52)-(35,63) depth4 ; front (36,52)-(38,63) 3w ;
# left (39,52)-(42,63) depth4 ; back (43,52)-(45,63) 3w
# top (36,48)-(38,51) 3w ; bottom (39,48)-(41,51) 3w
def sleeve_skin2(x0, x1, base_off):
    for x in range(x0, x1 + 1):
        c = stripe_color((x - x0) + base_off)
        rect(x, 52, x, 56, c)
        rect(x, 57, x, 63, SKIN)
rect(32, 52, 35, 56, STRIPES[1]); rect(32, 57, 35, 63, SKIN)     # right
sleeve_skin2(36, 38, 2)                                          # front 3w
rect(36, 62, 38, 63, SKIN_SH)                                    # hand shadow
rect(39, 52, 42, 56, STRIPES[4]); rect(39, 57, 42, 63, SKIN)    # left
sleeve_skin2(43, 45, 1)                                          # back 3w
rect(36, 48, 38, 51, STRIPES[3])                                # top sleeve
rect(39, 48, 41, 51, SKIN_SH)                                   # bottom hand

# ===== LEGS (identical) =====
def leg(rx, fx_, lx, bx, topx, botx):
    rect(rx, 20, rx + 3, 31, PANTS)
    rect(fx_, 20, fx_ + 3, 31, PANTS)
    rect(lx, 20, lx + 3, 31, PANTS_SH)
    rect(bx, 20, bx + 3, 31, PANTS_SH)
    for sx in (rx, fx_, lx, bx): rect(sx, 30, sx + 3, 31, SHOE)
    rect(topx, 16, topx + 3, 19, PANTS)
    rect(botx, 16, botx + 3, 19, SHOE_SH)
leg(0, 4, 8, 12, 4, 8)
rect(16, 52, 19, 63, PANTS); rect(20, 52, 23, 63, PANTS)
rect(24, 52, 27, 63, PANTS_SH); rect(28, 52, 31, 63, PANTS_SH)
for sx in (16, 20, 24, 28): rect(sx, 62, sx + 3, 63, SHOE)
rect(20, 48, 23, 51, PANTS); rect(24, 48, 27, 51, SHOE_SH)

out = r"C:\Users\bishe\Desktop\Aquilo\Loadout\clay-minecraft-skin-slim.png"
img.save(out, "PNG")
print("saved", out, img.size, img.mode)
img.resize((256, 256), Image.NEAREST).save(
    r"C:\Users\bishe\Desktop\Aquilo\Loadout\clay-minecraft-skin-slim-preview.png", "PNG")

# slim front render (arms 3px wide)
S = 16
def grab(x0, y0, w, h): return img.crop((x0, y0, x0 + w, y0 + h))
cw, ch = 14, 32   # 3+8+3 arms/body
canvas = Image.new("RGBA", (cw, ch), (40, 44, 52, 255))
canvas.alpha_composite(grab(8, 8, 8, 8), (3, 0))
canvas.alpha_composite(grab(40, 8, 8, 8), (3, 0))
canvas.alpha_composite(grab(20, 20, 8, 12), (3, 8))
canvas.alpha_composite(grab(44, 20, 3, 12), (0, 8))    # right arm 3w
canvas.alpha_composite(grab(36, 52, 3, 12), (11, 8))   # left arm 3w
canvas.alpha_composite(grab(4, 20, 4, 12), (3, 20))
canvas.alpha_composite(grab(20, 52, 4, 12), (7, 20))
canvas.resize((cw * S, ch * S), Image.NEAREST).save(
    r"C:\Users\bishe\Desktop\Aquilo\Loadout\clay-minecraft-skin-slim-frontrender.png")
print("render done")
