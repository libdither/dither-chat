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
  // From a page out of sight (pwa.ts): only while no window of the app is in sight, so none is left on the old build.
  if (e.data?.t === 'skipWaiting' && e.data.unlessSeen)
    e.waitUntil(self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then((cs) => cs.some((c) => c.visibilityState === 'visible') || self.skipWaiting()));
  if (e.data === 'canReply') e.source?.postMessage({ t: 'canReply', value: CAN_REPLY });
  // An open page without push hands its notifications here, so they look the same as pushed ones.
  if (e.data?.t === 'notify' && e.data.d) e.waitUntil(show(e.data.d));
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

/**
 * What became of a notification, for the activity log (docs/activity.md). Only pushes that carry an id (`nid`) are
 * reported, and only with the id of this push registration (`device`), never anything about their content.
 */
function outcome(data, event) {
  if (!data?.nid) return Promise.resolve();
  const body = JSON.stringify({ events: [{ id: data.nid, device: data.device, event, at: Date.now() }] });
  return fetch('/api/activity/notifications', { method: 'POST', headers: { 'content-type': 'application/json' }, body }).catch(() => {});
}

// ------------------------------------------------------------------ how a notification looks

// Network colours (protocol NETWORK_META) and glyphs (web/src/brand.ts, Simple Icons, CC0); test/sw.test.ts keeps them equal.
const NETWORKS = {
  discord: { color: '#5865F2', glyph: 'M20.317 4.3698a19.7913 19.7913 0 00-4.8851-1.5152.0741.0741 0 00-.0785.0371c-.211.3753-.4447.8648-.6083 1.2495-1.8447-.2762-3.68-.2762-5.4868 0-.1636-.3933-.4058-.8742-.6177-1.2495a.077.077 0 00-.0785-.037 19.7363 19.7363 0 00-4.8852 1.515.0699.0699 0 00-.0321.0277C.5334 9.0458-.319 13.5799.0992 18.0578a.0824.0824 0 00.0312.0561c2.0528 1.5076 4.0413 2.4228 5.9929 3.0294a.0777.0777 0 00.0842-.0276c.4616-.6304.8731-1.2952 1.226-1.9942a.076.076 0 00-.0416-.1057c-.6528-.2476-1.2743-.5495-1.8722-.8923a.077.077 0 01-.0076-.1277c.1258-.0943.2517-.1923.3718-.2914a.0743.0743 0 01.0776-.0105c3.9278 1.7933 8.18 1.7933 12.0614 0a.0739.0739 0 01.0785.0095c.1202.099.246.1981.3728.2924a.077.077 0 01-.0066.1276 12.2986 12.2986 0 01-1.873.8914.0766.0766 0 00-.0407.1067c.3604.698.7719 1.3628 1.225 1.9932a.076.076 0 00.0842.0286c1.961-.6067 3.9495-1.5219 6.0023-3.0294a.077.077 0 00.0313-.0552c.5004-5.177-.8382-9.6739-3.5485-13.6604a.061.061 0 00-.0312-.0286zM8.02 15.3312c-1.1825 0-2.1569-1.0857-2.1569-2.419 0-1.3332.9555-2.4189 2.157-2.4189 1.2108 0 2.1757 1.0952 2.1568 2.419 0 1.3332-.9555 2.4189-2.1569 2.4189zm7.9748 0c-1.1825 0-2.1569-1.0857-2.1569-2.419 0-1.3332.9554-2.4189 2.1569-2.4189 1.2108 0 2.1757 1.0952 2.1568 2.419 0 1.3332-.946 2.4189-2.1568 2.4189Z' },
  signal: { color: '#3A91F5', glyph: 'M12 0q-.934 0-1.83.139l.17 1.111a11 11 0 0 1 3.32 0l.172-1.111A12 12 0 0 0 12 0M9.152.34A12 12 0 0 0 5.77 1.742l.584.961a10.8 10.8 0 0 1 3.066-1.27zm5.696 0-.268 1.094a10.8 10.8 0 0 1 3.066 1.27l.584-.962A12 12 0 0 0 14.848.34M12 2.25a9.75 9.75 0 0 0-8.539 14.459c.074.134.1.292.064.441l-1.013 4.338 4.338-1.013a.62.62 0 0 1 .441.064A9.7 9.7 0 0 0 12 21.75c5.385 0 9.75-4.365 9.75-9.75S17.385 2.25 12 2.25m-7.092.068a12 12 0 0 0-2.59 2.59l.909.664a11 11 0 0 1 2.345-2.345zm14.184 0-.664.909a11 11 0 0 1 2.345 2.345l.909-.664a12 12 0 0 0-2.59-2.59M1.742 5.77A12 12 0 0 0 .34 9.152l1.094.268a10.8 10.8 0 0 1 1.269-3.066zm20.516 0-.961.584a10.8 10.8 0 0 1 1.27 3.066l1.093-.268a12 12 0 0 0-1.402-3.383M.138 10.168A12 12 0 0 0 0 12q0 .934.139 1.83l1.111-.17A11 11 0 0 1 1.125 12q0-.848.125-1.66zm23.723.002-1.111.17q.125.812.125 1.66c0 .848-.042 1.12-.125 1.66l1.111.172a12.1 12.1 0 0 0 0-3.662M1.434 14.58l-1.094.268a12 12 0 0 0 .96 2.591l-.265 1.14 1.096.255.36-1.539-.188-.365a10.8 10.8 0 0 1-.87-2.35m21.133 0a10.8 10.8 0 0 1-1.27 3.067l.962.584a12 12 0 0 0 1.402-3.383zm-1.793 3.848a11 11 0 0 1-2.345 2.345l.664.909a12 12 0 0 0 2.59-2.59zm-19.959 1.1L.357 21.48a1.8 1.8 0 0 0 2.162 2.161l1.954-.455-.256-1.095-1.953.455a.675.675 0 0 1-.81-.81l.454-1.954zm16.832 1.769a10.8 10.8 0 0 1-3.066 1.27l.268 1.093a12 12 0 0 0 3.382-1.402zm-10.94.213-1.54.36.256 1.095 1.139-.266c.814.415 1.683.74 2.591.961l.268-1.094a10.8 10.8 0 0 1-2.35-.869zm3.634 1.24-.172 1.111a12.1 12.1 0 0 0 3.662 0l-.17-1.111q-.812.125-1.66.125a11 11 0 0 1-1.66-.125' },
  matrix: { color: '#0DBD8B', glyph: 'M.632.55v22.9H2.28V24H0V0h2.28v.55zm7.043 7.26v1.157h.033c.309-.443.683-.784 1.117-1.024.433-.245.936-.365 1.5-.365.54 0 1.033.107 1.481.314.448.208.785.582 1.02 1.108.254-.374.6-.706 1.034-.992.434-.287.95-.43 1.546-.43.453 0 .872.056 1.26.167.388.11.716.286.993.53.276.245.489.559.646.951.152.392.23.863.23 1.417v5.728h-2.349V11.52c0-.286-.01-.559-.032-.812a1.755 1.755 0 0 0-.18-.66 1.106 1.106 0 0 0-.438-.448c-.194-.11-.457-.166-.785-.166-.332 0-.6.064-.803.189a1.38 1.38 0 0 0-.48.499 1.946 1.946 0 0 0-.231.696 5.56 5.56 0 0 0-.06.785v4.768h-2.35v-4.8c0-.254-.004-.503-.018-.752a2.074 2.074 0 0 0-.143-.688 1.052 1.052 0 0 0-.415-.503c-.194-.125-.476-.19-.854-.19-.111 0-.259.024-.439.074-.18.051-.36.143-.53.282-.171.138-.319.337-.439.595-.12.259-.18.6-.18 1.02v4.966H5.46V7.81zm15.693 15.64V.55H21.72V0H24v24h-2.28v-.55z' },
  whatsapp: { color: '#1DAA61', glyph: 'M17.472 14.382c-.297-.149-1.758-.867-2.03-.967-.273-.099-.471-.148-.67.15-.197.297-.767.966-.94 1.164-.173.199-.347.223-.644.075-.297-.15-1.255-.463-2.39-1.475-.883-.788-1.48-1.761-1.653-2.059-.173-.297-.018-.458.13-.606.134-.133.298-.347.446-.52.149-.174.198-.298.298-.497.099-.198.05-.371-.025-.52-.075-.149-.669-1.612-.916-2.207-.242-.579-.487-.5-.669-.51-.173-.008-.371-.01-.57-.01-.198 0-.52.074-.792.372-.272.297-1.04 1.016-1.04 2.479 0 1.462 1.065 2.875 1.213 3.074.149.198 2.096 3.2 5.077 4.487.709.306 1.262.489 1.694.625.712.227 1.36.195 1.871.118.571-.085 1.758-.719 2.006-1.413.248-.694.248-1.289.173-1.413-.074-.124-.272-.198-.57-.347m-5.421 7.403h-.004a9.87 9.87 0 01-5.031-1.378l-.361-.214-3.741.982.998-3.648-.235-.374a9.86 9.86 0 01-1.51-5.26c.001-5.45 4.436-9.884 9.888-9.884 2.64 0 5.122 1.03 6.988 2.898a9.825 9.825 0 012.893 6.994c-.003 5.45-4.437 9.884-9.885 9.884m8.413-18.297A11.815 11.815 0 0012.05 0C5.495 0 .16 5.335.157 11.892c0 2.096.547 4.142 1.588 5.945L.057 24l6.305-1.654a11.882 11.882 0 005.683 1.448h.005c6.554 0 11.89-5.335 11.893-11.893a11.821 11.821 0 00-3.48-8.413Z' },
};

