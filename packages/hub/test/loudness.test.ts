/**
 * One loudness scale (loudness.ts, loudlearn.ts, checkin.ts, docs/notifications.md): the bands from want, can-wait,
 * owed and the moment; your rules on top; each answer moving only the part it names; check-ins picked half at random
 * with their chance kept; and the tiers deciding while it runs in shadow.
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { rmSync } from 'node:fs';
import { join } from 'node:path';
import type * as P from '@dither-chat/protocol';
import { bandOf } from '@dither-chat/protocol';
import type { Facts } from '../src/learn.ts';
import { BAND_DECISION, emptyAttnModel, loudness, momentKeys, trainAttn, type AttnExample, type LoudInput, type Moment } from '../src/loudness.ts';
import { behaviourLabel, LoudLearner, routed } from '../src/loudlearn.ts';
import { PAUSE, SKIPS_TO_PAUSE } from '../src/checkin.ts';
import { Store, type AccountRow } from '../src/store.ts';
import { dayBounds, dayOf, loudnessScores } from '../src/scorecard.ts';
import { Triage } from '../src/triage.ts';
import { TriageVotes } from '../src/votes.ts';
import { memTempDir } from './fixtures/memdir.ts';

const MIN = 60_000;
const HOUR = 60 * MIN;
const DAY = 24 * HOUR;

const facts = (f: Partial<Facts> = {}): Facts => ({ network: 'signal', shape: 'direct', conversation: 'c1', spaces: [], author: 'p1', bot: false, mention: false, reply: false, question: false, urgent: false, active: false, media: false, base: 'drop', known: true, ...f });
const free: Moment = { desk: false, hour: 14, sinceSound: null, quiet: false };
const input = (x: Partial<LoudInput> = {}): LoudInput => ({ facts: facts(), words: ['coming', 'leave'], importance: 0.8, alert: 0.9, why: ['dm'], moment: free, ...x });

describe('the scale', () => {
  const m = emptyAttnModel();

  test('a DM that cannot wait sounds; at a desk it shows silently; in quiet hours it waits for the next look', () => {
    const now = loudness(input(), m);
    expect(now.band).toBe('sound');
    expect(now.loudness).toBeGreaterThanOrEqual(80);
    expect(bandOf(now.loudness)).toBe(now.band);
    const maybe = loudness(input({ alert: 0.5 }), m);
    expect(maybe.band).toBe('sound');
    const desk = loudness(input({ alert: 0.5, moment: { ...free, desk: true } }), m);
    expect(desk.loudness).toBeLessThan(maybe.loudness);
    expect(desk.band).not.toBe('sound');
    expect(desk.reasons.some((r) => r.text === 'A computer is in use' && r.by < 0)).toBe(true);
    const quiet = loudness(input({ moment: { ...free, quiet: true } }), m);
    expect(quiet.band).not.toBe('sound');
    expect(quiet.parts.quiet).toBe(true);
    expect(quiet.reasons.some((r) => r.text.startsWith('Quiet hours') && r.by < 0)).toBe(true);
  });

  test('a busy channel you do not take part in stays out of the way; one that keeps for days is not shown now', () => {
    const channel = loudness(input({ facts: facts({ shape: 'channel', author: 'p9', known: false }), importance: 0.2, alert: undefined, why: [] }), m);
    expect(['unread', 'inbox']).toContain(channel.band);
    // A group you are not talking in, that the network notifies: wanted, keeps for days, so it waits.
    const keeps = loudness(input({ facts: facts({ shape: 'group' }), alert: undefined, why: [] }), m);
    expect(['next', 'inbox']).toContain(keeps.band);
    // A friend's "ok" in a DM shows now, silently, as a Conversation did.
    expect(loudness(input({ alert: 0.01 }), m).band).toBe('show');
  });

  test('a second sound within minutes costs more than the first', () => {
    const first = loudness(input({ alert: 0.6 }), m);
    const burst = loudness(input({ alert: 0.6, moment: { ...free, sinceSound: 2 * MIN } }), m);
    expect(burst.loudness).toBeLessThan(first.loudness);
    expect(momentKeys({ ...free, sinceSound: 2 * MIN })).toContain('burst5');
    expect(momentKeys({ ...free, sinceSound: 20 * MIN })).toContain('burst30');
    expect(momentKeys({ ...free, hour: 2 })).toContain('hour:night');
  });

  test('your rules stay absolute: Always alert is 100, List only at most the next look', () => {
    expect(loudness(input({ rule: 'always', alert: 0.01, importance: 0.05 }), m)).toMatchObject({ loudness: 100, band: 'sound' });
    const listed = loudness(input({ rule: 'list' }), m);
    expect(['unread', 'inbox', 'next']).toContain(listed.band);
  });

  test('the nudge: less readily sounds less, more readily more; nothing caps it', () => {
    const base = loudness(input({ alert: 0.5 }), m).loudness;
    expect(loudness(input({ alert: 0.5 }), m, 'less').loudness).toBeLessThan(base);
    expect(loudness(input({ alert: 0.5 }), m, 'more').loudness).toBeGreaterThan(base);
  });

  test('every band is stored as a code older apps know', () => {
    expect(BAND_DECISION).toEqual({ sound: 'push', show: 'quiet', next: 'digest', inbox: 'digest', unread: 'drop' });
  });

  test('the reasons say how far each part moved it', () => {
    const r = loudness(input({ owed: 0.6 }), m).reasons;
    expect(r[0].by).toBe(0);
    const urgent = r.find((x) => x.text.startsWith("Can't wait an hour"));
    expect(urgent?.by).toBeGreaterThan(0);
    expect(r.some((x) => x.text === 'A direct message' && x.by > 0)).toBe(true);
    // A person waiting on you adds, most where it decides between the next look and the inbox.
    const later = (owed: number) => loudness(input({ alert: 0.01, importance: 0.3, why: [], owed }), m).loudness;
    expect(later(0.9)).toBeGreaterThan(later(0));
  });
});

describe('each answer moves only the part it names', () => {
  const base: AttnExample = { facts: facts({ shape: 'group', conversation: 'g1', author: 'ann', spaces: ['s1'] }), words: ['deploy', 'failed'], why: ['wrote'], importance: 0.5, alert: 0.3, moment: { keys: ['all', 'hour:day', 'desk'], by: 0 }, weight: 0, at: 0 };
  const ans = (x: Record<string, unknown>) => ({ at: 0, scope: null, reason: null, wait: null, ...x });
  const fit = (rows: AttnExample[]) => trainAttn(rows, new Set(), 0);

  test('"not this chat" moves the chat alone', () => {
    const mm = fit(routed(ans({ answer: 'quieter', reason: 'not_chat' }), base, 1));
    expect(Object.keys(mm.want)).toEqual(['conv:g1']);
    expect(mm.want['conv:g1']).toBeLessThan(0);
    expect(mm.wait).toEqual({});
    expect(mm.moment).toEqual({});
  });

  test('"this person matters" moves the person, on want and owed', () => {
    const mm = fit(routed(ans({ answer: 'louder', reason: 'person_matters' }), base, 1));
    expect(Object.keys(mm.want)).toEqual(['author:ann']);
    expect(mm.owed['author:ann']).toBeGreaterThan(0);
  });

  test('"not this topic" moves the words alone', () => {
    const mm = fit(routed(ans({ answer: 'quieter', reason: 'not_topic' }), base, 1));
    expect(Object.keys(mm.want).every((k) => k.startsWith('w:'))).toBe(true);
  });

  test('"bad moment" moves the cost of that moment, not the message', () => {
    const mm = fit(routed(ans({ answer: 'quieter', reason: 'bad_moment' }), base, 1));
    expect(mm.want).toEqual({});
    expect(mm.wait).toEqual({});
    expect(mm.moment.desk).toBeGreaterThan(0);
    const free = fit(routed(ans({ answer: 'louder', reason: 'was_free' }), base, 1));
    expect(free.moment.desk).toBeLessThan(0);
  });

  test('"could have waited an hour" is a label for the can-wait buckets, want unchanged', () => {
    const mm = fit(routed(ans({ answer: 'could_wait', reason: 'could_wait', wait: 'hour' }), base, 1));
    expect(mm.want).toEqual({});
    expect(Object.values(mm.wait).every((w) => w < 0)).toBe(true);
    expect(mm.moment.all).toBeGreaterThan(0);
  });

  test('"I had already seen it" teaches nothing', () => {
    expect(routed(ans({ answer: 'quieter', reason: 'seen' }), base, 1)).toEqual([]);
  });

  test('Louder for the chat, with no why, moves the chat on both chances', () => {
    const mm = fit(routed(ans({ answer: 'louder', scope: 'chat' }), base, 1));
    expect(Object.keys(mm.want)).toEqual(['conv:g1']);
    expect(Object.keys(mm.wait)).toEqual(['conv:g1']);
  });

  test('what you did: answered 0.3, opened 0.1, but not right after a sound, swiped 0.05', () => {
    const o = { id: 'm', conv: 'c', ts: 0, engaged: false, seenLive: false, nextOwn: null, answered: false, reacted: false, decision: 'quiet', notified: true, shown: true, suppressed: false, dismissed: false, tapped: null, tapDwell: null, opened: null, openDwell: null, burstFirst: true, lullFirst: true, unprompted: false, addressed: false, observed: 2 * DAY };
    expect(behaviourLabel({ ...o, answered: true, nextOwn: 10 * MIN })).toEqual({ want: 1, weight: 0.3 });
    expect(behaviourLabel({ ...o, opened: 30 * MIN, openDwell: 20 })).toEqual({ want: 1, weight: 0.1 });
    expect(behaviourLabel({ ...o, decision: 'push', tapped: 30_000, tapDwell: 20 })).toBeNull();
    expect(behaviourLabel({ ...o, decision: 'push', tapped: 30 * MIN, tapDwell: 20 })).toEqual({ want: 1, weight: 0.1 });
    expect(behaviourLabel({ ...o, dismissed: true })).toEqual({ want: 0, weight: 0.05 });
  });
});

describe('through the hub', () => {
  let dir: string;
  let store: Store;
  let acc: AccountRow;
  let triage: Triage;
  let votes: TriageVotes;
  let loud: LoudLearner;
  let n = 0;
  const conv = (nativeId: string) => store.one<{ id: string }>('SELECT id FROM conversation WHERE native_id = ?', nativeId)!.id;
  const post = (conversation: string, author: string, ts: number, body = 'are you still coming? we leave soon') => {
    const nativeId = `m${++n}`;
    store.ingest(acc, { t: 'message', message: { nativeId, conversation, author, ts, body }, live: true });
    return store.one<{ id: string }>('SELECT id FROM message WHERE native_id = ?', nativeId)!.id;
  };
  const decide = async (id: string, now: number) => {
    const d = (await triage.decide(id, now))!;
    store.setTriage(id, d, d.facts);
    return d;
  };

  beforeAll(() => {
    dir = memTempDir('dither-loud-');
    store = new Store(join(dir, 'hub.sqlite'), (raw) => raw ?? null);
    acc = store.createAccount({ network: 'signal', label: 's', color: '#000', adapter: 'signal' });
    store.ingest(acc, { t: 'status', status: 'online', self: { nativeId: 'me', isSelf: true, displayName: 'Me' } });
    acc = store.accounts().find((x) => x.id === acc.id)!;
    store.ingest(acc, { t: 'identity', identity: { nativeId: 'ann', displayName: 'Ann', contact: true } });
    store.ingest(acc, { t: 'conversation', conversation: { nativeId: 'dm', shape: 'direct', participants: ['ann', 'me'] } });
    store.ingest(acc, { t: 'conversation', conversation: { nativeId: 'g', shape: 'group', name: 'Club', participants: ['ann', 'bo', 'cy', 'me'] } });
    triage = new Triage(store);
    triage.judge = async (text) => (/coming|leave/.test(text) ? 0.6 : 0.01);
    votes = new TriageVotes(store, triage);
    loud = new LoudLearner(store, 'shadow');
    loud.mark = (id, marks) => void votes.mark(id, marks);
    triage.loud = loud;
    triage.momentOf = () => ({ desk: false, sinceSound: null });
  });
  afterAll(() => {
    store.db.close();
    rmSync(dir, { recursive: true, force: true });
  });

  test('in shadow the tiers decide, and the loudness is stored beside them', async () => {
    const T = Date.now();
    const id = post('dm', 'ann', T - 40 * MIN);
    const d = await decide(id, T - 40 * MIN);
    expect(d.decision).toBe('push');
    expect(d.loud?.live).toBe(false);
    expect(d.loud?.why).toContain('dm');
    const row = store.one<{ loud: number }>('SELECT loud FROM triage WHERE message_id = ?', id)!;
    expect(row.loud).toBe(d.loud!.loudness);
    const view = store.messageView(id)!;
    // Only the number rides with the message; the Why sheet asks for the rest.
    expect(view.triage?.loudness).toBe(d.loud!.loudness);
  });

  test('on, the band decides; a rule of yours still wins', async () => {
    const on = new LoudLearner(store, 'on');
    triage.loud = on;
    try {
      const T = Date.now();
      const id = post('g', 'bo', T - 30 * MIN, 'lunch pics from saturday');
      const d = await decide(id, T - 30 * MIN);
      expect(d.loud?.live).toBe(true);
      expect(d.decision).toBe(BAND_DECISION[d.loud!.band]);
    } finally {
      triage.loud = loud;
    }
  });

  test('an answer asks why at most once a chat a day, and never twice in a row for the same answer', async () => {
    const T = Date.now();
    const a = post('dm', 'ann', T - 50 * MIN);
    await decide(a, T - 50 * MIN);
    const first = loud.answer({ messageId: a, answer: 'quieter', source: 'sheet' });
    expect(first.why).toBe('quieter');
    // Quieter also stands as today's mark on the alert.
    expect(store.one<{ alert_mark: number }>('SELECT alert_mark FROM triage WHERE message_id = ?', a)!.alert_mark).toBe(0);
    expect(loud.answer({ messageId: a, answer: 'louder', source: 'sheet' }).why).toBeUndefined();
    const b = post('g', 'ann', T - 45 * MIN, 'build failed again');
    await decide(b, T - 45 * MIN);
    // Another chat, but the same answer as the last one asked about; then another answer, which is asked about.
    expect(loud.answer({ messageId: b, answer: 'quieter', source: 'sheet' }).why).toBeUndefined();
    expect(loud.answer({ messageId: b, answer: 'could_wait', source: 'sheet' }).why).toBe('quieter');
    // Asked once in that chat today: no more there.
    expect(loud.answer({ messageId: b, answer: 'louder', source: 'sheet' }).why).toBeUndefined();
  });

  test('your words become a reason through the local model, and are not kept', async () => {
    const T = Date.now();
    const id = post('g', 'ann', T - 44 * MIN, 'standup notes');
    await decide(id, T - 44 * MIN);
    const r = loud.answer({ messageId: id, answer: 'shouldnt', source: 'checkin' });
    loud.ask = async (q) => (q.includes('chat or channel') && q.includes('not care') ? 0.9 : 0.1);
    const w = await loud.why({ answerId: r.answerId, text: 'this group is just noise to me', until: T + 30 * DAY });
    expect(w.reason).toBe('not_chat');
    const row = store.one<Record<string, unknown>>('SELECT * FROM attn_answer WHERE id = ?', r.answerId)!;
    expect(row).toMatchObject({ reason: 'not_chat', texted: 1, until: T + 30 * DAY });
    expect(JSON.stringify(row)).not.toContain('noise');
    expect(loud.model.want[`conv:${conv('g')}`]).toBeLessThan(0);
    // Forget it: gone from what was learned, and never learned again.
    loud.forget(`want|conv:${conv('g')}`, true);
    expect(loud.model.want[`conv:${conv('g')}`]).toBeUndefined();
    loud.ask = null;
  });

  test('check-ins: one from each side, half at random with the chance kept; skips pause them; "ask me less" halves', () => {
    // A fixed local noon, every decision an hour before it: the day's bounds never fall between.
    const T = new Date(2030, 0, 15, 12).getTime();
    store.db.query('UPDATE triage SET created_at = ?').run(T - HOUR);
    loud.checkins.random = () => 0.1;
    store.db.exec('DELETE FROM checkin');
    loud.setPrefs({ ask: 'often' });
    const qs = loud.checkins.due(loud.prefs(), T);
    expect(qs.length).toBeGreaterThanOrEqual(1);
    expect(new Set(qs.map((q) => q.side)).size).toBe(qs.length);
    const rows = store.raw<{ arm: string; propensity: number; pool: number }>('SELECT arm, propensity, pool FROM checkin');
    for (const r of rows) expect(r.propensity).toBeCloseTo(r.arm === 'random' ? 0.5 / r.pool : 0.5, 6);
    // Open questions wait until answered; none new within the pace.
    expect(loud.checkins.due(loud.prefs(), T + MIN).map((q) => q.id)).toEqual(qs.map((q) => q.id));
    // Each says when it was asked and carries where it was seen (no notification went out in this test).
    for (const q of qs) expect(q.askedAt).toBe(T);
    for (const q of qs) expect(q.context.sent).toBeNull();
    const sounded = qs.find((q) => q.side === 'sounded');
    if (sounded) expect(() => loud.checkin(sounded.id, 'sooner')).toThrow();
    for (let i = 0; i < SKIPS_TO_PAUSE; i++) {
      const id = `chk_skip${i}`;
      store.db.query(`INSERT INTO checkin (id, side, message_id, arm, propensity, pool, created_at) VALUES (?, 'quiet', 'x', 'random', 1, 1, ?)`).run(id, T);
      loud.checkin(id, null, T);
    }
    expect(loud.checkins.state().pausedUntil).toBe(T + PAUSE);
    // Paused: nothing new goes on the page, and what already waits stays there.
    const waiting = loud.checkins.pendingCount();
    expect(loud.checkins.due(loud.prefs(), T + 3 * HOUR).length).toBe(waiting);
    expect(store.one<{ n: number }>('SELECT COUNT(*) AS n FROM checkin')!.n).toBe(qs.length + SKIPS_TO_PAUSE);
    loud.checkins.askLess();
    expect(loud.checkins.state().rate).toBe(0.5);
    // Three a day at half the rate: one, and the half left over is a chance drawn once a day (0.1 < 0.5: it came up).
    expect(loud.checkins.quota(loud.prefs(), T)).toBe(2);
    loud.checkins.random = () => 0.9;
    expect(loud.checkins.quota(loud.prefs(), T + HOUR)).toBe(2);
    expect(loud.checkins.quota(loud.prefs(), T + 26 * HOUR)).toBe(1);
    // "Ask me less" to the floor: an eighth of three, so most days none, never a floor of one a day.
    for (let i = 0; i < 4; i++) loud.checkins.askLess();
    expect(loud.checkins.quota(loud.prefs(), T + 50 * HOUR)).toBe(0);
    loud.checkins.random = () => 0.1;
    expect(loud.checkins.quota(loud.prefs(), T + 74 * HOUR)).toBe(1);
    store.setMetaValue('checkin_state', null);
    loud.setPrefs({ ask: 'never' });
    expect(loud.checkins.quota(loud.prefs())).toBe(0);
  });

  test('"could have waited" and "shouldn\'t have reached me" still teach the tiers, as "Not urgent" and "Less like this" did', async () => {
    const T = Date.now();
    const a = post('dm', 'ann', T - 20 * MIN);
    expect((await decide(a, T - 20 * MIN)).decision).toBe('push');
    loud.answer({ messageId: a, answer: 'could_wait', source: 'notification' });
    expect(store.one<{ alert_mark: number }>('SELECT alert_mark FROM triage WHERE message_id = ?', a)!.alert_mark).toBe(0);
    const b = post('g', 'cy', T - 19 * MIN, 'lunch pics from saturday');
    expect((await decide(b, T - 19 * MIN)).decision).not.toBe('push');
    loud.answer({ messageId: b, answer: 'shouldnt', source: 'checkin' });
    expect(store.one<{ less_mark: number }>('SELECT less_mark FROM triage WHERE message_id = ?', b)!.less_mark).toBe(1);
  });

  test('a mark taken back on the old route takes back its answer', async () => {
    const T = Date.now();
    const a = post('dm', 'ann', T - 18 * MIN);
    await decide(a, T - 18 * MIN);
    loud.fromMark(a, { alert: true });
    expect(store.raw('SELECT 1 FROM attn_answer WHERE message_id = ?', a).length).toBe(1);
    loud.fromMark(a, { alert: null });
    expect(store.raw('SELECT 1 FROM attn_answer WHERE message_id = ?', a).length).toBe(0);
  });

  test('a check-in asks "this sounded" only about what actually sounded', async () => {
    const T = new Date(2030, 0, 20, 12).getTime();
    store.db.exec('DELETE FROM checkin');
    store.setMetaValue('checkin_state', null);
    loud.setPrefs({ ask: 'often' });
    const a = post('dm', 'ann', T - 2 * HOUR);
    const d = await decide(a, T - 2 * HOUR);
    expect(d.decision).toBe('push');
    store.db.query('UPDATE triage SET created_at = ? WHERE message_id = ?').run(T - HOUR, a);
    // Decided an alert, but no push of it played a sound (a burst, a computer in use): not on the sounded side.
    expect(loud.checkins.pick('sounded', 'random', T)).toBeNull();
    store.db.query(`INSERT INTO notification (id, kind, message_id, sent_at, alert) VALUES ('n1', 'message', ?, ?, 1)`).run(a, T - HOUR);
    expect(loud.checkins.pick('sounded', 'random', T)).not.toBeNull();
  });

  test('For you asks one card a day, at random among the first ten, with its chance', () => {
    store.db.exec(`DELETE FROM checkin WHERE side = 'foryou'`);
    store.setMetaValue('checkin_state', null);
    loud.setPrefs({ ask: 'often' });
    loud.checkins.random = () => 0.35;
    const items = Array.from({ length: 12 }, (_, i) => ({ id: `fy${i}`, messageId: `m${i}` }));
    const p = loud.checkins.pickForYou(items, loud.prefs())!;
    expect(p.itemId).toBe('fy3');
    expect(store.one<{ propensity: number }>('SELECT propensity FROM checkin WHERE id = ?', p.checkinId)!.propensity).toBeCloseTo(0.1, 6);
    expect(loud.checkins.pickForYou(items, loud.prefs())).toBeNull();
  });

  test('the old marks are aliases of Louder / Quieter', () => {
    const before = store.one<{ n: number }>('SELECT COUNT(*) AS n FROM attn_answer')!.n;
    const id = store.one<{ message_id: string }>(`SELECT message_id FROM triage WHERE decision != 'silent' LIMIT 1`)!.message_id;
    loud.fromMark(id, { alert: true } satisfies P.TriageMarks);
    expect(store.one<{ answer: string }>('SELECT answer FROM attn_answer ORDER BY at DESC, rowid DESC LIMIT 1')!.answer).toBe('louder');
    expect(store.one<{ n: number }>('SELECT COUNT(*) AS n FROM attn_answer')!.n).toBe(before + 1);
  });

  test('the scorecard weighs the random half back by each question\'s chance, and leaves the least-sure half out', () => {
    const day = dayOf(new Date(2031, 2, 3, 12).getTime());
    const [from, to] = dayBounds(day);
    const put = store.db.query(`INSERT INTO checkin (id, side, message_id, arm, propensity, pool, shadow_band, created_at, answer) VALUES (?, ?, 'x', ?, ?, 1, ?, ?, ?)`);
    put.run('s1', 'sounded', 'random', 0.5 / 2, 'sound', from + HOUR, 'worth');
    put.run('s2', 'sounded', 'random', 0.5 / 8, 'show', from + HOUR, 'could_wait');
    put.run('s3', 'sounded', 'unsure', 0.5, 'sound', from + HOUR, 'shouldnt');
    put.run('q1', 'quiet', 'random', 0.5 / 100, 'next', from + HOUR, 'sooner');
    const gen = loudnessScores({ db: store.db, day, from, to, self: [], opens: null } as never);
    let r = gen.next();
    while (!r.done) r = gen.next();
    const by = Object.fromEntries(r.value.map((x) => [x.metric, x]));
    // 1/0.25 = 4 worth against 1/0.0625 = 16 could wait: 4 of 20.
    expect(by['attn.worth']).toMatchObject({ value: 0.2, n: 2 });
    expect(by['attn.could_wait'].value).toBe(0.8);
    expect(by['attn.shouldnt'].value).toBe(0);
    expect(by['attn.worth_shadow']).toMatchObject({ value: 1, n: 1 });
    expect(by['attn.missed']).toMatchObject({ value: 1, n: 1 });
    expect(by['attn.asked']).toMatchObject({ value: 4, extra: { answered: 4, skipped: 0 } });
    expect(by['foryou.worth'].value).toBeNull();
  });
});
