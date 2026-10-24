# Alibi – where am I, really?

**GPS is just one witness.** Alibi asks other witnesses where you are (landmarks you aim at, angles between
them, the stars, Wi-Fi names, your own steps, you yourself, cell towers and the map), checks every witness against all the
others, throws out the one that is lying, and tells you how far you can trust the answer: a **±** that still
holds even if one of the witnesses is lying, and a green, yellow or red light.

Made for the *When GPS fails / Kun GPS katoaa* challenge (Tampere University, ESA BIC Finland).
**Main user:** a hiker in Finnish Lapland, about 30 km from the Russian border. The same engine has Drive and Boat modes.

**Try it:** <https://chintufp.github.io/alibi-gps/> · Lapland demo: <https://chintufp.github.io/alibi-gps/?demo>

**Real or simulated?** Real: the engine and its maths, the Sun and star positions, OpenStreetMap landmarks,
the phone's camera, compass, gyroscope and step counter, Wi-Fi names you read off your phone, and the
organisers' own GPS recordings. Simulated:
cell towers (browsers can't read them), every spoofing or jamming attack, and the measurements in the
Lapland demo (made with the app's own error sizes, see `tools/check_integrity.js` for random ones).

---

## The problem, and who it is for

A phone shows a confident blue dot even when its position is wrong, and it has nothing to check it against.

- **Interference in Finland is real and growing.** Traficom said on 21 April 2026 that GNSS interference
  continued and increased in spring 2026: aircraft meet it daily over southern and central Finland, ships
  regularly in the eastern Gulf of Finland (boaters are told not to rely blindly on chart plotters and to carry a
  paper chart), and drones can be affected further inland. At ground level it is still local: very close to
  the eastern border and on the eastern Gulf coast. ([Traficom](https://traficom.fi/en/news/interference-affecting-mobile-communications-and-satellite-navigation-services-continues-finland))
- **Next door, in the border area, it reaches the ground.** In East Finnmark, Norway, GPS jamming and spoofing
  near the Russian border have been recorded for years. In March 2026 they disrupted the GPS tracking of the
  Finnmarksløpet sled-dog race, and its racers were encouraged to carry a map and compass. ([Finnmarksløpet](https://finnmarkslopet.no/2026/03/07/gnns-disturbances-affecting-finnmarkslopets-gps-tracking/))
  Finnmark police have said they depend on good GPS to find missing people in bad weather. ([Barents Observer via RCI, 2019](https://www.rcinet.ca/eye-on-the-arctic/2019/01/10/gps-jamming-norway-finnmark-russia-aircraft-search-rescue-police-signal-emergency/))
- **Getting lost in the Finnish wilds is common.** In summer 2022 Finnish police handled over 100 cases of
  lost berry pickers, 40 of them in Lapland. ([Yle](https://yle.fi/a/3-12576796))

**Our user: Aino, hiking in Urho Kekkonen National Park**, which reaches the Russian border (her trail is
about 30 km from the Raja-Jooseppi crossing). Honestly: ground-level interference is documented right across
the border in Finnmark, not yet on her trail, so we extrapolate. Her decisions depend on her position: keep
going or turn back, which way to the hut, and what position to give 112. A spoofed GPS looks perfect, so her
phone can't warn her. Map, compass and trail markers still work, but then everything rests on her alone and
nothing checks her. Alibi turns the same skills (aiming at a fell, recognising the hut) into witnesses that
check each other, and tells her when her position is checked and when it is not.

**What Alibi gives her:** one position built from everything she has, a ± she can trust even if one source is
lying, a light that tells her when to stop and add a sighting, and all of it offline once her area is saved
(only the Wi-Fi lookup needs the network). The same engine fits
boaters in the eastern Gulf of Finland (Boat mode), where interference is a regular event today.

### The light and what to do

| Light | Means | What Aino does |
|---|---|---|
| green | **checked**: the ± is inside her safety limit (Walk: 150 m) even if one witness (or one shared cause, such as one mixed-up fell or one radio attacker) is wrong, with 99 % confidence under Alibi's error sizes | carry on |
| yellow | the witnesses agree, but nothing proves the position that closely (or only one witness is left) | stay on the marked trail, slow down, add a sighting that doesn't depend on the weakest witness (Alibi names it and suggests the best landmark) |
| red | the witnesses disagree and Alibi can't tell who is lying, or even the best guess is far too uncertain | stop; don't take shortcuts or cross lakes; add sightings; if she needs help, call 112 and give the position Alibi trusts, not the raw GPS |

In a car, train or boat the words change: yellow says don't rely on it for close turns, red says don't rely
on the position until it is checked again. A normal hike with GPS and steps is mostly yellow. That's honest
(steps can't prove GPS to 150 m), and it is why yellow means "carry on carefully", not "danger".

---

## How it works (in plain words)

1. **Every witness draws a shape.** GPS, your guess and your steps are circles. A landmark you aim at gives a
   line, because you are somewhere along the line you aimed along. The angle between two landmarks gives an
   arc through both of them. A cell tower gives a ring. A Wi-Fi name gives a small circle around each place
   it could belong to. A star gives a band: everywhere on Earth where that star is at that height right now.
2. **Where the shapes overlap is where you are.** Alibi lays a grid over the map and multiplies the shapes (a
   Bayesian grid filter), zooming in step by step. The orange glow is the result. Long thin shapes, two
   crossing points, anything: no straight-line assumptions.
3. **Catching the liar.** For each witness Alibi predicts what it *should* say from all the other witnesses.
   If it is far outside that (less than 0.1 % likely), it fails. Alibi then looks for the one witness whose
   removal makes everyone else agree, and ignores it. This is the idea behind receiver integrity monitoring
   (RAIM fault detection and exclusion), applied to whole positioning sources:
   - 2 witnesses that disagree → you know something is wrong, but not who (red).
   - 3 or more → you can usually find the liar.
   - A GPS that jumps faster than you can move is thrown out at once, and a GPS caught lying stays distrusted
     for as long as it stays wrong in the same way.
4. **The ± is a protection level.** For every witness that could lie, Alibi asks: if this one were quietly
   wrong (by just too little to be caught), where could I be, according to the others alone? The ± is the
   radius around the best guess that holds 99 % of that, for the worst such witness (and for "everyone is
   honest"). This is "solution separation", as in advanced receiver integrity monitoring. So two witnesses
   that agree but can only check each other loosely give an honest, large ±. The faint inner circle shows
   where you most likely are if everyone is honest.
5. **Which witnesses could lie, and what goes wrong together.** Each kind has a rough chance of being wrong
   by more than its own ± (GPS: jammed or spoofed; a landmark or star: mixed up with another; a guess: just
   wrong; a mast: mapped in the wrong place; steps: the wrong stride, or the phone in a pocket). These are
   judgement calls (`FAULT` in `js/engine.js`), not measurements. Mistakes with one cause are one hypothesis:
   mixing up a fell spoils its compass line **and** every angle measured to it, so Alibi takes them all out
   together when it asks "what if this is wrong?". A vehicle's own dead reckoning is not treated as a liar,
   but a check on GPS that was itself started from GPS can never make the light green.
6. **Trust light and safety limit.** Green means the ± is inside the safety limit for the mode (Walk 150 m,
   chosen as roughly how far off you can still find a hut or trail marker in poor weather; Drive 50 m; Boat 100 m). Yellow
   means the best guess is usable but not checked that closely. Red means a stand-off, or even the best guess
   is far too uncertain. An honest witness can turn yellow into red, and that is on purpose: it is how a
   hidden lie comes out (demo step 4). The limit can be changed in Settings.
7. **Extra checks.** The **map rule** (walkers aren't in lakes, cars stay on roads, boats stay on lakes and
   rivers) uses OpenStreetMap. It only makes those places very unlikely, not impossible, because people do
   walk on frozen lakes.

**Compass:** Finland's magnetic declination (about +9.5° in the south to +15.5° in Lapland in 2026, from the
World Magnetic Model) is added automatically. **Stars:** positions come from a star catalogue (J2000,
corrected for precession), and the Sun from an almanac formula. A star's height is corrected for atmospheric
refraction.

---

## The Lapland demo (use this for the video)

Click **Lapland demo**, then **Next** (or the → key). Real map data. The measurements are simulated with the
app's own error sizes: phone compass ±4° after calibration, gyroscope angle ±2°, phone tilt ±1°, steps
drifting 8 % of the distance walked since the last position Alibi could vouch for.

| # | What happens | Light |
|---|---|---|
| 1 | Aino starts at Kiilopää fell centre. GPS and "I'm at the fell centre" agree: ±65 m even if one of them lied. She calibrates her compass while GPS is confirmed. | green |
| 2 | 2 km on. GPS says ±12 m, and her steps agree, but steps can only vouch for GPS to **±500 m**. | yellow |
| 3 | A spoofer slowly drags GPS 650 m off. Too little for the steps to prove a lie, but the ± grows to **1.3 km**, and the truth stays inside it. | yellow |
| 4 | She aims at **Kiilopää**. GPS doesn't fit the line, but maybe she mixed up the fell: Alibi can't tell which is wrong, and says so. | red |
| 5 | She aims at **Ahopäät**. The lines cross where her steps say: GPS is ignored. If one fell were mixed up, only ±680 m. | yellow |
| 6 | She turns from fell to fell and the **gyroscope** measures three angles between six fells: no compass, nothing magnetic to fool. GPS is proven the liar. Most likely ±67 m, but ±285 m if she mixed up one fell (its line and its angle together), so still yellow: green at 150 m needs closer landmarks. | yellow |
| 7 | Night: GPS jumps to **Murmansk**, 216 km away, faster than anyone can walk: ignored. Polaris and Vega agree with her steps. Her steps say ±276 m, but if they were wrong the stars alone only say ±230 km, and Alibi shows that: she stays the night at the hut. | yellow |
| 8 | Fog and jamming: only her steps are left, 7.5 km since the last fix: ±1.8 km with nothing to check them. The **map rule** cuts out the lakes. She follows only the marked trail. | red |
| 9 | The fog lifts: the hut, two fell tops and the angle between them. ±122 m even if one were wrong (±132 m without the lake rule, as in the headless test). Safe arrival. | green |

The "Aino (the truth)" marker is only there for the audience; Alibi never sees it.

---

## Does the ± hold? (Monte Carlo)

`node tools/check_integrity.js . 100` plays every demo step 100 times with **random** errors drawn from each
witness's own ±, then hides GPS spoofs of different sizes in random directions. Add an error scale
(`... 100 2`) to draw errors 2 or 3 times bigger than the app assumes, with heavy tails, and a seed to vary
the random numbers.

| Demo step, random errors (default seed) | green | yellow | red | truth inside the ± | confidently wrong (green, but off by more than 150 m) | honest witness thrown out |
|---|---|---|---|---|---|---|
| 1 GPS + "I'm at the fell centre" (±50 m) | 100 % | 0 | 0 | 100 % | 0 | 0 |
| 2 GPS + steps | 0 | 100 % | 0 | 100 % | 0 | 0 |
| 3 GPS dragged 650 m + steps | 0 | 84 % | 16 % | 100 % | 0 | 0 |
| 4 ... + one fell line | 0 | 18 % | 82 % | 100 % | 0 | 0 |
| 5 ... + two fell lines | 0 | 42 % | 58 % | 100 % | 0 | 0 |
| 6 ... + three gyroscope angles (six fells) | 0 | 99 % | 1 % | 100 % | 0 | 0 |
| 7 night: GPS at Murmansk + steps + 2 stars | 0 | 100 % | 0 | 100 % | 0 | 0 |
| 7b night, if GPS's jump were not flagged | 0 | 62 % | 38 % | 100 % | 0 | 0 |
| 8 fog: steps only | 0 | 0 | 100 % | 98 % | 0 | 0 |
| 9 hut + 2 fell lines + angle + steps | 36 % | 63 % | 1 % | 100 % | 0 | 0 |

- **These runs use Alibi's own error model, so they only show it is consistent with itself.** The real test
  is the field. So we also broke the model on purpose:
  - **Errors 2× bigger than assumed, with heavy tails:** never green while more than 150 m off in 1,000
    runs. Alibi failed safe: far more red and yellow, and it threw out more honest witnesses (up to 30 %
    in steps 6 and 9).
  - **Errors 3× bigger:** green while more than 150 m off once in 1,000 runs (step 9).
- **Honest witnesses thrown out:** none with the default seed, 1 in 1,000 runs with seed 7.
- **Wi-Fi names** have their own test, `node tools/check_wifi.js . 300` (a city, made-up places), including the
  attacks the round-3 judges found:

| Case (300 runs each) | with the assumed errors | errors 2× bigger, heavy tails |
|---|---|---|
| honest GPS + café Wi-Fi + a fake hotspot named after a shop 1.3 km away | fake thrown out 100 %, never green | fake thrown out 74 %, never green |
| GPS spoofed 3 km; the Wi-Fi lookup was centred by it and found only shops near the fake spot | never green (yellow: the places fall together with GPS) | never green |
| GPS spoofed 2 km + two fake Wi-Fi names there + an honest guess ±200 m | red (stand-off) 100 % | red 99 %, yellow 1 % |
| no attack: three names from one café, mapped 400 m off | red 100 % (they count once; GPS and Wi-Fi disagree) | red 100 % |
| GPS 600 m off + café Wi-Fi + guess ±300 m | never green; GPS caught 19 %, honest witness dropped 2 % | never green; honest witness dropped 41 % |

  Wi-Fi names never produced a green that was more than 150 m off. The last line is the weak spot: two weak
  honest witnesses against one strong liar, with errors bigger than assumed, often lose the vote; the light
  is then yellow or red, but the yellow ± can miss the truth.
- **A slow drag is the hard case.** How often a hidden GPS lie was caught after 3 km of walking (50 runs per
  size, so roughly ±10 %):

| Other witnesses | 200 m | 400 m | 650 m | 1 km | 1.5 km |
|---|---|---|---|---|---|
| steps only | 2 % | 4 % | 20 % | 76 % | 98 % |
| steps + one fell line | 36 % | 84 % | 86 % | 100 % | 100 % |
| steps + two fell lines | 42 % | 94 % | 98 % | 100 % | 100 % |

  When a lie is not caught, the ± still held the truth in 95–100 % of runs, and the light was yellow, never
  green. The exception is the one 1.5 km lie that slipped past steps alone: there the truth was outside.

---

## Real GPS recordings (the organisers' data)

Click **Real log** and pick a scene. These are the organisers' own recordings from an Android phone (Google's
GnssLogger app): a 17-minute **train ride near Paris** with tunnels, and a 16-minute **drive in Espoo**, plus
clearly labelled **simulated attacks** on top of them. Press **Play**: it pauses on every result. **Skip**
jumps to the next one.

- **The chart** shows how many satellites the phone hears (blue) and how strong they are (orange). Red
  stripes are times without a GPS position, other bands show when GPS was ignored or jammed. Click it to jump.
- **Every second, GPS is checked** against dead reckoning from the fix Alibi trusted 25 s earlier, carried on
  with the vehicle's speed and the phone's **gyroscope** (which follows the curve inside a tunnel). Starting
  25 s back means it doesn't simply agree with the GPS it is checking. A fix that fails the check (0.1 % false
  alarms) is ignored, dead reckoning is never re-anchored on it, and GPS stays ignored for as long as it keeps
  telling the same lie: a spoofer can't win trust back just by waiting.
- **The ± is calibrated.** Dead reckoning's ± is a 95 % radius, tuned on outages cut into both recordings:
  the truth was inside it in 89–100 % of 10 to 120 s outages (the old version: 54–80 %). That is tuned and
  scored on the same two recordings, so it is optimistic until tested on new ones.
- **It can never be green on its own.** The motion check was started from GPS 25 s earlier, so a slow enough
  drag moves both. With only GPS and this check, the best Alibi says is yellow, "consistent". Green needs a
  witness that doesn't come from GPS (a landmark, a cell tower, the map).
- **It says why GPS is missing.** Satellites heard fine but no position: most likely a receiver hiccup (a
  spoofer taking over can look like this too, which the check against dead reckoning then catches). No satellites at
  all: blocked or jammed. "Gain normal, so blocked" is only said where the phone actually logged its receiver
  gain at that moment, and the jamming check runs first, so it can warn while GPS still has a position.
- **The speed stands in for a sensor.** The recordings have no wheel-speed or odometer data, so the recorded
  speed stands in for the vehicle's own speed sensor, which a GPS spoofer can't touch. A phone alone has no
  such sensor (see Limits).

Results on the real train recording:

| GPS outage | What Alibi says | Distance without GPS | GPS comes back |
|---|---|---|---|
| 27 s | 33 satellites heard fine: most likely a receiver hiccup, not jamming | 440 m | 8 m from dead reckoning (±255 m): trusted again |
| 111 s, curved tunnel | no satellites; the gain wasn't logged in the tunnel, so jamming can't be ruled out (most likely blocked) | 2.3 km | 148 m off (±1.5 km, because the speed is unknown in the tunnel): trusted again |
| 7 s tunnel | no satellites; the gain reads normal, but it never changes in this recording, so it proves little | 203 m | 38 m off (±55 m): trusted again |

No false alarms: in 859 seconds of the train and 977 of the car, honest GPS was never rejected.

**Simulated attacks on the real recordings** (`node tools/check_spoof.js .`, many start times and directions):

| Attack | Caught |
|---|---|
| Car, GPS slowly dragged away (the spoofer also fakes speed and course) | 1 m/s: 85 %; 1.5 m/s: 95 %; 2 m/s or more: always. At 3 m/s after 14 s, about 40 m off |
| Train, slow drag | 3 m/s: 85 %; 5 m/s: 98 %; 10 m/s: always |
| Sudden jump while driving | car 50 m: 94 %, 100 m: always; train 200 m: always |
| GPS comes back off after a tunnel | 7 s tunnel: 300 m always; 27 s outage: 1 km; 111 s tunnel: only about 3 km |
| Jamming (car, receiver gain drops 9 dB) | warned 15 s before GPS lost its position; GPS came back 19 m from dead reckoning |

The honest weak spots: a drag slower than about 1 m/s (car) or 3 m/s (train) can go unnoticed, and then the
truth can be outside the ± shown (in 20–52 % of those seconds); small undetected jumps of 20–75 m leave it
outside in 4–12 % of seconds. That's why the light is never green with only this check. After the 111 s
tunnel a lie of up to about 2 km can't be caught, because without a speed sensor the train really could be
anywhere within ±1.5 km. A third witness closes these gaps: a landmark, a cell tower, or the map (trains stay
on the rails). `docs/replay-integrity.svg` plots every error against the ± shown.

### Compass or gyroscope?

A compass knows where north is and never drifts, so why not use it for turns? The phone also logged its
magnetometer, so we tested both against the GPS track (`tools/compass_test.py`):

| | Train near Paris | Car in Espoo |
|---|---|---|
| Magnetic field the phone measured (the Earth's field there) | 61 µT and too steep (48 µT) | 20 µT, peaks of 280 µT (52 µT): probably a magnetic phone holder |
| Turn error over 30 s, **gyroscope** | **2.8°** | **2.5°** |
| Turn error over 30 s, heading from the raw magnetometer | 31° | 6.3° (22° in the worst 5 %) |
| Turn error over 30 s, Android's own compass reading | 3.0°, because it was secretly following the gyroscope (see below) | 6.3° (21° in the worst 5 %) |
| 112 s curved tunnel, 101° turn | gyroscope 5° off, raw magnetometer 18°, Google's fused heading 19° | – |

- **In the train, Android's compass quietly gave up.** Its compass reading stopped following the
  magnetometer and just turned with the gyroscope. It pointed about 85° away from where the magnetometer did,
  and still marked every one of its 127,657 readings "high accuracy". An app that trusts it would never know.
  Google's newer fused heading did notice: it reported its own error as ±84°.
- In the car the compass was right on average, but more than 20° off one second in five.
- So Alibi uses the **gyroscope for turns** in vehicles, and the compass only on foot away from metal, with a
  wide ±. The two can also check each other: in the car, when Android's compass and the gyroscope agreed
  about the last 10 s of turning, the compass was more than 20° off 16 % of the time; when they disagreed,
  25 % (raw magnetometer: 11 % against 29 %). The live app uses this check.

### What if there is no GPS at all?

In the recordings GPS does two jobs: it gives the starting point before the tunnel, and it is the answer key
we score our estimate against afterwards. Everything that carried the train through the tunnel works without
it. With no GPS at all:

- **The starting point** is whatever Alibi trusted last: a fix from landmarks or angles, the station you got on
  at, a Wi-Fi name, a cell tower ring, or your own guess.
- **Other witnesses keep correcting it**: landmarks and angles, the Sun and stars, cell towers and the map
  rules each give a position by themselves. The Lapland demo ignores GPS from step 5 onwards.
- **Speed** would come from the vehicle itself (a car's wheel speed, a train's odometer), which a phone app
  can't read today, or from counting steps on foot. The **direction** comes from the gyroscope.

---

## Live mode (on a real phone)

| Button | What it does | Real or simulated |
|---|---|---|
| GPS | Uses your phone's location as one witness (satellites; the browser may also mix in Wi-Fi and cell positioning, which a GPS spoofer doesn't touch but which isn't independent of Alibi's own Wi-Fi witness either). No GPS fix (a laptop)? It offers a clearly labelled simulated GPS at the map centre for demos. | real |
| I'm about here | Tap the map where you think you are (±200 m / 1 km / 5 km). GPS is hidden while you choose, so your guess isn't a copy of a possibly spoofed GPS dot. But the map may still be centred where GPS put it, so tap what you recognise (a sign, a building, a lake), not just the middle of the map. | real |
| Landmark | Loads hill tops, churches, towers, water towers, chimneys, lighthouses, wind turbines, ski jumps, wilderness huts, sea beacons, tall buildings and masts from OpenStreetMap. Tap one, put the camera's red cross on it and press **Take**. Check the reading, then **Add witness**. The compass draws a line. You can also mark a landmark yourself. | real |
| Angle A↔B | Tap two landmarks, aim at A and press **Take**, then turn on the spot to B and press **Take** again. The **gyroscope** measures how far you turned, so there is no compass to be fooled by metal or magnets. The angle puts you on an arc through A and B. Two angles (three landmarks) give a fix; a third angle or another witness makes it a fix Alibi can vouch for. | real |
| Sky | Pick the Sun or a bright star, aim at it and press **Take**. Its height above the horizon puts you on a band on the map. Aiming at the Sun can also **correct the phone compass with no GPS**: the clock says where the Sun stands, and being 20 km off changes that by less than 0.3°. | real |
| Wi-Fi / cell | Type a Wi-Fi name from your phone's Wi-Fi list (no need to connect; your phone lists them with GPS off). Shops, cafés, libraries and campuses often name their Wi-Fi after the place, and Wi-Fi rarely reaches more than 200 m. Alibi looks the name up in OpenStreetMap (name, brand, or a mapped Wi-Fi name) where the map is looking and puts a small circle around each place that fits: one shop, or every shop of a chain, and the other witnesses pick the right one. `eduroam` usually means a university or college (some libraries and hospitals have it too, so it counts as one possible liar like any name). Names that move with you (train, bus, ferry, phone hotspots) and home routers' factory names are refused with a reason. | real |
| … cell towers | In the same panel. Shows the masts around you as landmarks. Masts within 250 m of each other count as one site. Alibi uses at most three sites, spread around you (the nearest, plus others up to twice as far in clearly different directions), and only those get a pink ring: a narrow one for the serving cell (timing advance) and wide ones for neighbours (signal strength). Browsers can't read cell towers, so which ones you "hear" is made up from your position. | simulated |
| Spoof GPS | Simulates an attack: first a slow drag (3 m/s), then a 120 km jump. The grey dot is your real GPS. | simulated |
| Save offline | Saves the landmarks, masts and lakes for 6 × 6 km around the map's centre onto the phone (roads too in Drive mode), so they work with no network. | real |
| Real log | Replays the organisers' own GPS recordings (see above). | real data |

**Check every reading before it counts.** After **Take** you see the photo and the reading, and you can:
- nudge it (±1°, ±0.1°) or type a better value;
- switch to **Hand compass** and type what your compass shows. It is a magnetic reading, so Alibi adds the
  declination (e.g. +10.6° in Tampere) for you. For the Sun or stars, switch to **Inclinometer / sextant**;
- set **how sure** you are (± degrees). The defaults are phone compass ±7°, ±4° after calibration, hand
  compass ±3°, gyroscope angle ±2°, phone tilt ±1°, inclinometer ±0.4°. Bigger ± makes the line wider and the
  witness count less. These defaults are reasoned estimates, not yet measured in the field.

**The compass gets a rough check.** While you aim, Alibi compares the phone compass with the gyroscope, which
magnets can't fool. If the compass turned differently from the gyroscope in the last 10 seconds (by more than
5°), something magnetic is probably near, so Alibi warns you and widens the ±. On an iPhone it also uses the
phone's own compass accuracy. It catches a magnet that moves the needle while you aim, not much more: in the
train recording the compass was more than 20° off in 16 % of the seconds where it agreed with the gyroscope,
against 25 % where it didn't. Its blind spot: a compass that is off by a **steady** amount passes this check,
for example Android's compass in the train, which followed the gyroscope 85° away from the magnetometer.
Calibrating on a landmark, on the Sun, or using the angle tool, covers that. The compass can only be
**calibrated** against GPS when another witness confirms GPS (a green light), so a spoofed GPS can't quietly
bend every compass line. The Sun needs no GPS at all: its direction comes from the clock and a rough position
(tested headlessly with a compass that reads 12° too high: the Sun set the correction to −12.0°). It is not
offered while the compass disagrees with the gyroscope, because a nearby magnet moves with you. Calibration is one offset from one sighting, so "±4° after calibration" is an assumption
until it is measured.

**The step watchdog.** Turn on step counting in Settings. Alibi then carries the last position it could vouch
for (a green light) along with your steps and compass, as a witness of its own, with no effort from you: if
GPS drifts away from it, the light changes, the phone buzzes when it turns red, and only then does Alibi ask
you for a sighting. It is moved to each new green position, never to an unchecked GPS fix, or a slow spoofer
could drag it along. A green now has to hold with GPS and every Wi-Fi name removed together, so a spoofer who
also fakes Wi-Fi names can't move it either. **Without step counting, witnesses age:** Alibi can't tell
whether you moved since a sighting, so each witness blurs by about 1 m per second of its age on foot (15 m/s
by car, 5 m/s by boat), and the list shows how old it is. A web page can't count steps with the screen off, so the screen stays on while it runs
(a native app would run in the background). It assumes a 0.7 m stride and that you walk where the phone
points, so its 8 % drift is a guess until measured.

**No phone? Use the simulated view.** On a laptop, or a phone without a compass, the aiming screen shows a
**simulated view** built from the map. You see the real landmarks around you, and the Sun and stars where
they really are right now. Drag it (or use the arrow keys, Shift for 0.1°) to put the target under the red
cross, then press **Take** (or Enter). The button at the top right switches between it and the real camera. The
Lapland demo uses the same pictures for its witnesses.

**A 15-minute field test (worth doing before the video).** Every ± default above is an estimate until it is
measured, so measure it:
1. Stand somewhere open with GPS on, where you can see three or more landmarks 0.5–3 km away in different
   directions. Tap **I'm about here** on the exact spot (±200 m), so the light goes green.
2. Calibrate the compass on one landmark, then aim at the others. Note Alibi's reading and the true bearing
   (from the map, or the bearing GPS gives) for each. 5–10 readings show your real compass ±.
3. Do two **Angle A↔B** measurements, then turn GPS off: how far is Alibi's position from where you stand,
   and is that inside its ±?
4. Time each sighting from tapping the landmark to **Add witness**.
Put the numbers in the video: "phone compass ±X° measured, angles ±Y°, a fix in Z s per sighting".

**Tips for a live demo**
- Calibrate the compass first: once the light is green with GPS, aim at a landmark and tick *"Use this to calibrate my phone compass"*.
- Aim at landmarks in different directions (about 60–120° apart). Alibi suggests the best next one.
- Landmarks for central **Tampere** and **Helsinki** are built in, so they load instantly. Anywhere else they
  come from the public Overpass servers, which can be slow (20 s or more) or busy.
- Settings (gear button): safety limit, extra compass correction, step counting.

---

## What already exists, and what is new

| Already exists | What it does | What it can't do |
|---|---|---|
| Receiver integrity monitoring (RAIM, ARAIM) and Galileo's signal authentication (OSNMA) | checks satellites against each other; proves Galileo signals are genuine | nothing to fall back on when every satellite signal is jammed; RAIM can be fooled when all signals are faked together |
| Google's GnssLogger Spoof/Jam tab ([Android docs](https://developer.android.com/develop/sensors-and-location/sensors/gnss-spoof-jam)) | plots receiver gain and signal strength and flags patterns that suggest jamming or spoofing (experimental) | tells you something is wrong, not where you are |
| Sextant and celestial apps (e.g. [Celestial Navigator](https://apps.apple.com/app/id696927722)); [GPS Anti Spoof](https://apps.apple.com/app/id1467017105) | turn star sights into lines of position; GPS Anti Spoof compares sextant sights with what GPS predicts | one kind of source, for sailors with a sextant; no combined position or trust level |
| Compass and peak-finder apps | bearings to landmarks, naming the peaks you see | don't turn sightings into a checked position |
| Offline map apps | maps without a network | still trust GPS for the blue dot |
| Research: matching the skyline to terrain, visual positioning | a position from a camera picture | research prototypes, one source |
| Research: integrity monitoring of fused sensors, e.g. [IM-GIV](https://arxiv.org/abs/2410.22672) (GNSS + inertial + camera), and user-level reliability monitoring of GNSS (Prof. Kuusniemi's doctoral topic) | fault detection, exclusion and protection levels across sensors | built for vehicles and robots with calibrated sensors, not for a person taking sightings by hand on a phone |

**What Alibi adds:** any mix of sources, including your own sightings, the sky, your steps, you and the map,
goes into **one** engine that checks each against all the others, throws out a liar, and gives a
**protection level** that still holds if one of them lies, explained as a traffic light. It runs on an
ordinary phone, offline, and was tested on the organisers' own recordings.

---

## Making it real

- **Who would use it:** hikers and skiers in border-area wilderness (Urho Kekkonen, Lemmenjoki, Vätsäri),
  reindeer herders and others working near the border, volunteer search-and-rescue teams, and boaters in the
  eastern Gulf of Finland.
- **Who could bring it to them:** park and outdoor organisations as a free safety app (for example
  Metsähallitus, which runs the national parks), and makers of navigation apps and outdoor devices as a
  software library. (These are possible partners; we have not talked to any of them.)
- **Business model:** free for hikers. Licence the integrity engine to app and device makers. Paid setups for
  professional users (border, rescue, maritime) with their own landmark sets and safety limits.
- **Data:** landmarks, lakes and roads from OpenStreetMap and the National Land Survey of Finland (both open);
  the star catalogue is built in; mast positions from operators or open cell databases, under their licences.
  Region packs of a few tens of MB, refreshed about monthly.
- **Cost:** nothing needs a server at run time: it works offline. Costs are the data packs and app upkeep.
- **What it would take:**
  1. A native Android app: real cell towers (serving and neighbour cells with timing advance), raw GNSS signal
     strength and receiver gain, and the barometer. A browser can read none of these.
  2. Field tests: measure the real ± of phone compass, gyroscope angles and tilt on hikes; time each sighting;
     check that hikers act correctly on yellow and red; record a real slow spoof and a real jamming episode
     (with the authorities' test events, never our own transmitter).
  3. Automatic witnesses: skyline matching against elevation data, star photos solved with ESA's open-source
     **tetra3**, Galileo OSNMA as one more witness.
  4. A safety case: fault probabilities from field data, and a path to certification for professional use.

---

## Without internet

Needs no network at all: the stars and the Sun (the catalogue and maths are built in), your steps and
compass, your own guess, and the whole Lapland demo except the background map pictures.

Works offline once you have opened the app once: the app itself (kept by a service worker, `sw.js`), the
map pictures of places you have already looked at, landmarks for central Tampere and Helsinki (built in),
areas you saved with **Save offline**, and any place you loaded landmarks for before.

A real app would let you **download a whole region before the trip**, like offline maps in hiking apps:
background map, landmarks, lakes and roads for, say, all of Lapland (a few tens of MB), refreshed about
monthly, since towers and lakes rarely move. The National Land Survey of Finland and OpenStreetMap both
publish this data openly. The demo does not bulk-download map pictures, because the free OpenStreetMap tile
servers forbid it; a real app would host its own.

---

## Limits (say these out loud)

| Witness | Good to about | Fails when |
|---|---|---|
| GPS | 5–10 m | jammed or spoofed (that's the point) |
| Landmark line | 2–5° (≈ 50–200 m at 1–3 km) | fog or darkness; the wrong fell (that's why one sighting against GPS gives red, not a verdict); metal near the phone confusing the compass (Alibi checks the compass against the gyroscope and warns) |
| Angle A↔B (gyroscope) | 1–2° | you walk or tilt the phone a lot between the two shots; the gyroscope drifts slowly, so take both shots within a few seconds |
| Wi-Fi name | ±200 m around the place (more for a big campus or mall) | the place isn't on the map, or too many places share the name (more than 40 within the search is refused); the lookup needs the network; anyone can name a hotspot "Lidl", and **whoever spoofs GPS can fake Wi-Fi names too**, so GPS and all Wi-Fi names count as one possible liar: Wi-Fi helps find you and catch a lone liar, but never makes the light green on its own |
| Cell tower ring | ±100–300 m (serving cell) to ±0.5–5 km (neighbours) | wilderness, open sea; a mast mapped in the wrong place; a fake base station (possible, but much harder than faking GPS). Simulated in this demo. |
| Sky band | ±0.5–1° of tilt ≈ ±50–100 km | clouds. Catches big lies, but can't steer you between rocks. |
| Steps + compass | drift about 8 % of the distance walked | a long time without another witness |
| Map rule | – | the map is wrong or out of date; at sea (boat mode only knows lakes and rivers, so it switches the rule off near a coastline) |

What the integrity checks can and can't do:

- **One cause of error at a time.** Alibi assumes at most one thing goes wrong at once (one witness, or one
  mixed-up landmark with everything aimed at it). Two independent mistakes together can fool it. Shared
  errors, and what Alibi does about them: a guess copied from a spoofed GPS dot (GPS is hidden while you pick
  your spot); a compass calibrated against a spoofed GPS (calibration needs a green light); steps and lines
  that share one compass (the compass check against the gyroscope, and angles that need no compass); a
  vehicle's dead reckoning started from GPS (it can never make the light green on its own).
- **Slow spoofing is the hard case.** With only steps to check it, a GPS lie under about 1 km after 3 km of
  walking can't be proven (see the Monte Carlo above). What Alibi does: the ± grows as GPS and steps drift
  apart, so the light goes yellow long before the lie is caught; one fell line catches most lies over 400 m.
- **99 % is not 100 %, and the ± is only as good as its assumptions.** About 1 time in 100 the truth can be
  outside the ± even when every assumption holds. The fault probabilities and the ± defaults are reasoned
  guesses until field tests measure them; the Monte Carlo above shows what happens when real errors are 2–3×
  bigger than assumed.
- **Witnesses age, but only roughly.** Without step counting, each witness blurs by about 1 m per second of
  its age on foot (15 m/s by car); faster than that and an old sighting still counts for too much.
- **Nothing is field-tested yet.** The 15-minute field test above has not been done: every ± is a reasoned
  estimate, and the Lapland demo's sightings are simulated with those estimates.
- **A green light can still be over-trusted.** It means "checked to the safety limit under these assumptions",
  not "certainly right". Keep using the trail markers.
- **Phone practicalities:** the screen stays on while counting steps, which costs battery, and phones lose
  battery fast in the cold. A native app would run in the background with the screen off.
- **In vehicles, speed must come from the vehicle.** The replay uses the recorded speed as a stand-in for a
  wheel-speed sensor or odometer. A phone alone has neither, so then a spoofer also controls the speed, and a
  slow drag can only be caught by other witnesses. The jamming thresholds are untested on real jamming: the
  recordings contain none.
- **Weak signal indoors is not an attack.** Alibi does not treat it as one; it just has fewer witnesses.
- **Mobile networks:** base stations use their own secured timing, with GNSS only as a supplement, so GNSS
  interference has not disrupted them in Finland; separate interference on mobile frequencies has caused local
  outages near the south-eastern border. ([Traficom](https://traficom.fi/en/news/interference-affecting-mobile-communications-and-satellite-navigation-services-continues-finland))
- A phone's tilt sensor limits star sights. A photo of the sky solved with a star-tracker program (e.g. ESA's
  open-source **tetra3**) finds the camera's direction very precisely, but "straight down" still comes from
  the phone's accelerometer, so about ±10–50 km. That's a next step.
- Never use a real jammer or spoofer: it is illegal. Everything here is simulated.
- This is a demonstrator, not certified navigation equipment.

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

## Files

| File | What's in it |
|---|---|
| `index.html`, `css/style.css` | the page and its looks |
| `js/engine.js` | the core: grid, shapes, consistency tests, finding the liar, protection level, trust light |
| `js/geo.js` | distances, bearings, map projection, compass declination for Finland |
| `js/sky.js` | where the Sun and stars are |
| `js/osm.js` | OpenStreetMap: landmarks, masts, places a Wi-Fi name could belong to, lakes and roads for the map rule |
| `js/wifi.js` | reading a Wi-Fi name: which words to search for, and names that move with you or say nothing |
| `js/sensors.js` | phone compass, gyroscope, tilt, step counter, and the compass check |
| `js/app.js` | map, buttons, aiming view, step watchdog, demo player |
| `js/scenario.js`, `js/scenario-data.js` | the Lapland demo and its trail, fells and lakes |
| `js/landmark-data.js` | built-in landmarks for central Tampere and Helsinki |
| `js/replay.js`, `data/train.json`, `data/car.json` | replay of the organisers' GPS recordings: dead reckoning, the GPS check, simulated attacks |
| `sw.js` | service worker: keeps the app and viewed map pictures for offline use |
| `tools/check_integrity.js` | the Monte Carlo test above (`node tools/check_integrity.js . 100`) |
| `tools/check_wifi.js` | the same kind of test for Wi-Fi names in a city: honest, with a spoofed GPS, a chain of shops, a fake hotspot (`node tools/check_wifi.js . 300`) |
| `tools/check_spoof.js`, `docs/replay-integrity.svg` | the attack sweep on the real recordings (`node tools/check_spoof.js .`) and its error-against-± plot |
| `tools/check_story.js`, `check_replay.js`, `check_angle.js`, `check_compass.js` | run the Lapland demo, both recordings, the angle tool and the compass check through the real code without a browser (`node tools/check_story.js .`) |
| `tools/build_epochs.py` | turns a GnssLogger recording into the replay data (`python tools/build_epochs.py <log.txt> data/train.json "Train"`) |
| `tools/compass_test.py` | the compass vs gyroscope test above (`python tools/compass_test.py <log.txt> 47.6 64.3`; needs numpy) |

The recordings themselves are in the organisers' repository: <https://github.com/foinikialainen/Datasets>.

**Credits:** map data © OpenStreetMap contributors (ODbL); topo map style © OpenTopoMap (CC-BY-SA); maps
drawn with Leaflet; icons by Font Awesome (free); magnetic declination from the World Magnetic Model 2025 (via
the British Geological Survey web service).
