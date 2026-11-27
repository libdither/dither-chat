/**
 * One loudness scale (loudness.ts, loudlearn.ts, checkin.ts, docs/notifications.md): the bands from want, can-wait,
 * owed and the moment; your rules on top; each answer moving only the part it names; check-ins picked half at random
 * with their chance kept; and the tiers deciding while it runs in shadow.
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { rmSync } from 'node:fs';
import { join } from 'node:path';
import type * as P from '@dither-chat/protocol';
import { asBand, bandOf, LOUD_BANDS } from '@dither-chat/protocol';
import type { Facts } from '../src/learn.ts';
import { BAND_DECISION, emptyAttnModel, loudness, momentKeys, trainAttn, type AttnExample, type LoudInput, type Moment } from '../src/loudness.ts';
import { behaviourLabel, LoudLearner, markRouted, routed } from '../src/loudlearn.ts';
import type { Example } from '../src/learn.ts';
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

  test('a DM that cannot wait sounds; at a desk it shows silently; in quiet hours it shows silently', () => {
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
    expect(['show', 'inbox']).toContain(keeps.band);
    expect(keeps.loudness).toBeLessThan(55);
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

  test('your rules stay absolute: Always alert is 100, List only at most the bottom of Show', () => {
    expect(loudness(input({ rule: 'always', alert: 0.01, importance: 0.05 }), m)).toMatchObject({ loudness: 100, band: 'sound' });
    const listed = loudness(input({ rule: 'list' }), m);
    expect(listed.loudness).toBeLessThan(55);
  });

  test('the nudge: less readily sounds less, more readily more; nothing caps it', () => {
    const base = loudness(input({ alert: 0.5 }), m).loudness;
    expect(loudness(input({ alert: 0.5 }), m, 'less').loudness).toBeLessThan(base);
    expect(loudness(input({ alert: 0.5 }), m, 'more').loudness).toBeGreaterThan(base);
  });

  test('every band is stored as a code older apps know', () => {
    expect(BAND_DECISION).toEqual({ sound: 'push', show: 'quiet', inbox: 'digest', unread: 'drop' });
    // Four bands, no next look: what was 30 to 55 is the bottom of Show.
    expect(LOUD_BANDS).toEqual(['unread', 'inbox', 'show', 'sound']);
    expect([bandOf(5), bandOf(29.9), bandOf(30), bandOf(54), bandOf(79.9), bandOf(80)]).toEqual(['unread', 'inbox', 'show', 'show', 'show', 'sound']);
    expect(asBand('next')).toBe('show');
  });

  test('the reasons say how far each part moved it', () => {
    const r = loudness(input({ owed: 0.6 }), m).reasons;
    expect(r[0].by).toBe(0);
    const urgent = r.find((x) => x.text.startsWith("Can't wait an hour"));
    expect(urgent?.by).toBeGreaterThan(0);
    expect(r.some((x) => x.text === 'A direct message' && x.by > 0)).toBe(true);
    // A person waiting on you adds, most where it decides between a quiet row and the inbox.
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

  /** A mark as the route keeps it: on the tiers (votes.ts), then on the scale. */
  const mark = (id: string, marks: P.TriageMarks) => {
    votes.mark(id, marks);
    loud.fromMark(id, marks);
  };
  const marksOn = (id: string) => store.raw<{ id: string; answer: string; source: string }>('SELECT id, answer, source FROM attn_answer WHERE message_id = ? ORDER BY id', id);

  test('each old mark is kept as the answer it is; a mark taken back takes it back', async () => {
    const T = Date.now();
    const a = post('dm', 'ann', T - 18 * MIN);
    await decide(a, T - 18 * MIN);
    mark(a, { alert: true });
    expect(marksOn(a)).toEqual([{ id: `mk_a_${a}`, answer: 'should_alert', source: 'mark' }]);
    mark(a, { alert: false, less: true });
    expect(marksOn(a).map((x) => x.answer)).toEqual(['alert_wrong', 'less']);
    mark(a, { alert: null, less: false });
    expect(marksOn(a)).toEqual([]);
  });

  test('a mark an answer stands for is not kept twice', async () => {
    const T = Date.now();
    const a = post('dm', 'ann', T - 17 * MIN);
    await decide(a, T - 17 * MIN);
    // Louder from a notification sets the mark itself; reading the marks again adds nothing.
    loud.answer({ messageId: a, answer: 'louder', source: 'notification' });
    expect(store.one<{ alert_mark: number }>('SELECT alert_mark FROM triage WHERE message_id = ?', a)!.alert_mark).toBe(1);
    expect(loud.syncMarks()).toBe(0);
    expect(marksOn(a).map((x) => x.source)).toEqual(['notification']);
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

describe('what you said in place teaches the scale', () => {
  let dir: string;
  let store: Store;
  let acc: AccountRow;
  let triage: Triage;
  let votes: TriageVotes;
  let n = 0;
  const post = (conversation: string, author: string, ts: number, body: string) => {
    const nativeId = `w${++n}`;
    store.ingest(acc, { t: 'message', message: { nativeId, conversation, author, ts, body }, live: true });
    return store.one<{ id: string }>('SELECT id FROM message WHERE native_id = ?', nativeId)!.id;
  };
  const decide = async (id: string, now: number) => {
    const d = (await triage.decide(id, now))!;
    store.setTriage(id, d, d.facts);
    return d;
  };
  const fresh = (l: LoudLearner) => {
    l.mark = (id, marks) => void votes.mark(id, marks);
    return l;
  };

  beforeAll(() => {
    dir = memTempDir('dither-loud-marks-');
    store = new Store(join(dir, 'hub.sqlite'), (raw) => raw ?? null);
    acc = store.createAccount({ network: 'signal', label: 's', color: '#000', adapter: 'signal' });
    store.ingest(acc, { t: 'status', status: 'online', self: { nativeId: 'me', isSelf: true, displayName: 'Me' } });
    acc = store.accounts().find((x) => x.id === acc.id)!;
    for (const who of ['ann', 'bo', 'cy']) store.ingest(acc, { t: 'identity', identity: { nativeId: who, displayName: who, contact: true } });
    store.ingest(acc, { t: 'conversation', conversation: { nativeId: 'g', shape: 'group', name: 'Club', participants: ['ann', 'bo', 'cy', 'me'] } });
    store.ingest(acc, { t: 'conversation', conversation: { nativeId: 'h', shape: 'group', name: 'Photos', participants: ['ann', 'bo', 'cy', 'me'] } });
    triage = new Triage(store);
    triage.judge = async () => 0.05;
    votes = new TriageVotes(store, triage);
    // Decisions keep their loudness and what it was worked out from (a learner of its own, as main.ts has).
    triage.loud = new LoudLearner(store, 'shadow');
    triage.momentOf = () => ({ desk: false, sinceSound: null });
  });
  afterAll(() => {
    store.db.close();
    rmSync(dir, { recursive: true, force: true });
  });

  test('marks from before the scale are read at start, once, and learned at the first round', async () => {
    const T = Date.now();
    // Marks kept before the scale learned from them: a hub that has them and a model that never saw them.
    const loudish = [] as string[];
    const quiet = [] as string[];
    for (let i = 0; i < 6; i++) {
      const a = post('g', 'bo', T - (60 - i) * MIN, 'the server is down again');
      await decide(a, T - (60 - i) * MIN);
      store.triageMark(a, { alert: true }, T - 50 * MIN);
      loudish.push(a);
      const b = post('h', 'cy', T - (40 - i) * MIN, 'weekly photo dump');
      await decide(b, T - (40 - i) * MIN);
      store.triageMark(b, { less: true }, T - 30 * MIN);
      quiet.push(b);
    }
    // An old vote from before the tiers, at half weight.
    store.db.query(`UPDATE triage SET feedback = 'digest', feedback_at = ? WHERE message_id = ?`).run(T - 20 * DAY, quiet[0]);
    const was = { up: new LoudLearner(store, 'shadow').loudNow(loudish[0])!, down: new LoudLearner(store, 'shadow').loudNow(quiet[0])! };
    store.db.exec(`DELETE FROM attn_answer`);
    store.db.exec(`DELETE FROM meta WHERE key = 'attn_model'`);
    const l = fresh(new LoudLearner(store, 'shadow'));
    const kept = store.raw<{ answer: string; n: number }>(`SELECT answer, COUNT(*) AS n FROM attn_answer WHERE source = 'mark' GROUP BY answer ORDER BY answer`);
    expect(kept).toEqual([
      { answer: 'less', n: 6 },
      { answer: 'should_alert', n: 6 },
    ]);
    // Again: nothing changes (each mark has its own answer id).
    expect(l.syncMarks()).toBe(0);
    expect(fresh(new LoudLearner(store, 'shadow')).syncMarks()).toBe(0);
    // The first round learns them: the marked server issues louder, the photo dumps quieter.
    l.daily(T);
    expect(l.loudNow(loudish[0])!).toBeGreaterThan(was.up);
    expect(l.loudNow(quiet[0])!).toBeLessThan(was.down);
    expect(l.signals(T)).toBe(12);
    // A model that has learned the marks does not need a round of its own after the next start.
    l.daily(T + MIN);
    const learnedAt = l.model.learnedAt;
    const again = fresh(new LoudLearner(store, 'shadow'));
    again.daily(T + 2 * MIN);
    expect(again.model.learnedAt).toBe(learnedAt);
  });

  test('each mark moves the scale its own way, at full weight; an old vote at half', () => {
    const facts = { network: 'signal', shape: 'group', conversation: 'c1', spaces: [], author: 'p1', bot: false, urgent: false, media: false, base: 'drop' } as never;
    const base: AttnExample = { facts, words: ['lunch'], why: [], importance: 0.4, alert: 0.1, weight: 0, at: 0 };
    const e = (x: Partial<AttnExample>): AttnExample => ({ ...base, ...x, weight: 1, at: 0 });
    const m0 = emptyAttnModel();
    const at = (rows: AttnExample[]) => loudness({ facts, words: ['lunch'], importance: 0.4, alert: 0.1, why: [], moment: free }, trainAttn(rows, new Set(), 0)).loudness;
    const start = loudness({ facts, words: ['lunch'], importance: 0.4, alert: 0.1, why: [], moment: free }, m0).loudness;
    const times = (k: number, x: AttnExample[]) => Array.from({ length: k }, () => x).flat();
    expect(at(times(5, markRouted('should_alert', e)))).toBeGreaterThan(start);
    expect(at(times(5, markRouted('less', e)))).toBeLessThan(start);
    // Alert was wrong says it could wait minutes, not that it was unwanted.
    const wrong = markRouted('alert_wrong', e);
    expect(wrong).toHaveLength(1);
    expect(wrong[0].want).toBeUndefined();
    expect(wrong[0].wait?.[0]).toBe(0);
    expect(markRouted('sound', e)[0]).toMatchObject({ want: 1, wait: [1, 1, 1] });
    expect(markRouted('nonsense', e)).toEqual([]);
  });

  test("a notification's buttons reach the scale, and count as signals given in place", async () => {
    const T = Date.now();
    const l = fresh(new LoudLearner(store, 'shadow'));
    const a = post('g', 'ann', T - 9 * MIN, 'are we still on for tonight?');
    await decide(a, T - 9 * MIN);
    const signals = l.signals(T);
    const was = l.loudNow(a)!;
    for (const source of ['notification', 'notification', 'notification'] as const) l.answer({ messageId: a, answer: 'sooner', source }, T);
    expect(l.signals(T)).toBe(signals + 3);
    expect(l.loudNow(a)!).toBeGreaterThan(was);
    expect(l.answerExamples(T).filter((x) => x.at === T).length).toBe(3);
  });

  test("notices' and mail's marks teach it too, from where they are kept, and the old route takes them", async () => {
    const T = Date.now();
    const l = fresh(new LoudLearner(store, 'shadow'));
    const facts = { network: 'email', shape: 'direct', conversation: 'mail-thread', spaces: [], author: 'sender', bot: false, urgent: false, media: false, base: 'drop' } as never;
    const others: Example[] = [
      { facts, words: ['newsletter'], y: { important: 0 }, weight: 1, vote: true, at: T - HOUR },
      { facts, words: ['newsletter'], y: { alert: 0 }, weight: 1, vote: true, at: T - HOUR },
      { facts, words: ['newsletter'], label: 'drop', weight: 0.5, vote: true, at: T - DAY },
    ];
    l.others = () => others;
    const before = l.signals(T);
    const ex = l.otherExamples(T, true);
    expect(ex.map((x) => [x.want, x.wait?.[0], x.weight])).toEqual([
      [0, 0, 1],
      [undefined, 0, 1],
      [0, 0, 0.5],
    ]);
    expect(l.answerExamples(T).filter((x) => x.facts.conversation === 'mail-thread')).toHaveLength(3);
    expect(before).toBeGreaterThanOrEqual(3);
    // A notice's or mail's id on the old route: nothing of a chat message to keep, and no error.
    expect(() => l.fromMark('ntc_none', { less: true }, T)).not.toThrow();
    expect(l.model.want['conv:mail-thread'] ?? 0).toBeLessThan(0);
  });
});
