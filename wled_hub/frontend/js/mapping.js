// JS mirror of wledhub/mapping.py – keep the two in sync (tests cover the Python side).

// --- segments: straight, or a circular arc given by a "bulge" -------------
// bulge = tan(sweep / 4): 0 = straight, 1 = half circle, ~0.414 = quarter.
// Positive bulges curve to the left of the direction of travel. A full circle
// is two points with bulges [1, 1].

function arc(a, b, bulge) {
  if (!bulge || Math.abs(bulge) < 1e-6) return null;
  const dx = b[0] - a[0], dy = b[1] - a[1], c = Math.hypot(dx, dy);
  if (!c) return null;
  const nx = -dy / c, ny = dx / c; // left normal
  const s = (bulge * c) / 2; // signed sagitta
  const r = (c * c / 4 + s * s) / (2 * Math.abs(s));
  const mx = (a[0] + b[0]) / 2, my = (a[1] + b[1]) / 2;
  const off = s - Math.sign(s) * r;
  const cx = mx + nx * off, cy = my + ny * off;
  const a0 = Math.atan2(a[1] - cy, a[0] - cx);
  const amid = Math.atan2(my + ny * s - cy, mx + nx * s - cx); // arc midpoint
  const half = ((((amid - a0 + Math.PI) % (2 * Math.PI)) + 2 * Math.PI) % (2 * Math.PI)) - Math.PI;
  return { cx, cy, r, a0, sweep: 2 * half };
}

export function segLength(a, b, bulge = 0) {
  const g = arc(a, b, bulge);
  return g ? g.r * Math.abs(g.sweep) : Math.hypot(b[0] - a[0], b[1] - a[1]);
}

export function segPoint(a, b, bulge, t) {
  const g = arc(a, b, bulge);
  if (!g) return [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t];
  const ang = g.a0 + g.sweep * t;
  return [g.cx + g.r * Math.cos(ang), g.cy + g.r * Math.sin(ang)];
}

const bulgeAt = (bulges, k) => (bulges && k < bulges.length ? Number(bulges[k]) || 0 : 0);

function polyline(points, count, bulges) {
  if (count <= 0) return [];
  if (!points.length) return Array(count).fill([0, 0]);
  if (points.length === 1 || count === 1) return Array(count).fill([points[0][0], points[0][1]]);
  const segs = [];
  let total = 0;
  for (let i = 0; i < points.length - 1; i++) {
    const a = points[i], b = points[i + 1], bu = bulgeAt(bulges, i), len = segLength(a, b, bu);
    segs.push([a, b, len, bu]);
    total += len;
  }
  if (!total) return Array(count).fill([points[0][0], points[0][1]]);
  const out = [];
  let si = 0, segStart = 0;
  for (let i = 0; i < count; i++) {
    const dist = (total * i) / (count - 1);
    while (si < segs.length - 1 && dist > segStart + segs[si][2]) { segStart += segs[si][2]; si++; }
    const [a, b, len, bu] = segs[si];
    const t = len ? Math.min(1, Math.max(0, (dist - segStart) / len)) : 0;
    out.push(segPoint(a, b, bu, t));
  }
  return out;
}

function anchored(points, anchors, count, bulges) {
  const last = points.length - 1, out = [];
  for (let i = 0; i < count; i++) {
    if (i <= anchors[0]) { out.push([points[0][0], points[0][1]]); continue; }
    if (i >= anchors[last]) { out.push([points[last][0], points[last][1]]); continue; }
    let j = 0;
    while (j < last - 1 && anchors[j + 1] <= i) j++;
    const span = anchors[j + 1] - anchors[j];
    const t = span > 0 ? (i - anchors[j]) / span : 0;
    out.push(segPoint(points[j], points[j + 1], bulgeAt(bulges, j), t));
  }
  return out;
}

export function anchorsValid(p) {
  const a = p.anchors || [];
  return (p.points || []).length >= 2 && a.length === p.points.length && a.every((v, i) => !i || v >= a[i - 1]);
}

export function isClosed(points) {
  if (points.length < 3) return false;
  const a = points[0], b = points[points.length - 1];
  return Math.hypot(a[0] - b[0], a[1] - b[1]) < 1e-6;
}

