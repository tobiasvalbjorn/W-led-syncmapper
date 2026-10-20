"""Effect Studio: user-built effects made of stacked layers, and painted scenes.

A custom effect definition (stored in HubConfig.custom_effects):

    {
      "name": "Red and blue lines",
      "background": "#000000",
      "layers": [
        {"type": "lines", "colors": ["#ff0000", "#0040ff"], "count": 3, "width": 0.06,
         "softness": 0.5, "angle": 0, "speed": 0.25, "bounce": false,
         "opacity": 1, "blend": "over"},
        {"type": "sparkle", "color": "#ffffff", "density": 0.3, "fade": 0.6, "opacity": 0.8, "blend": "add"}
      ]
    }

Positions are the effect coordinates (0..1 across the house or room, see
mapping.fit_to_box). Speeds are in "house widths" (or cycles) per second
and are multiplied by the room's speed slider (128 = 1x).

A scene (HubConfig.scenes) is a painted picture: one colour per LED,
stored per device as a hex string ("rrggbb" per LED, "000000" = off).
"""
from __future__ import annotations

import math
import random
from typing import Any, Dict, List, Sequence, Tuple

RGB = Tuple[int, int, int]
Coord = Tuple[float, float]

LAYER_TYPES = ("lines", "gradient", "rings", "wave", "sparkle", "solid")
MAX_LAYERS = 8


def hex_rgb(value: Any, default: RGB = (255, 255, 255)) -> RGB:
    if isinstance(value, (list, tuple)) and len(value) >= 3:
        return tuple(max(0, min(255, int(v))) for v in value[:3])  # type: ignore[return-value]
    if isinstance(value, str):
        v = value.strip().lstrip("#")
        if len(v) == 6:
            try:
                return int(v[0:2], 16), int(v[2:4], 16), int(v[4:6], 16)
            except ValueError:
                pass
    return default


def _num(layer: dict, key: str, default: float, lo: float, hi: float) -> float:
    try:
        return max(lo, min(hi, float(layer.get(key, default))))
    except (TypeError, ValueError):
        return default


def _colors(layer: dict) -> List[RGB]:
    cols = [hex_rgb(c) for c in (layer.get("colors") or [])][:12]
    return cols or [hex_rgb(layer.get("color", "#ffffff"))]


def _along(coords: Sequence[Coord], angle: float) -> List[float]:
    """Position of every LED along a direction, 0..1 across the area."""
    rad = math.radians(angle)
    dx, dy = math.cos(rad), math.sin(rad)
    span = abs(dx) + abs(dy) or 1.0
    offset = min(0.0, dx) + min(0.0, dy)
    return [((x * dx + y * dy) - offset) / span for x, y in coords]


def _mix(a: Sequence[float], b: Sequence[float], t: float) -> Tuple[float, float, float]:
    return (a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t)


def _band(dist: float, half: float, softness: float) -> float:
    """1 inside a band of half-width `half`, fading to 0 over the soft edge."""
    if half <= 0:
        return 0.0
    core = half * (1.0 - softness)
    if dist <= core:
        return 1.0
    if dist >= half:
        return 0.0
    return 1.0 - (dist - core) / max(1e-9, half - core)


def _triangle(x: float) -> float:
    """0 -> 1 -> 0 over every unit of x (for bouncing motion)."""
    f = x % 2.0
    return f if f <= 1.0 else 2.0 - f


# ----------------------------------------------------------------- layers
# Each returns [(rgb, alpha)] per LED.

def _lines(layer, coords, t, speed):
    count = int(_num(layer, "count", 3, 1, 50))
    width = _num(layer, "width", 0.06, 0.002, 1.0)
    soft = _num(layer, "softness", 0.5, 0.0, 1.0)
    velocity = _num(layer, "speed", 0.25, -5.0, 5.0) * speed
    cols = _colors(layer)
    pos = _along(coords, _num(layer, "angle", 0, -360, 360))
    period = 1.0 / count
    shift = _triangle(t * abs(velocity)) * (1 if velocity >= 0 else -1) if layer.get("bounce") else t * velocity
    out = []
    for p in pos:
        phase = (p - shift) / period
        nearest = math.floor(phase + 0.5)
        dist = abs(phase - nearest) * period
        out.append((cols[int(nearest) % len(cols)], _band(dist, width / 2, soft)))
    return out


def _gradient(layer, coords, t, speed):
    cols = _colors(layer)
    if len(cols) == 1:
        cols = cols * 2
    repeat = _num(layer, "repeat", 1, 0.1, 20)
    velocity = _num(layer, "speed", 0.1, -5.0, 5.0) * speed
    pos = _along(coords, _num(layer, "angle", 0, -360, 360))
    n = len(cols)
    out = []
    for p in pos:
        f = ((p * repeat - t * velocity) % 1.0) * n  # cyclic: last colour blends back to the first
        i = int(f) % n
        out.append((_mix(cols[i], cols[(i + 1) % n], f - int(f)), 1.0))
    return out


