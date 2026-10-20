// Small live preview of some devices' mapped LEDs with the colours they show
// right now (the hub's pixel preview). One panel per grid the LEDs are on,
// side by side, each zoomed to its own LEDs. Used in the room/group sheet.
import { ledCount, placementCoords } from "./mapping.js";
import { h } from "./ui.js";

export function livePreview(store, deviceIds, { height = 130 } = {}) {
  const wanted = new Set(deviceIds);
  const canvas = h("canvas", { class: "grid-canvas", style: { height: `${height}px` } });
  const empty = h("p", { class: "muted", style: { margin: "6px 0", fontSize: "13px" } },
    "Not mapped yet – place these lights on a grid in the Grid tab to see the effect here.");
  const el = h("div", { class: "live-preview" }, canvas);
  const ctx = canvas.getContext("2d");

  // [{ items: [{ p, coords }], box: [x0, y0, x1, y1] }] – one panel per grid
  let panels = [];
  function build() {
    panels = [];
    for (const layout of Object.values(store.config.layouts || {})) {
      const items = [];
      for (const p of layout.placements) {
        const d = store.config.devices[p.device_id];
        if (!d || !wanted.has(p.device_id)) continue;
        items.push({ p, n: ledCount(p, d.led_count), coords: placementCoords(p, d.led_count) });
      }
      const pts = items.flatMap((it) => it.coords);
      if (!pts.length) continue;
      const xs = pts.map((c) => c[0]), ys = pts.map((c) => c[1]);
      panels.push({ items, box: [Math.min(...xs), Math.min(...ys), Math.max(...xs), Math.max(...ys)] });
    }
    canvas.style.display = panels.length ? "" : "none";
    if (!panels.length && !empty.isConnected) el.append(empty);
    if (panels.length && empty.isConnected) empty.remove();
  }

  function draw() {
    if (!panels.length) return;
    const dpr = window.devicePixelRatio || 1;
    const W = canvas.clientWidth * dpr, H = height * dpr;
    if (canvas.width !== W || canvas.height !== H) { canvas.width = W; canvas.height = H; }
    ctx.fillStyle = "#000"; ctx.fillRect(0, 0, W, H);
    const pw = W / panels.length;
    panels.forEach(({ items, box }, k) => {
      const bw = Math.max(box[2] - box[0], 0.05), bh = Math.max(box[3] - box[1], 0.05);
      const scale = Math.min((pw * 0.88) / bw, (H * 0.84) / bh);
      const ox = k * pw + pw / 2 - ((box[0] + box[2]) / 2) * scale, oy = H / 2 - ((box[1] + box[3]) / 2) * scale;
      const r = Math.max(1.2, Math.min(5, scale * 0.05));
      for (const { p, n, coords } of items) {
        const frame = store.preview[p.device_id] ? atob(store.preview[p.device_id]) : null;
        coords.forEach((c, i) => {
          const idx = (p.start || 0) + (p.reverse ? n - 1 - i : i);
          let R = 25, G = 25, B = 25;
          if (frame && frame.length >= idx * 3 + 3) { R = frame.charCodeAt(idx * 3); G = frame.charCodeAt(idx * 3 + 1); B = frame.charCodeAt(idx * 3 + 2); }
          ctx.fillStyle = `rgb(${R},${G},${B})`;
          ctx.beginPath(); ctx.arc(ox + c[0] * scale, oy + c[1] * scale, r, 0, 2 * Math.PI); ctx.fill();
        });
      }
    });
  }

  build();
  const unsubs = [store.onPreview(draw), store.subscribe(() => { build(); draw(); })];
  const ro = new ResizeObserver(draw);
  ro.observe(canvas);
  store.previewRate?.(12);
  return {
    el,
    setDevices(ids) { wanted.clear(); ids.forEach((id) => wanted.add(id)); build(); draw(); },
    destroy() { unsubs.forEach((u) => u()); ro.disconnect(); store.previewDone?.(); },
  };
}
