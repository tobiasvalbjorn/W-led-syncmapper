// "Studio": build your own effects from stacked layers (lines, gradients,
// rings, waves, sparkle, solid), watch them live on the real lights and on a
// preview of the grid, and save the ones you like. Saved effects appear in
// every room's effect list under "My effects" and in Home Assistant as
// "Custom: <name>". Rendering happens in the hub (wledhub/studio.py).
import { del, post, put } from "../api.js";
import { ledCount, placementCoords } from "../mapping.js";
import { fill, h, toast } from "../ui.js";

export const title = "Studio";
export const wantsPreview = true;

const LAYERS = {
  lines: { name: "Lines", hint: "Moving lines or bars across the house",
    make: () => ({ type: "lines", colors: ["#ff2020", "#2050ff"], count: 3, width: 0.06, softness: 0.5, angle: 0, speed: 0.25, bounce: false }) },
  gradient: { name: "Gradient", hint: "Colours blending into each other, optionally scrolling",
    make: () => ({ type: "gradient", colors: ["#ff0000", "#ffcc00", "#00ff60", "#0080ff", "#a000ff"], repeat: 1, angle: 0, speed: 0.1 }) },
  rings: { name: "Rings", hint: "Circles growing out from a point",
    make: () => ({ type: "rings", colors: ["#00ffd0"], count: 3, width: 0.08, softness: 0.6, speed: 0.3, cx: 0.5, cy: 0.5 }) },
  wave: { name: "Wave", hint: "Soft bands of light rolling along",
    make: () => ({ type: "wave", colors: ["#ff6a00"], wavelength: 0.4, sharpness: 2, angle: 0, speed: 0.2 }) },
  sparkle: { name: "Sparkle", hint: "Random twinkles that fade out",
    make: () => ({ type: "sparkle", colors: ["#ffffff"], density: 0.5, fade: 0.6, blend: "add" }) },
  solid: { name: "Solid colour", hint: "One colour everywhere (good as a base or a tint)",
    make: () => ({ type: "solid", color: "#201000" }) },
};

// slider specs: [key, label, min, max, step]
const CONTROLS = {
  lines: [["count", "Number of lines", 1, 30, 1], ["width", "Thickness", 0.005, 0.5, 0.005], ["softness", "Soft edges", 0, 1, 0.05],
    ["angle", "Direction (°)", 0, 359, 1], ["speed", "Speed (− = backwards)", -3, 3, 0.05]],
  gradient: [["repeat", "Repeats across the house", 0.1, 10, 0.1], ["angle", "Direction (°)", 0, 359, 1], ["speed", "Scroll speed", -3, 3, 0.05]],
  rings: [["count", "Number of rings", 1, 20, 1], ["width", "Thickness", 0.005, 0.5, 0.005], ["softness", "Soft edges", 0, 1, 0.05],
    ["speed", "Speed (− = inwards)", -3, 3, 0.05], ["cx", "Centre X", 0, 1, 0.01], ["cy", "Centre Y", 0, 1, 0.01]],
  wave: [["wavelength", "Wave length", 0.02, 3, 0.01], ["sharpness", "Sharpness", 0.2, 12, 0.1], ["angle", "Direction (°)", 0, 359, 1],
    ["speed", "Speed (− = backwards)", -3, 3, 0.05]],
  sparkle: [["density", "Density", 0, 10, 0.05], ["fade", "Fade time (s)", 0.05, 5, 0.05]],
  solid: [],
};

const STARTERS = {
  "Red & blue lines": { background: "#000000", layers: [LAYERS.lines.make()] },
  "Rainbow scroll": { background: "#000000", layers: [LAYERS.gradient.make()] },
  "Rings from the centre": { background: "#000008", layers: [LAYERS.rings.make()] },
  "Embers with sparkle": { background: "#100200", layers: [LAYERS.wave.make(), { ...LAYERS.sparkle.make(), colors: ["#ffd080"], density: 1 }] },
  "Empty": { background: "#000000", layers: [] },
};

