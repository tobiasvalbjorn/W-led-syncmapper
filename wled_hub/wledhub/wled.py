"""Minimal async client for the WLED JSON API (kno.wled.ge/interfaces/json-api).

Only what the hub needs: read info/state/effect lists and push state.
Verified against WLED 0.14 – 16.0 source; see docs/ARCHITECTURE.md.
"""
from __future__ import annotations

import asyncio
import logging
from typing import Any, Dict, List, Optional, Tuple

import aiohttp

_LOGGER = logging.getLogger(__name__)
TIMEOUT = aiohttp.ClientTimeout(total=4)


class WLEDError(Exception):
    pass


class WLEDClient:
    def __init__(self, session: aiohttp.ClientSession, host: str, port: int = 80) -> None:
        self.session = session
        self.host = host
        self.port = port
        self.base = f"http://{host}:{port}" if port != 80 else f"http://{host}"

    async def request(self, method: str, path: str, payload: Optional[dict] = None) -> Any:
        try:
            async with self.session.request(method, self.base + path, json=payload, timeout=TIMEOUT) as resp:
                if resp.status == 401:
                    raise WLEDError(f"{self.host}: settings are PIN-locked")
                if resp.status >= 400:
                    raise WLEDError(f"{self.host}: HTTP {resp.status} on {path}")
                return await resp.json(content_type=None)
        except (aiohttp.ClientError, asyncio.TimeoutError) as err:
            raise WLEDError(f"{self.host}: {err.__class__.__name__} {err}") from err

    async def info(self) -> Dict[str, Any]:
        return await self.request("GET", "/json/info")

    async def state(self) -> Dict[str, Any]:
        return await self.request("GET", "/json/state")

    async def effects(self) -> List[str]:
        return await self.request("GET", "/json/effects")

    async def palettes(self) -> List[str]:
        return await self.request("GET", "/json/palettes")

    async def set_state(self, state: Dict[str, Any]) -> Any:
        return await self.request("POST", "/json/state", state)

    async def set_config(self, cfg: Dict[str, Any]) -> Any:
        """Partial config merge. Writes flash on the device: use sparingly."""
        return await self.request("POST", "/json/cfg", cfg)


def parse_info(info: Dict[str, Any]) -> Dict[str, Any]:
    """Extract the fields the hub stores about a device from /json/info."""
    leds = info.get("leds", {})
    matrix = leds.get("matrix")
    return {
        "name": info.get("name") or "WLED",
        "mac": (info.get("mac") or "").lower(),
        "led_count": int(leds.get("count", 0)),
        "matrix": {"w": int(matrix["w"]), "h": int(matrix["h"])} if matrix else None,
        "version": str(info.get("ver", "")),
        # leds.rgbw is deprecated but still sent; lc bit 1 (0x02) = has white channel
        "rgbw": bool(leds.get("rgbw")) or bool(int(leds.get("lc", 0)) & 0x02),
        "max_segments": int(leds.get("maxseg", 0) or 0),
        "live": bool(info.get("live")),
    }


def native_state(state, sync_send: bool, sync_group: int,
                 segments: Optional[List[Tuple[int, int, bool]]] = None,
                 max_segments: int = 16, geometry: bool = True) -> Dict[str, Any]:
    """WLED JSON state for a LightState running a native WLED effect.

    `sync_send` marks the leader of a room/group: it broadcasts UDP sync to
    the group bit, the others only listen to that bit. That keeps effect
    timing aligned across devices without the hub streaming pixels.

    `segments` [(start, stop, lit)] replaces the device's segments: lit ones
    run the effect, the others are switched off (so they are dark for sure),
    and any further segment ids up to `max_segments` are deleted ("stop": 0
    deletes a segment; ids that do not exist are ignored by WLED).
    With geometry=False the segments are assumed to be in place already and
    only the lit ones get the new look (much smaller, for slider updates).
    """
    eff = state.effect
    fx = int(eff.id) if eff.source == "wled" else 0
    look = {
        "col": [list(state.color), list(state.color2), [0, 0, 0]],
        "fx": fx,
        "sx": eff.speed,
        "ix": eff.intensity,
        "pal": eff.palette,
    }
    if segments and not geometry:
        seg = [{"id": i, **look} for i, (_s, _e, lit) in enumerate(segments) if lit]
    elif segments:
        seg: List[Dict[str, Any]] = []
        for i, (start, stop, lit) in enumerate(segments):
            seg.append({"id": i, "start": start, "stop": stop, "on": lit, "bri": 255, **(look if lit else {})})
        seg += [{"id": i, "stop": 0} for i in range(len(segments), max(max_segments, len(segments)))]
    else:
        seg = [look]
    return {
        "on": state.on,
        "bri": max(1, state.brightness),
        "live": False,  # leave realtime mode if a hub effect ran before
        "udpn": {"send": sync_send, "sgrp": sync_group, "rgrp": sync_group},
        "seg": seg,
    }


def segment_plan(mapped: List[Tuple[int, int]], led_count: int, max_segments: int) -> Optional[List[Tuple[int, int, bool]]]:
    """Cover the whole strip: mapped ranges lit, the gaps between them off.

    Returns None when it would need more segments than the device allows.
    """
    plan: List[Tuple[int, int, bool]] = []
    pos = 0
    for start, stop in mapped:
        if start > pos:
            plan.append((pos, start, False))
        plan.append((start, stop, True))
        pos = stop
    if pos < led_count:
        plan.append((pos, led_count, False))
    if max_segments and len(plan) > max_segments:
        return None
    return plan


def realtime_state() -> Dict[str, Any]:
    """Prepare a device for hub (DDP) streaming: on, full brightness, no sync.

    The hub scales pixel values itself, so WLED brightness stays at 255.
    """
    return {"on": True, "bri": 255, "tt": 0, "udpn": {"send": False, "rgrp": 0}}
