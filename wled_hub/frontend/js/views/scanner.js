// Camera mapping – find every LED's real position with the phone camera.
//
// The hub lights binary patterns (see wledhub/scanner.py): LED code = index+1,
// for each bit k we capture "bit k set" and its inverse. Per camera pixel we
// read bit = (pattern brighter than inverse). Pixels that never change are
// background. Pixels sharing a code are averaged into that LED's centroid.
// All processing happens here in the browser; no images are uploaded.
import { post, put } from "../api.js";
import { h, sheet, toast } from "../ui.js";

const WORK_WIDTH = 480; // analysis resolution (keeps decoding fast on phones)
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export function openScanner(store) {
  if (!window.isSecureContext || !navigator.mediaDevices?.getUserMedia) {
    sheet(h("div", {},
      h("h2", {}, "Kamera kræver HTTPS"),
      h("p", {}, "Browsere giver kun kameraadgang på sikre forbindelser. Åbn WLED Hub via Home Assistant (med HTTPS, fx Nabu Casa), eller slå SSL til i add-on'ens indstillinger og åbn https://<hub-ip>:8787."),
    ));
    return;
  }

  const devices = Object.values(store.config.devices).filter((d) => d.online && d.led_count);
  const chosen = new Set(devices.map((d) => d.id));
  const L = store.config.layout;
  const area = { x: 0, y: 0, width: L.width, height: L.height };
  let level = 160, settle = 350, stream = null, wakeLock = null, running = false;

  const video = h("video", { playsinline: true, muted: true, autoplay: true, style: { width: "100%", borderRadius: "12px", background: "#000" } });
  const overlay = h("canvas", { style: { width: "100%", borderRadius: "12px", display: "none" } });
  const status = h("p", { class: "muted" }, "Stil dig så alle lyskæderne er i billedet. Brug gerne stativ – telefonen skal holdes helt stille. Det virker bedst i mørke.");
  const progress = h("progress", { max: 1, value: 0, style: { width: "100%", display: "none" } });
  const startBtn = h("button", { class: "btn", onclick: () => run() }, "Start scanning");
  const saveBtn = h("button", { class: "btn", style: { display: "none" } }, "Gem på grid");
  const numField = (label, obj, key, attrs = {}) => {
    const input = h("input", { type: "number", value: obj[key], step: 0.5, ...attrs });
    input.addEventListener("change", () => (obj[key] = Number(input.value)));
    return h("div", { class: "field", style: { flex: 1 } }, h("label", {}, label), input);
  };

  const s = sheet(h("div", {},
    h("h2", {}, "Kamera-mapping"),
    status,
    h("div", { class: "list" }, devices.map((d) => {
      const c = h("input", { type: "checkbox", checked: true });
      c.addEventListener("change", () => (c.checked ? chosen.add(d.id) : chosen.delete(d.id)));
      return h("label", { class: "list-item" }, c, h("div", { class: "grow" }, d.name), h("span", { class: "muted" }, `${d.led_count} LEDs`));
    })),
    h("details", {},
      h("summary", { class: "muted", style: { margin: "10px 0" } }, "Placering på grid og avanceret"),
      h("p", { class: "muted" }, "Hvor på det samlede grid skal det scannede billede placeres? (fx forsiden af huset). Scan flere facader hver for sig og placér dem forskellige steder."),
      h("div", { class: "row" }, numField("X", area, "x"), numField("Y", area, "y")),
      h("div", { class: "row" }, numField("Bredde", area, "width"), numField("Højde", area, "height")),
      (() => {
        const lv = h("input", { type: "range", min: 30, max: 255, value: level });
        lv.addEventListener("input", () => (level = Number(lv.value)));
        const st = h("input", { type: "number", value: settle, min: 100, max: 2000, step: 50 });
        st.addEventListener("change", () => (settle = Number(st.value)));
        return h("div", {},
          h("div", { class: "field" }, h("label", {}, "LED-lysstyrke under scanning (lavere = mindre overstråling)"), lv),
          h("div", { class: "field" }, h("label", {}, "Ventetid pr. billede (ms) – øg ved langsomt WiFi"), st));
      })()),
    video, overlay, progress,
    h("div", { class: "row", style: { marginTop: "12px" } }, startBtn, saveBtn,
      h("button", { class: "btn secondary", onclick: () => s.close() }, "Luk")),
  ), { onClose: cleanup });

  navigator.mediaDevices.getUserMedia({
    video: { facingMode: { ideal: "environment" }, width: { ideal: 1280 }, height: { ideal: 720 } }, audio: false,
  }).then((st) => { stream = st; video.srcObject = st; })
    .catch((e) => { status.textContent = `Kunne ikke åbne kameraet: ${e.message}`; startBtn.disabled = true; });

  async function cleanup() {
    stream?.getTracks().forEach((t) => t.stop());
    wakeLock?.release?.().catch(() => {});
    if (running || store.config.scan) await post("scan/stop").catch(() => {});
  }

  // --- capture helpers
  const work = document.createElement("canvas");
  const wctx = work.getContext("2d", { willReadFrequently: true });
  function grab() {
    const vw = video.videoWidth, vh = video.videoHeight;
    work.width = WORK_WIDTH; work.height = Math.round((WORK_WIDTH * vh) / vw);
    wctx.drawImage(video, 0, 0, work.width, work.height);
    const { data } = wctx.getImageData(0, 0, work.width, work.height);
    const lum = new Float32Array(work.width * work.height);
    for (let i = 0, j = 0; j < lum.length; i += 4, j++) lum[j] = 0.299 * data[i] + 0.587 * data[i + 1] + 0.114 * data[i + 2];
    return lum;
  }
  async function frame(pattern) {
    await post("scan/pattern", pattern);
    await sleep(settle);
    // average two captures to fight sensor noise and rolling-shutter tearing
    const a = grab();
    await sleep(40);
    const b = grab();
    for (let i = 0; i < a.length; i++) a[i] = (a[i] + b[i]) / 2;
    return a;
  }

  async function lockExposure() {
    const track = stream.getVideoTracks()[0];
    const caps = track.getCapabilities?.() || {};
    const advanced = [];
    if (caps.exposureMode?.includes("manual")) advanced.push({ exposureMode: "manual" });
    if (caps.whiteBalanceMode?.includes("manual")) advanced.push({ whiteBalanceMode: "manual" });
    if (caps.focusMode?.includes("manual")) advanced.push({ focusMode: "manual" });
    if (advanced.length) await track.applyConstraints({ advanced }).catch(() => {});
    return advanced.length > 0;
  }

  async function run() {
    if (!chosen.size) return toast("Vælg mindst én enhed");
    if (!video.videoWidth) return toast("Kameraet er ikke klar endnu");
    running = true;
    startBtn.disabled = true;
    saveBtn.style.display = "none";
    overlay.style.display = "none";
    video.style.display = "";
    progress.style.display = "";
    try {
      wakeLock = await navigator.wakeLock?.request("screen").catch(() => null);
      const scan = await post("scan/start", { device_ids: [...chosen], level });
      const steps = 2 + scan.bits * 2;
      let done = 0;
      const tick = (msg) => { progress.value = ++done / steps; status.textContent = msg; };

      // let auto-exposure settle on the lit scene, then try to lock it
      await post("scan/pattern", { kind: "all" });
      status.textContent = "Justerer kameraet…";
      await sleep(1500);
      const locked = await lockExposure();
      const all = await frame({ kind: "all" }); tick("Alle tændt");
      const black = await frame({ kind: "black" }); tick("Alle slukket");
      const pairs = [];
      for (let bit = 0; bit < scan.bits; bit++) {
        const on = await frame({ kind: "bit", bit }); tick(`Mønster ${bit + 1}/${scan.bits}`);
        const off = await frame({ kind: "bit", bit, inverse: true }); tick(`Mønster ${bit + 1}/${scan.bits} (omvendt)`);
        pairs.push([on, off]);
      }
      await post("scan/stop");
      running = false;

      const result = decode(all, black, pairs, scan, work.width, work.height);
      showResult(result, all, scan, locked);
    } catch (e) {
      toast(e.message);
      status.textContent = `Fejl: ${e.message}`;
      await post("scan/stop").catch(() => {});
      running = false;
    } finally {
      startBtn.disabled = false;
      startBtn.textContent = "Scan igen";
      progress.style.display = "none";
    }
  }

  function showResult(result, all, scan, locked) {
    const { leds, found, w, hgt } = result;
    video.style.display = "none";
    overlay.style.display = "";
    overlay.width = w; overlay.height = hgt;
    const octx = overlay.getContext("2d");
    const img = octx.createImageData(w, hgt);
    for (let i = 0; i < all.length; i++) {
      const v = all[i] * 0.6;
      img.data[i * 4] = img.data[i * 4 + 1] = img.data[i * 4 + 2] = v; img.data[i * 4 + 3] = 255;
    }
    octx.putImageData(img, 0, 0);
    leds.forEach((p) => {
      if (!p) return;
      octx.fillStyle = p.estimated ? "rgba(255,180,0,.9)" : "rgba(40,220,110,.95)";
      octx.beginPath(); octx.arc(p.x, p.y, 2.2, 0, 2 * Math.PI); octx.fill();
    });
    const pct = Math.round((found / scan.total) * 100);
    status.textContent = `Fandt ${found} af ${scan.total} LEDs (${pct} %). Grønne er målt, gule er udregnet mellem naboer.` +
      (locked ? "" : " Tip: kameraets eksponering kunne ikke låses – hvis resultatet er dårligt, prøv i mørke eller med lavere LED-lysstyrke.");
    if (!found) return;
    saveBtn.style.display = "";
    saveBtn.onclick = () => save(result, scan);
  }

  async function save(result, scan) {
    const { leds, w, hgt } = result;
    // fit image into the chosen grid area, keeping its aspect ratio
    const k = Math.min(area.width / w, area.height / hgt);
    const offX = area.x + (area.width - w * k) / 2, offY = area.y + (area.height - hgt * k) / 2;
    const layout = structuredClone(store.config.layout);
    layout.placements = layout.placements.filter((p) => !scan.device_ids.includes(p.device_id));
    for (const r of scan.ranges) {
      const points = [];
      for (let i = 0; i < r.count; i++) {
        const p = leds[r.offset + i];
        points.push(p ? [+(offX + p.x * k).toFixed(3), +(offY + p.y * k).toFixed(3)] : [offX, offY]);
      }
      layout.placements.push({
        id: `pl_${Math.random().toString(16).slice(2, 10)}`, device_id: r.device_id, start: 0, count: r.count,
        shape: "points", points, reverse: false, x: 0, y: 0, width: 1, height: 1, cols: 0, rows: 0,
        serpentine: true, origin: "top-left", vertical: false, z: 0,
      });
    }
    try {
      await put("layout", layout);
      toast("Pixel-map gemt på grid'et");
      s.close();
      location.hash = "grid";
    } catch (e) { toast(e.message); }
  }
}

