/**
 * Read anywhere, gone everywhere (clears.ts, docs/notifications.md "Read elsewhere, gone here"): who gets a push that
 * only closes a notification, what it carries, the caps of Chrome and Firefox, and the `cleared` event for open pages.
 * A fake push server keeps what was sent; payloads are decrypted as a browser would.
 */
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { createDecipheriv, createECDH, hkdfSync } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type * as P from '@dither-chat/protocol';
import { CHROME_PER_DAY, CLEAR_TTL, clearRead, clearRelay, firefoxAllowance } from '../src/clears.ts';
import { Delivery, FORGET_MS } from '../src/delivery.ts';
import { PushService } from '../src/push.ts';
import { Store } from '../src/store.ts';
import { Triage } from '../src/triage.ts';
import { generateVapidKeys } from '../src/webpush.ts';

const HOUR = 3_600_000;
const DAY = 24 * HOUR;

/** The receiving half of RFC 8291, as webpush.test.ts has it. */
function decrypt(body: Uint8Array, ua: ReturnType<typeof createECDH>, auth: Buffer): any {
  const b = Buffer.from(body);
  const salt = b.subarray(0, 16);
  const idlen = b[20];
  const asPublic = b.subarray(21, 21 + idlen);
  const ikm = Buffer.from(hkdfSync('sha256', ua.computeSecret(asPublic), auth, Buffer.concat([Buffer.from('WebPush: info\0'), ua.getPublicKey(), asPublic]), 32));
  const cek = Buffer.from(hkdfSync('sha256', ikm, salt, Buffer.from('Content-Encoding: aes128gcm\0'), 16));
  const nonce = Buffer.from(hkdfSync('sha256', ikm, salt, Buffer.from('Content-Encoding: nonce\0'), 12));
  const ct = b.subarray(21 + idlen);
  const d = createDecipheriv('aes-128-gcm', cek, nonce);
  d.setAuthTag(ct.subarray(ct.length - 16));
  const plain = Buffer.concat([d.update(ct.subarray(0, ct.length - 16)), d.final()]);
  return JSON.parse(plain.subarray(0, plain.length - 1).toString());
}

const ENDPOINTS = {
  app: ['https://fcm.googleapis.com/fcm/send/app', 'Android app, Pixel', true],
  chrome: ['https://fcm.googleapis.com/fcm/send/chrome', 'Linux, Chrome', false],
  firefox: ['https://updates.push.services.mozilla.com/wpush/v2/firefox', 'Linux, Firefox', false],
  phoneChrome: ['https://fcm.googleapis.com/fcm/send/phone', 'Android, Chrome', false],
  safari: ['https://web.push.apple.com/safari', 'Mac, Safari', false],
  edge: ['https://wns2-par02p.notify.windows.com/w/?token=edge', 'Windows, Edge', false],
} as const;
type Name = keyof typeof ENDPOINTS;

interface Sent {
  to: Name;
  headers: Record<string, string>;
  body: any;
}

let dir: string;
let store: Store;
let push: PushService;
let sent: Sent[];
let ids: Record<Name, string>;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'dither-clears-'));
  store = new Store(join(dir, 'hub.sqlite'), () => null);
  if (!(store.db.query('PRAGMA table_info(push_subscription)').all() as { name: string }[]).some((c) => c.name === 'device')) store.db.exec('ALTER TABLE push_subscription ADD COLUMN device TEXT');
  push = new PushService(store, generateVapidKeys(), 's');
  sent = [];
  const keys = new Map<string, { ua: ReturnType<typeof createECDH>; auth: Buffer; name: Name }>();
  ids = {} as Record<Name, string>;
  for (const [name, [endpoint, label, clears]] of Object.entries(ENDPOINTS) as [Name, (typeof ENDPOINTS)[Name]][]) {
    const ua = createECDH('prime256v1');
    ua.generateKeys();
    const auth = Buffer.from(crypto.getRandomValues(new Uint8Array(16)));
    keys.set(endpoint, { ua, auth, name });
    ids[name] = push.subscribe({ endpoint, p256dh: ua.getPublicKey().toString('base64url'), auth: auth.toString('base64url') }, label, clears)!;
  }
  push.transport = (async (url: string, init: RequestInit) => {
    const k = keys.get(url)!;
    sent.push({ to: k.name, headers: init.headers as Record<string, string>, body: decrypt(init.body as Uint8Array, k.ua, k.auth) });
    return new Response('', { status: 201 });
  }) as unknown as typeof fetch;
});
afterEach(() => {
  store.db.close();
  rmSync(dir, { recursive: true, force: true });
});

