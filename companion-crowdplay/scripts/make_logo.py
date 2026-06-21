"""Generate the Aquilo CrowdPlay logo at multiple sizes.

Produces:
  companion_crowdplay/assets/logo.png      (256x256, used for QApp.windowIcon)
  companion_crowdplay/assets/logo.ico      (16/32/48/64/128/256, used for the .exe)

Pure Pillow + simple polygon math so the logo is reproducible from CI without
a designer in the loop.
"""
from __future__ import annotations
import math
from pathlib import Path
from PIL import Image, ImageDraw, ImageFilter


HERE = Path(__file__).resolve().parent.parent / "companion_crowdplay" / "assets"
HERE.mkdir(parents=True, exist_ok=True)


# Brand colours (mirror theme.py + dock vars).
INK_DEEP = (10, 11, 18)
VIOLET   = (124, 92, 255)
VIOLET2  = (154, 130, 255)
DEEP_PURP= (58, 31, 138)
TEAL     = (34, 211, 238)
HILITE   = (212, 194, 255)


def lerp(a, b, t):
    return tuple(int(a[i] + (b[i] - a[i]) * t) for i in range(3))


def draw_logo(size: int) -> Image.Image:
    """Render the logo at `size` px. Anti-aliased by drawing 4x then downscaling."""
    SCALE = 4
    s = size * SCALE
    img = Image.new("RGBA", (s, s), (0, 0, 0, 0))
    d = ImageDraw.Draw(img)

    # Rounded card body with a vertical aurora gradient.
    radius = int(s * 0.22)
    # Build the gradient via a per-row solid rect (Pillow can't do gradients
    # natively; this is cheap at 4x size).
    grad = Image.new("RGB", (s, s), INK_DEEP)
    for y in range(s):
        t = y / max(1, s - 1)
        # Top: lifted violet wash; middle: ink; bottom: teal whisper.
        if t < 0.5:
            row = lerp(INK_DEEP, (40, 30, 70), t / 0.5)
        else:
            row = lerp((40, 30, 70), INK_DEEP, (t - 0.5) / 0.5)
        ImageDraw.Draw(grad).line([(0, y), (s, y)], fill=row)
    # Mask to rounded rect.
    mask = Image.new("L", (s, s), 0)
    ImageDraw.Draw(mask).rounded_rectangle(
        (0, 0, s - 1, s - 1), radius=radius, fill=255
    )
    img.paste(grad, (0, 0), mask)

    # Inner accent ring.
    inner_pad = int(s * 0.05)
    d.rounded_rectangle(
        (inner_pad, inner_pad, s - inner_pad, s - inner_pad),
        radius=radius - inner_pad,
        outline=VIOLET, width=max(1, int(s * 0.008)),
    )

    # Bolt path (matches the SVG used in the dock + the panel logo).
    bolt_pts = [
        (37, 8), (17, 38), (29, 38), (25, 56), (47, 26), (35, 26),
    ]
    cx_scale = s / 64
    bolt_xy = [(x * cx_scale, y * cx_scale) for (x, y) in bolt_pts]

    # Drop shadow.
    shadow_offset = int(s * 0.018)
    shadow_pts = [(x + shadow_offset, y + shadow_offset) for (x, y) in bolt_xy]
    shadow_layer = Image.new("RGBA", (s, s), (0, 0, 0, 0))
    ImageDraw.Draw(shadow_layer).polygon(shadow_pts, fill=(0, 0, 0, 180))
    shadow_layer = shadow_layer.filter(ImageFilter.GaussianBlur(s * 0.018))
    img.alpha_composite(shadow_layer)

    # Bolt fill - simulate vertical gradient by laying down N strips clipped to
    # the polygon mask.
    bolt_layer = Image.new("RGBA", (s, s), (0, 0, 0, 0))
    bolt_grad = Image.new("RGB", (s, s), VIOLET)
    for y in range(s):
        t = y / max(1, s - 1)
        if t < 0.55:
            row = lerp(HILITE, VIOLET, t / 0.55)
        else:
            row = lerp(VIOLET, DEEP_PURP, (t - 0.55) / 0.45)
        ImageDraw.Draw(bolt_grad).line([(0, y), (s, y)], fill=row)
    bolt_mask = Image.new("L", (s, s), 0)
    ImageDraw.Draw(bolt_mask).polygon(bolt_xy, fill=255)
    bolt_layer.paste(bolt_grad, (0, 0), bolt_mask)
    # Bolt outline
    ImageDraw.Draw(bolt_layer).polygon(
        bolt_xy, outline=(26, 13, 64), width=max(1, int(s * 0.008))
    )
    img.alpha_composite(bolt_layer)

    # Specular highlight on the top half of the card body.
    highlight = Image.new("RGBA", (s, s), (0, 0, 0, 0))
    h_mask = Image.new("L", (s, s), 0)
    ImageDraw.Draw(h_mask).rounded_rectangle(
        (0, 0, s - 1, int(s * 0.48)), radius=radius, fill=80,
    )
    ImageDraw.Draw(highlight).rectangle((0, 0, s, s), fill=(255, 255, 255, 255))
    highlight.putalpha(h_mask)
    img.alpha_composite(highlight)

    # Outer rim (subtle teal hairline on the bottom edge for that aurora hint).
    rim = Image.new("RGBA", (s, s), (0, 0, 0, 0))
    ImageDraw.Draw(rim).rounded_rectangle(
        (0, 0, s - 1, s - 1), radius=radius,
        outline=(*TEAL, 80), width=max(1, int(s * 0.008)),
    )
    img.alpha_composite(rim)

    # Downscale with Lanczos for a crisp result.
    return img.resize((size, size), Image.LANCZOS)


def main():
    # PNG at the canonical size used by Qt.
    big = draw_logo(256)
    big.save(HERE / "logo.png", "PNG")
    print(f"wrote {HERE / 'logo.png'} 256x256")

    # ICO with the sizes Windows actually picks from in different contexts.
    sizes = [16, 24, 32, 48, 64, 128, 256]
    images = [draw_logo(sz) for sz in sizes]
    images[0].save(
        HERE / "logo.ico", format="ICO",
        sizes=[(sz, sz) for sz in sizes],
        append_images=images[1:],
    )
    print(f"wrote {HERE / 'logo.ico'} sizes={sizes}")


if __name__ == "__main__":
    main()
