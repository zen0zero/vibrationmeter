// Minimal canvas charts with touch/hover tooltips. Colours come from CSS tokens.

const css = name => getComputedStyle(document.documentElement).getPropertyValue(name).trim();

function setup(el) {
  el.querySelectorAll('.empty').forEach(n => n.remove());
  let canvas = el.querySelector('canvas');
  let tip = el.querySelector('.tip');
  if (!canvas) {
    canvas = document.createElement('canvas');
    tip = document.createElement('div');
    tip.className = 'tip';
    el.append(canvas, tip);
  }
  const dpr = window.devicePixelRatio || 1;
  const w = el.clientWidth, h = el.clientHeight;
  canvas.width = Math.round(w * dpr); canvas.height = Math.round(h * dpr);
  canvas.style.width = w + 'px'; canvas.style.height = h + 'px';
  const ctx = canvas.getContext('2d');
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.font = '11px system-ui, -apple-system, "Segoe UI", sans-serif';
  return { canvas, tip, ctx, w, h };
}

function niceTicks(min, max, count = 5) {
  if (!(max > min)) return [min];
  const span = max - min;
  const step0 = span / count;
  const mag = 10 ** Math.floor(Math.log10(step0));
  const step = [1, 2, 2.5, 5, 10].map(m => m * mag).find(s => span / s <= count) || 10 * mag;
  const out = [];
  for (let v = Math.ceil(min / step) * step; v <= max + step * 1e-9; v += step) out.push(+v.toFixed(10));
  return out;
}

function frame(ctx, box, xScale, yScale, xTicks, yTicks, opts) {
  const { x0, y0, x1, y1 } = box;
  ctx.strokeStyle = css('--grid');
  ctx.lineWidth = 1;
  ctx.fillStyle = css('--muted');
  ctx.textAlign = 'right'; ctx.textBaseline = 'middle';
  for (const t of yTicks) {
    const y = Math.round(yScale(t)) + 0.5;
    if (!opts.noGrid) { ctx.beginPath(); ctx.moveTo(x0, y); ctx.lineTo(x1, y); ctx.stroke(); }
    ctx.fillText((opts.yFmt || String)(t), x0 - 6, y);
  }
  ctx.textAlign = 'center'; ctx.textBaseline = 'top';
  for (const t of xTicks) ctx.fillText((opts.xFmt || String)(t), xScale(t), y1 + 6);
  ctx.strokeStyle = css('--axis');
  ctx.beginPath(); ctx.moveTo(x0, y1 + 0.5); ctx.lineTo(x1, y1 + 0.5); ctx.stroke();
  ctx.fillStyle = css('--muted');
  if (opts.xLabel) { ctx.textAlign = 'right'; ctx.textBaseline = 'bottom'; ctx.fillText(opts.xLabel, x1, box.h - 2); }
  if (opts.yLabel) { ctx.textAlign = 'left'; ctx.textBaseline = 'top'; ctx.fillText(opts.yLabel, 4, 2); }
}

function showTip(tip, el, px, py, html) {
  if (!html) { tip.style.display = 'none'; return; }
  tip.innerHTML = html;
  tip.style.display = 'block';
  const tw = tip.offsetWidth, th = tip.offsetHeight;
  let x = px + 12, y = py - th - 8;
  if (x + tw > el.clientWidth) x = px - tw - 12;
  if (x < 0) x = 2;
  if (y < 0) y = py + 12;
  tip.style.left = x + 'px'; tip.style.top = y + 'px';
}

function bindHover(el, canvas, onMove) {
  canvas.onpointermove = canvas.onpointerdown = e => {
    const r = canvas.getBoundingClientRect();
    onMove(e.clientX - r.left, e.clientY - r.top);
  };
  canvas.onpointerleave = () => onMove(null, null);
}

function autoRedraw(el, draw) {
  if (el._ro) el._ro.disconnect();
  let lastW = el.clientWidth;
  const safeDraw = () => { if (el.clientWidth > 0 && el.clientHeight > 0) draw(); };
  el._ro = new ResizeObserver(() => { if (el.clientWidth !== lastW) { lastW = el.clientWidth; safeDraw(); } });
  el._ro.observe(el);
  safeDraw();
}

const swatch = c => `<i class="sw" style="background:${c}"></i>`;

