/**
 * Sends that are kept and matched by id (packages/web/src/outbox.ts, docs/sync.md), in a real browser against a demo
 * hub:
 *
 *   - a send shows one pending copy, and then exactly one message: the hub's answer names it (messageId), and the
 *     copy goes when that message is here, not when some message with the same text is;
 *   - two identical sends in a row are two messages, each copy replaced by its own;
 *   - with the hub stopped, a send waits; it survives a reload (the app comes from its cache), and goes out once
 *     when the hub is back; a reload after that does not bring it back.
 *
 *   bun scripts/verify-sends.ts http://127.0.0.1:8731 --stop "<command that stops that hub>" --start "<command that starts it>"
 *
 * Run it against a fresh demo hub, never a real one: it sends messages, and stops and starts the hub.
 */
import { launch } from './browser.ts';

const args = process.argv.slice(2);
const base = args.find((a) => /^https?:/.test(a));
const arg = (k: string) => (args.indexOf(k) >= 0 ? args[args.indexOf(k) + 1] : null);
const stop = arg('--stop');
const start = arg('--start');
if (!base || !stop || !start) throw new Error('usage: bun scripts/verify-sends.ts <hub url> --stop "<command>" --start "<command>"');

let failed = 0;
const check = (name: string, ok: boolean, detail: unknown = '') => {
  if (!ok) failed++;
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail !== '' ? `  ${typeof detail === 'string' ? detail : JSON.stringify(detail)}` : ''}`);
};
const hub = async <T = any>(path: string): Promise<T> => {
  const r = await fetch(base + path);
  if (!r.ok) throw new Error(`${path}: ${r.status}`);
  return r.json() as Promise<T>;
};
const sh = (cmd: string) => Bun.spawnSync(['sh', '-c', cmd], { stdout: 'inherit', stderr: 'inherit' }).exitCode === 0;

const boot = await hub('/api/bootstrap');
if (!boot.accounts.every((a: any) => a.demo)) throw new Error('not a demo hub');
// A direct conversation one of the demo accounts can send in; the demo answers each message there.
const sender = new Set(boot.accounts.filter((a: any) => a.status === 'online' && a.capabilities.includes('send')).map((a: any) => a.id));
const conv = boot.conversations.find((c: any) => c.shape === 'direct' && c.vantages.some((v: any) => sender.has(v.accountId)));
if (!conv) throw new Error('no direct conversation to send in');
const stored = async (body: string) => (await hub(`/api/conversations/${conv.id}/messages?limit=60`)).messages.filter((m: any) => m.body === body).length;

const { page, close } = await launch();
await page.size(1200, 800);

// The answers to sends, as the app got them.
const sendReqs = new Set<string>();
const answers: any[] = [];
page.on('Network.requestWillBeSent', (p) => /\/api\/conversations\/[^/]+\/send$/.test(p.request.url) && sendReqs.add(p.requestId));
page.on('Network.loadingFinished', (p) => {
  if (!sendReqs.has(p.requestId)) return;
  page.send('Network.getResponseBody', { requestId: p.requestId }).then(
    (r: any) => answers.push(JSON.parse(r.body)),
    () => {},
  );
});

const counts = (text: string) =>
  page.eval<{ real: number; pending: number; queued: number }>(`(() => {
    const t = ${JSON.stringify(text)};
    const real = [...document.querySelectorAll('.timeline-scroll .msg:not(.pending) .msg-body')].filter(e => e.textContent.trim() === t).length;
    const ps = [...document.querySelectorAll('.timeline-scroll .msg.pending')].filter(e => e.querySelector('.msg-body')?.textContent.trim() === t);
    return { real, pending: ps.length, queued: ps.filter(e => e.classList.contains('queued')).length };
  })()`);
const typeAndSend = async (text: string) => {
  await page.eval(`document.querySelector('.composer textarea').focus()`);
  await page.send('Input.insertText', { text });
  await page.send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13, text: '\r' });
  await page.send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13 });
};

try {
  await page.goto(`${base}/#/inbox/c/${conv.id}`);
  await page.until(`!!navigator.serviceWorker?.controller && performance.getEntriesByName('dither:fresh').length > 0 && !!document.querySelector('.timeline-scroll .msg')`, 20000);

  // ------------------------------------------------------------------ one send, one message

  const one = `just once ${Date.now().toString(36)}`;
  await typeAndSend(one);
  const seen: { real: number; pending: number }[] = [];
  const end = Date.now() + 8000;
  while (Date.now() < end) {
    seen.push(await counts(one));
    await Bun.sleep(100);
  }
  const last = seen[seen.length - 1];
  check('a send shows its copy at once', seen.slice(0, 3).some((c) => c.pending + c.real === 1), seen.slice(0, 3));
  check('…then exactly one message, and no copy', last.real === 1 && last.pending === 0, last);
  check('…never two of it at once for more than a moment', seen.filter((c) => c.real + c.pending > 1).length <= 2, seen.filter((c) => c.real + c.pending > 1).length);
  const answer = answers.find((a) => a?.ok);
  const msgId = await page.eval<string | null>(`[...document.querySelectorAll('.timeline-scroll .msg:not(.pending)')].find(e => e.querySelector('.msg-body')?.textContent.trim() === ${JSON.stringify(one)})?.id?.replace(/^m-/, '') ?? null`);
  check("the hub's answer names the message it became", !!answer?.messageId && answer.messageId === msgId, { answer: answer?.messageId, shown: msgId });
  check('…stored once', (await stored(one)) === 1);

  // ------------------------------------------------------------------ the same text twice

  const twice = `twice ${Date.now().toString(36)}`;
  await typeAndSend(twice);
  await typeAndSend(twice);
  // By text, the first message took both copies, and for a moment the second send looked lost.
  const both: number[] = [];
  for (let i = 0; i < 30; i++) {
    const c = await counts(twice);
    both.push(c.real + c.pending);
    await Bun.sleep(100);
  }
  const from = both.indexOf(2);
  check('two identical sends: two on screen all along, never one', from >= 0 && both.slice(from).every((n) => n === 2), both.join(''));
  await page.until(`(() => { const t = ${JSON.stringify(twice)}; return [...document.querySelectorAll('.timeline-scroll .msg:not(.pending) .msg-body')].filter(e => e.textContent.trim() === t).length === 2 && ![...document.querySelectorAll('.timeline-scroll .msg.pending')].length; })()`, 10000).then(
    () => check('two identical sends are two messages, each copy replaced by its own', true),
    async () => check('two identical sends are two messages, each copy replaced by its own', false, await counts(twice)),
  );
  check('…stored twice', (await stored(twice)) === 2);

  // ------------------------------------------------------------------ the hub stopped: kept across a reload

  // The snapshot (what a start without the hub shows) is written when the app goes out of sight.
  await page.eval(`Object.defineProperty(document, 'visibilityState', { value: 'hidden', configurable: true }), document.dispatchEvent(new Event('visibilitychange'))`);
  await Bun.sleep(1500);
  await page.eval(`Object.defineProperty(document, 'visibilityState', { value: 'visible', configurable: true }), document.dispatchEvent(new Event('visibilitychange'))`);
  check('the hub stopped', sh(stop));
  await page.eval(`window.dispatchEvent(new Event('online'))`);
  await Bun.sleep(1500);
  const kept = `kept across a reload ${Date.now().toString(36)}`;
  await typeAndSend(kept);
  await page.until(`[...document.querySelectorAll('.msg.pending.queued')].some(e => e.textContent.includes(${JSON.stringify(kept)}))`, 8000).then(
    () => check('without the hub, a send waits, and says so', true),
    async () => check('without the hub, a send waits, and says so', false, await counts(kept)),
  );
  await Bun.sleep(500);
  await page.send('Page.reload');
  await Bun.sleep(500);
  await page.until(`[...document.querySelectorAll('.msg.pending.queued')].some(e => e.textContent.includes(${JSON.stringify(kept)}))`, 15000).then(
    () => check('…after a reload with the hub still down, it is still there, still waiting', true),
    async () => check('…after a reload with the hub still down, it is still there, still waiting', false, await counts(kept).catch((e) => String(e))),
  );
  check('the hub started again', sh(start));
  await page.eval(`window.dispatchEvent(new Event('online'))`);
  await page.until(`(() => { const t = ${JSON.stringify(kept)}; return [...document.querySelectorAll('.timeline-scroll .msg:not(.pending) .msg-body')].some(e => e.textContent.trim() === t) && ![...document.querySelectorAll('.timeline-scroll .msg.pending')].length; })()`, 30000).then(
    () => check('…and goes out by itself once the hub is back', true),
    async () => check('…and goes out by itself once the hub is back', false, await counts(kept)),
  );
  await Bun.sleep(1000);
  check('…once', (await stored(kept)) === 1, await stored(kept));
  await page.send('Page.reload');
  await Bun.sleep(500);
  await page.until(`performance.getEntriesByName('dither:fresh').length > 0 && !!document.querySelector('.timeline-scroll .msg')`, 20000);
  await Bun.sleep(1500);
  const after = await counts(kept);
  check('a reload after that does not bring it back', after.pending === 0 && after.real === 1, after);
  check('…and nothing went out twice', (await stored(kept)) === 1 && (await stored(one)) === 1 && (await stored(twice)) === 2);

  const errors = page.errors.filter((e) => !/ERR_INTERNET_DISCONNECTED|ERR_CONNECTION_REFUSED|WebSocket connection|Failed to load resource/.test(e));
  check('no script errors', !errors.length, errors);
} finally {
  await close();
}
console.log(failed ? `${failed} failed` : 'all passed');
process.exit(failed ? 1 : 0);
