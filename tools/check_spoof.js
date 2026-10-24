// Headless test of the replay's checks: runs the exact replay logic (js/replay.js) on both real recordings,
// honest and with simulated attacks, and scores it against the recorded positions (the "truth").
//   - honest seconds: false alarms, and how often the truth is inside dead reckoning's ±
//   - synthetic outages cut into both logs (10-120 s, many start times): is the ± honest when GPS comes back?
//   - drag spoofing at many speeds, directions and start times: caught? how fast? how far off before that?
//   - jumps of many sizes, mid-drive and at the exits of the real tunnels
// Usage: node tools/check_spoof.js . [--md results.md] [--svg] [--W 30]
// (--svg writes docs/replay-integrity.svg: error against the ± Alibi showed, one dot per second)
const fs = require('fs'), vm = require('vm'), path = require('path');
const args = process.argv.slice(2), dir = args[0] || '.';
const opt = (k) => { const i = args.indexOf(k); return i >= 0 ? args[i + 1] : null; };
const ctx = { console, Math, Date, Float64Array, Int32Array, Uint8Array, Array, Object, Set, JSON };
ctx.window = ctx;
vm.createContext(ctx);
for (const f of ['geo.js', 'replay.js']) vm.runInContext(fs.readFileSync(path.join(dir, 'js', f), 'utf8'), ctx);
const RP = ctx.Alibi.replay, G = ctx.Alibi.geo;
const P = opt('--W') ? { W: +opt('--W') } : {};
const raw = { train: JSON.parse(fs.readFileSync(path.join(dir, 'data/train.json'), 'utf8')), car: JSON.parse(fs.readFileSync(path.join(dir, 'data/car.json'), 'utf8')) };
const run = (log, attack, rawLog) => RP.prepare(rawLog || raw[log], { log, attack }, P);
const out = [];
const say = (s) => { console.log(s); out.push(s); };
const pct = (a, b) => (b ? (100 * a / b).toFixed(1) + ' %' : '-');
const q = (arr, p) => { const s = arr.slice().sort((x, y) => x - y); return s.length ? s[Math.min(s.length - 1, Math.floor(p * s.length))] : NaN; };
const m = (x) => (isFinite(x) ? G.fmtDist(x) : '-');
const err = (e) => (e.est && e.truth ? G.dist(e.est.lat, e.est.lon, e.truth.lat, e.truth.lon) : null);
// the ± the header shows (approximates the engine's protection level: tools/check_replay.js compares the two)
const shown = (e) => (!e.dr ? null : e.gps && !e.rejected ? G.dist(e.gps.lat, e.gps.lon, e.dr.lat, e.dr.lon) + 3.03 * e.dr.sigma : e.dr.r95);
const dots = [];   // [error, shown ±, kind]
const LIM = { train: 100, car: 50 };
const t0 = Date.now();

say(`# Replay checks (window W = ${P.W || RP.P.W} s)`);
say('');
// ---------------- 1. honest recordings ----------------
say('## 1. The real recordings, no attack');
for (const log of ['train', 'car']) {
  const d = run(log);
  const gps = d.ep.filter((e) => e.gps && e.dr && e.gate && e.gate.state !== 'start');
  const rej = d.ep.filter((e) => e.rejected).length, eps = d.ep.filter((e) => e.event && e.event.kind === 'spoof').length;
  const inside = gps.filter((e) => G.dist(e.dr.lat, e.dr.lon, e.truth.lat, e.truth.lon) <= e.dr.r95).length;
  const z = gps.map((e) => e.gate.chi2);
  const avail = gps.filter((e) => shown(e) <= d.limit).length;
  say(`- **${log}**: ${gps.length} seconds with GPS checked against dead reckoning. GPS wrongly rejected: ${rej} s (${eps} false alarms). ` +
    `The real position was inside dead reckoning's ± (95 %) in ${pct(inside, gps.length)} of them; the largest check value was ${Math.sqrt(q(z, 1)).toFixed(1)} sigma (limit 3.7). ` +
    `Alibi's ± (if GPS were lying) was within the ${d.limit} m safety limit ${pct(avail, gps.length)} of the time.`);
  for (const e of d.ep.filter((x) => x.back)) {
    say(`  - GPS back after ${e.back.gap} s: ${m(e.back.dist)} from dead reckoning (±${m(e.back.r95)}, check limit ${m(e.gate.limit)}) → ${e.back.ok ? 'trusted again' : 'REJECTED'}` +
      (e.back.held ? ` (speed unknown for ${e.back.held} s)` : ''));
  }
  // dead reckoning against its own ± (on these seconds Alibi itself sits on GPS, which is the truth here)
  for (const e of gps) if (e.i % 2 === 0) dots.push([Math.max(0.5, G.dist(e.dr.lat, e.dr.lon, e.truth.lat, e.truth.lon)), e.dr.r95, 'honest']);
}
say('');

