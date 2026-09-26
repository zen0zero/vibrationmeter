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
| `test` | guided test running at that sample (`engine_off`, `tap`, `idle`, `coast`, …) |

The last three are derived when exporting, so older recordings get them too.

The JSON export keeps the unmodified GPS fixes (1 Hz, with their own timestamps) next to the motion samples.

## Guided tests

The **Record** tab has a guided-test list. A test records a labelled stretch under known conditions and starts the recording if needed.
Parked tests are timed, with a countdown and beeps so your hands can stay off the wheel. Driving tests are started and ended by a passenger.
You don't enter the speed where it vibrates: the analysis finds the worst speed band and judges the driving tests there.
Tests that don't apply to the car are hidden, based on the **Gearbox** setting in Vehicle.

| test | conditions | what it tells the analysis |
|---|---|---|
| Engine off | parked, wheels straight, hands off (15 s) | sensor noise floor, loose mount; sets the steering centre |
| Tap test | tap the rim once a second (10 s) | ringing frequency of steering column + mount; explains speed-band humps and fixed-frequency peaks |
| Idle | neutral, A/C off (20 s) | engine baseline; idle rpm from a comb over half/crank/firing orders; uneven running (misfire) |
| Idle with A/C on | (20 s, optional) | mounts / idle speed control / compressor, if vibration rises |
| In gear, brake held | automatics only (15 s, optional) | engine/gearbox mounts, if vibration rises well above idle |
| Rev steps | hold 1500 / 2000 / 2500 / 3000 rpm, 12 s each (optional) | vibration by rpm, resonance at one rpm, where each engine frequency lands after fold-back, and the neutral run-up verdict |
| Slow rev | to ~3000 rpm and back (30 s, optional) | resonances between the steps |
| Lock-to-lock | full left → full right (25 s, optional) | steering range; unequal left/right = wheel off-centre on the rack; shudder at lock |
| Speed steps | hold 30, 50, 70 … 130 km/h, ~15 s each | steady data over the whole range, to find the worst band |
| Coast in neutral | from the top speed down to ~40 km/h | at the worst band: unchanged → wheels/tires/brakes/bearings; disappears → engine or drivetrain under load |
| One gear lower | several speeds (optional) | changes → engine-rpm related |
| Pull away | manual only: from standstill in 1st, three times (optional) | clutch judder, flywheel, engine/gearbox mounts |
| Braking | firm, 90 → 20 km/h, twice (optional) | repeatable brake-judder data |

**Repeating tests.** Every run is saved. Runs of the same test in a recording are pooled: their spectra are averaged,
weighted by length. With three or more runs, one that is more than 40 % off the median is discarded.
The table shows the run count and spread, and the app warns when repeated parked runs disagree.
That usually means the radiator fan or A/C cycled, or the engine was still cold.

**Engine frequencies and the 60 Hz limit.** A 4-cylinder fires twice per crank turn. That is about 26 Hz at idle, which is measurable,
but 50–100 Hz at 1500–3000 rpm, which is above the ~30 Hz limit. Those vibrations fold back to a lower frequency: at 2000 rpm, 67 Hz shows up at ~7 Hz.
At a known rpm the fold-back is predictable, so the rev-step analysis labels such peaks as engine.
A fixed-frequency peak while driving that sits on one of these folded engine lines is reported as probably engine-related.

**Neutral run-up without knowing the driving rpm.** If the parked engine stays well below the vibration of the worst driving speed band at
every rev step, the engine is ruled out as the main source. If one step matches the driving level, the engine can explain it.

For the level-based comparisons (A/C, in gear), the app uses the larger of two ratios against idle: overall vibration, and vibration at the idle firing frequency.
Coast and gear tests are compared with steady driving at the same speed (±6 km/h), within the worst band when the test reached it.
Results appear in a **Guided tests** table in the Analysis tab and as findings.
The CSV `test` column records which test each sample belongs to (`rev_2000`, `coast`, …).

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
js/tests.js           guided test definitions and their analysis
js/steering.js        steering angle, cornering and braking g from gravity + gyro + GPS
js/charts.js          canvas charts with touch tooltips
js/sim.js             synthetic demo drive (baseline and rev steps, imbalance, brake judder, right wheel bearing, neutral coast)
sw.js                 offline cache
```
