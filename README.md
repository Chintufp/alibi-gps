# Alibi – where am I, really?

**GPS is just one witness.** Alibi asks other witnesses where you are (landmarks, the stars, cell
towers, your own steps, you yourself, and the map) and shows where they agree. If one witness disagrees
with all the others, it is probably lying, and Alibi ignores it.

Made for the *When GPS fails / Kun GPS katoaa* challenge (Tampere University, ESA BIC Finland).
Main user in the demo: a hiker in Lapland near the Russian border. The same app has Walk, Drive and Boat modes.

---

## Run it

**On a laptop:** open a terminal in this `alibi` folder and run

```bash
python -m http.server 8765
```

then open <http://localhost:8765>. Add `?demo` to the address to jump straight into the Lapland demo.

**On a phone:** phones only give a web page the compass, camera and GPS over **HTTPS**, so put the folder
online first. The easiest free way is GitHub Pages:

1. Make a new public repository on github.com and upload the files from this `alibi` folder (keep the folders).
2. In the repository: **Settings → Pages → Branch: main → Save**.
3. After a minute the app is at `https://<your-name>.github.io/<repo-name>/`.

It works on Android Chrome and iPhone Safari (iPhone asks for motion permission when you first aim).

---

## The Lapland demo (use this for the video)

Click **🎬 Lapland demo**, then **Next** (or the → key). Real map data, simulated measurements:

| # | What happens | Light |
|---|---|---|
| 1 | Aino starts at Kiilopää fell centre. GPS + "I'm at the fell centre" agree. | 🟢 |
| 2 | She walks 2 km. Steps + compass carry her last good position along; GPS agrees. | 🟢 |
| 3 | A spoofer slowly drags GPS 650 m off. **Two** witnesses disagree: something is wrong, but who? | 🔴 |
| 4 | A distant cell mast (simulated) fits both, so it still can't tell. Alibi says so honestly. | 🔴 |
| 5 | She aims at **Kiilopää** fell top. Three witnesses outvote GPS, so GPS is ignored. | 🟡 |
| 6 | She aims at **Ahopäät**. The lines cross where her steps say: ±139 m. | 🟢 |
| 7 | Night: GPS says **Murmansk**, 216 km away. Polaris and Vega agree with her steps, not GPS. | 🟡 |
| 8 | Fog and jamming: only steps are left, so the uncertainty grows. The **map rule** cuts out the lake. | 🟡 |
| 9 | The fog lifts: hut + two fell tops. Safe arrival. | 🟢 |

The "Aino (the truth)" marker is only there for the audience; Alibi never sees it.

---

## Live mode (on a real phone)

| Button | What it does | Real or simulated |
|---|---|---|
| 🛰️ GPS | Uses your phone's GPS as one witness | real |
| 📍 I'm about here | Tap the map where you think you are (±200 m / 1 km / 5 km) | real |
| 🗼 Landmark | Loads towers, churches, chimneys and hill tops from OpenStreetMap. Tap one, put the camera's red cross on it and press 📸. Check the reading, then **Add witness**. The compass draws a line. You can also mark a landmark yourself. | real |
| ✨ Sky | Pick the Sun or a bright star, aim at it and press 📸. Its height above the horizon puts you on a band on the map. | real |
| 📡 Cell towers | Browsers can't read cell towers, so this uses real mast positions and makes up what a phone would hear | simulated |
| 😈 Spoof GPS | Simulates an attack: first a slow drag (3 m/s), then a 120 km jump. The grey dot is your real GPS. | simulated |

**Check every reading before it counts.** After 📸 you see the photo and the reading, and you can:
- nudge it (±1°, ±0.1°) or type a better value;
- switch to **🧭 Hand compass** and type what your compass shows. It is a magnetic reading, so Alibi adds the
  declination (e.g. +10.6° in Tampere) for you. For the Sun or stars, switch to **📐 Inclinometer / sextant**;
- set **how sure** you are (± degrees). The defaults are phone compass ±7°, ±4° after calibration, hand
  compass ±3°, phone tilt ±1°, inclinometer ±0.4°. Bigger ± makes the line wider and the witness count less.

**No phone? Use the simulated view.** On a laptop, or a phone without a compass, the aiming screen shows a
**🎮 simulated view** built from the map. You see the real landmarks around you, and the Sun and stars where
they really are right now. Drag it (or use the arrow keys, Shift for 0.1°) to put the target under the red
cross, then press 📸 (or Enter). The button at the top right switches between it and the real camera. The
Lapland demo uses the same pictures for its witnesses.

**Tips for a live demo**
- Calibrate the compass first: while GPS is good, aim at a landmark and tick *"Use this to calibrate my phone compass"*.
- Aim at landmarks in different directions (about 60–120° apart). Alibi suggests the best next one (👉).
- Landmarks for central **Tampere** and **Helsinki** are built in, so they load instantly. Anywhere else they
  come from the public Overpass servers, which can be slow (20 s or more) or busy.
- ⚙️ Settings: safety limit, extra compass correction, step counting (carries witnesses along as you walk).

