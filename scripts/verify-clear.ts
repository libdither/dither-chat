/**
 * A computer's notification closes once its chat is read, here or on another device (docs/notifications.md, "Read
 * elsewhere, gone here"), in headless Chromium against a demo hub of its own:
 *   1. the hub alerts about a DM (Always alert on it, then the demo answers a message), and the alert is pushed to the
 *      service worker while no window of the app is open, so it stays up;
 *   2. with the app open, the DM is read on another device: the hub's `cleared` reaches the page, which closes it;
 *   3. a notification left from while the app was closed goes when it starts again; one of a chat still unread stays;
 *   4. with no window of the app open, a `{ clear }` push closes its notifications, but not one newer than `upTo`,
 *      and shows nothing.
 * Pushes go to the worker over DevTools (ServiceWorker.deliverPushMessage): headless Chromium cannot reach a relay.
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

let failed = 0;
const check = (ok: unknown, what: string, detail?: unknown) => {
  if (!ok) failed++;
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${what}${detail !== undefined ? `  ${JSON.stringify(detail)}` : ''}`);
};
const call = (method: string, path: string, body?: unknown) =>
  fetch(`${url}${path}`, { method, headers: { 'content-type': 'application/json', origin: url }, ...(body !== undefined ? { body: JSON.stringify(body) } : {}) });
/** Polls for one exact condition, as the repo's verify scripts do; throws with what it waited for. */
async function until<T>(what: string, f: () => Promise<T | null | undefined | false>, ms = 20_000, seen?: () => Promise<unknown>): Promise<T> {
  const end = Date.now() + ms;
  for (;;) {
    const v = await f().catch(() => null);
    if (v) return v;
    if (Date.now() > end) throw new Error(`timed out waiting for ${what}${seen ? `; saw ${JSON.stringify(await seen().catch((e) => String(e)))}` : ''}`);
    await Bun.sleep(100);
  }
}

const hub = Bun.spawn(['bun', 'packages/hub/src/main.ts', '--demo', '--data', data, '--port', String(port), '--host', '127.0.0.1', ...web], {
  cwd: REPO,
  env: { ...process.env, DITHER_CALENDAR_URL: 'off' },
  stdout: 'ignore',
  stderr: 'inherit',
});
await until('the hub to answer', () => fetch(`${url}/api/health`).then((r) => r.ok), 60_000);

