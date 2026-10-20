"""Turns layout placements into one canvas coordinate per LED.

Coordinates are returned normalised to 0..1 on both axes (relative to the
layout's width/height) so effects never need to know the house's size.
"""
from __future__ import annotations

import math
from typing import Dict, List, Optional, Tuple

from .models import Device, Layout, Placement

Coord = Tuple[float, float]


# --- segments: straight, or a circular arc given by a "bulge" -------------
#
# bulge = tan(sweep / 4), like DXF polylines: 0 = straight, 1 = half circle,
# about 0.414 = quarter circle. Positive bulges curve to the left of the
# direction of travel (in x-right / y-down canvas coordinates: to the right
# on screen when going up). A full circle is two points with bulge 1 twice.


def _arc(a, b, bulge):
    """(center, radius, start angle, sweep) of an arc segment, or None if straight."""
    if abs(bulge) < 1e-6:
        return None
    dx, dy = b[0] - a[0], b[1] - a[1]
    c = math.hypot(dx, dy)
    if c == 0:
        return None
    nx, ny = -dy / c, dx / c  # left normal
    s = bulge * c / 2  # signed sagitta
    r = (c * c / 4 + s * s) / (2 * abs(s))
    mx, my = (a[0] + b[0]) / 2, (a[1] + b[1]) / 2
    off = s - math.copysign(r, s)
    cx, cy = mx + nx * off, my + ny * off
    a0 = math.atan2(a[1] - cy, a[0] - cx)
    amid = math.atan2(my + ny * s - cy, mx + nx * s - cx)  # arc midpoint
    half = (amid - a0 + math.pi) % (2 * math.pi) - math.pi
    return cx, cy, r, a0, 2 * half


def seg_length(a, b, bulge: float = 0.0) -> float:
    arc = _arc(a, b, bulge)
    if arc is None:
        return math.hypot(b[0] - a[0], b[1] - a[1])
    return arc[2] * abs(arc[4])


def seg_point(a, b, bulge: float, t: float) -> Coord:
    arc = _arc(a, b, bulge)
    if arc is None:
        return (a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t)
    cx, cy, r, a0, sweep = arc
    ang = a0 + sweep * t
    return (cx + r * math.cos(ang), cy + r * math.sin(ang))


def _bulge(bulges: List[float], k: int) -> float:
    return float(bulges[k]) if k < len(bulges) else 0.0


def _polyline(points: List[List[float]], count: int, bulges: Optional[List[float]] = None) -> List[Coord]:
    bulges = bulges or []
    if count <= 0:
        return []
    if not points:
        return [(0.0, 0.0)] * count
    if len(points) == 1 or count == 1:
        return [(float(points[0][0]), float(points[0][1]))] * count

    segments = []
    total = 0.0
    for k, (a, b) in enumerate(zip(points, points[1:])):
        length = seg_length(a, b, _bulge(bulges, k))
        segments.append((a, b, length, _bulge(bulges, k)))
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
        a, b, length, bulge = segments[seg_index]
        t = 0.0 if length == 0 else min(1.0, max(0.0, (dist - seg_start) / length))
        coords.append(seg_point(a, b, bulge, t))
    return coords


def _anchored(points: List[List[float]], anchors: List[int], count: int,
              bulges: Optional[List[float]] = None) -> List[Coord]:
    """LEDs between two anchored points are spread evenly on that segment."""
    bulges = bulges or []
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
        span = anchors[j + 1] - anchors[j]
        t = 0.0 if span <= 0 else (i - anchors[j]) / span
        coords.append(seg_point(points[j], points[j + 1], _bulge(bulges, j), t))
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
        coords = _anchored(p.points, p.anchors, count, p.bulges)
    else:
        coords = _polyline(p.points, count, p.bulges)
    if p.reverse:
        coords.reverse()
    return coords


def device_pixel_map(device: Device, layout: Layout) -> List[Optional[Coord]]:
    """Normalised (x, y) for every LED on a device, or None for "stay dark".

    Strict: only LEDs drawn on the grid take part in hub effects. Every other
    LED is None and stays off – including every LED of a device that has no
    placement yet.
    """
    n = device.led_count
    w = layout.width or 1.0
    h = layout.height or 1.0
    result: List[Optional[Coord]] = [None] * n

    for p in layout.placements:
        if p.device_id != device.id:
            continue
        for offset, (x, y) in enumerate(placement_coords(p, n)):
            idx = p.start + offset
            if 0 <= idx < n:
                result[idx] = (x / w, y / h)
    return result


def _as_list(layouts) -> List[Layout]:
    return [layouts] if isinstance(layouts, Layout) else list(layouts)


def mapped_ranges(device: Device, layouts) -> List[Tuple[int, int]]:
    """Merged [start, stop) LED ranges of a device that are on any grid."""
    spans = []
    for p in (q for layout in _as_list(layouts) for q in layout.placements):
        if p.device_id != device.id:
            continue
        count = p.count or max(0, device.led_count - p.start)
        start, stop = max(0, p.start), min(device.led_count, p.start + count)
        if stop > start:
            spans.append((start, stop))
    merged: List[Tuple[int, int]] = []
    for start, stop in sorted(spans):
        if merged and start <= merged[-1][1]:
            merged[-1] = (merged[-1][0], max(merged[-1][1], stop))
        else:
            merged.append((start, stop))
    return merged


Box = Tuple[float, float, float, float]


def bounding_box(coords) -> Optional[Box]:
    """(min_x, min_y, span_x, span_y) of the given coords, ignoring None."""
    pts = [c for c in coords if c is not None]
    if not pts:
        return None
    xs = [c[0] for c in pts]
    ys = [c[1] for c in pts]
    return min(xs), min(ys), max(xs) - min(xs), max(ys) - min(ys)


def fit_to_box(coords: List[Coord], box: Optional[Box]) -> List[Coord]:
    """Stretch coords so the box becomes 0..1 on both axes.

    Effects then span exactly the lit area – the whole house, or one room –
    however big the canvas is. A flat box (a single straight strip) keeps
    0.5 on the flat axis.
    """
    if box is None:
        return coords
    x0, y0, sx, sy = box
    fx = (lambda x: (x - x0) / sx) if sx > 1e-9 else (lambda x: 0.5)
    fy = (lambda y: (y - y0) / sy) if sy > 1e-9 else (lambda y: 0.5)
    return [(fx(x), fy(y)) for x, y in coords]


def build_pixel_maps(devices: List[Device], layouts) -> Tuple[Dict[str, List[Optional[Coord]]], Dict[str, List[Optional[str]]]]:
    """Per device: normalised (x, y) per LED, and which grid each LED is on.

    Coordinates of different grids are not comparable, so effects are fitted
    per grid (see Hub._render_frame). If an LED is on two grids the last wins.
    """
    maps: Dict[str, List[Optional[Coord]]] = {}
    grids: Dict[str, List[Optional[str]]] = {}
    for d in devices:
        coords: List[Optional[Coord]] = [None] * d.led_count
        gids: List[Optional[str]] = [None] * d.led_count
        for layout in _as_list(layouts):
            for i, c in enumerate(device_pixel_map(d, layout)):
                if c is not None:
                    coords[i], gids[i] = c, layout.id
        maps[d.id], grids[d.id] = coords, gids
    return maps, grids
