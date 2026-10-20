# WLED Hub

En central hub, der styrer og synkroniserer alle dine [WLED](https://kno.wled.ge)-enheder rundt om huset:

- **Rum og grupper som i Sonos**: træk et rum oven på et andet for at låse dem sammen, fx "Hele huset".
- **Fælles pixel-grid**: alle lyskæder placeres på ét kort over huset, og hub-effekter flyder på tværs af enhederne.
- **Kamera-mapping som i Twinkly**: stil dig foran huset, og telefonen finder selv, hvor hver LED sidder.
- **Home Assistant**: hvert rum og hver gruppe bliver en `light`-entitet med lysstyrke, farve og effekter. Hub'en findes automatisk, og hele appen ligger i sidebaren.
- **App på telefonen**: en PWA, der installeres fra browseren. Den virker også i enhver browser på dit lokale net.

Se [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) for arkitektur, datamodel og synkronisering.

## Indhold

| Mappe | Hvad |
|---|---|
| `wled_hub/` | Home Assistant add-on (app): hub'en i Python/aiohttp + web-appen |
| `wled_hub/wledhub/` | Hub-kode: engine, effekter, DDP, WLED-klient, mDNS, API |
| `wled_hub/frontend/` | PWA (ES-moduler uden build-trin) |
| `custom_components/wled_hub/` | Home Assistant-integration (HACS) |
| `tools/` | `fake_wled.py` (simuleret WLED-enhed) og ikon-generator |
| `tests/` | Unit-tests (`pytest`) |

## Installation i Home Assistant

1. **Add-on (hub'en)**: Indstillinger → Add-ons (Apps) → Butik → ⋮ → Repositories → tilføj `https://github.com/OWNER/REPO`. Installer **WLED Hub**, slå "Vis i sidebar" til, og start den.
2. **Integration**: HACS → ⋮ → Custom repositories → `https://github.com/OWNER/REPO`, kategori *Integration*. Installer **WLED Hub** og genstart Home Assistant. Hub'en dukker derefter op under *Indstillinger → Enheder og tjenester* som "Fundet".
3. Åbn **WLED Hub** i sidebaren. Tilføj de fundne WLED-enheder under *Enheder*, opret rum, og placér lyskæderne under *Grid*.

Hvert rum og hver gruppe bliver til `light.<navn>`. Effektlisten indeholder både hub-effekter (præfiks `Hub:`) og WLED's egne effekter, så de kan bruges i automationer:

```yaml
action: light.turn_on
target:
  entity_id: light.hele_huset
data:
  effect: "Hub: Regnbuebølge"
  brightness: 180
```

## Telefon-app (PWA) og lokalt net

- **Via Home Assistant-appen**: WLED Hub ligger i sidebaren.
- **Direkte på LAN**: åbn `http://<home-assistant-ip>:8787` og vælg *Føj til hjemmeskærm* (iOS) eller *Installer app* (Android).
- **Kamera-mapping kræver HTTPS**, fordi browsere kun giver kameraadgang på sikre forbindelser. Brug appen via Home Assistant med HTTPS (fx Nabu Casa), eller slå `ssl` til i add-on'ens indstillinger med certifikater i `/ssl`.
- **Adgangskontrol**: LAN-porten er som standard åben for alle på netværket. Sæt `api_token` i add-on'en, hvis du har gæste-WiFi på samme net, og åbn appen én gang med `?token=<token>`.

## Udvikling uden hardware

```bash
python -m venv .venv
```

```bash
.venv/Scripts/pip install aiohttp zeroconf pytest
```

Start to falske WLED-enheder og hub'en i hver sin terminal:

```bash
.venv/Scripts/python tools/fake_wled.py --ip 127.0.0.2 --leds 150 --outputs 2 --name Stue
```

```bash
.venv/Scripts/python tools/fake_wled.py --ip 127.0.0.3 --leds 256 --matrix 16x16 --name Terrasse
```

```bash
cd wled_hub && ../.venv/Scripts/python -m wledhub --data ../.devdata --port 8787
```

Åbn derefter <http://127.0.0.1:8787>. Tests køres med `pytest tests`.

## Status

Version 0.1.0 er et første, fungerende udkast. Hub, web-app og kamera-afkodning er testet mod simulerede enheder. Home Assistant-integrationen og add-on-image'et er **endnu ikke kørt i en rigtig Home Assistant**. Se listen "Ikke verificeret" i [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md).

## Licens

MIT. Se [LICENSE](LICENSE). WLED er et selvstændigt open source-projekt (MIT) og har ikke noget med dette projekt at gøre.
