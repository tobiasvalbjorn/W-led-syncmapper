"""Fake WLED device for developing the hub without real hardware.

    python tools/fake_wled.py --ip 127.0.0.2 --leds 150 --name Stue
    python tools/fake_wled.py --ip 127.0.0.3 --leds 256 --matrix 16x16 --name Panel

Implements the small part of the JSON API the hub uses and counts DDP
frames received on UDP 4048, so you can see that streaming works.
"""
from __future__ import annotations

import argparse
import asyncio
import json
import struct

from aiohttp import web


def make_app(args) -> web.Application:
    mac = "aabbcc" + "".join(f"{int(p):02x}" for p in args.ip.split(".")[1:])
    state = {"on": True, "bri": 128, "live": False, "udpn": {"send": False, "recv": True, "sgrp": 1, "rgrp": 1},
             "seg": [{"id": 0, "start": 0, "stop": args.leds, "fx": 0, "sx": 128, "ix": 128, "pal": 0,
                      "col": [[255, 160, 0], [0, 0, 0], [0, 0, 0]]}]}
    leds = {"count": args.leds, "rgbw": False, "lc": 1}
    if args.matrix:
        w, h = args.matrix.lower().split("x")
        leds["matrix"] = {"w": int(w), "h": int(h)}
    info = {"ver": "16.0.1", "name": args.name, "mac": mac, "arch": "esp32", "leds": leds,
            "live": False, "lm": "", "lip": "", "udpport": 21324}
    outputs = [{"start": 0, "len": args.leds, "pin": [16], "type": 22, "rev": False}]
    if args.outputs > 1:
        per = args.leds // args.outputs
        outputs = [{"start": i * per, "len": per if i < args.outputs - 1 else args.leds - i * per,
                    "pin": [16 + i], "type": 22, "rev": False} for i in range(args.outputs)]

    async def get_info(_):
        info["live"] = state["live"]
        return web.json_response(info)

    async def get_state(_):
        return web.json_response(state)

    async def post_state(request):
        data = await request.json()
        print(f"[{args.name}] state <- {json.dumps(data)}")
        for key, value in data.items():
            if key == "seg":
                for seg in value:
                    state["seg"][0].update(seg)
            elif isinstance(value, dict) and isinstance(state.get(key), dict):
                state[key].update(value)
            else:
                state[key] = value
        return web.json_response({"success": True})

    app = web.Application()
    app.router.add_get("/json/info", get_info)
    app.router.add_get("/json/state", get_state)
    app.router.add_post("/json/state", post_state)
    app.router.add_get("/json/effects", lambda _: web.json_response(["Solid", "Blink", "Breathe", "Wipe", "Rainbow", "Colorloop"]))
    app.router.add_get("/json/palettes", lambda _: web.json_response(["Default", "* Random Cycle", "Party", "Ocean"]))
    app.router.add_get("/json/cfg", lambda _: web.json_response({"hw": {"led": {"ins": outputs}}}))
    app["state"] = state
    return app


class DDPCounter(asyncio.DatagramProtocol):
    def __init__(self, name: str, state: dict) -> None:
        self.name, self.state, self.frames, self.packets = name, state, 0, 0

    def datagram_received(self, data, addr):
        flags, seq, dtype, dest, offset, length = struct.unpack("!BBBBIH", data[:10])
        self.packets += 1
        self.state["live"] = True
        if flags & 0x01:
            self.frames += 1
            if self.frames % 100 == 1:
                first = tuple(data[10:13])
                print(f"[{self.name}] DDP frame {self.frames} ({self.packets} packets), first pixel {first}")


async def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--ip", default="127.0.0.2")
    parser.add_argument("--port", type=int, default=80)
    parser.add_argument("--leds", type=int, default=150)
    parser.add_argument("--matrix", default="")
    parser.add_argument("--outputs", type=int, default=1, help="simulate N strings on N pins")
    parser.add_argument("--name", default="Fake WLED")
    args = parser.parse_args()

    app = make_app(args)
    runner = web.AppRunner(app)
    await runner.setup()
    await web.TCPSite(runner, args.ip, args.port).start()
    loop = asyncio.get_running_loop()
    await loop.create_datagram_endpoint(lambda: DDPCounter(args.name, app["state"]), local_addr=(args.ip, 4048))
    print(f"Fake WLED '{args.name}' on http://{args.ip}:{args.port} with {args.leds} LEDs")
    await asyncio.Event().wait()


if __name__ == "__main__":
    asyncio.run(main())
