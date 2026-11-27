/**
 * The calibration feed's hub side (calfeed.ts, seen.ts, loudlearn.ts, docs/notifications.md "The calibration feed"):
 * the cost-weighted regret and what you did from strong signals only; only notifications that reached a device and
 * sounds held back; no cards before the model is fitted from what you said in place, then the one or two a day most
 * worth asking; a surprising answer back once; an answer routed to the parts you name; the next look's stored values
 * moved to Show; and each notification keeping what the devices drew and said, so the feed can draw it again.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'bun:test';
import { rmSync } from 'node:fs';
import { join } from 'node:path';
import { ActivityStore, WORDS_KEPT } from '../src/activity.ts';
import type * as P from '@dither-chat/protocol';
import { CARD_OVER, CARDS_A_DAY, chances, COST, costKind, EXPIRE_AFTER, FITTED_AT, fewOf, HALF_LIFE, ipsWeight, LATE_FLOOR, lateWeight, regretOf, REPLY_WITHIN, RETURN_AFTER, saidOf, sigmaOf, surpriseOf, TAP_SOUND_WITHIN, UNKNOWN_SHARE, unsureOf, worthAsking, youOf } from '../src/calfeed.ts';
import { feedRouted, LoudLearner } from '../src/loudlearn.ts';
import { trainAttn, type AttnExample } from '../src/loudness.ts';
import { Notifier } from '../src/notify.ts';
import { seenContext } from '../src/seen.ts';
import { Store, type AccountRow } from '../src/store.ts';
import { Triage } from '../src/triage.ts';
import { memTempDir } from './fixtures/memdir.ts';

const MIN = 60_000;
const HOUR = 60 * MIN;
const DAY = 24 * HOUR;

let dir: string;
let store: Store;
let acc: AccountRow;
let triage: Triage;
let loud: LoudLearner;
let n = 0;

const post = (conversation: string, author: string, ts: number, body = 'are you still coming? we leave soon') => {
  const nativeId = `m${++n}`;
  store.ingest(acc, { t: 'message', message: { nativeId, conversation, author, ts, body }, live: true });
  return store.one<{ id: string; conversation_id: string }>('SELECT id, conversation_id FROM message WHERE native_id = ?', nativeId)!;
};

interface Sent {
  /** It sounded; else it showed silently. */
  alert?: boolean;
  /** A push server took it (else: it never reached a device). */
  reached?: boolean;
  /** After the message, in ms. */
  tapped?: number;
  dismissed?: number;
}

/** A message from Ann `at`, decided, with the loudness the model gave it, and (when `sent`) its notification. */
async function delivered(at: number, loudness: number, sent: Sent | null, conv: 'dm' | 'g' = n % 2 ? 'dm' : 'g') {
  const m = post(conv, 'ann', at);
  const d = (await triage.decide(m.id, at))!;
  store.setTriage(m.id, d, d.facts);
  store.db.query('UPDATE triage SET created_at = ?, loud = ? WHERE message_id = ?').run(at, loudness, m.id);
  if (sent) {
    store.db
      .query(`INSERT INTO notification (id, kind, message_id, conversation_id, sent_at, devices, accepted, alert, tapped_at, dismissed_at) VALUES (?, 'message', ?, ?, ?, 1, ?, ?, ?, ?)`)
      .run(`n_${m.id}`, m.id, m.conversation_id, at + 1000, sent.reached === false ? 0 : 1, sent.alert ? 1 : 0, sent.tapped !== undefined ? at + sent.tapped : null, sent.dismissed !== undefined ? at + sent.dismissed : null);
  }
  return m;
}

/** `k` answers given in place (a notification's buttons), about no message on the feed: what fits the model. */
const fitWith = (k: number, at = Date.now() - 10 * DAY) => {
  const put = store.db.query(`INSERT OR IGNORE INTO attn_answer (id, message_id, conversation_id, author, answer, source, at) VALUES (?, 'elsewhere', 'elsewhere', 'elsewhere', 'worth', 'notification', ?)`);
  for (let i = 0; i < k; i++) put.run(`ans_fit_${i}`, at);
};
const unfit = () => store.db.exec(`DELETE FROM attn_answer WHERE id LIKE 'ans_fit_%'`);

