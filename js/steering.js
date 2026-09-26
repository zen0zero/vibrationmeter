// Steering-wheel angle from the phone mounted on the wheel.
//
// The wheel rim is tilted, so gravity has a component in the screen plane whose
// direction rotates with the wheel: angle = atan2(acc_x, acc_y). In a corner the
// sideways (centripetal) acceleration tilts that vector; it is estimated from the
// GPS track (speed × yaw rate) and removed. The gyro's rotation around the screen
// normal is fused in to reject vibration and follow fast steering.
//
// Once the wheel angle is known, the accelerometer itself gives the car's
// cornering g (the in-plane component across the rim) and braking/acceleration g
// (mostly along the screen normal). These are lag-free, unlike GPS, and work at
// car-park speeds. GPS is kept as a cross-check and fallback.
//
// Convention: degrees, positive = wheel turned LEFT (counter-clockwise as seen by
// the driver). Lateral acceleration: m/s², positive = car accelerating to the left.

const D = 180 / Math.PI;
const MIN_PLANE_G = 2.5;          // below this the wheel is too flat to read the angle
const STRAIGHT_YAW = 0.015;       // rad/s
const STRAIGHT_SPEED = 20 / 3.6;

function movingAvg(x, win) {
  const n = x.length, out = new Float64Array(n), cs = new Float64Array(n + 1);
  for (let i = 0; i < n; i++) cs[i + 1] = cs[i] + (Number.isFinite(x[i]) ? x[i] : 0);
  const h = Math.floor(win / 2);
  for (let i = 0; i < n; i++) {
    const a = Math.max(0, i - h), b = Math.min(n, i + h + 1);
    out[i] = (cs[b] - cs[a]) / (b - a);
  }
  return out;
}

function median(values) {
  const a = values.filter(Number.isFinite).sort((p, q) => p - q);
  if (!a.length) return NaN;
  const m = a.length >> 1;
  return a.length % 2 ? a[m] : (a[m - 1] + a[m]) / 2;
}

const wrapPi = a => a - 2 * Math.PI * Math.round(a / (2 * Math.PI));

// Yaw rate (rad/s, + = left) per sample from the GPS positions carried in the track.
export function gpsYawRate(track) {
  const n = track.n;
  const fixes = [];
  for (let i = 0; i < n; i++) {
    const lat = track.lat[i], lon = track.lon[i];
    if (!Number.isFinite(lat)) continue;
    const prev = fixes[fixes.length - 1];
    if (prev && prev.lat === lat && prev.lon === lon) continue;
    const age = track.gpsAge[i];
    fixes.push({ t: track.t[i] - (Number.isFinite(age) ? age / 1000 : 0), lat, lon, v: track.speed[i] });
  }
  // Bearing of each leg between consecutive fixes (clockwise from north).
  const legs = [];
  for (let i = 1; i < fixes.length; i++) {
    const a = fixes[i - 1], b = fixes[i];
    const dt = b.t - a.t;
    const dy = (b.lat - a.lat) * 111320;
    const dx = (b.lon - a.lon) * 111320 * Math.cos(a.lat * Math.PI / 180);
    const dist = Math.hypot(dx, dy);
    if (dt <= 0 || dt > 5 || dist < 3 || !(Math.min(a.v, b.v) > 4)) { legs.push(null); continue; }
    legs.push({ t: (a.t + b.t) / 2, brg: Math.atan2(dx, dy) });
  }
  const pts = [];
  for (let i = 1; i < legs.length; i++) {
    const a = legs[i - 1], b = legs[i];
    if (!a || !b) continue;
    pts.push({ t: (a.t + b.t) / 2, yaw: -wrapPi(b.brg - a.brg) / (b.t - a.t) });
  }
  // light 3-point smoothing
  const sm = pts.map((p, i) => {
    const nb = pts.slice(Math.max(0, i - 1), i + 2).filter(q => Math.abs(q.t - p.t) < 3);
    return { t: p.t, yaw: nb.reduce((s, q) => s + q.yaw, 0) / nb.length };
  });
  const yaw = new Float64Array(n).fill(NaN);
  let j = 0;
  for (let i = 0; i < n && sm.length; i++) {
    const t = track.t[i];
    while (j + 1 < sm.length && sm[j + 1].t <= t) j++;
    const a = sm[j], b = sm[j + 1];
    if (b && a.t <= t && b.t - a.t < 4) yaw[i] = a.yaw + (b.yaw - a.yaw) * (t - a.t) / (b.t - a.t);
    else if (Math.abs(a.t - t) < 1.5) yaw[i] = a.yaw;
  }
  return yaw;
}

