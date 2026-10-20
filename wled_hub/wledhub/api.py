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
GET    api/devices/{id}/wled/{path}           proxy to the device (json/cfg, presets.json …)
POST   api/devices/{id}/wled/json/state|cfg   change any WLED setting
POST   api/devices/{id}/highlight {index, start?, count?, marks?} | {ranges: [[start, count, rgb?]], effect?}
DELETE api/devices/{id}/highlight             end the mapping cursor
POST   api/rooms              {name, icon}
PATCH  api/rooms/{id}
DELETE api/rooms/{id}
POST   api/groups             {room_ids, name?, id?}   group rooms (Sonos)
DELETE api/groups/{id}                        ungroup
POST   api/layouts            {name, copy_from?}  new grid (area), optionally a copy of another
PUT    api/layouts/{id}                       save a grid's mapping
PATCH  api/layouts/{id}       {name}          rename a grid
DELETE api/layouts/{id}                       delete a grid (not the last)
GET    api/layouts/{id}/background            a grid's background image
GET    api/layouts/{id}/field?target=&cols=&rows=  a room's hub effect sampled over the grid (overlay)
POST   api/custom-effects     {id?, name, background, layers}  save a Studio effect
DELETE api/custom-effects/{id}
POST   api/scenes             {id?, name, pixels: {device: "rrggbb…"}}  save a painted scene
GET    api/scenes/{id}        full scene (pixels)
DELETE api/scenes/{id}
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
import base64
import json
import logging
import time
from pathlib import Path
from typing import Optional

from aiohttp import WSMsgType, web

from . import effects as fx
from .hub import Hub
from .wled import WLEDError

_LOGGER = logging.getLogger(__name__)
INGRESS_PEER = "172.30.32.2"  # Home Assistant Supervisor ingress proxy
# Device API paths the app may read / write through the hub's proxy
WLED_READ = {"json", "json/state", "json/info", "json/si", "json/cfg", "json/effects",
             "json/palettes", "json/nodes", "presets.json"}
