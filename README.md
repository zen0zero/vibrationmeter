# Vibration Meter

A single-page web app for an Android phone mounted on the steering wheel. It records
3-axis acceleration, rotation rate and GPS speed. Every sample gets a timestamp.
It then attributes the vibration to a probable cause.

No build step and no dependencies: plain HTML, CSS and ES modules. The app works
offline once loaded, and you can install it to the home screen (PWA).

## Running it

Browsers only expose motion sensors and GPS on **HTTPS** (or `localhost`).

- **GitHub Pages:** in the repository settings, go to *Pages* and deploy from the branch, root folder.
  Then open `https://<user>.github.io/vibrationmeter/` in Chrome on the phone and choose
  *Add to Home screen*.
- **Local test:** `python3 -m http.server 8000` and open `http://localhost:8000`. To reach
  it from the phone over HTTPS, use a tunnel (for example `cloudflared` or `ngrok`) or
  Chrome remote-debugging port forwarding.

## Using it

1. **Vehicle** tab: enter the tire size (e.g. `205/55R16`). Final drive ratio and cylinder count are optional.
2. Mount the phone rigidly on the wheel rim with the screen facing you, and press **Start recording** before driving.
   With the car parked and the wheels straight, tap **Set steering centre**.
   The screen is kept awake with the Wake Lock API. Android pauses sensors when the screen is off or the app is in the background.
3. Drive the pattern that produces the vibration. Include some standstill time with the engine running,
   steady speeds held for 20 s or more across the range, some firm stops and some strong accelerations. A passenger can tap **Mark**.
   For wheel bearings, drive long curves in both directions at 50–100 km/h. For CV joints, pull away at full lock both ways in an empty car park.
4. **Recordings** tab: analyze, export **CSV** (one row per sample) or **JSON** (raw streams, re-importable), or delete a recording.
   You can also import a CSV or JSON file, for example on a laptop, or load a synthetic **demo drive**.

Recordings are written to IndexedDB every 2 s while recording. A crash or closed tab loses at most a couple of seconds.

## Data format (CSV)

| column | meaning |
|---|---|
| `timestamp_ms` | epoch milliseconds (sub-ms resolution, from the sensor event time) |
| `elapsed_s` | seconds since the first sample |
| `acc_x/y/z` | acceleration including gravity, m/s², phone axes |
| `lin_x/y/z` | acceleration without gravity (if the phone provides it), m/s² |
| `rot_alpha/beta/gamma` | rotation rate, deg/s (alpha = around the screen normal = steering rotation) |
| `speed_kmh` | GPS speed interpolated to the sample time |
| `lat`, `lon`, `gps_accuracy_m` | last GPS fix |
| `gps_age_ms` | how old that fix is at this sample |
| `steering_deg` | estimated steering-wheel angle, degrees, + = left (can exceed ±180° at full lock) |
| `lateral_acc` | cornering acceleration, m/s², + = car accelerating to the left |
| `longitudinal_acc` | acceleration (+) / braking (−), m/s² |
| `marker` | `1` where the Mark button was pressed, `C` where the steering centre was set |

The last three are derived when exporting, so older recordings get them too.

The JSON export keeps the unmodified GPS fixes (1 Hz, with their own timestamps) next to the motion samples.

## Steering angle and cornering g

The phone turns with the wheel. Because the rim is tilted, gravity's direction across the screen rotates by
the same angle: `atan2(acc_x, acc_y)`.

- **Gyro fusion.** The gyro's rotation around the screen normal follows fast steering movements.
  Gravity removes the gyro's drift slowly. The result is unwrapped, so full lock (±400° and beyond) is tracked.
- **Cornering g.** Once the wheel angle is known, the part of the accelerometer reading across the rim is the car's
  sideways acceleration. It has no lag and is cross-checked against GPS (speed × heading change).
  GPS is the fallback when there is no gyro.