const row = (name: Name) => store.db.query('SELECT * FROM push_subscription WHERE id = ?').get(ids[name]) as Record<string, any>;
/** An alert under this tag, shown on these registrations, up to `ts`. */
const alerted = (tag: string, ts: number, names: Name[], at = Date.now()) => names.forEach((n) => push.browsers.shown(row(n), tag, ts, at));
const clears = (to?: Name) => sent.filter((s) => s.body.clear && (!to || s.to === to));
const reset = () => void (sent.length = 0);

describe('who gets a clear', () => {
  test('the relay and the label decide: Chrome and Firefox on a computer; never Safari, Edge, a phone or another push server', () => {
    expect(clearRelay(ENDPOINTS.chrome[0], 'Linux, Chrome')).toBe('chrome');
    expect(clearRelay('https://fcm.googleapis.com/fcm/send/x', 'Mac, Chrome')).toBe('chrome');
    expect(clearRelay(ENDPOINTS.firefox[0], 'Windows, Firefox')).toBe('firefox');
    expect(clearRelay('https://push.services.mozilla.com/wpush/v1/x', 'Linux, Firefox')).toBe('firefox');
    expect(clearRelay(ENDPOINTS.safari[0], 'Mac, Safari')).toBeNull();
    // Safari by its label too, whatever its endpoint says.
    expect(clearRelay('https://fcm.googleapis.com/fcm/send/x', 'Mac, Safari')).toBeNull();
    expect(clearRelay(ENDPOINTS.edge[0], 'Windows, Edge')).toBeNull();
    expect(clearRelay(ENDPOINTS.phoneChrome[0], 'Android, Chrome')).toBeNull();
    expect(clearRelay('https://fcm.googleapis.com/fcm/send/x', 'iPhone or iPad, Chrome')).toBeNull();
    expect(clearRelay('https://ntfy.sh/up123', 'Linux, Firefox')).toBeNull();
    expect(clearRelay('https://evil.example/fcm.googleapis.com', 'Linux, Chrome')).toBeNull();
    expect(clearRelay('not a url', 'Linux, Chrome')).toBeNull();
  });

  test('an alert is noted for the browsers that took it; a read goes to them and the app, with upTo, and nowhere else', async () => {
    await push.notify('Ann', 'are you coming', 'cnv_a', { lines: [{ author: 'Ann', key: 'k', body: 'are you coming', ts: 100 }], tier: 'push' });
    expect(sent.map((s) => s.to).sort()).toEqual(['app', 'chrome', 'edge', 'firefox', 'phoneChrome', 'safari']);
    reset();
    await push.clear('cnv_a', 100);
    await push.clearBrowsers([{ id: 'cnv_a', upTo: 100 }]);
    // The Android app: as before, one clear for the chat, now with upTo (which it does not read), a day's TTL, no topic.
    const [app] = clears('app');
    expect(app.body).toEqual({ clear: 'cnv_a', upTo: 100, device: ids.app });
    expect(app.headers.TTL).toBe('86400');
    expect(app.headers.Topic).toBeUndefined();
    // Chrome and Firefox on a computer: ten minutes, under the one topic.
    for (const to of ['chrome', 'firefox'] as const) {
      const [c] = clears(to);
      expect(c.body).toEqual({ clear: 'cnv_a', upTo: 100, device: ids[to] });
      expect(c.headers.TTL).toBe(String(CLEAR_TTL));
      expect(c.headers.Topic).toBe('clear');
      expect(c.headers.Topic).toMatch(/^[A-Za-z0-9_-]{1,32}$/);
    }
    expect(sent.map((s) => s.to).sort()).toEqual(['app', 'chrome', 'firefox']);
  });

  test('only what a browser was alerted about, up to what it showed, and not a calendar reminder or a ring', async () => {
    // Chrome was kept quiet (its device rules): Firefox alone shows it.
    await push.notify('Bo', 'later', 'cnv_b', { lines: [{ author: 'Bo', key: 'k', body: 'later', ts: 200 }] }, [ids.chrome]);
    await push.notify('Dentist', 'at 3', 'cnv_cal', { calendar: { eventKey: 'evt_1', open: 'day/2026-11-14' } });
    await push.notify('Ann', 'calling', 'cnv_call', { call: { id: 'call_1', tag: 'call:call_1' } });
    reset();
    await push.clearBrowsers([{ id: 'cnv_b', upTo: 200 }, { id: 'cnv_cal', upTo: Date.now() }, { id: 'cnv_call', upTo: Date.now() }, { id: 'cnv_never', upTo: 999 }]);
    expect(sent.map((s) => [s.to, s.body.clear, s.body.more])).toEqual([['firefox', 'cnv_b', undefined]]);
    // A newer alert came after the read point: nothing to close.
    alerted('cnv_c', 500, ['chrome']);
    reset();
    await push.clearBrowsers([{ id: 'cnv_c', upTo: 400 }]);
    expect(sent).toEqual([]);
  });

  test('a tap, a swipe or a notification closed at once in sight: no clear for it later', async () => {
    alerted('cnv_d', 10, ['chrome', 'firefox']);
    store.db.query('UPDATE push_subscription SET device = ? WHERE id = ?').run('dev_ff', ids.firefox);
    push.browsers.noted({ event: 'dismissed', conversationId: 'cnv_d', device: ids.chrome });
    // Firefox's page tapped it: by its device id.
    push.browsers.noted({ event: 'tapped', conversationId: 'cnv_d', device: 'dev_ff' });
    // Words that say nothing about it showing do nothing.
    alerted('cnv_e', 10, ['chrome']);
    push.browsers.noted({ event: 'delivered', conversationId: 'cnv_e', device: ids.chrome });
    await push.clearBrowsers([{ id: 'cnv_d', upTo: 10 }, { id: 'cnv_e', upTo: 10 }]);
    expect(clears().map((s) => [s.to, s.body.clear])).toEqual([['chrome', 'cnv_e']]);
  });

  test('a browser whose page is open and in use gets none: the page closes it, and it no longer counts as showing', async () => {
    const t = Date.now();
    store.db.query('UPDATE push_subscription SET device = ? WHERE id = ?').run('dev_ch', ids.chrome);
    const stay = (id: string, start: number, end: number, closed: number) =>
      store.db.query(`INSERT INTO visit (id, device, device_label, view, start_at, end_at, source, closed, updated_at) VALUES (?, 'dev_ch', 'Linux, Chrome', 'inbox', ?, ?, 'rail', ?, ?)`).run(id, start, end, closed, end);
    alerted('cnv_here', 10, ['chrome', 'firefox'], t);
    alerted('cnv_later', 20, ['chrome'], t);
    // In use a minute ago, the stay still going: read there (or `cleared` reaches it), so no push to it.
    stay('v1', t - 10 * 60_000, t - 60_000, 0);
    await push.clearBrowsers([{ id: 'cnv_here', upTo: 10 }], t);
    expect(clears().map((s) => [s.to, s.body.clear])).toEqual([['firefox', 'cnv_here']]);
    // Last used three minutes ago, or its stay over: the push goes again. cnv_here no longer counts as showing on
    // Chrome, so this clear closes its last notification and costs.
    store.db.query('UPDATE visit SET end_at = ? WHERE id = ?').run(t - 3 * 60_000, 'v1');
    reset();
    await push.clearBrowsers([{ id: 'cnv_later', upTo: 20 }], t);
    expect(clears().map((s) => [s.to, s.body.clear])).toEqual([['chrome', 'cnv_later']]);
    expect((store.db.query('SELECT free FROM push_clear WHERE sub_id = ?').get(ids.chrome) as { free: number }).free).toBe(0);
  });

  test('a failed push is not counted, and its notification is still known to show', async () => {
    alerted('cnv_f', 10, ['chrome']);
    const real = push.transport;
    push.transport = (async () => new Response('busy', { status: 503 })) as unknown as typeof fetch;
    await push.clearBrowsers([{ id: 'cnv_f', upTo: 10 }]);
    expect((store.db.query('SELECT COUNT(*) AS n FROM push_clear').get() as { n: number }).n).toBe(0);
    push.transport = real;
    await push.clearBrowsers([{ id: 'cnv_f', upTo: 10 }]);
    expect(clears('chrome').map((s) => s.body.clear)).toEqual(['cnv_f']);
  });
});

