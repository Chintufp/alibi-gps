/* Alibi - the app: map, buttons, aiming view and the Lapland demo. */
(function () {
  'use strict';

  const G = Alibi.geo, SKY = Alibi.sky, ENG = Alibi.engine, OSM = Alibi.osm, SEN = Alibi.sensors, STORY = Alibi.scenario;
  const $ = (id) => document.getElementById(id);

  const MODES = {
    walk: { limit: 150, maxSpeed: 4, verb: 'walk', rule: 'Walkers aren’t in lakes' },
    drive: { limit: 50, maxSpeed: 60, verb: 'drive', rule: 'Cars stay on roads' },
    boat: { limit: 100, maxSpeed: 25, verb: 'sail', rule: 'Boats stay on water (lakes and rivers)' },
  };
  const COLORS = { gps: '#2563eb', you: '#7c3aed', steps: '#059669', motion: '#059669', landmark: '#ea580c', angle: '#0891b2', tower: '#c026d3', sky: '#1e3a8a' };
  const LABEL_SIDE = { gps: 'right', you: 'left', steps: 'bottom', motion: 'bottom', landmark: 'top', angle: 'top', tower: 'top', sky: 'top' };
  const BAD = '#dc2626', SUSPECT = '#d97706';
  const ICONS = { gps: '🛰️', you: '📍', steps: '👣', motion: '🧭', landmark: '🗼', angle: '📐', tower: '📡', sky: '✨' };
  const STATE_TEXT = { agrees: '✓ agrees', ignored: '✗ ignored', suspect: '? suspect', unchecked: '– unchecked' };

  const state = {
    mode: 'walk', witnesses: [], nextId: 1,
    gps: { on: false, watch: null, raw: null, prev: null, spoof: 'off', spoofT0: 0, spoofDir: 120, suspectUntil: 0, jumpMsg: '' },
    landmarks: [], suggestId: null,
    compassOffset: 0, compassCalibrated: false, steps: false,
    pending: null, youRadius: 1000,
    story: null, replay: null, result: null,
  };

  // ---------- map ----------
  const map = L.map('map', { zoomControl: false }).setView([61.4978, 23.7610], 14);   // Tampere
  L.control.zoom({ position: 'topright' }).addTo(map);
  // crossOrigin lets the service worker keep the map pictures you have looked at for offline use
  const street = L.tileLayer('https://tile.openstreetmap.org/{z}/{x}/{y}.png', {
    maxZoom: 19, crossOrigin: true, attribution: '© <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors',
  });
  const topo = L.tileLayer('https://{s}.tile.opentopomap.org/{z}/{x}/{y}.png', {
    maxZoom: 17, subdomains: 'abc', crossOrigin: true,
    attribution: 'Map data © OpenStreetMap contributors, SRTM · style © <a href="https://opentopomap.org">OpenTopoMap</a> (CC-BY-SA)',
  });
  street.addTo(map);
  L.control.layers({ 'Street map': street, 'Topo map': topo }, null, { position: 'topright' }).addTo(map);
  map.createPane('heat');
  map.getPane('heat').style.zIndex = 350;
  map.getPane('heat').style.pointerEvents = 'none';
  const layer = {
    story: L.layerGroup().addTo(map),
    marks: L.layerGroup().addTo(map),
    shapes: L.layerGroup().addTo(map),
    est: L.layerGroup().addTo(map),
  };
  let heat = null;

  // ---------- witnesses ----------
  function addWitness(w) {
    w.id = 'w' + state.nextId++;
    state.witnesses.push(w);
    schedule();
  }
  function removeWitness(id) {
    state.witnesses = state.witnesses.filter((w) => w.id !== id);
    drawLandmarks();
    schedule();
  }
  function allWitnesses() {
    if (state.story) return state.story.witnesses;
    if (state.replay) return state.replay.witnesses;
    const g = gpsWitness();
    return g ? [g].concat(state.witnesses) : state.witnesses.slice();
  }
  function refPoint() {
    if (state.result && state.result.est) return state.result.est;
    if (state.gps.raw) return state.gps.raw;
    const c = map.getCenter();
    return { lat: c.lat, lon: c.lng };
  }
  function viewBounds() {
    const b = map.getBounds();
    return { s: b.getSouth(), w: b.getWest(), n: b.getNorth(), e: b.getEast() };
  }

  // ---------- GPS (real) and the simulated attack ----------
  function spoofed(raw) {
    const s = state.gps.spoof;
    if (s === 'off' || !raw) return Object.assign({ off: 0 }, raw);
    const secs = (Date.now() - state.gps.spoofT0) / 1000;
    const d = s === 'drag' ? Math.min(3 * secs, 5000) : 120000;   // drag at 3 m/s, or jump 120 km
    const p = G.dest(raw.lat, raw.lon, state.gps.spoofDir, d);
    return { lat: p.lat, lon: p.lon, acc: raw.acc, off: d };
  }

  function gpsWitness() {
    const raw = state.gps.raw;
    if (!state.gps.on || !raw) return null;
    const p = spoofed(raw), sigma = Math.max(4, raw.acc / 1.5);   // phones report a 68 % radius
    const note = state.gps.spoof === 'off' ? '' : ` · pulled ${G.fmtDist(p.off)} off (simulated spoof)`;
    return { id: 'gps', type: 'gps', kind: 'point', lat: p.lat, lon: p.lon, sigma, label: 'GPS',
      suspect: Date.now() < state.gps.suspectUntil, detail: `±${G.fmtDist(2 * sigma)}${note}` };
  }

  function toggleGps() {
    const gs = state.gps;
    if (gs.on) {
      if (gs.watch != null) navigator.geolocation.clearWatch(gs.watch);
      Object.assign(gs, { on: false, watch: null, raw: null, prev: null, spoof: 'off', suspectUntil: 0, jumpMsg: '' });
      refreshButtons(); schedule();
      return;
    }
    if (!('geolocation' in navigator)) { toast('This browser cannot read GPS.'); return; }
    gs.on = true;
    refreshButtons();
    toast('Waiting for GPS…');
    let first = true;
    gs.watch = navigator.geolocation.watchPosition((pos) => {
      gs.raw = { lat: pos.coords.latitude, lon: pos.coords.longitude, acc: pos.coords.accuracy || 30 };
      speedCheck();
      if (first) {
        first = false;
        toast(`GPS fix: ±${G.fmtDist(gs.raw.acc)}`);
        if (!state.story) flyToVisible([gs.raw.lat, gs.raw.lon], Math.max(map.getZoom(), 15));
      }
      schedule();
    }, (err) => toast('GPS: ' + err.message), { enableHighAccuracy: true, maximumAge: 2000, timeout: 30000 });
  }

  // A position that moves faster than you possibly can is a lie, whatever the other witnesses say
  function speedCheck() {
    const gs = state.gps, now = Date.now(), p = spoofed(gs.raw), prev = gs.prev;
    gs.prev = { lat: p.lat, lon: p.lon, t: now, acc: gs.raw.acc };
    if (!prev) return;
    const d = G.dist(prev.lat, prev.lon, p.lat, p.lon), dt = Math.max(1, (now - prev.t) / 1000), m = MODES[state.mode];
    if (d > 3 * (prev.acc + gs.raw.acc) + 20 && d / dt > 1.5 * m.maxSpeed) {
      gs.suspectUntil = now + 60000;
      gs.jumpMsg = `⚠ GPS jumped ${G.fmtDist(d)} in ${Math.round(dt)} s. Nobody can ${m.verb} that fast.`;
    }
  }

  function cycleSpoof() {
    const gs = state.gps;
    if (!gs.on || !gs.raw) { toast('Turn on GPS first and wait for a fix, then spoof it.'); return; }
    gs.spoof = { off: 'drag', drag: 'jump', jump: 'off' }[gs.spoof];
    gs.spoofT0 = Date.now();
    if (gs.spoof === 'off') { gs.prev = null; gs.suspectUntil = 0; gs.jumpMsg = ''; }
    toast({
      drag: 'Simulated spoofing: GPS is slowly dragged away at 3 m/s. Add witnesses and watch.',
      jump: 'Simulated spoofing: GPS jumps 120 km away.',
      off: 'Spoofing off.',
    }[gs.spoof], 5000);
    speedCheck();
    refreshButtons(); schedule();
  }

  setInterval(() => {
    if (!state.story && state.gps.on && state.gps.raw && state.gps.spoof === 'drag') { speedCheck(); schedule(); }
  }, 1000);

  // ---------- compass ----------
  function correctedBearing(mag) {
    const ref = refPoint();
    const decl = G.inFinland(ref.lat, ref.lon) ? G.declination(ref.lat, ref.lon) : 0;
    return G.wrap360(mag + decl + state.compassOffset);
  }
  function trustedGps() {
    const gs = state.gps;
    if (!gs.on || !gs.raw || gs.spoof !== 'off' || Date.now() < gs.suspectUntil || gs.raw.acc > 30) return null;
    return gs.raw;
  }

  // ---------- "I'm about here" ----------
  function startYou() {
    if (state.story) return;
    state.pending = 'you';
    const chips = [200, 1000, 5000].map((r) =>
      `<button class="chip ${r === state.youRadius ? 'on' : ''}" data-r="${r}">±${G.fmtDist(r)}</button>`).join('');
    toastHTML(`<b>Tap the map where you think you are.</b><div class="chips">${chips}<button class="chip" data-cancel="1">Cancel</button></div>`, 0);
    collapseSheet();
  }
  $('toast').addEventListener('click', (e) => {
    const b = e.target.closest('.chip');
    if (!b) return;
    if (b.dataset.cancel) { state.pending = null; hideToast(); return; }
    if (b.dataset.pick) {
      state.pending = 'landmark';
      toast('Tap the map exactly where the landmark is (a tower, church, chimney, hill top…).', 0);
      collapseSheet();
      return;
    }
    state.youRadius = +b.dataset.r;
    $('toast').querySelectorAll('.chip[data-r]').forEach((c) => c.classList.toggle('on', c === b));
  });
  map.on('click', (e) => {
    const what = state.pending;
    if (!what) return;
    if (what === 'angleA' || what === 'angleB') {
      // no mapped landmark there: use the tapped spot as one
      const lm = addLandmark({ lat: e.latlng.lat, lon: e.latlng.lng, name: 'My landmark', kind: 'Landmark', icon: '📌' });
      drawLandmarks();
      onLandmarkClick(lm);
      return;
    }
    state.pending = null;
    hideToast();
    if (what === 'you') {
      addWitness({ type: 'you', kind: 'point', lat: e.latlng.lat, lon: e.latlng.lng, sigma: state.youRadius / 2,
        label: 'I’m about here', detail: `your guess · ±${G.fmtDist(state.youRadius)}` });
    } else if (what === 'landmark') {
      const lm = addLandmark({ lat: e.latlng.lat, lon: e.latlng.lng, name: 'My landmark', kind: 'Landmark', icon: '📌' });
      drawLandmarks();
      aimAtLandmark(lm);
    }
  });

  // ---------- landmarks ----------
  // Offer the no-network way too: you can always mark a landmark's spot on the map yourself
  function offerPick(msg) {
    toastHTML('<span></span><div class="chips"><button class="chip" data-pick="1">📌 Mark a landmark on the map myself</button></div>', 8000);
    $('toast').querySelector('span').textContent = msg;
  }

  // Load landmarks around the map view once; returns false if there are none to tap
  async function loadLandmarks() {
    if (state.landmarks.length) return true;
    if (map.getZoom() < 13) { offerPick('Zoom in to your area first, so I can search nearby.'); return false; }
    toast('Searching OpenStreetMap for towers, churches, chimneys and hill tops… (can take 20 s)', 0);
    try {
      state.landmarks = await OSM.landmarks(viewBounds());
      drawLandmarks();
      schedule();
      if (!state.landmarks.length) { offerPick('No landmarks are mapped here.'); return false; }
      return true;
    } catch (e) {
      offerPick(`OpenStreetMap is busy right now (${e.message}).`);
      return false;
    }
  }

  async function actLandmark() {
    if (state.story) return;
    const had = state.landmarks.length;
    if (!(await loadLandmarks())) return;
    offerPick(had ? 'Tap a landmark you can see (🗼 ⛪ 🏭 ⛰️ 📡).' : `Found ${state.landmarks.length}. Tap one you can see.`);
    collapseSheet();
  }

  // Tapping a landmark: normally aim at it; while measuring an angle, it picks A or B
  function onLandmarkClick(lm) {
    if (state.pending === 'angleA') {
      state.angleA = lm;
      state.pending = 'angleB';
      angleToast(`A = ${lm.name}. Now tap landmark B, ideally 30–120° to the side of A.`);
      return;
    }
    if (state.pending === 'angleB') {
      if (lm === state.angleA) return;
      state.pending = null;
      hideToast();
      aimAngle(state.angleA, lm);
      return;
    }
    aimAtLandmark(lm);
  }

  // ---------- angle between two landmarks ----------
  // Aim at A, turn on the spot to B: the gyroscope measures the turn. No compass is involved, so
  // magnets, metal and a badly calibrated compass can't spoil it. All places that see A and B this
  // far apart lie on a circle through A and B; two such angles (three landmarks) give a fix.
  function angleToast(msg) {
    toastHTML('<span></span><div class="chips"><button class="chip" data-cancel="1">Cancel</button></div>', 0);
    $('toast').querySelector('span').textContent = msg;
  }

  async function actAngle() {
    if (state.story) return;
    if (!(await loadLandmarks())) return;
    state.pending = 'angleA';
    state.angleA = null;
    angleToast('Angle between two landmarks: tap landmark A (or tap the map where it is).');
    collapseSheet();
  }

  function aimAngle(a, b) {
    openAim({
      mode: 'angle', lm: a, a, b, step: 1, name: `${a.name} ↔ ${b.name}`, title: `1/2 · Aim at ${a.name}`,
      hint: 'Put the red cross on A and press 📸. Then turn on the spot (don’t walk) to B and press 📸 again.',
      onLock: (r) => {
        addWitness({ type: 'angle', kind: 'angle', a: { lat: a.lat, lon: a.lon }, b: { lat: b.lat, lon: b.lon },
          ang: r.value, sigma: r.sigma, photo: r.photo, lmIds: [a.id, b.id], label: `${a.name} ↔ ${b.name}`,
          detail: `${r.source === 'tool' ? 'sextant' : 'gyroscope'} · ${Math.abs(r.value).toFixed(1)}° ${r.value >= 0 ? 'right' : 'left'} from A to B · ±${+(2 * r.sigma).toFixed(1)}°` });
        drawLandmarks();
      },
    });
  }

  function drawLandmarks() {
    layer.marks.clearLayers();
    if (state.story || state.replay) return;
    for (const lm of state.landmarks) {
      const used = state.witnesses.some((w) => w.lmId === lm.id || (w.lmIds && w.lmIds.includes(lm.id)));
      const cls = 'lm-icon' + (used ? ' used' : '') + (lm.heard ? ' heard' : '') + (state.suggestId === lm.id ? ' suggest' : '');
      L.marker([lm.lat, lm.lon], { icon: L.divIcon({ className: cls, html: `<span>${lm.icon}</span>`, iconSize: [30, 30], iconAnchor: [15, 15] }) })
        .bindTooltip(lm.heard ? `${lm.name} · your phone hears it` : lm.name, { direction: 'top', offset: [0, -14] })
        .on('click', () => onLandmarkClick(lm))
        .addTo(layer.marks);
    }
  }

  function aimAtLandmark(lm) {
    if (state.story) return;
    const ref = refPoint(), gpsOk = trustedGps();
    const dir = G.compass8(G.bearing(ref.lat, ref.lon, lm.lat, lm.lon));
    openAim({
      mode: 'bearing', lm, name: lm.name, title: `Aim at ${lm.name}`, calibrate: !!gpsOk,
      hint: `Put the red cross on it, hold still for a second, then 📸. It should be roughly ${dir} of you.`,
      onLock: (r) => {
        if (r.calibrate && gpsOk) {
          const truth = G.bearing(gpsOk.lat, gpsOk.lon, lm.lat, lm.lon);
          state.compassOffset = G.wrap180(state.compassOffset + truth - r.value);
          state.compassCalibrated = true;
          toast(`Compass calibrated against GPS: correction ${state.compassOffset >= 0 ? '+' : ''}${state.compassOffset.toFixed(1)}°.`);
          return;
        }
        addWitness({ type: 'landmark', kind: 'bearing', lat: lm.lat, lon: lm.lon, brg: r.value, sigma: r.sigma, lmId: lm.id,
          photo: r.photo, label: lm.name,
          detail: `${lm.kind.toLowerCase()} · ${r.source === 'hand' ? 'hand compass' : 'phone compass'} ${Math.round(r.value)}° · ±${+(2 * r.sigma).toFixed(1)}°` });
        drawLandmarks();
      },
    });
  }

  // ---------- sky ----------
  function actSky() {
    if (state.story) return;
    const ref = refPoint(), vis = SKY.visible(ref.lat, ref.lon, new Date());
    const items = vis.map((b) => ({
      html: `<b>${b.name}</b><small>${G.compass8(b.az)}, ${Math.round(b.alt)}° up</small>`,
      onPick: () => aimAtSky(b),
    }));
    openPicker('What can you see in the sky?', items, vis.length
      ? 'Pick one, then aim the phone at it. The angle above the horizon tells which ring on Earth you are on.'
      : 'Nothing bright is up right now: the Sun is down and it is not dark enough for stars yet.');
  }

  function aimAtSky(b) {
    openAim({
      mode: 'elev', body: b.id, name: b.name, title: `Aim at ${b.name}`,
      hint: (b.id === 'sun' ? 'Never look straight at the Sun: aim the phone, look at the screen. ' : '') +
        `Look ${G.compass8(b.az)}, about ${Math.round(b.alt)}° up. Put the red cross on it, hold still, then 📸.`,
      onLock: (r) => {
        const trueAlt = r.value - SKY.refraction(r.value);
        addWitness({ type: 'sky', kind: 'sky', body: b.id, time: new Date(), alt: trueAlt, sigma: r.sigma, photo: r.photo, label: b.name,
          detail: `${r.value.toFixed(1)}° above the horizon · ${r.source === 'tool' ? 'inclinometer' : 'phone tilt'} · ±${(2 * r.sigma).toFixed(1)}°` });
      },
    });
  }

  // ---------- cell towers (simulated: a web page cannot read them) ----------
  // Every mast nearby is a landmark you can see and aim at. Only the few your phone "hears" become ring
  // witnesses: the nearest is the serving cell, whose timing advance gives a fairly good distance; the
  // neighbours only give signal strength, which is a much rougher distance.
  async function actTowers() {
    if (state.story) return;
    const truth = state.gps.raw;
    if (!truth) {
      toast('Turn on GPS once first. Browsers can’t read cell towers, so this simulates what your phone would hear around your real position.', 7000);
      return;
    }
    toast('Looking up masts near you…', 0);
    try {
      const all = (await OSM.masts(truth.lat, truth.lon, 6000))
        .map((m) => Object.assign(m, { d: G.dist(truth.lat, truth.lon, m.lat, m.lon) }))
        .filter((m) => m.d > 50).sort((a, b) => a.d - b.d).slice(0, 40);    // the nearest 40 keep the map readable
      if (!all.length) { toast('No masts are mapped near you.'); return; }
      // in range: the nearest mast, plus neighbours up to twice as far (at least 2 km), at most 4
      const heard = all.filter((m) => m.d <= Math.max(2000, 2 * all[0].d)).slice(0, 4);
      state.landmarks.forEach((lm) => { lm.heard = false; });
      for (const m of all) addLandmark({ lat: m.lat, lon: m.lon, name: m.name, kind: 'Mast', icon: '📡' }).heard = heard.includes(m);
      state.witnesses = state.witnesses.filter((w) => w.type !== 'tower');
      heard.forEach((m, i) => {
        const serving = i === 0;
        const sigma = serving ? Math.max(120, 0.08 * m.d) : Math.max(250, 0.35 * m.d);
        const r = Math.max(50, m.d + 1.2 * sigma * noise(m.lat, m.lon));   // a made-up error, the same every time
        addWitness({ type: 'tower', kind: 'range', lat: m.lat, lon: m.lon, r, sigma,
          label: `${serving ? 'Serving' : 'Neighbour'} cell (simulated)`,
          detail: `${serving ? 'timing advance' : 'signal strength'} · about ${G.fmtDist(r)} away · ±${G.fmtDist(2 * sigma)}` });
      });
      drawLandmarks();
      toast(`${all.length} masts nearby. Your phone hears ${heard.length} of them (simulated), so only those get a ring.`, 6000);
    } catch (e) {
      toast('Could not reach OpenStreetMap (' + e.message + ').');
    }
  }

  // ---------- save an area for offline use ----------
  // Saves a 6 × 6 km area around the map's centre (3 × 3 km with roads in Drive mode, since roads are big)
  async function actSave() {
    if (state.story) return;
    const withRoads = state.mode === 'drive', c = map.getCenter();
    const b = OSM.around(c.lat, c.lng, withRoads ? 1500 : 3000);
    toast(`Saving landmarks, masts and lakes${withRoads ? ' and roads' : ''} around the map's centre for offline use… (can take a minute)`, 0);
    try {
      const r = await OSM.saveArea(b, withRoads);
      toast(`Saved for offline: ${r.landmarks} landmarks (${r.masts} masts) and ${r.lakes} lakes${withRoads ? `, ${r.roads} roads` : ''}. ` +
        'Map pictures are kept only for places you have already looked at.', 9000);
    } catch (e) {
      toast(`Could not save (${e.message}). Try again in a minute.`, 6000);
    }
  }

  // Add a landmark unless one is already within 30 m; returns the landmark that is on the map
  function addLandmark(lm) {
    const dup = state.landmarks.find((o) => G.dist(o.lat, o.lon, lm.lat, lm.lon) < 30);
    if (dup) return dup;
    const n = Object.assign({ id: 'lm' + state.nextId++, named: lm.name !== 'Mast' }, lm);
    state.landmarks.push(n);
    return n;
  }

  // Repeatable pseudo-random number in [-1, 1] for a place
  function noise(lat, lon) {
    const s = Math.sin(lat * 12.9898 + lon * 78.233) * 43758.5453;
    return 2 * (s - Math.floor(s)) - 1;
  }

  // ---------- aiming view: the camera (or a simulated view for demos), then a review before it counts ----------
  let aim = null, camStream = null, aimRaf = 0, simTimer = 0;
  const sim = { on: false, heading: 0, pitch: 0, drag: null };

  async function openAim(opts) {
    aim = Object.assign({ shot: null, source: 'phone' }, opts);
    $('aimTitle').textContent = opts.title;
    $('aimHint').textContent = opts.hint || '';
    $('aimBrgLabel').textContent = opts.mode === 'angle' ? 'Turned from A (gyroscope)' : 'Direction (true)';
    $('aimPanel').classList.remove('hidden');
    $('review').classList.add('hidden');
    $('aim').classList.remove('hidden');
    // the simulated view starts pointing a little to one side, so you have to find the target yourself
    const t = simTarget();
    sim.heading = G.wrap360(t.az + (Math.random() < 0.5 ? -1 : 1) * (15 + Math.random() * 20));
    sim.pitch = opts.mode === 'elev' ? Math.max(0, t.alt - 6) : 0;
    setSim(false);
    cancelAnimationFrame(aimRaf);
    readout();
    const sensorsOk = await SEN.start();
    let camOk = false;
    try {
      camStream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: { ideal: 'environment' } }, audio: false });
      if (aim) { $('cam').srcObject = camStream; camOk = true; } else stopCamera();
    } catch (e) { /* no camera here */ }
    if (!aim) return;
    if (!camOk) setSim(true);
    // no compass or tilt readings after a moment (e.g. on a laptop): switch to the simulated view
    clearTimeout(simTimer);
    simTimer = setTimeout(() => {
      if (aim && !sim.on && (!sensorsOk || !SEN.alive())) {
        setSim(true);
        toast('No compass or tilt sensor here, so this is a simulated view. Drag it to turn.');
      }
    }, 1500);
  }

  function setSim(on) {
    sim.on = on;
    $('simView').classList.toggle('hidden', !on);
    $('cam').classList.toggle('hidden', on);
    $('simToggle').textContent = on ? '📷 Use camera' : '🎮 Simulated view';
  }

  // Where the simulated camera stands: your real position (even while GPS is spoofed), else Alibi's guess
  function simFrom() {
    if (state.gps.raw) return state.gps.raw;
    if (state.result && state.result.est) return state.result.est;
    const c = map.getCenter();
    return { lat: c.lat, lon: c.lng };
  }

  function simTarget() {
    const from = simFrom(), now = new Date();
    if (aim.mode === 'elev') {
      const p = SKY.radec(aim.body, now), a = SKY.altAz(p.ra, p.dec, from.lat, from.lon, now);
      return { az: a.az, alt: a.alt + SKY.refraction(a.alt) };
    }
    return { az: G.bearing(from.lat, from.lon, aim.lm.lat, aim.lm.lon), alt: 0 };
  }

  // What the phone measures right now: true bearing (compass), gyroscope heading (its own zero), angle above the horizon
  function reading() {
    if (sim.on) return { heading: sim.heading, rel: sim.heading, elev: sim.pitch };
    const c = SEN.alive() ? SEN.current() : null;
    if (!c) return null;
    const heading = c.heading != null ? correctedBearing(c.heading) : null;
    return { heading, rel: c.rel != null ? c.rel : heading, elev: c.elev };
  }

  function readout() {
    const r = reading();
    if (aim && aim.mode === 'angle') {
      const turned = aim.step === 2 && r && r.rel != null && aim.first.yaw != null ? G.wrap180(r.rel - aim.first.yaw) : null;
      $('aimBrg').textContent = turned == null ? (aim.step === 1 ? 'aim at A' : '—') : `${turned >= 0 ? '+' : ''}${turned.toFixed(1)}°`;
    } else {
      $('aimBrg').textContent = r && r.heading != null ? `${Math.round(r.heading)}° ${G.compass8(r.heading)}` : '—';
    }
    $('aimAlt').textContent = r && r.elev != null ? `${r.elev.toFixed(1)}°` : '—';
    if (sim.on && aim) drawSimView();
    aimRaf = requestAnimationFrame(readout);
  }

  function stopCamera() {
    if (camStream) { camStream.getTracks().forEach((t) => t.stop()); camStream = null; }
    $('cam').srcObject = null;
  }

  function closeAim() {
    $('aim').classList.add('hidden');
    cancelAnimationFrame(aimRaf);
    clearTimeout(simTimer);
    aim = null;
    stopCamera();
  }

  // 📸 Take: freeze the picture and the reading, then let the user check and correct it
  function takeShot() {
    if (!aim) return;
    if (aim.mode === 'angle') { takeAngleShot(); return; }
    let value = null, spread = 0;
    if (sim.on) value = aim.mode === 'bearing' ? sim.heading : sim.pitch;
    else {
      const avg = SEN.alive() ? SEN.average(1500) : null;
      if (avg && aim.mode === 'bearing' && avg.heading != null) { value = correctedBearing(avg.heading); spread = avg.headSpread || 0; }
      else if (avg && aim.mode === 'elev') { value = avg.elev; spread = avg.elevSpread || 0; }
    }
    aim.shot = { photo: capturePhoto(), value, spread, simulated: sim.on };
    aim.source = 'phone';
    showReview();
  }

  function crosshair(ctx, x, y) {
    ctx.strokeStyle = '#ff3b30';
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.moveTo(x - 14, y); ctx.lineTo(x + 14, y);
    ctx.moveTo(x, y - 14); ctx.lineTo(x, y + 14);
    ctx.stroke();
  }

  // Angle: the first 📸 remembers where A is (gyroscope heading), the second measures how far you turned to B
  function takeAngleShot() {
    let yaw = null, spread = 0;
    if (sim.on) yaw = sim.heading;
    else {
      const avg = SEN.alive() ? SEN.average(1000) : null;
      if (avg && avg.rel != null) { yaw = avg.rel; spread = avg.relSpread || 0; }
      else if (avg && avg.heading != null) { yaw = correctedBearing(avg.heading); spread = avg.headSpread || 0; }
    }
    const shot = { yaw, spread, canvas: captureCanvas() };
    if (aim.step === 1) {
      aim.first = shot;
      aim.step = 2;
      aim.lm = aim.b;
      $('aimTitle').textContent = `2/2 · Now turn to ${aim.b.name}`;
      $('aimHint').textContent = 'Turn on the spot (don’t walk) until the red cross is on B, then 📸.';
      toast(`A is saved. Now turn to ${aim.b.name}.`);
      return;
    }
    const value = aim.first.yaw != null && yaw != null ? G.wrap180(yaw - aim.first.yaw) : null;
    aim.shot = { photo: pairPhoto(aim.first.canvas, shot.canvas), value, spread: Math.hypot(aim.first.spread, spread), simulated: sim.on };
    aim.source = 'phone';
    showReview();
  }

  // Switching between camera and simulated view mid-angle mixes two different zeros: start the angle again
  function restartAngle() {
    if (!aim || aim.mode !== 'angle' || aim.step === 1) return;
    aim.step = 1;
    aim.lm = aim.a;
    aim.first = null;
    $('aimTitle').textContent = `1/2 · Aim at ${aim.a.name}`;
    $('aimHint').textContent = 'Put the red cross on A and press 📸. Then turn on the spot (don’t walk) to B and press 📸 again.';
  }

  // A 4:3 picture around the crosshair, from the camera or the simulated view
  function captureCanvas() {
    const el = sim.on ? $('simView') : $('cam');
    const sw = sim.on ? el.width : el.videoWidth, sh = sim.on ? el.height : el.videoHeight;
    if (!sw || !sh) return null;
    const scale = Math.max(el.clientWidth / sw, el.clientHeight / sh);     // the screen shows it "object-fit: cover"
    const visW = el.clientWidth / scale, visH = el.clientHeight / scale;
    const cx = (sw - visW) / 2 + visW / 2, cy = (sh - visH) / 2 + visH * 0.42;
    let cw = visW, ch = cw * 3 / 4;
    if (ch > visH) { ch = visH; cw = ch * 4 / 3; }
    const x0 = Math.max(0, Math.min(sw - cw, cx - cw / 2)), y0 = Math.max(0, Math.min(sh - ch, cy - ch / 2));
    const out = document.createElement('canvas');
    out.width = 320; out.height = 240;
    const ctx = out.getContext('2d');
    ctx.drawImage(el, x0, y0, cw, ch, 0, 0, 320, 240);
    crosshair(ctx, (cx - x0) / cw * 320, (cy - y0) / ch * 240);
    return out;
  }

  function capturePhoto() {
    const c = captureCanvas();
    try { return c ? c.toDataURL('image/jpeg', 0.75) : null; } catch (e) { return null; }
  }

  // The two shots of an angle side by side, A on the left and B on the right
  function pairPhoto(c1, c2) {
    const out = document.createElement('canvas');
    out.width = 320; out.height = 240;
    const ctx = out.getContext('2d');
    ctx.fillStyle = '#000';
    ctx.fillRect(0, 0, 320, 240);
    [c1, c2].forEach((c, i) => { if (c) ctx.drawImage(c, 80, 0, 160, 240, i * 160, 0, 160, 240); });
    ctx.fillStyle = '#fff';
    ctx.fillRect(159, 0, 2, 240);
    ctx.font = '700 16px system-ui, sans-serif';
    ctx.textAlign = 'left';
    for (const [t, x] of [['A', 6], ['B', 166]]) {
      ctx.fillStyle = 'rgba(0,0,0,.55)';
      ctx.fillRect(x - 2, 4, 22, 22);
      ctx.fillStyle = '#fff';
      ctx.fillText(t, x + 3, 21);
    }
    try { return out.toDataURL('image/jpeg', 0.75); } catch (e) { return null; }
  }

  // Where a reading comes from, and how far to trust it (± in degrees, about 95 %)
  const SOURCES = {
    bearing: [
      { id: 'phone', label: '📱 Phone compass', pm: () => (state.compassCalibrated ? 4 : 7) },
      { id: 'hand', label: '🧭 Hand compass', pm: () => 3 },
    ],
    elev: [
      { id: 'phone', label: '📱 Phone tilt', pm: () => 1 },
      { id: 'tool', label: '📐 Inclinometer / sextant', pm: () => 0.4 },
    ],
    angle: [
      { id: 'phone', label: '📱 Phone gyroscope', pm: () => 2 },
      { id: 'tool', label: '📐 Sextant / protractor', pm: () => 0.4 },
    ],
  };

  function declHere() {
    const r = refPoint();
    return G.inFinland(r.lat, r.lon) ? G.declination(r.lat, r.lon) : 0;
  }

  function showReview() {
    const s = aim.shot;
    $('aimPanel').classList.add('hidden');
    $('review').classList.remove('hidden');
    $('reviewImg').src = s.photo || '';
    $('reviewImg').classList.toggle('hidden', !s.photo);
    $('reviewTitle').textContent = aim.name;
    $('reviewNote').textContent = s.value == null ? 'No sensor reading here, so type the value.'
      : aim.mode === 'angle' ? (s.simulated ? 'Simulated gyroscope reading: how far you turned from A to B.' : 'Gyroscope reading: how far you turned from A to B.')
        : s.simulated ? 'Simulated phone reading. Fix it below, or switch to a hand compass.'
          : 'Phone reading. Fix it below if you measured it better another way.';
    $('reviewValue').value = s.value == null ? '' : s.value.toFixed(1);
    $('reviewPm').value = SOURCES[aim.mode][0].pm();
    $('reviewCalibRow').classList.toggle('hidden', !(aim.mode === 'bearing' && aim.calibrate && !s.simulated));
    $('reviewCalib').checked = false;
    renderSources();
    updateReviewNote();
  }

  function renderSources() {
    const box = $('reviewSource');
    box.innerHTML = '';
    for (const src of SOURCES[aim.mode]) {
      const b = document.createElement('button');
      b.textContent = src.label;
      b.className = src.id === aim.source ? 'on' : '';
      b.onclick = () => switchSource(src.id);
      box.appendChild(b);
    }
  }

  // The phone shows true bearings (declination already added); a hand compass shows magnetic ones
  function switchSource(id) {
    if (id === aim.source) return;
    const v = parseFloat($('reviewValue').value);
    if (aim.mode === 'bearing' && !isNaN(v)) {
      $('reviewValue').value = G.wrap360(id === 'hand' ? v - declHere() : v + declHere()).toFixed(1);
    }
    aim.source = id;
    $('reviewPm').value = SOURCES[aim.mode].find((s) => s.id === id).pm();
    renderSources();
    updateReviewNote();
  }

  // The value the engine will use: a true bearing, an angle above the horizon, or a turn from A to B
  function reviewValue() {
    const v = parseFloat($('reviewValue').value);
    if (isNaN(v)) return null;
    if (aim.mode === 'bearing') return G.wrap360(aim.source === 'hand' ? v + declHere() : v);
    if (aim.mode === 'angle') return G.wrap180(v);
    return v;
  }

  function updateReviewNote() {
    let txt;
    if (aim.mode === 'elev') txt = 'Angle above the horizon. Air bends starlight a little; that is corrected automatically.';
    else if (aim.mode === 'angle') {
      const v = reviewValue();
      txt = v == null ? 'Type the angle from A to B (plus = B is to the right of A).'
        : `From A, turn ${Math.abs(v).toFixed(1)}° to the ${v >= 0 ? 'right' : 'left'} to see B. No compass involved, so magnets can't spoil it.`;
    } else if (aim.source === 'hand') {
      const v = reviewValue();
      txt = v == null ? 'Type what your compass shows (magnetic north).'
        : `Compass reading + declination ${declHere().toFixed(1)}° = true bearing ${v.toFixed(1)}° (${G.compass8(v)}).`;
    } else txt = 'True bearing: magnetic declination' + (state.compassOffset ? ` and your calibration (${state.compassOffset.toFixed(1)}°)` : '') + ' already added.';
    $('reviewTrue').textContent = txt;
  }

  function addFromReview() {
    const v = reviewValue();
    if (v == null) { toast('Type the angle first.'); return; }
    const pm = parseFloat($('reviewPm').value);
    let sigma = Math.max({ bearing: 0.25, angle: 0.1, elev: 0.05 }[aim.mode], (isNaN(pm) ? 2 : pm) / 2);
    if (aim.source === 'phone' && aim.shot.value != null && !aim.shot.simulated) sigma = Math.max(sigma, aim.shot.spread);  // shaky hands count too
    const r = { value: v, sigma, source: aim.source, photo: aim.shot.photo, calibrate: $('reviewCalib').checked && aim.source === 'phone' };
    const cb = aim.onLock;
    closeAim();
    cb(r);
  }

  // ---------- simulated camera picture (demo mode, and the photos in the Lapland story) ----------
  const LM_HEIGHT = { Tower: 45, 'Water tower': 40, Chimney: 80, Mast: 70, Church: 45, Lighthouse: 30, 'Hill top': 120, Landmark: 40 };
  const ridge = (az) => 0.8 + 0.6 * Math.sin(az * 0.05) + 0.35 * Math.sin(az * 0.17 + 1.3) + 0.2 * Math.sin(az * 0.43 + 2.1);

  function tag(ctx, text, x, y, strong) {
    ctx.font = `${strong ? 700 : 600} ${strong ? 14 : 12}px system-ui, sans-serif`;
    const w = ctx.measureText(text).width + 12;
    ctx.fillStyle = strong ? 'rgba(220,38,38,.92)' : 'rgba(15,23,42,.62)';
    ctx.fillRect(x - w / 2, y - 15, w, 20);
    ctx.fillStyle = '#fff';
    ctx.textAlign = 'center';
    ctx.fillText(text, x, y);
  }

  // v: { from, heading, pitch, time, landmarks, target | targetName, body }
  function drawView(ctx, W, H, v) {
    const hfov = W >= H ? 62 : 48, k = W / hfov;            // pixels per degree
    const cx = W / 2, cy = H * 0.42, horizon = cy + v.pitch * k;
    const sx = (az) => cx + G.wrap180(az - v.heading) * k;
    const sp = SKY.radec('sun', v.time), sunAlt = SKY.altAz(sp.ra, sp.dec, v.from.lat, v.from.lon, v.time).alt;
    const night = sunAlt < -6, dusk = !night && sunAlt < 2;

    const skyGrad = ctx.createLinearGradient(0, horizon - H, 0, horizon);
    const cols = night ? ['#020617', '#1e293b'] : dusk ? ['#1e3a8a', '#fb923c'] : ['#1d4ed8', '#bfdbfe'];
    skyGrad.addColorStop(0, cols[0]); skyGrad.addColorStop(1, cols[1]);
    ctx.fillStyle = skyGrad;
    ctx.fillRect(0, 0, W, H);

    // stars and the Sun where you would see them (air lifts them slightly: refraction)
    const bodies = [];
    if (night || dusk) for (const s of SKY.STARS) bodies.push({ id: s.id, name: s.name, mag: s.mag });
    if (sunAlt > -1) bodies.push({ id: 'sun', name: 'Sun', mag: -26 });
    for (const b of bodies) {
      const p = SKY.radec(b.id, v.time), a = SKY.altAz(p.ra, p.dec, v.from.lat, v.from.lon, v.time);
      const alt = a.alt + SKY.refraction(a.alt), x = sx(a.az), y = horizon - alt * k;
      if (alt < -1 || x < -40 || x > W + 40 || y < -40 || y > H + 40) continue;
      if (b.id === 'sun') {
        const r = Math.max(8, 0.27 * k), glow = ctx.createRadialGradient(x, y, 0, x, y, r * 4);
        glow.addColorStop(0, 'rgba(255,244,200,1)'); glow.addColorStop(0.3, 'rgba(255,220,120,.55)'); glow.addColorStop(1, 'rgba(255,220,120,0)');
        ctx.fillStyle = glow; ctx.beginPath(); ctx.arc(x, y, r * 4, 0, 7); ctx.fill();
        ctx.fillStyle = '#fffbeb'; ctx.beginPath(); ctx.arc(x, y, r, 0, 7); ctx.fill();
      } else {
        const r = Math.max(1.2, 3.4 - 0.9 * b.mag);
        ctx.fillStyle = 'rgba(255,255,255,.22)'; ctx.beginPath(); ctx.arc(x, y, r * 2.6, 0, 7); ctx.fill();
        ctx.fillStyle = '#fff'; ctx.beginPath(); ctx.arc(x, y, r, 0, 7); ctx.fill();
      }
      if (v.body === b.id) tag(ctx, b.name, x, y - 14, true);
      else if (b.mag < 0.6) tag(ctx, b.name, x, y - 10, false);
    }

    // distant hills that turn with you, then the ground
    ctx.fillStyle = night ? '#0f172a' : '#64748b';
    ctx.beginPath();
    ctx.moveTo(0, H);
    for (let x = 0; x <= W; x += 4) ctx.lineTo(x, horizon - ridge(v.heading + (x - cx) / k) * k * 0.6);
    ctx.lineTo(W, H);
    ctx.closePath();
    ctx.fill();
    const ground = ctx.createLinearGradient(0, horizon, 0, H);
    ground.addColorStop(0, night ? '#111827' : '#4d7c0f'); ground.addColorStop(1, night ? '#030712' : '#1a2e05');
    ctx.fillStyle = ground;
    ctx.fillRect(0, horizon, W, Math.max(0, H - horizon));

    // compass marks along the horizon
    ctx.fillStyle = 'rgba(255,255,255,.8)';
    ctx.font = '600 12px system-ui, sans-serif';
    ctx.textAlign = 'center';
    for (let a = Math.ceil((v.heading - hfov / 2) / 10) * 10; a <= v.heading + hfov / 2; a += 10) {
      const x = sx(a), deg = Math.round(G.wrap360(a)), major = deg % 30 === 0;
      ctx.fillRect(x - 0.5, horizon + 2, 1, major ? 10 : 5);
      if (major) ctx.fillText(deg % 90 === 0 ? 'NESW'[deg / 90] : String(deg), x, horizon + 25);
    }

    // landmarks: a post with the icon on top, nearer ones bigger
    for (const lm of v.landmarks) {
      const d = G.dist(v.from.lat, v.from.lon, lm.lat, lm.lon);
      if (d < 30 || d > 15000) continue;
      const x = sx(G.bearing(v.from.lat, v.from.lon, lm.lat, lm.lon));
      if (x < -60 || x > W + 60) continue;
      const top = horizon - Math.atan2(LM_HEIGHT[lm.kind] || 40, d) * G.R2D * k;
      const size = Math.max(14, Math.min(56, 2400 / Math.sqrt(d)));
      ctx.fillStyle = night ? '#475569' : '#1f2937';
      ctx.fillRect(x - 1.5, top, 3, Math.max(0, horizon - top));
      ctx.font = `${size}px serif`;
      ctx.textAlign = 'center';
      ctx.fillText(lm.icon || '🗼', x, top + size * 0.15);
      const isTarget = v.target === lm || (v.targetName && v.targetName === lm.name);
      if (isTarget || d < 2500) tag(ctx, `${lm.name} · ${G.fmtDist(d)}`, x, top - size - 2, isTarget);
    }
  }

  function drawSimView() {
    const cv = $('simView'), dpr = window.devicePixelRatio || 1, W = cv.clientWidth, H = cv.clientHeight;
    if (!W || !H) return;
    if (cv.width !== Math.round(W * dpr) || cv.height !== Math.round(H * dpr)) { cv.width = Math.round(W * dpr); cv.height = Math.round(H * dpr); }
    const ctx = cv.getContext('2d');
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    drawView(ctx, W, H, { from: simFrom(), heading: sim.heading, pitch: sim.pitch, time: new Date(),
      landmarks: state.landmarks, target: aim.lm, body: aim.body });
  }

  // drag the simulated view to turn around (like Street View); arrow keys for fine steps
  const simCv = $('simView');
  const simK = () => simCv.clientWidth / (simCv.clientWidth >= simCv.clientHeight ? 62 : 48);
  simCv.addEventListener('pointerdown', (e) => {
    sim.drag = { x: e.clientX, y: e.clientY, h: sim.heading, p: sim.pitch };
    simCv.setPointerCapture(e.pointerId);
  });
  simCv.addEventListener('pointermove', (e) => {
    if (!sim.drag) return;
    sim.heading = G.wrap360(sim.drag.h - (e.clientX - sim.drag.x) / simK());
    sim.pitch = Math.max(-20, Math.min(85, sim.drag.p + (e.clientY - sim.drag.y) / simK()));
  });
  const endDrag = () => { sim.drag = null; };
  simCv.addEventListener('pointerup', endDrag);
  simCv.addEventListener('pointercancel', endDrag);

  // Pictures for the story's witnesses, drawn from Aino's true position
  const storyPhotos = {};
  function storyPhoto(w, truth) {
    const key = `${w.id}:${(w.kind === 'sky' ? w.alt : w.brg).toFixed(2)}:${truth.lat.toFixed(5)}`;
    if (storyPhotos[key]) return storyPhotos[key];
    const D = STORY.data;
    const lms = Object.values(D.peaks).map((p) => ({ lat: p.lat, lon: p.lon, name: p.name, kind: 'Hill top', icon: '⛰️' }))
      .concat(Object.values(D.huts).map((h) => ({ lat: h.lat, lon: h.lon, name: h.name, kind: 'Landmark', icon: '🛖' })))
      .concat([D.mast].concat(D.masts).map((m) => ({ lat: m.lat, lon: m.lon, name: m.name, kind: 'Mast', icon: '📡' })));
    let view;
    if (w.kind === 'sky') {
      const p = SKY.radec(w.body, w.time), a = SKY.altAz(p.ra, p.dec, truth.lat, truth.lon, w.time);
      view = { heading: a.az, pitch: a.alt + SKY.refraction(a.alt), time: w.time, body: w.body };
    } else {
      view = { heading: w.brg, pitch: 2, time: new Date(Date.UTC(2026, 9, 24, 8, 0)), targetName: w.label };
    }
    const cv = document.createElement('canvas');
    cv.width = 320; cv.height = 240;
    const ctx = cv.getContext('2d');
    drawView(ctx, 320, 240, Object.assign({ from: truth, landmarks: lms }, view));
    crosshair(ctx, 160, 240 * 0.42);
    return (storyPhotos[key] = cv.toDataURL('image/jpeg', 0.75));
  }

  // ---------- picker + settings ----------
  function openPicker(title, items, note) {
    $('pickerTitle').textContent = title;
    const body = $('pickerBody');
    body.innerHTML = '';
    if (note) { const p = document.createElement('p'); p.className = 'note'; p.textContent = note; body.appendChild(p); }
    for (const it of items) {
      const b = document.createElement('button');
      b.className = 'pick';
      b.innerHTML = it.html;
      b.onclick = () => { closePicker(); it.onPick(); };
      body.appendChild(b);
    }
    $('picker').classList.remove('hidden');
  }
  function closePicker() { $('picker').classList.add('hidden'); }

  function openSettings() {
    const ref = refPoint();
    $('setLimit').value = MODES[state.mode].limit;
    $('setOffset').value = state.compassOffset.toFixed(1);
    $('setSteps').checked = state.steps;
    $('setDecl').textContent = G.inFinland(ref.lat, ref.lon)
      ? `Magnetic declination here is +${G.declination(ref.lat, ref.lon).toFixed(1)}°. It is added to compass readings automatically (Finland only).`
      : 'Outside Finland: add your local magnetic declination to the correction above.';
    $('settings').classList.remove('hidden');
  }
  function closeSettings() {
    const lim = parseFloat($('setLimit').value);
    if (lim > 0) MODES[state.mode].limit = lim;
    const off = parseFloat($('setOffset').value);
    if (!isNaN(off)) state.compassOffset = off;
    setSteps($('setSteps').checked);
    $('settings').classList.add('hidden');
    schedule();
  }

  // Walking carries every witness along: where you were + what you walked = where you are
  let stepCount = 0;
  function setSteps(on) {
    if (on === state.steps) return;
    state.steps = on;
    if (on) SEN.start().then((ok) => { if (!ok) toast('Motion sensors are not available or not allowed.'); });
    SEN.setSteps(on, (cur) => {
      if (!cur || cur.heading == null) return;
      const h = correctedBearing(cur.heading) * G.D2R, stepLen = 0.7;
      for (const w of state.witnesses) {
        const m = w.move || (w.move = { dE: 0, dN: 0, sigma: 0, walked: 0 });
        m.dE += stepLen * Math.sin(h);
        m.dN += stepLen * Math.cos(h);
        m.walked += stepLen;
        m.sigma = 2 + 0.08 * m.walked;
      }
      if (++stepCount % 4 === 0) schedule();
    });
  }

  function clearAll() {
    state.witnesses = [];
    state.landmarks = [];
    state.suggestId = null;
    Object.assign(state.gps, { spoof: 'off', suspectUntil: 0, jumpMsg: '', prev: null });
    drawLandmarks(); refreshButtons(); schedule();
  }

  // ---------- Lapland demo ----------
  function startStory() {
    if (state.replay) exitReplay();
    state.pending = null;
    hideToast();
    state.story = { k: 0, witnesses: [], alert: null };
    OSM.setStaticWater(STORY.data.lakes);
    map.removeLayer(street);
    topo.addTo(map);
    document.body.classList.add('story-mode');
    drawLandmarks();
    drawStoryMap();
    showStep(0);
  }

  function drawStoryMap() {
    layer.story.clearLayers();
    const D = STORY.data;
    L.polyline(STORY.route, { color: '#7c2d12', weight: 3, opacity: 0.6, dashArray: '2 7', interactive: false }).addTo(layer.story);
    const icon = (cls, emoji) => L.divIcon({ className: cls, html: `<span>${emoji}</span>`, iconSize: [26, 26], iconAnchor: [13, 13] });
    for (const p of Object.values(D.peaks)) L.marker([p.lat, p.lon], { icon: icon('peak-icon', '⛰️') }).bindTooltip(p.name, { direction: 'top', offset: [0, -10] }).addTo(layer.story);
    for (const h of Object.values(D.huts)) L.marker([h.lat, h.lon], { icon: icon('hut-icon', '🛖') }).bindTooltip(h.name, { direction: 'top', offset: [0, -10] }).addTo(layer.story);
    // the one mast Aino's phone hears, and the others that are only landmarks
    L.marker([D.mast.lat, D.mast.lon], { icon: icon('lm-icon heard', '📡') }).bindTooltip(`${D.mast.name} · her phone hears it`, { direction: 'top', offset: [0, -12] }).addTo(layer.story);
    for (const m of D.masts) L.marker([m.lat, m.lon], { icon: icon('peak-icon', '📡') }).bindTooltip(`${m.name} · out of range`, { direction: 'top', offset: [0, -10] }).addTo(layer.story);
    state.story.truthLayer = L.layerGroup().addTo(layer.story);
  }

  function showStep(k) {
    const st = STORY.build(k);
    for (const w of st.witnesses) if (w.kind === 'bearing' || w.kind === 'sky') w.photo = storyPhoto(w, st.truth);
    Object.assign(state.story, { k, witnesses: st.witnesses, alert: st.alert });
    $('storyStep').textContent = `Lapland demo · ${k + 1} / ${STORY.count}`;
    $('storyTitle').textContent = st.title;
    $('storyText').textContent = st.text;
    $('storyBack').disabled = k === 0;
    $('storyNext').textContent = k === STORY.count - 1 ? 'Start again ↺' : 'Next ▶';
    const tl = state.story.truthLayer;
    tl.clearLayers();
    L.polyline(st.track, { color: '#7c2d12', weight: 4, opacity: 0.9, interactive: false }).addTo(tl);
    L.marker([st.truth.lat, st.truth.lon], {
      icon: L.divIcon({ className: 'truth-icon', html: '<span>🥾</span><em>Aino (the truth)</em>', iconSize: [30, 30], iconAnchor: [15, 15] }),
      interactive: false, zIndexOffset: 1000,
    }).addTo(tl);
    schedule();
    if (st.view.bounds) flyToBoundsVisible(st.view.bounds);
    else flyToVisible(st.view.center, st.view.zoom);
  }

  function exitStory() {
    state.story = null;
    layer.story.clearLayers();
    map.removeLayer(topo);
    street.addTo(map);
    document.body.classList.remove('story-mode');
    drawLandmarks();
    schedule();
  }

  // ---------- replay of the organisers' real GPS logs ----------
  const RP = Alibi.replay;

  function actReplay() {
    openPicker('Replay a real GPS recording', Object.entries(RP.LOGS).map(([id, l]) => ({
      html: `<b>${l.icon} ${l.label}</b><small>organisers’ data</small>`,
      onPick: () => startReplay(id),
    })), 'Recorded with Google’s GnssLogger app. Watch GPS drop out in tunnels and Alibi carry on with speed and direction.');
  }

  async function startReplay(id) {
    toast('Loading the recording…', 0);
    let data;
    try { data = await RP.load(id); } catch (e) { toast('Could not load the recording (' + e.message + ').'); return; }
    hideToast();
    if (state.story) exitStory();
    state.pending = null;
    const log = RP.LOGS[id];
    state.replay = { id, data, i: 0, playing: false, timer: 0, witnesses: [], alert: null, limit: log.mode === 'train' ? 100 : MODES.drive.limit };
    document.body.classList.add('replay-mode');
    $('replay').classList.remove('hidden');
    drawLandmarks();
    $('replayTitle').textContent = `${log.icon} ${log.label} · real GPS log`;
    $('replaySlider').max = data.ep.length - 1;
    layer.story.clearLayers();
    L.polyline(data.track, { color: '#64748b', weight: 3, opacity: 0.55, interactive: false }).addTo(layer.story);
    state.replay.done = L.polyline([], { color: '#0f172a', weight: 4, opacity: 0.85, interactive: false }).addTo(layer.story);
    state.replay.exitMark = L.layerGroup().addTo(layer.story);
    flyToBoundsVisible(L.latLngBounds(data.track));
    replayStep(Math.max(0, data.ep.findIndex((e) => e.lat != null)));
  }

  function replayStep(i) {
    const R = state.replay, ep = R.data.ep, e = ep[i];
    R.i = i;
    $('replaySlider').value = i;
    const ws = [];
    if (e.lat != null) {
      const sg = Math.max(3, (e.acc || 10) / 1.5);
      ws.push({ id: 'gps', type: 'gps', kind: 'point', lat: e.lat, lon: e.lon, sigma: sg, label: 'GPS',
        detail: `${e.nsat} satellites · signal ${e.cn0 != null ? e.cn0.toFixed(0) + ' dB-Hz' : '–'} · ±${G.fmtDist(2 * sg)}` });
    }
    if (e.dr) {
      ws.push({ id: 'motion', type: 'motion', kind: 'point', lat: e.dr.lat, lon: e.dr.lon, sigma: Math.max(3, e.dr.sigma),
        label: e.dr.gyro ? 'Speed + gyroscope' : 'Speed + direction',
        detail: `last fix + ${G.fmtDist(e.dr.since)} at ${Math.round(e.dr.spd * 3.6)} km/h · ±${G.fmtDist(2 * Math.max(3, e.dr.sigma))}` });
    }
    R.witnesses = ws;
    const diag = RP.diagnose(e, R.data.hasAgc);
    R.alert = diag ? '⚠ ' + diag.text : null;
    // GPS just came back: does it land where dead reckoning said?
    R.exitMark.clearLayers();
    let back = '';
    if (e.back) {
      const ok = e.back.dist <= 3 * e.back.sigma, prev = ep[i - 1];
      const how = prev && prev.dr && prev.dr.gyro ? 'speed + gyroscope' : 'speed + direction';
      back = ` GPS is back after ${e.back.gap} s: ${G.fmtDist(e.back.dist)} from where ${how} said, after ${G.fmtDist(e.back.since)} without GPS` +
        (ok ? ' (inside the ± circle ✓).' : ' (outside the ± circle: check it).');
      L.marker([e.lat, e.lon], { icon: L.divIcon({ className: 'truth-icon', html: '<span>🎯</span><em>GPS back</em>', iconSize: [30, 30], iconAnchor: [15, 15] }), interactive: false }).addTo(R.exitMark);
    }
    const time = new Date(e.t * 1000).toISOString().slice(11, 19);
    const spd = e.spd != null ? `${Math.round(e.spd * 3.6)} km/h` : e.dr ? `~${Math.round(e.dr.spd * 3.6)} km/h` : '';
    $('replayText').textContent = `${time} UTC · ${spd} · ${e.nsat} satellites` +
      (e.lat == null ? ` · GPS lost for ${e.lost} s.` : '.') + back;
    R.done.setLatLngs(R.data.track.slice(0, ep.slice(0, i + 1).filter((x) => x.lat != null).length));
    const pos = e.lat != null ? [e.lat, e.lon] : e.dr ? [e.dr.lat, e.dr.lon] : null;
    if (pos && !map.getBounds().pad(-0.15).contains(pos)) map.panTo(pos, { animate: false });
    drawReplayChart();
    schedule();
  }

  // play: quick through good GPS, slow (2 s per tick) around outages, so the tunnels are what you watch
  function toggleReplay() {
    const R = state.replay;
    R.playing = !R.playing;
    $('replayPlay').textContent = R.playing ? '⏸ Pause' : '▶ Play';
    clearInterval(R.timer);
    if (!R.playing) return;
    R.timer = setInterval(() => {
      const ep = R.data.ep;
      const near = R.data.outs.some((o) => R.i >= o.from - 8 && R.i <= o.to + 8);
      const next = Math.min(ep.length - 1, R.i + (near ? 1 : 6));
      replayStep(next);
      if (next === ep.length - 1) toggleReplay();
    }, 120);
  }

  function jumpOutage(dir) {
    const R = state.replay, outs = R.data.outs;
    if (!outs.length) { toast('No GPS outages in this recording.'); return; }
    const o = dir > 0 ? outs.find((x) => x.from - 6 > R.i) || outs[0] : outs.slice().reverse().find((x) => x.from - 6 < R.i - 1) || outs[outs.length - 1];
    replayStep(Math.max(0, o.from - 6));
  }

  function drawReplayChart() {
    const R = state.replay, cv = $('replayChart'), dpr = window.devicePixelRatio || 1;
    const W = cv.clientWidth, H = 84;
    if (!W) return;
    cv.width = Math.round(W * dpr); cv.height = Math.round(H * dpr);
    const ctx = cv.getContext('2d');
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    const ep = R.data.ep, n = ep.length, x = (i) => (i / Math.max(1, n - 1)) * W;
    ctx.fillStyle = '#f8fafc'; ctx.fillRect(0, 0, W, H);
    ctx.fillStyle = 'rgba(220,38,38,.2)';
    for (const o of R.data.outs) ctx.fillRect(x(o.from), 0, Math.max(2, x(o.to) - x(o.from)), H);
    const line = (get, lo, hi, color) => {
      ctx.strokeStyle = color; ctx.lineWidth = 1.5; ctx.beginPath();
      const step = Math.max(1, Math.floor(n / W));
      let pen = false;
      for (let i = 0; i < n; i += step) {
        const v = get(ep[i]);
        if (v == null) { pen = false; continue; }
        const y = H - 4 - (Math.max(lo, Math.min(hi, v)) - lo) / (hi - lo) * (H - 18);
        if (pen) ctx.lineTo(x(i), y); else { ctx.moveTo(x(i), y); pen = true; }
      }
      ctx.stroke();
    };
    line((e) => e.nsat, 0, 40, '#2563eb');
    line((e) => e.cn0, 10, 50, '#ea580c');
    ctx.fillStyle = '#0f172a'; ctx.fillRect(x(R.i) - 1, 0, 2, H);
    ctx.font = '600 11px system-ui, sans-serif'; ctx.textAlign = 'left';
    ctx.fillStyle = '#2563eb'; ctx.fillText('satellites', 4, 11);
    ctx.fillStyle = '#ea580c'; ctx.fillText('signal (dB-Hz)', 66, 11);
    ctx.fillStyle = '#dc2626'; ctx.fillText('GPS lost', 158, 11);
  }

  function exitReplay() {
    const R = state.replay;
    if (!R) return;
    clearInterval(R.timer);
    state.replay = null;
    layer.story.clearLayers();
    document.body.classList.remove('replay-mode');
    $('replay').classList.add('hidden');
    $('replayPlay').textContent = '▶ Play';
    drawLandmarks();
    schedule();
  }

  // ---------- run the engine ----------
  let runTimer = 0;
  function schedule() { clearTimeout(runTimer); runTimer = setTimeout(run, 40); }

  function run() {
    const ws = allWitnesses();
    const mode = state.story ? 'walk' : state.mode;
    const t0 = performance.now();
    const res = ENG.analyze(ws, {
      alertLimit: state.story ? 150 : state.replay ? state.replay.limit : MODES[mode].limit,
      maskFor: state.replay ? null : (g) => OSM.maskFor(g, mode, state.story ? 'static' : 'live', schedule),
      fallbackBounds: viewBounds(),
    });
    res.ms = performance.now() - t0;
    state.result = res;
    render(res, ws);
  }

  // ---------- drawing ----------
  function render(res, ws) {
    $('light').className = 'light ' + res.light;
    $('headline').textContent = res.headline;
    $('detail').textContent = res.detail;
    renderAlerts(res);
    renderList(state.story ? $('storyWitnesses') : state.replay ? $('replayWitnesses') : $('witnesses'), res, ws, !state.story && !state.replay);
    renderShapes(res, ws);
    renderHeat(res);
    renderEstimate(res);
    renderHint(res, ws);
  }

  function renderAlerts(res) {
    const box = $('alerts');
    box.innerHTML = '';
    const msgs = [];
    if (state.story && state.story.alert) msgs.push(state.story.alert);
    if (state.replay && state.replay.alert) msgs.push(state.replay.alert);
    if (!state.story && !state.replay && state.gps.jumpMsg && Date.now() < state.gps.suspectUntil) msgs.push(state.gps.jumpMsg);
    msgs.push(...(res.alerts || []));
    for (const m of msgs) {
      const d = document.createElement('div');
      d.className = 'alert';
      d.textContent = m;
      box.appendChild(d);
    }
  }

  function renderList(el, res, ws, removable) {
    el.innerHTML = '';
    if (!ws.length) { el.innerHTML = '<li class="empty">No witnesses yet. Turn on GPS or add one above.</li>'; return; }
    ws.forEach((w, i) => {
      const st = res.status && res.status[i] ? res.status[i].state : 'unchecked';
      const li = document.createElement('li');
      const icon = w.photo ? `<img class="thumb" src="${w.photo}" alt="">`
        : `<span class="wi" style="background:${COLORS[w.type]}22">${ICONS[w.type]}</span>`;
      li.innerHTML = `${icon}<div class="wt"><b></b><small></small></div><span class="pill ${st}">${STATE_TEXT[st]}</span>`;
      li.querySelector('b').textContent = w.label;
      li.querySelector('small').textContent = w.detail || '';
      if (removable && w.type !== 'gps') {
        const b = document.createElement('button');
        b.className = 'rm'; b.title = 'Remove'; b.textContent = '×';
        b.onclick = () => removeWitness(w.id);
        li.appendChild(b);
      }
      el.appendChild(li);
    });
    if (res.maskUsed) {
      const li = document.createElement('li');
      li.innerHTML = `<span class="wi" style="background:#e2e8f0">🗺️</span><div class="wt"><b>Map rule</b><small>${MODES[state.story ? 'walk' : state.mode].rule}</small></div><span class="pill rule">on</span>`;
      el.appendChild(li);
    }
  }

  // where a witness's shape is now, after the steps walked since it was taken
  function moved(w, lat, lon) { return w.move ? G.offset(lat, lon, w.move.dE, w.move.dN) : { lat, lon }; }

  function renderShapes(res, ws) {
    layer.shapes.clearLayers();
    ws.forEach((w, i) => {
      const st = res.status && res.status[i] ? res.status[i].state : 'unchecked';
      const color = st === 'ignored' ? BAD : st === 'suspect' ? SUSPECT : COLORS[w.type];
      const style = { color, fillColor: color, weight: 2, opacity: 0.9, fillOpacity: 0.1, dashArray: st === 'ignored' ? '6 6' : null, interactive: false };
      if (w.kind === 'point') drawPoint(w, style);
      else if (w.kind === 'bearing') drawWedge(w, style);
      else if (w.kind === 'range') drawRing(w, style);
      else if (w.kind === 'angle') drawAngle(w, style);
      else if (w.kind === 'sky') drawBand(w, style);
    });
  }

  const LABEL_OFFSET = { right: [9, 0], left: [-9, 0], top: [0, -9], bottom: [0, 9] };
  function anchorDot(lat, lon, color, label, type) {
    const side = LABEL_SIDE[type] || 'right';
    L.circleMarker([lat, lon], { radius: 7, color: '#fff', weight: 2, fillColor: color, fillOpacity: 1 })
      .bindTooltip(label, { className: 'wlabel', direction: side, offset: LABEL_OFFSET[side], permanent: true, opacity: 0.92 })
      .addTo(layer.shapes);
  }

  function drawPoint(w, style) {
    const p = moved(w, w.lat, w.lon), sigma = w.move ? Math.hypot(w.sigma, w.move.sigma) : w.sigma;
    L.circle([p.lat, p.lon], Object.assign({}, style, { radius: Math.max(6, 2 * sigma) })).addTo(layer.shapes);
    anchorDot(p.lat, p.lon, style.color, `${ICONS[w.type]} ${w.label}`, w.type);
  }

  function drawWedge(w, style) {
    const ref = state.result && state.result.est;
    const len = ref ? Math.min(20000, Math.max(1500, 1.8 * G.dist(w.lat, w.lon, ref.lat, ref.lon))) : 6000;
    const back = w.brg + 180, half = 2 * w.sigma;
    const shift = (p) => { const q = moved(w, p.lat, p.lon); return [q.lat, q.lon]; };
    const pts = [shift({ lat: w.lat, lon: w.lon })];
    for (let a = -half; a <= half + 1e-9; a += half / 8) pts.push(shift(G.dest(w.lat, w.lon, back + a, len)));
    L.polygon(pts, Object.assign({}, style, { fillOpacity: 0.14, weight: 1 })).addTo(layer.shapes);
    L.polyline([shift({ lat: w.lat, lon: w.lon }), shift(G.dest(w.lat, w.lon, back, len))],
      { color: style.color, weight: 2, dashArray: '5 5', interactive: false }).addTo(layer.shapes);
    anchorDot(w.lat, w.lon, style.color, `🗼 ${w.label}`, w.type);
  }

  function drawRing(w, style) {
    const ro = w.r + 2 * w.sigma, ri = Math.max(0, w.r - 2 * w.sigma), outer = [], inner = [];
    for (let a = 0; a < 360; a += 4) {
      const o = G.dest(w.lat, w.lon, a, ro), mo = moved(w, o.lat, o.lon);
      outer.push([mo.lat, mo.lon]);
      if (ri > 0) {
        const q = G.dest(w.lat, w.lon, a, ri), mq = moved(w, q.lat, q.lon);
        inner.push([mq.lat, mq.lon]);
      }
    }
    L.polygon(ri > 0 ? [outer, inner] : outer, Object.assign({}, style, { fillOpacity: 0.08, weight: 1.5 })).addTo(layer.shapes);
    anchorDot(w.lat, w.lon, style.color, `📡 ${w.label}`, w.type);
  }

  // Seeing A and B a fixed angle apart puts you on an arc of a circle through A and B (the inscribed
  // angle theorem). Draw the band between the arcs for the angle ± 2 sigma, on the side you stand on.
  function drawAngle(w, style) {
    const m = { lat: (w.a.lat + w.b.lat) / 2, lon: (w.a.lon + w.b.lon) / 2 }, cm = Math.cos(m.lat * G.D2R);
    const ax = (w.a.lon - m.lon) * G.M_PER_DEG * cm, ay = (w.a.lat - m.lat) * G.M_PER_DEG;
    const bx = -ax, by = -ay, c = Math.hypot(ax, ay);
    if (c < 1) return;
    const ux = (bx - ax) / (2 * c), uy = (by - ay) / (2 * c);
    const side = w.ang >= 0 ? 1 : -1;                  // B clockwise from A: you stand to the right of A→B
    const nx = side * uy, ny = -side * ux;
    const toLL = (x, y) => { const q = moved(w, m.lat + y / G.M_PER_DEG, m.lon + x / (G.M_PER_DEG * cm)); return [q.lat, q.lon]; };
    const arc = (deg) => {
      const al = Math.min(179, Math.max(1, Math.abs(deg))) * G.D2R;
      const r = c / Math.sin(al), off = c / Math.tan(al), ox = nx * off, oy = ny * off;
      const a0 = Math.atan2(ay - oy, ax - ox), a1 = Math.atan2(by - oy, bx - ox), far = Math.atan2(ny, nx);
      const norm = (t) => ((t % (2 * Math.PI)) + 2 * Math.PI) % (2 * Math.PI);
      const ccw = norm(a1 - a0);
      const sweep = norm(far - a0) < ccw ? ccw : ccw - 2 * Math.PI;   // go round through your side of AB
      const pts = [];
      for (let i = 0; i <= 64; i++) { const t = a0 + sweep * i / 64; pts.push(toLL(ox + r * Math.cos(t), oy + r * Math.sin(t))); }
      return pts;
    };
    const wide = arc(Math.abs(w.ang) - 2 * w.sigma), narrow = arc(Math.abs(w.ang) + 2 * w.sigma);
    L.polygon(wide.concat(narrow.slice().reverse()), Object.assign({}, style, { fillOpacity: 0.16, weight: 1 })).addTo(layer.shapes);
    L.polyline(arc(Math.abs(w.ang)), { color: style.color, weight: 2, dashArray: '5 5', interactive: false }).addTo(layer.shapes);
    const [la, lb] = w.label.split(' ↔ ');
    anchorDot(w.a.lat, w.a.lon, style.color, `📐 A: ${la || 'A'}`, w.type);
    anchorDot(w.b.lat, w.b.lon, style.color, `📐 B: ${lb || 'B'}`, w.type);
  }

  // A star seen at a given height is on a ring around the point where it is overhead: draw that band
  function drawBand(w, style) {
    const gp = SKY.groundPoint(w.body, w.time), ref = refPoint();
    const radIn = (90 - (w.alt + 2 * w.sigma)) * G.M_PER_DEG, radOut = (90 - (w.alt - 2 * w.sigma)) * G.M_PER_DEG;
    const segs = [];
    let seg = null, label = null;
    for (let az = 0; az <= 360; az += 0.5) {
      const c = G.dest(gp.lat, gp.lon, az, (radIn + radOut) / 2);
      const dRef = G.dist(ref.lat, ref.lon, c.lat, c.lon), near = dRef < 2500000;
      const a = G.dest(gp.lat, gp.lon, az, radIn), b = G.dest(gp.lat, gp.lon, az, radOut);
      const last = seg && seg.a[seg.a.length - 1];
      const jump = last && Math.abs(a.lon - last[1]) > 90;
      if (near && !jump) {
        if (!seg) seg = { a: [], b: [] };
        seg.a.push([a.lat, a.lon]); seg.b.push([b.lat, b.lon]);
      } else {
        if (seg && seg.a.length > 1) segs.push(seg);
        seg = near ? { a: [[a.lat, a.lon]], b: [[b.lat, b.lon]] } : null;
      }
      if (near && (!label || dRef < label.d)) label = { d: dRef, lat: c.lat, lon: c.lon };
    }
    if (seg && seg.a.length > 1) segs.push(seg);
    for (const s of segs) {
      L.polygon(s.a.concat(s.b.slice().reverse()), {
        color: style.color, weight: 2, opacity: 0.9, fillColor: style.color, fillOpacity: 0.2,
        dashArray: style.dashArray || '8 6', interactive: false,
      }).addTo(layer.shapes);
    }
    if (label) {
      L.marker([label.lat, label.lon], {
        icon: L.divIcon({ className: 'band-label', html: `<span>✨ ${w.label}</span>`, iconSize: null }), interactive: false,
      }).addTo(layer.shapes);
    }
  }

  function renderHeat(res) {
    if (heat) { map.removeLayer(heat); heat = null; }
    if (res.empty || res.conflict || !res.grid) return;
    const g = res.grid, P = res.P, cv = document.createElement('canvas');
    cv.width = g.nx; cv.height = g.ny;
    const ctx = cv.getContext('2d'), img = ctx.createImageData(g.nx, g.ny);
    let top = 0;
    for (let k = 0; k < g.N; k++) top = Math.max(top, ENG.density(g, P, k));
    for (let k = 0; k < g.N; k++) {
      const v = Math.sqrt(ENG.density(g, P, k) / top);      // square root makes the faint edges visible
      if (v < 0.04) continue;
      img.data[4 * k] = 255;
      img.data[4 * k + 1] = Math.round(215 - 175 * v);
      img.data[4 * k + 2] = Math.round(70 - 60 * v);
      img.data[4 * k + 3] = Math.round(50 + 170 * v);
    }
    ctx.putImageData(img, 0, 0);
    heat = L.imageOverlay(cv.toDataURL(), [[g.s, g.w], [g.n, g.e]], { pane: 'heat', interactive: false, opacity: 0.85 }).addTo(map);
  }

  function renderEstimate(res) {
    layer.est.clearLayers();
    if (!state.story && !state.replay && state.gps.spoof !== 'off' && state.gps.raw) {
      L.marker([state.gps.raw.lat, state.gps.raw.lon], {
        icon: L.divIcon({ className: '', html: '<div class="real-dot"></div>', iconSize: [12, 12], iconAnchor: [6, 6] }),
      }).bindTooltip('Your real GPS (Alibi cannot see this)', { direction: 'right', offset: [8, 0] }).addTo(layer.est);
    }
    if (!res.est || res.conflict) return;
    L.circle([res.est.lat, res.est.lon], { radius: res.r95, color: '#0f172a', weight: 2, dashArray: '2 6', fill: false, interactive: false }).addTo(layer.est);
    L.marker([res.est.lat, res.est.lon], {
      icon: L.divIcon({ className: '', html: '<div class="est-dot"></div>', iconSize: [20, 20], iconAnchor: [10, 10] }),
      zIndexOffset: 900,
    }).bindTooltip(`Alibi: you are here (±${G.fmtDist(res.r95)})`, { direction: 'right', offset: [10, 0] }).addTo(layer.est);
  }

  // Which landmark would shrink the search area the most? One whose line crosses the others squarely.
  function renderHint(res, ws) {
    let best = null;
    if (!state.story && !state.replay && state.landmarks.length && res.est && res.light !== 'green') {
      const used = new Set(ws.filter((w) => w.lmId).map((w) => w.lmId));
      const lines = ws.filter((w) => w.kind === 'bearing').map((w) => w.brg);
      for (const lm of state.landmarks) {
        if (used.has(lm.id)) continue;
        const d = G.dist(res.est.lat, res.est.lon, lm.lat, lm.lon);
        if (d < 80 || d > 8000) continue;
        const b = G.bearing(res.est.lat, res.est.lon, lm.lat, lm.lon);
        const cross = lines.length ? Math.min(...lines.map((l) => Math.abs(Math.sin((b - l) * G.D2R)))) : 1;
        const score = cross / (1 + d / 1500);
        if (!best || score > best.score) best = { lm, b, d, score };
      }
    }
    const id = best ? best.lm.id : null;
    if (id !== state.suggestId) { state.suggestId = id; drawLandmarks(); }
    $('hint').textContent = best ? `👉 Next: aim at ${best.lm.name} (${G.compass8(best.b)}, ${G.fmtDist(best.d)})` : '';
  }

  // ---------- small UI helpers ----------
  let toastTimer = 0;
  function toast(msg, ms) { $('toast').textContent = msg; showToast(ms); }
  function toastHTML(html, ms) { $('toast').innerHTML = html; showToast(ms); }
  function showToast(ms) {
    $('toast').classList.add('show');
    clearTimeout(toastTimer);
    if (ms !== 0) toastTimer = setTimeout(hideToast, ms || 4000);
  }
  function hideToast() { $('toast').classList.remove('show'); }
  function collapseSheet() { if (window.innerWidth < 900) $('sheet').classList.add('collapsed'); }

  function refreshButtons() {
    $('actGps').classList.toggle('on', state.gps.on);
    $('actSpoof').classList.toggle('on', state.gps.spoof !== 'off');
    $('spoofLabel').textContent = { off: 'Spoof GPS', drag: 'Spoof: drag', jump: 'Spoof: jump' }[state.gps.spoof];
    document.querySelectorAll('.mode').forEach((b) => b.classList.toggle('active', b.dataset.mode === state.mode));
  }

  // The part of the map not hidden behind the panels
  function visibleRect() {
    const size = map.getSize();
    const panel = (state.story ? $('story') : state.replay ? $('replay') : $('sheet')).getBoundingClientRect();
    if (window.innerWidth >= 900) return { left: panel.right + 10, top: 10, right: size.x - 50, bottom: size.y - 10 };
    const top = $('status').getBoundingClientRect().bottom + 8;
    return { left: 10, top, right: size.x - 50, bottom: Math.max(top + 120, panel.top - 8) };
  }
  function flyToVisible(center, zoom) {
    const r = visibleRect(), size = map.getSize();
    const off = L.point(size.x / 2 - (r.left + r.right) / 2, size.y / 2 - (r.top + r.bottom) / 2);
    map.flyTo(map.unproject(map.project(L.latLng(center), zoom).add(off), zoom), zoom, { duration: 1.0 });
  }
  function flyToBoundsVisible(bounds) {
    const r = visibleRect(), size = map.getSize();
    map.flyToBounds(bounds, {
      paddingTopLeft: L.point(r.left + 40, r.top + 40),
      paddingBottomRight: L.point(size.x - r.right + 40, size.y - r.bottom + 40),
      duration: 1.2,
    });
  }

  // ---------- wiring ----------
  $('actGps').onclick = toggleGps;
  $('actYou').onclick = startYou;
  $('actLandmark').onclick = actLandmark;
  $('actSky').onclick = actSky;
  $('actTowers').onclick = actTowers;
  $('actAngle').onclick = actAngle;
  $('actSave').onclick = actSave;
  $('actSpoof').onclick = cycleSpoof;
  $('actStory').onclick = startStory;
  $('actClear').onclick = clearAll;
  $('actSettings').onclick = openSettings;
  $('settingsClose').onclick = closeSettings;
  $('sheetHandle').onclick = () => $('sheet').classList.toggle('collapsed');
  $('storyNext').onclick = () => showStep(state.story.k === STORY.count - 1 ? 0 : state.story.k + 1);
  $('storyBack').onclick = () => showStep(Math.max(0, state.story.k - 1));
  $('storyExit').onclick = exitStory;
  $('actReplay').onclick = actReplay;
  $('replayExit').onclick = exitReplay;
  $('replayPlay').onclick = toggleReplay;
  $('replayPrev').onclick = () => jumpOutage(-1);
  $('replayNext').onclick = () => jumpOutage(1);
  $('replaySlider').addEventListener('input', (e) => replayStep(+e.target.value));
  $('replayChart').addEventListener('click', (e) => {
    const r = e.target.getBoundingClientRect(), n = state.replay.data.ep.length;
    replayStep(Math.round((e.clientX - r.left) / r.width * (n - 1)));
  });
  $('aimCancel').onclick = closeAim;
  $('aimLock').onclick = takeShot;
  $('simToggle').onclick = () => { setSim(!sim.on); restartAngle(); };
  $('reviewRetake').onclick = () => { $('review').classList.add('hidden'); $('aimPanel').classList.remove('hidden'); };
  $('reviewAdd').onclick = addFromReview;
  $('reviewValue').addEventListener('input', updateReviewNote);
  document.querySelectorAll('#review [data-step]').forEach((b) => {
    b.onclick = () => {
      const v = (parseFloat($('reviewValue').value) || 0) + parseFloat(b.dataset.step);
      const mode = aim && aim.mode;
      $('reviewValue').value = (mode === 'bearing' ? G.wrap360(v) : mode === 'angle' ? G.wrap180(v) : v).toFixed(1);
      updateReviewNote();
    };
  });
  $('pickerClose').onclick = closePicker;
  document.querySelectorAll('.mode').forEach((b) => {
    b.onclick = () => {
      state.mode = b.dataset.mode;
      refreshButtons(); schedule();
      toast(`${b.textContent.trim()}: ${MODES[state.mode].rule.toLowerCase()} · safety limit ±${G.fmtDist(MODES[state.mode].limit)}`);
    };
  });
  document.addEventListener('keydown', (e) => {
    if (e.target.tagName === 'INPUT') return;
    if (aim && sim.on && $('review').classList.contains('hidden')) {
      const step = e.shiftKey ? 0.1 : 1;
      if (e.key === 'ArrowLeft') sim.heading = G.wrap360(sim.heading - step);
      else if (e.key === 'ArrowRight') sim.heading = G.wrap360(sim.heading + step);
      else if (e.key === 'ArrowUp') sim.pitch = Math.min(85, sim.pitch + step);
      else if (e.key === 'ArrowDown') sim.pitch = Math.max(-20, sim.pitch - step);
      else if (e.key === 'Enter') takeShot();
      else return;
      e.preventDefault();
      return;
    }
    if (!state.story) return;
    if (e.key === 'ArrowRight' || e.key === ' ') { e.preventDefault(); $('storyNext').click(); }
    if (e.key === 'ArrowLeft') $('storyBack').click();
    if (e.key === 'Escape') exitStory();
  });
  new ResizeObserver(() => document.documentElement.style.setProperty('--status-h', $('status').offsetHeight + 'px')).observe($('status'));

  // handle for the browser console (handy when testing or tweaking a demo)
  Alibi.app = { state, map, run, addWitness, sim };

  // Keep the app on the phone so it opens without a network too (see sw.js)
  if ('serviceWorker' in navigator && location.protocol !== 'file:') navigator.serviceWorker.register('sw.js').catch(() => {});
  window.addEventListener('offline', () => toast('You are offline. Alibi keeps working with saved and built-in data.', 6000));
  window.addEventListener('online', () => toast('Back online.'));

  refreshButtons();
  schedule();
  if (/[?&]demo\b/.test(location.search)) startStory();
  else toast('Try 🎬 Lapland demo, or turn on 🛰️ GPS and add witnesses.', 6000);
})();
