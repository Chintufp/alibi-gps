# Alibi: video script, final pitch and judge questions

Deadline: **Sunday 25 October, 12:30**. Video: **6 minutes max**, covering problem and user, how it works,
demo, and reliability and next steps.

**Before you record:**
- Open <https://chintufp.github.io/alibi-gps/?demo> on a laptop and refresh once, so you get the newest version.
- Screen-record at 1280×800 or bigger. Zoom the browser to about 125 % for the Lapland demo, so the circles are
  easy to see. Before talking over a step, wait a second for the map tiles to finish loading.
- In **Real log**, use **Skip** to jump to each result instead of waiting for **Play**.
- Practise once. Talk slowly: about 130 words a minute. The script below is about 780 words.
- Optional but strong: do the 15-minute field test in the README first and put your real numbers in scene 5.
  If you can, film one real sighting with your phone outdoors (aim, Take, Add witness): 10 seconds is enough.

---

## The 6-minute video, scene by scene

### 1. Problem and user (0:00–0:45)

**Show:** the app's start screen, then the map of Lapland (click *Watch the Lapland demo*, stay on step 1).

**Say:**
> "Your phone shows a confident blue dot even when it's wrong. GPS can be jammed, or worse, spoofed: faked
> so it looks perfect. Traficom says interference in Finland grew this spring: daily for planes, regularly
> for ships in the eastern Gulf of Finland, and on the ground close to the eastern border. Just across the
> border in Norway's Finnmark it reaches the ground: this March a sled-dog race lost its GPS tracking.
> Our user is Aino, hiking in Urho Kekkonen National Park, about 30 km from the Russian border. Her
> decisions depend on her position: keep going or turn back, which way to the hut, what to tell 112. If GPS
> lies, her phone can't tell her."

### 2. How it works (0:45–1:45)

**Show:** step 1 of the demo. Point at the two circles, the light, and the dashed ± circle.

**Say:**
> "Alibi treats GPS as just one witness. Other witnesses: landmarks you aim the camera at, the angle between
> two landmarks measured by the gyroscope, the Sun and stars, your own steps, your own guess, cell towers
> and the map. Each draws a shape on the map: a circle, a line, an arc or a band. Where they overlap is where
> you are.
> Then Alibi does what GPS receivers do with satellites, but for whole sources: it predicts what each witness
> should say from all the others. If one is way off, it's lying, and it's thrown out.
> And the ± is a protection level: it still holds if one witness is lying. Green means proven. Here GPS and
> 'I'm at the fell centre' agree, so she's within ±65 m even if one of them were lying."

### 3. Demo: the Lapland story (1:45–3:40)

Click **Next** through the steps and say one line each:

- **Step 2:** "She walks 2 km. GPS says ±12 m, and her steps agree, but steps drift, so they can only vouch
  for ±500 m. Yellow: they agree, but it's not proven. Alibi never promises more than it can check."
- **Step 3:** "A spoofer slowly drags GPS 650 m away. Too little to prove, but the ± grows to 1.3 km, and the
  truth is still inside it."
- **Step 4:** "She aims at Kiilopää. GPS doesn't fit the line. But maybe she mixed up the fell? One against
  one: Alibi honestly says it can't tell. Red."
- **Step 5:** "A second fell. The lines cross where her steps say: GPS is thrown out."
- **Step 6:** "She turns from fell to fell and the gyroscope measures angles: no compass, nothing magnetic to
  fool. GPS is proven to be lying. But if she had mixed up one fell, both its line and its angle would be
  wrong, so Alibi only promises ±285 m: still yellow. It is that strict."
- **Step 7:** "Night. GPS jumps to Murmansk, 216 km away: impossible on foot, ignored at once. Her steps say
  ±276 m, but if they were wrong, the stars alone could only say ±230 km, and Alibi tells her so. She stays
  at the hut."
- **Step 8:** "Fog and jamming: only her steps, ±1.8 km. Red: she sticks to the marked trail."
- **Step 9:** "The fog lifts: the hut, two fells and an angle. Proven, green. She arrives safely."

### 4. Demo: the organisers' own data (3:40–4:30)

**Show:** Exit the demo → **Real log** → **Train ride near Paris**. Press **Skip** until the long tunnel's
result card (GPS back after 111 s). Then pick **Car + slow drag spoofing** and press **Skip** until it shows
"GPS caught lying".

**Say:**
> "This is the organisers' own recording: a train near Paris. In a 111-second curved tunnel GPS is gone.
> Alibi carries on with speed and the phone's gyroscope, which follows the curve, and when GPS comes back
> it is 148 metres from where Alibi said, inside its honest circle. One caveat: the recordings have no
> wheel or odometer sensor, so we use the recorded speed as a stand-in for one.
> Now a simulated attack on their car recording: a spoofer drags GPS away at 3 metres a second. Alibi
> checks GPS every second against the car's own motion and catches the lie 12 seconds in, 38 metres off,
> and it stays caught. And on the real recordings, with no attack: no false alarms at all."

(Read the numbers off the result card if they differ.)

### 5. Reliability: why you can trust it, and when not (4:30–5:30)

**Show:** the README sections "Does the ± hold?" and "Compass or gyroscope?" (scroll slowly), or a slide
with these numbers.

