# Architecture

```
 Phone / browser (PWA)             Home Assistant
  ├─ Rooms (Sonos-style UI)         ├─ Ingress panel in the sidebar ──┐
  ├─ Grid editor + live preview     └─ custom_components/wled_hub     │
  └─ Camera mapping                      light.* per room/group       │
        │  REST + WebSocket                 │ REST + WebSocket        │
        └──────────────┬────────────────────┘                         │
                       ▼                                              │
            WLED Hub (HA add-on, Python/aiohttp) ◄────────────────────┘
             ├─ Hub          rooms, groups, targets, sync bits
             ├─ Engine       render loop at 40 fps on the shared canvas
             ├─ Effects      rainbow, plasma, comet, aurora …
             ├─ Mapping      placements → (x, y) per LED
             ├─ Scanner      binary patterns for camera mapping
             ├─ Discovery    mDNS: finds _wled._tcp, advertises _wledhub._tcp
             └─ Store        /data/hub.json
                       │
       ┌───────────────┼──────────────────────────┐
       │ JSON API (HTTP)   DDP (UDP 4048)    UDP sync (21324, WLED↔WLED)
       ▼               ▼                          ▼
   WLED ESP32 #1   WLED ESP32 #2   …   (several strings per ESP = several outputs)
```

## Two ways to synchronise

