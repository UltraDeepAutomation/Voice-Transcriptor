#!/usr/bin/env python3
"""Generate the branded DMG installer background.

The output image is committed and consumed by electron-builder. This script is
kept so the asset stays reproducible when the app name, version, or palette
changes.
"""

from __future__ import annotations

import json
import math
from pathlib import Path

from PIL import Image, ImageDraw, ImageFilter, ImageFont


ROOT = Path(__file__).resolve().parents[1]
PACKAGE_JSON = ROOT / "package.json"
OUTPUT = ROOT / "build" / "dmg-background.png"

WIDTH = 660
HEIGHT = 420
SCALE = 2

FONT_REGULAR = "/System/Library/Fonts/SFNS.ttf"
FONT_BOLD = "/System/Library/Fonts/SFNS.ttf"
FONT_MONO = "/System/Library/Fonts/SFNSMono.ttf"


def load_font(path: str, size: int) -> ImageFont.FreeTypeFont:
    return ImageFont.truetype(path, size * SCALE)


def rounded_rectangle(
    draw: ImageDraw.ImageDraw,
    box: tuple[int, int, int, int],
    radius: int,
    fill: tuple[int, int, int, int] | None = None,
    outline: tuple[int, int, int, int] | None = None,
    width: int = 1,
) -> None:
    scaled = tuple(value * SCALE for value in box)
    draw.rounded_rectangle(
        scaled,
        radius=radius * SCALE,
        fill=fill,
        outline=outline,
        width=width * SCALE,
    )


def line(
    draw: ImageDraw.ImageDraw,
    points: list[tuple[int, int]],
    fill: tuple[int, int, int, int],
    width: int = 1,
) -> None:
    draw.line([(x * SCALE, y * SCALE) for x, y in points], fill=fill, width=width * SCALE)


def text(
    draw: ImageDraw.ImageDraw,
    xy: tuple[int, int],
    value: str,
    font: ImageFont.FreeTypeFont,
    fill: tuple[int, int, int, int],
    anchor: str | None = None,
) -> None:
    draw.text((xy[0] * SCALE, xy[1] * SCALE), value, font=font, fill=fill, anchor=anchor)


def draw_background(draw: ImageDraw.ImageDraw) -> None:
    top = (21, 23, 29)
    bottom = (8, 10, 14)
    for y in range(HEIGHT * SCALE):
        t = y / (HEIGHT * SCALE - 1)
        color = tuple(round(top[i] * (1 - t) + bottom[i] * t) for i in range(3))
        draw.line([(0, y), (WIDTH * SCALE, y)], fill=(*color, 255))

    # Quiet waveform field. It adds motion without competing with Finder icons.
    for i in range(28):
        x = int((i * 31 + 18) * SCALE)
        amplitude = 13 + (i % 5) * 7
        center = 94 + math.sin(i * 0.8) * 8
        line(
            draw,
            [(x // SCALE, int(center - amplitude)), (x // SCALE, int(center + amplitude))],
            (255, 255, 255, 13),
            width=2,
        )

    for x in range(0, WIDTH, 22):
        line(draw, [(x, 0), (x, HEIGHT)], (255, 255, 255, 5))
    for y in range(0, HEIGHT, 22):
        line(draw, [(0, y), (WIDTH, y)], (255, 255, 255, 4))

    glow = Image.new("RGBA", (WIDTH * SCALE, HEIGHT * SCALE), (0, 0, 0, 0))
    glow_draw = ImageDraw.Draw(glow)
    for radius, alpha in [(150, 24), (110, 34), (70, 46)]:
        glow_draw.ellipse(
            (
                (WIDTH // 2 - radius) * SCALE,
                (246 - radius) * SCALE,
                (WIDTH // 2 + radius) * SCALE,
                (246 + radius) * SCALE,
            ),
            fill=(72, 148, 255, alpha),
        )
    glow = glow.filter(ImageFilter.GaussianBlur(34 * SCALE))
    return glow


def draw_install_wells(base: Image.Image, draw: ImageDraw.ImageDraw) -> None:
    for cx, label in ((178, "APP"), (482, "APPLICATIONS")):
        rounded_rectangle(draw, (cx - 82, 132, cx + 82, 292), 28, fill=(255, 255, 255, 15))
        rounded_rectangle(draw, (cx - 82, 132, cx + 82, 292), 28, outline=(255, 255, 255, 29), width=1)
        text(draw, (cx, 142), label, load_font(FONT_MONO, 10), (255, 255, 255, 88), anchor="mt")

    arrow_layer = Image.new("RGBA", base.size, (0, 0, 0, 0))
    arrow_draw = ImageDraw.Draw(arrow_layer)
    line(arrow_draw, [(282, 220), (378, 220)], (255, 255, 255, 170), width=4)
    arrow_draw.polygon(
        [(378 * SCALE, 220 * SCALE), (356 * SCALE, 206 * SCALE), (356 * SCALE, 234 * SCALE)],
        fill=(255, 255, 255, 178),
    )
    line(arrow_draw, [(286, 242), (374, 242)], (78, 199, 176, 118), width=2)
    arrow_layer = arrow_layer.filter(ImageFilter.GaussianBlur(0.18 * SCALE))
    base.paste(arrow_layer.convert("RGB"), (0, 0), arrow_layer)


def main() -> None:
    metadata = json.loads(PACKAGE_JSON.read_text())
    product_name = metadata["build"]["productName"]

    canvas = Image.new("RGB", (WIDTH * SCALE, HEIGHT * SCALE), (0, 0, 0))
    draw = ImageDraw.Draw(canvas, "RGBA")
    glow = draw_background(draw)
    canvas.paste(glow.convert("RGB"), (0, 0), glow)
    draw = ImageDraw.Draw(canvas, "RGBA")

    title_font = load_font(FONT_BOLD, 34)
    subtitle_font = load_font(FONT_REGULAR, 15)
    instruction_font = load_font(FONT_BOLD, 21)

    text(draw, (28, 34), product_name, title_font, (247, 248, 252, 246))
    text(draw, (30, 75), "Install for macOS Sonoma", subtitle_font, (204, 213, 228, 172))

    draw_install_wells(canvas, draw)

    text(draw, (WIDTH // 2, 104), "Drag Transcriptor to Applications", instruction_font, (248, 250, 255, 230), anchor="mm")
    text(draw, (WIDTH // 2, 130), "The app will be copied into your Applications folder.", subtitle_font, (204, 213, 228, 154), anchor="mm")

    # Preserve pixel-accurate Finder positioning while producing a crisp asset.
    output = canvas.resize((WIDTH, HEIGHT), Image.Resampling.LANCZOS)
    OUTPUT.parent.mkdir(parents=True, exist_ok=True)
    output.save(OUTPUT, "PNG", optimize=True)
    print(OUTPUT)


if __name__ == "__main__":
    main()
