"""DDP (Distributed Display Protocol) sender for WLED realtime streaming.

WLED always listens for DDP on UDP 4048. Header (10 bytes, big-endian):

    0  flags     0x40 = version 1, 0x01 = PUSH (render now)
    1  sequence  1..15 (0 = unused)
    2  type      0x0B = RGB 8-bit, 0x1B = RGBW 8-bit
    3  dest id   1 = default output
    4  offset    uint32, in *bytes* (channels), not pixels
    8  length    uint16, data bytes in this packet

Once WLED has seen a PUSH flag it only renders on PUSH packets, so the PUSH
flag goes on the last packet of every frame. That also means a frame split
over several packets appears atomically.
"""
from __future__ import annotations

import asyncio
import logging
import struct
from typing import Dict, Optional, Sequence, Tuple

_LOGGER = logging.getLogger(__name__)

DDP_PORT = 4048
FLAG_VER1 = 0x40
FLAG_PUSH = 0x01
TYPE_RGB24 = 0x0B
TYPE_RGBW32 = 0x1B
DEST_DISPLAY = 1
MAX_DATA = 1440  # 480 RGB / 360 RGBW pixels, same as WLED's own DDP sender

RGB = Tuple[int, int, int]


def build_packets(pixels: Sequence[RGB], seq: int, rgbw: bool = False) -> list:
    """Encode one frame as a list of DDP packets."""
    if rgbw:
        # Simple white extraction: the common part of R, G and B goes to W.
        data = bytearray()
        for r, g, b in pixels:
            w = min(r, g, b)
            data += bytes((r - w, g - w, b - w, w))
        dtype = TYPE_RGBW32
        chunk = MAX_DATA  # 1440 is divisible by 4
    else:
        data = bytearray()
        for r, g, b in pixels:
            data += bytes((r, g, b))
        dtype = TYPE_RGB24
        chunk = MAX_DATA  # divisible by 3

    packets = []
    total = len(data)
    for offset in range(0, total, chunk):
        part = data[offset : offset + chunk]
        last = offset + chunk >= total
        flags = FLAG_VER1 | (FLAG_PUSH if last else 0)
        header = struct.pack("!BBBBIH", flags, seq & 0x0F, dtype, DEST_DISPLAY, offset, len(part))
        packets.append(header + bytes(part))
    return packets


class _Protocol(asyncio.DatagramProtocol):
    def error_received(self, exc: Exception) -> None:  # pragma: no cover - network
        _LOGGER.debug("DDP socket error: %s", exc)


class DDPSender:
    """One UDP socket that streams frames to many WLED devices."""

    def __init__(self) -> None:
        self._transport: Optional[asyncio.DatagramTransport] = None
        self._seq: Dict[str, int] = {}

    async def start(self) -> None:
        loop = asyncio.get_running_loop()
        self._transport, _ = await loop.create_datagram_endpoint(_Protocol, local_addr=("0.0.0.0", 0))

    def close(self) -> None:
        if self._transport is not None:
            self._transport.close()
            self._transport = None

    def send(self, host: str, pixels: Sequence[RGB], rgbw: bool = False, port: int = DDP_PORT) -> None:
        if self._transport is None:
            return
        seq = self._seq.get(host, 0) % 15 + 1
        self._seq[host] = seq
        for packet in build_packets(pixels, seq, rgbw):
            self._transport.sendto(packet, (host, port))
