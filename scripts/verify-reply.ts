/**
 * Replying from a notification in a real service worker, against a demo hub:
 *   bun packages/hub/src/main.ts --demo --data <temp dir> --port <port>
 *   bun scripts/verify-reply.ts http://127.0.0.1:<port>
 *
 * Pushes arrive through DevTools and go through the real push handler. Headless Chromium has no notification UI to type
 * into, so a click is a constructed NotificationEvent dispatched at the worker: everything after the click is real.
 * Sends messages only on the demo adapter. Never point this at a hub with real accounts.
 */
import { launch } from './browser.ts';

const url = process.argv[2];
const shot = process.argv[3];
const origin = new URL(url).origin;
const hub = (p: string, init?: RequestInit) => fetch(url + p, init).then((r) => r.json() as Promise<any>);
const boot = await hub('/api/bootstrap');
if (!boot.accounts.every((a: any) => a.demo)) throw new Error('this hub has real accounts: refusing');
const directs = boot.conversations.filter((c: any) => c.shape === 'direct');
const plain = directs.find((c: any) => c.network === 'discord');
const secret = directs.find((c: any) => c.network === 'matrix' && c.encrypted);

let failed = 0;
const check = (ok: boolean, what: string, detail?: unknown) => {
  if (!ok) failed++;
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${what}${detail !== undefined ? `  ${JSON.stringify(detail)}` : ''}`);
};

const { page: p, close } = await launch();
try {
  await p.size(1280, 800);
  await p.send('Emulation.setTimezoneOverride', { timezoneId: 'Etc/UTC' }); // screenshots should not say where this machine is
  await p.send('Browser.grantPermissions', { origin, permissions: ['notifications'] });
  const regs: any[] = [];
  p.on('ServiceWorker.workerRegistrationUpdated', (e) => regs.push(...e.registrations));
  await p.send('ServiceWorker.enable');
  await p.goto(url + '/#/settings');
  await p.until(`navigator.serviceWorker.getRegistration().then((r) => !!r && !!r.active)`, 15000);
  // Out of focus, or the push handler closes what it shows, as it should for someone looking at the app.
  await p.send('Emulation.setFocusEmulationEnabled', { enabled: false });
  const reg = regs.find((r) => r.scopeURL.startsWith(origin));

  const push = async (d: unknown) => {
    await p.send('ServiceWorker.deliverPushMessage', { origin, registrationId: reg.registrationId, data: JSON.stringify(d) });
    await Bun.sleep(600);
  };
  const shown = (tag: string): Promise<any[]> => p.evalWorker('/sw.js', `registration.getNotifications({ tag: ${JSON.stringify(tag)} }).then((ns) => ns.map((n) => ({ title: n.title, body: n.body, actions: n.actions.map((a) => [a.action, a.type]) })))`);
  const clear = () => p.evalWorker('/sw.js', `registration.getNotifications().then((ns) => ns.forEach((n) => n.close()))`);
  const reply = (tag: string, text: string) =>
    p.evalWorker(
      '/sw.js',
      `(async () => {
        const [notification] = await registration.getNotifications({ tag: ${JSON.stringify(tag)} });
        const ev = new NotificationEvent('notificationclick', { notification, action: 'reply', reply: ${JSON.stringify(text)} });
        let done;
        Object.defineProperty(ev, 'waitUntil', { value: (x) => (done = x) });
        self.dispatchEvent(ev);
        await done;
      })()`,
    );
  const stored = async (id: string) => (await hub(`/api/conversations/${id}/messages?limit=10`)).messages.map((m: any) => m.body);

  check(await p.evalWorker('/sw.js', `'reply' in NotificationEvent.prototype`), 'this Chromium has NotificationEvent.reply', await p.evalWorker('/sw.js', 'navigator.userAgent'));
  if (shot) {
    await p.until(`[...document.querySelectorAll('#push .set-help')].some((x) => x.textContent.includes('Replying from a notification'))`);
    await p.eval(`document.getElementById('push').scrollIntoView()`);
    await p.shot(shot);
  }

  await push({ title: 'Ravi', body: 'can you bring a friend?', conversationId: plain.id, canReply: true });
  const offered = await shown(plain.id);
  check(offered[0]?.actions[0]?.[0] === 'reply' && offered[0]?.actions[0]?.[1] === 'text', 'a reply-capable push shows a text action', offered[0]?.actions);

  const text = `from the notification ${Date.now()}`;
  await reply(plain.id, text);
  await Bun.sleep(400);
  check((await stored(plain.id)).includes(text), 'the reply went out through the hub and came back as a message');
  check((await shown(plain.id)).length === 0, 'the notification is cleared on success');

  await push({ title: 'Alice', body: 'hi', conversationId: secret.id });
  const refused = await shown(secret.id);
  check(refused[0]?.actions.length === 1 && refused[0].actions[0][0] === 'open', 'no reply offered in an encrypted Matrix room', refused[0]?.actions);

  const blocked = `never plaintext ${Date.now()}`;
  await reply(secret.id, blocked);
  await Bun.sleep(400);
  const failure = await shown(secret.id);
  check(failure[0]?.title === 'Reply not sent' && failure[0].body.includes('encrypted Matrix rooms') && failure[0].body.includes(blocked), 'a reply forced at an encrypted room is refused by the hub, visibly', failure[0]);
  check(!(await stored(secret.id)).includes(blocked), 'and nothing was stored or sent');
  await clear();

  await push({ title: 'Ravi', body: 'again', conversationId: plain.id, canReply: true });
  await p.evalWorker('/sw.js', `(self.__fetch = self.fetch, self.fetch = () => Promise.reject(new TypeError('Failed to fetch')), 0)`);
  await reply(plain.id, 'lost');
  await Bun.sleep(300);
  await p.evalWorker('/sw.js', `(self.fetch = self.__fetch, 0)`);
  const down = await shown(plain.id);
  check(down[0]?.title === 'Reply not sent' && down[0].body.startsWith('Could not reach the hub'), 'an unreachable hub gives a visible failure', down[0]);
  await clear();

  const res = await fetch(`${url}/api/conversations/${plain.id}/send`, { method: 'POST', body: JSON.stringify({ body: 'evil' }), headers: { origin: 'https://evil.example' } });
  check(res.status === 403, 'another site cannot post to that same endpoint', res.status);
  if (p.errors.length) console.log('page errors', p.errors);
} finally {
  await close();
}
console.log(failed ? `${failed} failed` : 'all passed');
process.exit(failed ? 1 : 0);