const pictures = new Map();

/**
 * The sender's picture, round, with the network's badge in a corner, as the notification's icon; the network's mark
 * as its badge (the small monochrome icon Android puts in the status bar). Without a picture, the first letter of the
 * title on a plain disc. Wherever a worker cannot draw, the app's icon as before.
 */
async function looks(d) {
  const out = { icon: '/icon-192.png', badge: '/icon-192.png' };
  const net = NETWORKS[d.network];
  if (!net || typeof OffscreenCanvas === 'undefined' || typeof Path2D === 'undefined' || typeof createImageBitmap === 'undefined') return out;
  try {
    const key = `${d.network}|${d.icon ?? d.title ?? ''}`;
    let icon = pictures.get(key);
    if (!icon) {
      let pic = null;
      if (d.icon) {
        const res = await fetch(d.icon, { signal: AbortSignal.timeout(4000) }).catch(() => null);
        if (res?.ok) pic = await createImageBitmap(await res.blob()).catch(() => null);
      }
      icon = await dataUrl(drawIcon(pic, net, d.title ?? ''));
      pictures.set(key, icon);
      while (pictures.size > 50) pictures.delete(pictures.keys().next().value);
    }
    out.icon = icon;
    out.badge = pictures.get(d.network) ?? (await dataUrl(drawBadge(net)));
    pictures.set(d.network, out.badge);
  } catch {}
  return out;
}

