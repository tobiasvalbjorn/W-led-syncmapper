// "Grid": the house-wide pixel canvas. Place every light string (placement)
// on the canvas; hub effects use these positions. Shows live colours.
//
// LED cursor: walk along the selected string with the arrow keys (or the
// on-screen buttons). The LED under the cursor lights up white on the real
// strip, so you can find the LED that sits in a corner and pin a corner point
// to it ("Knæk her" / the corner guide for templates).
import { del, get, post, put, throttled } from "../api.js";
import { anchorsFromLengths, anchorsValid, isClosed, ledCount, newPlacement, placementCoords } from "../mapping.js";
import { STARTS, TEMPLATES, buildTemplate, cornerSteps } from "../templates.js";
import { fill, h, icon, sheet, toast } from "../ui.js";
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
  let cursor = null; // LED index relative to the placement, null = cursor off
  let guide = null; // { steps: [point indexes], k: position in steps }
  let highlighted = null; // device id currently showing the cursor on the strip

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
      h("button", { class: "btn secondary small", onclick: templateSheet }, "+ Form / skabelon"),
      h("button", { class: "btn secondary small", onclick: addPlacement }, "+ Linje"),
      h("button", { class: "btn secondary small", onclick: importOutputs }, "Importér outputs"),
      h("button", { class: "btn secondary small", onclick: autoMatrix }, "Auto 2D-matrix"),
      h("button", { class: "btn secondary small", onclick: () => setBackground() }, "Baggrundsbillede"),
      h("button", { class: "btn secondary small", onclick: () => fitSelected() }, "Zoom til valgt"),
      h("button", { class: "btn secondary small", onclick: () => zoomTo(1) }, "Vis alt"),
      saveBtn),
    form,
  );

  const devices = () => store.config.devices;
  const colorFor = (deviceId) => PALETTE[Object.keys(devices()).indexOf(deviceId) % PALETTE.length];
  const sel = () => layout.placements.find((p) => p.id === selected);
  const countOf = (p) => ledCount(p, devices()[p.device_id]?.led_count || 0);
  const markDirty = () => { dirty = true; saveBtn.textContent = "Gem layout •"; };

  // --- geometry: layout units <-> canvas pixels, with zoom around `center`
  let scale = 1, ox = 0, oy = 0, zoom = 1, center = null;
  function resize() {
    const dpr = window.devicePixelRatio || 1;
    const w = canvas.clientWidth;
    const hgt = Math.min(window.innerHeight * 0.55, (w * layout.height) / layout.width);
    canvas.style.height = `${hgt}px`;
    canvas.width = w * dpr; canvas.height = hgt * dpr;
    scale = Math.min(canvas.width / layout.width, canvas.height / layout.height) * zoom;
    const [cx, cy] = center || [layout.width / 2, layout.height / 2];
    ox = canvas.width / 2 - cx * scale;
    oy = canvas.height / 2 - cy * scale;
    draw();
  }

  function zoomTo(z, c) {
    zoom = Math.max(1, Math.min(80, z));
    center = zoom === 1 ? null : c;
    resize();
  }

  // Zoom so the selected light string fills the view (a TV on a house-sized canvas).
  function fitSelected() {
    const p = sel();
    const d = p && devices()[p.device_id];
    if (!d) return;
    const pts = [...placementCoords(p, d.led_count), ...handles(p)];
    if (!pts.length) return;
    const xs = pts.map((q) => q[0]), ys = pts.map((q) => q[1]);
    const [x0, x1, y0, y1] = [Math.min(...xs), Math.max(...xs), Math.min(...ys), Math.max(...ys)];
    const bw = Math.max(x1 - x0, layout.width / 80), bh = Math.max(y1 - y0, layout.height / 80);
    zoomTo(Math.min(layout.width / (bw * 1.5), layout.height / (bh * 1.5)), [(x0 + x1) / 2, (y0 + y1) / 2]);
  }

  canvas.addEventListener("wheel", (e) => {
    e.preventDefault();
    const at = fromEvent(e);
    const z = zoom * (e.deltaY < 0 ? 1.2 : 1 / 1.2);
    // keep the point under the mouse still while zooming
    const [cx, cy] = center || [layout.width / 2, layout.height / 2];
    const k = zoom / Math.max(1, Math.min(80, z));
    zoomTo(z, [at[0] + (cx - at[0]) * k, at[1] + (cy - at[1]) * k]);
  }, { passive: false });
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

    ctx.font = `${11 * dpr}px sans-serif`;
    for (const p of layout.placements) {
      const d = devices()[p.device_id];
      if (!d) continue;
      const coords = placementCoords(p, d.led_count);
      const frame = store.preview[p.device_id] ? atob(store.preview[p.device_id]) : null;
      const r = Math.max(1.5, Math.min(6, scale * 0.06));
      coords.forEach((c, i) => {
        const idx = (p.start || 0) + (p.reverse ? coords.length - 1 - i : i);
        const [px, py] = toPx(c);
        let dark = false;
        if (frame && frame.length >= idx * 3 + 3) {
          const R = frame.charCodeAt(idx * 3), G = frame.charCodeAt(idx * 3 + 1), B = frame.charCodeAt(idx * 3 + 2);
          ctx.fillStyle = `rgb(${R},${G},${B})`;
          dark = R + G + B < 90;
        } else ctx.fillStyle = colorFor(p.device_id);
        ctx.beginPath(); ctx.arc(px, py, r, 0, 2 * Math.PI); ctx.fill();
        if (dark) { // keep unlit LEDs visible on the dark canvas
          ctx.strokeStyle = "rgba(255,255,255,.28)"; ctx.lineWidth = 1;
          ctx.stroke();
        }
      });
      if (p.id !== selected) continue;

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
      const anchored = p.shape === "line" && anchorsValid(p);
      handles(p).forEach((hp, i) => {
        const [x, y] = toPx(hp);
        const isGuide = guide && guide.steps[guide.k] === i;
        ctx.fillStyle = isGuide ? "#ffb020" : "#fff";
        ctx.beginPath(); ctx.arc(x, y, (isGuide ? 9 : 7) * dpr, 0, 2 * Math.PI); ctx.fill();
        if (anchored && !(isClosed(p.points) && i === p.points.length - 1)) {
          ctx.fillStyle = "#fff";
          ctx.fillText(`#${p.anchors[i]}`, x + 9 * dpr, y - 9 * dpr);
        }
      });
      if (coords.length && !anchored) { // mark LED 0
        const [x, y] = toPx(p.reverse ? coords[coords.length - 1] : coords[0]);
        ctx.fillStyle = "#fff"; ctx.fillText("0", x + 6 * dpr, y - 6 * dpr);
      }
      if (cursor !== null && coords[cursor]) {
        const [x, y] = toPx(p.reverse ? coords[coords.length - 1 - cursor] : coords[cursor]);
        ctx.strokeStyle = "#fff"; ctx.lineWidth = 2.5 * dpr;
        ctx.beginPath(); ctx.arc(x, y, 11 * dpr, 0, 2 * Math.PI); ctx.stroke();
        ctx.fillStyle = "#fff"; ctx.font = `bold ${12 * dpr}px sans-serif`;
        ctx.fillText(`LED ${cursor}`, x + 14 * dpr, y + 18 * dpr);
        ctx.font = `${11 * dpr}px sans-serif`;
      }
    }
  }

  // --- LED cursor ---------------------------------------------------------

  const sendHighlight = throttled((deviceId, payload) => {
    post(`devices/${deviceId}/highlight`, payload).catch((e) => toast(e.message));
  }, 60);

  function syncHighlight() {
    const p = sel();
    if (cursor === null || !p) return stopHighlight();
    if (highlighted && highlighted !== p.device_id) stopHighlight();
    highlighted = p.device_id;
    const start = p.start || 0, n = countOf(p);
    const abs = (i) => start + (p.reverse ? n - 1 - i : i);
    const marks = anchorsValid(p) ? p.anchors.filter((a) => a < n).map(abs) : [];
    sendHighlight(p.device_id, { index: abs(cursor), start, count: n, marks });
  }

  function stopHighlight() {
    if (!highlighted) return;
    del(`devices/${highlighted}/highlight`).catch(() => {});
    highlighted = null;
  }

  function setCursor(i) {
    const p = sel();
    if (!p) return;
    const n = countOf(p);
    cursor = Math.max(0, Math.min(n - 1, i));
    syncHighlight(); draw(); updateCursorLabel();
  }

  function cursorOff() {
    cursor = null; guide = null;
    stopHighlight(); draw(); drawForm();
  }

  // Split the segment at the cursor LED: a new point appears where that LED is
  // drawn now; drag it to the real corner. Existing corners keep their LEDs.
  function bendHere() {
    const p = sel();
    if (!p || p.shape !== "line" || cursor === null) return;
    const n = countOf(p);
    if (!anchorsValid(p)) p.anchors = anchorsFromLengths(p.points, n);
    const led = p.reverse ? n - 1 - cursor : cursor;
    if (p.anchors.includes(led)) return toast(`LED ${led} er allerede et knækpunkt`);
    const coords = placementCoords({ ...p, reverse: false }, devices()[p.device_id].led_count);
    let j = p.anchors.findIndex((a) => a > led);
    if (j <= 0) return toast("Markøren skal stå mellem første og sidste punkt");
    p.points.splice(j, 0, [...coords[led]]);
    p.anchors.splice(j, 0, led);
    markDirty(); draw(); drawForm(); syncHighlight();
    toast(`Knækpunkt på LED ${led} – træk det hvide punkt hen hvor hjørnet er`);
  }

  // Corner guide (templates): pin point guide.steps[k] to the cursor LED.
  function pinCorner() {
    const p = sel();
    if (!p || !guide || cursor === null) return;
    const n = countOf(p);
    if (!anchorsValid(p)) p.anchors = anchorsFromLengths(p.points, n);
    const i = guide.steps[guide.k];
    const led = p.reverse ? n - 1 - cursor : cursor;
    if (led <= p.anchors[i - 1]) return toast(`Hjørnet skal ligge efter LED ${p.anchors[i - 1]}`);
    p.anchors[i] = led;
    // later corners must stay after this one
    for (let k = i + 1; k < p.anchors.length; k++) p.anchors[k] = Math.max(p.anchors[k], led + 1);
    if (!isClosed(p.points)) p.anchors[p.anchors.length - 1] = Math.max(p.anchors[p.anchors.length - 1], led);
    guide.k++;
    markDirty();
    if (guide.k >= guide.steps.length) {
      guide = null;
      toast("Alle hjørner er sat – husk at gemme layoutet");
    }
    draw(); drawForm(); syncHighlight();
  }

  function onKey(e) {
    if (cursor === null) return;
    const tag = document.activeElement?.tagName;
    if (tag === "INPUT" || tag === "SELECT" || tag === "TEXTAREA") return;
    const step = e.shiftKey ? 10 : 1;
    const p = sel();
    const handlers = {
      ArrowRight: () => setCursor(cursor + step),
      ArrowUp: () => setCursor(cursor + step),
      ArrowLeft: () => setCursor(cursor - step),
      ArrowDown: () => setCursor(cursor - step),
      Home: () => setCursor(0),
      End: () => setCursor(countOf(p) - 1),
      Enter: () => (guide ? pinCorner() : bendHere()),
      Escape: () => cursorOff(),
    };
    if (handlers[e.key]) { e.preventDefault(); handlers[e.key](); }
  }
  document.addEventListener("keydown", onKey);

  let cursorLabel = null;
  function updateCursorLabel() {
    if (!cursorLabel) return;
    const p = sel();
    const step = guide ? `Hjørne ${guide.k + 1} af ${guide.steps.length}: gå til LED'en der sidder i det orange hjørne og tryk Enter. ` : "";
    cursorLabel.textContent = `${step}Markør på LED ${cursor} af ${countOf(p) - 1} (enhedens LED ${(p.start || 0) + cursor}).`;
  }

  function cursorPanel(p) {
    if (cursor === null) {
      return h("div", { class: "row", style: { flexWrap: "wrap", marginTop: "8px" } },
        h("button", { class: "btn small", onclick: () => { setCursor(0); drawForm(); } }, "Find LEDs med markør"),
        p.template && cornerSteps(p.template, p.points).length
          ? h("button", { class: "btn small secondary", onclick: startGuide }, "Sæt hjørner (guide)") : null,
        h("span", { class: "muted" }, "Lyser LED'en op på den rigtige lyskæde, så du kan finde hjørnerne."));
    }
    const b = (label, fn, title) => h("button", { class: "btn small secondary", title, onclick: fn }, label);
    cursorLabel = h("p", { class: "muted", style: { margin: "6px 0" } });
    const panel = h("div", { class: "list", style: { padding: "10px 12px", marginTop: "8px" } },
      cursorLabel,
      h("div", { class: "row", style: { flexWrap: "wrap", gap: "6px" } },
        b("⏮", () => setCursor(0), "Første LED (Home)"),
        b("−10", () => setCursor(cursor - 10), "Shift+←"),
        b("−1", () => setCursor(cursor - 1), "←"),
        b("+1", () => setCursor(cursor + 1), "→"),
        b("+10", () => setCursor(cursor + 10), "Shift+→"),
        b("⏭", () => setCursor(countOf(p) - 1), "Sidste LED (End)")),
      h("div", { class: "row", style: { flexWrap: "wrap", gap: "6px", marginTop: "8px" } },
        guide
          ? h("button", { class: "btn small", onclick: pinCorner }, "Hjørnet er her (Enter)")
          : p.shape === "line" ? h("button", { class: "btn small", onclick: bendHere }, "Knæk her (Enter)") : null,
        guide ? b("Spring hjørne over", () => { guide.k++; if (guide.k >= guide.steps.length) guide = null; draw(); drawForm(); }) : null,
        b("Luk markør (Esc)", cursorOff)),
      h("p", { class: "muted", style: { margin: "8px 0 0", fontSize: "13px" } },
        "Piletaster flytter 1 LED, Shift+pil flytter 10. Hvid = markør, grøn = første LED, orange = hjørner der er sat."));
    updateCursorLabel();
    return panel;
  }

  function startGuide() {
    const p = sel();
    if (!p) return;
    if (!anchorsValid(p)) p.anchors = anchorsFromLengths(p.points, countOf(p));
    guide = { steps: cornerSteps(p.template, p.points), k: 0 };
    const first = p.anchors[guide.steps[0]] ?? 0;
    setCursor(first);
    drawForm();
  }

  // --- canvas interaction: drag handles, tap to select, add points in add mode
  let drag = null;
  canvas.addEventListener("pointerdown", (e) => {
    const pt = fromEvent(e);
    const tol = 14 / scale * (canvas.width / canvas.getBoundingClientRect().width);
    const p = sel();
    if (p && addMode && p.shape === "line") {
      p.points.push(pt);
      p.anchors = []; // free drawing: spread evenly again
      markDirty(); draw(); drawForm(); return;
    }
    if (p) {
      const hs = handles(p);
      const i = hs.findIndex((hp) => Math.hypot(hp[0] - pt[0], hp[1] - pt[1]) < tol);
      if (i >= 0) { drag = { p, i, last: pt }; canvas.setPointerCapture(e.pointerId); return; }
    }
    // select nearest placement; with the cursor on, jump to the tapped LED
    let best = null, bestI = -1, bestD = tol * 1.5;
    for (const q of layout.placements) {
      const d = devices()[q.device_id];
      if (!d) continue;
      placementCoords(q, d.led_count).forEach((c, i) => {
        const dist = Math.hypot(c[0] - pt[0], c[1] - pt[1]);
        if (dist < bestD) { bestD = dist; best = q; bestI = i; }
      });
    }
    if (!best) {
      if (zoom > 1) { drag = { pan: true, last: [e.clientX, e.clientY] }; canvas.setPointerCapture(e.pointerId); }
      return;
    }
    if (cursor !== null && best.id === selected) {
      setCursor(best.reverse ? countOf(best) - 1 - bestI : bestI);
      return;
    }
    if (best.id !== selected) { stopHighlight(); cursor = null; guide = null; }
    selected = best.id;
    drag = { p: best, i: -1, last: pt }; // drag whole placement
    canvas.setPointerCapture(e.pointerId);
    draw(); drawForm();
  });
  canvas.addEventListener("pointermove", (e) => {
    if (!drag) return;
    if (drag.pan) {
      const k = (canvas.width / canvas.getBoundingClientRect().width) / scale;
      const [cx, cy] = center || [layout.width / 2, layout.height / 2];
      center = [cx - (e.clientX - drag.last[0]) * k, cy - (e.clientY - drag.last[1]) * k];
      drag.last = [e.clientX, e.clientY];
      return resize();
    }
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
    } else {
      const closed = isClosed(p.points);
      p.points[i] = pt;
      // keep closed shapes closed when moving the start/end point
      if (closed && i === 0) p.points[p.points.length - 1] = pt;
      if (closed && i === p.points.length - 1) p.points[0] = pt;
    }
    markDirty(); draw();
  });
  canvas.addEventListener("pointerup", () => { if (drag && !drag.pan) drawForm(); drag = null; });

  // --- form helpers
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
    cursorLabel = null;
    const canvasFields = h("div", { class: "row" },
      num("Bredde (m)", layout.width, (v) => { layout.width = Math.max(1, v); resize(); }, { step: 0.5 }),
      num("Højde (m)", layout.height, (v) => { layout.height = Math.max(1, v); resize(); }, { step: 0.5 }));
    if (!p) {
      fill(form, h("div", { class: "section-title" }, "Lærred"), canvasFields,
        h("p", { class: "muted" }, "Tilføj en form (fx et rektangel til TV-backlight), importér en enheds outputs, eller brug kamera-mapping (kamera-ikonet)."));
      return;
    }
    const d = devices()[p.device_id];
    fill(form,
      h("div", { class: "section-title" }, "Valgt lyskæde"),
      h("div", { class: "list" }, layout.placements.map((q) => h("div", {
        class: "list-item", style: { cursor: "pointer", fontWeight: q.id === p.id ? 600 : 400 },
        onclick: () => { if (q.id !== selected) { stopHighlight(); cursor = null; guide = null; } selected = q.id; addMode = false; draw(); drawForm(); },
      }, h("span", { class: "dot", style: { background: colorFor(q.device_id) } }),
        h("div", { class: "grow" }, devices()[q.device_id]?.name || "?",
          q.template ? h("span", { class: "muted" }, ` · ${TEMPLATES[q.template]?.name.split(" (")[0] || q.template}`) : null),
        h("span", { class: "muted" }, `LED ${q.start}${q.count ? `–${q.start + q.count - 1}` : "+"} · ${q.shape}`)))),
      cursorPanel(p),
      choice("Enhed", p.device_id, Object.values(devices()).map((x) => [x.id, x.name]), (v) => (p.device_id = v)),
      h("div", { class: "row" },
        num("Første LED", p.start, (v) => (p.start = Math.max(0, v)), { min: 0 }),
        num(`Antal (0 = resten af ${d?.led_count ?? "?"})`, p.count, (v) => { p.count = Math.max(0, v); p.anchors = []; }, { min: 0 })),
      choice("Form", p.shape, [["line", "Linje / polyline"], ["matrix", "2D-matrix"], ["points", "Punkter (kamera)"]], (v) => {
        p.shape = v;
        if (v === "matrix" && !p.cols) { p.cols = d?.matrix?.w || 16; p.rows = d?.matrix?.h || 16; }
      }),
      check("Omvendt retning", p.reverse, (v) => (p.reverse = v)),
      p.shape === "line" ? h("div", { class: "row", style: { flexWrap: "wrap" } },
        h("button", { class: `btn small ${addMode ? "" : "secondary"}`, onclick: () => { addMode = !addMode; drawForm(); } },
          addMode ? "Færdig med punkter" : "Tegn punkter"),
        h("button", { class: "btn small secondary", onclick: () => {
          if (p.points.length <= 2) return;
          p.points.pop();
          if (anchorsValid({ ...p, points: [...p.points, [0, 0]] })) p.anchors.pop();
          markDirty(); draw(); drawForm();
        } }, "Fjern sidste punkt"),
        anchorsValid(p) ? h("button", { class: "btn small secondary", onclick: () => { p.anchors = []; markDirty(); draw(); drawForm(); } }, "Nulstil hjørne-LEDs") : null,
        h("span", { class: "muted" }, addMode ? "Tryk på lærredet for at tilføje punkter" : `${p.points.length} punkter${anchorsValid(p) ? " · hjørner bundet til LEDs" : ""}`)) : null,
      p.shape === "matrix" ? h("div", {},
        h("div", { class: "row" },
          num("Kolonner", p.cols, (v) => (p.cols = Math.max(1, v)), { min: 1 }),
          num("Rækker", p.rows, (v) => (p.rows = Math.max(1, v)), { min: 1 })),
        choice("LED 0 sidder", p.origin, [["top-left", "Øverst venstre"], ["top-right", "Øverst højre"], ["bottom-left", "Nederst venstre"], ["bottom-right", "Nederst højre"]], (v) => (p.origin = v)),
        check("Serpentine (zig-zag)", p.serpentine, (v) => (p.serpentine = v)),
        check("Lodret ledningsføring", p.vertical, (v) => (p.vertical = v))) : null,
      h("button", { class: "btn danger small", style: { marginTop: "8px" }, onclick: () => {
        cursorOff();
        layout.placements = layout.placements.filter((q) => q.id !== p.id);
        selected = layout.placements[0]?.id || null;
        markDirty(); draw(); drawForm();
      } }, "Slet lyskæde"),
      h("div", { class: "section-title" }, "Lærred"), canvasFields,
    );
  }

  // --- creating placements

  function templateSheet() {
    const devs = Object.values(devices());
    if (!devs.length) return toast("Tilføj først en WLED-enhed");
    const st = {
      kind: "rect", device: sel()?.device_id || devs[0].id, start: 0, count: 0,
      from: "bottom-left", clockwise: false,
      w: Math.min(layout.width * 0.5, 1.45), h: Math.min(layout.height * 0.5, 0.82),
    };
    const field = (label, el) => h("div", { class: "field" }, h("label", {}, label), el);
    const select = (key, options) => {
      const s = h("select", {}, options.map(([v, l]) => h("option", { value: v, selected: String(v) === String(st[key]) }, l)));
      s.addEventListener("change", () => (st[key] = key === "clockwise" ? s.value === "true" : s.value));
      return s;
    };
    const number = (key, attrs = {}) => {
      const i = h("input", { type: "number", value: st[key], ...attrs });
      i.addEventListener("change", () => (st[key] = Number(i.value)));
      return i;
    };
    const s = sheet(h("div", {},
      h("h2", {}, "Ny form"),
      h("p", { class: "muted" }, "Vælg en form der ligner lyskædens. Bagefter går du hjørnerne igennem med markøren, så formen passer præcist til hvor LED'erne sidder."),
      field("Form", select("kind", Object.entries(TEMPLATES).map(([k, t]) => [k, t.name]))),
      field("Enhed", select("device", devs.map((d) => [d.id, `${d.name} (${d.led_count} LEDs)`]))),
      h("div", { class: "row" },
        field("Første LED", number("start", { min: 0 })),
        field("Antal (0 = resten)", number("count", { min: 0 }))),
      h("div", { class: "row" },
        field("LED 0 sidder", select("from", STARTS)),
        field("Retning (set forfra)", select("clockwise", [[false, "Mod uret"], [true, "Med uret"]]))),
      h("div", { class: "row" },
        field("Bredde (m)", number("w", { step: 0.05, min: 0.05 })),
        field("Højde (m)", number("h", { step: 0.05, min: 0.05 }))),
      h("p", { class: "muted" }, "TV-backlight: brug Rektangel. Bredde og højde er TV'ets mål – fx 65\" ≈ 1,45 × 0,82 m. Ved du ikke hvor LED 0 sidder, så vælg et gæt; markøren viser det bagefter."),
      h("button", { class: "btn", onclick: () => {
        const x = (layout.width - st.w) / 2, y = (layout.height - st.h) / 2;
        const points = buildTemplate(st.kind, { x, y, w: st.w, h: st.h, start: st.from, clockwise: st.clockwise });
        const p = newPlacement(st.device, layout, { start: st.start, count: st.count, points, template: st.kind });
        p.anchors = anchorsFromLengths(points, countOf(p));
        layout.placements.push(p);
        selected = p.id; markDirty();
        s.close();
        fitSelected();
        if (cornerSteps(st.kind, points).length) startGuide();
        else { setCursor(0); drawForm(); }
        draw();
      } }, "Opret og sæt hjørner"),
    ));
  }

  function addPlacement() {
    const first = sel()?.device_id || Object.keys(devices())[0];
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
      if (!dirty) {
        layout = structuredClone(config.layout);
        if (!sel()) selected = layout.placements[0]?.id || null;
        loadBackground(); drawForm();
      }
    }),
  ];
  const ro = new ResizeObserver(resize);
  ro.observe(canvas);
  loadBackground();
  drawForm();
  return () => {
    unsubs.forEach((u) => u());
    ro.disconnect();
    document.removeEventListener("keydown", onKey);
    stopHighlight();
  };
}
