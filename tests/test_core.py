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


def test_unplaced_device_stays_dark():
    pmap = device_pixel_map(Device(id="d", name="d", host="x", led_count=3), Layout())
    assert pmap == [None, None, None]


def test_only_mapped_leds_take_part_once_placed():
    layout = Layout(width=10, height=10, placements=[
        Placement(id="a", device_id="d", start=1, count=2, points=[[0, 0], [10, 0]]),
    ])
    pmap = device_pixel_map(Device(id="d", name="d", host="x", led_count=5), layout)
    assert pmap == [None, (0, 0), (1, 0), None, None]


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


def test_anchored_rectangle_pins_corners_to_leds():
    # TV backlight: 10 LEDs bottom-left -> up the left side (2), top (4), right (2), bottom (2)
    pts = [[0, 4], [0, 0], [8, 0], [8, 4], [0, 4]]
    p = Placement(id="p", device_id="d", count=10, points=pts, anchors=[0, 2, 6, 8, 10])
    coords = placement_coords(p, 10)
    assert coords[0] == (0, 4)
    assert coords[2] == (0, 0)  # LED 2 sits exactly in the top-left corner
    assert coords[6] == (8, 0)
    assert coords[8] == (8, 4)
    assert coords[1] == (0, 2)
    assert coords[9] == (4, 4)  # last LED half-way back along the bottom


def test_invalid_anchors_fall_back_to_even_spacing():
    p = Placement(id="p", device_id="d", count=5, points=[[0, 0], [4, 0]], anchors=[0, 9, 2])
    assert placement_coords(p, 5) == [(0, 0), (1, 0), (2, 0), (3, 0), (4, 0)]


def test_highlight_frame():
    from wledhub.hub import Hub

    class FakeStore:
        config = HubConfig.from_dict({"devices": {"d": {"id": "d", "name": "TV", "host": "x", "led_count": 8}}})

    hub = Hub(FakeStore(), "hub", "0")
    hub.highlights["d"] = {"index": 3, "start": 2, "count": 4, "marks": [4], "until": float("inf")}
    frame = hub._highlight_frames()["d"]
    assert frame[3] == (255, 255, 255)
    assert frame[2] == (0, 70, 0)
    assert frame[4] == (120, 50, 0)
    assert frame[5] == (0, 0, 24)
    assert frame[0] == (0, 0, 0) and frame[7] == (0, 0, 0)


def test_highlight_ranges_light_whole_parts():
    from wledhub.hub import Hub

    class FakeStore:
        config = HubConfig.from_dict({"devices": {"d": {"id": "d", "name": "Lampe", "host": "x", "led_count": 6}}})

    hub = Hub(FakeStore(), "hub", "0")
    hub.highlights["d"] = {"index": -1, "start": 0, "count": 6, "marks": [],
                           "ranges": [(1, 2, (200, 0, 0)), (4, 1, (0, 200, 0))], "until": float("inf")}
    frame = hub._highlight_frames()["d"]
    assert [max(px) > 0 for px in frame] == [False, True, True, False, True, False]
    assert frame[1] == (200, 0, 0) and frame[4] == (0, 200, 0)


def test_chase_and_rainbow_patterns():
    from wledhub.hub import _paint_range

    frame = [(0, 0, 0)] * 20
    _paint_range(frame, 2, 16, (255, 0, 0), "chase", 0.2)  # head at LED 5 of the range
    assert frame[0] == (0, 0, 0) and frame[19] == (0, 0, 0)
    assert max(frame[2:18])[0] == 255 and frame[2 + 5] == (255, 0, 0)
    frame = [(0, 0, 0)] * 10
    _paint_range(frame, 0, 10, (0, 0, 0), "rainbow", 0.0)
    assert len(set(frame)) > 5


def test_circle_from_two_points_with_arcs():
    import math

    # full circle of radius 1 around (0, 0): bottom point -> top point -> back, two half circles
    p = Placement(id="c", device_id="d", count=8, points=[[0, 1], [0, -1], [0, 1]], bulges=[1, 1])
    coords = placement_coords(p, 8)
    for x, y in coords:
        assert abs(math.hypot(x, y) - 1) < 1e-9
    # evenly spread: neighbours are all 45 degrees apart (8 LEDs on a closed loop
    # end one step before the start, so use anchors to make it a true loop)
    p.anchors = [0, 4, 8]
    coords = placement_coords(p, 8)
    gaps = [math.hypot(coords[i + 1][0] - coords[i][0], coords[i + 1][1] - coords[i][1]) for i in range(7)]
    assert max(gaps) - min(gaps) < 1e-9
    assert coords[4] == (0, -1) or (abs(coords[4][0]) < 1e-9 and abs(coords[4][1] + 1) < 1e-9)


def test_straight_segment_unchanged_with_zero_bulge():
    p = Placement(id="p", device_id="d", count=5, points=[[0, 0], [4, 0]], bulges=[0])
    assert placement_coords(p, 5) == [(0, 0), (1, 0), (2, 0), (3, 0), (4, 0)]
