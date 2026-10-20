"""Config flow: manual, zeroconf (_wledhub._tcp) and Supervisor add-on discovery."""
from __future__ import annotations

import logging
from typing import Any

import voluptuous as vol
from homeassistant.config_entries import ConfigEntry, ConfigFlow, ConfigFlowResult, OptionsFlow
from homeassistant.const import CONF_HOST, CONF_PORT
from homeassistant.core import callback
from homeassistant.helpers.aiohttp_client import async_get_clientsession
from homeassistant.helpers.service_info.hassio import HassioServiceInfo
from homeassistant.helpers.service_info.zeroconf import ZeroconfServiceInfo

from .api import HubAuthError, HubClient, HubError
from .const import CONF_HUB_ID, CONF_SHOW_PANEL, CONF_TOKEN, DEFAULT_PORT, DOMAIN

_LOGGER = logging.getLogger(__name__)


class WLEDHubConfigFlow(ConfigFlow, domain=DOMAIN):
    VERSION = 1

    def __init__(self) -> None:
        self._host: str | None = None
        self._port: int = DEFAULT_PORT
        self._hub_id: str | None = None
        self._from_addon = False

    async def _probe(self, host: str, port: int, token: str | None) -> dict:
        client = HubClient(async_get_clientsession(self.hass), host, port, token)
        health = await client.health()
        await client.config()  # checks the token too
        return health

    def _entry(self, token: str | None) -> ConfigFlowResult:
        return self.async_create_entry(
            title="WLED Hub",
            data={CONF_HOST: self._host, CONF_PORT: self._port, CONF_TOKEN: token or "",
                  CONF_HUB_ID: self._hub_id},
            # The add-on already shows the UI via ingress, so no extra panel then.
            options={CONF_SHOW_PANEL: False},
        )

    # ------------------------------------------------------------ manual

    async def async_step_user(self, user_input: dict[str, Any] | None = None) -> ConfigFlowResult:
        errors: dict[str, str] = {}
        if user_input is not None:
            self._host = user_input[CONF_HOST].strip()
            self._port = user_input[CONF_PORT]
            token = user_input.get(CONF_TOKEN) or None
            try:
                health = await self._probe(self._host, self._port, token)
            except HubAuthError:
                errors["base"] = "invalid_auth"
            except HubError:
                errors["base"] = "cannot_connect"
            else:
                self._hub_id = health["id"]
                await self.async_set_unique_id(self._hub_id)
                self._abort_if_unique_id_configured(updates={CONF_HOST: self._host, CONF_PORT: self._port})
                return self._entry(token)

        schema = vol.Schema({
            vol.Required(CONF_HOST, default=self._host or ""): str,
            vol.Required(CONF_PORT, default=self._port): int,
            vol.Optional(CONF_TOKEN, default=""): str,
        })
        return self.async_show_form(step_id="user", data_schema=schema, errors=errors)

    # ---------------------------------------------------------- zeroconf

    async def async_step_zeroconf(self, discovery_info: ZeroconfServiceInfo) -> ConfigFlowResult:
        hub_id = discovery_info.properties.get("id")
        if not hub_id:
            return self.async_abort(reason="not_wled_hub")
        self._host = str(discovery_info.ip_address)
        self._port = discovery_info.port or DEFAULT_PORT
        self._hub_id = hub_id
        await self.async_set_unique_id(hub_id)
        self._abort_if_unique_id_configured(updates={CONF_HOST: self._host, CONF_PORT: self._port})
        self.context["title_placeholders"] = {"host": self._host}
        return await self.async_step_confirm()

    # ------------------------------------------------- Supervisor add-on

    async def async_step_hassio(self, discovery_info: HassioServiceInfo) -> ConfigFlowResult:
        cfg = discovery_info.config
        self._host = cfg["host"]
        self._port = int(cfg.get("port", DEFAULT_PORT))
        self._hub_id = cfg.get("id")
        self._from_addon = True
        if self._hub_id:
            await self.async_set_unique_id(self._hub_id)
            self._abort_if_unique_id_configured(updates={CONF_HOST: self._host, CONF_PORT: self._port})
        self.context["title_placeholders"] = {"host": "Home Assistant add-on"}
        return await self.async_step_confirm()

    async def async_step_confirm(self, user_input: dict[str, Any] | None = None) -> ConfigFlowResult:
        errors: dict[str, str] = {}
        if user_input is not None:
            token = user_input.get(CONF_TOKEN) or None
            try:
                await self._probe(self._host, self._port, token)  # type: ignore[arg-type]
            except HubAuthError:
                errors["base"] = "invalid_auth"
            except HubError:
                errors["base"] = "cannot_connect"
            else:
                return self._entry(token)
        return self.async_show_form(
            step_id="confirm",
            data_schema=vol.Schema({vol.Optional(CONF_TOKEN, default=""): str}),
            description_placeholders={"host": f"{self._host}:{self._port}"},
            errors=errors,
        )

    @staticmethod
    @callback
    def async_get_options_flow(config_entry: ConfigEntry) -> OptionsFlow:
        return WLEDHubOptionsFlow()


class WLEDHubOptionsFlow(OptionsFlow):
    async def async_step_init(self, user_input: dict[str, Any] | None = None) -> ConfigFlowResult:
        if user_input is not None:
            return self.async_create_entry(data=user_input)
        return self.async_show_form(
            step_id="init",
            data_schema=vol.Schema({
                vol.Required(CONF_SHOW_PANEL, default=self.config_entry.options.get(CONF_SHOW_PANEL, False)): bool,
            }),
        )