// ----------------------------------------------------------------- decoding

export function decode(all, black, pairs, scan, w, hgt) {
  const n = all.length;
  const amp = new Float32Array(n);
  let maxAmp = 0;
  for (let i = 0; i < n; i++) { amp[i] = all[i] - black[i]; if (amp[i] > maxAmp) maxAmp = amp[i]; }
  const minAmp = Math.max(25, maxAmp * 0.18);

  const acc = new Map(); // code -> [sumX, sumY, sumW, count]
  for (let i = 0; i < n; i++) {
    if (amp[i] < minAmp) continue;
    let code = 0, ok = true;
    for (let b = 0; b < pairs.length; b++) {
      const d = pairs[b][0][i] - pairs[b][1][i];
      if (Math.abs(d) < amp[i] * 0.3) { ok = false; break; } // ambiguous: LED edge or overlap
      if (d > 0) code |= 1 << b;
    }
    if (!ok || code < 1 || code > scan.total) continue;
    const x = i % w, y = (i / w) | 0, wt = amp[i];
    const a = acc.get(code) || [0, 0, 0, 0];
    a[0] += x * wt; a[1] += y * wt; a[2] += wt; a[3]++;
    acc.set(code, a);
  }

  const leds = new Array(scan.total).fill(null);
  for (const [code, [sx, sy, sw, count]] of acc) {
    if (count >= 2) leds[code - 1] = { x: sx / sw, y: sy / sw, estimated: false };
  }

  // Reject outliers: a found LED far from both index-neighbours is likely a reflection.
  for (const r of scan.ranges) {
    const dists = [];
    for (let i = r.offset + 1; i < r.offset + r.count; i++) {
      const a = leds[i - 1], b = leds[i];
      if (a && b) dists.push(Math.hypot(a.x - b.x, a.y - b.y));
    }
    dists.sort((a, b) => a - b);
    const median = dists[dists.length >> 1] || 0;
    if (median > 0) {
      for (let i = r.offset; i < r.offset + r.count; i++) {
        const p = leds[i];
        if (!p) continue;
        const prev = leds[i - 1] && i > r.offset ? leds[i - 1] : null;
        const next = leds[i + 1] && i < r.offset + r.count - 1 ? leds[i + 1] : null;
        const far = (q) => !q || Math.hypot(q.x - p.x, q.y - p.y) > median * 8;
        if ((prev || next) && far(prev) && far(next)) leds[i] = null;
      }
    }
  }

  let found = leds.filter(Boolean).length;

  // Fill gaps by interpolating between nearest found neighbours on the same device.
  for (const r of scan.ranges) {
    const end = r.offset + r.count;
    let last = -1;
    for (let i = r.offset; i < end; i++) {
      if (!leds[i]) continue;
      if (last >= 0 && i - last > 1) {
        const a = leds[last], b = leds[i];
        for (let j = last + 1; j < i; j++) {
          const t = (j - last) / (i - last);
          leds[j] = { x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t, estimated: true };
        }
      }
      last = i;
    }
    const firstFound = leds.slice(r.offset, end).findIndex(Boolean);
    if (firstFound > 0) for (let j = r.offset; j < r.offset + firstFound; j++) leds[j] = { ...leds[r.offset + firstFound], estimated: true };
    if (last >= 0) for (let j = last + 1; j < end; j++) leds[j] = { ...leds[last], estimated: true };
  }
  return { leds, found, w, hgt };
}
