/* Alibi - phone sensors in the browser: which way the camera points (compass bearing and up-angle),
   how far the phone has turned (gyroscope, which magnets can't fool), and a simple step counter.
   Works on Android Chrome and iPhone Safari (needs HTTPS). */
Alibi.sensors = (function () {
  'use strict';

  const G = Alibi.geo;
  const D2R = Math.PI / 180, R2D = 180 / Math.PI;
  // recent { t, heading (compass, magnetic, may be null), rel (gyroscope heading, arbitrary zero, may be null), elev }
  const samples = [];
  // 15 s of { t, d: compass heading minus gyroscope heading }, about 10 a second, for the compass check
  const pairs = [];
  let started = false, lastEvent = 0, lastAbs = null, lastRel = null, lastAcc = null;
  let stepCb = null, stepOn = false, filt = 9.81, lastStep = 0, rising = false;

  // Direction of the back camera from the W3C orientation angles (rotation matrix Rz(a)·Rx(b)·Ry(g)).
  // Android sends two streams: "absolute" (with the magnetic compass) and plain (gyroscope only, its own zero).
  // iPhone sends one: alpha comes from the gyroscope, webkitCompassHeading from the compass.
  function onOrientation(e, absolute) {
    if (e.beta == null || e.gamma == null) return;
    const a = (e.alpha || 0) * D2R, b = e.beta * D2R, g = e.gamma * D2R;
    const cA = Math.cos(a), sA = Math.sin(a), cB = Math.cos(b), sB = Math.sin(b), cG = Math.cos(g), sG = Math.sin(g);
    const E = -cA * sG - sA * sB * cG;     // back camera = device -z axis, in east/north/up
    const N = -sA * sG + cA * sB * cG;
    const U = -cB * cG;
    const elev = Math.asin(Math.max(-1, Math.min(1, U))) * R2D;
    // phone lying flat: the camera looks at the ground, so use the top edge of the phone instead
    const dir = Math.abs(elev) > 65 ? G.wrap360(Math.atan2(-sA * cB, cA * cB) * R2D) : G.wrap360(Math.atan2(E, N) * R2D);
    if (typeof e.webkitCompassHeading === 'number' && !isNaN(e.webkitCompassHeading)) {
      lastAbs = e.webkitCompassHeading;
      lastRel = dir;
      if (typeof e.webkitCompassAccuracy === 'number') lastAcc = e.webkitCompassAccuracy;   // iPhone: ± degrees, -1 = uncalibrated
    }
    else if (absolute) lastAbs = dir;
    else lastRel = dir;
    const now = performance.now();
    lastEvent = now;
    samples.push({ t: now, heading: lastAbs, rel: lastRel, elev });
    while (samples.length && now - samples[0].t > 3000) samples.shift();
    if (lastAbs != null && lastRel != null && (!pairs.length || now - pairs[pairs.length - 1].t >= 100)) {
      pairs.push({ t: now, d: G.wrap180(lastAbs - lastRel) });
      while (pairs.length && now - pairs[0].t > 15000) pairs.shift();
    }
  }

  function onMotion(e) {
    if (!stepOn || !e.accelerationIncludingGravity) return;
    const a = e.accelerationIncludingGravity;
    const mag = Math.sqrt((a.x || 0) ** 2 + (a.y || 0) ** 2 + (a.z || 0) ** 2);
    filt = 0.8 * filt + 0.2 * mag;
    const now = performance.now();
    if (filt > 11.0) rising = true;
    else if (rising && filt < 10.2) {
      rising = false;
      if (now - lastStep > 330) { lastStep = now; if (stepCb) stepCb(current()); }
    }
  }

  // Must be called from a tap (iPhone asks for permission)
  async function start() {
    if (started) return true;
    try {
      if (typeof DeviceOrientationEvent !== 'undefined' && typeof DeviceOrientationEvent.requestPermission === 'function') {
        if (await DeviceOrientationEvent.requestPermission() !== 'granted') return false;
      }
      if (typeof DeviceMotionEvent !== 'undefined' && typeof DeviceMotionEvent.requestPermission === 'function') {
        await DeviceMotionEvent.requestPermission().catch(() => {});
      }
    } catch (e) { return false; }
    if ('ondeviceorientationabsolute' in window) window.addEventListener('deviceorientationabsolute', (e) => onOrientation(e, true));
    window.addEventListener('deviceorientation', (e) => onOrientation(e, e.absolute === true));
    window.addEventListener('devicemotion', onMotion);
    started = true;
    return true;
  }

  function alive() { return started && performance.now() - lastEvent < 1500; }

  function current() {
    const s = samples[samples.length - 1];
    return s ? { heading: s.heading, rel: s.rel, elev: s.elev } : null;
  }

  // circular mean and spread (degrees) of one heading field
  function circular(win, key) {
    let sx = 0, sy = 0, n = 0;
    for (const s of win) if (s[key] != null) { sx += Math.sin(s[key] * D2R); sy += Math.cos(s[key] * D2R); n++; }
    if (!n) return { mean: null, spread: null };
    const len = Math.min(1, Math.hypot(sx, sy) / n);
    return { mean: G.wrap360(Math.atan2(sx, sy) * R2D), spread: Math.sqrt(-2 * Math.log(Math.max(1e-9, len))) * R2D };
  }

  // Average of the last `ms` milliseconds; spread tells how steady the hand was
  function average(ms) {
    const now = performance.now(), win = samples.filter((s) => now - s.t <= ms);
    if (!win.length) return null;
    const elev = win.reduce((a, s) => a + s.elev, 0) / win.length;
    const elevSpread = Math.sqrt(win.reduce((a, s) => a + (s.elev - elev) ** 2, 0) / win.length);
    const h = circular(win, 'heading'), r = circular(win, 'rel');
    return { heading: h.mean, headSpread: h.spread, rel: r.mean, relSpread: r.spread, elev, elevSpread, n: win.length };
  }

  // Compass check. Magnets can't fool the gyroscope, so the compass should turn exactly as much as the gyroscope
  // does, and the gap between the two should stay put. If the gap wanders, something magnetic is near.
  // The phone itself won't say so: in the organisers' train recording Android marked every compass reading
  // "high accuracy" while it was far off. drift = how far the gap wandered (degrees, 1 s averages) over the last
  // `ms`; null if there is too little data or no separate gyroscope stream. accuracy = iPhone's own ± (or null).
  function compassCheck(ms) {
    const now = performance.now(), win = pairs.filter((p) => now - p.t <= ms);
    if (win.length < 20 || win[win.length - 1].t - win[0].t < 3000) return { drift: null, accuracy: lastAcc };
    const mean = circular(win, 'd').mean, bins = {};
    for (const p of win) (bins[Math.floor((now - p.t) / 1000)] = bins[Math.floor((now - p.t) / 1000)] || []).push(p);
    const dev = Object.values(bins).filter((b) => b.length >= 3).map((b) => G.wrap180(circular(b, 'd').mean - mean));
    return { drift: dev.length > 1 ? Math.max(...dev) - Math.min(...dev) : null, accuracy: lastAcc };
  }

  function setSteps(on, cb) { stepOn = on; stepCb = cb; }

  return { start, alive, current, average, compassCheck, setSteps };
})();
