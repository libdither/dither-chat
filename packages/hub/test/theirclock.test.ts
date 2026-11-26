/**
 * Their time (theirclock.ts, docs/profile.md "Their time"): a zone a profile states wins; else an offset guessed from
 * the hours they are around in (writing, reacting, reading, coming online…), shown only when sure enough; their usual
 * day by hour with intervals, and their usual night.
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { Database } from 'bun:sqlite';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type * as P from '@dither-chat/protocol';
import { hubId } from '@dither-chat/protocol/ids';
import { HOUR, offsetAt } from '../src/activitychart.ts';
import { rhythmTimes, type Rhythm } from '../src/demo-clocks.ts';
import { HubServer } from '../src/server.ts';
import { Store } from '../src/store.ts';
import { Clocks, guessOffset, usualDay } from '../src/theirclock.ts';
import { Triage } from '../src/triage.ts';

const NOW = Date.UTC(2026, 10, 20, 15, 0);
const DAY = 24 * HOUR;
const person = (zone: string, wake = 8, sleep = 24.5): Rhythm => ({ zone, wake, sleep, perDay: 8, active: 0.8 });

describe('guessing an offset from when they write', () => {
  const zones = ['Asia/Tokyo', 'Europe/Berlin', 'America/Chicago', 'America/Los_Angeles', 'Australia/Sydney', 'Asia/Kolkata', 'America/Sao_Paulo', 'Europe/London'];
  const err = (offset: number, zone: string) => {
    const e = offset / 60 - offsetAt({ tz: zone }, NOW) / HOUR;
    return (((e + 12) % 24) + 24) % 24 - 12;
  };
  for (const zone of zones)
    test(`six weeks of an ordinary day in ${zone}: within an hour (half-hour zones an hour and a half), and sure enough to show`, () => {
      for (const seed of [1, 2, 3]) {
        const g = guessOffset(rhythmTimes(person(zone), 42, NOW, seed), null)!;
        expect(Math.abs(err(g.offset, zone))).toBeLessThanOrEqual(1.5);
        expect(g.sure).toBeGreaterThanOrEqual(0.65);
      }
    });

  test('someone who writes only in the evening, or only at work, could be anywhere in a long quiet: never sure enough to show', () => {
    for (const zone of zones)
      for (const r of [{ ...person(zone), from: 18 }, { ...person(zone, 9, 18) }]) {
        const g = guessOffset(rhythmTimes(r, 42, NOW, 7), null)!;
        expect(g.sure).toBeLessThan(0.65);
      }
  });

  test("an owl's late night reads as a zone or more west: rhythm alone cannot tell them apart", () => {
    const owl = guessOffset(rhythmTimes(person('America/New_York', 11, 27), 42, NOW, 9), null)!;
    expect(err(owl.offset, 'America/New_York')).toBeLessThanOrEqual(-2);
  });

  test('a few days are less sure than six weeks', () => {
    const few = guessOffset(rhythmTimes(person('Asia/Tokyo'), 5, NOW, 5), null)!;
    const many = guessOffset(rhythmTimes(person('Asia/Tokyo'), 42, NOW, 5), null)!;
    expect(few.sure).toBeLessThan(many.sure);
  });

  test('your own offset is a little likelier, and the chances add up to one', () => {
    const ts = rhythmTimes(person('Europe/Berlin'), 30, NOW, 4);
    const alone = guessOffset(ts, null)!;
    const near = guessOffset(ts, 60)!;
    expect(near.post.length).toBe(24);
    expect(near.post.reduce((a, b) => a + b, 0)).toBeCloseTo(1, 6);
    expect(near.post[12]).toBeGreaterThan(alone.post[12]);
  });

  test('nothing to go on: no guess', () => {
    expect(guessOffset([], null)).toBeNull();
  });
});

describe('their usual day', () => {
  test('by hour in their zone: the night empty, the day busy, intervals around each share', () => {
    const ts = rhythmTimes(person('Asia/Tokyo'), 60, NOW, 3);
    const d = usualDay(ts, { tz: 'Asia/Tokyo' }, NOW);
    expect(d.hours.length).toBe(24);
    expect(d.week.length).toBe(168);
    expect(d.weekDays.reduce((a, b) => a + b, 0)).toBe(d.days);
    for (const h of [3, 4, 5]) expect(d.hours[h][0]).toBeLessThan(5);
    for (const [p, lo, hi, wrote] of d.hours) expect(lo <= p && p <= hi && wrote === p).toBe(true);
    const mean = (xs: number[][]) => xs.reduce((n, x) => n + x[0], 0) / xs.length;
    expect(mean(d.hours.slice(9, 23))).toBeGreaterThan(5 * mean(d.hours.slice(2, 6)) + 5);
    // In bed around half past midnight, up around eight (an hour later at weekends): quiet from a little before the
    // one to a little after the other.
    expect(d.quiet).toBeDefined();
    const near = (a: number, b: number, by: number) => Math.abs((((a - b) % 1440) + 2160) % 1440 - 720) <= by;
    expect(near(d.quiet!.from, 0, 75)).toBe(true);
    expect(near(d.quiet!.to, 8.75 * 60, 75)).toBe(true);
    expect(d.quiet!.fromSpread).toBeLessThan(90);
    expect(d.quiet!.nights).toBeGreaterThanOrEqual(7);
  });

  test('in another zone the same day moves by the difference', () => {
    const ts = rhythmTimes(person('Asia/Tokyo'), 60, NOW, 3);
    const tokyo = usualDay(ts, { tz: 'Asia/Tokyo' }, NOW);
    const utc = usualDay(ts, { offset: 0 }, NOW);
    const quietest = (h: number[][]) => h.map((x) => x[0]).indexOf(Math.min(...h.map((x) => x[0])));
    expect((quietest(utc.hours) + 9) % 24).toBe(quietest(tokyo.hours));
  });

  test('around and wrote: hours they only react in count as around, not as written', () => {
    const wrote = rhythmTimes(person('Asia/Tokyo', 18, 24.5), 60, NOW, 3);
    const mornings = rhythmTimes(person('Asia/Tokyo', 8, 12), 60, NOW, 4);
    const d = usualDay([...wrote, ...mornings].sort((a, b) => a - b), { tz: 'Asia/Tokyo' }, NOW, 90, wrote);
    for (const [p, , , w] of d.hours) expect(w).toBeLessThanOrEqual(p);
    const sum = (from: number, to: number, i: number) => d.hours.slice(from, to).reduce((n, h) => n + h[i], 0);
    // Mornings: around, never written in; evenings written in.
    expect(sum(8, 12, 0)).toBeGreaterThan(100);
    expect(sum(8, 12, 3)).toBe(0);
    expect(sum(18, 24, 3)).toBeGreaterThan(50);
  });

  test('too few nights: no usual night', () => {
    const d = usualDay(rhythmTimes(person('Europe/Berlin'), 4, NOW, 2), { tz: 'Europe/Berlin' }, NOW);
    expect(d.quiet).toBeUndefined();
  });
});

describe('clocks from the database', () => {
  function world() {
    const db = new Database(':memory:');
    db.exec(`CREATE TABLE person (id TEXT PRIMARY KEY, is_self INTEGER DEFAULT 0);
      CREATE TABLE identity (id TEXT PRIMARY KEY, person_id TEXT, network TEXT);
      CREATE TABLE account (id TEXT PRIMARY KEY, self_identity TEXT);
      CREATE TABLE about (target_id TEXT, account_id TEXT, data TEXT, fetched_at INTEGER);
      CREATE TABLE message (id INTEGER PRIMARY KEY, author_id TEXT, ts INTEGER, kind TEXT DEFAULT 'text');
      CREATE TABLE reaction (message_id TEXT, identity_id TEXT, key TEXT, at INTEGER, at_exact INTEGER DEFAULT 0);
      CREATE TABLE receipt (message_id TEXT, identity_id TEXT, state TEXT, at INTEGER);
      CREATE TABLE change_log (id INTEGER PRIMARY KEY, target_kind TEXT, target_id TEXT, field TEXT, old TEXT, new TEXT, at INTEGER);`);
    const add = (id: string, network: string, person: string | null, times: number[]) => {
      db.query('INSERT INTO identity VALUES (?, ?, ?)').run(id, person, network);
      for (const t of times) db.query('INSERT INTO message (author_id, ts) VALUES (?, ?)').run(id, t);
    };
    db.query('INSERT INTO person VALUES (?, 0)').run('per_mika');
    add('idn_mika_dc', 'discord', 'per_mika', rhythmTimes(person('Asia/Tokyo'), 42, NOW, 1));
    add('idn_mika_sig', 'signal', 'per_mika', []);
    add('idn_new', 'discord', null, rhythmTimes(person('Asia/Tokyo'), 3, NOW, 1));
    add('idn_zulip', 'zulip', null, []);
    db.query('INSERT INTO about VALUES (?, ?, ?, ?)').run('idn_zulip', 'acc_z', JSON.stringify({ timeZone: 'Europe/Berlin' }), NOW - DAY);
    add('idn_old_zulip', 'zulip', null, []);
    db.query('INSERT INTO about VALUES (?, ?, ?, ?)').run('idn_old_zulip', 'acc_z', JSON.stringify({ facts: [{ label: 'Time zone', value: 'Asia/Kolkata' }] }), NOW - DAY);
    add('idn_matrix', 'matrix', null, []);
    add('idn_me', 'discord', null, rhythmTimes(person('Asia/Tokyo'), 42, NOW, 1));
    db.query('INSERT INTO account VALUES (?, ?)').run('acc_me', 'idn_me');
    return db;
  }

  test("a profile's zone, an older profile's fact, a guess across a person's identities, nothing for a newcomer or yourself", () => {
    const asked: string[] = [];
    const c = new Clocks({ db: world(), now: () => NOW, askProfile: async (id) => void asked.push(id) });
    const v = c.clocks(['idn_zulip', 'idn_old_zulip', 'idn_mika_sig', 'idn_new', 'idn_me', 'idn_nobody'], -360);
    expect(v.clocks.idn_zulip).toEqual({ source: 'profile', zone: 'Europe/Berlin', network: 'zulip' });
    expect(v.clocks.idn_old_zulip).toEqual({ source: 'profile', zone: 'Asia/Kolkata', network: 'zulip' });
    const mika = v.clocks.idn_mika_sig!;
    expect(mika.source).toBe('rhythm');
    expect(mika.source === 'rhythm' && Math.abs(mika.offset - 9 * 60)).toBeLessThanOrEqual(60);
    expect(v.clocks.idn_new).toBeNull();
    expect(v.clocks.idn_me).toBeNull();
    expect(v.clocks.idn_nobody).toBeNull();
    expect(asked).toEqual([]);
  });

  test("a Matrix author with no kept profile: its profile is asked once, and the answer's zone is used after", async () => {
    const db = world();
    let done!: () => void;
    const answered = new Promise<void>((r) => (done = r));
    const asked: string[] = [];
    const c = new Clocks({
      db,
      now: () => NOW,
      askProfile: async (id) => {
        asked.push(id);
        db.query('INSERT INTO about VALUES (?, ?, ?, ?)').run(id, 'acc_m', JSON.stringify({ timeZone: 'America/Denver' }), NOW);
        queueMicrotask(done);
      },
    });
    const first = c.clocks(['idn_matrix'], 0);
    expect(first.asking).toEqual(['idn_matrix']);
    await answered;
    // The ask's .finally runs after the answer is kept.
    await Promise.resolve();
    const second = c.clocks(['idn_matrix'], 0);
    expect(second.clocks.idn_matrix).toEqual({ source: 'profile', zone: 'America/Denver', network: 'matrix' });
    expect(second.asking).toBeUndefined();
    expect(asked).toEqual(['idn_matrix']);
  });

  test('a zone set by hand wins over a profile and a guess, for every identity of the person, until cleared', () => {
    let pins: Record<string, string> = {};
    const c = new Clocks({ db: world(), now: () => NOW, pins: { get: () => pins, set: (m) => (pins = m) } });
    expect(c.pin('idn_mika_dc', 'America/Denver')).toBe(true);
    expect(pins).toEqual({ per_mika: 'America/Denver' });
    expect(c.clocks(['idn_mika_sig'], 0).clocks.idn_mika_sig).toEqual({ source: 'pinned', zone: 'America/Denver' });
    expect(c.pin('idn_zulip', 'Asia/Seoul')).toBe(true);
    expect(c.clocks(['idn_zulip'], 0).clocks.idn_zulip).toEqual({ source: 'pinned', zone: 'Asia/Seoul' });
    expect(c.pin('idn_zulip', 'Not/AZone')).toBe(false);
    expect(c.pin('idn_nobody', 'Asia/Seoul')).toBe(false);
    expect(c.pin('per_mika', null)).toBe(true);
    expect(c.clocks(['idn_mika_sig'], 0).clocks.idn_mika_sig?.source).toBe('rhythm');
  });

  /** Someone who wrote a few times only, but reacted, read and came online through six weeks in Tokyo. */
  function quietWriter(db: Database, presence: { at: number; state: string }[] = []) {
    const times = rhythmTimes(person('Asia/Tokyo'), 42, NOW, 21);
    db.query('INSERT INTO identity VALUES (?, ?, ?)').run('idn_lurk', null, 'signal');
    times.slice(-4).forEach((t) => db.query('INSERT INTO message (author_id, ts) VALUES (?, ?)').run('idn_lurk', t));
    times.forEach((t, i) =>
      i % 3 ? db.query('INSERT INTO reaction VALUES (?, ?, ?, ?, 1)').run(`m${i}`, 'idn_lurk', '👍', t) : db.query("INSERT INTO receipt VALUES (?, ?, 'read', ?)").run(`m${i}`, 'idn_lurk', t),
    );
    // A delivery is their phone, not them: never counted.
    db.query("INSERT INTO receipt VALUES ('m0', 'idn_lurk', 'delivered', ?)").run(NOW - 3 * HOUR);
    for (const p of presence) db.query("INSERT INTO change_log (target_kind, target_id, field, new, at) VALUES ('identity', 'idn_lurk', 'presence', ?, ?)").run(JSON.stringify({ state: p.state }), p.at);
  }

  test('reactions and reads place someone who barely writes, and their day counts each kind', () => {
    const db = world();
    quietWriter(db);
    const c = new Clocks({ db, now: () => NOW });
    const v = c.clocks(['idn_lurk', 'idn_mika_dc'], -360);
    const g = v.clocks.idn_lurk!;
    expect(g.source === 'rhythm' && Math.abs(g.offset - 540) <= 60 && g.days >= 10).toBe(true);
    const d = c.day('idn_lurk', { tz: 'America/Chicago' })!;
    expect(d.counts.messages).toBe(4);
    expect(d.counts.reactions! + d.counts.reads!).toBeGreaterThan(100);
    expect(d.counts.presence).toBeUndefined();
    // Batched or one at a time, the same guess.
    expect(new Clocks({ db, now: () => NOW }).clocks(['idn_lurk'], -360).clocks.idn_lurk).toEqual(g);
  });

  test('presence: coming online and leaving it count, idle to offline and a restart burst do not, nor anything while it is not logged', () => {
    const db = world();
    const t0 = NOW - 2 * DAY;
    quietWriter(db, [
      { at: t0, state: 'online' },
      { at: t0 + HOUR, state: 'idle' },
      { at: t0 + 5 * HOUR, state: 'offline' },
      { at: t0 + 9 * HOUR, state: 'dnd' },
      { at: t0 + 10 * HOUR, state: 'online' },
      { at: t0 + 11 * HOUR, state: 'offline' },
    ]);
    // A fresh snapshot after a restart: everyone heard again in one minute.
    const burst = t0 + 20 * HOUR;
    for (let i = 0; i < 45; i++) db.query("INSERT INTO change_log (target_kind, target_id, field, new, at) VALUES ('identity', ?, 'presence', ?, ?)").run(i ? `idn_other${i}` : 'idn_lurk', JSON.stringify({ state: 'online' }), burst + i);
    const day = (presence: boolean) => new Clocks({ db, now: () => NOW, logged: () => ({ presence, statuses: false }) }).day('idn_lurk', { offset: 0 })!;
    // Online, off to idle, back (to do not disturb), to offline: four; idle to offline, dnd to online and the burst, none.
    expect(day(true).counts.presence).toBe(4);
    expect(day(false).counts.presence).toBeUndefined();
  });

  test('their day comes in their zone when it is known, in yours when not', () => {
    const c = new Clocks({ db: world(), now: () => NOW });
    const mika = c.day('per_mika', { tz: 'America/Chicago' })!;
    expect(mika.frame.theirs).toBe(true);
    expect(Math.abs(mika.frame.offsetNow - 540)).toBeLessThanOrEqual(60);
    const newcomer = c.day('idn_new', { tz: 'America/Chicago' })!;
    expect(newcomer.clock).toBeNull();
    expect(newcomer.frame).toEqual({ theirs: false, zone: 'America/Chicago', offsetNow: -360 });
    expect(c.day('idn_nobody', { offset: 0 })).toBeNull();
  });
});

