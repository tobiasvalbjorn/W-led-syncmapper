# Changelog

## 0.9.1

- Sliders can be dragged smoothly again: views no longer redraw while you drag (the hub's echo of each change used to replace the slider under your finger).
- New colour picker: brightness down to black, R/G/B sliders, hex field, presets incl. black and white, and your own saved colours (stored in the hub).
- Effects open on "Across the grid" (the effects that run as one across all lamps), with a hint when picking a WLED built-in effect, which runs on each light string by itself.
- Copy or move a part / whole lamp to another grid, and duplicate a grid.

## 0.9.0

- **Effect Studio** (new tab): build your own effects from stacked layers – lines, gradient, rings, wave, sparkle, solid colour – with colours, count, thickness, softness, direction, speed, bounce, opacity and blend. Preview live on a room's lights and save; saved effects appear in every room under "My effects" and in Home Assistant as "Custom: <name>".
- **Paint**: paint colours onto the LEDs in the grid editor (brush, eraser, fill, clear), live on the lights, and save as a scene ("Scene: <name>" in Home Assistant). Scenes light only mapped LEDs.
- **Several grids**: one grid per area (front of the house, the back, TV wall, kids' room …), each with its own canvas, background and mapping. Hub effects span each grid on its own. Your existing mapping becomes the first grid.
- **Effect overlay** in the grid editor: a room's running hub effect drawn behind the lamps, so they can be placed and spaced to match how the effect moves.
- **Live preview** ("now playing") at the top of every room/group sheet.

## 0.8.0

- Hub effects span the mapped LEDs – from the outermost lit LED on one side of the house to the other – instead of the whole canvas, so an effect runs across every device. Rooms running the same effect stay in line with each other.
- "Effect spans: Whole house / This room only" per room for hub effects.
- New hub effect "Line sweep": a line that sweeps across the whole house, with direction and width.
- Effect tabs renamed to "Across the grid (hub)" and "Per device (WLED built-in)", with a clearer explanation of the difference.

## 0.7.1

- Much less lag while mapping on a slow connection (e.g. through Home Assistant on a phone): highlight requests no longer queue up – only the newest cursor position is sent.
- The live connection only ever holds the newest config and preview frame per client instead of a queue, previews run at 8 fps (20 in Peek) and are not rendered at all when nobody has the grid open.
- The background image is no longer sent with every change; clients fetch it once.
- Tip: for the snappiest mapping, open the hub directly on your network at http://<home-assistant-ip>:8787.

## 0.7.0

- WLED's own effects follow the mapping too: when a room runs a WLED effect, the hub sets each mapped device's WLED segments so the mapped LED ranges run the effect and the gaps are switched off. Devices without a placement and 2D matrices are not changed; the setting "WLED effects follow the mapping" turns it off (the hub then restores one full segment).
- While mapping, the real strip is black with only the white cursor LED. "Strip guides" brings back the side colours, green first LED and amber corners.

## 0.6.0

- Strict mapping: only LEDs drawn on the grid take part in hub effects. Unmapped LEDs – and devices with no placement – stay dark (no more temporary line).
- Circle template has four points – N, E, S, W – joined by quarter arcs, labelled on the grid; the corner guide pins the LED at each compass point.
- "Stop mapping here" ends a shape at the cursor LED; the rest of the strip is left out of the mapping. In Draw LED by LED the finish button says the same.
- "Peek": watch the running effect live on the mapped LEDs (black background, glowing colours). Live preview raised to 20 fps.

## 0.5.1

- Draw LED by LED: the opposite arrow key removes the last LED of the current side (it never goes past the last corner; holding it stops there). Same arrow adds, Enter makes a corner, and the next arrow after a corner starts the new side.

## 0.5.0

- A point on a straight line between its neighbours is not a corner: the stretches on both sides count as one side (also across the start of a closed loop), e.g. LED 0 half-way up the side of a rectangle. Affects colour per side and side highlight.
- Box selection: drag on an empty spot to select points in several shapes (or a whole lamp) and drag them together. Esc deselects. Pan is now Shift / Space + drag, the middle mouse button, or a touch drag.
- "Pixel view": the canvas shows only the mapped pixels, white on black.
- Test pattern "All mapped white": every mapped LED on every device white, everything else off.

## 0.4.1

- Draw LED by LED: only Enter makes a corner. An arrow key in a new direction before Enter turns the current side instead.

## 0.4.0

- "Draw LED by LED": place LED 0 and build the shape with the arrow keys, one LED (or ten with Shift) at a time. The newest LED lights up on the real strip, changing direction or pressing Enter makes a corner, Backspace removes the last LED, and drawing stops by itself at the last LED.
- Highlight scope "Side": with highlight on, the stretch between two points under the mouse lights up on the real strip (next to "Part" and "Whole lamp").

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
