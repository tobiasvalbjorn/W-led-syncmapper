"""JSON file persistence with atomic writes and debounced saving."""
from __future__ import annotations

import asyncio
import json
import logging
import os
from pathlib import Path
from typing import Optional

from .models import HubConfig

_LOGGER = logging.getLogger(__name__)


class Store:
    def __init__(self, path: Path, save_delay: float = 1.0) -> None:
        self.path = path
        self.save_delay = save_delay
        self._pending: Optional[asyncio.TimerHandle] = None
        self.config = HubConfig()

    def load(self) -> HubConfig:
        if self.path.exists():
            try:
                self.config = HubConfig.from_dict(json.loads(self.path.read_text("utf-8")))
            except (ValueError, KeyError, TypeError) as err:
                backup = self.path.with_suffix(".broken.json")
                _LOGGER.error("Could not read %s (%s); moved to %s", self.path, err, backup)
                os.replace(self.path, backup)
                self.config = HubConfig()
        return self.config

    def save_now(self) -> None:
        self.path.parent.mkdir(parents=True, exist_ok=True)
        tmp = self.path.with_suffix(".tmp")
        tmp.write_text(json.dumps(self.config.to_dict(), indent=2), "utf-8")
        os.replace(tmp, self.path)

    def schedule_save(self) -> None:
        """Coalesce bursts of changes (sliders!) into one write."""
        loop = asyncio.get_running_loop()
        if self._pending is not None:
            self._pending.cancel()
        self._pending = loop.call_later(self.save_delay, self._flush)

    def _flush(self) -> None:
        self._pending = None
        try:
            self.save_now()
        except OSError as err:
            _LOGGER.error("Saving %s failed: %s", self.path, err)
