/**
 * Status dots (hub presence.ts, docs/profile.md "Status dots"): the latest presence is kept whatever the retention
 * settings say, coalesced, saved across a restart, hidden while no account that heard it is online, and forgotten with
 * its accounts or when stale. Presence over time stays behind the adversarial switch.
 */
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type * as P from '@dither-chat/protocol';
import { DEFAULT_RETENTION } from '@dither-chat/protocol';
import { hubId } from '@dither-chat/protocol/ids';
import { changesOf } from '../src/journal.ts';
import { FRAME_MS, OFFLINE_STALE_MS, PresenceNow, STALE_MS } from '../src/presence.ts';
import { Store, type AccountRow } from '../src/store.ts';

let dir: string;
let store: Store;
let dc: AccountRow;
let zu: AccountRow;
const bob = () => hubId('idn', 'discord', 'bob');
const heard = (state: P.PresenceView['state'], o: { who?: string; acc?: AccountRow; devices?: P.PresenceView['devices']; ts?: number } = {}) =>
  store.ingest(o.acc ?? dc, { t: 'presence', who: o.who ?? 'bob', state, devices: o.devices, ts: o.ts });
const presenceEvents = (events: P.ClientEvent[]) => events.filter((e): e is Extract<P.ClientEvent, { t: 'presence' }> => e.t === 'presence');

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'dither-presence-'));
  store = new Store(join(dir, 'hub.sqlite'), (raw) => raw ?? null);
  dc = store.createAccount({ network: 'discord', label: 'd', color: '#111', adapter: 'discord' });
  zu = store.createAccount({ network: 'zulip', label: 'z', color: '#222', adapter: 'zulip' });
  store.ingest(dc, { t: 'status', status: 'online', self: { nativeId: 'dme', displayName: 'Me', isSelf: true } });
  store.ingest(zu, { t: 'status', status: 'online', self: { nativeId: 'zme', displayName: 'Me', isSelf: true } });
  for (const n of ['bob', 'a', 'b']) store.ingest(dc, { t: 'identity', identity: { nativeId: n, displayName: n } });
  store.ingest(zu, { t: 'identity', identity: { nativeId: 'zed', displayName: 'Zed' } });
  store.flush(true);
});
afterEach(() => {
  store.db.close();
  rmSync(dir, { recursive: true, force: true });
});

describe('the latest presence', () => {
  test('is kept with every retention setting off, and goes out in the bootstrap and a live frame', () => {
    store.setRetention({ ...DEFAULT_RETENTION, changes: false });
    heard('idle', { devices: ['mobile', 'desktop', 'mobile'], ts: 1000 });
    expect(store.presenceNow.get(bob())).toEqual({ identityId: bob(), state: 'idle', devices: ['desktop', 'mobile'], at: 1000 });
    expect(store.bootstrap().presence).toEqual([{ identityId: bob(), state: 'idle', devices: ['desktop', 'mobile'], at: 1000 }]);
    const frames = presenceEvents(store.flush(true));
    expect(frames).toEqual([{ t: 'presence', items: [{ identityId: bob(), state: 'idle', devices: ['desktop', 'mobile'], at: 1000 }], removed: [] }]);
    expect(changesOf(frames)).toEqual([{ kind: 'presence', id: bob() }]);
  });

  test('the gate still holds back presence over time', () => {
    store.setRetention({ ...DEFAULT_RETENTION, presence: true });
    heard('online');
    heard('idle');
    expect(store.one('SELECT COUNT(*) AS n FROM change_log WHERE field = ?', 'presence')).toEqual({ n: 0 });
    expect(store.presenceNow.get(bob())?.state).toBe('idle');
    store.setRetention({ ...DEFAULT_RETENTION, adversarial: true, presence: true });
    heard('dnd');
    expect(store.one('SELECT COUNT(*) AS n FROM change_log WHERE field = ?', 'presence')).toEqual({ n: 1 });
  });

  test('your own presence is not a dot', () => {
    heard('online', { who: 'dme' });
    expect(store.presenceNow.list()).toEqual([]);
  });

  test('offline is on no device; a state not of the protocol is nothing', () => {
    heard('offline', { devices: ['desktop'] });
    expect(store.presenceNow.get(bob())).toMatchObject({ state: 'offline' });
    expect(store.presenceNow.get(bob())?.devices).toBeUndefined();
    store.ingest(dc, { t: 'presence', who: 'bob', state: 'away' as never });
    expect(store.presenceNow.get(bob())?.state).toBe('offline');
  });

  test('is saved, and read back after a restart, however long ago it changed', () => {
    heard('dnd', { ts: 5000, devices: ['web'] });
    store.flush(true);
    store.db.close();
    store = new Store(join(dir, 'hub.sqlite'), (raw) => raw ?? null);
    expect(store.presenceNow.get(bob())).toEqual({ identityId: bob(), state: 'dnd', devices: ['web'], at: 5000 });
  });

  test('hidden while its account is not online, shown again when it is back; gone with the account', () => {
    heard('online', { ts: 1000 });
    heard('online', { acc: zu, who: 'zed' });
    store.flush(true);
    for (const status of ['offline', 'connecting', 'attention', 'error'] as const) {
      store.updateAccount(dc.id, { status });
      expect(store.presenceNow.get(bob())).toBeNull();
      expect(store.bootstrap().presence?.map((v) => v.identityId)).toEqual([hubId('idn', 'zulip', 'zed')]);
      expect(presenceEvents(store.flush(true))).toEqual([{ t: 'presence', items: [], removed: [bob()] }]);
      store.ingest(dc, { t: 'status', status: 'online' });
      expect(presenceEvents(store.flush(true))).toEqual([{ t: 'presence', items: [{ identityId: bob(), state: 'online', at: 1000 }], removed: [] }]);
    }
    store.updateAccount(dc.id, { enabled: 0 });
    expect(store.presenceNow.get(bob())).toBeNull();
    store.updateAccount(dc.id, { enabled: 1 });
    expect(store.presenceNow.get(bob())?.state).toBe('online');
    store.deleteAccount(zu.id);
    expect(store.presenceNow.list().map((v) => v.identityId)).toEqual([bob()]);
    store.flush(true);
    expect(store.one('SELECT COUNT(*) AS n FROM presence_now')).toEqual({ n: 1 });
  });

  test('heard on two accounts: shown while either is online', () => {
    const dc2 = store.createAccount({ network: 'discord', label: 'd2', color: '#333', adapter: 'discord' });
    store.ingest(dc2, { t: 'status', status: 'online', self: { nativeId: 'dme2', displayName: 'Me', isSelf: true } });
    heard('idle');
    heard('idle', { acc: dc2 });
    store.updateAccount(dc.id, { status: 'offline' });
    expect(store.presenceNow.get(bob())?.state).toBe('idle');
    store.updateAccount(dc2.id, { status: 'offline' });
    expect(store.presenceNow.get(bob())).toBeNull();
    store.ingest(dc2, { t: 'status', status: 'online' });
    // A change heard on one account is that account's word alone.
    heard('dnd', { acc: dc2 });
    store.updateAccount(dc2.id, { status: 'offline' });
    store.ingest(dc, { t: 'status', status: 'online' });
    expect(store.presenceNow.get(bob())).toBeNull();
  });

  test('makes no identity of its own, unless presence is logged', () => {
    heard('online', { who: 'stranger' });
    expect(store.one('SELECT COUNT(*) AS n FROM identity WHERE id = ?', hubId('idn', 'discord', 'stranger'))).toEqual({ n: 0 });
    expect(store.presenceNow.list()).toEqual([]);
  });

  test('an identity known later as your own loses its dot', () => {
    heard('online', { who: 'a' });
    expect(store.presenceNow.get(hubId('idn', 'discord', 'a'))?.state).toBe('online');
    store.ingest(dc, { t: 'status', status: 'online', self: { nativeId: 'a', displayName: 'Me', isSelf: true } });
    expect(store.presenceNow.get(hubId('idn', 'discord', 'a'))).toBeNull();
  });

  test('a write that fails is made next time', () => {
    heard('dnd');
    store.flush(true);
    heard('online');
    store.db.exec('ALTER TABLE presence_now RENAME TO presence_aside');
    expect(() => store.presenceNow.save()).toThrow();
    store.db.exec('ALTER TABLE presence_aside RENAME TO presence_now');
    store.presenceNow.save();
    expect(store.one('SELECT state FROM presence_now WHERE identity_id = ?', bob())).toEqual({ state: 'online' });
  });
});

