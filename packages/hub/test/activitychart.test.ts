/**
 * The Activity chart's numbers (activitychart.ts, docs/profile.md "Activity"): local hours in a zone, across DST changes
 * and half-hour zones; the range clamped; presence merged across identities; presence and statuses only while they are
 * logged; your messages to them; and the endpoint.
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type * as P from '@dither-chat/protocol';
import { DEFAULT_RETENTION } from '@dither-chat/protocol';
import { hubId } from '@dither-chat/protocol/ids';
import { clampDays, HOUR, localRange, mergePresence, offsetAt, offsetPieces, parseZone, presenceHours, rangePieces, zoneName } from '../src/activitychart.ts';
import { HubServer } from '../src/server.ts';
import { Store, type AccountRow } from '../src/store.ts';
import { Triage } from '../src/triage.ts';

const NY = { tz: 'America/New_York' };
const total = (s: P.ActivitySeries[] | undefined) => (s ?? []).reduce((n, x) => n + x.count, 0);
/** Hour h's count summed over the series. */
const at = (s: P.ActivitySeries[] | undefined, h: number) => (s ?? []).reduce((n, x) => n + x.hours[h], 0);

describe('zones and ranges', () => {
  test('days: whole days from 1 to 365, 30 when missing or not a number', () => {
    expect([null, '', 'abc', '0', '-4', '7', '7.6', '90', '365', '1000', 'Infinity'].map(clampDays)).toEqual([30, 30, 30, 1, 1, 7, 8, 90, 365, 365, 30]);
  });

  test('a zone by name, by offset, or UTC; anything else is refused', () => {
    expect(parseZone('Europe/Berlin', null)).toEqual({ tz: 'Europe/Berlin' });
    expect(parseZone('Not/AZone', null)).toBeNull();
    expect(parseZone(null, '330')).toEqual({ offset: 330 });
    expect(parseZone(null, '-300')).toEqual({ offset: -300 });
    expect(parseZone(null, '9999')).toBeNull();
    expect(parseZone(null, '1.5')).toBeNull();
    expect(parseZone(null, null)).toEqual({ offset: 0 });
    expect([{ offset: 330 }, { offset: -570 }, { offset: 0 }, NY].map(zoneName)).toEqual(['UTC+05:30', 'UTC-09:30', 'UTC', 'America/New_York']);
  });

  test('offsets: standard and summer time, half and quarter hours', () => {
    expect(offsetAt(NY, Date.UTC(2026, 0, 15))).toBe(-5 * HOUR);
    expect(offsetAt(NY, Date.UTC(2026, 6, 15))).toBe(-4 * HOUR);
    expect(offsetAt({ tz: 'Asia/Kolkata' }, Date.UTC(2026, 6, 15))).toBe(5.5 * HOUR);
    expect(offsetAt({ tz: 'Asia/Kathmandu' }, Date.UTC(2026, 6, 15))).toBe(5.75 * HOUR);
    expect(offsetAt({ tz: 'Australia/Lord_Howe' }, Date.UTC(2026, 6, 15))).toBe(10.5 * HOUR);
    expect(offsetAt({ tz: 'Australia/Lord_Howe' }, Date.UTC(2026, 0, 15))).toBe(11 * HOUR);
  });

  test('a range is cut exactly where the offset changes', () => {
    // New York springs forward at 2am EST on 8 March 2026 (07:00 UTC) and falls back at 2am EDT on 1 November (06:00 UTC).
    expect(offsetPieces(NY, Date.UTC(2026, 2, 1), Date.UTC(2026, 2, 20))).toEqual([
      { from: Date.UTC(2026, 2, 1), to: Date.UTC(2026, 2, 8, 7), offset: -5 * HOUR },
      { from: Date.UTC(2026, 2, 8, 7), to: Date.UTC(2026, 2, 20), offset: -4 * HOUR },
    ]);
    const year = offsetPieces(NY, Date.UTC(2026, 0, 1), Date.UTC(2027, 0, 1));
    expect(year.map((p) => p.offset / HOUR)).toEqual([-5, -4, -5]);
    expect(year[2].from).toBe(Date.UTC(2026, 10, 1, 6));
    expect(offsetPieces({ offset: 60 }, 0, 10)).toEqual([{ from: 0, to: 10, offset: HOUR }]);
  });

  test('whole local days, today last: the first day, its weekday, and the hour holding now', () => {
    // 10 March 2026, 12:30 in New York (EDT): 16:30 UTC.
    const now = Date.UTC(2026, 2, 10, 16, 30);
    const r = localRange(NY, 3, now);
    expect(r.firstDay).toBe('2026-03-08');
    expect(r.firstWeekday).toBe(6); // a Sunday
    expect(r.hours).toBe(72);
    expect(r.nowHour).toBe(48 + 12);
    expect(r.from).toBe(Date.UTC(2026, 2, 8, 5)); // midnight EST
    // Just after midnight UTC is still the evening before in New York.
    expect(localRange(NY, 1, Date.UTC(2026, 2, 11, 2)).firstDay).toBe('2026-03-10');
    expect(localRange({ offset: 330 }, 1, Date.UTC(2026, 2, 10, 19)).firstDay).toBe('2026-03-11');
  });
});