// Line chart. series: [{name, color, y: array}], x: shared array.
export function lineChart(el, opts) {
  autoRedraw(el, () => {
    const { canvas, tip, ctx, w, h } = setup(el);
    const { x, series } = opts;
    const box = { x0: 44, y0: 16, x1: w - 10, y1: h - 22, h };
    let xMin = opts.xMin ?? Infinity, xMax = opts.xMax ?? -Infinity;
    if (opts.xMin === undefined) for (const v of x) if (Number.isFinite(v)) { xMin = Math.min(xMin, v); xMax = Math.max(xMax, v); }
    let yMin = opts.yMin ?? Infinity, yMax = -Infinity;
    for (const s of series) for (const v of s.y) if (Number.isFinite(v)) { yMax = Math.max(yMax, v); if (opts.yMin === undefined) yMin = Math.min(yMin, v); }
    if (!Number.isFinite(yMax)) { yMin = 0; yMax = 1; }
    if (yMax === yMin) yMax = yMin + 1;
    const yTicks = niceTicks(yMin, yMax, Math.max(3, Math.floor((box.y1 - box.y0) / 40)));
    yMax = Math.max(yMax, yTicks[yTicks.length - 1]);
    const xs = v => box.x0 + (v - xMin) / (xMax - xMin || 1) * (box.x1 - box.x0);
    const ys = v => box.y1 - (v - yMin) / (yMax - yMin) * (box.y1 - box.y0);
    ctx.clearRect(0, 0, w, h);
    frame(ctx, box, xs, ys, niceTicks(xMin, xMax, Math.max(3, Math.floor(w / 80))), yTicks, opts);

    for (const b of opts.bands || []) {
      ctx.fillStyle = b.color;
      ctx.fillRect(xs(b.from), box.y0, Math.max(1, xs(b.to) - xs(b.from)), box.y1 - box.y0);
    }
    for (const vl of opts.vlines || []) {
      const px = Math.round(xs(vl.x)) + 0.5;
      if (px < box.x0 || px > box.x1) continue;
      ctx.strokeStyle = vl.color || css('--axis');
      ctx.setLineDash(vl.dash || [4, 3]);
      ctx.beginPath(); ctx.moveTo(px, box.y0); ctx.lineTo(px, box.y1); ctx.stroke();
      ctx.setLineDash([]);
      if (vl.label) {
        ctx.fillStyle = css('--text-2'); ctx.textAlign = 'center'; ctx.textBaseline = 'bottom';
        ctx.fillText(vl.label, px, box.y0 - 1);
      }
    }
    ctx.lineWidth = opts.lineWidth || 1.5;
    ctx.lineJoin = 'round';
    // Decimate to ~2 points per pixel (min/max per bucket keeps the peaks).
    const step = Math.max(1, Math.floor(x.length / ((box.x1 - box.x0) * 2)));
    for (const s of series) {
      ctx.strokeStyle = s.color;
      ctx.beginPath();
      let pen = false;
      for (let i = 0; i < x.length; i += step) {
        let lo = Infinity, hi = -Infinity;
        for (let j = i; j < Math.min(x.length, i + step); j++) if (Number.isFinite(s.y[j])) { lo = Math.min(lo, s.y[j]); hi = Math.max(hi, s.y[j]); }
        if (!Number.isFinite(lo)) { pen = false; continue; }
        const px = xs(x[i]);
        if (!pen) { ctx.moveTo(px, ys(lo)); pen = true; } else ctx.lineTo(px, ys(lo));
        if (hi !== lo) ctx.lineTo(px, ys(hi));
      }
      ctx.stroke();
    }
    if (opts.noHover) return;
    const base = ctx.getImageData(0, 0, canvas.width, canvas.height);
    bindHover(el, canvas, (px, py) => {
      ctx.putImageData(base, 0, 0);
      if (px === null || px < box.x0 || px > box.x1) return showTip(tip, el, 0, 0, null);
      const xv = xMin + (px - box.x0) / (box.x1 - box.x0) * (xMax - xMin);
      let lo = 0, hi = x.length - 1;
      while (hi - lo > 1) { const m = (lo + hi) >> 1; if (x[m] < xv) lo = m; else hi = m; }
      const i = Math.abs(x[lo] - xv) < Math.abs(x[hi] - xv) ? lo : hi;
      const cx = Math.round(xs(x[i])) + 0.5;
      ctx.strokeStyle = css('--text-2'); ctx.lineWidth = 1;
      ctx.beginPath(); ctx.moveTo(cx, box.y0); ctx.lineTo(cx, box.y1); ctx.stroke();
      const rows = series.map(s => {
        if (Number.isFinite(s.y[i])) {
          ctx.fillStyle = s.color; ctx.strokeStyle = css('--surface'); ctx.lineWidth = 2;
          ctx.beginPath(); ctx.arc(cx, ys(s.y[i]), 4, 0, 7); ctx.fill(); ctx.stroke();
        }
        return `<div>${swatch(s.color)}${s.name}: <b>${Number.isFinite(s.y[i]) ? (opts.yFmtTip || opts.yFmt || (v => v.toFixed(3)))(s.y[i]) : '–'}</b></div>`;
      });
      showTip(tip, el, cx, py, `<div class="tip-h">${(opts.xFmtTip || opts.xFmt || String)(x[i])}</div>${rows.join('')}${opts.extraTip ? opts.extraTip(i) : ''}`);
    });
  });
}

