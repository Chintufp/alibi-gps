/* Alibi - OpenStreetMap data: landmarks to aim at, cell masts, and the map rule
   (walkers aren't in lakes, cars stay on roads, boats stay on water). Uses the Overpass API. */
Alibi.osm = (function () {
  'use strict';

  const G = Alibi.geo;
  const ENDPOINTS = [
    'https://overpass-api.de/api/interpreter',
    'https://overpass.kumi.systems/api/interpreter',
    'https://maps.mail.ru/osm/tools/overpass/api/interpreter',
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

  async function overpass(query) {
    const cached = cacheGet(query);
    if (cached) return cached;
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 60000);
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
            .then((d) => { if (!done) { done = true; cachePut(query, d); resolve(d); } })
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

  // Landmarks shipped with the app (central Tampere and Helsinki), so demos there need no network.
  // full = one shipped area covers the whole box, so there is no need to ask the servers at all.
  function shipped(b) {
    const F = Alibi.landmarkData;
    if (!F) return null;
    let full = false;
    const elements = [];
    for (const a of F.areas) {
      if (b.n < a.s || b.s > a.n || b.e < a.w || b.w > a.e) continue;
      if (b.s >= a.s && b.n <= a.n && b.w >= a.w && b.e <= a.e) full = true;
      for (const el of a.elements) {
        if (el.lat >= b.s && el.lat <= b.n && el.lon >= b.w && el.lon <= b.e) elements.push(el);
      }
    }
    return elements.length ? { full, elements } : null;
  }

  async function query(q, b) {
    const local = shipped(b);
    if (local && local.full) return { elements: local.elements };
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
  const KINDS = [
    { test: (t) => t.man_made === 'lighthouse', label: 'Lighthouse', icon: '🗼' },
    { test: (t) => t.man_made === 'water_tower', label: 'Water tower', icon: '🗼' },
    { test: (t) => t.man_made === 'chimney', label: 'Chimney', icon: '🏭' },
    { test: (t) => t.man_made === 'mast' || t.man_made === 'communications_tower', label: 'Mast', icon: '📡' },
    { test: (t) => t.man_made === 'tower', label: 'Tower', icon: '🗼' },
    { test: (t) => t.natural === 'peak', label: 'Hill top', icon: '⛰️' },
    { test: (t) => /church|cathedral/.test(t.building || '') || t.amenity === 'place_of_worship', label: 'Church', icon: '⛪' },
  ];

  async function landmarks(b) {
    const q = `[out:json][timeout:25];(
      nwr["man_made"~"^(tower|water_tower|chimney|lighthouse|mast|communications_tower)$"](${bbox(b)});
      nwr["building"~"^(church|cathedral)$"](${bbox(b)});
      nwr["amenity"="place_of_worship"]["building"](${bbox(b)});
      node["natural"="peak"](${bbox(b)});
    );out center tags 400;`;
    const d = await query(q, b);
    const out = [];
    for (const el of d.elements) {
      const c = centre(el), t = el.tags || {};
      if (!c) continue;
      const kind = KINDS.find((k) => k.test(t));
      if (!kind) continue;
      const dup = out.find((o) => G.dist(o.lat, o.lon, c.lat, c.lon) < 30);
      if (dup) { if (!dup.named && t.name) Object.assign(dup, { name: t.name, named: true }); continue; }
      out.push({ id: el.type + el.id, lat: c.lat, lon: c.lon, name: t.name || kind.label, named: !!t.name,
        kind: kind.label, icon: kind.icon });
    }
    return out.sort((a, b) => b.named - a.named).slice(0, 100);
  }

  // ---------- cell masts near a point (for the simulated tower witness) ----------
  async function masts(lat, lon, radius) {
    const box = around(lat, lon, radius), b = bbox(box);
    const q = `[out:json][timeout:25];(
      nwr["man_made"~"^(mast|tower|communications_tower)$"]["tower:type"~"communication"](${b});
      nwr["communication:mobile_phone"="yes"](${b});
      nwr["man_made"~"^(mast|communications_tower)$"](${b});
    );out center tags 200;`;
    const d = await query(q, box);
    const isMast = (t) => /^(mast|communications_tower)$/.test(t.man_made || '') || /communication/.test(t['tower:type'] || '') ||
      t['communication:mobile_phone'] === 'yes';
    const out = [];
    for (const el of d.elements) {
      const c = centre(el);
      if (!c || !isMast(el.tags || {}) || out.some((o) => G.dist(o.lat, o.lon, c.lat, c.lon) < 50)) continue;
      out.push({ lat: c.lat, lon: c.lon, name: (el.tags && el.tags.name) || 'Mast' });
    }
    return out;
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

  async function fetchArea(type, g, onLoaded) {
    const pad = 0.5;
    const b = {
      s: g.s - (g.n - g.s) * pad, n: g.n + (g.n - g.s) * pad,
      w: g.w - (g.e - g.w) * pad, e: g.e + (g.e - g.w) * pad,
    };
    const key = type + bbox(b);
    if (inflight[key]) return;
    inflight[key] = true;
    const q = type === 'roads'
      ? `[out:json][timeout:25];way["highway"~"^(motorway|trunk|primary|secondary|tertiary|unclassified|residential|service|living_street|motorway_link|trunk_link|primary_link|secondary_link|tertiary_link)$"](${bbox(b)});out geom;`
      : `[out:json][timeout:25];(way["natural"="water"](${bbox(b)});relation["natural"="water"](${bbox(b)});way["waterway"="riverbank"](${bbox(b)}););out geom;`;
    let features = [];
    try {
      const d = await overpass(q);
      for (const el of d.elements) {
        const pts = (geom) => geom.map((p) => [p.lat, p.lon]);
        if (type === 'roads') { if (el.geometry) features.push(pts(el.geometry)); continue; }
        if (el.type === 'way' && el.geometry) features.push({ rings: [pts(el.geometry)] });
        if (el.type === 'relation' && el.members) {
          const outer = el.members.filter((m) => m.role !== 'inner' && m.geometry).map((m) => pts(m.geometry));
          const inner = el.members.filter((m) => m.role === 'inner' && m.geometry).map((m) => pts(m.geometry));
          features.push({ rings: assemble(outer).concat(assemble(inner)) });
        }
      }
    } catch (e) {
      features = [];
    }
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
    return rasterize(g, feats, mode);
  }

  return { landmarks, masts, maskFor, setStaticWater, around };
})();
