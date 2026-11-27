/**
 * What the app says while it loads (docs/sync.md "What the inbox says", "Opening a chat"), in headless Chromium against
 * a demo hub of its own that it stops, restarts and starts again:
 *
 *   - opening a chat whose network is slow to answer: what the hub stored shows at once, the line over the message box
 *     fills, and past 1.5 s the row says "Waiting on Discord", in amber once well past its usual time; a chat whose hub
 *     page is slow says "Waiting on your hub"; no spinner in the middle of either;
 *   - the hub gone: beside "Inbox", the amber orb, "Offline", since when and the next try counted down; the list a shade
 *     quieter; a click there tries at once;
 *   - the hub stopping for a restart: "Hub restarting" beside "Inbox" at once (the hub says so before it stops), not
 *     "Offline", tried every second, then "Hub restarted · up to date"; the next restart says when it is likely back;
 *   - a first start with nothing kept, on a slow link: the orb fills as the inbox downloads, with its size.
 *
 *   bun scripts/verify-loading.ts [--shots <dir>]
 * Starts its own demo hub on a free port with a throwaway data dir. DITHER_WEB_DIST serves another web build.
 */
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { launch, type Page } from './browser.ts';

const REPO = resolve(import.meta.dir, '..');
const args = process.argv.slice(2);
const shotsDir = args.includes('--shots') ? resolve(args[args.indexOf('--shots') + 1]) : null;
if (shotsDir) mkdirSync(shotsDir, { recursive: true });
const data = mkdtempSync(join(tmpdir(), 'dither-loading-hub-'));
const port = await new Promise<number>((done) => {
  const s = Bun.listen({ hostname: '127.0.0.1', port: 0, socket: { data() {} } });
  const p = s.port;
  s.stop(true);
  done(p);
});
const url = `http://127.0.0.1:${port}`;
const web = process.env.DITHER_WEB_DIST ? ['--web', process.env.DITHER_WEB_DIST] : [];

