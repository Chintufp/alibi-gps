/* Alibi - replay the organisers' real GPS recordings (Google GnssLogger on an Android phone) second by second.
   Shows when GPS drops out (tunnels), tells a blocked signal from possible jamming when the phone logged its
   receiver gain (AGC), and carries the position through the gap with speed and direction ("dead reckoning"),
   then checks GPS against that estimate when it comes back. */
Alibi.replay = (function () {
  'use strict';

  const G = Alibi.geo;
  const LOGS = {
    train: { file: 'data/train.json', icon: 'fa-train', label: 'Train ride (France)', mode: 'train' },
    car: { file: 'data/car.json', icon: 'fa-car', label: 'Car drive (Espoo)', mode: 'car' },
  };
  const loaded = {};

  async function load(name) {
    if (loaded[name]) return loaded[name];
    const r = await fetch(LOGS[name].file);
    if (!r.ok) throw new Error('HTTP ' + r.status);
    return (loaded[name] = prepare(await r.json()));
  }

  // Rows -> epochs, then run a simple dead-reckoning filter through the whole log
  function prepare(log) {
    const ix = {};
    log.cols.forEach((c, i) => { ix[c] = i; });
    const col = (r, c) => (ix[c] == null ? null : r[ix[c]]);
    const ep = log.epochs.map((r) => ({
      t: col(r, 't'), lat: col(r, 'lat'), lon: col(r, 'lon'), acc: col(r, 'acc'), spd: col(r, 'spd'), brg: col(r, 'brg'),
      nsat: col(r, 'nsat') || 0, cn0: col(r, 'cn0'), agc: col(r, 'agc'), yaw: col(r, 'yaw'),
    }));
    let est = null, sig = 0, sig0 = 0, spd = 0, brg = 0, yaw0 = null, since = 0, secs = 0, lost = 0, agcBase = null;
    for (const e of ep) {
      // predict one second ahead with the last good speed. Direction: the last GPS direction, turned by as
      // much as the phone's gyroscope felt since then (so curves in a tunnel are followed). A direction error
      // makes the position error grow in step with the distance travelled: about 7 % of it, or 3 % when the
      // gyroscope follows the turns. Speed changes (about 1.5 m/s either way) add more every second.
      const gyro = e.yaw != null && yaw0 != null;
      if (est) {
        const h = gyro ? brg + (e.yaw - yaw0) : brg;
        if (spd > 0.2) est = G.dest(est.lat, est.lon, h, spd);
        since += spd;
        secs++;
        sig = Math.hypot(sig0, (gyro ? 0.03 : 0.07) * since, 1.5 * secs);
      }
      e.dr = est ? { lat: est.lat, lon: est.lon, sigma: sig, since, spd, gyro } : null;
      if (e.lat != null) {
        const sg = Math.max(3, (e.acc || 10) / 1.5);
        // GPS is back after a gap: how far is it from where dead reckoning said?
        if (est && lost >= 3) e.back = { gap: lost, dist: G.dist(est.lat, est.lon, e.lat, e.lon), sigma: Math.hypot(sig, sg), since };
        est = { lat: e.lat, lon: e.lon };
        sig = sig0 = sg; since = 0; secs = 0; lost = 0;
        if (e.spd != null && e.spd > 0.5) { spd = e.spd; if (e.brg != null) { brg = e.brg; yaw0 = e.yaw; } }
      } else if (est) lost++;
      e.lost = lost;
      // receiver gain while GPS is healthy, as a baseline to compare against
      if (e.agc != null) {
        if (e.lat != null && e.nsat >= 6) agcBase = agcBase == null ? e.agc : 0.97 * agcBase + 0.03 * e.agc;
        e.agcDrop = agcBase != null ? agcBase - e.agc : null;
      }
    }
    const outs = [];
    let start = null;
    ep.forEach((e, i) => {
      if (e.lat == null && e.dr) { if (start == null) start = i; }
      else if (start != null) { if (i - start >= 5) outs.push({ from: start, to: i }); start = null; }
    });
    const hasAgc = ep.some((e) => e.agc != null);
    return { name: log.name, ep, outs, hasAgc, track: ep.filter((e) => e.lat != null).map((e) => [e.lat, e.lon]) };
  }

  // Why is GPS missing or weak right now?
  function diagnose(e, hasAgc) {
    if (e.lat != null && e.nsat >= 4) return null;
    if (e.agcDrop != null && e.agcDrop > 4) {
      return { kind: 'jam', text: `Possible jamming: the receiver turned its gain down ${e.agcDrop.toFixed(1)} dB, so there is extra radio noise.` };
    }
    if (e.lat == null && e.nsat >= 4 && e.cn0 != null && e.cn0 > 30) {
      return { kind: 'nofix', text: `No GPS position for ${e.lost} s, although ${e.nsat} satellites are heard clearly (${e.cn0.toFixed(0)} dB-Hz). ` +
        'The phone just stopped giving GPS fixes: a receiver hiccup, not jamming.' };
    }
    if (e.lat == null && (e.nsat === 0 || e.cn0 == null)) {
      return { kind: 'blocked', text: `GPS lost for ${e.lost} s and no satellites heard at all. ` +
        (hasAgc ? 'The receiver gain is normal, so the signal is blocked (a tunnel), not jammed.' : 'Most likely blocked (a tunnel), not jammed. This phone did not log its receiver gain, so it can’t be sure.') };
    }
    return { kind: 'weak', text: `GPS weak: only ${e.nsat} satellites${e.cn0 != null ? `, signal ${e.cn0.toFixed(0)} dB-Hz` : ''}.` };
  }

  return { LOGS, load, diagnose };
})();