beforeAll(() => {
  dir = memTempDir('dither-calfeed-');
  store = new Store(join(dir, 'hub.sqlite'), (raw) => raw ?? null);
  acc = store.createAccount({ network: 'signal', label: 's', color: '#000', adapter: 'signal' });
  store.ingest(acc, { t: 'status', status: 'online', self: { nativeId: 'me', isSelf: true, displayName: 'Me' } });
  acc = store.accounts().find((x) => x.id === acc.id)!;
  store.ingest(acc, { t: 'identity', identity: { nativeId: 'ann', displayName: 'Ann', contact: true } });
  store.ingest(acc, { t: 'conversation', conversation: { nativeId: 'dm', shape: 'direct', participants: ['ann', 'me'] } });
  store.ingest(acc, { t: 'conversation', conversation: { nativeId: 'g', shape: 'group', name: 'Club', participants: ['ann', 'bo', 'me'] } });
  triage = new Triage(store);
  triage.judge = async (text) => (/coming|leave/.test(text) ? 0.6 : 0.01);
  loud = new LoudLearner(store, 'shadow');
  triage.loud = loud;
  triage.momentOf = () => ({ desk: false, sinceSound: null });
});
afterAll(() => {
  store.db.close();
  rmSync(dir, { recursive: true, force: true });
});

describe('the numbers', () => {
  test('the chances come from the loudness, blurred by how few answers there are, cut at 30 and 80', () => {
    const none = chances(60, 0);
    expect(none[0] + none[1] + none[2]).toBeCloseTo(1, 2);
    expect(none[1]).toBeGreaterThan(none[0]);
    expect(none[1]).toBeGreaterThan(none[2]);
    // More answers, a narrower blur: surer of the band it sits in.
    expect(chances(60, 40)[1]).toBeGreaterThan(none[1]);
    expect(sigmaOf(0)).toBe(30);
    expect(sigmaOf(30)).toBeLessThan(8);
    expect(fewOf(0)).toBe(1);
    expect(chances(95, 0)[0]).toBeGreaterThan(0.6);
    expect(chances(5, 0)[2]).toBeGreaterThan(0.75);
  });

  test('surprise is −log2 of what you did, capped at 5 bits; unsure is spread × few answers', () => {
    expect(surpriseOf([0.5, 0.25, 0.25], 'sound')).toBe(1);
    expect(surpriseOf([0.5, 0.25, 0.25], 'show')).toBe(2);
    expect(surpriseOf([0.999, 0.001, 0], 'inbox')).toBe(5);
    expect(unsureOf([1 / 3, 1 / 3, 1 / 3], 0)).toBeCloseTo(1, 2);
    expect(unsureOf([1, 0, 0], 0)).toBe(0);
  });

  test('a sound missed costs most, a sound not wanted next, a silent mix-up barely', () => {
    expect(COST.show.sound).toBe(1);
    expect(COST.inbox.sound).toBe(1);
    for (const unwanted of [COST.sound.show, COST.sound.inbox]) {
      expect(unwanted).toBeLessThan(1);
      expect(unwanted).toBeGreaterThan(Math.max(COST.show.inbox, COST.inbox.show) * 3);
    }
    for (const a of ['sound', 'show', 'inbox'] as const) expect(COST[a][a]).toBe(0);
    // Even a silent mix-up the model never expected is under the bar for a card; a missed sound it expected a little is over it.
    expect(regretOf([0, 0, 1], 'inbox', 'show')).toBeLessThan(CARD_OVER);
    expect(regretOf([0, 1, 0], 'show', 'inbox')).toBeLessThan(CARD_OVER);
    expect(regretOf([0.3, 0.6, 0.1], 'show', 'sound')).toBeGreaterThan(CARD_OVER);
    expect(costKind('show', 'sound')).toBe('missed');
    expect(costKind('sound', 'inbox')).toBe('unwanted');
    expect(costKind('show', 'inbox')).toBe('mixup');
    expect(costKind('show', 'show')).toBeNull();
    expect(costKind('show', null)).toBeNull();
  });

  test('regret is the cost by how little the model expected what you did; unknown, half its own expected cost', () => {
    const p: P.Trio = [0.1, 0.7, 0.2];
    expect(regretOf(p, 'show', 'sound')).toBeCloseTo(1 * 0.9, 3);
    expect(regretOf(p, 'show', 'show')).toBe(0);
    // The same miss, expected more, costs less: ranked by regret, not by surprise alone.
    expect(regretOf([0.45, 0.45, 0.1], 'show', 'sound')).toBeLessThan(regretOf(p, 'show', 'sound'));
    expect(regretOf(p, 'show', null)).toBeCloseTo(UNKNOWN_SHARE * (0.1 * 1 + 0.2 * COST.show.inbox), 3);
    // A missed sound outranks a sound not wanted that surprised it as much.
    expect(regretOf([0.1, 0.8, 0.1], 'show', 'sound')).toBeGreaterThan(regretOf([0.8, 0.1, 0.1], 'sound', 'inbox'));
    // Worth asking halves every day.
    expect(worthAsking(0.8, 0)).toBe(0.8);
    expect(worthAsking(0.8, HALF_LIFE)).toBeCloseTo(0.4, 3);
  });

  test('what you did, from strong signals only: a tap, a quick reply, a swipe, an answer or a mark', () => {
    const none = { tapped: null, dismissed: null, replied: null };
    expect(youOf(none)).toBeNull();
    expect(youOf({ ...none, tapped: TAP_SOUND_WITHIN })).toBe('sound');
    expect(youOf({ ...none, tapped: TAP_SOUND_WITHIN + 1 })).toBe('show');
    expect(youOf({ ...none, replied: REPLY_WITHIN })).toBe('sound');
    // A reply long after says nothing of this message.
    expect(youOf({ ...none, replied: REPLY_WITHIN + 1 })).toBeNull();
    expect(youOf({ ...none, dismissed: 3000 })).toBe('inbox');
    // A tap says more than a swipe; what you said more than either.
    expect(youOf({ ...none, tapped: MIN, dismissed: 3000 })).toBe('sound');
    expect(youOf({ said: 'inbox', tapped: MIN, dismissed: null, replied: null })).toBe('inbox');
    // Answers and marks as the band they ask for, given what was done.
    expect(saidOf('worth', 'sound')).toBe('sound');
    expect(saidOf('could_wait', 'sound')).toBe('show');
    expect(saidOf('louder', 'show')).toBe('sound');
    expect(saidOf('quieter', 'show')).toBe('inbox');
    expect(saidOf('should_alert', 'inbox')).toBe('sound');
    expect(saidOf('alert_wrong', 'sound')).toBe('show');
    expect(saidOf('less', 'show')).toBe('inbox');
    // A vote from before the tiers, kept as a mark: its band.
    expect(saidOf('sound', 'inbox')).toBe('sound');
    expect(saidOf('glad', 'inbox')).toBeNull();
  });

  test('a picked card counts once; a late answer counts less, down to a floor', () => {
    expect(ipsWeight(1)).toBe(1);
    expect(ipsWeight(0.25)).toBe(2);
    expect(ipsWeight(null)).toBe(1);
    expect(lateWeight(HOUR)).toBe(1);
    expect(lateWeight(DAY)).toBe(1);
    expect(lateWeight(EXPIRE_AFTER)).toBeCloseTo(LATE_FLOOR, 6);
    expect(lateWeight(10 * EXPIRE_AFTER)).toBe(LATE_FLOOR);
  });
});

