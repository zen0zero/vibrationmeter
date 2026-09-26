import { Recorder } from './recorder.js';
import { listSessions, loadChunks, deleteSession, getSession } from './storage.js';
import { trackFromRecording, trackFromFile, toCsv, toJson, download, fileStamp } from './format.js';
import { analyze, liveSpectrum, highPass, tireCircumference, vehicleCircumference } from './analysis.js';
import { lineChart, heatmap, barChart } from './charts.js';
import { simulateDrive } from './sim.js';

const $ = s => document.querySelector(s);
const cssVar = n => getComputedStyle(document.documentElement).getPropertyValue(n).trim();
const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

function toast(msg) {
  const t = $('#toast');
  t.textContent = msg;
  t.classList.add('show');
  clearTimeout(toast.timer);
  toast.timer = setTimeout(() => t.classList.remove('show'), 2500);
}

function fmtDuration(ms) {
  const s = Math.round(ms / 1000);
  const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), r = s % 60;
  return h ? `${h}:${String(m).padStart(2, '0')}:${String(r).padStart(2, '0')}` : `${m}:${String(r).padStart(2, '0')}`;
}

// ---------- tabs ----------
function showView(name) {
  document.querySelectorAll('.tabs button').forEach(b => b.setAttribute('aria-selected', b.dataset.view === name));
  document.querySelectorAll('.view').forEach(v => v.classList.toggle('active', v.id === `view-${name}`));
  if (name === 'recordings') refreshList();
  try { localStorage.setItem('vm.view', name); } catch (_) { /* ignore */ }
  window.scrollTo(0, 0);
}
document.querySelectorAll('.tabs button').forEach(b => b.addEventListener('click', () => showView(b.dataset.view)));

// ---------- vehicle ----------
const VEHICLE_KEY = 'vm.vehicle';
function loadVehicle() {
  try { return JSON.parse(localStorage.getItem(VEHICLE_KEY)) || {}; } catch (_) { return {}; }
}
function currentVehicle() {
  const f = $('#vehicle-form');
  const v = Object.fromEntries(new FormData(f).entries());
  return { tire: v.tire.trim(), circumference: v.circumference, finalDrive: v.finalDrive, cylinders: v.cylinders || '4', drive: v.drive, notes: v.notes };
}
function updateTireInfo() {
  const v = currentVehicle();
  const c = tireCircumference(v.tire);
  const used = vehicleCircumference(v);
  $('#tire-info').textContent = Number.isFinite(c)
    ? `Rolling circumference ≈ ${c.toFixed(3)} m → at 100 km/h a wheel turns ${(100 / 3.6 / used).toFixed(1)} times per second (${(100 / 3.6 / used).toFixed(1)} Hz).`
    : `Enter a size like 205/55R16. Using ${used.toFixed(2)} m until then.`;
}
(function initVehicle() {
  const f = $('#vehicle-form');
  const v = loadVehicle();
  for (const [k, val] of Object.entries(v)) if (f.elements[k]) f.elements[k].value = val;
  f.addEventListener('input', () => {
    try { localStorage.setItem(VEHICLE_KEY, JSON.stringify(currentVehicle())); } catch (_) { /* ignore */ }
    updateTireInfo();
  });
  f.addEventListener('submit', e => e.preventDefault());
  updateTireInfo();
})();

// ---------- recording ----------
const recorder = new Recorder(() => renderAlerts());
let liveTimer = null;

function renderAlerts() {
  const out = [];
  if (!window.isSecureContext) out.push(['error', 'Not secure', 'Open this page over HTTPS – browsers block sensors and GPS on plain http.']);
  if (recorder.sensorError) out.push(['error', 'Sensors', recorder.sensorError]);
  if (recorder.active && recorder.gpsError) out.push(['warn', 'GPS', `${recorder.gpsError}. Vibrations will be recorded but cannot be matched to speed.`]);
  if (recorder.storageError) out.push(['error', 'Storage', recorder.storageError]);
  $('#rec-alerts').innerHTML = out.map(([cls, t, m]) => `<div class="alert ${cls}"><b>${t}:</b>${esc(m)}</div>`).join('');
}
renderAlerts();

