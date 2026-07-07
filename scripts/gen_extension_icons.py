"""Rasterize the Kibitzer icon to transparent PNGs.

macOS `qlmanage` bakes an opaque white background into SVG thumbnails, which
made the toolbar icon render as a white square. This script draws the same
geometry as apps/extension/icons/icon-128.svg (the design source of truth)
with real alpha, using only the standard library.

The mark is the "peek-over-monitor" kibitzer: a dark head peeking from behind a
green monitor, a light rim separating the two, hands draped over the top edge,
and eyes cresting above the screen. Keep this geometry in sync with icon-128.svg.

Usage: python scripts/gen_extension_icons.py
Writes icon-{16,32,48,128}.png into apps/extension/icons/.
"""

from __future__ import annotations

import struct
import zlib
from pathlib import Path

ICON_DIR = Path(__file__).resolve().parent.parent / "apps" / "extension" / "icons"
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


def _sample(x: float, y: float):
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


def render(size: int) -> list[bytes]:
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
                    color = _sample(x, y)
                    if color:
                        r += color[0]
                        g += color[1]
                        b += color[2]
                        a += 1.0
            n = SUBSAMPLES * SUBSAMPLES
            if a == 0:
                row += b"\x00\x00\x00\x00"
            else:
                row += bytes(
                    (round(r / a), round(g / a), round(b / a), round(a / n * 255))
                )
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
    for size in SIZES:
        path = ICON_DIR / f"icon-{size}.png"
        write_png(path, size, render(size))
        print(f"wrote {path} ({size}x{size})")


if __name__ == "__main__":
    main()