// ---------------- 2. synthetic outages: is the ± honest? ----------------
say('## 2. Synthetic outages cut into both logs (no GPS and no speed for T seconds)');
say('The speed is unknown in a real outage of these recordings, so it is cut too: dead reckoning holds the median of the last 10 s.');
say('');
say('| log | outage | cases | truth inside the ± when GPS returns | GPS wrongly rejected | median ± | a lie this big is always caught |');
say('|---|---|---|---|---|---|---|');
const synth = {};
for (const log of ['train', 'car']) {
  const rows = raw[log].epochs, ix = {};
  raw[log].cols.forEach((c, i) => { ix[c] = i; });
  for (const T of [10, 30, 60, 120]) {
    let n = 0, inside = 0, rejected = 0;
    const r95s = [], sure = [];
    for (let s = 15; s + T + 10 < rows.length; s += 7) {
      let ok = true;
      for (let k = s - 15; k <= s + T + 10; k++) if (rows[k][ix.lat] == null) { ok = false; break; }
      if (!ok) continue;
      const mod = Object.assign({}, raw[log], { epochs: rows.map((r, k) => (k >= s && k < s + T ? r.map((v, c) => (['lat', 'lon', 'acc', 'spd', 'brg'].includes(raw[log].cols[c]) ? null : v)) : r)) });
      const d = run(log, null, mod), e = d.ep[s + T];
      if (!e.back) continue;
      n++;
      if (e.back.dist <= e.back.r95) inside++;
      if (!e.back.ok) rejected++;
      r95s.push(e.back.r95);
      sure.push(e.gate.limit + e.back.dist);
      dots.push([Math.max(0.5, e.back.dist), e.back.r95, 'outage']);
    }
    synth[log + T] = { n, inside, rejected };
    say(`| ${log} | ${T} s | ${n} | ${pct(inside, n)} | ${rejected} (${pct(rejected, n)}) | ±${m(q(r95s, 0.5))} | ${m(q(sure, 0.5))} (median) |`);
  }
}
say('');

// ---------------- 3. drag spoofing ----------------
say('## 3. Slow drag spoofing (GPS pulled away at a steady speed, with faked speed and course), 4 directions, start every 30 s, 180 s long');
say('');
say('| log | drag speed | runs | caught | time to catch (median / 90 %) | off by when caught (median / max) | worst error never caught | seconds the truth was outside the shown ± |');
say('|---|---|---|---|---|---|---|---|');
const dragMin = {};
for (const log of ['train', 'car']) {
  const n = raw[log].epochs.length;
  for (const v of [0.5, 1, 1.5, 2, 3, 5, 10]) {
    let runs = 0, caught = 0, secs = 0, bad = 0, worstMiss = 0;
    const ttd = [], offAt = [];
    for (let t0s = 60; t0s + 180 < n; t0s += 30) {
      for (const brg of [0, 90, 180, 270]) {
        const d = run(log, { kind: 'drag', t0: t0s, speed: v, brg, dur: 180 });
        runs++;
        let hit = null;
        for (let i = t0s; i < t0s + 180; i++) {
          const e = d.ep[i];
          if (hit == null && e.rejected) hit = i;
          const x = err(e), s = shown(e);
          if (x != null && s != null) { secs++; if (x > s) bad++; if (i % 5 === 0) dots.push([Math.max(0.5, x), s, 'attack']); }
        }
        if (hit != null) { caught++; ttd.push(hit - t0s); offAt.push(d.ep[hit].off); }
        else worstMiss = Math.max(worstMiss, d.ep[t0s + 179].off);
      }
    }
    if (caught / runs >= 0.9 && dragMin[log] == null) dragMin[log] = v;
    say(`| ${log} | ${v} m/s | ${runs} | ${pct(caught, runs)} | ${ttd.length ? `${q(ttd, 0.5)} s / ${q(ttd, 0.9)} s` : '-'} | ${offAt.length ? `${m(q(offAt, 0.5))} / ${m(q(offAt, 1))}` : '-'} | ${worstMiss ? m(worstMiss) : '-'} | ${pct(bad, secs)} |`);
  }
}
say('');

