"""Keeps Home Assistant in sync with the hub via its WebSocket (push)."""
from __future__ import annotations

import asyncio
import logging
from datetime import timedelta

from homeassistant.config_entries import ConfigEntry
from homeassistant.core import HomeAssistant
from homeassistant.helpers.update_coordinator import DataUpdateCoordinator, UpdateFailed

from .api import HubAuthError, HubClient, HubError
from .const import DOMAIN

_LOGGER = logging.getLogger(__name__)

WLEDHubConfigEntry = ConfigEntry["WLEDHubCoordinator"]


class WLEDHubCoordinator(DataUpdateCoordinator[dict]):
    """Data = the hub's /api/config snapshot (devices, rooms, groups, targets)."""

    config_entry: WLEDHubConfigEntry

    def __init__(self, hass: HomeAssistant, entry: WLEDHubConfigEntry, client: HubClient) -> None:
        super().__init__(
            hass,
            _LOGGER,
            config_entry=entry,
            name=DOMAIN,
            # Pushes arrive over the WebSocket; polling is only a safety net.
            update_interval=timedelta(minutes=5),
        )
        self.client = client
        self.effects: dict = {"hub": [], "wled": [], "palettes": []}
        self._stop = asyncio.Event()
        self._listener: asyncio.Task | None = None

    async def _async_update_data(self) -> dict:
        try:
            data = await self.client.config()
            if not self.effects["hub"] or not self.effects["wled"]:
                self.effects = await self.client.effects()
            return data
        except HubAuthError as err:
            from homeassistant.exceptions import ConfigEntryAuthFailed

            raise ConfigEntryAuthFailed(str(err)) from err
        except HubError as err:
            raise UpdateFailed(f"WLED Hub unreachable: {err}") from err

    def start_push(self) -> None:
        self._listener = self.config_entry.async_create_background_task(
            self.hass,
            self.client.listen(self._on_push, self._on_disconnect, self._stop),
            name=f"{DOMAIN} websocket",
        )

    async def async_shutdown(self) -> None:
        self._stop.set()
        if self._listener is not None:
            self._listener.cancel()
        await super().async_shutdown()

    def _on_push(self, data: dict) -> None:
        self.async_set_updated_data(data)

    def _on_disconnect(self, err: Exception) -> None:
        if self.last_update_success:
            self.async_set_update_error(err)
