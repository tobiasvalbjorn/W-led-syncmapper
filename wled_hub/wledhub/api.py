"""HTTP + WebSocket API, also serves the PWA.

REST (JSON)                                   Purpose
-------------------------------------------   ------------------------------
GET    api/config                             full config + runtime + targets
GET    api/effects                            hub + WLED effects, palettes
PUT    api/targets/{id}/state                 control a room or group
POST   api/devices            {host, port?}   add device (probes /json/info)
PATCH  api/devices/{id}                       rename / move to room / disable
DELETE api/devices/{id}
GET    api/devices/{id}/outputs               LED outputs (strings) on the ESP
POST   api/devices/{id}/identify              blink it
POST   api/rooms              {name, icon}
PATCH  api/rooms/{id}
DELETE api/rooms/{id}
POST   api/groups             {room_ids, name?, id?}   group rooms (Sonos)
DELETE api/groups/{id}                        ungroup
PUT    api/layout                             pixel-grid mapping
PATCH  api/settings
POST   api/scan/start         {device_ids, level?}
POST   api/scan/pattern       {kind, bit?, inverse?, index?}
POST   api/scan/stop
GET    api/ws                 WebSocket: {"type": "config"|"preview", "data": ...}

All paths are relative to the server root so the app works behind Home
Assistant ingress, which strips the /api/hassio_ingress/<token> prefix.
"""
from __future__ import annotations

import asyncio
import json
import logging
from pathlib import Path
from typing import Optional

from aiohttp import WSMsgType, web

from . import effects as fx
from .hub import Hub
from .wled import WLEDError

_LOGGER = logging.getLogger(__name__)
INGRESS_PEER = "172.30.32.2"  # Home Assistant Supervisor ingress proxy


def json_response(data, status: int = 200) -> web.Response:
    return web.json_response(data, status=status, dumps=lambda d: json.dumps(d, ensure_ascii=False))


@web.middleware
async def error_middleware(request: web.Request, handler):
    try:
        return await handler(request)
    except web.HTTPException:
        raise
    except KeyError as err:
        return json_response({"error": f"Not found: {err}"}, 404)
    except (ValueError, TypeError) as err:
        return json_response({"error": str(err)}, 400)
    except WLEDError as err:
        return json_response({"error": str(err)}, 502)


def auth_middleware(token: Optional[str], ingress_port: Optional[int]):
    """Ingress requests are already authenticated by Home Assistant.

    On the ingress port only the Supervisor proxy may connect. On the LAN
    port an optional bearer token protects the API (static files are open
    so the PWA can load and ask for the token).
    """

    @web.middleware
    async def middleware(request: web.Request, handler):
        sock = request.transport.get_extra_info("sockname") if request.transport else None
        port = sock[1] if sock else None
        if ingress_port and port == ingress_port:
            if request.remote != INGRESS_PEER:
                raise web.HTTPForbidden(text="Ingress port only accepts the Supervisor")
            return await handler(request)
        if token and request.path.startswith("/api/"):
            supplied = request.headers.get("Authorization", "").removeprefix("Bearer ").strip()
            supplied = supplied or request.query.get("token", "")
            if supplied != token:
                raise web.HTTPUnauthorized(text="Missing or wrong API token")
        return await handler(request)

    return middleware


