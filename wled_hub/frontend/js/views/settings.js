import { patch } from "../api.js";
import { h, toast } from "../ui.js";

export const title = "Settings";

export function render(view, store) {
  const s = store.config.settings;
  const fps = h("input", { type: "number", min: 5, max: 60, value: s.fps });
  const theme = h("select", {},
    [["", "Follow system"], ["light", "Light"], ["dark", "Dark"]].map(([v, l]) =>
      h("option", { value: v, selected: (document.documentElement.dataset.theme || "") === v }, l)));
  theme.addEventListener("change", () => {
    if (theme.value) document.documentElement.dataset.theme = theme.value;
    else delete document.documentElement.dataset.theme;
    try { localStorage.setItem("wledhub-theme", theme.value); } catch { /* ignore */ }
  });

  view.replaceChildren(
    h("div", { class: "section-title" }, "Appearance"),
    h("div", { class: "list" }, h("div", { class: "list-item" }, h("div", { class: "grow" }, "Theme"), theme)),
    h("div", { class: "section-title" }, "Sync"),
    h("div", { class: "list" },
      h("div", { class: "list-item" },
        h("div", { class: "grow" }, "Frames per second", h("div", { class: "muted" }, "For hub effects (DDP). 30–40 is smooth; lower saves WiFi.")),
        fps)),
    h("button", { class: "btn", style: { marginTop: "12px" }, onclick: async () => {
      try { await patch("settings", { fps: Number(fps.value) }); toast("Saved"); } catch (e) { toast(e.message); }
    } }, "Save"),
    h("div", { class: "section-title" }, "About"),
    h("div", { class: "list" },
      h("div", { class: "list-item" }, h("div", { class: "grow" }, "Hub version"), h("span", { class: "muted" }, store.config.hub.version)),
      h("div", { class: "list-item" }, h("div", { class: "grow" }, "Install as app"),
        h("span", { class: "muted" }, "Share → Add to Home Screen (iOS) / ⋮ → Install app (Android)"))),
  );
}
