"""3D Skin Layers mod-optimized variant of Clay's skin.

The 3D Skin Layers mod (tr7zw) extrudes the SECOND (overlay) layer of a skin
into real 3D geometry, offset out from the body. A skin "designed for" the mod
therefore needs meaningful, solid content on the overlay layers:
  - hat layer    -> 3D hair + 3D glasses + 3D beard
  - jacket layer -> 3D button-up shirt
  - sleeve layers-> 3D rolled sleeves (forearms/hands stay flat skin)
  - pants layers -> 3D pant legs (shoes stay flat)

Each overlay is copied from / matched to the base directly beneath it, so the
skin still renders correctly in vanilla (no mod): the overlay just sits flush.
With the mod installed, those layers lift off the body in 3D.

Takes the already-built base skins and adds the overlay content.
"""
from PIL import Image

# palette constants (must match the base builders exactly for color-keyed copy)
SKIN      = (240, 200, 168, 255)
SKIN_SH   = (214, 172, 140, 255)
SKIN_HI   = (250, 214, 184, 255)
HAIR      = (58, 38, 26, 255)
HAIR_HI   = (80, 54, 38, 255)
BEARD     = (74, 50, 36, 255)
GLASS     = (26, 24, 28, 255)
LENS      = (150, 168, 182, 255)
PANTS     = (203, 180, 138, 255)
PANTS_SH  = (182, 158, 118, 255)
STRIPES = [
    (228, 116, 150, 255), (92, 184, 196, 255), (236, 234, 224, 255),
    (122, 182, 112, 255), (96, 124, 206, 255), (236, 162, 92, 255),
]
HAIRSET  = {HAIR, HAIR_HI, BEARD}
STRIPESET = set(STRIPES)
PANTSET  = {PANTS, PANTS_SH}


def add_overlays(im):
    px = im.load()

    def copy(x0, y0, x1, y1, dx, dy, pred):
        # snapshot source first (some copies overlap their own region's row range)
        src = {}
        for y in range(y0, y1 + 1):
            for x in range(x0, x1 + 1):
                src[(x, y)] = px[x, y]
        for (x, y), c in src.items():
            if c[3] != 0 and pred(c):
                px[x + dx, y + dy] = c

    # HAT layer: hair + beard from the whole head block, shifted +32 in x.
    # (glasses are already on the hat front from the base build)
    copy(0, 0, 31, 15, 32, 0, lambda c: c in HAIRSET)

    # JACKET layer: entire shirt (body base -> +16 in y) = full 3D shirt
    copy(16, 16, 39, 31, 0, 16, lambda c: True)

    # SLEEVE layers: only the striped sleeve pixels (forearms/hands stay flat)
    copy(40, 16, 55, 31, 0, 16, lambda c: c in STRIPESET)   # right arm -> sleeve
    copy(32, 48, 47, 63, 16, 0, lambda c: c in STRIPESET)   # left arm  -> sleeve

    # PANTS layers: only the khaki pixels (shoes stay flat, no clown-shoe 3D)
    copy(0, 16, 15, 31, 0, 16, lambda c: c in PANTSET)      # right leg -> pants
    copy(16, 48, 31, 63, -16, 0, lambda c: c in PANTSET)    # left leg  -> pants

    return im


def faux_3d_render(im, arm_w, out_path):
    """Illustrative render: base front view with the 2nd-layer front faces
    drawn raised + shadowed, to communicate the in-game 3D pop."""
    S = 18
    def grab(x0, y0, w, h):
        return im.crop((x0, y0, x0 + w, y0 + h))

    cw = 4 + 8 + 4
    ch = 8 + 12 + 12
    base = Image.new("RGBA", (cw, ch), (0, 0, 0, 0))
    ax = (8 - arm_w)  # arm left x in canvas (3 for slim-ish gap)... keep centered
    body_x = 4
    # ---- BASE front faces ----
    base.alpha_composite(grab(8, 8, 8, 8), (body_x, 0))            # head
    base.alpha_composite(grab(20, 20, 8, 12), (body_x, 8))         # body
    base.alpha_composite(grab(44, 20, arm_w, 12), (body_x - arm_w, 8))  # R arm
    base.alpha_composite(grab(36, 52, arm_w, 12), (body_x + 8, 8))      # L arm
    base.alpha_composite(grab(4, 20, 4, 12), (body_x, 20))        # R leg
    base.alpha_composite(grab(20, 52, 4, 12), (body_x + 4, 20))   # L leg

    big = base.resize((cw * S, ch * S), Image.NEAREST)
    canvas = Image.new("RGBA", (cw * S, ch * S), (44, 48, 56, 255))
    canvas.alpha_composite(big)

    # overlay (2nd layer) front faces, drawn enlarged + shadow = "raised"
    overlays = [
        (grab(40, 8, 8, 8), (body_x, 0)),         # hat front (hair/glasses/beard)
        (grab(20, 36, 8, 12), (body_x, 8)),       # jacket front (shirt)
        (grab(44, 36, arm_w, 12), (body_x - arm_w, 8)),  # R sleeve
        (grab(52, 52, arm_w, 12), (body_x + 8, 8)),      # L sleeve
        (grab(4, 36, 4, 12), (body_x, 20)),       # R pants
        (grab(4, 52, 4, 12), (body_x + 4, 20)),   # L pants
    ]
    pad = 3
    for face, (cxp, cyp) in overlays:
        w, h = face.size
        if w == 0 or h == 0:
            continue
        big_face = face.resize((w * S + 2 * pad, h * S + 2 * pad), Image.NEAREST)
        # shadow
        sh = Image.new("RGBA", big_face.size, (0, 0, 0, 0))
        shpx = sh.load(); bfpx = big_face.load()
        for yy in range(big_face.size[1]):
            for xx in range(big_face.size[0]):
                if bfpx[xx, yy][3] != 0:
                    shpx[xx, yy] = (0, 0, 0, 90)
        canvas.alpha_composite(sh, (cxp * S - pad + 5, cyp * S - pad + 6))
        canvas.alpha_composite(big_face, (cxp * S - pad - 2, cyp * S - pad - 3))

    canvas.save(out_path, "PNG")


# ---- build classic 3D ----
for src, out, arm_w, render in [
    ("clay-minecraft-skin.png",      "clay-minecraft-skin-3d.png",      4,
     "clay-minecraft-skin-3d-render.png"),
    ("clay-minecraft-skin-slim.png", "clay-minecraft-skin-3d-slim.png", 3,
     "clay-minecraft-skin-3d-slim-render.png"),
]:
    base = Image.open(src).convert("RGBA")
    add_overlays(base)
    base.save(out, "PNG")
    print("saved", out, base.size, base.mode)
    faux_3d_render(base, arm_w, render)
    print("render", render)