def create_app(hub: Hub, frontend: Path, token: Optional[str] = None,
               ingress_port: Optional[int] = None) -> web.Application:
    @web.middleware
    async def revalidate_static(request: web.Request, handler):
        # Always revalidate app files so updates show up at once; the service
        # worker provides the offline copy.
        response = await handler(request)
        if not request.path.startswith("/api/"):
            response.headers.setdefault("Cache-Control", "no-cache")
        return response

    app = web.Application(middlewares=[auth_middleware(token, ingress_port), error_middleware, revalidate_static])
    routes = web.RouteTableDef()

    async def body(request: web.Request) -> dict:
        try:
            data = await request.json()
        except json.JSONDecodeError as err:
            raise ValueError(f"Invalid JSON: {err}") from err
        if not isinstance(data, dict):
            raise ValueError("Expected a JSON object")
        return data

    @routes.get("/api/health")
    async def health(_request):
        return json_response({"ok": True, "id": hub.hub_id, "version": hub.version})

    @routes.get("/api/config")
    async def get_config(_request):
        return json_response(hub.snapshot())

    @routes.get("/api/effects")
    async def get_effects(_request):
        return json_response({
            "hub": fx.catalogue(),
            "wled": [{"id": i, "name": n} for i, n in enumerate(hub.wled_effects) if n and n != "RSVD"],
            "palettes": [{"id": i, "name": n} for i, n in enumerate(hub.wled_palettes)],
        })

    @routes.put("/api/targets/{target_id}/state")
    async def put_state(request):
        state = await hub.set_state(request.match_info["target_id"], await body(request))
        from dataclasses import asdict

        return json_response(asdict(state))

    # devices
    @routes.post("/api/devices")
    async def add_device(request):
        data = await body(request)
        device = await hub.add_device(str(data["host"]).strip(), int(data.get("port", 80)), data.get("room_id"))
        return json_response(device.to_dict(runtime=True), 201)

    @routes.patch("/api/devices/{device_id}")
    async def patch_device(request):
        device = await hub.update_device(request.match_info["device_id"], await body(request))
        return json_response(device.to_dict(runtime=True))

    @routes.delete("/api/devices/{device_id}")
    async def delete_device(request):
        await hub.remove_device(request.match_info["device_id"])
        return json_response({"ok": True})

    @routes.get("/api/devices/{device_id}/outputs")
    async def outputs(request):
        return json_response(await hub.device_outputs(request.match_info["device_id"]))

    @routes.post("/api/devices/{device_id}/identify")
    async def identify(request):
        asyncio.ensure_future(hub.identify(request.match_info["device_id"]))
        return json_response({"ok": True})

    # rooms & groups
    @routes.post("/api/rooms")
    async def add_room(request):
        data = await body(request)
        room = await hub.add_room(str(data["name"]), data.get("icon", "sofa"))
        return json_response({"id": room.id}, 201)

    @routes.patch("/api/rooms/{room_id}")
    async def patch_room(request):
        room = await hub.update_room(request.match_info["room_id"], await body(request))
        return json_response({"id": room.id})

    @routes.delete("/api/rooms/{room_id}")
    async def delete_room(request):
        await hub.remove_room(request.match_info["room_id"])
        return json_response({"ok": True})

    @routes.post("/api/groups")
    async def set_group(request):
        data = await body(request)
        group = await hub.set_group(list(data.get("room_ids", [])), data.get("name"), data.get("id"))
        return json_response({"id": group.id if group else None})

    @routes.delete("/api/groups/{group_id}")
    async def delete_group(request):
        await hub.ungroup(request.match_info["group_id"])
        return json_response({"ok": True})

    # layout & settings
    @routes.put("/api/layout")
    async def put_layout(request):
        await hub.set_layout(await body(request))
        return json_response({"ok": True})

    @routes.patch("/api/settings")
    async def patch_settings(request):
        from dataclasses import asdict

        from .models import Settings

        merged = {**asdict(hub.config.settings), **(await body(request))}
        hub.config.settings = Settings.from_dict(merged)
        hub.changed()
        return json_response(asdict(hub.config.settings))

    # camera mapping
    @routes.post("/api/scan/start")
    async def scan_start(request):
        data = await body(request)
        scan = await hub.scan_start(list(data.get("device_ids", [])), int(data.get("level", 160)))
        return json_response(scan.describe())

    @routes.post("/api/scan/pattern")
    async def scan_pattern(request):
        if hub.scan is None:
            raise ValueError("No scan running")
        data = await body(request)
        hub.scan.set_pattern(data.get("kind", "black"), int(data.get("bit", 0)),
                             bool(data.get("inverse", False)), int(data.get("index", -1)))
        # Let the render loop send at least one frame before answering.
        await asyncio.sleep(2.0 / hub.config.settings.fps)
        return json_response(hub.scan.pattern)

    @routes.post("/api/scan/stop")
    async def scan_stop(_request):
        await hub.scan_stop()
        return json_response({"ok": True})

    # websocket
    @routes.get("/api/ws")
    async def websocket(request):
        ws = web.WebSocketResponse(heartbeat=30)
        await ws.prepare(request)
        queue: asyncio.Queue = asyncio.Queue(maxsize=50)
        want_preview = request.query.get("preview") == "1"

        def listener(message: dict) -> None:
            if message["type"] == "preview" and not want_preview:
                return
            if queue.full():
                try:
                    queue.get_nowait()  # drop oldest instead of blocking the hub
                except asyncio.QueueEmpty:
                    pass
            queue.put_nowait(message)

        async def sender() -> None:
            while True:
                message = await queue.get()
                await ws.send_str(json.dumps(message, ensure_ascii=False))

        hub.listeners.append(listener)
        await ws.send_str(json.dumps({"type": "config", "data": hub.snapshot()}, ensure_ascii=False))
        task = asyncio.ensure_future(sender())
        try:
            async for msg in ws:
                if msg.type == WSMsgType.TEXT:
                    data = json.loads(msg.data)
                    if data.get("type") == "preview":
                        want_preview = bool(data.get("enabled"))
                elif msg.type == WSMsgType.ERROR:
                    break
        finally:
            task.cancel()
            hub.listeners.remove(listener)
        return ws

    app.add_routes(routes)

    async def index(_request):
        return web.FileResponse(frontend / "index.html", headers={"Cache-Control": "no-cache"})

    app.router.add_get("/", index)
    app.router.add_static("/", frontend, show_index=False)
    return app
