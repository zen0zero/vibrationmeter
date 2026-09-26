// Data layout, import/export, and conversion of a raw recording into a
// per-sample "track" (every accelerometer sample paired with GPS speed).

// Flat row layouts used in memory, IndexedDB and JSON export.
export const MOTION_FIELDS = ['t', 'ax', 'ay', 'az', 'lx', 'ly', 'lz', 'ra', 'rb', 'rg'];
export const GPS_FIELDS = ['t', 'lat', 'lon', 'acc', 'speed', 'heading', 'alt'];
export const MS = MOTION_FIELDS.length;
export const GS = GPS_FIELDS.length;

const CSV_COLUMNS = [
  'timestamp_ms', 'elapsed_s',
  'acc_x', 'acc_y', 'acc_z',            // accelerationIncludingGravity, m/s²
  'lin_x', 'lin_y', 'lin_z',            // acceleration without gravity (if the phone provides it), m/s²
  'rot_alpha', 'rot_beta', 'rot_gamma', // rotation rate, deg/s
  'speed_kmh', 'lat', 'lon', 'gps_accuracy_m', 'gps_age_ms', 'marker',
];

const MAX_GPS_GAP_MS = 6000;

function haversine(lat1, lon1, lat2, lon2) {
  const R = 6371000, r = Math.PI / 180;
  const dLat = (lat2 - lat1) * r, dLon = (lon2 - lon1) * r;
  const a = Math.sin(dLat / 2) ** 2 + Math.cos(lat1 * r) * Math.cos(lat2 * r) * Math.sin(dLon / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(a));
}

// GPS fixes -> arrays, filling missing Doppler speed from position deltas.
export function gpsFixes(gps) {
  const n = Math.floor(gps.length / GS);
  const t = new Float64Array(n), v = new Float64Array(n);
  const lat = new Float64Array(n), lon = new Float64Array(n), acc = new Float64Array(n);
  for (let i = 0; i < n; i++) {
    const o = i * GS;
    t[i] = gps[o]; lat[i] = gps[o + 1]; lon[i] = gps[o + 2]; acc[i] = gps[o + 3];
    let s = gps[o + 4];
    if (!Number.isFinite(s) && i > 0) {
      const dt = (gps[o] - gps[o - GS]) / 1000;
      if (dt > 0 && dt < 10) s = haversine(gps[o - GS + 1], gps[o - GS + 2], lat[i], lon[i]) / dt;
    }
    v[i] = Number.isFinite(s) ? s : NaN;
  }
  return { t, v, lat, lon, acc, n };
}

// Recording -> per-sample track. Speed is linearly interpolated between fixes;
// samples far from any fix get NaN speed.
export function trackFromRecording(rec) {
  const m = rec.motion;
  const n = Math.floor(m.length / MS);
  const g = gpsFixes(rec.gps);
  const track = emptyTrack(n);
  const t0 = n ? m[0] : 0;
  let j = 0;
  for (let i = 0; i < n; i++) {
    const o = i * MS;
    const ts = m[o];
    track.ts[i] = ts;
    track.t[i] = (ts - t0) / 1000;
    track.ax[i] = m[o + 1]; track.ay[i] = m[o + 2]; track.az[i] = m[o + 3];
    track.lx[i] = m[o + 4]; track.ly[i] = m[o + 5]; track.lz[i] = m[o + 6];
    track.ra[i] = m[o + 7]; track.rb[i] = m[o + 8]; track.rg[i] = m[o + 9];
    while (j + 1 < g.n && g.t[j + 1] <= ts) j++;
    let speed = NaN, lat = NaN, lon = NaN, acc = NaN, age = NaN;
    if (g.n && g.t[j] <= ts) {
      age = ts - g.t[j];
      lat = g.lat[j]; lon = g.lon[j]; acc = g.acc[j];
      if (j + 1 < g.n && g.t[j + 1] - g.t[j] < MAX_GPS_GAP_MS) {
        const f = (ts - g.t[j]) / (g.t[j + 1] - g.t[j]);
        speed = g.v[j] + (g.v[j + 1] - g.v[j]) * f;
      } else if (age < MAX_GPS_GAP_MS / 2) {
        speed = g.v[j];
      }
    } else if (g.n && g.t[0] - ts < 2000) {
      speed = g.v[0];
    }
    track.speed[i] = speed; track.lat[i] = lat; track.lon[i] = lon;
    track.gpsAcc[i] = acc; track.gpsAge[i] = age;
  }
  track.markers = (rec.markers || []).map(ts => (ts - t0) / 1000);
  track.meta = rec.meta || {};
  track.t0 = t0;
  return track;
}

function emptyTrack(n) {
  const f = () => new Float64Array(n);
  return {
    n, ts: f(), t: f(), ax: f(), ay: f(), az: f(), lx: f(), ly: f(), lz: f(),
    ra: f(), rb: f(), rg: f(), speed: f(), lat: f(), lon: f(), gpsAcc: f(), gpsAge: f(),
    markers: [], meta: {},
  };
}

