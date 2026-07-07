"""Rasterize the Kibitzer face icon to transparent PNGs.

macOS `qlmanage` bakes an opaque white background into SVG thumbnails, which
made the toolbar icon render as a white square. This script draws the same
geometry as apps/extension/icons/icon-128.svg (the design source of truth)
with real alpha, using only the standard library.

Usage: python scripts/gen_extension_icons.py
Writes icon-{16,32,48,128}.png into apps/extension/icons/.
"""

from __future__ import annotations

import math
import struct
import zlib
from pathlib import Path

ICON_DIR = Path(__file__).resolve().parent.parent / "apps" / "extension" / "icons"
SIZES = (16, 32, 48, 128)
SUBSAMPLES = 4  # 4x4 grid per pixel

INK = (0x1F, 0x29, 0x37)
FACE = (0xF9, 0xFA, 0xFB)
GREEN = (0x10, 0xB9, 0x81)

# Geometry in the 128x128 SVG coordinate space.
FACE_CENTER = (64.0, 64.0)
FACE_RADIUS = 55.0
RING_HALF = 4.5  # stroke-width 9
BROW = ((36.0, 70.0), (49.0, 43.0), (79.0, 43.0), (92.0, 70.0))  # cubic bezier
BROW_HALF = 6.0  # stroke-width 12
EYES = ((45.0, 52.0), (83.0, 52.0))
EYE_RADIUS = 8.0
SMILE = ((40.0, 94.0), (88.0, 94.0))
SMILE_HALF = 5.5  # stroke-width 11


def _bezier_points(p0, p1, p2, p3, steps: int = 64):
    points = []
    for i in range(steps + 1):
        t = i / steps
        u = 1 - t
        x = u**3 * p0[0] + 3 * u**2 * t * p1[0] + 3 * u * t**2 * p2[0] + t**3 * p3[0]
        y = u**3 * p0[1] + 3 * u**2 * t * p1[1] + 3 * u * t**2 * p2[1] + t**3 * p3[1]
        points.append((x, y))
    return points


BROW_POLYLINE = _bezier_points(*BROW)


def _dist_to_segment(px, py, ax, ay, bx, by) -> float:
    dx, dy = bx - ax, by - ay
    length_sq = dx * dx + dy * dy
    if length_sq == 0:
        return math.hypot(px - ax, py - ay)
    t = max(0.0, min(1.0, ((px - ax) * dx + (py - ay) * dy) / length_sq))
    return math.hypot(px - (ax + t * dx), py - (ay + t * dy))


def _dist_to_polyline(px, py, points) -> float:
    best = math.inf
    for (ax, ay), (bx, by) in zip(points, points[1:]):
        best = min(best, _dist_to_segment(px, py, ax, ay, bx, by))
    return best


def _sample(x: float, y: float):
    """Color at a point in 128-space, painter's order top-down. None = transparent."""
    center_dist = math.hypot(x - FACE_CENTER[0], y - FACE_CENTER[1])
    if center_dist > FACE_RADIUS + RING_HALF:
        return None
    if _dist_to_segment(x, y, *SMILE[0], *SMILE[1]) <= SMILE_HALF:
        return GREEN
    for ex, ey in EYES:
        if math.hypot(x - ex, y - ey) <= EYE_RADIUS:
            return INK
    if _dist_to_polyline(x, y, BROW_POLYLINE) <= BROW_HALF:
        return INK
    if abs(center_dist - FACE_RADIUS) <= RING_HALF:
        return INK
    return FACE


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
