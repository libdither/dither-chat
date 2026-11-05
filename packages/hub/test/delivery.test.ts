import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { BURST_MS, Delivery } from '../src/delivery.ts';
import { Store, type AccountRow } from '../src/store.ts';
import { Triage } from '../src/triage.ts';

describe('one notification per conversation', () => {
  let dir: string;
  let store: Store;
  let delivery: Delivery;
  let sg: AccountRow;
  const conv = (nativeId: string) => store.one<{ id: string }>('SELECT id FROM conversation WHERE native_id = ?', nativeId)!.id;
  const msg = (nativeId: string) => store.one<{ id: string }>('SELECT id FROM message WHERE native_id = ?', nativeId)!.id;
  const say = (nativeId: string, conversation: string, author: string, ts: number, body: string, decision = 'push') => {
    store.ingest(sg, { t: 'message', message: { nativeId, conversation, author, ts, body }, live: true });
    store.db.query(`INSERT OR REPLACE INTO triage (message_id, decision, reasons, decided_by, created_at) VALUES (?, ?, '[]', 'rules', ?)`).run(msg(nativeId), decision, ts);
  };

  beforeAll(() => {
    dir = mkdtempSync(join(tmpdir(), 'dither-delivery-'));
    store = new Store(join(dir, 'hub.sqlite'), (raw, a) => (raw ? `/media/${a ?? ''}/${raw}` : null));
    delivery = new Delivery(store, new Triage(store));
    sg = store.createAccount({ network: 'signal', label: 'phone', color: '#000', adapter: 'signal' });
    store.ingest(sg, { t: 'status', status: 'online', self: { nativeId: 'me', displayName: 'Me' } });
    sg = store.accounts().find((a) => a.id === sg.id)!;
    store.ingest(sg, { t: 'identity', identity: { nativeId: 'ann', displayName: 'Ann', avatarUrl: 'ann.png', contact: true } });
    store.ingest(sg, { t: 'identity', identity: { nativeId: 'bo', displayName: 'Bo', contact: true } });
    store.ingest(sg, { t: 'conversation', conversation: { nativeId: 'dm', shape: 'direct', participants: ['ann'] } });
    store.ingest(sg, { t: 'conversation', conversation: { nativeId: 'fam', shape: 'group', name: 'Family', avatarUrl: 'fam.png', participants: ['ann', 'bo'] } });
  });
  afterAll(() => {
    store.db.close();
    rmSync(dir, { recursive: true, force: true });
  });

  test('the rule: first of a burst, a rise to Important, or one to you', () => {
    const t = 1_000_000;
    expect(Delivery.alert(undefined, 'push', false, t)).toBe(true);
    expect(Delivery.alert(undefined, 'quiet', true, t)).toBe(false);
    const prev = { at: t, ts: t, top: 'push' as const };
    expect(Delivery.alert(prev, 'push', false, t + 60_000)).toBe(false);
    expect(Delivery.alert(prev, 'push', true, t + 60_000)).toBe(true);
    expect(Delivery.alert(prev, 'push', false, t + BURST_MS)).toBe(true);
    expect(Delivery.alert({ ...prev, top: 'quiet' }, 'push', false, t + 60_000)).toBe(true);
  });

  test('a burst buzzes once, and its lines are what you have not read, oldest first', () => {
    const t = Date.now();
    say('f1', 'fam', 'ann', t - 3000, 'old, before you wrote');
    say('f2', 'fam', 'me', t - 2500, 'my answer');
    say('f3', 'fam', 'ann', t - 2000, 'are you coming');
    say('f4', 'fam', 'bo', t - 1500, 'channel noise', 'drop');
    say('f5', 'fam', 'bo', t - 1000, 'leaving at 6');
    const a = delivery.plan(conv('fam'), msg('f3'), 'push', false, t - 2000)!;
    expect(a.alert).toBe(true);
    expect(a.lines.map((l) => l.body)).toEqual(['are you coming']);
    const b = delivery.plan(conv('fam'), msg('f5'), 'push', false, t - 1000)!;
    expect(b.alert).toBe(false);
    expect(b.lines.map((l) => `${l.author}: ${l.body}`)).toEqual(['Ann: are you coming', 'Bo: leaving at 6']);
    expect(b.count).toBe(3);
    expect(b.conv).toEqual({ title: 'Family', shape: 'group', icon: `/media/${sg.id}/fam.png` });
    expect(b.sender.name).toBe('Bo');
    expect(b.icons[a.sender.key]).toBe(`/media/${sg.id}/ann.png`);
  });

  test('reading the conversation anywhere clears it, once', () => {
    expect(delivery.read()).toEqual([]);
    store.markRead(conv('fam'), Date.now());
    expect(delivery.read()).toEqual([conv('fam')]);
    expect(delivery.read()).toEqual([]);
  });

  test('a computer in use: nothing buzzes', () => {
    const t = Date.now();
    say('d1', 'dm', 'ann', t, 'hello?');
    store.db
      .query(`INSERT INTO visit (id, device, device_label, view, start_at, end_at, active, source, updated_at) VALUES ('v1', 'dev-l', 'Linux, Chrome', 'inbox', ?, ?, 30, 'rail', 0)`)
      .run(t - 60_000, t - 10_000);
    const p = delivery.plan(conv('dm'), msg('d1'), 'push', true, t)!;
    expect(p.alert).toBe(false);
    expect(p.conv.shape).toBe('direct');
    expect(p.conv.icon).toBe(p.sender.icon!);
  });

  test('a long burst keeps under the push budget', () => {
    const t = Date.now() + 10_000;
    for (let i = 0; i < 12; i++) say(`L${i}`, 'fam', i % 2 ? 'ann' : 'bo', t + i, 'x'.repeat(400));
    const p = delivery.plan(conv('fam'), msg('L11'), 'push', false, t + 11)!;
    expect(p.lines.length).toBe(6);
    expect(p.lines.at(-1)!.body.length).toBeLessThanOrEqual(200);
    expect(JSON.stringify(p).length).toBeLessThan(3500);
  });
});

test('a clear push goes only to devices that said they take it', async () => {
  const { PushService } = await import('../src/push.ts');
  const { generateVapidKeys } = await import('../src/webpush.ts');
  const dir = mkdtempSync(join(tmpdir(), 'dither-clear-'));
  const store = new Store(join(dir, 'hub.sqlite'), () => null);
  const sent: string[] = [];
  const push = new PushService(store, generateVapidKeys(), 's');
  push.transport = (async (url: string) => (sent.push(url), new Response('', { status: 201 }))) as unknown as typeof fetch;
  const ecdh = (await import('node:crypto')).createECDH('prime256v1');
  ecdh.generateKeys();
  const keys = { p256dh: ecdh.getPublicKey().toString('base64url'), auth: Buffer.alloc(16, 1).toString('base64url') };
  push.subscribe({ endpoint: 'https://fcm.googleapis.com/fcm/send/old-app', ...keys }, 'Android app, Pixel');
  push.subscribe({ endpoint: 'https://fcm.googleapis.com/fcm/send/new-app', ...keys }, 'Android app, Pixel', true);
  await push.clear('cnv_1');
  expect(sent).toEqual(['https://fcm.googleapis.com/fcm/send/new-app']);
  store.db.close();
  rmSync(dir, { recursive: true, force: true });
});