describe('the feed', () => {
  const visit = (conv: string, at: number) =>
    store.db.query(`INSERT INTO visit (id, device, view, conversation_id, start_at, end_at, source, updated_at) VALUES (?, 'd', 'conversation', ?, ?, ?, 'inbox', ?)`).run(`v_${++n}`, conv, at, at + MIN, at);
  const itemOf = (id: string) => store.one<{ id: string; kind: string; you: string | null; did: string; score: number; chance: number }>('SELECT * FROM cal_item WHERE message_id = ?', id);
  beforeEach(() => {
    // Each test its own messages: the earlier ones' decisions are put out of the window.
    store.db.exec('DELETE FROM cal_item');
    store.db.exec('UPDATE triage SET created_at = 0');
    unfit();
    loud.setPrefs({ ask: 'often' });
  });

  test('only notifications that reached a device, and sounds the model held back; never an inbox-only message', async () => {
    fitWith(FITTED_AT);
    const T = Date.now();
    const reached = await delivered(T - 5 * HOUR, 50, { tapped: MIN });
    // Sent, but no push server took it and no device said a word.
    const never = await delivered(T - 5 * HOUR, 50, { reached: false });
    const inbox = await delivered(T - 5 * HOUR, 20, null);
    visit(inbox.conversation_id, T - 5 * HOUR + MIN);
    const held = await delivered(T - 5 * HOUR, 90, null);
    expect(loud.feed.fill(loud.prefs(), T, true)).toBe(2);
    expect(itemOf(reached.id)).toMatchObject({ you: 'sound', did: 'show' });
    expect(itemOf(held.id)).toMatchObject({ did: 'inbox' });
    expect(itemOf(never.id)).toBeNull();
    expect(itemOf(inbox.id)).toBeNull();
  });

  test('opening the chat later is not what you did; a tap, a swipe or a quick reply is', async () => {
    fitWith(FITTED_AT);
    const T = Date.now();
    // Shown, its group opened a minute later: nothing says what you made of this one message.
    const opened = await delivered(T - 5 * HOUR, 50, {}, 'g');
    visit(opened.conversation_id, T - 5 * HOUR + MIN);
    const tapped = await delivered(T - 5 * HOUR + 2 * MIN, 50, { tapped: 20 * MIN });
    const swiped = await delivered(T - 5 * HOUR + 3 * MIN, 50, { dismissed: 4000 });
    const quick = await delivered(T - 5 * HOUR + 4 * MIN, 50, {}, 'dm');
    post('dm', 'me', T - 5 * HOUR + 6 * MIN, 'on my way');
    // Not settled yet and nothing known: it waits.
    const fresh = await delivered(T - 30 * MIN, 50, {});
    loud.feed.fill(loud.prefs(), T, true);
    expect(itemOf(opened.id)).toMatchObject({ you: null });
    expect(itemOf(tapped.id)!.you).toBe('show');
    expect(itemOf(swiped.id)!.you).toBe('inbox');
    expect(itemOf(quick.id)!.you).toBe('sound');
    expect(itemOf(fresh.id)).toBeNull();
    // A tap known before it settles puts it on at once.
    store.db.query('UPDATE notification SET tapped_at = ? WHERE message_id = ?').run(T - 29 * MIN, fresh.id);
    loud.feed.fill(loud.prefs(), T, true);
    expect(itemOf(fresh.id)!.you).toBe('sound');
  });

  test('no cards until the model has learned from enough in-place signals; the feed\'s own answers do not count', async () => {
    const T = Date.now();
    const m = await delivered(T - 5 * HOUR, 40, { tapped: 30_000 });
    fitWith(FITTED_AT - 1);
    store.db.query(`INSERT INTO attn_answer (id, message_id, answer, source, at) VALUES ('ans_fit_feed', 'elsewhere', 'sound', 'feed', ?)`).run(T - DAY);
    expect(loud.feed.fitted(T)).toEqual({ signals: FITTED_AT - 1, need: FITTED_AT });
    loud.feed.fill(loud.prefs(), T, true);
    expect(itemOf(m.id)!.kind).toBe('row');
    const v = loud.feed.view(loud.prefs(), T);
    expect(v.items).toEqual([]);
    expect(v.fitted.signals).toBe(FITTED_AT - 1);
    // Nothing waits, so the inbox has no row for it.
    expect(loud.feed.pendingCount(T)).toBe(0);
    // One more answer given in place: fitted; the miss waiting as a row becomes a card.
    fitWith(FITTED_AT);
    loud.feed.fill(loud.prefs(), T + MIN, true);
    expect(itemOf(m.id)).toMatchObject({ kind: 'card', chance: 1 });
    expect(loud.feed.pendingCount(T + MIN)).toBe(1);
  });

  test('then the one or two a day most worth asking, by cost-weighted regret, not by surprise', async () => {
    fitWith(FITTED_AT);
    const T = Date.now();
    // A sound missed (shown silently, tapped at once), a sound not wanted (swiped in seconds), two silent mix-ups
    // the model gave next to no chance (shown, swiped; and a quiet one tapped late).
    const missed = await delivered(T - 4 * HOUR, 55, { tapped: 40_000 });
    const unwanted = await delivered(T - 4 * HOUR, 92, { alert: true, dismissed: 3000 });
    const mix1 = await delivered(T - 4 * HOUR, 75, { dismissed: 5000 });
    const mix2 = await delivered(T - 4 * HOUR, 3, { tapped: 2 * HOUR });
    // Surprise ranks a mix-up the model was sure against above the miss; regret does not.
    expect(itemOf(mix1.id)).toBeNull();
    loud.feed.fill(loud.prefs(), T, true);
    const s = (id: string) => itemOf(id)!;
    expect(s(missed.id).score).toBeGreaterThan(s(unwanted.id).score);
    expect(s(unwanted.id).score).toBeGreaterThan(CARD_OVER);
    for (const m of [mix1, mix2]) expect(s(m.id).score).toBeLessThan(CARD_OVER);
    expect(store.one<{ surprise: number }>('SELECT surprise FROM cal_item WHERE message_id = ?', mix2.id)!.surprise).toBeGreaterThan(store.one<{ surprise: number }>('SELECT surprise FROM cal_item WHERE message_id = ?', missed.id)!.surprise);
    expect([missed, unwanted].map((m) => s(m.id).kind)).toEqual(['card', 'card']);
    expect([mix1, mix2].map((m) => s(m.id).kind)).toEqual(['row', 'row']);
    const v = loud.feed.view(loud.prefs(), T);
    expect(v.items.map((i) => i.messageId)).toEqual([missed.id, unwanted.id]);
    expect(v.items.map((i) => i.cost)).toEqual(['missed', 'unwanted']);
    expect(v.items.every((i) => i.kind === 'card')).toBe(true);
    // A third worth asking the same day waits: two in any 24 hours.
    const third = await delivered(T - 3 * HOUR, 50, { tapped: 20_000 });
    loud.feed.fill(loud.prefs(), T + HOUR, true);
    expect(s(third.id).kind).toBe('row');
    expect(CARDS_A_DAY.often).toBe(2);
    // A day on, room again: it is picked while it is fresh.
    loud.feed.fill(loud.prefs(), T + DAY + 2 * MIN, true);
    expect(s(third.id).kind).toBe('card');
  });

  test('"rarely" asks one a day; "never" none', async () => {
    fitWith(FITTED_AT);
    const T = Date.now();
    const a = await delivered(T - 4 * HOUR, 50, { tapped: 20_000 });
    const b = await delivered(T - 4 * HOUR, 52, { tapped: 25_000 });
    loud.setPrefs({ ask: 'never' });
    loud.feed.fill(loud.prefs(), T, true);
    expect(store.raw(`SELECT 1 FROM cal_item WHERE kind = 'card'`).length).toBe(0);
    loud.setPrefs({ ask: 'rarely' });
    loud.feed.fill(loud.prefs(), T + MIN, true);
    expect([a, b].filter((m) => itemOf(m.id)!.kind === 'card').length).toBe(1);
  });

  test('an answer it gave little chance comes back once, a day later; Keep, Only that once and Undo', async () => {
    fitWith(FITTED_AT);
    const T = Date.now();
    const a = await delivered(T - 5 * HOUR, 20, { tapped: 30_000 });
    loud.feed.fill(loud.prefs(), T, true);
    const it = store.one<{ id: string; p: string; kind: string }>('SELECT id, p, kind FROM cal_item WHERE message_id = ?', a.id)!;
    expect(it.kind).toBe('card');
    const p = JSON.parse(it.p) as P.Trio;
    const least = (['sound', 'show', 'inbox'] as const)[p.indexOf(Math.min(...p))];
    expect(Math.min(...p)).toBeLessThan(0.2);
    const r = loud.feedAnswer(it.id, least, T);
    expect(r.before).toEqual(p);
    // Learned: its loudness now is louder than just before the answer.
    expect(loud.loudNow(a.id)!).toBeGreaterThan(store.one<{ loud_base: number }>('SELECT loud_base FROM cal_item WHERE id = ?', it.id)!.loud_base);
    const row = store.one<{ returns_at: number; answer: string }>('SELECT returns_at, answer FROM cal_item WHERE id = ?', it.id)!;
    expect(row).toEqual({ returns_at: T + RETURN_AFTER, answer: least });
    // Not back yet; back a day later, as a past card with your answer.
    expect(loud.feed.view(loud.prefs(), T + HOUR).items.some((x) => x.id === it.id)).toBe(false);
    const back = loud.feed.view(loud.prefs(), T + RETURN_AFTER + MIN).items.find((x) => x.id === it.id)!;
    expect(back).toMatchObject({ kind: 'past', answer: least });
    expect(back.after).toBeDefined();
    expect(loud.feed.pendingCount(T + RETURN_AFTER + MIN)).toBeGreaterThanOrEqual(1);
    // Only that once: kept, teaching nothing from now; it leaves the feed.
    loud.feedSettle(it.id, 'once', T + RETURN_AFTER + 2 * MIN);
    expect(store.one<{ until: number }>('SELECT until FROM attn_answer WHERE checkin_id = ?', it.id)!.until).toBe(T + RETURN_AFTER + 2 * MIN);
    expect(loud.answerExamples(T + RETURN_AFTER + 3 * MIN).some((e) => e.at === T)).toBe(false);
    expect(loud.feed.view(loud.prefs(), T + RETURN_AFTER + 3 * MIN).items.some((x) => x.id === it.id)).toBe(false);
    // Undo: the answer goes, and the message is back unanswered.
    loud.feedSettle(it.id, 'undo', T + RETURN_AFTER + 4 * MIN);
    expect(store.raw('SELECT 1 FROM attn_answer WHERE checkin_id = ?', it.id).length).toBe(0);
    expect(store.one<{ answer: string | null }>('SELECT answer FROM cal_item WHERE id = ?', it.id)!.answer).toBeNull();
    // An answer the model expected does not come back.
    const most = (['sound', 'show', 'inbox'] as const)[p.indexOf(Math.max(...p))];
    loud.feedAnswer(it.id, most, T + RETURN_AFTER + 5 * MIN);
    expect(store.one<{ returns_at: number | null }>('SELECT returns_at FROM cal_item WHERE id = ?', it.id)!.returns_at).toBeNull();
    // Answering again replaces the earlier answer.
    loud.feedAnswer(it.id, least, T + RETURN_AFTER + 6 * MIN);
    expect(store.raw('SELECT 1 FROM attn_answer WHERE checkin_id = ?', it.id).length).toBe(1);
  });

  test('"what was it wrong about" routes the answer to that part alone, and the learner uses it', async () => {
    const base: AttnExample = { facts: { network: 'signal', shape: 'group', conversation: 'g1', spaces: [], author: 'ann', bot: false, urgent: false, media: false, base: 'drop' } as never, words: ['deploy', 'failed'], why: [], importance: 0.5, alert: 0.3, moment: { keys: ['all', 'hour:day'], by: 0 }, weight: 0, at: 0 };
    const answer = (parts: P.CalPart[] | null) => ({ answer: 'sound', band: 'show', source: 'feed', parts: parts ? JSON.stringify(parts) : null, at: 0 });
    const e = (x: Partial<AttnExample>): AttnExample => ({ ...base, moment: undefined, ...x, weight: 1, at: 0 });
    const fit = (rows: AttnExample[]) => trainAttn(rows, new Set(), 0);
    const keys = base.moment!.keys;
    // Wrong about the chat: only the chat's weight moves, toward louder.
    const chat = fit(feedRouted(answer(['chat']), base, e, keys));
    expect(chat.want['conv:g1']).toBeGreaterThan(0);
    expect(chat.want['author:ann']).toBeUndefined();
    expect(Object.keys(chat.wait)).toHaveLength(0);
    // The person: want and owed, nothing of the chat.
    const person = fit(feedRouted(answer(['person']), base, e, keys));
    expect(person.want['author:ann']).toBeGreaterThan(0);
    expect(person.owed['author:ann']).toBeGreaterThan(0);
    expect(person.want['conv:g1']).toBeUndefined();
    // The topic: the words alone.
    const topic = fit(feedRouted(answer(['topic']), base, e, keys));
    expect(Object.keys(topic.want).every((k) => k.startsWith('w:'))).toBe(true);
    // Can wait: the can-wait model, not want.
    const wait = fit(feedRouted(answer(['wait']), base, e, keys));
    expect(Object.keys(wait.want)).toHaveLength(0);
    expect(Object.keys(wait.wait).length).toBeGreaterThan(0);
    // The moment: a sound then cheaper, the message untouched.
    const moment = fit(feedRouted(answer(['moment']), base, e, keys));
    expect(moment.moment.all).toBeLessThan(0);
    expect(Object.keys(moment.want)).toHaveLength(0);
    // Delivery: a fault of how it was sent, nothing learned.
    expect(feedRouted(answer(['delivery']), base, e, keys)).toEqual([]);
    // No part named: broadly, want and can-wait toward Sound, and a sound then a little cheaper.
    const broad = feedRouted(answer(null), base, e, keys);
    expect(broad).toHaveLength(1);
    expect(broad[0]).toMatchObject({ want: 1, wait: [1, 1, 1] });
    expect(broad[0].only).toBeUndefined();
    // Through the learner: the parts are stored and the next fit moves only the chat.
    store.db.exec(`DELETE FROM attn_answer`);
    const T = Date.now();
    const a = await delivered(T - 5 * HOUR, 50, { tapped: 30_000 });
    const id = loud.feed.place(a.id, 'card', T)!;
    const ann = store.one<{ a: string }>('SELECT COALESCE(i.person_id, m.author_id) AS a FROM message m LEFT JOIN identity i ON i.id = m.author_id WHERE m.id = ?', a.id)!.a;
    // What you did elsewhere already moved Ann a little; the answer about the chat must not move her more.
    loud.learn(T);
    const annBefore = loud.model.want[`author:${ann}`] ?? 0;
    loud.feedAnswer(id, 'sound', T);
    const r = loud.feedParts(id, ['chat'], T);
    expect(r.after).toHaveLength(3);
    expect(store.one<{ parts: string }>('SELECT parts FROM attn_answer WHERE checkin_id = ?', id)!.parts).toBe('["chat"]');
    const ex = loud.answerExamples(T).filter((x) => x.at === T);
    expect(ex.every((x) => x.only === 'conv')).toBe(true);
    expect(loud.model.want[`author:${ann}`] ?? 0).toBeCloseTo(annBefore, 3);
    expect(loud.model.want[`conv:${a.conversation_id}`]).toBeGreaterThan(0);
    // The feed's item shows which way each of the six parts pushed it, and what it cost.
    const v = loud.feed.itemView(store.one<Record<string, unknown>>('SELECT * FROM cal_item WHERE id = ?', id)!, T)!;
    expect(v.parts.map((x) => x.part)).toEqual(['person', 'chat', 'topic', 'wait', 'moment', 'delivery']);
    for (const x of v.parts) expect(Math.abs(x.push)).toBeLessThanOrEqual(1);
    expect(v).toMatchObject({ said: 'show', you: 'sound', cost: 'missed' });
  });
});

