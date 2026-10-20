"""Small async client for the WLED Hub REST + WebSocket API."""
from __future__ import annotations

import asyncio
import json
import logging
from collections.abc import Callable
from typing import Any

import aiohttp

_LOGGER = logging.getLogger(__name__)


class HubError(Exception):
    """Hub unreachable or returned an error."""


class HubAuthError(HubError):
    """Wrong or missing API token."""


class HubClient:
    def __init__(self, session: aiohttp.ClientSession, host: str, port: int, token: str | None = None) -> None:
        self.session = session
        self.host = host
        self.port = port
        self.token = token or None
        self.base = f"http://{host}:{port}/api/"

    @property
    def _headers(self) -> dict[str, str]:
        return {"Authorization": f"Bearer {self.token}"} if self.token else {}

    async def request(self, method: str, path: str, payload: dict | None = None) -> Any:
        try:
            async with self.session.request(
                method, self.base + path, json=payload, headers=self._headers,
                timeout=aiohttp.ClientTimeout(total=10),
            ) as resp:
                if resp.status == 401:
                    raise HubAuthError("Invalid API token")
                data = await resp.json(content_type=None)
                if resp.status >= 400:
                    raise HubError(data.get("error") if isinstance(data, dict) else resp.reason)
                return data
        except (aiohttp.ClientError, asyncio.TimeoutError) as err:
            raise HubError(str(err) or err.__class__.__name__) from err

    async def health(self) -> dict:
        return await self.request("GET", "health")

    async def config(self) -> dict:
        return await self.request("GET", "config")

    async def effects(self) -> dict:
        return await self.request("GET", "effects")

    async def set_state(self, target_id: str, changes: dict) -> dict:
        return await self.request("PUT", f"targets/{target_id}/state", changes)

    async def listen(self, on_config: Callable[[dict], None], on_disconnect: Callable[[Exception], None],
                     stop: asyncio.Event) -> None:
        """Keep a WebSocket open and call on_config for every pushed config."""
        url = f"ws://{self.host}:{self.port}/api/ws"
        params = {"token": self.token} if self.token else None
        delay = 1
        while not stop.is_set():
            try:
                async with self.session.ws_connect(url, params=params, heartbeat=30) as ws:
                    delay = 1
                    async for msg in ws:
                        if msg.type == aiohttp.WSMsgType.TEXT:
                            data = json.loads(msg.data)
                            if data.get("type") == "config":
                                on_config(data["data"])
                        elif msg.type in (aiohttp.WSMsgType.CLOSED, aiohttp.WSMsgType.ERROR):
                            break
                raise HubError("WebSocket closed")
            except (aiohttp.ClientError, asyncio.TimeoutError, HubError) as err:
                if stop.is_set():
                    return
                on_disconnect(err)
                _LOGGER.debug("Hub WebSocket lost (%s); retrying in %ss", err, delay)
                try:
                    await asyncio.wait_for(stop.wait(), timeout=delay)
                except asyncio.TimeoutError:
                    pass
                delay = min(delay * 2, 60)

