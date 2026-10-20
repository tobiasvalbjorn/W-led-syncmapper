"""Unit tests for the parts of the hub that do not need a network."""
import struct
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent / "wled_hub"))

from wledhub import effects as fx  # noqa: E402
from wledhub.ddp import FLAG_PUSH, MAX_DATA, build_packets  # noqa: E402
from wledhub.mapping import device_pixel_map, placement_coords  # noqa: E402
from wledhub.models import Device, HubConfig, Layout, Placement  # noqa: E402
from wledhub.scanner import ScanSession  # noqa: E402


def test_ddp_single_packet_has_push():
    packets = build_packets([(1, 2, 3)] * 10, seq=3)
    assert len(packets) == 1
    flags, seq, dtype, dest, offset, length = struct.unpack("!BBBBIH", packets[0][:10])
    assert flags == 0x41 and seq == 3 and dtype == 0x0B and dest == 1
    assert offset == 0 and length == 30
    assert packets[0][10:13] == bytes((1, 2, 3))


def test_ddp_split_only_last_pushes():
    packets = build_packets([(9, 9, 9)] * 1000, seq=1)
    assert len(packets) == 3  # 480 + 480 + 40 pixels
    flags = [p[0] for p in packets]
    assert flags == [0x40, 0x40, 0x40 | FLAG_PUSH]
    offsets = [struct.unpack("!I", p[4:8])[0] for p in packets]
    assert offsets == [0, MAX_DATA, 2 * MAX_DATA]


def test_ddp_rgbw_extracts_white():
    packet = build_packets([(200, 100, 50)], seq=1, rgbw=True)[0]
    assert packet[2] == 0x1B
    assert tuple(packet[10:14]) == (150, 50, 0, 50)


def test_line_placement_spreads_evenly():
    p = Placement(id="p", device_id="d", count=5, points=[[0, 0], [4, 0]])
    assert placement_coords(p, 5) == [(0, 0), (1, 0), (2, 0), (3, 0), (4, 0)]


def test_polyline_around_corner():
    p = Placement(id="p", device_id="d", count=3, points=[[0, 0], [1, 0], [1, 1]])
    coords = placement_coords(p, 3)
    assert coords[1] == (1, 0)
    assert coords[2] == (1, 1)


def test_matrix_serpentine():
    p = Placement(id="p", device_id="d", shape="matrix", cols=3, rows=2, width=3, height=2)
    coords = placement_coords(p, 6)
    # row 0 left->right, row 1 right->left
    assert [c[0] for c in coords] == [0.5, 1.5, 2.5, 2.5, 1.5, 0.5]
    assert [c[1] for c in coords] == [0.5, 0.5, 0.5, 1.5, 1.5, 1.5]


def test_two_outputs_on_one_device():
    layout = Layout(width=10, height=10, placements=[
        Placement(id="a", device_id="d", start=0, count=2, points=[[0, 0], [10, 0]]),
        Placement(id="b", device_id="d", start=2, count=2, points=[[0, 10], [10, 10]]),
    ])
    pmap = device_pixel_map(Device(id="d", name="d", host="x", led_count=4), layout)
    assert pmap == [(0, 0), (1, 0), (0, 1), (1, 1)]


def test_unmapped_leds_get_fallback():
    pmap = device_pixel_map(Device(id="d", name="d", host="x", led_count=3), Layout())
    assert [x for x, _ in pmap] == [0, 0.5, 1]


def test_all_effects_render():
    coords = [(i / 9, (i % 3) / 2) for i in range(10)]
    opts = {"speed": 128, "intensity": 128, "color": [255, 0, 0], "color2": [0, 0, 255], "params": {}}
    for key in fx.REGISTRY:
        effect = fx.create(key)
        for t in (0.0, 0.5, 1.0):
            pixels = effect.render(coords, t, opts)
            assert len(pixels) == 10, key
            assert all(0 <= v <= 255 for px in pixels for v in px), key


def test_scan_codes_round_trip():
    devices = [Device(id="a", name="a", host="x", led_count=5), Device(id="b", name="b", host="y", led_count=6)]
    scan = ScanSession(devices)
    assert scan.total == 11 and scan.bits == 4
    decoded = [0] * 11
    for bit in range(scan.bits):
        scan.set_pattern("bit", bit)
        frames = scan.frames({d.id: d for d in devices})
        lit = frames["a"] + frames["b"]
        for i, px in enumerate(lit):
            if px[0] > 0:
                decoded[i] |= 1 << bit
    assert decoded == list(range(1, 12))


def test_config_round_trip():
    cfg = HubConfig.from_dict({
        "devices": {"d": {"id": "d", "name": "Stue", "host": "1.2.3.4", "led_count": 60, "room_id": "r"}},
        "rooms": {"r": {"id": "r", "name": "Stue", "state": {"on": True, "effect": {"source": "hub", "id": "plasma"}}}},
        "layout": {"placements": [{"id": "p", "device_id": "d", "points": [[0, 0], [1, 1]]}]},
    })
    again = HubConfig.from_dict(cfg.to_dict())
    assert again.to_dict() == cfg.to_dict()
    assert again.rooms["r"].state.effect.id == "plasma"
    assert "online" not in cfg.to_dict()["devices"]["d"]
