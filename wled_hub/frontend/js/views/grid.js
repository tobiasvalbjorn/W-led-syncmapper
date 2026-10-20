// "Grid": the house-wide pixel canvas. Place every light string (placement)
// on the canvas; hub effects use these positions. Shows live colours.
//
// LED cursor: walk along the selected string with the arrow keys (or the
// on-screen buttons). The LED under the cursor lights up white on the real
// strip, so you can find the LED that sits in a corner and pin a corner point
// to it ("Bend here" / the corner guide for templates).
//
// Segments between points can be straight or curved (a "bulge", drag the
// small square in the middle of a segment). A circle is two points joined by
// two half circles, so it has two segments like any other shape.
import { del, get, post, put, throttled } from "../api.js";
import {
  MAX_COLOURED_SEGMENTS, anchorsFromLengths, anchorsValid, cornerSegments, isClosed, ledCount,
  newPlacement, placementCoords, segPoint,
} from "../mapping.js";
import { STARTS, TEMPLATES, buildTemplate, cornerSteps } from "../templates.js";
import { fill, h, icon, sheet, toast } from "../ui.js";
import { openScanner } from "./scanner.js";

export const title = "Grid";
export const wantsPreview = true;

const PALETTE = ["#ff5f6d", "#ffc371", "#47cf73", "#4facfe", "#b06ab3", "#f9d423", "#00c9a7", "#ff8a5c"];
// Colours for parts / segments between corners in test patterns
const SEG_COLOURS = [
  [255, 40, 40], [40, 220, 60], [50, 90, 255], [255, 200, 0], [220, 40, 255], [0, 220, 220],
  [255, 120, 0], [150, 80, 255], [120, 255, 0], [255, 60, 160], [255, 255, 255], [0, 150, 255],
];
const TESTS = [
  ["segments", "Colour per side", "Each part – and each stretch between corners – in its own colour"],
  ["chase", "Chase", "A running light on every stretch – shows the wiring direction"],
  ["rainbow", "Rainbow", "A rainbow along each part"],
  ["white", "White", "Everything in the selection white"],
];