$('#btn-start').addEventListener('click', async () => {
  const btn = $('#btn-start');
  if (!recorder.active) {
    try {
      recorder.sensorError = null;
      await recorder.start({ name: $('#rec-name').value.trim(), vehicle: currentVehicle(), notes: currentVehicle().notes });
    } catch (err) {
      recorder.sensorError = err.message;
      renderAlerts();
      return;
    }
    btn.textContent = 'Stop recording';
    btn.classList.add('stop');
    $('#btn-mark').disabled = false;
    $('#rec-name').disabled = true;
    liveTimer = setInterval(updateLive, 250);
    renderAlerts();
  } else {
    btn.disabled = true;
    clearInterval(liveTimer);
    const meta = await recorder.stop();
    btn.disabled = false;
    btn.textContent = 'Start recording';
    btn.classList.remove('stop');
    $('#btn-mark').disabled = true;
    $('#rec-name').disabled = false;
    $('#rec-name').value = '';
    renderAlerts();
    toast(`Saved ${meta.samples.toLocaleString()} samples, ${meta.gpsFixes} GPS fixes`);
  }
});

$('#btn-mark').addEventListener('click', () => {
  recorder.mark();
  const b = $('#btn-mark');
  b.classList.add('flash');
  setTimeout(() => b.classList.remove('flash'), 400);
  if (navigator.vibrate) navigator.vibrate(60);
});

let liveTick = 0;
function updateLive() {
  if (!recorder.active) return;
  const L = recorder.live;
  const rate = recorder.rate;
  const fix = recorder.lastFix;
  const fresh = fix && Date.now() - fix.received < 5000;
  const speed = fresh && Number.isFinite(fix.speed) ? fix.speed : NaN;
  $('#live-speed').textContent = Number.isFinite(speed) ? Math.round(speed * 3.6) : '–';
  $('#live-rate').textContent = Number.isFinite(rate) ? rate.toFixed(0) : '–';
  $('#live-gps').textContent = fresh ? Math.round(fix.acc) : '–';
  $('#live-gps-unit').textContent = fresh ? 'accuracy m' : 'waiting for fix';
  $('#live-time').textContent = fmtDuration(recorder.elapsedMs);
  $('#live-samples').textContent = `${Math.round(recorder.sampleCount).toLocaleString()} samples`;
  if (Number.isFinite(rate) && L.x.length >= 64) {
    const s = liveSpectrum(L.x, L.y, L.z, rate);
    if (s) {
      $('#live-rms').textContent = s.rms.toFixed(2);
      $('#live-peak').textContent = s.peakHz.toFixed(1);
      const C = vehicleCircumference(currentVehicle());
      $('#live-order').textContent = speed > 3 ? `Hz · ${(s.peakHz / (speed / C)).toFixed(2)}× wheel` : 'Hz';
    }
  }
  if (liveTick++ % 2 === 0 && L.x.length > 16) drawLive(L, rate);
}

function drawLive(L, rate) {
  const n = Math.min(L.x.length, 480);
  const hpw = Math.max(3, Math.round((rate || 60) * 0.4));
  const cut = a => highPass(Float64Array.from(a.slice(-n)), hpw);
  const t0 = L.t[L.t.length - 1];
  const x = L.t.slice(-n).map(t => (t - t0) / 1000);
  lineChart($('#live-chart'), {
    x, noHover: true, lineWidth: 1.2, xFmt: v => `${v.toFixed(0)}s`, yFmt: v => v.toFixed(1),
    series: [
      { name: 'X', color: cssVar('--s1'), y: cut(L.x) },
      { name: 'Y', color: cssVar('--s2'), y: cut(L.y) },
      { name: 'Z', color: cssVar('--s3'), y: cut(L.z) },
    ],
  });
}

window.addEventListener('beforeunload', e => {
  if (recorder.active) { e.preventDefault(); e.returnValue = ''; }
});

// ---------- recordings list ----------
async function refreshList() {
  const list = $('#rec-list');
  let sessions = [];
  try { sessions = await listSessions(); } catch (err) { list.innerHTML = `<li>Storage unavailable: ${esc(err.message)}</li>`; return; }
  if (!sessions.length) {
    list.innerHTML = '<li class="muted">No recordings yet. Record a drive, import a file, or load the demo drive.</li>';
  } else {
    list.innerHTML = sessions.map(s => `
      <li data-id="${esc(s.id)}">
        <div class="name">${esc(s.name)}</div>
        <div class="muted small">${new Date(s.startedAt).toLocaleString()} · ${fmtDuration(s.durationMs || 0)} ·
          ${(s.samples || 0).toLocaleString()} samples · ${s.gpsFixes || 0} GPS fixes${s.markers ? ` · ${s.markers} marks` : ''}
          ${recorder.active && recorder.meta?.id === s.id ? ' · <b>recording…</b>' : ''}</div>
        <div class="actions">
          <button class="btn" data-act="analyze">Analyze</button>
          <button class="btn" data-act="csv">CSV</button>
          <button class="btn" data-act="json">JSON</button>
          <button class="btn danger" data-act="delete">Delete</button>
        </div>
      </li>`).join('');
  }
  try {
    const est = await navigator.storage?.estimate?.();
    if (est) $('#storage-info').textContent = `Using ${(est.usage / 1e6).toFixed(1)} MB of ${(est.quota / 1e6).toFixed(0)} MB available on this phone.`;
  } catch (_) { /* ignore */ }
}

