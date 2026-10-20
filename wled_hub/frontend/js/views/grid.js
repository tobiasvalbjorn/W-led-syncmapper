// "Grid": the house-wide pixel canvas. Place every light string (placement)
// on the canvas; hub effects use these positions. Shows live colours.
import { get, put } from "../api.js";
import { newPlacement, placementCoords } from "../mapping.js";
import { fill, h, icon, toast } from "../ui.js";
import { openScanner } from "./scanner.js";

export const title = "Grid";
export const wantsPreview = true;

const PALETTE = ["#ff5f6d", "#ffc371", "#47cf73", "#4facfe", "#b06ab3", "#f9d423", "#00c9a7", "#ff8a5c"];

export function render(view, store, actions) {
  let layout = structuredClone(store.config.layout);
  let selected = layout.placements[0]?.id || null;
  let dirty = false;
  let addMode = false;
  let bgImage = null;

  actions.append(
    h("button", { class: "icon-btn", title: "Kamera-mapping", onclick: () => openScanner(store) }, icon("camera")),
  );

  const canvas = h("canvas", { class: "grid-canvas" });
  const ctx = canvas.getContext("2d");
  const form = h("div");
  const saveBtn = h("button", { class: "btn", onclick: save }, "Gem layout");
  view.replaceChildren(
    h("div", { class: "grid-wrap" }, canvas),
    h("div", { class: "grid-toolbar" },
      h("button", { class: "btn secondary small", onclick: addPlacement }, "+ Lyskæde"),
      h("button", { class: "btn secondary small", onclick: importOutputs }, "Importér outputs"),
      h("button", { class: "btn secondary small", onclick: autoMatrix }, "Auto 2D-matrix"),
      h("button", { class: "btn secondary small", onclick: () => setBackground() }, "Baggrundsbillede"),
      saveBtn),
    form,
  );

  const devices = () => store.config.devices;
  const colorFor = (deviceId) => PALETTE[Object.keys(devices()).indexOf(deviceId) % PALETTE.length];
  const sel = () => layout.placements.find((p) => p.id === selected);
  const markDirty = () => { dirty = true; saveBtn.textContent = "Gem layout •"; };

  // --- geometry: layout units <-> canvas pixels
  let scale = 1, ox = 0, oy = 0;
  function resize() {
    const dpr = window.devicePixelRatio || 1;
    const w = canvas.clientWidth;
    const hgt = Math.min(window.innerHeight * 0.55, (w * layout.height) / layout.width);
    canvas.style.height = `${hgt}px`;
    canvas.width = w * dpr; canvas.height = hgt * dpr;
    scale = Math.min(canvas.width / layout.width, canvas.height / layout.height);
    ox = (canvas.width - layout.width * scale) / 2;
    oy = (canvas.height - layout.height * scale) / 2;
    draw();
  }
  const toPx = ([x, y]) => [ox + x * scale, oy + y * scale];
  const fromEvent = (e) => {
    const r = canvas.getBoundingClientRect(), dpr = canvas.width / r.width;
    return [((e.clientX - r.left) * dpr - ox) / scale, ((e.clientY - r.top) * dpr - oy) / scale];
  };

  function handles(p) {
    if (p.shape === "matrix") return [[p.x, p.y], [p.x + p.width, p.y + p.height]];
    if (p.shape === "line") return p.points;
    return [];
  }

  function draw() {
    const dpr = window.devicePixelRatio || 1;
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    ctx.fillStyle = "#0b0b0d";
    ctx.fillRect(ox, oy, layout.width * scale, layout.height * scale);
    if (bgImage) {
      ctx.globalAlpha = 0.45;
      ctx.drawImage(bgImage, ox, oy, layout.width * scale, layout.height * scale);
      ctx.globalAlpha = 1;
    }
    // 1-unit grid
    ctx.strokeStyle = "rgba(255,255,255,.06)";
    ctx.lineWidth = 1;
    for (let x = 0; x <= layout.width; x++) { const [px] = toPx([x, 0]); ctx.beginPath(); ctx.moveTo(px, oy); ctx.lineTo(px, oy + layout.height * scale); ctx.stroke(); }
    for (let y = 0; y <= layout.height; y++) { const [, py] = toPx([0, y]); ctx.beginPath(); ctx.moveTo(ox, py); ctx.lineTo(ox + layout.width * scale, py); ctx.stroke(); }

    for (const p of layout.placements) {
      const d = devices()[p.device_id];
      if (!d) continue;
      const coords = placementCoords(p, d.led_count);
      const frame = store.preview[p.device_id] ? atob(store.preview[p.device_id]) : null;
      const r = Math.max(1.5, Math.min(6, scale * 0.06)) * (dpr > 1 ? 1 : 1);
      coords.forEach((c, i) => {
        const idx = (p.start || 0) + (p.reverse ? coords.length - 1 - i : i);
        const [px, py] = toPx(c);
        if (frame && frame.length >= idx * 3 + 3) {
          const R = frame.charCodeAt(idx * 3), G = frame.charCodeAt(idx * 3 + 1), B = frame.charCodeAt(idx * 3 + 2);
          ctx.fillStyle = R + G + B > 12 ? `rgb(${R},${G},${B})` : "rgba(255,255,255,.12)";
        } else ctx.fillStyle = colorFor(p.device_id);
        ctx.beginPath(); ctx.arc(px, py, r, 0, 2 * Math.PI); ctx.fill();
      });
      if (p.id === selected) {
        ctx.strokeStyle = colorFor(p.device_id);
        ctx.lineWidth = 2 * dpr;
        if (p.shape === "matrix") {
          const [x1, y1] = toPx([p.x, p.y]);
          ctx.strokeRect(x1, y1, p.width * scale, p.height * scale);
        } else if (p.shape === "line") {
          ctx.setLineDash([4 * dpr, 4 * dpr]);
          ctx.beginPath();
          p.points.forEach((pt, i) => { const [x, y] = toPx(pt); i ? ctx.lineTo(x, y) : ctx.moveTo(x, y); });
          ctx.stroke(); ctx.setLineDash([]);
        }
        for (const hp of handles(p)) {
          const [x, y] = toPx(hp);
          ctx.fillStyle = "#fff"; ctx.beginPath(); ctx.arc(x, y, 7 * dpr, 0, 2 * Math.PI); ctx.fill();
        }
        if (coords.length) { // mark LED 0
          const [x, y] = toPx(p.reverse ? coords[coords.length - 1] : coords[0]);
          ctx.fillStyle = "#fff"; ctx.font = `${11 * dpr}px sans-serif`; ctx.fillText("0", x + 6 * dpr, y - 6 * dpr);
        }
      }
    }
  }

  // --- interaction: drag handles, tap to select, add points in add mode
  let drag = null;
  canvas.addEventListener("pointerdown", (e) => {
    const pt = fromEvent(e);
    const tol = 14 / scale * (canvas.width / canvas.getBoundingClientRect().width);
    const p = sel();
    if (p && addMode && p.shape === "line") {
      p.points.push(pt); markDirty(); draw(); drawForm(); return;
    }
    if (p) {
      const hs = handles(p);
      const i = hs.findIndex((hp) => Math.hypot(hp[0] - pt[0], hp[1] - pt[1]) < tol);
      if (i >= 0) { drag = { p, i, last: pt }; canvas.setPointerCapture(e.pointerId); return; }
    }
    // select nearest placement by LED proximity
    let best = null, bestD = tol * 1.5;
    for (const q of layout.placements) {
      const d = devices()[q.device_id];
      if (!d) continue;
      for (const c of placementCoords(q, d.led_count)) {
        const dist = Math.hypot(c[0] - pt[0], c[1] - pt[1]);
        if (dist < bestD) { bestD = dist; best = q; }
      }
    }
    if (best) {
      selected = best.id;
      drag = { p: best, i: -1, last: pt }; // drag whole placement
      canvas.setPointerCapture(e.pointerId);
      draw(); drawForm();
    }
  });
  canvas.addEventListener("pointermove", (e) => {
    if (!drag) return;
    const pt = fromEvent(e);
    const { p, i } = drag;
    const dx = pt[0] - drag.last[0], dy = pt[1] - drag.last[1];
    drag.last = pt;
    if (i < 0) {
      if (p.shape === "matrix") { p.x += dx; p.y += dy; }
      else p.points = p.points.map(([x, y]) => [x + dx, y + dy]);
    } else if (p.shape === "matrix") {
      if (i === 0) { p.x += dx; p.y += dy; p.width -= dx; p.height -= dy; }
      else { p.width += dx; p.height += dy; }
      p.width = Math.max(0.1, p.width); p.height = Math.max(0.1, p.height);
    } else p.points[i] = pt;
    markDirty(); draw();
  });
  canvas.addEventListener("pointerup", () => { if (drag) drawForm(); drag = null; });

  function num(label, value, onchange, attrs = {}) {
    const input = h("input", { type: "number", value, ...attrs });
    input.addEventListener("change", () => { onchange(Number(input.value)); markDirty(); draw(); });
    return h("div", { class: "field" }, h("label", {}, label), input);
  }
  function check(label, value, onchange) {
    const input = h("input", { type: "checkbox", checked: value });
    input.addEventListener("change", () => { onchange(input.checked); markDirty(); draw(); drawForm(); });
    return h("label", { class: "row", style: { margin: "8px 0" } }, input, label);
  }
  function choice(label, value, options, onchange) {
    const s = h("select", {}, options.map(([v, l]) => h("option", { value: v, selected: v === value }, l)));
    s.addEventListener("change", () => { onchange(s.value); markDirty(); draw(); drawForm(); });
    return h("div", { class: "field" }, h("label", {}, label), s);
  }

  function drawForm() {
    const p = sel();
    const canvasFields = h("div", { class: "row" },
      num("Bredde (m)", layout.width, (v) => { layout.width = Math.max(1, v); resize(); }, { step: 0.5 }),
      num("Højde (m)", layout.height, (v) => { layout.height = Math.max(1, v); resize(); }, { step: 0.5 }));
    if (!p) {
      form.replaceChildren(h("div", { class: "section-title" }, "Lærred"), canvasFields,
        h("p", { class: "muted" }, "Tilføj en lyskæde, importér en enheds outputs, eller brug kamera-mapping (kamera-ikonet) for at placere LEDs automatisk."));
      return;
    }
    const d = devices()[p.device_id];
    fill(form, 
      h("div", { class: "section-title" }, "Valgt lyskæde"),
      h("div", { class: "list" }, layout.placements.map((q) => h("div", {
        class: "list-item", style: { cursor: "pointer", fontWeight: q.id === p.id ? 600 : 400 },
        onclick: () => { selected = q.id; addMode = false; draw(); drawForm(); },
      }, h("span", { class: "dot", style: { background: colorFor(q.device_id) } }),
        h("div", { class: "grow" }, devices()[q.device_id]?.name || "?"),
        h("span", { class: "muted" }, `LED ${q.start}${q.count ? `–${q.start + q.count - 1}` : "+"} · ${q.shape}`)))),
      choice("Enhed", p.device_id, Object.values(devices()).map((x) => [x.id, x.name]), (v) => (p.device_id = v)),
      h("div", { class: "row" },
        num("Første LED", p.start, (v) => (p.start = Math.max(0, v)), { min: 0 }),
        num(`Antal (0 = resten af ${d?.led_count ?? "?"})`, p.count, (v) => (p.count = Math.max(0, v)), { min: 0 })),
      choice("Form", p.shape, [["line", "Linje / polyline"], ["matrix", "2D-matrix"], ["points", "Punkter (kamera)"]], (v) => {
        p.shape = v;
        if (v === "matrix" && !p.cols) { p.cols = d?.matrix?.w || 16; p.rows = d?.matrix?.h || 16; }
      }),
      check("Omvendt retning", p.reverse, (v) => (p.reverse = v)),
      p.shape === "line" ? h("div", { class: "row", style: { flexWrap: "wrap" } },
        h("button", { class: `btn small ${addMode ? "" : "secondary"}`, onclick: () => { addMode = !addMode; drawForm(); } },
          addMode ? "Færdig med punkter" : "Tilføj knæk-punkter"),
        h("button", { class: "btn small secondary", onclick: () => { if (p.points.length > 2) { p.points.pop(); markDirty(); draw(); } } }, "Fjern sidste punkt"),
        h("span", { class: "muted" }, addMode ? "Tryk på lærredet for at tilføje punkter (fx rundt om et vindue)" : `${p.points.length} punkter`)) : null,
      p.shape === "matrix" ? h("div", {},
        h("div", { class: "row" },
          num("Kolonner", p.cols, (v) => (p.cols = Math.max(1, v)), { min: 1 }),
          num("Rækker", p.rows, (v) => (p.rows = Math.max(1, v)), { min: 1 })),
        choice("LED 0 sidder", p.origin, [["top-left", "Øverst venstre"], ["top-right", "Øverst højre"], ["bottom-left", "Nederst venstre"], ["bottom-right", "Nederst højre"]], (v) => (p.origin = v)),
        check("Serpentine (zig-zag)", p.serpentine, (v) => (p.serpentine = v)),
        check("Lodret ledningsføring", p.vertical, (v) => (p.vertical = v))) : null,
      h("button", { class: "btn danger small", style: { marginTop: "8px" }, onclick: () => {
        layout.placements = layout.placements.filter((q) => q.id !== p.id);
        selected = layout.placements[0]?.id || null;
        markDirty(); draw(); drawForm();
      } }, "Slet lyskæde"),
      h("div", { class: "section-title" }, "Lærred"), canvasFields,
    );
  }

  function addPlacement() {
    const first = Object.keys(devices())[0];
    if (!first) return toast("Tilføj først en WLED-enhed");
    const p = newPlacement(first, layout);
    layout.placements.push(p);
    selected = p.id; markDirty(); draw(); drawForm();
  }

  async function importOutputs() {
    const p = sel();
    const deviceId = p?.device_id || Object.keys(devices())[0];
    if (!deviceId) return toast("Tilføj først en WLED-enhed");
    try {
      const outs = await get(`devices/${deviceId}/outputs`);
      layout.placements = layout.placements.filter((q) => q.device_id !== deviceId);
      outs.forEach((o, i) => {
        const y = layout.height * ((i + 1) / (outs.length + 1));
        layout.placements.push(newPlacement(deviceId, layout, {
          start: o.start, count: o.count, points: [[layout.width * 0.1, y], [layout.width * 0.9, y]],
        }));
      });
      selected = layout.placements[layout.placements.length - 1]?.id;
      markDirty(); draw(); drawForm();
      toast(`${outs.length} output(s) importeret fra ${devices()[deviceId].name}`);
    } catch (e) { toast(e.message); }
  }

  function autoMatrix() {
    const d = Object.values(devices()).find((x) => x.matrix && !layout.placements.some((p) => p.device_id === x.id));
    if (!d) return toast("Ingen uplacerede 2D-enheder");
    const p = newPlacement(d.id, layout, { shape: "matrix", cols: d.matrix.w, rows: d.matrix.h, serpentine: false,
      width: Math.min(layout.width / 3, 2), height: Math.min(layout.height / 3, 2) * d.matrix.h / d.matrix.w });
    layout.placements.push(p);
    selected = p.id; markDirty(); draw(); drawForm();
    toast("Tjek serpentine/LED 0 i formularen – WLED's 2D-opsætning afgør det");
  }

  function setBackground() {
    const input = h("input", { type: "file", accept: "image/*" });
    input.addEventListener("change", () => {
      const file = input.files[0];
      if (!file) return;
      const img = new Image();
      img.onload = () => {
        // downscale to keep hub.json small
        const c = document.createElement("canvas"), k = Math.min(1, 1280 / img.width);
        c.width = img.width * k; c.height = img.height * k;
        c.getContext("2d").drawImage(img, 0, 0, c.width, c.height);
        layout.background = c.toDataURL("image/jpeg", 0.7);
        loadBackground(); markDirty();
      };
      img.src = URL.createObjectURL(file);
    });
    input.click();
  }

  function loadBackground() {
    if (!layout.background) { bgImage = null; return draw(); }
    const img = new Image();
    img.onload = () => { bgImage = img; draw(); };
    img.src = layout.background;
  }

  async function save() {
    try {
      await put("layout", layout);
      dirty = false; saveBtn.textContent = "Gem layout";
      toast("Layout gemt – hub-effekter bruger det nu");
    } catch (e) { toast(e.message); }
  }

  const unsubs = [
    store.onPreview(() => { if (!drag) draw(); }),
    store.subscribe((config) => {
      if (!dirty) { layout = structuredClone(config.layout); if (!sel()) selected = layout.placements[0]?.id || null; loadBackground(); drawForm(); }
    }),
  ];
  const ro = new ResizeObserver(resize);
  ro.observe(canvas);
  loadBackground();
  drawForm();
  return () => { unsubs.forEach((u) => u()); ro.disconnect(); };
}