describe('the next look went', () => {
  test('stored "next" bands become show, its table and settings go, once', () => {
    const d2 = memTempDir('dither-calfeed-migrate-');
    const path = join(d2, 'hub.sqlite');
    try {
      const s1 = new Store(path, (raw) => raw ?? null);
      const a = s1.createAccount({ network: 'signal', label: 's', color: '#000', adapter: 'signal' });
      s1.ingest(a, { t: 'conversation', conversation: { nativeId: 'c', shape: 'direct', participants: ['x'] } });
      s1.ingest(a, { t: 'message', message: { nativeId: 'm1', conversation: 'c', author: 'x', ts: 1000, body: 'hi' }, live: true });
      const mid = s1.one<{ id: string }>(`SELECT id FROM message WHERE native_id = 'm1'`)!.id;
      s1.db.query(`INSERT OR REPLACE INTO triage (message_id, decision, score, reasons, decided_by, created_at, loud, loud_view) VALUES (?, 'digest', 0, '[]', 'rules', 1, 40, ?)`).run(mid, JSON.stringify({ loudness: 40, band: 'next', reasons: [] }));
      s1.db.query(`INSERT INTO checkin (id, side, message_id, arm, propensity, pool, live_band, shadow_band, created_at) VALUES ('c1', 'quiet', ?, 'random', 1, 1, 'next', 'next', 1)`).run(mid);
      s1.db.query(`INSERT INTO attn_answer (id, message_id, answer, source, band, at) VALUES ('a1', ?, 'sooner', 'checkin', 'next', 1)`).run(mid);
      s1.db.exec(`CREATE TABLE next_look (message_id TEXT PRIMARY KEY, conversation_id TEXT, held_at INTEGER, quiet INTEGER)`);
      s1.setMetaValue('attention_prefs', { readily: 'less', nextLook: 'times', times: ['12:00'], ask: 'rarely' });
      s1.db.exec(`DELETE FROM meta WHERE key IN ('bands_without_next', 'schema_sig')`);
      s1.db.close();
      const s2 = new Store(path, (raw) => raw ?? null);
      expect(JSON.parse(s2.one<{ loud_view: string }>('SELECT loud_view FROM triage WHERE message_id = ?', mid)!.loud_view).band).toBe('show');
      expect(s2.one<Record<string, string>>(`SELECT live_band, shadow_band FROM checkin WHERE id = 'c1'`)).toEqual({ live_band: 'show', shadow_band: 'show' });
      expect(s2.one<{ band: string }>(`SELECT band FROM attn_answer WHERE id = 'a1'`)!.band).toBe('show');
      expect(s2.one(`SELECT 1 FROM sqlite_master WHERE name = 'next_look'`)).toBeNull();
      expect(s2.metaValue('attention_prefs')).toEqual({ readily: 'less', ask: 'rarely' });
      // The prefs read back hold only what is still a setting.
      expect(Object.keys(new LoudLearner(s2, 'shadow').prefs()).sort()).toEqual(['ask', 'computerFirst', 'drifting', 'readily']);
      s2.db.close();
    } finally {
      rmSync(d2, { recursive: true, force: true });
    }
  });
});

