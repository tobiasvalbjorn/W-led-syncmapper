"""Constants for the WLED Hub integration."""
from __future__ import annotations

DOMAIN = "wled_hub"
DEFAULT_PORT = 8787

CONF_TOKEN = "token"
CONF_HUB_ID = "hub_id"
CONF_SHOW_PANEL = "show_panel"

# Effect names in Home Assistant are prefixed so hub effects and WLED's own
# effects with similar names can't be confused.
HUB_PREFIX = "Hub: "
