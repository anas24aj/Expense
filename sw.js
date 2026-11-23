// Install + offline shell. Static files: cache first. Pages and /api: network first, the last good copy when offline.
// Personal data sits only in DATA, which the sign-in page empties so the next person never sees it.
const STATIC = 'expense-static-v1', DATA = 'expense-data';
const STATIC_PATHS = ['/manifest.webmanifest', '/icon-192.png', '/icon-512.png'];
const NEVER = /^\/(sms|mcp|admin|api\/admin|api\/devices|logout|login|signup|forgot|reset|sw\.js)/;  // live only, never stored

self.addEventListener('install', e => {
  e.waitUntil(caches.open(STATIC).then(c => c.addAll(STATIC_PATHS)));
  self.skipWaiting();
});
self.addEventListener('activate', e => {
  e.waitUntil(caches.keys().then(keys => Promise.all(keys.filter(k => k !== STATIC && k !== DATA).map(k => caches.delete(k))))
    .then(() => self.clients.claim()));
});
self.addEventListener('fetch', e => {
  const req = e.request, url = new URL(req.url);
  if (req.method !== 'GET' || url.origin !== location.origin || NEVER.test(url.pathname)) return;
  const keep = name => res => {
    if (res.ok && !res.redirected) { const copy = res.clone(); caches.open(name).then(c => c.put(req, copy)); }
    return res;
  };
  if (STATIC_PATHS.includes(url.pathname)) {
    e.respondWith(caches.match(req).then(hit => hit || fetch(req).then(keep(STATIC))));
  } else {
    e.respondWith(fetch(req).then(keep(DATA)).catch(() => caches.match(req).then(hit => hit || Response.error())));
  }
});