// ---------------- 4. jumps ----------------
say('## 4. Sudden jumps mid-drive (held for 120 s), 4 directions, start every 30 s');
say('');
say('| log | jump | runs | caught | caught in the first second | seconds the truth was outside the shown ± |');
say('|---|---|---|---|---|---|');
const jumpMin = {};
for (const log of ['train', 'car']) {
  const n = raw[log].epochs.length;
  for (const D of [10, 20, 30, 50, 75, 100, 200, 1000]) {
    let runs = 0, caught = 0, first = 0, secs = 0, bad = 0;
    for (let t0s = 60; t0s + 120 < n; t0s += 30) {
      if (!raw[log].epochs[t0s][1]) continue;
      for (const brg of [0, 90, 180, 270]) {
        const d = run(log, { kind: 'jump', t0: t0s, brg, dist: D, dur: 120 });
        runs++;
        const hit = d.ep.slice(t0s, t0s + 120).find((e) => e.rejected);
        if (hit) { caught++; if (hit.i === t0s) first++; }
        for (let i = t0s; i < t0s + 120; i++) { const e = d.ep[i], x = err(e), s = shown(e); if (x != null && s != null) { secs++; if (x > s) bad++; if (i % 5 === 0) dots.push([Math.max(0.5, x), s, 'attack']); } }
      }
    }
    if (caught / runs >= 0.9 && jumpMin[log] == null) jumpMin[log] = D;
    say(`| ${log} | ${m(D)} | ${runs} | ${pct(caught, runs)} | ${pct(first, runs)} | ${pct(bad, secs)} |`);
  }
}
say('');
say('### Jumps at the exits of the real outages in the train (8 directions)');
say('');
const trainD = run('train');
const exits = trainD.ep.filter((e) => e.back);
say('| outage | ±(95 %) when GPS returns | check limit | ' + [100, 300, 1000, 2000, 3000].map((D) => `${m(D)} caught`).join(' | ') + ' |');
say('|---|---|---|' + [100, 300, 1000, 2000, 3000].map(() => '---').join('|') + '|');
for (const x of exits) {
  const cells = [100, 300, 1000, 2000, 3000].map((D) => {
    let c = 0;
    for (let k = 0; k < 8; k++) {
      // jump right at the exit, then hold it
      const d = run('train', { kind: 'jump', t0: x.i, brg: k * 45, dist: D, dur: 60 });
      if (d.ep[x.i].rejected) c++;
    }
    return `${c}/8`;
  });
  say(`| ${x.back.gap} s | ±${m(x.back.r95)} | ${m(x.gate.limit)} | ${cells.join(' | ')} |`);
}
say('');

// ---------------- 5. the demo scenes ----------------
say('## 5. The demo scenes in the replay picker');
say('');
for (const [id, sc] of Object.entries(RP.SCENES)) {
  const d = RP.prepare(raw[sc.log], sc, P);
  const ev = d.ep.filter((e) => e.event).map((e) => `${e.event.kind} at ${e.i} s` + (e.back ? ` (${m(e.back.dist)} from dead reckoning, ±${m(e.back.r95)}, ${e.back.ok ? 'trusted' : 'rejected'})` : e.gate && e.gate.dist != null ? ` (${m(e.gate.dist)}, ±${m(e.gate.r95)})` : ''));
  const a = d.attack;
  let worst = 0, before = 0, firstRej = null;
  for (const e of d.ep) {
    const x = err(e);
    if (x != null) worst = Math.max(worst, x);
    if (a && e.i >= a.from && e.i < a.to && firstRej == null) { if (e.rejected || (a.kind === 'jam' && e.diag && e.diag.kind === 'jam')) firstRej = e.i; else if (x != null) before = Math.max(before, x); }
  }
  say(`- **${sc.title}** (${sc.sub}): ${ev.join('; ') || 'no events, no false alarms'}.` +
    (a ? ` Attack starts at ${a.from} s; ${firstRej != null ? `noticed after ${firstRej - a.from} s, when Alibi was at most ${m(before)} off` : 'never noticed'}; Alibi's worst error ${m(worst)}.` : ''));
}
say('');
say(`(${((Date.now() - t0) / 1000).toFixed(0)} s)`);

