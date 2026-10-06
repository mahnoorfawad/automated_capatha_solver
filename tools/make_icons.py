"""Generates the extension icons (no third-party dependencies).

Usage: python tools/make_icons.py
"""
import math
import struct
import zlib
from pathlib import Path

OUT = Path(__file__).resolve().parent.parent / "extension" / "icons"
PURPLE = (124, 58, 237)
WHITE = (255, 255, 255)


def png(width, height, pixels):
    raw = b"".join(b"\x00" + bytes(c for px in row for c in px) for row in pixels)

    def chunk(tag, data):
        return struct.pack(">I", len(data)) + tag + data + struct.pack(">I", zlib.crc32(tag + data) & 0xFFFFFFFF)

    return (
        b"\x89PNG\r\n\x1a\n"
        + chunk(b"IHDR", struct.pack(">IIBBBBB", width, height, 8, 6, 0, 0, 0))
        + chunk(b"IDAT", zlib.compress(raw, 9))
        + chunk(b"IEND", b"")
    )


def dist_to_segment(px, py, ax, ay, bx, by):
    dx, dy = bx - ax, by - ay
    t = max(0.0, min(1.0, ((px - ax) * dx + (py - ay) * dy) / (dx * dx + dy * dy)))
    return math.hypot(px - (ax + t * dx), py - (ay + t * dy))


def icon(size):
    ss = 4  # supersampling for anti-aliasing
    radius = 0.22
    stroke = 0.09
    check = [(0.27, 0.53), (0.44, 0.69), (0.74, 0.35)]
    rows = []
    for y in range(size):
        row = []
        for x in range(size):
            bg = fg = 0
            for sy in range(ss):
                for sx in range(ss):
                    u = (x + (sx + 0.5) / ss) / size
                    v = (y + (sy + 0.5) / ss) / size
                    # rounded square
                    qx = max(abs(u - 0.5) - (0.5 - radius), 0)
                    qy = max(abs(v - 0.5) - (0.5 - radius), 0)
                    if math.hypot(qx, qy) <= radius:
                        bg += 1
                        d = min(dist_to_segment(u, v, *check[0], *check[1]), dist_to_segment(u, v, *check[1], *check[2]))
                        if d <= stroke / 2:
                            fg += 1
            n = ss * ss
            alpha = round(255 * bg / n)
            mix = fg / bg if bg else 0
            color = tuple(round(PURPLE[i] * (1 - mix) + WHITE[i] * mix) for i in range(3))
            row.append((*color, alpha))
        rows.append(row)
    return png(size, size, rows)


if __name__ == "__main__":
    OUT.mkdir(parents=True, exist_ok=True)
    for s in (16, 48, 128):
        (OUT / f"icon{s}.png").write_bytes(icon(s))
        print(f"wrote icon{s}.png")
