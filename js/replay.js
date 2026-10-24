/* Alibi - replay the organisers' real GPS recordings (Google GnssLogger on an Android phone) second by second,
   and clearly labelled simulated attacks on top of them.
   Every second GPS is checked against an independent witness: dead reckoning ("Motion"), carried on with the
   vehicle's own speed and the phone's gyroscope from a GPS fix that was trusted 25 s earlier. A fix that fails
   the check is not trusted, dead reckoning is never re-anchored on it, and it stays distrusted while it keeps
   telling the same lie. The replay also says why GPS is missing (blocked, a receiver hiccup, or possible
   jamming), using the receiver gain (AGC) only where the phone actually logged it. */
Alibi.replay = (function () {
  'use strict';

  const G = Alibi.geo;
  const D2R = Math.PI / 180, M = G.M_PER_DEG;

  // The vehicle's own speed sensor (a train's odometer, a car's wheel speed) is not in the recordings, so the
  // recorded speed stands in for it. A GPS spoofer can't touch that sensor, so the simulated attacks only
  // change what GPS reports. Where the recording has no speed at all (in the tunnels), the speed is unknown
  // and dead reckoning holds the median of the last 10 s, with a ± that grows quickly.
  const LOGS = {
    train: { file: 'data/train.json', icon: 'fa-train', label: 'Train ride (France)', limit: 100, sensor: 'odometer', vehicle: 'train' },
    car: { file: 'data/car.json', icon: 'fa-car', label: 'Car drive (Espoo)', limit: 50, sensor: 'wheel speed', vehicle: 'car' },
  };

  // What the replay picker offers. Attacks are simulated on top of the real recordings.
  const SCENES = {
    train: { log: 'train', title: 'Train ride near Paris', sub: 'real log · tunnels: blocked or jammed?' },
    trainSpoof: { log: 'train', title: 'Train + spoofing after a tunnel', sub: 'simulated: GPS comes back 1 km off after the 7 s tunnel',
      attack: { kind: 'jump', outage: 'last', dist: 1000, side: 90, dur: 100 } },
    trainSpoofLong: { log: 'train', title: 'Train + spoofing after the long tunnel', sub: 'simulated: GPS comes back 3 km off after 111 s without GPS',
      attack: { kind: 'jump', outage: 'longest', dist: 3000, side: 90, dur: 150 } },
    carDrag: { log: 'car', title: 'Car + slow drag spoofing', sub: 'simulated: GPS pulled away at 3 m/s',
      attack: { kind: 'drag', t0: 300, speed: 3, brg: 120, dur: 240 } },
    carJam: { log: 'car', title: 'Car + jamming', sub: 'simulated: radio noise drowns GPS for a minute',
      attack: { kind: 'jam', t0: 560, ramp: 40, hold: 45, fall: 20 } },
    car: { log: 'car', title: 'Car drive in Espoo', sub: 'real log, no attack: does Alibi cry wolf?' },
  };

  const P = {
    W: 25,             // the Motion witness: dead reckoning from the trusted fix this many seconds ago
    CHI2: 13.8,        // consistency limit: chi-square, 2 degrees of freedom, 0.1 % false alarms
    K95: 2.45,         // ± is a 95 % radius; for a round 2-D normal that is 2.45 sigma
    GAP: 5,            // a gap this long (s) without GPS counts as an outage
    SETTLE: 5,         // fixes right after an outage are less precise: anchor on them only after this many s
    // dead-reckoning error model, calibrated on synthetic outages cut into both logs (see deadReckon)
    PSI0: 0.025, PSI_RATE: 0.0007, NOGYRO: 1.2, HELD_A: 1.6, HELD_P: 1.25,
    REF_WIN: 30, REF_VMIN: 5, REF_TURN: 3, HELD_N: 10,
    // jamming: the receiver turns its gain (AGC) down this much (dB) below its usual level
    AGC_DROP: 3, AGC_NEAR: 3,
  };

  const raw = {};
  async function load(name) {
    if (raw[name]) return raw[name];
    const r = await fetch(LOGS[name].file);
    if (!r.ok) throw new Error('HTTP ' + r.status);
    return (raw[name] = await r.json());
  }

  const median = (a) => { const s = a.slice().sort((x, y) => x - y); return s.length ? s[s.length >> 1] : null; };
  const wrap180 = (a) => ((a + 180) % 360 + 360) % 360 - 180;
  const gpsSigma = (acc) => Math.max(3, (acc || 10) / 1.5);   // phones report a 68 % radius
  const offsetM = (a, b) => ({ e: (b.lon - a.lon) * M * Math.cos(a.lat * D2R), n: (b.lat - a.lat) * M });   // a -> b in metres

  // ---------- the simulated attacks: they change only what the GPS receiver reports ----------
  function attackInfo(ep, at) {
    if (!at) return null;
    if (at.kind === 'jump' && at.t0 != null) return Object.assign({}, at, { from: at.t0, to: at.t0 + at.dur, dir: at.brg });
    if (at.kind === 'jump') {
      // the spoofer waits for the train to leave a tunnel (the longest, or the last one), then takes over
      let best = null, run = 0;
      ep.forEach((e, i) => {
        if (e.lat == null) { run++; return; }
        if (run >= P.GAP && i - run > 0 && (!best || at.outage === 'last' || run > best.gap)) best = { gap: run, i };
        run = 0;
      });
      if (!best) return null;
      const x = ep[best.i], brg = G.wrap360((x.brg != null ? x.brg : 0) + at.side);
      return Object.assign({}, at, { from: best.i, to: best.i + at.dur, dir: brg });
    }
    if (at.kind === 'drag') return Object.assign({}, at, { from: at.t0, to: at.t0 + at.dur });
    if (at.kind === 'jam') return Object.assign({}, at, { from: at.t0, to: at.t0 + at.ramp + at.hold + at.fall });
    return null;
  }

  function jamLevel(a, i) {
    const k = i - a.from;
    if (k < 0 || i >= a.to) return 0;
    if (k < a.ramp) return k / a.ramp;
    if (k < a.ramp + a.hold) return 1;
    return 1 - (k - a.ramp - a.hold) / a.fall;
  }

  // what the receiver puts out this second: { lat, lon, acc, spd, brg } or null, and what it hears
  function receiver(e, i, a) {
    const rec = e.lat != null ? { lat: e.lat, lon: e.lon, acc: e.acc, spd: e.spd, brg: e.brg } : null;
    const out = { gps: rec, nsat: e.nsat, cn0: e.cn0, agc: e.agc, off: 0 };
    if (!a || i < a.from || i >= a.to || (a.kind !== 'jam' && !rec)) return out;
    if (a.kind === 'jump') {
      const p = G.dest(rec.lat, rec.lon, a.dir, a.dist);
      out.gps = Object.assign({}, rec, { lat: p.lat, lon: p.lon });     // a fixed offset moves with the train
      out.off = a.dist;
    } else if (a.kind === 'drag') {
      // the fake position drifts at a steady speed; a careful spoofer fakes the speed and course to match
      const d = a.speed * (i - a.from), p = G.dest(rec.lat, rec.lon, a.brg, d);
      const v = rec.spd > 0.5 && rec.brg != null ? rec.spd : 0, b = (rec.brg || 0) * D2R;
      const ve = v * Math.sin(b) + a.speed * Math.sin(a.brg * D2R), vn = v * Math.cos(b) + a.speed * Math.cos(a.brg * D2R);
      const spd = Math.hypot(ve, vn);
      out.gps = { lat: p.lat, lon: p.lon, acc: rec.acc, spd: Math.round(spd * 10) / 10, brg: spd > 0.3 ? Math.round(G.wrap360(Math.atan2(ve, vn) / D2R)) : null };
      out.off = d;
    } else if (a.kind === 'jam') {
      // radio noise: the receiver turns its gain down, every satellite sounds weaker, then the fix is lost
      const j = jamLevel(a, i);
      if (e.agc != null) out.agc = Math.round((e.agc - 9 * j) * 10) / 10;
      if (e.cn0 != null) {
        out.cn0 = Math.round((e.cn0 - 22 * j) * 10) / 10;
        out.nsat = Math.round(e.nsat * Math.max(0, Math.min(1, (out.cn0 - 20) / Math.max(1, e.cn0 - 20))));
        if (out.cn0 < 18) out.cn0 = null;
      }
      if (!rec || out.cn0 == null || out.cn0 < 27 || out.nsat < 5) out.gps = null;
      else out.gps = Object.assign({}, rec, { acc: rec.acc != null ? Math.round(rec.acc * (1 + 5 * j) * 10) / 10 : rec.acc });
    }
    return out;
  }

  // ---------- run the whole recording through the replay logic ----------
  // raw log + scene -> one record per second (what the app shows and what the tests score)
  function prepare(log, scene, opt) {
    const p = Object.assign({}, P, opt || {});
    const ix = {};
    log.cols.forEach((c, i) => { ix[c] = i; });
    const col = (r, c) => (ix[c] == null ? null : r[ix[c]]);
    const src = log.epochs.map((r) => ({
      t: col(r, 't'), lat: col(r, 'lat'), lon: col(r, 'lon'), acc: col(r, 'acc'), spd: col(r, 'spd'), brg: col(r, 'brg'),
      nsat: col(r, 'nsat') || 0, cn0: col(r, 'cn0'), agc: col(r, 'agc'), yaw: col(r, 'yaw'),
    }));
    const attack = attackInfo(src, scene && scene.attack);
    const n = src.length;
    const ep = src.map((s, i) => {
      const rx = receiver(s, i, attack);
      return { i, t: s.t, truth: s.lat != null ? { lat: s.lat, lon: s.lon } : null, gps: rx.gps, off: rx.off,
        nsat: rx.nsat, cn0: rx.cn0, agc: rx.agc, yaw: s.yaw, spdS: s.spd };
    });

    // speed used by dead reckoning: the vehicle's own sensor (stand-in: the recorded speed); in a gap of the
    // recording, the median of the last 10 recorded speeds (held). The stand-in is GPS's own speed, which is
    // unreliable for a few seconds after the receiver finds the satellites again, so those count as a gap too.
    const vUse = new Float64Array(n), held = new Uint8Array(n);
    const recent = [];
    let fresh = 0;
    for (let s = 0; s < n; s++) {
      const v = ep[s].spdS;
      fresh = v == null ? 0 : fresh + 1;
      if (v != null && (fresh > p.SETTLE || !recent.length)) { vUse[s] = v; recent.push(v); if (recent.length > p.HELD_N) recent.shift(); }
      else { vUse[s] = recent.length ? median(recent) : 0; held[s] = 1; }
    }
    // dead reckoning in the gyroscope's own frame, summed once: any stretch from A to i is then a difference
    // turned by the gyroscope's offset from true north at A
    const Cx = new Float64Array(n), Cy = new Float64Array(n), Cd = new Float64Array(n), Ch = new Float64Array(n), Cng = new Float64Array(n);
    let yPrev = null;
    for (let s = 0; s < n; s++) {
      const y = ep[s].yaw != null ? ep[s].yaw : yPrev;
      if (s > 0) {
        const step = 0.5 * (vUse[s - 1] + vUse[s]);
        const gyro = ep[s].yaw != null && ep[s - 1].yaw != null;
        const ym = (y == null ? 0 : yPrev == null ? y : 0.5 * (y + yPrev)) * D2R;
        Cx[s] = Cx[s - 1] + step * Math.sin(ym); Cy[s] = Cy[s - 1] + step * Math.cos(ym);
        Cd[s] = Cd[s - 1] + step; Ch[s] = Ch[s - 1] + held[s]; Cng[s] = Cng[s - 1] + (gyro ? 0 : step);
      }
      yPrev = y;
    }

    // Dead reckoning from a trusted fix A to second i, and its error (one sigma, metres):
    //   sigma² = fix² + (distance × direction error)² + (1.2 × distance without gyroscope)² + (1.6 × t_held^1.25)²
    // The direction error is how well the GPS course pinned the gyroscope's zero (1.4°, more with fewer than 10
    // readings) plus gyroscope drift (0.04°/s). Without a speed sensor the vehicle may have sped up or braked:
    // that term grows with the seconds the speed was only held. Calibrated on synthetic outages cut into both
    // logs (10-120 s, every start time) so that the ± (2.45 sigma) holds the truth about 95 % of the time.
    function deadReckon(A, i) {
      const dx = Cx[i] - Cx[A.i], dy = Cy[i] - Cy[A.i], c = (A.ref ? A.ref.c : 0) * D2R;
      const de = Math.cos(c) * dx + Math.sin(c) * dy, dn = Math.cos(c) * dy - Math.sin(c) * dx;
      const pos = G.offset(A.lat, A.lon, de, dn), t = i - A.i, d = Cd[i] - Cd[A.i], th = Ch[i] - Ch[A.i], dng = Cng[i] - Cng[A.i];
      const psi = A.ref ? Math.min(1, p.PSI0 * Math.sqrt(10 / Math.min(10, A.ref.n)) + p.PSI_RATE * (A.ref.age + t / 2)) : 1;
      const sigma = Math.sqrt(A.sigma * A.sigma + (d * psi) ** 2 + (p.NOGYRO * dng) ** 2 + (th ? p.HELD_A * Math.pow(th, p.HELD_P) : 0) ** 2);
      return { lat: pos.lat, lon: pos.lon, sigma, r95: p.K95 * sigma, age: t, dist: d, held: th, gyro: !dng, spd: vUse[i], from: A.i };
    }

    const trusted = [];          // fixes that passed the check: { i, lat, lon, sigma, ref }
    const refs = [];             // course - gyroscope readings from trusted fixes: { i, o }
    let rej = null, lost = 0, gapEnd = 0, lastFix = -1, started = false;
    let agcBase = null, agcMin = Infinity, agcMax = -Infinity, agcN = 0, cn0Base = null, lastAgc = null;
    const outs = [];

    // the gyroscope's offset from true north, from steady stretches of trusted GPS course
    function refAt(i) {
      if (!refs.length) return null;
      const newest = refs[refs.length - 1].i;
      let s = 0, c = 0, k = 0;
      for (let j = refs.length - 1; j >= 0 && refs[j].i >= newest - p.REF_WIN; j--) { s += Math.sin(refs[j].o * D2R); c += Math.cos(refs[j].o * D2R); k++; }
      return { c: Math.atan2(s, c) / D2R, n: k, age: i - newest };
    }
    function trust(i, gps) {
      const e = ep[i], prev = i > 0 ? ep[i - 1] : null;
      if (gps.brg != null && e.spdS != null && e.spdS >= p.REF_VMIN && e.yaw != null && prev && prev.yaw != null && Math.abs(e.yaw - prev.yaw) <= p.REF_TURN) {
        refs.push({ i, o: wrap180(gps.brg - e.yaw) });
      }
      trusted.push({ i, lat: gps.lat, lon: gps.lon, sigma: gpsSigma(gps.acc), ref: refAt(i) });
    }
    // which trusted fix the Motion witness starts from
    function anchorFor(i, checking) {
      if (rej) return rej.A;
      if (!trusted.length) return null;
      const newest = trusted[trusted.length - 1];
      if (!checking || lost > 0) return newest;                 // no GPS, or GPS just came back: best estimate
      for (const f of trusted) if (f.i >= i - p.W && f.i >= gapEnd && f.i <= i - p.SETTLE) return f;   // oldest trusted fix in the window
      // GPS came back only moments ago: keep checking it against the last fix before the outage
      if (i - gapEnd < p.SETTLE) for (let k = trusted.length - 1; k >= 0; k--) if (trusted[k].i < gapEnd) return trusted[k];
      return newest;
    }

    for (let i = 0; i < n; i++) {
      const e = ep[i], gps = e.gps;
      const A = anchorFor(i, !!gps);
      e.dr = A ? deadReckon(A, i) : null;
      e.lost = lost;
      if (gps) {
        const sg = gpsSigma(gps.acc);
        e.gpsSigma = sg;
        if (!started || !e.dr) {
          trust(i, gps); started = true;
          e.gate = { state: 'start' };
        } else {
          const o = offsetM(e.dr, gps), S = e.dr.sigma ** 2 + sg * sg, chi2 = (o.e * o.e + o.n * o.n) / S;
          const dist = Math.hypot(o.e, o.n);
          let ok;
          if (!rej) ok = chi2 <= p.CHI2;
          else {
            // Still the same lie? Compare "GPS is honest" (offset near 0, within dead reckoning's ± now) with
            // "GPS still lies the same way" (offset near the one it had when it was caught, within how much
            // dead reckoning could have drifted since). A spoofer holding a fixed offset never wins this,
            // however large the ± grows.
            const Sl = Math.max(25, e.dr.sigma ** 2 - rej.s0) + 2 * sg * sg;
            const de = o.e - rej.o.e, dn = o.n - rej.o.n;
            const llHonest = -0.5 * chi2 - Math.log(S), llLie = -0.5 * (de * de + dn * dn) / Sl - Math.log(Sl);
            e.lr = llLie - llHonest;
            ok = chi2 <= p.CHI2 && llHonest >= llLie;
          }
          e.gate = { state: ok ? (rej ? 'clear' : 'ok') : (rej ? 'held' : 'new'), chi2, dist, r95: e.dr.r95,
            limit: Math.sqrt(p.CHI2 * S), since: rej ? i - rej.i : 0 };
          if (ok) {
            if (rej) { e.event = { kind: 'clear', since: i - rej.i }; rej = null; }
            trust(i, gps);
          } else if (!rej) {
            // caught: freeze the witness that caught it, and drop the fixes trusted since then (a slow drag may
            // already have been under way in them)
            rej = { i, A, o, s0: e.dr.sigma ** 2 };
            while (trusted.length && trusted[trusted.length - 1].i > A.i) trusted.pop();
            while (refs.length && refs[refs.length - 1].i > A.i) refs.pop();
            if (!lost) e.event = { kind: 'spoof' };
          }
        }
        if (lost >= p.GAP && e.dr) {
          e.back = { gap: lost, dist: e.gate.dist, r95: e.dr.r95, since: e.dr.dist, held: e.dr.held, ok: !rej, chi2: e.gate.chi2 };
          e.event = { kind: 'back' };
          outs.push({ from: lastFix + 1, to: i });
        }
        if (lost >= p.GAP && !rej) gapEnd = i;
        lost = 0; lastFix = i;
      } else if (started) lost++;
      e.rejected = !!(gps && rej);
      e.held = !!rej;                      // GPS is under suspicion (rejected, or caught and not yet cleared)
      e.est = gps && !rej ? { lat: gps.lat, lon: gps.lon } : e.dr ? { lat: e.dr.lat, lon: e.dr.lon } : null;

      // ---------- receiver health: gain (AGC) and signal strength against their usual level ----------
      if (e.agc != null) {
        lastAgc = { i, v: e.agc };
        agcMin = Math.min(agcMin, e.agc); agcMax = Math.max(agcMax, e.agc); agcN++;
      }
      const agcNear = lastAgc && i - lastAgc.i <= p.AGC_NEAR ? lastAgc.v : null;
      const healthy = gps && e.nsat >= 6 && !(e.gate && e.gate.state === 'new');
      e.agcDrop = agcNear != null && agcBase != null ? agcBase - agcNear : null;
      e.cn0Drop = e.cn0 != null && cn0Base != null ? cn0Base - e.cn0 : null;
      e.agcFlat = agcN >= 60 && agcMax - agcMin < 0.3;
      e.diag = diagnose(e);
      if (e.diag && e.diag.kind === 'jam' && !(i > 0 && ep[i - 1].diag && ep[i - 1].diag.kind === 'jam') && !e.event) e.event = { kind: 'jam' };
      // the usual gain level: it may rise quickly but only sinks slowly (a 5-minute memory), so a jammer that
      // turns up the noise very slowly can't drag the baseline down with it
      if (healthy && e.agc != null && (e.agcDrop == null || e.agcDrop < p.AGC_DROP)) {
        const k = agcBase == null || e.agc > agcBase ? 0.03 : 0.003;
        agcBase = agcBase == null ? e.agc : (1 - k) * agcBase + k * e.agc;
      }
      if (healthy && e.cn0 != null && (e.cn0Drop == null || e.cn0Drop < 6)) cn0Base = cn0Base == null ? e.cn0 : 0.95 * cn0Base + 0.05 * e.cn0;
    }
    // outages that never ended (GPS still gone at the end of the recording)
    if (lost >= p.GAP && lastFix >= 0) outs.push({ from: lastFix + 1, to: n - 1, open: true });

    const L = LOGS[scene ? scene.log : 'train'] || LOGS.train;
    return {
      name: log.name, scene, attack, ep, outs, limit: L.limit, sensor: L.sensor, vehicle: L.vehicle,
      track: ep.filter((e) => e.truth).map((e) => [e.truth.lat, e.truth.lon]),
      gpsTrack: ep.filter((e) => e.gps).map((e) => [e.gps.lat, e.gps.lon]),
    };
  }

  // GPS and dead reckoning ("Motion") as the engine's two witnesses for second e. A GPS fix the replay has
  // caught lying goes in as a suspect: shown, but given no vote.
  function witnesses(e, d) {
    const f = G.fmtDist, ws = [];
    if (e.gps) {
      const w = { id: 'gps', type: 'gps', kind: 'point', lat: e.gps.lat, lon: e.gps.lon, sigma: e.gpsSigma, label: 'GPS',
        detail: `${e.nsat} satellites · signal ${e.cn0 != null ? e.cn0.toFixed(0) + ' dB-Hz' : '–'} · ±${f(P.K95 * e.gpsSigma)}` };
      if (e.rejected) {
        const g = e.gate;
        w.suspect = true;
        w.why = g.state === 'held' ? `GPS still tells the lie it was caught with ${g.since} s ago (${f(g.dist)} from dead reckoning).`
          : e.back ? `GPS came back after ${e.back.gap} s ${f(g.dist)} from where dead reckoning says, far outside its ±${f(g.r95)}.`
          : `GPS is ${f(g.dist)} from where the ${d.sensor} and gyroscope say, outside their ±${f(g.r95)}.`;
      }
      ws.push(w);
    }
    if (e.dr) {
      const r = e.dr;
      // fromGps: it was started from a GPS fix, so on its own it can't prove a slow drag away
      ws.push({ id: 'motion', type: 'motion', kind: 'point', fromGps: true, lat: r.lat, lon: r.lon, sigma: r.sigma, label: r.gyro ? 'Speed + gyroscope' : 'Speed + direction',
        detail: `${r.age ? `trusted fix ${r.age} s ago` : 'this fix'} + ${f(r.dist)} · ` +
          (r.held ? `speed unknown for ${r.held} s, held at ${Math.round(r.spd * 3.6)} km/h` : d.sensor) + ` · ±${f(r.r95)}` });
    }
    return ws;
  }

  // Why is GPS missing or weak right now? Jamming is checked first, so it can be seen before the fix is lost.
  function diagnose(e) {
    const fix = !!e.gps;
    if (e.agcDrop != null && e.agcDrop >= P.AGC_DROP) {
      return { kind: 'jam', text: `Possible jamming: the receiver turned its gain down ${e.agcDrop.toFixed(1)} dB (more radio noise than usual)` +
        (e.cn0Drop != null && e.cn0Drop >= 3 ? ` and the satellites sound ${e.cn0Drop.toFixed(0)} dB weaker` : '') +
        (fix ? '. GPS still gives a position, but it may soon fail or be faked.' : `. GPS lost for ${e.lost} s.`) };
    }
    if (fix && e.nsat >= 4) return null;
    if (!fix && e.nsat >= 4 && e.cn0 != null && e.cn0 > 30) {
      return { kind: 'nofix', text: `No GPS position for ${e.lost} s, although ${e.nsat} satellites are heard clearly (${e.cn0.toFixed(0)} dB-Hz). ` +
        'The phone just stopped giving GPS fixes: a receiver hiccup. A jammer would drown the satellites, so this is not jamming.' };
    }
    if (!fix && (e.nsat === 0 || e.cn0 == null)) {
      const lead = `GPS lost for ${e.lost} s and no satellites heard at all. `;
      if (e.agcDrop == null) return { kind: 'blocked', text: lead + 'The receiver gain was not logged here, so jamming can’t be ruled out. Most likely blocked (a tunnel).' };
      if (e.agcFlat) return { kind: 'blocked', text: lead + 'The receiver gain reads normal, but it has not changed once in this recording, so it proves little: most likely blocked (a tunnel), but jamming can’t be ruled out.' };
      return { kind: 'blocked', text: lead + 'The receiver gain is at its usual level, so most likely the signal is blocked (a tunnel), not jammed. (A gain check can miss a jammer that ramps up very slowly.)' };
    }
    return { kind: 'weak', text: `GPS weak: only ${e.nsat} satellites${e.cn0 != null ? `, signal ${e.cn0.toFixed(0)} dB-Hz` : ''}.` };
  }

  return { LOGS, SCENES, P, load, prepare, witnesses, diagnose };
})();