---

## How it works (in plain words)

1. **Every witness draws a shape.** GPS, your guess and your steps are circles. A landmark gives a line,
   because you are somewhere along the line you aimed along. A cell tower gives a ring. A star gives a band:
   everywhere on Earth where that star is at that height right now.
2. **Where the shapes overlap is where you are.** Alibi lays a grid over the map and multiplies the shapes
   (a Bayesian grid filter), zooming in step by step. The orange glow is the result. The dashed circle holds
   95 % of it, and that radius is the **± number**.
3. **Catching the liar.** For each witness Alibi predicts what it *should* say from all the other witnesses.
   If it is far outside what they allow (less than 0.1 % likely), it fails. Alibi then looks for the one
   witness whose removal makes everyone else agree, and ignores it. This is the idea behind receiver
   integrity monitoring (RAIM fault detection and exclusion), applied to whole positioning sources:
   - 2 witnesses that disagree → you know something is wrong, but not who (🔴).
   - 3 or more → you can usually find the liar.
4. **Trust light and safety limit.** 🟢 means the ± radius is inside the safety limit for the mode
   (Walk 150 m, Drive 50 m, Boat 100 m). 🟡 means up to 10× that: slow down and add a witness. 🔴 means the
   witnesses disagree with no way to tell who is lying, or the position is far too uncertain.
5. **Extra checks.** A GPS jump faster than you can move is flagged at once. The **map rule** (walkers aren't
   in lakes, cars stay on roads, boats stay on water) uses OpenStreetMap. It only makes those places very
   unlikely, not impossible, because people do walk on frozen lakes.

**Compass:** Finland's magnetic declination (about +9.5° in the south to +15.5° in Lapland in 2026, from
the World Magnetic Model) is added automatically.
**Stars:** positions come from a star catalogue (J2000, corrected for precession), and the Sun from an
almanac formula. A star's height is corrected for atmospheric refraction.

---

## Without internet

Needs no network at all: the stars and the Sun (the catalogue and maths are built in), your steps and
compass, your own guess, and the whole Lapland demo except the background map pictures.

Works offline once loaded: landmarks for central Tampere and Helsinki (built in), and any place you have
loaded landmarks for before (kept on the phone).

A real app would let you **download a region before the trip**, like offline maps in hiking apps:
background map, landmarks, lakes and roads for, say, all of Lapland (a few tens of MB), refreshed about
monthly, since towers and lakes rarely move. The National Land Survey of Finland and OpenStreetMap both
publish this data openly. The demo does not bulk-download map tiles, because the free OpenStreetMap tile
servers forbid it; a real app would host its own.

---

## Limits (say these out loud)

| Witness | Good to about | Fails when |
|---|---|---|
| GPS | 5–10 m | jammed or spoofed (that's the point) |
| Landmark line | 2–5° (≈ 50–200 m at 1–3 km) | fog or darkness, or metal near the phone confusing the compass |
| Cell tower ring | 0.5–5 km | wilderness, open sea. Base stations also use GPS timing, and jamming in Finland has hit mobile networks too. |
| Sky band | ±0.5–1° of tilt ≈ ±50–100 km | clouds. Catches big lies, but can't steer you between rocks. |
| Steps + compass | error grows ~5–10 % of the distance walked | a long time without another witness |
| Map rule | – | the map is wrong or out of date |

- A phone's tilt sensor limits star sights. A photo of the sky solved with a star-tracker program (e.g.
  ESA's open-source **tetra3**) could reach ±10–30 km. That's a next step.
- Weak signal indoors is **not** an attack. Alibi does not treat it as one; it just has fewer witnesses.
- Never use a real jammer or spoofer: it is illegal. Everything here is simulated.
- This is a demonstrator, not certified navigation equipment.

**Next steps:** a native Android app (real cell IDs, GNSS signal strength and AGC from the raw GNSS
measurements, barometer), star photos solved with tetra3, depth-sounder matching for boats, sea coastlines,
and Galileo OSNMA authentication as one more witness.

---

## Files

| File | What's in it |
|---|---|
| `index.html`, `css/style.css` | the page and its looks |
| `js/engine.js` | the core: grid, shapes, consistency tests, finding the liar, trust light |
| `js/geo.js` | distances, bearings, map projection, compass declination for Finland |
| `js/sky.js` | where the Sun and stars are |
| `js/osm.js` | OpenStreetMap: landmarks, masts, lakes and roads for the map rule |
| `js/sensors.js` | phone compass, tilt and step counter |
| `js/app.js` | map, buttons, aiming view, demo player |
| `js/scenario.js`, `js/scenario-data.js` | the Lapland demo and its trail, fells and lakes |
| `js/landmark-data.js` | built-in landmarks for central Tampere and Helsinki |

**Credits:** map data © OpenStreetMap contributors (ODbL); topo map style © OpenTopoMap (CC-BY-SA); maps
drawn with Leaflet; magnetic declination from the World Magnetic Model 2025 (via the British Geological
Survey web service).