const SIZE = 192;

function drawIcon(pic, net, title) {
  const c = new OffscreenCanvas(SIZE, SIZE);
  const g = c.getContext('2d');
  const r = SIZE / 2;
  g.save();
  g.beginPath();
  g.arc(r, r, r, 0, Math.PI * 2);
  g.clip();
  if (pic) {
    // Cover: the shorter side fills the circle.
    const k = SIZE / Math.min(pic.width, pic.height);
    g.drawImage(pic, (SIZE - pic.width * k) / 2, (SIZE - pic.height * k) / 2, pic.width * k, pic.height * k);
  } else {
    g.fillStyle = '#5c6370';
    g.fillRect(0, 0, SIZE, SIZE);
    g.fillStyle = '#fff';
    g.font = `600 ${SIZE * 0.45}px system-ui, sans-serif`;
    g.textAlign = 'center';
    g.textBaseline = 'middle';
    g.fillText(([...title.trim()][0] ?? '?').toUpperCase(), r, r * 1.04);
  }
  g.restore();
  // The badge: the network's colour behind its white mark, ringed so it stands off any picture.
  const b = SIZE * 0.2;
  const x = SIZE - b;
  const y = SIZE - b;
  g.beginPath();
  g.arc(x, y, b + SIZE * 0.025, 0, Math.PI * 2);
  g.fillStyle = '#fff';
  g.fill();
  g.beginPath();
  g.arc(x, y, b, 0, Math.PI * 2);
  g.fillStyle = net.color;
  g.fill();
  glyph(g, net, x, y, b * 1.2);
  return c;
}

/** White on transparent: Android shows only the shape of a badge. */
function drawBadge(net) {
  const c = new OffscreenCanvas(96, 96);
  glyph(c.getContext('2d'), net, 48, 48, 80);
  return c;
}

function glyph(g, net, cx, cy, size) {
  g.save();
  g.translate(cx - size / 2, cy - size / 2);
  g.scale(size / 24, size / 24);
  g.fillStyle = '#fff';
  g.fill(new Path2D(net.glyph));
  g.restore();
}

async function dataUrl(canvas) {
  const bytes = new Uint8Array(await (await canvas.convertToBlob({ type: 'image/png' })).arrayBuffer());
  let bin = '';
  for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return `data:image/png;base64,${btoa(bin)}`;
}

/**
 * A vote from the notification (docs/notifications.md): Important down to Active, or up, which says it was right;
 * Active up to Important or down to the digest.
 */