async function loadRecording(id) {
  const meta = await getSession(id);
  const chunks = await loadChunks(id);
  return { meta, motion: chunks.motion, gps: chunks.gps, markers: chunks.marker };
}

$('#rec-list').addEventListener('click', async e => {
  const btn = e.target.closest('button[data-act]');
  if (!btn) return;
  const id = btn.closest('li').dataset.id;
  const act = btn.dataset.act;
  if (recorder.active && recorder.meta?.id === id && act !== 'analyze') await recorder.flush();
  try {
    if (act === 'delete') {
      if (recorder.active && recorder.meta?.id === id) return toast('Stop the recording first');
      if (!confirm('Delete this recording permanently?')) return;
      await deleteSession(id);
      refreshList();
      return;
    }
    btn.disabled = true;
    const rec = await loadRecording(id);
    btn.disabled = false;
    const stamp = fileStamp(rec.meta.startedAt);
    if (act === 'csv') download(`vibration-${stamp}.csv`, toCsv(trackFromRecording(rec)), 'text/csv');
    if (act === 'json') download(`vibration-${stamp}.json`, toJson(rec), 'application/json');
    if (act === 'analyze') openAnalysis(rec, trackFromRecording(rec));
  } catch (err) {
    btn.disabled = false;
    toast(`Failed: ${err.message}`);
  }
});

$('#file-import').addEventListener('change', async e => {
  const file = e.target.files[0];
  e.target.value = '';
  if (!file) return;
  try {
    const { rec, track } = trackFromFile(await file.text(), file.name);
    openAnalysis(rec, track);
  } catch (err) {
    toast(`Import failed: ${err.message}`);
  }
});

$('#btn-demo').addEventListener('click', () => {
  const veh = { ...currentVehicle() };
  if (!veh.tire) veh.tire = '205/55R16';
  const rec = simulateDrive(veh);
  openAnalysis(rec, trackFromRecording(rec));
});

// ---------- analysis ----------
let current = null;

function openAnalysis(rec, track) {
  showView('analysis');
  $('#an-empty').hidden = false;
  $('#an-empty').textContent = 'Analyzing…';
  $('#an-body').hidden = true;
  setTimeout(() => {
    try {
      const recVeh = track.meta?.vehicle;
      const vehicle = recVeh && (recVeh.tire || recVeh.circumference) ? recVeh : currentVehicle();
      const res = analyze(track, vehicle);
      current = { rec, track, res, vehicle };
      renderAnalysis();
    } catch (err) {
      $('#an-empty').textContent = `Analysis failed: ${err.message}`;
    }
  }, 30);
}

const STATE_LABEL = { cruise: 'steady', transient: 'varying', accel: 'accelerating', braking: 'braking', idle: 'standstill', nospeed: 'no GPS', gap: 'gap' };
const SEV = { warning: ['▲', 'Likely cause'], info: ['●', 'Note'], good: ['✓', 'OK'] };

function renderAnalysis() {
  const { track, res, vehicle } = current;
  $('#an-empty').hidden = true;
  $('#an-body').hidden = false;
  const meta = track.meta || {};
  $('#an-title').textContent = meta.name || 'Recording';
  const counts = {};
  for (const w of res.windows) counts[w.state] = (counts[w.state] || 0) + 1;
  $('#an-summary').innerHTML =
    `${meta.startedAt ? new Date(meta.startedAt).toLocaleString() + ' · ' : ''}${fmtDuration(res.duration * 1000)} · ` +
    `${res.samples.toLocaleString()} samples at ${res.rawFs.toFixed(0)} Hz · wheel circumference ${res.circumference.toFixed(3)} m` +
    `${vehicle.tire ? ` (${esc(vehicle.tire)})` : ''}<br>` +
    `Analysis windows (${(res.N / res.fs).toFixed(1)} s): ` +
    Object.entries(counts).map(([k, v]) => `${v} ${STATE_LABEL[k] || k}`).join(', ');

  $('#an-findings').innerHTML = res.findings.map(f => {
    const [ico, tag] = SEV[f.severity] || SEV.info;
    const conf = f.severity === 'warning' ? `<div class="conf" title="confidence"><div style="width:${Math.round(f.confidence * 100)}%"></div></div>
      <div class="muted small">Confidence ${Math.round(f.confidence * 100)}%</div>` : '';
    return `<div class="finding ${f.severity}">
      <div class="f-head"><span class="f-title">${esc(f.title)}</span><span class="f-tag"><span class="ico">${ico}</span> ${tag}</span></div>
      <p>${esc(f.detail)}</p>${conf}</div>`;
  }).join('');

  drawAnalysisCharts();
}

