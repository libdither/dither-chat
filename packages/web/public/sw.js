// Offline shell, updates and push. The app is live-data first: only the shell and static files
// are cached, and each build gets its own cache. The build fills in the two placeholders (vite.config.ts).
const BUILD = '__BUILD__';
const PRECACHE = '__PRECACHE__';
const CACHE = `dither-shell-${BUILD}`;

self.addEventListener('install', (e) => {
  const assets = PRECACHE.startsWith('[') ? JSON.parse(PRECACHE) : [];
  // Fetched fresh: an HTTP-cached index.html could name files from the previous build.
  e.waitUntil(caches.open(CACHE).then((c) => c.addAll(['/index.html', '/manifest.webmanifest', ...assets].map((u) => new Request(u, { cache: 'reload' })))));
  // No skipWaiting: the page asks for it (pwa.ts), since old pages may still load old chunks.
});
self.addEventListener('activate', (e) => {
  e.waitUntil(caches.keys().then((ks) => Promise.all(ks.filter((k) => k.startsWith('dither-shell-') && k !== CACHE).map((k) => caches.delete(k)))).then(() => self.clients.claim()));
});
self.addEventListener('message', (e) => {
  if (e.data === 'skipWaiting') self.skipWaiting();
});

self.addEventListener('fetch', (e) => {
  if (e.request.method !== 'GET') return;
  const url = new URL(e.request.url);
  if (url.origin !== location.origin) return;
  if (e.request.mode === 'navigate') {
    e.respondWith(
      fetch(e.request).catch(async () => (await caches.open(CACHE)).match('/index.html')),
    );
    return;
  }
  const p = url.pathname;
  if (p.startsWith('/api/') || p.startsWith('/media/') || p.startsWith('/emoji/') || p === '/sw.js' || p === '/ca.crt') return;
  // Hashed files never change, so the cache is right whenever it has them. Anything else: network first.
  if (p.startsWith('/assets/')) {
    e.respondWith(
      caches.open(CACHE).then(async (c) => {
        const hit = await c.match(e.request);
        if (hit) return hit;
        const res = await fetch(e.request);
        if (res.ok) c.put(e.request, res.clone());
        return res;
      }),
    );
    return;
  }
  e.respondWith(
    caches.open(CACHE).then((c) =>
      fetch(e.request)
        .then((res) => {
          if (res.ok) c.put(e.request, res.clone());
          return res;
        })
        .catch(() => c.match(e.request).then((hit) => hit ?? Response.error())),
    ),
  );
});

self.addEventListener('push', (e) => {
  let d = {};
  try {
    d = e.data ? e.data.json() : {};
  } catch {}
  e.waitUntil(
    (async () => {
      const tag = d.conversationId ?? (d.inbox ? 'dither-digest' : 'dither');
      await self.registration.showNotification(d.title ?? 'dither-chat', {
        body: d.body ?? '',
        tag,
        renotify: true,
        icon: '/icon-192.png',
        badge: '/icon-192.png',
        data: { conversationId: d.conversationId, inbox: d.inbox, test: d.test },
        actions: d.conversationId ? [{ action: 'open', title: 'Open' }] : [],
      });
      // Always shown first: Safari revokes subscriptions that receive a push and show nothing.
      const clients = await self.clients.matchAll({ type: 'window' });
      const looking = clients.some((c) => c.focused && c.visibilityState === 'visible');
      if (looking && !d.test) (await self.registration.getNotifications({ tag })).forEach((n) => n.close());
    })(),
  );
});

self.addEventListener('pushsubscriptionchange', (e) => {
  e.waitUntil(
    (async () => {
      const key = e.oldSubscription?.options?.applicationServerKey;
      const sub = e.newSubscription ?? (key ? await self.registration.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: key }) : null);
      if (sub) await fetch('/api/push/subscribe', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ subscription: sub.toJSON() }) });
    })(),
  );
});

self.addEventListener('notificationclick', (e) => {
  e.notification.close();
  const { conversationId: conv, inbox } = e.notification.data ?? {};
  const target = conv ? `/#/inbox/c/${conv}` : inbox ? '/#/inbox' : '/';
  e.waitUntil(
    self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then(async (cs) => {
      for (const c of cs) {
        await c.focus().catch(() => {});
        // navigate() refuses a window this worker does not control yet; the page listens for this too.
        c.postMessage({ t: 'open', hash: target.slice(1) });
        return;
      }
      await self.clients.openWindow(target);
    }),
  );
});
