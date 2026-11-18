/**
 * Does the app start from what the device kept while the hub is out of reach, the first start after a deploy too, and
 * come back by itself when it cannot? A pass/fail check for CI (docs/testing.md "Startup"), in headless Chromium at a
 * phone's size against a demo hub on a fresh data dir and a free port:
 *
 * 1. Online, a load and a second one from the service worker, with a conversation opened: the snapshot and that
 *    conversation's kept page are written (src/snapshot.ts).
 * 2. A deploy (a new build id in sw.js) while every hashed file is gone from the hub and the HTTP cache is empty: the new
 *    worker can only install from the old build's cache, and once it takes over, its cache holds every file of the
 *    build (public/sw.js, vite.config.ts).
 * 3. The hub gone and the HTTP cache emptied again: a reload shows the conversation from the snapshot, every file
 *    from the worker's cache.
 * 4. A deploy that changed the protocol, the hub still gone: the snapshot and the pages were written by an older build
 *    (their schema stamped as another one's), and a reload still shows the conversation from them.
 * 5. A file the cache lost, the hub still gone: the start fails (dither:boot-failed in index.html). The hub back: the
 *    page comes back by itself, and the older snapshot is written again as this build's.
 *
 *   bun scripts/check-offline.ts [--web <built dist>] [--keep]     (bun run check:offline)
 *
 * Without --web it builds the web app first. It works on a copy of the build and a data dir in a temp dir, removed
 * afterwards (--keep keeps it).
 */
