// Vibration analysis: resampling, spectra, order tracking against wheel speed,
// and heuristic attribution of vibration to likely causes.

// ---------- vehicle ----------

// "205/55R16" -> rolling circumference in metres (loaded radius ≈ 97% of free radius).
export function tireCircumference(size) {
  const m = /(\d{3})\s*\/\s*(\d{2})\s*Z?R?\s*F?\s*(\d{2}(?:\.\d)?)/i.exec(size || '');
  if (!m) return NaN;
  const width = +m[1], aspect = +m[2] / 100, rim = +m[3];
  const diameter = rim * 25.4 + 2 * width * aspect; // mm
  return Math.PI * diameter * 0.97 / 1000;
}

export function vehicleCircumference(v) {
  const c = +v.circumference;
  if (c > 0.5 && c < 5) return c;
  const t = tireCircumference(v.tire);
  return Number.isFinite(t) ? t : 1.95;
}

// ---------- DSP ----------

export function fft(re, im) {
  const n = re.length;
  for (let i = 1, j = 0; i < n; i++) {
    let bit = n >> 1;
    for (; j & bit; bit >>= 1) j ^= bit;
    j ^= bit;
    if (i < j) {
      [re[i], re[j]] = [re[j], re[i]];
      [im[i], im[j]] = [im[j], im[i]];
    }
  }
  for (let len = 2; len <= n; len <<= 1) {
    const ang = -2 * Math.PI / len;
    const wr = Math.cos(ang), wi = Math.sin(ang);
    for (let i = 0; i < n; i += len) {
      let cr = 1, ci = 0;
      for (let k = 0; k < len / 2; k++) {
        const a = i + k, b = a + len / 2;
        const xr = re[b] * cr - im[b] * ci, xi = re[b] * ci + im[b] * cr;
        re[b] = re[a] - xr; im[b] = im[a] - xi;
        re[a] += xr; im[a] += xi;
        const t = cr * wr - ci * wi; ci = cr * wi + ci * wr; cr = t;
      }
    }
  }
}

const hannCache = new Map();
function hann(n) {
  if (!hannCache.has(n)) {
    const w = new Float64Array(n);
    let s2 = 0;
    for (let i = 0; i < n; i++) { w[i] = 0.5 - 0.5 * Math.cos(2 * Math.PI * i / (n - 1)); s2 += w[i] * w[i]; }
    hannCache.set(n, { w, s2 });
  }
  return hannCache.get(n);
}

// One-sided power spectrum, scaled so that the sum of bins ≈ signal variance.
export function powerSpectrum(x, start, n, out) {
  const { w, s2 } = hann(n);
  const re = new Float64Array(n), im = new Float64Array(n);
  let mean = 0;
  for (let i = 0; i < n; i++) mean += x[start + i];
  mean /= n;
  for (let i = 0; i < n; i++) re[i] = (x[start + i] - mean) * w[i];
  fft(re, im);
  const half = n / 2;
  for (let k = 0; k < half; k++) {
    const p = (re[k] * re[k] + im[k] * im[k]) / (n * s2);
    out[k] += k === 0 ? p : 2 * p;
  }
  return out;
}

// Centered moving-average high-pass: removes gravity and slow steering motion.
export function highPass(x, win) {
  const n = x.length, out = new Float64Array(n);
  const cs = new Float64Array(n + 1);
  for (let i = 0; i < n; i++) cs[i + 1] = cs[i] + x[i];
  const h = Math.floor(win / 2);
  for (let i = 0; i < n; i++) {
    const a = Math.max(0, i - h), b = Math.min(n, i + h + 1);
    out[i] = x[i] - (cs[b] - cs[a]) / (b - a);
  }
  return out;
}

function median(arr) {
  const a = Array.from(arr).filter(Number.isFinite).sort((p, q) => p - q);
  if (!a.length) return NaN;
  const m = a.length >> 1;
  return a.length % 2 ? a[m] : (a[m - 1] + a[m]) / 2;
}

export function estimateRate(t) {
  const d = [];
  const step = Math.max(1, Math.floor(t.length / 5000));
  for (let i = step; i < t.length; i += step) d.push((t[i] - t[i - 1]));
  const md = median(d);
  return md > 0 ? 1 / md : NaN;
}

