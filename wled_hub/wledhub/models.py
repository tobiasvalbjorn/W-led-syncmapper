"""Data model for the WLED Hub.

Everything the hub persists lives in one JSON document (see store.py):

    {
      "version": 1,
      "devices":    { "<device_id>": Device },
      "rooms":      { "<room_id>":   Room },
      "groups":     { "<group_id>":  Group },
      "layouts":    { "<grid_id>": Layout },   # one grid per area, e.g. front of house, TV wall
      "settings":   Settings
    }

Rooms are the Sonos-style "speakers": every device belongs to at most one room.
Groups link rooms together so they are controlled (and animated) as one.
The layout maps every LED of every device onto one shared 2D canvas, which is
what lets hub effects flow across devices.
"""
from __future__ import annotations

import re
import time
import uuid
from dataclasses import asdict, dataclass, field
from typing import Any, Dict, List, Optional

SCHEMA_VERSION = 1


def new_id(prefix: str) -> str:
    return f"{prefix}_{uuid.uuid4().hex[:8]}"


def slugify(text: str) -> str:
    slug = re.sub(r"[^a-z0-9]+", "_", text.lower()).strip("_")
    return slug or "item"


# ---------------------------------------------------------------- light state


@dataclass
class EffectRef:
    """Which effect a room/group runs.

    source "wled": a built-in WLED effect, id = WLED fx index. Runs on the
                   devices themselves; the hub keeps them in time via UDP sync.
    source "hub":  a hub effect, id = effect key in effects.py. Rendered by the
                   hub on the shared canvas and streamed to devices over DDP.
    """

    source: str = "wled"  # "wled" | "hub"
    id: Any = 0  # int for wled, str for hub
    speed: int = 128  # 0-255
    intensity: int = 128  # 0-255
    palette: int = 0  # WLED palette index (wled source only)
    params: Dict[str, Any] = field(default_factory=dict)  # hub effect params

    @classmethod
    def from_dict(cls, data: Optional[dict]) -> "EffectRef":
        data = data or {}
        return cls(
            source=data.get("source", "wled"),
            id=data.get("id", 0),
            speed=int(data.get("speed", 128)),
            intensity=int(data.get("intensity", 128)),
            palette=int(data.get("palette", 0)),
            params=dict(data.get("params", {})),
        )


@dataclass
class LightState:
    on: bool = False
    brightness: int = 128  # 0-255
    color: List[int] = field(default_factory=lambda: [255, 160, 80])  # RGB
    color2: List[int] = field(default_factory=lambda: [0, 0, 0])
    effect: EffectRef = field(default_factory=EffectRef)
    updated: float = field(default_factory=time.time)

    @classmethod
    def from_dict(cls, data: Optional[dict]) -> "LightState":
        data = data or {}
        return cls(
            on=bool(data.get("on", False)),
            brightness=int(data.get("brightness", 128)),
            color=list(data.get("color", [255, 160, 80]))[:3],
            color2=list(data.get("color2", [0, 0, 0]))[:3],
            effect=EffectRef.from_dict(data.get("effect")),
            updated=float(data.get("updated", time.time())),
        )


# -------------------------------------------------------------------- devices


@dataclass
class Device:
    id: str
    name: str
    host: str  # IP or hostname
    port: int = 80
    mac: str = ""
    led_count: int = 0
    matrix: Optional[Dict[str, int]] = None  # {"w": 16, "h": 16} for 2D devices
    version: str = ""
    room_id: Optional[str] = None
    enabled: bool = True
    rgbw: bool = False
    max_segments: int = 0  # info.leds.maxseg (0 = unknown)
    # Runtime-only fields (not persisted, filled by the hub)
    online: bool = False
    live: bool = False

    RUNTIME_FIELDS = ("online", "live")

    @classmethod
    def from_dict(cls, data: dict) -> "Device":
        return cls(
            id=data["id"],
            name=data.get("name", data["id"]),
            host=data["host"],
            port=int(data.get("port", 80)),
            mac=data.get("mac", ""),
            led_count=int(data.get("led_count", 0)),
            matrix=data.get("matrix"),
            version=data.get("version", ""),
            room_id=data.get("room_id"),
            enabled=bool(data.get("enabled", True)),
            rgbw=bool(data.get("rgbw", False)),
            max_segments=int(data.get("max_segments", 0)),
        )

    def to_dict(self, runtime: bool = False) -> dict:
        data = asdict(self)
        if not runtime:
            for key in self.RUNTIME_FIELDS:
                data.pop(key, None)
        return data