function num(x, digits) {
  return Number.isFinite(x) ? x.toFixed(digits) : '';
}

// Merged CSV: one row per accelerometer sample with the GPS data at that instant.
export function toCsv(track) {
  const lines = [CSV_COLUMNS.join(',')];
  const markerIdx = new Set();
  for (const mt of track.markers) {
    let best = 0;
    for (let i = 1; i < track.n; i++) if (Math.abs(track.t[i] - mt) < Math.abs(track.t[best] - mt)) best = i;
    markerIdx.add(best);
  }
  for (let i = 0; i < track.n; i++) {
    lines.push([
      track.ts[i].toFixed(3), track.t[i].toFixed(4),
      num(track.ax[i], 4), num(track.ay[i], 4), num(track.az[i], 4),
      num(track.lx[i], 4), num(track.ly[i], 4), num(track.lz[i], 4),
      num(track.ra[i], 3), num(track.rb[i], 3), num(track.rg[i], 3),
      num(track.speed[i] * 3.6, 2), num(track.lat[i], 7), num(track.lon[i], 7),
      num(track.gpsAcc[i], 1), num(track.gpsAge[i], 0), markerIdx.has(i) ? '1' : '',
    ].join(','));
  }
  return lines.join('\n') + '\n';
}

export function toJson(rec) {
  return JSON.stringify({
    format: 'vibrationmeter', version: 1, meta: rec.meta,
    motionFields: MOTION_FIELDS, motion: Array.from(rec.motion, x => (Number.isFinite(x) ? x : null)),
    gpsFields: GPS_FIELDS, gps: Array.from(rec.gps, x => (Number.isFinite(x) ? x : null)),
    markers: rec.markers || [],
  });
}

const nullToNaN = x => (x === null || x === undefined ? NaN : x);

// Parse an exported JSON or CSV file back into a track.
export function trackFromFile(text, filename = '') {
  const trimmed = text.trimStart();
  if (trimmed.startsWith('{')) {
    const obj = JSON.parse(trimmed);
    if (obj.format !== 'vibrationmeter') throw new Error('Not a vibrationmeter JSON file');
    const rec = {
      meta: { ...obj.meta, name: obj.meta?.name || filename },
      motion: obj.motion.map(nullToNaN), gps: obj.gps.map(nullToNaN), markers: obj.markers || [],
    };
    return { rec, track: trackFromRecording(rec) };
  }
  return { rec: null, track: trackFromCsv(text, filename) };
}

function trackFromCsv(text, filename) {
  const rows = text.split(/\r?\n/).filter(l => l.length);
  const header = rows[0].split(',').map(s => s.trim());
  const col = name => header.indexOf(name);
  const need = ['timestamp_ms', 'acc_x', 'acc_y', 'acc_z', 'speed_kmh'];
  for (const k of need) if (col(k) < 0) throw new Error(`CSV is missing column "${k}"`);
  const n = rows.length - 1;
  const tr = emptyTrack(n);
  const idx = Object.fromEntries(CSV_COLUMNS.map(c => [c, col(c)]));
  const get = (cells, c) => (idx[c] >= 0 && cells[idx[c]] !== '' && cells[idx[c]] !== undefined ? +cells[idx[c]] : NaN);
  let t0 = 0;
  for (let i = 0; i < n; i++) {
    const c = rows[i + 1].split(',');
    const ts = get(c, 'timestamp_ms');
    if (i === 0) t0 = ts;
    tr.ts[i] = ts; tr.t[i] = (ts - t0) / 1000;
    tr.ax[i] = get(c, 'acc_x'); tr.ay[i] = get(c, 'acc_y'); tr.az[i] = get(c, 'acc_z');
    tr.lx[i] = get(c, 'lin_x'); tr.ly[i] = get(c, 'lin_y'); tr.lz[i] = get(c, 'lin_z');
    tr.ra[i] = get(c, 'rot_alpha'); tr.rb[i] = get(c, 'rot_beta'); tr.rg[i] = get(c, 'rot_gamma');
    tr.speed[i] = get(c, 'speed_kmh') / 3.6;
    tr.lat[i] = get(c, 'lat'); tr.lon[i] = get(c, 'lon');
    tr.gpsAcc[i] = get(c, 'gps_accuracy_m'); tr.gpsAge[i] = get(c, 'gps_age_ms');
    if (get(c, 'marker') === 1) tr.markers.push(tr.t[i]);
  }
  tr.t0 = t0;
  tr.meta = { name: filename, startedAt: t0 };
  return tr;
}

export function download(filename, text, type) {
  const blob = new Blob([text], { type });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url; a.download = filename;
  document.body.appendChild(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 5000);
}

export function fileStamp(ts) {
  const d = new Date(ts);
  const p = x => String(x).padStart(2, '0');
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}`;
}
