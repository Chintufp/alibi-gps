/* Alibi - where the Sun and bright stars are, for any place and time.
   A measured height above the horizon gives a ring on Earth where that height is true. */
Alibi.sky = (function () {
  'use strict';

  const G = Alibi.geo;
  const D2R = Math.PI / 180, R2D = 180 / Math.PI;
  const hms = (h, m, s) => (h + m / 60 + s / 3600) * 15;
  const dms = (d, m, s) => (d < 0 ? -1 : 1) * (Math.abs(d) + m / 60 + s / 3600);

  // Bright stars that are easy to find from Finland (J2000 coordinates)
  const STARS = [
    { id: 'polaris', name: 'Polaris (North Star)', ra: hms(2, 31, 49.09), dec: dms(89, 15, 50.8), mag: 2.0 },
    { id: 'vega', name: 'Vega', ra: hms(18, 36, 56.34), dec: dms(38, 47, 1.3), mag: 0.0 },
    { id: 'capella', name: 'Capella', ra: hms(5, 16, 41.36), dec: dms(45, 59, 52.8), mag: 0.1 },
    { id: 'arcturus', name: 'Arcturus', ra: hms(14, 15, 39.67), dec: dms(19, 10, 56.7), mag: -0.05 },
    { id: 'deneb', name: 'Deneb', ra: hms(20, 41, 25.9), dec: dms(45, 16, 49), mag: 1.25 },
    { id: 'altair', name: 'Altair', ra: hms(19, 50, 47.0), dec: dms(8, 52, 6), mag: 0.77 },
    { id: 'aldebaran', name: 'Aldebaran', ra: hms(4, 35, 55.24), dec: dms(16, 30, 33.5), mag: 0.85 },
    { id: 'betelgeuse', name: 'Betelgeuse', ra: hms(5, 55, 10.31), dec: dms(7, 24, 25.4), mag: 0.5 },
    { id: 'rigel', name: 'Rigel', ra: hms(5, 14, 32.27), dec: dms(-8, 12, 5.9), mag: 0.13 },
    { id: 'sirius', name: 'Sirius', ra: hms(6, 45, 8.92), dec: dms(-16, 42, 58.0), mag: -1.46 },
    { id: 'pollux', name: 'Pollux', ra: hms(7, 45, 18.95), dec: dms(28, 1, 34.3), mag: 1.14 },
    { id: 'dubhe', name: 'Dubhe (Big Dipper)', ra: hms(11, 3, 43.67), dec: dms(61, 45, 3.7), mag: 1.8 },
    { id: 'regulus', name: 'Regulus', ra: hms(10, 8, 22.31), dec: dms(11, 58, 2.0), mag: 1.35 },
    { id: 'spica', name: 'Spica', ra: hms(13, 25, 11.58), dec: dms(-11, 9, 40.8), mag: 0.97 },
  ];

  const jd = (date) => date.getTime() / 86400000 + 2440587.5;

  // Greenwich mean sidereal time (degrees)
  function gmst(date) {
    const d = jd(date) - 2451545.0, T = d / 36525;
    return G.wrap360(280.46061837 + 360.98564736629 * d + 0.000387933 * T * T - T * T * T / 38710000);
  }

  // Precession from J2000 to the date (IAU 1976), degrees in and out
  function precess(ra, dec, date) {
    const T = (jd(date) - 2451545.0) / 36525, as = D2R / 3600;
    const zeta = (2306.2181 * T + 0.30188 * T * T + 0.017998 * T * T * T) * as;
    const z = (2306.2181 * T + 1.09468 * T * T + 0.018203 * T * T * T) * as;
    const th = (2004.3109 * T - 0.42665 * T * T - 0.041833 * T * T * T) * as;
    const a0 = ra * D2R, d0 = dec * D2R;
    const A = Math.cos(d0) * Math.sin(a0 + zeta);
    const B = Math.cos(th) * Math.cos(d0) * Math.cos(a0 + zeta) - Math.sin(th) * Math.sin(d0);
    const C = Math.sin(th) * Math.cos(d0) * Math.cos(a0 + zeta) + Math.cos(th) * Math.sin(d0);
    return { ra: G.wrap360((Math.atan2(A, B) + z) * R2D), dec: Math.asin(C) * R2D };
  }

  // Sun position (low-precision almanac formula, good to ~0.01°)
  function sun(date) {
    const n = jd(date) - 2451545.0;
    const L = G.wrap360(280.460 + 0.9856474 * n);
    const g = G.wrap360(357.528 + 0.9856003 * n) * D2R;
    const lam = (L + 1.915 * Math.sin(g) + 0.020 * Math.sin(2 * g)) * D2R;
    const eps = (23.439 - 0.0000004 * n) * D2R;
    return {
      ra: G.wrap360(Math.atan2(Math.cos(eps) * Math.sin(lam), Math.cos(lam)) * R2D),
      dec: Math.asin(Math.sin(eps) * Math.sin(lam)) * R2D,
    };
  }

  function star(id) { return STARS.find((s) => s.id === id); }
  function name(id) { return id === 'sun' ? 'Sun' : star(id).name; }

  function radec(id, date) {
    if (id === 'sun') return sun(date);
    const s = star(id);
    return precess(s.ra, s.dec, date);
  }

  // True altitude and azimuth of a body seen from (lat, lon)
  function altAz(ra, dec, lat, lon, date) {
    const H = (gmst(date) + lon - ra) * D2R, p = lat * D2R, d = dec * D2R;
    const alt = Math.asin(Math.sin(p) * Math.sin(d) + Math.cos(p) * Math.cos(d) * Math.cos(H)) * R2D;
    const az = G.wrap360(Math.atan2(-Math.sin(H) * Math.cos(d),
      Math.cos(p) * Math.sin(d) - Math.sin(p) * Math.cos(d) * Math.cos(H)) * R2D);
    return { alt, az };
  }

  // Atmospheric refraction (Bennett) for an apparent altitude, in degrees
  function refraction(app) {
    if (app < -1) return 0;
    return 1 / Math.tan((app + 7.31 / (app + 4.4)) * D2R) / 60;
  }

  // The point on Earth where the body is straight overhead
  function groundPoint(id, date) {
    const p = radec(id, date);
    return { lat: p.dec, lon: G.wrap180(p.ra - gmst(date)) };
  }

  // Bodies you could aim at right now from (lat, lon)
  function visible(lat, lon, date) {
    const out = [];
    const s = sun(date), sa = altAz(s.ra, s.dec, lat, lon, date);
    if (sa.alt > 2) out.push({ id: 'sun', name: 'Sun', alt: sa.alt, az: sa.az, mag: -26 });
    if (sa.alt < -6) {
      for (const st of STARS) {
        const p = precess(st.ra, st.dec, date), a = altAz(p.ra, p.dec, lat, lon, date);
        if (a.alt > 10) out.push({ id: st.id, name: st.name, alt: a.alt, az: a.az, mag: st.mag });
      }
    }
    return out.sort((a, b) => a.mag - b.mag);
  }

  return { STARS, gmst, radec, altAz, refraction, groundPoint, visible, name };
})();
