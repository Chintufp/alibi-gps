/* Alibi service worker: keeps the app on the phone so it also opens without a network, plus the map
   pictures you have already looked at. App files are always fetched fresh when there is a network, so
   updates show up straight away. Map pictures are only kept as you view them, never downloaded in bulk
   (the free OpenStreetMap tile servers forbid that). */
const SHELL_CACHE = 'alibi-shell-v4';
const TILE_CACHE = 'alibi-tiles-v1';
const MAX_TILES = 2500;
const SHELL = [
  './', './index.html', './css/style.css',
  './js/geo.js', './js/sky.js', './js/engine.js', './js/osm.js', './js/sensors.js',
  './js/scenario-data.js', './js/landmark-data.js', './js/scenario.js', './js/replay.js', './js/app.js',
  './data/train.json', './data/car.json',
  'https://unpkg.com/leaflet@1.9.4/dist/leaflet.css',
  'https://unpkg.com/leaflet@1.9.4/dist/leaflet.js',
  'https://cdnjs.cloudflare.com/ajax/libs/font-awesome/6.7.2/css/all.min.css',
  'https://cdnjs.cloudflare.com/ajax/libs/font-awesome/6.7.2/webfonts/fa-solid-900.woff2',
];

self.addEventListener('install', (e) => {
  e.waitUntil(caches.open(SHELL_CACHE).then((c) => c.addAll(SHELL)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', (e) => {
  e.waitUntil(caches.keys()
    .then((keys) => Promise.all(keys.filter((k) => k !== SHELL_CACHE && k !== TILE_CACHE).map((k) => caches.delete(k))))
    .then(() => self.clients.claim()));
});

const isTile = (url) => /(^|\.)tile\.openstreetmap\.org$|(^|\.)tile\.opentopomap\.org$/.test(url.hostname);

self.addEventListener('fetch', (e) => {
  const req = e.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);
  if (isTile(url)) e.respondWith(tile(req));
  else if (url.origin === self.location.origin || url.hostname === 'unpkg.com' || url.hostname === 'cdnjs.cloudflare.com') e.respondWith(networkFirst(req));
});

async function networkFirst(req) {
  const cache = await caches.open(SHELL_CACHE);
  try {
    // 'no-cache' asks the server whether the browser's copy is still current, so updates are never missed
    // (a page navigation can't be re-made with options, so fetch its address instead)
    const res = await fetch(req.mode === 'navigate' ? req.url : req, { cache: 'no-cache' });
    if (res.ok) cache.put(req, res.clone());
    return res;
  } catch (err) {
    const hit = await cache.match(req, { ignoreSearch: true });
    if (hit) return hit;
    throw err;
  }
}

async function tile(req) {
  const cache = await caches.open(TILE_CACHE);
  const hit = await cache.match(req);
  if (hit) return hit;
  const res = await fetch(req);
  if (res.ok) { cache.put(req, res.clone()); trim(cache); }
  return res;
}

let trimming = false;
async function trim(cache) {
  if (trimming) return;
  trimming = true;
  const keys = await cache.keys();
  for (let i = 0; i < keys.length - MAX_TILES; i++) await cache.delete(keys[i]);
  trimming = false;
}
