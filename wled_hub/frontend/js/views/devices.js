// "Devices": discovered + added WLED devices, grouped by room. Rooms can be
// created, renamed and deleted here too, and devices dragged (or picked) into them.
import { del, get, patch, post } from "../api.js";
import { ROOM_ICONS, h, icon, sheet, toast } from "../ui.js";
import { openDeviceSettings } from "./devicesettings.js";
import { newRoomSheet } from "./rooms.js";

export const title = "Devices";

export function render(view, store, actions) {
  actions.append(
    h("button", { class: "btn secondary small", title: "Create a room", onclick: () => newRoomSheet() }, "+ Room"),
    h("button", { class: "icon-btn", title: "Add a device by IP", onclick: () => addSheet() }, icon("plus")),
  );

  const draw = () => {
    const { config } = store;
    const rooms = Object.values(config.rooms).sort((a, b) => a.order - b.order);
    const devices = Object.values(config.devices).sort((a, b) => a.name.localeCompare(b.name));

    const sections = [];
    if (config.discovered.length) {
      sections.push(h("div", { class: "section-title" }, "Found on the network"),
        h("div", { class: "list" }, config.discovered.map((d) => h("div", { class: "list-item" },
          icon("bolt"),
          h("div", { class: "grow" }, d.name, h("div", { class: "muted" }, d.host)),
          h("button", { class: "btn small", onclick: async () => {
            try { await post("devices", { host: d.host, port: Number(d.port) || 80 }); toast(`${d.name} added`); }
            catch (e) { toast(e.message); }
          } }, "Add")))));
    }

    // One drop zone per room (+ "Not in a room"), Sonos-like.
    for (const room of [...rooms, { id: null, name: "Not in a room" }]) {
      const inRoom = devices.filter((d) => (d.room_id || null) === room.id);
      const zone = h("div", { class: "list", "data-room": room.id ?? "" },
        inRoom.length ? inRoom.map((d) => deviceRow(d, rooms)) : h("div", { class: "list-item muted" }, "Drag a device here or pick this room in a device's list"));
      const header = h("div", { class: "row room-header" },
        room.id ? h("span", { class: "room-header-icon" }, icon(room.icon)) : null,
        h("div", { class: "section-title", style: { flex: 1, margin: 0 } }, `${room.name} · ${inRoom.length}`),
        room.id ? h("button", { class: "btn secondary small", onclick: () => editRoomSheet(store, room.id) }, "Edit") : null);
      sections.push(header, zone);
    }
    if (!rooms.length) {
      sections.push(h("p", { class: "muted", style: { textAlign: "center" } },
        "Tip: create rooms with “+ Room” and move devices into them – each room becomes a light in Home Assistant."));
    }
    if (!devices.length && !config.discovered.length) {
      sections.unshift(h("div", { class: "empty" }, "No WLED devices yet. The hub searches automatically via mDNS – or tap + to add an IP."));
    }
    view.replaceChildren(...sections);
  };

  function deviceRow(d, rooms) {
    const select = h("select", { "aria-label": "Room" },
      h("option", { value: "" }, "Not in a room"),
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

function editRoomSheet(store, roomId) {
  const room = store.config.rooms[roomId];
  if (!room) return;
  const name = h("input", { type: "text", value: room.name });
  let chosen = room.icon;
  const icons = h("div", { class: "swatches" }, ROOM_ICONS.map((key) =>
    h("button", { class: "icon-btn", style: { outline: key === chosen ? "2px solid var(--on)" : "" },
      onclick: (e) => {
        chosen = key;
        icons.querySelectorAll("button").forEach((b) => (b.style.outline = ""));
        e.currentTarget.style.outline = "2px solid var(--on)";
      } }, icon(key))));
  const inRoom = Object.values(store.config.devices).filter((d) => d.room_id === roomId);
  const s = sheet(h("div", {},
    h("h2", {}, "Edit room"),
    h("div", { class: "field" }, h("label", {}, "Name"), name),
    h("div", { class: "field" }, h("label", {}, "Icon"), icons),
    h("p", { class: "muted" }, inRoom.length ? `${inRoom.length} device(s): ${inRoom.map((d) => d.name).join(", ")}` : "No devices in this room yet."),
    h("div", { class: "row", style: { flexWrap: "wrap" } },
      h("button", { class: "btn", onclick: async () => {
        try {
          await patch(`rooms/${roomId}`, { name: name.value.trim() || room.name, icon: chosen });
          toast("Room saved"); s.close();
        } catch (e) { toast(e.message); }
      } }, "Save"),
      h("button", { class: "btn danger", onclick: async () => {
        if (!confirm(`Delete the room ${room.name}? Its devices are kept and move to "Not in a room".`)) return;
        try { await del(`rooms/${roomId}`); toast("Room deleted"); s.close(); } catch (e) { toast(e.message); }
      } }, "Delete room")),
  ));
  setTimeout(() => name.focus(), 250);
}

function addSheet() {
  const host = h("input", { type: "text", placeholder: "192.168.1.50 or wled-livingroom.local", inputmode: "url" });
  const s = sheet(h("div", {},
    h("h2", {}, "Add WLED device"),
    h("div", { class: "field" }, h("label", {}, "IP address or hostname"), host),
    h("button", { class: "btn", onclick: async () => {
      try { const d = await post("devices", { host: host.value.trim() }); toast(`${d.name} added`); s.close(); }
      catch (e) { toast(e.message); }
    } }, "Add")));
  setTimeout(() => host.focus(), 250);
}

async function deviceSheet(store, id) {
  const d = store.config.devices[id];
  const name = h("input", { type: "text", value: d.name });
  const outputs = h("div", { class: "muted" }, "Loading outputs…");
  const s = sheet(h("div", {},
    h("h2", {}, d.name),
    h("p", { class: "muted" }, `WLED ${d.version} · ${d.host} · ${d.mac}`),
    h("div", { class: "field" }, h("label", {}, "Name in the hub"), name),
    h("div", { class: "field" }, h("label", {}, "LED outputs (light strings on the ESP)"), outputs),
    h("div", { class: "row", style: { flexWrap: "wrap" } },
      h("button", { class: "btn", onclick: async () => { await patch(`devices/${id}`, { name: name.value.trim() }); toast("Saved"); } }, "Save"),
      h("button", { class: "btn secondary", onclick: () => { s.close(); openDeviceSettings(store, id); } }, "All WLED settings"),
      h("button", { class: "btn secondary", onclick: () => post(`devices/${id}/identify`).then(() => toast("Blinking for 3 seconds")) }, "Identify"),
      h("a", { class: "btn secondary", href: `http://${d.host}/`, target: "_blank", rel: "noopener" }, "Open WLED"),
      h("button", { class: "btn danger", onclick: async () => {
        if (!confirm(`Remove ${d.name} from the hub?`)) return;
        await del(`devices/${id}`); s.close();
      } }, "Remove")),
  ));
  try {
    const outs = await get(`devices/${id}/outputs`);
    outputs.replaceChildren(h("div", { class: "list" }, outs.map((o) => h("div", { class: "list-item" },
      h("div", { class: "grow" }, `Output ${o.index + 1}${o.pin !== null ? ` (GPIO ${o.pin})` : ""}`),
      h("span", {}, `LED ${o.start}–${o.start + o.count - 1}`)))),
      h("p", { class: "muted" }, "Each light string can be placed separately on the Grid tab."));
  } catch (e) {
    outputs.textContent = `Could not load outputs: ${e.message}`;
  }
}
