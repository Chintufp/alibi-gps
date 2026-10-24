// Monte Carlo integrity test: every Lapland demo step again and again with RANDOM errors drawn from each
// witness's own ±, then a sweep of GPS spoofs of different sizes. Counts how often the light is green, how
// often the truth is inside the ± (the protection level), how often Alibi is "confidently wrong" (green but
// further off than the safety limit), and how often it throws out an honest witness.
// Usage: node tools/check_integrity.js . [runs per case, default 100] [error scale, default 1] [seed]
// An error scale of 2 or 3 draws errors 2 or 3 times bigger than the app assumes (and with heavier tails),
// to test what happens when the ± defaults are too optimistic.
const fs = require('fs'), path = require('path');
const dir = process.argv[2] || '.', RUNS = Number(process.argv[3]) || 100, SCALE = Number(process.argv[4]) || 1;
globalThis.window = globalThis;     // load the app's files like a browser does (fast, unlike a vm sandbox)
for (const f of ['geo.js', 'sky.js', 'engine.js', 'scenario-data.js', 'scenario.js']) (0, eval)(fs.readFileSync(path.join(dir, 'js', f), 'utf8'));
const A = globalThis.Alibi, G = A.geo, S = A.scenario, D = S.data, LIMIT = 150;

// repeatable random numbers (mulberry32) and Gaussian noise
let seed = Number(process.argv[5]) || 20261025;
const rand = () => { seed |= 0; seed = (seed + 0x6D2B79F5) | 0; let t = Math.imul(seed ^ (seed >>> 15), 1 | seed); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
const normal = () => Math.sqrt(-2 * Math.log(1 - rand())) * Math.cos(2 * Math.PI * rand());
// with SCALE > 1: bigger errors, and 1 in 10 of them three times bigger again (a heavy tail)
const gauss = () => SCALE === 1 ? normal() : SCALE * normal() * (rand() < 0.1 ? 3 : 1);

// witnesses with random errors (the same makers the demo uses, fed random instead of fixed errors)
const m = S.make, walk = (a, d) => Math.hypot(a, 0.08 * d);
const W = {
  gps: (t) => m.gps(G.offset(t.lat, t.lon, 5 * gauss() - 3, 5 * gauss() + 2)),
  spoof: (t, off, dir) => m.spoofedGps(G.offset(t.lat, t.lon, 5 * gauss(), 5 * gauss()), off, dir),
  you: (p, s) => m.you(G.offset(p.lat, p.lon, s * gauss(), s * gauss()), s, 'guess'),
  steps: (t, s, walked) => m.steps(t, s * gauss(), s * gauss(), s, walked),
  fell: (id, t, s) => m.fell(id, t, s * gauss(), s),
  angle: (a, b, t, s) => m.angle(a, b, t, s * gauss(), s),
  star: (id, t, s) => m.star(id, t, S.NIGHT, s * gauss(), s),
};

const CASES = [
  { name: '1 trailhead: GPS + guess', at: 0, make: (t) => [W.gps(t), W.you(t, 50 / 2.45)] },
  { name: '2 GPS + steps (2 km)', at: 2000, make: (t) => [W.gps(t), W.steps(t, walk(30, 2000), 2000)] },
  { name: '3 GPS 650 m off + steps', at: 3000, spoof: true, make: (t) => [W.spoof(t, 650, 120), W.steps(t, walk(30, 3000), 3000)] },
  { name: '4 ... + one fell line', at: 3000, spoof: true, make: (t) => [W.spoof(t, 650, 120), W.steps(t, walk(30, 3000), 3000), W.fell('kiilopaa', t, 2)] },
  { name: '5 ... + two fell lines', at: 3000, spoof: true, make: (t) => [W.spoof(t, 650, 120), W.steps(t, walk(30, 3000), 3000), W.fell('kiilopaa', t, 2), W.fell('ahopaat', t, 2)] },
  { name: '6 ... + three gyro angles (6 fells)', at: 3000, spoof: true, make: (t) => [W.spoof(t, 650, 120), W.steps(t, walk(30, 3000), 3000), W.fell('kiilopaa', t, 2), W.fell('ahopaat', t, 2),
    W.angle('ahopaat', 'kiilopaa', t, 1), W.angle('luuvaara', 'vavypaa', t, 1), W.angle('pirttinokka', 'niilanpaa', t, 1)] },
  { name: '7 night: GPS at Murmansk + steps + 2 stars', at: 4320, spoof: true, make: (t) => [m.gpsAt(S.MURMANSK, 'Murmansk'), W.steps(t, walk(40, 1320), 1320),
    W.star('polaris', t, 0.5), W.star('vega', t, 0.5)] },
  { name: '7b night, GPS not flagged as a jump', at: 4320, spoof: true, make: (t) => [Object.assign(m.gpsAt(S.MURMANSK, 'Murmansk'), { suspect: false }),
    W.steps(t, walk(40, 1320), 1320), W.star('polaris', t, 0.5), W.star('vega', t, 0.5)] },
  { name: '8 fog: steps only', at: 10450, make: (t) => [W.steps(t, walk(40, 7450), 7450)] },
  { name: '9 hut + 2 fell lines + angle + steps', at: 10900, make: (t) => [W.steps(t, walk(40, 7900), 7900), W.you(t, 15), W.fell('raututunturit', t, 2),
    W.fell('aaslakkapaa', t, 2), W.angle('raututunturit', 'aaslakkapaa', t, 1)] },
];

function runCase(c) {
  const n = { green: 0, yellow: 0, red: 0 }, out = { covered: 0, withEst: 0, misleading: 0, honestIgnored: 0, gpsCaught: 0, ms: 0, errs: [] };
  for (let r = 0; r < RUNS; r++) {
    const t = S.along(c.at), ws = c.make(t), t0 = Date.now(), res = A.engine.analyze(ws, { alertLimit: LIMIT });
    out.ms += Date.now() - t0;
    n[res.light] = (n[res.light] || 0) + 1;
    if (res.est) {
      const err = G.dist(res.est.lat, res.est.lon, t.lat, t.lon);
      out.withEst++; out.errs.push(err);
      if (err <= res.pl) out.covered++;
      if (res.light === 'green' && err > LIMIT) out.misleading++;
    }
    ws.forEach((w, i) => {
      const st = res.status[i] && res.status[i].state;
      if (w.type === 'gps' && c.spoof && (st === 'ignored' || st === 'suspect')) out.gpsCaught++;
      if (!(w.type === 'gps' && c.spoof) && st === 'ignored') out.honestIgnored++;
    });
  }
  return { n, out };
}

const pct = (a, b) => (b ? (100 * a / b).toFixed(0) + ' %' : '-');
console.log(`Monte Carlo: ${RUNS} runs per case, ${SCALE === 1 ? "random errors drawn from each witness's own ±" : "random errors " + SCALE + "x bigger than the ± says, with heavy tails"}, safety limit ±${LIMIT} m, seed ${seed}\n`);
console.log('case'.padEnd(44), 'green  yellow red   | truth inside ±  confidently wrong  honest witness thrown out  GPS lie caught  median error');
for (const c of CASES) {
  const { n, out } = runCase(c);
  out.errs.sort((a, b) => a - b);
  const med = out.errs.length ? Math.round(out.errs[out.errs.length >> 1]) + ' m' : '-';
  console.log(c.name.padEnd(44), pct(n.green, RUNS).padStart(5), pct(n.yellow, RUNS).padStart(6), pct(n.red, RUNS).padStart(5), ' |',
    pct(out.covered, out.withEst).padStart(13), String(out.misleading).padStart(15), String(out.honestIgnored).padStart(20),
    (c.spoof ? pct(out.gpsCaught, RUNS) : '-').padStart(21), med.padStart(12), `  (${Math.round(out.ms / RUNS)} ms/run)`);
}

// How big must a GPS lie be before it is caught? Steps (3 km walked) plus 0, 1 or 2 fell lines.
console.log('\nGPS pulled off by a hidden spoof: how often it is caught (excluded or flagged), and how often the truth stays inside the ±');
const sizes = [100, 200, 400, 650, 1000, 1500];
for (const lines of [0, 1, 2]) {
  const row = [];
  for (const off of sizes) {
    let caught = 0, covered = 0, withEst = 0, misleading = 0;
    for (let r = 0; r < Math.max(20, RUNS >> 1); r++) {
      const t = S.along(3000), dir = 360 * rand();
      const ws = [W.spoof(t, off, dir), W.steps(t, walk(30, 3000), 3000)];
      if (lines > 0) ws.push(W.fell('kiilopaa', t, 2));
      if (lines > 1) ws.push(W.fell('ahopaat', t, 2));
      const res = A.engine.analyze(ws, { alertLimit: LIMIT }), st = res.status[0].state;
      if (st !== 'agrees') caught++;
      if (res.est) {
        const err = G.dist(res.est.lat, res.est.lon, t.lat, t.lon);
        withEst++; if (err <= res.pl) covered++;
        if (res.light === 'green' && err > LIMIT) misleading++;
      }
      row.total = (row.total || 0) + 1;
    }
    const k = Math.max(20, RUNS >> 1);
    row.push(`${off} m: caught ${pct(caught, k)}, inside ± ${pct(covered, withEst)}${misleading ? `, ${misleading} confidently wrong` : ''}`);
  }
  console.log(`  steps + ${lines} fell line${lines === 1 ? '' : 's'}:`, row.join(' | '));
}
