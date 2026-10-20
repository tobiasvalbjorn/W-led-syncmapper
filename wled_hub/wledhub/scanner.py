"""Camera mapping ("Twinkly-style"): find where every LED physically is.

The phone films the house while the hub lights binary patterns:

  * every LED in the scan gets a code = global index + 1 (0 is reserved
    for "no LED", so dark camera pixels never decode to a real LED)
  * for every bit k the hub shows the pattern "LEDs whose code has bit k set"
    and then its inverse
  * the phone compares each camera pixel between the pattern and its inverse:
    brighter in the pattern -> bit = 1. Pixels that barely change are not
    LEDs and are ignored.
  * pixels sharing a code are averaged into the centroid of that LED

So N LEDs need 2 * ceil(log2(N + 1)) frames instead of N. 2000 LEDs is 22
frames, about 10 seconds. All image processing runs in the browser; the hub
only lights patterns, and no images leave the phone.

Several strings on different outputs of one ESP32 are simply different
index ranges of the same device; they are scanned together.
"""
from __future__ import annotations

import math
from typing import Dict, List, Tuple

from .models import Device

RGB = Tuple[int, int, int]


class ScanSession:
    def __init__(self, devices: List[Device], level: int = 160) -> None:
        self.device_ids = [d.id for d in devices]
        self.ranges: List[dict] = []
        offset = 0
        for d in devices:
            self.ranges.append({"device_id": d.id, "offset": offset, "count": d.led_count})
            offset += d.led_count
        self.total = offset
        self.bits = max(1, math.ceil(math.log2(self.total + 1)))
        self.level = max(16, min(255, level))
        self.pattern: dict = {"kind": "black"}

    def describe(self) -> dict:
        return {
            "device_ids": self.device_ids,
            "ranges": self.ranges,
            "total": self.total,
            "bits": self.bits,
            "pattern": self.pattern,
        }

    def set_pattern(self, kind: str, bit: int = 0, inverse: bool = False, index: int = -1) -> None:
        if kind not in ("black", "all", "bit", "single"):
            raise ValueError(f"Unknown pattern {kind}")
        if kind == "bit" and not 0 <= bit < self.bits:
            raise ValueError(f"Bit {bit} out of range 0..{self.bits - 1}")
        self.pattern = {"kind": kind, "bit": bit, "inverse": inverse, "index": index}

    def _lit(self, code: int) -> bool:
        p = self.pattern
        kind = p["kind"]
        if kind == "all":
            return True
        if kind == "bit":
            return bool((code >> p["bit"]) & 1) != bool(p["inverse"])
        if kind == "single":
            return code - 1 == p["index"]
        return False

    def frames(self, devices: Dict[str, Device]) -> Dict[str, List[RGB]]:
        on: RGB = (self.level, self.level, self.level)
        off: RGB = (0, 0, 0)
        out: Dict[str, List[RGB]] = {}
        for r in self.ranges:
            if r["device_id"] not in devices:
                continue
            out[r["device_id"]] = [
                on if self._lit(r["offset"] + i + 1) else off for i in range(r["count"])
            ]
        return out
