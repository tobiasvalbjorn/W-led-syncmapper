# WLED Hub (WLED-FX-mapper)

A central hub that controls and synchronises all your [WLED](https://kno.wled.ge) devices around the house:

- **Sonos-style rooms and groups**: drag one room onto another to link them, for example into "Whole house".
- **A shared pixel grid**: every light string is placed on one map of the house, so hub effects flow across devices.
- **Twinkly-style camera mapping**: stand in front of the house and your phone works out where every LED is.
- **Mapping by hand**: shape templates (rectangle for a TV backlight, windows, gables …) and an LED cursor you move with the arrow keys. The LED lights up on the real strip, so you can pin each corner to the LED that sits there.
- **Lamps with several parts**: split one strip into parts (say an outer and an inner ring), place, scale and rotate them separately or as one lamp, and highlight a part on the real lamp by hovering over it. On a PC the grid editor shows the tools on the left and the grid on the right.
- **Effect Studio and painting**: build your own layered effects (lines, gradients, rings, waves, sparkle) and paint colours straight onto the LEDs; save them and use them in any room or from Home Assistant.
- **Several grids**: map each area – front of the house, the back, a TV wall, a kids' room – on its own grid.
- **Every WLED setting in one place**: sync, realtime, nightlight, presets, segments and a raw JSON editor for each device.
- **Home Assistant**: every room and group becomes a `light` entity with brightness, colour and effects. The hub is discovered automatically, and the whole app is available in the sidebar.
- **Phone app**: a PWA you install from the browser. It also works in any browser on your local network.

See [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) for the architecture, data model and synchronisation details.

## Contents

| Folder | What |
|---|---|
| `wled_hub/` | Home Assistant add-on (app): the hub in Python/aiohttp plus the web app |
| `wled_hub/wledhub/` | Hub code: engine, effects, DDP, WLED client, mDNS, API |
| `wled_hub/frontend/` | PWA (plain ES modules, no build step) |
| `custom_components/wled_hub/` | Home Assistant integration (HACS) |
| `tools/` | `fake_wled.py` (simulated WLED device) and an icon generator |
| `tests/` | Unit tests (`pytest`) |

## Installing in Home Assistant

1. **Add-on (the hub)**: Settings → Add-ons (Apps) → Store → ⋮ → Repositories → add `https://github.com/tobiasvalbjorn/WLED-FX-mapper`. Install **WLED Hub**, turn on "Show in sidebar", and start it.
2. **Integration**: HACS → ⋮ → Custom repositories → `https://github.com/tobiasvalbjorn/WLED-FX-mapper`, category *Integration*. Install **WLED Hub** and restart Home Assistant. The hub then shows up as "Discovered" under *Settings → Devices & services*.
3. Open **WLED Hub** in the sidebar. Add the discovered WLED devices under *Devices*, create rooms, and place your light strings under *Grid*.

Every room and group becomes `light.<name>`. The effect list contains both hub effects (prefixed `Hub:`) and WLED's built-in effects, so you can use them in automations:

```yaml
action: light.turn_on
target:
  entity_id: light.whole_house
data:
  effect: "Hub: Rainbow wave"
  brightness: 180
```

## Phone app (PWA) and local network

- **In the Home Assistant app**: WLED Hub is in the sidebar.
- **Directly on the LAN** (fastest – no detour through Home Assistant): open `http://<home-assistant-ip>:8787` and choose *Add to Home Screen* (iOS) or *Install app* (Android).
- **Camera mapping needs HTTPS**, because browsers only give camera access on secure connections. Use the app through Home Assistant over HTTPS (for example Nabu Casa), or turn on `ssl` in the add-on options with certificates in `/ssl`.
- **Access control**: by default the LAN port is open to everyone on the network. If guests share your Wi-Fi, set `api_token` in the add-on and open the app once with `?token=<token>`.

## Development without hardware

```bash
python -m venv .venv
```

```bash
.venv/Scripts/pip install aiohttp zeroconf pytest
```

Start two fake WLED devices and the hub, each in its own terminal:

```bash
.venv/Scripts/python tools/fake_wled.py --ip 127.0.0.2 --leds 150 --outputs 2 --name Stue
```

```bash
.venv/Scripts/python tools/fake_wled.py --ip 127.0.0.3 --leds 256 --matrix 16x16 --name Terrasse
```

```bash
cd wled_hub && ../.venv/Scripts/python -m wledhub --data ../.devdata --port 8787
```

Then open <http://127.0.0.1:8787>. Run the tests with `pytest tests`.

On Linux and macOS the virtual environment's scripts are in `.venv/bin/` instead of `.venv/Scripts/`.

## Status

Version 0.1.0 is a first working draft. The hub, the web app and the camera decoding have been tested against simulated devices. The Home Assistant integration and the add-on image have **not yet been run in a real Home Assistant**. See "Not yet verified" in [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md).

## License

MIT, see [LICENSE](LICENSE). WLED is a separate open source project (MIT) and is not affiliated with this project.