describe('presence', () => {
  test('merged across identities: the most present state wins, unknown left out', () => {
    const merged = mergePresence(
      [
        { before: null, changes: [{ at: 10, state: 'online' }, { at: 40, state: 'offline' }] },
        { before: 'idle', changes: [{ at: 20, state: 'dnd' }, { at: 50, state: 'offline' }] },
      ],
      0,
      60,
    );
    expect(merged).toEqual([
      { from: 0, to: 10, state: 'idle' },
      { from: 10, to: 40, state: 'online' },
      { from: 40, to: 50, state: 'dnd' },
      { from: 50, to: 60, state: 'offline' },
    ]);
    expect(mergePresence([{ before: null, changes: [] }], 0, 60)).toEqual([]);
    // The same state again from another identity is one stretch.
    expect(mergePresence([{ before: 'online', changes: [] }, { before: null, changes: [{ at: 30, state: 'online' }] }], 0, 60)).toEqual([{ from: 0, to: 60, state: 'online' }]);
  });

  test('seconds per local hour across a fall-back night: the repeated hour holds two hours', () => {
    // 1 November 2026 in New York: 1am happens twice. Noon the day after, so 1 November is the first day.
    const now = Date.UTC(2026, 10, 2, 17);
    const r = localRange(NY, 2, now);
    const pieces = rangePieces(NY, r, now);
    const p = presenceHours([{ from: Date.UTC(2026, 10, 1, 4), to: Date.UTC(2026, 10, 1, 8), state: 'online' }], pieces, r);
    const online = (h: number) => p.hours.find((x) => x[0] === h)?.[1] ?? 0;
    // 00:00 EDT to 03:00 EST is four hours of time over three hours of the clock.
    expect([0, 1, 2, 3].map(online)).toEqual([3600, 7200, 3600, 0]);
    expect(p.stretches).toEqual([
      [0, 2, 'online'],
      [1, 3, 'online'],
    ]);
  });

  test('a spring-forward night skips an hour', () => {
    const now = Date.UTC(2026, 2, 9, 16);
    const r = localRange(NY, 2, now);
    const p = presenceHours([{ from: Date.UTC(2026, 2, 8, 5), to: Date.UTC(2026, 2, 8, 9), state: 'idle' }], rangePieces(NY, r, now), r);
    const idle = (h: number) => p.hours.find((x) => x[0] === h)?.[2] ?? 0;
    // 00:00 EST to 05:00 EDT: four hours, and no 2am.
    expect([0, 1, 2, 3, 4, 5].map(idle)).toEqual([3600, 3600, 0, 3600, 3600, 0]);
    expect(p.stretches).toEqual([
      [0, 2, 'idle'],
      [3, 5, 'idle'],
    ]);
  });
});

