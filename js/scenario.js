/* Alibi - the Lapland demo story.
   Aino hikes from Kiilopää fell centre to Rautulampi hut while her GPS is first spoofed and then jammed.
   Every "measurement" is her true position plus a fixed error, so the demo plays the same way every time. */
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
  const twoSigma = (s) => '±' + G.fmtDist(2 * s);

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
    return { id: 'gps', type: 'gps', kind: 'point', lat: p.lat, lon: p.lon, sigma: 5, label: 'GPS', detail: note, suspect: true };
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
    return { id: 'lm-' + id, type: 'landmark', kind: 'bearing', lat: pk.lat, lon: pk.lon, brg: b, sigma, label: pk.name,
      detail: `fell top · compass line ${Math.round(b)}° · ±${2 * sigma}°` };
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
  const SPOOF = (t) => spoofedGps(t, 650, 120);
  const STEPS_3KM = (t) => steps(t, -25, 20, 90, 1000);

  const STEPS = [
    {
      at: 0, zoom: 15, title: 'Morning at the trailhead',
      text: 'Aino starts a day hike at Kiilopää in Urho Kekkonen National Park, less than 50 km from the Russian border. Her GPS agrees with what she knows: she is at the fell centre. Two witnesses agree, so the light is green.',
      make: (t) => [gps(t), you(D.huts.start, 30, 'at Kiilopää fell centre')],
    },
    {
      at: 2000, zoom: 15, title: 'On the trail',
      text: 'She walks 2 km towards Luulampi. The phone counts her steps and reads the compass, carrying her last good position along. GPS and steps agree.',
      make: (t) => [gps(t), steps(t, 45, -30, 60, 2000)],
    },
    {
      at: 3000, zoom: 14, title: 'GPS starts lying',
      text: 'A spoofer slowly drags her GPS 650 m off course, slowly enough to look believable. Now GPS and her steps disagree. With only two witnesses, Alibi knows something is wrong, but not who is lying.',
      make: (t) => [SPOOF(t), STEPS_3KM(t)],
    },
    {
      at: 3000, zoom: 13, title: 'A distant cell mast',
      text: 'Her phone hears one mast 3.5 km away (simulated, because browsers cannot read cell towers). Its ring is wide and fits both GPS and her steps, so Alibi still cannot tell who is lying, and says so honestly.',
      make: (t) => [SPOOF(t), STEPS_3KM(t), mast(t, 250, 450)],
    },
    {
      at: 3000, zoom: 14, title: 'Aim at Kiilopää',
      text: 'Aino points her phone at Kiilopää fell top and the compass draws a line (it was calibrated against GPS this morning, while GPS could still be trusted). Her steps fit the line; GPS does not. Three witnesses outvote GPS, so GPS is ignored.',
      make: (t) => [SPOOF(t), STEPS_3KM(t), mast(t, 250, 450), fell('kiilopaa', t, 2.5, 2)],
    },
    {
      at: 3000, zoom: 14, title: 'Aim at Ahopäät',
      text: 'A second fell top. The two lines cross right where her steps say she is. The uncertainty drops below the safety limit, so the light turns green.',
      make: (t) => [SPOOF(t), STEPS_3KM(t), mast(t, 250, 450), fell('kiilopaa', t, 2.5, 2), fell('ahopaat', t, -2, 2)],
    },
    {
      at: 4320, view: 'night', title: 'Night at Luulampi',
      alert: '⚠ GPS jumped 216 km in one second. That is impossible on foot.',
      text: 'GPS suddenly says she is at Murmansk airport, 216 km away. She aims her phone at Polaris and Vega. The stars agree with her steps, not with GPS. Signals can be jammed. The stars can’t.',
      make: (t) => [gpsAt(MURMANSK, 'says Murmansk airport (simulated spoof)'), steps(t, 30, -40, 70, 1320),
        star('polaris', t, NIGHT, 0.2, 0.35), star('vega', t, NIGHT, -0.25, 0.35)],
    },
    {
      at: 10450, zoom: 15, title: 'Fog, and GPS is jammed',
      alert: '⚠ GPS: no signal (jammed).',
      text: 'Next morning: thick fog and no GPS at all. Only her steps are left, so the uncertainty grows. The map rule cuts out the lakes, because walkers are not in lakes. Alibi says: slow down and follow the trail markers.',
      make: (t) => [steps(t, 150, 120, 250, 6130)],
    },
    {
      at: 10900, zoom: 15, title: 'The fog lifts',
      text: 'She can see Rautulampi hut and aims at two fell tops. All witnesses agree again, so the light is green. She arrives safely.',
      make: (t) => [steps(t, 150, 120, 260, 450), you(D.huts.rautulampi, 15, 'I can see Rautulampi hut'),
        fell('raututunturit', t, 1.5, 2.5), fell('aaslakkapaa', t, -1, 2.5)],
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

  return { count: STEPS.length, build, route, data: D };
})();
