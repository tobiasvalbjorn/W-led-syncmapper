// Full settings for one WLED device, through the hub's proxy
// (api/devices/{id}/wled/...). Covers the everyday settings with forms and
// everything else through the raw JSON editor.
//
// cfg keys used here are checked against WLED's cfg.cpp / json.cpp
// (v0.14 – v16): id.name, light.nl.*, if.sync.send/recv.*, if.live.*,
// hw.led.maxpwr; state keys on, bri, transition, lor, nl, udpn, psave, pdel, rb.
import { get, post } from "../api.js";
import { fill, h, sheet, slider, toast, toggle } from "../ui.js";

const TABS = [
  ["general", "General"], ["sync", "Sync"], ["live", "Realtime"], ["nl", "Nightlight"],
  ["presets", "Presets"], ["segments", "Segments"], ["raw", "Advanced"],
];

export async function openDeviceSettings(store, deviceId) {
  const device = store.config.devices[deviceId];
  const api = (path) => `devices/${deviceId}/wled/${path}`;
  let tab = "general";
  let cfg = null, state = null, info = null;
  const body = h("div", {}, h("p", { class: "muted" }, "Loading settings from the device…"));
  const s = sheet(h("div", {},
    h("h2", {}, device.name),
    h("p", { class: "muted" }, `WLED ${device.version} · ${device.host}`),
    body));

  async function load() {
    try {
      [cfg, state, info] = await Promise.all([get(api("json/cfg")), get(api("json/state")), get(api("json/info"))]);
      draw();
    } catch (e) {
      fill(body, h("p", {}, `Could not load settings: ${e.message}`));
    }
  }

  // --- helpers -------------------------------------------------------------
  const at = (obj, path) => path.reduce((o, k) => (o == null ? undefined : o[k]), obj);
  // Build {a: {b: {c: value}}} for a partial config write.
  const nest = (path, value) => path.reduceRight((acc, k) => ({ [k]: acc }), value);
  const merge = (a, b) => {
    for (const [k, v] of Object.entries(b)) {
      a[k] = v && typeof v === "object" && !Array.isArray(v) ? merge(a[k] || {}, v) : v;
    }
    return a;
  };

  let pending = {};
  const setCfg = (path, value) => { merge(pending, nest(path, value)); merge(cfg, nest(path, value)); saveBar.hidden = false; };
  const saveBar = h("div", { class: "row", style: { position: "sticky", bottom: "0", padding: "10px 0", background: "var(--bg)" }, hidden: true },
    h("button", { class: "btn", onclick: saveCfg }, "Save to device"),
    h("span", { class: "muted" }, "Written to the device's flash memory."));

  async function saveCfg() {
    try {
      await post(api("json/cfg"), pending);
      pending = {};
      saveBar.hidden = true;
      toast("Saved to device");
    } catch (e) { toast(e.message); }
  }

  async function sendState(changes, msg) {
    try {
      await post(api("json/state"), changes);
      Object.assign(state, changes);
      if (msg) toast(msg);
    } catch (e) { toast(e.message); }
  }

  const row = (label, control, hint) => h("div", { class: "list-item" },
    h("div", { class: "grow" }, label, hint ? h("div", { class: "muted" }, hint) : null), control);
  const cfgToggle = (path) => toggle(!!at(cfg, path), (v) => setCfg(path, v));
  const cfgNumber = (path, attrs = {}) => {
    const i = h("input", { type: "number", value: at(cfg, path) ?? "", style: { width: "96px" }, ...attrs });
    i.addEventListener("change", () => setCfg(path, Number(i.value)));
    return i;
  };
  const cfgText = (path) => {
    const i = h("input", { type: "text", value: at(cfg, path) ?? "", style: { width: "160px" } });
    i.addEventListener("change", () => setCfg(path, i.value));
    return i;
  };
  const cfgSelect = (path, options) => {
    const sel = h("select", {}, options.map(([v, l]) => h("option", { value: v, selected: at(cfg, path) === v }, l)));
    sel.addEventListener("change", () => setCfg(path, Number(sel.value)));
    return sel;
  };
  // 8 sync groups as a bitmask
  const groupBits = (path) => h("div", { class: "row", style: { gap: "4px", flexWrap: "wrap" } },
    [1, 2, 3, 4, 5, 6, 7, 8].map((n) => {
      const bit = 1 << (n - 1);
      const c = h("input", { type: "checkbox", checked: ((at(cfg, path) || 0) & bit) !== 0, title: `Group ${n}` });
      c.addEventListener("change", () => setCfg(path, c.checked ? (at(cfg, path) | bit) : (at(cfg, path) & ~bit)));
      return h("label", { style: { fontSize: "13px", display: "flex", alignItems: "center", gap: "2px" } }, c, n);
    }));

  // --- tabs ----------------------------------------------------------------
  function general() {
    const wifi = info.wifi || {};
    const up = info.uptime || 0;
    return [
      h("div", { class: "list" },
        row("On", toggle(state.on, (on) => sendState({ on }))),
        row("Brightness", slider({ value: state.bri, min: 1, label: "Brightness", oninput: (bri) => sendState({ bri }) })),
        row("Transition", (() => {
          const i = h("input", { type: "number", value: (state.transition ?? 7) / 10, step: 0.1, min: 0, style: { width: "80px" } });
          i.addEventListener("change", () => sendState({ transition: Math.round(Number(i.value) * 10) }));
          return i;
        })(), "Seconds when changing colour/brightness"),
        row("Ignore live data (live override)", (() => {
          const sel = h("select", {}, [[0, "Off"], [1, "Until live data ends"], [2, "Until restart"]].map(([v, l]) =>
            h("option", { value: v, selected: state.lor === v }, l)));
          sel.addEventListener("change", () => sendState({ lor: Number(sel.value) }));
          return sel;
        })(), "When on, the device ignores hub streaming and runs its own effects")),
      h("div", { class: "section-title" }, "Device"),
      h("div", { class: "list" },
        row("Name in WLED", cfgText(["id", "name"])),
        row("mDNS name", cfgText(["id", "mdns"]), `${at(cfg, ["id", "mdns"]) || "?"}.local`),
        row("Current limit (mA)", cfgNumber(["hw", "led", "maxpwr"], { min: 0, step: 50 }), "0 = no limit")),
      h("div", { class: "section-title" }, "Status"),
      h("div", { class: "list" },
        row("Firmware", h("span", { class: "muted" }, `${info.ver} (${info.arch})`)),
        row("LEDs", h("span", { class: "muted" }, `${info.leds?.count} · ${info.leds?.fps ?? "?"} fps · ${info.leds?.pwr ?? "?"} mA`)),
        row("WiFi", h("span", { class: "muted" }, `${wifi.signal ?? "?"} % (${wifi.rssi ?? "?"} dBm)`)),
        row("Uptime", h("span", { class: "muted" }, `${Math.floor(up / 86400)} d ${Math.floor((up % 86400) / 3600)} h ${Math.floor((up % 3600) / 60)} m`)),
        row("Live source", h("span", { class: "muted" }, info.live ? `${info.lm} from ${info.lip}` : "None"))),
      h("div", { class: "row", style: { flexWrap: "wrap", marginTop: "12px" } },
        h("a", { class: "btn secondary", href: `http://${device.host}/`, target: "_blank", rel: "noopener" }, "Open WLED's own page"),
        h("button", { class: "btn danger", onclick: async () => {
          if (!confirm(`Restart ${device.name}?`)) return;
          await sendState({ rb: true }, "Restarting…");
        } }, "Restart")),
    ];
  }

  function sync() {
    const runtime = state.udpn || {};
    return [
      h("p", { class: "muted" }, "WLED's own UDP sync between devices. Note: when the device is in a room running a WLED effect, the hub temporarily controls the sync groups to keep the room in step."),
      h("div", { class: "section-title" }, "Right now (until restart)"),
      h("div", { class: "list" },
        row("Send sync", toggle(!!runtime.send, (v) => sendState({ udpn: { send: v } }))),
        row("Receive sync", toggle((runtime.rgrp ?? (runtime.recv ? 1 : 0)) !== 0, (v) =>
          sendState({ udpn: { rgrp: v ? (at(cfg, ["if", "sync", "recv", "grp"]) || 1) : 0 } })))),
      h("div", { class: "section-title" }, "Send (saved)"),
      h("div", { class: "list" },
        row("Send sync messages", cfgToggle(["if", "sync", "send", "en"])),
        row("Send on changes from the app/API", cfgToggle(["if", "sync", "send", "dir"])),
        row("Send on button press", cfgToggle(["if", "sync", "send", "btn"])),
        row("Send on Alexa", cfgToggle(["if", "sync", "send", "va"])),
        row("Send on Philips Hue", cfgToggle(["if", "sync", "send", "hue"])),
        row("Extra retransmissions", cfgNumber(["if", "sync", "send", "ret"], { min: 0, max: 30 }), "Helps on unstable WiFi"),
        row("Send to groups", groupBits(["if", "sync", "send", "grp"]))),
      h("div", { class: "section-title" }, "Receive (saved)"),
      h("div", { class: "list" },
        row("Receive from groups", groupBits(["if", "sync", "recv", "grp"])),
        row("Brightness", cfgToggle(["if", "sync", "recv", "bri"])),
        row("Colour", cfgToggle(["if", "sync", "recv", "col"])),
        row("Effect", cfgToggle(["if", "sync", "recv", "fx"])),
        row("Palette", cfgToggle(["if", "sync", "recv", "pal"])),
        row("Segment options", cfgToggle(["if", "sync", "recv", "seg"])),
        row("Segment bounds", cfgToggle(["if", "sync", "recv", "sb"]))),
      h("div", { class: "section-title" }, "Ports (restart required)"),
      h("div", { class: "list" },
        row("UDP port", cfgNumber(["if", "sync", "port0"])),
        row("UDP port 2", cfgNumber(["if", "sync", "port1"]))),
    ];
  }

  function live() {
    return [
      h("p", { class: "muted" }, "Hub effects are sent as DDP, which WLED always accepts. These settings mainly apply to UDP/Hyperion and E1.31/Art-Net."),
      h("div", { class: "list" },
        row("Receive UDP/Hyperion realtime", cfgToggle(["if", "live", "en"])),
        row("Main segment only", cfgToggle(["if", "live", "mso"]), "Live data only controls the main segment"),
        row("Use LED map for live data", cfgToggle(["if", "live", "rlm"])),
        row("Timeout (×100 ms)", cfgNumber(["if", "live", "timeout"], { min: 1 }), "How long the device waits before returning to its own effects (25 = 2.5 s)")),
      h("div", { class: "section-title" }, "E1.31 / Art-Net / DMX"),
      h("div", { class: "list" },
        row("Port", cfgNumber(["if", "live", "port"])),
        row("Multicast", cfgToggle(["if", "live", "mc"])),
        row("Universe", cfgNumber(["if", "live", "dmx", "uni"], { min: 0 })),
        row("Start address", cfgNumber(["if", "live", "dmx", "addr"], { min: 1 })),
        row("DMX mode", cfgNumber(["if", "live", "dmx", "mode"], { min: 0 }), "See the WLED documentation for the values"),
        row("Skip out-of-sequence packets", cfgToggle(["if", "live", "dmx", "seqskip"]))),
    ];
  }

  function nightlight() {
    const nl = state.nl || {};
    return [
      h("p", { class: "muted" }, "The nightlight dims the light gradually over a period and turns off (or goes to a target brightness)."),
      h("div", { class: "list" },
        row("Nightlight active now", toggle(!!nl.on, (on) => sendState({ nl: { on } }, on ? "Nightlight started" : "Nightlight stopped"))),
        row("Duration now (min)", (() => {
          const i = h("input", { type: "number", value: nl.dur ?? 60, min: 1, max: 255, style: { width: "80px" } });
          i.addEventListener("change", () => sendState({ nl: { dur: Number(i.value) } }));
          return i;
        })()),
        row("Default duration (min)", cfgNumber(["light", "nl", "dur"], { min: 1, max: 255 })),
        row("Mode", cfgSelect(["light", "nl", "mode"], [[0, "Instant"], [1, "Fade"], [2, "Colour fade"], [3, "Sunrise"]])),
        row("Target brightness", cfgNumber(["light", "nl", "tbri"], { min: 0, max: 255 }), "0 = turn off at the end")),
    ];
  }

  async function presets() {
    const wrap = h("div", {}, h("p", { class: "muted" }, "Loading presets…"));
    try {
      const all = await get(api("presets.json"));
      const list = Object.entries(all).filter(([id, p]) => id !== "0" && p && Object.keys(p).length)
        .sort((a, b) => Number(a[0]) - Number(b[0]));
      const name = h("input", { type: "text", placeholder: "Name of new preset" });
      const free = () => { for (let i = 1; i < 251; i++) if (!all[i] || !Object.keys(all[i]).length) return i; return 250; };
      fill(wrap,
        list.length ? h("div", { class: "list" }, list.map(([id, p]) => h("div", { class: "list-item" },
          h("div", { class: "grow" }, p.n || `Preset ${id}`, h("div", { class: "muted" }, `#${id}${p.ql ? ` · ${p.ql}` : ""}`)),
          h("button", { class: "btn small", onclick: () => sendState({ ps: Number(id) }, `Preset ${p.n || id} activated`) }, "Apply"),
          h("button", { class: "btn small danger", onclick: async () => {
            if (!confirm(`Delete preset ${p.n || id}?`)) return;
            await sendState({ pdel: Number(id) }, "Deleted");
            draw();
          } }, "Delete"))))
          : h("p", { class: "muted" }, "No presets on the device."),
        h("div", { class: "section-title" }, "Save current state as preset"),
        h("div", { class: "row" }, name, h("button", { class: "btn", onclick: async () => {
          const id = free();
          await sendState({ psave: id, n: name.value.trim() || `Preset ${id}`, ib: true, sb: true }, `Saved as preset ${id}`);
          setTimeout(draw, 500);
        } }, "Save")));
    } catch (e) {
      fill(wrap, h("p", {}, `Could not load presets: ${e.message}`));
    }
    return [wrap];
  }

  function segments() {
    const segs = state.seg || [];
    return [
      h("p", { class: "muted" }, "Segments are parts of the light string that can be controlled separately in WLED."),
      h("div", { class: "list" }, segs.map((seg) => h("div", { class: "list-item", style: { flexWrap: "wrap" } },
        h("div", { class: "grow" }, seg.n || `Segment ${seg.id}`,
          h("div", { class: "muted" }, `LED ${seg.start}–${seg.stop - 1}${seg.startY !== undefined ? ` · rows ${seg.startY}–${seg.stopY - 1}` : ""}`)),
        toggle(seg.on !== false, (on) => sendState({ seg: [{ id: seg.id, on }] })),
        h("div", { style: { flexBasis: "100%" } },
          slider({ value: seg.bri ?? 255, min: 1, label: "Segment brightness", oninput: (bri) => sendState({ seg: [{ id: seg.id, bri }] }) }))))),
      h("p", { class: "muted" }, "Creating and splitting segments is easiest under Advanced or on WLED's own page."),
    ];
  }

  function raw() {
    const which = { value: "cfg" };
    const area = h("textarea", { style: { width: "100%", minHeight: "320px", fontFamily: "ui-monospace, monospace", fontSize: "12px",
      background: "var(--surface)", color: "var(--text)", border: "1px solid var(--border)", borderRadius: "12px", padding: "10px" } });
    const show = () => (area.value = JSON.stringify(which.value === "cfg" ? cfg : state, null, 2));
    const pick = h("select", {}, h("option", { value: "cfg" }, "Configuration (json/cfg)"), h("option", { value: "state" }, "State (json/state)"));
    pick.addEventListener("change", () => { which.value = pick.value; show(); });
    show();
    return [
      h("p", { class: "muted" }, "All WLED settings as JSON. Edit and save – only the fields you send are changed. Wrong values (e.g. LED pins) can make the device unreachable, so be careful."),
      h("div", { class: "field" }, pick),
      area,
      h("div", { class: "row", style: { marginTop: "8px" } },
        h("button", { class: "btn", onclick: async () => {
          let data;
          try { data = JSON.parse(area.value); } catch (e) { return toast(`Invalid JSON: ${e.message}`); }
          try {
            await post(api(which.value === "cfg" ? "json/cfg" : "json/state"), data);
            toast("Sent to device");
            await load();
          } catch (e) { toast(e.message); }
        } }, "Send to device"),
        h("button", { class: "btn secondary", onclick: load }, "Reload")),
    ];
  }

  async function draw() {
    const tabs = h("div", { class: "segmented", style: { flexWrap: "wrap" } },
      TABS.map(([key, label]) => h("button", { class: tab === key ? "active" : "", onclick: () => { tab = key; draw(); } }, label)));
    const content = await ({ general, sync, live, nl: nightlight, presets, segments, raw }[tab])();
    fill(body, tabs, ...content, saveBar);
  }

  load();
  return s;
}
