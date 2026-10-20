// "Rum" – the Sonos-style home screen: one card per room or group.
// Long-press a card and drop it on another to group them.
import { post, put, throttled } from "../api.js";
import { fill, h, icon, rgbCss, sheet, slider, toast, toggle, ROOM_ICONS } from "../ui.js";
import { openTargetSheet, effectLabel } from "./roomsheet.js";

export const title = "Rum";

export function targetState(config, target) {
  return target.kind === "group" ? config.groups[target.id].state : config.rooms[target.id].state;
}

export function targetIcon(config, target) {
  if (target.kind === "group") return "link";
  return config.rooms[target.id]?.icon || "sofa";
}

function artStyle(state) {
  if (!state.on) return {};
  const a = rgbCss(state.color);
  const b = state.effect.source === "hub" || state.effect.id !== 0 ? rgbCss(state.color2.some((v) => v) ? state.color2 : [80, 60, 255]) : a;
  return { background: `linear-gradient(135deg, ${a}, ${b})` };
}

function subtitle(config, target, state, effects) {
  const parts = [];
  if (target.kind === "group") {
    parts.push(config.groups[target.id].room_ids.map((r) => config.rooms[r]?.name).filter(Boolean).join(" + "));
  }
  if (!target.device_ids.length) parts.push("Ingen enheder");
  else if (!state.on) parts.push("Slukket");
  else parts.push(effectLabel(state, effects));
  return parts.join(" · ");
}

export function render(view, store, actions) {
  actions.append(
    h("button", { class: "icon-btn", title: "Nyt rum", onclick: () => newRoomSheet() }, icon("plus"))
  );

  const draw = () => {
    if (store.interacting) return;
    const { config } = store;
    const cards = h("div", { class: "cards" });
    for (const target of config.targets) cards.append(card(store, target));
    const unassigned = Object.values(config.devices).filter((d) => !d.room_id);
    fill(view, 
      config.targets.length
        ? cards
        : h("div", { class: "empty" }, "Ingen rum endnu. Opret et rum med + og tilføj enheder under Enheder."),
      unassigned.length
        ? h("p", { class: "muted", style: { textAlign: "center", marginTop: "18px" } },
            `${unassigned.length} enhed(er) er ikke i et rum endnu – `, h("a", { href: "#devices" }, "placér dem"))
        : null,
      config.targets.length > 1
        ? h("p", { class: "muted", style: { textAlign: "center" } }, "Tip: hold fingeren på et rum og træk det over på et andet for at gruppere dem.")
        : null,
    );
  };
  draw();
  return store.subscribe(draw);
}

function card(store, target) {
  const { config } = store;
  const state = targetState(config, target);
  const setState = throttled((changes) => put(`targets/${target.id}/state`, changes).catch((e) => toast(e.message)));

  const el = h(
    "div",
    { class: "card", "data-target": target.id },
    h(
      "div",
      { class: "room-head", onclick: () => openTargetSheet(store, target.id) },
      h("div", { class: "room-art", style: artStyle(state) }, icon(targetIcon(config, target))),
      h(
        "div",
        { class: "room-meta" },
        h("div", { class: "room-name" }, target.name),
        h("div", { class: "room-sub" }, subtitle(config, target, state, store.effects)),
      ),
      toggle(state.on, (on) => setState({ on })),
    ),
    h(
      "div",
      { class: "room-controls" },
      icon("sun"),
      slider({
        value: state.brightness,
        min: 1,
        label: "Lysstyrke",
        oninput: (brightness) => { store.interacting = 1; setState({ brightness, on: true }); },
      }),
    ),
  );
  enableDragGroup(el, store, target);
  return el;
}

// Long-press drag-to-group, works with touch and mouse (pointer events).
function enableDragGroup(el, store, target) {
  let timer = null, dragging = false, startX = 0, startY = 0, over = null;
  const head = el.querySelector(".room-head");

  head.addEventListener("pointerdown", (e) => {
    startX = e.clientX; startY = e.clientY;
    timer = setTimeout(() => {
      dragging = true;
      el.classList.add("dragging");
      head.setPointerCapture(e.pointerId);
      navigator.vibrate?.(15);
    }, 450);
  });
  // Once the long-press has fired, stop the page from scrolling under the finger.
  head.addEventListener("touchmove", (e) => { if (dragging) e.preventDefault(); }, { passive: false });
  head.addEventListener("pointermove", (e) => {
    if (!dragging) {
      if (Math.hypot(e.clientX - startX, e.clientY - startY) > 8) clearTimeout(timer);
      return;
    }
    e.preventDefault();
    el.style.transform = `translate(${e.clientX - startX}px, ${e.clientY - startY}px) scale(1.03)`;
    el.style.pointerEvents = "none";
    const hit = document.elementFromPoint(e.clientX, e.clientY)?.closest(".card[data-target]");
    el.style.pointerEvents = "";
    if (over && over !== hit) over.classList.remove("drop-target");
    over = hit && hit !== el ? hit : null;
    over?.classList.add("drop-target");
  });
  const end = async () => {
    clearTimeout(timer);
    if (!dragging) return;
    dragging = false;
    el.classList.remove("dragging");
    el.style.transform = "";
    if (!over) return;
    over.classList.remove("drop-target");
    const dropId = over.dataset.target;
    over = null;
    await groupTargets(store, dropId, target.id);
  };
  head.addEventListener("pointerup", end);
  head.addEventListener("pointercancel", end);
  // a long-press must not also open the sheet
  head.addEventListener("click", (e) => { if (el.classList.contains("dragging")) e.stopPropagation(); }, true);
}

function roomIds(config, targetId) {
  return config.groups[targetId] ? [...config.groups[targetId].room_ids] : [targetId];
}

// Drop `movingId` onto `ontoId`: the target being dropped on keeps its state (like Sonos).
async function groupTargets(store, ontoId, movingId) {
  const { config } = store;
  const rooms = [...roomIds(config, ontoId), ...roomIds(config, movingId)];
  const groupId = config.groups[ontoId] ? ontoId : undefined;
  try {
    await post("groups", { room_ids: rooms, id: groupId });
    toast("Rum grupperet");
  } catch (e) {
    toast(e.message);
  }
}

export function newRoomSheet() {
  let chosen = "sofa";
  const name = h("input", { type: "text", placeholder: "Fx Stue, Terrasse, Carport" });
  const icons = h("div", { class: "swatches" }, ROOM_ICONS.map((key) => {
    const b = h("button", { class: `icon-btn${key === chosen ? " active" : ""}`, onclick: () => {
      chosen = key;
      icons.querySelectorAll("button").forEach((x) => (x.style.outline = ""));
      b.style.outline = "2px solid var(--on)";
    } }, icon(key));
    if (key === chosen) b.style.outline = "2px solid var(--on)";
    return b;
  }));
  const s = sheet(h("div", {},
    h("h2", {}, "Nyt rum"),
    h("div", { class: "field" }, h("label", {}, "Navn"), name),
    h("div", { class: "field" }, h("label", {}, "Ikon"), icons),
    h("button", { class: "btn", onclick: async () => {
      if (!name.value.trim()) return name.focus();
      try {
        await post("rooms", { name: name.value.trim(), icon: chosen });
        s.close();
      } catch (e) { toast(e.message); }
    } }, "Opret rum"),
  ));
  setTimeout(() => name.focus(), 250);
}