const { page: p, close, port: devtools } = await launch();
try {
  await p.size(1280, 800);
  await p.send('Browser.grantPermissions', { origin: url, permissions: ['notifications'] });
  const regs: { registrationId: string; scopeURL: string }[] = [];
  p.on('ServiceWorker.workerRegistrationUpdated', (e) => regs.push(...e.registrations));
  await p.send('ServiceWorker.enable');
  /** Every event the page's live socket got (a frame is a list of them). */
  type Live = { t: string; conversationId?: string; messageId?: string; title?: string; body?: string; level?: string; ids?: string[] };
  const events: Live[] = [];
  p.on('Network.webSocketFrameReceived', (e) => {
    try {
      const f = JSON.parse(String(e.response?.payloadData ?? ''));
      if (Array.isArray(f)) events.push(...f);
    } catch {}
  });
  const event = (f: (e: Live) => boolean) => until('a live event', async () => events.find(f), 30_000);

  const fresh = async (mark: string) => {
    await p.goto(`${url}/#/inbox`);
    await p.until(`!!navigator.serviceWorker?.controller && performance.getEntriesByName(${JSON.stringify(mark)}).length > 0`, 30_000);
  };
  await fresh('dither:tidied');
  const reg = regs.find((r) => r.scopeURL.startsWith(url));
  if (!reg) throw new Error('no service worker registration');
  const deliver = (d: unknown) => p.send('ServiceWorker.deliverPushMessage', { origin: url, registrationId: reg.registrationId, data: JSON.stringify(d) });
  type Shown = { tag: string; ts?: number; title: string };
  const inWorker = () => p.evalWorker<Shown[]>('/sw.js', `self.registration.getNotifications().then((ns) => ns.map((n) => ({ tag: n.tag, ts: n.data?.ts, title: n.title })))`);
  const inPage = () => p.eval<Shown[]>(`navigator.serviceWorker.ready.then((r) => r.getNotifications()).then((ns) => ns.map((n) => ({ tag: n.tag, ts: n.data?.ts, title: n.title })))`);
  /**
   * No window of the app, as the worker sees it (sw.js closes an alert at once while one is in sight), and no page to
   * tidy up. A worker that is not running has no window either.
   */
  const away = async () => {
    await p.goto('about:blank');
    await until('the worker to see no window of the app', async () => {
      const running = (await fetch(`http://127.0.0.1:${devtools}/json`).then((r) => r.json() as Promise<{ type: string; url: string }[]>)).some((t) => t.type === 'service_worker' && t.url.startsWith(url));
      return !running || p.evalWorker<boolean>('/sw.js', `self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then((cs) => cs.length === 0)`);
    });
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
  const ts = answer?.messages?.find((m) => m.id === notify.messageId)?.ts ?? Date.now();

  await away();
  const alert = { title: notify.title, body: notify.body, conversationId: conv, messageId: notify.messageId, tier: 'push', alert: true, lines: [{ author: notify.title, key: 'k', body: notify.body, ts }] };
  await deliver(alert);
  check(await until('the alert to show', async () => (await inWorker()).some((n) => n.tag === conv && n.ts === ts), 20_000, inWorker), 'pushed with no window of the app open, the alert shows, with the time of its newest message');

  // 2. The app opens (the chat still unread: its tidy leaves the alert), then the chat is read on another device.
  events.length = 0;
  await fresh('dither:tidied');
  check((await inPage()).some((n) => n.tag === conv), 'opening the app leaves the alert of a chat still unread');
  check((await call('POST', `/api/conversations/${conv}/read`, {})).ok, 'the chat is read on another device');
  const cleared = await event((e) => e.t === 'cleared' && !!e.ids?.includes(conv));
  check(!!cleared, 'the hub tells the open page it was read', cleared);
  check(await until('the alert to close', async () => !(await inPage()).some((n) => n.tag === conv), 20_000, inPage), 'and the page closes its notification');

  // 3. Left over from while the app was closed: the read chat's goes at the start, a chat still unread keeps its own.
  const unread = boot.conversations.find((c) => c.id !== conv && c.vantages.some((v) => v.unread > 0));
  check(!!unread, 'the demo world has another chat with something unread', unread?.id);
  await away();
  await deliver(alert);
  await deliver({ ...alert, conversationId: unread!.id, lines: [{ ...alert.lines[0], ts: Date.now() }] });
  check(await until('both to show', async () => (await inWorker()).filter((n) => n.tag === conv || n.tag === unread!.id).length === 2, 20_000, inWorker), 'two notifications up while the app is closed: the read chat’s, and one still unread');
  await fresh('dither:tidied');
  const after = await inPage();
  check(!after.some((n) => n.tag === conv) && after.some((n) => n.tag === unread!.id), 'starting the app closes the read chat’s and leaves the unread one', after.map((n) => n.tag));

  // 4. A clear push with no window of the app: closed up to where it was read, a newer alert stays, nothing shown.
  await away();
  const [a, b] = [conv, unread!.id];
  await deliver({ ...alert, conversationId: a, lines: [{ ...alert.lines[0], ts: 1000 }] });
  await deliver({ ...alert, conversationId: b, lines: [{ ...alert.lines[0], ts: 5000 }] });
  await until('both to show', async () => (await inWorker()).filter((n) => n.tag === a || n.tag === b).length === 2, 20_000, inWorker);
  const before = (await inWorker()).length;
  await deliver({ clear: a, upTo: 2000, more: [{ clear: b, upTo: 4000 }], device: 'test' });
  const left = await until('the clear to close the older one', async () => {
    const ns = await inWorker();
    return ns.some((n) => n.tag === a) ? null : ns;
  });
  check(!left.some((n) => n.tag === a), 'a clear push closes the notification read up to its upTo');
  check(left.some((n) => n.tag === b) && left.length === before - 1, 'and leaves the one with a newer message, showing nothing of its own', left.map((n) => `${n.title}:${n.tag}`));
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
