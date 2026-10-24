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
  const COLORS = { gps: '#2563eb', you: '#7c3aed', steps: '#059669', landmark: '#ea580c', tower: '#c026d3', sky: '#1e3a8a' };
  const LABEL_SIDE = { gps: 'right', you: 'left', steps: 'bottom', landmark: 'top', tower: 'top', sky: 'top' };
  const BAD = '#dc2626', SUSPECT = '#d97706';
  const ICONS = { gps: '🛰️', you: '📍', steps: '👣', landmark: '🗼', tower: '📡', sky: '✨' };
  const STATE_TEXT = { agrees: '✓ agrees', ignored: '✗ ignored', suspect: '? suspect', unchecked: '– unchecked' };

  const state = {
    mode: 'walk', witnesses: [], nextId: 1,
    gps: { on: false, watch: null, raw: null, prev: null, spoof: 'off', spoofT0: 0, spoofDir: 120, suspectUntil: 0, jumpMsg: '' },
    landmarks: [], suggestId: null,
    compassOffset: 0, compassCalibrated: false, steps: false,
    pending: null, youRadius: 1000,
    story: null, result: null,
  };

  // ---------- map ----------
  const map = L.map('map', { zoomControl: false }).setView([61.4978, 23.7610], 14);   // Tampere
  L.control.zoom({ position: 'topright' }).addTo(map);
  const street = L.tileLayer('https://tile.openstreetmap.org/{z}/{x}/{y}.png', {
    maxZoom: 19, attribution: '© <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors',
  });
  const topo = L.tileLayer('https://{s}.tile.opentopomap.org/{z}/{x}/{y}.png', {
    maxZoom: 17, subdomains: 'abc',
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
    state.pending = null;
    hideToast();
    if (what === 'you') {
      addWitness({ type: 'you', kind: 'point', lat: e.latlng.lat, lon: e.latlng.lng, sigma: state.youRadius / 2,
        label: 'I’m about here', detail: `your guess · ±${G.fmtDist(state.youRadius)}` });
    } else if (what === 'landmark') {
      const lm = { id: 'pick' + state.nextId++, lat: e.latlng.lat, lon: e.latlng.lng, name: 'My landmark', named: true, kind: 'Landmark', icon: '📌' };
      state.landmarks.push(lm);
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

  async function actLandmark() {
    if (state.story) return;
    if (state.landmarks.length) { offerPick('Tap a landmark you can see (🗼 ⛪ 🏭 ⛰️ 📡).'); collapseSheet(); return; }
    if (map.getZoom() < 13) { offerPick('Zoom in to your area first, so I can search nearby.'); return; }
    toast('Searching OpenStreetMap for towers, churches, chimneys and hill tops… (can take 20 s)', 0);
    try {
      state.landmarks = await OSM.landmarks(viewBounds());
      drawLandmarks();
      offerPick(state.landmarks.length ? `Found ${state.landmarks.length}. Tap one you can see.` : 'No landmarks are mapped here.');
      if (state.landmarks.length) collapseSheet();
    } catch (e) {
      offerPick(`OpenStreetMap is busy right now (${e.message}).`);
    }
    schedule();
  }

  function drawLandmarks() {
    layer.marks.clearLayers();
    if (state.story) return;
    for (const lm of state.landmarks) {
      const used = state.witnesses.some((w) => w.lmId === lm.id);
      const cls = 'lm-icon' + (used ? ' used' : '') + (lm.heard ? ' heard' : '') + (state.suggestId === lm.id ? ' suggest' : '');
      L.marker([lm.lat, lm.lon], { icon: L.divIcon({ className: cls, html: `<span>${lm.icon}</span>`, iconSize: [30, 30], iconAnchor: [15, 15] }) })
        .bindTooltip(lm.heard ? `${lm.name} · your phone hears it` : lm.name, { direction: 'top', offset: [0, -14] })
        .on('click', () => aimAtLandmark(lm))
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

  // What the phone measures right now: true bearing and angle above the horizon
  function reading() {
    if (sim.on) return { heading: sim.heading, elev: sim.pitch };
    const c = SEN.alive() ? SEN.current() : null;
    return c ? { heading: c.heading != null ? correctedBearing(c.heading) : null, elev: c.elev } : null;
  }

  function readout() {
    const r = reading();
    $('aimBrg').textContent = r && r.heading != null ? `${Math.round(r.heading)}° ${G.compass8(r.heading)}` : '—';
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

  // A 4:3 picture around the crosshair, from the camera or the simulated view
  function capturePhoto() {
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

  // The value the engine will use: a true bearing, or an angle above the horizon
  function reviewValue() {
    const v = parseFloat($('reviewValue').value);
    if (isNaN(v)) return null;
    if (aim.mode === 'bearing') return G.wrap360(aim.source === 'hand' ? v + declHere() : v);
    return v;
  }

  function updateReviewNote() {
    let txt;
    if (aim.mode === 'elev') txt = 'Angle above the horizon. Air bends starlight a little; that is corrected automatically.';
    else if (aim.source === 'hand') {
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
    let sigma = Math.max(aim.mode === 'bearing' ? 0.25 : 0.05, (isNaN(pm) ? 2 : pm) / 2);
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

  // ---------- run the engine ----------
  let runTimer = 0;
  function schedule() { clearTimeout(runTimer); runTimer = setTimeout(run, 40); }

  function run() {
    const ws = allWitnesses();
    const mode = state.story ? 'walk' : state.mode;
    const t0 = performance.now();
    const res = ENG.analyze(ws, {
      alertLimit: state.story ? 150 : MODES[mode].limit,
      maskFor: (g) => OSM.maskFor(g, mode, state.story ? 'static' : 'live', schedule),
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
    renderList(state.story ? $('storyWitnesses') : $('witnesses'), res, ws, !state.story);
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
    if (!state.story && state.gps.jumpMsg && Date.now() < state.gps.suspectUntil) msgs.push(state.gps.jumpMsg);
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
    if (!state.story && state.gps.spoof !== 'off' && state.gps.raw) {
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
    if (!state.story && state.landmarks.length && res.est && res.light !== 'green') {
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
    const panel = (state.story ? $('story') : $('sheet')).getBoundingClientRect();
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
  $('actSpoof').onclick = cycleSpoof;
  $('actStory').onclick = startStory;
  $('actClear').onclick = clearAll;
  $('actSettings').onclick = openSettings;
  $('settingsClose').onclick = closeSettings;
  $('sheetHandle').onclick = () => $('sheet').classList.toggle('collapsed');
  $('storyNext').onclick = () => showStep(state.story.k === STORY.count - 1 ? 0 : state.story.k + 1);
  $('storyBack').onclick = () => showStep(Math.max(0, state.story.k - 1));
  $('storyExit').onclick = exitStory;
  $('aimCancel').onclick = closeAim;
  $('aimLock').onclick = takeShot;
  $('simToggle').onclick = () => setSim(!sim.on);
  $('reviewRetake').onclick = () => { $('review').classList.add('hidden'); $('aimPanel').classList.remove('hidden'); };
  $('reviewAdd').onclick = addFromReview;
  $('reviewValue').addEventListener('input', updateReviewNote);
  document.querySelectorAll('#review [data-step]').forEach((b) => {
    b.onclick = () => {
      const v = (parseFloat($('reviewValue').value) || 0) + parseFloat(b.dataset.step);
      $('reviewValue').value = (aim && aim.mode === 'bearing' ? G.wrap360(v) : v).toFixed(1);
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
  Alibi.app = { state, map, run, addWitness };

  refreshButtons();
  schedule();
  if (/[?&]demo\b/.test(location.search)) startStory();
  else toast('Try 🎬 Lapland demo, or turn on 🛰️ GPS and add witnesses.', 6000);
})();