if (opt('--md')) fs.writeFileSync(opt('--md'), out.join('\n') + '\n');
if (args.includes('--svg')) writeSvg(path.join(dir, 'docs', 'replay-integrity.svg'));

// error against the ± Alibi showed, one dot per second (log scales): above the diagonal the ± told the truth
function writeSvg(file) {
  const W = 640, H = 520, L0 = 70, R0 = 20, T0 = 50, B0 = 60, lo = Math.log10(0.5), hi = Math.log10(10000);
  const X = (v) => L0 + (Math.log10(Math.min(10000, Math.max(0.5, v))) - lo) / (hi - lo) * (W - L0 - R0);
  const Y = (v) => H - B0 - (Math.log10(Math.min(10000, Math.max(0.5, v))) - lo) / (hi - lo) * (H - T0 - B0);
  const col = { honest: '#2563eb', outage: '#059669', attack: '#dc2626' };
  const cnt = {};
  for (const [e, s, k] of dots) { const c = cnt[k] = cnt[k] || { n: 0, out: 0 }; c.n++; if (e > s) c.out++; }
  let g = '';
  for (const t of [1, 10, 100, 1000, 10000]) {
    g += `<line x1="${X(t)}" y1="${T0}" x2="${X(t)}" y2="${H - B0}" stroke="#e2e8f0"/><line x1="${L0}" y1="${Y(t)}" x2="${W - R0}" y2="${Y(t)}" stroke="#e2e8f0"/>`;
    g += `<text x="${X(t)}" y="${H - B0 + 16}" text-anchor="middle">${G.fmtDist(t)}</text><text x="${L0 - 6}" y="${Y(t) + 4}" text-anchor="end">${G.fmtDist(t)}</text>`;
  }
  // one dot per 4-pixel cell and kind keeps the file small
  const seen = new Set();
  const pts = dots.map(([e, s, k]) => [Math.round(X(e) / 4) * 4, Math.round(Y(s) / 4) * 4, k]).filter(([x, y, k]) => !seen.has(`${x},${y},${k}`) && seen.add(`${x},${y},${k}`))
    .map(([x, y, k]) => `<circle cx="${x}" cy="${y}" r="2.2" fill="${col[k]}" fill-opacity="0.5"/>`).join('');
  const legend = Object.entries({ honest: 'dead reckoning on the real logs (every 2nd s)', outage: 'GPS back after a synthetic outage', attack: 'Alibi under simulated attack' })
    .map(([k, t], i) => { const c = cnt[k] || { n: 0, out: 0 }; return `<circle cx="${L0 + 14}" cy="${T0 + 14 + 16 * i}" r="4" fill="${col[k]}"/><text x="${L0 + 24}" y="${T0 + 18 + 16 * i}">${t}: ${c.n} dots, ${pct(c.out, c.n)} below the line</text>`; }).join('');
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${W} ${H}" font-family="system-ui, sans-serif" font-size="11" fill="#334155">
<rect width="${W}" height="${H}" fill="#fff"/>
<text x="${L0}" y="22" font-size="15" font-weight="700" fill="#0f172a">Alibi replay: real error against the ± it showed</text>
<text x="${L0}" y="38">Above the line the ± held the truth; below it the ± was too small (misleading). Made by tools/check_spoof.js.</text>
<polygon points="${X(0.5)},${Y(0.5)} ${X(10000)},${Y(10000)} ${X(10000)},${Y(0.5)}" fill="#fee2e2" fill-opacity="0.6"/>
${g}<line x1="${X(0.5)}" y1="${Y(0.5)}" x2="${X(10000)}" y2="${Y(10000)}" stroke="#0f172a" stroke-width="1.2"/>
${pts}
<rect x="${L0 + 4}" y="${T0 + 2}" width="370" height="54" fill="#fff" fill-opacity="0.9" stroke="#e2e8f0"/>${legend}
<text x="${(L0 + W - R0) / 2}" y="${H - 18}" text-anchor="middle" font-size="12" fill="#0f172a">real error of Alibi's position</text>
<text transform="translate(16 ${(T0 + H - B0) / 2}) rotate(-90)" text-anchor="middle" font-size="12" fill="#0f172a">± Alibi showed</text>
</svg>
`;
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, svg);
  console.log('wrote', file, dots.length, 'dots');
}
