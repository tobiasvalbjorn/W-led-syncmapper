"""Hub effects: rendered on the shared canvas, independent of device.

Each effect gets the normalised (x, y) of every LED in the room or group it
runs on, so a wave started in the living room continues on the terrace if
both are part of the same group. Effects return 8-bit RGB tuples; global
brightness is applied by the engine.

To add an effect: subclass Effect, set key/name/params, implement render(),
and decorate with @register.
"""
from __future__ import annotations

import colorsys
import math
import random
from typing import Dict, List, Sequence, Tuple, Type

RGB = Tuple[int, int, int]
Coord = Tuple[float, float]

REGISTRY: Dict[str, Type["Effect"]] = {}


def register(cls: Type["Effect"]) -> Type["Effect"]:
    REGISTRY[cls.key] = cls
    return cls


def hsv(h: float, s: float = 1.0, v: float = 1.0) -> RGB:
    r, g, b = colorsys.hsv_to_rgb(h % 1.0, s, v)
    return int(r * 255), int(g * 255), int(b * 255)


def mix(a: Sequence[int], b: Sequence[int], t: float) -> RGB:
    t = min(1.0, max(0.0, t))
    return (
        int(a[0] + (b[0] - a[0]) * t),
        int(a[1] + (b[1] - a[1]) * t),
        int(a[2] + (b[2] - a[2]) * t),
    )


def scale(c: Sequence[int], f: float) -> RGB:
    f = min(1.0, max(0.0, f))
    return int(c[0] * f), int(c[1] * f), int(c[2] * f)


class Effect:
    key = ""
    name = ""
    description = ""
    hidden = False  # not in the effect list (studio/scene are picked from "My effects")
    # Extra params beyond speed/intensity/colours, described for the UI:
    # {"angle": {"type": "range", "min": 0, "max": 360, "default": 0, "label": "Direction"}}
    params: Dict[str, dict] = {}

    def __init__(self) -> None:
        self.state: dict = {}

    @staticmethod
    def speed_factor(speed: int) -> float:
        """Map WLED-style speed 0..255 to roughly 0.02..2 cycles per second."""
        return 0.02 + (speed / 255.0) ** 2 * 2.0

    def param(self, opts: dict, key: str):
        return opts.get("params", {}).get(key, self.params.get(key, {}).get("default"))

    def render(self, coords: List[Coord], t: float, opts: dict) -> List[RGB]:
        raise NotImplementedError

    @classmethod
    def describe(cls) -> dict:
        return {
            "key": cls.key,
            "name": cls.name,
            "description": cls.description,
            "params": cls.params,
        }


def _direction(angle_deg: float) -> Tuple[float, float]:
    rad = math.radians(angle_deg)
    return math.cos(rad), math.sin(rad)


@register
class RainbowWave(Effect):
    key = "rainbow_wave"
    name = "Rainbow wave"
    description = "A rainbow rolling across the whole house"
    params = {"angle": {"type": "range", "min": 0, "max": 359, "default": 0, "label": "Direction"}}

    def render(self, coords, t, opts):
        dx, dy = _direction(self.param(opts, "angle"))
        width = 0.2 + (opts["intensity"] / 255.0) * 2.0  # rainbows across canvas
        shift = t * self.speed_factor(opts["speed"])
        return [hsv((x * dx + y * dy) * width - shift) for x, y in coords]


@register
class GradientSweep(Effect):
    key = "gradient_sweep"
    name = "Colour sweep"
    description = "A soft blend between two colours sliding across the grid"
    params = {"angle": {"type": "range", "min": 0, "max": 359, "default": 0, "label": "Direction"}}

    def render(self, coords, t, opts):
        dx, dy = _direction(self.param(opts, "angle"))
        c1, c2 = opts["color"], opts["color2"]
        waves = 0.5 + opts["intensity"] / 255.0 * 3.0
        shift = t * self.speed_factor(opts["speed"])
        out = []
        for x, y in coords:
            phase = ((x * dx + y * dy) * waves - shift) * 2 * math.pi
            out.append(mix(c1, c2, 0.5 + 0.5 * math.sin(phase)))
        return out


