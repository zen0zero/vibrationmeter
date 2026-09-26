// Guided tests: labelled segments of a recording with known conditions, used as a
// baseline (noise floor, mount resonance, idle) and for classic A/B checks
// (coast in neutral vs cruise, same speed in another gear).
import { powerSpectrum } from './analysis.js';

// timed: seconds of measurement (parked tests); otherwise the operator ends the test.
// prep: seconds of countdown before measuring; steps: a sequence run as one test.
export const REV_RPMS = [1500, 2000, 2500, 3000];

export const TESTS = [
  {
    id: 'engine_off', group: 'baseline', title: 'Engine off', timed: 15, setsCentre: true,
    how: 'Park on level ground with the wheels pointing straight. Engine OFF. Hands off the wheel and nobody moving in the car.',
    why: 'Measures the sensor noise floor and sets the steering centre.',
  },
  {
    id: 'tap', group: 'baseline', title: 'Tap test', timed: 10,
    how: 'Engine off. Tap the steering-wheel rim firmly with your palm about once a second until the beep.',
    why: 'Finds the ringing frequency of the steering column and phone mount, so it is not mistaken for a car fault.',
  },
  {
    id: 'idle', group: 'baseline', title: 'Idle', timed: 20,
    how: 'Start the engine and let it warm up. Gearbox in neutral (P on an automatic), handbrake on, A/C and blower off. Hands off.',
    why: 'Engine vibration with no road input: the reference for everything the engine adds.',
  },
  {
    id: 'idle_ac', group: 'baseline', title: 'Idle with A/C on', timed: 20, optional: true,
    how: 'Same as idle, but with the A/C on and the blower at maximum.',
    why: 'Extra engine load at idle shows up worn engine mounts, a weak idle speed control or a rough A/C compressor.',
  },
  {
    id: 'idle_drive', group: 'baseline', title: 'In gear, brake held', timed: 15, optional: true, onlyFor: 'automatic',
    how: 'Foot firmly on the brake, select D (or R). Handbrake on.',
    why: 'The engine twists against its mounts. A big increase over idle points at worn engine or gearbox mounts.',
  },
  {
    id: 'rev_steps', group: 'baseline', title: 'Rev steps', optional: true, steps: REV_RPMS.map(r => `rev_${r}`),
    why: 'Holds 1500, 2000, 2500 and 3000 rpm for 12 s each. Shows engine vibration and resonances by rpm – and if the engine stays smooth, rules it out.',
  },
  ...REV_RPMS.map(rpm => ({
    id: `rev_${rpm}`, group: 'baseline', title: `Hold ${rpm} rpm`, timed: 12, prep: 6, rpm, hidden: true,
    how: `Neutral, handbrake on. Raise the engine to ${rpm} rpm on the rev counter and hold it as steady as you can until the beep.`,
    prepText: `Bring the engine to ${rpm} rpm and hold it.`,
  })),
  {
    id: 'rev', group: 'baseline', title: 'Slow rev', timed: 30, optional: true,
    how: 'Neutral: over 10 seconds raise the engine speed slowly to about 3000 rpm, hold it briefly, then let it fall slowly.',
    why: 'Sweeps through every rpm, catching resonances between the rev steps.',
  },
  {
    id: 'steer_sweep', group: 'baseline', title: 'Lock-to-lock', timed: 25, optional: true,
    how: 'Engine running, car stopped. Turn the wheel slowly to full LEFT lock, then to full RIGHT lock, then back to centre.',
    why: 'Measures the steering range (an off-centre steering wheel shows as unequal left/right) and checks the power steering at full lock.',
  },
  {
    id: 'steps', group: 'driving', title: 'Speed steps',
    how: 'On a straight, smooth road, hold each speed for about 15 seconds: 30, 50, 70, 90, 110, 130 km/h (as far as the road allows). Tap Done at the end.',
    why: 'Steady data across the whole speed range, so the analysis can find where the vibration is worst and match it to wheel speed.',
  },
  {
    id: 'coast', group: 'driving', title: 'Coast in neutral',
    how: 'Where it is safe and legal: from the highest speed you drove, press the clutch or shift to neutral and roll down to about 40 km/h. Tap Done, then re-engage the gear. Repeat if you like.',
    why: 'Compared at the speed where the vibration is worst: unchanged means wheels, tires, brakes or bearings; if it disappears, the engine or drivetrain under load.',
  },
  {
    id: 'gear', group: 'driving', title: 'One gear lower', optional: true,
    how: 'Drive a stretch one gear lower than usual, holding a few different speeds for 10–15 seconds each. Tap Done.',
    why: 'If the vibration changes with the gear at the same road speed, it follows engine rpm, not the wheels.',
  },
  {
    id: 'pullaway', group: 'driving', title: 'Pull away', optional: true, onlyFor: 'manual',
    how: 'From a standstill, pull away normally in 1st gear to about 20 km/h, then stop. Do it three times, then tap Done.',
    why: 'Shudder while the clutch engages points at clutch judder (disc, flywheel) or worn engine/gearbox mounts.',
  },
  {
    id: 'brake', group: 'driving', title: 'Braking', optional: true,
    how: 'From about 90 km/h, brake firmly (not an emergency stop) down to 20 km/h. Do it twice, then tap Done.',
    why: 'A repeatable brake-judder check.',
  },
  // Older recordings may contain this test.
  { id: 'cruise', group: 'driving', title: 'Steady cruise', hidden: true, legacy: true },
];

