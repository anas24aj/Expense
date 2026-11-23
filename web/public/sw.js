// Offline shell only. Never caches /api or /mcp: household money data stays live and off the device cache.
const SHELL = 'ledger-shell-v4';
self.addEventListener('install', e => {
  e.waitUntil(caches.open(SHELL).then(c => c.addAll(['/', '/manifest.webmanifest', '/icon.svg', '/icon-192.png', '/apple-touch-icon.png'])));
  self.skipWaiting();
});
self.addEventListener('activate', e => {
  e.waitUntil(caches.keys().then(ks => Promise.all(ks.filter(k => k !== SHELL).map(k => caches.delete(k)))).then(() => self.clients.claim()));
});
self.addEventListener('fetch', e => {
  const req = e.request, url = new URL(req.url);
  if (req.method !== 'GET' || url.origin !== location.origin || /^\/(api|mcp)(\/|$)/.test(url.pathname)) return;
  const put = res => { if (res.ok) { const c = res.clone(); caches.open(SHELL).then(s => s.put(req, c)); } return res; };
  if (url.pathname.startsWith('/assets/')) e.respondWith(caches.match(req).then(hit => hit || fetch(req).then(put)));  // hashed, immutable
  else if (req.mode === 'navigate') e.respondWith(fetch(req).then(put).catch(() => caches.match('/')));
  else e.respondWith(fetch(req).then(put).catch(() => caches.match(req)));
});
