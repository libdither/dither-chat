import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Devices } from '../src/devices.ts';
import { PushService } from '../src/push.ts';
import { Store, type AccountRow } from '../src/store.ts';
import { Triage } from '../src/triage.ts';
import { generateVapidKeys } from '../src/webpush.ts';

describe('per-device notification rules', () => {
  let dir: string;
  let store: Store;
  let devices: Devices;
  let sg: AccountRow;
  let dc: AccountRow;
  const conv = (network: string, nativeId: string) => store.one<{ id: string }>('SELECT id FROM conversation WHERE network = ? AND native_id = ?', network, nativeId)!.id;
  const msg = (nativeId: string) => store.one<{ id: string }>('SELECT id FROM message WHERE native_id = ?', nativeId)!.id;

  beforeAll(() => {
    dir = mkdtempSync(join(tmpdir(), 'dither-devices-'));
    store = new Store(join(dir, 'hub.sqlite'), (raw, a) => (raw ? `/media/${a ?? ''}/${raw}` : null));
    devices = new Devices(store, new Triage(store));
    sg = store.createAccount({ network: 'signal', label: 'phone', color: '#000', adapter: 'signal' });
    dc = store.createAccount({ network: 'discord', label: 'main', color: '#111', adapter: 'discord' });
    store.ingest(sg, { t: 'identity', identity: { nativeId: 'ann', displayName: 'Ann', avatarUrl: 'ann.png', contact: true } });
    store.ingest(sg, { t: 'conversation', conversation: { nativeId: 'dm', shape: 'direct', participants: ['ann'] } });
    store.ingest(sg, { t: 'conversation', conversation: { nativeId: 'fam', shape: 'group', name: 'Family', participants: ['ann'] } });
    store.ingest(dc, { t: 'space', space: { nativeId: 'g1', kind: 'community', name: 'Rust' } });
    store.ingest(dc, { t: 'conversation', conversation: { nativeId: 'gen', shape: 'channel', name: 'general', spaces: [{ nativeId: 'g1' }] } });
    store.ingest(sg, { t: 'message', message: { nativeId: 'm1', conversation: 'fam', author: 'ann', ts: 1, body: 'hi' }, live: true });
    store.ingest(sg, { t: 'message', message: { nativeId: 'm2', conversation: 'fam', author: 'ann', ts: 2, body: 'hey you', mentionsSelf: true }, live: true });
  });
  afterAll(() => {
    store.db.close();
    rmSync(dir, { recursive: true, force: true });
  });

  test('a network left to its own app on one device', () => {
    devices.hello('dev-laptop', 'Linux, Chrome', null);
    devices.hello('dev-phone', 'Android app, Pixel', null);
    expect(devices.setRule('dev-phone', 'network', 'signal', 'none')).toBeNull();
    expect(devices.quietOn(conv('signal', 'dm'), false)).toEqual(['dev-phone']);
    expect(devices.quietOn(conv('discord', 'gen'), false)).toEqual([]);
    // Nothing about a conversation: a digest goes everywhere.
    expect(devices.quietOn(undefined, false)).toEqual([]);
  });

  test('the most specific rule on the device wins, and mentions only keeps what is addressed to you', () => {
    devices.setRule('dev-phone', 'conversation', conv('signal', 'fam'), 'mentions');
    expect(devices.quietOn(conv('signal', 'fam'), devices.addressed(msg('m1')))).toEqual(['dev-phone']);
    expect(devices.quietOn(conv('signal', 'fam'), devices.addressed(msg('m2')))).toEqual([]);
    devices.setRule('dev-phone', 'conversation', conv('signal', 'fam'), 'hub');
    expect(devices.quietOn(conv('signal', 'fam'), false)).toEqual([]);
    devices.setRule('dev-laptop', 'space', store.one<{ id: string }>(`SELECT id FROM space WHERE native_id = 'g1'`)!.id, 'none');
    expect(devices.quietOn(conv('discord', 'gen'), false)).toEqual(['dev-laptop']);
  });

  test('rules set on an unclaimed push registration move to the page that claims it', () => {
    const push = new PushService(store, generateVapidKeys(), 's');
    push.allow = () => true;
    const pid = push.subscribe({ endpoint: 'https://push.example/up/abc', p256dh: 'k', auth: 'a' }, 'Android app, Pixel')!;
    expect(devices.list().find((d) => d.id === pid)).toMatchObject({ label: 'Android app, Pixel', pushIds: [pid], lastSeenAt: null });
    expect(devices.setRule(pid, 'network', 'discord', 'none')).toBeNull();
    expect(devices.quietOn(conv('discord', 'gen'), false)).toContain(pid);
    devices.hello('dev-phone', 'Android app, Pixel', 'https://push.example/up/abc');
    const phone = devices.list().find((d) => d.id === 'dev-phone')!;
    expect(phone.pushIds).toEqual([pid]);
    expect(phone.rules).toContainEqual({ scope: 'network', target: 'discord', level: 'none' });
    expect(phone.rules).toContainEqual({ scope: 'network', target: 'signal', level: 'none' });
    expect(devices.list().some((d) => d.id === pid)).toBe(false);
    expect(devices.quietOn(conv('discord', 'gen'), false)).toContain('dev-phone');
  });

  test('push skips the devices the rules keep quiet', async () => {
    const push = new PushService(store, generateVapidKeys(), 's');
    push.allow = () => true;
    const sent: string[] = [];
    push.transport = (async (url: string) => (sent.push(url), new Response('', { status: 201 }))) as unknown as typeof fetch;
    // A real key pair, so the payload can be encrypted for it.
    const ecdh = (await import('node:crypto')).createECDH('prime256v1');
    ecdh.generateKeys();
    const keys = { p256dh: ecdh.getPublicKey().toString('base64url'), auth: Buffer.alloc(16, 1).toString('base64url') };
    store.db.query('UPDATE push_subscription SET p256dh = ?, auth = ?').run(keys.p256dh, keys.auth);
    push.subscribe({ endpoint: 'https://push.example/up/laptop', ...keys }, 'Linux, Firefox');
    devices.hello('dev-laptop', 'Linux, Firefox', 'https://push.example/up/laptop');
    const quiet = devices.quietOn(conv('signal', 'dm'), false);
    const r = await push.notify('Ann · Signal', 'hi', conv('signal', 'dm'), {}, quiet);
    expect(r.devices).toBe(1);
    expect(sent).toEqual(['https://push.example/up/laptop']);
  });

  test('a notification shows the sender’s picture and the network', () => {
    expect(store.notifyLook(conv('signal', 'fam'), msg('m1'))).toEqual({ network: 'signal', icon: `/media/${sg.id}/ann.png` });
    expect(store.notifyLook(conv('discord', 'gen'), undefined)).toEqual({ network: 'discord' });
    expect(store.notifyLook(undefined, undefined)).toEqual({});
  });

  test('forgetting a device keeps its push, as a device of its own again', () => {
    devices.forget('dev-phone');
    const list = devices.list();
    expect(list.some((d) => d.id === 'dev-phone')).toBe(false);
    expect(list.some((d) => d.label === 'Android app, Pixel' && d.rules.length === 0)).toBe(true);
  });
});
