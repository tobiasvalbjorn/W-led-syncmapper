// Shape templates for the grid editor. Each returns the points in wiring
// order (LED 0 first). Closed shapes repeat the first point at the end.
// Anchors are filled in afterwards (evenly by length), and the user then pins
// the corners to the real LEDs with the arrow keys.

export const TEMPLATES = {
  rect: { name: "Rektangel (TV-backlight, vindue, dør)", closed: true },
  u_top: { name: "Tre sider – uden bund (TV på fod)", closed: false },
  u_bottom: { name: "Tre sider – uden top", closed: false },
  l: { name: "L-form (to sider)", closed: false },
  gable: { name: "Gavl / tag (^)", closed: false },
  circle: { name: "Cirkel / ring", closed: true },
  line: { name: "Lige linje", closed: false },
};

export const STARTS = [
  ["bottom-left", "Nederst venstre"], ["bottom-mid", "Midt på bunden"], ["bottom-right", "Nederst højre"],
  ["top-left", "Øverst venstre"], ["top-mid", "Midt på toppen"], ["top-right", "Øverst højre"],
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
        const n = 32, cx = x + w / 2, cy = y + h / 2, out = [];
        const a0 = start.startsWith("top") ? -Math.PI / 2 : Math.PI / 2;
        for (let i = 0; i <= n; i++) {
          const a = a0 + (clockwise ? 1 : -1) * (2 * Math.PI * i) / n;
          out.push([cx + (Math.cos(a) * w) / 2, cy + (Math.sin(a) * h) / 2]);
        }
        out[n] = out[0];
        return out;
      }
      default:
        return leftStart ? [[x, y + h / 2], [x + w, y + h / 2]] : [[x + w, y + h / 2], [x, y + h / 2]];
    }
  })();
  return pts.map(([px, py]) => [+px.toFixed(3), +py.toFixed(3)]);
}

// Which points the corner guide asks for. Circles have too many points to
// pin one by one, so only the start is fixed there.
export function cornerSteps(kind, points) {
  if (kind === "circle") return [];
  const closed = TEMPLATES[kind]?.closed;
  const out = [];
  for (let i = 1; i < points.length - (closed ? 1 : 0); i++) out.push(i);
  return out;
}
