// bump CACHE when deploying
const CACHE = 'kokuin-v4';
const SHELL = [
  './', './index.html', './styles.css', './manifest.webmanifest',
  './js/app.js', './js/db.js', './js/dict.js', './js/tts.js', './js/fsrs.js', './js/handwriting.js',
  './js/decklib.js', './js/sync.js', './js/hangul.js', './js/speech.js',
  './icons/icon-192.png', './icons/icon-512.png', './icons/icon-512-maskable.png', './icons/icon-180.png',
];
// decks are cached separately so a missing file doesn't break install
const DECKS = [
  './data/decks/index.json', './data/decks/topik1.json', './data/decks/topik2.json',
  './data/decks/topik3.json', './data/decks/daily.json', './data/decks/travel.json',
];

self.addEventListener('install', (e) => {
  e.waitUntil(caches.open(CACHE).then(async (c) => {
    await c.addAll(SHELL);
    await Promise.allSettled(DECKS.map((u) => c.add(u)));
  }).then(() => self.skipWaiting()));
});

self.addEventListener('activate', (e) => {
  e.waitUntil(
    caches.keys().then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', (e) => {
  const { request } = e;
  if (request.method !== 'GET') return;
  const url = new URL(request.url);

  // never cache the sync API
  if (url.origin === location.origin && url.pathname.includes('/api/')) return;

  // same origin: cache first, update in background
  if (url.origin === location.origin) {
    e.respondWith(
      caches.match(request).then((cached) => {
        const net = fetch(request).then((res) => {
          if (res && res.ok) caches.open(CACHE).then((c) => c.put(request, res.clone()));
          return res;
        }).catch(() => cached || (request.mode === 'navigate' ? caches.match('./index.html') : undefined));
        return cached || net;
      })
    );
    return;
  }

  // cross origin (dictionary, audio): network first, cache as fallback
  e.respondWith(
    fetch(request).then((res) => {
      // audio responses are opaque (no-cors), cache them too
      if (res && (res.ok || res.type === 'opaque') && /\.(mp3|ogg|wav)$/i.test(url.pathname)) {
        caches.open(CACHE).then((c) => c.put(request, res.clone()));
      }
      return res;
    }).catch(() => caches.match(request))
  );
});
