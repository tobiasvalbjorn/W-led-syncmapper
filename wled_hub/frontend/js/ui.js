// Tiny DOM helpers – no framework, no build step.

export function h(tag, attrs = {}, ...children) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs || {})) {
    if (v === undefined || v === null || v === false) continue;
    if (k === "class") el.className = v;
    else if (k === "style" && typeof v === "object") Object.assign(el.style, v);
    else if (k.startsWith("on") && typeof v === "function") el.addEventListener(k.slice(2), v);
    else if (k === "html") el.innerHTML = v;
    else if (v === true) el.setAttribute(k, "");
    else el.setAttribute(k, v);
  }
  for (const c of children.flat(Infinity)) {
    if (c === null || c === undefined || c === false) continue;
    el.append(c instanceof Node ? c : document.createTextNode(String(c)));
  }
  return el;
}

const ICONS = {
  sofa: '<path d="M4 11V8a2 2 0 0 1 2-2h12a2 2 0 0 1 2 2v3"/><path d="M2 13a2 2 0 0 1 4 0v2h12v-2a2 2 0 0 1 4 0v5H2z"/><path d="M5 18v2M19 18v2"/>',
  bed: '<path d="M3 18V6M3 12h18v6M21 18v-4a2 2 0 0 0-2-2H10v0"/><circle cx="7" cy="10" r="2"/>',
  kitchen: '<path d="M7 3v8M5 3v4a2 2 0 0 0 4 0V3M7 11v10M17 3c-2 2-2 6 0 8v10"/>',
  tree: '<path d="M12 2l6 9h-3l4 6H5l4-6H6z"/><path d="M12 17v5"/>',
  house: '<path d="M3 11l9-7 9 7v9a1 1 0 0 1-1 1H4a1 1 0 0 1-1-1z"/>',
  garage: '<path d="M3 21V9l9-6 9 6v12"/><path d="M7 21v-8h10v8M7 16h10"/>',
  window: '<rect x="4" y="3" width="16" height="18" rx="1"/><path d="M12 3v18M4 12h16"/>',
  star: '<path d="M12 3l2.7 5.6 6.1.9-4.4 4.3 1 6.1L12 17l-5.4 2.9 1-6.1L3.2 9.5l6.1-.9z"/>',
  plus: '<path d="M12 5v14M5 12h14"/>',
  link: '<path d="M10 13a5 5 0 0 0 7.5.5l3-3a5 5 0 0 0-7-7l-1.7 1.7"/><path d="M14 11a5 5 0 0 0-7.5-.5l-3 3a5 5 0 0 0 7 7l1.7-1.7"/>',
  sun: '<circle cx="12" cy="12" r="4"/><path d="M12 2v2M12 20v2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M2 12h2M20 12h2M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4"/>',
  camera: '<path d="M4 7h3l2-3h6l2 3h3a1 1 0 0 1 1 1v11a1 1 0 0 1-1 1H4a1 1 0 0 1-1-1V8a1 1 0 0 1 1-1z"/><circle cx="12" cy="13" r="4"/>',
  trash: '<path d="M4 7h16M10 11v6M14 11v6M5 7l1 13h12l1-13M9 7V4h6v3"/>',
  close: '<path d="M6 6l12 12M18 6L6 18"/>',
  bolt: '<path d="M13 2L4 14h7l-1 8 9-12h-7z"/>',
  search: '<circle cx="11" cy="11" r="7"/><path d="M20 20l-3.5-3.5"/>',
  edit: '<path d="M4 20h4L19 9l-4-4L4 16z"/>',
};
export const ROOM_ICONS = ["sofa", "bed", "kitchen", "tree", "house", "garage", "window", "star"];

export function icon(name) {
  const span = document.createElement("span");
  span.style.display = "contents";
  span.innerHTML = `<svg viewBox="0 0 24 24">${ICONS[name] || ICONS.star}</svg>`;
  return span.firstChild;
}

export function toast(message, ms = 2500) {
  const el = document.getElementById("toast");
  el.textContent = message;
  el.classList.add("show");
  clearTimeout(el._t);
  el._t = setTimeout(() => el.classList.remove("show"), ms);
}

export function sheet(content, { onClose } = {}) {
  const root = document.getElementById("sheet-root");
  const backdrop = h("div", { class: "sheet-backdrop" });
  const panel = h("div", { class: "sheet", role: "dialog" }, h("div", { class: "sheet-grip" }), content);
  const close = () => {
    backdrop.remove();
    panel.remove();
    onClose?.();
  };
  backdrop.addEventListener("click", close);
  // swipe down on the grip area to close
  let startY = null;
  panel.addEventListener("touchstart", (e) => { if (panel.scrollTop <= 0) startY = e.touches[0].clientY; }, { passive: true });
  panel.addEventListener("touchend", (e) => {
    if (startY !== null && e.changedTouches[0].clientY - startY > 90) close();
    startY = null;
  });
  root.append(backdrop, panel);
  return { close, panel };
}

export function toggle(checked, onchange) {
  const input = h("input", { type: "checkbox", checked });
  input.addEventListener("change", () => onchange(input.checked));
  return h("label", { class: "toggle", onclick: (e) => e.stopPropagation() }, input, h("span"));
}

export function slider({ value, min = 0, max = 255, oninput, label }) {
  const input = h("input", { type: "range", min, max, value, "aria-label": label });
  input.addEventListener("input", () => oninput(Number(input.value)));
  input.addEventListener("click", (e) => e.stopPropagation());
  return input;
}

export const rgbCss = (c) => `rgb(${c[0]},${c[1]},${c[2]})`;

export function hexToRgb(hex) {
  const n = parseInt(hex.slice(1), 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}
export const rgbToHex = (c) => "#" + c.map((v) => v.toString(16).padStart(2, "0")).join("");

export function confirmDialog(message) {
  return Promise.resolve(window.confirm(message));
}

// replaceChildren that skips null/false (conditional children)
export function fill(el, ...children) {
  el.replaceChildren(...children.flat().filter((c) => c !== null && c !== undefined && c !== false));
}
