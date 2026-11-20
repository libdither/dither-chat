/**
 * A computer's notification closes once its chat is read, here or on another device (docs/notifications.md, "Read
 * elsewhere, gone here"), in headless Chromium against a demo hub of its own:
 *   1. the hub alerts about a DM (Always alert on it, then the demo answers a message), and the alert is pushed to the
 *      service worker while no window of the app is open, so it stays up;
 *   2. with the app open, the DM is read on another device: the hub's `cleared` reaches the page, which closes it;
 *   3. a notification left from while the app was closed goes when it starts again; one of a chat still unread stays,
 *      and so do one newer than its chat's read and a reminder (`keep`);
 *   4. with no window of the app open, a `{ clear }` push closes its notifications, but not one newer than `upTo` nor
 *      a reminder, and shows nothing.
 * Pushes go to the worker over DevTools (ServiceWorker.deliverPushMessage): headless Chromium cannot reach a relay.
 * Every line says when it was printed; a wait that runs out says what the worker held then (its windows and its
 * notifications). The worker's notifications are read only once each push has shown its own (sw.js marks
 * `dither:shown`): Chromium's getNotifications() drops one written but not yet on screen from its list for good.
 *
 *   bun run web:build && bun scripts/verify-clear.ts
 * Starts its own hub on a free port with a throwaway data dir. DITHER_WEB_DIST serves another web build.
 */
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { launch } from './browser.ts';

const REPO = resolve(import.meta.dir, '..');
const data = mkdtempSync(join(tmpdir(), 'dither-clear-hub-'));
const port = await new Promise<number>((done) => {
  const s = Bun.listen({ hostname: '127.0.0.1', port: 0, socket: { data() {} } });
  const p = s.port;
  s.stop(true);
  done(p);
});
const url = `http://127.0.0.1:${port}`;
const web = process.env.DITHER_WEB_DIST ? ['--web', process.env.DITHER_WEB_DIST] : [];

