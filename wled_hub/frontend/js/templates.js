// Shape templates for the grid editor. Each returns the points in wiring
// order (LED 0 first). Closed shapes repeat the first point at the end.
// Anchors are filled in afterwards (evenly by length), and the user then pins
// the corners to the real LEDs with the arrow keys.

export const TEMPLATES = {
  rect: { name: "Rectangle (TV backlight, window, door)", closed: true },
  u_top: { name: "Three sides – no bottom (TV on a stand)", closed: false },
  u_bottom: { name: "Three sides – no top", closed: false },
  l: { name: "L shape (two sides)", closed: false },
  gable: { name: "Gable / roof (^)", closed: false },
  circle: { name: "Circle / ring (N, E, S, W)", closed: true },
  arc: { name: "Arc (e.g. arched window)", closed: false },
  line: { name: "Straight line", closed: false },
};

export const STARTS = [
  ["bottom-left", "Bottom left"], ["bottom-mid", "Bottom middle"], ["bottom-right", "Bottom right"],
  ["top-left", "Top left"], ["top-mid", "Top middle"], ["top-right", "Top right"],
  ["left-mid", "Left side"], ["right-mid", "Right side"],
];

// Rectangle corners clockwise on screen (y grows downwards): TL, TR, BR, BL.
function rectLoop(x, y, w, h, start, clockwise) {
  const TL = [x, y], TR = [x + w, y], BR = [x + w, y + h], BL = [x, y + h];
  const cw = [TL, TR, BR, BL];
  // A start on a side sits between two corners: [point, first corner reached
  // going clockwise, first corner going anticlockwise]. Drag the start point
  // along the side afterwards if LED 0 is not in the middle.
  const mids = {
    "bottom-mid": [[x + w / 2, y + h], BL, BR],
    "top-mid": [[x + w / 2, y], TR, TL],
    "left-mid": [[x, y + h / 2], TL, BL],
    "right-mid": [[x + w, y + h / 2], BR, TR],
  };
  let ring = clockwise ? cw : [TL, BL, BR, TR];
  let first;
  if (mids[start]) {
    const [pt, cwNext, ccwNext] = mids[start];
    const after = clockwise ? cwNext : ccwNext;
    const i = ring.indexOf(after);
    ring = [...ring.slice(i), ...ring.slice(0, i)];
    first = pt;
    return [first, ...ring, first];
  }
  const corner = { "top-left": TL, "top-right": TR, "bottom-right": BR, "bottom-left": BL }[start] || BL;
  const i = ring.indexOf(corner);
  ring = [...ring.slice(i), ...ring.slice(0, i)];
  return [...ring, ring[0]];
}

export function buildTemplate(kind, { x, y, w, h, start = "bottom-left", clockwise = true }) {
  const leftStart = !start.endsWith("right");
  let bulges = [];
  const pts = (() => {
    switch (kind) {
      case "rect":
        return rectLoop(x, y, w, h, start, clockwise);
      case "u_top": // up the left, across the top, down the right (or mirrored)
        return leftStart ? [[x, y + h], [x, y], [x + w, y], [x + w, y + h]]
                         : [[x + w, y + h], [x + w, y], [x, y], [x, y + h]];
      case "u_bottom":
        return leftStart ? [[x, y], [x, y + h], [x + w, y + h], [x + w, y]]
                         : [[x + w, y], [x + w, y + h], [x, y + h], [x, y]];
      case "l":
        return leftStart ? [[x, y], [x, y + h], [x + w, y + h]] : [[x + w, y], [x + w, y + h], [x, y + h]];
      case "gable":
        return leftStart ? [[x, y + h], [x + w / 2, y], [x + w, y + h]] : [[x + w, y + h], [x + w / 2, y], [x, y + h]];
      case "circle": {
        // Four points – north, east, south, west – joined by quarter arcs
        // (bulge ±tan(22.5°)). The corner guide pins the LED at each compass
        // point. Uses the width as diameter.
        const cx = x + w / 2, cy = y + h / 2, r = w / 2;
        const N = [cx, cy - r], E = [cx + r, cy], S = [cx, cy + r], W = [cx - r, cy];
        const ring = clockwise ? [N, E, S, W] : [N, W, S, E]; // as seen on screen
        const first = start.startsWith("top") ? N : start === "left-mid" ? W : start === "right-mid" ? E : S;
        const i = ring.indexOf(first);
        const ordered = [...ring.slice(i), ...ring.slice(0, i)];
        const q = Math.tan(Math.PI / 8) * (clockwise ? -1 : 1);
        bulges = [q, q, q, q];
        return [...ordered, first];
      }
      case "arc": // a half circle over the opening, e.g. an arched window
        bulges = [leftStart ? -1 : 1];
        return leftStart ? [[x, y + h], [x + w, y + h]] : [[x + w, y + h], [x, y + h]];
      default:
        return leftStart ? [[x, y + h / 2], [x + w, y + h / 2]] : [[x + w, y + h / 2], [x, y + h / 2]];
    }
  })();
  return { points: pts.map(([px, py]) => [+px.toFixed(3), +py.toFixed(3)]), bulges };
}

// Which points the corner guide asks for (every point but the start, and
// not the closing point of a closed shape). For a circle: the other three
// compass points.
export function cornerSteps(kind, points) {
  const closed = TEMPLATES[kind]?.closed;
  const out = [];
  for (let i = 1; i < points.length - (closed ? 1 : 0); i++) out.push(i);
  return out;
}
