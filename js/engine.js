/* Alibi engine.
   Every witness draws a shape on the map: a circle (GPS, your guess, your steps), a line (a landmark
   you aimed at), a ring (a cell tower) or a band (a star). Where the shapes overlap is where you are,
   and the size of the overlap is how sure we are.
   Before trusting a witness we predict what it should say from all the OTHER witnesses. If it is far
   off, it is lying and gets ignored. This is fault detection and exclusion, the same idea receivers
   use to drop a bad satellite (RAIM), applied to whole positioning sources. */
Alibi.engine = (function () {
  'use strict';

  const G = Alibi.geo, SKY = Alibi.sky;
  const D2R = Math.PI / 180, R2D = 180 / Math.PI, M = G.M_PER_DEG;

  const CELLS = 150;          // grid cells per side
  const P_LIMIT = 0.001;      // a witness this unlikely (two-sided, about 3.3 sigma) is called a liar
  const CHI2_2D = 13.8;       // the same limit for 2-D witnesses (chi-square, 2 degrees of freedom)
  const VIS_RANGE = 15000;    // you rarely see a landmark from further away than this (m)
  const MASK_BELOW = 8000;    // apply the map rule once the search area is smaller than this (m)
  const MIN_SIZE = 200;       // smallest search area (m)
  const LOCAL = 50000;        // below this size, flat-Earth maths is accurate enough and much faster
  const ZERO_MOVE = { dE: 0, dN: 0, sigma: 0 };

  // ---------- search grid (square cells, rows evenly spaced in Web Mercator like the map) ----------
  function makeGrid(b) {
    const latc = (b.s + b.n) / 2, lonc = (b.w + b.e) / 2, cosc = Math.cos(latc * D2R);
    const size = Math.max(MIN_SIZE, (b.e - b.w) * cosc * M, (b.n - b.s) * M);
    const s = latc - size / 2 / M, n = latc + size / 2 / M;
    const w = lonc - size / 2 / (M * cosc), e = lonc + size / 2 / (M * cosc);
    const nx = CELLS, ny = CELLS, N = nx * ny;
    const yN = G.mercY(n), dy = (yN - G.mercY(s)) / ny, dlon = (e - w) / nx;
    const lat = new Float64Array(N), lon = new Float64Array(N), area = new Float64Array(N);
    const rowLat = new Float64Array(ny), colLon = new Float64Array(nx);
    for (let i = 0; i < nx; i++) colLon[i] = w + (i + 0.5) * dlon;
    for (let j = 0; j < ny; j++) {
      const la = G.invMercY(yN - (j + 0.5) * dy), c = Math.cos(la * D2R);
      const a = (dlon * D2R * G.R * c) * (dy * G.R * c);
      rowLat[j] = la;
      for (let i = 0; i < nx; i++) {
        const k = j * nx + i;
        lat[k] = la; lon[k] = colLon[i]; area[k] = a;
      }
    }
    return { s, n, w, e, nx, ny, N, lat, lon, area, rowLat, colLon, size, cellM: size / nx, latc, lonc };
  }

  // ---------- one witness on the grid: how well does each cell fit what it says? ----------
  function evaluate(w, g) {
    const N = g.N, ll = new Float64Array(N), mv = w.move || ZERO_MOVE;
    const floor = 0.6 * g.cellM;                        // a coarse grid cannot show shapes thinner than a cell
    const slop2 = mv.sigma * mv.sigma + floor * floor;  // walking drift + grid blur (m²)
    const local = g.size < LOCAL;

    // where you were when the witness was taken = where you are now minus what you walked since
    const cellLat = (k) => g.lat[k] - mv.dN / M;
    const cellLon = (k) => g.lon[k] - mv.dE / (M * Math.cos(g.lat[k] * D2R));

    if (w.kind === 'point') {
      const ex = new Float64Array(N), ey = new Float64Array(N), s2 = w.sigma * w.sigma + slop2;
      const cw = Math.cos(w.lat * D2R);
      for (let k = 0; k < N; k++) {
        const la = cellLat(k), lo = cellLon(k);
        let x, y;
        if (local) { x = (lo - w.lon) * M * cw; y = (la - w.lat) * M; }
        else {
          const d = G.dist(w.lat, w.lon, la, lo), b = G.bearing(w.lat, w.lon, la, lo) * D2R;
          x = d * Math.sin(b); y = d * Math.cos(b);
        }
        ex[k] = x; ey[k] = y;
        ll[k] = -0.5 * (x * x + y * y) / s2;
      }
      return { kind: 'point', ll, ex, ey, s2 };
    }

    const e = new Float64Array(N), v = new Float64Array(N);
    if (w.kind === 'bearing') {
      const s2a = w.sigma * w.sigma, cw = Math.cos(w.lat * D2R);
      for (let k = 0; k < N; k++) {
        const la = cellLat(k), lo = cellLon(k);
        let d, brg;
        if (local) {
          const dx = (w.lon - lo) * M * cw, dyy = (w.lat - la) * M;
          d = Math.hypot(dx, dyy); brg = Math.atan2(dx, dyy) * R2D;
        } else { d = G.dist(la, lo, w.lat, w.lon); brg = G.bearing(la, lo, w.lat, w.lon); }
        const err = G.wrap180(brg - w.brg);
        const slopDeg = Math.sqrt(slop2) / Math.max(d, 20) * R2D;
        const varK = s2a + slopDeg * slopDeg;
        const far = d > VIS_RANGE ? (d - VIS_RANGE) / 5000 : 0;
        e[k] = err; v[k] = varK;
        ll[k] = -0.5 * err * err / varK - 0.5 * far * far;
      }
    } else if (w.kind === 'angle') {
      // the angle between two landmarks seen from the cell, clockwise from A to B (a gyroscope reading:
      // no compass involved). All places with the same angle lie on a circle through A and B.
      const s2a = w.sigma * w.sigma, ca = Math.cos(w.a.lat * D2R), cb = Math.cos(w.b.lat * D2R), slop = Math.sqrt(slop2);
      for (let k = 0; k < N; k++) {
        const la = cellLat(k), lo = cellLon(k);
        let dA, dB, bA, bB;
        if (local) {
          const ax = (w.a.lon - lo) * M * ca, ay = (w.a.lat - la) * M, bx = (w.b.lon - lo) * M * cb, by = (w.b.lat - la) * M;
          dA = Math.hypot(ax, ay); dB = Math.hypot(bx, by);
          bA = Math.atan2(ax, ay) * R2D; bB = Math.atan2(bx, by) * R2D;
        } else {
          dA = G.dist(la, lo, w.a.lat, w.a.lon); dB = G.dist(la, lo, w.b.lat, w.b.lon);
          bA = G.bearing(la, lo, w.a.lat, w.a.lon); bB = G.bearing(la, lo, w.b.lat, w.b.lon);
        }
        const err = G.wrap180(G.wrap180(bB - bA) - w.ang);
        const sa = slop / Math.max(dA, 20) * R2D, sb = slop / Math.max(dB, 20) * R2D;
        const varK = s2a + sa * sa + sb * sb, dMax = Math.max(dA, dB);
        const far = dMax > VIS_RANGE ? (dMax - VIS_RANGE) / 5000 : 0;
        e[k] = err; v[k] = varK;
        ll[k] = -0.5 * err * err / varK - 0.5 * far * far;
      }
    } else if (w.kind === 'range') {
      const s2r = w.sigma * w.sigma + slop2, cw = Math.cos(w.lat * D2R);
      for (let k = 0; k < N; k++) {
        const la = cellLat(k), lo = cellLon(k);
        const d = local ? Math.hypot((lo - w.lon) * M * cw, (la - w.lat) * M) : G.dist(la, lo, w.lat, w.lon);
        const err = d - w.r;
        e[k] = err; v[k] = s2r; ll[k] = -0.5 * err * err / s2r;
      }
    } else if (w.kind === 'sky') {
      // altitude of the body seen from each cell; rows and columns separate, so precompute them
      const p = SKY.radec(w.body, w.time), gm = SKY.gmst(w.time);
      const sd = Math.sin(p.dec * D2R), cd = Math.cos(p.dec * D2R);
      const s2s = w.sigma * w.sigma + slop2 / (M * M);
      const dLat = mv.dN / M, dLon = mv.dE / (M * Math.cos(g.latc * D2R));
      const rowA = new Float64Array(g.ny), rowB = new Float64Array(g.ny), colH = new Float64Array(g.nx);
      for (let j = 0; j < g.ny; j++) { const ph = (g.rowLat[j] - dLat) * D2R; rowA[j] = Math.sin(ph) * sd; rowB[j] = Math.cos(ph) * cd; }
      for (let i = 0; i < g.nx; i++) colH[i] = Math.cos((gm + g.colLon[i] - dLon - p.ra) * D2R);
      for (let j = 0; j < g.ny; j++) {
        for (let i = 0; i < g.nx; i++) {
          const k = j * g.nx + i;
          const h = Math.asin(Math.max(-1, Math.min(1, rowA[j] + rowB[j] * colH[i]))) * R2D;
          const err = h - w.alt;
          e[k] = err; v[k] = s2s; ll[k] = -0.5 * err * err / s2s;
        }
      }
    }
    return { kind: '1d', ll, e, v };
  }

  // ---------- combine witnesses: multiply their shapes (add log-likelihoods) ----------
  function posterior(g, evs, idx, mask) {
    const N = g.N, L = new Float64Array(N);
    let top = -Infinity;
    for (let k = 0; k < N; k++) {
      let s = mask ? mask[k] : 0;
      for (let t = 0; t < idx.length; t++) s += evs[idx[t]].ll[k];
      L[k] = s;
      if (s > top) top = s;
    }
    const P = new Float64Array(N);
    let tot = 0;
    for (let k = 0; k < N; k++) { const p = Math.exp(L[k] - top) * g.area[k]; P[k] = p; tot += p; }
    for (let k = 0; k < N; k++) P[k] /= tot;
    return P;
  }

  // Standard normal CDF (Abramowitz & Stegun 7.1.26, error < 1.5e-7)
  function normCdf(x) {
    const t = 1 / (1 + 0.3275911 * Math.abs(x) / Math.SQRT2);
    const y = 1 - t * (0.254829592 + t * (-0.284496736 + t * (1.421413741 + t * (-1.453152027 + t * 1.061405429)))) *
      Math.exp(-x * x / 2);
    return x >= 0 ? 0.5 * (1 + y) : 0.5 * (1 - y);
  }

  // ---------- is a witness consistent with where the others put you? ----------
  // Point witnesses: distance from the others' best guess, compared with both uncertainties (Mahalanobis).
  // Lines, rings and bands: where would this witness's reading fall among the readings the others predict?
  // Far out in the tail means it is lying. Unlike a mean-and-spread test, this still works when the others
  // only give a long thin shape, such as a single compass line.
  function test(ev, P) {
    const N = P.length;
    if (ev.kind === 'point') {
      let mx = 0, my = 0;
      for (let k = 0; k < N; k++) { mx += P[k] * ev.ex[k]; my += P[k] * ev.ey[k]; }
      let cxx = 0, cxy = 0, cyy = 0;
      for (let k = 0; k < N; k++) {
        const dx = ev.ex[k] - mx, dy = ev.ey[k] - my;
        cxx += P[k] * dx * dx; cxy += P[k] * dx * dy; cyy += P[k] * dy * dy;
      }
      const a = cxx + ev.s2, b = cxy, c = cyy + ev.s2, det = a * c - b * b;
      const d2 = (c * mx * mx - 2 * b * mx * my + a * my * my) / det;
      return { z: Math.sqrt(Math.max(0, d2)), fail: d2 > CHI2_2D };
    }
    let below = 0;
    for (let k = 0; k < N; k++) {
      if (P[k] > 1e-12) below += P[k] * normCdf(-ev.e[k] / Math.sqrt(ev.v[k]));
    }
    const p = 2 * Math.min(below, 1 - below);
    return { p, fail: p < P_LIMIT };
  }

  function check(g, evs, set, mask) {
    const fails = [];
    if (set.length < 2) return { ok: true, fails };
    for (const i of set) {
      const t = test(evs[i], posterior(g, evs, set.filter((j) => j !== i), mask));
      if (t.fail) fails.push(i);
    }
    return { ok: fails.length === 0, fails };
  }

  // Find the liar: which witness can we drop so that everyone left agrees?
  function fde(g, evs, ws, mask) {
    const all = ws.map((_, i) => i);
    const base = check(g, evs, all, mask);
    if (base.ok) return { kept: all, excluded: [], conflict: false, suspects: [] };

    const options = [];
    for (const i of all) {
      const rest = all.filter((j) => j !== i);
      if (rest.length >= 2 && check(g, evs, rest, mask).ok) options.push([i]);
    }
    if (!options.length && all.length >= 5) {
      for (let a = 0; a < all.length; a++) {
        for (let b = a + 1; b < all.length; b++) {
          const rest = all.filter((j) => j !== a && j !== b);
          if (check(g, evs, rest, mask).ok) options.push([a, b]);
        }
      }
    }
    let pick = options;
    if (pick.length > 1) {
      // tie-break: blame a witness that already looked suspicious (e.g. GPS jumped impossibly far)
      const sus = pick.filter((o) => o.every((i) => ws[i].suspect));
      if (sus.length === 1) pick = sus;
    }
    if (pick.length === 1) {
      const ex = pick[0];
      return { kept: all.filter((i) => !ex.includes(i)), excluded: ex, conflict: false, suspects: [] };
    }
    const suspects = options.length ? [...new Set(options.flat())] : base.fails;
    return { kept: all, excluded: [], conflict: true, suspects, options };
  }

  // ---------- helpers ----------
  function anchorBounds(ws) {
    let b = null;
    const add = (lat, lon, r) => {
      const dLat = r / M, dLon = r / (M * Math.max(0.05, Math.cos(lat * D2R)));
      const nb = { s: lat - dLat, n: lat + dLat, w: lon - dLon, e: lon + dLon };
      b = b ? { s: Math.min(b.s, nb.s), n: Math.max(b.n, nb.n), w: Math.min(b.w, nb.w), e: Math.max(b.e, nb.e) } : nb;
    };
    for (const w of ws) {
      const mv = w.move || ZERO_MOVE, walked = Math.hypot(mv.dE, mv.dN);
      if (w.kind === 'point') {
        const c = G.offset(w.lat, w.lon, mv.dE, mv.dN);
        add(c.lat, c.lon, 3 * Math.hypot(w.sigma, mv.sigma) + 100);
      } else if (w.kind === 'bearing') add(w.lat, w.lon, VIS_RANGE + walked);
      else if (w.kind === 'angle') { add(w.a.lat, w.a.lon, VIS_RANGE + walked); add(w.b.lat, w.b.lon, VIS_RANGE + walked); }
      else if (w.kind === 'range') add(w.lat, w.lon, w.r + 3 * w.sigma + walked);
    }
    return b;
  }

  function density(g, P, k) { return P[k] / g.area[k]; }

  // Area that holds almost all of the probability, padded by two cells
  function massBounds(g, P, frac) {
    let top = 0;
    for (let k = 0; k < g.N; k++) top = Math.max(top, density(g, P, k));
    let s = 90, n = -90, w = 180, e = -180;
    for (let k = 0; k < g.N; k++) {
      if (density(g, P, k) >= top * frac) {
        s = Math.min(s, g.lat[k]); n = Math.max(n, g.lat[k]);
        w = Math.min(w, g.lon[k]); e = Math.max(e, g.lon[k]);
      }
    }
    const padLat = 2 * g.cellM / M, padLon = 2 * g.cellM / (M * Math.cos(((s + n) / 2) * D2R));
    return { s: s - padLat, n: n + padLat, w: w - padLon, e: e + padLon };
  }

  // Best guess (most likely cell) and the radius of the circle around it that holds 95 % of the
  // probability. Like a receiver's protection level, this stays honest for long thin shapes too
  // (one compass line or one angle), where an equal-area circle would look far too small.
  function summarize(g, P) {
    let kBest = 0;
    for (let k = 1; k < g.N; k++) if (density(g, P, k) > density(g, P, kBest)) kBest = k;
    const la0 = g.lat[kBest], lo0 = g.lon[kBest], c0 = Math.cos(la0 * D2R);
    const d = new Float64Array(g.N);
    for (let k = 0; k < g.N; k++) d[k] = Math.hypot((g.lon[k] - lo0) * M * c0, (g.lat[k] - la0) * M);
    const order = Array.from({ length: g.N }, (_, k) => k).sort((a, b) => d[a] - d[b]);
    let acc = 0, r95 = 0;
    for (const k of order) { acc += P[k]; r95 = d[k]; if (acc >= 0.95) break; }
    // a cell is not a point: never claim better than about half a cell
    return { est: { lat: la0, lon: lo0 }, r95: Math.max(r95, 0.5 * g.cellM) };
  }

  function verdict(res, ws, limit) {
    const lim = '±' + G.fmtDist(limit);
    if (res.conflict) {
      const names = res.suspects.map((i) => ws[i].label).join(' or ');
      return { light: 'red', headline: 'Witnesses disagree', detail: `Can't tell who is lying: ${names}. Add another witness.` };
    }
    const r = '±' + G.fmtDist(res.r95), n = res.kept.length;
    if (ws.length === 1) {
      const gpsOnly = ws[0].type === 'gps';
      return {
        light: res.r95 <= 10 * limit ? 'yellow' : 'red',
        headline: gpsOnly ? 'Only GPS, nothing checks it' : 'Only one witness',
        detail: `About ${r}, but nothing checks it. Add a witness.`,
      };
    }
    if (res.r95 <= limit) return { light: 'green', headline: `You're within ${r}`, detail: `${n} witnesses agree · need ${lim}` };
    if (res.r95 <= 10 * limit) return { light: 'yellow', headline: `Roughly within ${r}`, detail: `Need ${lim}. Slow down and add a witness.` };
    return { light: 'red', headline: `Too uncertain (${r})`, detail: 'Stop and add witnesses before you move on.' };
  }

  // ---------- main entry ----------
  // ws: witnesses. opts: { alertLimit (m), maskFor(grid) -> Float64Array|null, fallbackBounds }
  function analyze(ws, opts) {
    opts = opts || {};
    const empty = { empty: true, light: 'grey', status: [], alerts: [], headline: 'No witnesses yet',
      detail: 'Turn on GPS, tap “I’m about here”, or aim at a landmark.' };
    if (!ws.length) return empty;
    let bounds = anchorBounds(ws) || opts.fallbackBounds;
    if (!bounds) return Object.assign(empty, { detail: 'Give a rough guess first: “I’m about here”.' });

    let last = null;
    for (let level = 0; level < 7; level++) {
      const g = makeGrid(bounds);
      const evs = ws.map((w) => evaluate(w, g));
      const mask = g.size <= MASK_BELOW && opts.maskFor ? opts.maskFor(g) : null;
      const f = fde(g, evs, ws, mask);
      const P = posterior(g, evs, f.kept, mask);
      last = { g, f, P, mask };
      let nb;
      if (f.conflict) {
        // A real stand-off (e.g. two witnesses that disagree): nothing to zoom into.
        if (!f.options || !f.options.length) break;
        // Several explanations fit at this coarse resolution: zoom into all of them and look closer.
        nb = f.options.map((ex) => massBounds(g, posterior(g, evs, ws.map((_, i) => i).filter((i) => !ex.includes(i)), mask), 1e-4))
          .reduce((a, b) => ({ s: Math.min(a.s, b.s), n: Math.max(a.n, b.n), w: Math.min(a.w, b.w), e: Math.max(a.e, b.e) }));
      } else nb = massBounds(g, P, 1e-4);
      const nbSize = Math.max((nb.e - nb.w) * Math.cos(((nb.s + nb.n) / 2) * D2R) * M, (nb.n - nb.s) * M);
      if (nbSize > 0.6 * g.size || g.size <= MIN_SIZE) break;   // zoomed in as far as it helps
      bounds = nb;
    }

    const { g, f, P, mask } = last;
    const status = ws.map((w, i) => ({
      state: f.conflict ? (f.suspects.includes(i) ? 'suspect' : 'agrees')
        : f.excluded.includes(i) ? 'ignored'
        : ws.length === 1 ? 'unchecked' : 'agrees',
    }));
    const res = { empty: false, grid: g, P, maskUsed: !!mask, conflict: f.conflict, kept: f.kept,
      excluded: f.excluded, suspects: f.suspects, status, alerts: [] };
    if (!f.conflict) Object.assign(res, summarize(g, P));
    Object.assign(res, verdict(res, ws, opts.alertLimit || 150));
    for (const i of f.excluded) {
      const w = ws[i];
      res.alerts.push(`⚠ ${w.label} disagrees with the other ${f.kept.length} witnesses, so it is ignored.` +
        (w.type === 'gps' ? ' Possible spoofing.' : ''));
    }
    return res;
  }

  return { analyze, density };
})();