@register
class RadialPulse(Effect):
    key = "radial_pulse"
    name = "Centre pulse"
    description = "Rings spreading out from a point"
    params = {
        "cx": {"type": "range", "min": 0, "max": 100, "default": 50, "label": "Centre X %"},
        "cy": {"type": "range", "min": 0, "max": 100, "default": 50, "label": "Centre Y %"},
    }

    def render(self, coords, t, opts):
        cx = self.param(opts, "cx") / 100.0
        cy = self.param(opts, "cy") / 100.0
        rings = 1.0 + opts["intensity"] / 255.0 * 6.0
        shift = t * self.speed_factor(opts["speed"])
        c1, c2 = opts["color"], opts["color2"]
        out = []
        for x, y in coords:
            d = math.hypot(x - cx, y - cy)
            v = 0.5 + 0.5 * math.cos((d * rings - shift) * 2 * math.pi)
            out.append(mix(c2, c1, v ** 3))
        return out


@register
class Plasma(Effect):
    key = "plasma"
    name = "Plasma"
    description = "Organic, flowing colour patterns"

    def render(self, coords, t, opts):
        k = 2.0 + opts["intensity"] / 255.0 * 10.0
        s = t * self.speed_factor(opts["speed"]) * 2.0
        out = []
        for x, y in coords:
            v = (
                math.sin(x * k + s)
                + math.sin((y * k + s) / 2.0)
                + math.sin((x * k + y * k + s) / 2.0)
                + math.sin(math.hypot(x - 0.5, y - 0.5) * k * 2 - s)
            )
            out.append(hsv(v / 8.0 + s * 0.05))
        return out


@register
class Aurora(Effect):
    key = "aurora"
    name = "Aurora"
    description = "Green and violet veils slowly rippling"

    def render(self, coords, t, opts):
        s = t * self.speed_factor(opts["speed"])
        k = 1.0 + opts["intensity"] / 255.0 * 6.0
        out = []
        for x, y in coords:
            band = math.sin(x * k * 3.1 + s * 1.3) + math.sin(x * k * 1.7 - s * 0.7 + y * 2.0)
            v = max(0.0, band / 2.0) ** 1.5
            hue = 0.33 + 0.12 * math.sin(x * 2.0 + s * 0.3) + 0.15 * math.sin(y * 3.0 - s * 0.2)
            out.append(hsv(hue, 0.85, 0.08 + 0.92 * v))
        return out


@register
class Comet(Effect):
    key = "comet"
    name = "Comet"
    description = "A point of light with a tail racing through the whole house"
    params = {"angle": {"type": "range", "min": 0, "max": 359, "default": 0, "label": "Direction"}}

    def render(self, coords, t, opts):
        dx, dy = _direction(self.param(opts, "angle"))
        # project onto the direction, normalised to 0..1 across the canvas
        span = abs(dx) + abs(dy) or 1.0
        offset = (min(0.0, dx) + min(0.0, dy))
        head = (t * self.speed_factor(opts["speed"]) * 0.5) % 1.3 - 0.15
        tail = 0.03 + opts["intensity"] / 255.0 * 0.4
        c, bg = opts["color"], opts["color2"]
        out = []
        for x, y in coords:
            p = ((x * dx + y * dy) - offset) / span
            d = head - p
            if 0 <= d < tail:
                out.append(mix(bg, c, (1 - d / tail) ** 2))
            elif -0.01 < d < 0:
                out.append((255, 255, 255))
            else:
                out.append(tuple(bg))  # type: ignore[arg-type]
        return out


@register
class LineSweep(Effect):
    key = "line_sweep"
    name = "Line sweep"
    description = "A bright line that sweeps across the whole house"
    params = {
        "angle": {"type": "range", "min": 0, "max": 359, "default": 0, "label": "Direction"},
        "width": {"type": "range", "min": 1, "max": 50, "default": 6, "label": "Line width %"},
    }

    def render(self, coords, t, opts):
        dx, dy = _direction(self.param(opts, "angle"))
        span = abs(dx) + abs(dy) or 1.0
        offset = min(0.0, dx) + min(0.0, dy)
        width = max(0.005, self.param(opts, "width") / 100.0)
        # travels 0 -> 1 across the lit area, with a short pause off each end
        pos = (t * self.speed_factor(opts["speed"]) * 0.5) % (1.0 + 4 * width) - 2 * width
        c, bg = opts["color"], opts["color2"]
        out = []
        for x, y in coords:
            d = abs(((x * dx + y * dy) - offset) / span - pos)
            out.append(mix(bg, c, 1.0 - d / width) if d < width else tuple(bg))  # type: ignore[arg-type]
        return out


