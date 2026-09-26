// Synthetic drive for the demo and for testing the analysis: a car with an
// unbalanced front wheel (resonating near 100 km/h), brake judder, a worn right
// wheel bearing (rougher in left corners) and a smooth idle.
import { MS, GS } from './format.js';
import { vehicleCircumference } from './analysis.js';

// Speed profile: [time s, speed km/h] keyframes, linearly interpolated.
const PROFILE = [
  [0, 0], [100, 0],                     // parked baseline tests
  [125, 50], [190, 50], [225, 110], [350, 110], [358, 70],
  [420, 70], [445, 130], [530, 130], [540, 95], [600, 95],
  [620, 80],                            // coast in neutral
  [635, 0], [665, 0],                   // braking test, then stop
  // car park: pull away at full lock, twice each way
  [671, 14], [679, 14], [683, 0], [687, 0], [693, 14], [701, 14], [705, 0], [715, 0],
];

// Steering-wheel angle keyframes [time s, degrees, + = left].
const STEER = [
  [0, 0], [135, 0], [138, 40], [148, 40], [151, 0], [160, 0], [163, -40], [173, -40], [176, 0],
  [240, 0], [243, 7], [261, 7], [264, 0], [270, 0], [273, -7], [291, -7], [294, 0],
  [300, 0], [303, 7], [321, 7], [324, 0], [328, 0], [331, -7], [346, -7], [349, 0],
  [665, 0], [668, 420], [681, 420], [684, 0], [687, 0], [690, -420], [703, -420], [706, 0], [715, 0],
];

// Guided tests performed during the demo drive [id, start s, end s].
const SEGMENTS = [
  ['engine_off', 0, 15], ['tap', 18, 28], ['idle', 35, 55], ['idle_drive', 60, 75],
  ['cruise', 575, 598], ['coast', 600, 619], ['brake', 620, 636],
];
const ENGINE_START = 32, TAP_HZ = 14, IN_GEAR = [60, 75];

const lerp = (keys, t, scale = 1) => {
  for (let i = 1; i < keys.length; i++) {
    const [t1, v1] = keys[i];
    const [t0, v0] = keys[i - 1];
    if (t <= t1) return (v0 + (v1 - v0) * (t - t0) / (t1 - t0)) * scale;
  }
  return keys[keys.length - 1][1] * scale;
};
const speedAt = t => lerp(PROFILE, Math.max(0, t), 1 / 3.6);
const steerAt = t => lerp(STEER, t, Math.PI / 180);

function rng(seed) {
  let s = seed >>> 0;
  return () => {
    s = (s * 1664525 + 1013904223) >>> 0;
    return s / 4294967296;
  };
}

const STEERING_RATIO = 15, WHEELBASE = 2.65, WHEEL_TILT = 25 * Math.PI / 180;

