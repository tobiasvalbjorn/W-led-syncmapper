"""mDNS: find WLED devices (_wled._tcp) and advertise the hub (_wledhub._tcp).

The Home Assistant integration listens for _wledhub._tcp via zeroconf, so a
hub on the LAN shows up in HA as "discovered" without typing an IP.
"""
from __future__ import annotations

import asyncio
import logging
import socket
from typing import Callable, Dict, Optional

from zeroconf import IPVersion, ServiceStateChange
from zeroconf.asyncio import AsyncServiceBrowser, AsyncServiceInfo, AsyncZeroconf

_LOGGER = logging.getLogger(__name__)

WLED_SERVICE = "_wled._tcp.local."
HUB_SERVICE = "_wledhub._tcp.local."

FoundCallback = Callable[[Dict[str, str]], None]


def _local_ip() -> str:
    """Best-effort LAN IP (no packets are actually sent)."""
    sock = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
    try:
        sock.connect(("10.255.255.255", 1))
        return sock.getsockname()[0]
    except OSError:
        return "127.0.0.1"
    finally:
        sock.close()


class Discovery:
    def __init__(self, on_found: FoundCallback) -> None:
        self.on_found = on_found
        self.found: Dict[str, Dict[str, str]] = {}  # mac/host -> {host, port, name, mac}
        self._zc: Optional[AsyncZeroconf] = None
        self._browser: Optional[AsyncServiceBrowser] = None
        self._hub_info: Optional[AsyncServiceInfo] = None
        self._tasks: set = set()

    async def start(self) -> None:
        self._zc = AsyncZeroconf(ip_version=IPVersion.V4Only)
        self._browser = AsyncServiceBrowser(
            self._zc.zeroconf, [WLED_SERVICE], handlers=[self._on_change]
        )

    async def advertise(self, port: int, hub_id: str, version: str) -> None:
        if self._zc is None:
            return
        ip = _local_ip()
        self._hub_info = AsyncServiceInfo(
            HUB_SERVICE,
            f"WLED Hub {hub_id[-4:]}.{HUB_SERVICE}",
            addresses=[socket.inet_aton(ip)],
            port=port,
            properties={"id": hub_id, "version": version, "path": "/"},
            server=f"wledhub-{hub_id[-6:]}.local.",
        )
        try:
            await self._zc.async_register_service(self._hub_info)
            _LOGGER.info("Advertising hub on %s:%s via mDNS", ip, port)
        except Exception as err:  # noqa: BLE001 - mDNS errors must never stop the hub
            _LOGGER.warning("mDNS advertising failed: %s", err)

    async def stop(self) -> None:
        if self._zc is None:
            return
        if self._hub_info is not None:
            await self._zc.async_unregister_service(self._hub_info)
        if self._browser is not None:
            await self._browser.async_cancel()
        await self._zc.async_close()
        self._zc = None

    def _on_change(self, zeroconf, service_type, name, state_change) -> None:
        if state_change is not ServiceStateChange.Added:
            return
        task = asyncio.ensure_future(self._resolve(service_type, name))
        self._tasks.add(task)
        task.add_done_callback(self._tasks.discard)

    async def _resolve(self, service_type: str, name: str) -> None:
        assert self._zc is not None
        info = AsyncServiceInfo(service_type, name)
        if not await info.async_request(self._zc.zeroconf, 3000):
            return
        addresses = info.parsed_addresses(IPVersion.V4Only)
        if not addresses:
            return
        props = {k.decode(): (v or b"").decode() for k, v in info.properties.items()}
        entry = {
            "host": addresses[0],
            "port": str(info.port or 80),
            "name": name.replace("." + service_type, ""),
            "mac": props.get("mac", "").lower(),
        }
        self.found[entry["mac"] or entry["host"]] = entry
        _LOGGER.debug("Found WLED device %s", entry)
        self.on_found(entry)