describe('the store and the endpoint', () => {
  const dir = mkdtempSync(join(tmpdir(), 'dither-activitychart-'));
  let port = 0;
  let store: Store;
  let hub: HubServer;
  let sig: AccountRow;
  let dc: AccountRow;
  let n = 0;
  const ON: P.RetentionSettings = { ...DEFAULT_RETENTION, adversarial: true, statuses: true, presence: true };
  const say = (acc: AccountRow, conversation: string, author: string, ts: number) =>
    store.ingest(acc, { t: 'message', message: { nativeId: `m${++n}`, conversation, author, ts, body: 'x' } });
  const ann = () => store.one<{ person_id: string }>('SELECT person_id FROM identity WHERE id = ?', hubId('idn', 'signal', 'ann'))!.person_id;
  // Two weeks before a fall-back night, and the week after it, in New York.
  const NOW = Date.UTC(2026, 10, 4, 17); // Wednesday 4 November, noon EST

  beforeAll(() => {
    store = new Store(join(dir, 'hub.sqlite'), (raw) => raw ?? null);
    // One transaction: one write to disk, not one per event (seconds on a busy disk).
    store.db.transaction(() => {
      sig = store.createAccount({ network: 'signal', label: 's', color: '#000', adapter: 'signal' });
      dc = store.createAccount({ network: 'discord', label: 'd', color: '#111', adapter: 'discord' });
      store.ingest(sig, { t: 'status', status: 'online', self: { nativeId: 'me', displayName: 'Me', isSelf: true } });
      store.ingest(dc, { t: 'status', status: 'online', self: { nativeId: 'dme', displayName: 'Me', isSelf: true } });
      store.setRetention(ON);
      store.ingest(sig, { t: 'identity', identity: { nativeId: 'ann', displayName: 'Ann' } });
      store.ingest(dc, { t: 'identity', identity: { nativeId: 'ann-d', displayName: 'Ann' } });
      store.ingest(sig, { t: 'conversation', conversation: { nativeId: 'dm-ann', shape: 'direct', participants: ['me', 'ann'] } });
      store.ingest(sig, { t: 'conversation', conversation: { nativeId: 'g1', shape: 'group', name: 'Climbing', participants: ['me', 'ann', 'bob'] } });
      store.ingest(dc, { t: 'space', space: { nativeId: 'guild', kind: 'community', name: 'Guild' } });
      store.ingest(dc, { t: 'conversation', conversation: { nativeId: 'general', shape: 'channel', name: 'general', spaces: [{ nativeId: 'guild' }] } });
      // One person on two networks.
      store.mergePersons(store.ensurePerson(hubId('idn', 'signal', 'ann')), store.ensurePerson(hubId('idn', 'discord', 'ann-d')));
      // Sunday 1 November: 1:30 EDT (05:30 UTC) and 1:30 EST (06:30 UTC) are the same hour of the clock; 3:10 EST.
      say(sig, 'dm-ann', 'ann', Date.UTC(2026, 10, 1, 5, 30));
      say(sig, 'dm-ann', 'ann', Date.UTC(2026, 10, 1, 6, 30));
      say(sig, 'dm-ann', 'ann', Date.UTC(2026, 10, 1, 8, 10));
      say(sig, 'g1', 'ann', Date.UTC(2026, 10, 3, 1)); // Monday 2 November, 8pm EST
      say(dc, 'general', 'ann-d', Date.UTC(2026, 10, 3, 2)); // 9pm
      say(dc, 'general', 'ann-d', Date.UTC(2026, 10, 3, 2, 30));
      say(sig, 'dm-ann', 'me', Date.UTC(2026, 10, 3, 1, 5)); // you, back
      say(sig, 'g1', 'me', Date.UTC(2026, 10, 3, 1, 6));
      say(dc, 'general', 'dme', Date.UTC(2026, 10, 3, 2, 1)); // a server: not to them
      say(sig, 'dm-ann', 'ann', Date.UTC(2026, 9, 1)); // long before the range
      store.ingest(sig, { t: 'message', message: { nativeId: 'sys', conversation: 'g1', author: 'ann', ts: Date.UTC(2026, 10, 3, 1), body: 'Ann joined', kind: 'system' } });
      store.ingest(dc, { t: 'reaction', conversation: 'general', message: `m${n - 4}`, author: 'ann-d', key: '👍' });
      // Presence on both networks, and two statuses.
      store.ingest(dc, { t: 'presence', who: 'ann-d', state: 'online', ts: Date.UTC(2026, 10, 3, 1) });
      store.ingest(sig, { t: 'presence', who: 'ann', state: 'idle', ts: Date.UTC(2026, 10, 3, 1, 30) });
      store.ingest(dc, { t: 'presence', who: 'ann-d', state: 'offline', ts: Date.UTC(2026, 10, 3, 3) });
      store.ingest(dc, { t: 'customStatus', who: 'ann-d', text: 'climbing', ts: Date.UTC(2026, 10, 2, 12) });
      store.ingest(dc, { t: 'customStatus', who: 'ann-d', text: 'back', emoji: '🧗', ts: Date.UTC(2026, 10, 3, 12) });
    })();
    store.flush();
    hub = new HubServer(store, { authorize: () => null, online: () => false } as any, new Triage(store), { port: 0, hostname: '127.0.0.1', dataDir: dir, webDist: dir, secret: 's' });
    port = hub.start().port!;
  });
  afterAll(() => {
    hub.stop();
    store.db.close();
    rmSync(dir, { recursive: true, force: true });
  });

  test('their messages by local hour, both identities, by where and network; system lines left out', () => {
    const v = store.activityChart({ personId: ann() }, 7, NY, NOW)!;
    expect(v.firstDay).toBe('2026-10-29');
    expect(v.zone).toBe('America/New_York');
    expect(total(v.sent)).toBe(6);
    const sun = 3 * 24; // 1 November is the fourth day
    expect([at(v.sent, sun + 1), at(v.sent, sun + 2), at(v.sent, sun + 3)]).toEqual([2, 0, 1]);
    expect([at(v.sent, sun + 24 + 20), at(v.sent, sun + 24 + 21)]).toEqual([1, 2]);
    expect(v.sent.map((s) => [s.where, s.network, s.count]).sort()).toEqual([
      ['dm', 'signal', 3],
      ['group', 'signal', 1],
      ['server', 'discord', 2],
    ]);
    // Monday is 0: Sunday 1am holds two, Monday 9pm two.
    expect(v.week.sent[6 * 24 + 1]).toBe(2);
    expect(v.week.sent[0 * 24 + 21]).toBe(2);
    expect(v.week.sent.reduce((a, b) => a + b, 0)).toBe(6);
  });

  test('your messages in their DMs and groups, not in servers; reactions at the message’s hour', () => {
    const v = store.activityChart({ personId: ann() }, 7, NY, NOW)!;
    expect(v.mine!.map((s) => [s.where, s.count]).sort()).toEqual([
      ['dm', 1],
      ['group', 1],
    ]);
    expect(v.week.mine![0 * 24 + 20]).toBe(2);
    expect(v.reactions.count).toBe(1);
    expect(v.reactions.hours[4 * 24 + 21]).toBe(1);
  });

  test('presence and statuses only while logged; merged across identities when they are', () => {
    const v = store.activityChart({ personId: ann() }, 7, NY, NOW)!;
    // Online on Discord from 8pm, idle on Signal from 8:30, offline on Discord from 10pm: online, then idle.
    const mon = 4 * 24;
    expect(v.nowHour).toBe(6 * 24 + 12);
    expect(v.presence!.stretches).toEqual([
      [mon + 20, mon + 22, 'online'],
      [mon + 22, 6 * 24 + 12, 'idle'],
    ]);
    expect(v.presence!.hours.find((h) => h[0] === mon + 20)).toEqual([mon + 20, 3600, 0, 0, 0]);
    expect(v.week.online![0 * 24 + 20]).toBe(3600);
    expect(v.week.known![0 * 24 + 23]).toBe(3600);
    expect(v.statuses!.map((s) => [s.text, s.emoji, s.network])).toEqual([['back', '🧗', 'discord']]);

    store.setRetention({ ...ON, presence: false, statuses: false });
    const off = store.activityChart({ personId: ann() }, 7, NY, NOW)!;
    expect('presence' in off).toBe(false);
    expect('statuses' in off).toBe(false);
    expect('online' in off.week).toBe(false);
    // Kept, but adversarial features hidden: the same.
    store.setRetention({ ...ON, adversarial: false });
    const hidden = store.activityChart({ personId: ann() }, 7, NY, NOW)!;
    expect(hidden.presence).toBeUndefined();
    expect(hidden.statuses).toBeUndefined();
    store.setRetention(ON);
  });

  test('one identity alone, your own page, and range clamping', () => {
    const one = store.activityChart({ identityId: hubId('idn', 'discord', 'ann-d') }, 7, NY, NOW)!;
    expect(one.sent.map((s) => s.network)).toEqual(['discord']);
    const self = store.activityChart({ identityId: hubId('idn', 'signal', 'me') }, 7, NY, NOW)!;
    expect(self.mine).toBeUndefined();
    expect(total(self.sent)).toBe(2);
    const long = store.activityChart({ personId: ann() }, 40, NY, NOW)!;
    expect(long.sent.every((s) => s.hours.length === 40 * 24)).toBe(true);
    expect(total(long.sent)).toBe(7);
    expect(store.activityChart({ personId: 'per_nobody' }, 7, NY, NOW)).toBeNull();
  });

  test('a half-hour zone puts a message in its own local hour', () => {
    // 01:00, 02:00 and 02:30 UTC on 3 November are 06:30, 07:30 and 08:00 in Kolkata.
    const v = store.activityChart({ personId: ann() }, 7, { tz: 'Asia/Kolkata' }, NOW)!;
    expect(v.firstDay).toBe('2026-10-29');
    expect([5, 6, 7, 8].map((h) => at(v.sent, 5 * 24 + h))).toEqual([0, 1, 1, 1]);
    // The same as a fixed offset.
    const fixed = store.activityChart({ personId: ann() }, 7, { offset: 330 }, NOW)!;
    expect(fixed.sent.map((s) => s.hours.join())).toEqual(v.sent.map((s) => s.hours.join()));
  });

  test('the endpoint: a person or an identity, the zone checked, days clamped', async () => {
    const get = (q: string) => fetch(`http://127.0.0.1:${port}${q}`, { headers: { origin: `http://127.0.0.1:${port}` } });
    const r = await get(`/api/people/${ann()}/activity?days=7&tz=America/New_York`);
    expect(r.status).toBe(200);
    const v = (await r.json()) as P.ActivityChartView;
    expect(v.days).toBe(7);
    expect(v.sent.every((s) => s.hours.length === 168)).toBe(true);
    expect(((await (await get(`/api/people/${ann()}/activity?days=5000&offset=60`)).json()) as P.ActivityChartView).days).toBe(365);
    expect(((await (await get(`/api/people/${hubId('idn', 'discord', 'ann-d')}/activity`)).json()) as P.ActivityChartView).zone).toBe('UTC');
    expect((await get(`/api/people/${ann()}/activity?tz=Mars/Olympus`)).status).toBe(400);
    expect((await get(`/api/people/per_nobody/activity`)).status).toBe(404);
  });
});
