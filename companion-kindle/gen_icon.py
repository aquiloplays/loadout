"""Generate the aurora key+book tray icon + .ico (no emoji, pure draw).

  python gen_icon.py

Writes assets/tray-64.png and assets/key.ico. Run once; the outputs are
committed so the build does not depend on regenerating them.
"""
import os

from PIL import Image, ImageDraw

OUT = os.path.join(os.path.dirname(os.path.abspath(__file__)), "assets")
# Aurora stops: violet -> teal -> green.
A = (0x9a, 0x82, 0xff)
B = (0x22, 0xd3, 0xee)
C = (0x5b, 0xff, 0x95)


def _lerp(c1, c2, t):
    return tuple(int(c1[i] + (c2[i] - c1[i]) * t) for i in range(3))


def _aurora(size):
    img = Image.new("RGBA", (size, size), (0, 0, 0, 0))
    px = img.load()
    for y in range(size):
        t = y / max(1, size - 1)
        col = _lerp(A, B, t * 2) if t < 0.5 else _lerp(B, C, (t - 0.5) * 2)
        for x in range(size):
            px[x, y] = (col[0], col[1], col[2], 255)
    # rounded-square mask
    mask = Image.new("L", (size, size), 0)
    ImageDraw.Draw(mask).rounded_rectangle([0, 0, size - 1, size - 1], radius=int(size * 0.22), fill=255)
    out = Image.new("RGBA", (size, size), (0, 0, 0, 0))
    out.paste(img, (0, 0), mask)
    return out


def _glyph(img):
    """Draw a book (lower-left) + key (upper-right) in soft white."""
    size = img.width
    d = ImageDraw.Draw(img)
    w = (255, 255, 255, 235)
    s = size / 256.0
    # Book: cover + spine + a couple of page lines.
    d.rounded_rectangle([40 * s, 120 * s, 150 * s, 210 * s], radius=10 * s, fill=w)
    d.line([95 * s, 128 * s, 95 * s, 202 * s], fill=B + (255,), width=int(4 * s))
    for i, yy in enumerate((150, 168, 186)):
        d.line([55 * s, yy * s, 86 * s, yy * s], fill=B + (180,), width=int(3 * s))
        d.line([104 * s, yy * s, 135 * s, yy * s], fill=B + (180,), width=int(3 * s))
    # Key: bow (ring) + stem + teeth, top-right.
    d.ellipse([150 * s, 44 * s, 200 * s, 94 * s], outline=w, width=int(12 * s))
    d.line([175 * s, 92 * s, 175 * s, 150 * s], fill=w, width=int(11 * s))
    d.line([175 * s, 150 * s, 200 * s, 150 * s], fill=w, width=int(11 * s))
    d.line([175 * s, 130 * s, 195 * s, 130 * s], fill=w, width=int(9 * s))
    return img


def main():
    os.makedirs(OUT, exist_ok=True)
    master = _glyph(_aurora(256))
    master.save(os.path.join(OUT, "tray-256.png"))
    master.resize((64, 64), Image.LANCZOS).save(os.path.join(OUT, "tray-64.png"))
    master.save(os.path.join(OUT, "key.ico"),
                sizes=[(16, 16), (32, 32), (48, 48), (64, 64), (128, 128), (256, 256)])
    print("wrote tray-64.png, tray-256.png, key.ico to", OUT)


if __name__ == "__main__":
    main()
