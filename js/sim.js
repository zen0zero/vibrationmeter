// Synthetic drive for the demo and for testing the analysis: a car with an
// unbalanced front wheel (resonating near 100 km/h), brake judder and a smooth idle.
import { MS, GS } from './format.js';
import { vehicleCircumference } from './analysis.js';

// Speed profile: [time s, speed km/h] keyframes, linearly interpolated.
const PROFILE = [
  [0, 0], [40, 0], [65, 50], [130, 50], [165, 110], [290, 110], [298, 70],
  [360, 70], [385, 130], [470, 130], [480, 95], [540, 95], [560, 0], [600, 0],
];

function speedAt(t) {
  for (let i = 1; i < PROFILE.length; i++) {
    const [t1, v1] = PROFILE[i];
    const [t0, v0] = PROFILE[i - 1];
    if (t <= t1) return (v0 + (v1 - v0) * (t - t0) / (t1 - t0)) / 3.6;
  }
  return 0;
}

function rng(seed) {
  let s = seed >>> 0;
  return () => {
    s = (s * 1664525 + 1013904223) >>> 0;
    return s / 4294967296;
  };
}

export function simulateDrive(vehicle = {}, { fs = 60, seed = 7, imbalance = true, brakeJudder = true } = {}) {
  const rand = rng(seed);
  const gauss = () => {
    const u = Math.max(rand(), 1e-12), v = rand();
    return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
  };
  const C = vehicleCircumference(vehicle);
  const duration = PROFILE[PROFILE.length - 1][0];
  const start = Date.now() - duration * 1000;
  const motion = [], gps = [];
  let wheelPhase = 0, enginePhase = 0, t = 0, lastGps = -1, lat = 45.0, lon = 9.0;
  while (t < duration) {
    const v = speedAt(t);
    const vNext = speedAt(t + 1);
    const braking = vNext - v < -1.2;
    const fw = v / C;
    const dt = (1 / fs) * (0.9 + 0.2 * rand());
    wheelPhase += 2 * Math.PI * fw * dt;
    enginePhase += 2 * Math.PI * 26 * dt; // ~780 rpm 4-cyl firing frequency

    // Unbalanced wheel: grows with speed², amplified by a steering resonance at ~100 km/h.
    const res = 1 + 2.5 * Math.exp(-((((v * 3.6) - 100) / 12) ** 2));
    let imb = imbalance ? 0.0045 * v * v / 100 * res * 10 : 0;
    if (braking && brakeJudder) imb += 0.35;
    const o1 = imb * Math.sin(wheelPhase);
    const road = 0.04 + 0.004 * v;
    const eng = (v < 0.5 ? 0.05 : 0.02) * Math.sin(enginePhase);

    // Steering angle wanders slowly, rotating gravity in the phone frame.
    const steer = 0.25 * Math.sin(2 * Math.PI * 0.03 * t) + 0.05 * Math.sin(2 * Math.PI * 0.2 * t);
    const gx = 9.81 * Math.sin(steer), gy = 9.81 * Math.cos(steer) * 0.94, gz = 9.81 * 0.34;

    const lx = 0.6 * o1 + road * gauss() + eng;
    const ly = 0.9 * o1 + road * gauss() + 0.7 * eng;
    const lz = 0.3 * o1 + road * gauss();
    const rotA = 6 * o1 + 0.3 * gauss(); // steering shimmy (deg/s)
    motion.push(start + t * 1000, gx + lx, gy + ly, gz + lz, lx, ly, lz,
      rotA, 0.4 * gauss(), 0.4 * gauss());

    if (Math.floor(t) !== lastGps) {
      lastGps = Math.floor(t);
      lat += v / 111320;
      gps.push(start + lastGps * 1000 + 150, lat, lon, 4 + 2 * rand(), Math.max(0, v + 0.15 * gauss()), 0, 120);
    }
    t += dt;
  }
  return {
    meta: {
      id: `demo-${start}`, name: 'Demo drive (synthetic)', startedAt: start, demo: true,
      vehicle, samples: motion.length / MS, gpsFixes: gps.length / GS, durationMs: duration * 1000,
    },
    motion, gps, markers: [start + 230 * 1000],
  };
}
