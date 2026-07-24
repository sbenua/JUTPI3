const SW_VERSION = 'v1';
const CACHE_PREFIX = 'jutpi3-pwa';
const STATIC_CACHE = `${CACHE_PREFIX}-static-${SW_VERSION}`;
const TILE_CACHE = `${CACHE_PREFIX}-tiles-${SW_VERSION}`;
const APP_SHELL = [
  './',
  './index.html',
  './manifest.json',
  './icon-192.svg',
  './icon-512.svg'
];
const OSM_TILE_RE = /^https:\/\/[abc]\.tile\.openstreetmap\.org\/(\d+)\/(\d+)\/(\d+)\.png/;
const CARTO_POSITRON_RE = /^https:\/\/[abcd]\.basemaps\.cartocdn\.com\/light_all\/(\d+)\/(\d+)\/(\d+)(@2x)?\.png/;
function matchTile(url) {
  let m = OSM_TILE_RE.exec(url);
  if (m) return { layer: 'osm', z: +m[1], x: +m[2], y: +m[3] };
  m = CARTO_POSITRON_RE.exec(url);
  if (m) return { layer: 'carto-positron', z: +m[1], x: +m[2], y: +m[3] };
  return null;
}
const OSM_SUBDOMAINS = ['a', 'b', 'c'];
const CARTO_SUBDOMAINS = ['a', 'b', 'c', 'd'];
function osmTileUrl(z, x, y) {
  const s = OSM_SUBDOMAINS[(x + y) % OSM_SUBDOMAINS.length];
  return `https://${s}.tile.openstreetmap.org/${z}/${x}/${y}.png`;
}
function cartoTileUrl(z, x, y) {
  const s = CARTO_SUBDOMAINS[(x + y) % CARTO_SUBDOMAINS.length];
  return `https://${s}.basemaps.cartocdn.com/light_all/${z}/${x}/${y}.png`;
}
const BBOX = { minLon: 106.171875, minLat: -6.755945, maxLon: 107.248535, maxLat: -5.926548 };
const PRECACHE_MIN_ZOOM = 8;
const PRECACHE_MAX_ZOOM = 13;
const TILE_CACHE_LIMIT = 20000;
function long2tile(lon, z) {
  return Math.floor(((lon + 180) / 360) * Math.pow(2, z));
}
function lat2tile(lat, z) {
  const rad = (lat * Math.PI) / 180;
  return Math.floor(
    ((1 - Math.log(Math.tan(rad) + 1 / Math.cos(rad)) / Math.PI) / 2) * Math.pow(2, z)
  );
}
function* tilesForBBoxZoom(bbox, z) {
  const xMin = long2tile(bbox.minLon, z);
  const xMax = long2tile(bbox.maxLon, z);
  const yMin = lat2tile(bbox.maxLat, z); // maxLat -> smaller tile y
  const yMax = lat2tile(bbox.minLat, z);
  for (let x = Math.min(xMin, xMax); x <= Math.max(xMin, xMax); x++) {
    for (let y = Math.min(yMin, yMax); y <= Math.max(yMin, yMax); y++) {
      yield { z, x, y };
    }
  }
}
function buildPrecacheList() {
  const list = [];
  for (let z = PRECACHE_MIN_ZOOM; z <= PRECACHE_MAX_ZOOM; z++) {
    for (const t of tilesForBBoxZoom(BBOX, z)) {
      list.push({ url: osmTileUrl(t.z, t.x, t.y), layer: 'osm', ...t });
      list.push({ url: cartoTileUrl(t.z, t.x, t.y), layer: 'carto-positron', ...t });
    }
  }
  return list;
}
async function broadcast(msg) {
  const clientsList = await self.clients.matchAll({ includeUncontrolled: true });
  for (const client of clientsList) {
    try {
      client.postMessage(msg);
    } catch (e) {
    }
  }
}
self.addEventListener('install', (event) => {
  event.waitUntil(
    (async () => {
      try {
        const cache = await caches.open(STATIC_CACHE);
        await cache.addAll(APP_SHELL);
      } catch (err) {
        console.error('[SW] app shell precache failed:', err);
      }
      self.skipWaiting();
    })()
  );
});
self.addEventListener('activate', (event) => {
  event.waitUntil(
    (async () => {
      const keys = await caches.keys();
      await Promise.all(
        keys
          .filter((k) => k.startsWith(CACHE_PREFIX) && k !== STATIC_CACHE && k !== TILE_CACHE)
          .map((k) => caches.delete(k))
      );
      await self.clients.claim();
      precacheTiles().catch((err) => console.error('[SW] tile precache error:', err));
    })()
  );
});
let precacheInFlight = false;
async function precacheTiles() {
  if (precacheInFlight) return;
  precacheInFlight = true;
  try {
    const list = buildPrecacheList();
    const total = list.length;
    let done = 0;
    let failed = 0;
    const cache = await caches.open(TILE_CACHE);
    const CONCURRENCY = 6;
    let idx = 0;
    async function worker() {
      while (idx < list.length) {
        const item = list[idx++];
        try {
          const existing = await cache.match(item.url);
          if (!existing) {
            const resp = await fetchWithTimeout(item.url, 15000);
            if (resp && resp.ok) {
              await safeCachePut(cache, item.url, resp.clone());
            } else {
              failed++;
            }
          }
        } catch (err) {
          failed++;
        }
        done++;
        if (done % 25 === 0 || done === total) {
          broadcast({
            type: 'PRECACHE_PROGRESS',
            done,
            total,
            failed,
            percent: Math.round((done / total) * 100)
          });
        }
      }
    }
    await Promise.all(Array.from({ length: CONCURRENCY }, worker));
    broadcast({ type: 'PRECACHE_COMPLETE', total, failed });
  } finally {
    precacheInFlight = false;
  }
}
function fetchWithTimeout(url, ms) {
  return new Promise((resolve, reject) => {
    const controller = new AbortController();
    const timer = setTimeout(() => {
      controller.abort();
      reject(new Error('timeout'));
    }, ms);
    fetch(url, { signal: controller.signal, mode: 'cors' })
      .then((resp) => {
        clearTimeout(timer);
        resolve(resp);
      })
      .catch((err) => {
        clearTimeout(timer);
        reject(err);
      });
  });
}
async function safeCachePut(cache, url, response) {
  try {
    await cache.put(url, response);
    await maybeEvict(cache);
  } catch (err) {
    if (err && (err.name === 'QuotaExceededError' || /quota/i.test(String(err)))) {
      console.warn('[SW] storage quota hit, evicting oldest tiles');
      await evictOldest(cache, Math.ceil(TILE_CACHE_LIMIT * 0.1));
      try {
        await cache.put(url, response);
      } catch (err2) {
        console.error('[SW] cache.put failed even after eviction:', err2);
      }
    } else {
      console.error('[SW] cache.put failed:', err);
    }
  }
}
async function maybeEvict(cache) {
  const keys = await cache.keys();
  if (keys.length > TILE_CACHE_LIMIT) {
    await evictOldest(cache, keys.length - TILE_CACHE_LIMIT);
  }
}
async function evictOldest(cache, count) {
  const keys = await cache.keys();
  const toDelete = keys.slice(0, Math.max(0, count));
  await Promise.all(toDelete.map((req) => cache.delete(req)));
}
const BLANK_TILE_BASE64 =
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=';
function blankTileResponse() {
  const bytes = Uint8Array.from(atob(BLANK_TILE_BASE64), (c) => c.charCodeAt(0));
  return new Response(bytes, {
    status: 200,
    headers: { 'Content-Type': 'image/png', 'X-Served-By': 'sw-fallback' }
  });
}
self.addEventListener('fetch', (event) => {
  const { request } = event;
  if (request.method !== 'GET') return;
  const url = request.url;
  const tile = matchTile(url);
  if (tile) {
    event.respondWith(handleTileRequest(request));
    return;
  }
  if (request.mode === 'navigate') {
    event.respondWith(handleNavigationRequest(request));
    return;
  }
  if (url.startsWith(self.location.origin)) {
    event.respondWith(handleStaticRequest(request));
    return;
  }
  event.respondWith(
    fetch(request).catch(async () => {
      const cached = await caches.match(request);
      return cached || new Response('', { status: 504, statusText: 'Offline' });
    })
  );
});
async function handleTileRequest(request) {
  const cache = await caches.open(TILE_CACHE);
  try {
    const cached = await cache.match(request);
    if (cached) return cached;
    const response = await fetchWithTimeout(request.url, 10000);
    if (response && response.ok) {
      await safeCachePut(cache, request.url, response.clone());
      return response;
    }
    return blankTileResponse();
  } catch (err) {
    return blankTileResponse();
  }
}
async function handleNavigationRequest(request) {
  try {
    const response = await fetchWithTimeout(request.url, 8000);
    if (response && response.ok) {
      const cache = await caches.open(STATIC_CACHE);
      await safeCachePut(cache, './index.html', response.clone());
      return response;
    }
    throw new Error('bad navigation response');
  } catch (err) {
    const cache = await caches.open(STATIC_CACHE);
    const cached = (await cache.match('./index.html')) || (await cache.match('./'));
    if (cached) return cached;
    return new Response(
      '<h1>Offline</h1><p>This page has not been cached yet. Reconnect once to enable offline mode.</p>',
      { status: 200, headers: { 'Content-Type': 'text/html' } }
    );
  }
}
async function handleStaticRequest(request) {
  const cache = await caches.open(STATIC_CACHE);
  try {
    const cached = await cache.match(request);
    if (cached) return cached;
    const response = await fetchWithTimeout(request.url, 10000);
    if (response && response.ok) {
      await safeCachePut(cache, request.url, response.clone());
    }
    return response;
  } catch (err) {
    const cached = await cache.match(request);
    if (cached) return cached;
    return new Response('', { status: 504, statusText: 'Offline' });
  }
}
self.addEventListener('message', (event) => {
  const data = event.data || {};
  if (data.type === 'SKIP_WAITING') {
    self.skipWaiting();
  } else if (data.type === 'START_PRECACHE') {
    precacheTiles().catch((err) => console.error('[SW] manual precache error:', err));
  } else if (data.type === 'GET_CACHE_STATUS') {
    (async () => {
      try {
        const tileCache = await caches.open(TILE_CACHE);
        const keys = await tileCache.keys();
        const total = buildPrecacheList().length;
        event.source && event.source.postMessage({
          type: 'CACHE_STATUS',
          tilesCached: keys.length,
          precacheTarget: total
        });
      } catch (err) {
        event.source && event.source.postMessage({ type: 'CACHE_STATUS', error: String(err) });
      }
    })();
  }
});
