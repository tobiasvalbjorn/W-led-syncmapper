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
  ["general", "Generelt"], ["sync", "Sync"], ["live", "Realtime"], ["nl", "Nattelys"],
  ["presets", "Presets"], ["segments", "Segmenter"], ["raw", "Avanceret"],
];

export async function openDeviceSettings(store, deviceId) {
  const device = store.config.devices[deviceId];
  const api = (path) => `devices/${deviceId}/wled/${path}`;
  let tab = "general";
  let cfg = null, state = null, info = null;
  const body = h("div", {}, h("p", { class: "muted" }, "Henter indstillinger fra enheden…"));
  const s = sheet(h("div", {},
    h("h2", {}, device.name),
    h("p", { class: "muted" }, `WLED ${device.version} · ${device.host}`),
    body));

  async function load() {
    try {
      [cfg, state, info] = await Promise.all([get(api("json/cfg")), get(api("json/state")), get(api("json/info"))]);
      draw();
    } catch (e) {
      fill(body, h("p", {}, `Kunne ikke hente indstillinger: ${e.message}`));
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
    h("button", { class: "btn", onclick: saveCfg }, "Gem på enheden"),
    h("span", { class: "muted" }, "Skrives i enhedens flash-hukommelse."));

  async function saveCfg() {
    try {
      await post(api("json/cfg"), pending);
      pending = {};
      saveBar.hidden = true;
      toast("Gemt på enheden");
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
      const c = h("input", { type: "checkbox", checked: ((at(cfg, path) || 0) & bit) !== 0, title: `Gruppe ${n}` });
      c.addEventListener("change", () => setCfg(path, c.checked ? (at(cfg, path) | bit) : (at(cfg, path) & ~bit)));
      return h("label", { style: { fontSize: "13px", display: "flex", alignItems: "center", gap: "2px" } }, c, n);
    }));

  // --- tabs ----------------------------------------------------------------
  function general() {
    const wifi = info.wifi || {};
    const up = info.uptime || 0;
    return [
      h("div", { class: "list" },
        row("Tændt", toggle(state.on, (on) => sendState({ on }))),
        row("Lysstyrke", slider({ value: state.bri, min: 1, label: "Lysstyrke", oninput: (bri) => sendState({ bri }) })),
        row("Overgang", (() => {
          const i = h("input", { type: "number", value: (state.transition ?? 7) / 10, step: 0.1, min: 0, style: { width: "80px" } });
          i.addEventListener("change", () => sendState({ transition: Math.round(Number(i.value) * 10) }));
          return i;
        })(), "Sekunder ved skift af farve/lysstyrke"),
        row("Ignorér live-data (live override)", (() => {
          const sel = h("select", {}, [[0, "Fra"], [1, "Til live-data stopper"], [2, "Til genstart"]].map(([v, l]) =>
            h("option", { value: v, selected: state.lor === v }, l)));
          sel.addEventListener("change", () => sendState({ lor: Number(sel.value) }));
          return sel;
        })(), "Når slået til, ignorerer enheden hub-streaming og kører sine egne effekter")),
      h("div", { class: "section-title" }, "Enhed"),
      h("div", { class: "list" },
        row("Navn i WLED", cfgText(["id", "name"])),
        row("mDNS-navn", cfgText(["id", "mdns"]), `${at(cfg, ["id", "mdns"]) || "?"}.local`),
        row("Strømbegrænsning (mA)", cfgNumber(["hw", "led", "maxpwr"], { min: 0, step: 50 }), "0 = ingen begrænsning")),
      h("div", { class: "section-title" }, "Status"),
      h("div", { class: "list" },
        row("Firmware", h("span", { class: "muted" }, `${info.ver} (${info.arch})`)),
        row("LEDs", h("span", { class: "muted" }, `${info.leds?.count} · ${info.leds?.fps ?? "?"} fps · ${info.leds?.pwr ?? "?"} mA`)),
        row("WiFi", h("span", { class: "muted" }, `${wifi.signal ?? "?"} % (${wifi.rssi ?? "?"} dBm)`)),
        row("Oppetid", h("span", { class: "muted" }, `${Math.floor(up / 86400)} d ${Math.floor((up % 86400) / 3600)} t ${Math.floor((up % 3600) / 60)} m`)),
        row("Live-kilde", h("span", { class: "muted" }, info.live ? `${info.lm} fra ${info.lip}` : "Ingen"))),
      h("div", { class: "row", style: { flexWrap: "wrap", marginTop: "12px" } },
        h("a", { class: "btn secondary", href: `http://${device.host}/`, target: "_blank", rel: "noopener" }, "Åbn WLED's egen side"),
        h("button", { class: "btn danger", onclick: async () => {
          if (!confirm(`Genstart ${device.name}?`)) return;
          await sendState({ rb: true }, "Genstarter…");
        } }, "Genstart")),
    ];
  }

  function sync() {
    const runtime = state.udpn || {};
    return [
      h("p", { class: "muted" }, "WLED's egen UDP-sync mellem enheder. Bemærk: når enheden er i et rum, som kører en WLED-effekt, styrer hub'en sync-grupperne midlertidigt for at holde rummet i takt."),
      h("div", { class: "section-title" }, "Lige nu (indtil genstart)"),
      h("div", { class: "list" },
        row("Send sync", toggle(!!runtime.send, (v) => sendState({ udpn: { send: v } }))),
        row("Modtag sync", toggle((runtime.rgrp ?? (runtime.recv ? 1 : 0)) !== 0, (v) =>
          sendState({ udpn: { rgrp: v ? (at(cfg, ["if", "sync", "recv", "grp"]) || 1) : 0 } })))),
      h("div", { class: "section-title" }, "Send (gemt)"),
      h("div", { class: "list" },
        row("Send sync-beskeder", cfgToggle(["if", "sync", "send", "en"])),
        row("Send ved ændringer fra appen/API", cfgToggle(["if", "sync", "send", "dir"])),
        row("Send ved knaptryk", cfgToggle(["if", "sync", "send", "btn"])),
        row("Send ved Alexa", cfgToggle(["if", "sync", "send", "va"])),
        row("Send ved Philips Hue", cfgToggle(["if", "sync", "send", "hue"])),
        row("Ekstra gentagelser", cfgNumber(["if", "sync", "send", "ret"], { min: 0, max: 30 }), "Hjælper på ustabilt WiFi"),
        row("Send til grupper", groupBits(["if", "sync", "send", "grp"]))),
      h("div", { class: "section-title" }, "Modtag (gemt)"),
      h("div", { class: "list" },
        row("Modtag fra grupper", groupBits(["if", "sync", "recv", "grp"])),
        row("Lysstyrke", cfgToggle(["if", "sync", "recv", "bri"])),
        row("Farve", cfgToggle(["if", "sync", "recv", "col"])),
        row("Effekt", cfgToggle(["if", "sync", "recv", "fx"])),
        row("Palette", cfgToggle(["if", "sync", "recv", "pal"])),
        row("Segment-indstillinger", cfgToggle(["if", "sync", "recv", "seg"])),
        row("Segment-grænser", cfgToggle(["if", "sync", "recv", "sb"]))),
      h("div", { class: "section-title" }, "Porte (kræver genstart)"),
      h("div", { class: "list" },
        row("UDP-port", cfgNumber(["if", "sync", "port0"])),
        row("UDP-port 2", cfgNumber(["if", "sync", "port1"]))),
    ];
  }

  function live() {
    return [
      h("p", { class: "muted" }, "Hub-effekter sendes som DDP, som WLED altid modtager. Indstillingerne her gælder især UDP/Hyperion og E1.31/Art-Net."),
      h("div", { class: "list" },
        row("Modtag UDP/Hyperion realtime", cfgToggle(["if", "live", "en"])),
        row("Kun hovedsegment", cfgToggle(["if", "live", "mso"]), "Live-data styrer kun hovedsegmentet"),
        row("Brug LED-map til live-data", cfgToggle(["if", "live", "rlm"])),
        row("Timeout (×100 ms)", cfgNumber(["if", "live", "timeout"], { min: 1 }), "Hvor længe enheden venter, før den vender tilbage til egne effekter (25 = 2,5 s)")),
      h("div", { class: "section-title" }, "E1.31 / Art-Net / DMX"),
      h("div", { class: "list" },
        row("Port", cfgNumber(["if", "live", "port"])),
        row("Multicast", cfgToggle(["if", "live", "mc"])),
        row("Univers", cfgNumber(["if", "live", "dmx", "uni"], { min: 0 })),
        row("Startadresse", cfgNumber(["if", "live", "dmx", "addr"], { min: 1 })),
        row("DMX-tilstand", cfgNumber(["if", "live", "dmx", "mode"], { min: 0 }), "Se WLED-dokumentationen for værdierne"),
        row("Spring pakker i forkert rækkefølge over", cfgToggle(["if", "live", "dmx", "seqskip"]))),
    ];
  }

  function nightlight() {
    const nl = state.nl || {};
    return [
      h("p", { class: "muted" }, "Nattelyset dæmper lyset gradvist over en periode og slukker (eller går til en mållysstyrke)."),
      h("div", { class: "list" },
        row("Nattelys aktivt nu", toggle(!!nl.on, (on) => sendState({ nl: { on } }, on ? "Nattelys startet" : "Nattelys stoppet"))),
        row("Varighed nu (min)", (() => {
          const i = h("input", { type: "number", value: nl.dur ?? 60, min: 1, max: 255, style: { width: "80px" } });
          i.addEventListener("change", () => sendState({ nl: { dur: Number(i.value) } }));
          return i;
        })()),
        row("Standard-varighed (min)", cfgNumber(["light", "nl", "dur"], { min: 1, max: 255 })),
        row("Tilstand", cfgSelect(["light", "nl", "mode"], [[0, "Øjeblikkelig"], [1, "Fade"], [2, "Farve-fade"], [3, "Solopgang"]])),
        row("Mållysstyrke", cfgNumber(["light", "nl", "tbri"], { min: 0, max: 255 }), "0 = sluk til sidst")),
    ];
  }

  async function presets() {
    const wrap = h("div", {}, h("p", { class: "muted" }, "Henter presets…"));
    try {
      const all = await get(api("presets.json"));
      const list = Object.entries(all).filter(([id, p]) => id !== "0" && p && Object.keys(p).length)
        .sort((a, b) => Number(a[0]) - Number(b[0]));
      const name = h("input", { type: "text", placeholder: "Navn på nyt preset" });
      const free = () => { for (let i = 1; i < 251; i++) if (!all[i] || !Object.keys(all[i]).length) return i; return 250; };
      fill(wrap,
        list.length ? h("div", { class: "list" }, list.map(([id, p]) => h("div", { class: "list-item" },
          h("div", { class: "grow" }, p.n || `Preset ${id}`, h("div", { class: "muted" }, `#${id}${p.ql ? ` · ${p.ql}` : ""}`)),
          h("button", { class: "btn small", onclick: () => sendState({ ps: Number(id) }, `Preset ${p.n || id} aktiveret`) }, "Brug"),
          h("button", { class: "btn small danger", onclick: async () => {
            if (!confirm(`Slet preset ${p.n || id}?`)) return;
            await sendState({ pdel: Number(id) }, "Slettet");
            draw();
          } }, "Slet"))))
          : h("p", { class: "muted" }, "Ingen presets på enheden."),
        h("div", { class: "section-title" }, "Gem nuværende tilstand som preset"),
        h("div", { class: "row" }, name, h("button", { class: "btn", onclick: async () => {
          const id = free();
          await sendState({ psave: id, n: name.value.trim() || `Preset ${id}`, ib: true, sb: true }, `Gemt som preset ${id}`);
          setTimeout(draw, 500);
        } }, "Gem")));
    } catch (e) {
      fill(wrap, h("p", {}, `Kunne ikke hente presets: ${e.message}`));
    }
    return [wrap];
  }

  function segments() {
    const segs = state.seg || [];
    return [
      h("p", { class: "muted" }, "Segmenter er dele af lyskæden, der kan styres hver for sig i WLED."),
      h("div", { class: "list" }, segs.map((seg) => h("div", { class: "list-item", style: { flexWrap: "wrap" } },
        h("div", { class: "grow" }, seg.n || `Segment ${seg.id}`,
          h("div", { class: "muted" }, `LED ${seg.start}–${seg.stop - 1}${seg.startY !== undefined ? ` · rækker ${seg.startY}–${seg.stopY - 1}` : ""}`)),
        toggle(seg.on !== false, (on) => sendState({ seg: [{ id: seg.id, on }] })),
        h("div", { style: { flexBasis: "100%" } },
          slider({ value: seg.bri ?? 255, min: 1, label: "Segment-lysstyrke", oninput: (bri) => sendState({ seg: [{ id: seg.id, bri }] }) }))))),
      h("p", { class: "muted" }, "Oprettelse og opdeling af segmenter gøres nemmest under Avanceret eller på WLED's egen side."),
    ];
  }

  function raw() {
    const which = { value: "cfg" };
    const area = h("textarea", { style: { width: "100%", minHeight: "320px", fontFamily: "ui-monospace, monospace", fontSize: "12px",
      background: "var(--surface)", color: "var(--text)", border: "1px solid var(--border)", borderRadius: "12px", padding: "10px" } });
    const show = () => (area.value = JSON.stringify(which.value === "cfg" ? cfg : state, null, 2));
    const pick = h("select", {}, h("option", { value: "cfg" }, "Konfiguration (json/cfg)"), h("option", { value: "state" }, "Tilstand (json/state)"));
    pick.addEventListener("change", () => { which.value = pick.value; show(); });
    show();
    return [
      h("p", { class: "muted" }, "Alle WLED-indstillinger som JSON. Ret og gem – kun de felter du sender, ændres. Forkerte værdier (fx LED-pins) kan gøre enheden utilgængelig, så vær forsigtig."),
      h("div", { class: "field" }, pick),
      area,
      h("div", { class: "row", style: { marginTop: "8px" } },
        h("button", { class: "btn", onclick: async () => {
          let data;
          try { data = JSON.parse(area.value); } catch (e) { return toast(`Ugyldig JSON: ${e.message}`); }
          try {
            await post(api(which.value === "cfg" ? "json/cfg" : "json/state"), data);
            toast("Sendt til enheden");
            await load();
          } catch (e) { toast(e.message); }
        } }, "Send til enheden"),
        h("button", { class: "btn secondary", onclick: load }, "Hent igen")),
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
