/**
 * The calibration feed's hub side (calfeed.ts, seen.ts, loudlearn.ts, docs/notifications.md "The calibration feed"):
 * how surprised and unsure the model is and how worth asking a notification is; cards drawn in proportion to that,
 * with the chance kept; the ones it is sure of hidden only when every condition holds; a surprising answer back once;
 * an answer routed to the parts you name; the next look's stored values moved to Show; and each notification keeping
 * what the devices drew and said, so the feed can draw it again.
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { rmSync } from 'node:fs';
import { join } from 'node:path';
import { ActivityStore, WORDS_KEPT } from '../src/activity.ts';
import type * as P from '@dither-chat/protocol';
import { cardChance, chances, EXPIRE_AFTER, fewOf, ipsWeight, isSure, LATE_FLOOR, lateWeight, RETURN_AFTER, sigmaOf, SURE_ANSWERS, SURE_SHOWN, surpriseOf, unsureOf, worthAsking, youOf } from '../src/calfeed.ts';
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

/** A message from Ann, decided `at`, and (when `sounded`) a notification of it that sounded. */
async function delivered(at: number, sounded: boolean) {
  const m = post(n % 2 ? 'dm' : 'g', 'ann', at - MIN);
  const d = (await triage.decide(m.id, at))!;
  store.setTriage(m.id, d, d.facts);
  store.db.query('UPDATE triage SET created_at = ? WHERE message_id = ?').run(at, m.id);
  if (sounded) store.db.query(`INSERT INTO notification (id, kind, message_id, conversation_id, sent_at, alert) VALUES (?, 'message', ?, ?, ?, 1)`).run(`n_${m.id}`, m.id, m.conversation_id, at);
  return m;
}

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

  test('surprise is −log2 of what you did, capped at 5 bits; unsure is spread × few answers; worth fades by half in 3 days', () => {
    expect(surpriseOf([0.5, 0.25, 0.25], 'sound')).toBe(1);
    expect(surpriseOf([0.5, 0.25, 0.25], 'show')).toBe(2);
    expect(surpriseOf([0.999, 0.001, 0], 'inbox')).toBe(5);
    expect(unsureOf([1 / 3, 1 / 3, 1 / 3], 0)).toBeCloseTo(1, 2);
    expect(unsureOf([1, 0, 0], 0)).toBe(0);
    expect(unsureOf([1 / 3, 1 / 3, 1 / 3], 5)).toBeCloseTo(0.5, 2);
    expect(worthAsking(5, 1, 0)).toBe(1);
    expect(worthAsking(5, 1, 3 * DAY)).toBeCloseTo(0.5, 3);
    expect(worthAsking(2.5, 0, 0)).toBeCloseTo(0.3, 3);
  });

  test('what you did: opened within 10 minutes is Sound, within 3 hours Show, later or never Inbox', () => {
    expect(youOf(5 * MIN, HOUR)).toBe('sound');
    expect(youOf(2 * HOUR, 4 * HOUR)).toBe('show');
    expect(youOf(5 * HOUR, DAY)).toBe('inbox');
    expect(youOf(null, 4 * HOUR)).toBe('inbox');
    // Not opened, and too soon to say.
    expect(youOf(null, HOUR)).toBeNull();
  });

  test('cards: none at 0.5 or below; above, in proportion to worth, about the setting a day; weighted back by their chance', () => {
    expect(cardChance(0.5, 3, 4)).toBe(0);
    expect(cardChance(0.8, 0, 4)).toBe(0);
    expect(cardChance(0.8, 3, 4)).toBeCloseTo(0.6, 3);
    expect(cardChance(0.6, 3, 4)).toBeCloseTo(0.45, 3);
    // Alone on its day, it opens.
    expect(cardChance(0.7, 1, 0)).toBe(1);
    expect(ipsWeight(0.5)).toBe(1);
    expect(ipsWeight(0.25)).toBe(2);
    expect(ipsWeight(SURE_SHOWN)).toBe(3);
    expect(ipsWeight(null)).toBe(1);
  });

  test('hidden as sure only when every condition holds', () => {
    const sure = { p: [0.01, 0.02, 0.97] as P.Trio, you: 'inbox' as const, answers: SURE_ANSWERS, against: false, held: false };
    expect(isSure(sure)).toBe(true);
    expect(isSure({ ...sure, p: [0.02, 0.04, 0.94] })).toBe(false);
    expect(isSure({ ...sure, you: 'show' })).toBe(false);
    expect(isSure({ ...sure, answers: SURE_ANSWERS - 1 })).toBe(false);
    expect(isSure({ ...sure, against: true })).toBe(false);
    expect(isSure({ ...sure, held: true })).toBe(false);
  });

  test('a late answer counts less in what is learned, down to a floor', () => {
    expect(lateWeight(HOUR)).toBe(1);
    expect(lateWeight(DAY)).toBe(1);
    expect(lateWeight(EXPIRE_AFTER)).toBeCloseTo(LATE_FLOOR, 6);
    expect(lateWeight(10 * EXPIRE_AFTER)).toBe(LATE_FLOOR);
    const mid = lateWeight((DAY + EXPIRE_AFTER) / 2);
    expect(mid).toBeGreaterThan(LATE_FLOOR);
    expect(mid).toBeLessThan(1);
  });
});