describe('one clear carries what may still wait at the push server', () => {
  test('a second clear within ten minutes carries the first, each with its own upTo; after that, only its own', async () => {
    const t = Date.now();
    alerted('cnv_1', 10, ['chrome'], t);
    alerted('cnv_2', 20, ['chrome'], t);
    alerted('cnv_3', 30, ['chrome'], t);
    await push.clearBrowsers([{ id: 'cnv_1', upTo: 10 }], t);
    await push.clearBrowsers([{ id: 'cnv_2', upTo: 25 }], t + 60_000);
    expect(clears('chrome').map((s) => s.body)).toEqual([
      { clear: 'cnv_1', upTo: 10, device: ids.chrome },
      { clear: 'cnv_2', upTo: 25, more: [{ clear: 'cnv_1', upTo: 10 }], device: ids.chrome },
    ]);
    reset();
    await push.clearBrowsers([{ id: 'cnv_3', upTo: 30 }], t + 60_000 + CLEAR_TTL * 1000 + 1);
    expect(clears('chrome').map((s) => s.body)).toEqual([{ clear: 'cnv_3', upTo: 30, device: ids.chrome }]);
  });

  test('reads in one round go in one push', async () => {
    alerted('cnv_1', 10, ['firefox']);
    alerted('cnv_2', 20, ['firefox']);
    await push.clearBrowsers([{ id: 'cnv_1', upTo: 10 }, { id: 'cnv_2', upTo: 20 }]);
    expect(clears('firefox').map((s) => s.body)).toEqual([{ clear: 'cnv_1', upTo: 10, more: [{ clear: 'cnv_2', upTo: 20 }], device: ids.firefox }]);
  });
});

