// JS mirror of wledhub/mapping.py – keep the two in sync (tests cover the Python side).

function polyline(points, count) {
  if (count <= 0) return [];
  if (!points.length) return Array(count).fill([0, 0]);
  if (points.length === 1 || count === 1) return Array(count).fill([points[0][0], points[0][1]]);
  const segs = [];
  let total = 0;
  for (let i = 0; i < points.length - 1; i++) {
    const a = points[i], b = points[i + 1], len = Math.hypot(b[0] - a[0], b[1] - a[1]);
    segs.push([a, b, len]);
    total += len;
  }
  if (!total) return Array(count).fill([points[0][0], points[0][1]]);
  const out = [];
  let si = 0, segStart = 0;
  for (let i = 0; i < count; i++) {
    const dist = (total * i) / (count - 1);
    while (si < segs.length - 1 && dist > segStart + segs[si][2]) { segStart += segs[si][2]; si++; }
    const [a, b, len] = segs[si];
    const t = len ? Math.min(1, Math.max(0, (dist - segStart) / len)) : 0;
    out.push([a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t]);
  }
  return out;
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
  } else coords = polyline(p.points || [], count);
  if (p.reverse) coords.reverse();
  return coords;
}

export function newPlacement(deviceId, layout, extra = {}) {
  const y = layout.height * (0.2 + Math.random() * 0.6);
  return {
    id: `pl_${Math.random().toString(16).slice(2, 10)}`,
    device_id: deviceId, start: 0, count: 0, shape: "line",
    points: [[layout.width * 0.1, y], [layout.width * 0.9, y]],
    reverse: false, x: layout.width * 0.3, y: layout.height * 0.3, width: layout.width * 0.2,
    height: layout.height * 0.3, cols: 0, rows: 0, serpentine: true, origin: "top-left", vertical: false, z: 0,
    ...extra,
  };
}