export function steeringAngle(track) {
  const n = track.n;
  const out = {
    deg: new Float64Array(n).fill(NaN), latAcc: new Float64Array(n).fill(NaN), yaw: null,
    longAcc: new Float64Array(n).fill(NaN), latSource: null, longSource: null,
    centre: null, straightOffset: NaN, gyroUsed: false, valid: false, planeG: NaN,
  };
  if (n < 32) return out;
  const dtMed = median(Array.from({ length: Math.min(n - 1, 2000) }, (_, i) => track.t[i + 1] - track.t[i]));
  const fs = dtMed > 0 ? 1 / dtMed : 60;
  const win = Math.max(3, Math.round(fs * 0.3));
  const ax = movingAvg(track.ax, win), ay = movingAvg(track.ay, win);
  const G = median(Array.from({ length: Math.ceil(n / 10) }, (_, k) => Math.hypot(ax[k * 10] ?? NaN, ay[k * 10] ?? NaN)));
  out.planeG = G;
  if (!(G >= MIN_PLANE_G)) return out;

  const yaw = gpsYawRate(track);
  out.yaw = yaw;
  const gpsLat = new Float64Array(n);
  for (let i = 0; i < n; i++) gpsLat[i] = track.speed[i] * yaw[i];
  out.latAcc.set(gpsLat);
  if (gpsLat.some(Number.isFinite)) out.latSource = 'GPS';

  // Gravity angle, corrected for lateral acceleration, then unwrapped (full lock > 180°).
  const meas = new Float64Array(n);
  let prev = 0, turns = 0;
  for (let i = 0; i < n; i++) {
    const la = Number.isFinite(out.latAcc[i]) ? out.latAcc[i] : 0;
    const a = Math.atan2(ax[i], ay[i]) + Math.atan2(la, G);
    if (i > 0) turns -= Math.round((a - prev) / (2 * Math.PI));
    prev = a;
    meas[i] = a + turns * 2 * Math.PI;
  }

  // Fuse with the gyro if its sign agrees with the gravity angle's rate of change.
  let sign = 0;
  const ra = track.ra;
  if (ra && ra.some(v => Number.isFinite(v) && v !== 0)) {
    let sxy = 0, sxx = 0, syy = 0;
    for (let i = win; i < n - win; i += 2) {
      const dt = track.t[i + win] - track.t[i - win];
      const w = Number.isFinite(ra[i]) ? ra[i] / D : NaN;
      if (!(dt > 0) || !Number.isFinite(w)) continue;
      const d = (meas[i + win] - meas[i - win]) / dt;
      if (Math.abs(d) < 0.1 && Math.abs(w) < 0.1) continue;
      sxy += d * w; sxx += d * d; syy += w * w;
    }
    const r = sxy / Math.sqrt(sxx * syy);
    if (r > 0.5) sign = 1; else if (r < -0.5) sign = -1;
  }
  const theta = new Float64Array(n);
  if (sign) {
    out.gyroUsed = true;
    // The gyro carries the short term; gravity (GPS-corrected) removes drift slowly,
    // so cornering force leaking into the gravity angle barely moves the estimate.
    const bias = median(Array.from({ length: Math.ceil(n / 7) }, (_, k) => ra[k * 7]));
    const tau = 6.0;
    theta[0] = meas[0];
    for (let i = 1; i < n; i++) {
      const dt = Math.max(0, Math.min(0.5, track.t[i] - track.t[i - 1]));
      const w = Number.isFinite(ra[i]) ? sign * (ra[i] - (bias || 0)) / D : 0;
      const alpha = tau / (tau + dt);
      theta[i] = alpha * (theta[i - 1] + w * dt) + (1 - alpha) * meas[i];
    }
  } else {
    theta.set(movingAvg(meas, Math.max(3, Math.round(fs * 0.5))));
  }

  // Cornering g straight from the accelerometer: rotate the in-plane vector back by
  // the wheel angle; what remains across the rim is the car's sideways acceleration.
  if (sign) {
    const la = new Float64Array(n);
    for (let i = 0; i < n; i++) la[i] = -(ax[i] * Math.cos(theta[i]) - ay[i] * Math.sin(theta[i]));
    const r = correlation(la, gpsLat, 5);
    if (r.n < 50 || r.r > 0.6) { out.latAcc = la; out.latSource = 'accelerometer'; }
  }

  // Braking/acceleration g: the screen normal (z) sees most of it. Scale and sign
  // come from regression against the GPS speed derivative.
  const az = movingAvg(track.az, Math.max(3, Math.round(fs)));
  const h = Math.max(1, Math.round(fs));
  const dvdt = new Float64Array(n).fill(NaN);
  for (let i = h; i < n - h; i++) dvdt[i] = (track.speed[i + h] - track.speed[i - h]) / (track.t[i + h] - track.t[i - h]);
  const fit = linearFit(dvdt, az, 5);
  if (fit && Math.abs(fit.r) > 0.6 && Math.abs(fit.k) > 0.2) {
    for (let i = 0; i < n; i++) out.longAcc[i] = (az[i] - fit.b) / fit.k;
    out.longSource = 'accelerometer';
  } else {
    out.longAcc.set(dvdt);
    out.longSource = dvdt.some(Number.isFinite) ? 'GPS' : null;
  }

  // Zero: the driver's "centre" calibration if given, else straight-line driving.
  const straight = [];
  for (let i = 0; i < n; i += 5) {
    if (track.speed[i] > STRAIGHT_SPEED && Math.abs(yaw[i]) < STRAIGHT_YAW) straight.push(theta[i]);
  }
  const zStraight = straight.length * 5 / fs >= 5 ? median(straight) : NaN;
  let zCal = NaN;
  const cal = (track.meta && track.meta.steerCal) || [];
  if (cal.length) {
    const ts = cal[cal.length - 1];
    const near = [];
    for (let i = 0; i < n; i++) if (Math.abs(track.ts[i] - ts) < 700) near.push(theta[i]);
    zCal = median(near);
  }
  let zero;
  if (Number.isFinite(zCal)) {
    zero = zCal; out.centre = 'calibration';
    if (Number.isFinite(zStraight)) out.straightOffset = (zStraight - zCal) * D;
  } else if (Number.isFinite(zStraight)) {
    zero = zStraight; out.centre = 'straight driving';
  } else {
    zero = median(Array.from(theta)); out.centre = 'average (no straight driving found)';
  }
  for (let i = 0; i < n; i++) out.deg[i] = (theta[i] - zero) * D;
  out.valid = true;
  return out;
}

