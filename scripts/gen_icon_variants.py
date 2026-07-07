"""Rasterize the peek-over icon variants (monitor / wall) to transparent PNGs.

Standalone and stdlib-only, mirroring scripts/gen_extension_icons.py. Geometry is
in the 128x128 SVG coordinate space and matches the source SVGs under
apps/extension/icons/variants/. Non-destructive: writes color
{variant}-{size}.png and monochrome {variant}-template-{size}.png into that same
variants/ folder and never touches the live icon-*.png.

To promote a variant to the live toolbar icon, copy its color SVG over
apps/extension/icons/icon-128.svg and port this geometry into
scripts/gen_extension_icons.py (or point the manifest PNGs at these files).

Usage: python scripts/gen_icon_variants.py
"""

from __future__ import annotations

import struct
import zlib
from pathlib import Path

OUT = Path(__file__).resolve().parent.parent / "apps" / "extension" / "icons" / "variants"
SIZES = (16, 32, 48, 128)
SUBSAMPLES = 4  # 4x4 grid per pixel

INK = (0x1F, 0x29, 0x37)
FACE = (0xF9, 0xFA, 0xFB)
GREEN = (0x10, 0xB9, 0x81)


def _in_circle(x: float, y: float, cx: float, cy: float, r: float) -> bool:
    return (x - cx) ** 2 + (y - cy) ** 2 <= r * r


def _in_round_rect(x, y, rx, ry, w, h, r) -> bool:
    """Rounded-rect hit test: rx,ry = top-left corner, r = corner radius."""
    if x < rx or x > rx + w or y < ry or y > ry + h:
        return False
    qx = min(max(x, rx + r), rx + w - r)
    qy = min(max(y, ry + r), ry + h - r)
    return (x - qx) ** 2 + (y - qy) ** 2 <= r * r


def sample_monitor(x: float, y: float):
    """Color at a point in 128-space, painter's order top-down. None = transparent."""
    if _in_round_rect(x, y, 30, 64, 15, 13, 6.5) or _in_round_rect(x, y, 83, 64, 15, 13, 6.5):
        return INK  # hands draped over the top edge
    if _in_circle(x, y, 52, 56, 8) or _in_circle(x, y, 76, 56, 8):
        return FACE  # eyes cresting above the screen
    if (
        _in_round_rect(x, y, 18, 69, 92, 38, 5)
        or _in_round_rect(x, y, 59, 107, 10, 7, 0)
        or _in_round_rect(x, y, 49, 113, 31, 5, 2)
    ):
        return GREEN  # monitor screen + neck + foot
    if _in_round_rect(x, y, 16, 67, 96, 42, 7):
        return FACE  # light rim separating the screen from the head
    if _in_circle(x, y, 64, 69, 32):
        return INK  # head hidden behind the monitor
    return None


def sample_wall(x: float, y: float):
    if _in_round_rect(x, y, 27, 69, 15, 13, 6.5) or _in_round_rect(x, y, 86, 69, 15, 13, 6.5):
        return INK  # hands draped over the top edge
    if _in_circle(x, y, 51, 60, 8) or _in_circle(x, y, 77, 60, 8):
        return FACE  # eyes cresting above the wall
    if _in_round_rect(x, y, 10, 74, 108, 38, 9):
        return GREEN  # wall / ledge
    if _in_round_rect(x, y, 8, 72, 112, 42, 11):
        return FACE  # light rim separating the ledge from the head
    if _in_circle(x, y, 64, 74, 36):
        return INK  # head hidden behind the wall
    return None


VARIANTS = {"monitor": sample_monitor, "wall": sample_wall}


def sample_monitor_template(x: float, y: float):
    """Single-color template glyph matching monitor-mono.svg."""
    if _in_circle(x, y, 52, 56, 8) or _in_circle(x, y, 76, 56, 8):
        return None
    if _in_round_rect(x, y, 18, 67, 92, 4, 2):
        return None
    if (
        _in_circle(x, y, 64, 69, 32)
        or _in_round_rect(x, y, 18, 69, 92, 38, 5)
        or _in_round_rect(x, y, 59, 107, 10, 7, 0)
        or _in_round_rect(x, y, 49, 113, 31, 5, 2)
    ):
        return INK
    return None


def sample_wall_template(x: float, y: float):
    """Single-color template glyph matching wall-mono.svg."""
    if _in_circle(x, y, 51, 60, 8) or _in_circle(x, y, 77, 60, 8):
        return None
    if _in_round_rect(x, y, 10, 72, 108, 4, 2):
        return None  # transparent separation slit
    if _in_circle(x, y, 64, 74, 36) or _in_round_rect(x, y, 10, 74, 108, 38, 9):
        return INK
    return None


TEMPLATE_VARIANTS = {"monitor": sample_monitor_template, "wall": sample_wall_template}


def render(size: int, sampler) -> list[bytes]:
    scale = 128.0 / size
    step = 1.0 / SUBSAMPLES
    rows = []
    for py in range(size):
        row = bytearray()
        for px in range(size):
            r = g = b = a = 0.0
            for sy in range(SUBSAMPLES):
                for sx in range(SUBSAMPLES):
                    x = (px + (sx + 0.5) * step) * scale
                    y = (py + (sy + 0.5) * step) * scale
                    color = sampler(x, y)
                    if color:
                        r += color[0]
                        g += color[1]
                        b += color[2]
                        a += 1.0
            n = SUBSAMPLES * SUBSAMPLES
            if a == 0:
                row += b"\x00\x00\x00\x00"
            else:
                row += bytes((round(r / a), round(g / a), round(b / a), round(a / n * 255)))
        rows.append(bytes(row))
    return rows


def write_png(path: Path, size: int, rows: list[bytes]) -> None:
    def chunk(ctype: bytes, payload: bytes) -> bytes:
        return (
            struct.pack(">I", len(payload))
            + ctype
            + payload
            + struct.pack(">I", zlib.crc32(ctype + payload) & 0xFFFFFFFF)
        )

    ihdr = struct.pack(">IIBBBBB", size, size, 8, 6, 0, 0, 0)
    raw = b"".join(b"\x00" + row for row in rows)
    png = (
        b"\x89PNG\r\n\x1a\n"
        + chunk(b"IHDR", ihdr)
        + chunk(b"IDAT", zlib.compress(raw, 9))
        + chunk(b"IEND", b"")
    )
    path.write_bytes(png)


def main() -> None:
    OUT.mkdir(parents=True, exist_ok=True)

    def render_variants(variants, filename_pattern: str) -> None:
        for name, sampler in variants.items():
            for size in SIZES:
                path = OUT / filename_pattern.format(name=name, size=size)
                write_png(path, size, render(size, sampler))
                print(f"wrote {path} ({size}x{size})")

    render_variants(VARIANTS, "{name}-{size}.png")
    render_variants(TEMPLATE_VARIANTS, "{name}-template-{size}.png")


if __name__ == "__main__":
    main()