# ---------------------------------------------------------------------- rooms


@dataclass
class Room:
    id: str
    name: str
    icon: str = "sofa"  # icon key used by the frontend
    order: int = 0
    state: LightState = field(default_factory=LightState)

    @classmethod
    def from_dict(cls, data: dict) -> "Room":
        return cls(
            id=data["id"],
            name=data.get("name", data["id"]),
            icon=data.get("icon", "sofa"),
            order=int(data.get("order", 0)),
            state=LightState.from_dict(data.get("state")),
        )


@dataclass
class Group:
    """Rooms linked together. The group's state overrides its rooms' states."""

    id: str
    name: str
    room_ids: List[str] = field(default_factory=list)
    state: LightState = field(default_factory=LightState)

    @classmethod
    def from_dict(cls, data: dict) -> "Group":
        return cls(
            id=data["id"],
            name=data.get("name", data["id"]),
            room_ids=list(data.get("room_ids", [])),
            state=LightState.from_dict(data.get("state")),
        )


# --------------------------------------------------------------------- layout


@dataclass
class Placement:
    """Places a run of LEDs from one device onto the canvas.

    A device can have several placements, e.g. a strip that runs along two
    walls is easiest to describe as two "line" placements.

    shape "line":     LEDs spread evenly along a polyline through `points`.
    shape "matrix":   a w x h panel inside the rectangle (x, y, width, height),
                      with `serpentine` wiring and `origin` corner of LED 0.
    shape "points":   one explicit [x, y] per LED (for 3D-ish or odd layouts).
    """

    id: str
    device_id: str
    name: str = ""  # e.g. "Outer" / "Inner" when one strip is split into parts
    start: int = 0  # first LED index on the device
    count: int = 0  # number of LEDs (0 = rest of the device)
    shape: str = "line"  # "line" | "matrix" | "points"
    points: List[List[float]] = field(default_factory=list)
    # Optional LED index (relative to `start`) that sits on each point, so a
    # corner is pinned to the LED that is physically in that corner. For a
    # closed shape the last anchor is `count` (the loop ends just before the
    # first point). Empty = LEDs spread evenly by length.
    anchors: List[int] = field(default_factory=list)
    # Optional curve per segment (len(points) - 1): bulge = tan(sweep / 4),
    # 0 = straight, 1 = half circle. A circle is two points with [1, 1].
    bulges: List[float] = field(default_factory=list)
    reverse: bool = False
    # matrix only
    x: float = 0.0
    y: float = 0.0
    width: float = 1.0
    height: float = 1.0
    cols: int = 0
    rows: int = 0
    serpentine: bool = True
    origin: str = "top-left"  # top-left | top-right | bottom-left | bottom-right
    vertical: bool = False  # True when the wiring runs in columns
    z: float = 0.0  # optional height (floor) for multi-storey houses
    template: str = ""  # shape template it was made from (rect, u_top, …), for the corner guide

    @classmethod
    def from_dict(cls, data: dict) -> "Placement":
        known = {f for f in cls.__dataclass_fields__}  # type: ignore[attr-defined]
        clean = {k: v for k, v in data.items() if k in known}
        clean.setdefault("id", new_id("pl"))
        return cls(**clean)


@dataclass
class Layout:
    """One grid: an area with its own canvas and coordinates (front of the
    house, the back, the TV wall, a kids' room …). Hub effects span each
    grid on its own."""

    id: str = "main"
    name: str = "Main grid"
    width: float = 20.0  # canvas size in arbitrary units (metres work well)
    height: float = 12.0
    background: Optional[str] = None  # optional floor plan image (data URL)
    placements: List[Placement] = field(default_factory=list)

    @classmethod
    def from_dict(cls, data: Optional[dict]) -> "Layout":
        data = data or {}
        return cls(
            id=str(data.get("id") or "main"),
            name=str(data.get("name") or "Main grid"),
            width=float(data.get("width", 20.0)),
            height=float(data.get("height", 12.0)),
            background=data.get("background"),
            placements=[Placement.from_dict(p) for p in data.get("placements", [])],
        )


