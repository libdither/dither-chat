/**
 * Does the built web app start? A pass/fail check for CI (docs/testing.md): build the web app, start a demo hub on a
 * fresh data dir, and load it in headless Chromium at a desktop's size and then a phone's: the inbox list shows, a
 * conversation opens, Settings opens. It fails on any uncaught error on the page, any console.error, any request that
 * fails (but those in EXPECTED, each with its reason), and a service worker that does not register.
 *
 *   bun scripts/check-boot.ts [--port <port>] [--web <built dist>] [--keep]     (bun run check:boot)
 *
 * Without --port the OS picks a free one. Everything it makes is in a temp dir, removed afterwards (--keep keeps it).
 */
import { mkdirSync, mkdtempSync, openSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { findBrowser, launch, type Page } from './browser.ts';

const args = process.argv.slice(2);
const opt = (k: string, d = '') => (args.includes(`--${k}`) ? args[args.indexOf(`--${k}`) + 1] : d);
const root = resolve(import.meta.dir, '..');

/**
 * Requests that may fail on a healthy start, by path, and why. Matched against "<status> <path>" (or
 * "<net error> <path>" for one that got no answer).
 */
const EXPECTED: { match: RegExp; why: string }[] = [];

const t0 = performance.now();
const elapsed = () => `${((performance.now() - t0) / 1000).toFixed(1)} s`;
const work = mkdtempSync(join(tmpdir(), 'dither-check-boot-'));
let hub: ReturnType<typeof Bun.spawn> | undefined;
let browser: Awaited<ReturnType<typeof launch>> | undefined;
const problems: string[] = [];
/** Which size is loading now, for the problems' lines. */
let stage = 'start';

function freePort(): number {
  const s = Bun.serve({ port: 0, hostname: '127.0.0.1', fetch: () => new Response() });
  const port = s.port!;
  s.stop(true);
  return port;
}

async function until(what: string, fn: () => Promise<unknown>, ms = 20_000) {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (await fn().catch(() => false)) return;
    await Bun.sleep(100);
  }
  const at = await browser?.page.eval<string>('location.href').catch(() => null);
  throw new Error(`timed out: ${what}${at ? ` (the page is at ${at})` : ''}`);
}

/** Every error the page shows, failed request and console.error, as one line each. */
function watch(page: Page, base: string) {
  const urls = new Map<string, string>();
  const say = (what: string) => problems.push(`${stage}: ${what}`);
  page.on('Runtime.exceptionThrown', (p) => say(`page error: ${p.exceptionDetails?.exception?.description ?? p.exceptionDetails?.text}`));
  page.on('Runtime.consoleAPICalled', (p) => {
    if (p.type === 'error' || p.type === 'assert') say(`console.${p.type}: ${p.args.map((a: any) => a.value ?? a.description ?? a.type).join(' ')}`);
  });
  // Failed requests are reported below with their path; the console's own line for one would say it twice.
  page.on('Log.entryAdded', (p) => p.entry.level === 'error' && p.entry.source !== 'network' && say(`${p.entry.source}: ${p.entry.text}`));
  page.on('Network.requestWillBeSent', (p) => urls.set(p.requestId, p.request.url));
  const failed = (status: string, url: string) => {
    const u = new URL(url);
    const line = `${status} ${u.origin === base ? u.pathname : u.origin + u.pathname}`;
    if (!EXPECTED.some((e) => e.match.test(line))) say(`request failed: ${line}`);
  };
  page.on('Network.responseReceived', (p) => p.response.status >= 400 && failed(String(p.response.status), p.response.url));
  // A request the page itself gave up (a navigation away, an aborted fetch) is not a failure.
  page.on('Network.loadingFailed', (p) => !p.canceled && failed(p.errorText, urls.get(p.requestId) ?? '?'));
}

/**
 * A click as the page would get it from a person: on the middle of the first match that is on screen and not under
 * anything else there.
 */
async function click(page: Page, sel: string, what: string) {
  const find = `(() => {
    for (const e of document.querySelectorAll(${JSON.stringify(sel)})) {
      const b = e.getBoundingClientRect();
      const x = b.x + b.width / 2, y = b.y + b.height / 2;
      if (b.width > 0 && x >= 0 && y >= 0 && x < innerWidth && y < innerHeight && e.contains(document.elementFromPoint(x, y))) return { x, y };
    }
    return null;
  })()`;
  let at: { x: number; y: number } | null = null;
  await until(`${what} (${sel})`, async () => (at = await page.eval(find)));
  for (const type of ['mousePressed', 'mouseReleased']) await page.send('Input.dispatchMouseEvent', { type, x: at!.x, y: at!.y, button: 'left', clickCount: 1 });
}