export function render(view, store, actions) {
  let layout = structuredClone(store.config.layout);
  let selected = layout.placements[0]?.id || null;
  let dirty = false;
  let addMode = false;
  let bgImage = null;
  let cursor = null; // LED index relative to the placement, null = cursor off
  let guide = null; // { steps: [point indexes], k: position in steps }
  let highlighted = null; // device id currently showing something on the strip
  let lampMode = false; // select/drag/highlight the whole lamp (all parts of a device)
  let hoverLight = false; // highlight mode: the part/lamp under the mouse lights up for real
  let hoverIds = new Set(); // placement ids lit by highlight mode
  let test = null; // running test pattern: { kind, label, timer }

  actions.append(
    h("button", { class: "icon-btn", title: "Camera mapping", onclick: () => openScanner(store) }, icon("camera")),
  );

  const canvas = h("canvas", { class: "grid-canvas" });
  const ctx = canvas.getContext("2d");
  const form = h("div");
  const testPanel = h("div");
  const saveBtn = h("button", { class: "btn", onclick: save }, "Save layout");
  const bgRemoveBtn = h("button", { class: "btn secondary small", hidden: true, onclick: () => {
    layout.background = null; loadBackground(); markDirty();
  } }, "Remove background");
  const modeBtnPart = h("button", { class: "active", onclick: () => setLampMode(false), title: "Select, move and highlight one part" }, "Part");
  const modeBtnLamp = h("button", { onclick: () => setLampMode(true), title: "Select, move and highlight every part of the lamp" }, "Whole lamp");
  const hoverBtn = h("button", { class: "btn secondary small", onclick: () => setHoverLight(!hoverLight),
    title: "Lights up the part/lamp under the mouse (or that you tap) on the real device" }, "Highlight: off");
  // Phone: grid on top, tools below. PC (wide screen): tools in a scrolling
  // column on the left, the grid filling the rest of the screen on the right.
  const gridWrap = h("div", { class: "grid-wrap" }, canvas);
  view.replaceChildren(h("div", { class: "grid-layout" },
    h("div", { class: "grid-main" }, gridWrap),
    h("aside", { class: "grid-side" },
      h("div", { class: "grid-toolbar" },
        h("button", { class: "btn secondary small", onclick: templateSheet }, "+ Shape / template"),
        h("button", { class: "btn secondary small", onclick: addPlacement }, "+ Line"),
        h("button", { class: "btn secondary small", onclick: importOutputs }, "Import outputs"),
        h("button", { class: "btn secondary small", onclick: autoMatrix }, "Auto 2D matrix"),
        h("button", { class: "btn secondary small", onclick: () => setBackground() }, "Background image"),
        bgRemoveBtn,
        h("button", { class: "btn secondary small", onclick: () => fitSelected() }, "Zoom to selection"),
        h("button", { class: "btn secondary small", onclick: () => zoomTo(1) }, "Show all"),
        saveBtn),
      h("div", { class: "grid-toolbar" },
        h("div", { class: "segmented", style: { margin: 0 } }, modeBtnPart, modeBtnLamp),
        hoverBtn),
      testPanel,
      form)));
  const wide = window.matchMedia("(min-width: 1000px)");

  const devices = () => store.config.devices;
  const colorFor = (deviceId) => PALETTE[Object.keys(devices()).indexOf(deviceId) % PALETTE.length];
  const sel = () => layout.placements.find((p) => p.id === selected);
  const countOf = (p) => ledCount(p, devices()[p.device_id]?.led_count || 0);
  const markDirty = () => { dirty = true; saveBtn.textContent = "Save layout •"; };
  const bulgeOf = (p, k) => Number(p.bulges?.[k]) || 0;

  // --- geometry: layout units <-> canvas pixels, with zoom around `center`
  let scale = 1, ox = 0, oy = 0, zoom = 1, center = null;
  function resize() {
    const dpr = window.devicePixelRatio || 1;
    const w = canvas.clientWidth;
    const hgt = wide.matches
      ? Math.max(200, gridWrap.clientHeight - 16) // fill the right-hand column
      : Math.min(window.innerHeight * 0.55, (w * layout.height) / layout.width);
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

  // Middle of every segment: drag it to bend the segment into an arc.
  function bendHandles(p) {
    if (p.shape !== "line") return [];
    const out = [];
    for (let k = 0; k < p.points.length - 1; k++) out.push(segPoint(p.points[k], p.points[k + 1], bulgeOf(p, k), 0.5));
    return out;
  }

  // Sampled path of a line placement (arcs become many short lines).
  function pathPoints(p) {
    const out = [p.points[0]];
    for (let k = 0; k < p.points.length - 1; k++) {
      const a = p.points[k], b = p.points[k + 1], bu = bulgeOf(p, k);
      const steps = bu ? 24 : 1;
      for (let s = 1; s <= steps; s++) out.push(segPoint(a, b, bu, s / steps));
    }
    return out;
  }

  function tracePath(p) {
    ctx.beginPath();
    pathPoints(p).forEach((pt, i) => { const [x, y] = toPx(pt); i ? ctx.lineTo(x, y) : ctx.moveTo(x, y); });
    ctx.stroke();
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
        if (hoverIds.has(p.id)) { // lit by highlight mode
          ctx.strokeStyle = "#fff"; ctx.lineWidth = 2;
          ctx.beginPath(); ctx.arc(px, py, r + 2.5, 0, 2 * Math.PI); ctx.stroke();
        } else if (dark) { // keep unlit LEDs visible on the dark canvas
          ctx.strokeStyle = "rgba(255,255,255,.28)"; ctx.lineWidth = 1;
          ctx.stroke();
        }
      });
      const inLamp = lampMode && sel()?.device_id === p.device_id;
      if (p.name && (p.id === selected || inLamp || hoverIds.has(p.id)) && coords.length) {
        const [x, y] = toPx(coords[Math.floor(coords.length / 2)]);
        ctx.fillStyle = "#fff"; ctx.fillText(p.name, x + 8 * dpr, y + 4 * dpr);
      }
      if (p.id !== selected && !inLamp) continue;
      if (p.id !== selected) { // other parts of the selected lamp: outline only
        ctx.strokeStyle = colorFor(p.device_id); ctx.lineWidth = 1.5 * dpr; ctx.setLineDash([2 * dpr, 4 * dpr]);
        if (p.shape === "line") tracePath(p);
        ctx.setLineDash([]);
        continue;
      }

      ctx.strokeStyle = colorFor(p.device_id);
      ctx.lineWidth = 2 * dpr;
      if (p.shape === "matrix") {
        const [x1, y1] = toPx([p.x, p.y]);
        ctx.strokeRect(x1, y1, p.width * scale, p.height * scale);
      } else if (p.shape === "line") {
        ctx.setLineDash([4 * dpr, 4 * dpr]);
        tracePath(p);
        ctx.setLineDash([]);
        // bend handles: small squares in the middle of each segment
        ctx.fillStyle = "rgba(255,255,255,.75)";
        for (const bh of bendHandles(p)) {
          const [x, y] = toPx(bh);
          ctx.fillRect(x - 4 * dpr, y - 4 * dpr, 8 * dpr, 8 * dpr);
        }
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

  // --- showing things on the real strip --------------------------------------

  let inflight = Promise.resolve(); // last highlight request, so a stop never overtakes it
  const sendHighlight = throttled((deviceId, payload) => {
    inflight = inflight.then(() => post(`devices/${deviceId}/highlight`, payload)).catch((e) => toast(e.message));
  }, 60);

  function stopHighlight() {
    sendHighlight.cancel(); // a queued highlight must not arrive after the stop
    if (!highlighted) return;
    const deviceId = highlighted;
    inflight = inflight.then(() => del(`devices/${deviceId}/highlight`)).catch(() => {});
    highlighted = null;
  }

  // Device LED ranges for a part: one per stretch between corners when the
  // shape has few points (rectangle, U, circle…), otherwise the whole part.
  // Relative ranges are mapped to device LEDs (start offset and reverse).
  function partRanges(p, bySide) {
    const n = countOf(p), start = p.start || 0;
    const rel = (bySide && cornerSegments(p, n)) || [[0, n]];
    return rel.map(([a, c]) => [p.reverse ? start + n - (a + c) : start + a, c]);
  }

  function colourRanges(parts, bySide, k = 1) {
    let i = 0;
    return parts.flatMap((q) => partRanges(q, bySide).map(([s, c]) => {
      const col = SEG_COLOURS[i++ % SEG_COLOURS.length];
      return [s, c, col.map((v) => Math.round(v * k))];
    }));
  }

  function syncHighlight() {
    const p = sel();
    if (cursor === null || !p) return stopHighlight();
    if (highlighted && highlighted !== p.device_id) stopHighlight();
    highlighted = p.device_id;
    const start = p.start || 0, n = countOf(p);
    const abs = (i) => start + (p.reverse ? n - 1 - i : i);
    const marks = anchorsValid(p) ? p.anchors.filter((a) => a < n).map(abs) : [];
    // stretches between corners in their own (dimmed) colours, so you can see
    // on the real strip which side you are on
    const ranges = cornerSegments(p, n) ? colourRanges([p], true, 0.3) : [];
    sendHighlight(p.device_id, { index: abs(cursor), start, count: n, marks, ranges });
  }

  // Highlight mode: light the whole part (or lamp) on the real device.
  function partsFor(p) {
    return lampMode ? layout.placements.filter((q) => q.device_id === p.device_id) : [p];
  }

  function lightParts(parts) {
    const ids = new Set(parts.map((q) => q.id));
    if ([...ids].join() === [...hoverIds].join()) return;
    hoverIds = ids;
    draw();
    if (!parts.length) return stopHighlight();
    const deviceId = parts[0].device_id;
    if (highlighted && highlighted !== deviceId) stopHighlight();
    highlighted = deviceId;
    sendHighlight(deviceId, { ranges: parts.map((q) => [q.start || 0, countOf(q)]) });
  }

  function setHoverLight(on) {
    hoverLight = on;
    hoverBtn.textContent = on ? "Highlight: on" : "Highlight: off";
    hoverBtn.classList.toggle("secondary", !on);
    if (!on) { hoverIds = new Set(); stopHighlight(); draw(); }
    else { stopTest(); if (cursor !== null) cursorOff(); }
  }

  function setLampMode(on) {
    lampMode = on;
    modeBtnPart.classList.toggle("active", !on);
    modeBtnLamp.classList.toggle("active", on);
    hoverIds = new Set();
    draw(); drawForm(); drawTestPanel();
  }

  // --- test patterns ----------------------------------------------------------

  function runTest(kind) {
    const p = sel();
    if (!p) return toast("Select a light string first");
    if (cursor !== null) cursorOff();
    if (hoverLight) setHoverLight(false);
    const parts = partsFor(p);
    const ranges = {
      segments: () => colourRanges(parts, true),
      chase: () => colourRanges(parts, true),
      rainbow: () => colourRanges(parts, false),
      white: () => parts.map((q) => [q.start || 0, countOf(q), [220, 220, 220]]),
    }[kind]();
    const effect = kind === "chase" ? "chase" : kind === "rainbow" ? "rainbow" : "solid";
    const send = () => {
      if (highlighted && highlighted !== p.device_id) stopHighlight();
      highlighted = p.device_id;
      sendHighlight(p.device_id, { ranges, effect });
    };
    clearInterval(test?.timer);
    send();
    const what = lampMode ? devices()[p.device_id]?.name : `${devices()[p.device_id]?.name}${p.name ? ` · ${p.name}` : ""}`;
    test = { kind, label: `${TESTS.find((t) => t[0] === kind)[1]} on ${what}`, timer: setInterval(send, 30000) };
    drawTestPanel();
  }

  function stopTest() {
    if (!test) return;
    clearInterval(test.timer);
    test = null;
    stopHighlight();
    drawTestPanel();
  }

  function drawTestPanel() {
    const p = sel();
    const many = p?.shape === "line" && p.points.length - 1 > MAX_COLOURED_SEGMENTS;
    fill(testPanel,
      h("div", { class: "section-title" }, "Test pattern on the real lights"),
      h("div", { class: "row", style: { flexWrap: "wrap", gap: "6px" } },
        TESTS.map(([kind, label, title]) => h("button", {
          class: `btn small ${test?.kind === kind ? "" : "secondary"}`, title, onclick: () => runTest(kind),
        }, label)),
        test ? h("button", { class: "btn small danger", onclick: stopTest }, "Stop") : null),
      h("p", { class: "muted", style: { fontSize: "13px", margin: "6px 0 0" } },
        test ? `Running: ${test.label}.`
          : `Applies to the selected ${lampMode ? "lamp (all parts)" : "part"}. Shapes with up to ${MAX_COLOURED_SEGMENTS} segments get a colour per side${many ? " – this one has more, so it gets one colour" : ""}.`));
  }

  // --- LED cursor ---------------------------------------------------------------

  function setCursor(i) {
    const p = sel();
    if (!p) return;
    if (hoverLight) setHoverLight(false); // the cursor uses the strip itself
    if (test) { clearInterval(test.timer); test = null; drawTestPanel(); }
    const n = countOf(p);
    cursor = Math.max(0, Math.min(n - 1, i));
    syncHighlight(); draw(); updateCursorLabel();
  }

  function cursorOff() {
    cursor = null; guide = null;
    stopHighlight(); draw(); drawForm();
  }

  // Bend at the cursor LED: a new point appears where that LED is drawn now;
  // drag it to the real corner. Existing corners keep their LEDs, and an arc
  // is split into two arcs that keep the same curve.
  function bendHere() {
    const p = sel();
    if (!p || p.shape !== "line" || cursor === null) return;
    const n = countOf(p);
    if (!anchorsValid(p)) p.anchors = anchorsFromLengths(p.points, n, p.bulges);
    const led = p.reverse ? n - 1 - cursor : cursor;
    if (p.anchors.includes(led)) return toast(`LED ${led} is already a bend point`);
    const coords = placementCoords({ ...p, reverse: false }, devices()[p.device_id].led_count);
    const j = p.anchors.findIndex((a) => a > led);
    if (j <= 0) return toast("Move the cursor between the first and last point");
    const k = j - 1; // the segment being split
    const bu = bulgeOf(p, k);
    if (bu) {
      const f = (led - p.anchors[k]) / (p.anchors[j] - p.anchors[k]);
      const sweep = 4 * Math.atan(bu);
      const bulges = [...(p.bulges || [])];
      while (bulges.length < p.points.length - 1) bulges.push(0);
      bulges.splice(k, 1, Math.tan((sweep * f) / 4), Math.tan((sweep * (1 - f)) / 4));
      p.bulges = bulges;
    } else if (p.bulges?.length > k) {
      p.bulges.splice(k, 0, 0);
    }
    p.points.splice(j, 0, [...coords[led]]);
    p.anchors.splice(j, 0, led);
    markDirty(); draw(); drawForm(); syncHighlight();
    toast(`Bend point at LED ${led} – drag the white point to where the corner is`);
  }

  // Corner guide (templates): pin point guide.steps[k] to the cursor LED.
  function pinCorner() {
    const p = sel();
    if (!p || !guide || cursor === null) return;
    const n = countOf(p);
    if (!anchorsValid(p)) p.anchors = anchorsFromLengths(p.points, n, p.bulges);
    const i = guide.steps[guide.k];
    const led = p.reverse ? n - 1 - cursor : cursor;
    if (led <= p.anchors[i - 1]) return toast(`This corner has to come after LED ${p.anchors[i - 1]}`);
    p.anchors[i] = led;
    // later corners must stay after this one
    for (let k = i + 1; k < p.anchors.length; k++) p.anchors[k] = Math.max(p.anchors[k], led + 1);
    if (!isClosed(p.points)) p.anchors[p.anchors.length - 1] = Math.max(p.anchors[p.anchors.length - 1], led);
    guide.k++;
    markDirty();
    if (guide.k >= guide.steps.length) {
      guide = null;
      toast("All corners are set – remember to save the layout");
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
    const step = guide ? `Corner ${guide.k + 1} of ${guide.steps.length}: move to the LED in the orange corner and press Enter. ` : "";
    cursorLabel.textContent = `${step}Cursor on LED ${cursor} of ${countOf(p) - 1} (device LED ${(p.start || 0) + cursor}).`;
  }

  function cursorPanel(p) {
    if (cursor === null) {
      return h("div", { class: "row", style: { flexWrap: "wrap", marginTop: "8px" } },
        h("button", { class: "btn small", onclick: () => { setCursor(0); drawForm(); } }, "Find LEDs with cursor"),
        p.template && cornerSteps(p.template, p.points).length
          ? h("button", { class: "btn small secondary", onclick: startGuide }, "Set corners (guide)") : null,
        h("span", { class: "muted" }, "Lights the LED on the real string so you can find the corners."));
    }
    const b = (label, fn, title) => h("button", { class: "btn small secondary", title, onclick: fn }, label);
    cursorLabel = h("p", { class: "muted", style: { margin: "6px 0" } });
    const panel = h("div", { class: "list", style: { padding: "10px 12px", marginTop: "8px" } },
      cursorLabel,
      h("div", { class: "row", style: { flexWrap: "wrap", gap: "6px" } },
        b("⏮", () => setCursor(0), "First LED (Home)"),
        b("−10", () => setCursor(cursor - 10), "Shift+←"),
        b("−1", () => setCursor(cursor - 1), "←"),
        b("+1", () => setCursor(cursor + 1), "→"),
        b("+10", () => setCursor(cursor + 10), "Shift+→"),
        b("⏭", () => setCursor(countOf(p) - 1), "Last LED (End)")),
      h("div", { class: "row", style: { flexWrap: "wrap", gap: "6px", marginTop: "8px" } },
        guide
          ? h("button", { class: "btn small", onclick: pinCorner }, "Corner is here (Enter)")
          : p.shape === "line" ? h("button", { class: "btn small", onclick: bendHere }, "Bend here (Enter)") : null,
        guide ? b("Skip corner", () => { guide.k++; if (guide.k >= guide.steps.length) guide = null; draw(); drawForm(); }) : null,
        p.shape !== "matrix" ? b("Split here", splitHere, "Split the string into two parts at the cursor – e.g. outer and inner ring") : null,
        b("Close cursor (Esc)", cursorOff)),
      h("p", { class: "muted", style: { margin: "8px 0 0", fontSize: "13px" } },
        "Arrow keys move 1 LED, Shift+arrow moves 10. White = cursor, green = first LED, orange = corners already set; the sides between corners show in their own colours."));
    updateCursorLabel();
    return panel;
  }

  // Scale / rotate the selected part (or every part of the lamp in lamp mode)
  // around the centre of the parts together – e.g. shrink the inner ring.
  function transformParts(parts, k, degrees) {
    const pts = parts.flatMap((q) => (q.shape === "matrix"
      ? [[q.x, q.y], [q.x + q.width, q.y + q.height]] : q.points));
    if (!pts.length) return;
    const xs = pts.map((q) => q[0]), ys = pts.map((q) => q[1]);
    const cx = (Math.min(...xs) + Math.max(...xs)) / 2, cy = (Math.min(...ys) + Math.max(...ys)) / 2;
    const a = (degrees * Math.PI) / 180, cos = Math.cos(a), sin = Math.sin(a);
    const tf = ([x, y]) => {
      const dx = (x - cx) * k, dy = (y - cy) * k;
      return [+(cx + dx * cos - dy * sin).toFixed(4), +(cy + dx * sin + dy * cos).toFixed(4)];
    };
    for (const q of parts) {
      if (q.shape === "matrix") {
        const [x0, y0] = tf([q.x, q.y]);
        q.width *= k; q.height *= k; q.x = x0; q.y = y0; // matrices scale but do not rotate
      } else {
        q.points = q.points.map(tf); // arcs keep their bulge: same curve, new size/angle
      }
    }
    markDirty(); draw();
  }

  function transformRow(p) {
    const parts = () => partsFor(p);
    const b = (label, fn, title) => h("button", { class: "btn small secondary", title, onclick: fn }, label);
    return h("div", { class: "field" },
      h("label", {}, lampMode ? "Size and rotation – whole lamp" : "Size and rotation – this part"),
      h("div", { class: "row", style: { flexWrap: "wrap", gap: "6px" } },
        b("− 10 %", () => transformParts(parts(), 0.9, 0), "Smaller"),
        b("− 2 %", () => transformParts(parts(), 0.98, 0), "A little smaller"),
        b("+ 2 %", () => transformParts(parts(), 1.02, 0), "A little bigger"),
        b("+ 10 %", () => transformParts(parts(), 1.1, 0), "Bigger"),
        b("⟲ 15°", () => transformParts(parts(), 1, -15), "Rotate anticlockwise"),
        b("⟳ 15°", () => transformParts(parts(), 1, 15), "Rotate clockwise"),
        b("Mirror ↔", () => {
          for (const q of parts()) if (q.shape !== "matrix") {
            const xs = q.points.map((v) => v[0]), mid = (Math.min(...xs) + Math.max(...xs)) / 2;
            q.points = q.points.map(([x, y]) => [2 * mid - x, y]);
            q.bulges = (q.bulges || []).map((v) => -v); // mirrored arcs curve the other way
          }
          markDirty(); draw();
        }, "Flip horizontally")));
  }

  // Split the selected part in two at the cursor: LEDs before the cursor stay,
  // the cursor LED and the rest become a new part you can place separately.
  function splitHere() {
    const p = sel();
    if (!p || cursor === null) return;
    const n = countOf(p);
    const led = p.reverse ? n - cursor : cursor;
    if (led <= 0 || led >= n) return toast("Move the cursor onto the string – not the first LED");
    const start = p.start || 0;
    const second = {
      ...structuredClone(p),
      id: `pl_${Math.random().toString(16).slice(2, 10)}`,
      start: start + led, count: n - led, anchors: [], template: "",
      name: p.name ? `${p.name} 2` : "Part 2",
      points: p.points.map(([x, y]) => [x, y + layout.height * 0.04]),
      y: (p.y || 0) + layout.height * 0.04,
    };
    p.count = led; p.anchors = []; p.template = "";
    if (!p.name) p.name = "Part 1";
    layout.placements.splice(layout.placements.indexOf(p) + 1, 0, second);
    cursorOff();
    selected = second.id;
    markDirty(); draw(); drawForm(); drawTestPanel();
    toast(`Split: LED ${start}–${start + led - 1} and LED ${start + led}–${start + n - 1}. Move the new part into place.`);
  }

  function startGuide() {
    const p = sel();
    if (!p) return;
    if (!anchorsValid(p)) p.anchors = anchorsFromLengths(p.points, countOf(p), p.bulges);
    guide = { steps: cornerSteps(p.template, p.points), k: 0 };
    const first = p.anchors[guide.steps[0]] ?? 0;
    setCursor(first);
    drawForm();
  }

  // --- canvas interaction: drag handles, tap to select, add points in add mode
  let drag = null;
  const tolerance = () => 14 / scale * (canvas.width / canvas.getBoundingClientRect().width);
  canvas.addEventListener("pointerdown", (e) => {
    const pt = fromEvent(e);
    const tol = tolerance();
    const p = sel();
    if (p && addMode && p.shape === "line") {
      p.points.push(pt);
      p.anchors = []; // free drawing: spread evenly again
      markDirty(); draw(); drawForm(); return;
    }
    if (p) {
      const i = handles(p).findIndex((hp) => Math.hypot(hp[0] - pt[0], hp[1] - pt[1]) < tol);
      if (i >= 0) { drag = { p, i, last: pt }; canvas.setPointerCapture(e.pointerId); return; }
      const k = bendHandles(p).findIndex((hp) => Math.hypot(hp[0] - pt[0], hp[1] - pt[1]) < tol);
      if (k >= 0) { drag = { p, bend: k, last: pt }; canvas.setPointerCapture(e.pointerId); return; }
    }
    // select the part under the pointer; with the cursor on, jump to the tapped LED
    const { p: best, i: bestI } = hitTest(pt, tol);
    if (best && hoverLight) lightParts(partsFor(best));
    if (!best) {
      if (zoom > 1) { drag = { pan: true, last: [e.clientX, e.clientY] }; canvas.setPointerCapture(e.pointerId); }
      return;
    }
    if (cursor !== null && best.id === selected && bestI >= 0) {
      setCursor(best.reverse ? countOf(best) - 1 - bestI : bestI);
      return;
    }
    if (best.id !== selected) { stopHighlight(); cursor = null; guide = null; }
    selected = best.id;
    drag = { p: best, i: -1, last: pt, parts: partsFor(best) }; // drag the part, or the whole lamp
    canvas.setPointerCapture(e.pointerId);
    draw(); drawForm(); drawTestPanel();
  });
  canvas.addEventListener("pointermove", (e) => {
    if (!drag) {
      if (hoverLight && e.pointerType === "mouse") {
        const { p } = hitTest(fromEvent(e), tolerance());
        lightParts(p ? partsFor(p) : []);
      }
      return;
    }
    if (drag.pan) {
      const k = (canvas.width / canvas.getBoundingClientRect().width) / scale;
      const [cx, cy] = center || [layout.width / 2, layout.height / 2];
      center = [cx - (e.clientX - drag.last[0]) * k, cy - (e.clientY - drag.last[1]) * k];
      drag.last = [e.clientX, e.clientY];
      return resize();
    }
    const pt = fromEvent(e);
    const { p, i } = drag;
    if (drag.bend !== undefined) {
      // bulge from how far the pointer is from the chord: s = sagitta, bulge = 2s / chord
      const a = p.points[drag.bend], b = p.points[drag.bend + 1];
      const dx = b[0] - a[0], dy = b[1] - a[1], c = Math.hypot(dx, dy);
      if (c) {
        const s = ((pt[0] - (a[0] + b[0]) / 2) * -dy + (pt[1] - (a[1] + b[1]) / 2) * dx) / c;
        let bu = (2 * s) / c;
        if (Math.abs(bu) < 0.03) bu = 0; // snap back to straight
        const bulges = [...(p.bulges || [])];
        while (bulges.length < p.points.length - 1) bulges.push(0);
        bulges[drag.bend] = Math.max(-3, Math.min(3, +bu.toFixed(4)));
        p.bulges = bulges;
        markDirty(); draw();
      }
      return;
    }
    const dx = pt[0] - drag.last[0], dy = pt[1] - drag.last[1];
    drag.last = pt;
    if (i < 0) {
      for (const q of drag.parts || [p]) {
        if (q.shape === "matrix") { q.x += dx; q.y += dy; }
        else q.points = q.points.map(([x, y]) => [x + dx, y + dy]);
      }
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
  canvas.addEventListener("pointerleave", (e) => { if (hoverLight && e.pointerType === "mouse" && !drag) lightParts([]); });

  // Nearest LED within tolerance, else a (possibly curved) segment, else a matrix area.
  function hitTest(pt, tol) {
    let best = null, bestI = -1, bestD = tol * 1.5;
    for (const q of layout.placements) {
      const d = devices()[q.device_id];
      if (!d) continue;
      placementCoords(q, d.led_count).forEach((c, i) => {
        const dist = Math.hypot(c[0] - pt[0], c[1] - pt[1]);
        if (dist < bestD) { bestD = dist; best = q; bestI = i; }
      });
    }
    if (best) return { p: best, i: bestI };
    for (const q of layout.placements) {
      if (q.shape === "line") {
        const path = pathPoints(q);
        for (let k = 0; k < path.length - 1; k++) {
          if (segDist(pt, path[k], path[k + 1]) < tol) return { p: q, i: -1 };
        }
      } else if (q.shape === "matrix" && pt[0] >= q.x && pt[0] <= q.x + q.width && pt[1] >= q.y && pt[1] <= q.y + q.height) {
        return { p: q, i: -1 };
      }
    }
    return { p: null, i: -1 };
  }

  function segDist(p, a, b) {
    const dx = b[0] - a[0], dy = b[1] - a[1], len = dx * dx + dy * dy;
    const t = len ? Math.max(0, Math.min(1, ((p[0] - a[0]) * dx + (p[1] - a[1]) * dy) / len)) : 0;
    return Math.hypot(p[0] - (a[0] + t * dx), p[1] - (a[1] + t * dy));
  }

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
      num("Width (m)", layout.width, (v) => { layout.width = Math.max(1, v); resize(); }, { step: 0.5 }),
      num("Height (m)", layout.height, (v) => { layout.height = Math.max(1, v); resize(); }, { step: 0.5 }));
    if (!p) {
      fill(form, h("div", { class: "section-title" }, "Canvas"), canvasFields,
        h("p", { class: "muted" }, "Add a shape (e.g. a rectangle for a TV backlight), import a device's outputs, or use camera mapping (the camera icon)."));
      return;
    }
    const d = devices()[p.device_id];
    const curved = (p.bulges || []).some((v) => v);
    fill(form,
      h("div", { class: "section-title" }, "Light strings and parts"),
      h("div", { class: "list" }, layout.placements.map((q) => h("div", {
        class: "list-item", style: { cursor: "pointer", fontWeight: q.id === p.id ? 600 : 400 },
        onclick: () => {
          if (q.id !== selected) { stopHighlight(); cursor = null; guide = null; }
          selected = q.id; addMode = false; draw(); drawForm(); drawTestPanel();
        },
      }, h("span", { class: "dot", style: { background: colorFor(q.device_id) } }),
        h("div", { class: "grow" }, devices()[q.device_id]?.name || "?", q.name ? ` · ${q.name}` : "",
          q.template ? h("span", { class: "muted" }, ` · ${TEMPLATES[q.template]?.name.split(" (")[0] || q.template}`) : null),
        h("span", { class: "muted" }, `LED ${q.start}${q.count ? `–${q.start + q.count - 1}` : "+"} · ${q.shape}`)))),
      cursorPanel(p),
      transformRow(p),
      (() => {
        const input = h("input", { type: "text", value: p.name || "", placeholder: "E.g. Outer, Inner, Top" });
        input.addEventListener("change", () => { p.name = input.value.trim(); markDirty(); draw(); drawForm(); });
        return h("div", { class: "field" }, h("label", {}, "Part name"), input);
      })(),
      choice("Device", p.device_id, Object.values(devices()).map((x) => [x.id, x.name]), (v) => (p.device_id = v)),
      h("div", { class: "row" },
        num("First LED", p.start, (v) => (p.start = Math.max(0, v)), { min: 0 }),
        num(`Count (0 = rest of ${d?.led_count ?? "?"})`, p.count, (v) => { p.count = Math.max(0, v); p.anchors = []; }, { min: 0 })),
      choice("Shape", p.shape, [["line", "Line / polyline"], ["matrix", "2D matrix"], ["points", "Points (camera)"]], (v) => {
        p.shape = v;
        if (v === "matrix" && !p.cols) { p.cols = d?.matrix?.w || 16; p.rows = d?.matrix?.h || 16; }
      }),
      check("Reverse direction", p.reverse, (v) => (p.reverse = v)),
      p.shape === "line" ? h("div", { class: "row", style: { flexWrap: "wrap" } },
        h("button", { class: `btn small ${addMode ? "" : "secondary"}`, onclick: () => { addMode = !addMode; drawForm(); } },
          addMode ? "Done adding points" : "Draw points"),
        h("button", { class: "btn small secondary", onclick: () => {
          if (p.points.length <= 2) return;
          p.points.pop();
          if (anchorsValid({ ...p, points: [...p.points, [0, 0]] })) p.anchors.pop();
          if (p.bulges) p.bulges = p.bulges.slice(0, p.points.length - 1);
          markDirty(); draw(); drawForm();
        } }, "Remove last point"),
        curved ? h("button", { class: "btn small secondary", onclick: () => { p.bulges = []; markDirty(); draw(); drawForm(); } }, "Make all straight") : null,
        anchorsValid(p) ? h("button", { class: "btn small secondary", onclick: () => { p.anchors = []; markDirty(); draw(); drawForm(); } }, "Reset corner LEDs") : null,
        h("span", { class: "muted" }, addMode ? "Tap the canvas to add points"
          : `${p.points.length} points${anchorsValid(p) ? " · corners pinned to LEDs" : ""}. Drag a small square to curve a side.`)) : null,
      p.shape === "matrix" ? h("div", {},
        h("div", { class: "row" },
          num("Columns", p.cols, (v) => (p.cols = Math.max(1, v)), { min: 1 }),
          num("Rows", p.rows, (v) => (p.rows = Math.max(1, v)), { min: 1 })),
        choice("LED 0 is at", p.origin, [["top-left", "Top left"], ["top-right", "Top right"], ["bottom-left", "Bottom left"], ["bottom-right", "Bottom right"]], (v) => (p.origin = v)),
        check("Serpentine (zig-zag)", p.serpentine, (v) => (p.serpentine = v)),
        check("Vertical wiring", p.vertical, (v) => (p.vertical = v))) : null,
      h("button", { class: "btn danger small", style: { marginTop: "8px" }, onclick: () => {
        cursorOff();
        layout.placements = layout.placements.filter((q) => q.id !== p.id);
        selected = layout.placements[0]?.id || null;
        markDirty(); draw(); drawForm(); drawTestPanel();
      } }, "Delete light string"),
      h("div", { class: "section-title" }, "Canvas"), canvasFields,
    );
  }

  // --- creating placements

  function templateSheet() {
    const devs = Object.values(devices());
    if (!devs.length) return toast("Add a WLED device first");
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
      h("h2", {}, "New shape"),
      h("p", { class: "muted" }, "Pick the shape that matches the light string. Afterwards you walk through the corners with the cursor, so the shape matches exactly where the LEDs are."),
      field("Shape", select("kind", Object.entries(TEMPLATES).map(([k, t]) => [k, t.name]))),
      field("Device", select("device", devs.map((d) => [d.id, `${d.name} (${d.led_count} LEDs)`]))),
      h("div", { class: "row" },
        field("First LED", number("start", { min: 0 })),
        field("Count (0 = the rest)", number("count", { min: 0 }))),
      h("div", { class: "row" },
        field("LED 0 is at", select("from", STARTS)),
        field("Direction (seen from the front)", select("clockwise", [[false, "Anticlockwise"], [true, "Clockwise"]]))),
      h("div", { class: "row" },
        field("Width (m)", number("w", { step: 0.05, min: 0.05 })),
        field("Height (m)", number("h", { step: 0.05, min: 0.05 }))),
      h("p", { class: "muted" }, "TV backlight: use Rectangle with the TV's size – e.g. 65\" ≈ 1.45 × 0.82 m. A circle uses the width as its diameter. Not sure where LED 0 is? Make a guess; the cursor will show you."),
      h("button", { class: "btn", onclick: () => {
        const x = (layout.width - st.w) / 2, y = (layout.height - st.h) / 2;
        const { points, bulges } = buildTemplate(st.kind, { x, y, w: st.w, h: st.h, start: st.from, clockwise: st.clockwise });
        const p = newPlacement(st.device, layout, { start: st.start, count: st.count, points, bulges, template: st.kind });
        p.anchors = anchorsFromLengths(points, countOf(p), bulges);
        layout.placements.push(p);
        selected = p.id; markDirty();
        s.close();
        fitSelected();
        if (cornerSteps(st.kind, points).length) startGuide();
        else { setCursor(0); drawForm(); }
        draw(); drawTestPanel();
      } }, "Create and set corners"),
    ));
  }

  function addPlacement() {
    const first = sel()?.device_id || Object.keys(devices())[0];
    if (!first) return toast("Add a WLED device first");
    const p = newPlacement(first, layout);
    layout.placements.push(p);
    selected = p.id; markDirty(); draw(); drawForm(); drawTestPanel();
  }

  async function importOutputs() {
    const p = sel();
    const deviceId = p?.device_id || Object.keys(devices())[0];
    if (!deviceId) return toast("Add a WLED device first");
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
      markDirty(); draw(); drawForm(); drawTestPanel();
      toast(`Imported ${outs.length} output(s) from ${devices()[deviceId].name}`);
    } catch (e) { toast(e.message); }
  }

  function autoMatrix() {
    const d = Object.values(devices()).find((x) => x.matrix && !layout.placements.some((p) => p.device_id === x.id));
    if (!d) return toast("No unplaced 2D devices");
    const p = newPlacement(d.id, layout, { shape: "matrix", cols: d.matrix.w, rows: d.matrix.h, serpentine: false,
      width: Math.min(layout.width / 3, 2), height: Math.min(layout.height / 3, 2) * d.matrix.h / d.matrix.w });
    layout.placements.push(p);
    selected = p.id; markDirty(); draw(); drawForm(); drawTestPanel();
    toast("Check serpentine / LED 0 in the form – it depends on WLED's 2D setup");
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
    bgRemoveBtn.hidden = !layout.background;
    if (!layout.background) { bgImage = null; return draw(); }
    const img = new Image();
    img.onload = () => { bgImage = img; draw(); };
    img.src = layout.background;
  }

  async function save() {
    try {
      await put("layout", layout);
      dirty = false; saveBtn.textContent = "Save layout";
      toast("Layout saved – hub effects use it now");
    } catch (e) { toast(e.message); }
  }

  const unsubs = [
    store.onPreview(() => { if (!drag) draw(); }),
    store.subscribe((config) => {
      if (!dirty) {
        layout = structuredClone(config.layout);
        if (!sel()) selected = layout.placements[0]?.id || null;
        loadBackground(); drawForm(); drawTestPanel();
      }
    }),
  ];
  const ro = new ResizeObserver(resize);
  ro.observe(gridWrap);
  wide.addEventListener("change", resize);
  loadBackground();
  drawForm();
  drawTestPanel();
  return () => {
    unsubs.forEach((u) => u());
    ro.disconnect();
    wide.removeEventListener("change", resize);
    document.removeEventListener("keydown", onKey);
    clearInterval(test?.timer);
    stopHighlight();
  };
}
