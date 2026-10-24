const fs = require('fs'), vm = require('vm'), path = require('path');
const dir = process.argv[2];
const ctx = { console, Math, Date, Float64Array, Array, Object, Set, JSON }; ctx.window = ctx; vm.createContext(ctx);
for (const f of ['geo.js', 'sky.js', 'engine.js']) vm.runInContext(fs.readFileSync(path.join(dir, 'js', f), 'utf8'), ctx);
const G = ctx.Alibi.geo, E = ctx.Alibi.engine;
const truth = { lat: 61.4978, lon: 23.7610 };
const A = G.dest(truth.lat, truth.lon, 350, 400), B = G.dest(truth.lat, truth.lon, 80, 600), C = G.dest(truth.lat, truth.lon, 200, 500);
const ang = (p, q, err) => G.wrap180(G.wrap180(G.bearing(truth.lat, truth.lon, q.lat, q.lon) - G.bearing(truth.lat, truth.lon, p.lat, p.lon)) + err);
const wAB = { type: 'angle', kind: 'angle', a: A, b: B, ang: ang(A, B, 0.8), sigma: 1, label: 'A-B' };
const wBC = { type: 'angle', kind: 'angle', a: B, b: C, ang: ang(B, C, -0.6), sigma: 1, label: 'B-C' };
console.log('angles', wAB.ang.toFixed(1), wBC.ang.toFixed(1));
let r = E.analyze([wAB, wBC], { alertLimit: 150 });
console.log('two angles:', r.light, r.headline, '| err', Math.round(G.dist(r.est.lat, r.est.lon, truth.lat, truth.lon)), 'm');
// with a spoofed GPS 300 m off and a rough guess
const gps = Object.assign({ type: 'gps', kind: 'point', sigma: 5, label: 'GPS' }, G.dest(truth.lat, truth.lon, 120, 300));
const you = Object.assign({ type: 'you', kind: 'point', sigma: 500, label: 'You' }, G.dest(truth.lat, truth.lon, 30, 200));
r = E.analyze([gps, you, wAB, wBC], { alertLimit: 150 });
console.log('gps spoofed 300 m:', r.light, r.headline, '|', r.status.map((s) => s.state).join(','), '| err', Math.round(G.dist(r.est.lat, r.est.lon, truth.lat, truth.lon)), 'm');
// one angle only + guess: should be a curved band, not a fix
r = E.analyze([you, wAB], { alertLimit: 150 });
console.log('one angle + guess:', r.light, r.headline);