describe('the endpoints', () => {
  const dir = mkdtempSync(join(tmpdir(), 'dither-theirclock-'));
  let port = 0;
  let store: Store;
  let hub: HubServer;
  const ann = hubId('idn', 'signal', 'ann');
  const ada = hubId('idn', 'zulip', 'ada');
  const annPerson = () => store.one<{ person_id: string }>('SELECT person_id FROM identity WHERE id = ?', ann)!.person_id;
  const get = (q: string, init?: RequestInit) => fetch(`http://127.0.0.1:${port}${q}`, { ...init, headers: { origin: `http://127.0.0.1:${port}`, 'content-type': 'application/json' } });

  beforeAll(() => {
    store = new Store(join(dir, 'hub.sqlite'), (raw) => raw ?? null);
    // Their messages run up to now: the hub reads the last 90 days from the real clock.
    const now = Date.now();
    store.db.transaction(() => {
      const sig = store.createAccount({ network: 'signal', label: 's', color: '#000', adapter: 'signal' });
      const dc = store.createAccount({ network: 'discord', label: 'd', color: '#111', adapter: 'discord' });
      const zl = store.createAccount({ network: 'zulip', label: 'z', color: '#222', adapter: 'zulip' });
      store.ingest(sig, { t: 'status', status: 'online', self: { nativeId: 'me', displayName: 'Me', isSelf: true } });
      store.ingest(dc, { t: 'status', status: 'online', self: { nativeId: 'dme', displayName: 'Me', isSelf: true } });
      store.ingest(zl, { t: 'status', status: 'online', self: { nativeId: 'zme', displayName: 'Me', isSelf: true } });
      store.ingest(sig, { t: 'identity', identity: { nativeId: 'ann', displayName: 'Ann' } });
      store.ingest(dc, { t: 'identity', identity: { nativeId: 'ann-d', displayName: 'Ann' } });
      store.ingest(zl, { t: 'identity', identity: { nativeId: 'ada', displayName: 'Ada' } });
      store.ingest(sig, { t: 'conversation', conversation: { nativeId: 'dm-ann', shape: 'direct', participants: ['me', 'ann'] } });
      store.ingest(dc, { t: 'conversation', conversation: { nativeId: 'dm-ann-d', shape: 'direct', participants: ['dme', 'ann-d'] } });
      store.mergePersons(store.ensurePerson(ann), store.ensurePerson(hubId('idn', 'discord', 'ann-d')));
      // Ann in Tokyo, on both networks; what she writes on Discord counts for her Signal identity too.
      rhythmTimes(person('Asia/Tokyo'), 42, now, 11).forEach((ts, i) =>
        i % 2 ? store.ingest(sig, { t: 'message', message: { nativeId: `s${i}`, conversation: 'dm-ann', author: 'ann', ts, body: 'x' } }) : store.ingest(dc, { t: 'message', message: { nativeId: `d${i}`, conversation: 'dm-ann-d', author: 'ann-d', ts, body: 'x' } }),
      );
      store.db.query('INSERT INTO about (target_id, account_id, data, fetched_at) VALUES (?, ?, ?, ?)').run(ada, zl.id, JSON.stringify({ timeZone: 'Europe/Berlin' }), now);
    })();
    store.flush();
    hub = new HubServer(store, { authorize: () => null, online: () => false } as any, new Triage(store), { port: 0, hostname: '127.0.0.1', dataDir: dir, webDist: dir, open: true, secret: 's' });
    port = hub.start().port!;
  });
  afterAll(() => {
    hub.stop();
    store.db.close();
    rmSync(dir, { recursive: true, force: true });
  });

  test("clocks: a guess for Ann across her accounts, Ada's profile zone; the zone checked", async () => {
    const v = (await (await get(`/api/people/clocks?ids=${ann},${ada},idn_nobody&tz=America/Chicago`)).json()) as P.TheirClocksView;
    const a = v.clocks[ann]!;
    expect(a.source === 'rhythm' && Math.abs(a.offset - 540) <= 60 && a.sure >= 0.65).toBe(true);
    expect(v.clocks[ada]).toEqual({ source: 'profile', zone: 'Europe/Berlin', network: 'zulip' });
    expect(v.clocks.idn_nobody).toBeNull();
    expect((await get(`/api/people/clocks?ids=${ann}&tz=Mars/Olympus`)).status).toBe(400);
  });

  test('day: in her zone, 24 hours and a week, her night; an unknown person is 404', async () => {
    const r = await get(`/api/people/${annPerson()}/day?tz=America/Chicago`);
    expect(r.status).toBe(200);
    const d = (await r.json()) as P.TheirDayView;
    expect(d.frame.theirs).toBe(true);
    expect(d.hours.length).toBe(24);
    expect(d.week.length).toBe(168);
    expect(d.quiet?.nights).toBeGreaterThanOrEqual(7);
    expect((await get(`/api/people/per_nobody/day?tz=UTC`)).status).toBe(404);
  });

  test('a zone set by hand, kept across a restart of the clocks, and cleared', async () => {
    const put = (zone: string | null, who = ann) => get(`/api/people/${who}/zone`, { method: 'PUT', body: JSON.stringify({ zone }) });
    expect((await put('Asia/Seoul')).status).toBe(200);
    expect(store.zonePins()).toEqual({ [annPerson()]: 'Asia/Seoul' });
    const v = (await (await get(`/api/people/clocks?ids=${hubId('idn', 'discord', 'ann-d')}&tz=UTC`)).json()) as P.TheirClocksView;
    expect(v.clocks[hubId('idn', 'discord', 'ann-d')]).toEqual({ source: 'pinned', zone: 'Asia/Seoul' });
    expect((await put('Not/AZone')).status).toBe(404);
    expect((await put('Asia/Seoul', 'idn_nobody')).status).toBe(404);
    expect((await put(null)).status).toBe(200);
    expect(store.zonePins()).toEqual({});
  });
});