// Resample the track onto a uniform time grid (devicemotion events jitter).
export function resample(track, fs) {
  const t = track.t;
  const n = Math.max(0, Math.floor((t[track.n - 1] - t[0]) * fs));
  const keys = ['ax', 'ay', 'az', 'ra', 'rb', 'rg', 'speed'];
  const out = { fs, n, t: new Float64Array(n), gap: new Uint8Array(n) };
  for (const k of keys) out[k] = new Float64Array(n);
  let j = 0;
  const maxGap = Math.max(0.25, 4 / fs);
  for (let i = 0; i < n; i++) {
    const ti = t[0] + i / fs;
    out.t[i] = ti;
    while (j + 2 < track.n && t[j + 1] <= ti) j++;
    const dt = t[j + 1] - t[j];
    const f = dt > 0 ? Math.min(1, Math.max(0, (ti - t[j]) / dt)) : 0;
    if (!(dt < maxGap)) out.gap[i] = 1;
    for (const k of keys) {
      const a = track[k][j], b = track[k][j + 1];
      out[k][i] = Number.isFinite(a) && Number.isFinite(b) ? a + (b - a) * f : (Number.isFinite(a) ? a : b);
    }
  }
  return out;
}

// ---------- analysis ----------

const MIN_HZ = 2.5;           // below this the high-pass and steering motion dominate
const ORDER_MIN = 0.4, ORDER_MAX = 6, ORDER_STEP = 0.05;
const MIN_ORDER_SPEED = 20 / 3.6;
const SPEED_BAND = 10;        // km/h

export function analyze(track, vehicle = {}) {
  if (track.n < 64) throw new Error('Recording is too short to analyze.');
  const C = vehicleCircumference(vehicle);
  const fdr = +vehicle.finalDrive || 0;
  const cyl = +vehicle.cylinders || 4;

  const rawFs = estimateRate(track.t);
  const fs = Math.min(400, Math.max(10, Math.round(rawFs)));
  const r = resample(track, fs);
  const hpWin = Math.max(3, Math.round(fs * 0.4));
  const ax = highPass(r.ax, hpWin), ay = highPass(r.ay, hpWin), az = highPass(r.az, hpWin);
  const hasGyro = r.ra.some(Number.isFinite) && r.ra.some(v => v !== 0);
  const ra = hasGyro ? highPass(r.ra.map(v => v || 0), hpWin) : null;
  const rb = hasGyro ? highPass(r.rb.map(v => v || 0), hpWin) : null;
  const rg = hasGyro ? highPass(r.rg.map(v => v || 0), hpWin) : null;

  let N = 1;
  while (N < fs * 4) N <<= 1;
  const hop = N / 2;
  const half = N / 2;
  const df = fs / N;
  const nyq = fs / 2;
  const kMin = Math.ceil(MIN_HZ / df), kMax = Math.floor(0.95 * nyq / df);
  const freqs = Float64Array.from({ length: half }, (_, k) => k * df);

  const windows = [];
  for (let s = 0; s + N <= r.n; s += hop) {
    let gap = false;
    for (let i = s; i < s + N; i++) if (r.gap[i]) { gap = true; break; }
    const spec = new Float64Array(half);
    powerSpectrum(ax, s, N, spec); powerSpectrum(ay, s, N, spec); powerSpectrum(az, s, N, spec);
    let gspec = null;
    if (hasGyro) {
      gspec = new Float64Array(half);
      powerSpectrum(ra, s, N, gspec); powerSpectrum(rb, s, N, gspec); powerSpectrum(rg, s, N, gspec);
    }
    let vSum = 0, vN = 0, vMin = Infinity, vMax = -Infinity;
    for (let i = s; i < s + N; i++) {
      const v = r.speed[i];
      if (Number.isFinite(v)) { vSum += v; vN++; vMin = Math.min(vMin, v); vMax = Math.max(vMax, v); }
    }
    const speed = vN > N * 0.8 ? vSum / vN : NaN;
    const q = Math.floor(N / 4);
    const vA = avgFinite(r.speed, s, s + q), vB = avgFinite(r.speed, s + N - q, s + N);
    const accel = (vB - vA) / ((N - q) / fs);
    let band = 0, peakK = kMin, peakP = -1;
    for (let k = kMin; k <= kMax; k++) {
      band += spec[k];
      if (spec[k] > peakP) { peakP = spec[k]; peakK = k; }
    }
    let gband = 0;
    if (gspec) for (let k = kMin; k <= kMax; k++) gband += gspec[k];
    const axisRms = [ax, ay, az].map(x => rmsOf(x, s, s + N));
    const w = {
      t0: r.t[s], tMid: r.t[s + half], speed, speedMin: vMin, speedMax: vMax, accel,
      spec, gspec, rms: Math.sqrt(band), gyroRms: Math.sqrt(gband), axisRms,
      peakHz: peakK * df, gap,
    };
    w.state = classify(w);
    windows.push(w);
  }

  const res = {
    fs, rawFs, N, df, nyq, freqs, kMin, kMax, windows, circumference: C, finalDrive: fdr,
    cylinders: cyl, hasGyro, duration: track.t[track.n - 1] - track.t[0], samples: track.n,
    markers: track.markers, hasSpeed: windows.some(w => Number.isFinite(w.speed)),
  };
  res.orders = orderSpectrum(res, w => w.state === 'cruise' || w.state === 'transient');
  res.ordersBrake = orderSpectrum(res, w => w.state === 'braking');
  res.ordersAccel = orderSpectrum(res, w => w.state === 'accel');
  res.hzSpectrum = hzSpectrum(res, w => w.state !== 'idle' && Number.isFinite(w.speed) && w.speed >= MIN_ORDER_SPEED);
  res.bands = speedBands(res);
  res.campbell = campbell(res);
  res.findings = diagnose(res);
  return res;
}

