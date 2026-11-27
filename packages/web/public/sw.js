// Offline shell, updates and push. The shell is served from this build's own cache, so starting the app
// never waits on the network; live data is the page's business (its snapshot, then the hub). Each build gets
// its own cache, and a new build reaches the page through the update flow in pwa.ts. The build fills in the
// two placeholders (vite.config.ts).
const BUILD = '__BUILD__';
const PRECACHE = '__PRECACHE__';
const CACHE = `dither-shell-${BUILD}`;

// Pictures the hub serves (/media/, /emoji/), kept across builds in a cache of their own and served from it first. A
// signed media path stands for one stored URL for good, and the hub keeps that URL's bytes (server.ts mediaSigner,
// fetchMedia), so a kept copy is never stale. Only whole images up to MEDIA_ITEM bytes; past MEDIA_COUNT entries or
// MEDIA_BYTES the oldest go. A WebView's own HTTP cache is small and shared with everything else (docs/android.md).
const MEDIA = 'dither-media-v1';
const MEDIA_ITEM = 512 * 1024;
const MEDIA_BYTES = 64 * 1024 * 1024;
const MEDIA_COUNT = 4000;
/** The bounds are checked after this many new entries. */
const TRIM_EVERY = 25;

self.addEventListener('install', (e) => {
  const listed = PRECACHE.startsWith('[') ? JSON.parse(PRECACHE) : [];
  e.waitUntil(fillShell([...new Set(['/index.html', '/manifest.webmanifest', ...listed])]));
  // No skipWaiting: the page asks for it (pwa.ts), since old pages may still load old chunks.
});
// Only once this build's cache is whole (an install that could not fill it fails, and the build in use stays) do the
// older builds' caches go.
self.addEventListener('activate', (e) => {
  const old = (k) => (k.startsWith('dither-shell-') && k !== CACHE) || (k.startsWith('dither-media-') && k !== MEDIA);
  e.waitUntil(caches.keys().then((ks) => Promise.all(ks.filter(old).map((k) => caches.delete(k)))).then(() => self.clients.claim()));
});

/**
 * Every file of this build into its cache (vite.config.ts lists them). A hashed file (/assets/) never changes under its
 * name, so one an older build's cache holds is copied from there, and a deploy downloads only what changed; one it
 * lacks may come from the HTTP cache. The rest (index.html, the manifest, the icons) are fetched fresh: an HTTP-cached
 * index.html could name the previous build's files. Any file it cannot have fails the install, once the others are in
 * (the browser tries the install again later, and then needs only what is missing).
 */
async function fillShell(urls) {
  const c = await caches.open(CACHE);
  const older = await Promise.all((await caches.keys()).filter((k) => k.startsWith('dither-shell-') && k !== CACHE).map((k) => caches.open(k)));
  const done = await Promise.allSettled(
    urls.map(async (u) => {
      const hashed = u.startsWith('/assets/');
      if (hashed) {
        // An install tried before and stopped may have this one already.
        if (await c.match(u)) return;
        for (const o of older) {
          const kept = await o.match(u);
          if (kept) return c.put(u, kept);
        }
      }
      const res = await fetch(new Request(u, { cache: hashed ? 'default' : 'reload' }));
      if (!res.ok) throw new Error(`${u}: ${res.status}`);
      await c.put(u, res);
    }),
  );
  const failed = done.find((d) => d.status === 'rejected');
  if (failed) throw failed.reason;
}
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
  // The hub's accounts, after each catch-up (pwa.ts): pictures fetched through one that left go from this device too.
  if (e.data?.t === 'keepAccounts' && Array.isArray(e.data.ids)) e.waitUntil(keepAccounts(e.data.ids));
});

