"""One light entity per hub target (room or group of rooms)."""
from __future__ import annotations

from typing import Any

from homeassistant.components.light import (
    ATTR_BRIGHTNESS,
    ATTR_EFFECT,
    ATTR_RGB_COLOR,
    ColorMode,
    LightEntity,
    LightEntityFeature,
)
from homeassistant.core import HomeAssistant, callback
from homeassistant.exceptions import HomeAssistantError
from homeassistant.helpers import entity_registry as er
from homeassistant.helpers.device_registry import DeviceInfo
from homeassistant.helpers.entity_platform import AddConfigEntryEntitiesCallback
from homeassistant.helpers.update_coordinator import CoordinatorEntity

from .api import HubError
from .const import DOMAIN, HUB_PREFIX
from .coordinator import WLEDHubConfigEntry, WLEDHubCoordinator

SOLID = "Solid"


async def async_setup_entry(
    hass: HomeAssistant, entry: WLEDHubConfigEntry, async_add_entities: AddConfigEntryEntitiesCallback
) -> None:
    coordinator = entry.runtime_data
    known: dict[str, WLEDHubLight] = {}

    @callback
    def sync_entities() -> None:
        targets = {t["id"]: t for t in coordinator.data.get("targets", [])}
        new = [WLEDHubLight(coordinator, tid) for tid in targets if tid not in known]
        for entity in new:
            known[entity.target_id] = entity
        if new:
            async_add_entities(new)
        # Groups come and go (Sonos-style): drop entities whose target is gone.
        registry = er.async_get(hass)
        for tid in [t for t in known if t not in targets]:
            entity = known.pop(tid)
            if entity.entity_id and registry.async_get(entity.entity_id):
                registry.async_remove(entity.entity_id)

    sync_entities()
    entry.async_on_unload(coordinator.async_add_listener(sync_entities))


class WLEDHubLight(CoordinatorEntity[WLEDHubCoordinator], LightEntity):
    _attr_has_entity_name = True
    _attr_name = None  # the device name is the room/group name
    _attr_supported_color_modes = {ColorMode.RGB}
    _attr_color_mode = ColorMode.RGB
    _attr_supported_features = LightEntityFeature.EFFECT

    def __init__(self, coordinator: WLEDHubCoordinator, target_id: str) -> None:
        super().__init__(coordinator)
        self.target_id = target_id
        hub_id = coordinator.data["hub"]["id"]
        self._attr_unique_id = f"{hub_id}_{target_id}"
        target = self._target or {}
        self._attr_device_info = DeviceInfo(
            identifiers={(DOMAIN, f"{hub_id}_{target_id}")},
            name=target.get("name", target_id),
            manufacturer="WLED Hub",
            model="Group" if target.get("kind") == "group" else "Room",
            via_device=(DOMAIN, hub_id),
            suggested_area=target.get("name") if target.get("kind") == "room" else None,
        )

    # ------------------------------------------------------------ helpers

    @property
    def _target(self) -> dict | None:
        return next((t for t in self.coordinator.data.get("targets", []) if t["id"] == self.target_id), None)

    @property
    def _state(self) -> dict | None:
        target = self._target
        if target is None:
            return None
        bucket = "groups" if target["kind"] == "group" else "rooms"
        return self.coordinator.data[bucket].get(self.target_id, {}).get("state")

    @property
    def available(self) -> bool:
        return super().available and self._target is not None

    # --------------------------------------------------------------- state

    @property
    def is_on(self) -> bool | None:
        state = self._state
        return None if state is None else state["on"]

    @property
    def brightness(self) -> int | None:
        state = self._state
        return None if state is None else max(1, state["brightness"])

    @property
    def rgb_color(self) -> tuple[int, int, int] | None:
        state = self._state
        return None if state is None else tuple(state["color"])  # type: ignore[return-value]

    @property
    def effect_list(self) -> list[str]:
        fx = self.coordinator.effects
        hub = [HUB_PREFIX + e["name"] for e in fx.get("hub", [])]
        wled = [e["name"] for e in fx.get("wled", [])]
        return hub + wled

    @property
    def effect(self) -> str | None:
        state = self._state
        if state is None:
            return None
        eff = state["effect"]
        fx = self.coordinator.effects
        if eff["source"] == "hub":
            match = next((e for e in fx.get("hub", []) if e["key"] == eff["id"]), None)
            return HUB_PREFIX + match["name"] if match else None
        match = next((e for e in fx.get("wled", []) if e["id"] == eff["id"]), None)
        return match["name"] if match else None

    @property
    def extra_state_attributes(self) -> dict[str, Any]:
        target = self._target or {}
        devices = self.coordinator.data.get("devices", {})
        return {
            "kind": target.get("kind"),
            "wled_devices": [devices[d]["name"] for d in target.get("device_ids", []) if d in devices],
            "effect_source": (self._state or {}).get("effect", {}).get("source"),
        }

    # ------------------------------------------------------------- control

    def _effect_ref(self, name: str) -> dict:
        fx = self.coordinator.effects
        if name.startswith(HUB_PREFIX):
            key = next((e["key"] for e in fx.get("hub", []) if HUB_PREFIX + e["name"] == name), None)
            if key:
                return {"source": "hub", "id": key}
        wled = next((e["id"] for e in fx.get("wled", []) if e["name"] == name), None)
        if wled is not None:
            return {"source": "wled", "id": wled}
        raise HomeAssistantError(f"Unknown effect: {name}")

    async def _send(self, changes: dict) -> None:
        try:
            await self.coordinator.client.set_state(self.target_id, changes)
        except HubError as err:
            raise HomeAssistantError(f"WLED Hub: {err}") from err
        # The hub pushes the new config over the WebSocket; no refresh needed.

    async def async_turn_on(self, **kwargs: Any) -> None:
        changes: dict[str, Any] = {"on": True}
        if ATTR_BRIGHTNESS in kwargs:
            changes["brightness"] = kwargs[ATTR_BRIGHTNESS]
        if ATTR_RGB_COLOR in kwargs:
            changes["color"] = list(kwargs[ATTR_RGB_COLOR])
            # Picking a colour without an effect means "solid colour", like WLED.
            if ATTR_EFFECT not in kwargs and (self._state or {}).get("effect", {}).get("source") == "hub":
                changes["effect"] = {"source": "wled", "id": 0}
        if ATTR_EFFECT in kwargs:
            changes["effect"] = self._effect_ref(kwargs[ATTR_EFFECT])
        await self._send(changes)

    async def async_turn_off(self, **kwargs: Any) -> None:
        await self._send({"on": False})
