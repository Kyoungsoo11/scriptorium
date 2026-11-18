"""Builds native/scriptorium.ico from the line drawing in assets/scriptorium-icon-source.webp.

The drawing is thin black lines on white. As an icon it sits on a white rounded tile (black lines
alone vanish on a dark taskbar or tray), and the strokes are thickened per size so the scribe
still reads at 16 px. Each size is drawn separately and stored as PNG in the .ico.

Usage: python scripts/make-icon.py [--preview <dir>]   (needs Pillow)
"""

import math
import sys
from pathlib import Path

from PIL import Image, ImageChops, ImageDraw, ImageFilter

ROOT = Path(__file__).resolve().parent.parent
SOURCE = ROOT / 'assets' / 'scriptorium-icon-source.webp'
OUT = ROOT / 'native' / 'scriptorium.ico'
SIZES = [16, 20, 24, 32, 40, 48, 64, 128, 256]
WORK = 1024  # the drawing is processed at this size, then reduced


def ink_map():
    """The drawing's lines as an 'L' image (255 = ink), cropped to the drawing and squared."""
    src = Image.open(SOURCE).convert('L')
    ink = src.point(lambda v: 255 - v)
    ink = ink.point(lambda v: 0 if v < 40 else v)  # paper noise
    box = ink.getbbox()
    ink = ink.crop(box)
    side = max(ink.size)
    square = Image.new('L', (side, side), 0)
    square.paste(ink, ((side - ink.width) // 2, (side - ink.height) // 2))
    return square.resize((WORK, WORK), Image.LANCZOS)


def stroke_px(size):
    """Wanted line width in output pixels."""
    # the drawing has many lines: wider strokes fill it in at small sizes, so they stay near one
    # pixel and rely on anti-aliasing
    if size <= 24:
        return 0.45
    if size <= 48:
        return 0.6
    if size <= 64:
        return 0.85
    return size / 110  # 128 -> ~1.2, 256 -> ~2.3


def draw(size, ink):
    tile_inset = max(0, round(size * 0.02))
    art_inset = round(size * 0.12)
    art = size - 2 * art_inset
    # thicken at the working size so the reduced line is about stroke_px wide
    scale = WORK / art
    have = 2.2  # source strokes are ~2.2 px at WORK
    grow = max(0.0, stroke_px(size) * scale - have)
    k = int(round(grow)) | 1
    lines = ink.filter(ImageFilter.MaxFilter(k)) if k > 1 else ink
    lines = lines.resize((art, art), Image.BOX)
    # sub-pixel strokes come out grey: lift them, more where they are faint
    lines = lines.point(lambda v: min(255, int(255 * (v / 255) ** 0.7)))

    icon = Image.new('RGBA', (size, size), (0, 0, 0, 0))
    tile = Image.new('L', (size, size), 0)
    r = max(2, round(size * 0.2))
    ImageDraw.Draw(tile).rounded_rectangle(
        (tile_inset, tile_inset, size - 1 - tile_inset, size - 1 - tile_inset), radius=r, fill=255
    )
    # supersampled tile edge
    big = Image.new('L', (size * 4, size * 4), 0)
    ImageDraw.Draw(big).rounded_rectangle(
        (tile_inset * 4, tile_inset * 4, size * 4 - 1 - tile_inset * 4, size * 4 - 1 - tile_inset * 4),
        radius=r * 4,
        fill=255,
    )
    tile = big.resize((size, size), Image.LANCZOS)
    paper = Image.new('RGBA', (size, size), (250, 248, 242, 255))  # warm parchment white
    icon.paste(paper, (0, 0), tile)
    # a faint edge so the tile holds on a white background too
    if size >= 24:
        edge = ImageChops.subtract(tile, tile.filter(ImageFilter.MinFilter(3)))
        icon.paste(Image.new('RGBA', (size, size), (120, 110, 95, 255)), (0, 0), edge.point(lambda v: v // 3))
    ink_layer = Image.new('RGBA', (art, art), (28, 24, 20, 255))
    icon.paste(ink_layer, (art_inset, art_inset), lines)
    return icon


def main():
    ink = ink_map()
    images = [draw(s, ink) for s in SIZES]
    images[-1].save(OUT, format='ICO', sizes=[(s, s) for s in SIZES], append_images=images[:-1])
    print(f'{OUT} ({OUT.stat().st_size // 1024} KB): {SIZES}')
    if '--preview' in sys.argv:
        out = Path(sys.argv[sys.argv.index('--preview') + 1])
        out.mkdir(parents=True, exist_ok=True)
        # each size at 4x (nearest) on light and dark, as the taskbar shows them
        sheet_w = sum(s * 4 + 16 for s in SIZES[:6]) + 16
        sheet = Image.new('RGB', (sheet_w, (64 * 4 + 32) * 2), (243, 243, 243))
        ImageDraw.Draw(sheet).rectangle((0, 64 * 4 + 32, sheet_w, sheet.height), fill=(32, 32, 32))
        x = 16
        for img in images[:6]:
            big = img.resize((img.width * 4, img.height * 4), Image.NEAREST)
            sheet.paste(big, (x, 16), big)
            sheet.paste(big, (x, 64 * 4 + 48), big)
            x += img.width * 4 + 16
        sheet.save(out / 'icon-small-sizes.png')
        images[-1].save(out / 'icon-256.png')
        print(f'preview: {out}')


if __name__ == '__main__':
    main()