describe('the caps', () => {
  test('Firefox allows fewer as its last visit gets older, and always keeps a point of its quota', () => {
    expect([0, 0.5, 1, 2, 3, 7, 10, 30].map(firefoxAllowance)).toEqual([8, 8, 7, 4, 2, 1, 0, 0]);
  });

  test('Chrome: a clear that leaves another notification showing is free; one that closes the last, four a day', async () => {
    const t = Date.now();
    // Each read closes the last notification there: costly. The fifth is held, and its notification stays.
    for (let i = 0; i < CHROME_PER_DAY + 1; i++) {
      alerted(`cnv_${i}`, i, ['chrome'], t + i * HOUR);
      await push.clearBrowsers([{ id: `cnv_${i}`, upTo: i }], t + i * HOUR + 1);
    }
    expect(clears('chrome').map((s) => s.body.clear)).toEqual(['cnv_0', 'cnv_1', 'cnv_2', 'cnv_3']);
    // So the next one leaves that one showing: free, although the day's four are spent.
    reset();
    alerted('cnv_x', 1, ['chrome'], t + 6 * HOUR);
    await push.clearBrowsers([{ id: 'cnv_x', upTo: 1 }], t + 6 * HOUR + 1);
    expect(clears('chrome').map((s) => s.body.clear)).toEqual(['cnv_x']);
    // Swiped away: the next is the last again, and held until a day after the first.
    reset();
    push.browsers.noted({ event: 'dismissed', conversationId: `cnv_${CHROME_PER_DAY}`, device: ids.chrome });
    alerted('cnv_y', 1, ['chrome'], t + 7 * HOUR);
    await push.clearBrowsers([{ id: 'cnv_y', upTo: 1 }], t + 7 * HOUR + 1);
    expect(clears('chrome')).toEqual([]);
    push.browsers.noted({ event: 'dismissed', conversationId: 'cnv_y', device: ids.chrome });
    alerted('cnv_z', 1, ['chrome'], t + DAY + 1);
    await push.clearBrowsers([{ id: 'cnv_z', upTo: 1 }], t + DAY + 2);
    expect(clears('chrome').map((s) => s.body.clear)).toEqual(['cnv_z']);
  });

  test('Firefox: every clear counts, free or not, at most eight since the device was last on the app', async () => {
    const t = Date.now();
    store.db.query('UPDATE push_subscription SET device = ?, created_at = ? WHERE id = ?').run('dev_ff', t - 30 * DAY, ids.firefox);
    // A stay of a minute, over: the page is not open there now.
    const visit = (at: number) =>
      store.db.query(`INSERT INTO visit (id, device, device_label, view, start_at, end_at, source, closed, updated_at) VALUES (?, 'dev_ff', 'Linux, Firefox', 'inbox', ?, ?, 'rail', 1, ?)`).run(`v${at}`, at, at + 60_000, at + 60_000);
    // Registered a month ago and never seen since: no allowance left.
    alerted('cnv_old', 1, ['firefox'], t);
    await push.clearBrowsers([{ id: 'cnv_old', upTo: 1 }], t + 1);
    expect(clears('firefox')).toEqual([]);
    visit(t);
    // Always another one showing: still at most eight.
    alerted('cnv_keep', 1, ['firefox'], t);
    for (let i = 0; i < 10; i++) {
      alerted(`cnv_${i}`, 1, ['firefox'], t + i);
      await push.clearBrowsers([{ id: `cnv_${i}`, upTo: 1 }], t + 1000 + i);
    }
    expect(clears('firefox').length).toBe(8);
    // A visit lets them go again; one three days old, only two.
    reset();
    visit(t + HOUR);
    for (let i = 10; i < 20; i++) {
      alerted(`cnv_${i}`, 1, ['firefox'], t + 3 * DAY + HOUR);
      await push.clearBrowsers([{ id: `cnv_${i}`, upTo: 1 }], t + 3 * DAY + HOUR + i);
    }
    expect(clears('firefox').length).toBe(firefoxAllowance(3));
  });

  test('what was sent is forgotten after three days, and so is the notification it showed', async () => {
    const t = Date.now();
    alerted('cnv_1', 1, ['chrome'], t);
    await push.clearBrowsers([], t + FORGET_MS + 1);
    await push.clearBrowsers([{ id: 'cnv_1', upTo: 1 }], t + FORGET_MS + 2);
    expect(clears('chrome')).toEqual([]);
    expect((store.db.query('SELECT COUNT(*) AS n FROM push_shown').get() as { n: number }).n).toBe(0);
  });
});

