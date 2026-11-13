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
  const assets = PRECACHE.startsWith('[') ? JSON.parse(PRECACHE) : [];
  // Fetched fresh: an HTTP-cached index.html could name files from the previous build.
  e.waitUntil(caches.open(CACHE).then((c) => c.addAll(['/index.html', '/manifest.webmanifest', ...assets].map((u) => new Request(u, { cache: 'reload' })))));
  // No skipWaiting: the page asks for it (pwa.ts), since old pages may still load old chunks.
});
self.addEventListener('activate', (e) => {
  const old = (k) => (k.startsWith('dither-shell-') && k !== CACHE) || (k.startsWith('dither-media-') && k !== MEDIA);
  e.waitUntil(caches.keys().then((ks) => Promise.all(ks.filter(old).map((k) => caches.delete(k)))).then(() => self.clients.claim()));
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
  // The hub's accounts, after each catch-up (pwa.ts): pictures fetched through one that left go from this device too.
  if (e.data?.t === 'keepAccounts' && Array.isArray(e.data.ids)) e.waitUntil(keepAccounts(e.data.ids));
});

self.addEventListener('fetch', (e) => {
  if (e.request.method !== 'GET') return;
  const url = new URL(e.request.url);
  if (url.origin !== location.origin) return;
  const p = url.pathname;
  // /calendar/ is dither-calendar through the hub (docs/calendar.md): its pages and files are never this app's.
  const hubOwn = p.startsWith('/api/') || p.startsWith('/media/') || p.startsWith('/emoji/') || p.startsWith('/voice/') || p === '/sw.js' || p === '/ca.crt' || p === '/calendar' || p.startsWith('/calendar/');
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
  telegram: { color: '#2AABEE', glyph: 'M11.944 0A12 12 0 0 0 0 12a12 12 0 0 0 12 12 12 12 0 0 0 12-12A12 12 0 0 0 12 0a12 12 0 0 0-.056 0zm4.962 7.224c.1-.002.321.023.465.14a.506.506 0 0 1 .171.325c.016.093.036.306.02.472-.18 1.898-.962 6.502-1.36 8.627-.168.9-.499 1.201-.82 1.23-.696.065-1.225-.46-1.9-.902-1.056-.693-1.653-1.124-2.678-1.8-1.185-.78-.417-1.21.258-1.91.177-.184 3.247-2.977 3.307-3.23.007-.032.014-.15-.056-.212s-.174-.041-.249-.024c-.106.024-1.793 1.14-5.061 3.345-.48.33-.913.49-1.302.48-.428-.008-1.252-.241-1.865-.44-.752-.245-1.349-.374-1.297-.789.027-.216.325-.437.893-.663 3.498-1.524 5.83-2.529 6.998-3.014 3.332-1.386 4.025-1.627 4.476-1.635z' },
  gmessages: { color: '#1A73E8', glyph: 'M12 0A12 12 0 0 0 0 12a12 12 0 0 0 12 12 12 12 0 0 0 12-12A12 12 0 0 0 12 0zM4.911 7.089h11.456a2.197 2.197 0 0 1 2.165 2.19v5.863a2.213 2.213 0 0 1-2.177 2.178H8.04c-1.174 0-2.04-.99-2.04-2.178v-4.639L4.503 7.905c-.31-.42-.05-.816.408-.816zm3.415 2.19c-.347 0-.68.21-.68.544 0 .334.333.544.68.544h7.905c.346 0 .68-.21.68-.544 0-.334-.334-.545-.68-.545zm0 2.177c-.347 0-.68.21-.68.544 0 .334.333.544.68.544h7.905c.346 0 .68-.21.68-.544 0-.334-.334-.544-.68-.544zm-.013 2.19c-.346 0-.68.21-.68.544 0 .334.334.544.68.544h5.728c.347 0 .68-.21.68-.544 0-.334-.333-.545-.68-.545z' },
  messenger: { color: '#0866FF', glyph: 'M12 0C5.24 0 0 4.952 0 11.64c0 3.499 1.434 6.521 3.769 8.61a.96.96 0 0 1 .323.683l.065 2.135a.96.96 0 0 0 1.347.85l2.381-1.053a.96.96 0 0 1 .641-.046A13 13 0 0 0 12 23.28c6.76 0 12-4.952 12-11.64S18.76 0 12 0m6.806 7.44c.522-.03.971.567.63 1.094l-4.178 6.457a.707.707 0 0 1-.977.208l-3.87-2.504a.44.44 0 0 0-.49.007l-4.363 3.01c-.637.438-1.415-.317-.995-.966l4.179-6.457a.706.706 0 0 1 .977-.21l3.87 2.505c.15.097.344.094.491-.007l4.362-3.008a.7.7 0 0 1 .364-.13' },
  instagram: { color: '#FF0069', glyph: 'M7.0301.084c-1.2768.0602-2.1487.264-2.911.5634-.7888.3075-1.4575.72-2.1228 1.3877-.6652.6677-1.075 1.3368-1.3802 2.127-.2954.7638-.4956 1.6365-.552 2.914-.0564 1.2775-.0689 1.6882-.0626 4.947.0062 3.2586.0206 3.6671.0825 4.9473.061 1.2765.264 2.1482.5635 2.9107.308.7889.72 1.4573 1.388 2.1228.6679.6655 1.3365 1.0743 2.1285 1.38.7632.295 1.6361.4961 2.9134.552 1.2773.056 1.6884.069 4.9462.0627 3.2578-.0062 3.668-.0207 4.9478-.0814 1.28-.0607 2.147-.2652 2.9098-.5633.7889-.3086 1.4578-.72 2.1228-1.3881.665-.6682 1.0745-1.3378 1.3795-2.1284.2957-.7632.4966-1.636.552-2.9124.056-1.2809.0692-1.6898.063-4.948-.0063-3.2583-.021-3.6668-.0817-4.9465-.0607-1.2797-.264-2.1487-.5633-2.9117-.3084-.7889-.72-1.4568-1.3876-2.1228C21.2982 1.33 20.628.9208 19.8378.6165 19.074.321 18.2017.1197 16.9244.0645 15.6471.0093 15.236-.005 11.977.0014 8.718.0076 8.31.0215 7.0301.0839m.1402 21.6932c-1.17-.0509-1.8053-.2453-2.2287-.408-.5606-.216-.96-.4771-1.3819-.895-.422-.4178-.6811-.8186-.9-1.378-.1644-.4234-.3624-1.058-.4171-2.228-.0595-1.2645-.072-1.6442-.079-4.848-.007-3.2037.0053-3.583.0607-4.848.05-1.169.2456-1.805.408-2.2282.216-.5613.4762-.96.895-1.3816.4188-.4217.8184-.6814 1.3783-.9003.423-.1651 1.0575-.3614 2.227-.4171 1.2655-.06 1.6447-.072 4.848-.079 3.2033-.007 3.5835.005 4.8495.0608 1.169.0508 1.8053.2445 2.228.408.5608.216.96.4754 1.3816.895.4217.4194.6816.8176.9005 1.3787.1653.4217.3617 1.056.4169 2.2263.0602 1.2655.0739 1.645.0796 4.848.0058 3.203-.0055 3.5834-.061 4.848-.051 1.17-.245 1.8055-.408 2.2294-.216.5604-.4763.96-.8954 1.3814-.419.4215-.8181.6811-1.3783.9-.4224.1649-1.0577.3617-2.2262.4174-1.2656.0595-1.6448.072-4.8493.079-3.2045.007-3.5825-.006-4.848-.0608M16.953 5.5864A1.44 1.44 0 1 0 18.39 4.144a1.44 1.44 0 0 0-1.437 1.4424M5.8385 12.012c.0067 3.4032 2.7706 6.1557 6.173 6.1493 3.4026-.0065 6.157-2.7701 6.1506-6.1733-.0065-3.4032-2.771-6.1565-6.174-6.1498-3.403.0067-6.156 2.771-6.1496 6.1738M8 12.0077a4 4 0 1 1 4.008 3.9921A3.9996 3.9996 0 0 1 8 12.0077' },
  x: { color: '#000000', glyph: 'M14.234 10.162 22.977 0h-2.072l-7.591 8.824L7.251 0H.258l9.168 13.343L.258 24H2.33l8.016-9.318L16.749 24h6.993zm-2.837 3.299-.929-1.329L3.076 1.56h3.182l5.965 8.532.929 1.329 7.754 11.09h-3.182z' },
  email: { color: '#5B7083', glyph: 'M2 4h20a2 2 0 0 1 2 2v12a2 2 0 0 1-2 2H2a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2zm0 2v.5l10 6.25L22 6.5V6zm20 2.86-9.47 5.92a1 1 0 0 1-1.06 0L2 8.86V18h20z' },
  calendar: { color: '#7E57C2', glyph: 'M7 1h2v2h6V1h2v2h2a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h2V1zM5 9v10h14V9H5zm2 2h4v4H7v-4z' },
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
 * A mark from the notification (docs/notifications.md), by its tier: an alert ('push') can be said to be not urgent,
 * a Conversation ('quiet') that it should have alerted, a list row ('digest') that there should be less like it or
 * that it should have alerted. Each action is what it tells the hub (POST /api/messages/:id/feedback).
 */
const MARKS = {
  wrong: { title: 'Not urgent', body: { alert: false } },
  alert: { title: 'Should have alerted', body: { alert: true } },
  less: { title: 'Less like this', body: { less: true } },
};
const TIER_MARKS = { push: ['wrong'], quiet: ['alert'], digest: ['less', 'alert'] };

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
  const tag = cal ? `calendar:${cal.eventKey}` : d.conversationId ?? (d.requestId ? `request:${d.requestId}` : d.inbox ? 'dither-inbox' : 'dither');
  const look = await looks(d);
  // Its tier (docs/notifications.md): an alert, a Conversation or a list row. A hub from before the tiers says only
  // `level`: 'quiet' for what is silent, else an alert.
  const tier = d.tier ?? (d.level === 'quiet' ? 'quiet' : 'push');
  const reply = d.conversationId && d.canReply && CAN_REPLY ? [{ action: 'reply', type: 'text', title: 'Reply', placeholder: 'Message' }] : [];
  // Mail takes only "Less like this" (docs/mail.md).
  const marks = (d.messageId ? TIER_MARKS[tier] ?? [] : []).filter((a) => !d.mailThreadId || a === 'less').map((a) => ({ action: a, title: MARKS[a].title }));
  // A browser shows two actions: Reply and the mark for an alert or a Conversation, both marks for a list row.
  const actions = cal ? (cal.meetingUrl ? [{ action: 'join', title: 'Join' }] : []) : d.conversationId ? (tier === 'digest' ? [...marks, ...reply] : [...reply, ...marks, ...(marks.length ? [] : [{ action: 'open', title: 'Open' }])]) : [];
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
    data: { conversationId: d.conversationId, request: d.requestId, notice: d.noticeId, inbox: d.inbox, test: d.test, replyTo: d.replyTo, nid: d.nid, device: d.device, messageId: d.messageId, calendar: cal },
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
  const mark = Object.hasOwn(MARKS, e.action) ? MARKS[e.action] : null;
  if (mark && mid) {
    e.notification.close();
    e.waitUntil(fetch(`/api/messages/${encodeURIComponent(mid)}/feedback`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(mark.body) }).catch(() => {}));
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