@dataclass
class Settings:
    fps: int = 40
    sync_group: int = 1  # WLED UDP sync group bit used for native-effect sync
    realtime_timeout: float = 2.5  # seconds WLED waits before leaving live mode
    discovery: bool = True
    # WLED's own effects: set the device's segments to the mapped LED ranges
    # so unmapped LEDs stay dark there too (devices with a placement only).
    segments_follow_mapping: bool = True

    @classmethod
    def from_dict(cls, data: Optional[dict]) -> "Settings":
        data = data or {}
        return cls(
            fps=max(5, min(60, int(data.get("fps", 40)))),
            sync_group=max(1, min(8, int(data.get("sync_group", 1)))),
            realtime_timeout=float(data.get("realtime_timeout", 2.5)),
            discovery=bool(data.get("discovery", True)),
            segments_follow_mapping=bool(data.get("segments_follow_mapping", True)),
        )


def _layouts_from(data: dict) -> Dict[str, Layout]:
    """Grids from config data; a single old-style "layout" becomes the first grid."""
    raw = data.get("layouts")
    if isinstance(raw, dict) and raw:
        return {str(k): Layout.from_dict({**v, "id": str(k)}) for k, v in raw.items()}
    return {"main": Layout.from_dict({**(data.get("layout") or {}), "id": "main", "name": "Main grid"})}


@dataclass
class HubConfig:
    devices: Dict[str, Device] = field(default_factory=dict)
    rooms: Dict[str, Room] = field(default_factory=dict)
    groups: Dict[str, Group] = field(default_factory=dict)
    layouts: Dict[str, Layout] = field(default_factory=lambda: {"main": Layout()})
    settings: Settings = field(default_factory=Settings)
    # Effect Studio: id -> definition (see studio.py); painted scenes: id -> {name, pixels}
    custom_effects: Dict[str, dict] = field(default_factory=dict)
    scenes: Dict[str, dict] = field(default_factory=dict)

    @classmethod
    def from_dict(cls, data: Optional[dict]) -> "HubConfig":
        data = data or {}
        return cls(
            devices={k: Device.from_dict(v) for k, v in data.get("devices", {}).items()},
            rooms={k: Room.from_dict(v) for k, v in data.get("rooms", {}).items()},
            groups={k: Group.from_dict(v) for k, v in data.get("groups", {}).items()},
            layouts=_layouts_from(data),
            settings=Settings.from_dict(data.get("settings")),
            custom_effects=dict(data.get("custom_effects") or {}),
            scenes=dict(data.get("scenes") or {}),
        )

    def to_dict(self, runtime: bool = False) -> dict:
        return {
            "version": SCHEMA_VERSION,
            "devices": {k: d.to_dict(runtime) for k, d in self.devices.items()},
            "rooms": {k: asdict(r) for k, r in self.rooms.items()},
            "groups": {k: asdict(g) for k, g in self.groups.items()},
            "layouts": {k: asdict(v) for k, v in self.layouts.items()},
            "settings": asdict(self.settings),
            "custom_effects": self.custom_effects,
            "scenes": self.scenes,
        }

    # ------------------------------------------------------------ helpers

    def placements(self) -> List["Placement"]:
        return [p for layout in self.layouts.values() for p in layout.placements]

    def devices_in_room(self, room_id: str) -> List[Device]:
        return [d for d in self.devices.values() if d.room_id == room_id and d.enabled]

    def group_of_room(self, room_id: str) -> Optional[Group]:
        for group in self.groups.values():
            if room_id in group.room_ids:
                return group
        return None

    def effective_state(self, room_id: str) -> LightState:
        """The state a room actually shows: its group's state if grouped."""
        group = self.group_of_room(room_id)
        if group is not None:
            return group.state
        return self.rooms[room_id].state