test('a round: open pages hear `cleared` once, the phone list is told, the app and the browsers get their clears', async () => {
  const delivery = new Delivery(store, new Triage(store));
  let sg = store.createAccount({ network: 'signal', label: 'phone', color: '#000', adapter: 'signal' });
  store.ingest(sg, { t: 'status', status: 'online', self: { nativeId: 'me', displayName: 'Me' } });
  sg = store.accounts().find((a) => a.id === sg.id)!;
  store.ingest(sg, { t: 'identity', identity: { nativeId: 'ann', displayName: 'Ann', contact: true } });
  store.ingest(sg, { t: 'conversation', conversation: { nativeId: 'dm', shape: 'direct', participants: ['ann'] } });
  const ts = Date.now() - 1000;
  store.ingest(sg, { t: 'message', message: { nativeId: 'm1', conversation: 'dm', author: 'ann', ts, body: 'are you coming' }, live: true });
  const cid = store.one<{ id: string }>(`SELECT id FROM conversation WHERE native_id = 'dm'`)!.id;
  const mid = store.one<{ id: string }>(`SELECT id FROM message WHERE native_id = 'm1'`)!.id;
  store.db.query(`INSERT OR REPLACE INTO triage (message_id, decision, reasons, decided_by, created_at) VALUES (?, 'push', '[]', 'rules', ?)`).run(mid, ts);
  const grouped = delivery.plan(cid, mid, 'push', false)!;
  await push.notify('Ann', 'are you coming', cid, { ...grouped, tier: 'push' });
  reset();

  const live: P.ClientEvent[] = [];
  const phone: string[] = [];
  const failed: unknown[] = [];
  const round = () => clearRead({ delivery, phone: { read: (c) => void phone.push(c) }, push, live: (ev) => void live.push(ev), failed: (e) => void failed.push(e) });
  await round();
  expect(live).toEqual([]);
  store.markRead(cid, Date.now());
  await round();
  expect(live).toEqual([{ t: 'cleared', ids: [cid] }]);
  expect(phone).toEqual([cid]);
  expect(clears().map((s) => [s.to, s.body.clear, s.body.upTo]).sort()).toEqual([
    ['app', cid, ts],
    ['chrome', cid, ts],
    ['firefox', cid, ts],
  ]);
  expect(failed).toEqual([]);
  // Once: the next round has nothing.
  await round();
  expect(live.length).toBe(1);
});
