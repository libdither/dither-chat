import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { BURST_MS, Delivery, LIST_EVERY } from '../src/delivery.ts';
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
    for (const g of ['club', 'crew', 'band']) store.ingest(sg, { t: 'conversation', conversation: { nativeId: g, shape: 'group', name: g, participants: ['ann', 'bo'] } });
  });
  afterAll(() => {
    store.db.close();
    rmSync(dir, { recursive: true, force: true });
  });

  test('the rule: only an alert sounds, on the first of a burst, a rise to an alert, or one to you', () => {
    const t = 1_000_000;
    expect(Delivery.alert(undefined, 'push', false, t)).toBe(true);
    const prev = { at: t, ts: t, top: 'push' as const };
    expect(Delivery.alert(prev, 'push', false, t + 60_000)).toBe(false);
    expect(Delivery.alert(prev, 'push', true, t + 60_000)).toBe(true);
    expect(Delivery.alert(prev, 'push', false, t + BURST_MS)).toBe(true);
    // A rise: the burst was a Conversation or a list row so far, and now something cannot wait.
    expect(Delivery.alert({ ...prev, top: 'quiet' }, 'push', false, t + 60_000)).toBe(true);
    expect(Delivery.alert({ ...prev, top: 'digest' }, 'push', false, t + 60_000)).toBe(true);
    // A Conversation and a list row never sound: first of a burst or not, to you or not, whatever came before.
    for (const tier of ['quiet', 'digest'] as const) {
      expect(Delivery.alert(undefined, tier, true, t)).toBe(false);
      expect(Delivery.alert(undefined, tier, false, t)).toBe(false);
      expect(Delivery.alert(prev, tier, true, t + 60_000)).toBe(false);
      expect(Delivery.alert({ ...prev, top: tier }, tier, true, t + BURST_MS)).toBe(false);
    }
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

  test('a burst keeps its highest tier: after an alert, a silent row in between does not make the next alert sound again', () => {
    const d = new Delivery(store, new Triage(store));
    const t = Date.now() + 60 * 60_000;
    say('c1', 'club', 'ann', t, 'come now', 'push');
    say('c2', 'club', 'bo', t + 60_000, 'on my way', 'quiet');
    say('c3', 'club', 'ann', t + 120_000, 'hurry', 'push');
    expect(d.plan(conv('club'), msg('c1'), 'push', false, t)!.alert).toBe(true);
    const silent = d.plan(conv('club'), msg('c2'), 'quiet', false, t + 60_000)!;
    expect(silent.alert).toBe(false);
    // The row shows every tier's lines; the burst is still an alert's.
    expect(silent.lines.map((l) => l.body)).toEqual(['come now', 'on my way']);
    expect(d.plan(conv('club'), msg('c3'), 'push', false, t + 120_000)!.alert).toBe(false);
    // To you by name, it sounds whatever came before.
    expect(d.plan(conv('club'), msg('c3'), 'push', true, t + 130_000)!.alert).toBe(true);
    // Five minutes after the last of it, a new burst: an alert sounds, a list row does not.
    say('c4', 'club', 'bo', t + 130_000 + BURST_MS, 'where are you', 'push');
    expect(d.plan(conv('club'), msg('c4'), 'push', false, t + 130_000 + BURST_MS)!.alert).toBe(true);
  });

  test('a burst that rises: list row, Conversation, then an alert, which sounds once', () => {
    const d = new Delivery(store, new Triage(store));
    const t = Date.now() + 2 * 60 * 60_000;
    say('r1', 'crew', 'ann', t, 'photos from Sunday', 'digest');
    say('r2', 'crew', 'bo', t + 30_000, 'nice ones', 'quiet');
    say('r3', 'crew', 'ann', t + 60_000, 'the car is being towed', 'push');
    say('r4', 'crew', 'ann', t + 90_000, 'come quick', 'push');
    say('r5', 'crew', 'bo', t + 100_000, 'not worth a row', 'drop');
    expect(d.plan(conv('crew'), msg('r1'), 'digest', false, t)!.alert).toBe(false);
    expect(d.plan(conv('crew'), msg('r2'), 'quiet', false, t + 30_000)!.alert).toBe(false);
    expect(d.plan(conv('crew'), msg('r3'), 'push', false, t + 60_000)!.alert).toBe(true);
    const last = d.plan(conv('crew'), msg('r4'), 'push', false, t + 90_000)!;
    expect(last.alert).toBe(false);
    expect(last.lines.map((l) => l.body)).toEqual(['photos from Sunday', 'nice ones', 'the car is being towed', 'come quick']);
    // What fell below the list is counted as unread and is no line of the row.
    say('r6', 'crew', 'ann', t + 110_000, 'still there?', 'quiet');
    const after = d.plan(conv('crew'), msg('r6'), 'quiet', false, t + 110_000)!;
    expect(after.lines.map((l) => l.body)).not.toContain('not worth a row');
    expect(after.count).toBe(6);
  });

  test('a list row for a chat goes out at most every ten minutes; another chat’s is its own', () => {
    const d = new Delivery(store, new Triage(store));
    const t = Date.now() + 3 * 60 * 60_000;
    expect(LIST_EVERY).toBe(10 * 60_000);
    expect(d.listDue(conv('band'), t)).toBe(true);
    say('b1', 'band', 'ann', t, 'new song is up', 'digest');
    expect(d.plan(conv('band'), msg('b1'), 'digest', false, t)).not.toBeNull();
    // A second message a minute later: its row is not due. Nor at nine minutes; at ten it is.
    expect(d.listDue(conv('band'), t + 60_000)).toBe(false);
    expect(d.listDue(conv('band'), t + LIST_EVERY - 1)).toBe(false);
    expect(d.listDue(conv('band'), t + LIST_EVERY)).toBe(true);
    expect(d.listDue(conv('crew'), t + 60_000)).toBe(true);
    // Whatever went out for the chat counts: a Conversation row or an alert a moment ago shows it already.
    say('b2', 'band', 'bo', t + LIST_EVERY, 'listening now', 'quiet');
    d.plan(conv('band'), msg('b2'), 'quiet', false, t + LIST_EVERY);
    expect(d.listDue(conv('band'), t + LIST_EVERY + 60_000)).toBe(false);
    // Read anywhere: the row is gone from the phones, and the next list message brings a new one at once.
    store.markRead(conv('band'), t + LIST_EVERY + 1);
    expect(d.read(t + LIST_EVERY + 2)).toEqual([conv('band')]);
    expect(d.listDue(conv('band'), t + LIST_EVERY + 60_000)).toBe(true);
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

  test("a Discord group with no picture: the sender's until the extractor names Discord's default one, then that, logged as no change", () => {
    let dc = store.createAccount({ network: 'discord', label: 'dc', color: '#111', adapter: 'discord' });
    store.ingest(dc, { t: 'status', status: 'online', self: { nativeId: 'dme', displayName: 'Me' } });
    dc = store.accounts().find((a) => a.id === dc.id)!;
    store.ingest(dc, { t: 'identity', identity: { nativeId: 'cy', displayName: 'Cy', avatarUrl: 'https://cdn.example/cy.png' } });
    const group = { nativeId: 'gdm', shape: 'group' as const, name: 'Trip', participants: ['cy'] };
    store.ingest(dc, { t: 'conversation', conversation: group });
    const t = Date.now() + 20_000;
    const sayIn = (nativeId: string, ts: number) => {
      store.ingest(dc, { t: 'message', message: { nativeId, conversation: 'gdm', author: 'cy', ts, body: 'tickets?' }, live: true });
      store.db.query(`INSERT OR REPLACE INTO triage (message_id, decision, reasons, decided_by, created_at) VALUES (?, 'push', '[]', 'rules', ?)`).run(msg(nativeId), ts);
      return delivery.plan(conv('gdm'), msg(nativeId), 'push', false, ts)!;
    };
    const before = sayIn('g1', t);
    expect(before.conv).toEqual({ title: 'Trip', shape: 'group' });
    expect(before.sender.icon).toBe(`/media/${dc.id}/https://cdn.example/cy.png`);
    expect(store.conversationView(conv('gdm'))!.avatar).toBeNull();

    // The extractor (contracts: group DM icons) names the picture Discord's own client shows for such a group.
    const DEFAULT = 'https://discord.com/assets/placeholder-group-icon.png';
    store.ingest(dc, { t: 'conversation', conversation: { ...group, avatarUrl: DEFAULT } });
    const after = sayIn('g2', t + 1);
    expect(after.conv.icon).toBe(`/media/${dc.id}/${DEFAULT}`);
    expect(after.sender.icon).toBe(`/media/${dc.id}/https://cdn.example/cy.png`);
    expect(store.conversationView(conv('gdm'))!.avatar).toBe(`/media/${dc.id}/${DEFAULT}`);
    expect(store.one(`SELECT COUNT(*) AS n FROM change_log WHERE target_id = ? AND field = 'avatar'`, conv('gdm'))!.n).toBe(0);
    // A fact without one keeps it; a real change is still logged.
    store.ingest(dc, { t: 'conversation', conversation: { ...group, name: 'Trip!' } });
    expect(store.conversationView(conv('gdm'))!.avatar).toBe(`/media/${dc.id}/${DEFAULT}`);
    expect(store.one(`SELECT COUNT(*) AS n FROM change_log WHERE target_id = ? AND field = 'name'`, conv('gdm'))!.n).toBe(1);
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
