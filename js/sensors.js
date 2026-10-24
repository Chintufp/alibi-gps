/* Alibi - phone sensors in the browser: which way the camera points (compass bearing and up-angle),
   and a simple step counter. Works on Android Chrome and iPhone Safari (needs HTTPS). */
Alibi.sensors = (function () {
  'use strict';

  const G = Alibi.geo;
  const D2R = Math.PI / 180, R2D = 180 / Math.PI;
  const samples = [];            // recent { t, heading (magnetic, may be null), elev }
  let started = false, lastEvent = 0;
  let stepCb = null, stepOn = false, filt = 9.81, lastStep = 0, rising = false;

  // Direction of the back camera from the W3C orientation angles (rotation matrix Rz(a)·Rx(b)·Ry(g))
  function onOrientation(e, absolute) {
    if (e.beta == null || e.gamma == null) return;
    const a = (e.alpha || 0) * D2R, b = e.beta * D2R, g = e.gamma * D2R;
    const cA = Math.cos(a), sA = Math.sin(a), cB = Math.cos(b), sB = Math.sin(b), cG = Math.cos(g), sG = Math.sin(g);
    const E = -cA * sG - sA * sB * cG;     // back camera = device -z axis, in east/north/up
    const N = -sA * sG + cA * sB * cG;
    const U = -cB * cG;
    const elev = Math.asin(Math.max(-1, Math.min(1, U))) * R2D;
    let heading = null;
    if (typeof e.webkitCompassHeading === 'number' && !isNaN(e.webkitCompassHeading)) heading = e.webkitCompassHeading; // iPhone
    else if (absolute) {
      // phone lying flat: the camera looks at the ground, so use the top edge of the phone instead
      heading = Math.abs(elev) > 65 ? G.wrap360(Math.atan2(-sA * cB, cA * cB) * R2D) : G.wrap360(Math.atan2(E, N) * R2D);
    }
    const now = performance.now();
    lastEvent = now;
    samples.push({ t: now, heading, elev });
    while (samples.length && now - samples[0].t > 3000) samples.shift();
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
    if ('ondeviceorientationabsolute' in window) {
      window.addEventListener('deviceorientationabsolute', (e) => onOrientation(e, true));
    } else {
      window.addEventListener('deviceorientation', (e) => onOrientation(e, e.absolute === true));
    }
    window.addEventListener('devicemotion', onMotion);
    started = true;
    return true;
  }

  function alive() { return started && performance.now() - lastEvent < 1500; }

  function current() {
    const s = samples[samples.length - 1];
    return s ? { heading: s.heading, elev: s.elev } : null;
  }

  // Average of the last `ms` milliseconds; spread tells how steady the hand was
  function average(ms) {
    const now = performance.now(), win = samples.filter((s) => now - s.t <= ms);
    if (!win.length) return null;
    let sx = 0, sy = 0, nh = 0, se = 0;
    for (const s of win) {
      se += s.elev;
      if (s.heading != null) { sx += Math.sin(s.heading * D2R); sy += Math.cos(s.heading * D2R); nh++; }
    }
    const elev = se / win.length;
    const elevSpread = Math.sqrt(win.reduce((a, s) => a + (s.elev - elev) ** 2, 0) / win.length);
    let heading = null, headSpread = null;
    if (nh) {
      heading = G.wrap360(Math.atan2(sx, sy) * R2D);
      const Rlen = Math.min(1, Math.hypot(sx, sy) / nh);
      headSpread = Math.sqrt(-2 * Math.log(Math.max(1e-9, Rlen))) * R2D;
    }
    return { heading, elev, headSpread, elevSpread, n: win.length };
  }

  function setSteps(on, cb) { stepOn = on; stepCb = cb; }

  return { start, alive, current, average, setSteps };
})();
