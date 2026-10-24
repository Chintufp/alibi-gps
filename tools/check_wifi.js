// Monte Carlo test of the Wi-Fi witness in a city (central Tampere, made-up places): random true positions,
// Wi-Fi heard from a random distance around the router (drawn from the app's own ±, or bigger with an error
// scale), GPS honest or spoofed, and a fake hotspot named after a shop that is somewhere else.
// Counts lights, how often the truth is inside the ±, "confidently wrong" greens and caught liars.
// Usage: node tools/check_wifi.js . [runs per case, default 300] [error scale, default 1] [seed]
const fs = require('fs'), path = require('path');
const dir = process.argv[2] || '.', RUNS = Number(process.argv[3]) || 300, SCALE = Number(process.argv[4]) || 1;
globalThis.window = globalThis;
for (const f of ['geo.js', 'sky.js', 'engine.js']) (0, eval)(fs.readFileSync(path.join(dir, 'js', f), 'utf8'));
const A = globalThis.Alibi, G = A.geo, LIMIT = 150, REACH = 50;

let seed = Number(process.argv[5]) || 20261025;
const rand = () => { seed |= 0; seed = (seed + 0x6D2B79F5) | 0; let t = Math.imul(seed ^ (seed >>> 15), 1 | seed); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
const normal = () => Math.sqrt(-2 * Math.log(1 - rand())) * Math.cos(2 * Math.PI * rand());
const gauss = () => SCALE === 1 ? normal() : SCALE * normal() * (rand() < 0.1 ? 3 : 1);

// a café near the true position (the one whose Wi-Fi you see), a chain with three shops (one of them near
// you), and a far shop of the same chain that a fake hotspot pretends to be
const C0 = { lat: 61.4980, lon: 23.7610 };
const off = (p, e, n) => G.offset(p.lat, p.lon, e, n);
function world() {
  const truth = off(C0, 800 * (rand() - 0.5), 800 * (rand() - 0.5));
  const near = (s) => off(truth, s * gauss(), s * gauss());       // where a router you can hear could be
  return {
    truth,
    cafe: near(REACH),
    chain: [near(REACH), off(truth, 2500, 900), off(truth, -1800, -2600)],
    fake: off(truth, 1200 * (rand() < 0.5 ? 1 : -1), 600),
  };
}
const wifi = (label, sites) => ({ type: 'wifi', kind: 'near', label, sites: sites.map((s) => ({ lat: s.lat, lon: s.lon, sigma: REACH })) });
const gps = (p, sigma = 5) => ({ type: 'gps', kind: 'point', label: 'GPS', lat: p.lat, lon: p.lon, sigma });
const you = (t, s) => { const p = off(t, s * gauss(), s * gauss()); return { type: 'you', kind: 'point', label: 'Guess', lat: p.lat, lon: p.lon, sigma: s }; };

const CASES = [
  { name: 'GPS + café Wi-Fi', make: (w) => [gps(off(w.truth, 5 * gauss(), 5 * gauss())), wifi('Café', [w.cafe])] },
  { name: 'GPS 600 m off + café Wi-Fi + guess ±300 m', liar: 0,
    make: (w) => [gps(off(w.truth, 600, 0)), wifi('Café', [w.cafe]), you(w.truth, 300)] },
  { name: 'no GPS: chain Wi-Fi (3 shops) + café Wi-Fi', make: (w) => [wifi('Chain', w.chain), wifi('Café', [w.cafe])] },
  { name: 'no GPS: chain + café + guess ±500 m', make: (w) => [wifi('Chain', w.chain), wifi('Café', [w.cafe]), you(w.truth, 500)] },
  { name: 'GPS + café + FAKE hotspot 1.3 km away', liar: 2,
    make: (w) => [gps(off(w.truth, 5 * gauss(), 5 * gauss())), wifi('Café', [w.cafe]), wifi('Fake shop', [w.fake])] },
];

for (const c of CASES) {
  const n = { green: 0, yellow: 0, red: 0, grey: 0 };
  let covered = 0, withEst = 0, wrongGreen = 0, caught = 0, honestOut = 0, ms = 0;
  const errs = [];
  for (let r = 0; r < RUNS; r++) {
    const w = world(), ws = c.make(w), t0 = Date.now();
    const res = A.engine.analyze(ws, { alertLimit: LIMIT });
    ms += Date.now() - t0;
    n[res.light]++;
    if (res.est) {
      const e = G.dist(res.est.lat, res.est.lon, w.truth.lat, w.truth.lon);
      withEst++; errs.push(e);
      if (e <= res.pl) covered++;
      if (res.light === 'green' && e > LIMIT) wrongGreen++;
    }
    if (c.liar != null && res.excluded.includes(c.liar)) caught++;
    honestOut += res.excluded.filter((i) => i !== c.liar).length > 0 ? 1 : 0;
  }
  errs.sort((a, b) => a - b);
  const pct = (x) => (100 * x / RUNS).toFixed(0) + '%';
  console.log(`${c.name}\n  lights G/Y/R ${pct(n.green)}/${pct(n.yellow)}/${pct(n.red)} · truth inside ± ${withEst ? (100 * covered / withEst).toFixed(1) : '-'}%` +
    ` · median error ${errs.length ? Math.round(errs[errs.length >> 1]) : '-'} m · wrong greens ${wrongGreen}` +
    (c.liar != null ? ` · liar caught ${pct(caught)}` : '') + ` · honest witness dropped ${pct(honestOut)} · ${Math.round(ms / RUNS)} ms/run`);
}