let failed = 0;
const check = (ok: unknown, what: string, detail?: unknown) => {
  if (!ok) failed++;
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${what}${detail !== undefined ? `  ${JSON.stringify(detail)}` : ''}`);
};
const waitFor = (p: Page, expr: string, what: string, ms = 10_000) =>
  p.until(expr, ms).then(
    () => (check(true, what), true),
    () => (check(false, what), false),
  );

/** The same hub each time: its port and its data dir, so the page comes back to it. */
async function startHub() {
  const hub = Bun.spawn(['bun', 'packages/hub/src/main.ts', '--demo', '--data', data, '--port', String(port), '--host', '127.0.0.1', ...web], {
    cwd: REPO,
    env: { ...process.env, DITHER_CALENDAR_URL: 'off' },
    stdout: 'ignore',
    stderr: 'inherit',
  });
  for (let i = 0; i < 3000; i++) {
    if (await fetch(`${url}/api/health`).then((r) => r.ok, () => false)) return hub;
    await Bun.sleep(50);
  }
  throw new Error('the demo hub did not start');
}

let hub = await startHub();
const browser = await launch();
const p = browser.page;
const shot = async (page: Page, name: string) => shotsDir && (await page.shot(join(shotsDir, `${name}.png`)));
const status = (page: Page) => page.eval<string | null>(`document.querySelector('.inbox-status')?.textContent ?? null`);

/** Requests whose address has `part` in it are held this long before they go on (DevTools' Fetch domain). */
const held = new Map<string, number>();
p.on('Fetch.requestPaused', (e: any) => {
  const ms = [...held].find(([part]) => e.request.url.includes(part))?.[1] ?? 0;
  setTimeout(() => void p.send('Fetch.continueRequest', { requestId: e.requestId }).catch(() => {}), ms);
});
const hold = async (part: string, ms: number) => {
  held.set(part, ms);
  await p.send('Fetch.enable', { patterns: [...held.keys()].map((k) => ({ urlPattern: `*${k}*` })) });
};
const release = async () => {
  held.clear();
  await p.send('Fetch.disable');
};

try {
  const boot = await fetch(`${url}/api/bootstrap`).then((r) => r.json() as Promise<any>);
  const discord = boot.conversations.filter((c: any) => c.network === 'discord' && c.shape !== 'direct' && c.lastMessage);
  const others = boot.conversations.filter((c: any) => c.network !== 'discord' && c.lastMessage && c.shape === 'direct');
  if (discord.length < 1 || others.length < 1) throw new Error('the demo world has no Discord channel or direct chat with messages');

  // ------------------------------------------------------------------ a computer: opening chats
  // Nothing fetched ahead (prefetch.ts), so a chat not opened yet is one the hub has to answer for.

  await p.size(1280, 800);
  await p.goto(`${url}/?ahead=0#/inbox`);
  await p.until(`navigator.serviceWorker.getRegistration().then((r) => !!r?.active)`, 30_000);
  await p.goto(`${url}/?ahead=0#/inbox`);
  await p.until(`!!navigator.serviceWorker.controller && document.querySelectorAll('.inbox-side .row').length > 0`, 30_000);
  await waitFor(p, `!document.querySelector('.inbox-status')`, 'all well: nothing beside "Inbox" once caught up', 10_000);

  // Discord slow to give its latest: what the hub stored shows meanwhile.
  await hold('/history', 6000);
  await p.eval(`location.hash = '#/inbox/c/${discord[0].id}'`);
  await waitFor(p, `document.querySelectorAll('.timeline-scroll .msg').length > 0`, "opening a Discord chat: the hub's stored messages show while Discord is asked", 5000);
  await waitFor(p, `getComputedStyle(document.querySelector('.typing-bar .open-bar') ?? document.body).opacity > 0.9 && !!document.querySelector('.typing-bar .open-bar')`, '…the line over the message box shows', 3000);
  await waitFor(p, `/^Waiting on Discord · /.test(document.querySelector('.open-note')?.textContent ?? '')`, '…past 1.5 s the row says it waits on Discord', 4000);
  await waitFor(p, `document.querySelector('.open-note')?.classList.contains('slow') && /usually/.test(document.querySelector('.open-note').textContent)`, '…in amber with its usual time once well past it', 6000);
  // Older messages may load above, Discord's backfill too, with their own small orb; the open itself spins nowhere.
  const spin = await p.eval<string | null>(`[...document.querySelectorAll('.timeline-scroll .loading, .pane .loading')].map((e) => e.getAttribute('aria-label')).find((l) => l !== 'Loading older messages') ?? null`);
  check(!spin, '…no spinner for the open', spin);
  await shot(p, 'open-discord-slow');
  if (!(await waitFor(p, `!document.querySelector('.typing-bar .open-bar') && !document.querySelector('.open-note')`, 'Discord answers: the line and the words go', 8000)))
    console.log(await p.eval(`JSON.stringify({ bar: document.querySelector('.typing-bar .open-bar')?.outerHTML, note: document.querySelector('.open-note')?.textContent })`));
  await release();

  // The hub slow with a chat never opened: nothing to show, nothing spinning, and the row says it is the hub.
  await hold('/messages', 4000);
  await p.eval(`location.hash = '#/inbox/c/${others[0].id}'`);
  await waitFor(p, `/^Waiting on your hub · /.test(document.querySelector('.open-note')?.textContent ?? '')`, 'a chat never opened, the hub slow: the row says it waits on the hub', 4000);
  check(!(await p.eval<boolean>(`!!document.querySelector('.timeline-scroll .loading, .pane .loading')`)), '…no spinner in the pane');
  await shot(p, 'open-hub-slow');
  await waitFor(p, `document.querySelectorAll('.timeline-scroll .msg').length > 0 && !document.querySelector('.open-note')`, '…then its messages, and the words go', 8000);
  await release();

  // What the device keeps to start from, written when the app goes out of sight (snapshot.ts).
  await p.eval(`location.hash = '#/inbox'`);
  await p.eval(`Object.defineProperty(document, 'visibilityState', { value: 'hidden', configurable: true }), document.dispatchEvent(new Event('visibilitychange'))`);
  await Bun.sleep(1500);
  await p.eval(`Object.defineProperty(document, 'visibilityState', { value: 'visible', configurable: true }), document.dispatchEvent(new Event('visibilitychange'))`);

  // ------------------------------------------------------------------ the hub restarting

  hub.kill('SIGTERM');
  await waitFor(p, `document.querySelector('.inbox-status-title')?.textContent === 'Hub restarting'`, 'the hub stopping: "Hub restarting" beside "Inbox" at once', 2500);
  await hub.exited;
  await Bun.sleep(6000);
  check(!(await p.eval<boolean>(`!!document.querySelector('.inbox-side.offline, .rail .offline-orb')`)), '…not called offline after 6 s', await status(p));
  check(/^Hub restarting\d+ s$/.test((await status(p)) ?? ''), '…counting the seconds, no usual time yet', await status(p));
  await shot(p, 'desk-restarting');
  const down = Date.now();
  hub = await startHub();
  const up = Date.now();
  await waitFor(p, `document.querySelector('.inbox-status-title')?.textContent === 'Hub restarted'`, '…back: "Hub restarted · up to date" (the same code)', 15_000);
  const back = Date.now();
  check(back - up < 3000, '…within a couple of seconds of the hub answering (tried every second)', { ms: back - up, down: up - down });
  await shot(p, 'desk-restarted');
  await p.until(`!document.querySelector('.inbox-status')`, 8000).catch(() => {});

  // The next restart: the hub knows how long the last took.
  hub.kill('SIGTERM');
  await waitFor(p, `/^back in about \\d+ s$|longer than usual$/.test(document.querySelector('.inbox-status-more')?.textContent ?? '')`, 'the next restart says when the hub is likely back', 3000);
  await shot(p, 'desk-restart-usual');
  await hub.exited;
  hub = await startHub();
  await p.until(`document.querySelector('.inbox-status-title')?.textContent === 'Hub restarted'`, 15_000).catch(() => {});

  // ------------------------------------------------------------------ the hub gone

  hub.kill('SIGKILL');
  await hub.exited;
  const OFF = `document.querySelector('.inbox-status-title')?.textContent === 'Offline'`;
  await waitFor(p, OFF, 'the hub gone: "Offline" beside "Inbox"', 12_000);
  check(/^since .+ · (next try \d+ s|trying…)$/.test((await p.eval<string>(`document.querySelector('.inbox-status-more')?.textContent ?? ''`)) ?? ''), '…since when, and the next try', await status(p));
  check(await p.eval<boolean>(`!!document.querySelector('.inbox-status .offline-orb') && !!document.querySelector('.rail .offline-orb')`), "…the logo's amber orb, there and on the rail");
  check(await p.eval<boolean>(`getComputedStyle(document.querySelector('.inbox-side .side-scroll')).opacity > 0.85`), '…the list only a shade quieter');
  await Bun.sleep(500);
  const FITS = `(() => { const e = document.querySelector('.inbox-status-more'), t = document.querySelector('.inbox-status-title'); return e.scrollWidth <= e.clientWidth && t.scrollWidth <= t.clientWidth; })()`;
  check(await p.eval<boolean>(FITS), '…all of it fits beside "Inbox" on a computer', await status(p));
  await shot(p, 'desk-offline');
  await p.size(412, 915, true);
  await p.until(OFF, 5000).catch(() => {});
  check(await p.eval<boolean>(FITS), 'a phone beside a page: what fits beside "Inbox", since when left out', await status(p));
  await Bun.sleep(600);
  await shot(p, 'phone-offline');
  // Out of reach a while, the tries are seconds apart; a tap tries now, and the next one comes a second after.
  await p.until(`/next try ([3-9]|\\d\\d) s/.test(document.querySelector('.inbox-status-more')?.textContent ?? '')`, 20_000).catch(() => {});
  const seen = await p.eval<string[]>(`new Promise((done) => { const said = [document.querySelector('.inbox-status')?.textContent]; const o = new MutationObserver(() => said.push(document.querySelector('.inbox-status')?.textContent)); o.observe(document.querySelector('.inbox-head'), { subtree: true, childList: true, characterData: true }); document.querySelector('button.inbox-status').click(); setTimeout(() => (o.disconnect(), done(said)), 1500); })`);
  check(seen.some((t) => /Trying your hub…|next try 1 s|trying…/.test(t ?? '')), 'a tap there tries at once', seen);
  hub = await startHub();
  await waitFor(p, `!document.querySelector('.inbox-side.offline') && document.querySelector('.inbox-status-title')?.textContent !== 'Offline'`, 'the hub back: no longer offline', 20_000);
  await browser.close();

  // ------------------------------------------------------------------ a first start, nothing kept, a slow link

  const fresh = await launch();
  const f = fresh.page;
  await f.size(412, 915, true);
  // Every word the start screen says, as it says it.
  await f.send('Page.addScriptToEvaluateOnNewDocument', {
    source: `window.__said = []; new MutationObserver(() => { const t = document.querySelector('.boot-status')?.textContent; if (t && window.__said.at(-1) !== t) window.__said.push(t); }).observe(document, { subtree: true, childList: true, characterData: true });`,
  });
  // The demo's inbox is small and the app's code is not: the bootstrap is held until the start screen is up, then comes
  // over a slow link, as a real inbox of megabytes does after the code (the slow-link probe).
  const paused: string[] = [];
  f.on('Fetch.requestPaused', (e: any) => void paused.push(e.requestId));
  await f.send('Fetch.enable', { patterns: [{ urlPattern: '*/api/bootstrap*' }] });
  await f.goto(`${url}/#/inbox`);
  await f.until(`!!document.querySelector('.boot-status') && document.querySelector('.boot-status').textContent !== 'Connecting to your hub…'`, 60_000).catch(() => {});
  await f.send('Network.emulateNetworkConditions', { offline: false, latency: 150, downloadThroughput: (40 * 1000) / 8, uploadThroughput: (40 * 1000) / 8 });
  for (let i = 0; i < 100 && !paused.length; i++) await Bun.sleep(100);
  for (const id of paused.splice(0)) await f.send('Fetch.continueRequest', { requestId: id });
  await f.send('Fetch.disable');
  await f.until(`/^Downloading your inbox · [\\d.]+ of/.test(document.querySelector('.boot-status')?.textContent ?? '')`, 30_000).catch(() => {});
  await Bun.sleep(800);
  await shot(f, 'first-start');
  await waitFor(f, `document.querySelectorAll('.inbox-side .row').length > 0`, 'a first start on a slow link: then the list', 120_000);
  const said = await f.eval<string[]>('window.__said');
  check(said.some((t) => /^Downloading your inbox · [\d.]+ of [\d.]+ [KM]B$/.test(t)), '…on the way, "Downloading your inbox · x of y KB"', said);
  check(said.at(-1) === 'Setting it up on this device…', '…and last, setting it up', said.at(-1));
  check(!f.errors.length, 'no errors on the page', f.errors.slice(0, 3));
  await fresh.close();
  check(!p.errors.filter((e) => !/Failed to load resource|ERR_CONNECTION_REFUSED|WebSocket/.test(e)).length, 'no errors on the first page', p.errors.slice(0, 3));
} finally {
  hub.kill('SIGKILL');
  await hub.exited;
  await browser.close().catch(() => {});
  rmSync(data, { recursive: true, force: true });
}
console.log(failed ? `${failed} failed` : 'all ok');
process.exit(failed ? 1 : 0);