**Say:**
> "Does the ± hold? We replayed every demo step a hundred times with random errors: Alibi was never green
> while more than 150 m off. Even with errors twice as big as the app assumes, it never showed a wrong green; it went yellow or red instead.
> Its limits, said out loud: it assumes one thing goes wrong at a time, and its error sizes are our estimates
> until we measure them. A slow drag is the hard case: steps alone can't prove a lie under about a kilometre,
> so the light stays yellow instead of green.
> And a surprise from the organisers' data: in the train, Android's compass silently stopped using its
> magnetometer, pointed 85° away from it, and still said 'high accuracy'. That's why Alibi's angle tool needs
> no compass at all."

*(If you did the field test, add:)* "We tested it outside: phone compass ±X°, angles ±Y°, about Z seconds per sighting."

### 6. Next steps (5:30–6:00)

**Say:**
> "Next: a native Android app to read real cell towers, receiver gain and the barometer, and to run in the
> background; field tests with hikers and rescue volunteers; and automatic witnesses, like star photos solved
> with ESA's open-source tetra3. Everything runs offline on an ordinary phone. GPS is just one witness. Alibi
> asks the others."

---

## The 4-minute final pitch (if you reach the final)

1. **Hook (20 s):** "Raise your hand if you'd know your phone's GPS was lying. Nobody would. That's the problem."
2. **User and need (40 s):** Aino in Lapland, 30 km from the border; interference facts (Traficom, Finnmark);
   getting lost is common (100+ lost berry pickers one summer, 40 in Lapland), and rescuers depend on GPS.
3. **Idea (40 s):** witnesses, shapes, catching the liar, the protection level, green means proven.
4. **Demo (90 s):** Lapland steps 3 → 4 → 6 → 7 (the growing ±, the honest "can't tell", the compass-free
   angles, Murmansk).
5. **Proof (30 s):** organisers' data (the tunnel, the drag caught in 12 s, no false alarms in 1,836 real
   seconds), the Monte Carlo, the compass discovery.
6. **Ask (20 s):** field tests with hikers and rescue volunteers; a native app; partners in parks, outdoor
   devices and maritime.

---

## Questions the judges will probably ask

**"Isn't this just RAIM?"**
RAIM checks satellites against each other inside one receiver, so it can't help when every signal is
jammed or faked together. Research systems (for example IM-GIV) extend integrity monitoring to inertial and
camera sensors in vehicles. What's new here: the same idea across sources a person collects by hand on a
phone (sightings, angles, stars, steps, her own guess, the map), with mistakes that share a cause, like a
mixed-up fell, treated as one. A spoofer can fake every satellite, but not a fell top.

**"What does your ± actually guarantee?"**
It's a protection level by solution separation: for each thing that could be wrong (a witness, or a landmark
with everything aimed at it), we compute where you could be from the rest, and take the radius that holds
99 % of that around the best guess, for the worst case. It assumes one cause of error at a time and our
error sizes. In our Monte Carlo it was never green while more than 150 m off, but those runs use our own
error model, so field data is the real test.

**"Where do your fault probabilities come from?"**
They are judgement calls (about 1 % for GPS, landmarks, stars, guesses and steps; less for a vehicle's own
sensors). Measuring them is part of the field tests. They only decide which hypotheses the ± must cover.

**"What about a slow drift spoof?"**
That's the hard case, and we say so. Steps alone can't prove a lie under about 1 km after 3 km of walking,
but the ± grows as GPS and steps drift apart, so the light never goes green. One fell line caught 70–85 % of
400 m lies in our runs (50 runs each, depending on the random seed). In the vehicle replay, a drag under
about 1 m/s goes unnoticed, so a check that started from GPS is never allowed to make the light green.

**"How accurate is a phone compass really?"**
In the organisers' car log, more than 20° off one second in five; in the train, Android's compass silently
followed the gyroscope 85° away from its magnetometer. Our compass check catches a compass that drifts
against the gyroscope, but not one that is off by a steady amount, which is why calibration on a landmark
and the compass-free angle tool matter.

**"Do you get false alarms?"**
On the organisers' real recordings, none: 859 seconds of the train and 977 of the car, honest GPS was never
rejected. The check is set for 0.1 % false alarms.

**"How do you tell jamming from a tunnel?"**
A tunnel cuts every signal at once, and the receiver's gain stays normal; jamming adds noise, so the receiver
turns its gain down. In the organisers' train log the gain is logged in 912 of 1,027 seconds, but it never
changes (always 5.2 dB), and inside the long tunnel it is missing for 104 of 111 seconds, so there Alibi says
it can't rule jamming out. Our jamming test is simulated, and a jammer that ramps up very slowly could slip
past a gain check.

**"Could you add a factor graph or LEO satellites?"** (Majed Imad's research)
Yes. Each witness is already a likelihood, so a factor graph over time (steps as odometry between positions,
older sightings correlated properly) is the natural next step, and a LEO signal like Starlink Doppler or a
dedicated LEO navigation service is simply one more witness.

**"Is any of it real, or all simulated?"**
Real: the engine, the sky maths, OpenStreetMap landmarks, the phone's sensors and camera, the organisers'
recordings. Simulated: cell towers (browsers can't read them), the attacks (transmitting them is illegal),
the vehicle speed sensor (a stand-in from the recording), and the demo's measurements, made with the app's
own error sizes.

**"Who pays?"**
Free for hikers; the engine licensed to outdoor-device and navigation-app makers; paid setups for
professionals (border, rescue, maritime). It runs offline, so the running cost is just data packs.

**"How long does a sighting take?"**
*(Use your field-test number. Otherwise:)* We estimate about half a minute: tap the landmark, aim, take,
check, add. The step watchdog needs no effort, so Alibi only asks for a sighting when something disagrees.
