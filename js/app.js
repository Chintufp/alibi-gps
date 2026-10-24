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
  // Font Awesome icons
  const ico = (cls) => `<i class="fa-solid ${cls}"></i>`;
  const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const ICONS = { gps: 'fa-satellite', you: 'fa-location-dot', steps: 'fa-shoe-prints', motion: 'fa-gauge-high', landmark: 'fa-tower-observation',
    angle: 'fa-compass-drafting', tower: 'fa-tower-cell', sky: 'fa-star' };
  const iconFor = (w) => (w.type === 'sky' && w.body === 'sun' ? 'fa-sun' : ICONS[w.type]);
  const STATE_TEXT = { agrees: `${ico('fa-check')} agrees`, ignored: `${ico('fa-xmark')} ignored`,
    suspect: `${ico('fa-question')} suspect`, unchecked: `${ico('fa-minus')} unchecked` };
  // the icon font has to be loaded before icons can be drawn on a canvas (simulated camera, story photos)
  const faReady = document.fonts ? document.fonts.load('900 20px "Font Awesome 6 Free"').catch(() => {}) : Promise.resolve();

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
    // show the panel again, so you see the new witness and what it changed
    $('sheet').classList.remove('collapsed');
    placeToast();
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
    const g = gpsWitness(), s = stepsWitness();
    return (g ? [g] : []).concat(s ? [s] : [], state.witnesses);
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
    const gs = state.gps, raw = gs.raw;
    if (!gs.on || !raw) return null;
    const p = spoofed(raw), sigma = Math.max(4, raw.acc / 1.5);   // phones report a 68 % radius
    const note = gs.spoof === 'off' ? '' : ` · pulled ${G.fmtDist(p.off)} off (simulated spoof)`;
    let suspect = Date.now() < gs.suspectUntil, why = gs.jumpMsg;
    // GPS caught lying stays distrusted for as long as it stays wrong in the same way (a spoofer holding an
    // offset can't win back trust just by waiting). It is trusted again once it comes back to where the
    // other witnesses put you.
    const est = state.result && state.result.est;
    if (gs.liar && est && !suspect) {
      const off = enOffset(est, p), now = Math.hypot(off.e, off.n), was = Math.hypot(gs.liar.e, gs.liar.n);
      if (now < Math.max(3 * sigma, 0.3 * was)) gs.liar = null;
      else if (Math.hypot(off.e - gs.liar.e, off.n - gs.liar.n) < Math.max(100, 0.5 * was)) {
        suspect = true;
        why = `GPS is still ${G.fmtDist(now)} away from where the other witnesses put you, as when it was caught lying.`;
      }
    }
    return { id: 'gps', type: 'gps', kind: 'point', lat: p.lat, lon: p.lon, sigma, label: gs.sim ? 'GPS (simulated)' : 'GPS', suspect, why,
      detail: `±${G.fmtDist(2.45 * sigma)}${note}` };
  }

  // east/north offset of b from a, in metres
  function enOffset(a, b) {
    return { e: (b.lon - a.lon) * G.M_PER_DEG * Math.cos(a.lat * G.D2R), n: (b.lat - a.lat) * G.M_PER_DEG };
  }

  function toggleGps() {
    const gs = state.gps;
    if (gs.on) {
      if (gs.watch != null) navigator.geolocation.clearWatch(gs.watch);
      Object.assign(gs, { on: false, sim: false, watch: null, raw: null, prev: null, spoof: 'off', suspectUntil: 0, jumpMsg: '' });
      refreshButtons(); schedule();
      return;
    }
    if (!('geolocation' in navigator)) { noGps('This browser can’t read GPS.'); return; }
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
    }, (err) => {
      if (!gs.on || gs.sim) return;      // turned off, or a simulated GPS took over meanwhile
      if (err.code === 1) {
        // blocked: then GPS is off, and the button shows it
        navigator.geolocation.clearWatch(gs.watch);
        Object.assign(gs, { on: false, watch: null });
        refreshButtons(); schedule();
        noGps(window.isSecureContext
          ? 'GPS is blocked for this page, so it is off. To use it, allow location for this site in the browser (the icon next to the address), then tap GPS again.'
          : 'Browsers only give GPS to pages on https://, so GPS is off here.');
      } else if (!gs.raw) noGps('No GPS fix yet (indoors, or a laptop without GPS?). GPS stays on and keeps trying.');
    }, { enableHighAccuracy: true, maximumAge: 2000, timeout: 30000 });
  }

  // No GPS position here (a laptop, indoors, or blocked): say so, and offer a simulated GPS for demos
  function noGps(msg) {
    toastHTML(`<span></span><div class="chips"><button class="chip" data-simgps="1">${ico('fa-satellite')} Simulated GPS at the map centre</button></div>`, 9000);
    $('toast').querySelector('span').textContent = msg;
  }

  // For demos without a GPS fix: a GPS witness at the map centre, clearly labelled as simulated. Spoof GPS and
  // Cell towers work with it just as with the real GPS (whose path above is unchanged). Tap GPS to turn it off.
  function simGps() {
    const gs = state.gps, c = map.getCenter();
    if (gs.watch != null) navigator.geolocation.clearWatch(gs.watch);
    Object.assign(gs, { on: true, sim: true, watch: null, raw: { lat: c.lat, lon: c.lng, acc: 8 }, prev: null, spoof: 'off', suspectUntil: 0, jumpMsg: '' });
    refreshButtons(); schedule();
    toast('Simulated GPS at the map centre (for demos: not your real position). Spoof GPS and Cell towers work with it now.', 7000);
  }

  // A position that moves faster than you possibly can is a lie, whatever the other witnesses say
  function speedCheck() {
    const gs = state.gps, now = Date.now(), p = spoofed(gs.raw), prev = gs.prev;
    gs.prev = { lat: p.lat, lon: p.lon, t: now, acc: gs.raw.acc };
    if (!prev) return;
    const d = G.dist(prev.lat, prev.lon, p.lat, p.lon), dt = Math.max(1, (now - prev.t) / 1000), m = MODES[state.mode];
    if (d > 3 * (prev.acc + gs.raw.acc) + 20 && d / dt > 1.5 * m.maxSpeed) {
      gs.suspectUntil = now + 60000;
      gs.jumpMsg = `GPS jumped ${G.fmtDist(d)} in ${Math.round(dt)} s. Nobody can ${m.verb} that fast.`;
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
  // GPS that the other witnesses vouch for (green light, GPS agreeing). Only this may calibrate the compass:
  // calibrating against a GPS that is already spoofed would quietly bend every compass line as well.
  function gpsConfirmed() {
    const r = state.result, ws = allWitnesses(), i = ws.findIndex((w) => w.type === 'gps');
    if (!trustedGps() || !r || r.light !== 'green' || i < 0 || !r.status[i] || r.status[i].state !== 'agrees') return null;
    return state.gps.raw;
  }

  // ---------- "I'm about here" ----------
  // Your own guess only counts as a separate witness if it comes from what you see, so GPS (and everything
  // built on it) is hidden while you pick the spot.
  function startYou() {
    if (state.story) return;
    state.pending = 'you';
    hideWhileGuessing();
    const chips = [50, 200, 1000, 5000].map((r) =>
      `<button class="chip ${r === state.youRadius ? 'on' : ''}" data-r="${r}">±${G.fmtDist(r)}</button>`).join('');
    toastHTML('<b>Tap where YOU think you are, from what you see.</b> GPS is hidden for now: a guess copied from it is no extra witness.' +
      `<div class="chips">${chips}<button class="chip" data-cancel="1">Cancel</button></div>`, 0);
    collapseSheet();
  }
  // Hide the witness shapes, the glow and Alibi's dot while "I'm about here" waits for your tap
  function hideWhileGuessing() {
    const on = state.pending === 'you';
    for (const g of [layer.shapes, layer.est]) {
      if (on) map.removeLayer(g);
      else if (!map.hasLayer(g)) g.addTo(map);
    }
    map.getPane('heat').style.display = on ? 'none' : '';
  }
  $('toast').addEventListener('click', (e) => {
    const b = e.target.closest('.chip');
    if (!b) return;
    if (b.dataset.cancel) { state.pending = null; hideToast(); hideWhileGuessing(); return; }
    if (b.dataset.simgps) { hideToast(); simGps(); return; }
    if (b.dataset.pick) {
      state.pending = 'landmark';
      hideWhileGuessing();
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
      const lm = addLandmark({ lat: e.latlng.lat, lon: e.latlng.lng, name: 'My landmark', kind: 'Landmark' });
      drawLandmarks();
      onLandmarkClick(lm);
      return;
    }
    state.pending = null;
    hideToast();
    hideWhileGuessing();
    if (what === 'you') {
      // ± is a 95 % radius; for a round 2-D bell curve that is 2.45 sigma
      addWitness({ type: 'you', kind: 'point', lat: e.latlng.lat, lon: e.latlng.lng, sigma: state.youRadius / 2.45,
        label: 'I’m about here', detail: `your guess · ±${G.fmtDist(state.youRadius)}` });
    } else if (what === 'landmark') {
      const lm = addLandmark({ lat: e.latlng.lat, lon: e.latlng.lng, name: 'My landmark', kind: 'Landmark' });
      drawLandmarks();
      aimAtLandmark(lm);
    }
  });

  // ---------- landmarks ----------
  // Offer the no-network way too: you can always mark a landmark's spot on the map yourself
  function offerPick(msg) {
    toastHTML(`<span></span><div class="chips"><button class="chip" data-pick="1">${ico('fa-thumbtack')} Mark a landmark on the map myself</button></div>`, 8000);
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
    offerPick(had ? 'Tap a landmark you can see.' : `Found ${state.landmarks.length}. Tap one you can see.`);
    collapseSheet();
  }

  // Tapping a landmark: normally aim at it; while measuring an angle, it picks A or B
  function onLandmarkClick(lm) {
    // while you pick where you are, a tap on a landmark icon means "I'm here", not "aim at it"
    if (state.pending === 'you') { map.fire('click', { latlng: L.latLng(lm.lat, lm.lon) }); return; }
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
      hint: 'Put the red cross on A and press Take. Then turn on the spot (don’t walk) to B and press Take again.',
      onLock: (r) => {
        addWitness({ type: 'angle', kind: 'angle', a: { lat: a.lat, lon: a.lon }, b: { lat: b.lat, lon: b.lon },
          ang: r.value, sigma: r.sigma, photo: r.photo, lmIds: [a.id, b.id], label: `${a.name} ↔ ${b.name}`,
          detail: `${r.source === 'tool' ? 'sextant' : r.viaCompass ? 'phone compass' : 'gyroscope'} · ${Math.abs(r.value).toFixed(1)}° ${r.value >= 0 ? 'right' : 'left'} from A to B · ±${+(2 * r.sigma).toFixed(1)}°` });
        drawLandmarks();
      },
    });
  }

  // Too many markers hide each other and catch the wrong tap. Always show the ones that matter (suggested, used,
  // your own, angle A), then the masts your phone hears, then up to 40 more that don't overlap on screen: the
  // best kinds first (OpenStreetMap's order), masts last. Zooming in spreads them out, so more appear.
  const MAX_MARKS = 40, MARK_GAP = 32;      // px between marker centres; the icons are 30 px wide, so they never overlap
  function drawLandmarks() {
    layer.marks.clearLayers();
    if (state.story || state.replay) return;
    const used = (lm) => state.witnesses.some((w) => w.lmId === lm.id || (w.lmIds && w.lmIds.includes(lm.id)));
    const must = (lm) => lm.id === state.suggestId || lm.kind === 'Landmark' || used(lm) || (state.pending === 'angleB' && lm === state.angleA);
    const tier = (lm) => (must(lm) ? 0 : lm.heard ? 1 : lm.kind === 'Mast' ? 3 : 2);
    const view = map.getBounds().pad(0.1), shown = [];
    let extra = 0;
    for (const lm of state.landmarks.slice().sort((a, b) => tier(a) - tier(b))) {     // a stable sort keeps the order inside a tier
      const pt = map.latLngToContainerPoint([lm.lat, lm.lon]);
      if (tier(lm) > 0) {
        if (extra >= MAX_MARKS || !view.contains([lm.lat, lm.lon]) || shown.some((p) => p.distanceTo(pt) < MARK_GAP)) continue;
        extra++;
      }
      shown.push(pt);
      const name = lm.heard ? `${lm.name} · your phone hears it` : lm.name;
      const cls = 'lm-icon' + (used(lm) ? ' used' : '') + (lm.heard ? ' heard' : '') + (state.suggestId === lm.id ? ' suggest' : '');
      const m = L.marker([lm.lat, lm.lon], { icon: L.divIcon({ className: cls, iconSize: [30, 30], iconAnchor: [15, 15],
        html: `<span><i class="fa-solid ${OSM.iconOf(lm.kind).cls}" aria-hidden="true"></i></span>` }) })
        .bindTooltip(esc(name), { direction: 'top', offset: [0, -14] })
        .on('click', () => onLandmarkClick(lm))
        .addTo(layer.marks);
      // a name for screen readers and voice control (the icon alone has none)
      const el = m.getElement();
      if (el) el.setAttribute('aria-label', (lm.name === lm.kind ? name : `${name} (${lm.kind.toLowerCase()})`) + (state.suggestId === lm.id ? ', suggested next' : ''));
    }
  }
  map.on('moveend', () => { if (state.landmarks.length) drawLandmarks(); });

  function aimAtLandmark(lm) {
    if (state.story) return;
    const ref = refPoint(), gpsOk = gpsConfirmed();
    const dir = G.compass8(G.bearing(ref.lat, ref.lon, lm.lat, lm.lon));
    openAim({
      mode: 'bearing', lm, name: lm.name, title: `Aim at ${lm.name}`, calibrate: !!gpsOk,
      hint: `Put the red cross on it, hold still for a second, then press Take. It should be roughly ${dir} of you.`,
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
      : 'Nothing to aim at right now: the Sun is down (or too low to measure well) and it is not dark enough for stars yet. Stars show up once the Sun is 6° below the horizon.');
  }

  function aimAtSky(b) {
    openAim({
      mode: 'elev', body: b.id, name: b.name, title: `Aim at ${b.name}`,
      hint: (b.id === 'sun' ? 'Never look straight at the Sun: aim the phone, look at the screen. ' : '') +
        `Look ${G.compass8(b.az)}, about ${Math.round(b.alt)}° up. Put the red cross on it, hold still, then press Take.`,
      onLock: (r) => {
        const trueAlt = r.value - SKY.refraction(r.value);
        addWitness({ type: 'sky', kind: 'sky', body: b.id, time: new Date(), alt: trueAlt, sigma: r.sigma, photo: r.photo, label: b.name,
          detail: `${r.value.toFixed(1)}° above the horizon · ${r.source === 'tool' ? 'inclinometer' : 'phone tilt'} · ±${(2 * r.sigma).toFixed(1)}°` });
      },
    });
  }

  // ---------- cell towers (simulated: a web page cannot read them) ----------
  // Every mast nearby is a landmark you can see and aim at. Masts within 250 m of each other count as one
  // site (often several operators on the same roof or hill): the phone can't tell them apart well enough
  // for separate rings. Alibi uses at most three sites, picked in clearly different directions, the way a
  // GPS receiver prefers satellites spread across the sky. The nearest is the serving cell, whose timing
  // advance gives a fairly good distance; the others only give signal strength, a much rougher distance.
  async function actTowers() {
    if (state.story) return;
    const truth = state.gps.raw;      // the real GPS position, or the simulated one at the map centre
    if (!truth) {
      noGps('Browsers can’t read cell towers, so this simulates what your phone would hear around your GPS position. Turn on GPS and wait for a fix, or use a simulated GPS.');
      return;
    }
    toast('Looking up masts near you…', 0);
    try {
      const all = (await OSM.masts(truth.lat, truth.lon, 6000))
        .map((m) => Object.assign(m, { d: G.dist(truth.lat, truth.lon, m.lat, m.lon) }))
        .filter((m) => m.d > 50).sort((a, b) => a.d - b.d).slice(0, 40);    // the nearest 40 keep the map readable
      if (!all.length) { toast('No masts are mapped near you.'); return; }
      const sites = [];
      for (const m of all) {
        const s = sites.find((x) => G.dist(x.lat, x.lon, m.lat, m.lon) < 250);
        if (s) s.masts.push(m);
        else sites.push({ lat: m.lat, lon: m.lon, d: m.d, masts: [m] });
      }
      const range = Math.max(2000, 2 * sites[0].d), dir = (s) => G.bearing(truth.lat, truth.lon, s.lat, s.lon);
      const heard = [sites[0]];
      for (const s of sites.slice(1)) {
        if (heard.length === 3 || s.d > range) break;
        if (heard.every((h) => Math.abs(G.wrap180(dir(h) - dir(s))) > 45)) heard.push(s);
      }
      state.landmarks.forEach((lm) => { lm.heard = false; });
      for (const s of sites) {
        for (const m of s.masts) addLandmark({ lat: m.lat, lon: m.lon, name: m.name, kind: 'Mast' }).heard = heard.includes(s);
      }
      state.witnesses = state.witnesses.filter((w) => w.type !== 'tower');
      heard.forEach((s, i) => {
        const serving = i === 0;
        const sigma = serving ? Math.max(120, 0.08 * s.d) : Math.max(250, 0.35 * s.d);
        const r = Math.max(50, s.d + 1.2 * sigma * noise(s.lat, s.lon));   // a made-up error, the same every time
        addWitness({ type: 'tower', kind: 'range', lat: s.lat, lon: s.lon, r, sigma, serving,
          label: `${serving ? 'Serving' : 'Neighbour'} cell (simulated)`,
          detail: `${serving ? 'timing advance' : 'signal strength'} · about ${G.fmtDist(r)} away · ±${G.fmtDist(2 * sigma)}` +
            (s.masts.length > 1 ? ` · ${s.masts.length} masts at one site` : '') });
      });
      drawLandmarks();
      toast(`${all.length} masts nearby in ${sites.length} sites. Your phone uses ${heard.length} of them (simulated), spread around you, so only those get a ring.`, 7000);
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
    if (!camOk) {
      setSim(true);
      toast('No camera here (or the browser blocks it), so this is a simulated view built from the map. Drag it to turn.', 5000);
    }
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
    $('simToggle').innerHTML = on ? `${ico('fa-camera')} Use camera` : `${ico('fa-gamepad')} Simulated view`;
  }

  // The button at the top right: go to the simulated view, or back to the camera only if there is one
  async function toggleSim() {
    if (!aim) return;
    if (!sim.on) { setSim(true); restartAngle(); return; }
    if (!camStream) {
      try { camStream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: { ideal: 'environment' } }, audio: false }); }
      catch (e) { camStream = null; }
      if (!aim) { stopCamera(); return; }
      if (!camStream) { toast('No camera here (or the browser blocks it), so you stay in the simulated view.', 5000); return; }
      $('cam').srcObject = camStream;
    }
    setSim(false);
    restartAngle();
    if (!SEN.alive()) toast('No compass or tilt sensor here, so the camera can’t measure (the readings stay “—”). Take the photo and type the value, or use the simulated view.', 7000);
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
    if (sim.on) return { heading: sim.heading, rel: sim.heading, gyro: true, elev: sim.pitch };
    const c = SEN.alive() ? SEN.current() : null;
    if (!c) return null;
    const heading = c.heading != null ? correctedBearing(c.heading) : null;
    return { heading, rel: c.rel != null ? c.rel : heading, gyro: c.rel != null, elev: c.elev };
  }

  function readout() {
    const r = reading();
    if (aim && aim.mode === 'angle') {
      const turned = aim.step === 2 && r && r.rel != null && aim.first.yaw != null ? G.wrap180(r.rel - aim.first.yaw) : null;
      $('aimBrg').textContent = turned == null ? (aim.step === 1 ? 'aim at A' : '—') : `${turned >= 0 ? '+' : ''}${turned.toFixed(1)}°`;
      const lbl = r && r.gyro === false ? 'Turned from A (compass: no gyroscope)' : 'Turned from A (gyroscope)';
      if ($('aimBrgLabel').textContent !== lbl) $('aimBrgLabel').textContent = lbl;
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

  // Take: freeze the picture and the reading, then let the user check and correct it
  function takeShot() {
    if (!aim) return;
    if (aim.mode === 'angle') { takeAngleShot(); return; }
    let value = null, spread = 0, check = null;
    if (sim.on) value = aim.mode === 'bearing' ? sim.heading : sim.pitch;
    else {
      const avg = SEN.alive() ? SEN.average(1500) : null;
      if (avg && aim.mode === 'bearing' && avg.heading != null) {
        value = correctedBearing(avg.heading);
        spread = avg.headSpread || 0;
        check = SEN.compassCheck(10000);
      }
      else if (avg && aim.mode === 'elev') { value = avg.elev; spread = avg.elevSpread || 0; }
    }
    aim.shot = { photo: capturePhoto(), value, spread, check, simulated: sim.on };
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

  // Angle: the first Take remembers where A is (gyroscope heading), the second measures how far you turned to B.
  // A phone with no gyroscope reading falls back to the compass, and the review says so: magnets can spoil that.
  function takeAngleShot() {
    let gyro = null, compass = null, gSpread = 0, cSpread = 0;
    if (sim.on) gyro = sim.heading;
    else {
      const avg = SEN.alive() ? SEN.average(1000) : null;
      if (avg && avg.rel != null) { gyro = avg.rel; gSpread = avg.relSpread || 0; }
      if (avg && avg.heading != null) { compass = correctedBearing(avg.heading); cSpread = avg.headSpread || 0; }
    }
    const shot = { gyro, compass, gSpread, cSpread, yaw: gyro != null ? gyro : compass, canvas: captureCanvas() };
    if (aim.step === 1) {
      aim.first = shot;
      aim.step = 2;
      aim.lm = aim.b;
      $('aimTitle').textContent = `2/2 · Now turn to ${aim.b.name}`;
      $('aimHint').textContent = 'Turn on the spot (don’t walk) until the red cross is on B, then press Take.';
      toast(`A is saved. Now turn to ${aim.b.name}.`);
      return;
    }
    // both shots from the gyroscope if it can, else both from the compass (never one of each: different zeros)
    const a = aim.first, byGyro = a.gyro != null && gyro != null, byCompass = !byGyro && a.compass != null && compass != null;
    const value = byGyro ? G.wrap180(gyro - a.gyro) : byCompass ? G.wrap180(compass - a.compass) : null;
    const spread = byGyro ? Math.hypot(a.gSpread, gSpread) : byCompass ? Math.hypot(a.cSpread, cSpread) : 0;
    aim.shot = { photo: pairPhoto(a.canvas, shot.canvas), value, spread, simulated: sim.on, viaCompass: byCompass };
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
    $('aimHint').textContent = 'Put the red cross on A and press Take. Then turn on the spot (don’t walk) to B and press Take again.';
  }

  // A 4:3 picture around the crosshair, from the camera or the simulated view
  function captureCanvas() {
    const el = sim.on ? $('simView') : $('cam');
    const sw = sim.on ? el.width : el.videoWidth, sh = sim.on ? el.height : el.videoHeight;
    if (!sw || !sh) return null;
    const scale = Math.max(el.clientWidth / sw, el.clientHeight / sh);     // the screen shows it "object-fit: cover"
    const visW = el.clientWidth / scale, visH = el.clientHeight / scale;
    const cx = sw / 2, cy = sh / 2;      // the cross is on the camera axis: the middle of the picture
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
      { id: 'phone', icon: 'fa-mobile-screen', label: 'Phone compass', pm: () => (state.compassCalibrated ? 4 : 7) },
      { id: 'hand', icon: 'fa-compass', label: 'Hand compass', pm: () => 3 },
    ],
    elev: [
      { id: 'phone', icon: 'fa-mobile-screen', label: 'Phone tilt', pm: () => 1 },
      { id: 'tool', icon: 'fa-ruler-combined', label: 'Inclinometer / sextant', pm: () => 0.4 },
    ],
    angle: [
      // the gyroscope; or, on a phone that gave no gyroscope reading, the compass (± like any phone compass)
      { id: 'phone', icon: 'fa-mobile-screen', label: () => (aim.shot && aim.shot.viaCompass ? 'Phone compass' : 'Phone gyroscope'),
        pm: () => (aim.shot && aim.shot.viaCompass ? 7 : 2) },
      { id: 'tool', icon: 'fa-ruler-combined', label: 'Sextant / protractor', pm: () => 0.4 },
    ],
  };

  function declHere() {
    const r = refPoint();
    return G.inFinland(r.lat, r.lon) ? G.declination(r.lat, r.lon) : 0;
  }

  function showReview() {
    const s = aim.shot;
    hideToast();      // a leftover hint must not sit over the review card
    $('aimPanel').classList.add('hidden');
    $('review').classList.remove('hidden');
    $('reviewImg').src = s.photo || '';
    $('reviewImg').classList.toggle('hidden', !s.photo);
    $('reviewTitle').textContent = aim.name;
    $('reviewNote').textContent = s.value == null ? 'No sensor reading here, so type the value.'
      : aim.mode === 'angle' ? (s.simulated ? 'Simulated gyroscope reading: how far you turned from A to B.'
        : s.viaCompass ? 'This phone gave no gyroscope reading, so the turn from A to B comes from the compass. Magnets and metal can spoil that, so the ± is wider (±7°, like the phone compass).'
          : 'Gyroscope reading: how far you turned from A to B.')
        : s.simulated ? 'Simulated phone reading. Fix it below, or switch to a hand compass.'
          : 'Phone reading. Fix it below if you measured it better another way.';
    $('reviewValue').value = s.value == null ? '' : s.value.toFixed(1);
    $('reviewPm').value = SOURCES[aim.mode][0].pm();
    const warn = compassWarning(s);
    if (warn) {
      $('reviewNote').textContent = warn.text;
      $('reviewPm').value = Math.max(SOURCES[aim.mode][0].pm(), warn.pm);
    }
    $('reviewCalibRow').classList.toggle('hidden', !(aim.mode === 'bearing' && aim.calibrate && !s.simulated));
    $('reviewCalib').checked = false;
    renderSources();
    updateReviewNote();
  }

  // A reason not to trust this phone compass reading: the compass check against the gyroscope, or iPhone's own ±
  function compassWarning(s) {
    if (aim.mode !== 'bearing' || s.simulated || !s.check) return null;
    const { drift, accuracy } = s.check;
    if (accuracy != null && accuracy < 0) {
      return { pm: 20, text: 'The iPhone says its compass needs calibrating (wave the phone in a figure 8). Or use a hand compass, or Angle A↔B, which needs no compass.' };
    }
    if (drift != null && drift > 5) {
      return { pm: Math.ceil(2 * drift), text: `Careful: in the last 10 s the compass turned ${Math.round(drift)}° differently from the gyroscope, so something magnetic may be near (metal, a car, a magnet in the phone case). The ± is wider. Step away from metal, or use Angle A↔B, which needs no compass.` };
    }
    if (accuracy != null && accuracy > 7) {
      return { pm: Math.ceil(accuracy), text: `The iPhone says its compass is only good to ±${Math.round(accuracy)}°, so the ± is wider.` };
    }
    return null;
  }

  function renderSources() {
    const box = $('reviewSource');
    box.innerHTML = '';
    for (const src of SOURCES[aim.mode]) {
      const b = document.createElement('button');
      b.innerHTML = `${ico(src.icon)} ${typeof src.label === 'function' ? src.label() : src.label}`;
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
        : `From A, turn ${Math.abs(v).toFixed(1)}° to the ${v >= 0 ? 'right' : 'left'} to see B. ` +
          (aim.source === 'phone' && aim.shot.viaCompass ? 'Measured with the compass, so magnets and metal can spoil it.' : 'No compass involved, so magnets can’t spoil it.');
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
    const r = { value: v, sigma, source: aim.source, photo: aim.shot.photo, calibrate: $('reviewCalib').checked && aim.source === 'phone',
      viaCompass: aim.source === 'phone' && !!aim.shot.viaCompass };
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

  // Labels go on last: the target's first (it always wins), then named landmarks nearest first, then stars.
  // A label that would cover one already placed (or the target) is left out, and none runs under the title bar.
  function placeTags(ctx, tags, keepOut, W, top) {
    const placed = keepOut.slice();
    tags.sort((a, b) => !!b.strong - !!a.strong || (a.rank || 0) - (b.rank || 0) || (a.d || 0) - (b.d || 0));
    for (const t of tags) {
      ctx.font = `${t.strong ? 700 : 600} ${t.strong ? 14 : 12}px system-ui, sans-serif`;
      const w = ctx.measureText(t.text).width + 12;
      const x = Math.max(w / 2 + 2, Math.min(W - w / 2 - 2, t.x)), y = Math.max(top + 17, t.y);
      const box = { l: x - w / 2 - 3, r: x + w / 2 + 3, t: y - 17, b: y + 7 };
      if (!t.strong && placed.some((p) => p.l < box.r && box.l < p.r && p.t < box.b && box.t < p.b)) continue;
      placed.push(box);
      tag(ctx, t.text, x, y, t.strong);
    }
  }

  // v: { from, heading, pitch, time, landmarks, target | targetName, body, top (height of the title bar) }
  function drawView(ctx, W, H, v) {
    const hfov = W >= H ? 62 : 48, k = W / hfov;            // pixels per degree
    const cx = W / 2, cy = H / 2, horizon = cy + v.pitch * k;   // the camera axis is the middle of the picture
    const tags = [], keepOut = [];
    const sx = (az) => cx + G.wrap180(az - v.heading) * k;
    const sp = SKY.radec('sun', v.time), sunAlt = SKY.altAz(sp.ra, sp.dec, v.from.lat, v.from.lon, v.time).alt;
    const night = sunAlt < -6, dusk = !night && sunAlt < 2;

    const skyGrad = ctx.createLinearGradient(0, horizon - H, 0, horizon);
    const cols = night ? ['#020617', '#1e293b'] : dusk ? ['#1e3a8a', '#fb923c'] : ['#1d4ed8', '#bfdbfe'];
    skyGrad.addColorStop(0, cols[0]); skyGrad.addColorStop(1, cols[1]);
    ctx.fillStyle = skyGrad;
    ctx.fillRect(0, 0, W, H);

    // the Sun and the stars the Sky picker offers right now, so the two always agree (and the target, if any),
    // where you would see them (air lifts them slightly: refraction)
    const bodies = SKY.visible(v.from.lat, v.from.lon, v.time);
    if (v.body && !bodies.some((b) => b.id === v.body)) bodies.push({ id: v.body, name: SKY.name(v.body), mag: v.body === 'sun' ? -26 : 1 });
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
      if (v.body === b.id) tags.push({ text: b.name, x, y: y - 14, strong: true });
      else if (b.mag < 0.6) tags.push({ text: b.name, x, y: y - 10, rank: 2, d: 0 });
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
      if (lm.kind !== 'Hill top') ctx.fillRect(x - 1.5, top, 3, Math.max(0, horizon - top));   // towers stand on a post; hills don't
      ctx.font = `900 ${Math.round(size * 0.8)}px "Font Awesome 6 Free"`;
      ctx.textAlign = 'center';
      ctx.fillStyle = night ? '#cbd5e1' : '#1f2937';
      ctx.fillText(OSM.iconOf(lm.kind).glyph, x, top);
      const isTarget = v.target === lm || (v.targetName && v.targetName === lm.name);
      if (isTarget) keepOut.push({ l: x - size / 2, r: x + size / 2, t: top - size, b: top });   // nothing hides the target
      if (isTarget || d < 2500) tags.push({ text: `${lm.name} · ${G.fmtDist(d)}`, x, y: top - size - 2, strong: isTarget, rank: lm.named === false ? 1 : 0, d });
    }
    placeTags(ctx, tags, keepOut, W, v.top || 0);
  }

  function drawSimView() {
    const cv = $('simView'), dpr = window.devicePixelRatio || 1, W = cv.clientWidth, H = cv.clientHeight;
    if (!W || !H) return;
    if (cv.width !== Math.round(W * dpr) || cv.height !== Math.round(H * dpr)) { cv.width = Math.round(W * dpr); cv.height = Math.round(H * dpr); }
    const ctx = cv.getContext('2d');
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    drawView(ctx, W, H, { from: simFrom(), heading: sim.heading, pitch: sim.pitch, time: new Date(),
      landmarks: state.landmarks, target: aim.lm, body: aim.body, top: $('aimTop').offsetHeight - 12 });
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
    const lms = Object.values(D.peaks).map((p) => ({ lat: p.lat, lon: p.lon, name: p.name, kind: 'Hill top' }))
      .concat(Object.values(D.huts).map((h) => ({ lat: h.lat, lon: h.lon, name: h.name, kind: 'Hut' })))
      .concat([D.mast].concat(D.masts).map((m) => ({ lat: m.lat, lon: m.lon, name: m.name, kind: 'Mast' })));
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
    crosshair(ctx, 160, 120);      // the camera axis: the middle of the picture
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
  const STEP_LEN = 0.7, STEP_DRIFT = 0.08;     // metres per step; steps drift about 8 % of the distance
  function setSteps(on) {
    if (on === state.steps) return;
    state.steps = on;
    state.walk = null;
    if (on) SEN.start().then((ok) => { if (!ok) toast('Motion sensors are not available or not allowed.'); });
    keepAwake(on);
    SEN.setSteps(on, (cur) => {
      if (!cur || cur.heading == null) return;
      const h = correctedBearing(cur.heading) * G.D2R;
      const de = STEP_LEN * Math.sin(h), dn = STEP_LEN * Math.cos(h);
      for (const w of state.witnesses) {
        const m = w.move || (w.move = { dE: 0, dN: 0, sigma: 0, walked: 0 });
        m.dE += de; m.dN += dn; m.walked += STEP_LEN;
        m.sigma = 2 + STEP_DRIFT * m.walked;
      }
      if (state.walk) { state.walk.dE += de; state.walk.dN += dn; state.walk.walked += STEP_LEN; }
      if (++stepCount % 4 === 0) schedule();
    });
  }

  // A web page can't count steps with the screen off, so keep the screen on while step counting runs
  let wakeLock = null;
  async function keepAwake(on) {
    try {
      if (on && !wakeLock && navigator.wakeLock) wakeLock = await navigator.wakeLock.request('screen');
      if (!on && wakeLock) { await wakeLock.release(); wakeLock = null; }
    } catch (e) { wakeLock = null; }
  }
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible' && state.steps) { wakeLock = null; keepAwake(true); }
  });

  // The step watchdog: the last position Alibi could vouch for (a green light), carried along by your steps
  // and compass. It runs in the background and is a witness of its own, so a GPS that drifts away from it
  // gets caught without you doing anything; then Alibi asks you for a sighting. It is moved to each new
  // green position, but never to an unchecked GPS fix, or a slow spoofer could drag it along.
  function stepsWitness() {
    const k = state.walk;
    if (!state.steps || !k || k.walked < 30) return null;
    const p = G.offset(k.lat, k.lon, k.dE, k.dN), sigma = Math.hypot(k.sigma, 2 + STEP_DRIFT * k.walked);
    return { id: 'steps', type: 'steps', kind: 'point', lat: p.lat, lon: p.lon, sigma, label: 'Steps + compass',
      detail: `${k.green ? 'last checked position' : 'where you started counting steps (not checked)'} + ${G.fmtDist(k.walked)} walked · ±${G.fmtDist(2.45 * sigma)}` };
  }
  function anchorWalk(res) {
    if (!state.steps || state.story || state.replay || !res.est) return;
    const green = res.light === 'green';
    if (!state.walk || (green && state.walk.walked >= 1)) {
      state.walk = { lat: res.est.lat, lon: res.est.lon, sigma: (res.pl || res.r95) / 2.45, dE: 0, dN: 0, walked: 0, green };
    }
  }

  function clearAll() {
    state.witnesses = [];
    state.landmarks = [];
    state.suggestId = null;
    state.walk = null;
    Object.assign(state.gps, { spoof: 'off', suspectUntil: 0, jumpMsg: '', prev: null, liar: null });
    drawLandmarks(); refreshButtons(); schedule();
  }

  // ---------- Lapland demo ----------
  async function startStory() {
    await faReady;    // the story's witness photos draw icons, so the icon font must be there first
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
    const icon = (cls, fa) => L.divIcon({ className: cls, html: `<span><i class="fa-solid ${fa}" aria-hidden="true"></i></span>`, iconSize: [26, 26], iconAnchor: [13, 13] });
    // a marker with its name as a tooltip, and as its name for screen readers
    const mark = (p, cls, fa, text, dy) => {
      const m = L.marker([p.lat, p.lon], { icon: icon(cls, fa) }).bindTooltip(esc(text), { direction: 'top', offset: [0, dy || -10] }).addTo(layer.story);
      if (m.getElement()) m.getElement().setAttribute('aria-label', text);
    };
    for (const p of Object.values(D.peaks)) mark(p, 'peak-icon', 'fa-mountain', `${p.name} (fell top)`);
    for (const h of Object.values(D.huts)) mark(h, 'hut-icon', 'fa-house-chimney', h.name);
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
    $('storyNext').innerHTML = k === STORY.count - 1 ? `${ico('fa-rotate-left')} Start again` : `Next ${ico('fa-chevron-right')}`;
    const tl = state.story.truthLayer;
    tl.clearLayers();
    L.polyline(st.track, { color: '#7c2d12', weight: 4, opacity: 0.9, interactive: false }).addTo(tl);
    L.marker([st.truth.lat, st.truth.lon], {
      icon: L.divIcon({ className: 'truth-icon aino', html: `<span>${ico('fa-person-hiking')}</span><em>Aino (the truth)</em>`, iconSize: [30, 30], iconAnchor: [15, 15] }),
      interactive: false, zIndexOffset: 1000,
    }).addTo(tl);
    clearTimeout(runTimer);
    run();          // draw the step now, so the view below makes room for its alerts and witness list
    flyToFit(storyItems(st), st.view.zoom || 15);
  }

  // What must be visible in a demo step, with room (px) for each label: Aino, every witness's ± circle, and the
  // fell tops or mast that each line, arc or ring starts from. Star bands are hundreds of km wide; the rest is enough.
  const LABEL_ROOM = { gps: { r: 75 }, you: { l: 125 }, steps: { l: 65, r: 65, b: 50 }, landmark: { l: 50, r: 50, t: 34 },
    angle: { l: 55, r: 55, t: 34 }, tower: { l: 80, r: 80, t: 34 } };
  function storyItems(st) {
    const items = [{ lat: st.truth.lat, lon: st.truth.lon, l: 52, r: 52, t: 40, b: 16 }];     // Aino, her label above
    for (const w of st.witnesses) {
      const room = Object.assign({ l: 12, r: 12, t: 12, b: 12 }, LABEL_ROOM[w.type]);
      if (w.kind === 'point') {
        items.push(Object.assign({ lat: w.lat, lon: w.lon }, room));
        for (const a of [0, 90, 180, 270]) items.push(G.dest(w.lat, w.lon, a, 2 * w.sigma));
      } else if (w.kind === 'bearing' || w.kind === 'range') items.push(Object.assign({ lat: w.lat, lon: w.lon }, room));
      else if (w.kind === 'angle') items.push(Object.assign({}, w.a, room), Object.assign({}, w.b, room));
    }
    return items;
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
    openPicker('Replay a real GPS recording', Object.entries(RP.SCENES).map(([id, s]) => ({
      html: `<b>${ico(RP.LOGS[s.log].icon)} ${esc(s.title)}</b><small>${s.attack ? ico('fa-user-secret') + ' ' : ''}${esc(s.sub)}</small>`,
      onPick: () => startReplay(id),
    })), 'The organisers’ own recordings (Google’s GnssLogger app on an Android phone). The attacks are simulated on top of them: ' +
      'they change only what GPS reports, never the vehicle’s own speed sensor or the phone’s gyroscope.');
    $('pickerBody').querySelectorAll('.pick').forEach((b) => b.classList.add('scene'));
  }

  async function startReplay(id) {
    const sc = RP.SCENES[id], log = RP.LOGS[sc.log];
    toast('Loading the recording…', 0);
    let data;
    try { data = RP.prepare(await RP.load(sc.log), sc); } catch (e) { toast('Could not load the recording (' + e.message + ').'); return; }
    hideToast();
    if (state.story) exitStory();
    if (state.replay) clearTimeout(state.replay.timer);
    state.pending = null;
    const nTrue = new Int32Array(data.ep.length);
    data.ep.forEach((e, i) => { nTrue[i] = (i ? nTrue[i - 1] : 0) + (e.truth ? 1 : 0); });
    const R = state.replay = { id, data, nTrue, i: 0, playing: false, timer: 0, witnesses: [], alert: null, limit: data.limit, card: null };
    wireReplay();
    document.body.classList.add('replay-mode');
    $('replay').classList.remove('hidden');
    drawLandmarks();
    $('replayTitle').innerHTML = `${ico(log.icon)} ${esc(sc.title)}`;
    $('replayNote').textContent = sc.attack
      ? `Simulated attack on a real recording: only what GPS reports is faked. The recorded speed stands in for the ${data.vehicle}’s own ${data.sensor}, which a spoofer can’t touch. The grey dot is the real position; Alibi can’t see it.`
      : `Real recording. The second witness is dead reckoning: the recorded speed (standing in for the ${data.vehicle}’s ${data.sensor}) and the phone’s gyroscope, carried on from the GPS fix trusted ${RP.P.W} s earlier.`;
    $('replayPlay').innerHTML = `${ico('fa-play')} Play`;
    $('replayCard').classList.add('hidden');
    $('replaySlider').max = data.ep.length - 1;
    layer.story.clearLayers();
    L.polyline(data.track, { color: '#64748b', weight: 3, opacity: 0.55, interactive: false }).addTo(layer.story);
    R.done = L.polyline([], { color: '#0f172a', weight: 4, opacity: 0.85, interactive: false }).addTo(layer.story);
    if (data.attack && data.attack.kind !== 'jam') R.fake = L.polyline([], { color: BAD, weight: 3, opacity: 0.8, dashArray: '6 6', interactive: false }).addTo(layer.story);
    R.marks = L.layerGroup().addTo(layer.story);
    flyToBoundsVisible(L.latLngBounds(data.track));
    R.flying = true;                    // don't pan while the map flies to the whole track
    setTimeout(() => { R.flying = false; }, 1400);
    replayStep(Math.max(0, data.ep.findIndex((e) => e.gps)));
  }

  // the replay's own buttons and keys (set up once)
  let replayWired = false;
  function wireReplay() {
    if (replayWired) return;
    replayWired = true;
    $('replaySkip').onclick = replaySkip;
    $('replayContinue').onclick = () => playReplay(true);
    document.addEventListener('keydown', (e) => {
      if (!state.replay || e.target.tagName === 'INPUT' || e.target.tagName === 'BUTTON' || !$('picker').classList.contains('hidden')) return;
      if (e.key === ' ') { e.preventDefault(); toggleReplay(); }
      else if (e.key === 'ArrowRight' && !state.replay.playing) replayStep(Math.min(state.replay.data.ep.length - 1, state.replay.i + 1));
      else if (e.key === 'ArrowLeft' && !state.replay.playing) replayStep(Math.max(0, state.replay.i - 1));
      else if (e.key === 'Escape') exitReplay();
    });
  }

  function replayStatus(e, D) {
    const f = G.fmtDist, time = new Date(e.t * 1000).toISOString().slice(11, 19);
    const v = e.spdS != null ? `${Math.round(e.spdS * 3.6)} km/h` : e.dr ? `speed unknown, held at ${Math.round(e.dr.spd * 3.6)} km/h` : '';
    let s = `${time} UTC · ${v} · ${e.nsat} satellites. `;
    if (!e.gps) s += e.dr ? `No GPS for ${e.lost} s: dead reckoning carries on (±${f(e.dr.r95)}).` : 'No GPS fix yet.';
    else if (!e.gate || e.gate.state === 'start') s += 'First GPS fix: the starting point.';
    else if (e.rejected) s += `GPS ignored: ${f(e.gate.dist)} from dead reckoning (±${f(e.gate.r95)}, check limit ${f(e.gate.limit)}).`;
    else s += `GPS checked against ${e.dr.age} s of dead reckoning: ${f(e.gate.dist)} apart (±${f(e.gate.r95)}, check limit ${f(e.gate.limit)}).`;
    return s;
  }

  // the result card for an event: it stays until you press Continue
  function replayCardText(e, D) {
    const ev = e.event, f = G.fmtDist;
    if (!ev) return null;
    const how = e.dr && e.dr.gyro ? 'speed + gyroscope' : 'speed + direction';
    const real = D.attack && e.truth && e.gps ? G.dist(e.gps.lat, e.gps.lon, e.truth.lat, e.truth.lon) : 0;
    const lie = real > 20 ? ` (Simulated: GPS really is ${f(real)} off.)` : '';
    if (ev.kind === 'back') {
      const b = e.back;
      const why = b.held ? ` The recording has no speed in there, so the speed was only held for ${b.held} s: that is why the ± is so wide.` : '';
      return b.ok
        ? { tone: 'good', title: `GPS is back after ${b.gap} s`, text: `${f(b.dist)} from where ${how} said, after ${f(b.since)} without GPS. ` +
            `Dead reckoning was good to ±${f(b.r95)} (95 %), so GPS agrees and is trusted again. Until GPS has passed the check for about 25 s, Alibi can only vouch for it as closely as dead reckoning could, so the light may not be green yet.${why}${lie}` }
        : { tone: 'bad', title: `GPS is back after ${b.gap} s, in the wrong place`, text: `${f(b.dist)} from where ${how} said, far more than its ±${f(b.r95)} allows. ` +
            `Alibi does not trust it, goes on with dead reckoning, and keeps ignoring GPS while it tells the same lie.${why}${lie}` };
    }
    if (ev.kind === 'spoof') {
      const a = D.attack, drag = a && a.kind === 'drag' && e.i >= a.from ? ` (Simulated drag at ${a.speed} m/s, started ${e.i - a.from} s ago.)` : lie;
      return { tone: 'bad', title: 'GPS caught lying', text: `GPS is ${f(e.gate.dist)} from where the ${D.sensor} and gyroscope say: more than their ±${f(e.gate.r95)} allows ` +
        `(check limit ${f(e.gate.limit)}). Alibi stops trusting GPS, goes on with dead reckoning, and keeps ignoring GPS while it tells the same lie.${drag}` };
    }
    if (ev.kind === 'clear') {
      return { tone: 'good', title: 'GPS agrees again', text: `GPS is back where dead reckoning says (${f(e.gate.dist)} apart, ±${f(e.gate.r95)}) and no longer tells ` +
        `the lie it was caught with ${ev.since} s ago, so it is trusted again. Until it has passed the check for about 25 s, Alibi can only vouch for it as closely as dead reckoning could.` };
    }
    if (ev.kind === 'jam') return { tone: 'warn', title: 'Possible jamming', text: e.diag.text + (e.gps ? ' Alibi warns before the position is lost.' : '') };
    return null;
  }

  function showReplayCard(i) {
    const R = state.replay, c = replayCardText(R.data.ep[i], R.data);
    if (!c) return false;
    R.card = i;
    $('replayCardTitle').textContent = c.title;
    $('replayCardText').textContent = c.text;
    $('replayCard').className = 'replay-card ' + c.tone;
    return true;
  }
  function hideReplayCard() {
    if (state.replay) state.replay.card = null;
    $('replayCard').classList.add('hidden');
  }

  function replayStep(i) {
    const R = state.replay, D = R.data, ep = D.ep, e = ep[i], a = D.attack;
    R.i = i;
    $('replaySlider').value = i;
    R.witnesses = RP.witnesses(e, D);
    R.alert = e.diag ? e.diag.text : null;
    // the map: the track so far, the faked GPS trail, the real position during an attack, and where GPS came back
    R.done.setLatLngs(D.track.slice(0, R.nTrue[i]));
    if (R.fake) R.fake.setLatLngs(a && i >= a.from ? ep.slice(a.from, Math.min(i, a.to) + 1).filter((x) => x.gps && x.off).map((x) => [x.gps.lat, x.gps.lon]) : []);
    R.marks.clearLayers();
    if (a && e.truth && (e.off || e.held || (i >= a.from && i < a.to))) {
      L.marker([e.truth.lat, e.truth.lon], { icon: L.divIcon({ className: '', html: '<div class="real-dot"></div>', iconSize: [12, 12], iconAnchor: [6, 6] }), interactive: false })
        .bindTooltip('real position', { direction: 'left', offset: [-8, 0], permanent: true, className: 'wlabel' }).addTo(R.marks);
    }
    if (e.back) {
      L.marker([e.gps.lat, e.gps.lon], { icon: L.divIcon({ className: 'truth-icon', html: `<span>${ico('fa-crosshairs')}</span><em>GPS back</em>`, iconSize: [30, 30], iconAnchor: [15, 15] }),
        interactive: false, zIndexOffset: 800 }).addTo(R.marks);
    }
    if (e.event) showReplayCard(i); else if (R.card != null) hideReplayCard();
    // run the engine now (not 40 ms later), so the light, the alerts and the text change together
    clearTimeout(runTimer);
    run();
    replayHeader();
    const res = state.result;
    // a jamming warning and a green light would contradict each other: GPS may drop out any moment
    if (res && e.diag && e.diag.kind === 'jam' && res.light === 'green') {
      res.light = 'yellow';
      $('light').className = 'light yellow';
      $('headline').textContent = `Within ±${G.fmtDist(res.pl || res.r95)}, but GPS may be jammed`;
    }
    // the end of the recording: how did it go?
    if (i === ep.length - 1 && !e.event) {
      const ign = ep.filter((x) => x.rejected).length, mins = Math.round(ep.length / 60);
      $('replayCardTitle').textContent = 'End of the recording';
      $('replayCardText').textContent = a ? `${mins} minutes. During the simulated attack GPS was ignored for ${ign} s.`
        : `${mins} minutes of real driving or riding, checked every second: GPS was ${ign ? `ignored for ${ign} s` : 'never wrongly ignored'}.`;
      $('replayCard').className = 'replay-card good';
      R.card = i;
    }
    let text = replayStatus(e, D);
    if (a && e.truth && res && res.est) text += ` Alibi is ${G.fmtDist(G.dist(res.est.lat, res.est.lon, e.truth.lat, e.truth.lon))} from the real position.`;
    $('replayText').textContent = text;
    const here = e.gps && !e.rejected ? e.gps : e.dr;
    // when GPS is caught, zoom in so the gap between the lie, the real position and dead reckoning can be seen
    if (e.event && e.event.kind === 'spoof' && e.gps && e.dr) {
      flyToBoundsVisible(L.latLngBounds([e.gps, e.dr].concat(e.truth ? [e.truth] : []).map((p) => [p.lat, p.lon])).pad(1.5));
    } else if (!R.flying) replayKeepVisible(e.back ? [e.gps, e.dr] : [here, e.event && e.gps]);
    drawReplayChart();
  }

  // The engine's words are for live use: in a replay nothing can be added, so drop that advice
  function replayHeader() {
    const res = state.result;
    if (!res) return;
    if (res.empty) { $('headline').textContent = 'No position yet'; $('detail').textContent = 'The recording has no GPS fix yet.'; }
    else $('detail').textContent = String(res.detail || '').replace(/\s*(Stop and add|Add)\b[^.]*\./g, '').trim();
    const empty = $('replayWitnesses').querySelector('li.empty');
    if (empty) empty.textContent = 'No witness yet at this point of the recording.';
  }

  // keep the current position (and where GPS came back) in the part of the map that no panel covers
  function replayKeepVisible(pts) {
    pts = pts.filter(Boolean);
    if (!pts.length) return;
    const r = visibleRect(), pad = 30, xy = pts.map((p) => map.latLngToContainerPoint([p.lat, p.lon]));
    const x0 = Math.min(...xy.map((p) => p.x)), x1 = Math.max(...xy.map((p) => p.x)), y0 = Math.min(...xy.map((p) => p.y)), y1 = Math.max(...xy.map((p) => p.y));
    if (x0 >= r.left + pad && x1 <= r.right - pad && y0 >= r.top + pad && y1 <= r.bottom - pad) return;
    if (x1 - x0 > r.right - r.left - 2 * pad || y1 - y0 > r.bottom - r.top - 2 * pad) {
      const size = map.getSize();
      map.fitBounds(L.latLngBounds(pts.map((p) => [p.lat, p.lon])), { animate: false,
        paddingTopLeft: L.point(r.left + pad, r.top + pad), paddingBottomRight: L.point(size.x - r.right + pad, size.y - r.bottom + pad) });
      return;
    }
    map.panBy([(x0 + x1) / 2 - (r.left + r.right) / 2, (y0 + y1) / 2 - (r.top + r.bottom) / 2], { animate: false });
  }

  function toggleReplay() { playReplay(!state.replay.playing); }

  function playReplay(on) {
    const R = state.replay;
    R.playing = on;
    $('replayPlay').innerHTML = on ? `${ico('fa-pause')} Pause` : `${ico('fa-play')} Play`;
    clearTimeout(R.timer);
    if (on) { hideReplayCard(); R.timer = setTimeout(replayTick, 60); }
  }

  // play: quick through good GPS, slower around outages and attacks, and stop at every result
  function replayTick() {
    const R = state.replay;
    if (!R || !R.playing) return;
    const ep = R.data.ep;
    if (R.i >= ep.length - 1) { playReplay(false); return; }
    const pace = replayPace(R.i);
    let next = Math.min(ep.length - 1, R.i + pace.step);
    for (let k = R.i + 1; k <= next; k++) if (ep[k].event) { next = k; break; }
    replayStep(next);
    if (ep[next].event && R.card === next) { playReplay(false); return; }
    R.timer = setTimeout(replayTick, pace.ms);
  }

  function replayPace(i) {
    const ep = state.replay.data.ep, e = ep[i];
    let near = false;
    for (let k = Math.max(1, i - 4); k < Math.min(ep.length, i + 10) && !near; k++) near = !!ep[k].event || (!ep[k].gps && !!ep[k - 1].gps);
    if (near) return { step: 1, ms: 300 };                            // slow down before and after anything happens
    if (!e.gps || e.rejected) return { step: 1, ms: 140 };             // through an outage or an attack
    return { step: 4, ms: 150 };
  }

  // Prev / Next: the moments worth watching (outages and attacks), starting a few seconds before
  function jumpOutage(dir) {
    const R = state.replay, ep = R.data.ep;
    const moments = R.data.outs.map((o) => o.from).concat(ep.filter((e) => e.event && e.event.kind !== 'back').map((e) => e.i))
      .map((k) => Math.max(0, k - 6)).sort((x, y) => x - y);
    if (!moments.length) { toast('No outages or attacks in this recording: GPS was checked every second and never failed.'); return; }
    const k = dir > 0 ? moments.find((x) => x > R.i) : moments.slice().reverse().find((x) => x < R.i - 1);
    replayStep(k != null ? k : dir > 0 ? moments[0] : moments[moments.length - 1]);
  }

  // Skip: to the end of this outage, where GPS comes back (or to the next result)
  function replaySkip() {
    const R = state.replay, ep = R.data.ep;
    let k = -1;
    for (let j = R.i + 1; j < ep.length; j++) if (ep[j].event) { k = j; break; }
    if (k < 0) { toast('Nothing more happens in this recording.'); return; }
    if (R.playing) playReplay(false);
    replayStep(k);
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
    // stripes: no GPS (red), GPS ignored as a liar (amber), possible jamming (purple)
    const stripes = (test, color) => {
      ctx.fillStyle = color;
      let s = null;
      for (let i = 0; i <= n; i++) {
        const on = i < n && test(ep[i]);
        if (on && s == null) s = i;
        else if (!on && s != null) { ctx.fillRect(x(s), 0, Math.max(2, x(i) - x(s)), H); s = null; }
      }
    };
    stripes((e) => !e.gps && e.lost > 0, 'rgba(220,38,38,.2)');
    stripes((e) => e.rejected, 'rgba(217,119,6,.3)');
    const jam = ep.some((e) => e.diag && e.diag.kind === 'jam');
    if (jam) stripes((e) => e.diag && e.diag.kind === 'jam', 'rgba(124,58,237,.18)');
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
    for (const e of ep) if (e.event) { ctx.fillStyle = e.event.kind === 'back' || e.event.kind === 'clear' ? '#16a34a' : '#dc2626'; ctx.fillRect(x(e.i) - 1, H - 7, 3, 7); }
    ctx.fillStyle = '#0f172a'; ctx.fillRect(x(R.i) - 1, 0, 2, H);
    ctx.font = '600 11px system-ui, sans-serif'; ctx.textAlign = 'left';
    let lx = 4;
    for (const [t, c] of [['satellites', '#2563eb'], ['signal', '#ea580c'], ['no GPS', '#dc2626'], ['GPS ignored', '#b45309']].concat(jam ? [['jamming', '#7c3aed']] : [])) {
      ctx.fillStyle = c; ctx.fillText(t, lx, 11); lx += ctx.measureText(t).width + 9;
    }
  }

  function exitReplay() {
    const R = state.replay;
    if (!R) return;
    clearTimeout(R.timer);
    hideReplayCard();
    state.replay = null;
    layer.story.clearLayers();
    document.body.classList.remove('replay-mode');
    $('replay').classList.add('hidden');
    $('replayPlay').innerHTML = `${ico('fa-play')} Play`;
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
      advice: state.story || (!state.replay && mode === 'walk') ? 'walk' : 'vehicle',
    });
    res.ms = performance.now() - t0;
    const before = state.result;
    state.result = res;
    if (!state.story && !state.replay) {
      anchorWalk(res);
      // remember a GPS caught lying (see gpsWitness), and buzz when the witnesses start to disagree
      const gi = ws.findIndex((w) => w.type === 'gps'), gs = state.gps;
      if (gi >= 0 && res.status[gi] && res.status[gi].state === 'ignored' && !ws[gi].suspect && res.est) gs.liar = enOffset(res.est, ws[gi]);
      if (res.light === 'red' && (!before || before.light !== 'red') && navigator.vibrate && (!navigator.userActivation || navigator.userActivation.hasBeenActive)) navigator.vibrate([200, 100, 200]);
    }
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
    msgs.push(...(res.alerts || []));
    for (const m of msgs) {
      const d = document.createElement('div');
      d.className = 'alert';
      d.innerHTML = `${ico('fa-triangle-exclamation')} ${esc(m)}`;
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
        : `<span class="wi" style="background:${COLORS[w.type]}22;color:${COLORS[w.type]}">${ico(iconFor(w))}</span>`;
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
      li.innerHTML = `<span class="wi" style="background:#e2e8f0">${ico('fa-map')}</span><div class="wt"><b>Map rule</b><small>${MODES[state.story ? 'walk' : state.mode].rule}</small></div><span class="pill rule">on</span>`;
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
    // the circle holds 95 % of where this witness says you are (2.45 sigma in two dimensions)
    L.circle([p.lat, p.lon], Object.assign({}, style, { radius: Math.max(6, 2.45 * sigma) })).addTo(layer.shapes);
    anchorDot(p.lat, p.lon, style.color, `${ico(iconFor(w))} ${esc(w.label)}`, w.type);
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
    anchorDot(w.lat, w.lon, style.color, `${ico(ICONS.landmark)} ${esc(w.label)}`, w.type);
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
    // neighbour cells only give a rough distance: draw their wide rings faintly so the serving cell stands out
    const faint = w.serving === false;
    L.polygon(ri > 0 ? [outer, inner] : outer, Object.assign({}, style,
      { fillOpacity: faint ? 0.035 : 0.1, weight: faint ? 1 : 2, opacity: faint ? 0.5 : 0.9, dashArray: faint ? '4 6' : style.dashArray })).addTo(layer.shapes);
    anchorDot(w.lat, w.lon, style.color, `${ico(ICONS.tower)} ${esc(w.label)}`, w.type);
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
    anchorDot(w.a.lat, w.a.lon, style.color, `${ico(ICONS.angle)} A: ${esc(la || 'A')}`, w.type);
    anchorDot(w.b.lat, w.b.lon, style.color, `${ico(ICONS.angle)} B: ${esc(lb || 'B')}`, w.type);
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
        icon: L.divIcon({ className: 'band-label', html: `<span>${ico(iconFor(w))} ${esc(w.label)}</span>`, iconSize: null }), interactive: false,
      }).addTo(layer.shapes);
    }
  }

  function renderHeat(res) {
    if (heat) { map.removeLayer(heat); heat = null; }
    if (res.empty || res.conflict || !res.grid || !res.P) return;
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
    // dashed: the protection level, which holds even if one witness lies; faint: most likely (all honest)
    const pl = res.pl || res.r95;
    L.circle([res.est.lat, res.est.lon], { radius: pl, color: '#0f172a', weight: 2, dashArray: '2 6', fill: false, interactive: false }).addTo(layer.est);
    if (pl > 1.5 * res.r95) L.circle([res.est.lat, res.est.lon], { radius: res.r95, color: '#0f172a', weight: 1, opacity: 0.35, fill: false, interactive: false }).addTo(layer.est);
    L.marker([res.est.lat, res.est.lon], {
      icon: L.divIcon({ className: '', html: '<div class="est-dot"></div>', iconSize: [20, 20], iconAnchor: [10, 10] }),
      zIndexOffset: 900,
    }).bindTooltip(`Alibi: you are within ±${G.fmtDist(pl)}, even if one witness lies` + (pl > 1.5 * res.r95 ? ` (most likely ±${G.fmtDist(res.r95)})` : ''),
      { direction: 'right', offset: [10, 0] }).addTo(layer.est);
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
    $('hint').innerHTML = best ? `${ico('fa-arrow-right')} Next: aim at ${esc(best.lm.name)} (${G.compass8(best.b)}, ${G.fmtDist(best.d)})` : '';
  }

  // ---------- small UI helpers ----------
  let toastTimer = 0;
  function toast(msg, ms) { $('toast').textContent = msg; showToast(ms); }
  function toastHTML(html, ms) { $('toast').innerHTML = html; showToast(ms); }
  function showToast(ms) {
    placeToast();
    $('toast').classList.add('show');
    clearTimeout(toastTimer);
    if (ms !== 0) toastTimer = setTimeout(hideToast, ms || 4000);
  }
  function hideToast() { $('toast').classList.remove('show'); }
  function collapseSheet() { if (window.innerWidth < 900) $('sheet').classList.add('collapsed'); placeToast(); }
  // The toast sits just above whatever is at the bottom: on a phone the panel (open or folded down), and while
  // aiming the buttons or the review card. So it never covers the middle of the map, the cross or the target.
  // On wide screens the map's toast is placed by CSS (bottom middle of the map).
  function placeToast() {
    const t = $('toast');
    t.style.bottom = '';
    if (!$('aim').classList.contains('hidden')) {
      const p = $('review').classList.contains('hidden') ? $('aimPanel') : $('review');
      t.style.bottom = `${window.innerHeight - p.getBoundingClientRect().top + 10}px`;
      return;
    }
    if (window.innerWidth >= 900) return;
    const p = state.story ? $('story') : state.replay ? $('replay') : $('sheet');
    t.style.bottom = `${(p.classList.contains('collapsed') ? 58 : p.offsetHeight) + 10}px`;
  }

  function refreshButtons() {
    $('actGps').classList.toggle('on', state.gps.on);
    $('gpsLabel').textContent = state.gps.sim ? 'Simulated GPS' : 'GPS';
    $('actSpoof').classList.toggle('on', state.gps.spoof !== 'off');
    $('spoofLabel').textContent = { off: 'Spoof GPS', drag: 'Spoof: drag', jump: 'Spoof: jump' }[state.gps.spoof];
    document.querySelectorAll('.mode').forEach((b) => b.classList.toggle('active', b.dataset.mode === state.mode));
  }

  // The part of the map not hidden behind the panels and the alerts
  function visibleRect() {
    const size = map.getSize();
    const panel = (state.story ? $('story') : state.replay ? $('replay') : $('sheet')).getBoundingClientRect();
    const alerts = $('alerts').children.length ? $('alerts').getBoundingClientRect().bottom + 8 : 0;
    if (window.innerWidth >= 900) return { left: panel.right + 10, top: Math.max(10, alerts), right: size.x - 50, bottom: size.y - 10 };
    const top = Math.max($('status').getBoundingClientRect().bottom + 8, alerts);
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
  // Fly to the closest zoom (up to maxZoom) that shows every item and the room its label needs around it
  // (items: { lat, lon, l, r, t, b } with l/r/t/b in pixels), centred in the visible part of the map
  function flyToFit(items, maxZoom) {
    const r = visibleRect(), size = map.getSize();
    for (let z = maxZoom; z >= 2; z--) {
      let x0 = Infinity, x1 = -Infinity, y0 = Infinity, y1 = -Infinity;
      for (const it of items) {
        const p = map.project([it.lat, it.lon], z);
        x0 = Math.min(x0, p.x - (it.l || 0)); x1 = Math.max(x1, p.x + (it.r || 0));
        y0 = Math.min(y0, p.y - (it.t || 0)); y1 = Math.max(y1, p.y + (it.b || 0));
      }
      if ((x1 - x0 <= r.right - r.left && y1 - y0 <= r.bottom - r.top) || z === 2) {
        const mid = L.point((x0 + x1) / 2 + size.x / 2 - (r.left + r.right) / 2, (y0 + y1) / 2 + size.y / 2 - (r.top + r.bottom) / 2);
        map.flyTo(map.unproject(mid, z), z, { duration: 1.0 });
        return;
      }
    }
  }

  // Map labels can land on each other: the two star bands' labels where they cross near Aino, or "Kiilopää",
  // "A: Kiilopää" and "B: Kiilopää" on one fell top. After each run and each move: show one label per name at a
  // spot, and nudge the others (with the CSS translate property, which Leaflet leaves alone) until they cover
  // no other label, witness dot or Aino, inside the free part of the map. Labels of fixed things (fell tops,
  // masts: they sit above them) go first; the labels around Aino move instead.
  function spreadLabels() {
    const fixed = (el) => el.classList.contains('leaflet-tooltip-top');
    const labels = [...document.querySelectorAll('#map .leaflet-tooltip.wlabel, #map .band-label span')].sort((a, b) => fixed(b) - fixed(a));
    if (!labels.length) return;
    labels.forEach((el) => { el.style.translate = ''; el.style.visibility = ''; });
    const r = visibleRect(), box = (el) => el.getBoundingClientRect();
    const name = (el) => el.textContent.trim().replace(/^[AB]: /, '');
    const hits = (a, b, dx, dy) => a.left < b.right + dx && b.left + dx < a.right && a.top < b.bottom + dy && b.top + dy < a.bottom;
    const taken = [...document.querySelectorAll('#map .truth-icon span, #map .truth-icon em, #map .est-dot')].map(box), kept = [];
    for (const p of document.querySelectorAll('#map path.leaflet-interactive')) {      // the witness dots (not big circles)
      const b = box(p);
      if (b.width <= 24 && b.height <= 24) taken.push(b);
    }
    for (const el of labels) {
      const b = box(el);
      if (kept.some((k) => k.name === name(el) && hits(k.box, b, 0, 0))) { el.style.visibility = 'hidden'; continue; }
      // try the nearest spots first: rows up and down and steps to either side, moving away from what it labels
      const away = el.classList.contains('leaflet-tooltip-bottom') ? 1 : -1, sx = b.width / 2 + 8, sy = b.height + 3;
      const inX = (x) => Math.max(r.left - b.left, Math.min(r.right - b.right, x));     // stay inside left to right
      const tries = [];
      for (const k of [0, 1, -1, 2, -2, 3, -3]) {
        for (const m of [0, -1, 1, -2, 2]) tries.push([inX(m * sx), k * sy, Math.abs(m) * sx + Math.abs(k) * sy * (k * away > 0 ? 1 : 1.6)]);
      }
      tries.sort((p, q) => p[2] - q[2]);
      const ok = ([x, y]) => b.top + y >= r.top && b.bottom + y <= r.bottom && !taken.some((t) => hits(t, b, x, y));
      const [dx, dy] = tries.find(ok) || tries[0];
      if (dx || dy) el.style.translate = `${dx}px ${dy}px`;
      taken.push({ left: b.left + dx, right: b.right + dx, top: b.top + dy, bottom: b.bottom + dy });
      kept.push({ name: name(el), box: b });
    }
  }
  map.on('moveend', spreadLabels);

  // ---------- first visit ----------
  // Until the first witness arrives, the status card says what Alibi is (#intro in index.html). "Try it here",
  // or any button in the panel, brings back the normal status.
  let introOff = false;
  function updateIntro() {
    $('status').classList.toggle('intro', !introOff && !state.story && !state.replay && (!state.result || state.result.empty));
  }
  // Every run sets the trust light: then update the intro, what "I'm about here" hides, and the band labels
  new MutationObserver(() => { updateIntro(); hideWhileGuessing(); spreadLabels(); }).observe($('light'), { attributes: true });

  // ---------- wiring ----------
  $('actGps').onclick = toggleGps;
  $('actYou').onclick = startYou;
  $('actLandmark').onclick = actLandmark;
  $('actSky').onclick = actSky;
  $('actTowers').onclick = actTowers;
  $('actAngle').onclick = actAngle;
  $('actSave').onclick = actSave;
  $('actSpoof').onclick = () => (state.gps.on && state.gps.raw ? cycleSpoof()
    : noGps('Spoof GPS needs a GPS position to pull away. Turn on GPS and wait for a fix, or use a simulated GPS.'));
  $('actStory').onclick = startStory;
  $('introDemo').onclick = startStory;
  $('introSelf').onclick = () => { introOff = true; updateIntro(); $('sheet').classList.remove('collapsed'); };
  // starting something in the panel brings back the normal status card, and cancels a half-done tap on the map
  $('sheet').addEventListener('click', (e) => {
    if (!e.target.closest('.act, .mode')) return;
    introOff = true;
    updateIntro();
    if (state.pending) { state.pending = null; hideToast(); hideWhileGuessing(); }
  }, true);
  $('actClear').onclick = clearAll;
  $('actSettings').onclick = openSettings;
  $('settingsClose').onclick = closeSettings;
  $('sheetHandle').onclick = () => { $('sheet').classList.toggle('collapsed'); placeToast(); };
  // On a phone the panel can also be swiped: up opens it, down (from its top) folds it away. When it is
  // folded, a tap anywhere on the visible strip (except a button) opens it too.
  (() => {
    const sheet = $('sheet');
    let y0 = null, top0 = 0;
    const setOpen = (open) => { sheet.classList.toggle('collapsed', !open); placeToast(); };
    sheet.addEventListener('touchstart', (e) => { y0 = e.touches[0].clientY; top0 = sheet.scrollTop; }, { passive: true });
    sheet.addEventListener('touchend', (e) => {
      if (y0 == null) return;
      const dy = e.changedTouches[0].clientY - y0;
      y0 = null;
      if (dy < -30 && sheet.classList.contains('collapsed')) setOpen(true);
      else if (dy > 40 && top0 <= 0 && !sheet.classList.contains('collapsed')) setOpen(false);
    }, { passive: true });
    sheet.addEventListener('click', (e) => {
      if (sheet.classList.contains('collapsed') && !e.target.closest('button')) setOpen(true);
    });
  })();
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
  $('simToggle').onclick = toggleSim;
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
  // toasts sit just above the bottom panels, so follow them when they change size, appear or go
  const panelWatch = new ResizeObserver(() => placeToast());
  ['sheet', 'story', 'replay', 'aimPanel', 'review'].forEach((id) => panelWatch.observe($(id)));

  // handle for the browser console (handy when testing or tweaking a demo)
  Alibi.app = { state, map, run, addWitness, sim };

  // Keep the app on the phone so it opens without a network too (see sw.js)
  if ('serviceWorker' in navigator && location.protocol !== 'file:') navigator.serviceWorker.register('sw.js').catch(() => {});
  window.addEventListener('offline', () => toast('You are offline. Alibi keeps working with saved and built-in data.', 6000));
  window.addEventListener('online', () => toast('Back online.'));

  refreshButtons();
  schedule();
  if (/[?&]demo\b/.test(location.search)) startStory();     // (otherwise the intro in the status card says what to do)
})();