WLED_WRITE = {"json/state", "json/cfg"}


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
            "custom": [{"id": k, "name": v.get("name", k)} for k, v in hub.config.custom_effects.items()],
            "scenes": [{"id": k, "name": v.get("name", k)} for k, v in hub.config.scenes.items()],
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

    @routes.post("/api/devices/{device_id}/highlight")
    async def highlight(request):
        data = await body(request)
        await hub.highlight(request.match_info["device_id"], int(data.get("index", -1)),
                            int(data.get("start", 0)), int(data.get("count", 0)), data.get("marks"),
                            data.get("ranges"), str(data.get("effect", "solid")), bool(data.get("plain", False)))
        return json_response({"ok": True})

    @routes.delete("/api/devices/{device_id}/highlight")
    async def clear_highlight(request):
        await hub.clear_highlight(request.match_info["device_id"])
        return json_response({"ok": True})

    # Direct access to a device's own WLED API (all settings: sync, live,
    # nightlight, presets, segments, raw config). Proxied so it also works
    # through ingress/HTTPS, where the browser may not reach the device.
    @routes.get("/api/devices/{device_id}/wled/{path:.+}")
    async def wled_get(request):
        path = request.match_info["path"]
        if path not in WLED_READ:
            raise ValueError(f"Not allowed: {path}")
        device = hub.config.devices[request.match_info["device_id"]]
        return json_response(await hub.client(device).request("GET", "/" + path))

    @routes.post("/api/devices/{device_id}/wled/{path:.+}")
    async def wled_post(request):
        path = request.match_info["path"]
        if path not in WLED_WRITE:
            raise ValueError(f"Not allowed: {path}")
        device = hub.config.devices[request.match_info["device_id"]]
        result = await hub.client(device).request("POST", "/" + path, await body(request))
        if path == "json/cfg":
            asyncio.ensure_future(hub.refresh_device(device))  # LED count etc. may have changed
        return json_response(result)

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
    # Effect Studio library
    @routes.post("/api/custom-effects")
    async def save_custom(request):
        data = await body(request)
        return json_response({"id": hub.save_custom_effect(data, data.get("id"))})

    @routes.delete("/api/custom-effects/{effect_id}")
    async def delete_custom(request):
        hub.delete_custom_effect(request.match_info["effect_id"])
        return json_response({"ok": True})

    @routes.post("/api/scenes")
    async def save_scene(request):
        data = await body(request)
        return json_response({"id": hub.save_scene(data, data.get("id"))})

    @routes.get("/api/scenes/{scene_id}")
    async def get_scene(request):
        return json_response(hub.config.scenes[request.match_info["scene_id"]])

    @routes.delete("/api/scenes/{scene_id}")
    async def delete_scene(request):
        hub.delete_scene(request.match_info["scene_id"])
        return json_response({"ok": True})

    # grids (one per area)
    @routes.post("/api/layouts")
    async def add_layout(request):
        data = await body(request)
        return json_response({"id": hub.add_layout(str(data.get("name", "New grid")), data.get("copy_from"))}, 201)

    @routes.patch("/api/layouts/{grid_id}")
    async def rename_layout(request):
        hub.rename_layout(request.match_info["grid_id"], str((await body(request)).get("name", "")))
        return json_response({"ok": True})

    @routes.delete("/api/layouts/{grid_id}")
    async def delete_layout(request):
        await hub.delete_layout(request.match_info["grid_id"])
        return json_response({"ok": True})

    @routes.get("/api/layouts/{grid_id}/field")
    async def effect_field(request):
        cols, rows = int(request.query.get("cols", 64)), int(request.query.get("rows", 40))
        data = hub.effect_field(request.match_info["grid_id"], request.query.get("target", ""), cols, rows)
        return json_response({"cols": max(2, min(160, cols)), "rows": max(2, min(120, rows)),
                              "data": base64.b64encode(data).decode()})

    @routes.get("/api/layouts/{grid_id}/background")
    async def get_background(request):
        return json_response({"background": hub.config.layouts[request.match_info["grid_id"]].background})

    @routes.put("/api/layouts/{grid_id}")
    async def put_layout(request):
        await hub.set_layout(request.match_info["grid_id"], await body(request))
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
        # Only the newest config and the newest preview frame wait to be sent:
        # on a slow link (phone via Home Assistant / the internet) nothing
        # piles up, the client just skips frames.
        slots: dict = {"config": None, "preview": None}
        wake = asyncio.Event()
        pv = {"on": request.query.get("preview") == "1", "fps": float(request.query.get("fps", 8)), "last": 0.0}
        if pv["on"]:
            hub.preview_clients += 1

        def set_preview(on: bool, fps: float) -> None:
            if on != pv["on"]:
                hub.preview_clients += 1 if on else -1
            pv["on"], pv["fps"] = on, max(1.0, min(30.0, fps))

        def listener(message: dict) -> None:
            if message["type"] == "preview":
                now = time.monotonic()
                if not pv["on"] or now - pv["last"] < 1.0 / pv["fps"]:
                    return
                pv["last"] = now
            slots[message["type"]] = message
            wake.set()

        async def sender() -> None:
            while True:
                await wake.wait()
                wake.clear()
                for kind in ("config", "preview"):
                    message, slots[kind] = slots[kind], None
                    if message is not None:
                        await ws.send_str(json.dumps(message, ensure_ascii=False))

        hub.listeners.append(listener)
        await ws.send_str(json.dumps({"type": "config", "data": hub.snapshot()}, ensure_ascii=False))
        task = asyncio.ensure_future(sender())
        try:
            async for msg in ws:
                if msg.type == WSMsgType.TEXT:
                    data = json.loads(msg.data)
                    if data.get("type") == "preview":
                        set_preview(bool(data.get("enabled")), float(data.get("fps", pv["fps"])))
                elif msg.type == WSMsgType.ERROR:
                    break
        finally:
            task.cancel()
            hub.listeners.remove(listener)
            if pv["on"]:
                hub.preview_clients -= 1
        return ws

    app.add_routes(routes)

    async def index(_request):
        return web.FileResponse(frontend / "index.html", headers={"Cache-Control": "no-cache"})

    app.router.add_get("/", index)
    app.router.add_static("/", frontend, show_index=False)
    return app
