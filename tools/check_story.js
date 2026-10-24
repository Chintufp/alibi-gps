const fs = require('fs'), vm = require('vm'), path = require('path');
const dir = process.argv[2];
const ctx = { console, Math, Date, Float64Array, Array, Object, Set, JSON }; ctx.window = ctx; vm.createContext(ctx);
for (const f of ['geo.js', 'sky.js', 'engine.js', 'scenario-data.js', 'scenario.js']) vm.runInContext(fs.readFileSync(path.join(dir, 'js', f), 'utf8'), ctx);
const A = ctx.Alibi, G = A.geo;
for (let k = 0; k < A.scenario.count; k++) {
  const st = A.scenario.build(k), r = A.engine.analyze(st.witnesses, { alertLimit: 150 });
  const err = r.est ? Math.round(G.dist(r.est.lat, r.est.lon, st.truth.lat, st.truth.lon)) : '-';
  console.log(`#${k + 1} ${st.title.padEnd(26)} ${r.light.padEnd(6)} ${r.headline.padEnd(26)} err=${err} m | ${st.witnesses.map((w, i) => w.label.split(' ')[0] + ':' + r.status[i].state[0]).join(' ')}`);
}