describe('the feed', () => {
  const visit = (conv: string, at: number) =>
    store.db.query(`INSERT INTO visit (id, device, view, conversation_id, start_at, end_at, source, updated_at) VALUES (?, 'd', 'conversation', ?, ?, ?, 'inbox', ?)`).run(`v_${++n}`, conv, at, at + MIN, at);

  test('each message goes on once what you did is known, with the chance it was drawn with', async () => {
    store.db.exec('DELETE FROM cal_item');
    loud.setPrefs({ ask: 'often' });
    const T = Date.now();
    const a = await delivered(T - 5 * HOUR, true);
    visit(a.conversation_id, T - 5 * HOUR + 2 * MIN);
    const b = await delivered(T - 4 * HOUR, false);
    // Too soon to say what you did, and not opened: it waits for a later fill.
    const c = await delivered(T - 30 * MIN, false);
    const draws: number[] = [];
    loud.feed.random = () => (draws.push(0.3), 0.3);
    expect(loud.feed.fill(loud.prefs(), T, true)).toBe(2);
    const rows = store.raw<{ message_id: string; kind: string; chance: number; score: number; you: string; did: string; surprise: number; p: string }>('SELECT * FROM cal_item');
    expect(rows.map((r) => r.message_id).sort()).toEqual([a.id, b.id].sort());
    expect(rows.find((r) => r.message_id === a.id)).toMatchObject({ you: 'sound', did: 'sound' });
    expect(rows.find((r) => r.message_id === b.id)).toMatchObject({ you: 'inbox', did: 'inbox' });
    for (const r of rows) {
      // The chance kept is of how it was drawn: a card, its chance; a row, the rest; worth asking as worked out.
      expect(r.surprise).toBeCloseTo(surpriseOf(JSON.parse(r.p), r.you as P.CalAnswer), 3);
      if (r.score <= 0.5) expect(r).toMatchObject({ kind: 'row', chance: 1 });
      else if (r.kind === 'card') expect(r.chance).toBeGreaterThan(0.3);
      else expect(r.chance).toBeLessThanOrEqual(0.7);
    }
    expect(store.raw('SELECT 1 FROM cal_item WHERE message_id = ?', c.id).length).toBe(0);
    // At most once an hour; a forced fill takes c once it has settled.
    expect(loud.feed.fill(loud.prefs(), T + MIN)).toBe(0);
    expect(loud.feed.fill(loud.prefs(), T + 3 * HOUR, true)).toBe(1);
  });

  test('cards are drawn in proportion to worth: a draw under its chance opens it, the chance is what is kept', () => {
    store.db.exec('DELETE FROM cal_item');
    const T = Date.now();
    const ids = store.raw<{ message_id: string }>(`SELECT message_id FROM triage WHERE loud IS NOT NULL AND decision != 'silent' LIMIT 3`).map((r) => r.message_id);
    // Every message surprising (you opened it at once; none sounded), so every one is worth asking over 0.5.
    for (const id of ids) {
      store.db.query('UPDATE triage SET loud = 20, created_at = ? WHERE message_id = ?').run(T - 5 * HOUR, id);
      store.db.query('UPDATE message SET ts = ? WHERE id = ?').run(T - 5 * HOUR, id);
    }
    const convs = store.raw<{ conversation_id: string }>(`SELECT DISTINCT conversation_id FROM message WHERE id IN (${ids.map(() => '?').join(',')})`, ...ids);
    for (const c of convs) visit(c.conversation_id, T - 5 * HOUR + MIN);
    let k = 0;
    const u = [0.05, 0.99, 0.05];
    loud.feed.random = () => u[k++ % u.length];
    loud.feed.fill(loud.prefs(), T, true);
    const rows = store.raw<{ message_id: string; kind: string; chance: number; score: number }>('SELECT * FROM cal_item');
    expect(rows.length).toBeGreaterThan(0);
    const dayWorth = rows.filter((r) => r.score > 0.5).reduce((t, r) => t + r.score, 0);
    for (const r of rows) {
      const c = cardChance(r.score, 3, dayWorth);
      expect(r.chance).toBeCloseTo(r.kind === 'card' ? c : 1 - c, 2);
    }
    expect(rows.some((r) => r.kind === 'card')).toBe(true);
  });

  test('a person it is sure of is hidden, but one in twenty is shown; a sound held back never is', async () => {
    store.db.exec('DELETE FROM cal_item');
    const T = Date.now();
    // A chat of its own, never opened: what you did is Inbox.
    store.ingest(acc, { t: 'conversation', conversation: { nativeId: 'dump', shape: 'group', name: 'Photos', participants: ['bo', 'cy', 'me'] } });
    const m = post('dump', 'bo', T - 6 * HOUR, 'weekly photo dump');
    const d = (await triage.decide(m.id, T - 6 * HOUR))!;
    store.setTriage(m.id, d, d.facts);
    store.db.query('UPDATE triage SET loud = 12, created_at = ? WHERE message_id = ?').run(T - 6 * HOUR, m.id);
    const who = store.one<{ a: string }>('SELECT COALESCE(i.person_id, m.author_id) AS a FROM message m LEFT JOIN identity i ON i.id = m.author_id WHERE m.id = ?', m.id)!.a;
    const put = store.db.query(`INSERT INTO attn_answer (id, message_id, conversation_id, author, answer, source, band, at) VALUES (?, ?, ?, ?, 'inbox', 'feed', 'inbox', ?)`);
    for (let i = 0; i < SURE_ANSWERS; i++) put.run(`ans_s${i}`, m.id, m.conversation_id, who, T - 40 * DAY);
    loud.feed.random = () => 0.5;
    loud.feed.fill(loud.prefs(), T, true);
    expect(store.one<{ kind: string; chance: number }>('SELECT kind, chance FROM cal_item WHERE message_id = ?', m.id)).toEqual({ kind: 'sure', chance: 1 - SURE_SHOWN });
    expect(loud.feed.view(loud.prefs(), T).sure.map((x) => x.messageId)).toContain(m.id);
    // Drawn under one in twenty: shown, as a row, with its chance.
    store.db.exec('DELETE FROM cal_item');
    loud.feed.random = () => 0.01;
    loud.feed.fill(loud.prefs(), T, true);
    expect(store.one<{ kind: string; sure_shown: number; chance: number }>('SELECT kind, sure_shown, chance FROM cal_item WHERE message_id = ?', m.id)).toEqual({ kind: 'row', sure_shown: 1, chance: SURE_SHOWN });
    // One answer against it in the last 30 days: not sure any more.
    store.db.exec('DELETE FROM cal_item');
    loud.feed.random = () => 0.5;
    put.run('ans_against', m.id, m.conversation_id, who, T - 2 * DAY);
    store.db.query(`UPDATE attn_answer SET answer = 'sound' WHERE id = 'ans_against'`).run();
    loud.feed.fill(loud.prefs(), T, true);
    expect(store.one<{ kind: string }>('SELECT kind FROM cal_item WHERE message_id = ?', m.id)!.kind).not.toBe('sure');
    store.db.exec(`DELETE FROM attn_answer WHERE id LIKE 'ans_s%' OR id = 'ans_against'`);
  });

  test('an answer it gave little chance comes back once, a day later; Keep, Only that once and Undo', async () => {
    store.db.exec('DELETE FROM cal_item');
    const T = Date.now();
    const a = await delivered(T - 5 * HOUR, true);
    visit(a.conversation_id, T - 5 * HOUR + MIN);
    loud.feed.random = () => 0.99;
    loud.feed.fill(loud.prefs(), T, true);
    const it = store.one<{ id: string; p: string }>('SELECT id, p FROM cal_item WHERE message_id = ?', a.id)!;
    const p = JSON.parse(it.p) as P.Trio;
    const least = (['sound', 'show', 'inbox'] as const)[p.indexOf(Math.min(...p))];
    expect(Math.min(...p)).toBeLessThan(0.2);
    const r = loud.feedAnswer(it.id, least, T);
    expect(r.before).toEqual(p);
    expect(r.after[p.indexOf(Math.min(...p))]).toBeGreaterThanOrEqual(p[p.indexOf(Math.min(...p))]);
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
    store.db.exec('DELETE FROM cal_item');
    store.db.exec(`DELETE FROM attn_answer`);
    const T = Date.now();
    const a = await delivered(T - 5 * HOUR, false);
    visit(a.conversation_id, T - 5 * HOUR + MIN);
    loud.feed.random = () => 0.99;
    loud.feed.fill(loud.prefs(), T, true);
    const it = store.one<{ id: string }>('SELECT id FROM cal_item WHERE message_id = ?', a.id)!;
    loud.feedAnswer(it.id, 'sound', T);
    const ann = store.one<{ a: string }>('SELECT COALESCE(i.person_id, m.author_id) AS a FROM message m LEFT JOIN identity i ON i.id = m.author_id WHERE m.id = ?', a.id)!.a;
    const r = loud.feedParts(it.id, ['chat'], T);
    expect(r.after).toHaveLength(3);
    expect(store.one<{ parts: string }>('SELECT parts FROM attn_answer WHERE checkin_id = ?', it.id)!.parts).toBe('["chat"]');
    const ex = loud.answerExamples(T).filter((x) => x.at === T);
    expect(ex.every((x) => x.only === 'conv')).toBe(true);
    expect(loud.model.want[`author:${ann}`] ?? 0).toBe(0);
    expect(loud.model.want[`conv:${a.conversation_id}`]).toBeGreaterThan(0);
    // The feed's item shows which way each of the six parts pushed it.
    const v = loud.feed.itemView(store.one<Record<string, unknown>>('SELECT * FROM cal_item WHERE id = ?', it.id)!, T)!;
    expect(v.parts.map((x) => x.part)).toEqual(['person', 'chat', 'topic', 'wait', 'moment', 'delivery']);
    for (const x of v.parts) expect(Math.abs(x.push)).toBeLessThanOrEqual(1);
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
