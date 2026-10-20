import { patch } from "../api.js";
import { h, toast } from "../ui.js";

export const title = "Indstillinger";

export function render(view, store) {
  const s = store.config.settings;
  const fps = h("input", { type: "number", min: 5, max: 60, value: s.fps });
  const theme = h("select", {},
    [["", "Følg system"], ["light", "Lyst"], ["dark", "Mørkt"]].map(([v, l]) =>
      h("option", { value: v, selected: (document.documentElement.dataset.theme || "") === v }, l)));
  theme.addEventListener("change", () => {
    if (theme.value) document.documentElement.dataset.theme = theme.value;
    else delete document.documentElement.dataset.theme;
    try { localStorage.setItem("wledhub-theme", theme.value); } catch { /* ignore */ }
  });

  view.replaceChildren(
    h("div", { class: "section-title" }, "Udseende"),
    h("div", { class: "list" }, h("div", { class: "list-item" }, h("div", { class: "grow" }, "Tema"), theme)),
    h("div", { class: "section-title" }, "Synkronisering"),
    h("div", { class: "list" },
      h("div", { class: "list-item" },
        h("div", { class: "grow" }, "Billeder pr. sekund", h("div", { class: "muted" }, "For hub-effekter (DDP). 30–40 er glat; lavere sparer WiFi.")),
        fps)),
    h("button", { class: "btn", style: { marginTop: "12px" }, onclick: async () => {
      try { await patch("settings", { fps: Number(fps.value) }); toast("Gemt"); } catch (e) { toast(e.message); }
    } }, "Gem"),
    h("div", { class: "section-title" }, "Om"),
    h("div", { class: "list" },
      h("div", { class: "list-item" }, h("div", { class: "grow" }, "Hub-version"), h("span", { class: "muted" }, store.config.hub.version)),
      h("div", { class: "list-item" }, h("div", { class: "grow" }, "Installer som app"),
        h("span", { class: "muted" }, "Del → Føj til hjemmeskærm (iOS) / ⋮ → Installer app (Android)"))),
  );
}
