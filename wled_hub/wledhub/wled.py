"""Minimal async client for the WLED JSON API (kno.wled.ge/interfaces/json-api).

Only what the hub needs: read info/state/effect lists and push state.
Verified against WLED 0.14 – 16.0 source; see docs/ARCHITECTURE.md.
"""
from __future__ import annotations

import asyncio
import logging
from typing import Any, Dict, List, Optional

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

    async def _request(self, method: str, path: str, payload: Optional[dict] = None) -> Any:
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
        return await self._request("GET", "/json/info")

    async def state(self) -> Dict[str, Any]:
        return await self._request("GET", "/json/state")

    async def effects(self) -> List[str]:
        return await self._request("GET", "/json/effects")

    async def palettes(self) -> List[str]:
        return await self._request("GET", "/json/palettes")

    async def set_state(self, state: Dict[str, Any]) -> Any:
        return await self._request("POST", "/json/state", state)

    async def set_config(self, cfg: Dict[str, Any]) -> Any:
        """Partial config merge. Writes flash on the device: use sparingly."""
        return await self._request("POST", "/json/cfg", cfg)


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
        "live": bool(info.get("live")),
    }


def native_state(state, sync_send: bool, sync_group: int) -> Dict[str, Any]:
    """WLED JSON state for a LightState running a native WLED effect.

    `sync_send` marks the leader of a room/group: it broadcasts UDP sync to
    the group bit, the others only listen to that bit. That keeps effect
    timing aligned across devices without the hub streaming pixels.
    """
    eff = state.effect
    fx = int(eff.id) if eff.source == "wled" else 0
    return {
        "on": state.on,
        "bri": max(1, state.brightness),
        "live": False,  # leave realtime mode if a hub effect ran before
        "udpn": {"send": sync_send, "sgrp": sync_group, "rgrp": sync_group},
        "seg": [
            {
                "col": [list(state.color), list(state.color2), [0, 0, 0]],
                "fx": fx,
                "sx": eff.speed,
                "ix": eff.intensity,
                "pal": eff.palette,
            }
        ],
    }


def realtime_state() -> Dict[str, Any]:
    """Prepare a device for hub (DDP) streaming: on, full brightness, no sync.

    The hub scales pixel values itself, so WLED brightness stays at 255.
    """
    return {"on": True, "bri": 255, "tt": 0, "udpn": {"send": False, "rgrp": 0}}