// Anchors that reproduce "evenly by length" – the starting point before the
// user pins corners to real LEDs. Closed shapes end at `count` (just before
// the first point again), open ones at the last LED.
export function anchorsFromLengths(points, count, bulges = []) {
  const lens = [0];
  for (let i = 1; i < points.length; i++) {
    lens.push(lens[i - 1] + segLength(points[i - 1], points[i], bulgeAt(bulges, i - 1)));
  }
  const total = lens[lens.length - 1] || 1;
  const end = isClosed(points) ? count : Math.max(0, count - 1);
  const anchors = lens.map((l) => Math.round((l / total) * end));
  for (let i = 1; i < anchors.length; i++) anchors[i] = Math.max(anchors[i], anchors[i - 1]);
  return anchors;
}

export function ledCount(p, deviceLeds) {
  return p.count || Math.max(0, deviceLeds - (p.start || 0));
}

function matrix(p, count) {
  const cols = p.cols || 1, rows = p.rows || Math.max(1, Math.ceil(count / cols));
  const flipX = p.origin?.endsWith("right"), flipY = p.origin?.startsWith("bottom");
  const out = [];
  for (let i = 0; i < count; i++) {
    let col, row;
    if (p.vertical) {
      const major = Math.floor(i / rows); let minor = i % rows;
      if (p.serpentine && major % 2) minor = rows - 1 - minor;
      col = major; row = minor;
    } else {
      const major = Math.floor(i / cols); let minor = i % cols;
      if (p.serpentine && major % 2) minor = cols - 1 - minor;
      col = minor; row = major;
    }
    if (flipX) col = cols - 1 - col;
    if (flipY) row = rows - 1 - row;
    out.push([p.x + ((col + 0.5) * p.width) / cols, p.y + ((row + 0.5) * p.height) / rows]);
  }
  return out;
}

export function placementCoords(p, deviceLeds) {
  const count = p.count || Math.max(0, deviceLeds - (p.start || 0));
  let coords;
  if (p.shape === "matrix") coords = matrix(p, count);
  else if (p.shape === "points") {
    coords = p.points.slice(0, count).map((pt) => [pt[0], pt[1]]);
    while (coords.length < count) coords.push(coords[coords.length - 1] || [0, 0]);
  } else if (anchorsValid(p)) coords = anchored(p.points, p.anchors, count, p.bulges);
  else coords = polyline(p.points || [], count, p.bulges);
  if (p.reverse) coords.reverse();
  return coords;
}

// LED ranges between consecutive corner points, as [first, count] relative to
// the placement (wiring order). Only for line shapes with few points – a
// shape drawn with many points would just give a rainbow of tiny stretches.
export const MAX_COLOURED_SEGMENTS = 12;
export function cornerSegments(p, count) {
  if (p.shape !== "line" || (p.points || []).length < 2 || p.points.length - 1 > MAX_COLOURED_SEGMENTS) return null;
  const anchors = anchorsValid(p) ? p.anchors : anchorsFromLengths(p.points, count, p.bulges);
  const out = [];
  for (let j = 0; j < anchors.length - 1; j++) {
    const a = Math.max(0, anchors[j]), b = Math.min(count, j === anchors.length - 2 ? Math.max(anchors[j + 1], count) : anchors[j + 1]);
    if (b > a) out.push([a, b - a]);
  }
  return out.length ? out : null;
}

export function newPlacement(deviceId, layout, extra = {}) {
  const y = layout.height * (0.2 + Math.random() * 0.6);
  return {
    id: `pl_${Math.random().toString(16).slice(2, 10)}`,
    device_id: deviceId, start: 0, count: 0, shape: "line",
    points: [[layout.width * 0.1, y], [layout.width * 0.9, y]],
    anchors: [], bulges: [], reverse: false, x: layout.width * 0.3, y: layout.height * 0.3, width: layout.width * 0.2,
    height: layout.height * 0.3, cols: 0, rows: 0, serpentine: true, origin: "top-left", vertical: false, z: 0,
    ...extra,
  };
}