// Sequential ramp (one hue): near-zero recedes into the surface.
function rampColor(t, stops) {
  t = Math.max(0, Math.min(1, t));
  const p = t * (stops.length - 1), i = Math.min(stops.length - 2, Math.floor(p)), f = p - i;
  const a = stops[i], b = stops[i + 1];
  return [0, 1, 2].map(c => Math.round(a[c] + (b[c] - a[c]) * f));
}
const hex = s => [1, 3, 5].map(i => parseInt(s.slice(i, i + 2), 16));

// Heatmap. nx × ny cells; value(xi, yi) returns linear power; overlays are polylines.
export function heatmap(el, opts) {
  autoRedraw(el, () => {
    const { canvas, tip, ctx, w, h } = setup(el);
    const { nx, ny, value, xAt, yAt } = opts;
    const box = { x0: 44, y0: 16, x1: w - 10, y1: h - 22, h };
    const stops = css('--ramp').split(',').map(s => hex(s.trim()));
    const db = [];
    for (let xi = 0; xi < nx; xi++) for (let yi = 0; yi < ny; yi++) {
      const v = value(xi, yi);
      if (v > 0) db.push(10 * Math.log10(v));
    }
    db.sort((a, b) => a - b);
    const lo = db[Math.floor(db.length * 0.05)] ?? -60, hi = db[Math.floor(db.length * 0.995)] ?? 0;
    const img = ctx.createImageData(nx, ny);
    for (let xi = 0; xi < nx; xi++) for (let yi = 0; yi < ny; yi++) {
      const v = value(xi, yi);
      const o = ((ny - 1 - yi) * nx + xi) * 4;
      if (v === null || v === undefined || !(v >= 0)) { img.data[o + 3] = 0; continue; }
      const c = rampColor(v > 0 ? (10 * Math.log10(v) - lo) / (hi - lo) : 0, stops);
      img.data[o] = c[0]; img.data[o + 1] = c[1]; img.data[o + 2] = c[2]; img.data[o + 3] = 255;
    }
    const off = document.createElement('canvas');
    off.width = nx; off.height = ny;
    off.getContext('2d').putImageData(img, 0, 0);
    ctx.clearRect(0, 0, w, h);
    ctx.imageSmoothingEnabled = false;
    ctx.drawImage(off, box.x0, box.y0, box.x1 - box.x0, box.y1 - box.y0);
    const xMin = opts.xMin, xMax = opts.xMax, yMin = opts.yMin, yMax = opts.yMax;
    const xs = v => box.x0 + (v - xMin) / (xMax - xMin) * (box.x1 - box.x0);
    const ys = v => box.y1 - (v - yMin) / (yMax - yMin) * (box.y1 - box.y0);
    frame(ctx, box, xs, ys, niceTicks(xMin, xMax, Math.max(3, Math.floor(w / 80))), niceTicks(yMin, yMax, 5), { ...opts, noGrid: true });
    ctx.save();
    ctx.beginPath(); ctx.rect(box.x0, box.y0, box.x1 - box.x0, box.y1 - box.y0); ctx.clip();
    for (const ov of opts.overlays || []) {
      ctx.strokeStyle = ov.color; ctx.lineWidth = 1.5; ctx.setLineDash(ov.dash || [5, 4]);
      ctx.beginPath();
      let pen = false;
      for (const [x, y] of ov.points) {
        if (!Number.isFinite(y)) { pen = false; continue; }
        if (!pen) { ctx.moveTo(xs(x), ys(y)); pen = true; } else ctx.lineTo(xs(x), ys(y));
      }
      ctx.stroke();
      ctx.setLineDash([]);
      const last = ov.labelAt || ov.points.filter(p => Number.isFinite(p[1]) && p[1] < yMax).pop();
      if (last && ov.label) {
        ctx.fillStyle = css('--text-1'); ctx.textAlign = 'right'; ctx.textBaseline = 'bottom';
        ctx.fillText(ov.label, Math.min(xs(last[0]), box.x1 - 2), ys(last[1]) - 3);
      }
    }
    ctx.restore();
    const base = ctx.getImageData(0, 0, canvas.width, canvas.height);
    bindHover(el, canvas, (px, py) => {
      ctx.putImageData(base, 0, 0);
      if (px === null || px < box.x0 || px > box.x1 || py < box.y0 || py > box.y1) return showTip(tip, el, 0, 0, null);
      const xi = Math.min(nx - 1, Math.floor((px - box.x0) / (box.x1 - box.x0) * nx));
      const yi = Math.min(ny - 1, Math.floor((box.y1 - py) / (box.y1 - box.y0) * ny));
      const cw = (box.x1 - box.x0) / nx, ch = (box.y1 - box.y0) / ny;
      ctx.strokeStyle = css('--text-1'); ctx.lineWidth = 1;
      ctx.strokeRect(box.x0 + xi * cw, box.y1 - (yi + 1) * ch, Math.max(cw, 2), Math.max(ch, 2));
      showTip(tip, el, px, py, opts.tooltip(xi, yi, value(xi, yi)));
    });
  });
}

