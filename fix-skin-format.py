"""Re-encode the generated skins into the SAME format as Clay's proven-working
reference skin: 8-bit PALETTE PNG (colortype 3) with a tRNS transparent index 0,
<=255 colors, binary alpha, no dither, no extra chunks. Geometry is untouched.

This matches minecraft.fandom UV spec AND the exact encoding of the file Clay
confirmed loads, eliminating RGBA/colortype as a possible cause.
"""
from PIL import Image

FILES = [
    "clay-minecraft-skin.png",
    "clay-minecraft-skin-slim.png",
    "clay-minecraft-skin-3d.png",
    "clay-minecraft-skin-3d-slim.png",
]

def to_skin_palette(rgba):
    """RGBA -> P mode, index 0 = transparent (tRNS len 1), opaque colors 1..255."""
    im = rgba.convert("RGBA")
    w, h = im.size
    apx = im.load()
    # opaque RGB (transparent -> black placeholder), quantize to <=255 colors, no dither
    rgb = Image.new("RGB", (w, h))
    opx = rgb.load()
    for y in range(h):
        for x in range(w):
            r, g, b, a = apx[x, y]
            opx[x, y] = (r, g, b) if a == 255 else (0, 0, 0)
    q = rgb.quantize(colors=255, dither=Image.Dither.NONE)
    qpx = q.load()
    qpal = q.getpalette()[:255 * 3]            # up to 255 colors

    out = Image.new("P", (w, h))
    npx = out.load()
    for y in range(h):
        for x in range(w):
            npx[x, y] = 0 if apx[x, y][3] == 0 else qpx[x, y] + 1   # shift opaque to 1..255
    out.putpalette([0, 0, 0] + qpal)           # index 0 reserved for transparency
    out.info["transparency"] = 0               # PIL writes tRNS marking index 0 transparent
    return out

for f in FILES:
    before = Image.open(f).convert("RGBA")
    pal = to_skin_palette(before)
    pal.save(f, "PNG", optimize=True, transparency=0)
    # verify round-trip equality of the visible image (alpha + RGB where opaque)
    after = Image.open(f).convert("RGBA")
    bpx, apx = before.load(), after.load()
    mismatch = 0
    for y in range(64):
        for x in range(64):
            ba, aa = bpx[x, y], apx[x, y]
            if (ba[3] == 0) != (aa[3] == 0):
                mismatch += 1                  # transparency must match exactly
    print(f"{f:34s} -> {after.mode}  transparency-mismatches={mismatch}")
print("done")
