# Alibi: video script, final pitch and judge questions

Deadline: **Sunday 25 October, 12:30**. Video: **6 minutes max**, covering problem and user, how it works,
demo, and reliability and next steps.

**Before you record:**
- Open <https://chintufp.github.io/alibi-gps/?demo> on a laptop and refresh once, so you get the newest version.
- Screen-record at 1280×800 or bigger, browser zoom 100 %. A phone recording is fine for the real-camera bit.
- Practise once. Talk slowly: about 130 words a minute. The script below is about 760 words.
- Optional but strong: do the 15-minute field test in the README first and put your real numbers in scene 5.

---

## The 6-minute video, scene by scene

### 1. Problem and user (0:00–0:45)

**Show:** the app's start screen, then the map of Lapland (click *Watch the Lapland demo*, stay on step 1).

**Say:**
> "Your phone shows a confident blue dot even when it's wrong. GPS can be jammed, or worse, spoofed: faked
> so it looks perfect. Traficom says interference in Finland grew this spring: daily for planes, regularly
> for ships in the eastern Gulf of Finland. And right next to Lapland, in Norway's Finnmark, jamming and
> spoofing reach the ground: this March a sled-dog race lost its GPS tracking.
> Our user is Aino, hiking in Urho Kekkonen National Park, which reaches the Russian border. Her decisions
> depend on her position: keep going or turn back, which way to the hut, what to tell 112. If GPS lies, her
> phone can't tell her."

### 2. How it works (0:45–1:45)

**Show:** step 1 of the demo. Point at the two circles, the light, and the dashed ± circle.

**Say:**
> "Alibi treats GPS as just one witness. Other witnesses: landmarks you aim the camera at, the angle between
> two landmarks measured by the gyroscope, the Sun and stars, your own steps, your own guess, cell towers
> and the map. Each draws a shape on the map: a circle, a line, an arc or a band. Where they overlap is where
> you are.
> Then Alibi does what GPS receivers do with satellites, but for whole sources: it predicts what each witness
> should say from all the others. If one is way off, it's lying, and it's thrown out.
> And the ± is a protection level: it still holds if one witness is lying. Here GPS and 'I'm at the fell
> centre' agree, so she's within ±93 m even if one of them were lying. Green."

### 3. Demo: the Lapland story (1:45–3:40)

Click **Next** through the steps and say one line each:

- **Step 2:** "She walks 2 km. GPS says ±12 m, but only her steps check it, and steps drift, so Alibi can
  only vouch for ±500 m. Yellow: it never promises more than it can check."
- **Step 3:** "A spoofer slowly drags GPS 650 m away. Too little to prove, but the ± grows to 1.3 km, and the
  truth is still inside it."
- **Step 4:** "She aims at Kiilopää. GPS doesn't fit the line. But maybe she mixed up the fell? One against
  one: Alibi honestly says it can't tell. Red."
- **Step 5:** "A second fell. The lines cross where her steps say: GPS is thrown out."
- **Step 6:** "Now she turns from fell to fell and the gyroscope measures the angles: no compass, nothing
  magnetic to fool. Even if any one witness were wrong, she's within ±121 m. Green."
- **Step 7:** "Night. GPS jumps to Murmansk, 216 km away: impossible on foot, ignored at once. The stars
  agree with her steps."
- **Step 8:** "Fog and jamming: only her steps. ±1.8 km, red: she sticks to the marked trail."
- **Step 9:** "Fog lifts: the hut and two fells. Green. She arrives safely."

### 4. Demo: the organisers' own data (3:40–4:30)

**Show:** Exit the demo → **Real log** → **Train ride near Paris**. Press **Skip** until the long tunnel's
result card (GPS back after 111 s). Then pick **Car + slow drag spoofing** and press **Play** until it pauses
on "caught".

**Say:**
> "This is the organisers' own recording: a train near Paris. In a 111-second curved tunnel GPS is gone.
> Alibi carries on with the train's speed and the phone's gyroscope, which follows the curve, and when GPS
> comes back it is 148 metres from where Alibi said, well inside its honest circle. Now a simulated attack
> on their car recording: a spoofer slowly drags GPS away at 3 metres a second, faking speed and course too.
> Alibi checks GPS every second against where the car's own motion says it should be, and catches the lie
> about 14 seconds in, about 40 metres off. And it stays caught: the spoofer can't win trust back by waiting."

### 5. Reliability: why you can trust it, and when not (4:30–5:30)

**Show:** the README sections "Does the ± hold?" and "Compass or gyroscope?" (scroll slowly), or a slide
with these numbers.

