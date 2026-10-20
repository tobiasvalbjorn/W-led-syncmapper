"""The hub: owns the config, talks to devices and runs the render loop.

Control model
-------------
A *target* is what the user controls: either a group of rooms, or a room
that is not in a group. Every target runs in one of two modes:

  native  WLED effect running on the devices. The hub sends the same JSON
          state to every device of the target at once and makes the first
          device the UDP-sync leader for a sync-group bit reserved for that
          target, so effect timing stays aligned (WLED notifier, port 21324).

  hub     Hub effect rendered on the shared canvas at `settings.fps` and
          streamed to every device of the target over DDP. Because one clock
          renders every pixel, the devices are frame-synchronous and effects
          flow across devices according to the layout.

Camera mapping temporarily takes devices out of their targets and streams
binary patterns to them (see mapping.py).
"""
from __future__ import annotations

import asyncio
import base64
import colorsys
import logging
import time
from dataclasses import dataclass, field
from typing import Any, Callable, Dict, List, Optional, Tuple

import aiohttp

from . import effects as fx
from .ddp import DDPSender
from .mapping import build_pixel_maps
from .models import Device, Group, HubConfig, LightState, Room, new_id, slugify
from .scanner import ScanSession
from .store import Store
from .wled import WLEDClient, WLEDError, native_state, parse_info, realtime_state

_LOGGER = logging.getLogger(__name__)

POLL_INTERVAL = 15.0
PREVIEW_FPS = 20
# Bit 1 is WLED's default sync group; leave it to devices the hub does not
# manage and give each native-mode target its own bit from 2..128.
SYNC_BITS = [2, 4, 8, 16, 32, 64, 128]


@dataclass
class Target:
    id: str
    kind: str  # "room" | "group"
    name: str
    state: LightState
    devices: List[Device]


@dataclass
class _Running:
    effect: fx.Effect
    key: str
    devices: Tuple[str, ...] = field(default_factory=tuple)


