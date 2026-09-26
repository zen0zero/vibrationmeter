// Synthetic drive for the demo and for testing the analysis: a car with an
// unbalanced front wheel (resonating near 100 km/h), brake judder, a worn right
// wheel bearing (rougher in left corners) and a smooth idle.
import { MS, GS } from './format.js';
import { vehicleCircumference } from './analysis.js';

// Speed profile: [time s, speed km/h] keyframes, linearly interpolated.
const PROFILE = [
  [0, 0], [40, 0], [65, 50], [130, 50], [165, 110], [290, 110], [298, 70],
  [360, 70], [385, 130], [470, 130], [480, 95], [540, 95], [560, 0], [590, 0],
  // car park: pull away at full lock, twice each way
  [596, 14], [604, 14], [608, 0], [612, 0], [618, 14], [626, 14], [630, 0], [640, 0],
];

// Steering-wheel angle keyframes [time s, degrees, + = left].
const STEER = [
  [0, 0], [75, 0], [78, 40], [88, 40], [91, 0], [100, 0], [103, -40], [113, -40], [116, 0],
  [180, 0], [183, 7], [201, 7], [204, 0], [210, 0], [213, -7], [231, -7], [234, 0],
  [240, 0], [243, 7], [261, 7], [264, 0], [268, 0], [271, -7], [286, -7], [289, 0],
  [590, 0], [593, 420], [606, 420], [609, 0], [612, 0], [615, -420], [628, -420], [631, 0], [640, 0],
];

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
  fs = 60, seed = 7, imbalance = true, brakeJudder = true, bearing = 'right', cvJoint = false, pullDeg = 0,
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
    const eng = (v < 0.5 ? 0.05 : 0.02) * Math.sin(enginePhase);

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
      steerCal: [start + 20 * 1000], markers: 1,
    },
    motion, gps, markers: [start + 230 * 1000],
  };
}
