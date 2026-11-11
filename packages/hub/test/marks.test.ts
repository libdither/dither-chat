/**
 * Your marks on triage's decisions and what is learned from them (votes.ts, docs/notifications.md): "should have
 * alerted", "the alert was wrong" and "less like this" on a real store, each moving the next message like it; marks
 * taken back; the votes from before the tiers, at half weight; what stood, only since the tiers; the list's level and
 * its preview; a model saved before the tiers starting over; and the routes the app sends marks through.
 */
import { afterAll, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type * as P from '@dither-chat/protocol';
import { emptyModel, OLD_VOTE, STOOD, STOOD_PER_PLACE, validModel, voteWeight, type Model } from '../src/learn.ts';
import { HubServer } from '../src/server.ts';
import { Store, type AccountRow } from '../src/store.ts';
import { Triage, type Decision } from '../src/triage.ts';
import { IMPLICIT_PER_PLACE, LIST_LEVELS, STOOD_AFTER, TriageVotes } from '../src/votes.ts';

const MIN = 60_000;
const HOUR = 60 * MIN;
const DAY = 24 * HOUR;

/**
 * The local model, stood in for. Its answers sit either side of the bar for a DM (0.05): "later" a little under it,
 * "maybe" a little over, "now" well over; the rest far under.
 */
const judge = async (text: string) => (/\bnow\b/.test(text) ? 0.3 : /\bmaybe\b/.test(text) ? 0.07 : /\blater\b/.test(text) ? 0.04 : 0.01);

const stores: Store[] = [];
afterAll(() => {
  for (const s of stores) s.db.close();
});

/** A hub's store, triage and marks: DMs with Ann and Bob, a server with a channel Discord notifies every message of. */
function world(before?: (store: Store) => void) {
  const store = new Store(':memory:', (raw) => raw ?? null);
  stores.push(store);
  before?.(store);
  const triage = new Triage(store);
  triage.judge = judge;
  const votes = new TriageVotes(store, triage);
  let d: AccountRow = store.createAccount({ network: 'discord', label: 'd', color: '#000', adapter: 'discord' });
  store.ingest(d, { t: 'status', status: 'online', self: { nativeId: 'me', isSelf: true, displayName: 'Me' } });
  d = store.account(d.id)!;
  store.ingest(d, { t: 'identity', identity: { nativeId: 'ann', displayName: 'Ann', contact: true } });
  store.ingest(d, { t: 'identity', identity: { nativeId: 'bob', displayName: 'Bob', contact: true } });
  store.ingest(d, { t: 'conversation', conversation: { nativeId: 'dm', shape: 'direct', participants: ['ann', 'me'] } });
  store.ingest(d, { t: 'conversation', conversation: { nativeId: 'dm2', shape: 'direct', participants: ['bob', 'me'] } });
  store.ingest(d, { t: 'space', space: { nativeId: 'guild', kind: 'community', name: 'Hub', mute: { level: 'mentions' } } });
  for (const c of ['alerts', 'news', 'builds']) store.ingest(d, { t: 'conversation', conversation: { nativeId: c, shape: 'channel', name: c, spaces: [{ nativeId: 'guild' }], mute: { level: 'all' } } });
  store.ingest(d, { t: 'conversation', conversation: { nativeId: 'general', shape: 'channel', name: 'general', spaces: [{ nativeId: 'guild' }] } });
  let n = 0;
  const w = {
    store,
    triage,
    votes,
    d,
    /** The time of the last message: each comes a minute after the one before. */
    clock: Date.now() - 2 * DAY,
    conv: (nativeId: string) => store.one<{ id: string }>('SELECT id FROM conversation WHERE native_id = ?', nativeId)!.id,
    row: (id: string) => store.one<Record<string, any>>('SELECT * FROM triage WHERE message_id = ?', id)!,
    /** A live message, decided as of when it came and kept as main.ts keeps it. */
    async say(conversation: string, author: string, body: string): Promise<{ id: string; dec: Decision }> {
      w.clock += MIN;
      const nativeId = `m${++n}`;
      store.ingest(d, { t: 'message', message: { nativeId, conversation, author, ts: w.clock, body }, live: true });
      const id = store.one<{ id: string }>('SELECT id FROM message WHERE native_id = ?', nativeId)!.id;
      if (author === 'me') return { id, dec: null as unknown as Decision };
      const dec = (await triage.decide(id, w.clock))!;
      store.setTriage(id, dec, dec.facts);
      return { id, dec };
    },
  };
  return w;
}

describe('"should have alerted" and "the alert was wrong"', () => {
  test('a mark on a Conversation message is kept, and the next one like it in that conversation alerts', async () => {
    const w = world();
    const first = await w.say('dm', 'ann', 'are you coming later');
    // Just under the bar: a Conversation.
    expect(first.dec).toMatchObject({ decision: 'quiet', decidedBy: 'rules' });
    expect(first.dec.facts!.judge).toBe(0.04);
    expect(first.dec.probs!.alert).toBeLessThan(0.5);

    const r = w.votes.mark(first.id, { alert: true }, w.clock);
    expect(r.marks).toEqual({ alert: true });
    expect(w.row(first.id)).toMatchObject({ decision: 'quiet', alert_mark: 1, less_mark: null, marked_at: w.clock, feedback: null });
    // What was learned, and how it fits: one mark, which the start alone got wrong.
    expect(r.policy).toMatchObject({ votes: 1, errors: 0, baseline: 1, learnedAt: w.clock, lastReason: 'a mark' });
    expect(r.policy.factors.find((f) => f.head === 'alert')).toMatchObject({ text: 'In your DM with Ann, not about you', votes: 1 });
    expect(r.policy.factors.every((f) => f.head === 'alert' && f.weight > 0)).toBe(true);
    expect(w.triage.learned.w.important).toEqual({});
    // The app reads the mark with the message.
    expect(w.store.messageViews([w.store.one('SELECT * FROM message WHERE id = ?', first.id)!])[0].triage).toMatchObject({ decision: 'quiet', marks: { alert: true }, judge: 0.04 });

    const next = await w.say('dm', 'ann', 'are you coming later');
    expect(next.dec).toMatchObject({ decision: 'push', decidedBy: 'learned' });
    expect(next.dec.reasons[0]).toBe('Alert, learned from your marks (was Conversation)');
    expect(next.dec.reasons[1]).toMatch(/^More likely to alert: /);
    expect(next.dec.reasons).toContain('More likely to alert: In your DM with Ann, not about you');
    expect(next.dec.probs!.alert).toBeGreaterThanOrEqual(0.5);
    // The local model said what it said before: the mark is what tipped it.
    expect(next.dec.facts!.judge).toBe(0.04);
    // One mark moves its conversation, not every DM: Bob's is where it was.
    expect((await w.say('dm2', 'bob', 'are we on for later')).dec.decision).toBe('quiet');
  });

  test('a mark on an alert stops the next one like it; taken back, it alerts again', async () => {
    const w = world();
    const first = await w.say('dm2', 'bob', 'maybe call me');
    expect(first.dec.decision).toBe('push');
    expect(first.dec.facts!.judge).toBe(0.07);
    const r = w.votes.mark(first.id, { alert: false }, w.clock);
    expect(r.marks).toEqual({ alert: false });
    expect(w.row(first.id)).toMatchObject({ decision: 'push', alert_mark: 0, marked_at: w.clock });
    expect(r.policy).toMatchObject({ votes: 1, errors: 0, baseline: 1 });
    expect(r.policy.factors.find((f) => f.head === 'alert')).toMatchObject({ text: 'In your DM with Bob, not about you' });
    expect(r.policy.factors.every((f) => f.weight < 0)).toBe(true);

    const next = await w.say('dm2', 'bob', 'maybe call me');
    expect(next.dec).toMatchObject({ decision: 'quiet', decidedBy: 'learned' });
    expect(next.dec.reasons[0]).toBe('Conversation, learned from your marks (was Alert)');
    expect(next.dec.reasons[1]).toMatch(/^Less likely to alert: /);
    // What clearly cannot wait still alerts there; and Ann's DM is where it was.
    expect((await w.say('dm2', 'bob', 'call me now')).dec.decision).toBe('push');
    expect((await w.say('dm', 'ann', 'maybe call me')).dec.decision).toBe('push');

    // null takes the mark back: nothing is left to learn from.
    const back = w.votes.mark(first.id, { alert: null }, w.clock);
    expect(back.marks).toEqual({});
    expect(w.row(first.id)).toMatchObject({ alert_mark: null, marked_at: null });
    expect(back.policy).toMatchObject({ votes: 0, factors: [] });
    expect(w.triage.learned).toEqual(emptyModel());
    expect((await w.say('dm2', 'bob', 'maybe call me')).dec).toMatchObject({ decision: 'push', decidedBy: 'rules' });
  });

  test('a mark makes its place and its author eligible at once: the next decision reads the marks again', async () => {
    const w = world();
    const missed = await w.say('general', 'bob', 'the basement is flooding now');
    expect(missed.dec.decision).toBe('drop');
    expect(missed.dec.facts!.judge).toBeUndefined();
    // Read once already: without being told, triage would not look again for a minute.
    expect(w.triage.marked(w.clock).convs.size).toBe(0);
    w.votes.mark(missed.id, { alert: true }, w.clock);
    expect(w.triage.marked(w.clock).convs.has(w.conv('general'))).toBe(true);
    const next = await w.say('general', 'ann', 'flooding again now');
    expect(next.dec.decision).toBe('push');
    expect(next.dec.facts).toMatchObject({ conv: false, judge: 0.3 });
  });
});

describe('"less like this"', () => {
  test('lowers importance there: the next one in that channel is below the list, and says what it learned from', async () => {
    const w = world();
    const first = await w.say('alerts', 'bob', 'build 41 finished');
    expect(first.dec).toMatchObject({ decision: 'digest', score: 0.8 });
    const r = w.votes.mark(first.id, { less: true }, w.clock);
    expect(r.marks).toEqual({ less: true });
    expect(w.row(first.id)).toMatchObject({ decision: 'digest', less_mark: 1, alert_mark: null, marked_at: w.clock });
    expect(r.policy).toMatchObject({ votes: 1, errors: 0, baseline: 1 });
    expect(r.policy.factors.find((f) => f.head === 'important')).toMatchObject({ text: 'In #alerts · Hub, not about you', votes: 1 });
    expect(w.triage.learned.w.alert).toEqual({});

    const next = await w.say('alerts', 'bob', 'build 42 finished');
    expect(next.dec).toMatchObject({ decision: 'drop', decidedBy: 'learned' });
    expect(next.dec.reasons[0]).toBe('Below the list, learned from your marks (was List)');
    expect(next.dec.reasons).toContain('Less likely to matter: In #alerts · Hub, not about you');
    expect(next.dec.reasons.some((r) => /^Below the list: importance \d+%, under your level of 60%$/.test(r))).toBe(true);
    expect(next.dec.reasons.at(-1)).toBe('Discord notifies every message here');
    expect(next.dec.score).toBeLessThan(0.6);
    // Another channel of that server, from someone else: still on the list after one mark.
    expect((await w.say('news', 'ann', 'the paper is out')).dec.decision).toBe('digest');

    // false takes it back, as null does.
    expect(w.votes.mark(first.id, { less: false }, w.clock).marks).toEqual({});
    expect(w.row(first.id)).toMatchObject({ less_mark: null, marked_at: null });
    expect((await w.say('alerts', 'bob', 'build 43 finished')).dec).toMatchObject({ decision: 'digest', decidedBy: 'rules' });
  });

  test('in a DM it lowers the importance and leaves the tier: a Conversation is one whatever its importance', async () => {
    const w = world();
    const first = await w.say('dm', 'ann', 'look at this meme');
    w.votes.mark(first.id, { less: true }, w.clock);
    const next = await w.say('dm', 'ann', 'look at this other meme');
    expect(next.dec.decision).toBe('quiet');
    expect(next.dec.probs!.important).toBeLessThan(0.6);
    expect(next.dec.decidedBy).toBe('rules');
  });

  test('both marks on one message; each is set or taken back by itself', async () => {
    const w = world();
    const m = await w.say('dm2', 'bob', 'maybe look at this');
    expect(m.dec.decision).toBe('push');
    expect(w.votes.mark(m.id, { alert: false, less: true }, w.clock).marks).toEqual({ alert: false, less: true });
    expect(w.triage.learned.w.alert[`conv:${w.conv('dm2')}`]).toBeLessThan(0);
    expect(w.triage.learned.w.important[`conv:${w.conv('dm2')}`]).toBeLessThan(0);
    expect(w.votes.mark(m.id, { less: false }, w.clock).marks).toEqual({ alert: false });
    expect(w.triage.learned.w.important).toEqual({});
    expect(w.triage.learned.w.alert[`conv:${w.conv('dm2')}`]).toBeLessThan(0);
    expect(w.votes.mark(m.id, { alert: null }, w.clock).marks).toEqual({});
    expect(w.row(m.id).marked_at).toBeNull();
  });
});

describe('what cannot be marked, and what a mark fills in', () => {
  test('a message triage never decided on, and one in a muted place', async () => {
    const w = world();
    expect(() => w.votes.mark('msg_nothing', { alert: true })).toThrow('Triage never decided on this message');
    w.store.setRule('conversation', w.conv('dm'), 'none');
    const silent = await w.say('dm', 'ann', 'come now');
    expect(silent.dec.decision).toBe('silent');
    expect(() => w.votes.mark(silent.id, { less: true })).toThrow('This place is silenced');
    expect(w.row(silent.id).marked_at).toBeNull();
  });

  test('a decision kept without its facts gets them when it is marked', async () => {
    const w = world();
    const m = await w.say('alerts', 'bob', 'build 7 finished');
    w.store.db.query('UPDATE triage SET facts = NULL WHERE message_id = ?').run(m.id);
    w.votes.mark(m.id, { less: true }, w.clock);
    const facts = JSON.parse(w.row(m.id).facts);
    expect(facts).toMatchObject({ shape: 'channel', conversation: w.conv('alerts'), base: 'digest', bot: false });
    expect(w.votes.examples(w.clock).filter((e) => e.vote)).toHaveLength(1);
  });
});

describe('votes from before the tiers', () => {
  /** A vote as the four levels kept it: the level it was voted to, a day before the tiers. */
  const oldVote = (w: ReturnType<typeof world>, id: string, level: string, was: string) =>
    w.store.db.query('UPDATE triage SET feedback = ?, feedback_at = ?, was = ? WHERE message_id = ?').run(level, w.store.tiersAt() - DAY, was, id);

  test('they teach importance, at half a mark, and nothing about alerts', async () => {
    const w = world();
    const down = await w.say('news', 'ann', 'the paper is out');
    const lower = await w.say('news', 'ann', 'the paper is out again');
    const up = await w.say('general', 'bob', 'the garden is open');
    oldVote(w, down.id, 'digest', 'push');
    oldVote(w, lower.id, 'drop', 'quiet');
    oldVote(w, up.id, 'quiet', 'digest');
    const now = Date.now();
    const ex = w.votes.examples(now);
    expect(ex).toHaveLength(3);
    expect(ex.every((e) => e.vote && e.y === undefined)).toBe(true);
    expect(ex.map((e) => e.label).sort()).toEqual(['digest', 'drop', 'quiet']);
    for (const e of ex) expect(e.weight).toBeCloseTo(OLD_VOTE * voteWeight(w.store.tiersAt() - DAY, now), 6);
    expect(ex[0].weight).toBeLessThan(0.5);
    expect(ex[0].weight).toBeGreaterThan(0.49);
    w.votes.learn('test', now);
    const m = w.triage.learned;
    expect(m.w.alert).toEqual({});
    expect(m.w.important[`conv:${w.conv('news')}`]).toBeLessThan(0);
    expect(m.w.important[`conv:${w.conv('general')}`]).toBeGreaterThan(0);
    // The policy counts them with the marks; the app reads the old vote as history, not as a mark.
    const view = w.votes.view(now);
    expect(view.votes).toBe(3);
    const t = w.store.messageViews([w.store.one('SELECT * FROM message WHERE id = ?', down.id)!])[0].triage!;
    expect(t.feedback).toBe('digest');
    expect(t.marks).toBeUndefined();
  });

  test('"less like this" on a message with an old vote says more than the vote: the mark is the example', async () => {
    const w = world();
    const m = await w.say('news', 'ann', 'the paper is out');
    oldVote(w, m.id, 'push', 'digest');
    expect(w.votes.examples(Date.now()).map((e) => e.label)).toEqual(['push']);
    w.votes.mark(m.id, { less: true }, Date.now());
    const ex = w.votes.examples(Date.now());
    expect(ex).toHaveLength(1);
    expect(ex[0]).toMatchObject({ y: { important: 0 }, vote: true });
    expect(ex[0].label).toBeUndefined();
    expect(ex[0].weight).toBeGreaterThan(0.99);
    // An alert mark says nothing of importance: the old vote still counts beside it.
    w.votes.mark(m.id, { less: false, alert: true }, Date.now());
    const both = w.votes.examples(Date.now());
    expect(both.map((e) => e.y ?? e.label)).toEqual([{ alert: 1 }, 'push']);
  });
});

describe('what stood', () => {
  test('alerts left unmarked and Conversation messages that did not alert count a little, half a day on, and only since the tiers', async () => {
    const w = world();
    const alert = await w.say('dm', 'ann', 'come now');
    const calm = await w.say('dm', 'ann', 'see you tomorrow');
    expect([alert.dec.decision, calm.dec.decision]).toEqual(['push', 'quiet']);
    // None of these says anything of the model: a rule's alert, a Conversation nobody read, a list row, a marked one.
    w.store.setRule('keyword', 'stove', 'all');
    await w.say('dm', 'ann', 'the stove is on');
    w.store.setRule('keyword', 'stove', null);
    w.triage.judge = null;
    await w.say('dm2', 'bob', 'hello there');
    w.triage.judge = judge;
    await w.say('alerts', 'bob', 'build 9 finished');
    const marked = await w.say('dm2', 'bob', 'call me now');
    w.votes.mark(marked.id, { alert: false }, w.clock);

    const made = Date.now();
    // Too soon: you may still mark them.
    expect(w.votes.examples(made + STOOD_AFTER - HOUR).filter((e) => !e.vote)).toEqual([]);
    const later = made + DAY;
    const stood = w.votes.examples(later).filter((e) => !e.vote);
    expect(stood.map((e) => [e.y, e.weight, e.words])).toEqual(expect.arrayContaining([[{ alert: 1 }, STOOD, []], [{ alert: 0 }, STOOD, []]]));
    expect(stood).toHaveLength(2);
    expect(stood.every((e) => e.facts.conversation === w.conv('dm') && e.facts.judge !== undefined)).toBe(true);

    // What was decided before this database took up the tiers was not an alert as alerts are now: it does not count.
    expect(w.store.tiersAt()).toBeLessThanOrEqual(made);
    w.store.db.query('UPDATE triage SET created_at = ? WHERE message_id = ?').run(w.store.tiersAt() - 1000, alert.id);
    expect(w.votes.examples(later).filter((e) => !e.vote).map((e) => e.y)).toEqual([{ alert: 0 }]);
    w.store.db.query(`UPDATE meta SET value = ? WHERE key = 'tiers_at'`).run(String(made + HOUR));
    expect(w.votes.examples(later).filter((e) => !e.vote)).toEqual([]);
  });

  test('at most ten of each kind from one conversation, the newest', async () => {
    const w = world();
    for (let i = 0; i < STOOD_PER_PLACE + 3; i++) await w.say('dm', 'ann', `note ${i}`);
    await w.say('dm2', 'bob', 'note');
    const stood = w.votes.examples(Date.now() + DAY).filter((e) => !e.vote);
    expect(stood.filter((e) => e.facts.conversation === w.conv('dm'))).toHaveLength(STOOD_PER_PLACE);
    expect(stood.filter((e) => e.facts.conversation === w.conv('dm2'))).toHaveLength(1);
  });
});

describe('what you did', () => {
  test('a message you answered teaches importance: the newest ten in a place for the live model, all of them for the candidate', async () => {
    const w = world();
    const ids: string[] = [];
    for (let i = 0; i < IMPLICIT_PER_PLACE + 2; i++) {
      ids.push((await w.say('news', 'ann', `question ${i}?`)).id);
      await w.say('news', 'me', `answer ${i}`);
    }
    const marked = ids[ids.length - 1];
    w.votes.mark(marked, { less: true }, w.clock);
    const now = w.clock + DAY;
    w.votes.learn('daily', now);
    const live = w.votes.examples(now).filter((e) => !e.vote);
    // The marked one is a mark, not something you did; of the other eleven, the newest ten.
    expect(live).toHaveLength(IMPLICIT_PER_PLACE);
    expect(live.every((e) => e.y?.important === 1 && e.y.alert === undefined && e.weight === 0.5)).toBe(true);
    expect(live.map((e) => e.id)).not.toContain(ids[0]);
    expect(live.map((e) => e.id)).not.toContain(marked);
    const candidate = w.votes.candidateExamples(now);
    expect(candidate.filter((e) => !e.vote)).toHaveLength(IMPLICIT_PER_PLACE + 1);
    expect(candidate.filter((e) => e.vote)).toHaveLength(1);
    expect(w.store.triagePolicy<{ candidateFrom: unknown }>()!.candidateFrom).toEqual({ votes: 1, implicit: IMPLICIT_PER_PLACE + 1 });
  });
});

describe('the list’s level and what the app is shown', () => {
  test('the view: thresholds, the bars, the preview; nothing of the old prompt', async () => {
    const w = world();
    // The preview is worked out in the background: until then the view has none.
    expect(w.votes.view().preview).toEqual([]);
    await w.votes.previewReady();
    const v = w.votes.view();
    expect(v).toMatchObject({ factors: [], rejected: [], votes: 0, errors: 0, baseline: 0, learnedAt: null, lastReason: null });
    expect(v.thresholds).toEqual({ alert: 0.5, important: 0.6 });
    expect(v.bars).toEqual({ direct: 0.05, other: 0.2 });
    expect(v.preview.map((p) => p.level)).toEqual(LIST_LEVELS);
    expect(LIST_LEVELS).toEqual([0.1, 0.2, 0.3, 0.4, 0.5, 0.6, 0.7, 0.8, 0.9]);
    expect(v.preview.every((p) => p.perDay === 0)).toBe(true);
    expect(v).not.toHaveProperty('prompt');
    expect(v).not.toHaveProperty('model');
  });

  test('setLevel: kept, rounded to a hundredth, never 0 or 1; decisions and the view go by it', async () => {
    const w = world();
    w.votes.setLevel(0.456);
    expect(w.store.listLevel()).toBe(0.46);
    expect(w.votes.view().thresholds).toEqual({ alert: 0.5, important: 0.46 });
    w.votes.setLevel(5);
    expect(w.store.listLevel()).toBe(0.99);
    w.votes.setLevel(-1);
    expect(w.store.listLevel()).toBe(0.01);
    w.votes.setLevel(0);
    expect(w.store.listLevel()).toBe(0.01);
    w.votes.setLevel(0.9);
    expect((await w.say('alerts', 'bob', 'build 1 finished')).dec.decision).toBe('drop');
    w.votes.setLevel(0.6);
    expect((await w.say('alerts', 'bob', 'build 2 finished')).dec.decision).toBe('digest');
    // Kept across a restart.
    w.votes.setLevel(0.3);
    expect(new Triage(w.store).thresholds().important).toBe(0.3);
  });

  test('the backtest in the view goes by your level', async () => {
    const w = world();
    const m = await w.say('alerts', 'bob', 'build 3 finished');
    w.votes.mark(m.id, { less: true }, w.clock);
    w.triage.learned = emptyModel();
    // At 60% the start (80%) put it on the list: wrong. At 90% it was below anyway: right.
    expect(w.votes.view(w.clock)).toMatchObject({ votes: 1, baseline: 1 });
    w.votes.setLevel(0.9);
    expect(w.votes.view(w.clock)).toMatchObject({ votes: 1, baseline: 0 });
  });

  test('the preview: chats a day the list would have held last week at each level, a chat once a day', async () => {
    const w = world();
    const day = Math.floor(Date.now() / DAY) * DAY;
    const put = async (conversation: string, decision: P.TriageDecision, score: number | null, at: number) => {
      const { id } = await w.say(conversation, 'bob', 'something');
      w.store.setTriage(id, { decision, score, reasons: [], decidedBy: 'rules' });
      w.store.db.query('UPDATE triage SET created_at = ? WHERE message_id = ?').run(at, id);
    };
    w.triage.judge = null;
    // Yesterday: two messages in #alerts (the better one counts), one in #news. The day before: #alerts again.
    await put('alerts', 'digest', 0.8, day - 12 * HOUR);
    await put('alerts', 'drop', 0.5, day - 11 * HOUR);
    await put('news', 'drop', 0.3, day - 12 * HOUR);
    await put('alerts', 'drop', 0.35, day - 36 * HOUR);
    // Left out: alerts and Conversations (they are not the list's), rows without an importance, and older than a week.
    await put('dm', 'quiet', 0.9, day - 12 * HOUR);
    await put('dm2', 'push', 0.9, day - 12 * HOUR);
    await put('builds', 'digest', null, day - 12 * HOUR);
    await put('builds', 'digest', 0.9, day - 9 * DAY);
    const now = day + HOUR;
    w.votes.learn('test', now);
    const rows = await w.votes.refreshPreview(now);
    // What was worked out stands for an hour, and a mark does not put it in doubt.
    expect(w.votes.preview(now + HOUR / 2)).toEqual(rows);
    const at = (level: number) => rows.find((r) => r.level === level)!.perDay;
    // Three chat-days at 30% or under, one from 40% to 80%, none at 90%: over seven days, to a tenth.
    expect([0.1, 0.2, 0.3].map(at)).toEqual([0.4, 0.4, 0.4]);
    expect([0.4, 0.5, 0.6, 0.7, 0.8].map(at)).toEqual([0.1, 0.1, 0.1, 0.1, 0.1]);
    expect(at(0.9)).toBe(0);
    expect(w.votes.view(now).preview).toBe(rows);
    // It stands for an hour, whatever is decided or learned meanwhile; then it is worked out again.
    await put('builds', 'digest', 0.95, day - 12 * HOUR);
    w.votes.learn('test', now + 12 * MIN);
    expect(w.votes.preview(now + 30 * MIN)).toBe(rows);
    expect((await w.votes.refreshPreview(now + 61 * MIN)).find((r) => r.level === 0.9)!.perDay).toBe(0.1);
    await put('general', 'digest', 0.95, day - 12 * HOUR);
    expect((await w.votes.refreshPreview(now + 62 * MIN)).find((r) => r.level === 0.9)!.perDay).toBe(0.3);
    expect(w.votes.view(now + 63 * MIN).preview.find((r) => r.level === 0.9)!.perDay).toBe(0.3);
    // Over a shorter span the same chats are more a day.
    expect((await w.votes.refreshPreview(now + 63 * MIN, 2)).find((r) => r.level === 0.9)!.perDay).toBe(1);
  });

  test('forgetting what it learned about a conversation, for good; and letting it be learned again', async () => {
    const w = world();
    const m = await w.say('alerts', 'bob', 'build 5 finished');
    const key = w.votes.mark(m.id, { less: true }, w.clock).policy.factors.find((f) => f.text === 'In #alerts · Hub, not about you')!.key;
    expect(key).toBe(`conv:${w.conv('alerts')}&!you`);
    w.votes.forget(key, true, w.clock);
    const v = w.votes.view(w.clock);
    expect(v.factors.some((f) => f.key === key)).toBe(false);
    expect(v.rejected).toEqual([{ key, text: 'In #alerts · Hub, not about you' }]);
    expect(v.lastReason).toBe('you had it forget something');
    expect(w.triage.learned.w.important[key]).toBeUndefined();
    w.votes.forget(key, false, w.clock);
    expect(w.votes.view(w.clock).rejected).toEqual([]);
    expect(w.triage.learned.w.important[key]).toBeLessThan(0);
  });

  test('once a day it learns again; within the day it does not', async () => {
    const w = world();
    const m = await w.say('alerts', 'bob', 'build 6 finished');
    w.votes.mark(m.id, { less: true }, w.clock);
    w.votes.daily(w.clock + HOUR);
    expect(w.votes.view(w.clock).lastReason).toBe('a mark');
    w.votes.daily(w.clock + DAY + HOUR);
    expect(w.votes.view(w.clock)).toMatchObject({ lastReason: 'daily', learnedAt: w.clock + DAY + HOUR });
  });
});

describe('a model saved before the tiers', () => {
  const old = { w: { ping: { all: -1 }, active: { 'conv:x': 2 }, interesting: {} } };

  test('starts over: its three chances are not these two, and it learns again from the marks and old votes there are', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'dither-marks-'));
    try {
      const path = join(dir, 'hub.sqlite');
      // A hub with a vote from before the tiers, and what the old model learned.
      const first = new Store(path, (raw) => raw ?? null);
      const acc = first.createAccount({ network: 'discord', label: 'd', color: '#000', adapter: 'discord' });
      first.ingest(acc, { t: 'conversation', conversation: { nativeId: 'news', shape: 'channel', name: 'news', mute: { level: 'all' } } });
      first.ingest(acc, { t: 'message', message: { nativeId: 'v1', conversation: 'news', author: 'ann', ts: Date.now() - DAY, body: 'the paper is out' }, live: true });
      const id = first.one<{ id: string }>('SELECT id FROM message')!.id;
      const cid = first.one<{ id: string }>('SELECT id FROM conversation')!.id;
      const t0 = new Triage(first);
      const dec = (await t0.decide(id))!;
      first.setTriage(id, dec, dec.facts);
      first.db.query(`UPDATE triage SET feedback = 'digest', feedback_at = ? WHERE message_id = ?`).run(Date.now() - DAY, id);
      first.setTriagePolicy({ model: old, rejected: ['w:paper'], learnedAt: 123, lastReason: 'a vote', candidate: old, candidateFrom: { votes: 9, implicit: 9 } });
      first.db.close();

      const store = new Store(path, (raw) => raw ?? null);
      const triage = new Triage(store);
      const votes = new TriageVotes(store, triage);
      expect(validModel(triage.learned)).toBe(true);
      expect(triage.learned.w).not.toHaveProperty('ping');
      // Learned again at once, from the old vote (what you did is read at the first tick, not while the hub starts):
      // that channel matters less. What you had it forget stays forgotten.
      expect(triage.learned.w.important[`conv:${cid}`]).toBeLessThan(0);
      expect(triage.learned.w.important['w:paper']).toBeUndefined();
      expect(triage.learned.w.alert).toEqual({});
      const kept = store.triagePolicy<{ model: Model; candidate: Model; candidateFrom: unknown; rejected: string[]; lastReason: string; learnedAt: number }>()!;
      expect(kept.model).toEqual(triage.learned);
      expect(kept.lastReason).toBe('the tiers replaced the levels');
      expect(kept.learnedAt).toBeNull();
      expect(kept.rejected).toEqual(['w:paper']);
      // The old candidate goes the same way.
      expect(validModel(kept.candidate)).toBe(true);
      expect(kept.candidateFrom).toEqual({ votes: 1, implicit: 0 });
      expect(votes.view().lastReason).toBe('the tiers replaced the levels');
      // The next start finds a model of these chances and keeps it as it is.
      const again = new Triage(store);
      new TriageVotes(store, again);
      expect(again.learned).toEqual(triage.learned);
      expect(store.triagePolicy<{ learnedAt: number }>()!.learnedAt).toBe(kept.learnedAt);
      store.db.close();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test('a saved model of these chances is kept as it is; with nothing saved it starts empty and learns nothing yet', () => {
    const model: Model = { w: { alert: { 'conv:a': 1.5 }, important: { 'w:paper': -2 } } };
    const w = world((store) => store.setTriagePolicy({ model, rejected: ['all'], learnedAt: 456, lastReason: 'a mark' }));
    expect(w.triage.learned).toEqual(model);
    expect(w.votes.view()).toMatchObject({ learnedAt: 456, lastReason: 'a mark', rejected: [{ key: 'all', text: 'Anything' }] });
    const fresh = world();
    expect(fresh.triage.learned).toEqual(emptyModel());
    expect(fresh.triage.candidate).toBeNull();
    expect(fresh.store.triagePolicy()).toBeNull();
  });
});

describe('the routes', () => {
  test('marks by message id, the old vote body, the policy, the level, the shadow counts, and which rules can be set', async () => {
    const w = world();
    const dir = mkdtempSync(join(tmpdir(), 'dither-marks-routes-'));
    const sup = { authorize: () => null, online: () => false, command: async () => ({}) } as any;
    const hub = new HubServer(w.store, sup, w.triage, { port: 0, hostname: '127.0.0.1', dataDir: dir, webDist: dir, secret: 's', votes: w.votes });
    const base = `http://127.0.0.1:${hub.start().port}`;
    const call = async (method: string, path: string, body?: unknown) => {
      const r = await fetch(base + path, { method, ...(body === undefined ? {} : { body: JSON.stringify(body), headers: { 'content-type': 'application/json' } }) });
      return { status: r.status, json: (await r.json().catch(() => null)) as any };
    };
    try {
      const calm = await w.say('dm', 'ann', 'are you coming later');
      const alert = await w.say('dm2', 'bob', 'maybe call me');
      const listed = await w.say('alerts', 'bob', 'build 8 finished');
      expect([calm.dec.decision, alert.dec.decision, listed.dec.decision]).toEqual(['quiet', 'push', 'digest']);

      // The marks, and what comes back: the marks as they now are, and the policy.
      const a = await call('POST', `/api/messages/${calm.id}/feedback`, { alert: true });
      expect(a.status).toBe(200);
      expect(a.json.marks).toEqual({ alert: true });
      expect(a.json.policy).toMatchObject({ votes: 1, thresholds: { alert: 0.5, important: 0.6 }, bars: { direct: 0.05, other: 0.2 } });
      expect((await call('POST', `/api/messages/${calm.id}/feedback`, { less: true })).json.marks).toEqual({ alert: true, less: true });
      expect((await call('POST', `/api/messages/${calm.id}/feedback`, { alert: null, less: false })).json.marks).toEqual({});
      expect(w.row(calm.id).marked_at).toBeNull();

      // An app from before the tiers: up says it should have alerted; down that the alert was wrong, or less like this.
      expect((await call('POST', `/api/messages/${calm.id}/feedback`, { vote: 'up' })).json.marks).toEqual({ alert: true });
      expect((await call('POST', `/api/messages/${alert.id}/feedback`, { vote: 'down' })).json.marks).toEqual({ alert: false });
      expect((await call('POST', `/api/messages/${listed.id}/feedback`, { vote: 'down' })).json.marks).toEqual({ less: true });
      // Its other body, a level, means nothing now; nor does anything else.
      for (const body of [{ feedback: 'push' }, { vote: 'sideways' }, { alert: 'yes' }, { less: 1 }, {}]) {
        const r = await call('POST', `/api/messages/${calm.id}/feedback`, body);
        expect(r.status).toBe(400);
        expect(r.json.error).toBe('Say alert: true, false or null, or less: true or false');
      }
      expect((await call('POST', '/api/messages/msg_nothing/feedback', { less: true })).status).toBeGreaterThanOrEqual(400);

      const policy = await call('GET', '/api/triage/policy');
      expect(policy.json).toMatchObject({ votes: 3, thresholds: { alert: 0.5, important: 0.6 }, bars: { direct: 0.05, other: 0.2 } });
      expect(policy.json.preview.map((p: { level: number }) => p.level)).toEqual(LIST_LEVELS);

      // The list's level: a number strictly between 0 and 1.
      const set = await call('PUT', '/api/triage/level', { level: 0.3 });
      expect(set.status).toBe(200);
      expect(set.json.thresholds).toEqual({ alert: 0.5, important: 0.3 });
      expect(w.store.listLevel()).toBe(0.3);
      for (const level of [0, 1, -0.2, 1.5, '0.5', null]) expect((await call('PUT', '/api/triage/level', { level })).status).toBe(400);
      expect(w.store.listLevel()).toBe(0.3);

      const shadow = await call('GET', '/api/triage/shadow');
      expect(shadow.status).toBe(200);
      expect(Object.keys(shadow.json).sort()).toEqual(['both', 'days', 'decided', 'live', 'shadow', 'since']);
      expect(shadow.json).toMatchObject({ days: 7, live: expect.any(Number), shadow: expect.any(Number), both: expect.any(Number) });

      // Rules: Always alert, List only, Mute, or none. The levels from before the tiers are refused.
      const target = w.conv('news');
      for (const level of ['smart', 'mentions', 'loud']) expect((await call('PUT', '/api/rules', { scope: 'conversation', target, level })).status).toBe(400);
      expect(w.store.rules()).toEqual([]);
      for (const level of ['all', 'digest', 'none']) {
        expect((await call('PUT', '/api/rules', { scope: 'conversation', target, level })).status).toBe(200);
        expect(w.store.rules().map((r) => [r.scope, r.target, r.level])).toEqual([['conversation', target, level]]);
      }
      expect((await call('PUT', '/api/rules', { scope: 'conversation', target, level: null })).status).toBe(200);
      expect(w.store.rules()).toEqual([]);
      // A person set to always alert and a keyword are rules too.
      expect((await call('PUT', '/api/rules', { scope: 'keyword', target: 'deploy', level: 'all' })).status).toBe(200);
      expect((await call('PUT', '/api/rules', { scope: 'keyword', target: 'deploy', level: null })).status).toBe(200);

      // The daily digest is gone, with its route.
      expect((await call('GET', '/api/daily-digest')).status).toBe(404);
      expect((await call('PUT', '/api/daily-digest', { enabled: true, time: '18:00', timezone: 'UTC' })).status).toBe(404);
      expect((await call('GET', '/api/bootstrap')).json).not.toHaveProperty('dailyDigest');
    } finally {
      hub.stop();
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
