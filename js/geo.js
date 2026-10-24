/* Alibi - geodesy helpers. Angles in degrees, distances in metres. */
window.Alibi = window.Alibi || {};

Alibi.geo = (function () {
  'use strict';

  const R = 6371008.8;              // mean Earth radius (m)
  const D2R = Math.PI / 180;
  const R2D = 180 / Math.PI;
  const M_PER_DEG = R * D2R;        // metres per degree of latitude (spherical Earth)

  function wrap360(a) { return ((a % 360) + 360) % 360; }
  function wrap180(a) { return wrap360(a + 180) - 180; }

  // Great-circle distance (haversine)
  function dist(lat1, lon1, lat2, lon2) {
    const p1 = lat1 * D2R, p2 = lat2 * D2R;
    const dp = p2 - p1, dl = (lon2 - lon1) * D2R;
    const h = Math.sin(dp / 2) ** 2 + Math.cos(p1) * Math.cos(p2) * Math.sin(dl / 2) ** 2;
    return 2 * R * Math.asin(Math.min(1, Math.sqrt(h)));
  }

  // Compass bearing from point 1 towards point 2 (0 = north, 90 = east)
  function bearing(lat1, lon1, lat2, lon2) {
    const p1 = lat1 * D2R, p2 = lat2 * D2R, dl = (lon2 - lon1) * D2R;
    const y = Math.sin(dl) * Math.cos(p2);
    const x = Math.cos(p1) * Math.sin(p2) - Math.sin(p1) * Math.cos(p2) * Math.cos(dl);
    return wrap360(Math.atan2(y, x) * R2D);
  }

  // Point reached after travelling d metres from (lat, lon) on bearing brg
  function dest(lat, lon, brg, d) {
    const p1 = lat * D2R, l1 = lon * D2R, t = brg * D2R, a = d / R;
    const p2 = Math.asin(Math.sin(p1) * Math.cos(a) + Math.cos(p1) * Math.sin(a) * Math.cos(t));
    const l2 = l1 + Math.atan2(Math.sin(t) * Math.sin(a) * Math.cos(p1), Math.cos(a) - Math.sin(p1) * Math.sin(p2));
    return { lat: p2 * R2D, lon: wrap180(l2 * R2D) };
  }

  // Shift a point by a small east/north offset in metres
  function offset(lat, lon, dE, dN) {
    return { lat: lat + dN / M_PER_DEG, lon: lon + dE / (M_PER_DEG * Math.cos(lat * D2R)) };
  }

  // Web Mercator helpers (the map is drawn in this projection)
  function mercY(lat) { return Math.log(Math.tan(Math.PI / 4 + Math.max(-85, Math.min(85, lat)) * D2R / 2)); }
  function invMercY(y) { return (2 * Math.atan(Math.exp(y)) - Math.PI / 2) * R2D; }

  // Magnetic declination in Finland: a linear fit of the World Magnetic Model (WMM2025)
  // for late 2026. Within about ±0.1° in most of Finland, but up to ~0.9° off in the far north-west
  // (Kilpisjärvi); outside Finland use the manual compass correction.
  function declination(lat, lon) { return 12.577 + 0.4644 * (lat - 64) + 0.3781 * (lon - 26); }
  function inFinland(lat, lon) { return lat > 59.5 && lat < 70.2 && lon > 19 && lon < 31.7; }

  function fmtDist(m) {
    if (m < 1000) return Math.round(m) + ' m';
    if (m < 10000) return (m / 1000).toFixed(1) + ' km';
    return Math.round(m / 1000) + ' km';
  }

  function compass8(b) { return ['N', 'NE', 'E', 'SE', 'S', 'SW', 'W', 'NW'][Math.round(wrap360(b) / 45) % 8]; }

  return { R, D2R, R2D, M_PER_DEG, wrap360, wrap180, dist, bearing, dest, offset, mercY, invMercY,
    declination, inFinland, fmtDist, compass8 };
})();