function avgFinite(x, a, b) {
  let s = 0, n = 0;
  for (let i = a; i < b; i++) if (Number.isFinite(x[i])) { s += x[i]; n++; }
  return n ? s / n : NaN;
}

function rmsOf(x, a, b) {
  let s = 0;
  for (let i = a; i < b; i++) s += x[i] * x[i];
  return Math.sqrt(s / (b - a));
}

function classify(w) {
  if (w.gap) return 'gap';
  if (!Number.isFinite(w.speed)) return 'nospeed';
  if (w.speedMax < 1.0) return 'idle';
  if (w.accel < -1.2) return 'braking';
  if (w.accel > 0.8) return 'accel';
  const spread = (w.speedMax - w.speedMin) / Math.max(w.speed, 1);
  if (Math.abs(w.accel) < 0.5 && spread < 0.12) return 'cruise';
  return 'transient';
}

// Normalised spectrum averaged in the wheel-order domain. Content locked to wheel
// rotation lines up at the same order at every speed; everything else smears out.
function orderSpectrum(res, pick, specKey = 'spec') {
  const nb = Math.round((ORDER_MAX - ORDER_MIN) / ORDER_STEP) + 1;
  const orders = Float64Array.from({ length: nb }, (_, i) => ORDER_MIN + i * ORDER_STEP);
  const acc = new Float64Array(nb), cnt = new Float64Array(nb);
  let used = 0;
  for (const w of res.windows) {
    if (!pick(w) || !(w.speed >= MIN_ORDER_SPEED) || !w[specKey]) continue;
    const fw = w.speed / res.circumference;
    let total = 0;
    for (let k = res.kMin; k <= res.kMax; k++) total += w[specKey][k];
    if (!(total > 0)) continue;
    used++;
    const spec = w[specKey];
    // Observable order range for this window: [fMin, fMax] / fw.
    const oLo = (res.kMin * res.df) / fw, oHi = (res.kMax * res.df) / fw;
    for (let i = 0; i < nb; i++) {
      if (orders[i] < oLo || orders[i] > oHi) continue;
      // Mean spectral density (per FFT bin) over this order bin's frequency span,
      // falling back to linear interpolation when the span is narrower than a bin.
      const kA = (orders[i] - ORDER_STEP / 2) * fw / res.df;
      const kB = (orders[i] + ORDER_STEP / 2) * fw / res.df;
      let v;
      if (Math.floor(kB) - Math.ceil(kA) >= 1) {
        let s = 0, n = 0;
        for (let k = Math.ceil(kA); k <= Math.floor(kB); k++) { s += spec[k]; n++; }
        v = s / n;
      } else {
        const kc = orders[i] * fw / res.df, k0 = Math.floor(kc), f = kc - k0;
        v = spec[k0] * (1 - f) + (spec[k0 + 1] ?? spec[k0]) * f;
      }
      acc[i] += v / total;
      cnt[i]++;
    }
  }
  const power = Float64Array.from(acc, (a, i) => (cnt[i] ? a / cnt[i] : NaN));
  const out = { orders, power, count: cnt, windows: used };
  if (res.hasGyro && specKey === 'spec') out.gyro = orderSpectrum(res, pick, 'gspec');
  return out;
}

