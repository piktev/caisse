/*
 * Service worker : met l'application en cache pour qu'elle s'ouvre sans Internet.
 * Il ne touche PAS aux données (ventes…), qui sont dans IndexedDB.
 *
 * Lors d'une mise à jour des fichiers de l'application, changer VERSION pour que
 * les appareils téléchargent la nouvelle version (au lancement suivant).
 */
const VERSION = 'caisse-v2';
const FILES = [
  './',
  './index.html',
  './css/style.css',
  './js/logic.js',
  './js/catalogue.js',
  './js/xlsx.js',
  './js/db.js',
  './js/app.js',
  './manifest.webmanifest',
  './icons/icon-192.png',
  './icons/icon-512.png',
  './icons/apple-touch-icon.png'
];

self.addEventListener('install', e => {
  e.waitUntil(caches.open(VERSION).then(c => c.addAll(FILES)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', e => {
  e.waitUntil(
    caches.keys()
      .then(keys => Promise.all(keys.filter(k => k !== VERSION).map(k => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

// Cache d'abord : l'application démarre instantanément, avec ou sans réseau.
self.addEventListener('fetch', e => {
  const req = e.request;
  if (req.method !== 'GET' || new URL(req.url).origin !== location.origin) return;
  e.respondWith(
    caches.match(req, { ignoreSearch: true }).then(hit => {
      if (hit) return hit;
      if (req.mode === 'navigate') return caches.match('./index.html').then(r => r || fetch(req));
      return fetch(req);
    })
  );
});
