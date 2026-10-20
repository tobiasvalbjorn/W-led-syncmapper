import { connect, get } from "./api.js";
import { h } from "./ui.js";
import * as rooms from "./views/rooms.js";
import * as grid from "./views/grid.js";
import * as devices from "./views/devices.js";
import * as settings from "./views/settings.js";
import * as studio from "./views/studio.js";

const VIEWS = { rooms, grid, studio, devices, settings };

// Shared app state. Views read from it and subscribe for updates.
export const store = {
  config: null,
  effects: { hub: [], wled: [], palettes: [] },
  preview: {},
  listeners: new Set(),
  previewListeners: new Set(),
  interacting: 0, // >0 while the user drags a slider: don't re-render under their finger
  subscribe(fn) { this.listeners.add(fn); return () => this.listeners.delete(fn); },
  onPreview(fn) { this.previewListeners.add(fn); return () => this.previewListeners.delete(fn); },
  previewRate(fps) { link?.preview(true, fps); }, // e.g. faster while peeking
  // back to whatever the current view wants (after a sheet with a live preview closes)
  previewDone() { link?.preview(!!VIEWS[current]?.wantsPreview, 8); },
};

let current = null;
let cleanup = null;
let link = null;

function show(tab) {
  if (!VIEWS[tab]) tab = "rooms";
  current = tab;
  document.body.dataset.view = tab; // lets CSS give the grid editor the full width
  document.querySelectorAll("#tabbar button").forEach((b) => b.classList.toggle("active", b.dataset.tab === tab));
  document.getElementById("title").textContent = VIEWS[tab].title;
  document.getElementById("topbar-actions").replaceChildren();
  cleanup?.();
  const view = document.getElementById("view");
  view.replaceChildren();
  if (!store.config) {
    view.append(h("div", { class: "empty" }, "Connecting to hub…"));
    cleanup = null;
    return;
  }
  link?.preview(!!VIEWS[tab].wantsPreview, 8);
  cleanup = VIEWS[tab].render(view, store, document.getElementById("topbar-actions")) || null;
}

document.getElementById("tabbar").addEventListener("click", (e) => {
  const btn = e.target.closest("button[data-tab]");
  if (btn) location.hash = btn.dataset.tab;
});
window.addEventListener("hashchange", () => show(location.hash.slice(1)));
document.addEventListener("pointerup", () => setTimeout(() => (store.interacting = 0), 300));

async function loadEffects() {
  try {
    store.effects = await get("effects");
  } catch { /* hub offline: retried on next config */ }
}

link = connect({
  onStatus(ok) {
    document.getElementById("conn").classList.toggle("ok", ok);
    if (ok) loadEffects();
  },
  onConfig(config) {
    const first = !store.config;
    store.config = config;
    if (first) return show(location.hash.slice(1) || "rooms");
    store.listeners.forEach((fn) => fn(config));
  },
  onPreview(frames) {
    store.preview = frames;
    store.previewListeners.forEach((fn) => fn(frames));
  },
});

// Theme: follow the system unless the user picked one in settings.
try {
  const theme = localStorage.getItem("wledhub-theme");
  if (theme) document.documentElement.dataset.theme = theme;
} catch { /* storage blocked */ }

if ("serviceWorker" in navigator && window.isSecureContext) {
  navigator.serviceWorker.register("sw.js").catch(() => {});
}

show(location.hash.slice(1) || "rooms");
