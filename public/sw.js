/* Hushchats service worker: makes the app installable, keeps the shell available offline,
   and shows message notifications (Android Chrome only allows them through a service worker). */
const CACHE = 'hushchats-shell-v2';
const SHELL = ['/', '/icon-192.png'];
self.addEventListener('install', e => { e.waitUntil(caches.open(CACHE).then(c => c.addAll(SHELL)).catch(() => {})); self.skipWaiting(); });
self.addEventListener('activate', e => { e.waitUntil(caches.keys().then(ks => Promise.all(ks.filter(k => k !== CACHE).map(k => caches.delete(k)))).then(() => self.clients.claim())); });
self.addEventListener('fetch', e => {
  const r = e.request, u = new URL(r.url);
  if (r.method !== 'GET' || u.origin !== location.origin || u.pathname.startsWith('/api/') || u.pathname === '/ws' || u.pathname.endsWith('.apk')) return;
  if (r.mode === 'navigate') {   // always try the network first so updates arrive; fall back to the cached shell when offline
    e.respondWith(fetch(r).then(res => { const c = res.clone(); caches.open(CACHE).then(ch => ch.put('/', c)); return res; }).catch(() => caches.match('/')));
  }
});
self.addEventListener('notificationclick', e => {
  e.notification.close();
  const peer = e.notification.data && e.notification.data.peer;
  e.waitUntil(self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then(list => {
    const w = list.find(c => 'focus' in c);
    if (w) { if (peer) w.postMessage({ type: 'open-chat', peer }); return w.focus(); }
    return self.clients.openWindow('/');
  }));
});