class Hub:
    def __init__(self, store: Store, hub_id: str, version: str) -> None:
        self.store = store
        self.config: HubConfig = store.config
        self.hub_id = hub_id
        self.version = version
        self.session: Optional[aiohttp.ClientSession] = None
        self.ddp = DDPSender()
        self.listeners: List[Callable[[dict], None]] = []
        self.discovered: Dict[str, Dict[str, str]] = {}
        self.scan: Optional[ScanSession] = None
        self.wled_effects: List[str] = []
        self.wled_palettes: List[str] = []

        self._pixel_maps: Dict[str, list] = {}
        self._running: Dict[str, _Running] = {}  # target id -> hub effect
        self._sync_bits: Dict[str, int] = {}
        self._last_frames: Dict[str, List[Tuple[int, int, int]]] = {}
        self._tasks: List[asyncio.Task] = []
        self._apply_lock = asyncio.Lock()
        # device id -> {"index", "start", "count", "marks", "until"} (mapping cursor)
        self.highlights: Dict[str, dict] = {}

    # ------------------------------------------------------------ lifecycle

    async def start(self) -> None:
        self.session = aiohttp.ClientSession()
        await self.ddp.start()
        self.rebuild_maps()
        self._tasks = [
            asyncio.ensure_future(self._render_loop()),
            asyncio.ensure_future(self._poll_loop()),
        ]
        await self.refresh_all()
        for target in self.targets():
            await self._apply(target)

    async def stop(self) -> None:
        for task in self._tasks:
            task.cancel()
        await asyncio.gather(*self._tasks, return_exceptions=True)
        self.ddp.close()
        if self.session is not None:
            await self.session.close()
        self.store.save_now()

    def client(self, device: Device) -> WLEDClient:
        assert self.session is not None
        return WLEDClient(self.session, device.host, device.port)

    # --------------------------------------------------------------- events

    def snapshot(self) -> dict:
        data = self.config.to_dict(runtime=True)
        data["targets"] = [
            {"id": t.id, "kind": t.kind, "name": t.name, "device_ids": [d.id for d in t.devices]}
            for t in self.targets()
        ]
        data["discovered"] = [
            d for d in self.discovered.values() if not self._known_device(d["host"], d.get("mac", ""))
        ]
        data["hub"] = {"id": self.hub_id, "version": self.version}
        data["scan"] = self.scan.describe() if self.scan else None
        return data

    def changed(self, save: bool = True) -> None:
        if save:
            self.store.schedule_save()
        message = {"type": "config", "data": self.snapshot()}
        for listener in list(self.listeners):
            listener(message)

    # -------------------------------------------------------------- targets

    def targets(self) -> List[Target]:
        cfg = self.config
        result: List[Target] = []
        grouped = set()
        for group in cfg.groups.values():
            rooms = [r for r in group.room_ids if r in cfg.rooms]
            grouped.update(rooms)
            devices = [d for r in rooms for d in cfg.devices_in_room(r)]
            result.append(Target(group.id, "group", group.name, group.state, devices))
        for room in sorted(cfg.rooms.values(), key=lambda r: r.order):
            if room.id not in grouped:
                result.append(Target(room.id, "room", room.name, room.state, cfg.devices_in_room(room.id)))
        return result

    def target(self, target_id: str) -> Optional[Target]:
        return next((t for t in self.targets() if t.id == target_id), None)

    async def set_state(self, target_id: str, changes: Dict[str, Any]) -> LightState:
        target = self.target(target_id)
        if target is None:
            raise KeyError(target_id)
        state = target.state
        if "on" in changes:
            state.on = bool(changes["on"])
        if "brightness" in changes:
            state.brightness = max(0, min(255, int(changes["brightness"])))
            if state.brightness == 0:
                state.on = False
        for key in ("color", "color2"):
            if key in changes:
                setattr(state, key, [max(0, min(255, int(c))) for c in changes[key]][:3])
        if "effect" in changes:
            eff = changes["effect"] or {}
            for key in ("source", "id", "speed", "intensity", "palette"):
                if key in eff:
                    setattr(state.effect, key, eff[key])
            if "params" in eff:
                state.effect.params.update(eff["params"])
            if state.effect.source == "hub" and state.effect.id not in fx.REGISTRY:
                raise ValueError(f"Unknown hub effect {state.effect.id}")
        state.updated = time.time()
        await self._apply(target)
        self.changed()
        return state

    async def _apply(self, target: Target) -> None:
        """Push a target's state to its devices (native) or the engine (hub)."""
        async with self._apply_lock:
            devices = [d for d in target.devices if not self._overridden(d.id)]
            state = target.state
            running = self._running.get(target.id)

            if state.on and state.effect.source == "hub":
                key = str(state.effect.id)
                device_ids = tuple(d.id for d in devices)
                fresh = running is None or running.key != key
                if fresh:
                    self._running[target.id] = _Running(fx.create(key), key, device_ids)
                if fresh or running.devices != device_ids:  # type: ignore[union-attr]
                    self._running[target.id].devices = device_ids
                    await self._send_all(devices, realtime_state())
                return

            self._running.pop(target.id, None)
            if not state.on:
                await self._send_all(devices, {"on": False, "live": False})
                return

            bit = self._sync_bit(target.id)
            await asyncio.gather(
                *(
                    self._send(d, native_state(state, sync_send=(i == 0), sync_group=bit))
                    for i, d in enumerate(devices)
                )
            )

    def _sync_bit(self, target_id: str) -> int:
        if target_id not in self._sync_bits:
            used = set(self._sync_bits.values())
            free = [b for b in SYNC_BITS if b not in used]
            if not free:
                _LOGGER.warning("More than %d synced targets; sync groups are shared", len(SYNC_BITS))
                free = SYNC_BITS
            self._sync_bits[target_id] = free[0]
        return self._sync_bits[target_id]

    async def _send(self, device: Device, state: dict) -> None:
        try:
            await self.client(device).set_state(state)
        except WLEDError as err:
            _LOGGER.warning("Could not update %s: %s", device.name, err)
            device.online = False

    async def _send_all(self, devices: List[Device], state: dict) -> None:
        await asyncio.gather(*(self._send(d, state) for d in devices))

    async def reapply_all(self) -> None:
        live = {t.id for t in self.targets()}
        for stale in set(self._running) - live:
            self._running.pop(stale, None)
        for stale in set(self._sync_bits) - live:
            self._sync_bits.pop(stale, None)
        for target in self.targets():
            await self._apply(target)

    # ---------------------------------------------------------- render loop

    def rebuild_maps(self) -> None:
        devices = sorted(self.config.devices.values(), key=lambda d: d.name)
        self._pixel_maps = build_pixel_maps(devices, self.config.layout)

    async def _render_loop(self) -> None:
        next_preview = 0.0
        start = time.monotonic()
        while True:
            fps = self.config.settings.fps
            frame_start = time.monotonic()
            try:
                self._render_frame(frame_start - start)
                if self.listeners and frame_start >= next_preview:
                    next_preview = frame_start + 1.0 / PREVIEW_FPS
                    self._broadcast_preview()
            except Exception:  # noqa: BLE001 - one bad effect must not kill the loop
                _LOGGER.exception("Render frame failed")
            await asyncio.sleep(max(0.0, 1.0 / fps - (time.monotonic() - frame_start)))

    def _render_frame(self, t: float) -> None:
        frames: Dict[str, List[Tuple[int, int, int]]] = {}
        for target_id, running in self._running.items():
            target = self.target(target_id)
            if target is None or not target.state.on:
                continue
            devices = [d for d in target.devices if d.id in running.devices and not self._overridden(d.id)]
            # Only LEDs that are drawn on the grid are rendered; the rest stay off.
            coords: list = []
            spans = []
            for d in devices:
                pmap = self._pixel_maps.get(d.id, [])
                lit = [i for i, c in enumerate(pmap) if c is not None]
                spans.append((d, len(coords), lit, len(pmap)))
                coords.extend(pmap[i] for i in lit)
            if not coords:
                for d, _offset, _lit, n in spans:
                    frames[d.id] = [(0, 0, 0)] * n
                continue
            state = target.state
            opts = {
                "speed": state.effect.speed,
                "intensity": state.effect.intensity,
                "color": state.color,
                "color2": state.color2,
                "params": state.effect.params,
            }
            pixels = running.effect.render(coords, t, opts)
            k = state.brightness / 255.0
            if k < 1.0:
                pixels = [(int(r * k), int(g * k), int(b * k)) for r, g, b in pixels]
            for d, offset, lit, n in spans:
                frame = [(0, 0, 0)] * n
                for k, i in enumerate(lit):
                    frame[i] = pixels[offset + k]
                frames[d.id] = frame

        if self.highlights:
            frames.update(self._highlight_frames())
        if self.scan is not None:
            frames.update(self.scan.frames(self.config.devices))

        for device_id, pixels in frames.items():
            device = self.config.devices.get(device_id)
            if device is not None and device.enabled:
                self.ddp.send(device.host, pixels, rgbw=device.rgbw)
        self._last_frames = frames

    def _broadcast_preview(self) -> None:
        """Approximate live colours for the grid view (10 fps, base64 RGB)."""
        preview = {}
        for target in self.targets():
            for d in target.devices:
                frame = self._last_frames.get(d.id)
                if frame is None:
                    s = target.state
                    k = s.brightness / 255.0 if s.on else 0.0
                    frame = [tuple(int(c * k) for c in s.color)] * d.led_count  # type: ignore[misc]
                preview[d.id] = base64.b64encode(bytes(v for px in frame for v in px)).decode()
        for d in self.config.devices.values():
            if d.id not in preview and d.id in self._last_frames:
                frame = self._last_frames[d.id]
                preview[d.id] = base64.b64encode(bytes(v for px in frame for v in px)).decode()
        message = {"type": "preview", "data": preview}
        for listener in list(self.listeners):
            listener(message)

    # -------------------------------------------------------------- devices

    def _known_device(self, host: str, mac: str) -> Optional[Device]:
        for d in self.config.devices.values():
            if d.host == host or (mac and d.mac == mac):
                return d
        return None

    async def add_device(self, host: str, port: int = 80, room_id: Optional[str] = None) -> Device:
        assert self.session is not None
        info = parse_info(await WLEDClient(self.session, host, port).info())
        existing = self._known_device(host, info["mac"])
        if existing is not None:
            existing.host = host
            return existing
        device_id = f"wled_{info['mac'][-6:]}" if info["mac"] else new_id("wled")
        device = Device(id=device_id, host=host, port=port, room_id=room_id, online=True, **{
            k: info[k] for k in ("name", "mac", "led_count", "matrix", "version", "rgbw")
        })
        self.config.devices[device.id] = device
        self.rebuild_maps()
        await self.reapply_all()
        self.changed()
        if not self.wled_effects:
            await self._load_wled_lists(device)
        return device

    async def update_device(self, device_id: str, changes: Dict[str, Any]) -> Device:
        device = self.config.devices[device_id]
        for key in ("name", "host", "room_id", "enabled"):
            if key in changes:
                setattr(device, key, changes[key])
        if "port" in changes:
            device.port = int(changes["port"])
        if device.room_id and device.room_id not in self.config.rooms:
            device.room_id = None
        self.rebuild_maps()
        await self.reapply_all()
        self.changed()
        return device

    async def remove_device(self, device_id: str) -> None:
        self.config.devices.pop(device_id, None)
        self.config.layout.placements = [
            p for p in self.config.layout.placements if p.device_id != device_id
        ]
        self.rebuild_maps()
        await self.reapply_all()
        self.changed()

    async def device_outputs(self, device_id: str) -> List[dict]:
        """Per-output LED ranges from /json/cfg (hw.led.ins), e.g. several strings on one ESP32."""
        device = self.config.devices[device_id]
        assert self.session is not None
        cfg = await self.client(device).request("GET", "/json/cfg")
        outputs = []
        for i, out in enumerate(cfg.get("hw", {}).get("led", {}).get("ins", [])):
            pins = out.get("pin", [])
            outputs.append({
                "index": i,
                "start": int(out.get("start", 0)),
                "count": int(out.get("len", 0)),
                "pin": pins[0] if pins else None,
                "reversed": bool(out.get("rev", False)),
            })
        return outputs

    async def identify(self, device_id: str) -> None:
        """Blink a device so the user can see which one it is."""
        device = self.config.devices[device_id]
        await self._send(device, {"on": True, "bri": 255, "live": False, "seg": [{"fx": 1, "sx": 220, "col": [[255, 255, 255]]}]})
        await asyncio.sleep(3)
        for target in self.targets():
            if any(d.id == device_id for d in target.devices):
                await self._apply(target)

    async def refresh_device(self, device: Device) -> None:
        try:
            info = parse_info(await self.client(device).info())
        except WLEDError:
            if device.online:
                _LOGGER.info("%s went offline", device.name)
            device.online = False
            return
        was_offline = not device.online
        device.online = True
        device.live = info["live"]
        device.version = info["version"]
        device.rgbw = info["rgbw"]
        if info["led_count"] != device.led_count or info["matrix"] != device.matrix:
            device.led_count = info["led_count"]
            device.matrix = info["matrix"]
            self.rebuild_maps()
        if was_offline:
            # A rebooted device has forgotten runtime sync settings: re-apply.
            for target in self.targets():
                if any(d.id == device.id for d in target.devices):
                    await self._apply(target)

    async def refresh_all(self) -> None:
        devices = list(self.config.devices.values())
        await asyncio.gather(*(self.refresh_device(d) for d in devices))
        if not self.wled_effects:
            online = next((d for d in devices if d.online), None)
            if online is not None:
                await self._load_wled_lists(online)

    async def _load_wled_lists(self, device: Device) -> None:
        try:
            client = self.client(device)
            self.wled_effects = await client.effects()
            self.wled_palettes = await client.palettes()
        except WLEDError as err:
            _LOGGER.debug("Could not load effect list: %s", err)

    async def _poll_loop(self) -> None:
        while True:
            await asyncio.sleep(POLL_INTERVAL)
            before = [(d.id, d.online, d.live, d.led_count) for d in self.config.devices.values()]
            await self.refresh_all()
            after = [(d.id, d.online, d.live, d.led_count) for d in self.config.devices.values()]
            if before != after:
                self.changed(save=False)

    def on_discovered(self, entry: Dict[str, str]) -> None:
        self.discovered[entry.get("mac") or entry["host"]] = entry
        self.changed(save=False)

    # ---------------------------------------------------------- rooms/groups

    async def add_room(self, name: str, icon: str = "sofa") -> Room:
        base = f"room_{slugify(name)}"
        room_id, n = base, 2
        while room_id in self.config.rooms:
            room_id, n = f"{base}_{n}", n + 1
        room = Room(id=room_id, name=name, icon=icon, order=len(self.config.rooms))
        self.config.rooms[room.id] = room
        self.changed()
        return room

    async def update_room(self, room_id: str, changes: Dict[str, Any]) -> Room:
        room = self.config.rooms[room_id]
        for key in ("name", "icon"):
            if key in changes:
                setattr(room, key, changes[key])
        if "order" in changes:
            room.order = int(changes["order"])
        self.changed()
        return room

    async def remove_room(self, room_id: str) -> None:
        self.config.rooms.pop(room_id, None)
        for d in self.config.devices.values():
            if d.room_id == room_id:
                d.room_id = None
        for g in list(self.config.groups.values()):
            if room_id in g.room_ids:
                g.room_ids.remove(room_id)
            if len(g.room_ids) < 2:
                self.config.groups.pop(g.id)
        await self.reapply_all()
        self.changed()

    async def set_group(self, room_ids: List[str], name: Optional[str] = None,
                        group_id: Optional[str] = None) -> Optional[Group]:
        """Sonos-style grouping: put these rooms (and only these) in one group.

        The new group starts with the state of its first room, like joining a
        room to the one that is "playing". Rooms leave any group they were in.
        """
        cfg = self.config
        room_ids = [r for r in room_ids if r in cfg.rooms]
        for g in list(cfg.groups.values()):
            if g.id == group_id:
                continue
            g.room_ids = [r for r in g.room_ids if r not in room_ids]
            if len(g.room_ids) < 2:
                cfg.groups.pop(g.id)
        if group_id and group_id in cfg.groups and len(room_ids) >= 2:
            group = cfg.groups[group_id]
            group.room_ids = room_ids
            if name:
                group.name = name
        elif len(room_ids) >= 2:
            leader = cfg.rooms[room_ids[0]]
            group = Group(
                id=group_id or new_id("group"),
                name=name or " + ".join(cfg.rooms[r].name for r in room_ids),
                room_ids=room_ids,
                state=LightState.from_dict(_state_dict(leader.state)),
            )
            cfg.groups[group.id] = group
        else:
            if group_id:
                cfg.groups.pop(group_id, None)
            group = None
        await self.reapply_all()
        self.changed()
        return group

    async def ungroup(self, group_id: str) -> None:
        group = self.config.groups.pop(group_id, None)
        if group is not None:
            # Rooms keep showing what the group showed, like Sonos does.
            for room_id in group.room_ids:
                if room_id in self.config.rooms:
                    self.config.rooms[room_id].state = LightState.from_dict(_state_dict(group.state))
        await self.reapply_all()
        self.changed()

    # --------------------------------------------------------------- layout

    async def set_layout(self, data: dict) -> None:
        from .models import Layout

        self.config.layout = Layout.from_dict(data)
        self.rebuild_maps()
        self.changed()

    # -------------------------------------------------------------- scanner

    def _in_scan(self, device_id: str) -> bool:
        return self.scan is not None and device_id in self.scan.device_ids

    def _overridden(self, device_id: str) -> bool:
        """Device is temporarily taken over by camera scan or mapping cursor."""
        return self._in_scan(device_id) or device_id in self.highlights

    # ------------------------------------------------------------ highlight

    HIGHLIGHT_IDLE = 90.0  # seconds without updates before the cursor goes away

    async def highlight(self, device_id: str, index: int = -1, start: int = 0, count: int = 0,
                        marks: Optional[List[int]] = None,
                        ranges: Optional[List[list]] = None, effect: str = "solid") -> None:
        """Show the grid editor's selection or a test pattern on the real strip.

        ranges: [[start, count, [r, g, b]?], ...] – LED ranges to light, each
        in its own colour (default white). Used for "the part under the
        mouse", for one colour per part/corner stretch, and for test effects.
        effect: "solid" | "chase" (a running dot that shows the direction) |
        "rainbow" (hue along each range).
        Cursor mode (index >= 0) draws on top: the LED under the cursor white,
        the first LED green, corners already set amber. Without ranges the
        placement range is shown dim blue.
        """
        if effect not in ("solid", "chase", "rainbow"):
            raise ValueError(f"Unknown test effect {effect}")
        device = self.config.devices[device_id]
        fresh = device_id not in self.highlights
        parsed = []
        for r in ranges or []:
            color = tuple(max(0, min(255, int(c))) for c in r[2])[:3] if len(r) > 2 and r[2] else (200, 200, 200)
            parsed.append((int(r[0]), int(r[1]), color))
        self.highlights[device_id] = {
            "index": int(index), "start": int(start), "count": int(count) or device.led_count - int(start),
            "marks": [int(m) for m in (marks or [])],
            "ranges": parsed, "effect": effect, "since": time.monotonic(),
            "until": time.monotonic() + self.HIGHLIGHT_IDLE,
        }
        if fresh:
            await self._send(device, realtime_state())

    async def clear_highlight(self, device_id: Optional[str] = None) -> None:
        ids = [device_id] if device_id else list(self.highlights)
        for d in ids:
            self.highlights.pop(d, None)
        await self.reapply_all()

    def _highlight_frames(self) -> Dict[str, List[Tuple[int, int, int]]]:
        frames = {}
        now = time.monotonic()
        for device_id, hl in list(self.highlights.items()):
            device = self.config.devices.get(device_id)
            if device is None or now > hl["until"]:
                self.highlights.pop(device_id, None)
                asyncio.ensure_future(self.reapply_all())
                continue
            frame = [(0, 0, 0)] * device.led_count
            t = now - hl.get("since", now)
            for start, count, color in hl.get("ranges", []):
                _paint_range(frame, start, count, color, hl.get("effect", "solid"), t)
            if hl["index"] < 0:
                frames[device_id] = frame
                continue
            if not hl.get("ranges"):
                for i in range(hl["start"], min(device.led_count, hl["start"] + hl["count"])):
                    frame[i] = (0, 0, 24)  # the placement's range, dim blue
            if 0 <= hl["start"] < device.led_count:
                frame[hl["start"]] = (0, 70, 0)  # first LED of the range, green
            for m in hl["marks"]:
                if 0 <= m < device.led_count:
                    frame[m] = (120, 50, 0)  # corners already set, amber
            if 0 <= hl["index"] < device.led_count:
                frame[hl["index"]] = (255, 255, 255)  # the cursor
            frames[device_id] = frame
        return frames

    async def scan_start(self, device_ids: List[str], level: int = 160) -> ScanSession:
        devices = [self.config.devices[d] for d in device_ids if d in self.config.devices]
        if not devices:
            raise ValueError("No devices selected")
        self.scan = ScanSession(devices, level=level)
        await self._send_all(devices, realtime_state())
        self.changed(save=False)
        return self.scan

    async def scan_stop(self) -> None:
        self.scan = None
        await self.reapply_all()
        self.changed(save=False)


