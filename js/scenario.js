/* Alibi - the Lapland demo story.
   Aino hikes from Kiilopää fell centre to Rautulampi hut while her GPS is first spoofed and then jammed.
   Every "measurement" is her true position plus a fixed error, so the demo plays the same way every time.
   The errors and ± are the app's own defaults: phone compass ±4° after calibration, gyroscope angle ±2°,
   phone tilt ±1°, steps drift 8 % of the distance walked since the last position Alibi could vouch for.
   tools/check_integrity.js replays every step with random errors instead. */
Alibi.scenario = (function () {
  'use strict';

  const G = Alibi.geo, SKY = Alibi.sky, D = Alibi.scenarioData;

  // ---------- the trail ----------
  const route = D.route;
  const cum = [0];
  for (let i = 1; i < route.length; i++) {
    cum.push(cum[i - 1] + G.dist(route[i - 1][0], route[i - 1][1], route[i][0], route[i][1]));
  }
  const length = cum[cum.length - 1];

  function along(m) {
    m = Math.max(0, Math.min(length, m));
    for (let i = 1; i < route.length; i++) {
      if (cum[i] >= m) {
        const f = (m - cum[i - 1]) / ((cum[i] - cum[i - 1]) || 1), a = route[i - 1], b = route[i];
        return { lat: a[0] + f * (b[0] - a[0]), lon: a[1] + f * (b[1] - a[1]) };
      }
    }
    const z = route[route.length - 1];
    return { lat: z[0], lon: z[1] };
  }

  function trackTo(m) {
    const pts = [];
    for (let i = 0; i < route.length && cum[i] < m; i++) pts.push(route[i]);
    const p = along(m);
    pts.push([p.lat, p.lon]);
    return pts;
  }

  const NIGHT = new Date(Date.UTC(2026, 9, 24, 17, 0));   // 20:00 local time
  const MURMANSK = { lat: 68.7817, lon: 32.7508 };         // Murmansk airport

  // ---------- simulated witnesses: true value + a fixed error ----------
  // ± is a 95 % radius: 2.45 sigma for a position, 2 sigma for an angle
  const twoSigma = (s) => '±' + G.fmtDist(2.45 * s);

  function gps(t) {
    const p = G.offset(t.lat, t.lon, 3, -2);
    return { id: 'gps', type: 'gps', kind: 'point', lat: p.lat, lon: p.lon, sigma: 5, label: 'GPS', detail: twoSigma(5) };
  }
  function spoofedGps(t, off, dir) {
    const p = G.dest(t.lat, t.lon, dir, off);
    return { id: 'gps', type: 'gps', kind: 'point', lat: p.lat, lon: p.lon, sigma: 5, label: 'GPS',
      detail: `${twoSigma(5)} · secretly pulled ${G.fmtDist(off)} off (simulated spoof)` };
  }
  function gpsAt(p, note) {
    return { id: 'gps', type: 'gps', kind: 'point', lat: p.lat, lon: p.lon, sigma: 5, label: 'GPS', detail: note, suspect: true,
      why: `GPS jumped ${G.fmtDist(G.dist(p.lat, p.lon, along(4320).lat, along(4320).lon))} in one second, faster than anyone can walk.` };
  }
  function you(p, sigma, what) {
    return { id: 'you', type: 'you', kind: 'point', lat: p.lat, lon: p.lon, sigma, label: 'I’m about here',
      detail: `${what} · ${twoSigma(sigma)}` };
  }
  function steps(t, errE, errN, sigma, walked) {
    const p = G.offset(t.lat, t.lon, errE, errN);
    return { id: 'steps', type: 'steps', kind: 'point', lat: p.lat, lon: p.lon, sigma, label: 'Steps + compass',
      detail: `last good position + ${G.fmtDist(walked)} walked · ${twoSigma(sigma)}` };
  }
  function fell(id, t, err, sigma) {
    const pk = D.peaks[id];
    const b = G.wrap360(G.bearing(t.lat, t.lon, pk.lat, pk.lon) + err);
    return { id: 'lm-' + id, type: 'landmark', kind: 'bearing', lat: pk.lat, lon: pk.lon, brg: b, sigma, label: pk.name, keys: [id], names: [pk.name],
      detail: `fell top · compass line ${Math.round(b)}° · ±${2 * sigma}°` };
  }
  // turn on the spot from fell A to fell B: the gyroscope measures the angle, no compass involved
  function angle(idA, idB, t, err, sigma) {
    const a = D.peaks[idA], b = D.peaks[idB];
    const ang = G.wrap180(G.bearing(t.lat, t.lon, b.lat, b.lon) - G.bearing(t.lat, t.lon, a.lat, a.lon) + err);
    return { id: `ang-${idA}-${idB}`, type: 'angle', kind: 'angle', a: { lat: a.lat, lon: a.lon }, b: { lat: b.lat, lon: b.lon },
      ang, sigma, label: `${a.name} ↔ ${b.name}`, keys: [idA, idB], names: [a.name, b.name],
      detail: `gyroscope · ${Math.abs(ang).toFixed(1)}° ${ang >= 0 ? 'right' : 'left'} from A to B · ±${2 * sigma}°` };
  }
  function mast(t, err, sigma) {
    const m = D.mast, r = G.dist(t.lat, t.lon, m.lat, m.lon) + err;
    return { id: 'tower', type: 'tower', kind: 'range', lat: m.lat, lon: m.lon, r, sigma, label: 'Cell mast (simulated)',
      detail: `about ${G.fmtDist(r)} away · ${twoSigma(sigma)}` };
  }
  function star(id, t, time, err, sigma) {
    const rd = SKY.radec(id, time), alt = SKY.altAz(rd.ra, rd.dec, t.lat, t.lon, time).alt + err;
    return { id: 'sky-' + id, type: 'sky', kind: 'sky', body: id, time, alt, sigma, label: SKY.name(id),
      detail: `${alt.toFixed(1)}° above the horizon · ±${(2 * sigma).toFixed(1)}°` };
  }

  // ---------- the story ----------
  const DRIFT = 0.08;                                                 // steps drift 8 % of the distance walked
  const walkSigma = (anchor, walked) => Math.hypot(anchor, DRIFT * walked);
  const SPOOF = (t) => spoofedGps(t, 650, 120);
  // carried from the fell centre (known to ±75 m, sigma 30 m): 3 km walked
  const STEPS_3KM = (t) => steps(t, -25, 20, walkSigma(30, 3000), 3000);
  const KIILOPAA = (t) => fell('kiilopaa', t, 2.5, 2), AHOPAAT = (t) => fell('ahopaat', t, -2, 2);
  // three angles between six different fell tops, so mixing up any one fell spoils only one of them
  const ANGLES = (t) => [angle('ahopaat', 'kiilopaa', t, 0.8, 1), angle('luuvaara', 'vavypaa', t, -0.7, 1),
    angle('pirttinokka', 'niilanpaa', t, 0.5, 1)];
  const FIX_SIGMA = 40;                                               // after the three-angle fix (±67 m most likely)

  const STEPS = [
    {
      at: 0, zoom: 15, title: 'Morning at the trailhead',
      text: 'Aino starts a day hike at Kiilopää in Urho Kekkonen National Park, which reaches the Russian border. Her GPS agrees with what she knows: she is at the fell centre. Two independent witnesses agree, so even if one of them were lying she would be within ±65 m: green. While GPS is confirmed, she calibrates her phone compass on a fell top.',
      make: (t) => [gps(t), you(D.huts.start, 50 / 2.45, 'at Kiilopää fell centre')],
    },
    {
      at: 2000, zoom: 14, title: 'On the trail',
      text: 'She walks 2 km. GPS says ±12 m, and her steps and compass agree with it. But steps drift about 8 % of the distance, so they can only vouch for GPS to ±500 m. Yellow: GPS looks fine, but nothing can prove it more closely than that.',
      make: (t) => [gps(t), steps(t, 45, -30, walkSigma(30, 2000), 2000)],
    },
    {
      at: 3000, zoom: 14, title: 'GPS starts lying',
      text: 'A spoofer slowly drags her GPS 650 m off course. That is too little for her steps to prove a lie, but GPS and steps are drifting apart, so the ± grows to 1.3 km. Alibi never promises more than its witnesses can check: the truth is still inside the circle.',
      make: (t) => [SPOOF(t), STEPS_3KM(t)],
    },
    {
      at: 3000, zoom: 14, title: 'Aim at Kiilopää',
      text: 'She aims her phone at Kiilopää fell top, and the compass draws a line. GPS doesn’t fit it. But what if she has mixed up the fell? One sighting against GPS, with steps too loose to decide: Alibi can’t tell which one is wrong, and says so.',
      make: (t) => [SPOOF(t), STEPS_3KM(t), KIILOPAA(t)],
    },
    {
      at: 3000, zoom: 14, title: 'Aim at Ahopäät',
      text: 'A second fell top. The two lines cross where her steps say she is, and GPS fits nothing, so GPS is ignored. Still yellow: if one of the fells were mixed up, the rest could only place her within about ±680 m.',
      make: (t) => [SPOOF(t), STEPS_3KM(t), KIILOPAA(t), AHOPAAT(t)],
    },
    {
      at: 3000, zoom: 14, title: 'Three angles, no compass',
      text: 'She turns on the spot from fell to fell, and the gyroscope measures three angles between six fell tops. No compass, so magnets can’t spoil it. GPS, 650 m off, is proven the liar. She is most likely within ±67 m, but if she had mixed up one fell, only ±285 m, so it stays yellow: green at 150 m needs closer landmarks. She keeps to the trail.',
      make: (t) => [SPOOF(t), STEPS_3KM(t), KIILOPAA(t), AHOPAAT(t)].concat(ANGLES(t)),
    },
    {
      at: 4320, view: 'night', title: 'Night at Luulampi',
      text: 'GPS suddenly says she is at Murmansk airport, 216 km away: faster than anyone can walk, so it is ignored at once. She aims at Polaris and Vega. The stars agree with her steps, not with GPS. Her steps carry her position: ±276 m if they are right. But if they were wrong, the stars alone could only say ±230 km, and Alibi shows that. Yellow: she spends the night at Luulampi hut instead of pushing on in the dark.',
      make: (t) => [gpsAt(MURMANSK, 'says Murmansk airport (simulated spoof)'), steps(t, 30, -40, walkSigma(FIX_SIGMA, 1320), 1320),
        star('polaris', t, NIGHT, 0.3, 0.5), star('vega', t, NIGHT, -0.4, 0.5)],
    },
    {
      at: 10450, zoom: 14, title: 'Fog, and GPS is jammed',
      alert: 'GPS: no signal (jammed).',
      text: 'Next morning: thick fog and no GPS at all. Only her steps are left, and they have drifted for 7.5 km since the last fix: ±1.8 km, with nothing to check them. Red: she takes no shortcuts and follows only the marked trail until she can sight something. The map rule cuts out the lakes, because walkers are not in lakes.',
      make: (t) => [steps(t, 150, 120, walkSigma(FIX_SIGMA, 7450), 7450)],
    },
    {
      at: 10900, zoom: 15, title: 'The fog lifts',
      text: 'She can see Rautulampi hut, aims at two fell tops and measures the angle between them. Everything agrees, and even if one witness were wrong she would be within about ±120 m: green. She arrives safely.',
      make: (t) => [steps(t, 150, 120, walkSigma(FIX_SIGMA, 7900), 7900), you(D.huts.rautulampi, 15, 'I can see Rautulampi hut'),
        fell('raututunturit', t, 1.5, 2), fell('aaslakkapaa', t, -1, 2), angle('raututunturit', 'aaslakkapaa', t, 0.6, 1)],
    },
  ];

  function build(k) {
    const st = STEPS[k], t = along(st.at);
    return {
      title: st.title, text: st.text, alert: st.alert || null,
      witnesses: st.make(t), truth: t, track: trackTo(st.at),
      view: st.view === 'night'
        ? { bounds: [[t.lat, t.lon], [MURMANSK.lat, MURMANSK.lon]] }
        : { center: [t.lat, t.lon], zoom: st.zoom || 14 },
    };
  }

  // the witness makers are shared with the headless integrity test (tools/check_integrity.js)
  return { count: STEPS.length, build, route, data: D, along,
    make: { gps, spoofedGps, gpsAt, you, steps, fell, angle, mast, star }, NIGHT, MURMANSK };
})();