function hzSpectrum(res, pick) {
  const half = res.N / 2, acc = new Float64Array(half);
  let used = 0;
  for (const w of res.windows) {
    if (!pick(w)) continue;
    let total = 0;
    for (let k = res.kMin; k <= res.kMax; k++) total += w.spec[k];
    if (!(total > 0)) continue;
    used++;
    for (let k = res.kMin; k <= res.kMax; k++) acc[k] += w.spec[k] / total;
  }
  return { power: acc.map(v => (used ? v / used : 0)), windows: used };
}

function speedBands(res) {
  const bands = new Map();
  for (const w of res.windows) {
    if (w.state === 'gap' || w.state === 'nospeed') continue;
    const kmh = w.speed * 3.6;
    const lo = w.state === 'idle' ? -1 : Math.floor(kmh / SPEED_BAND) * SPEED_BAND;
    if (!bands.has(lo)) bands.set(lo, { lo, hi: lo < 0 ? 0 : lo + SPEED_BAND, rms2: 0, g2: 0, n: 0, cruise: 0, braking: 0, accel: 0 });
    const b = bands.get(lo);
    b.rms2 += w.rms * w.rms; b.g2 += w.gyroRms * w.gyroRms; b.n++;
    if (b[w.state] !== undefined) b[w.state]++;
  }
  return [...bands.values()].sort((a, b) => a.lo - b.lo).map(b => ({
    ...b, rms: Math.sqrt(b.rms2 / b.n), gyroRms: Math.sqrt(b.g2 / b.n), idle: b.lo < 0,
  }));
}

// Frequency × speed map (Campbell diagram): mean power per speed bin.
function campbell(res) {
  const maxKmh = Math.max(20, ...res.windows.filter(w => Number.isFinite(w.speed)).map(w => w.speed * 3.6));
  const step = 5;
  const nx = Math.ceil(maxKmh / step) + 1;
  const half = res.N / 2;
  const grid = Array.from({ length: nx }, () => new Float64Array(half));
  const cnt = new Float64Array(nx);
  for (const w of res.windows) {
    if (!Number.isFinite(w.speed) || w.state === 'gap') continue;
    const x = Math.min(nx - 1, Math.floor(w.speed * 3.6 / step));
    for (let k = 0; k < half; k++) grid[x][k] += w.spec[k];
    cnt[x]++;
  }
  for (let x = 0; x < nx; x++) if (cnt[x]) for (let k = 0; k < half; k++) grid[x][k] /= cnt[x];
  return { step, nx, grid, count: cnt };
}

// Peak prominence: value near `target` order vs the median of the spectrum.
function orderPeak(os, lo, hi) {
  let best = -1, bestO = NaN;
  for (let i = 0; i < os.orders.length; i++) {
    if (os.orders[i] < lo || os.orders[i] > hi || !Number.isFinite(os.power[i])) continue;
    if (os.power[i] > best) { best = os.power[i]; bestO = os.orders[i]; }
  }
  const base = median(os.power);
  return { order: bestO, value: best, prominence: base > 0 && best > 0 ? best / base : 0 };
}

function spectrumPeaks(power, freqs, kMin, kMax, count = 3) {
  const base = median(Array.from(power).slice(kMin, kMax + 1));
  const peaks = [];
  for (let k = kMin + 1; k < kMax; k++) {
    if (power[k] > power[k - 1] && power[k] >= power[k + 1]) peaks.push({ hz: freqs[k], k, value: power[k], prominence: power[k] / base });
  }
  return peaks.sort((a, b) => b.value - a.value).slice(0, count);
}

const clamp01 = x => Math.max(0, Math.min(1, x));
const confFromProm = p => clamp01((p - 1.8) / 4);

function speedBandFor(res, lo, hi) {
  // speed band (km/h) where the order-locked content is strongest
  let best = null;
  for (const b of res.bands) {
    if (b.idle) continue;
    const ws = res.windows.filter(w => Number.isFinite(w.speed) && w.speed * 3.6 >= b.lo && w.speed * 3.6 < b.hi && w.speed >= MIN_ORDER_SPEED);
    let s = 0, n = 0;
    for (const w of ws) {
      const fw = w.speed / res.circumference;
      for (let k = res.kMin; k <= res.kMax; k++) {
        const o = k * res.df / fw;
        if (o >= lo && o <= hi) s += w.spec[k];
      }
      n++;
    }
    if (!n) continue;
    const amp = Math.sqrt(s / n);
    if (!best || amp > best.amp) best = { lo: b.lo, hi: b.hi, amp };
  }
  return best;
}