self.addEventListener('fetch', (e) => {
  if (e.request.method !== 'GET') return;
  const url = new URL(e.request.url);
  if (url.origin !== location.origin) return;
  const p = url.pathname;
  // /calendar/ is dither-calendar through the hub (docs/calendar.md): its pages and files are never this app's.
  // /__device/ is the Android app's own (the phone's photos and files for the panel): it answers before the network.
  // Never kept here: the hub's answers are behind its login (docs/login.md), and a kept copy would outlive it. Only
  // pictures are kept (below), and signing out deletes them (login.ts).
  const hubOwn = p.startsWith('/api/') || p.startsWith('/media/') || p.startsWith('/emoji/') || p.startsWith('/voice/') || p.startsWith('/demo/') || p === '/sw.js' || p === '/ca.crt' || p === '/calendar' || p.startsWith('/calendar/') || p.startsWith('/__device/');
  if (e.request.mode === 'navigate') {
    if (hubOwn) return;
    // Every other path is the app (routes live in the hash). Cache first: the cached index.html names exactly the
    // files this build precached. Network only when the cache lost it.
    e.respondWith(
      caches.open(CACHE).then(async (c) => (await c.match('/index.html')) ?? fetch(e.request)),
    );
    return;
  }
  // A picture (<img>, or the page's own fetch ahead of one). A video or a download goes past: it asks for ranges, or
  // is not something an <img> shows.
  const dest = e.request.destination;
  if ((p.startsWith('/media/') || p.startsWith('/emoji/')) && (dest === 'image' || dest === '') && !e.request.headers.has('range')) {
    e.respondWith(media(e));
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

// ------------------------------------------------------------------ pictures

/** A whole image from this origin (a 'basic' response, not an opaque one), small enough to keep. */
function keepable(res) {
  const size = Number(res.headers.get('content-length') ?? NaN);
  return res.status === 200 && res.type === 'basic' && /^image\//i.test(res.headers.get('content-type') ?? '') && size >= 0 && size <= MEDIA_ITEM;
}

let added = 0;
async function media(e) {
  const c = await caches.open(MEDIA);
  const hit = await c.match(e.request);
  if (hit) return hit;
  const res = await fetch(e.request);
  if (keepable(res)) {
    e.waitUntil(
      c
        .put(e.request, res.clone())
        .then(() => ++added % TRIM_EVERY === 0 && trimMedia())
        .catch(() => {}),
    );
  }
  return res;
}

/** Oldest first (a cache lists its entries in the order they went in), until within both bounds. */
async function trimMedia() {
  const c = await caches.open(MEDIA);
  const keys = await c.keys();
  const sizes = await Promise.all(keys.map((k) => c.match(k).then((r) => Number(r?.headers.get('content-length') ?? 0) || 0)));
  let total = sizes.reduce((a, b) => a + b, 0);
  let count = keys.length;
  for (let i = 0; i < keys.length && (count > MEDIA_COUNT || total > MEDIA_BYTES); i++) {
    await c.delete(keys[i]);
    count--;
    total -= sizes[i];
  }
}

let kept = '';
/** Drops every kept picture fetched through an account (the signed path's `?a=`) that is not one of `ids`. */
async function keepAccounts(ids) {
  const key = [...ids].sort().join(',');
  if (key === kept) return;
  const live = new Set(ids);
  const c = await caches.open(MEDIA);
  for (const k of await c.keys()) {
    const a = new URL(k.url).searchParams.get('a');
    if (a !== null && !live.has(a)) await c.delete(k);
  }
  kept = key;
}

/**
 * What became of a notification, for the activity log (docs/activity.md). Only pushes that carry an id (`nid`) are
 * reported, and only with the id of this push registration (`device`), never anything about their content.
 */
function outcome(data, event, seen) {
  if (!data?.nid) return Promise.resolve();
  const body = JSON.stringify({ events: [{ id: data.nid, device: data.device, event, at: Date.now(), ...(seen ? { seen } : {}) }] });
  // A hub that takes the request and never answers (a phone off its network) must not hold the push's work open.
  const signal = typeof AbortSignal.timeout === 'function' ? AbortSignal.timeout(10_000) : undefined;
  return fetch('/api/activity/notifications', { method: 'POST', headers: { 'content-type': 'application/json' }, body, signal }).catch(() => {});
}

/**
 * Where this browser showed a notification, for the Notification calibration page (docs/notifications.md, "Where you
 * saw it"): a browser notification, with sound or not as the hub asked (a browser cannot say what the system did with
 * it), and whether a page of the app was open behind. Codes only. Not what else was showing: getNotifications() while
 * another push's notification is written but not yet on screen drops that one from Chromium's list for good, and with
 * it from close-on-read (scripts/verify-clear.ts), so the hub works that out from what it sent (push_shown).
 */
function seenHere(d, clients) {
  const alert = (d.tier ?? (d.level === 'quiet' ? 'quiet' : 'push')) === 'push' && (d.alert ?? true);
  return { surface: 'browser', sound: alert ? 'sound' : 'silent', pageOpen: clients.length > 0 };
}

// ------------------------------------------------------------------ how a notification looks

// Network colours (protocol NETWORK_META) and glyphs (web/src/brand.ts, Simple Icons, CC0); test/sw.test.ts keeps them equal.
const NETWORKS = {
  discord: { color: '#5865F2', glyph: 'M20.317 4.3698a19.7913 19.7913 0 00-4.8851-1.5152.0741.0741 0 00-.0785.0371c-.211.3753-.4447.8648-.6083 1.2495-1.8447-.2762-3.68-.2762-5.4868 0-.1636-.3933-.4058-.8742-.6177-1.2495a.077.077 0 00-.0785-.037 19.7363 19.7363 0 00-4.8852 1.515.0699.0699 0 00-.0321.0277C.5334 9.0458-.319 13.5799.0992 18.0578a.0824.0824 0 00.0312.0561c2.0528 1.5076 4.0413 2.4228 5.9929 3.0294a.0777.0777 0 00.0842-.0276c.4616-.6304.8731-1.2952 1.226-1.9942a.076.076 0 00-.0416-.1057c-.6528-.2476-1.2743-.5495-1.8722-.8923a.077.077 0 01-.0076-.1277c.1258-.0943.2517-.1923.3718-.2914a.0743.0743 0 01.0776-.0105c3.9278 1.7933 8.18 1.7933 12.0614 0a.0739.0739 0 01.0785.0095c.1202.099.246.1981.3728.2924a.077.077 0 01-.0066.1276 12.2986 12.2986 0 01-1.873.8914.0766.0766 0 00-.0407.1067c.3604.698.7719 1.3628 1.225 1.9932a.076.076 0 00.0842.0286c1.961-.6067 3.9495-1.5219 6.0023-3.0294a.077.077 0 00.0313-.0552c.5004-5.177-.8382-9.6739-3.5485-13.6604a.061.061 0 00-.0312-.0286zM8.02 15.3312c-1.1825 0-2.1569-1.0857-2.1569-2.419 0-1.3332.9555-2.4189 2.157-2.4189 1.2108 0 2.1757 1.0952 2.1568 2.419 0 1.3332-.9555 2.4189-2.1569 2.4189zm7.9748 0c-1.1825 0-2.1569-1.0857-2.1569-2.419 0-1.3332.9554-2.4189 2.1569-2.4189 1.2108 0 2.1757 1.0952 2.1568 2.419 0 1.3332-.946 2.4189-2.1568 2.4189Z' },
  signal: { color: '#3A91F5', glyph: 'M12 0q-.934 0-1.83.139l.17 1.111a11 11 0 0 1 3.32 0l.172-1.111A12 12 0 0 0 12 0M9.152.34A12 12 0 0 0 5.77 1.742l.584.961a10.8 10.8 0 0 1 3.066-1.27zm5.696 0-.268 1.094a10.8 10.8 0 0 1 3.066 1.27l.584-.962A12 12 0 0 0 14.848.34M12 2.25a9.75 9.75 0 0 0-8.539 14.459c.074.134.1.292.064.441l-1.013 4.338 4.338-1.013a.62.62 0 0 1 .441.064A9.7 9.7 0 0 0 12 21.75c5.385 0 9.75-4.365 9.75-9.75S17.385 2.25 12 2.25m-7.092.068a12 12 0 0 0-2.59 2.59l.909.664a11 11 0 0 1 2.345-2.345zm14.184 0-.664.909a11 11 0 0 1 2.345 2.345l.909-.664a12 12 0 0 0-2.59-2.59M1.742 5.77A12 12 0 0 0 .34 9.152l1.094.268a10.8 10.8 0 0 1 1.269-3.066zm20.516 0-.961.584a10.8 10.8 0 0 1 1.27 3.066l1.093-.268a12 12 0 0 0-1.402-3.383M.138 10.168A12 12 0 0 0 0 12q0 .934.139 1.83l1.111-.17A11 11 0 0 1 1.125 12q0-.848.125-1.66zm23.723.002-1.111.17q.125.812.125 1.66c0 .848-.042 1.12-.125 1.66l1.111.172a12.1 12.1 0 0 0 0-3.662M1.434 14.58l-1.094.268a12 12 0 0 0 .96 2.591l-.265 1.14 1.096.255.36-1.539-.188-.365a10.8 10.8 0 0 1-.87-2.35m21.133 0a10.8 10.8 0 0 1-1.27 3.067l.962.584a12 12 0 0 0 1.402-3.383zm-1.793 3.848a11 11 0 0 1-2.345 2.345l.664.909a12 12 0 0 0 2.59-2.59zm-19.959 1.1L.357 21.48a1.8 1.8 0 0 0 2.162 2.161l1.954-.455-.256-1.095-1.953.455a.675.675 0 0 1-.81-.81l.454-1.954zm16.832 1.769a10.8 10.8 0 0 1-3.066 1.27l.268 1.093a12 12 0 0 0 3.382-1.402zm-10.94.213-1.54.36.256 1.095 1.139-.266c.814.415 1.683.74 2.591.961l.268-1.094a10.8 10.8 0 0 1-2.35-.869zm3.634 1.24-.172 1.111a12.1 12.1 0 0 0 3.662 0l-.17-1.111q-.812.125-1.66.125a11 11 0 0 1-1.66-.125' },
  matrix: { color: '#0DBD8B', glyph: 'M.632.55v22.9H2.28V24H0V0h2.28v.55zm7.043 7.26v1.157h.033c.309-.443.683-.784 1.117-1.024.433-.245.936-.365 1.5-.365.54 0 1.033.107 1.481.314.448.208.785.582 1.02 1.108.254-.374.6-.706 1.034-.992.434-.287.95-.43 1.546-.43.453 0 .872.056 1.26.167.388.11.716.286.993.53.276.245.489.559.646.951.152.392.23.863.23 1.417v5.728h-2.349V11.52c0-.286-.01-.559-.032-.812a1.755 1.755 0 0 0-.18-.66 1.106 1.106 0 0 0-.438-.448c-.194-.11-.457-.166-.785-.166-.332 0-.6.064-.803.189a1.38 1.38 0 0 0-.48.499 1.946 1.946 0 0 0-.231.696 5.56 5.56 0 0 0-.06.785v4.768h-2.35v-4.8c0-.254-.004-.503-.018-.752a2.074 2.074 0 0 0-.143-.688 1.052 1.052 0 0 0-.415-.503c-.194-.125-.476-.19-.854-.19-.111 0-.259.024-.439.074-.18.051-.36.143-.53.282-.171.138-.319.337-.439.595-.12.259-.18.6-.18 1.02v4.966H5.46V7.81zm15.693 15.64V.55H21.72V0H24v24h-2.28v-.55z' },
  whatsapp: { color: '#1DAA61', glyph: 'M17.472 14.382c-.297-.149-1.758-.867-2.03-.967-.273-.099-.471-.148-.67.15-.197.297-.767.966-.94 1.164-.173.199-.347.223-.644.075-.297-.15-1.255-.463-2.39-1.475-.883-.788-1.48-1.761-1.653-2.059-.173-.297-.018-.458.13-.606.134-.133.298-.347.446-.52.149-.174.198-.298.298-.497.099-.198.05-.371-.025-.52-.075-.149-.669-1.612-.916-2.207-.242-.579-.487-.5-.669-.51-.173-.008-.371-.01-.57-.01-.198 0-.52.074-.792.372-.272.297-1.04 1.016-1.04 2.479 0 1.462 1.065 2.875 1.213 3.074.149.198 2.096 3.2 5.077 4.487.709.306 1.262.489 1.694.625.712.227 1.36.195 1.871.118.571-.085 1.758-.719 2.006-1.413.248-.694.248-1.289.173-1.413-.074-.124-.272-.198-.57-.347m-5.421 7.403h-.004a9.87 9.87 0 01-5.031-1.378l-.361-.214-3.741.982.998-3.648-.235-.374a9.86 9.86 0 01-1.51-5.26c.001-5.45 4.436-9.884 9.888-9.884 2.64 0 5.122 1.03 6.988 2.898a9.825 9.825 0 012.893 6.994c-.003 5.45-4.437 9.884-9.885 9.884m8.413-18.297A11.815 11.815 0 0012.05 0C5.495 0 .16 5.335.157 11.892c0 2.096.547 4.142 1.588 5.945L.057 24l6.305-1.654a11.882 11.882 0 005.683 1.448h.005c6.554 0 11.89-5.335 11.893-11.893a11.821 11.821 0 00-3.48-8.413Z' },
  telegram: { color: '#2AABEE', glyph: 'M11.944 0A12 12 0 0 0 0 12a12 12 0 0 0 12 12 12 12 0 0 0 12-12A12 12 0 0 0 12 0a12 12 0 0 0-.056 0zm4.962 7.224c.1-.002.321.023.465.14a.506.506 0 0 1 .171.325c.016.093.036.306.02.472-.18 1.898-.962 6.502-1.36 8.627-.168.9-.499 1.201-.82 1.23-.696.065-1.225-.46-1.9-.902-1.056-.693-1.653-1.124-2.678-1.8-1.185-.78-.417-1.21.258-1.91.177-.184 3.247-2.977 3.307-3.23.007-.032.014-.15-.056-.212s-.174-.041-.249-.024c-.106.024-1.793 1.14-5.061 3.345-.48.33-.913.49-1.302.48-.428-.008-1.252-.241-1.865-.44-.752-.245-1.349-.374-1.297-.789.027-.216.325-.437.893-.663 3.498-1.524 5.83-2.529 6.998-3.014 3.332-1.386 4.025-1.627 4.476-1.635z' },
  gmessages: { color: '#1A73E8', glyph: 'M12 0A12 12 0 0 0 0 12a12 12 0 0 0 12 12 12 12 0 0 0 12-12A12 12 0 0 0 12 0zM4.911 7.089h11.456a2.197 2.197 0 0 1 2.165 2.19v5.863a2.213 2.213 0 0 1-2.177 2.178H8.04c-1.174 0-2.04-.99-2.04-2.178v-4.639L4.503 7.905c-.31-.42-.05-.816.408-.816zm3.415 2.19c-.347 0-.68.21-.68.544 0 .334.333.544.68.544h7.905c.346 0 .68-.21.68-.544 0-.334-.334-.545-.68-.545zm0 2.177c-.347 0-.68.21-.68.544 0 .334.333.544.68.544h7.905c.346 0 .68-.21.68-.544 0-.334-.334-.544-.68-.544zm-.013 2.19c-.346 0-.68.21-.68.544 0 .334.334.544.68.544h5.728c.347 0 .68-.21.68-.544 0-.334-.333-.545-.68-.545z' },
  messenger: { color: '#0866FF', glyph: 'M12 0C5.24 0 0 4.952 0 11.64c0 3.499 1.434 6.521 3.769 8.61a.96.96 0 0 1 .323.683l.065 2.135a.96.96 0 0 0 1.347.85l2.381-1.053a.96.96 0 0 1 .641-.046A13 13 0 0 0 12 23.28c6.76 0 12-4.952 12-11.64S18.76 0 12 0m6.806 7.44c.522-.03.971.567.63 1.094l-4.178 6.457a.707.707 0 0 1-.977.208l-3.87-2.504a.44.44 0 0 0-.49.007l-4.363 3.01c-.637.438-1.415-.317-.995-.966l4.179-6.457a.706.706 0 0 1 .977-.21l3.87 2.505c.15.097.344.094.491-.007l4.362-3.008a.7.7 0 0 1 .364-.13' },
  instagram: { color: '#FF0069', glyph: 'M7.0301.084c-1.2768.0602-2.1487.264-2.911.5634-.7888.3075-1.4575.72-2.1228 1.3877-.6652.6677-1.075 1.3368-1.3802 2.127-.2954.7638-.4956 1.6365-.552 2.914-.0564 1.2775-.0689 1.6882-.0626 4.947.0062 3.2586.0206 3.6671.0825 4.9473.061 1.2765.264 2.1482.5635 2.9107.308.7889.72 1.4573 1.388 2.1228.6679.6655 1.3365 1.0743 2.1285 1.38.7632.295 1.6361.4961 2.9134.552 1.2773.056 1.6884.069 4.9462.0627 3.2578-.0062 3.668-.0207 4.9478-.0814 1.28-.0607 2.147-.2652 2.9098-.5633.7889-.3086 1.4578-.72 2.1228-1.3881.665-.6682 1.0745-1.3378 1.3795-2.1284.2957-.7632.4966-1.636.552-2.9124.056-1.2809.0692-1.6898.063-4.948-.0063-3.2583-.021-3.6668-.0817-4.9465-.0607-1.2797-.264-2.1487-.5633-2.9117-.3084-.7889-.72-1.4568-1.3876-2.1228C21.2982 1.33 20.628.9208 19.8378.6165 19.074.321 18.2017.1197 16.9244.0645 15.6471.0093 15.236-.005 11.977.0014 8.718.0076 8.31.0215 7.0301.0839m.1402 21.6932c-1.17-.0509-1.8053-.2453-2.2287-.408-.5606-.216-.96-.4771-1.3819-.895-.422-.4178-.6811-.8186-.9-1.378-.1644-.4234-.3624-1.058-.4171-2.228-.0595-1.2645-.072-1.6442-.079-4.848-.007-3.2037.0053-3.583.0607-4.848.05-1.169.2456-1.805.408-2.2282.216-.5613.4762-.96.895-1.3816.4188-.4217.8184-.6814 1.3783-.9003.423-.1651 1.0575-.3614 2.227-.4171 1.2655-.06 1.6447-.072 4.848-.079 3.2033-.007 3.5835.005 4.8495.0608 1.169.0508 1.8053.2445 2.228.408.5608.216.96.4754 1.3816.895.4217.4194.6816.8176.9005 1.3787.1653.4217.3617 1.056.4169 2.2263.0602 1.2655.0739 1.645.0796 4.848.0058 3.203-.0055 3.5834-.061 4.848-.051 1.17-.245 1.8055-.408 2.2294-.216.5604-.4763.96-.8954 1.3814-.419.4215-.8181.6811-1.3783.9-.4224.1649-1.0577.3617-2.2262.4174-1.2656.0595-1.6448.072-4.8493.079-3.2045.007-3.5825-.006-4.848-.0608M16.953 5.5864A1.44 1.44 0 1 0 18.39 4.144a1.44 1.44 0 0 0-1.437 1.4424M5.8385 12.012c.0067 3.4032 2.7706 6.1557 6.173 6.1493 3.4026-.0065 6.157-2.7701 6.1506-6.1733-.0065-3.4032-2.771-6.1565-6.174-6.1498-3.403.0067-6.156 2.771-6.1496 6.1738M8 12.0077a4 4 0 1 1 4.008 3.9921A3.9996 3.9996 0 0 1 8 12.0077' },
  x: { color: '#000000', glyph: 'M14.234 10.162 22.977 0h-2.072l-7.591 8.824L7.251 0H.258l9.168 13.343L.258 24H2.33l8.016-9.318L16.749 24h6.993zm-2.837 3.299-.929-1.329L3.076 1.56h3.182l5.965 8.532.929 1.329 7.754 11.09h-3.182z' },
  email: { color: '#5B7083', glyph: 'M2 4h20a2 2 0 0 1 2 2v12a2 2 0 0 1-2 2H2a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2zm0 2v.5l10 6.25L22 6.5V6zm20 2.86-9.47 5.92a1 1 0 0 1-1.06 0L2 8.86V18h20z' },
  calendar: { color: '#7E57C2', glyph: 'M7 1h2v2h6V1h2v2h2a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h2V1zM5 9v10h14V9H5zm2 2h4v4H7v-4z' },
  t3: { color: '#E5484D', glyph: 'M2.6 5.4 4.4 3.6 12.8 12l-8.4 8.4-1.8-1.8L9.2 12zM13 18h9v2.4h-9z' },
  mastodon: { color: '#6364FF', glyph: 'M23.268 5.313c-.35-2.578-2.617-4.61-5.304-5.004C17.51.242 15.792 0 11.813 0h-.03c-3.98 0-4.835.242-5.288.309C3.882.692 1.496 2.518.917 5.127.64 6.412.61 7.837.661 9.143c.074 1.874.088 3.745.26 5.611.118 1.24.325 2.47.62 3.68.55 2.237 2.777 4.098 4.96 4.857 2.336.792 4.849.923 7.256.38.265-.061.527-.132.786-.213.585-.184 1.27-.39 1.774-.753a.057.057 0 0 0 .023-.043v-1.809a.052.052 0 0 0-.02-.041.053.053 0 0 0-.046-.01 20.282 20.282 0 0 1-4.709.545c-2.73 0-3.463-1.284-3.674-1.818a5.593 5.593 0 0 1-.319-1.433.053.053 0 0 1 .066-.054c1.517.363 3.072.546 4.632.546.376 0 .75 0 1.125-.01 1.57-.044 3.224-.124 4.768-.422.038-.008.077-.015.11-.024 2.435-.464 4.753-1.92 4.989-5.604.008-.145.03-1.52.03-1.67.002-.512.167-3.63-.024-5.545zm-3.748 9.195h-2.561V8.29c0-1.309-.55-1.976-1.67-1.976-1.23 0-1.846.79-1.846 2.35v3.403h-2.546V8.663c0-1.56-.617-2.35-1.848-2.35-1.112 0-1.668.668-1.67 1.977v6.218H4.822V8.102c0-1.31.337-2.35 1.011-3.12.696-.77 1.608-1.164 2.74-1.164 1.311 0 2.302.5 2.962 1.498l.638 1.06.638-1.06c.66-.999 1.65-1.498 2.96-1.498 1.13 0 2.043.395 2.74 1.164.675.77 1.012 1.81 1.012 3.12z' },
  reddit: { color: '#FF4500', glyph: 'M12 0C5.373 0 0 5.373 0 12c0 3.314 1.343 6.314 3.515 8.485l-2.286 2.286C.775 23.225 1.097 24 1.738 24H12c6.627 0 12-5.373 12-12S18.627 0 12 0Zm4.388 3.199c1.104 0 1.999.895 1.999 1.999 0 1.105-.895 2-1.999 2-.946 0-1.739-.657-1.947-1.539v.002c-1.147.162-2.032 1.15-2.032 2.341v.007c1.776.067 3.4.567 4.686 1.363.473-.363 1.064-.58 1.707-.58 1.547 0 2.802 1.254 2.802 2.802 0 1.117-.655 2.081-1.601 2.531-.088 3.256-3.637 5.876-7.997 5.876-4.361 0-7.905-2.617-7.998-5.87-.954-.447-1.614-1.415-1.614-2.538 0-1.548 1.255-2.802 2.803-2.802.645 0 1.239.218 1.712.585 1.275-.79 2.881-1.291 4.64-1.365v-.01c0-1.663 1.263-3.034 2.88-3.207.188-.911.993-1.595 1.959-1.595Zm-8.085 8.376c-.784 0-1.459.78-1.506 1.797-.047 1.016.64 1.429 1.426 1.429.786 0 1.371-.369 1.418-1.385.047-1.017-.553-1.841-1.338-1.841Zm7.406 0c-.786 0-1.385.824-1.338 1.841.047 1.017.634 1.385 1.418 1.385.785 0 1.473-.413 1.426-1.429-.046-1.017-.721-1.797-1.506-1.797Zm-3.703 4.013c-.974 0-1.907.048-2.77.135-.147.015-.241.168-.183.305.483 1.154 1.622 1.964 2.953 1.964 1.33 0 2.47-.81 2.953-1.964.057-.137-.037-.29-.184-.305-.863-.087-1.795-.135-2.769-.135Z' },
  lemmy: { color: '#00BC8C', glyph: 'M2.9595 4.2228a3.9132 3.9132 0 0 0-.332.019c-.8781.1012-1.67.5699-2.155 1.3862-.475.8-.5922 1.6809-.35 2.4971.2421.8162.8297 1.5575 1.6982 2.1449.0053.0035.0106.0076.0163.0114.746.4498 1.492.7431 2.2877.8994-.02.3318-.0272.6689-.006 1.0181.0634 1.0432.4368 2.0006.996 2.8492l-2.0061.8189a.4163.4163 0 0 0-.2276.2239.416.416 0 0 0 .0879.455.415.415 0 0 0 .2941.1231.4156.4156 0 0 0 .1595-.0312l2.2093-.9035c.408.4859.8695.9315 1.3723 1.318.0196.0151.0407.0264.0603.0423l-1.2918 1.7103a.416.416 0 0 0 .664.501l1.314-1.7385c.7185.4548 1.4782.7927 2.2294 1.0242.3833.7209 1.1379 1.1871 2.0202 1.1871.8907 0 1.6442-.501 2.0242-1.2072.744-.2347 1.4959-.5729 2.2073-1.0262l1.332 1.7606a.4157.4157 0 0 0 .7439-.1936.4165.4165 0 0 0-.0799-.3074l-1.3099-1.7345c.0083-.0075.0178-.0113.0261-.0188.4968-.3803.9549-.8175 1.3622-1.2939l2.155.8794a.4156.4156 0 0 0 .5412-.2276.4151.4151 0 0 0-.2273-.5432l-1.9438-.7928c.577-.8538.9697-1.8183 1.0504-2.8693.0268-.3507.0242-.6914.0079-1.0262.7905-.1572 1.5321-.4502 2.2737-.8974.0053-.0033.011-.0076.0163-.0113.8684-.5874 1.456-1.3287 1.6982-2.145.2421-.8161.125-1.697-.3501-2.497-.4849-.8163-1.2768-1.2852-2.155-1.3863a3.2175 3.2175 0 0 0-.332-.0189c-.7852-.0151-1.6231.229-2.4286.6942-.5926.342-1.1252.867-1.5433 1.4387-1.1699-.6703-2.6923-1.0476-4.5635-1.0785a15.5768 15.5768 0 0 0-.5111 0c-2.085.034-3.7537.43-5.0142 1.1449-.0033-.0038-.0045-.0114-.008-.0152-.4233-.5916-.973-1.1365-1.5835-1.489-.8055-.465-1.6434-.7083-2.4286-.6941Zm.2858.7365c.5568.042 1.1696.2358 1.7787.5875.485.28.9757.7554 1.346 1.2696a5.6875 5.6875 0 0 0-.4969.4085c-.9201.8516-1.4615 1.9597-1.668 3.2335-.6809-.1402-1.3183-.3945-1.984-.7948-.7553-.5128-1.2159-1.1225-1.4004-1.7445-.1851-.624-.1074-1.2712.2776-1.9196.3743-.63.9275-.9534 1.6118-1.0322a2.796 2.796 0 0 1 .5352-.0076Zm17.5094 0a2.797 2.797 0 0 1 .5353.0075c.6842.0786 1.2374.4021 1.6117 1.0322.385.6484.4627 1.2957.2776 1.9196-.1845.622-.645 1.2317-1.4004 1.7445-.6578.3955-1.2881.6472-1.9598.7888-.1942-1.2968-.7375-2.4338-1.666-3.302a5.5639 5.5639 0 0 0-.4709-.3923c.3645-.49.8287-.9428 1.2938-1.2113.6091-.3515 1.2219-.5454 1.7787-.5875ZM12.006 6.0036a14.832 14.832 0 0 1 .487 0c2.3901.0393 4.0848.67 5.1631 1.678 1.1501 1.0754 1.6423 2.6006 1.499 4.467-.1311 1.7079-1.2203 3.2281-2.652 4.324-.694.5313-1.4626.9354-2.2254 1.2294.0031-.0453.014-.0888.014-.1349.0029-1.1964-.9313-2.2133-2.2918-2.2133-1.3606 0-2.3222 1.0154-2.2918 2.2213.0013.0507.014.0972.0181.1471-.781-.2933-1.5696-.7013-2.2777-1.2456-1.4239-1.0945-2.4997-2.6129-2.6037-4.322-.1129-1.8567.3778-3.3382 1.5212-4.3965C7.5094 6.7 9.352 6.047 12.006 6.0036Zm-3.6419 6.8291c-.6053 0-1.0966.4903-1.0966 1.0966 0 .6063.4913 1.0986 1.0966 1.0986s1.0966-.4923 1.0966-1.0986c0-.6063-.4913-1.0966-1.0966-1.0966zm7.2819.0113c-.5998 0-1.0866.4859-1.0866 1.0866s.4868 1.0885 1.0866 1.0885c.5997 0 1.0865-.4878 1.0865-1.0885s-.4868-1.0866-1.0865-1.0866zM12 16.0835c1.0237 0 1.5654.638 1.5634 1.4829-.0018.7849-.6723 1.485-1.5634 1.485-.9167 0-1.54-.5629-1.5634-1.493-.0212-.8347.5397-1.4749 1.5634-1.4749Z' },
  bluesky: { color: '#0085FF', glyph: 'M5.202 2.857C7.954 4.922 10.913 9.11 12 11.358c1.087-2.247 4.046-6.436 6.798-8.501C20.783 1.366 24 .213 24 3.883c0 .732-.42 6.156-.667 7.037-.856 3.061-3.978 3.842-6.755 3.37 4.854.826 6.089 3.562 3.422 6.299-5.065 5.196-7.28-1.304-7.847-2.97-.104-.305-.152-.448-.153-.327 0-.121-.05.022-.153.327-.568 1.666-2.782 8.166-7.847 2.97-2.667-2.737-1.432-5.473 3.422-6.3-2.777.473-5.899-.308-6.755-3.369C.42 10.04 0 4.615 0 3.883c0-3.67 3.217-2.517 5.202-1.026' },
  zulip: { color: '#6492FE', glyph: 'M22.767 3.589c0 1.209-.543 2.283-1.37 2.934l-8.034 7.174c-.149.128-.343-.078-.235-.25l2.946-5.9c.083-.165-.024-.368-.194-.368H4.452c-1.77 0-3.219-1.615-3.219-3.59C1.233 1.616 2.682 0 4.452 0h15.096c1.77-.001 3.219 1.614 3.219 3.589zM4.452 24h15.096c1.77 0 3.219-1.616 3.219-3.59 0-1.974-1.449-3.59-3.219-3.59H8.12c-.17 0-.277-.202-.194-.367l2.946-5.9c.108-.172-.086-.378-.235-.25l-8.033 7.173c-.828.65-1.37 1.725-1.37 2.934 0 1.974 1.448 3.59 3.218 3.59z' },
  lesswrong: { color: '#5F9B65', glyph: 'M1 5h2.6v11.6h5V19H1zm8 0h2.5l1.5 8.6L14.9 5h2.2l1.9 8.6L20.5 5H23l-3.1 14h-2.4L16 10.6 14.5 19h-2.4z' },
  luma: { color: '#E0399F', glyph: 'M12 1.5c.75 5.2 2.8 8.85 10.5 10.5-7.7 1.65-9.75 5.3-10.5 10.5-.75-5.2-2.8-8.85-10.5-10.5C9.2 10.35 11.25 6.7 12 1.5z' },
  partiful: { color: '#7C3AED', glyph: 'M12 1a7 7 0 0 0-7 7c0 4.3 3.4 8.4 5.9 9.5l-.9 1.5h1.4c-.2.9-.7 1.8-1.6 2.6l1 .9c1.1-1 1.7-2.2 2-3.5H14l-.9-1.5C15.6 16.4 19 12.3 19 8a7 7 0 0 0-7-7zm-2.6 3.2c.6 0 1 .5 1 1-1.4.4-2.3 1.4-2.6 2.8-.6 0-1-.4-1-1 .4-1.6 1.4-2.5 2.6-2.8z' },
  substack: { color: '#FF6719', glyph: 'M22.539 8.242H1.46V5.406h21.08v2.836zM1.46 10.812V24L12 18.11 22.54 24V10.812H1.46zM22.54 0H1.46v2.836h21.08V0z' },
};

const pictures = new Map();

/** A group's or channel's own picture (the push's conv.icon, as on Android), else the sender's. */
function pictureOf(d) {
  return (d.conv && d.conv.shape !== 'direct' && d.conv.icon) || d.icon;
}

/**
 * The picture (pictureOf), round, with the network's badge in a corner, as the notification's icon; the network's
 * mark as its badge (the small monochrome icon Android puts in the status bar). Without a picture, the first letter
 * of the title on a plain disc. Wherever a worker cannot draw, the app's icon as before.
 */
async function looks(d) {
  const out = { icon: '/icon-192.png', badge: '/icon-192.png' };
  const net = NETWORKS[d.network];
  if (!net || typeof OffscreenCanvas === 'undefined' || typeof Path2D === 'undefined' || typeof createImageBitmap === 'undefined') return out;
  try {
    const src = pictureOf(d);
    const key = `${d.network}|${src ?? d.title ?? ''}`;
    let icon = pictures.get(key);
    if (!icon) {
      let pic = null;
      if (src) {
        const res = await fetch(src, { signal: AbortSignal.timeout(4000) }).catch(() => null);
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
 * Your say from the notification (docs/notifications.md, "Answers"), by how it reached you: one that sounded ('push')
 * was worth it or could have waited; a silent one ('quiet') should have been louder; a list row ('digest') quieter or
 * louder. Each is an answer (POST /api/loudness/answers). Mail keeps "Less like this" (POST
 * /api/messages/:id/feedback); `wrong` and `alert` are the marks from before, kept for a notification shown then.
 */
const MARKS = {
  worth: { title: 'Worth it', answer: 'worth', said: 'More like this will sound.' },
  could_wait: { title: 'Could have waited', answer: 'could_wait', said: 'More like this will wait.' },
  louder: { title: 'Louder', answer: 'louder', said: 'More like this will come louder.' },
  quieter: { title: 'Quieter', answer: 'quieter', said: 'More like this will come quieter.' },
  wrong: { title: 'Not urgent', body: { alert: false }, said: 'Fewer like this will alert.' },
  alert: { title: 'Should have alerted', body: { alert: true }, said: 'More like this will alert.' },
  less: { title: 'Less like this', body: { less: true }, said: 'Less like this will reach you.' },
};
/** How long "Noted" stays in an answered notification's place before it closes itself. */
const NOTED_MS = 4000;
const TIER_MARKS = { push: ['worth', 'could_wait'], quiet: ['louder'], digest: ['quieter', 'louder'] };
/** A notice (docs/notices.md) is not a message the scale weighs: it keeps the marks. */
const NOTICE_MARKS = { push: ['wrong'], quiet: ['alert'], digest: ['less', 'alert'] };

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
  // A request waiting on you (docs/add.md) has one of its own, and opens under Requests. A calendar reminder has one
  // per event (docs/calendar.md), so a second lead time takes the first one's place.
  const cal = d.calendar && typeof d.calendar.open === 'string' ? d.calendar : null;
  // A call ringing you (docs/calls.md "Ringing"): one per call, with Answer and Decline, kept up until it is handled.
  const ring = d.call && typeof d.call.id === 'string' ? d.call : null;
  if (ring) return showRing(d, ring);
  const tag = cal ? `calendar:${cal.eventKey}` : d.conversationId ?? (d.requestId ? `request:${d.requestId}` : d.inbox ? 'dither-inbox' : 'dither');
  const look = await looks(d);
  // Its tier (docs/notifications.md): an alert, a Conversation or a list row. A hub from before the tiers says only
  // `level`: 'quiet' for what is silent, else an alert.
  const tier = d.tier ?? (d.level === 'quiet' ? 'quiet' : 'push');
  const reply = d.conversationId && d.canReply && CAN_REPLY ? [{ action: 'reply', type: 'text', title: 'Reply', placeholder: 'Message' }] : [];
  // Mail takes only "Less like this" (docs/mail.md).
  const marks = (d.messageId ? (d.mailThreadId ? (tier === 'push' ? [] : ['less']) : ((d.noticeId ? NOTICE_MARKS : TIER_MARKS)[tier] ?? [])) : []).map((a) => ({ action: a, title: MARKS[a].title }));
  // A browser shows two actions: Reply and the mark where there is one, both where there are two (an alert, a list row).
  const actions = cal ? (cal.meetingUrl ? [{ action: 'join', title: 'Join' }] : []) : d.conversationId ? (marks.length > 1 ? [...marks, ...reply] : [...reply, ...marks, ...(marks.length ? [] : [{ action: 'open', title: 'Open' }])]) : [];
  // One notification per conversation (docs/notifications.md): its unread lines. Only an alert may sound, and only
  // when the hub says so; an older hub does not say, and every alert sounds. A Conversation and a list row are shown
  // without sound or vibration.
  const alert = tier === 'push' && (d.alert ?? true);
  const { title, body } = grouped(d);
  await self.registration.showNotification(title, {
    body,
    tag,
    renotify: alert,
    silent: !alert,
    icon: look.icon,
    badge: look.badge,
    // `ts`: the newest message it shows, so a clear that comes late closes it only up to where it was read (below).
    // `keep`: a reminder or a held summary, which no read closes, here or in a page (shade.ts).
    data: { conversationId: d.conversationId, request: d.requestId, notice: d.noticeId, inbox: d.inbox, test: d.test, replyTo: d.replyTo, nid: d.nid, device: d.device, messageId: d.messageId, calendar: cal, ts: newest(d), keep: d.keep === true || undefined },
    actions: actions.slice(0, self.Notification?.maxActions ?? 2),
  });
  // On screen now. Chromium drops one still on its way from what getNotifications() lists (docs/notifications.md,
  // "Read elsewhere, gone here"), so scripts/verify-clear.ts waits for this mark before it looks.
  performance.mark('dither:shown', { detail: tag });
  return tag;
}

/** A call ringing you: Answer opens the chat, where the ring card answers it; Decline stops it ringing everywhere. */
async function showRing(d, ring) {
  const look = await looks(d);
  const tag = ring.tag || `call:${ring.id}`;
  const actions = [...(ring.canAnswer ? [{ action: 'answer', title: 'Answer' }] : []), ...(ring.canDecline ? [{ action: 'decline', title: 'Decline' }] : [])];
  await self.registration.showNotification(d.title ?? 'Incoming call', {
    body: d.body ?? '',
    tag,
    renotify: true,
    requireInteraction: true,
    icon: look.icon,
    badge: look.badge,
    data: { conversationId: d.conversationId, call: ring.id, device: d.device },
    actions: actions.slice(0, self.Notification?.maxActions ?? 2),
  });
  return tag;
}

/** The newest message a push shows: the hub's `ts`, else its last line's. */
function newest(d) {
  if (typeof d.ts === 'number') return d.ts;
  const last = Array.isArray(d.lines) ? d.lines[d.lines.length - 1] : null;
  return typeof last?.ts === 'number' ? last.ts : undefined;
}

/**
 * A clear closes its tag's notification, and those in `more` (one push carries everything still waiting for this
 * browser, clears.ts), each only when it shows nothing newer than `upTo`, where it was read: a clear that arrives
 * after a newer alert leaves that alert. Without `upTo` (an older hub), or a notification without `ts`, it closes.
 * One with `keep` (a reminder, a held summary, "Reply not sent" with what you typed) stays whatever was read.
 */
async function clear(d) {
  const all = [{ clear: d.clear, upTo: d.upTo }, ...(Array.isArray(d.more) ? d.more : [])].filter((c) => typeof c?.clear === 'string');
  for (const c of all) {
    for (const n of await self.registration.getNotifications({ tag: c.clear })) {
      if (n.data?.keep === true) continue;
      const ts = n.data?.ts;
      if (typeof c.upTo !== 'number' || typeof ts !== 'number' || ts <= c.upTo) n.close();
    }
  }
}

// Copies of the messages pushes were about, and reads elsewhere, kept for the page's next start (src/arrived.ts,
// docs/notifications.md "A copy in the push"): it shows them before the hub answers, and deletes them once it has; an
// open page gets them as they come. The newest ARRIVED_MAX, none older than ARRIVED_KEEP_MS. The key is the page's to
// agree with.
const ARRIVED_DB = 'dither-arrived';
const ARRIVED_MAX = 300;
const ARRIVED_KEEP_MS = 3 * 24 * 3600 * 1000;

/**
 * What a push leaves for the page: its message's copy, or each read it carries, one per conversation (a later read
 * replaces it, keeping the furthest `upTo`). A clear without `upTo` is not a read (the hub took a phone-list row back),
 * so it leaves nothing.
 */
function arrivedRecords(d, at) {
  const a = d.arrived;
  if (a && typeof a.message?.id === 'string' && a.message.conversationId === d.conversationId) return [{ key: `m:${a.message.id}`, kind: 'message', conv: d.conversationId, arrived: a, at }];
  if (typeof d.clear !== 'string') return [];
  return [{ clear: d.clear, upTo: d.upTo }, ...(Array.isArray(d.more) ? d.more : [])]
    .filter((c) => typeof c?.clear === 'string' && typeof c.upTo === 'number')
    .map((c) => ({ key: `c:${c.clear}`, kind: 'clear', conv: c.clear, upTo: c.upTo, at }));
}

function keepArrived(records) {
  const idb = self.indexedDB;
  if (!idb || !records.length) return Promise.resolve();
  return new Promise((resolve) => {
    const q = idb.open(ARRIVED_DB, 1);
    q.onupgradeneeded = () => q.result.createObjectStore('arrived');
    q.onerror = q.onblocked = () => resolve();
    q.onsuccess = () => {
      const d = q.result;
      try {
        const t = d.transaction('arrived', 'readwrite');
        const st = t.objectStore('arrived');
        for (const r of records) {
          if (r.kind !== 'clear') st.put(r, r.key);
          else {
            const was = st.get(r.key);
            was.onsuccess = () => st.put(was.result?.upTo > r.upTo ? { ...r, upTo: was.result.upTo } : r, r.key);
          }
        }
        const all = st.getAll();
        all.onsuccess = () => {
          const now = Date.now();
          all.result.sort((x, y) => y.at - x.at).forEach((r, i) => (i >= ARRIVED_MAX || now - r.at > ARRIVED_KEEP_MS) && st.delete(r.key));
        };
        t.oncomplete = t.onerror = t.onabort = () => (d.close(), resolve());
      } catch {
        d.close();
        resolve();
      }
    };
  }).then(() => tellPages(records));
}

/** An open page that has not heard from the hub yet shows them now (src/arrived.ts). */
async function tellPages(records) {
  for (const c of await self.clients.matchAll({ type: 'window' })) c.postMessage({ t: 'arrived', records });
}

self.addEventListener('push', (e) => {
  let d = {};
  try {
    d = e.data ? e.data.json() : {};
  } catch {}
  // A test asks the device to say it arrived, so Settings can tell "the relay took it" from "it got here".
  const arrived = d.test && d.device ? fetch('/api/push/arrived', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ id: d.device }) }).catch(() => {}) : null;
  // Read somewhere else (docs/notifications.md, "Read elsewhere, gone here"): it shows nothing, and only closes.
  if (d.clear) {
    e.waitUntil(Promise.all([clear(d), keepArrived(arrivedRecords(d, Date.now()))]));
    return;
  }
  // Kept first: a push's work can be cut short (the hub's requests below may never be answered off its network), and a
  // tap can start the page at once.
  const keeping = keepArrived(arrivedRecords(d, Date.now()));
  e.waitUntil(
    (async () => {
      await arrived;
      const tag = await show(d);
      // Always shown first: Safari revokes subscriptions that receive a push and show nothing.
      const clients = await self.clients.matchAll({ type: 'window' });
      const looking = clients.some((c) => c.focused && c.visibilityState === 'visible');
      if (looking && !d.test) (await self.registration.getNotifications({ tag })).forEach((n) => n.close());
      await outcome(d, 'delivered');
      await outcome(d, looking ? 'suppressed' : 'shown', looking ? { pageOpen: true } : seenHere(d, clients));
      await keeping;
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
  let held = null;
  // It names the message it answers, so the hub holds it if more came into the chat since (docs/sync.md "The send
  // queue").
  const seen = typeof n.data?.messageId === 'string' ? { seenUpTo: { id: n.data.messageId } } : {};
  try {
    const res = await fetch(`/api/conversations/${conv}/send`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ body: text, replyTo, ...seen }), signal: AbortSignal.timeout(60_000) });
    const answer = await res.json().catch(() => null);
    if (!res.ok) error = answer?.error ?? `The hub answered ${res.status}`;
    // 202: the hub has it and it waits for you, held itself or behind an earlier send of the chat that is.
    else if (res.status === 202) held = answer?.row ?? {};
  } catch (err) {
    error = err?.name === 'TimeoutError' ? 'The hub did not answer in time, so it may or may not have gone out' : 'Could not reach the hub';
  }
  if (held) {
    const k = held.hold?.count ?? 0;
    const why = held.state === 'held' ? `${k} new message${k === 1 ? '' : 's'} came in` : 'It waits behind an earlier message of yours that is held or may not have gone out';
    await outcome(n.data, 'replied');
    await self.registration.showNotification('Reply waiting', { body: `${why}. Open the chat to send it, edit it or cancel it. You wrote: ${text}`.slice(0, 1000), tag: n.tag, renotify: true, requireInteraction: true, icon: '/icon-192.png', badge: '/icon-192.png', data: { conversationId: conv, keep: true } });
    return;
  }
  if (!error) {
    await outcome(n.data, 'replied');
    n.close();
    for (const other of await self.registration.getNotifications({ tag: n.tag })) other.close();
    return;
  }
  // Same tag: it takes the place of the one replied to. What was typed stays readable, since nothing else kept it, so
  // no read of the chat closes it (`keep`: clear above, shade.ts), only a tap or a swipe.
  await self.registration.showNotification('Reply not sent', { body: `${error}. You wrote: ${text}`.slice(0, 1000), tag: n.tag, renotify: true, requireInteraction: true, icon: '/icon-192.png', badge: '/icon-192.png', data: { conversationId: conv, keep: true } });
}

/**
 * An answer from a notification's button. A button that only closed the notification would look the same whether the
 * hub took it or not, so in its place a silent "Noted" says it did, and closes itself; or "Answer not saved" says why
 * not, and stays.
 */
async function sendMark(n, mark, mid) {
  const req = mark.answer
    ? { url: '/api/loudness/answers', body: { messageId: mid, answer: mark.answer, source: 'notification' } }
    : { url: `/api/messages/${encodeURIComponent(mid)}/feedback`, body: mark.body };
  let error = null;
  try {
    const res = await fetch(req.url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(req.body), signal: AbortSignal.timeout(30_000) });
    if (!res.ok) error = (await res.json().catch(() => null))?.error ?? `The hub answered ${res.status}`;
  } catch (err) {
    error = err?.name === 'TimeoutError' ? 'The hub did not answer in time' : 'Could not reach the hub';
  }
  const o = { tag: n.tag, silent: true, icon: '/icon-192.png', badge: '/icon-192.png' };
  if (error) {
    await self.registration.showNotification('Answer not saved', { ...o, body: `${mark.title}: ${error}.`, data: { conversationId: n.data?.conversationId } });
    return;
  }
  await self.registration.showNotification(`Noted: ${mark.title}`, { ...o, body: mark.said, data: { conversationId: n.data?.conversationId, noted: true } });
  await new Promise((r) => setTimeout(r, NOTED_MS));
  // Only the "Noted": a push for the chat may have taken its place since.
  for (const shown of await self.registration.getNotifications({ tag: n.tag })) if (shown.data?.noted) shown.close();
}

self.addEventListener('notificationclick', (e) => {
  const { conversationId: conv, inbox, replyTo } = e.notification.data ?? {};
  const ringing = e.notification.data?.call;
  if (ringing && e.action === 'decline') {
    e.notification.close();
    e.waitUntil(fetch(`/api/calls/${encodeURIComponent(ringing)}/decline`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' }).catch(() => {}));
    return;
  }
  // A platform that shows the action as a plain button gives no text: then it just opens, like any other click.
  const text = e.action === 'reply' && typeof e.reply === 'string' ? e.reply.trim() : '';
  if (conv && text) {
    e.waitUntil(sendReply(e.notification, conv, text, replyTo));
    return;
  }
  const mid = e.notification.data?.messageId;
  const mark = Object.hasOwn(MARKS, e.action) ? MARKS[e.action] : null;
  if (mark && mid) {
    e.notification.close();
    e.waitUntil(sendMark(e.notification, mark, mid));
    return;
  }
  e.notification.close();
  // A calendar reminder: Join opens the meeting; anything else, the calendar where the event is (docs/calendar.md).
  const cal = e.notification.data?.calendar;
  if (cal && e.action === 'join' && /^https?:\/\//i.test(cal.meetingUrl ?? '')) {
    e.waitUntil(outcome(e.notification.data, 'tapped').then(() => self.clients.openWindow(cal.meetingUrl)));
    return;
  }
  // The push's id rides in the hash, so the page can say which visit the tap led to (activity.ts).
  const nid = e.notification.data?.nid;
  const request = e.notification.data?.request;
  // A notice (docs/notices.md) opens under Notices, not its group's "conversation".
  const notice = e.notification.data?.notice;
  // A group of notices without its notice (quiet hours' summary from an older hub) opens Notices too.
  const noticesOnly = !notice && typeof conv === 'string' && conv.startsWith('ntg_');
  const target = cal ? '/#/calendar/' + String(cal.open).replace(/^#\/?/, '') : (notice ? `/#/notices/${notice}` : noticesOnly ? '/#/notices' : conv ? `/#/inbox/c/${conv}` : request ? `/#/requests/${request}` : inbox ? '/#/inbox' : '/') + (nid && (notice || conv || request || inbox) ? `?n=${encodeURIComponent(nid)}` : '');
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
