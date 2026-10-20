// Full colour editor: hue/saturation wheel, a brightness slider (all the way
// down to black), R/G/B sliders, a hex field, presets and the user's own
// saved colours (stored in the hub's settings, so they follow you between
// phone and PC). All controls stay in sync.
import { patch } from "./api.js";
import { colorWheel } from "./colorwheel.js";
import { h, rgbCss, toast } from "./ui.js";

const PRESETS = [
  [0, 0, 0], [255, 255, 255], [255, 147, 41], [255, 197, 143], [255, 0, 0], [255, 80, 0],
  [255, 200, 0], [0, 255, 60], [0, 200, 255], [0, 60, 255], [140, 0, 255], [255, 0, 140],
];

const toHex = (c) => "#" + c.map((v) => Math.round(v).toString(16).padStart(2, "0")).join("");
const fromHex = (s) => {
  const m = /^#?([0-9a-f]{6})$/i.exec(s.trim());
  if (!m) return null;
  const n = parseInt(m[1], 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
};

export function colorPicker({ store, color, onchange, size = 240 }) {
  let rgb = [...color];
  const value = () => Math.max(...rgb) / 255; // HSV "value": 0 = black

  const el = h("div", { class: "colorpicker" });
  const wheel = colorWheel({ size: Math.min(size, window.innerWidth - 80), color: rgb.some((v) => v) ? rgb : [255, 255, 255], onchange: (full) => {
    // the wheel picks hue + saturation at full brightness; keep the chosen brightness
    const v = value() || 1;
    set(full.map((x) => x * v), "wheel");
  } });
  const bri = h("input", { type: "range", min: 0, max: 100, value: Math.round(value() * 100), "aria-label": "Colour brightness" });
  const briOut = h("span", { class: "muted" });
  bri.addEventListener("input", () => {
    const v = Number(bri.value) / 100;
    const cur = value();
    // scale the current colour; from black, start from white
    const base = cur > 0 ? rgb.map((x) => x / cur) : [255, 255, 255];
    set(base.map((x) => x * v), "bri");
  });
  const sliders = ["R", "G", "B"].map((label, i) => {
    const input = h("input", { type: "range", min: 0, max: 255, value: rgb[i], "aria-label": label });
    const num = h("input", { type: "number", min: 0, max: 255, value: rgb[i], style: { width: "64px" } });
    input.addEventListener("input", () => { const c = [...rgb]; c[i] = Number(input.value); set(c, "rgb"); });
    num.addEventListener("change", () => { const c = [...rgb]; c[i] = Math.max(0, Math.min(255, Number(num.value) || 0)); set(c, "rgb"); });
    return { input, num, row: h("div", { class: "row", style: { gap: "8px" } }, h("strong", { style: { width: "14px" } }, label), input, num) };
  });
  const hex = h("input", { type: "text", value: toHex(rgb), style: { width: "100px", fontFamily: "ui-monospace, monospace" }, "aria-label": "Hex colour" });
  hex.addEventListener("change", () => { const c = fromHex(hex.value); if (c) set(c, "hex"); else hex.value = toHex(rgb); });
  const swatch = h("span", { class: "swatch", style: { width: "34px", height: "34px", display: "inline-block" } });
  const presetRow = h("div", { class: "swatches" });
  const savedRow = h("div", { class: "swatches" });

  function set(c, from) {
    rgb = c.map((v) => Math.max(0, Math.min(255, Math.round(v))));
    if (from !== "wheel" && rgb.some((v) => v)) wheel.setColor(rgb);
    if (from !== "bri") bri.value = Math.round(value() * 100);
    briOut.textContent = `${Math.round(value() * 100)} %`;
    sliders.forEach((s, i) => { if (from !== "rgb" || Number(s.input.value) !== rgb[i]) s.input.value = rgb[i]; s.num.value = rgb[i]; });
    if (from !== "hex") hex.value = toHex(rgb);
    swatch.style.background = rgbCss(rgb);
    onchange([...rgb]);
  }

  const saved = () => (store.config.settings.saved_colors || []).map(fromHex).filter(Boolean);
  async function saveList(list) {
    try { await patch("settings", { saved_colors: list.map(toHex) }); } catch (e) { toast(e.message); }
  }
  function drawSwatches() {
    presetRow.replaceChildren(...PRESETS.map((c) => h("button", {
      class: "swatch", title: toHex(c), style: { background: rgbCss(c) }, onclick: () => set(c, "preset"),
    })));
    savedRow.replaceChildren(
      ...saved().map((c, i) => h("button", {
        class: "swatch", title: `${toHex(c)} – right-click or long-press to remove`, style: { background: rgbCss(c) },
        onclick: () => set(c, "preset"),
        oncontextmenu: (e) => { e.preventDefault(); const list = saved(); list.splice(i, 1); saveList(list); },
      })),
      h("button", { class: "btn small secondary", title: "Save the current colour", onclick: () => {
        const list = saved().filter((c) => toHex(c) !== toHex(rgb));
        list.unshift(rgb);
        saveList(list.slice(0, 24));
        toast("Colour saved");
      } }, "+ Save colour"));
  }
  drawSwatches();

  el.append(
    wheel,
    h("div", { class: "field" }, h("label", { class: "row", style: { justifyContent: "space-between" } }, "Brightness of the colour (down to black)", briOut), bri),
    ...sliders.map((s) => s.row),
    h("div", { class: "row", style: { gap: "8px", marginTop: "8px" } }, swatch, hex),
    h("div", { class: "field" }, h("label", {}, "Presets"), presetRow),
    h("div", { class: "field" }, h("label", {}, "My colours"), savedRow),
  );
  briOut.textContent = `${Math.round(value() * 100)} %`;
  swatch.style.background = rgbCss(rgb);

  return {
    el,
    setColor(c) { rgb = [...c]; if (rgb.some((v) => v)) wheel.setColor(rgb); bri.value = Math.round(value() * 100); sliders.forEach((s, i) => { s.input.value = rgb[i]; s.num.value = rgb[i]; }); hex.value = toHex(rgb); swatch.style.background = rgbCss(rgb); briOut.textContent = `${Math.round(value() * 100)} %`; },
    refreshSaved: drawSwatches,
  };
}
