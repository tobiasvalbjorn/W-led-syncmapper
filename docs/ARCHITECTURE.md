# Arkitektur

```
 Telefon / browser (PWA)          Home Assistant
  ├─ Rum (Sonos-UI)                ├─ Ingress-panel i sidebaren ──┐
  ├─ Grid-editor + live preview    └─ custom_components/wled_hub  │
  └─ Kamera-mapping                     light.* pr. rum/gruppe    │
        │  REST + WebSocket                │ REST + WebSocket     │
        └──────────────┬───────────────────┘                      │
                       ▼                                          │
            WLED Hub (HA add-on, Python/aiohttp) ◄────────────────┘
             ├─ Hub          rum, grupper, targets, sync-bits
             ├─ Engine       render-loop 40 fps på det fælles canvas
             ├─ Effects      regnbue, plasma, komet, nordlys …
             ├─ Mapping      placements → (x, y) pr. LED
             ├─ Scanner      binære mønstre til kamera-mapping
             ├─ Discovery    mDNS: finder _wled._tcp, annoncerer _wledhub._tcp
             └─ Store        /data/hub.json
                       │
       ┌───────────────┼──────────────────────────┐
       │ JSON API (HTTP)   DDP (UDP 4048)    UDP sync (21324, WLED↔WLED)
       ▼               ▼                          ▼
   WLED ESP32 #1   WLED ESP32 #2   …   (flere lyskæder pr. ESP = flere outputs)
```

## To måder at synkronisere på

| | **WLED-effekt** (`source: "wled"`) | **Hub-effekt** (`source: "hub"`) |
|---|---|---|
| Hvor beregnes pixels | På hver ESP32 | I hub'en |
| Transport | JSON API én gang + WLED UDP-sync | DDP-stream, 40 fps |
| Synkronisering | Første enhed i rummet/gruppen er sync-leder og sender på en gruppe-bit, som hub'en reserverer til netop det target (bit 2–128; bit 1 er WLED's standard og bliver ikke brugt) | Én fælles clock renderer alle pixels. Push-flaget sættes på sidste pakke i hver frame, så hver frame vises samlet |
| Flyder på tværs af enheder | Nej, hver enhed kører effekten på sin egen strip | Ja, effekten bruger LED'ernes (x, y) på det fælles grid |
| WiFi-belastning | Næsten ingen | ~3 bytes × LEDs × fps (1000 LEDs ≈ 120 kB/s) |

Når et target skifter fra hub- til WLED-effekt, sender hub'en `"live": false`, så enheden forlader realtime med det samme. Når hub'en stopper med at streame, går WLED selv tilbage efter `if.live.timeout`, som er 2,5 s som standard.

## Begreber

- **Device**: én WLED-controller. Den kan have flere outputs, altså lyskæder på forskellige GPIO'er. WLED lægger dem efter hinanden i ét LED-indeks, og hub'en læser intervallerne fra `/json/cfg` → `hw.led.ins[]`.
- **Room** (rum): Sonos' "højttaler". Hver enhed er i højst ét rum.
- **Group**: rum der er låst sammen. Gruppens tilstand gælder for alle dens rum.
- **Target**: det man styrer. Det er en gruppe, eller et rum der ikke er i en gruppe. Hvert target er én `light`-entitet i Home Assistant.
- **Placement**: placerer et interval af LEDs fra én enhed på griddet som `line` (polyline med knæk), `matrix` (2D-panel) eller `points` (ét punkt pr. LED, fra kamera-mapping).

## Datamodel (`/data/hub.json`)

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
    "group_2cc6e313": { "id": "group_2cc6e313", "name": "Hele huset",
                        "room_ids": ["room_carport", "room_stue"], "state": { "...": "som ovenfor" } }
  },
  "layout": {
    "width": 20, "height": 12, "background": "data:image/jpeg;base64,… (valgfri)",
    "placements": [
      { "id": "pl_1", "device_id": "wled_a1b2c3", "start": 0, "count": 150, "shape": "line",
        "points": [[1, 2], [6, 2], [6, 5], [1, 5], [1, 2]], "reverse": false },
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

Koordinater er i valgfri enheder (meter passer godt). Effekter får dem normaliseret til 0..1. LEDs uden placement får en midlertidig vandret linje, så nye enheder lyser med det samme.

## Kamera-mapping

1. Hub'en tildeler hver LED i scanningen en kode `= globalt indeks + 1`. Koden 0 betyder "ingen LED".
2. For hver bit *k* tænder den de LEDs, hvis kode har bit *k* sat, og bagefter det inverse mønster. Det giver `2·⌈log2(N+1)⌉` billeder, fx 22 for 2000 LEDs.
3. Telefonen sammenligner hver kamerapixel mellem mønster og inverse. Pixels der knap ændrer sig, er baggrund. Pixels med samme kode midles til LED'ens centrum.
4. Outliers (refleksioner) frasorteres med afstand til nabo-LEDs. Huller interpoleres langs indekset.
5. Resultatet gemmes som `points`-placements, skaleret ind i et valgt område af griddet. Flere facader scannes hver for sig.

Billederne forlader ikke telefonen. Kameraet kræver en sikker forbindelse (HTTPS eller localhost), se README.

## Verificerede WLED-fakta (kilde: WLED-source v0.14–v16.0.1)

- DDP: UDP 4048. Header på 10 bytes: flags `0x40|0x01(push)`, seq 1–15, type `0x0B` RGB / `0x1B` RGBW, dest `1`, offset i bytes (u32 BE), længde (u16 BE). Efter første push-pakke renderer WLED kun på push. Brug 480 RGB-pixels pr. pakke.
- `live: false` forlader realtime med det samme. `if.live.timeout` er i enheder af 100 ms (standard 25).
- `udpn.sgrp` / `udpn.rgrp` findes siden 0.14. `udpn.recv` er read-only fra 0.15.
- mDNS: `_wled._tcp` med TXT `mac=<12 hex>`.
- `/json/info`: `leds.count`, `leds.matrix{w,h}` (kun 2D), `mac`, `ver`, `live`.

## Ikke verificeret endnu (skal testes på rigtig hardware)

- Om WLED's UDP-sync holder effekt-timingen tæt nok sammen for alle effekter. Hvis ikke, kan effekten køres som hub-effekt i stedet.
- RGBW-hvid-udtrækning til DDP.
- `hw.led.ins`-nøglerne i `/json/cfg` på alle WLED-versioner.
- Base-image-tagget `ghcr.io/home-assistant/base-python:3.14-alpine3.24`.
- Om HACS accepterer et repo, der også indeholder en add-on.
