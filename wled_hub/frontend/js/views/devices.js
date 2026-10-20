// "Enheder": discovered + added WLED devices; drag (or pick) a room for each.
import { del, get, patch, post } from "../api.js";
import { h, icon, sheet, toast } from "../ui.js";

export const title = "Enheder";

export function render(view, store, actions) {
  actions.append(h("button", { class: "icon-btn", title: "Tilføj via IP", onclick: () => addSheet() }, icon("plus")));

  const draw = () => {
    const { config } = store;
    const rooms = Object.values(config.rooms).sort((a, b) => a.order - b.order);
    const devices = Object.values(config.devices).sort((a, b) => a.name.localeCompare(b.name));

    const sections = [];
    if (config.discovered.length) {
      sections.push(h("div", { class: "section-title" }, "Fundet på netværket"),
        h("div", { class: "list" }, config.discovered.map((d) => h("div", { class: "list-item" },
          icon("bolt"),
          h("div", { class: "grow" }, d.name, h("div", { class: "muted" }, d.host)),
          h("button", { class: "btn small", onclick: async () => {
            try { await post("devices", { host: d.host, port: Number(d.port) || 80 }); toast(`${d.name} tilføjet`); }
            catch (e) { toast(e.message); }
          } }, "Tilføj")))));
    }

    // One drop zone per room (+ "Uden rum"), Sonos-like.
    for (const room of [...rooms, { id: null, name: "Uden rum" }]) {
      const inRoom = devices.filter((d) => (d.room_id || null) === room.id);
      const zone = h("div", { class: "list", "data-room": room.id ?? "" },
        inRoom.length ? inRoom.map((d) => deviceRow(d, rooms)) : h("div", { class: "list-item muted" }, "Træk en enhed hertil"));
      sections.push(h("div", { class: "section-title" }, room.name), zone);
    }
    if (!devices.length && !config.discovered.length) {
      sections.unshift(h("div", { class: "empty" }, "Ingen WLED-enheder endnu. Hub'en leder automatisk via mDNS – eller tryk + for at tilføje en IP."));
    }
    view.replaceChildren(...sections);
  };

  function deviceRow(d, rooms) {
    const select = h("select", { "aria-label": "Rum" },
      h("option", { value: "" }, "Uden rum"),
      rooms.map((r) => h("option", { value: r.id, selected: r.id === d.room_id }, r.name)));
    select.addEventListener("change", () => move(d, select.value || null));
    const row = h("div", { class: "list-item", draggable: "true" },
      h("span", { class: `dot${d.online ? " on" : ""}`, title: d.online ? "Online" : "Offline" }),
      h("div", { class: "grow", onclick: () => deviceSheet(store, d.id) },
        h("div", {}, d.name),
        h("div", { class: "muted" }, `${d.host} · ${d.led_count} LEDs${d.matrix ? ` · ${d.matrix.w}×${d.matrix.h}` : ""}${d.live ? " · live" : ""}`)),
      select);
    row.addEventListener("dragstart", (e) => e.dataTransfer.setData("text/device", d.id));
    return row;
  }

  async function move(d, roomId) {
    try { await patch(`devices/${d.id}`, { room_id: roomId }); }
    catch (e) { toast(e.message); }
  }

  // Desktop drag & drop between rooms (on phones the room picker is used).
  view.addEventListener("dragover", (e) => { if (e.target.closest("[data-room]")) e.preventDefault(); });
  view.addEventListener("drop", (e) => {
    const zone = e.target.closest("[data-room]");
    const id = e.dataTransfer.getData("text/device");
    if (zone && id) move(store.config.devices[id], zone.dataset.room || null);
  });

  draw();
  return store.subscribe(draw);
}

function addSheet() {
  const host = h("input", { type: "text", placeholder: "192.168.1.50 eller wled-stue.local", inputmode: "url" });
  const s = sheet(h("div", {},
    h("h2", {}, "Tilføj WLED-enhed"),
    h("div", { class: "field" }, h("label", {}, "IP-adresse eller hostname"), host),
    h("button", { class: "btn", onclick: async () => {
      try { const d = await post("devices", { host: host.value.trim() }); toast(`${d.name} tilføjet`); s.close(); }
      catch (e) { toast(e.message); }
    } }, "Tilføj")));
  setTimeout(() => host.focus(), 250);
}

async function deviceSheet(store, id) {
  const d = store.config.devices[id];
  const name = h("input", { type: "text", value: d.name });
  const outputs = h("div", { class: "muted" }, "Henter outputs…");
  const s = sheet(h("div", {},
    h("h2", {}, d.name),
    h("p", { class: "muted" }, `WLED ${d.version} · ${d.host} · ${d.mac}`),
    h("div", { class: "field" }, h("label", {}, "Navn i hub'en"), name),
    h("div", { class: "field" }, h("label", {}, "LED-outputs (lyskæder på ESP'en)"), outputs),
    h("div", { class: "row", style: { flexWrap: "wrap" } },
      h("button", { class: "btn", onclick: async () => { await patch(`devices/${id}`, { name: name.value.trim() }); toast("Gemt"); } }, "Gem"),
      h("button", { class: "btn secondary", onclick: () => post(`devices/${id}/identify`).then(() => toast("Blinker i 3 sekunder")) }, "Identificér"),
      h("a", { class: "btn secondary", href: `http://${d.host}/`, target: "_blank", rel: "noopener" }, "Åbn WLED"),
      h("button", { class: "btn danger", onclick: async () => {
        if (!confirm(`Fjern ${d.name} fra hub'en?`)) return;
        await del(`devices/${id}`); s.close();
      } }, "Fjern")),
  ));
  try {
    const outs = await get(`devices/${id}/outputs`);
    outputs.replaceChildren(h("div", { class: "list" }, outs.map((o) => h("div", { class: "list-item" },
      h("div", { class: "grow" }, `Output ${o.index + 1}${o.pin !== null ? ` (GPIO ${o.pin})` : ""}`),
      h("span", {}, `LED ${o.start}–${o.start + o.count - 1}`)))),
      h("p", { class: "muted" }, "Hver lyskæde kan placeres for sig i Grid-fanen."));
  } catch (e) {
    outputs.textContent = `Kunne ikke hente outputs: ${e.message}`;
  }
}