async function main() {
  // ------------------------------------------------------------------ the app and a hub
  let web = opt('web');
  if (!web) {
    web = join(work, 'web');
    const b = Bun.spawnSync(['bunx', '--bun', 'vite', 'build', '--outDir', web, '--emptyOutDir'], { cwd: join(root, 'packages/web'), stdout: 'pipe', stderr: 'pipe' });
    if (b.exitCode !== 0) throw new Error('web build failed:\n' + b.stderr.toString());
    console.log(`built the web app (${elapsed()})`);
  }
  const port = Number(opt('port')) || freePort();
  const base = `http://127.0.0.1:${port}`;
  if ((await fetch(`${base}/api/health`).catch(() => null))?.ok) throw new Error(`something is already listening on ${port}`);
  const data = join(work, 'data');
  mkdirSync(data, { mode: 0o700 });
  const log = openSync(join(work, 'hub.log'), 'a');
  // None of the caller's hub settings (a manager's address, a model): a demo hub alone.
  const env = Object.fromEntries(Object.entries(process.env).filter(([k]) => !k.startsWith('DITHER_')));
  hub = Bun.spawn(['bun', join(root, 'packages/hub/src/main.ts'), '--demo', '--data', data, '--port', String(port), '--host', '127.0.0.1', '--web', web], {
    env: { ...env, DITHER_DEMO_CHATTER: '0', DITHER_CATEGORY_MODEL: 'keyword' },
    stdout: log,
    stderr: log,
  });
  await until('the hub to answer', async () => (await fetch(`${base}/api/health`)).ok, 30_000);
  console.log(`demo hub on ${port} (${elapsed()})`);

  // ------------------------------------------------------------------ the browser, at two sizes
  const browserPath = findBrowser();
  console.log(`browser: ${Bun.spawnSync([browserPath, '--version']).stdout.toString().trim() || browserPath}`);
  browser = await launch();
  const page = browser.page;
  watch(page, base);
  for (const [size, w, h, phone] of [
    ['desktop', 1280, 800, false],
    ['phone', 390, 844, true],
  ] as const) {
    const before = problems.length;
    stage = size;
    await page.size(w, h, phone);
    // A load of its own, not a change of hash; the second comes from the service worker the first one installed.
    await page.goto('about:blank');
    await page.goto(`${base}/#/inbox`);
    await until(`${size}: the inbox list`, () => page.eval(`!!document.querySelector('.sidebar .conv-row')`));
    await click(page, '.sidebar .conv-row', `${size}: a conversation in the list`);
    await until(`${size}: a conversation's messages`, () => page.eval(`location.hash.startsWith('#/inbox/c/') && !!document.querySelector('.timeline-scroll .msg')`));
    if (phone) {
      await click(page, '.icon-btn.back', `${size}: back from the conversation`);
      await click(page, '.tabbar button[data-track="tabs: You"]', `${size}: the You tab`);
    } else await click(page, '.rail-btn[data-track="settings"]', `${size}: Settings on the rail`);
    await until(`${size}: Settings`, () => page.eval(`location.hash === '#/settings' && !!document.querySelector('.settings-scroll')`));
    if (size === 'desktop') {
      await until('the service worker to register and activate', () => page.eval(`navigator.serviceWorker.getRegistration().then((r) => !!r?.active)`), 15_000).catch((e) => {
        problems.push(`desktop: ${e.message}`);
      });
    } else if (!(await page.eval<boolean>('!!navigator.serviceWorker.controller'))) problems.push('phone: the page is not controlled by the service worker');
    // Errors that come a little after (a chunk loaded late, a refresh).
    await Bun.sleep(1000);
    console.log(`${problems.length > before ? 'FAIL' : 'ok  '} ${size} ${w}x${h}: inbox, a conversation, Settings (${elapsed()})`);
  }
}

let code = 1;
try {
  await main();
  code = problems.length ? 1 : 0;
} catch (e) {
  problems.push(e instanceof Error ? e.message : String(e));
} finally {
  await browser?.close();
  hub?.kill('SIGTERM');
  await hub?.exited;
}
for (const p of problems) console.log(`  ${p}`);
if (problems.length) {
  const log = (() => {
    try {
      return readFileSync(join(work, 'hub.log'), 'utf8').split('\n').slice(-20).join('\n');
    } catch {
      return '(none)';
    }
  })();
  console.log(`\nboot check failed (${elapsed()}). The hub's log ends:\n${log}`);
} else console.log(`\nboot check passed (${elapsed()})`);
if (args.includes('--keep')) console.log(`kept ${work}`);
else rmSync(work, { recursive: true, force: true });
process.exit(code);