// Vertical bars. items: [{label, value, color, tip}]
export function barChart(el, opts) {
  autoRedraw(el, () => {
    const { canvas, tip, ctx, w, h } = setup(el);
    const items = opts.items;
    const box = { x0: 44, y0: 16, x1: w - 10, y1: h - 22, h };
    const yMax0 = Math.max(1e-9, ...items.map(i => i.value).filter(Number.isFinite));
    const yTicks = niceTicks(0, yMax0, 4);
    const yMax = Math.max(yMax0, yTicks[yTicks.length - 1]);
    const ys = v => box.y1 - v / yMax * (box.y1 - box.y0);
    const slot = (box.x1 - box.x0) / Math.max(1, items.length);
    const xs = i => box.x0 + slot * i;
    ctx.clearRect(0, 0, w, h);
    const labelEvery = Math.ceil(items.length / Math.max(1, Math.floor((box.x1 - box.x0) / 36)));
    frame(ctx, box, i => xs(i) + slot / 2, ys, [], yTicks, opts);
    ctx.fillStyle = css('--muted'); ctx.textAlign = 'center'; ctx.textBaseline = 'top';
    items.forEach((it, i) => { if (i % labelEvery === 0) ctx.fillText(it.label, xs(i) + slot / 2, box.y1 + 6); });
    const bw = Math.max(2, Math.min(28, slot - 2));
    const drawBar = (it, i, hl) => {
      const x = xs(i) + (slot - bw) / 2, y = ys(it.value), bh = box.y1 - y;
      ctx.fillStyle = it.color;
      ctx.globalAlpha = hl ? 1 : 0.9;
      ctx.beginPath();
      const r = Math.min(4, bw / 2, bh);
      ctx.moveTo(x, box.y1); ctx.lineTo(x, y + r); ctx.arcTo(x, y, x + r, y, r);
      ctx.lineTo(x + bw - r, y); ctx.arcTo(x + bw, y, x + bw, y + r, r); ctx.lineTo(x + bw, box.y1);
      ctx.fill();
      ctx.globalAlpha = 1;
      if (hl) { ctx.strokeStyle = css('--text-1'); ctx.lineWidth = 1; ctx.stroke(); }
    };
    items.forEach((it, i) => drawBar(it, i, false));
    const base = ctx.getImageData(0, 0, canvas.width, canvas.height);
    bindHover(el, canvas, (px, py) => {
      ctx.putImageData(base, 0, 0);
      if (px === null || px < box.x0 || px > box.x1) return showTip(tip, el, 0, 0, null);
      const i = Math.min(items.length - 1, Math.floor((px - box.x0) / slot));
      drawBar(items[i], i, true);
      showTip(tip, el, xs(i) + slot / 2, py, items[i].tip);
    });
  });
}