def _paint_range(frame: list, start: int, count: int, color: Tuple[int, int, int],
                 effect: str, t: float) -> None:
    """Fill frame[start:start+count] with a test pattern."""
    n = len(frame)
    if count <= 0:
        return
    if effect == "chase":
        # a head running from the first to the last LED with a fading tail,
        # over a faint background, so the wiring direction is obvious
        head = (t * 25.0) % count
        tail = max(3, count // 8)
        faint = tuple(c // 12 for c in color)
        for k in range(count):
            i = start + k
            if not 0 <= i < n:
                continue
            behind = head - k
            if 0 <= behind < tail:
                f = 1.0 - behind / tail
                frame[i] = tuple(int(c * f + fc * (1 - f)) for c, fc in zip(color, faint))
            else:
                frame[i] = faint
    elif effect == "rainbow":
        for k in range(count):
            i = start + k
            if 0 <= i < n:
                r, g, b = colorsys.hsv_to_rgb((k / count + t * 0.2) % 1.0, 1.0, 0.8)
                frame[i] = (int(r * 255), int(g * 255), int(b * 255))
    else:
        for i in range(max(0, start), min(n, start + count)):
            frame[i] = color


def _state_dict(state: LightState) -> dict:
    from dataclasses import asdict

    return asdict(state)