describe('PresenceNow', () => {
  let clock = 0;
  const make = () => new PresenceNow(store.db, [], () => clock);
  beforeEach(() => {
    clock = 1_000_000_000;
  });
  const a = hubId('idn', 'discord', 'a');
  const b = hubId('idn', 'discord', 'b');

  test('coalesces: one frame per FRAME_MS, with each identity once and at its newest', () => {
    const p = make();
    p.set(a, 'online', [], dc.id);
    expect(p.take()).toEqual({ t: 'presence', items: [{ identityId: a, state: 'online', at: clock }], removed: [] });
    for (const s of ['idle', 'online', 'dnd']) p.set(a, s, [], dc.id);
    p.set(b, 'idle', [], dc.id);
    clock += FRAME_MS - 1;
    expect(p.due()).toBe(false);
    expect(p.take()).toBeNull();
    clock += 1;
    const e = p.take() as Extract<P.ClientEvent, { t: 'presence' }>;
    expect(e.items.map((v) => [v.identityId, v.state])).toEqual([
      [a, 'dnd'],
      [b, 'idle'],
    ]);
    expect(p.take(true)).toBeNull();
  });

  test('the same heard again is no news; a network time is never in the future nor before the last', () => {
    const p = make();
    expect(p.set(a, 'online', ['desktop'], dc.id, clock + 60_000)).toBe(true);
    expect(p.get(a)?.at).toBe(clock);
    expect(p.set(a, 'online', ['desktop'], dc.id)).toBe(false);
    expect(p.set(a, 'idle', [], dc.id, clock - 5000)).toBe(true);
    expect(p.get(a)?.at).toBe(clock);
  });

  test('goes unknown when not heard for too long: a day when on, a week when offline', () => {
    const p = make();
    p.set(a, 'online', [], dc.id);
    p.set(b, 'offline', [], dc.id);
    p.take(true);
    clock += STALE_MS / 2;
    p.set(a, 'online', [], dc.id); // heard again: still trusted
    clock += STALE_MS / 2 + 1;
    p.expire();
    expect(p.get(a)?.state).toBe('online');
    clock += STALE_MS / 2;
    p.expire();
    expect(p.get(a)).toBeNull();
    expect(p.get(b)?.state).toBe('offline');
    clock += OFFLINE_STALE_MS;
    expect(p.due()).toBe(true); // expiring runs from due(), once a minute
    expect(p.get(b)).toBeNull();
    expect(p.take(true)).toEqual({ t: 'presence', items: [], removed: [a, b] });
  });
});