**Say:**
> "Does the ± hold? We replayed every demo step a hundred times with random errors. Alibi was never green
> while more than 150 m off, and never threw out an honest witness.
> Its limits: it assumes one liar at a time. A slow drag is the hard case: steps alone can't prove a lie
> under about a kilometre, so the light goes yellow instead, and one landmark catches most lies over 400 m.
> And a surprise from the organisers' data: in the train, Android's compass silently stopped using its
> magnetometer, ended up 85° off, and still said 'high accuracy'. That's why Alibi checks the compass against
> the gyroscope, and why its angle tool needs no compass at all."

*(If you did the field test, add:)* "We tested it outside: phone compass ±X°, angles ±Y°, about Z seconds per sighting."

### 6. Next steps (5:30–6:00)

**Say:**
> "Next: a native Android app to read real cell towers, receiver gain and the barometer; field tests with
> hikers; and automatic witnesses, like star photos solved with ESA's open-source tetra3. Everything runs
> offline on an ordinary phone. GPS is just one witness. Alibi asks the others."

---

## The 4-minute final pitch (if you reach the final)

1. **Hook (20 s):** "Raise your hand if you'd know your phone's GPS was lying. Nobody would. That's the problem."
2. **User and need (40 s):** Aino in Lapland near the border; interference facts (Traficom, Finnmark);
   lost hikers are common (100+ lost berry pickers one summer, 40 in Lapland).
3. **Idea (40 s):** witnesses, shapes, catching the liar, the protection level.
4. **Demo (90 s):** Lapland steps 3 → 4 → 6 → 7 (the strongest moments: the growing ±, the honest "can't
   tell", the compass-free green, Murmansk).
5. **Proof (30 s):** organisers' data (tunnel, the drag caught in 14 s, no false alarms in 1,836 real seconds), the Monte Carlo numbers, the compass discovery.
6. **Ask (20 s):** field tests with hikers and rescue volunteers; a native app; partners in parks, outdoor
   devices and maritime.

---

## Questions the judges will probably ask

**"Isn't this just RAIM?"**
RAIM checks satellites against each other inside one receiver, so it can't help when every signal is
jammed or faked together. We do the same consistency test, but across completely different sources:
sightings, stars, steps, the user, the map. A spoofer can fake every satellite, but not a fell top.

**"What does your ± actually guarantee?"**
It's a protection level by solution separation: for each witness that could lie, we compute where you could
be from the others alone, and take the radius that holds 99 % of that around the best guess, for the worst
case. It assumes one liar at a time. Our Monte Carlo had zero cases of green while more than 150 m off.

**"Where do your fault probabilities come from?"**
They are judgement calls (GPS, landmarks, stars, guesses about 1 %; steps drift rather than lie). Measuring
them is part of the field tests. They only decide which witnesses get a "what if this one lies" check.

**"What about a slow drift spoof?"**
That's the hard case, and we say so. Steps alone can't prove a lie under about 1 km after 3 km of walking,
but the ± grows as GPS and steps drift apart, so the light turns yellow first. One landmark catches 84 % of
400 m lies, and two catch 94 %.

**"How accurate is a phone compass really?"**
In the organisers' car log, more than 20° off one second in five; in the train, Android's compass silently
gave up. That's why we check it against the gyroscope, widen its ± when they disagree, and offer the
gyroscope angle tool that needs no compass.

**"Do you get false alarms?"**
On the organisers' real recordings, none: 859 seconds of the train and 977 of the car, honest GPS was never
rejected. The check is set for 0.1 % false alarms.

**"How do you tell jamming from a tunnel?"**
A tunnel cuts every signal at once, and the receiver's gain stays normal; jamming adds noise, so the receiver
turns its gain down. The organisers' train log only has gain values for a few seconds, so where it's
missing Alibi says it can't rule jamming out.

**"Could you add a factor graph or LEO satellites?"** (Majed Imad's research)
Yes. Each witness is already a likelihood, so a factor graph over time (steps as odometry between positions)
is the natural next step, and a LEO signal like Starlink Doppler or a dedicated LEO navigation service is
simply one more witness.

**"Is any of it real, or all simulated?"**
Real: the engine, the sky maths, OpenStreetMap landmarks, the phone's sensors and camera, the organisers'
recordings. Simulated: cell towers (browsers can't read them), the attacks (transmitting them is illegal),
and the demo's measurements, made with the app's own error sizes.

**"Who pays?"**
Free for hikers; the engine licensed to outdoor-device and navigation-app makers; paid setups for
professionals (border, rescue, maritime). It runs offline, so the running cost is just data packs.

**"How long does a sighting take?"**
*(Use your field-test number. Otherwise:)* About half a minute: tap the landmark, aim, take, check, add. And
the step watchdog runs in the background, so Alibi only asks for a sighting when something disagrees.
