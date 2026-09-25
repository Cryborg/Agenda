// Service worker : l'appli s'ouvre hors ligne. Stratégie "réseau d'abord" pour
// les fichiers de l'appli (une mise à jour est visible au prochain
// chargement), cache en secours. Les appels Google ne sont jamais interceptés.

const CACHE = 'agenda-v2';
const SHELL = [
  './',
  'index.html',
  'css/styles.css',
  'js/app.js',
  'js/dates.js',
  'js/layout.js',
  'js/recur.js',
  'js/colors.js',
  'js/icons.js',
  'js/people.js',
  'js/store-local.js',
  'js/store-google.js',
  'manifest.webmanifest',
  'icons/icon.svg',
  'icons/favicon.svg',
];

self.addEventListener('install', (e) => {
  e.waitUntil(caches.open(CACHE).then((c) => c.addAll(SHELL)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', (e) => {
  e.waitUntil(
    caches
      .keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim()),
  );
});

self.addEventListener('fetch', (e) => {
  const url = new URL(e.request.url);
  if (e.request.method !== 'GET' || url.origin !== location.origin) return;
  e.respondWith(
    fetch(e.request)
      .then((res) => {
        if (res.ok) {
          const copy = res.clone();
          caches.open(CACHE).then((c) => c.put(e.request, copy));
        }
        return res;
      })
      .catch(() => caches.match(e.request, { ignoreSearch: true }).then((r) => r || caches.match('index.html'))),
  );
});