const t0 = performance.now();
const at = () => `+${((performance.now() - t0) / 1000).toFixed(1)}s`.padStart(7);
let failed = 0;
const check = (ok: unknown, what: string, detail?: unknown) => {
  if (!ok) failed++;
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${at()} ${what}${detail !== undefined ? `  ${JSON.stringify(detail)}` : ''}`);
};
const note = (what: string) => console.log(`     ${at()} ${what}`);
const call = (method: string, path: string, body?: unknown) =>
  fetch(`${url}${path}`, { method, headers: { 'content-type': 'application/json', origin: url }, ...(body !== undefined ? { body: JSON.stringify(body) } : {}) });
/** What the worker holds, said by every wait that runs out (set once the browser is up). */
let worker: (() => Promise<unknown>) | null = null;
/** Polls for one exact condition, as the repo's verify scripts do; throws with what it waited for and what it saw. */
async function until<T>(what: string, f: () => Promise<T | null | undefined | false>, ms = 20_000, seen?: () => Promise<unknown>): Promise<T> {
  const end = Date.now() + ms;
  for (;;) {
    const v = await f().catch(() => null);
    if (v) return v;
    if (Date.now() > end) {
      const saw = seen ? `; saw ${JSON.stringify(await seen().catch((e) => String(e)))}` : '';
      const held = worker ? `; the worker held ${JSON.stringify(await worker().catch((e) => String(e)))}` : '';
      throw new Error(`timed out at ${at().trim()} waiting for ${what}${saw}${held}`);
    }
    await Bun.sleep(100);
  }
}

const hub = Bun.spawn(['bun', 'packages/hub/src/main.ts', '--demo', '--data', data, '--port', String(port), '--host', '127.0.0.1', ...web], {
  cwd: REPO,
  // No background chatter in the demo world (as verify-perf.ts): only the messages this sends get answers.
  env: { ...process.env, DITHER_CALENDAR_URL: 'off', DITHER_DEMO_CHATTER: '0' },
  stdout: 'ignore',
  stderr: 'inherit',
});
await until('the hub to answer', () => fetch(`${url}/api/health`).then((r) => r.ok), 60_000);
note('the hub answers');

const { page: p, close, port: devtools } = await launch();
try {
  await p.size(1280, 800);
  await p.send('Browser.grantPermissions', { origin: url, permissions: ['notifications'] });
  const regs: { registrationId: string; scopeURL: string }[] = [];
  p.on('ServiceWorker.workerRegistrationUpdated', (e) => regs.push(...e.registrations));
  await p.send('ServiceWorker.enable');
  /** Every event the page's live socket got (a frame is a list of them). */
  type Live = { t: string; conversationId?: string; messageId?: string; title?: string; body?: string; level?: string; reads?: { id: string; upTo: number }[] };
  const events: Live[] = [];
  p.on('Network.webSocketFrameReceived', (e) => {
    try {
      const f = JSON.parse(String(e.response?.payloadData ?? ''));
      if (Array.isArray(f)) events.push(...f);
    } catch {}
  });
  const event = (f: (e: Live) => boolean) => until('a live event', async () => events.find(f), 30_000, async () => events.map((e) => `${e.t}:${e.conversationId ?? e.reads?.map((r) => r.id).join(',') ?? ''}`));

  const fresh = async (mark: string) => {
    await p.goto(`${url}/#/inbox`);
    await p.until(`!!navigator.serviceWorker?.controller && performance.getEntriesByName(${JSON.stringify(mark)}).length > 0`, 30_000);
    note(`the app is open and ${mark} is marked`);
  };
  await fresh('dither:tidied');
  const reg = regs.find((r) => r.scopeURL.startsWith(url));
  if (!reg) throw new Error('no service worker registration');
  const deliver = (d: unknown) => p.send('ServiceWorker.deliverPushMessage', { origin: url, registrationId: reg.registrationId, data: JSON.stringify(d) });
  /**
   * Pushes these and waits until the worker has shown each (DevTools answers once a push is handed over, not once it
   * is handled). Reading the notifications sooner is a race the reading loses: Chromium's getNotifications() keeps
   * only those it sees on screen or written after the call, so one written just before it and still on its way to
   * the screen is deleted from its list, while it still shows (content/browser/notifications,
   * PlatformNotificationContextImpl::DoReadAllNotificationDataForServiceWorkerRegistration).
   */
  const show = async (...ds: ({ conversationId: string } & Record<string, unknown>)[]) => {
    await p.evalWorker('/sw.js', `performance.clearMarks('dither:shown')`);
    for (const d of ds) await deliver(d);
    const want = ds.map((d) => d.conversationId);
    const marks = () => p.evalWorker<string[]>('/sw.js', `performance.getEntriesByName('dither:shown').map((m) => m.detail)`);
    await until(`the worker to show ${want.length}`, async () => {
      const got = await marks();
      return want.every((t) => got.includes(t));
    }, 20_000, marks);
  };
  type Shown = { tag: string; ts?: number; title: string; keep?: boolean };
  const SHOWN = `(ns) => ns.map((n) => ({ tag: n.tag, ts: n.data?.ts, title: n.title, keep: n.data?.keep }))`;
  const inWorker = () => p.evalWorker<Shown[]>('/sw.js', `self.registration.getNotifications().then(${SHOWN})`);
  const inPage = () => p.eval<Shown[]>(`navigator.serviceWorker.ready.then((r) => r.getNotifications()).then(${SHOWN})`);
  /** Whether the worker runs: DevTools lists a service worker only while it does. */
  const running = async () => (await fetch(`http://127.0.0.1:${devtools}/json`).then((r) => r.json() as Promise<{ type: string; url: string }[]>)).some((t) => t.type === 'service_worker' && t.url.startsWith(url));
  /** The windows of the app the worker sees, as sw.js asks for them (it closes an alert while one is in sight). */
  const windows = () =>
    p.evalWorker<{ url: string; focused: boolean; visibilityState: string }[]>('/sw.js', `self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then((cs) => cs.map((c) => ({ url: c.url, focused: c.focused, visibilityState: c.visibilityState })))`);
  worker = async () => ((await running()) ? { windows: await windows(), notifications: await inWorker() } : 'not running');
  /**
   * No window of the app, as the worker sees it, and no page to tidy up. A stopped worker is started first and asked:
   * the window of a page just left can still be its client when it starts (it is not gone until the browser has
   * unloaded it), and a push would start it with that window still in sight.
   */
  const away = async () => {
    await p.goto('about:blank');
    let started = 0;
    await until('the worker to see no window of the app', async () => {
      if (!(await running())) {
        started++;
        await p.send('ServiceWorker.startWorker', { scopeURL: reg.scopeURL });
        return false;
      }
      return (await windows()).length === 0;
    });
    note(`the worker runs${started ? ' (started it: it had stopped)' : ''} and sees no window of the app`);
  };

  // 1. An alert from the hub about a DM: Always alert on it, then the demo's person answers what is sent there.
  const boot = (await (await call('GET', '/api/bootstrap')).json()) as { conversations: { id: string; shape: string; network: string; vantages: { unread: number }[] }[] };
  const dms = boot.conversations.filter((c) => c.shape === 'direct' && c.network === 'discord');
  let conv = '';
  for (const c of dms) {
    if (!(await call('PUT', '/api/rules', { scope: 'conversation', target: c.id, level: 'all' })).ok) continue;
    if ((await call('POST', `/api/conversations/${c.id}/send`, { body: 'are you around?' })).ok) {
      conv = c.id;
      break;
    }
  }
  check(!!conv, 'a demo DM set to Always alert takes a message', conv);
  const notify = await event((e) => e.t === 'notify' && e.conversationId === conv);
  check(!notify.level, 'the answer is an alert', notify.level ?? 'alert');
  const answer = (await (await call('GET', `/api/conversations/${conv}/messages`)).json().catch(() => null)) as { messages?: { id: string; ts: number }[] } | null;
  const ts = answer?.messages?.find((m) => m.id === notify.messageId)?.ts;
  check(typeof ts === 'number', 'the answer has a time', ts);

  await away();
  const alert = { title: notify.title, body: notify.body, conversationId: conv, messageId: notify.messageId, tier: 'push', alert: true, lines: [{ author: notify.title, key: 'k', body: notify.body, ts }] };
  await show(alert);
  check(await until('the alert to show', async () => (await inWorker()).some((n) => n.tag === conv && n.ts === ts), 20_000, inWorker), 'pushed with no window of the app open, the alert shows, with the time of its newest message');

  // 2. The app opens (the chat still unread: its tidy leaves the alert), then the chat is read on another device.
  events.length = 0;
  await fresh('dither:tidied');
  const opened = await inPage();
  check(opened.some((n) => n.tag === conv), 'opening the app leaves the alert of a chat still unread', opened.map((n) => n.tag));
  check((await call('POST', `/api/conversations/${conv}/read`, {})).ok, 'the chat is read on another device');
  const cleared = await event((e) => e.t === 'cleared' && !!e.reads?.some((r) => r.id === conv));
  check(cleared.reads?.find((r) => r.id === conv)?.upTo === ts, 'the hub tells the open page it was read, up to the answer', cleared);
  check(await until('the alert to close', async () => !(await inPage()).some((n) => n.tag === conv), 20_000, inPage), 'and the page closes its notification');

  // 3. Left over from while the app was closed: the read chat's goes at the start; a chat still unread keeps its own,
  // and so do a chat read up to before its alert's message and a reminder you set in a read chat.
  const unread = boot.conversations.find((c) => c.id !== conv && c.vantages.some((v) => v.unread > 0));
  check(!!unread, 'the demo world has another chat with something unread', unread?.id);
  const [newer, reminded] = boot.conversations.filter((c) => c.id !== conv && c.id !== unread?.id);
  const readTo = Date.now();
  for (const c of [newer, reminded]) check((await call('POST', `/api/conversations/${c.id}/read`, { upToTs: readTo })).ok, 'another chat is read on another device', c.id);
  await away();
  await show(
    alert,
    { ...alert, conversationId: unread!.id, lines: [{ ...alert.lines[0], ts: Date.now() }] },
    { ...alert, conversationId: newer.id, lines: [{ ...alert.lines[0], ts: readTo + 60_000 }] },
    { title: 'A reminder you set', body: 'about this', conversationId: reminded.id, tier: 'push', alert: true, keep: true },
  );
  const four = [conv, unread!.id, newer.id, reminded.id];
  check(await until('all four to show', async () => (await inWorker()).filter((n) => four.includes(n.tag)).length === 4, 20_000, inWorker), 'four notifications up while the app is closed: a read chat’s, one unread, one newer than its read, a reminder');
  await fresh('dither:tidied');
  const after = (await inPage()).map((n) => n.tag);
  check(!after.includes(conv), 'starting the app closes the read chat’s', after);
  check(after.includes(unread!.id) && after.includes(newer.id) && after.includes(reminded.id), 'and leaves the unread one, the one newer than its read and the reminder', after);

  // 4. A clear push with no window of the app: closed up to where it was read; a newer alert and a reminder stay;
  // nothing shown.
  await away();
  const [a, b] = [conv, unread!.id];
  await show({ ...alert, conversationId: a, lines: [{ ...alert.lines[0], ts: 1000 }] }, { ...alert, conversationId: b, lines: [{ ...alert.lines[0], ts: 5000 }] });
  await until('both to show', async () => (await inWorker()).filter((n) => n.tag === a || n.tag === b).length === 2, 20_000, inWorker);
  const before = (await inWorker()).length;
  await deliver({ clear: a, upTo: 2000, more: [{ clear: b, upTo: 4000 }, { clear: reminded.id, upTo: Date.now() }], device: 'test' });
  const left = await until(
    'the clear to close the older one',
    async () => {
      const ns = await inWorker();
      return ns.some((n) => n.tag === a) ? null : ns;
    },
    20_000,
    inWorker,
  );
  check(!left.some((n) => n.tag === a), 'a clear push closes the notification read up to its upTo');
  check(left.some((n) => n.tag === b) && left.some((n) => n.tag === reminded.id) && left.length === before - 1, 'and leaves the one with a newer message and the reminder, showing nothing of its own', left.map((n) => `${n.title}:${n.tag}`));
  if (p.errors.length) check(false, 'no page errors', p.errors);
} catch (e) {
  check(false, 'ran to the end', String(e));
} finally {
  await close();
  hub.kill();
  await hub.exited;
  rmSync(data, { recursive: true, force: true });
}
console.log(failed ? `${failed} failed` : 'all passed');
process.exit(failed ? 1 : 0);
