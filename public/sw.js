/* Twogether service worker: makes the app installable, keeps the shell available offline,
   and shows message notifications (Android Chrome only allows them through a service worker). */
const CACHE = 'twogether-shell-v3';
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
/* Web Push: fires even with every tab and this worker itself freshly woken from being fully killed —
   this is the one thing a WebSocket alone can never do (a dead process has no socket to push to).
   Payload is deliberately content-free ({t:'msg', from, ts}) — the server encrypts it so even the
   push relay (FCM/Mozilla) never sees this much, and we only use it to know whose name to show. */
self.addEventListener('push', e => {
  e.waitUntil((async () => {
    let d = {}; try { d = e.data ? e.data.json() : {}; } catch {}
    if (d.t !== 'msg' || !d.from) return;
    let name = d.from;
    try {   // best-effort: show their saved name instead of the raw ID, if we have it on this device
      const db = await new Promise((res, rej) => { const r = indexedDB.open('hushline', 2); r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error); });
      const fr = await new Promise((res, rej) => { const rq = db.transaction('friends', 'readonly').objectStore('friends').get(d.from); rq.onsuccess = () => res(rq.result); rq.onerror = () => rej(rq.error); });
      if (fr && (fr.name || fr.theirName)) name = fr.name || fr.theirName;
      db.close();
    } catch {}
    await self.registration.showNotification(name, { body: 'New message', tag: 'msg-' + d.from, renotify: true, icon: 'icon-192.png', badge: 'icon-192.png', data: { peer: d.from } });
  })());
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