def _rings(layer, coords, t, speed):
    count = _num(layer, "count", 3, 1, 30)
    width = _num(layer, "width", 0.08, 0.005, 1.0)
    soft = _num(layer, "softness", 0.6, 0.0, 1.0)
    velocity = _num(layer, "speed", 0.3, -5.0, 5.0) * speed
    cx, cy = _num(layer, "cx", 0.5, -1, 2), _num(layer, "cy", 0.5, -1, 2)
    cols = _colors(layer)
    period = 1.0 / count
    out = []
    for x, y in coords:
        phase = (math.hypot(x - cx, y - cy) - t * velocity) / period
        nearest = math.floor(phase + 0.5)
        dist = abs(phase - nearest) * period
        out.append((cols[int(nearest) % len(cols)], _band(dist, width / 2, soft)))
    return out


def _wave(layer, coords, t, speed):
    wavelength = _num(layer, "wavelength", 0.5, 0.02, 5.0)
    sharp = _num(layer, "sharpness", 2.0, 0.2, 20.0)
    velocity = _num(layer, "speed", 0.2, -5.0, 5.0) * speed
    cols = _colors(layer)
    pos = _along(coords, _num(layer, "angle", 0, -360, 360))
    out = []
    for p in pos:
        phase = p / wavelength - t * velocity
        a = (0.5 + 0.5 * math.sin(2 * math.pi * phase)) ** sharp
        out.append((cols[int(math.floor(phase)) % len(cols)], a))
    return out


def _sparkle(layer, coords, t, speed, state):
    density = _num(layer, "density", 0.3, 0.0, 20.0) * max(0.05, speed)
    fade = _num(layer, "fade", 0.6, 0.02, 10.0)
    cols = _colors(layer)
    n = len(coords)
    levels: List[float] = state.get("levels") or []
    hues: List[int] = state.get("hues") or []
    if len(levels) != n:
        levels, hues = [0.0] * n, [0] * n
    dt = max(0.0, min(0.25, t - state.get("t", t)))
    decay = dt / fade
    chance = dt * density
    out = []
    for i in range(n):
        level = max(0.0, levels[i] - decay)
        if random.random() < chance:
            level, hues[i] = 1.0, random.randrange(len(cols))
        levels[i] = level
        out.append((cols[hues[i] % len(cols)], level))
    state.update(levels=levels, hues=hues, t=t)
    return out


def _solid(layer, coords, t, speed):
    c = hex_rgb(layer.get("color", (layer.get("colors") or ["#ffffff"])[0]))
    return [(c, 1.0)] * len(coords)


def render_definition(definition: dict, coords: List[Coord], t: float, speed: float,
                      states: Dict[int, dict]) -> List[RGB]:
    """Composite all layers (bottom first) over the background colour."""
    bg = hex_rgb(definition.get("background", "#000000"), (0, 0, 0))
    out = [[float(bg[0]), float(bg[1]), float(bg[2])] for _ in coords]
    for index, layer in enumerate((definition.get("layers") or [])[:MAX_LAYERS]):
        if not isinstance(layer, dict) or layer.get("enabled") is False:
            continue
        kind = layer.get("type")
        if kind == "lines":
            px = _lines(layer, coords, t, speed)
        elif kind == "gradient":
            px = _gradient(layer, coords, t, speed)
        elif kind == "rings":
            px = _rings(layer, coords, t, speed)
        elif kind == "wave":
            px = _wave(layer, coords, t, speed)
        elif kind == "sparkle":
            px = _sparkle(layer, coords, t, speed, states.setdefault(index, {}))
        elif kind == "solid":
            px = _solid(layer, coords, t, speed)
        else:
            continue
        opacity = _num(layer, "opacity", 1.0, 0.0, 1.0)
        add = layer.get("blend") == "add"
        for o, (c, a) in zip(out, px):
            a *= opacity
            if a <= 0:
                continue
            if add:
                o[0] = min(255.0, o[0] + c[0] * a)
                o[1] = min(255.0, o[1] + c[1] * a)
                o[2] = min(255.0, o[2] + c[2] * a)
            else:
                o[0] += (c[0] - o[0]) * a
                o[1] += (c[1] - o[1]) * a
                o[2] += (c[2] - o[2]) * a
    return [(int(r), int(g), int(b)) for r, g, b in out]


def clean_definition(data: dict) -> dict:
    """Keep a definition small and well-formed before it is stored."""
    layers = []
    for layer in (data.get("layers") or [])[:MAX_LAYERS]:
        if isinstance(layer, dict) and layer.get("type") in LAYER_TYPES:
            layers.append({k: v for k, v in layer.items() if isinstance(v, (int, float, str, bool, list)) or v is None})
    return {
        "name": str(data.get("name") or "My effect")[:60],
        "background": str(data.get("background") or "#000000")[:7],
        "layers": layers,
    }


# ----------------------------------------------------------------- scenes

def decode_scene_pixels(hexstr: str, count: int) -> List[RGB]:
    out: List[RGB] = []
    for i in range(count):
        chunk = hexstr[i * 6 : i * 6 + 6]
        out.append(hex_rgb(chunk, (0, 0, 0)) if len(chunk) == 6 else (0, 0, 0))
    return out


def clean_scene(data: dict) -> dict:
    pixels = {}
    for device_id, value in (data.get("pixels") or {}).items():
        if isinstance(value, str):
            v = "".join(ch for ch in value.lower() if ch in "0123456789abcdef")
            pixels[str(device_id)] = v[: 6 * 4096]
    return {"name": str(data.get("name") or "My scene")[:60], "pixels": pixels}