@register
class Twinkle(Effect):
    key = "twinkle"
    name = "Twinkle"
    description = "Random sparkles that light up and fade out"

    def render(self, coords, t, opts):
        n = len(coords)
        levels: List[float] = self.state.get("levels", [])
        if len(levels) != n:
            levels = [0.0] * n
        last = self.state.get("t", t)
        dt = max(0.0, min(0.2, t - last))
        decay = dt * (0.5 + self.speed_factor(opts["speed"]) * 2)
        chance = dt * (0.05 + opts["intensity"] / 255.0 * 2.0)
        c, bg = opts["color"], opts["color2"]
        out = []
        for i in range(n):
            level = max(0.0, levels[i] - decay)
            if random.random() < chance:
                level = 1.0
            levels[i] = level
            out.append(mix(bg, c, level))
        self.state["levels"] = levels
        self.state["t"] = t
        return out


@register
class Fire(Effect):
    key = "fire"
    name = "Fire"
    description = "Flames licking upwards (uses the Y axis)"

    def render(self, coords, t, opts):
        s = t * (1.0 + self.speed_factor(opts["speed"]) * 4)
        k = 4.0 + opts["intensity"] / 255.0 * 12.0
        out = []
        for x, y in coords:
            flicker = (
                math.sin(x * k * 1.7 + s * 3.1) * 0.5
                + math.sin(x * k * 3.3 - s * 4.7) * 0.3
                + math.sin(x * k * 7.1 + s * 6.3) * 0.2
            )
            heat = max(0.0, min(1.0, y * 1.2 + flicker * 0.25))  # y=1 bottom is hottest
            out.append(_heat_color(heat))
        return out


def _heat_color(h: float) -> RGB:
    if h < 0.33:
        return int(h / 0.33 * 255), 0, 0
    if h < 0.66:
        return 255, int((h - 0.33) / 0.33 * 200), 0
    return 255, 200 + int((h - 0.66) / 0.34 * 55), int((h - 0.66) / 0.34 * 180)


@register
class Breathe(Effect):
    key = "breathe"
    name = "Breathe"
    description = "All lights breathe calmly in sync"

    def render(self, coords, t, opts):
        v = 0.5 - 0.5 * math.cos(t * self.speed_factor(opts["speed"]) * 2 * math.pi)
        floor = opts["intensity"] / 255.0 * 0.5
        color = scale(opts["color"], floor + (1 - floor) * v)
        return [color] * len(coords)


def create(key: str) -> Effect:
    try:
        return REGISTRY[key]()
    except KeyError:
        raise KeyError(f"Unknown hub effect '{key}'") from None


@register
class StudioEffect(Effect):
    """A custom effect built in the Effect Studio (see studio.py).

    params: {"custom_id": "<saved effect>"} or, while designing,
    {"custom_id": null, "layers": [...], "background": "#000000"}.
    """

    key = "studio"
    name = "Custom effect"
    hidden = True

    def render(self, coords, t, opts):
        from .studio import render_definition

        params = opts.get("params") or {}
        definition = (opts.get("custom") or {}).get(params.get("custom_id") or "") or params
        return render_definition(definition, coords, t, opts["speed"] / 128.0, self.state.setdefault("layers", {}))


@register
class SceneEffect(Effect):
    """A painted scene: per-LED colours, rendered by the hub per device (see Hub._render_frame)."""

    key = "scene"
    name = "Scene"
    hidden = True

    def render(self, coords, t, opts):  # the hub fills scenes itself, by device and LED index
        return [(0, 0, 0)] * len(coords)


def catalogue() -> List[dict]:
    return [cls.describe() for cls in REGISTRY.values() if not cls.hidden]
