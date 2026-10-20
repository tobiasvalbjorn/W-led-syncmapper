"""Generate the PNG icons (add-on icon/logo, HACS brand icon) without Pillow.

    python tools/make_icons.py
"""
import math
import struct
import zlib
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
COLORS = [(255, 95, 109), (255, 195, 113), (71, 207, 115)]


def render(size: int):
    rows = []
    radius = size * 0.22
    dot = size * 0.078
    centers = [(size * fx, size * fy) for fy in (0.34, 0.66) for fx in (0.27, 0.5, 0.73)]
    for y in range(size):
        row = bytearray([0])  # filter: none
        for x in range(size):
            # rounded-square mask with 1px anti-aliasing
            cx = min(max(x + 0.5, radius), size - radius)
            cy = min(max(y + 0.5, radius), size - radius)
            d = math.hypot(x + 0.5 - cx, y + 0.5 - cy)
            alpha = max(0.0, min(1.0, radius - d + 0.5))
            r, g, b = 17, 18, 20
            for i, (px, py) in enumerate(centers):
                dd = math.hypot(x + 0.5 - px, y + 0.5 - py)
                k = max(0.0, min(1.0, dot - dd + 0.5))
                if k:
                    t = (x / size)
                    c0, c1 = COLORS[0], COLORS[2] if i % 3 == 2 else COLORS[1]
                    col = tuple(int(a + (bb - a) * t) for a, bb in zip(c0, c1))
                    r, g, b = (int(r + (col[j] - (r, g, b)[j]) * k) for j in range(3))
            row += bytes((r, g, b, int(alpha * 255)))
        rows.append(bytes(row))
    raw = b"".join(rows)

    def chunk(tag, data):
        return struct.pack("!I", len(data)) + tag + data + struct.pack("!I", zlib.crc32(tag + data) & 0xFFFFFFFF)

    return (b"\x89PNG\r\n\x1a\n" + chunk(b"IHDR", struct.pack("!IIBBBBB", size, size, 8, 6, 0, 0, 0))
            + chunk(b"IDAT", zlib.compress(raw, 9)) + chunk(b"IEND", b""))


if __name__ == "__main__":
    targets = {
        ROOT / "wled_hub" / "icon.png": 128,
        ROOT / "wled_hub" / "logo.png": 250,
        ROOT / "custom_components" / "wled_hub" / "brand" / "icon.png": 256,
        ROOT / "wled_hub" / "frontend" / "icons" / "icon-192.png": 192,
        ROOT / "wled_hub" / "frontend" / "icons" / "icon-512.png": 512,
    }
    for path, size in targets.items():
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_bytes(render(size))
        print("wrote", path.relative_to(ROOT))