describe('where you saw it', () => {
  test('the words, the devices, what each said, and what showed beside it come back for the page', async () => {
    const activity = new ActivityStore(store);
    // A moment just past, so the devices' words (kept no later than now, no earlier than the send) land as given.
    const T = Date.now() + 2000;
    const other = post('g', 'ann', T - 10 * MIN, 'lunch at noon?');
    const m = post('dm', 'ann', T - MIN, 'are you still coming?');
    const make = () =>
      new Notifier({
        store: { notifyLook: () => ({ network: 'signal' }), one: () => null },
        phone: { list: () => ({ send: true }), higher: () => {} } as any,
        activity,
        devices: { addressed: () => false, quietOn: () => [] },
        push: {
          desktops: () => [],
          notify: async () => ({ devices: 2, accepted: 2, to: [{ id: 'sub_phone', label: 'Android app', android: true, ok: true }, { id: 'sub_desk', label: 'Firefox on Linux', android: false, ok: true }] }),
        },
        delivery: {
          listDue: () => true,
          conversationDue: () => true,
          inUse: () => true,
          plan: (conv: string) => ({ alert: true, count: 1, conv: { title: conv === other.conversation_id ? 'Club' : 'Ann', shape: conv === other.conversation_id ? 'group' : 'direct' }, sender: { name: 'Ann', key: 'ann' }, lines: [{ author: 'Ann', key: 'ann', body: 'are you still coming?', ts: T - MIN }], icons: {} }),
        },
        server: { notify: () => {}, warm: async () => {}, watched: () => false },
      });
    const notifier = make();
    notifier.message('Club', 'Ann: lunch at noon?', other.conversation_id, other.id, [], {}, 'message', 'push');
    await notifier.last;
    notifier.message('Ann', 'are you still coming?', m.conversation_id, m.id, [], {}, 'message', 'push');
    await notifier.last;
    const nid = store.one<{ id: string }>('SELECT id FROM notification WHERE message_id = ?', m.id)!.id;
    // The phone showed it on the lock screen, vibrating, beside the club's; the computer said nothing more than shown.
    activity.events([
      { id: nid, device: 'sub_phone', event: 'delivered', at: T },
      { id: nid, device: 'sub_phone', event: 'shown', at: T + 1000, seen: { surface: 'lock', sound: 'vibrate', locked: true, screenOn: false, beside: [other.conversation_id, 'nope'] } },
      { id: nid, device: 'sub_desk', event: 'shown', at: T + 2000 },
      // Junk in the device's word is dropped, not kept.
      { id: nid, device: 'sub_desk', event: 'dismissed', at: T + 3000, seen: { surface: 'everywhere', sound: 42 } as any },
    ], T + HOUR);
    const ctx = seenContext(store.db, m.id, { title: 'Ann', preview: 'are you still coming?', at: T - MIN, network: 'signal', shape: 'direct', conversationId: m.conversation_id });
    expect(ctx.sent).toMatchObject({ title: 'Ann', body: 'are you still coming?', network: 'signal', computerInUse: true, tier: 'push', sounded: true });
    expect(ctx.sent!.lines).toEqual([{ author: 'Ann', body: 'are you still coming?', ts: T - MIN }]);
    const phone = ctx.sent!.devices.find((d) => d.label === 'Android app')!;
    expect(phone).toMatchObject({ kind: 'android', phone: true, meantToSound: true, surface: 'lock', sound: 'vibrate', locked: true, screenOn: false, delivered: T, shown: T + 1000 });
    expect(phone.beside).toEqual([{ title: 'Club', body: 'Ann: lunch at noon?', at: expect.any(Number) }]);
    const desk = ctx.sent!.devices.find((d) => d.label === 'Firefox on Linux')!;
    expect(desk).toMatchObject({ kind: 'browser', phone: false, surface: null, sound: null, dismissed: T + 3000, beside: null });
    expect(store.one<{ seen: string | null }>(`SELECT seen FROM notification_event WHERE notification_id = ? AND event = 'dismissed'`, nid)!.seen).toBeNull();
    // Said honestly: the computer showed it without saying where.
    expect(ctx.unknown.some((u) => /didn't say where/.test(u))).toBe(true);
    // A push it skipped, and the first visit after it.
    const q = post('dm', 'ann', T, 'quiet one');
    store.db.query(`INSERT INTO push_skip (message_id, conversation_id, why, at) VALUES (?, ?, 'watched', ?)`).run(q.id, q.conversation_id, T);
    activity.visits([{ id: 'v_1', device: 'dev_1', deviceLabel: 'Firefox on Linux', view: 'conversation', conversationId: q.conversation_id, start: T + 5 * MIN, end: T + 6 * MIN, active: 30, source: 'inbox' } as any], T + 7 * MIN);
    const qc = seenContext(store.db, q.id, { title: 'Ann', preview: 'quiet one', at: T, network: 'signal', shape: 'direct', conversationId: q.conversation_id });
    expect(qc.sent).toBeNull();
    expect(qc.notSent).toBe('watched');
    expect(qc.opened).toMatchObject({ source: 'inbox', device: 'Firefox on Linux', phone: false });
    // The words are kept only a while; the row and its times stay.
    activity.prune(T + WORDS_KEPT + DAY, true);
    const later = seenContext(store.db, m.id, { title: 'Ann', preview: 'are you still coming?', at: T - MIN, network: 'signal', shape: 'direct', conversationId: m.conversation_id });
    expect(later.sent).toMatchObject({ title: null, body: null, lines: [] });
    expect(later.sent!.devices.length).toBe(2);
  });

});
