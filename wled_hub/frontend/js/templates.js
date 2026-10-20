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
  circle: { name: "Circle / ring (2 points, arcs)", closed: true },
  arc: { name: "Arc (e.g. arched window)", closed: false },
  line: { name: "Straight line", closed: false },
};

export const STARTS = [
  ["bottom-left", "Bottom left"], ["bottom-mid", "Bottom middle"], ["bottom-right", "Bottom right"],
  ["top-left", "Top left"], ["top-mid", "Top middle"], ["top-right", "Top right"],
];

// Rectangle corners clockwise on screen (y grows downwards): TL, TR, BR, BL.
function rectLoop(x, y, w, h, start, clockwise) {
  const TL = [x, y], TR = [x + w, y], BR = [x + w, y + h], BL = [x, y + h];
  const cw = [TL, TR, BR, BL];
  const mids = { "bottom-mid": [[x + w / 2, y + h], 3], "top-mid": [[x + w / 2, y], 0] };
  let ring = clockwise ? cw : [TL, BL, BR, TR];
  let first;
  if (mids[start]) {
    // A mid-side start sits between two corners; walk from there.
    const [pt] = mids[start];
    const after = start === "bottom-mid" ? (clockwise ? BL : BR) : (clockwise ? TR : TL);
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
        // Two points on opposite sides, joined by two half circles (bulge ±1).
        // Uses the width as diameter; LEDs are spread evenly around it.
        const cx = x + w / 2, cy = y + h / 2, r = w / 2;
        const top = [cx, cy - r], bottom = [cx, cy + r];
        const first = start.startsWith("top") ? top : bottom;
        const other = first === top ? bottom : top;
        bulges = clockwise ? [-1, -1] : [1, 1];
        return [first, other, first];
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
// not the closing point of a closed shape). For a circle that is just the
// opposite point.
export function cornerSteps(kind, points) {
  const closed = TEMPLATES[kind]?.closed;
  const out = [];
  for (let i = 1; i < points.length - (closed ? 1 : 0); i++) out.push(i);
  return out;
}