| | **WLED effect** (`source: "wled"`) | **Hub effect** (`source: "hub"`) |
|---|---|---|
| Where pixels are computed | On each ESP32 | In the hub |
| Transport | JSON API once, plus WLED UDP sync | DDP stream at 40 fps |
| Synchronisation | The first device in the room/group is the sync leader. It sends on a group bit the hub reserves for that target (bits 2–128; bit 1 is WLED's default and is left alone) | One shared clock renders every pixel. The push flag is set on the last packet of each frame, so every frame appears at once |
| Flows across devices | No, each device runs the effect on its own strip | Yes, the effect uses each LED's (x, y) on the shared grid |
| Wi-Fi load | Almost none | ~3 bytes × LEDs × fps (1000 LEDs ≈ 120 kB/s) |

When a target switches from a hub effect to a WLED effect, the hub sends `"live": false` so the device leaves realtime mode at once. When the hub stops streaming, WLED returns on its own after `if.live.timeout`, which defaults to 2.5 s.

## Concepts

- **Device**: one WLED controller. It can have several outputs, meaning light strings on different GPIOs. WLED puts them one after another in a single LED index, and the hub reads the ranges from `/json/cfg` → `hw.led.ins[]`.
- **Room**: the Sonos "speaker". Each device belongs to at most one room.
- **Group**: rooms linked together. The group's state applies to all its rooms.
- **Target**: what you control. It is either a group, or a room that is not in a group. Each target is one `light` entity in Home Assistant.
- **Placement**: puts a range of LEDs from one device on the grid, as a `line` (polyline with corners), a `matrix` (2D panel) or `points` (one point per LED, from camera mapping).

## Data model (`/data/hub.json`)

```jsonc
{
  "version": 1,
  "devices": {
    "wled_a1b2c3": {
      "id": "wled_a1b2c3", "name": "Carport", "host": "192.168.1.111", "port": 80,
      "mac": "aabbcca1b2c3", "led_count": 300, "matrix": null, "version": "16.0.1",
      "room_id": "room_carport", "enabled": true, "rgbw": false
    }
  },
  "rooms": {
    "room_carport": {
      "id": "room_carport", "name": "Carport", "icon": "garage", "order": 0,
      "state": {
        "on": true, "brightness": 180, "color": [255, 147, 41], "color2": [0, 0, 0],
        "effect": { "source": "hub", "id": "rainbow_wave", "speed": 128, "intensity": 128,
                    "palette": 0, "params": { "angle": 0 } },
        "updated": 1792475776.9
      }
    }
  },
  "groups": {
    "group_2cc6e313": { "id": "group_2cc6e313", "name": "Whole house",
                        "room_ids": ["room_carport", "room_living"], "state": { "...": "as above" } }
  },
  "layout": {
    "width": 20, "height": 12, "background": "data:image/jpeg;base64,… (optional)",
    "placements": [
      { "id": "pl_1", "device_id": "wled_a1b2c3", "start": 0, "count": 150, "shape": "line",
        "template": "rect", "points": [[1, 2], [6, 2], [6, 5], [1, 5], [1, 2]],
        "anchors": [0, 50, 75, 125, 150], "reverse": false },
      { "id": "pl_2", "device_id": "wled_a1b2c3", "start": 150, "count": 150, "shape": "points",
        "points": [[8.1, 3.2], [8.15, 3.21], "…"] },
      { "id": "pl_3", "device_id": "wled_d4e5f6", "start": 0, "count": 256, "shape": "matrix",
        "x": 12, "y": 1, "width": 2, "height": 2, "cols": 16, "rows": 16,
        "serpentine": true, "origin": "top-left", "vertical": false }
    ]
  },
  "settings": { "fps": 40, "sync_group": 1, "realtime_timeout": 2.5, "discovery": true }
}
```

`bulges` (optional, one per segment) curves a segment into a circular arc: bulge = tan(sweep/4), 0 = straight, 1 = half circle. A circle is two points with bulges `[1, 1]`, so it has two segments like any other shape and its LEDs are spread evenly around it. The grid editor shows a small square in the middle of every segment; dragging it sets the bulge.

`anchors` (optional) pins each point of a line to an LED index relative to `start`: LEDs between two points are spread evenly on that segment, so a corner lands exactly on the LED that sits in the real corner. For a closed shape the last anchor is `count`. Without anchors, LEDs are spread evenly by length. `template` records which shape template the placement came from, for the corner guide.

Coordinates use any unit you like (metres work well). Effects receive them normalised to 0..1. Once a device has at least one placement, only the LEDs drawn on the grid take part in hub effects; the rest stay off. A device with no placement at all gets a temporary horizontal line, so a new device lights up straight away.

A lamp whose strip is split into parts (for example LEDs 0–55 on the outside and 56–157 on the inside) is simply one device with several placements, each with its own `start`, `count` and optional `name`. The grid editor can split a part at the LED cursor, move, scale and rotate a part or the whole lamp, and light a part or lamp on the real device while you hover over it (`POST api/devices/{id}/highlight {"ranges": [[start, count]]}`).

## Mapping by hand: LED cursor and shape templates

1. Create a shape from a template (rectangle for a TV backlight, window or door; three sides; L; gable; circle; line), choosing where LED 0 sits and the direction.
2. The corner guide asks for each corner in turn. Move the cursor with the arrow keys (Shift = 10 LEDs, Home/End) or the on-screen buttons. The hub lights the cursor LED white on the real strip (`POST api/devices/{id}/highlight`), the first LED green and the corners already set amber.
3. Press Enter when the white LED is in the corner. That LED becomes the corner's anchor.
4. Any point can be pinned to the cursor LED: click the point, move the cursor, press P. "Close loop" connects the last point back to the first. Dragged points snap into line with the other points (Alt = no snapping), and every change can be undone with Ctrl+Z.
5. On free lines, Enter on any LED inserts a bend point there ("Bend here"); drag it to where the corner is.

## Test patterns

The grid editor can show test patterns on the real lights for the selected part or whole lamp: one colour per part and per side (stretch between corners, for shapes with up to 12 segments), a chase that runs along each side to show the wiring direction, a rainbow, or white. The hub renders them from `POST api/devices/{id}/highlight {"ranges": [[start, count, [r, g, b]]], "effect": "solid" | "chase" | "rainbow"}`. While the LED cursor is active, the sides are shown in dimmed versions of the same colours.

## Camera mapping

1. The hub gives every LED in the scan a code `= global index + 1`. Code 0 means "no LED".
2. For each bit *k* it lights the LEDs whose code has bit *k* set, and then the inverse pattern. That takes `2·⌈log2(N+1)⌉` frames, for example 22 for 2000 LEDs.
3. The phone compares each camera pixel between the pattern and its inverse. Pixels that barely change are background. Pixels with the same code are averaged into that LED's centre.
4. Outliers (reflections) are rejected by their distance to neighbouring LEDs. Gaps are interpolated along the LED index.
5. The result is saved as `points` placements, scaled into a chosen area of the grid. Scan each side of the house separately.

The images never leave the phone. The camera needs a secure connection (HTTPS or localhost); see the README.

## Device settings

The app reaches every WLED setting through the hub's proxy (`api/devices/{id}/wled/json/state|cfg|info`, `presets.json`): sync (send/receive flags and groups, ports), realtime (UDP/Hyperion, E1.31/Art-Net/DMX, timeout), nightlight, presets (apply, save with `psave`, delete with `pdel`), segments, live override, power limit, name, reboot, plus a raw JSON editor for everything else. The proxy only allows these paths. `json/cfg` writes are saved to the device's flash.

## Verified WLED facts (source: WLED source code, v0.14–v16.0.1)

- DDP: UDP 4048. 10-byte header: flags `0x40|0x01(push)`, sequence 1–15, type `0x0B` RGB / `0x1B` RGBW, destination `1`, offset in bytes (u32 BE), length (u16 BE). After the first push packet, WLED only renders on push. Use 480 RGB pixels per packet.
- `live: false` leaves realtime mode at once. `if.live.timeout` is in units of 100 ms (default 25).
- `udpn.sgrp` / `udpn.rgrp` exist since 0.14. `udpn.recv` is read-only from 0.15.
- mDNS: `_wled._tcp` with TXT `mac=<12 hex>`.
- `/json/info`: `leds.count`, `leds.matrix{w,h}` (2D only), `mac`, `ver`, `live`, `wifi{rssi,signal}`, `uptime`.
- cfg keys used by the settings sheet: `id.name`, `id.mdns`, `hw.led.maxpwr`, `light.nl{mode,dur,tbri}`, `if.sync.send{en,dir,btn,va,hue,grp,ret}`, `if.sync.recv{bri,col,fx,pal,grp,seg,sb}`, `if.live{en,mso,rlm,port,mc,timeout,dmx{uni,addr,mode,seqskip}}`. State: `psave`, `pdel`, `rb`, `lor`, `nl`.

## Not yet verified (needs testing on real hardware)

- Whether WLED's UDP sync keeps effect timing close enough for every effect. If not, the effect can be run as a hub effect instead.
- RGBW white extraction for DDP.
- The `hw.led.ins` keys in `/json/cfg` on every WLED version.
- The base image tag `ghcr.io/home-assistant/base-python:3.14-alpine3.24`.
- Whether HACS accepts a repository that also contains an add-on.