function statsFor(res, state, lo, hi) {
  const ws = res.windows.filter(w => w.state === state && w.speed * 3.6 >= lo && w.speed * 3.6 < hi);
  if (!ws.length) return null;
  return { n: ws.length, rms: Math.sqrt(ws.reduce((a, w) => a + w.rms * w.rms, 0) / ws.length) };
}

// Compare vibration in `state` windows vs steady-speed windows at matched speeds.
function compareToCruise(res, state) {
  let ratioSum = 0, weight = 0, n = 0;
  for (const b of res.bands) {
    if (b.idle) continue;
    const s = statsFor(res, state, b.lo - 10, b.hi + 10);
    const c = statsFor(res, 'cruise', b.lo - 10, b.hi + 10) || statsFor(res, 'transient', b.lo - 10, b.hi + 10);
    if (!s || !c || !b[state]) continue;
    ratioSum += (s.rms / c.rms) * b[state];
    weight += b[state]; n += b[state];
  }
  return weight ? { ratio: ratioSum / weight, n } : null;
}

export function diagnose(res) {
  const F = [];
  const kmh = b => (b ? `${b.lo}–${b.hi} km/h` : '');
  const add = (f) => F.push({ confidence: 0, ...f });

  if (!res.hasSpeed) {
    add({ id: 'nogps', severity: 'info', title: 'No GPS speed in this recording',
      detail: 'Without speed the vibration cannot be tied to wheel rotation. Only frequency content is shown. Make sure location is allowed and the phone has a sky view.' });
  }
  if (res.rawFs < 40) {
    add({ id: 'lowrate', severity: 'info', title: `Low sample rate (${res.rawFs.toFixed(0)} Hz)`,
      detail: `Frequencies above ${res.nyq.toFixed(0)} Hz cannot be measured and may alias into lower frequencies. Engine firing frequencies and driveshaft orders are usually out of reach.` });
  }

  const os = res.orders;
  if (os.windows >= 3) {
    const o1 = orderPeak(os, 0.88, 1.12);
    const o2 = orderPeak(os, 1.85, 2.15);
    const g1 = os.gyro ? orderPeak(os.gyro, 0.88, 1.12) : null;
    if (o1.prominence >= 2.2) {
      const band = speedBandFor(res, 0.88, 1.12);
      const steering = g1 && g1.prominence >= 2.2;
      add({ id: 'order1', severity: 'warning', confidence: confFromProm(o1.prominence),
        title: 'Wheel/tire imbalance (1st wheel order)',
        detail: `A vibration at once per wheel revolution (order ${o1.order.toFixed(2)}) stands ${o1.prominence.toFixed(1)}× above the background` +
          (band ? `, strongest around ${kmh(band)}` : '') + '. Most common cause: a lost balance weight or an unbalanced wheel. ' +
          'Also possible: bent rim, tire with a shifted belt, worn wheel bearing, loose lug nuts or hub run-out. ' +
          (steering ? 'It also shows up as rotation of the steering wheel (shimmy), which points to the FRONT wheels.'
                    : 'Little of it rotates the steering wheel, so rear wheels are also candidates.'),
        evidence: { order: o1.order, prominence: o1.prominence, band } });
    }
    if (o2.prominence >= 2.2) {
      const band = speedBandFor(res, 1.85, 2.15);
      add({ id: 'order2', severity: 'warning', confidence: confFromProm(o2.prominence),
        title: 'Tire out-of-round / non-uniformity (2nd wheel order)',
        detail: `A vibration at twice per wheel revolution (order ${o2.order.toFixed(2)}, ${o2.prominence.toFixed(1)}× background)` +
          (band ? `, strongest around ${kmh(band)}` : '') + '. Typical causes: an oval or flat-spotted tire (e.g. after standing still for a long time), ' +
          'radial force variation, or a bent rim. A road-force balance usually finds it.',
        evidence: { order: o2.order, prominence: o2.prominence, band } });
    }
    if (res.finalDrive > 0) {
      const lo = res.finalDrive * 0.93, hi = res.finalDrive * 1.07;
      const od = orderPeak(os, lo, hi);
      if (od.prominence >= 2.2 && Number.isFinite(od.order)) {
        add({ id: 'driveshaft', severity: 'warning', confidence: confFromProm(od.prominence),
          title: 'Driveshaft / propshaft rotation',
          detail: `A peak at order ${od.order.toFixed(2)} ≈ final-drive ratio ${res.finalDrive} means something turning at driveshaft speed: ` +
            'propshaft imbalance, worn U-joints or centre bearing (RWD/AWD), or pinion/differential run-out.',
          evidence: { order: od.order, prominence: od.prominence } });
      }
    }
  }

  const accelCmp = compareToCruise(res, 'accel');
  if (res.ordersAccel.windows >= 2) {
    const o3 = orderPeak(res.ordersAccel, 2.85, 3.15);
    if (o3.prominence >= 2.5) {
      add({ id: 'cv3', severity: 'warning', confidence: confFromProm(o3.prominence) * 0.8,
        title: 'Inner CV joint (3rd wheel order under load)',
        detail: `During acceleration a peak at order ${o3.order.toFixed(2)} (${o3.prominence.toFixed(1)}× background) appears. ` +
          'Tripod-type inner CV joints produce three pulses per revolution when worn; typical on front-wheel-drive cars as a shudder when accelerating.',
        evidence: o3 });
    }
  }
  if (accelCmp && accelCmp.n >= 3 && accelCmp.ratio >= 1.4) {
    add({ id: 'load', severity: 'warning', confidence: clamp01((accelCmp.ratio - 1.2) / 1.5),
      title: 'Vibration increases under acceleration',
      detail: `While accelerating the vibration is ${accelCmp.ratio.toFixed(1)}× stronger than at a steady similar speed. ` +
        'Load-dependent vibration points at the drivetrain: CV joints / drive shafts, engine or gearbox mounts, or propshaft angles. ' +
        'Compare with a coast-down in neutral: if it disappears, the wheels and tires are not the cause.',
      evidence: accelCmp });
  }

  const brakeCmp = compareToCruise(res, 'braking');
  if (brakeCmp && brakeCmp.n >= 2 && brakeCmp.ratio >= 1.4) {
    const ob = res.ordersBrake.windows >= 2 ? orderPeak(res.ordersBrake, 0.88, 1.12) : null;
    const locked = ob && ob.prominence >= 2.2;
    add({ id: 'brake', severity: 'warning',
      confidence: clamp01((brakeCmp.ratio - 1.2) / 1.5 + (locked ? 0.25 : 0)),
      title: 'Brake judder (vibration while braking)',
      detail: `While braking the vibration is ${brakeCmp.ratio.toFixed(1)}× stronger than at a steady similar speed` +
        (locked ? `, and it follows wheel rotation (order ${ob.order.toFixed(2)})` : '') + '. ' +
        'Classic cause: brake-disc thickness variation ("warped rotors"), or sticking calipers / deposits on the pads. ' +
        'Felt in the steering wheel → front discs; felt in the seat/pedal only → often rear.',
      evidence: { ...brakeCmp, order: ob } });
  }

  const idle = res.bands.find(b => b.idle);
  if (idle && idle.n >= 2) {
    const ws = res.windows.filter(w => w.state === 'idle');
    const avg = new Float64Array(res.N / 2);
    for (const w of ws) for (let k = 0; k < avg.length; k++) avg[k] += w.spec[k] / ws.length;
    const [p] = spectrumPeaks(avg, res.freqs, res.kMin, res.kMax, 1);
    const rpm = p ? p.hz * 120 / res.cylinders : NaN;
    const rough = idle.rms > 0.12;
    add({ id: 'idle', severity: rough ? 'warning' : 'info', confidence: rough ? clamp01((idle.rms - 0.08) / 0.2) : 0.1,
      title: rough ? 'Noticeable vibration at standstill (engine running)' : 'Standstill vibration is low',
      detail: `At standstill the vibration level is ${idle.rms.toFixed(3)} m/s²` +
        (p ? `, with a peak at ${p.hz.toFixed(1)} Hz (≈ ${Math.round(rpm)} rpm if it is the ${res.cylinders}-cylinder firing frequency, ` +
          `or ${Math.round(p.hz * 60)} rpm at engine order 1)` : '') + '. ' +
        (rough ? 'Vibration at a standstill cannot come from wheels or tires. Suspect engine mounts, a misfire, idle speed too low, or the A/C compressor. '
               : '') + (res.nyq < 35 ? `Note: at ${res.fs} Hz sampling, frequencies above ${res.nyq.toFixed(0)} Hz fold back, so treat the rpm estimate with caution.` : ''),
      evidence: { rms: idle.rms, peakHz: p?.hz } });
  }

  // Strong peaks at a fixed frequency that do NOT follow wheel speed.
  if (res.hzSpectrum.windows >= 4) {
    const peaks = spectrumPeaks(res.hzSpectrum.power, res.freqs, res.kMin, res.kMax, 2);
    for (const p of peaks) {
      if (p.prominence < 4) continue;
      const tracked = F.some(f => ['order1', 'order2', 'driveshaft'].includes(f.id));
      // Check whether this frequency moves with speed: compare peak frequency in slow vs fast windows.
      const moving = res.windows.filter(w => w.speed >= MIN_ORDER_SPEED && w.state !== 'gap');
      if (moving.length < 4) continue;
      const lock = orderPeak(res.orders, 0.4, 6).prominence;
      if (!tracked || lock < p.prominence * 0.6) {
        add({ id: `fixed${p.hz.toFixed(1)}`, severity: 'info', confidence: clamp01((p.prominence - 3) / 8) * 0.8,
          title: `Speed-independent vibration around ${p.hz.toFixed(1)} Hz`,
          detail: `A peak at ${p.hz.toFixed(1)} Hz stays at the same frequency at different road speeds. ` +
            'This is usually a structural resonance (steering column, mirror, seat, dashboard), the phone mount itself, ' +
            'or something tied to engine rpm rather than road speed (engine, alternator, A/C compressor). ' +
            'Tip: repeat at the same road speed in two different gears – if it changes, it is engine-related.',
          evidence: p });
        break;
      }
    }
  }

  // Speed-band hump with no clear order: suspension/steering resonance or balance.
  const moving = res.bands.filter(b => !b.idle && b.n >= 2);
  if (moving.length >= 4) {
    const top = moving.reduce((a, b) => (b.rms > a.rms ? b : a));
    const others = moving.filter(b => Math.abs(b.lo - top.lo) > 15);
    const ref = median(others.map(b => b.rms));
    if (ref > 0 && top.rms / ref > 1.8 && top !== moving[moving.length - 1]) {
      add({ id: 'band', severity: 'info', confidence: clamp01((top.rms / ref - 1.5) / 2) * 0.7,
        title: `Vibration peaks in the ${kmh(top)} range`,
        detail: `Vibration is ${(top.rms / ref).toFixed(1)}× higher around ${kmh(top)} than at other speeds and drops again above it. ` +
          'A vibration that appears in one speed window and fades above it is typical of wheel imbalance exciting a suspension or steering resonance.',
        evidence: { band: top, ratio: top.rms / ref } });
    }
  }

  if (!F.some(f => f.severity === 'warning')) {
    add({ id: 'none', severity: 'good', confidence: 0.5,
      title: 'No dominant periodic vibration found',
      detail: 'Nothing stands out as locked to wheel rotation, braking or acceleration. The remaining vibration is broadband, which usually means road surface. ' +
        'If you do feel a vibration, record again at the speed where it is worst, for at least 30 seconds at a steady speed, and use the marker button when it happens.' });
  }

  const rank = { warning: 0, info: 1, good: 2 };
  return F.sort((a, b) => rank[a.severity] - rank[b.severity] || b.confidence - a.confidence);
}

// Small helper for the live view: dominant frequency of the last N samples.
export function liveSpectrum(xs, ys, zs, fs) {
  let N = 1;
  while (N * 2 <= xs.length) N <<= 1;
  if (N < 32) return null;
  const start = xs.length - N;
  const hp = arr => highPass(Float64Array.from(arr.slice(start)), Math.max(3, Math.round(fs * 0.4)));
  const spec = new Float64Array(N / 2);
  powerSpectrum(hp(xs), 0, N, spec); powerSpectrum(hp(ys), 0, N, spec); powerSpectrum(hp(zs), 0, N, spec);
  const df = fs / N, kMin = Math.ceil(MIN_HZ / df), kMax = Math.floor(0.95 * fs / 2 / df);
  let pk = kMin, tot = 0;
  for (let k = kMin; k <= kMax; k++) { tot += spec[k]; if (spec[k] > spec[pk]) pk = k; }
  return { spec, df, peakHz: pk * df, rms: Math.sqrt(tot), kMin, kMax };
}