import { cpSync, mkdirSync, mkdtempSync, openSync, readdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { launch, type Page } from './browser.ts';

const args = process.argv.slice(2);
const opt = (k: string, d = '') => (args.includes(`--${k}`) ? args[args.indexOf(`--${k}`) + 1] : d);
const root = resolve(import.meta.dir, '..');

const t0 = performance.now();
const elapsed = () => `${((performance.now() - t0) / 1000).toFixed(1)} s`;
const work = mkdtempSync(join(tmpdir(), 'dither-check-offline-'));
const web = join(work, 'web');
const data = join(work, 'data');
let hub: ReturnType<typeof Bun.spawn> | undefined;
let browser: Awaited<ReturnType<typeof launch>> | undefined;
let failed = 0;

const check = (ok: boolean, what: string, detail?: unknown) => {
  if (!ok) failed++;
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${what}${detail !== undefined ? `  ${typeof detail === 'string' ? detail : JSON.stringify(detail)}` : ''} (${elapsed()})`);
};

function freePort(): number {
  const s = Bun.serve({ port: 0, hostname: '127.0.0.1', fetch: () => new Response() });
  const port = s.port!;
  s.stop(true);
  return port;
}

/** Files a cache lacks, for a line: how many, and the first few. */
const lacking = (files: string[], have: string[] | undefined) => {
  const gone = files.filter((f) => !have?.includes(f));
  return gone.length ? `${gone.length} missing: ${gone.slice(0, 4).join(' ')}${gone.length > 4 ? ' …' : ''}` : undefined;
};

/** Waits for `fn` to hold, by its deadline; the error says what it waited for. */
async function until(what: string, fn: () => Promise<unknown>, ms = 20_000) {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (await fn().catch(() => false)) return;
    await Bun.sleep(100);
  }
  throw new Error(`timed out: ${what}`);
}

const port = Number(opt('port')) || freePort();
const base = `http://127.0.0.1:${port}`;

async function startHub() {
  const log = openSync(join(work, 'hub.log'), 'a');
  // None of the caller's hub settings (a manager's address, a model): a demo hub alone.
  const env = Object.fromEntries(Object.entries(process.env).filter(([k]) => !k.startsWith('DITHER_')));
  hub = Bun.spawn(['bun', join(root, 'packages/hub/src/main.ts'), '--demo', '--data', data, '--port', String(port), '--host', '127.0.0.1', '--web', web], {
    env: { ...env, DITHER_DEMO_CHATTER: '0', DITHER_CATEGORY_MODEL: 'keyword', DITHER_CALENDAR_URL: 'off' },
    stdout: log,
    stderr: log,
  });
  await until('the hub to answer', async () => (await fetch(`${base}/api/health`)).ok, 30_000);
}

async function stopHub() {
  hub?.kill('SIGKILL');
  await hub?.exited;
  hub = undefined;
}

/** The shell caches the page sees: name → paths. */
const shellCaches = (p: Page) =>
  p.eval<Record<string, string[]>>(`(async () => {
    const out = {};
    for (const k of await caches.keys()) if (k.startsWith('dither-shell-')) out[k] = (await (await caches.open(k)).keys()).map((r) => new URL(r.url).pathname);
    return out;
  })()`);

/** What IndexedDB holds for a start: whether a snapshot is kept, and the kept pages' keys. */
const kept = (p: Page) =>
  p.eval<{ snapshot: boolean; pages: string[] } | null>(`new Promise((res) => {
    const q = indexedDB.open('dither-chat');
    q.onerror = () => res(null);
    q.onsuccess = () => {
      const d = q.result;
      try {
        const t = d.transaction(['snapshot', 'pages'], 'readonly');
        const a = t.objectStore('snapshot').get('last');
        const b = t.objectStore('pages').getAllKeys();
        t.oncomplete = () => (d.close(), res({ snapshot: !!a.result, pages: b.result.map(String) }));
        t.onerror = () => (d.close(), res(null));
      } catch {
        d.close();
        res(null);
      }
    };
  })`);

/** Stamps what IndexedDB keeps as another build's (a deploy that changed the protocol); resolves to how many records. */
const stampOlder = (p: Page) =>
  p.eval<number>(`new Promise((res, rej) => {
    const q = indexedDB.open('dither-chat');
    q.onerror = () => rej(q.error);
    q.onsuccess = () => {
      const d = q.result;
      const t = d.transaction(['snapshot', 'pages'], 'readwrite');
      let n = 0;
      for (const name of ['snapshot', 'pages']) {
        const st = t.objectStore(name);
        const c = st.openCursor();
        c.onsuccess = () => {
          const cur = c.result;
          if (!cur) return;
          if (cur.value && typeof cur.value === 'object' && 'schema' in cur.value) (cur.update({ ...cur.value, schema: 'older-build' }), n++);
          cur.continue();
        };
      }
      t.oncomplete = () => (d.close(), res(n));
      t.onerror = () => (d.close(), rej(t.error));
    };
  })`);
/** The kept snapshot's schema. */
const snapshotSchema = (p: Page) =>
  p.eval<string | null>(`new Promise((res) => {
    const q = indexedDB.open('dither-chat');
    q.onerror = () => res(null);
    q.onsuccess = () => {
      const d = q.result;
      const a = d.transaction('snapshot', 'readonly').objectStore('snapshot').get('last');
      a.onsuccess = () => (d.close(), res(a.result?.schema ?? null));
      a.onerror = () => (d.close(), res(null));
    };
  })`);

/** Reloads the page; `newPage` then holds only in the new document. */
async function reload(p: Page) {
  await p.eval('window.__checkOfflineOld = true');
  await p.send('Page.reload', { ignoreCache: false });
}
const newPage = (cond: string) => `!window.__checkOfflineOld && (${cond})`;

async function main() {
  // ------------------------------------------------------------------ the app and a hub
  const given = opt('web');
  if (given) cpSync(given, web, { recursive: true });
  else {
    const b = Bun.spawnSync(['bunx', '--bun', 'vite', 'build', '--outDir', web, '--emptyOutDir'], { cwd: join(root, 'packages/web'), stdout: 'pipe', stderr: 'pipe' });
    if (b.exitCode !== 0) throw new Error('web build failed:\n' + b.stderr.toString());
    console.log(`built the web app (${elapsed()})`);
  }
  mkdirSync(data, { mode: 0o700 });
  if ((await fetch(`${base}/api/health`).catch(() => null))?.ok) throw new Error(`something is already listening on ${port}`);
  await startHub();
  console.log(`demo hub on ${port} (${elapsed()})`);
  const boot = (await (await fetch(`${base}/api/bootstrap`)).json()) as { conversations: { id: string; lastMessageAt: number | null }[] };
  const conv = boot.conversations.filter((c) => c.lastMessageAt).sort((a, b) => b.lastMessageAt! - a.lastMessageAt!)[0]?.id;
  if (!conv) throw new Error('the demo world has no conversation with messages');

  const swFile = join(web, 'sw.js');
  const shell: string[] = JSON.parse(readFileSync(swFile, 'utf8').match(/const PRECACHE = '(.*)';/)![1].replace(/\\'/g, "'"));
  // Every file of the build: what sw.js lists, and every file in assets/ (an older sw.js listed only some).
  const every = [...new Set([...shell, '/index.html', ...readdirSync(join(web, 'assets')).filter((f) => !f.endsWith('.map')).map((f) => `/assets/${f}`)])];

  browser = await launch();
  const p = browser.page;
  await p.size(412, 915, true);
  // Every file a page asks for that does not come: phases 3 and 4 judge their own.
  const urls = new Map<string, string>();
  let lost: string[] = [];
  p.on('Network.requestWillBeSent', (e) => urls.set(e.requestId, e.request.url));
  p.on('Network.loadingFailed', (e) => !e.canceled && lost.push(new URL(urls.get(e.requestId) ?? 'about:blank').pathname));

  // ------------------------------------------------------------------ 1. online
  await p.goto(`${base}/`);
  await p.until(`!!document.querySelector('.app') && navigator.serviceWorker.getRegistration().then((r) => r?.active?.state === 'activated')`, 30_000);
  // The start every later one is: from the worker's cache.
  await reload(p);
  await p.until(newPage(`!!navigator.serviceWorker.controller && !!document.querySelector('.app')`), 20_000);
  await p.eval(`location.hash = '#/inbox/c/${conv}'`);
  await p.until(`document.querySelectorAll('.timeline-scroll .msg').length > 0`, 20_000);
  await until('the snapshot and the open conversation to be kept', async () => {
    const k = await kept(p);
    return k?.snapshot && k.pages.includes(`c:${conv}`);
  });
  check(true, 'online: the snapshot and the conversation are kept');
  const first = await shellCaches(p);
  const firstName = Object.keys(first)[0];
  check(Object.keys(first).length === 1 && every.every((f) => first[firstName].includes(f)), 'the first install keeps every file of the build', lacking(every, first[firstName]));

  // ------------------------------------------------------------------ 2. a deploy, with nothing hashed on the hub
  writeFileSync(swFile, readFileSync(swFile, 'utf8').replace(/const BUILD = '[^']*'/, `const BUILD = 'offline${Date.now().toString(36)}'`));
  renameSync(join(web, 'assets'), join(web, 'assets-away'));
  await p.send('Network.clearBrowserCache');
  /** The browser looks for a new worker and installs it: 'installed', or 'failed' when its install did. */
  const update = () =>
    p.eval<string>(`(async () => {
      const r = await navigator.serviceWorker.getRegistration();
      const found = new Promise((res) => r.addEventListener('updatefound', () => res(r.installing), { once: true }));
      await r.update();
      const w = r.waiting ?? r.installing ?? (await found);
      return new Promise((res) => {
        const look = () => (w.state === 'redundant' ? res('failed') : w.state !== 'installing' && w.state !== 'parsed' ? res('installed') : 0);
        w.addEventListener('statechange', look);
        look();
      });
    })()`);
  const installed = await update();
  check(installed === 'installed', "a new build installs from the old build's cache, with no hashed file on the hub", installed);
  renameSync(join(web, 'assets-away'), join(web, 'assets'));
  // Not a retry: with the files back on the hub, the deploy goes in as it would anyway, and the offline start after it
  // is checked all the same.
  if (installed !== 'installed' && (await update()) !== 'installed') throw new Error('the new build did not install with every file on the hub either');
  // As the reload bar does: it takes over, and once activated (the page has it as its controller a moment before), the
  // old build's cache is gone.
  await p.eval(`navigator.serviceWorker.getRegistration().then((r) => new Promise((res) => {
    const w = r.waiting;
    w.addEventListener('statechange', () => w.state === 'activated' && res());
    w.postMessage('skipWaiting');
  }))`);
  const after = await shellCaches(p);
  const name = Object.keys(after).find((k) => k !== firstName) ?? '';
  check(Object.keys(after).length === 1 && !!name, "once it takes over, only the new build's cache is left", Object.keys(after));
  check(every.every((f) => after[name]?.includes(f)), "the new build's cache holds every file of the build", lacking(every, after[name]));

  // ------------------------------------------------------------------ 3. the hub gone, the HTTP cache empty
  await stopHub();
  await p.send('Network.clearBrowserCache');
  lost = [];
  await reload(p);
  try {
    await p.until(
      newPage(
        `!!document.querySelector('.app') && document.querySelectorAll('.timeline-scroll .msg').length > 0 && performance.getEntriesByName('dither:content')[0]?.detail?.source === 'snapshot'`,
      ),
      20_000,
    );
    check(true, 'offline after the deploy: the conversation shows, from the snapshot');
  } catch {
    const state = await p.eval(`({ logo: !!document.getElementById('boot-static'), app: !!document.querySelector('.app'), failed: performance.getEntriesByName('dither:boot-failed').length > 0 })`).catch(() => null);
    check(false, 'offline after the deploy: the conversation shows, from the snapshot', { state, lost: lost.filter((f) => f.startsWith('/assets/')) });
  }
  check(!lost.some((f) => f.startsWith('/assets/') || f === '/'), "every file of the app came from the worker's cache", lost.filter((f) => f.startsWith('/assets/') || f === '/'));

  // ------------------------------------------------------------------ 4. a deploy that changed the protocol, offline
  const stamped = await stampOlder(p);
  check(stamped >= 2, 'the snapshot and the pages are stamped as an older build’s', stamped);
  await reload(p);
  try {
    await p.until(
      newPage(
        `!!document.querySelector('.app') && document.querySelectorAll('.timeline-scroll .msg').length > 0 && performance.getEntriesByName('dither:content')[0]?.detail?.source === 'older snapshot'`,
      ),
      20_000,
    );
    check(true, 'offline after a deploy that changed the protocol: the conversation shows, from the older snapshot');
  } catch {
    const state = await p.eval(`({ logo: !!document.getElementById('boot-static'), app: !!document.querySelector('.app'), source: performance.getEntriesByName('dither:content')[0]?.detail?.source ?? null })`).catch(() => null);
    check(false, 'offline after a deploy that changed the protocol: the conversation shows, from the older snapshot', state);
  }
  // Views that ask the hub, which is gone: a request that fails is not the older snapshot failing to draw, so it stays.
  await p.eval('window.__checkOfflineStay = true');
  for (const hash of ['#/settings', '#/search?q=a']) {
    lost = [];
    await p.eval(`location.hash = ${JSON.stringify(hash)}`);
    await until(`${hash} to ask the hub`, async () => lost.some((f) => f.startsWith('/api/')));
  }
  const stayed = await p.eval<boolean>('window.__checkOfflineStay === true');
  const schema = await snapshotSchema(p);
  check(stayed && schema === 'older-build', 'requests that fail while it shows (Settings, Search) leave the older snapshot alone', { reloaded: !stayed, schema });

  // ------------------------------------------------------------------ 5. a file the cache lost, then the hub back
  const html = readFileSync(join(web, 'index.html'), 'utf8');
  // A file the app's script imports: index.html preloads them.
  const gone = html.match(/<link rel="modulepreload"[^>]* href="(\/assets\/[^"]+)"/)?.[1] ?? html.match(/<script type="module"[^>]* src="(\/assets\/[^"]+)"/)![1];
  await p.eval(`(async () => { for (const k of await caches.keys()) await (await caches.open(k)).delete(${JSON.stringify(gone)}); })()`);
  await p.send('Network.clearBrowserCache');
  await reload(p);
  await p.until(newPage(`performance.getEntriesByName('dither:boot-failed').length > 0 && !!document.getElementById('boot-static')`), 20_000);
  check(true, `without ${gone.replace('/assets/', '')} and the hub, the start fails and says so`);
  await startHub();
  // Its backoff starts at a second and doubles; the hub took about that to start.
  await p.until(newPage(`!!document.querySelector('.app') && performance.getEntriesByName('dither:fresh').length > 0`), 45_000);
  check(true, 'the hub back: the page comes back by itself, fresh from the hub');
  await until("the older snapshot written again as this build's", async () => {
    const schema = await snapshotSchema(p);
    return !!schema && schema !== 'older-build';
  });
  check(true, "the older snapshot is written again as this build's");
  await until(`${gone} kept again`, async () => (await shellCaches(p))[name]?.includes(gone));
  check(true, 'the file it lost is kept again');
}

try {
  await main();
} catch (e) {
  check(false, e instanceof Error ? e.message : String(e));
} finally {
  await browser?.close();
  await stopHub();
}
if (failed) {
  let log = '(none)';
  try {
    log = readFileSync(join(work, 'hub.log'), 'utf8').split('\n').slice(-20).join('\n');
  } catch {}
  console.log(`\noffline check failed (${elapsed()}). The hub's log ends:\n${log}`);
} else console.log(`\noffline check passed (${elapsed()})`);
if (args.includes('--keep')) console.log(`kept ${work}`);
else rmSync(work, { recursive: true, force: true });
process.exit(failed ? 1 : 0);
