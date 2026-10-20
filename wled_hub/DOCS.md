# WLED Hub

Styrer og synkroniserer alle dine WLED-enheder som rum og grupper (Sonos-stil), med et fælles pixel-grid og kamera-mapping.

## Kom i gang

1. Start add-on'en og åbn **WLED Hub** i sidebaren.
2. Under **Enheder** vises de WLED-enheder, der er fundet på netværket. Tryk *Tilføj*.
3. Opret rum med **+** under **Rum**, og flyt enhederne ind i dem.
4. Placér lyskæderne under **Grid**, enten manuelt eller med kamera-ikonet.
5. Installer integrationen **WLED Hub** (HACS) for at få rum og grupper som lys-entiteter.

## Indstillinger

| Indstilling | Betydning |
|---|---|
| `port` | Port til appen på LAN, standard 8787. Ingress virker altid. |
| `api_token` | Valgfri. Kræves på LAN-porten, når den er sat. |
| `ssl` / `certfile` / `keyfile` | HTTPS på LAN-porten (filer i `/ssl`). Kameraet kræver HTTPS. |
| `log_level` | debug, info, warning eller error |

Add-on'en bruger host-netværket, så den kan finde WLED via mDNS og streame DDP (UDP 4048) til enhederne.
