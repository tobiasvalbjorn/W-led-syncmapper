"""WLED Hub integration: rooms and groups from the hub become light entities."""
from __future__ import annotations

import logging

from homeassistant.components import frontend
from homeassistant.const import CONF_HOST, CONF_PORT, Platform
from homeassistant.core import HomeAssistant
from homeassistant.exceptions import ConfigEntryNotReady
from homeassistant.helpers import device_registry as dr
from homeassistant.helpers.aiohttp_client import async_get_clientsession

from .api import HubClient, HubError
from .const import CONF_SHOW_PANEL, CONF_TOKEN, DOMAIN
from .coordinator import WLEDHubConfigEntry, WLEDHubCoordinator

_LOGGER = logging.getLogger(__name__)
PLATFORMS: list[Platform] = [Platform.LIGHT]
PANEL_URL = "wled-hub"


async def async_setup_entry(hass: HomeAssistant, entry: WLEDHubConfigEntry) -> bool:
    client = HubClient(
        async_get_clientsession(hass),
        entry.data[CONF_HOST],
        entry.data[CONF_PORT],
        entry.data.get(CONF_TOKEN),
    )
    try:
        await client.health()
    except HubError as err:
        raise ConfigEntryNotReady(f"Cannot reach WLED Hub at {client.base}: {err}") from err

    coordinator = WLEDHubCoordinator(hass, entry, client)
    await coordinator.async_config_entry_first_refresh()

    # The hub itself is a device; every room/group light hangs off it (via_device).
    hub = coordinator.data["hub"]
    dr.async_get(hass).async_get_or_create(
        config_entry_id=entry.entry_id,
        identifiers={(DOMAIN, hub["id"])},
        name="WLED Hub",
        manufacturer="WLED Hub",
        model="Sync hub",
        sw_version=hub["version"],
        configuration_url=f"http://{client.host}:{client.port}/",
    )
    entry.runtime_data = coordinator
    coordinator.start_push()

    await hass.config_entries.async_forward_entry_setups(entry, PLATFORMS)

    if entry.options.get(CONF_SHOW_PANEL, False):
        # An iframe panel for hubs that do not run as an add-on (an add-on
        # already gets a sidebar panel through ingress). Note: an http:// hub
        # cannot be framed when Home Assistant itself is served over https.
        frontend.async_register_built_in_panel(
            hass,
            "iframe",
            sidebar_title="WLED Hub",
            sidebar_icon="mdi:led-strip-variant",
            frontend_url_path=PANEL_URL,
            config={"url": f"http://{client.host}:{client.port}/"},
            require_admin=False,
            update=True,
        )
    entry.async_on_unload(entry.add_update_listener(_async_reload))
    return True


async def _async_reload(hass: HomeAssistant, entry: WLEDHubConfigEntry) -> None:
    await hass.config_entries.async_reload(entry.entry_id)


async def async_unload_entry(hass: HomeAssistant, entry: WLEDHubConfigEntry) -> bool:
    if entry.options.get(CONF_SHOW_PANEL, False):
        frontend.async_remove_panel(hass, PANEL_URL, warn_if_unknown=False)
    return await hass.config_entries.async_unload_platforms(entry, PLATFORMS)
