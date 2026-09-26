// Guided tests: labelled segments of a recording with known conditions, used as a
// baseline (noise floor, mount resonance, idle) and for classic A/B checks
// (coast in neutral vs cruise, same speed in another gear).
import { powerSpectrum } from './analysis.js';

// timed: seconds of measurement (parked tests); otherwise the operator ends the test.
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
    how: 'Start the engine and let it settle. Gearbox in P or N, handbrake on, A/C and blower off. Hands off.',
    why: 'Engine vibration with no road input: the reference for everything the engine adds.',
  },
  {
    id: 'idle_ac', group: 'baseline', title: 'Idle with A/C on', timed: 20, optional: true,
    how: 'Same as idle, but with the A/C on and the blower at maximum.',
    why: 'Extra engine load at idle shows up worn engine mounts, a weak idle speed control or a rough A/C compressor.',
  },
  {
    id: 'idle_drive', group: 'baseline', title: 'In gear, brake held', timed: 15, optional: true,
    how: 'Automatic only: foot firmly on the brake, select D (or R). Handbrake on. Manual gearbox: skip this test.',
    why: 'The engine twists against its mounts. A big increase over idle points at worn engine or gearbox mounts.',
  },
  {
    id: 'rev', group: 'baseline', title: 'Slow rev', timed: 30, optional: true,
    how: 'In P or N: over 10 seconds raise the engine speed slowly to about 3000 rpm, hold it briefly, then let it fall slowly.',
    why: 'Shows engine, exhaust and mount resonances without the car moving.',
  },
  {
    id: 'steer_sweep', group: 'baseline', title: 'Lock-to-lock', timed: 25, optional: true,
    how: 'Engine running, car stopped. Turn the wheel slowly to full LEFT lock, then to full RIGHT lock, then back to centre.',
    why: 'Measures the steering range (an off-centre steering wheel shows as unequal left/right) and checks the power steering at full lock.',
  },
  {
    id: 'cruise', group: 'driving', title: 'Steady cruise',
    how: 'Hold a steady {v} km/h on a straight, smooth road for at least 20 seconds, then tap Done.',
    why: 'The reference for the coast and gear tests.',
  },
  {
    id: 'coast', group: 'driving', title: 'Coast in neutral',
    how: 'Where it is safe and legal: reach {v+} km/h, shift to neutral (or press the clutch) and let the car roll down past {v-} km/h. Tap Done, then re-engage the gear.',
    why: 'Unchanged vibration means wheels, tires, brakes or bearings. If it disappears, the cause is the engine or the drivetrain under load.',
  },
  {
    id: 'gear', group: 'driving', title: 'Same speed, lower gear', optional: true,
    how: 'Hold {v} km/h for 20 seconds in one gear lower than normal (manual, or the automatic\'s manual mode). Tap Done.',
    why: 'If the vibration changes with the gear at the same road speed, it follows engine rpm, not the wheels.',
  },
  {
    id: 'brake', group: 'driving', title: 'Braking', optional: true,
    how: 'From about 90 km/h, brake firmly (not an emergency stop) down to 20 km/h. Do it twice, then tap Done.',
    why: 'A repeatable brake-judder check.',
  },
];

export const TEST_BY_ID = Object.fromEntries(TESTS.map(t => [t.id, t]));
export const STATIONARY = new Set(TESTS.filter(t => t.group === 'baseline').map(t => t.id));

export function testText(text, v) {
  const s = Math.round(+v || 100);
  return text.replace('{v}', s).replace('{v+}', s + 10).replace('{v-}', Math.max(20, s - 20));
}

// ---------- analysis ----------

const MIN_HZ = 2.5;

