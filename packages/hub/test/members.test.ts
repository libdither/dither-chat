/**
 * Server members seen passively (a `members` event, source 'seen'): kept only with the adversarial members setting,
 * upserted when seen again, with coverage against the network's own counts (docs/history.md).
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type * as P from '@dither-chat/protocol';
import { DEFAULT_RETENTION } from '@dither-chat/protocol';
import { hubId } from '@dither-chat/protocol/ids';
import { Store, type AccountRow } from '../src/store.ts';

const dir = mkdtempSync(join(tmpdir(), 'dither-members-'));
let store: Store;
let dc: AccountRow;
const ON: P.RetentionSettings = { ...DEFAULT_RETENTION, adversarial: true, members: true };
const GUILD = 'g1';
const sid = hubId('spc', 'discord', GUILD);
const seen = (members: P.MemberFact[], x: Partial<Extract<P.AdapterEvent, { t: 'members' }>> = {}) =>
  store.ingest(dc, { t: 'members', space: GUILD, source: 'seen', members, ...x });
const rows = () => store.db.query('SELECT * FROM membership').all() as Record<string, any>[];
const row = (who: string) => rows().find((r) => r.identity_id === hubId('idn', 'discord', who));
const coverageRows = () => store.db.query('SELECT * FROM member_coverage').all();

beforeAll(() => {
  store = new Store(join(dir, 'hub.sqlite'), (raw) => raw ?? null);
  dc = store.createAccount({ network: 'discord', label: 'd', color: '#111', adapter: 'discord' });
  store.ingest(dc, { t: 'status', status: 'online', self: { nativeId: 'dme', displayName: 'Me', isSelf: true } });
  store.ingest(dc, { t: 'space', space: { nativeId: GUILD, kind: 'community', name: 'Guild' } });
  for (const a of ['ann', 'bob', 'cy']) store.ingest(dc, { t: 'identity', identity: { nativeId: a, displayName: a.toUpperCase() } });
});
afterAll(() => {
  store.db.close();
  rmSync(dir, { recursive: true, force: true });
});

describe('gating', () => {
  test('off by default: nothing written, nothing read', () => {
    store.setRetention(DEFAULT_RETENTION);
    seen([{ who: 'ann', nick: 'a' }], { total: 100, online: 10 });
    expect(rows()).toEqual([]);
    expect(coverageRows()).toEqual([]);
    expect(store.memberCoverage(sid)).toBeUndefined();
  });

  test('members on without adversarial features shown: still nothing', () => {
    store.setRetention({ ...DEFAULT_RETENTION, members: true });
    seen([{ who: 'ann' }], { total: 100 });
    expect(rows()).toEqual([]);
    expect(coverageRows()).toEqual([]);
  });

  test('adversarial shown but members off: nothing', () => {
    store.setRetention({ ...DEFAULT_RETENTION, adversarial: true, statuses: true });
    seen([{ who: 'ann' }], { total: 100 });
    expect(rows()).toEqual([]);
    expect(store.memberCoverage(sid)).toBeUndefined();
    expect(store.profile({ identityId: hubId('idn', 'discord', 'ann') })!.memberOf).toBeUndefined();
  });

  test('a space the hub does not know is not recorded', () => {
    store.setRetention(ON);
    store.ingest(dc, { t: 'members', space: 'nowhere', source: 'seen', members: [{ who: 'ann' }], total: 5 });
    expect(rows()).toEqual([]);
    expect(coverageRows()).toEqual([]);
  });
});

describe('passive ingest', () => {
  test('members seen are kept, with nick, roles and when they joined', () => {
    store.setRetention(ON);
    seen([{ who: 'ann', nick: 'annie', roles: ['Mod'], joinedAt: 1_000 }, { who: 'bob' }], { ts: 5_000 });
    expect(rows()).toHaveLength(2);
    expect(row('ann')).toMatchObject({ space_id: sid, nick: 'annie', roles: '["Mod"]', joined_at: 1_000, source: 'seen', first_seen: 5_000, last_seen: 5_000, account_id: dc.id });
    expect(row('bob')).toMatchObject({ nick: null, roles: null, joined_at: null, source: 'seen', first_seen: 5_000, last_seen: 5_000 });
  });

  test('seen again: one row, last seen moves on, what is not said again stays, roles given replace', () => {
    seen([{ who: 'ann', roles: [] }, { who: 'bob', nick: 'bobby' }], { ts: 9_000 });
    seen([{ who: 'ann' }], { ts: 7_000 });
    expect(rows()).toHaveLength(2);
    expect(row('ann')).toMatchObject({ nick: 'annie', roles: '[]', joined_at: 1_000, first_seen: 5_000, last_seen: 9_000 });
    expect(row('bob')).toMatchObject({ nick: 'bobby', first_seen: 5_000, last_seen: 9_000 });
  });

  test('someone not heard of yet gets an identity', () => {
    seen([{ who: 'zed' }], { ts: 9_500 });
    expect(store.identitiesByIds([hubId('idn', 'discord', 'zed')])).toHaveLength(1);
  });

  test('at most 500 members from one event', () => {
    store.ingest(dc, { t: 'space', space: { nativeId: 'big', kind: 'community', name: 'Big' } });
    store.ingest(dc, { t: 'members', space: 'big', source: 'seen', members: Array.from({ length: 600 }, (_, i) => ({ who: `bulk${i}` })) });
    const big = hubId('spc', 'discord', 'big');
    expect(store.one<{ n: number }>('SELECT COUNT(*) AS n FROM membership WHERE space_id = ?', big)!.n).toBe(500);
    store.db.query('DELETE FROM membership WHERE space_id = ?').run(big);
  });

  test('a profile lists the servers they were seen in', () => {
    expect(store.profile({ identityId: hubId('idn', 'discord', 'ann') })!.memberOf).toEqual([{ spaceId: sid, nick: 'annie', joinedAt: 1_000, lastSeenAt: 9_000 }]);
  });
});

describe('coverage', () => {
  test('no count from the network yet: seen alone, no fraction', () => {
    expect(store.memberCoverage(sid)).toEqual({ seen: 3, lastSeenAt: 9_500 });
  });

  test('with the network counts: seen of total, and an event with no members still updates counts', () => {
    seen([], { total: 12, online: 4, ts: 11_000 });
    expect(store.memberCoverage(sid)).toEqual({ seen: 3, total: 12, online: 4, fraction: 0.25, lastSeenAt: 9_500, reportedAt: 11_000 });
    // A later event with only the online count keeps the total.
    seen([], { online: 6, ts: 12_000 });
    expect(store.memberCoverage(sid)).toMatchObject({ total: 12, online: 6, reportedAt: 12_000 });
  });

  test('never above 1, even when the network undercounts', () => {
    seen([], { total: 2, ts: 13_000 });
    expect(store.memberCoverage(sid)!.fraction).toBe(1);
  });

  test('a nonsense count is ignored', () => {
    seen([], { total: -4, online: Number.NaN, ts: 14_000 });
    expect(store.memberCoverage(sid)).toMatchObject({ total: 2, online: 6 });
  });

  test('hidden again, coverage and membership are out of sight but kept; shown, they are back', () => {
    store.setRetention({ ...ON, adversarial: false });
    expect(store.memberCoverage(sid)).toBeUndefined();
    expect(store.profile({ identityId: hubId('idn', 'discord', 'ann') })!.memberOf).toBeUndefined();
    expect(rows()).toHaveLength(3);
    store.setRetention(ON);
    expect(store.memberCoverage(sid)!.seen).toBe(3);
  });

  test('forgetting them empties both tables', () => {
    expect(store.eraseKept('members')).toBe(3);
    expect(rows()).toEqual([]);
    expect(coverageRows()).toEqual([]);
    expect(store.memberCoverage(sid)).toEqual({ seen: 0 });
  });

  test('a server left by every account takes its members with it', () => {
    seen([{ who: 'ann' }], { total: 9 });
    store.ingest(dc, { t: 'leave', kind: 'space', nativeId: GUILD });
    expect(rows()).toEqual([]);
    expect(coverageRows()).toEqual([]);
  });
});