export function render(view, store, actions) {
  let def = { name: "My effect", ...structuredClone(STARTERS["Red & blue lines"]) };
  let editingId = null; // saved effect being edited
  let target = store.config.targets[0]?.id || null;
  let live = !!target;
  let gridId = Object.keys(store.config.layouts)[0];
  store.previewRate?.(20);

  const canvas = h("canvas", { class: "grid-canvas" });
  const ctx = canvas.getContext("2d");
  const editor = h("div");
  const wrap = h("div", { class: "grid-wrap" }, canvas);
  view.replaceChildren(h("div", { class: "grid-layout" },
    h("div", { class: "grid-main" }, wrap),
    h("aside", { class: "grid-side" }, editor)));
  const wide = window.matchMedia("(min-width: 1000px)");

  // --- live preview on the real lights (the hub renders the draft)
  let timer = null, pendingSend = false;
  function send() {
    if (!live || !target) return;
    if (timer) { pendingSend = true; return; }
    put(`targets/${target}/state`, {
      on: true,
      effect: { source: "hub", id: "studio", params: { custom_id: null, layers: def.layers, background: def.background } },
    }).catch((e) => toast(e.message));
    timer = setTimeout(() => { timer = null; if (pendingSend) { pendingSend = false; send(); } }, 120);
  }

  // --- preview canvas: the mapped LEDs with their live colours
  let scale = 1, ox = 0, oy = 0;
  function resize() {
    const dpr = window.devicePixelRatio || 1;
    const L = store.config.layouts[gridId] || Object.values(store.config.layouts)[0];
    const w = canvas.clientWidth;
    const hgt = wide.matches ? Math.max(200, wrap.clientHeight - 16) : Math.min(window.innerHeight * 0.4, (w * L.height) / L.width);
    canvas.style.height = `${hgt}px`;
    canvas.width = w * dpr; canvas.height = hgt * dpr;
    // zoom to the mapped LEDs
    const pts = allCoords();
    const xs = pts.map((p) => p[0]), ys = pts.map((p) => p[1]);
    const [x0, x1, y0, y1] = pts.length ? [Math.min(...xs), Math.max(...xs), Math.min(...ys), Math.max(...ys)] : [0, L.width, 0, L.height];
    const bw = Math.max(x1 - x0, 0.1), bh = Math.max(y1 - y0, 0.1);
    scale = Math.min(canvas.width / (bw * 1.15), canvas.height / (bh * 1.15));
    ox = canvas.width / 2 - ((x0 + x1) / 2) * scale;
    oy = canvas.height / 2 - ((y0 + y1) / 2) * scale;
    draw();
  }
  let coordCache = null;
  function allCoords() {
    if (coordCache) return coordCache.flatMap((c) => c.coords);
    coordCache = [];
    for (const p of (store.config.layouts[gridId] || Object.values(store.config.layouts)[0]).placements) {
      const d = store.config.devices[p.device_id];
      if (!d) continue;
      coordCache.push({ p, coords: placementCoords(p, d.led_count) });
    }
    return coordCache.flatMap((c) => c.coords);
  }
  function draw() {
    const dpr = window.devicePixelRatio || 1;
    ctx.fillStyle = "#000"; ctx.fillRect(0, 0, canvas.width, canvas.height);
    allCoords();
    const r = Math.max(1.5, Math.min(7, scale * 0.06));
    for (const { p, coords } of coordCache) {
      const frame = store.preview[p.device_id] ? atob(store.preview[p.device_id]) : null;
      const n = ledCount(p, store.config.devices[p.device_id]?.led_count || 0);
      coords.forEach((c, i) => {
        const idx = (p.start || 0) + (p.reverse ? n - 1 - i : i);
        let R = 25, G = 25, B = 25;
        if (frame && frame.length >= idx * 3 + 3) { R = frame.charCodeAt(idx * 3); G = frame.charCodeAt(idx * 3 + 1); B = frame.charCodeAt(idx * 3 + 2); }
        ctx.fillStyle = `rgb(${R},${G},${B})`;
        ctx.beginPath(); ctx.arc(ox + c[0] * scale, oy + c[1] * scale, r, 0, 2 * Math.PI); ctx.fill();
      });
    }
    ctx.fillStyle = "rgba(255,255,255,.55)"; ctx.font = `${11 * dpr}px sans-serif`;
    ctx.fillText(live && target ? "Live on the lights" : "Preview off – pick a room and turn on live preview", 10 * dpr, 18 * dpr);
  }

  // --- editor
  const changed = () => { send(); };

  function colourList(layer) {
    if (layer.type === "solid") {
      const i = h("input", { type: "color", value: layer.color });
      i.addEventListener("input", () => { layer.color = i.value; changed(); });
      return h("div", { class: "field" }, h("label", {}, "Colour"), i);
    }
    const row = h("div", { class: "row", style: { flexWrap: "wrap", gap: "6px" } });
    const paint = () => fill(row,
      layer.colors.map((c, k) => {
        const i = h("input", { type: "color", value: c, title: "Click to change" });
        i.addEventListener("input", () => { layer.colors[k] = i.value; changed(); });
        return h("span", { class: "row", style: { gap: "2px" } }, i,
          layer.colors.length > 1 ? h("button", { class: "icon-btn", style: { width: "26px", height: "26px" }, title: "Remove colour",
            onclick: () => { layer.colors.splice(k, 1); paint(); changed(); } }, "×") : null);
      }),
      layer.colors.length < 12 ? h("button", { class: "btn small secondary", onclick: () => { layer.colors.push("#ffffff"); paint(); changed(); } }, "+ colour") : null);
    paint();
    return h("div", { class: "field" }, h("label", {}, layer.type === "gradient" ? "Colour stops" : "Colours (each line/ring/band takes the next)"), row);
  }

  function rangeField(layer, [key, label, min, max, step]) {
    const value = layer[key] ?? min;
    const out = h("span", { class: "muted" }, String(value));
    const input = h("input", { type: "range", min, max, step, value });
    input.addEventListener("input", () => { layer[key] = Number(input.value); out.textContent = input.value; changed(); });
    return h("div", { class: "field" }, h("label", { class: "row", style: { justifyContent: "space-between" } }, label, out), input);
  }

  function layerCard(layer, index) {
    const meta = LAYERS[layer.type];
    const enabled = h("input", { type: "checkbox", checked: layer.enabled !== false, title: "Layer on/off" });
    enabled.addEventListener("change", () => { layer.enabled = enabled.checked; changed(); });
    const blend = h("select", {}, h("option", { value: "over", selected: layer.blend !== "add" }, "On top"), h("option", { value: "add", selected: layer.blend === "add" }, "Add light"));
    blend.addEventListener("change", () => { layer.blend = blend.value; changed(); });
    const move = (d) => { const j = index + d; if (j < 0 || j >= def.layers.length) return; [def.layers[index], def.layers[j]] = [def.layers[j], def.layers[index]]; drawEditor(); changed(); };
    return h("div", { class: "list", style: { padding: "10px 12px", marginBottom: "10px" } },
      h("div", { class: "row", style: { gap: "6px" } }, enabled,
        h("strong", { style: { flex: 1 } }, `${index + 1}. ${meta.name}`),
        h("button", { class: "icon-btn", style: { width: "30px", height: "30px" }, title: "Move down (drawn earlier)", onclick: () => move(-1) }, "↑"),
        h("button", { class: "icon-btn", style: { width: "30px", height: "30px" }, title: "Move up (drawn later, on top)", onclick: () => move(1) }, "↓"),
        h("button", { class: "icon-btn", style: { width: "30px", height: "30px" }, title: "Duplicate", onclick: () => { def.layers.splice(index + 1, 0, structuredClone(layer)); drawEditor(); changed(); } }, "⧉"),
        h("button", { class: "icon-btn", style: { width: "30px", height: "30px" }, title: "Delete layer", onclick: () => { def.layers.splice(index, 1); drawEditor(); changed(); } }, "×")),
      h("p", { class: "muted", style: { margin: "4px 0 0", fontSize: "13px" } }, meta.hint),
      colourList(layer),
      CONTROLS[layer.type].map((spec) => rangeField(layer, spec)),
      layer.type === "lines" ? (() => {
        const b = h("input", { type: "checkbox", checked: !!layer.bounce });
        b.addEventListener("change", () => { layer.bounce = b.checked; changed(); });
        return h("label", { class: "row", style: { margin: "6px 0" } }, b, "Bounce back and forth");
      })() : null,
      rangeField(layer, ["opacity", "Opacity", 0, 1, 0.05]),
      h("div", { class: "field" }, h("label", {}, "Blend"), blend));
  }

  function drawEditor() {
    const targets = store.config.targets;
    const targetSel = h("select", {}, h("option", { value: "" }, "– no live preview –"),
      targets.map((t) => h("option", { value: t.id, selected: t.id === target }, t.name)));
    targetSel.addEventListener("change", () => { target = targetSel.value || null; live = !!target; send(); draw(); });
    const name = h("input", { type: "text", value: def.name, placeholder: "Name" });
    name.addEventListener("change", () => (def.name = name.value.trim() || "My effect"));
    const bg = h("input", { type: "color", value: def.background || "#000000" });
    bg.addEventListener("input", () => { def.background = bg.value; changed(); });
    const addSel = h("select", {}, h("option", { value: "" }, "+ Add layer…"), Object.entries(LAYERS).map(([k, v]) => h("option", { value: k }, v.name)));
    addSel.addEventListener("change", () => { if (!addSel.value) return; def.layers.push(LAYERS[addSel.value].make()); drawEditor(); changed(); });
    const starter = h("select", {}, h("option", { value: "" }, "Start from…"), Object.keys(STARTERS).map((k) => h("option", { value: k }, k)));
    starter.addEventListener("change", () => {
      if (!starter.value) return;
      def = { name: starter.value === "Empty" ? "My effect" : starter.value, ...structuredClone(STARTERS[starter.value]) };
      editingId = null; drawEditor(); changed();
    });
    const saved = Object.entries(store.config.custom_effects || {});
    fill(editor,
      h("div", { class: "section-title" }, "Preview on"),
      h("div", { class: "row" }, targetSel, gridSel()),
      h("p", { class: "muted", style: { fontSize: "13px" } }, "The chosen room shows the effect live while you edit. Positions run across the whole house (0 = one end, 1 = the other)."),
      h("div", { class: "section-title" }, editingId ? "Editing saved effect" : "New effect"),
      h("div", { class: "row", style: { flexWrap: "wrap" } }, name,
        h("button", { class: "btn small", onclick: () => save(false) }, editingId ? "Save" : "Save effect"),
        editingId ? h("button", { class: "btn small secondary", onclick: () => save(true) }, "Save as new") : null,
        starter),
      h("div", { class: "field" }, h("label", {}, "Background colour"), bg),
      def.layers.map(layerCard),
      def.layers.length ? null : h("p", { class: "muted" }, "No layers yet – add one below."),
      h("div", { class: "row" }, addSel),
      h("div", { class: "section-title" }, "My effects"),
      saved.length ? h("div", { class: "list" }, saved.map(([id, e]) => h("div", { class: "list-item" },
        h("div", { class: "grow" }, e.name, h("div", { class: "muted" }, `${(e.layers || []).length} layer(s)`)),
        h("button", { class: "btn small secondary", onclick: () => { def = structuredClone(e); editingId = id; drawEditor(); changed(); } }, "Edit"),
        h("button", { class: "btn small danger", onclick: async () => {
          if (!confirm(`Delete the effect ${e.name}?`)) return;
          await del(`custom-effects/${id}`).catch((err) => toast(err.message));
          if (editingId === id) editingId = null;
        } }, "Delete")))) : h("p", { class: "muted" }, "Nothing saved yet. Saved effects can be picked in every room under “My effects”."),
    );
  }

  function gridSel() {
    const grids = Object.values(store.config.layouts);
    if (grids.length < 2) return null;
    const s = h("select", { title: "Which grid the preview shows" }, grids.map((g) => h("option", { value: g.id, selected: g.id === gridId }, g.name)));
    s.addEventListener("change", () => { gridId = s.value; coordCache = null; resize(); });
    return s;
  }

  async function save(asNew) {
    try {
      const res = await post("custom-effects", { ...def, id: asNew ? undefined : editingId || undefined });
      editingId = res.id;
      toast(`Saved “${def.name}” – pick it in a room under My effects`);
    } catch (e) { toast(e.message); }
  }

  // the hub echoes every slider move: only redraw the editor once the user lets go
  function onConfig() { coordCache = null; drawEditor(); resize(); }
  const unsubs = [
    store.onPreview(() => draw()),
    store.subscribe(() => store.whenIdle(onConfig)),
  ];
  const ro = new ResizeObserver(resize);
  ro.observe(wrap);
  wide.addEventListener("change", resize);
  drawEditor();
  send();
  return () => {
    unsubs.forEach((u) => u()); ro.disconnect(); wide.removeEventListener("change", resize);
    clearTimeout(timer);
    store.previewRate?.(8);
  };
}