// Welch-averaged spectrum of the three (high-passed) axes over samples [a, b).
function segmentSpectrum(ctx, a, b) {
  let N = 1;
  while (N * 2 <= Math.min(ctx.N, b - a)) N <<= 1;
  if (N < 32) return null;
  const spec = new Float64Array(N / 2);
  let count = 0;
  for (let s = a; s + N <= b; s += N / 2) {
    for (const x of [ctx.ax, ctx.ay, ctx.az]) powerSpectrum(x, s, N, spec);
    count++;
  }
  for (let k = 0; k < spec.length; k++) spec[k] /= count;
  const df = ctx.fs / N;
  const kMin = Math.ceil(MIN_HZ / df), kMax = Math.floor(0.95 * ctx.fs / 2 / df);
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

// ctx: { r, ax, ay, az, fs, N, t0 (epoch of r.t = 0), segments, matchedRatio, res }
export function analyzeTests(ctx) {
  const results = [], findings = [];
  const byId = {};
  for (const seg of ctx.segments || []) {
    if (!(seg.t1 > seg.t0)) continue;
    const a = Math.max(0, Math.round(((seg.t0 - ctx.t0) / 1000 - ctx.r.t[0]) * ctx.fs));
    const b = Math.min(ctx.r.n, Math.round(((seg.t1 - ctx.t0) / 1000 - ctx.r.t[0]) * ctx.fs));
    if (b - a < ctx.fs * 2) continue;
    const def = TEST_BY_ID[seg.id] || { title: seg.id };
    const sp = segmentSpectrum(ctx, a, b);
    const out = {
      id: seg.id, title: def.title, a, b, duration: (b - a) / ctx.fs,
      rms: sp ? sp.rms : rmsRange(ctx, a, b), peakHz: sp ? sp.peakHz : NaN, spec: sp,
      speed: meanFinite(ctx.r.speed, a, b), note: '',
    };
    results.push(out);
    byId[seg.id] = out; // the last run of a test wins
  }
  const idle = byId.idle, off = byId.engine_off;
  const add = f => findings.push({ confidence: 0, ...f });

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

  if (idle) {
    const rpm = idle.peakHz * 120 / (ctx.res.cylinders || 4);
    idle.note = `peak ${idle.peakHz.toFixed(1)} Hz (≈ ${Math.round(rpm)} rpm firing)`;
    if (off) idle.note += `, ${(idle.rms / Math.max(off.rms, 1e-3)).toFixed(1)}× engine-off`;
    ctx.res.idleTest = idle;
  }

  const loadTest = (t, id, limit, title, detail) => {
    if (!t || !idle) return;
    // Larger of: overall level, and the level at the idle firing frequency.
    const total = t.rms / Math.max(idle.rms, 1e-3);
    const atPeak = bandRms(t.spec, idle.peakHz) / Math.max(bandRms(idle.spec, idle.peakHz), 1e-4);
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
    if (idle && ratio >= 3) {
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

  // Driving A/B tests, compared with speed-matched windows.
  const W = ctx.res.windows;
  const inTest = id => w => w.test === id && w.speed > 20 / 3.6;
  const reference = w => (w.test === 'cruise' || (!w.test && w.state === 'cruise')) && w.speed > 20 / 3.6;
  if (byId.coast) {
    const m = ctx.matchedRatio(ctx.res, inTest('coast'), reference, 'rms', 6);
    const t = byId.coast;
    if (m && m.n >= 1) {
      t.note = `${m.ratio.toFixed(2)}× cruise at the same speed`;
      if (m.ratio <= 0.6) {
        add({ id: 'coastdrop', severity: 'warning', confidence: clamp01((0.75 - m.ratio) / 0.4),
          title: 'Vibration disappears when coasting in neutral',
          detail: `Rolling in neutral the vibration drops to ${pct(m.ratio)} of the level in gear at the same speed. The wheels still turn at the same speed, ` +
            'so wheels, tires and brakes are unlikely. Look at the engine and drivetrain under load: engine/gearbox mounts, inner CV joints, driveshaft angles, ' +
            'or a misfire under load.' });
      } else if (m.ratio >= 0.75 && m.ratio <= 1.3) {
        add({ id: 'coastsame', severity: 'info', confidence: clamp01(1 - Math.abs(m.ratio - 1) / 0.3) * 0.8,
          title: 'Vibration unchanged in neutral → road-speed related',
          detail: `In neutral the vibration stays at ${pct(m.ratio)} of the level in gear. It follows road speed, not the engine: wheels, tires, ` +
            'wheel bearings, brakes, or the driveshaft after the gearbox (which keeps turning on RWD/AWD cars).' });
      }
    } else {
      t.note = 'no matching cruise at that speed';
    }
  }
  if (byId.gear) {
    const m = ctx.matchedRatio(ctx.res, inTest('gear'), reference, 'rms', 6);
    const t = byId.gear;
    if (m && m.n >= 1) {
      t.note = `${m.ratio.toFixed(2)}× cruise at the same speed`;
      if (m.ratio >= 1.4 || m.ratio <= 0.7) {
        add({ id: 'gearrpm', severity: 'warning', confidence: clamp01((Math.max(m.ratio, 1 / m.ratio) - 1.2) / 1.2),
          title: 'Vibration changes with the gear → engine rpm related',
          detail: `At the same road speed in a lower gear the vibration is ${m.ratio.toFixed(1)}× the normal level. Road speed was the same, so the difference ` +
            'comes from engine speed: engine balance or misfire, flywheel/clutch, engine mounts, or exhaust resonance.' });
      } else {
        t.note += ' (engine rpm not the cause)';
      }
    } else {
      t.note = 'no matching cruise at that speed';
    }
  }
  if (byId.brake) {
    const bw = W.filter(w => w.test === 'brake' && w.state === 'braking').length;
    byId.brake.note = bw ? `${bw} braking windows` : 'no firm braking detected';
  }
  if (byId.cruise) byId.cruise.note = Number.isFinite(byId.cruise.speed) ? `${Math.round(byId.cruise.speed * 3.6)} km/h reference` : 'no GPS speed';

  return { results, findings };
}
