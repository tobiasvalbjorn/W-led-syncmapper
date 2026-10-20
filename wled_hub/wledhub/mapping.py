"""Turns layout placements into one canvas coordinate per LED.

Coordinates are returned normalised to 0..1 on both axes (relative to the
layout's width/height) so effects never need to know the house's size.
"""
from __future__ import annotations

import math
from typing import Dict, List, Tuple

from .models import Device, Layout, Placement

Coord = Tuple[float, float]


def _polyline(points: List[List[float]], count: int) -> List[Coord]:
    if count <= 0:
        return []
    if not points:
        return [(0.0, 0.0)] * count
    if len(points) == 1 or count == 1:
        return [(float(points[0][0]), float(points[0][1]))] * count

    segments = []
    total = 0.0
    for a, b in zip(points, points[1:]):
        length = math.hypot(b[0] - a[0], b[1] - a[1])
        segments.append((a, b, length))
        total += length
    if total == 0:
        return [(float(points[0][0]), float(points[0][1]))] * count

    coords: List[Coord] = []
    seg_index = 0
    seg_start = 0.0
    for i in range(count):
        # LED centres: first LED on the first point, last LED on the last point
        dist = total * i / (count - 1)
        while seg_index < len(segments) - 1 and dist > seg_start + segments[seg_index][2]:
            seg_start += segments[seg_index][2]
            seg_index += 1
        a, b, length = segments[seg_index]
        t = 0.0 if length == 0 else min(1.0, max(0.0, (dist - seg_start) / length))
        coords.append((a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t))
    return coords


def _anchored(points: List[List[float]], anchors: List[int], count: int) -> List[Coord]:
    """LEDs between two anchored points are spread evenly on that segment."""
    coords: List[Coord] = []
    last = len(points) - 1
    for i in range(count):
        if i <= anchors[0]:
            coords.append((float(points[0][0]), float(points[0][1])))
            continue
        if i >= anchors[last]:
            coords.append((float(points[last][0]), float(points[last][1])))
            continue
        j = 0
        while j < last - 1 and anchors[j + 1] <= i:
            j += 1
        a, b = points[j], points[j + 1]
        span = anchors[j + 1] - anchors[j]
        t = 0.0 if span <= 0 else (i - anchors[j]) / span
        coords.append((a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t))
    return coords


def anchors_valid(anchors: List[int], points: List[List[float]]) -> bool:
    return (
        len(points) >= 2
        and len(anchors) == len(points)
        and all(b >= a for a, b in zip(anchors, anchors[1:]))
    )


def _matrix(p: Placement, count: int) -> List[Coord]:
    cols = p.cols or 1
    rows = p.rows or max(1, math.ceil(count / cols))
    coords: List[Coord] = []
    flip_x = p.origin.endswith("right")
    flip_y = p.origin.startswith("bottom")
    for i in range(count):
        if p.vertical:
            major, minor = divmod(i, rows)  # major = column, minor = row
            if p.serpentine and major % 2 == 1:
                minor = rows - 1 - minor
            col, row = major, minor
        else:
            major, minor = divmod(i, cols)  # major = row, minor = column
            if p.serpentine and major % 2 == 1:
                minor = cols - 1 - minor
            col, row = minor, major
        if flip_x:
            col = cols - 1 - col
        if flip_y:
            row = rows - 1 - row
        cx = p.x + (col + 0.5) * p.width / cols
        cy = p.y + (row + 0.5) * p.height / rows
        coords.append((cx, cy))
    return coords


def placement_coords(p: Placement, device_leds: int) -> List[Coord]:
    count = p.count or max(0, device_leds - p.start)
    if p.shape == "matrix":
        coords = _matrix(p, count)
    elif p.shape == "points":
        coords = [(float(pt[0]), float(pt[1])) for pt in p.points[:count]]
        coords += [coords[-1] if coords else (0.0, 0.0)] * (count - len(coords))
    elif anchors_valid(p.anchors, p.points):
        coords = _anchored(p.points, p.anchors, count)
    else:
        coords = _polyline(p.points, count)
    if p.reverse:
        coords.reverse()
    return coords


def device_pixel_map(device: Device, layout: Layout, fallback_row: int = 0) -> List[Coord]:
    """Normalised (x, y) for every LED on a device.

    LEDs without a placement get a fallback position: a horizontal line in
    their own row, so new devices still show something sensible.
    """
    n = device.led_count
    w = layout.width or 1.0
    h = layout.height or 1.0
    result: List[Coord] = [(-1.0, -1.0)] * n

    for p in layout.placements:
        if p.device_id != device.id:
            continue
        for offset, (x, y) in enumerate(placement_coords(p, n)):
            idx = p.start + offset
            if 0 <= idx < n:
                result[idx] = (x / w, y / h)

    row_y = min(0.95, 0.05 + 0.1 * fallback_row)
    for i, (x, _y) in enumerate(result):
        if x < 0:
            result[i] = (i / max(1, n - 1), row_y)
    return result


def build_pixel_maps(devices: List[Device], layout: Layout) -> Dict[str, List[Coord]]:
    return {d.id: device_pixel_map(d, layout, row) for row, d in enumerate(devices)}