export const TEST_BY_ID = Object.fromEntries(TESTS.map(t => [t.id, t]));
export const STATIONARY = new Set(TESTS.filter(t => t.group === 'baseline').map(t => t.id));

// Tests shown for this car (e.g. no "brake held in D" for a manual gearbox).
export function testsFor(vehicle = {}) {
  const box = vehicle.gearbox || 'manual';
  return TESTS.filter(t => !t.hidden && (!t.onlyFor || t.onlyFor === box));
}

// ---------- analysis ----------

const MIN_HZ = 2.5;

// Welch-averaged spectrum of the three (high-passed) axes over samples [a, b), block size N.
function segmentSpectrum(ctx, a, b, N) {
  if (N < 32 || b - a < N) return null;
  const spec = new Float64Array(N / 2);
  let count = 0;
  for (let s = a; s + N <= b; s += N / 2) {
    for (const x of [ctx.ax, ctx.ay, ctx.az]) powerSpectrum(x, s, N, spec);
    count++;
  }
  for (let k = 0; k < spec.length; k++) spec[k] /= count;
  return summarize(spec, ctx.fs / N);
}

function summarize(spec, df) {
  const kMin = Math.ceil(MIN_HZ / df), kMax = Math.min(spec.length - 1, Math.floor(0.95 * (spec.length * df) / df));
  let tot = 0, pk = kMin;
  for (let k = kMin; k <= kMax; k++) { tot += spec[k]; if (spec[k] > spec[pk]) pk = k; }
  return { spec, df, rms: Math.sqrt(tot), peakHz: pk * df };
}

// RMS within ±bw Hz of f (the engine's own frequency at idle).
function bandRms(sp, f, bw = 1) {
  if (!sp || !Number.isFinite(f)) return NaN;
  let s = 0;
  for (let k = Math.max(1, Math.floor((f - bw) / sp.df)); k <= Math.ceil((f + bw) / sp.df) && k < sp.spec.length; k++) s += sp.spec[k];
  return Math.sqrt(s);
}

function rmsRange(ctx, a, b) {
  let s = 0;
  for (let i = a; i < b; i++) s += ctx.ax[i] ** 2 + ctx.ay[i] ** 2 + ctx.az[i] ** 2;
  return b > a ? Math.sqrt(s / (b - a)) : NaN;
}

function meanFinite(x, a, b) {
  let s = 0, n = 0;
  for (let i = a; i < b; i++) if (Number.isFinite(x[i])) { s += x[i]; n++; }
  return n ? s / n : NaN;
}

const clamp01 = x => Math.max(0, Math.min(1, x));
const pct = x => `${Math.round(x * 100)}%`;

