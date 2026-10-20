# Changelog

## 0.3.0

- Grid editor: undo / redo (Ctrl+Z, Ctrl+Y or Ctrl+Shift+Z, and buttons).
- Dragged points snap into line with the other points of the shape, so sides come out straight (hold Alt to drag freely).
- "Close loop" connects the last point to the first (and "Open loop" undoes it).
- Rectangle template can start on the left or right side (LED 0 part-way down a side).
- Pin any point to the LED under the cursor: click the point, move the cursor, press P.

## 0.2.0

- The whole app is in English.
- Grid editor: shape templates (rectangle/TV backlight, three sides, L, gable, circle, arc, line) with a corner guide; LED cursor with arrow keys that lights the LED on the real strip; bend points; curved segments; split a string into parts and name them; move, scale and rotate a part or a whole lamp; hover highlight; test patterns (colour per side, chase, rainbow, white); zoom and pan; PC layout with tools on the left.
- Only LEDs drawn on the grid take part in hub effects.
- All WLED settings per device (sync, realtime, nightlight, presets, segments, raw JSON).
- Rooms can be created, edited and deleted on the Devices tab.

## 0.1.0

- First version: rooms and groups, hub effects over DDP, WLED effects kept in sync with UDP sync, pixel grid editor, camera mapping, PWA, ingress, Supervisor and mDNS discovery.
