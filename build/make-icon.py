#!/usr/bin/env python3
"""Generates Manifold's application icons.

The mark is the app's own first screen reduced to its essentials: a violet
sine and a cyan parabola crossing on a faint grid. It is drawn from formulas
rather than traced by hand so it stays sharp at 1024px and still reads at 16px,
where everything but the two curves has to disappear.

Outputs build/icon.png (1024), build/icon-256.png, build/icon.ico and
build/manifold.icns. Run with:  python3 build/make-icon.py
"""

import math
import os
import struct

from PIL import Image, ImageDraw, ImageFilter

HERE = os.path.dirname(os.path.abspath(__file__))
SIZE = 1024
# Supersampling: every curve is drawn at 4x and downsampled, which is far
# cheaper than implementing an antialiased stroke by hand.
SS = 4
W = SIZE * SS

BACKGROUND_TOP = (24, 26, 38)
BACKGROUND_BOTTOM = (11, 13, 18)
ACCENT = (139, 124, 246)
ACCENT_SOFT = (166, 152, 248)
CYAN = (56, 189, 248)
GRID = (255, 255, 255, 16)


def rounded_mask(size: int, radius_fraction: float = 0.2237) -> Image.Image:
    """The macOS "squircle" corner radius is very close to 22.37% of the side."""
    mask = Image.new("L", (size, size), 0)
    ImageDraw.Draw(mask).rounded_rectangle(
        (0, 0, size - 1, size - 1), radius=int(size * radius_fraction), fill=255
    )
    return mask


def vertical_gradient(size: int, top, bottom) -> Image.Image:
    image = Image.new("RGB", (1, size))
    for y in range(size):
        t = y / max(1, size - 1)
        image.putpixel(
            (0, y),
            (
                round(top[0] + (bottom[0] - top[0]) * t),
                round(top[1] + (bottom[1] - top[1]) * t),
                round(top[2] + (bottom[2] - top[2]) * t),
            ),
        )
    return image.resize((size, size), Image.NEAREST)


def curve_points(f, x0, x1, samples=1600):
    """World-space samples of f mapped into the icon's drawing box."""
    # The plot window: x from -6 to 6, y from -4.5 to 4.5, inset from the edge
    # so the curves never touch the rounded corners.
    inset = W * 0.13
    span = W - 2 * inset
    points = []
    for i in range(samples + 1):
        x = x0 + (x1 - x0) * i / samples
        y = f(x)
        if not math.isfinite(y):
            continue
        px = inset + (x + 6) / 12 * span
        py = inset + (4.5 - y) / 9 * span
        points.append((px, py))
    return points


def draw_icon() -> Image.Image:
    canvas = Image.new("RGB", (W, W), BACKGROUND_BOTTOM)
    canvas.paste(vertical_gradient(W, BACKGROUND_TOP, BACKGROUND_BOTTOM), (0, 0))

    # A soft violet glow behind the curves, so the mark has depth at large sizes
    # without adding anything that needs to resolve at small ones.
    glow = Image.new("RGB", (W, W), (0, 0, 0))
    gd = ImageDraw.Draw(glow)
    gd.ellipse((W * 0.14, W * 0.2, W * 0.86, W * 0.92), fill=(46, 36, 96))
    glow = glow.filter(ImageFilter.GaussianBlur(W * 0.09))
    canvas = Image.blend(canvas, Image.blend(canvas, glow, 0.55), 0.75)

    overlay = Image.new("RGBA", (W, W), (0, 0, 0, 0))
    draw = ImageDraw.Draw(overlay)

    inset = W * 0.13
    span = W - 2 * inset
    for i in range(1, 6):
        p = inset + span * i / 6
        draw.line([(p, inset), (p, inset + span)], fill=GRID, width=int(W * 0.0035))
        draw.line([(inset, p), (inset + span, p)], fill=GRID, width=int(W * 0.0035))

    axis = (255, 255, 255, 46)
    mid = inset + span / 2
    draw.line([(inset, mid), (inset + span, mid)], fill=axis, width=int(W * 0.006))
    draw.line([(mid, inset), (mid, inset + span)], fill=axis, width=int(W * 0.006))

    # The range stops where the arms reach the top of the plot box: run it any
    # wider and they leave through the rounded corners instead of the frame.
    parabola = curve_points(lambda x: x * x / 3.2 - 3.1, -4.85, 4.85)
    draw.line(parabola, fill=CYAN + (235,), width=int(W * 0.028), joint="curve")

    sine = curve_points(lambda x: 2.5 * math.sin(x * 1.05), -5.6, 5.6)
    # Drawn twice: a wide translucent pass under a solid one gives the stroke a
    # soft edge that survives downsampling to 16px.
    draw.line(sine, fill=ACCENT + (90,), width=int(W * 0.062), joint="curve")
    draw.line(sine, fill=ACCENT_SOFT + (255,), width=int(W * 0.034), joint="curve")

    for x in (-math.pi / 1.05, 0, math.pi / 1.05):
        px = inset + (x + 6) / 12 * span
        py = inset + (4.5 - 2.5 * math.sin(x * 1.05)) / 9 * span
        r = W * 0.019
        draw.ellipse((px - r, py - r, px + r, py + r), fill=(255, 255, 255, 235))

    canvas = Image.alpha_composite(canvas.convert("RGBA"), overlay)

    icon = canvas.resize((SIZE, SIZE), Image.LANCZOS)
    icon.putalpha(rounded_mask(SIZE))
    return icon


def write_icns(icon: Image.Image, path: str) -> None:
    """Writes a PNG-based .icns container.

    The format is a four-byte magic, a total length, then typed chunks. macOS
    has accepted PNG payloads for the ic07-ic14 types since 10.7, so there is no
    need for the older RLE-compressed formats or for iconutil — which matters,
    because this has to run on Linux as well.
    """
    entries = [
        ("ic07", 128),
        ("ic08", 256),
        ("ic09", 512),
        ("ic10", 1024),
        ("ic11", 32),
        ("ic12", 64),
        ("ic13", 256),
        ("ic14", 512),
    ]
    chunks = []
    for kind, size in entries:
        from io import BytesIO

        buffer = BytesIO()
        icon.resize((size, size), Image.LANCZOS).save(buffer, format="PNG")
        data = buffer.getvalue()
        chunks.append(kind.encode("ascii") + struct.pack(">I", len(data) + 8) + data)
    body = b"".join(chunks)
    with open(path, "wb") as handle:
        handle.write(b"icns" + struct.pack(">I", len(body) + 8) + body)


def main() -> None:
    icon = draw_icon()
    icon.save(os.path.join(HERE, "icon.png"))
    icon.resize((256, 256), Image.LANCZOS).save(os.path.join(HERE, "icon-256.png"))
    icon.save(
        os.path.join(HERE, "icon.ico"),
        sizes=[(16, 16), (32, 32), (48, 48), (64, 64), (128, 128), (256, 256)],
    )
    write_icns(icon, os.path.join(HERE, "manifold.icns"))
    print("Wrote icon.png, icon-256.png, icon.ico and manifold.icns")


if __name__ == "__main__":
    main()
