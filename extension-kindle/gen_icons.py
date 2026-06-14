"""Generate the aurora key+book extension icons (no emoji, pure draw).

  python gen_icons.py

Writes icons/icon-{16,32,48,128}.png. Run once; outputs are committed.
"""
import os

from PIL import Image, ImageDraw

OUT = os.path.join(os.path.dirname(os.path.abspath(__file__)), "icons")
A = (0x9a, 0x82, 0xff)
B = (0x22, 0xd3, 0xee)
C = (0x5b, 0xff, 0x95)


def _lerp(c1, c2, t):
    return tuple(int(c1[i] + (c2[i] - c1[i]) * t) for i in range(3))


def _master(size=256):
    img = Image.new("RGBA", (size, size), (0, 0, 0, 0))
    px = img.load()
    for y in range(size):
        t = y / max(1, size - 1)
        col = _lerp(A, B, t * 2) if t < 0.5 else _lerp(B, C, (t - 0.5) * 2)
        for x in range(size):
            px[x, y] = (col[0], col[1], col[2], 255)
    mask = Image.new("L", (size, size), 0)
    ImageDraw.Draw(mask).rounded_rectangle([0, 0, size - 1, size - 1], radius=int(size * 0.22), fill=255)
    out = Image.new("RGBA", (size, size), (0, 0, 0, 0))
    out.paste(img, (0, 0), mask)
    d = ImageDraw.Draw(out)
    w = (255, 255, 255, 235)
    s = size / 256.0
    # book
    d.rounded_rectangle([40 * s, 120 * s, 150 * s, 210 * s], radius=10 * s, fill=w)
    d.line([95 * s, 128 * s, 95 * s, 202 * s], fill=B + (255,), width=max(1, int(4 * s)))
    for yy in (150, 168, 186):
        d.line([55 * s, yy * s, 86 * s, yy * s], fill=B + (180,), width=max(1, int(3 * s)))
        d.line([104 * s, yy * s, 135 * s, yy * s], fill=B + (180,), width=max(1, int(3 * s)))
    # key
    d.ellipse([150 * s, 44 * s, 200 * s, 94 * s], outline=w, width=max(2, int(12 * s)))
    d.line([175 * s, 92 * s, 175 * s, 150 * s], fill=w, width=max(2, int(11 * s)))
    d.line([175 * s, 150 * s, 200 * s, 150 * s], fill=w, width=max(2, int(11 * s)))
    d.line([175 * s, 130 * s, 195 * s, 130 * s], fill=w, width=max(1, int(9 * s)))
    return out


def main():
    os.makedirs(OUT, exist_ok=True)
    master = _master(256)
    for sz in (16, 32, 48, 128):
        master.resize((sz, sz), Image.LANCZOS).save(os.path.join(OUT, f"icon-{sz}.png"))
    print("wrote icon-16/32/48/128.png to", OUT)


if __name__ == "__main__":
    main()