// Frequency at which a vibration of f Hz appears when sampled at fs (fold-back).
export function aliasOf(f, fs) {
  return Math.abs(f - fs * Math.round(f / fs));
}

function median(a) {
  const v = a.filter(Number.isFinite).sort((p, q) => p - q);
  return v.length ? v[v.length >> 1] : NaN;
}

// All runs of one test pooled: spectra averaged (weighted by length), outlier run
// dropped when there are three or more, spread between runs reported.
function poolRuns(ctx, id, ranges) {
  const minLen = Math.min(...ranges.map(([a, b]) => b - a));
  let N = 1;
  while (N * 2 <= Math.min(ctx.N, minLen)) N <<= 1;
  const runs = ranges.map(([a, b]) => ({ a, b, sp: segmentSpectrum(ctx, a, b, N), rms: rmsRange(ctx, a, b) }));
  for (const r of runs) if (r.sp) r.rms = r.sp.rms;
  let kept = runs;
  let dropped = 0;
  if (runs.length >= 3) {
    const med = median(runs.map(r => r.rms));
    kept = runs.filter(r => Math.abs(r.rms / med - 1) <= 0.4);
    if (!kept.length) kept = runs;
    dropped = runs.length - kept.length;
  }
  const withSp = kept.filter(r => r.sp);
  let sp = null;
  if (withSp.length) {
    const spec = new Float64Array(N / 2);
    let wsum = 0;
    for (const r of withSp) { const w = r.b - r.a; wsum += w; for (let k = 0; k < spec.length; k++) spec[k] += r.sp.spec[k] * w; }
    for (let k = 0; k < spec.length; k++) spec[k] /= wsum;
    sp = summarize(spec, ctx.fs / N);
  }
  const rmsList = kept.map(r => r.rms);
  const mean = rmsList.reduce((x, y) => x + y, 0) / rmsList.length;
  const spread = kept.length >= 2 ? (Math.max(...rmsList) - Math.min(...rmsList)) / mean : 0;
  const last = runs[runs.length - 1];
  const def = TEST_BY_ID[id] || { title: id };
  let speed = 0, n = 0;
  for (const r of kept) for (let i = r.a; i < r.b; i++) if (Number.isFinite(ctx.r.speed[i])) { speed += ctx.r.speed[i]; n++; }
  return {
    id, title: def.title, runs: runs.length, dropped, spread, spec: sp,
    rms: sp ? sp.rms : mean, peakHz: sp ? sp.peakHz : NaN,
    duration: kept.reduce((x, r) => x + (r.b - r.a), 0) / ctx.fs,
    a: last.a, b: last.b, ranges: kept.map(r => [r.a, r.b]),
    speed: n ? speed / n : NaN, note: '',
  };
}

// Idle rpm from a comb over the engine orders (half, crank, firing), each placed where
// it lands after fold-back. Robust when a misfire makes the half-order the tallest peak.
function estimateIdleRpm(sp, fs, cyl) {
  if (!sp) return NaN;
  let best = NaN, bestScore = 0;
  for (let rpm = 550; rpm <= 1300; rpm += 5) {
    let score = 0;
    for (const o of [0.5, 1, cyl / 2]) {
      const fa = aliasOf(rpm / 60 * o, fs);
      if (fa < MIN_HZ) continue;
      score += bandRms(sp, fa, 0.25) ** 2 * (o === cyl / 2 ? 1.5 : 1);
    }
    if (score > bestScore) { bestScore = score; best = rpm; }
  }
  return best;
}

