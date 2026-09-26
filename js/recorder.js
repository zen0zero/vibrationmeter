// Sensor capture: devicemotion (3-axis accel + gyro) and GPS, each sample
// timestamped in epoch milliseconds, flushed to IndexedDB every couple of seconds.
import { appendChunk, saveSession, requestPersistence } from './storage.js';
import { MS } from './format.js';

const FLUSH_MS = 2000;
const LIVE_LEN = 512;

const nz = v => (v === null || v === undefined ? NaN : v);

export class Recorder {
  constructor(onStatus) {
    this.onStatus = onStatus || (() => {});
    this.active = false;
    this.live = { t: [], x: [], y: [], z: [], rot: [] };
    this.lastFix = null;
  }

  static async requestPermissions() {
    // iOS needs an explicit permission prompt from a user gesture; Android does not.
    if (typeof DeviceMotionEvent !== 'undefined' && typeof DeviceMotionEvent.requestPermission === 'function') {
      const r = await DeviceMotionEvent.requestPermission();
      if (r !== 'granted') throw new Error('Motion sensor permission denied');
    }
  }

  async start(meta) {
    if (this.active) return;
    if (!window.isSecureContext) throw new Error('Sensors need HTTPS (or localhost). Open the app over https://');
    if (typeof DeviceMotionEvent === 'undefined') throw new Error('This browser has no motion sensor support.');
    await Recorder.requestPermissions();
    requestPersistence();

    const startedAt = Date.now();
    this.meta = {
      id: `rec-${startedAt}`, startedAt, name: meta.name || new Date(startedAt).toLocaleString(),
      vehicle: meta.vehicle, notes: meta.notes || '', userAgent: navigator.userAgent,
      samples: 0, gpsFixes: 0, markers: 0, durationMs: 0, interval: null,
    };
    this.buf = { motion: [], gps: [], marker: [] };
    this.seq = 0;
    this.counts = { motion: 0, gps: 0 };
    this.firstT = null; this.lastT = null;
    this.live = { t: [], x: [], y: [], z: [], rot: [] };
    this.lastFix = null;
    this.gpsError = null;
    this.active = true;
    await saveSession(this.meta);

    this.onMotion = e => this.handleMotion(e);
    window.addEventListener('devicemotion', this.onMotion);

    if ('geolocation' in navigator) {
      this.watchId = navigator.geolocation.watchPosition(
        p => this.handleFix(p),
        err => { this.gpsError = err.message || 'GPS error'; this.onStatus(); },
        { enableHighAccuracy: true, maximumAge: 0, timeout: 20000 });
    } else {
      this.gpsError = 'No geolocation support';
    }

    await this.acquireWakeLock();
    this.onVisibility = () => {
      if (document.visibilityState === 'visible' && this.active) this.acquireWakeLock();
    };
    document.addEventListener('visibilitychange', this.onVisibility);
    this.flushTimer = setInterval(() => this.flush(), FLUSH_MS);

    this.noDataTimer = setTimeout(() => {
      if (this.active && this.counts.motion === 0 && this.buf.motion.length === 0) {
        this.sensorError = 'No accelerometer data received. The phone may not expose motion sensors to the browser, or the permission was blocked (Site settings → Motion sensors).';
        this.onStatus();
      }
    }, 2000);
  }

  async acquireWakeLock() {
    try {
      if ('wakeLock' in navigator) {
        this.wakeLock = await navigator.wakeLock.request('screen');
      }
    } catch (_) { /* screen may turn off; recording pauses if it does */ }
  }

  handleMotion(e) {
    if (!this.active) return;
    const g = e.accelerationIncludingGravity || {};
    const a = e.acceleration || {};
    const r = e.rotationRate || {};
    // Event timestamp is relative to the page time origin; convert to epoch ms.
    const t = performance.timeOrigin + e.timeStamp;
    const ax = nz(g.x), ay = nz(g.y), az = nz(g.z);
    if (!Number.isFinite(ax) && !Number.isFinite(nz(a.x))) return;
    this.buf.motion.push(t, ax, ay, az, nz(a.x), nz(a.y), nz(a.z), nz(r.alpha), nz(r.beta), nz(r.gamma));
    if (this.firstT === null) { this.firstT = t; this.meta.interval = e.interval; }
    this.lastT = t;
    const L = this.live;
    L.t.push(t); L.x.push(ax); L.y.push(ay); L.z.push(az); L.rot.push(nz(r.alpha));
    if (L.t.length > LIVE_LEN) { L.t.shift(); L.x.shift(); L.y.shift(); L.z.shift(); L.rot.shift(); }
  }

  handleFix(p) {
    if (!this.active) return;
    const c = p.coords;
    this.buf.gps.push(p.timestamp, c.latitude, c.longitude, nz(c.accuracy), nz(c.speed), nz(c.heading), nz(c.altitude));
    this.lastFix = { t: p.timestamp, speed: nz(c.speed), acc: c.accuracy, received: Date.now() };
    this.gpsError = null;
    this.onStatus();
  }

  mark() {
    if (!this.active) return;
    const t = Date.now();
    this.buf.marker.push(t);
    this.meta.markers++;
    return t;
  }

  async flush() {
    const jobs = [];
    for (const kind of ['motion', 'gps', 'marker']) {
      const data = this.buf[kind];
      if (!data.length) continue;
      this.buf[kind] = [];
      if (kind === 'motion') this.counts.motion += data.length / MS;
      if (kind === 'gps') this.counts.gps += data.length / 7;
      jobs.push(appendChunk(this.meta.id, this.seq++, kind, data));
    }
    this.meta.samples = this.counts.motion;
    this.meta.gpsFixes = this.counts.gps;
    this.meta.durationMs = this.lastT && this.firstT ? this.lastT - this.firstT : 0;
    jobs.push(saveSession(this.meta));
    try { await Promise.all(jobs); } catch (err) { this.storageError = err.message; }
    this.onStatus();
  }

  get rate() {
    const t = this.live.t;
    if (t.length < 10) return NaN;
    return (t.length - 1) / ((t[t.length - 1] - t[0]) / 1000);
  }

  get elapsedMs() {
    return this.active ? Date.now() - this.meta.startedAt : 0;
  }

  get sampleCount() {
    return this.counts ? this.counts.motion + this.buf.motion.length / MS : 0;
  }

  async stop() {
    if (!this.active) return null;
    this.active = false;
    window.removeEventListener('devicemotion', this.onMotion);
    if (this.watchId !== undefined) navigator.geolocation.clearWatch(this.watchId);
    clearInterval(this.flushTimer);
    clearTimeout(this.noDataTimer);
    document.removeEventListener('visibilitychange', this.onVisibility);
    try { await this.wakeLock?.release(); } catch (_) { /* ignore */ }
    this.wakeLock = null;
    this.meta.endedAt = Date.now();
    await this.flush();
    return this.meta;
  }
}
