/**
 * Coming back without starting over (docs/sync.md), in a real browser against a demo hub:
 *
 *   - a short drop is not shown, and the app catches up with one POST /api/sync: no bootstrap, no timeline page;
 *   - what changed meanwhile (a message in the open conversation) shows up from that delta;
 *   - a long drop shows the small notice, and it goes once the hub is back;
 *   - a send without the hub waits, says so, and goes out by itself when the hub is back;
 *   - a cold start from the device's snapshot resumes with a delta too;
 *   - with --restart, a restarted hub (a deploy) is caught up from its journal as well.
 *
 *   bun scripts/verify-sync.ts http://127.0.0.1:8472 [--restart "<command that restarts that hub>"]
 *
 * Run it against a fresh demo hub, never a real one: it sends messages.
 */
import { launch } from './browser.ts';

const args = process.argv.slice(2);
const base = args.find((a) => /^https?:/.test(a));
if (!base) throw new Error('usage: bun scripts/verify-sync.ts <hub url> [--restart "<command>"]');
const ri = args.indexOf('--restart');
const restart = ri >= 0 ? args[ri + 1] : null;

let failed = 0;
const check = (name: string, ok: boolean, detail: unknown = '') => {
  if (!ok) failed++;
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail !== '' ? `  ${typeof detail === 'string' ? detail : JSON.stringify(detail)}` : ''}`);
};

const hub = async <T = any>(path: string, body?: unknown): Promise<T> => {
  const r = await fetch(base + path, body === undefined ? {} : { method: 'POST', body: JSON.stringify(body), headers: { 'content-type': 'application/json' } });
  if (!r.ok) throw new Error(`${path}: ${r.status}`);
  return r.json() as Promise<T>;
};

// A direct conversation one of the demo accounts can send in.
const boot = await hub('/api/bootstrap');
const sender = new Set(boot.accounts.filter((a: any) => a.status === 'online' && a.capabilities.includes('send')).map((a: any) => a.id));
const conv = boot.conversations.find((c: any) => c.shape === 'direct' && c.vantages.some((v: any) => sender.has(v.accountId)));
if (!conv) throw new Error('no direct conversation to send in');

const { page, close } = await launch();
await page.size(1200, 800);

// Every request, with its bytes on the wire.
const reqs = new Map<string, string>();
const done: { url: string; bytes: number; at: number }[] = [];
page.on('Network.requestWillBeSent', (p) => reqs.set(p.requestId, p.request.url.replace(base, '')));
page.on('Network.loadingFinished', (p) => reqs.has(p.requestId) && done.push({ url: reqs.get(p.requestId)!, bytes: p.encodedDataLength, at: Date.now() }));
const since = (t: number, re: RegExp) => done.filter((d) => d.at >= t && re.test(d.url));
const bytes = (xs: { bytes: number }[]) => xs.reduce((n, x) => n + x.bytes, 0);
const offline = (on: boolean) => page.send('Network.emulateNetworkConditions', { offline: on, latency: 0, downloadThroughput: -1, uploadThroughput: -1 });
const freshCount = () => page.eval<number>(`performance.getEntriesByName('dither:fresh').length`);
const notice = () => page.eval<boolean>(`!!document.querySelector('.reconnect')`);
const shown = (text: string) => page.eval<boolean>(`[...document.querySelectorAll('.timeline-scroll .msg-body')].some(e => e.textContent.includes(${JSON.stringify(text)}))`);
/** Coming back to the app: what a phone does when it is switched back to. */
const wake = () => page.eval(`window.dispatchEvent(new Event('online')), document.dispatchEvent(new Event('visibilitychange'))`);

// ------------------------------------------------------------------ first start, from the hub

await page.goto(`${base}/#/inbox/c/${conv.id}`);
await page.until(`performance.getEntriesByName('dither:fresh').length > 0 && !!document.querySelector('.timeline-scroll .msg')`, 15000);
check('a first start loads from the hub', since(0, /\/api\/bootstrap/).length === 1);

// ------------------------------------------------------------------ a short drop

// What opening a conversation fetches in the background (its network's latest) is done before this starts.
await Bun.sleep(2500);
let t0 = Date.now();
let fresh = await freshCount();
await offline(true);
await wake();
// Long enough for the heartbeat to give the socket up, short enough not to be worth a word.
let noticed = false;
for (let i = 0; i < 17; i++) {
  await Bun.sleep(200);
  noticed ||= await notice();
}
await offline(false);
await wake();
await page.until(`performance.getEntriesByName('dither:fresh').length > ${fresh}`, 10000).catch(() => {});
for (let i = 0; i < 5; i++) {
  noticed ||= await notice();
  await Bun.sleep(100);
}
check('a short drop shows nothing', !noticed);
check('…and catches up with one delta', since(t0, /\/api\/sync/).length === 1 && !since(t0, /\/api\/(bootstrap|inbox)|\/messages/).length, done.filter((d) => d.at >= t0).map((d) => `${d.url.split('?')[0]} ${d.bytes} B`));
console.log(`      the delta: ${bytes(since(t0, /\/api\/sync/))} B on the wire`);

// ------------------------------------------------------------------ changes while away

