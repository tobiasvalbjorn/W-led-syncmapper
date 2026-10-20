// Full control sheet for one room or group ("Now Playing" in Sonos terms).
import { del, patch, post, put, throttled } from "../api.js";
import { colorWheel } from "../colorwheel.js";
import { h, icon, rgbCss, sheet, slider, toast, toggle, ROOM_ICONS } from "../ui.js";

const PRESETS = [
  [255, 147, 41], [255, 197, 143], [255, 255, 255], [255, 0, 0], [255, 80, 0],
  [255, 200, 0], [0, 255, 60], [0, 200, 255], [0, 60, 255], [140, 0, 255], [255, 0, 140],
];

export function effectLabel(state, effects) {
  const e = state.effect;
  if (e.source === "hub") return effects.hub.find((x) => x.key === e.id)?.name || e.id;
  if (Number(e.id) === 0) return "Solid colour";
  return effects.wled.find((x) => x.id === Number(e.id))?.name || `Effect ${e.id}`;
}

function findTarget(config, id) {
  return config.targets.find((t) => t.id === id);
}

function stateOf(config, target) {
  return target.kind === "group" ? config.groups[target.id].state : config.rooms[target.id].state;
}

export function openTargetSheet(store, targetId) {
  let target = findTarget(store.config, targetId);
  if (!target) return;
  let state = stateOf(store.config, target);
  let tab = "color";
  let colorSlot = "color";
  let effectSource = state.effect.source;
  let filter = "";

  const send = throttled((changes) =>
    put(`targets/${targetId}/state`, changes).catch((e) => toast(e.message)), 70);
  const setLocal = (changes) => {
    Object.assign(state, changes);
    if (changes.effect) state.effect = { ...state.effect, ...changes.effect };
  };
  const change = (changes) => { store.interacting = 1; setLocal(changes); send(changes); };

  const body = h("div");
  const s = sheet(body, { onClose: () => unsubscribe() });

  const draw = () => {
    const header = h("div", { class: "row", style: { marginBottom: "6px" } },
      h("div", { style: { flex: 1 } },
        h("h2", {}, target.name),
        h("div", { class: "muted" }, `${target.device_ids.length} device(s)`)),
      toggle(state.on, (on) => change({ on })),
    );
    const bri = h("div", { class: "row" }, icon("sun"),
      slider({ value: state.brightness, min: 1, label: "Brightness", oninput: (brightness) => change({ brightness, on: true }) }));

    const tabs = h("div", { class: "segmented" },
      [["color", "Colour"], ["effects", "Effects"], ["group", "Group"], ["edit", "Edit"]].map(([key, label]) =>
        h("button", { class: tab === key ? "active" : "", onclick: () => { tab = key; draw(); } }, label)));

    const content = { color: colorTab, effects: effectsTab, group: groupTab, edit: editTab }[tab]();
    body.replaceChildren(header, bri, tabs, content);
  };

  function colorTab() {
    const wheel = colorWheel({ size: Math.min(280, window.innerWidth - 80), color: state[colorSlot], onchange: (rgb) => {
      change({ [colorSlot]: rgb, on: true });
      slotButtons.querySelectorAll(".swatch")[colorSlot === "color" ? 0 : 1].style.background = rgbCss(rgb);
    } });
    const slotButtons = h("div", { class: "row", style: { justifyContent: "center", gap: "18px" } },
      ["color", "color2"].map((slot, i) => h("button", {
        class: `swatch${colorSlot === slot ? " active" : ""}`,
        style: { background: rgbCss(state[slot]), width: "44px", height: "44px" },
        title: i ? "Colour 2 (background / effect)" : "Colour 1",
        onclick: () => { colorSlot = slot; draw(); },
      })));
    const presets = h("div", { class: "swatches" }, PRESETS.map((c) =>
      h("button", { class: "swatch", style: { background: rgbCss(c) }, onclick: () => {
        change({ [colorSlot]: c, on: true });
        wheel.setColor(c);
        draw();
      } })));
    const solid = h("button", { class: "btn secondary small", style: { display: "block", margin: "12px auto 0" },
      onclick: () => { change({ on: true, effect: { source: "wled", id: 0 } }); toast("Solid colour"); } }, "Use as solid colour");
    return h("div", {},
      h("p", { class: "muted", style: { textAlign: "center", margin: "4px 0" } }, "Colour 1 · Colour 2"),
      slotButtons, wheel, presets, solid);
  }

  function effectsTab() {
    const effects = store.effects;
    const srcTabs = h("div", { class: "segmented" },
      h("button", { class: effectSource === "hub" ? "active" : "", onclick: () => { effectSource = "hub"; draw(); } }, "Across the grid (hub)"),
      h("button", { class: effectSource === "wled" ? "active" : "", onclick: () => { effectSource = "wled"; draw(); } }, "Per device (WLED built-in)"));

    const list = effectSource === "hub"
      ? effects.hub.map((e) => ({ id: e.key, name: e.name, desc: e.description }))
      : effects.wled.map((e) => ({ id: e.id, name: e.name, desc: "" }));
    const search = h("input", { class: "search", type: "search", placeholder: "Search effects…", value: filter });
    const grid = h("div", { class: "effects" });
    const fill = () => {
      grid.replaceChildren(...list
        .filter((e) => e.name.toLowerCase().includes(filter.toLowerCase()))
        .map((e) => h("button", {
          class: `effect${state.effect.source === effectSource && String(state.effect.id) === String(e.id) ? " active" : ""}`,
          onclick: () => { change({ on: true, effect: { source: effectSource, id: e.id } }); draw(); },
        }, e.name, e.desc ? h("small", {}, e.desc) : null)));
    };
    search.addEventListener("input", () => { filter = search.value; fill(); });
    fill();

    const eff = state.effect;
    const controls = h("div", {},
      h("div", { class: "field" }, h("label", {}, "Speed"),
        slider({ value: eff.speed, label: "Speed", oninput: (speed) => change({ effect: { speed } }) })),
      h("div", { class: "field" }, h("label", {}, "Intensity / scale"),
        slider({ value: eff.intensity, label: "Intensity", oninput: (intensity) => change({ effect: { intensity } }) })),
    );
    if (eff.source === "hub") {
      const span = eff.params?.span === "room" ? "room" : "house";
      controls.append(h("div", { class: "field" }, h("label", {}, "Effect spans"),
        h("div", { class: "segmented", style: { margin: 0 } },
          h("button", { class: span === "house" ? "active" : "", title: "Positions relative to every mapped LED – rooms running the same effect line up across the house",
            onclick: () => { change({ effect: { params: { ...eff.params, span: "house" } } }); draw(); } }, "Whole house"),
          h("button", { class: span === "room" ? "active" : "", title: "The effect fills just this room's own LEDs",
            onclick: () => { change({ effect: { params: { ...eff.params, span: "room" } } }); draw(); } }, "This room only"))));
      const def = effects.hub.find((e) => e.key === eff.id);
      for (const [key, p] of Object.entries(def?.params || {})) {
        controls.append(h("div", { class: "field" }, h("label", {}, p.label || key),
          slider({ value: eff.params?.[key] ?? p.default, min: p.min, max: p.max, label: p.label,
            oninput: (v) => change({ effect: { params: { ...eff.params, [key]: v } } }) })));
      }
    } else if (effects.palettes.length) {
      const sel = h("select", {}, effects.palettes.map((p) =>
        h("option", { value: p.id, selected: p.id === eff.palette }, p.name)));
      sel.addEventListener("change", () => change({ effect: { palette: Number(sel.value) } }));
      controls.append(h("div", { class: "field" }, h("label", {}, "Palette"), sel));
    }
    const note = effectSource === "hub"
      ? "Rendered by the hub on your grid and sent to every mapped LED at once, so an effect runs across all devices – a line sweeps from one end of the house to the other."
      : "WLED's own effects run on each device by itself (each light string on its own), kept in time with WLED sync. They do not follow the grid – use an effect from \"Across the grid\" for that.";
    return h("div", {}, srcTabs, h("p", { class: "muted" }, note), search, grid, controls);
  }

  function groupTab() {
    const { config } = store;
    const mine = new Set(target.kind === "group" ? config.groups[target.id].room_ids : [target.id]);
    const checks = Object.values(config.rooms).sort((a, b) => a.order - b.order).map((room) => {
      const input = h("input", { type: "checkbox", checked: mine.has(room.id) });
      input.addEventListener("change", () => (input.checked ? mine.add(room.id) : mine.delete(room.id)));
      const other = Object.values(config.groups).find((g) => g.id !== target.id && g.room_ids.includes(room.id));
      return h("label", { class: "list-item" }, input,
        h("div", { class: "grow" }, room.name, other ? h("div", { class: "muted" }, `In group ${other.name}`) : null));
    });
    const name = h("input", { type: "text", value: target.kind === "group" ? target.name : "", placeholder: "Group name, e.g. Whole house" });
    const save = h("button", { class: "btn", onclick: async () => {
      try {
        const res = await post("groups", { room_ids: [...mine], name: name.value.trim() || undefined,
          id: target.kind === "group" ? target.id : undefined });
        toast(res.id ? "Group saved" : "Group dissolved");
        s.close();
      } catch (e) { toast(e.message); }
    } }, "Save group");
    const all = h("button", { class: "btn secondary", onclick: () => {
      Object.keys(config.rooms).forEach((r) => mine.add(r));
      if (!name.value) name.value = "Whole house";
      draw2();
    } }, "Select all");
    const ungroup = target.kind === "group" ? h("button", { class: "btn secondary", onclick: async () => {
      await del(`groups/${target.id}`).catch((e) => toast(e.message));
      s.close();
    } }, "Ungroup") : null;
    const wrap = h("div", {},
      h("p", { class: "muted" }, "Choose the rooms to control together. Grouped rooms show the same light – and hub effects flow across all of them."),
      h("div", { class: "list" }, checks),
      h("div", { class: "field" }, h("label", {}, "Name"), name),
      h("div", { class: "row" }, save, all, ungroup));
    const draw2 = () => wrap.querySelectorAll("input[type=checkbox]").forEach((c, i) => {
      c.checked = mine.has(Object.values(config.rooms).sort((a, b) => a.order - b.order)[i].id);
    });
    return wrap;
  }

  function editTab() {
    if (target.kind === "group") {
      return h("p", { class: "muted" }, "Groups are edited on the Group tab.");
    }
    const room = store.config.rooms[target.id];
    const name = h("input", { type: "text", value: room.name });
    let chosen = room.icon;
    const icons = h("div", { class: "swatches" }, ROOM_ICONS.map((key) =>
      h("button", { class: "icon-btn", style: { outline: key === chosen ? "2px solid var(--on)" : "" },
        onclick: (e) => {
          chosen = key;
          icons.querySelectorAll("button").forEach((b) => (b.style.outline = ""));
          e.currentTarget.style.outline = "2px solid var(--on)";
        } }, icon(key))));
    const devices = Object.values(store.config.devices).filter((d) => d.room_id === room.id);
    return h("div", {},
      h("div", { class: "field" }, h("label", {}, "Name"), name),
      h("div", { class: "field" }, h("label", {}, "Icon"), icons),
      h("div", { class: "field" }, h("label", {}, "Devices in this room"),
        devices.length
          ? h("div", { class: "list" }, devices.map((d) => h("div", { class: "list-item" },
              h("span", { class: `dot${d.online ? " on" : ""}` }), h("div", { class: "grow" }, d.name),
              h("span", { class: "muted" }, `${d.led_count} LEDs`))))
          : h("p", { class: "muted" }, "None – move devices here under Devices.")),
      h("div", { class: "row" },
        h("button", { class: "btn", onclick: async () => {
          await patch(`rooms/${room.id}`, { name: name.value.trim() || room.name, icon: chosen }).catch((e) => toast(e.message));
          toast("Saved");
        } }, "Save"),
        h("button", { class: "btn danger", onclick: async () => {
          if (!confirm(`Delete the room ${room.name}? Its devices will not be deleted.`)) return;
          await del(`rooms/${room.id}`).catch((e) => toast(e.message));
          s.close();
        } }, "Delete room")),
    );
  }

  const unsubscribe = store.subscribe((config) => {
    const t = findTarget(config, targetId);
    if (!t) return s.close(); // room got grouped / deleted
    target = t;
    if (!store.interacting && tab !== "group" && tab !== "edit") {
      state = stateOf(config, target);
      draw();
    }
  });
  draw();
}