// ctx: { r, ax, ay, az, fs, N, t0 (epoch of r.t = 0), segments, matchedRatio, res }
export function analyzeTests(ctx) {
  const findings = [];
  const add = f => findings.push({ confidence: 0, ...f });
  const groups = new Map();
  for (const seg of ctx.segments || []) {
    if (!(seg.t1 > seg.t0)) continue;
    const a = Math.max(0, Math.round(((seg.t0 - ctx.t0) / 1000 - ctx.r.t[0]) * ctx.fs));
    const b = Math.min(ctx.r.n, Math.round(((seg.t1 - ctx.t0) / 1000 - ctx.r.t[0]) * ctx.fs));
    if (b - a < ctx.fs * 2) continue;
    if (!groups.has(seg.id)) groups.set(seg.id, []);
    groups.get(seg.id).push([a, b]);
  }
  const byId = {};
  const results = [];
  for (const [id, ranges] of groups) {
    const res = poolRuns(ctx, id, ranges);
    byId[id] = res;
    results.push(res);
  }
  // Order the table like the test list.
  const order = TESTS.map(t => t.id);
  results.sort((x, y) => order.indexOf(x.id) - order.indexOf(y.id));

  const disagree = results.filter(t => t.runs >= 2 && t.spread > 0.4 && STATIONARY.has(t.id));
  if (disagree.length) {
    add({ id: 'runsdisagree', severity: 'info', confidence: 0.3,
      title: 'Repeated parked tests gave different results',
      detail: `${disagree.map(t => `${t.title} (${Math.round(t.spread * 100)}% apart)`).join(', ')}. Something changed between runs – ` +
        'the radiator fan or A/C compressor switching, a door, someone moving, or a cold engine idling faster. Those results are less reliable; repeat them in calm conditions.' });
  }

  const idle = byId.idle, off = byId.engine_off;
  const cyl = ctx.res.cylinders || 4;

  if (off) {
    off.note = 'noise floor';
    if (off.rms > 0.06) {
      add({ id: 'noisybase', severity: 'info', title: 'Baseline is noisy with the engine off',
        detail: `With the engine off the phone still measured ${off.rms.toFixed(3)} m/s² (a rigid mount gives well under 0.03). ` +
          'Either something moved during the test or the mount is loose – a loose mount adds its own rattle to every result. Tighten it and repeat.' });
    }
  }

  if (byId.tap && byId.tap.spec) {
    const t = byId.tap;
    t.note = `rings at ${t.peakHz.toFixed(1)} Hz`;
    ctx.res.tapHz = t.peakHz;
    add({ id: 'tapres', severity: 'info', confidence: 0.3,
      title: `Steering wheel + mount resonance: ${t.peakHz.toFixed(1)} Hz`,
      detail: `Tapping the rim makes the steering column and phone mount ring at ${t.peakHz.toFixed(1)} Hz. ` +
        'A road or wheel vibration near this frequency gets amplified, so a vibration felt only in a narrow speed range may just be the speed ' +
        `at which a wheel turns ${t.peakHz.toFixed(1)} times per second.` });
  }

  let idleRpm = NaN;
  if (idle) {
    idleRpm = estimateIdleRpm(idle.spec, ctx.fs, cyl);
    idle.firingHz = aliasOf(idleRpm / 60 * cyl / 2, ctx.fs);
    idle.rpm = idleRpm;
    idle.note = Number.isFinite(idleRpm) ? `≈ ${Math.round(idleRpm)} rpm (firing ${(idleRpm / 60 * cyl / 2).toFixed(1)} Hz)` : `peak ${idle.peakHz.toFixed(1)} Hz`;
    if (off) idle.note += `, ${(idle.rms / Math.max(off.rms, 1e-3)).toFixed(1)}× engine-off`;
    ctx.res.idleTest = idle;
    // Uneven cylinders / misfire: energy at half and once per crank turn.
    const f05 = idleRpm / 120, f1 = idleRpm / 60;
    const share = Math.hypot(bandRms(idle.spec, f05, 0.6), bandRms(idle.spec, f1, 0.6)) / Math.max(idle.rms, 1e-4);
    const aboveFloor = !off || idle.rms > 2 * off.rms;
    if (idle.spec && Number.isFinite(idleRpm) && f05 > MIN_HZ && share >= 0.5 && aboveFloor && idle.rms > 0.04) {
      add({ id: 'misfire', severity: 'info', confidence: clamp01((share - 0.4) / 0.5) * 0.6,
        title: 'Uneven running at idle (possible misfire)',
        detail: `${pct(share)} of the idle vibration is at half and once per crankshaft turn (${f05.toFixed(1)} and ${f1.toFixed(1)} Hz at ≈ ${Math.round(idleRpm)} rpm), ` +
          `not at the ${cyl}-cylinder firing frequency. A smooth engine concentrates on the firing frequency; this pattern suggests one cylinder working less ` +
          '(misfire, injector, compression) or an out-of-balance flywheel/crank pulley. Read fault codes and check for misfire counts.' });
    }
  }

  const loadTest = (t, id, limit, title, detail) => {
    if (!t || !idle) return;
    // Larger of: overall level, and the level at the idle firing frequency.
    const total = t.rms / Math.max(idle.rms, 1e-3);
    const fe = Number.isFinite(idle.firingHz) ? idle.firingHz : idle.peakHz;
    const atPeak = bandRms(t.spec, fe) / Math.max(bandRms(idle.spec, fe), 1e-4);
    const ratio = Math.max(total, Number.isFinite(atPeak) ? atPeak : 0);
    t.note = `${total.toFixed(1)}× idle overall, ${Number.isFinite(atPeak) ? atPeak.toFixed(1) : '–'}× at the engine frequency`;
    if (ratio >= limit) {
      add({ id, severity: 'warning', confidence: clamp01((ratio - limit + 0.3) / 1.5), title,
        detail: detail(ratio) });
    }
  };
  loadTest(byId.idle_ac, 'acload', 1.5, 'Vibration rises with A/C load at idle', r =>
    `Switching the A/C on raises idle vibration ${r.toFixed(1)}×. Suspect worn engine mounts (the extra load rocks the engine), ` +
    'an idle speed that does not rise enough with the A/C, or a rough A/C compressor or clutch.');
  loadTest(byId.idle_drive, 'mounts', 1.8, 'Engine/gearbox mounts (vibration in gear at standstill)', r =>
    `Holding the car on the brake in gear makes it vibrate ${r.toFixed(1)}× more than in P/N. The engine twists against its mounts under torque; ` +
    'a large increase usually means a collapsed or cracked engine or gearbox mount. Inspect the mounts, especially the lower torque mount.');

  // Rev steps: level by rpm, where each engine frequency lands after fold-back.
  const steps = REV_RPMS.map(rpm => byId[`rev_${rpm}`] && { rpm, t: byId[`rev_${rpm}`] }).filter(Boolean);
  ctx.res.engineLines = [];
  if (steps.length) {
    const orders = [[0.5, 'half-order'], [1, 'crank'], [cyl / 2, 'firing'], [cyl, '2× firing']];
    for (const { rpm, t } of steps) {
      const ratio = idle ? t.rms / Math.max(idle.rms, 1e-3) : NaN;
      let match = null;
      for (const [o, label] of orders) {
        const f = rpm / 60 * o;
        const fa = aliasOf(f, ctx.fs);
        ctx.res.engineLines.push({ rpm, order: o, label, f, alias: fa });
        const tol = Math.max(0.8, 0.07 * f);
        if (!match && Number.isFinite(t.peakHz) && Math.abs(t.peakHz - fa) <= tol) match = { label, f, fa };
      }
      t.ratio = ratio;
      t.note = (Number.isFinite(ratio) ? `${ratio.toFixed(1)}× idle · ` : '') +
        (match ? `peak ${t.peakHz.toFixed(1)} Hz = ${match.label} ${match.f.toFixed(0)} Hz${match.f > ctx.fs / 2 ? ' folded back' : ''}`
               : `peak ${t.peakHz.toFixed(1)} Hz`);
      t.engineMatch = match;
    }
    // A step much stronger than its neighbours = resonance near that rpm.
    if (idle) {
      steps.forEach(({ rpm, t }, i) => {
        const nb = [steps[i - 1], steps[i + 1]].filter(Boolean).map(x => x.t.rms);
        if (t.ratio >= 3 && nb.every(v => t.rms >= 1.8 * v)) {
          add({ id: `revres${rpm}`, severity: 'info', confidence: clamp01((t.ratio - 2.5) / 4) * 0.7,
            title: `Engine vibration peaks around ${rpm} rpm (parked)`,
            detail: `At ${rpm} rpm the parked engine vibrates ${t.ratio.toFixed(1)}× more than at idle and clearly more than at the neighbouring steps. ` +
              'A peak at one rpm is a resonance: engine or gearbox mounts, exhaust hangers and heat shields, or an accessory bracket. ' +
              'If you feel the same vibration while driving at this rpm, that is where it comes from.' });
        }
      });
    }
    // Neutral run-up verdict, without needing the driving rpm: compare with the worst driving speed band.
    const moving = ctx.res.bands.filter(b => !b.idle && b.n >= 2);
    const worst = moving.length ? moving.reduce((x, y) => (y.rms > x.rms ? y : x)) : null;
    const maxStep = steps.reduce((x, y) => (y.t.rms > x.t.rms ? y : x));
    if (worst && steps.length >= 2) {
      const rel = maxStep.t.rms / worst.rms;
      if (rel <= 0.4) {
        add({ id: 'enginesmooth', severity: 'info', confidence: clamp01((0.5 - rel) / 0.4) * 0.8,
          title: 'Engine is smooth when revved parked → not the main source',
          detail: `Across the rev steps the engine reached at most ${maxStep.t.rms.toFixed(2)} m/s² (at ${maxStep.rpm} rpm), only ${pct(rel)} of the ` +
            `${worst.rms.toFixed(2)} m/s² measured while driving at ${worst.lo}–${worst.hi} km/h. The driving vibration therefore needs the car to move: ` +
            'wheels, tires, brakes, bearings, or the drivetrain under load.' });
      } else if (rel >= 0.7) {
        add({ id: 'engineparked', severity: 'warning', confidence: clamp01((rel - 0.5) / 0.6) * 0.8,
          title: `Parked engine at ${maxStep.rpm} rpm vibrates as much as the car does on the road`,
          detail: `Revving to ${maxStep.rpm} rpm in neutral gives ${maxStep.t.rms.toFixed(2)} m/s² – ${pct(rel)} of the worst driving level ` +
            `(${worst.lo}–${worst.hi} km/h). The engine alone can explain the vibration: check engine mounts, misfire, and the exhaust and its hangers.` });
      }
    }
  }

  if (byId.rev) {
    const t = byId.rev;
    const step = Math.round(ctx.fs);
    let max = 0, at = 0;
    for (let s = t.a; s + step <= t.b; s += step) {
      const v = rmsRange(ctx, s, s + step);
      if (v > max) { max = v; at = (s - t.a) / ctx.fs; }
    }
    const base = idle ? idle.rms : t.rms;
    const ratio = max / Math.max(base, 1e-3);
    t.note = `max ${max.toFixed(2)} m/s² at ${at.toFixed(0)} s (${ratio.toFixed(1)}× idle)`;
    if (idle && ratio >= 3 && !findings.some(f => f.id.startsWith('revres'))) {
      add({ id: 'revres', severity: 'info', confidence: clamp01((ratio - 2.5) / 4) * 0.7,
        title: 'Strong vibration while revving at standstill',
        detail: `Revving the parked engine produced up to ${ratio.toFixed(1)}× the idle vibration (${at.toFixed(0)} s into the test). ` +
          'Since the car was not moving, this comes from the engine, exhaust or their mounts. If it feels like the vibration you get while driving, ' +
          'the wheels are not the cause. Check exhaust hangers and heat shields, engine mounts, and for a misfire.' });
    }
  }
  if (byId.steer_sweep) {
    const t = byId.steer_sweep;
    let lo = Infinity, hi = -Infinity;
    for (let i = t.a; i < t.b; i++) { const d = ctx.r.steerDeg?.[i]; if (Number.isFinite(d)) { lo = Math.min(lo, d); hi = Math.max(hi, d); } }
    if (Number.isFinite(lo) && hi - lo > 180) {
      t.note = `L ${hi.toFixed(0)}° / R ${(-lo).toFixed(0)}°`;
      const asym = (hi + lo) / 2; // + = centre sits to the left of the rack's middle
      ctx.res.lockToLock = { left: hi, right: -lo };
      if (Math.abs(asym) >= 8) {
        add({ id: 'rackcentre', severity: 'info', confidence: clamp01((Math.abs(asym) - 5) / 20),
          title: 'Steering wheel not centred on the rack',
          detail: `The wheel turns ${hi.toFixed(0)}° to the left lock and ${(-lo).toFixed(0)}° to the right from your centre point, ` +
            `so straight-ahead is about ${Math.abs(asym).toFixed(0)}° off the middle of the rack. That usually means the tie-rods (toe) were adjusted unevenly – ` +
            'an alignment job – or the centre was set with the wheels not quite straight.' });
      }
      // vibration near the locks vs mid-sweep
      const span = Math.max(Math.abs(lo), Math.abs(hi));
      let sl = 0, nl = 0, sm = 0, nm = 0;
      for (let i = t.a; i < t.b; i++) {
        const d = Math.abs(ctx.r.steerDeg[i]);
        const e = ctx.ax[i] ** 2 + ctx.ay[i] ** 2 + ctx.az[i] ** 2;
        if (d > span * 0.85) { sl += e; nl++; } else if (d < span * 0.5) { sm += e; nm++; }
      }
      const ratio = nl > ctx.fs && nm > ctx.fs ? Math.sqrt(sl / nl) / Math.sqrt(sm / nm) : NaN;
      if (ratio >= 2) {
        add({ id: 'pslock', severity: 'info', confidence: clamp01((ratio - 1.5) / 3) * 0.6,
          title: 'Vibration at full lock (parked)',
          detail: `At full lock the wheel vibrates ${ratio.toFixed(1)}× more than mid-sweep. Some shudder at the stops is normal; a lot suggests low power-steering fluid, ` +
            'a struggling pump or worn rack. It can also be tire scrub on a grippy surface – repeat on a smooth one.' });
      }
    } else {
      t.note = 'steering range not measured';
    }
  }

  // Driving A/B tests: compared with steady driving at the same speed, preferably
  // in the speed band where the vibration is worst (found by the analysis).
  const W = ctx.res.windows;
  const moving = ctx.res.bands.filter(b => !b.idle && b.n >= 2);
  const worst = moving.length ? moving.reduce((x, y) => (y.rms > x.rms ? y : x)) : null;
  const inWorst = w => worst && w.speed * 3.6 >= worst.lo - 5 && w.speed * 3.6 < worst.hi + 5;
  const inTest = id => w => w.test === id && w.speed > 20 / 3.6;
  const reference = w => (!w.test || w.test === 'steps' || w.test === 'cruise') && w.state === 'cruise' && w.speed > 20 / 3.6;
  const compare = id => {
    const atWorst = ctx.matchedRatio(ctx.res, w => inTest(id)(w) && inWorst(w), reference, 'rms', 6);
    if (atWorst && atWorst.n >= 1) return { ...atWorst, where: `at ${worst.lo}–${worst.hi} km/h, where it is worst` };
    const any = ctx.matchedRatio(ctx.res, inTest(id), reference, 'rms', 6);
    return any && any.n >= 1 ? { ...any, where: worst ? `outside the worst speeds (${worst.lo}–${worst.hi} km/h) – repeat it through that range` : 'at all speeds' } : null;
  };
  if (byId.steps) {
    const ws = W.filter(w => w.test === 'steps' && Number.isFinite(w.speed));
    const lo = Math.min(...ws.map(w => w.speed * 3.6)), hi = Math.max(...ws.map(w => w.speed * 3.6));
    byId.steps.note = ws.length ? `covered ${Math.round(lo)}–${Math.round(hi)} km/h` : 'no GPS speed';
  }
  if (byId.coast) {
    const m = compare('coast');
    const t = byId.coast;
    if (m) {
      t.note = `${m.ratio.toFixed(2)}× in gear, ${m.where}`;
      if (m.ratio <= 0.6) {
        add({ id: 'coastdrop', severity: 'warning', confidence: clamp01((0.75 - m.ratio) / 0.4),
          title: 'Vibration disappears when coasting in neutral',
          detail: `Rolling in neutral the vibration drops to ${pct(m.ratio)} of the level in gear at the same speed, ${m.where}. The wheels still turn at the same speed, ` +
            'so wheels, tires and brakes are unlikely. Look at the engine and drivetrain under load: engine/gearbox mounts, inner CV joints, ' +
            'clutch/flywheel, or a misfire under load.' });
      } else if (m.ratio >= 0.75 && m.ratio <= 1.3) {
        add({ id: 'coastsame', severity: 'info', confidence: clamp01(1 - Math.abs(m.ratio - 1) / 0.3) * 0.8,
          title: 'Vibration unchanged in neutral → road-speed related',
          detail: `In neutral the vibration stays at ${pct(m.ratio)} of the level in gear, ${m.where}. It follows road speed, not the engine: wheels, tires, ` +
            'wheel bearings, brakes, or the drive shafts.' });
      }
    } else {
      t.note = 'no steady driving at the same speeds to compare with';
    }
  }
  if (byId.gear) {
    const m = compare('gear');
    const t = byId.gear;
    if (m) {
      t.note = `${m.ratio.toFixed(2)}× normal gear, ${m.where}`;
      if (m.ratio >= 1.4 || m.ratio <= 0.7) {
        add({ id: 'gearrpm', severity: 'warning', confidence: clamp01((Math.max(m.ratio, 1 / m.ratio) - 1.2) / 1.2),
          title: 'Vibration changes with the gear → engine rpm related',
          detail: `At the same road speed one gear lower, the vibration is ${m.ratio.toFixed(1)}× the normal level, ${m.where}. Road speed was the same, so the difference ` +
            'comes from engine speed: engine balance or misfire, flywheel/clutch, engine mounts, or exhaust resonance.' });
      } else {
        t.note += ' – engine rpm not the cause';
      }
    } else {
      t.note = 'no steady driving at the same speeds to compare with';
    }
  }
  if (byId.pullaway) {
    const t = byId.pullaway;
    const pulls = W.filter(w => w.test === 'pullaway' && w.accel > 0.4 && w.speed > 0.5 && w.speed < 30 / 3.6);
    const refs = W.filter(w => !w.test && (w.state === 'cruise' || w.state === 'transient') && w.speed > 10 / 3.6 && w.speed < 45 / 3.6);
    const rmsOf = ws => Math.sqrt(ws.reduce((a, w) => a + w.rms * w.rms, 0) / ws.length);
    const refRms = refs.length ? rmsOf(refs) : idle ? idle.rms : NaN;
    const refName = refs.length ? 'steady driving at low speed' : 'idle';
    if (pulls.length && Number.isFinite(refRms)) {
      const ratio = rmsOf(pulls) / refRms;
      const peak = pulls.reduce((a, w) => a + w.peakHz, 0) / pulls.length;
      t.note = `${ratio.toFixed(1)}× ${refName}, around ${peak.toFixed(0)} Hz`;
      if (ratio >= 2) {
        add({ id: 'clutch', severity: 'warning', confidence: clamp01((ratio - 1.6) / 2),
          title: 'Judder when pulling away (clutch engagement)',
          detail: `Pulling away in 1st the vibration is ${ratio.toFixed(1)}× ${refName} (around ${peak.toFixed(0)} Hz). ` +
            'Shudder while the clutch bites comes from a contaminated or glazed clutch disc, a warped flywheel or pressure plate, a failing dual-mass flywheel, ' +
            'or engine/gearbox mounts letting the engine rock. If it is worse when cold or with a heavy load, suspect the clutch first.' });
      }
    } else {
      t.note = 'no pull-away from standstill detected';
    }
  }
  if (byId.brake) {
    const bw = W.filter(w => w.test === 'brake' && w.state === 'braking').length;
    byId.brake.note = bw ? `${bw} braking windows` : 'no firm braking detected';
  }
  if (byId.cruise) byId.cruise.note = Number.isFinite(byId.cruise.speed) ? `${Math.round(byId.cruise.speed * 3.6)} km/h reference` : 'no GPS speed';
  for (const t of results) if (t.runs > 1) t.note = `${t.runs} runs${t.dropped ? ` (${t.dropped} discarded)` : ''}${t.spread ? `, ±${Math.round(t.spread * 50)}%` : ''} · ${t.note}`;

  return { results, findings };
}