const VOTES = {
  push: [
    { action: 'down', title: '▼ Active' },
    { action: 'up', title: '✓ Right' },
  ],
  quiet: [
    { action: 'up', title: '▲ Important' },
    { action: 'down', title: '▼ Digest' },
  ],
};

/** Title and body: a group's lines each say who wrote them, and the title counts them. */
function grouped(d) {
  const lines = Array.isArray(d.lines) && d.lines.length ? d.lines : null;
  if (!lines) return { title: d.title ?? 'dither-chat', body: d.body ?? '' };
  const direct = d.conv?.shape === 'direct';
  const n = Math.max(d.count ?? 0, lines.length);
  return {
    title: direct || n < 2 ? d.title : `${d.conv?.title ?? d.title} (${n})`,
    body: lines.map((l) => (direct ? l.body : `${l.author}: ${l.body}`)).join('\n'),
  };
}

/** Shows a notification from the hub's payload (webpush.ts pushPayload, or a page's notify event). Returns its tag. */
async function show(d) {
  const tag = d.conversationId ?? (d.inbox ? 'dither-digest' : 'dither');
  const look = await looks(d);
  // Active (docs/notifications.md): shown, but without sound or vibration.
  const quiet = d.level === 'quiet';
  const reply = d.conversationId && d.canReply && CAN_REPLY ? [{ action: 'reply', type: 'text', title: 'Reply', placeholder: 'Message' }] : [];
  const votes = d.messageId ? VOTES[d.level] ?? [] : [];
  // The votes first: a browser that shows two actions shows them.
  const actions = d.conversationId ? [...votes, ...reply, ...(votes.length ? [] : [{ action: 'open', title: 'Open' }])] : [];
  // One notification per conversation (docs/notifications.md): its unread lines, and a sound only when the hub says
  // so. An older hub sends neither, and every Important message sounds.
  const alert = d.alert ?? !quiet;
  const { title, body } = grouped(d);
  await self.registration.showNotification(title, {
    body,
    tag,
    renotify: alert,
    silent: !alert,
    icon: look.icon,
    badge: look.badge,
    data: { conversationId: d.conversationId, inbox: d.inbox, test: d.test, replyTo: d.replyTo, nid: d.nid, device: d.device, messageId: d.messageId },
    actions: actions.slice(0, self.Notification?.maxActions ?? 2),
  });
  return tag;
}

self.addEventListener('push', (e) => {
  let d = {};
  try {
    d = e.data ? e.data.json() : {};
  } catch {}
  // A test asks the device to say it arrived, so Settings can tell "the relay took it" from "it got here".
  const arrived = d.test && d.device ? fetch('/api/push/arrived', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ id: d.device }) }).catch(() => {}) : null;
  // Read somewhere else: the hub sends these to the Android app only, but a page that gets one closes it the same way.
  if (d.clear) {
    e.waitUntil(self.registration.getNotifications({ tag: d.clear }).then((ns) => ns.forEach((n) => n.close())));
    return;
  }
  e.waitUntil(
    (async () => {
      await arrived;
      const tag = await show(d);
      // Always shown first: Safari revokes subscriptions that receive a push and show nothing.
      const clients = await self.clients.matchAll({ type: 'window' });
      const looking = clients.some((c) => c.focused && c.visibilityState === 'visible');
      if (looking && !d.test) (await self.registration.getNotifications({ tag })).forEach((n) => n.close());
      await outcome(d, 'delivered');
      await outcome(d, looking ? 'suppressed' : 'shown');
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
    await outcome(n.data, 'replied');
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
  const mid = e.notification.data?.messageId;
  if ((e.action === 'up' || e.action === 'down') && mid) {
    e.notification.close();
    e.waitUntil(fetch(`/api/messages/${encodeURIComponent(mid)}/feedback`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ vote: e.action }) }).catch(() => {}));
    return;
  }
  e.notification.close();
  // The push's id rides in the hash, so the page can say which visit the tap led to (activity.ts).
  const nid = e.notification.data?.nid;
  const target = (conv ? `/#/inbox/c/${conv}` : inbox ? '/#/inbox' : '/') + (nid && (conv || inbox) ? `?n=${encodeURIComponent(nid)}` : '');
  e.waitUntil(
    self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then(async (cs) => {
      await outcome(e.notification.data, 'tapped');
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

// Swiped away. Browsers fire this only for some user dismissals (Chrome does on desktop and Android, Firefox on some
// systems, Safari not at all), and never for "clear all" everywhere: a missing dismissal means nothing.
self.addEventListener('notificationclose', (e) => {
  e.waitUntil(outcome(e.notification.data, 'dismissed'));
});
