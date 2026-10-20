"""Entry point: python -m wledhub [--data DIR] [--port 8787]

Inside the Home Assistant add-on, options come from /data/options.json and
the hub additionally listens on the ingress port and announces itself to
Home Assistant through Supervisor discovery.
"""
from __future__ import annotations

import argparse
import asyncio
import json
import logging
import os
import signal
import ssl
import uuid
from pathlib import Path
from typing import Optional

import aiohttp
from aiohttp import web

from . import __version__
from .api import create_app
from .discovery import Discovery, _local_ip
from .hub import Hub
from .store import Store

_LOGGER = logging.getLogger("wledhub")
DOMAIN = "wled_hub"  # Home Assistant integration domain


def load_options(data_dir: Path) -> dict:
    path = data_dir / "options.json"
    if path.exists():
        try:
            return json.loads(path.read_text("utf-8"))
        except ValueError:
            _LOGGER.error("Ignoring unreadable %s", path)
    return {}


def hub_id(data_dir: Path) -> str:
    path = data_dir / "hub_id"
    if not path.exists():
        data_dir.mkdir(parents=True, exist_ok=True)
        path.write_text(uuid.uuid4().hex)
    return path.read_text().strip()


async def supervisor_discovery(port: int, hid: str) -> None:
    """Tell Home Assistant about the hub (shows up under Settings > Devices)."""
    token = os.environ.get("SUPERVISOR_TOKEN")
    if not token:
        return
    # The add-on runs with host_network, so Home Assistant reaches it on the
    # host's own LAN IP (the same address phones on the LAN use).
    payload = {"service": DOMAIN, "config": {"host": _local_ip(), "port": port, "id": hid}}
    try:
        async with aiohttp.ClientSession() as session:
            async with session.post("http://supervisor/discovery", json=payload,
                                    headers={"Authorization": f"Bearer {token}"}) as resp:
                _LOGGER.info("Supervisor discovery: HTTP %s", resp.status)
    except aiohttp.ClientError as err:
        _LOGGER.warning("Supervisor discovery failed: %s", err)


def ssl_context(certfile: str, keyfile: str) -> Optional[ssl.SSLContext]:
    if not certfile:
        return None
    # Add-on options name files inside Home Assistant's /ssl share.
    certfile = certfile if os.path.isabs(certfile) else f"/ssl/{certfile}"
    keyfile = keyfile if os.path.isabs(keyfile) else f"/ssl/{keyfile}"
    if not (Path(certfile).exists() and Path(keyfile).exists()):
        _LOGGER.error("SSL enabled but %s / %s not found; serving plain HTTP", certfile, keyfile)
        return None
    ctx = ssl.create_default_context(ssl.Purpose.CLIENT_AUTH)
    ctx.load_cert_chain(certfile, keyfile)
    return ctx


async def main() -> None:
    parser = argparse.ArgumentParser(prog="wledhub")
    parser.add_argument("--data", default=os.environ.get("WLEDHUB_DATA", "/data"))
    parser.add_argument("--port", type=int, default=None)
    parser.add_argument("--frontend", default=str(Path(__file__).resolve().parent.parent / "frontend"))
    args = parser.parse_args()

    data_dir = Path(args.data)
    options = load_options(data_dir)
    logging.basicConfig(
        level=getattr(logging, str(options.get("log_level", "info")).upper(), logging.INFO),
        format="%(asctime)s %(levelname)s %(name)s: %(message)s",
    )

    port = args.port or int(options.get("port", 8787))
    ingress_port = int(os.environ.get("INGRESS_PORT", 0)) or None
    token = options.get("api_token") or None
    ctx = ssl_context(options.get("certfile", "") if options.get("ssl") else "",
                      options.get("keyfile", ""))

    store = Store(data_dir / "hub.json")
    store.load()
    hid = hub_id(data_dir)
    hub = Hub(store, hid, __version__)

    discovery = Discovery(hub.on_discovered)
    app = create_app(hub, Path(args.frontend), token=token, ingress_port=ingress_port)
    runner = web.AppRunner(app)
    await runner.setup()

    await hub.start()
    sites = [web.TCPSite(runner, "0.0.0.0", port, ssl_context=ctx)]
    if ingress_port and ingress_port != port:
        sites.append(web.TCPSite(runner, "0.0.0.0", ingress_port))
    for site in sites:
        await site.start()
    _LOGGER.info("WLED Hub %s on %s://0.0.0.0:%s", __version__, "https" if ctx else "http", port)

    if hub.config.settings.discovery:
        try:
            await discovery.start()
            await discovery.advertise(port, hid, __version__)
        except OSError as err:
            _LOGGER.warning("mDNS unavailable: %s", err)
    await supervisor_discovery(port, hid)

    stop = asyncio.Event()
    loop = asyncio.get_running_loop()
    for sig in (signal.SIGTERM, signal.SIGINT):
        try:
            loop.add_signal_handler(sig, stop.set)
        except NotImplementedError:  # Windows dev machines
            pass
    try:
        await stop.wait()
    finally:
        await discovery.stop()
        await hub.stop()
        await runner.cleanup()


if __name__ == "__main__":
    try:
        asyncio.run(main())
    except KeyboardInterrupt:
        pass