t0 = Date.now();
fresh = await freshCount();
await offline(true);
await wake();
await Bun.sleep(3500);
const away = `while you were away ${Date.now().toString(36)}`;
await hub(`/api/conversations/${conv.id}/send`, { body: away });
await Bun.sleep(800);
check('nothing arrives while offline', !(await shown(away)));
await offline(false);
const back = Date.now();
await wake();
await page.until(`[...document.querySelectorAll('.timeline-scroll .msg-body')].some(e => e.textContent.includes(${JSON.stringify(away)}))`, 10000).then(
  () => check('a message sent meanwhile shows up from the delta', true, `${Date.now() - back} ms after the network came back`),
  () => check('a message sent meanwhile shows up from the delta', false),
);
check('…without a bootstrap or a timeline page', !since(t0, /\/api\/bootstrap|\/messages/).length, since(t0, /\/api\//).map((d) => d.url.split('?')[0]));
console.log(`      the delta: ${bytes(since(back, /\/api\/sync/))} B on the wire`);

// ------------------------------------------------------------------ a long drop

await offline(true);
await wake();
await Bun.sleep(8000);
check('a long drop shows the notice', await notice());
await offline(false);
await wake();
await page.until(`!document.querySelector('.reconnect')`, 10000).then(
  () => check('…which goes when the hub is back', true),
  () => check('…which goes when the hub is back', false),
);

// ------------------------------------------------------------------ sending without the hub

await offline(true);
await wake();
await Bun.sleep(300);
const queued = `sent offline ${Date.now().toString(36)}`;
await page.eval(`document.querySelector('.composer textarea').focus()`);
await page.send('Input.insertText', { text: queued });
await page.send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13, text: '\r' });
await page.send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13 });
await page.until(`[...document.querySelectorAll('.msg.pending.queued')].some(e => e.textContent.includes(${JSON.stringify(queued)}))`, 6000).then(
  () => check('a send without the hub waits, and says so', true),
  () => check('a send without the hub waits, and says so', false, page.eval(`document.querySelector('.msg.pending')?.textContent`)),
);
await page.until(`!!document.querySelector('.reconnect')`, 6000).then(
  () => check('…with the notice up', true),
  () => check('…with the notice up', false),
);
await offline(false);
await wake();
await page.until(`!document.querySelector('.msg.pending') && [...document.querySelectorAll('.timeline-scroll .msg-body')].some(e => e.textContent.includes(${JSON.stringify(queued)}))`, 12000).then(
  () => check('…and goes out by itself when the hub is back', true),
  () => check('…and goes out by itself when the hub is back', false),
);
const sends = await hub<any>(`/api/conversations/${conv.id}/messages?limit=60`).then((p) => p.messages.filter((m: any) => m.body === queued).length);
check('…once', sends === 1, sends);

// ------------------------------------------------------------------ a cold start from the snapshot

// The snapshot is written when the app goes out of sight.
await page.eval(`Object.defineProperty(document, 'visibilityState', { value: 'hidden', configurable: true }), document.dispatchEvent(new Event('visibilitychange'))`);
await Bun.sleep(1500);
t0 = Date.now();
await page.send('Page.reload');
await Bun.sleep(300);
await page.until(`performance.getEntriesByName('dither:fresh').length > 0`, 15000);
check('a cold start from the snapshot resumes with a delta', since(t0, /\/api\/sync/).length >= 1 && !since(t0, /\/api\/bootstrap/).length, since(t0, /\/api\//).map((d) => `${d.url.split('?')[0]} ${d.bytes} B`));
check('…and shows what was sent offline', await page.until(`[...document.querySelectorAll('.timeline-scroll .msg-body')].some(e => e.textContent.includes(${JSON.stringify(queued)}))`, 8000).then(() => true, () => false));

// ------------------------------------------------------------------ a restarted hub

if (restart) {
  fresh = await freshCount();
  t0 = Date.now();
  const r = Bun.spawnSync(['sh', '-c', restart], { stdout: 'inherit', stderr: 'inherit' });
  check('the hub restarted', r.exitCode === 0);
  const after = `after the restart ${Date.now().toString(36)}`;
  for (let i = 0; i < 50; i++) {
    if (await fetch(base + '/api/health').then((x) => x.ok, () => false)) break;
    await Bun.sleep(200);
  }
  await hub(`/api/conversations/${conv.id}/send`, { body: after });
  await page.until(`performance.getEntriesByName('dither:fresh').length > ${fresh}`, 20000).catch(() => {});
  check('a restarted hub is caught up from its journal', since(t0, /\/api\/sync/).length >= 1 && !since(t0, /\/api\/bootstrap/).length, since(t0, /\/api\//).map((d) => `${d.url.split('?')[0]} ${d.bytes} B`));
  check('…and what came after it shows', await page.until(`[...document.querySelectorAll('.timeline-scroll .msg-body')].some(e => e.textContent.includes(${JSON.stringify(after)}))`, 10000).then(() => true, () => false));
}

const errors = page.errors.filter((e) => !/ERR_INTERNET_DISCONNECTED|ERR_CONNECTION_REFUSED|WebSocket connection/.test(e));
check('no script errors', !errors.length, errors);
await close();
console.log(failed ? `${failed} failed` : 'all passed');
process.exit(failed ? 1 : 0);
