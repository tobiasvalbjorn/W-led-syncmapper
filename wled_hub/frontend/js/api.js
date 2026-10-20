// Hub API client. Every URL is relative to the page so the app works both on
// http://<hub>:8787/ and behind Home Assistant ingress (/api/hassio_ingress/<token>/).
const base = new URL(".", location.href);

function token() {
  const fromUrl = new URLSearchParams(location.search).get("token");
  try {
    if (fromUrl) localStorage.setItem("wledhub-token", fromUrl);
    return fromUrl || localStorage.getItem("wledhub-token") || "";
  } catch {
    return fromUrl || "";
  }
}

export class ApiError extends Error {}

export async function api(method, path, body) {
  const headers = { "Content-Type": "application/json" };
  const t = token();
  if (t) headers.Authorization = `Bearer ${t}`;
  const res = await fetch(new URL(`api/${path}`, base), {
    method,
    headers,
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new ApiError(data.error || `${res.status} ${res.statusText}`);
  return data;
}

export const get = (p) => api("GET", p);
export const post = (p, b = {}) => api("POST", p, b);
export const put = (p, b = {}) => api("PUT", p, b);
export const patch = (p, b = {}) => api("PATCH", p, b);
export const del = (p) => api("DELETE", p);

// Throttle rapid calls (sliders, colour wheel) to one in flight + latest.
// .cancel() drops a call that is still waiting.
export function throttled(fn, ms = 80) {
  let timer = null, pending = null;
  const call = (...args) => {
    pending = args;
    if (timer) return;
    fn(...pending);
    pending = null;
    timer = setTimeout(function tick() {
      timer = null;
      if (pending) { fn(...pending); pending = null; timer = setTimeout(tick, ms); }
    }, ms);
  };
  call.cancel = () => { pending = null; };
  return call;
}

// Live connection: config pushes and (optionally) pixel preview frames.
export function connect({ onConfig, onPreview, onStatus }) {
  let ws, retry = 1000, wantPreview = false, previewFps = 8;
  const open = () => {
    const url = new URL("api/ws", base);
    url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
    const t = token();
    if (t) url.searchParams.set("token", t);
    if (wantPreview) { url.searchParams.set("preview", "1"); url.searchParams.set("fps", previewFps); }
    ws = new WebSocket(url);
    ws.onopen = () => { retry = 1000; onStatus(true); };
    ws.onmessage = (ev) => {
      const msg = JSON.parse(ev.data);
      if (msg.type === "config") onConfig(msg.data);
      else if (msg.type === "preview") onPreview?.(msg.data);
    };
    ws.onclose = () => {
      onStatus(false);
      setTimeout(open, retry);
      retry = Math.min(retry * 2, 15000);
    };
  };
  open();
  return {
    preview(enabled, fps = previewFps) {
      wantPreview = enabled; previewFps = fps;
      if (ws?.readyState === 1) ws.send(JSON.stringify({ type: "preview", enabled, fps }));
    },
  };
}
