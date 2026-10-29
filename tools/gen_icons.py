#!/usr/bin/env python3
"""Generate LONDON BOOM! PWA icons (F6) — no runtime deps, only Pillow for the
build. Draws the dusk scene: gradient sky, Elizabeth Tower silhouette with a
glowing clock face, gilded tip, and a little boom star. Writes icon-192/512
(full-bleed art) and icon-maskable-192/512 (art inside the 80% safe zone)."""
from PIL import Image, ImageDraw
import os

OUT = os.path.join(os.path.dirname(os.path.abspath(__file__)), '..', 'icons')


def lerp(a, b, t):
    return tuple(int(a[i] + (b[i] - a[i]) * t) for i in range(3))


def tower_icon(size, maskable):
    img = Image.new('RGB', (size, size))
    d = ImageDraw.Draw(img)
    top = (5, 8, 31)      # #05081f night
    mid = (41, 42, 103)   # #292a67
    bot = (168, 74, 68)   # #a84a44 dusk
    for y in range(size):
        t = y / size
        c = lerp(top, mid, t / 0.62) if t < 0.62 else lerp(mid, bot, (t - 0.62) / 0.38)
        d.line([(0, y), (size, y)], fill=c)

    S = size / 512.0
    # maskable safe zone: keep art within the middle 80%
    scale = 0.78 if maskable else 1.0
    cx = size / 2

    def Y(v):  # tower drawn in a 512-tall mental space, centred vertically
        return size / 2 + (v - 256) * S * scale

    def X(v):
        return cx + (v - 256) * S * scale

    stone = (216, 186, 122)
    stone_dk = (172, 140, 86)
    iron = (52, 62, 88)
    gold = (255, 202, 94)

    # plinth
    d.rectangle([X(216), Y(470), X(296), Y(500)], fill=stone_dk)
    # shaft
    d.rectangle([X(224), Y(250), X(288), Y(470)], fill=stone)
    # lancet windows
    for wx in (244, 262):
        d.rectangle([X(wx), Y(300), X(wx + 7), Y(340)], fill=(70, 55, 30))
    # clock stage (wider) + frame
    d.rectangle([X(216), Y(196), X(296), Y(250)], fill=stone_dk)
    # gilded belfry arches
    d.rectangle([X(224), Y(150), X(288), Y(196)], fill=stone)
    for ax in (236, 256, 276):
        d.rectangle([X(ax - 4), Y(158), X(ax + 4), Y(192)], fill=(40, 44, 66))
    # iron crown (tapering)
    d.polygon([(X(228), Y(150)), (X(284), Y(150)), (X(272), Y(112)), (X(240), Y(112))], fill=iron)
    d.polygon([(X(240), Y(112)), (X(272), Y(112)), (X(260), Y(84)), (X(252), Y(84))], fill=iron)
    # gilded finial + boom star
    d.rectangle([X(252), Y(70), X(260), Y(84)], fill=gold)
    r = 16 * S * scale
    sy = Y(58)
    star = [(cx, sy - r * 2.2), (cx + r * 0.6, sy - r * 0.6), (cx + r * 2.2, sy),
            (cx + r * 0.6, sy + r * 0.6), (cx, sy + r * 2.2), (cx - r * 0.6, sy + r * 0.6),
            (cx - r * 2.2, sy), (cx - r * 0.6, sy - r * 0.6)]
    d.polygon(star, fill=gold)

    # glowing clock face
    cyk = Y(223)
    rr = 22 * S * scale
    for gr, alpha in ((rr * 2.1, 60), (rr * 1.5, 110)):
        glow = Image.new('RGBA', (size, size), (0, 0, 0, 0))
        gd = ImageDraw.Draw(glow)
        gd.ellipse([cx - gr, cyk - gr, cx + gr, cyk + gr], fill=(255, 205, 120, alpha))
        img = Image.alpha_composite(img.convert('RGBA'), glow).convert('RGB')
        d = ImageDraw.Draw(img)
    d.ellipse([cx - rr, cyk - rr, cx + rr, cyk + rr], fill=(246, 233, 196))
    d.ellipse([cx - rr, cyk - rr, cx + rr, cyk + rr], outline=(77, 58, 20), width=max(2, int(3 * S)))
    # hands: 10:08 classic display time
    import math
    for ang, ln, wdt in ((math.radians(-90 + 305), 0.62, 3), (math.radians(-90 + 56), 0.85, 2)):
        ex = cx + math.cos(ang) * rr * ln
        ey = cyk + math.sin(ang) * rr * ln
        d.line([cx, cyk, ex, ey], fill=(44, 33, 9), width=max(2, int(wdt * S * scale)))
    d.ellipse([cx - 2.5, cyk - 2.5, cx + 2.5, cyk + 2.5], fill=(44, 33, 9))
    return img


def main():
    os.makedirs(OUT, exist_ok=True)
    for size in (192, 512):
        tower_icon(size, False).save(os.path.join(OUT, f'icon-{size}.png'), 'PNG')
        tower_icon(size, True).save(os.path.join(OUT, f'icon-maskable-{size}.png'), 'PNG')
        print(f'icon-{size}.png + icon-maskable-{size}.png written ({size}x{size})')


if __name__ == '__main__':
    main()
