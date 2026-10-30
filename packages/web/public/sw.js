// Minimal offline shell + notification click routing. The app is live-data
// first, so we only cache the built shell and let everything else hit network.
const CACHE = 'dither-shell-v1';
const SHELL = ['/', '/index.html'];
self.addEventListener('install', (e) => {
  e.waitUntil(caches.open(CACHE).then((c) => c.addAll(SHELL)).then(() => self.skipWaiting()));
});
self.addEventListener('activate', (e) => {
  e.waitUntil(caches.keys().then((ks) => Promise.all(ks.filter((k) => k !== CACHE).map((k) => caches.delete(k)))).then(() => self.clients.claim()));
});
self.addEventListener('fetch', (e) => {
  const url = new URL(e.request.url);
  if (e.request.mode === 'navigate') {
    e.respondWith(fetch(e.request).catch(() => caches.match('/index.html')));
    return;
  }
  if (url.pathname.startsWith('/api/') || url.pathname.startsWith('/media/')) return;
  e.respondWith(caches.match(e.request).then((hit) => hit || fetch(e.request)));
});
self.addEventListener('notificationclick', (e) => {
  e.notification.close();
  const conv = e.notification.data && e.notification.data.conversationId;
  const target = conv ? `/#/inbox/c/${conv}` : '/';
  e.waitUntil(
    self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then((cs) => {
      for (const c of cs) if ('focus' in c) { c.navigate(target); return c.focus(); }
      return self.clients.openWindow(target);
    }),
  );
});