function drawAnalysisCharts() {
  const { res } = current;
  const W = res.windows;
  const tFmt = v => fmtDuration(v * 1000);
  const markers = (res.markers || []).map(m => ({ x: m, label: '★', color: cssVar('--warning'), dash: [2, 2] }));
  const tMax = W.length ? W[W.length - 1].tMid : 0;

  // Speed (per window, from GPS).
  lineChart($('#ch-speed'), {
    x: W.map(w => w.tMid), xMin: 0, xMax: tMax, yMin: 0,
    series: [{ name: 'Speed', color: cssVar('--s1'), y: W.map(w => w.speed * 3.6) }],
    xFmt: tFmt, yFmt: v => v.toFixed(0), yFmtTip: v => `${v.toFixed(0)} km/h`, xLabel: 'time', yLabel: 'km/h',
    vlines: markers,
    extraTip: i => `<div class="muted">${STATE_LABEL[W[i].state]}</div>`,
  });

  // Vibration RMS per axis with braking / acceleration bands.
  const half = res.N / 2 / res.fs;
  const bands = W.filter(w => w.state === 'braking' || w.state === 'accel').map(w => ({
    from: w.tMid - half / 2, to: w.tMid + half / 2, color: cssVar(w.state === 'braking' ? '--brake-band' : '--accel-band'),
  }));
  lineChart($('#ch-rms'), {
    x: W.map(w => w.tMid), xMin: 0, xMax: tMax, yMin: 0, bands, vlines: markers,
    series: ['X', 'Y', 'Z'].map((n, a) => ({ name: n, color: cssVar(`--s${a + 1}`), y: W.map(w => w.axisRms[a]) })),
    xFmt: tFmt, yFmt: v => v.toFixed(2), yFmtTip: v => `${v.toFixed(3)} m/s²`, xLabel: 'time', yLabel: 'm/s² RMS',
    extraTip: i => `<div class="muted">${Number.isFinite(W[i].speed) ? Math.round(W[i].speed * 3.6) + ' km/h · ' : ''}${STATE_LABEL[W[i].state]} · peak ${W[i].peakHz.toFixed(1)} Hz</div>`,
  });

  // Spectrogram with wheel-order overlays.
  const kLo = res.kMin, kHi = res.kMax;
  const orderLine = o => W.map(w => [w.tMid, Number.isFinite(w.speed) && w.speed > 1 ? o * w.speed / res.circumference : NaN]);
  const ink = cssVar('--text-1');
  heatmap($('#ch-spectro'), {
    nx: W.length, ny: kHi - kLo + 1,
    value: (xi, yi) => W[xi].spec[kLo + yi],
    xMin: W[0].t0, xMax: W[W.length - 1].t0 + res.N / res.fs,
    yMin: (kLo - 0.5) * res.df, yMax: (kHi + 0.5) * res.df,
    xFmt: tFmt, yFmt: v => v.toFixed(0), xLabel: 'time', yLabel: 'Hz',
    overlays: [
      { points: orderLine(1), color: ink, dash: [6, 4], label: '1× wheel' },
      { points: orderLine(2), color: ink, dash: [2, 3], label: '2× wheel' },
    ],
    tooltip: (xi, yi, v) => `<div class="tip-h">${tFmt(W[xi].tMid)} · ${Number.isFinite(W[xi].speed) ? Math.round(W[xi].speed * 3.6) + ' km/h' : 'no speed'}</div>
      <div>${((kLo + yi) * res.df).toFixed(1)} Hz: <b>${(10 * Math.log10(v)).toFixed(0)} dB</b></div>
      ${Number.isFinite(W[xi].speed) && W[xi].speed > 1 ? `<div class="muted">= ${(((kLo + yi) * res.df) / (W[xi].speed / res.circumference)).toFixed(2)}× wheel</div>` : ''}`,
  });

  // Campbell: speed × frequency.
  const cb = res.campbell;
  const maxKmh = cb.nx * cb.step;
  const ray = o => Array.from({ length: 60 }, (_, i) => { const kmh = maxKmh * i / 59; return [kmh, o * kmh / 3.6 / res.circumference]; });
  const overlays = [
    { points: ray(1), color: ink, dash: [6, 4], label: '1×' },
    { points: ray(2), color: ink, dash: [2, 3], label: '2×' },
  ];
  if (res.finalDrive) overlays.push({ points: ray(res.finalDrive), color: ink, dash: [1, 3], label: 'shaft' });
  heatmap($('#ch-campbell'), {
    nx: cb.nx, ny: kHi - kLo + 1,
    value: (xi, yi) => (cb.count[xi] ? cb.grid[xi][kLo + yi] : null),
    xMin: 0, xMax: maxKmh, yMin: (kLo - 0.5) * res.df, yMax: (kHi + 0.5) * res.df,
    xFmt: v => v.toFixed(0), yFmt: v => v.toFixed(0), xLabel: 'km/h', yLabel: 'Hz', overlays,
    tooltip: (xi, yi, v) => (v === null ? '<div class="muted">no data at this speed</div>' :
      `<div class="tip-h">${xi * cb.step}–${(xi + 1) * cb.step} km/h · ${cb.count[xi]} windows</div>
       <div>${((kLo + yi) * res.df).toFixed(1)} Hz: <b>${(10 * Math.log10(v)).toFixed(0)} dB</b></div>`),
  });

  // Order spectrum relative to its median.
  const os = res.orders;
  const rel = arr => {
    const vals = Array.from(arr).filter(Number.isFinite).sort((a, b) => a - b);
    const med = vals[vals.length >> 1] || 1;
    return Array.from(arr, v => v / med);
  };
  const series = [{ name: 'Vibration', color: cssVar('--s1'), y: rel(os.power) }];
  if (os.gyro && res.hasGyro) series.push({ name: 'Steering rotation', color: cssVar('--s2'), y: rel(os.gyro.power) });
  $('#gyro-key').hidden = $('#gyro-key-label').hidden = !(os.gyro && res.hasGyro);
  const vl = [{ x: 1, label: '1×' }, { x: 2, label: '2×' }, { x: 3, label: '3×' }];
  if (res.finalDrive) vl.push({ x: res.finalDrive, label: 'shaft' });
  if (os.windows) {
    lineChart($('#ch-orders'), {
      x: Array.from(os.orders), yMin: 0, series, vlines: vl,
      xFmt: v => v.toFixed(1), xFmtTip: v => `order ${v.toFixed(2)}`, yFmt: v => v.toFixed(0),
      yFmtTip: v => `${v.toFixed(1)}× background`, xLabel: '× wheel speed', yLabel: '× median',
    });
  } else {
    emptyChart($('#ch-orders'), 'Needs driving above 20 km/h with GPS speed.');
  }

  // RMS by speed band.
  const items = res.bands.map(b => ({
    label: b.idle ? 'idle' : String(b.lo), value: b.rms, color: cssVar('--s1'),
    tip: `<div class="tip-h">${b.idle ? 'Standstill' : `${b.lo}–${b.hi} km/h`}</div><div>Vibration: <b>${b.rms.toFixed(3)} m/s²</b></div>
      <div class="muted">${b.n} windows${b.braking ? ` · ${b.braking} braking` : ''}${b.accel ? ` · ${b.accel} accel.` : ''}</div>`,
  }));
  if (items.length) barChart($('#ch-bands'), { items, yFmt: v => v.toFixed(2), xLabel: 'km/h', yLabel: 'm/s² RMS' });
  else emptyChart($('#ch-bands'), 'No GPS speed in this recording.');
}

function emptyChart(el, msg) {
  el._ro?.disconnect();
  el.innerHTML = `<div class="empty">${esc(msg)}</div>`;
}

$('#an-csv').addEventListener('click', () => {
  if (!current) return;
  download(`vibration-${fileStamp(current.track.meta?.startedAt || Date.now())}.csv`, toCsv(current.track), 'text/csv');
});
$('#an-json').addEventListener('click', () => {
  if (!current) return;
  if (!current.rec) return toast('JSON export needs the original recording (not a CSV import).');
  download(`vibration-${fileStamp(current.rec.meta.startedAt)}.json`, toJson(current.rec), 'application/json');
});

// Re-theme charts when the system theme flips.
window.matchMedia('(prefers-color-scheme: dark)').addEventListener('change', () => { if (current) drawAnalysisCharts(); });

// ---------- boot ----------
if ('serviceWorker' in navigator && location.protocol === 'https:') {
  navigator.serviceWorker.register('sw.js').catch(() => {});
}
let startView = 'record';
try { startView = localStorage.getItem('vm.view') || 'record'; } catch (_) { /* ignore */ }
showView(startView === 'analysis' ? 'recordings' : startView);
