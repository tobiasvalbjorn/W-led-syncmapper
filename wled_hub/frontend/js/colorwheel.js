// Hue/saturation colour wheel on a canvas (touch + mouse).

function hsvToRgb(h, s, v) {
  const f = (n) => {
    const k = (n + h * 6) % 6;
    return Math.round(255 * (v - v * s * Math.max(0, Math.min(k, 4 - k, 1))));
  };
  return [f(5), f(3), f(1)];
}

function rgbToHs([r, g, b]) {
  r /= 255; g /= 255; b /= 255;
  const max = Math.max(r, g, b), min = Math.min(r, g, b), d = max - min;
  let h = 0;
  if (d) {
    if (max === r) h = ((g - b) / d) % 6;
    else if (max === g) h = (b - r) / d + 2;
    else h = (r - g) / d + 4;
    h /= 6;
    if (h < 0) h += 1;
  }
  return [h, max ? d / max : 0];
}

export function colorWheel({ size = 260, color = [255, 255, 255], onchange }) {
  const dpr = window.devicePixelRatio || 1;
  const canvas = document.createElement("canvas");
  canvas.className = "colorwheel";
  canvas.width = canvas.height = size * dpr;
  canvas.style.width = canvas.style.height = `${size}px`;
  const ctx = canvas.getContext("2d");
  const r = (size * dpr) / 2;

  // Pre-render the wheel once.
  const wheel = ctx.createImageData(size * dpr, size * dpr);
  for (let y = 0; y < size * dpr; y++) {
    for (let x = 0; x < size * dpr; x++) {
      const dx = x - r, dy = y - r, d = Math.hypot(dx, dy);
      if (d > r) continue;
      const hue = (Math.atan2(dy, dx) / (2 * Math.PI) + 1) % 1;
      const [cr, cg, cb] = hsvToRgb(hue, d / r, 1);
      const i = (y * size * dpr + x) * 4;
      wheel.data[i] = cr; wheel.data[i + 1] = cg; wheel.data[i + 2] = cb;
      wheel.data[i + 3] = d > r - 1.5 ? 255 * (r - d) / 1.5 : 255;
    }
  }

  let [hue, sat] = rgbToHs(color);
  const draw = () => {
    ctx.putImageData(wheel, 0, 0);
    const a = hue * 2 * Math.PI, px = r + Math.cos(a) * sat * r, py = r + Math.sin(a) * sat * r;
    ctx.beginPath();
    ctx.arc(px, py, 12 * dpr, 0, 2 * Math.PI);
    ctx.lineWidth = 3 * dpr;
    ctx.strokeStyle = "#fff";
    ctx.fillStyle = `rgb(${hsvToRgb(hue, sat, 1).join(",")})`;
    ctx.fill();
    ctx.stroke();
  };
  draw();

  const pick = (e) => {
    const rect = canvas.getBoundingClientRect();
    const x = ((e.clientX - rect.left) / rect.width) * 2 - 1;
    const y = ((e.clientY - rect.top) / rect.height) * 2 - 1;
    hue = (Math.atan2(y, x) / (2 * Math.PI) + 1) % 1;
    sat = Math.min(1, Math.hypot(x, y));
    draw();
    onchange(hsvToRgb(hue, sat, 1));
  };
  canvas.addEventListener("pointerdown", (e) => { canvas.setPointerCapture(e.pointerId); pick(e); });
  canvas.addEventListener("pointermove", (e) => { if (e.buttons) pick(e); });

  canvas.setColor = (c) => { [hue, sat] = rgbToHs(c); draw(); };
  return canvas;
}
