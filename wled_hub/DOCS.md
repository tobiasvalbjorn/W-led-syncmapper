# WLED Hub

Controls and synchronises all your WLED devices as rooms and groups (Sonos-style), with a shared pixel grid and camera mapping.

## Getting started

1. Start the add-on and open **WLED Hub** in the sidebar.
2. **Devices** lists the WLED devices found on your network. Tap *Add* (*Tilføj*).
3. Create rooms with **+** under **Rooms** (*Rum*) and move the devices into them.
4. Place your light strings under **Grid**, either by hand or with the camera icon.
5. Install the **WLED Hub** integration (HACS) to get rooms and groups as light entities.

The app's interface is currently in Danish.

## Options

| Option | Meaning |
|---|---|
| `port` | Port for the app on the LAN, default 8787. Ingress always works. |
| `api_token` | Optional. When set, the LAN port requires it. |
| `ssl` / `certfile` / `keyfile` | HTTPS on the LAN port (files in `/ssl`). The camera needs HTTPS. |
| `log_level` | debug, info, warning or error |

The add-on uses the host network so it can find WLED devices over mDNS and stream DDP (UDP 4048) to them.
