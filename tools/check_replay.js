// Run both recordings and the simulated attacks through the engine, exactly as the replay does (the same
// witnesses, from js/replay.js), and count the lights. Every 5th second plus every event, to stay quick.
// Usage: node tools/check_replay.js . [step]
const fs = require('fs'), vm = require('vm'), path = require('path');
const dir = process.argv[2] || '.', STEP = +(process.argv[3] || 5);
const ctx = { console, Math, Date, Float64Array, Int32Array, Uint8Array, Array, Object, Set, JSON };
ctx.window = ctx;
vm.createContext(ctx);
for (const f of ['geo.js', 'sky.js', 'engine.js', 'replay.js']) vm.runInContext(fs.readFileSync(path.join(dir, 'js', f), 'utf8'), ctx);
const A = ctx.Alibi, RP = A.replay, G = A.geo;
const raw = { train: JSON.parse(fs.readFileSync(path.join(dir, 'data/train.json'), 'utf8')), car: JSON.parse(fs.readFileSync(path.join(dir, 'data/car.json'), 'utf8')) };
const t0 = Date.now();
let problems = 0;
for (const [id, sc] of Object.entries(RP.SCENES)) {
  const d = RP.prepare(raw[sc.log], sc);
  const n = { green: 0, yellow: 0, red: 0, grey: 0 }, plErr = [];
  let miss = 0, checked = 0, gpsVote = 0, worst = 0;
  d.ep.forEach((e, i) => {
    if (i % STEP && !e.event) return;
    const ws = RP.witnesses(e, d);
    const r = A.engine.analyze(ws, { alertLimit: d.limit });
    n[r.light]++;
    const gi = ws.findIndex((w) => w.type === 'gps');
    if (gi >= 0 && e.rejected && r.status[gi].state !== 'ignored') gpsVote++;        // a caught liar must get no vote
    if (r.est && e.truth && !r.conflict) {
      const err = G.dist(r.est.lat, r.est.lon, e.truth.lat, e.truth.lon), pl = r.pl || r.r95;
      checked++; if (err > pl) miss++; worst = Math.max(worst, err);
      // the ± tools/check_spoof.js assumes, against the engine's own protection level
      const approx = e.gps && !e.rejected ? G.dist(e.gps.lat, e.gps.lon, e.dr.lat, e.dr.lon) + 3.03 * e.dr.sigma : e.dr ? e.dr.r95 : null;
      if (approx) plErr.push(approx / pl);
    }
  });
  plErr.sort((a, b) => a - b);
  const honest = !sc.attack;
  const falseAlarms = d.ep.filter((e) => e.rejected).length;
  if (honest && falseAlarms) problems++;
  if (gpsVote) problems++;
  console.log(`${id.padEnd(15)} green ${n.green}, yellow ${n.yellow}, red ${n.red}, grey ${n.grey} | truth outside the shown ± in ${miss}/${checked} checked seconds, worst error ${Math.round(worst)} m` +
    ` | GPS rejected ${falseAlarms} s${honest ? ' (false alarms)' : ''} | caught liar still voting: ${gpsVote}` +
    ` | spoof-test ± / engine ± median ${plErr[plErr.length >> 1].toFixed(2)} (5-95 %: ${plErr[Math.floor(0.05 * plErr.length)].toFixed(2)}-${plErr[Math.floor(0.95 * plErr.length)].toFixed(2)})`);
}
console.log(problems ? `SOME REPLAY CHECKS FAILED (${problems})` : 'replay checks passed', `(${((Date.now() - t0) / 1000).toFixed(0)} s)`);
process.exitCode = problems ? 1 : 0;