- **Braking/acceleration g.** This is read from the axis perpendicular to the screen. Its scale and sign are calibrated
  by regression against the GPS speed change.
- **Zero.** The zero is the **Set steering centre** tap. Without that tap, it is the average angle while driving straight,
  judged by a constant GPS heading.

## How the analysis works

1. Motion samples are resampled onto a uniform grid. Gravity and steering movements are removed with a 0.4 s high-pass.
2. The drive is cut into ~4 s windows (50 % overlap). Each window gets a power spectrum, a mean GPS speed, a state
   (standstill, steady, accelerating, braking or varying, from braking/acceleration g) and a corner direction
   (left, straight or right, from cornering g).
3. **Order tracking.** Wheel rotation frequency is `speed / tire circumference`. Each window's spectrum is re-plotted
   against multiples of that frequency ("orders") and averaged. A vibration caused by the wheels lines up at the same order at every speed.
   Anything else smears out. Straight-line windows are used when there are enough of them.
4. Heuristics then look for these patterns:

| pattern | probable cause |
|---|---|
| peak at 1× wheel order | wheel imbalance, bent rim, tire belt, hub/bearing run-out. Also seen in steering rotation → front wheels |
| peak at 2× wheel order | out-of-round / flat-spotted tire, radial force variation |
| peak at final-drive-ratio order | propshaft, U-joints, centre bearing |
| 3× order only under acceleration | worn inner (tripod) CV joint |
| stronger only under acceleration | drivetrain: CV joints, engine/gearbox mounts |
| stronger only while braking (often 1× order) | brake disc thickness variation, sticking calipers |
| vibration at standstill | engine, mounts, misfire, A/C compressor |
| fixed frequency at all speeds | structural resonance, phone mount, or rpm-related |
| hump in one speed band | imbalance exciting a suspension/steering resonance |
| stronger in left corners only (or right only) | wheel bearing on the loaded side: left corners load the right wheels |
| stronger in all corners | suspension bushings, CV joints, cupped tires |
| stronger at > 90° steering while pulling away | outer CV joint |
| wheel held off-centre to drive straight (needs centre calibration) | alignment, tire pressure, sticking caliper, pulling tire |
| steering shake only on-centre (disappears in corners) | play in tie-rod ends or rack, plus imbalance |

The charts show speed, vibration over time (braking and acceleration shaded, marks shown as ★),
steering angle, vibration by corner direction, a spectrogram with 1×/2× wheel-order lines, a frequency-vs-speed (Campbell) map, the wheel-order spectrum,
and vibration per speed band.

## Limitations

- Android Chrome delivers `devicemotion` at about **60 Hz**, so only frequencies up to about 30 Hz can be measured.
  That covers wheel orders (about 5–20 Hz at road speeds) and brake judder. It does not cover engine firing frequency while driving.
  Higher frequencies can alias.
- GPS speed updates about once per second and lags slightly. Order analysis therefore uses steady-speed windows primarily.
- Steering angle needs the wheel rim to be tilted (normal cars: 20–30°). Cornering g at walking pace is approximate.
  GPS cannot correct it at that speed, but the full-lock angle itself stays accurate.
- In a fixed gear, engine rpm is also proportional to road speed. To separate engine from wheel causes, repeat a run
  at the same speed in a different gear.
- Results are heuristic. Use them to guide inspection, not as a verdict.

## Files

```
index.html            UI shell
css/style.css         styles (light and dark)
js/app.js             UI controller
js/recorder.js        devicemotion + geolocation capture, wake lock, chunked saving
js/storage.js         IndexedDB
js/format.js          data layout, CSV/JSON export and import, GPS↔sample alignment
js/analysis.js        FFT, order tracking, diagnosis heuristics
js/steering.js        steering angle, cornering and braking g from gravity + gyro + GPS
js/charts.js          canvas charts with touch tooltips
js/sim.js             synthetic demo drive (imbalance, brake judder, right wheel bearing)
sw.js                 offline cache
```