function correlation(a, b, stride) {
  let sa = 0, sb = 0, saa = 0, sbb = 0, sab = 0, n = 0;
  for (let i = 0; i < a.length; i += stride) {
    if (!Number.isFinite(a[i]) || !Number.isFinite(b[i])) continue;
    sa += a[i]; sb += b[i]; saa += a[i] * a[i]; sbb += b[i] * b[i]; sab += a[i] * b[i]; n++;
  }
  if (n < 3) return { r: NaN, n };
  const cov = sab / n - (sa / n) * (sb / n);
  return { r: cov / Math.sqrt((saa / n - (sa / n) ** 2) * (sbb / n - (sb / n) ** 2)), n };
}

// y ≈ k·x + b over samples where both are finite and x varies.
function linearFit(x, y, stride) {
  let sx = 0, sy = 0, sxx = 0, syy = 0, sxy = 0, n = 0;
  for (let i = 0; i < x.length; i += stride) {
    if (!Number.isFinite(x[i]) || !Number.isFinite(y[i])) continue;
    sx += x[i]; sy += y[i]; sxx += x[i] * x[i]; syy += y[i] * y[i]; sxy += x[i] * y[i]; n++;
  }
  if (n < 100) return null;
  const vx = sxx / n - (sx / n) ** 2, vy = syy / n - (sy / n) ** 2, cxy = sxy / n - (sx / n) * (sy / n);
  if (!(vx > 0.05) || !(vy > 0)) return null;
  const k = cxy / vx;
  return { k, b: sy / n - k * sx / n, r: cxy / Math.sqrt(vx * vy) };
}

export function attachSteering(track) {
  if (!track.steering) track.steering = steeringAngle(track);
  return track.steering;
}

export const fmtSteer = d => (!Number.isFinite(d) ? '–' : Math.abs(d) < 0.5 ? '0°' : `${d > 0 ? 'L' : 'R'} ${Math.abs(d).toFixed(0)}°`);
