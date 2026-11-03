// Offline shell, updates and push. The shell is served from this build's own cache, so starting the app
// never waits on the network; live data is the page's business (its snapshot, then the hub). Each build gets
// its own cache, and a new build reaches the page through the update flow in pwa.ts. The build fills in the
// two placeholders (vite.config.ts).
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
// Typing into a notification is a Chromium extension, not in the Notifications standard. Elsewhere there is no way to
// read what was typed, so it is not offered there at all and the notification opens the conversation as usual.
const CAN_REPLY = typeof NotificationEvent !== 'undefined' && 'reply' in NotificationEvent.prototype;

self.addEventListener('message', (e) => {
  if (e.data === 'skipWaiting') self.skipWaiting();
  if (e.data === 'canReply') e.source?.postMessage({ t: 'canReply', value: CAN_REPLY });
});

self.addEventListener('fetch', (e) => {
  if (e.request.method !== 'GET') return;
  const url = new URL(e.request.url);
  if (url.origin !== location.origin) return;
  const p = url.pathname;
  const hubOwn = p.startsWith('/api/') || p.startsWith('/media/') || p.startsWith('/emoji/') || p.startsWith('/voice/') || p === '/sw.js' || p === '/ca.crt';
  if (e.request.mode === 'navigate') {
    if (hubOwn) return;
    // Every other path is the app (routes live in the hash). Cache first: the cached index.html names exactly the
    // files this build precached. Network only when the cache lost it.
    e.respondWith(
      caches.open(CACHE).then(async (c) => (await c.match('/index.html')) ?? fetch(e.request)),
    );
    return;
  }
  if (hubOwn) return;
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
  // A test asks the device to say it arrived, so Settings can tell "the relay took it" from "it got here".
  const arrived = d.test && d.device ? fetch('/api/push/arrived', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ id: d.device }) }).catch(() => {}) : null;
  e.waitUntil(
    (async () => {
      await arrived;
      const tag = d.conversationId ?? (d.inbox ? 'dither-digest' : 'dither');
      await self.registration.showNotification(d.title ?? 'dither-chat', {
        body: d.body ?? '',
        tag,
        renotify: true,
        icon: '/icon-192.png',
        badge: '/icon-192.png',
        data: { conversationId: d.conversationId, inbox: d.inbox, test: d.test, replyTo: d.replyTo },
        actions: d.conversationId ? [...(d.canReply && CAN_REPLY ? [{ action: 'reply', type: 'text', title: 'Reply', placeholder: 'Message' }] : []), { action: 'open', title: 'Open' }] : [],
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

/**
 * The hub's ordinary send, which decides whether this may go out at all. It takes this because a worker's fetch carries
 * this origin, like the page's: there is no token in the push and no endpoint that trusts one.
 */
async function sendReply(n, conv, text, replyTo) {
  let error = null;
  try {
    const res = await fetch(`/api/conversations/${conv}/send`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ body: text, replyTo }), signal: AbortSignal.timeout(60_000) });
    if (!res.ok) error = (await res.json().catch(() => null))?.error ?? `The hub answered ${res.status}`;
  } catch (err) {
    error = err?.name === 'TimeoutError' ? 'The hub did not answer in time, so it may or may not have gone out' : 'Could not reach the hub';
  }
  if (!error) {
    n.close();
    for (const other of await self.registration.getNotifications({ tag: n.tag })) other.close();
    return;
  }
  // Same tag: it takes the place of the one replied to. What was typed stays readable, since nothing else kept it.
  await self.registration.showNotification('Reply not sent', { body: `${error}. You wrote: ${text}`.slice(0, 1000), tag: n.tag, renotify: true, requireInteraction: true, icon: '/icon-192.png', badge: '/icon-192.png', data: { conversationId: conv } });
}

self.addEventListener('notificationclick', (e) => {
  const { conversationId: conv, inbox, replyTo } = e.notification.data ?? {};
  // A platform that shows the action as a plain button gives no text: then it just opens, like any other click.
  const text = e.action === 'reply' && typeof e.reply === 'string' ? e.reply.trim() : '';
  if (conv && text) {
    e.waitUntil(sendReply(e.notification, conv, text, replyTo));
    return;
  }
  e.notification.close();
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
