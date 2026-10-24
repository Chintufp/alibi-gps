/* Alibi - OpenStreetMap data: landmarks to aim at, cell masts, and the map rule
   (walkers aren't in lakes, cars stay on roads, boats stay on water). Uses the Overpass API. */
Alibi.osm = (function () {
  'use strict';

  const G = Alibi.geo;
  // Only servers in the EU: the request contains the area you are in, so it should not go just anywhere
  const ENDPOINTS = [
    'https://overpass-api.de/api/interpreter',
    'https://overpass.kumi.systems/api/interpreter',
  ];

  // Public Overpass servers can be slow: ask one, and if it has not answered in 8 s (or fails), ask the
  // next one too; the first good answer wins. Answers are kept on this device, so a place you have
  // loaded once also works offline.
  const CACHE_PREFIX = 'alibi-osm:';

  function cacheGet(query) {
    try { const v = localStorage.getItem(CACHE_PREFIX + query); return v ? JSON.parse(v) : null; } catch (e) { return null; }
  }
  function cachePut(query, data) {
    try { localStorage.setItem(CACHE_PREFIX + query, JSON.stringify(data)); } catch (e) { /* storage full or blocked */ }
  }

  // remember = false: don't keep the answer (big answers for the map rule would fill the phone's storage)
  async function overpass(query, remember = true, waitMs = 60000) {
    const cached = remember ? cacheGet(query) : null;
    if (cached) return cached;
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), waitMs);
    try {
      return await new Promise((resolve, reject) => {
        let next = 0, failed = 0, done = false;
        const launch = () => {
          if (done || next >= ENDPOINTS.length) return;
          const url = ENDPOINTS[next++];
          const hedge = setTimeout(launch, 8000);
          fetch(url, {
            method: 'POST', signal: ctrl.signal,
            headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
            body: 'data=' + encodeURIComponent(query),
          })
            .then((r) => (r.ok ? r.json() : Promise.reject(new Error('HTTP ' + r.status))))
            .then((d) => { if (!done) { done = true; if (remember) cachePut(query, d); resolve(d); } })
            .catch(() => {
              clearTimeout(hedge);
              if (++failed === ENDPOINTS.length && !done) { done = true; reject(new Error('servers busy')); } else launch();
            });
        };
        ctrl.signal.addEventListener('abort', () => { if (!done) { done = true; reject(new Error('timed out')); } });
        launch();
      });
    } finally {
      clearTimeout(timer);
      ctrl.abort();    // stop any slower servers still working on it
    }
  }

  const bbox = (b) => `${b.s.toFixed(5)},${b.w.toFixed(5)},${b.n.toFixed(5)},${b.e.toFixed(5)}`;

  // Landmarks shipped with the app (central Tampere and Helsinki) or saved on this device, so demos there
  // need no network. Used straight away when the middle of the search box lies in such an area (the edges
  // of a big box may stick out a little); otherwise only when the servers fail.
  function shipped(b) {
    const F = Alibi.landmarkData;
    const areas = (F ? F.areas : []).concat(saved);
    const cLat = (b.s + b.n) / 2, cLon = (b.w + b.e) / 2;
    let centred = false;
    const elements = [];
    for (const a of areas) {
      if (b.n < a.s || b.s > a.n || b.e < a.w || b.w > a.e) continue;
      if (cLat >= a.s && cLat <= a.n && cLon >= a.w && cLon <= a.e) centred = true;
      for (const el of a.elements) {
        if (el.lat >= b.s && el.lat <= b.n && el.lon >= b.w && el.lon <= b.e) elements.push(el);
      }
    }
    return elements.length ? { centred, elements } : null;
  }

  async function query(q, b) {
    const local = shipped(b);
    if (local && local.centred) return { elements: local.elements };
    try {
      return await overpass(q);
    } catch (e) {
      if (local) return { elements: local.elements };
      throw e;
    }
  }
  function around(lat, lon, r) {
    const dLat = r / G.M_PER_DEG, dLon = r / (G.M_PER_DEG * Math.cos(lat * G.D2R));
    return { s: lat - dLat, n: lat + dLat, w: lon - dLon, e: lon + dLon };
  }
  const centre = (el) => el.lat != null ? { lat: el.lat, lon: el.lon } : (el.center || null);

  // ---------- landmarks you can aim your phone at ----------
  // Font Awesome icon for each kind: the class for the page, the character for drawing on a canvas
  const ICONS = {
    Lighthouse: ['fa-tower-observation', ''], 'Water tower': ['fa-tower-observation', ''],
    Tower: ['fa-tower-observation', ''], Chimney: ['fa-industry', ''], Mast: ['fa-tower-cell', ''],
    'Hill top': ['fa-mountain', ''], Church: ['fa-church', ''], Hut: ['fa-house-chimney', ''],
    'Wind turbine': ['fa-fan', ''], 'Tall building': ['fa-building', ''], Beacon: ['fa-anchor', ''],
    'Ski jump': ['fa-person-skiing', ''], Landmark: ['fa-thumbtack', ''],
  };
  const iconOf = (kind) => { const i = ICONS[kind] || ICONS.Landmark; return { cls: i[0], glyph: i[1] }; };

  // In order of how good they are to aim at: tall, thin, easy to recognise and mapped as one point.
  // Masts come last: there are many and they look alike.
  const KINDS = [
    { test: (t) => t.natural === 'peak', label: 'Hill top' },
    { test: (t) => t.man_made === 'lighthouse', label: 'Lighthouse' },
    { test: (t) => /church|cathedral/.test(t.building || '') || t.amenity === 'place_of_worship', label: 'Church' },
    { test: (t) => t.man_made === 'water_tower', label: 'Water tower' },
    { test: (t) => t.man_made === 'chimney', label: 'Chimney' },
    { test: (t) => t.power === 'generator' && t['generator:source'] === 'wind', label: 'Wind turbine' },
    { test: (t) => t['piste:type'] === 'ski_jump' || t.sport === 'ski_jumping', label: 'Ski jump' },
    { test: (t) => t.man_made === 'tower', label: 'Tower' },
    { test: (t) => /^(wilderness_hut|alpine_hut)$/.test(t.tourism || '') || (t.amenity === 'shelter' && /^(lean_to|basic_hut)$/.test(t.shelter_type || '')), label: 'Hut' },
    { test: (t) => t.man_made === 'beacon' || /^(beacon_|light_major|light_minor)/.test(t['seamark:type'] || ''), label: 'Beacon' },
    { test: (t) => !!t.building && (parseFloat(t.height) >= 40 || parseInt(t['building:levels'], 10) >= 12), label: 'Tall building' },
    { test: (t) => t.man_made === 'mast' || t.man_made === 'communications_tower', label: 'Mast' },
  ];
  const RANK = Object.fromEntries(KINDS.map((k, i) => [k.label, i]));

  const landmarkQuery = (b, max) => `[out:json][timeout:60];(
      nwr["man_made"~"^(tower|water_tower|chimney|lighthouse|mast|communications_tower|beacon)$"](${bbox(b)});
      nwr["building"~"^(church|cathedral)$"](${bbox(b)});
      nwr["amenity"="place_of_worship"]["building"](${bbox(b)});
      node["natural"="peak"](${bbox(b)});
      node["power"="generator"]["generator:source"="wind"](${bbox(b)});
      nwr["piste:type"="ski_jump"](${bbox(b)});
      nwr["sport"="ski_jumping"](${bbox(b)});
      nwr["tourism"~"^(wilderness_hut|alpine_hut)$"](${bbox(b)});
      nwr["amenity"="shelter"]["shelter_type"~"^(lean_to|basic_hut)$"](${bbox(b)});
      node["seamark:type"~"^(beacon_|light_major|light_minor)"](${bbox(b)});
      nwr["building"]["building:levels"~"^(1[2-9]|[2-9][0-9])$"](${bbox(b)});
      nwr["building"]["height"~"^([4-9][0-9]|[1-9][0-9][0-9])"](${bbox(b)});
    );out center tags ${max};`;

  async function landmarks(b) {
    const d = await query(landmarkQuery(b, 800), b);
    const out = [];
    for (const el of d.elements) {
      const c = centre(el), t = el.tags || {};
      if (!c) continue;
      const kind = KINDS.find((k) => k.test(t));
      if (!kind) continue;
      const dup = out.find((o) => G.dist(o.lat, o.lon, c.lat, c.lon) < 30);
      if (dup) { if (!dup.named && t.name) Object.assign(dup, { name: t.name, named: true }); continue; }
      out.push({ id: el.type + el.id, lat: c.lat, lon: c.lon, name: t.name || kind.label, named: !!t.name, kind: kind.label });
    }
    // the best kinds first, named before unnamed, so masts can't crowd out hill tops and churches
    return out.sort((a, b) => (RANK[a.kind] - RANK[b.kind]) || (b.named - a.named)).slice(0, 150);
  }

  // ---------- cell masts near a point (for the simulated tower witness) ----------
  const isMast = (t) => /^(mast|communications_tower)$/.test(t.man_made || '') || /communication/.test(t['tower:type'] || '') ||
    t['communication:mobile_phone'] === 'yes';

  async function masts(lat, lon, radius) {
    const box = around(lat, lon, radius), b = bbox(box);
    const q = `[out:json][timeout:25];(
      nwr["man_made"~"^(mast|tower|communications_tower)$"]["tower:type"~"communication"](${b});
      nwr["communication:mobile_phone"="yes"](${b});
      nwr["man_made"~"^(mast|communications_tower)$"](${b});
    );out center tags 200;`;
    const d = await query(q, box);
    const out = [];
    for (const el of d.elements) {
      const c = centre(el);
      if (!c || !isMast(el.tags || {}) || out.some((o) => G.dist(o.lat, o.lon, c.lat, c.lon) < 50)) continue;
      out.push({ lat: c.lat, lon: c.lon, name: (el.tags && el.tags.name) || 'Mast' });
    }
    return out;
  }

  // ---------- places a Wi-Fi name could belong to ----------
  // Shops, cafés, campuses... whose name (or brand, or mapped Wi-Fi name) fits a Wi-Fi name you can see.
  // A big place (a campus, a mall) can be heard from anywhere around it, so its size is returned too.
  const NOT_A_PLACE = /^(highway|waterway|natural|landuse|boundary|route|place|power)$/;
  async function wifiPlaces(b, wf) {
    const box = bbox(b), re = Alibi.wifi.pattern(wf.key || '');
    const find = wf.kind === 'campus'
      ? `nwr["amenity"~"^(university|college)$"](${box});nwr["internet_access:ssid"~"eduroam",i](${box});`
      : `nwr["name"~"${re}",i](${box});nwr["brand"~"${re}",i](${box});nwr["internet_access:ssid"~"${re}",i](${box});`;
    // tags and centres, then the outline's box (how big the place is) for the same elements
    const d = await overpass(`[out:json][timeout:25];(${find})->.p;.p out center tags 200;.p out bb ids 200;`);
    const els = new Map();
    for (const el of d.elements) {
      const id = el.type + el.id, o = els.get(id) || {};
      els.set(id, Object.assign(o, el, { tags: el.tags || o.tags }));
    }
    const out = [];
    for (const el of els.values()) {
      const t = el.tags || {};
      if (Object.keys(t).some((k) => NOT_A_PLACE.test(k)) && !t.amenity && !t.shop && !t.internet_access) continue;
      const c = centre(el), bb = el.bounds;
      let lat = c && c.lat, lon = c && c.lon, half = 0;
      if (bb) {
        if (lat == null) { lat = (bb.minlat + bb.maxlat) / 2; lon = (bb.minlon + bb.maxlon) / 2; }
        half = G.dist(bb.minlat, bb.minlon, bb.maxlat, bb.maxlon) / 2;
      }
      if (lat == null) continue;
      const score = wf.kind === 'campus' ? 1 : Alibi.wifi.fits(t, wf.tokens);
      if (!score) continue;
      const name = t.name || t.brand || (wf.kind === 'campus' ? 'Campus' : 'Place');
      // the same place mapped twice (a shop and its building): keep the bigger one
      const dup = out.find((o) => G.dist(o.lat, o.lon, lat, lon) < Math.max(80, o.half, half));
      if (dup) { if (half > dup.half) Object.assign(dup, { lat, lon, half }); continue; }
      out.push({ lat, lon, half, name, score });
    }
    const top = Math.max(0, ...out.map((o) => o.score));
    return out.filter((o) => o.score === top);
  }

  // ---------- the map rule ----------
  const cache = { water: [], roads: [] };
  const inflight = {};
  let staticWater = null;

  function setStaticWater(lakes) { staticWater = lakes; }

  // Join the pieces of a lake outline (OSM multipolygons come in several ways)
  function assemble(ways) {
    const pool = ways.filter((w) => w.length >= 2).map((w) => w.slice());
    const same = (a, b) => Math.abs(a[0] - b[0]) < 1e-7 && Math.abs(a[1] - b[1]) < 1e-7;
    const rings = [];
    while (pool.length) {
      let ring = pool.shift(), grew = true;
      while (grew && !same(ring[0], ring[ring.length - 1])) {
        grew = false;
        for (let i = 0; i < pool.length; i++) {
          const w = pool[i], end = ring[ring.length - 1];
          if (same(w[0], end)) ring = ring.concat(w.slice(1));
          else if (same(w[w.length - 1], end)) ring = ring.concat(w.slice(0, -1).reverse());
          else continue;
          pool.splice(i, 1); grew = true; break;
        }
      }
      if (ring.length >= 3) rings.push(ring);
    }
    return rings;
  }

  // Lakes as polygons, or roads as lines, for a box
  async function fetchFeatures(type, b, waitMs) {
    const q = type === 'roads'
      ? `[out:json][timeout:60];way["highway"~"^(motorway|trunk|primary|secondary|tertiary|unclassified|residential|service|living_street|motorway_link|trunk_link|primary_link|secondary_link|tertiary_link)$"](${bbox(b)});out geom;`
      : `[out:json][timeout:60];(way["natural"="water"](${bbox(b)});relation["natural"="water"](${bbox(b)});way["waterway"="riverbank"](${bbox(b)});way["natural"="coastline"](${bbox(b)}););out geom;`;
    const d = await overpass(q, false, waitMs);
    const features = [], pts = (geom) => geom.map((p) => [+p.lat.toFixed(6), +p.lon.toFixed(6)]);
    for (const el of d.elements) {
      if (type === 'roads') { if (el.geometry) features.push(pts(el.geometry)); continue; }
      // the sea is not mapped as a shape, only its coastline: remember that this area has some sea
      if (el.tags && el.tags.natural === 'coastline') { if (!features.some((f) => f.coast)) features.push({ coast: true, rings: [] }); continue; }
      if (el.type === 'way' && el.geometry) features.push({ rings: [pts(el.geometry)] });
      if (el.type === 'relation' && el.members) {
        const outer = el.members.filter((m) => m.role !== 'inner' && m.geometry).map((m) => pts(m.geometry));
        const inner = el.members.filter((m) => m.role === 'inner' && m.geometry).map((m) => pts(m.geometry));
        features.push({ rings: assemble(outer).concat(assemble(inner)) });
      }
    }
    return features;
  }

  async function fetchArea(type, g, onLoaded) {
    const pad = 0.5;
    const b = {
      s: g.s - (g.n - g.s) * pad, n: g.n + (g.n - g.s) * pad,
      w: g.w - (g.e - g.w) * pad, e: g.e + (g.e - g.w) * pad,
    };
    const key = type + bbox(b);
    if (inflight[key]) return;
    inflight[key] = true;
    let features = [];
    try { features = await fetchFeatures(type, b); } catch (e) { features = []; }
    cache[type].push({ b, features });
    delete inflight[key];
    if (onLoaded) onLoaded();
  }

  // Draw roads or water onto a tiny canvas the size of the grid, then read it back cell by cell
  function rasterize(g, feats, mode) {
    const cv = document.createElement('canvas');
    cv.width = g.nx; cv.height = g.ny;
    const ctx = cv.getContext('2d');
    const yN = G.mercY(g.n), dy = (yN - G.mercY(g.s)) / g.ny, dlon = (g.e - g.w) / g.nx;
    const X = (lon) => (lon - g.w) / dlon, Y = (lat) => (yN - G.mercY(lat)) / dy;
    ctx.fillStyle = '#000'; ctx.strokeStyle = '#000';
    if (mode === 'drive') {
      ctx.lineWidth = Math.max(1.2, 30 / g.cellM); ctx.lineCap = 'round'; ctx.lineJoin = 'round';
      for (const line of feats) {
        ctx.beginPath();
        line.forEach((p, i) => (i ? ctx.lineTo(X(p[1]), Y(p[0])) : ctx.moveTo(X(p[1]), Y(p[0]))));
        ctx.stroke();
      }
    } else {
      for (const f of feats) {
        ctx.beginPath();
        for (const ring of f.rings) {
          ring.forEach((p, i) => (i ? ctx.lineTo(X(p[1]), Y(p[0])) : ctx.moveTo(X(p[1]), Y(p[0]))));
          ctx.closePath();
        }
        ctx.fill('evenodd');
      }
    }
    const data = ctx.getImageData(0, 0, g.nx, g.ny).data;
    const OFF = Math.log(0.03);    // "very unlikely", not impossible: lakes freeze, roads are missing from maps
    const out = new Float64Array(g.N);
    let hits = 0;
    for (let k = 0; k < g.N; k++) {
      const hit = data[4 * k + 3] > 100;
      if (hit) hits++;
      out[k] = mode === 'walk' ? (hit ? OFF : 0) : (hit ? 0 : OFF);
    }
    if (!hits) return null;    // nothing mapped here: don't apply the rule
    return out;
  }

  // Map-rule mask for a grid, or null if there is no data (yet). Starts a download when needed.
  function maskFor(g, mode, source, onLoaded) {
    const type = mode === 'drive' ? 'roads' : 'water';
    let feats;
    if (source === 'static') {
      if (type !== 'water' || !staticWater) return null;
      feats = staticWater;
    } else {
      const hit = cache[type].find((c) => c.b.s <= g.s && c.b.n >= g.n && c.b.w <= g.w && c.b.e >= g.e);
      if (!hit) { fetchArea(type, g, onLoaded); return null; }
      feats = hit.features;
    }
    if (!feats.length) return null;
    // Boat mode only knows lakes and rivers as shapes, so near the sea the "boats stay on water" rule is off
    // (open sea would look like land). Turning coastlines into sea shapes is a next step.
    if (mode === 'boat' && feats.some((f) => f.coast)) return null;
    return rasterize(g, feats.filter((f) => !f.coast), mode);
  }

  // ---------- areas saved on this device for offline use ("Save offline") ----------
  // Landmarks, masts and lakes (and roads in Drive mode) for a box, kept in the phone's storage.
  // Map pictures are not downloaded in bulk: the free OpenStreetMap tile servers forbid that.
  const SAVED_KEY = 'alibi-saved-areas';
  const KEEP = ['name', 'man_made', 'natural', 'building', 'amenity', 'tower:type', 'communication:mobile_phone', 'power',
    'generator:source', 'piste:type', 'sport', 'tourism', 'shelter_type', 'seamark:type', 'height', 'building:levels'];
  let saved = [];
  try { saved = JSON.parse(localStorage.getItem(SAVED_KEY) || '[]'); } catch (e) { saved = []; }

  function useSaved(a) {
    const b = { s: a.s, w: a.w, n: a.n, e: a.e };
    if (a.water && a.water.length) cache.water.push({ b, features: a.water });
    if (a.roads && a.roads.length) cache.roads.push({ b, features: a.roads });
  }
  saved.forEach(useSaved);

  // Saving is something you wait for on purpose, so give the busy servers two minutes per part
  async function saveArea(b, withRoads) {
    const WAIT = 120000;
    const d = await overpass(landmarkQuery(b, 3000), false, WAIT);
    const elements = [];
    for (const el of d.elements) {
      const c = centre(el);
      if (!c) continue;
      const tags = {};
      for (const k of KEEP) if (el.tags && el.tags[k] != null) tags[k] = el.tags[k];
      elements.push({ type: el.type, id: el.id, lat: +c.lat.toFixed(6), lon: +c.lon.toFixed(6), tags });
    }
    const water = await fetchFeatures('water', b, WAIT);
    const roads = withRoads ? await fetchFeatures('roads', b, WAIT) : [];
    const area = { s: b.s, w: b.w, n: b.n, e: b.e, savedAt: Date.now(), elements, water, roads };
    // keep the three newest areas, and drop the oldest if the phone's storage is full
    let list = saved.concat([area]).slice(-3);
    for (;;) {
      try { localStorage.setItem(SAVED_KEY, JSON.stringify(list)); break; }
      catch (e) {
        if (list.length <= 1) throw new Error('not enough storage space on this device');
        list = list.slice(1);
      }
    }
    saved = list;
    useSaved(area);
    return { landmarks: elements.length, masts: elements.filter((el) => isMast(el.tags)).length, lakes: water.length, roads: roads.length };
  }

  return { landmarks, masts, wifiPlaces, maskFor, setStaticWater, around, saveArea, iconOf };
})();