export function simulateDrive(vehicle = {}, {
  fs = 60, seed = 7, imbalance = true, brakeJudder = true, bearing = 'right', cvJoint = false, pullDeg = 0, mountFactor = 1.2,
} = {}) {
  const rand = rng(seed);
  const gauss = () => {
    const u = Math.max(rand(), 1e-12), v = rand();
    return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
  };
  const C = vehicleCircumference(vehicle);
  const duration = PROFILE[PROFILE.length - 1][0];
  const start = Date.now() - duration * 1000;
  const motion = [], gps = [];
  let wheelPhase = 0, enginePhase = 0, t = 0, lastGps = -1;
  let lat = 45.0, lon = 9.0, heading = 0, prevWheel = 0;
  const G = 9.81 * Math.cos(WHEEL_TILT), Gz = 9.81 * Math.sin(WHEEL_TILT);
  const pull = pullDeg * Math.PI / 180;
  while (t < duration) {
    const v = speedAt(t);
    const aLong = speedAt(t + 0.5) - speedAt(t - 0.5);
    const braking = speedAt(t + 1) - v < -1.2;
    const theta = steerAt(t);                  // effective steering (drives the car)
    const wheel = theta + (v > 3 ? pull : 0);  // actual wheel position (a pulling car needs a held offset)
    const yaw = v * Math.tan(theta / STEERING_RATIO) / WHEELBASE; // rad/s, + = left
    const aLat = v * yaw;
    const fw = v / C;
    const dt = (1 / fs) * (0.9 + 0.2 * rand());
    wheelPhase += 2 * Math.PI * fw * dt;
    enginePhase += 2 * Math.PI * 26 * dt; // ~780 rpm 4-cyl firing frequency
    heading -= yaw * dt;                   // compass heading is clockwise
    lat += v * Math.cos(heading) * dt / 111320;
    lon += v * Math.sin(heading) * dt / (111320 * Math.cos(lat * Math.PI / 180));

    // Unbalanced wheel: grows with speed², amplified by a steering resonance at ~100 km/h.
    const res = 1 + 2.5 * Math.exp(-((((v * 3.6) - 100) / 12) ** 2));
    let imb = imbalance ? 0.0045 * v * v / 100 * res * 10 : 0;
    if (braking && brakeJudder) imb += 0.35;
    const o1 = imb * Math.sin(wheelPhase);
    let road = 0.04 + 0.004 * v;
    // Worn bearing: rumble grows when the car leans onto it.
    const load = bearing === 'right' ? aLat : bearing === 'left' ? -aLat : 0;
    if (bearing && v > 5) road += 0.005 * v * Math.max(0, load);
    if (cvJoint && Math.abs(theta) > 1.5 && aLong > 0.3) road += 0.35;
    let eng = t < ENGINE_START ? 0 : (v < 0.5 ? 0.05 : 0.02) * Math.sin(enginePhase);
    if (t >= IN_GEAR[0] && t < IN_GEAR[1]) eng *= mountFactor;       // healthy mounts: small rise in gear
    if (v < 0.5) road = t < ENGINE_START ? 0.008 : 0.015;          // parked: sensor noise, cabin fan
    // Tap test: a knock each second rings the column/mount at TAP_HZ.
    if (t >= 18 && t < 28) {
      const since = t - Math.floor(t);
      eng += 1.5 * Math.exp(-since / 0.25) * Math.sin(2 * Math.PI * TAP_HZ * since);
    }

    // In-plane specific force in wheel coordinates: (x = right, y = up the rim).
    const ux = -aLat + road * gauss() + 0.6 * o1 + eng;
    const uy = G + aLong * Math.sin(WHEEL_TILT) + road * gauss() + 0.9 * o1 + 0.7 * eng;
    const lz = -aLong * Math.cos(WHEEL_TILT) + 0.3 * o1 + road * gauss(); // screen normal faces back-up
    // Rotate into the phone frame (phone turns with the wheel, CCW = left).
    const c = Math.cos(wheel), s = Math.sin(wheel);
    const px = ux * c + uy * s, py = -ux * s + uy * c;
    const lx = px - G * s, ly = py - G * c;
    const steerRate = (wheel - prevWheel) / dt * 180 / Math.PI;
    prevWheel = wheel;
    const rotA = steerRate + 6 * o1 + 0.3 * gauss(); // steering rotation + shimmy (deg/s)
    motion.push(start + t * 1000, px, py, Gz + lz, lx, ly, lz, rotA, 0.4 * gauss(), 0.4 * gauss());

    if (Math.floor(t) !== lastGps) {
      lastGps = Math.floor(t);
      const hdg = ((heading * 180 / Math.PI) % 360 + 360) % 360;
      gps.push(start + lastGps * 1000 + 150, lat + 2e-6 * gauss(), lon + 2e-6 * gauss(), 4 + 2 * rand(),
        Math.max(0, v + 0.15 * gauss()), v > 1 ? hdg : NaN, 120);
    }
    t += dt;
  }
  return {
    meta: {
      id: `demo-${start}`, name: 'Demo drive (synthetic)', startedAt: start, demo: true,
      vehicle, samples: motion.length / MS, gpsFixes: gps.length / GS, durationMs: duration * 1000,
      steerCal: [start + 15 * 1000], markers: 1,
      segments: SEGMENTS.map(([id, a, b]) => ({ id, t0: start + a * 1000, t1: start + b * 1000 })),
    },
    motion, gps, markers: [start + 290 * 1000],
  };
}
