/**
 * The inbox's attention score (attention.ts, docs/inbox.md): the formula's parts, keeping features up to date one
 * message at a time, in batches, and after older messages turn up, and what the tiers do to a row: an alert pins it,
 * a Conversation lifts it, the list gives it its importance, until you have seen it.
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type * as P from '@dither-chat/protocol';
import { ActivityStore } from '../src/activity.ts';
import {
  ALERT_PIN,
  Attention,
  emptyTally,
  foldMessage,
  freshState,
  medianLatency,
  owedCurve,
  record,
  scoreConversation,
  WEIGHTS,
  type ConvState,
  type FoldMessage,
  type ScoreInput,
  type Tally,
} from '../src/attention.ts';
import { Store, type AccountRow } from '../src/store.ts';
import { Triage } from '../src/triage.ts';
import { UsageStore } from '../src/usage.ts';

const MIN = 60_000;
const HOUR = 60 * MIN;
const DAY = 24 * HOUR;
const T0 = Date.UTC(2026, 9, 1, 9);

// ------------------------------------------------------------------ the formula

describe('an unanswered message', () => {
  test('counts in full from the moment it arrives, through the first day, then fades over a few days', () => {
    const at = (h: number) => owedCurve(h * HOUR);
    expect(at(0)).toBe(1);
    expect(at(0.1)).toBe(1);
    expect(at(24)).toBe(1);
    // Halves every two days after the first.
    expect(at(72)).toBeCloseTo(at(24) / 2, 2);
    expect(at(24 * 7)).toBeCloseTo(0.125, 2);
    expect(at(24 * 12)).toBeLessThan(0.05);
  });

  test('reading a message you will answer leaves it where it was; reading one you would not lets it go', () => {
    const now = T0 + 40 * DAY;
    const unread = (x: ScoreInput, n: number): ScoreInput => ({ ...x, unread: n, pinged: n ? 'Direct message' : null });
    const often = owedDm(0.05, now, habit(9, 10, 30 * MIN, now));
    expect(scoreConversation(often).score).toBeCloseTo(scoreConversation(unread(often, 1)).score, 0);
    expect(scoreConversation(often).needs).toBe(true);
    const seldom = owedDm(0.05, now, habit(0, 10, 0, now));
    expect(scoreConversation(seldom).score).toBeLessThan(scoreConversation(unread(seldom, 1)).score - 15);
    // Not counted twice while it is unread either.
    expect(scoreConversation(unread(often, 1)).parts.overlap).toBeLessThan(0);
  });
});

describe('a conversation going on', () => {
  const now = T0 + 40 * DAY;
  /** Sam wrote, you answered `mineAgo` ago; Sam's message came `gap` before yours. */
  function answered(mineAgo: number, gap = 2 * MIN): ScoreInput {
    const s = freshState();
    const tally = () => emptyTally();
    foldMessage(s, tally, msg({ ts: now - mineAgo - gap, author: 'sam', authorKey: 'p_sam' }), { shape: 'direct', members: 2 });
    foldMessage(s, tally, msg({ ts: now - mineAgo, mine: true, author: 'me', authorKey: 'me' }), { shape: 'direct', members: 2 });
    return { now, shape: 'direct', members: 2, lastMessageAt: now - mineAgo, state: s, author: null, authorName: 'Sam', unread: 0, mentions: 0, pinged: null, muted: null, usage: null };
  }

  test('the chat you just answered stays above the line for a while, then lets go', () => {
    const just = scoreConversation(answered(MIN));
    expect(just.needs).toBe(true);
    expect(just.reasons[0]).toBe("You're in a conversation here: you wrote a minute ago");
    expect(scoreConversation(answered(30 * MIN)).parts.live).toBeCloseTo(WEIGHTS.live / 2, 0);
    expect(scoreConversation(answered(3 * HOUR)).needs).toBe(false);
  });

  test('a message of yours into silence is not a conversation', () => {
    expect(scoreConversation(answered(MIN, 3 * DAY)).parts.live).toBeUndefined();
  });

  test('counts once with an answer they are owed', () => {
    const x = answered(10 * MIN);
    foldMessage(x.state, () => emptyTally(), msg({ ts: now - MIN, author: 'sam', authorKey: 'p_sam' }), { shape: 'direct', members: 2 });
    const r = scoreConversation({ ...x, lastMessageAt: now - MIN });
    expect(r.parts.owed).toBeGreaterThan(0);
    expect(r.parts.overlap).toBeCloseTo(-Math.min(r.parts.owed, r.parts.live), 0);
  });
});

/** A DM where Sam wrote `ageH` hours ago and you have not answered. */
function owedDm(ageH: number, now: number, author: Tally | null = null): ScoreInput {
  const s = freshState();
  foldMessage(s, () => emptyTally(), msg({ ts: now - ageH * HOUR, author: 'sam', authorKey: 'p_sam' }), { shape: 'direct', members: 2 });
  return { now, shape: 'direct', members: 2, lastMessageAt: now - ageH * HOUR, state: s, author, authorName: 'Sam', unread: 0, mentions: 0, pinged: null, muted: null, usage: null };
}

function msg(m: Partial<FoldMessage> & { ts: number }): FoldMessage {
  return { id: `m${m.ts}`, author: 'x', authorKey: 'x', mine: false, bot: false, mentionsMe: false, repliesToMe: false, question: false, pushed: false, ignore: false, ...m };
}

/** Your answers to someone: `answered` of `of` turns, each after `latency`. */
function habit(answered: number, of: number, latency: number, now: number): Tally {
  const t = emptyTally();
  for (let i = 0; i < of; i++) record(t, now - (i + 1) * DAY, i < answered ? latency : null);
  return t;
}

describe('owed reply', () => {
  const now = T0 + 40 * DAY;

  test('weighs by how often you answer that person', () => {
    const often = scoreConversation(owedDm(5, now, habit(9, 10, 30 * MIN, now)));
    const seldom = scoreConversation(owedDm(5, now, habit(1, 10, 30 * MIN, now)));
    const unknown = scoreConversation(owedDm(5, now));
    expect(often.parts.owed).toBeGreaterThan(unknown.parts.owed);
    expect(unknown.parts.owed).toBeGreaterThan(seldom.parts.owed);
    expect(often.parts.owed).toBeGreaterThan(3 * seldom.parts.owed);
    expect(often.needs).toBe(true);
    expect(seldom.needs).toBe(false);
  });

  test('says why in your terms', () => {
    const r = scoreConversation(owedDm(5, now, habit(9, 10, 40 * MIN, now)));
    expect(r.reasons[0]).toBe('You usually reply to Sam within an hour; unanswered for 5 hours');
    expect(r.owedSince).toBe(now - 5 * HOUR);
    expect(medianLatency(habit(9, 10, 40 * MIN, now))).toBe(HOUR);
    expect(scoreConversation(owedDm(3, now)).reasons[0]).toBe('Sam wrote to you 3 hours ago; not answered yet');
  });

  test('a week-old one no longer needs you', () => {
    const fresh = scoreConversation(owedDm(6, now, habit(9, 10, 30 * MIN, now)));
    const old = scoreConversation(owedDm(24 * 8, now, habit(9, 10, 30 * MIN, now)));
    expect(old.parts.owed).toBeLessThan(fresh.parts.owed / 5);
    expect(old.needs).toBe(false);
  });
});

describe('noise', () => {
  const now = T0 + 60 * DAY;
  /** A group with `perDay` messages from others and `mine` from you, every day for two months. */
  function busy(perDay: number, mine: number): ScoreInput {
    const s = freshState();
    for (let d = 60; d >= 1; d--) {
      for (let i = 0; i < perDay; i++) foldMessage(s, () => emptyTally(), msg({ ts: now - d * DAY + i * MIN }), { shape: 'group', members: 30 });
      for (let i = 0; i < mine; i++) foldMessage(s, () => emptyTally(), msg({ ts: now - d * DAY + HOUR + i * MIN, mine: true }), { shape: 'group', members: 30 });
    }
    return { now, shape: 'group', members: 30, lastMessageAt: now - DAY + HOUR, state: s, author: null, authorName: null, unread: 0, mentions: 0, pinged: null, muted: null, usage: null };
  }

  test('high volume and no engagement sinks; rare but engaged rises', () => {
    const loud = scoreConversation(busy(200, 0));
    const quiet = scoreConversation(busy(1, 1));
    // Two months of a 30-day half-life is not yet steady state, so a little under 200.
    expect(loud.noise.receivedPerDay).toBeGreaterThan(120);
    expect(loud.noise.fit).toBeLessThan(-0.6);
    expect(loud.parts.noise).toBeLessThan(-10);
    expect(quiet.noise.fit).toBeGreaterThan(0);
    expect(quiet.parts.noise).toBeGreaterThan(0);
    expect(quiet.score).toBeGreaterThan(loud.score);
    expect(loud.reasons.some((r) => r.startsWith('Busy'))).toBe(true);
  });

  test('the same volume you take part in is not noise', () => {
    expect(scoreConversation(busy(200, 60)).noise.fit).toBeGreaterThan(scoreConversation(busy(200, 0)).noise.fit + 0.4);
  });

  test('an unread busy group you never read stays below the line; a mention lifts it', () => {
    const x = busy(200, 0);
    expect(scoreConversation({ ...x, unread: 50 }).needs).toBe(false);
    expect(scoreConversation({ ...x, unread: 50, mentions: 2 }).needs).toBe(true);
  });
});

describe('muted places', () => {
  test('sit below everything else, whatever is in them', () => {
    const now = T0 + 40 * DAY;
    const loud = { ...owedDm(5, now, habit(10, 10, 5 * MIN, now)), unread: 3, pinged: 'Mentions you' };
    const muted = scoreConversation({ ...loud, muted: 'muted in Discord' });
    const idle = scoreConversation({ ...owedDm(1, now), state: freshState(), lastMessageAt: now - 30 * DAY });
    expect(muted.needs).toBe(false);
    expect(muted.score).toBeLessThan(idle.score);
    expect(muted.score).toBeLessThan(WEIGHTS.mutedFloor + WEIGHTS.recency + 0.01);
    expect(muted.reasons[0]).toBe('Muted: muted in Discord');
  });
});

describe('where you were', () => {
  const now = T0 + 40 * DAY;
  const base = { now, shape: 'group' as const, members: 12, lastMessageAt: now - 2 * DAY, state: freshState(), author: null, authorName: null, unread: 0, mentions: 0, pinged: null, muted: null };
  const was = (ago: number, lastVisit = now - ago - 10 * MIN) => scoreConversation({ ...base, usage: { score: 600, visitScore: 1, at: now - ago, lastVisit } });

  test('the chat you just left stays near the top, and lets go over a few hours', () => {
    const none = scoreConversation({ ...base, usage: null });
    expect(was(MIN).score - none.score).toBeGreaterThan(WEIGHTS.visited - 1);
    expect(was(MIN).reasons[0]).toBe('You were here a minute ago');
    expect(was(2 * HOUR).parts.visited).toBeCloseTo(WEIGHTS.visited / 2, 0);
    expect(was(12 * HOUR).parts.visited).toBeLessThan(1);
  });

  test('counts from when you left, not when you arrived', () => {
    expect(was(MIN, now - 3 * HOUR).parts.visited).toBeCloseTo(was(MIN).parts.visited!, 1);
  });

  test('moves the row, not whether it needs you', () => {
    expect(was(MIN).score).toBeGreaterThan(WEIGHTS.needs);
    expect(was(MIN).needs).toBe(false);
  });

  test('a place you only passed through counts nothing', () => {
    expect(scoreConversation({ ...base, usage: { score: 2, visitScore: 0, at: now - MIN, lastVisit: null } }).parts.visited).toBeUndefined();
  });
});

describe('unread', () => {
  test('a DM message counts more than a group message; mentions count like DMs', () => {
    const now = T0;
    const base = { now, members: 0, lastMessageAt: now - HOUR, state: freshState(), author: null, authorName: null, mentions: 0, pinged: null, muted: null, usage: null };
    const dm = scoreConversation({ ...base, shape: 'direct', unread: 2 });
    const group = scoreConversation({ ...base, shape: 'group', unread: 2 });
    const mentioned = scoreConversation({ ...base, shape: 'group', unread: 2, mentions: 2 });
    expect(dm.parts.unread).toBeGreaterThan(group.parts.unread);
    expect(mentioned.parts.unread).toBe(dm.parts.unread);
    expect(dm.needs).toBe(true);
    expect(dm.reasons).toContain('2 unread messages');
  });
});

// ------------------------------------------------------------------ the fold

describe('turns', () => {
  const fold = (s: ConvState, authors: Map<string, Tally>, m: Partial<FoldMessage> & { ts: number }, shape: P.Shape = 'direct', members = 2) =>
    foldMessage(s, (k) => authors.get(k) ?? authors.set(k, emptyTally()).get(k)!, msg(m), { shape, members });

  test('your answer settles what you owed, with how long it took', () => {
    const s = freshState();
    const a = new Map<string, Tally>();
    fold(s, a, { ts: T0, authorKey: 'sam' });
    fold(s, a, { ts: T0 + MIN, authorKey: 'sam' });
    expect(s.turn?.addressed).toBe(T0);
    fold(s, a, { ts: T0 + 20 * MIN, mine: true });
    expect(s.turn).toBeNull();
    expect(s.tally.addressed).toBeCloseTo(1);
    expect(s.tally.replied).toBeCloseTo(1);
    expect(medianLatency({ ...s.tally, latency: s.tally.latency.map((x) => x * 2) })).toBe(30 * MIN);
    expect(a.get('sam')!.replied).toBeCloseTo(1);
  });

  test('an answer after the window counts as unanswered; a new message after it starts the clock again', () => {
    const s = freshState();
    const a = new Map<string, Tally>();
    fold(s, a, { ts: T0, authorKey: 'sam' });
    fold(s, a, { ts: T0 + 4 * DAY, authorKey: 'sam' });
    expect(s.turn?.addressed).toBe(T0 + 4 * DAY);
    expect(s.tally.addressed).toBeCloseTo(1, 1);
    expect(s.tally.replied).toBe(0);
    fold(s, a, { ts: T0 + 8 * DAY, mine: true });
    expect(s.tally.replied).toBe(0);
  });

  test('in a group, only what is addressed to you: a mention, a reply, a quick answer in a small group', () => {
    const big = (m: Partial<FoldMessage> & { ts: number }) => {
      const s = freshState();
      fold(s, new Map(), { ts: m.ts - 10 * MIN, mine: true }, 'group', 40);
      fold(s, new Map(), m, 'group', 40);
      return s.turn?.kind ?? null;
    };
    expect(big({ ts: T0 })).toBeNull();
    expect(big({ ts: T0, mentionsMe: true })).toBe('mention');
    expect(big({ ts: T0, repliesToMe: true })).toBe('reply');
    const small = freshState();
    fold(small, new Map(), { ts: T0, mine: true }, 'group', 4);
    fold(small, new Map(), { ts: T0 + 10 * MIN }, 'group', 4);
    expect(small.turn?.kind).toBe('answer');
    const late = freshState();
    fold(late, new Map(), { ts: T0, mine: true }, 'group', 4);
    fold(late, new Map(), { ts: T0 + 3 * HOUR }, 'group', 4);
    expect(late.turn?.addressed).toBeNull();
    fold(late, new Map(), { ts: T0 + 4 * HOUR, question: true }, 'group', 4);
    expect(late.turn?.kind).toBe('question');
  });

  test('a reaction of yours answers what was owed up to the message, and counts toward how often, not how fast', () => {
    const s = freshState();
    const a = new Map<string, Tally>();
    fold(s, a, { ts: T0, authorKey: 'sam' });
    fold(s, a, { ts: T0 + MIN, authorKey: 'sam', reactedByMe: true });
    expect(s.turn).toBeNull();
    expect(s.tally.replied).toBeCloseTo(1);
    expect(s.tally.latency.reduce((x, y) => x + y, 0)).toBe(0);
    expect(a.get('sam')!.replied).toBeCloseTo(1);
    // What they write after it is owed afresh.
    fold(s, a, { ts: T0 + 2 * MIN, authorKey: 'sam' });
    expect(s.turn?.addressed).toBe(T0 + 2 * MIN);
    // In a group, reacting to chatter after a mention answers the mention.
    const g = freshState();
    fold(g, new Map(), { ts: T0, mentionsMe: true }, 'group', 40);
    fold(g, new Map(), { ts: T0 + MIN, reactedByMe: true }, 'group', 40);
    expect(g.turn).toBeNull();
  });

  test('bots, system lines and deleted messages owe you nothing', () => {
    const s = freshState();
    fold(s, new Map(), { ts: T0, bot: true });
    fold(s, new Map(), { ts: T0 + 1, ignore: true });
    expect(s.turn?.addressed ?? null).toBeNull();
    expect(s.totalReceived).toBe(1);
  });
});

// ------------------------------------------------------------------ kept up to date

describe('incremental features in the hub', () => {
  let dir: string;
  let store: Store;
  let att: Attention;
  let acc: AccountRow;
  let clock = T0;
  let n = 0;
  const say = (conversation: string, author: string, ts: number, x: Partial<P.MessageFact> = {}) => {
    const nativeId = `m${++n}`;
    store.ingest(acc, { t: 'message', message: { nativeId, conversation, author, ts, body: '', ...x }, live: true });
    return nativeId;
  };
  const cid = (native: string) => store.one<{ id: string }>('SELECT id FROM conversation WHERE native_id = ?', native)!.id;
  const state = (native: string) => JSON.parse(store.one<{ state: string }>('SELECT state FROM conv_feature WHERE conversation_id = ?', cid(native))!.state) as ConvState;
  /** The store's changes, then syncs until nothing waits (a sync scores for 20 ms at most), as one event. */
  const flush = (): P.ClientEvent[] => {
    const evs = store.flush();
    const out = att.sync(evs.flatMap((e) => (e.t === 'conversation' ? [e.conversation.id] : [])));
    while (att.busy) out.push(...att.sync([]));
    const items = out.flatMap((e) => (e.t === 'attention' ? e.items : []));
    const removed = out.flatMap((e) => (e.t === 'attention' ? e.removed : []));
    return items.length || removed.length ? [{ t: 'attention', items, removed }] : [];
  };
  /** The same conversation's features folded from nothing, in one go. */
  function fromScratch(native: string): ConvState {
    store.db.query('DELETE FROM conv_feature WHERE conversation_id = ?').run(cid(native));
    store.db.query('DELETE FROM conv_author_feature WHERE conversation_id = ?').run(cid(native));
    att.fold(cid(native), 100_000);
    return state(native);
  }

  beforeAll(() => {
    dir = mkdtempSync(join(tmpdir(), 'dither-attention-'));
    store = new Store(join(dir, 'hub.sqlite'), (raw) => raw ?? null);
    acc = store.createAccount({ network: 'matrix', label: 'a', color: '#000', adapter: 'matrix' });
    store.ingest(acc, { t: 'status', status: 'online', self: { nativeId: 'me', displayName: 'Me' } });
    acc = store.account(acc.id)!;
    for (const who of ['sam', 'kim', 'lee']) store.ingest(acc, { t: 'identity', identity: { nativeId: who, displayName: who[0].toUpperCase() + who.slice(1), contact: true } });
    store.ingest(acc, { t: 'conversation', conversation: { nativeId: 'dm', shape: 'direct', participants: ['me', 'sam'] } });
    store.ingest(acc, { t: 'conversation', conversation: { nativeId: 'trio', shape: 'group', name: 'Trio', participants: ['me', 'kim', 'lee'] } });
    store.ingest(acc, { t: 'conversation', conversation: { nativeId: 'chan', shape: 'channel', name: 'general', spaces: [{ nativeId: 'srv' }] } });
    att = new Attention(store, new Triage(store), () => clock);
    att.rescoreAll(T0);
    store.flush();
  });
  afterAll(() => {
    store.db.close();
    rmSync(dir, { recursive: true, force: true });
  });

  test('a new message is folded and scored at the next flush', () => {
    clock = T0 + HOUR;
    say('dm', 'sam', T0);
    const evs = flush();
    const item = (evs[0] as Extract<P.ClientEvent, { t: 'attention' }>).items.find((i) => i.id === cid('dm'))!;
    expect(item.owedSince).toBe(T0);
    expect(item.needs).toBe(true);
    expect(state('dm').totalReceived).toBe(1);
  });

  test('message by message gives the same features as folding everything at once', () => {
    for (let i = 0; i < 30; i++) {
      say('trio', i % 3 === 0 ? 'me' : i % 3 === 1 ? 'kim' : 'lee', T0 + 2 * HOUR + i * 7 * MIN, { mentionsSelf: i % 5 === 0 });
      if (i % 4 === 0) flush();
      clock += MIN;
    }
    flush();
    const live = state('trio');
    expect(live.totalReceived + live.totalSent).toBe(30);
    expect(fromScratch('trio')).toEqual(live);
  });

  test('in batches of any size, the same again; and re-sending the same messages changes nothing', () => {
    const whole = state('trio');
    store.db.query('DELETE FROM conv_feature').run();
    store.db.query('DELETE FROM conv_author_feature').run();
    while (att.pump(7) > 0);
    expect(state('trio')).toEqual(whole);
    const authors = store.raw('SELECT * FROM conv_author_feature ORDER BY conversation_id, author_key');
    // The ingest is idempotent, so is the fold: the same message again is not new.
    n -= 3;
    say('trio', 'kim', T0 + 2 * HOUR + 28 * 7 * MIN);
    flush();
    expect(state('trio')).toEqual(whole);
    expect(store.raw('SELECT * FROM conv_author_feature ORDER BY conversation_id, author_key')).toEqual(authors);
    n += 2;
  });

  test('an older message (backfill, imported history) makes it fold again from the start, once quiet', () => {
    const before = state('trio');
    clock += MIN;
    say('trio', 'me', T0 + 2 * HOUR + 3 * MIN);
    flush();
    expect(store.one<{ stale_at: number }>('SELECT stale_at FROM conv_feature WHERE conversation_id = ?', cid('trio'))!.stale_at).toBe(clock);
    // Still arriving: nothing starts over yet, and appends wait too.
    att.pump();
    expect(state('trio')).toEqual(before);
    clock += 10_000;
    while (att.pump() > 0);
    const after = state('trio');
    expect(after.totalSent).toBe(before.totalSent + 1);
    expect(fromScratch('trio')).toEqual(after);
  });

  test('triage deciding after the fold still counts: a push, and a question in a small group', () => {
    clock = T0 + 2 * DAY;
    say('trio', 'me', clock - 10 * HOUR);
    const q = say('trio', 'kim', clock - 5 * HOUR);
    flush();
    expect(state('trio').turn?.addressed ?? null).toBeNull();
    const id = store.one<{ id: string }>('SELECT id FROM message WHERE native_id = ?', q)!.id;
    const d = { decision: 'push' as const, score: 0.7, reasons: ['Smart: asks a question, small group (3)'], decidedBy: 'rules' as const };
    store.setTriage(id, d);
    att.triaged(id, d);
    const s = state('trio');
    expect(s.turn?.kind).toBe('question');
    expect(s.lastPush?.id).toBe(id);
    // Folding again from the start reads the stored decision and agrees.
    expect(fromScratch('trio')).toEqual(s);
  });

  test('a server channel is listed only while it has something for you', () => {
    clock += HOUR;
    say('chan', 'lee', clock - MIN);
    let evs = flush();
    expect(att.list().some((v) => v.id === cid('chan'))).toBe(false);
    say('chan', 'lee', clock, { mentionsSelf: true });
    evs = flush();
    expect(att.list().find((v) => v.id === cid('chan'))?.reasons).toContain('1 unread mention, 1 more unread');
    store.markRead(cid('chan'), clock);
    evs = flush();
    expect((evs[0] as Extract<P.ClientEvent, { t: 'attention' }>).removed).toContain(cid('chan'));
  });

  test('@everyone notifies like a mention but owes no answer', () => {
    clock += HOUR;
    store.ingest(acc, { t: 'conversation', conversation: { nativeId: 'news', shape: 'channel', name: 'announcements', spaces: [{ nativeId: 'srv' }] } });
    say('news', 'lee', clock, { mentionsSelf: true, mentionsAll: true });
    flush();
    expect(state('news').turn?.addressed ?? null).toBeNull();
    expect(store.one<{ mentions: number }>('SELECT mentions FROM vantage WHERE target_id = ?', cid('news'))!.mentions).toBe(1);
    // Read, it is gone from the inbox: nothing was owed.
    store.markRead(cid('news'), clock);
    flush();
    expect(att.list().some((v) => v.id === cid('news'))).toBe(false);
  });

  test('where you have just been is scored again at once: a group by itself, a DM through its person', () => {
    clock += HOUR;
    const usage = new UsageStore(store.db);
    const before = att.view(cid('trio'))!.score;
    usage.apply('b1', [{ kind: 'conversation', id: cid('trio'), seconds: 40, visits: 1, at: clock, lastVisit: clock - 30_000 }], clock);
    const evs = att.visited([{ kind: 'conversation', id: cid('trio') }]);
    const item = (evs[0] as Extract<P.ClientEvent, { t: 'attention' }>).items.find((i) => i.id === cid('trio'))!;
    expect(item.score).toBeGreaterThan(before + WEIGHTS.visited - 2);
    expect(item.reasons).toContain('You were here a moment ago');
    const sam = store.one<{ person_id: string | null }>(`SELECT person_id FROM identity WHERE native_id = 'sam'`)!.person_id;
    expect(sam).toBeTruthy();
    usage.apply('b2', [{ kind: 'person', id: sam!, seconds: 40, visits: 1, at: clock, lastVisit: clock }], clock);
    const dm = (att.visited([{ kind: 'person', id: sam! }])[0] as Extract<P.ClientEvent, { t: 'attention' }>).items.map((i) => i.id);
    expect(dm).toEqual([cid('dm')]);
  });

  test('out of time, a pump still folds one and a sync still scores one: nothing waits for good', () => {
    clock += HOUR;
    // Every look at this clock is a second later: each budget is spent before its first step.
    let ms = 0;
    const real = att.budgetClock;
    att.budgetClock = () => (ms += 1000);
    try {
      say('dm', 'sam', clock - MIN);
      say('trio', 'kim', clock - MIN);
      store.flush();
      expect(att.pump()).toBe(1);
      expect(att.pump()).toBe(1);
      expect(att.pump()).toBe(0);
      expect(att.busy).toBe(true);
      const first = att.sync([]);
      expect(first).toHaveLength(1);
      expect(att.busy).toBe(true);
      att.sync([]);
      expect(att.busy).toBe(false);
      expect([state('dm').lastReceived, state('trio').lastReceived]).toEqual([clock - MIN, clock - MIN]);
    } finally {
      att.budgetClock = real;
    }
  });

  test('reacting to what they wrote answers it: the conversation folds again, and owes nothing', () => {
    clock += HOUR;
    say('dm', 'me', clock - 2 * MIN);
    const m = say('dm', 'sam', clock - MIN);
    flush();
    const owed = clock - MIN;
    expect(state('dm').turn?.addressed).toBe(owed);
    store.ingest(acc, { t: 'reaction', conversation: 'dm', message: m, author: 'me', key: '👍' });
    flush();
    clock += 10_000;
    while (att.pump() > 0);
    flush();
    expect(state('dm').turn).toBeNull();
    expect(att.list().find((v) => v.id === cid('dm'))?.owedSince ?? null).toBeNull();
    // Taking the reaction back owes it again.
    store.ingest(acc, { t: 'reaction', conversation: 'dm', message: m, author: 'me', key: '👍', remove: true });
    flush();
    clock += 10_000;
    while (att.pump() > 0);
    expect(state('dm').turn?.addressed).toBe(owed);
  });

  test('keeps the turns it closed, fits the owed table on them, and explains the weight', () => {
    const turns = store.db.query('SELECT shape, answered_at, timed FROM owed_turn WHERE conversation_id = ?').all(cid('dm')) as { shape: string; answered_at: number | null; timed: number }[];
    expect(turns.length).toBeGreaterThan(0);
    expect(turns.every((t) => t.shape === 'direct')).toBe(true);
    // Folding again from the start keeps the same turns, once each.
    const before = store.one<{ n: number }>('SELECT COUNT(*) AS n FROM owed_turn')!.n;
    fromScratch('dm');
    expect(store.one<{ n: number }>('SELECT COUNT(*) AS n FROM owed_turn')!.n).toBe(before);
    // Too few turns to fit: the default's rows, but fitted now and kept for the next start.
    const t = att.fitOwed(clock);
    expect(t.fittedAt).toBe(clock);
    expect(t.chance.direct).toEqual(att.owedTable.chance.direct);
    expect(new Attention(store, new Triage(store), () => clock).owedTable.fittedAt).toBe(clock);
    const e = att.explain(cid('dm')) as any;
    expect(e.owed.chance).toBeGreaterThan(0);
    expect(e.owed.points).toBeCloseTo(WEIGHTS.owed * e.owed.chance, 0);
    expect(typeof e.owed.before).toBe('number');
  });
});

// ------------------------------------------------------------------ the tiers

describe('the tiers in the formula', () => {
  const now = T0 + 40 * DAY;
  /** A group with two unread messages, neither to you. */
  const base: ScoreInput = { now, shape: 'group', members: 12, lastMessageAt: now - HOUR, state: freshState(), author: null, authorName: null, unread: 2, mentions: 0, pinged: null, muted: null, usage: null };
  const plain = scoreConversation(base);

  test('an unread Conversation message lifts the row, and says why it is one', () => {
    const s = scoreConversation({ ...base, pinged: 'You wrote here in the last day' });
    expect(WEIGHTS.pinged).toBe(15);
    expect(s.parts.pinged).toBe(WEIGHTS.pinged);
    expect(s.score).toBeCloseTo(plain.score + WEIGHTS.pinged, 1);
    expect(s.reasons).toContain('You wrote here in the last day');
    expect(s.reasons.some((r) => r.startsWith('Alerted you'))).toBe(false);
  });

  test('an unread alert lifts it further, and says it alerted you; a long reason is cut', () => {
    const why = "Reads as urgent: the local model's answer is 0.3 against a bar of 0.05";
    expect(why.length).toBeLessThanOrEqual(70);
    const s = scoreConversation({ ...base, pinged: why, alerted: true });
    expect(WEIGHTS.alerted).toBe(40);
    expect(s.parts.pinged).toBe(WEIGHTS.pinged + WEIGHTS.alerted);
    expect(s.score).toBeCloseTo(plain.score + 55, 1);
    expect(s.reasons[0]).toBe(`Alerted you: ${why}`);
    expect(scoreConversation({ ...base, pinged: 'Matches keyword “deploy”', alerted: true }).reasons[0]).toBe('Alerted you: Matches keyword “deploy”');
    // Over seventy characters it is cut.
    const long = "Reads as urgent: the local model's answer is 0.125 against a bar of 0.05";
    expect(long.length).toBeGreaterThan(70);
    expect(scoreConversation({ ...base, pinged: long, alerted: true }).reasons[0]).toBe(`Alerted you: ${long.slice(0, 69)}…`);
    // Alerted without anything unread to say why: nothing to lift.
    expect(scoreConversation({ ...base, pinged: null, alerted: true }).parts.pinged).toBeUndefined();
    expect(ALERT_PIN).toBe(1000);
  });

  test('importance counts by how much: a list row says so, an alert or a Conversation says its own reason', () => {
    expect(WEIGHTS.importance).toBe(25);
    const listed = scoreConversation({ ...base, importance: 0.8 });
    expect(listed.parts.importance).toBe(20);
    expect(listed.score).toBeCloseTo(plain.score + 20, 1);
    expect(listed.reasons).toContain('On your list: importance 80%');
    expect(scoreConversation({ ...base, importance: 0.2 }).parts.importance).toBe(5);
    const conv = scoreConversation({ ...base, pinged: 'A direct message', importance: 0.8 });
    expect(conv.parts).toMatchObject({ pinged: 15, importance: 20 });
    expect(conv.reasons).toContain('A direct message');
    expect(conv.reasons.some((r) => r.startsWith('On your list'))).toBe(false);
    // None kept (decided by a rule alone), or none at all: no part.
    expect(scoreConversation({ ...base, importance: null }).parts.importance).toBeUndefined();
    expect(scoreConversation({ ...base, importance: 0 }).parts.importance).toBeUndefined();
    expect(plain.parts.importance).toBeUndefined();
  });

  test('a muted place takes none of it', () => {
    const s = scoreConversation({ ...base, muted: 'this conversation', pinged: 'About you', alerted: true, importance: 0.9 });
    expect(s.parts.pinged).toBeUndefined();
    expect(s.parts.importance).toBeUndefined();
    expect(s.score).toBeLessThan(plain.score);
  });
});

describe('the tiers in the inbox', () => {
  let store: Store;
  let att: Attention;
  let activity: ActivityStore;
  let acc: AccountRow;
  let clock = T0;
  let n = 0;
  const cid = (native: string) => store.one<{ id: string }>('SELECT id FROM conversation WHERE native_id = ?', native)!.id;
  const flush = () => {
    const evs = store.flush();
    att.sync(evs.flatMap((e) => (e.t === 'conversation' ? [e.conversation.id] : [])));
    while (att.busy) att.sync([]);
  };
  /** A message from someone else an hour on, decided as triage would have, then folded and scored. Returns its id. */
  const arrive = (conversation: string, author: string, d: { decision: P.TriageDecision; score: number | null; reasons: string[] }) => {
    clock += HOUR;
    const nativeId = `t${++n}`;
    store.ingest(acc, { t: 'message', message: { nativeId, conversation, author, ts: clock, body: 'hello' }, live: true });
    flush();
    const id = store.one<{ id: string }>('SELECT id FROM message WHERE native_id = ?', nativeId)!.id;
    const dec = { ...d, decidedBy: 'rules' as const };
    store.setTriage(id, dec);
    att.triaged(id, dec);
    flush();
    return id;
  };
  /** Its notification, swiped away on the phone a minute after it came. */
  const swipe = (conversation: string, messageId: string, at = clock + MIN) => {
    const nid = activity.notification({ kind: 'message', messageId, conversationId: cid(conversation) }, clock)!;
    expect(activity.events([{ id: nid, device: 'phone', event: 'dismissed', at }], at)).toBe(1);
    // The inbox scores everything again every few minutes (and at once when the chat changes).
    att.rescoreAll(at);
  };
  /** The formula's answer for a chat, part by part (what the pin is added to). */
  const explain = (conversation: string) => att.explain(cid(conversation), clock) as { score: number; parts: Record<string, number> };
  const parts = (conversation: string) => explain(conversation).parts;
  const unreadOf = (conversation: string) => store.one<{ unread: number }>('SELECT MAX(unread) AS unread FROM vantage WHERE target_id = ?', cid(conversation))!.unread;
  const URGENT = "Reads as urgent: the local model's answer is 0.3 against a bar of 0.05";

  beforeAll(() => {
    store = new Store(':memory:', (raw) => raw ?? null);
    acc = store.createAccount({ network: 'matrix', label: 'a', color: '#000', adapter: 'matrix' });
    store.ingest(acc, { t: 'status', status: 'online', self: { nativeId: 'me', displayName: 'Me' } });
    acc = store.account(acc.id)!;
    for (const who of ['sam', 'kim', 'lee']) store.ingest(acc, { t: 'identity', identity: { nativeId: who, displayName: who[0].toUpperCase() + who.slice(1), contact: true } });
    store.ingest(acc, { t: 'conversation', conversation: { nativeId: 'dm', shape: 'direct', participants: ['me', 'sam'] } });
    store.ingest(acc, { t: 'conversation', conversation: { nativeId: 'trio', shape: 'group', name: 'Trio', participants: ['me', 'kim', 'lee'] } });
    for (const c of ['chan', 'side', 'quiet']) store.ingest(acc, { t: 'conversation', conversation: { nativeId: c, shape: 'channel', name: c, spaces: [{ nativeId: 'srv' }] } });
    activity = new ActivityStore(store);
    activity.setSettings({ enabled: true, retentionDays: 365 });
    att = new Attention(store, new Triage(store), () => clock);
    att.rescoreAll(T0);
    store.flush();
  });
  afterAll(() => store.db.close());

  test('an unread alert pins its conversation above everything, with why', () => {
    arrive('trio', 'kim', { decision: 'quiet', score: 0.8, reasons: ['You wrote here in the last day'] });
    arrive('dm', 'sam', { decision: 'push', score: 0.8, reasons: [URGENT, 'A direct message'] });
    const v = att.view(cid('dm'))!;
    const x = explain('dm');
    expect(x.parts).toMatchObject({ pinged: WEIGHTS.pinged + WEIGHTS.alerted, importance: 20 });
    expect(v.score).toBeCloseTo(x.score + ALERT_PIN, 1);
    expect(v.reasons[0]).toBe(`Alerted you: ${URGENT}`);
    // Whatever else is in the inbox scores under the pin.
    const others = att.list().filter((o) => o.id !== cid('dm'));
    expect(others.length).toBeGreaterThan(0);
    expect(Math.max(...others.map((o) => o.score))).toBeLessThan(ALERT_PIN);
    expect(v.score).toBeGreaterThan(ALERT_PIN);
  });

  test('an unread Conversation message lifts its row, with its reason, and is not pinned', () => {
    const v = att.view(cid('trio'))!;
    expect(parts('trio')).toMatchObject({ pinged: WEIGHTS.pinged, importance: 20 });
    expect(v.reasons).toContain('You wrote here in the last day');
    expect(v.reasons.some((r) => r.startsWith('Alerted you'))).toBe(false);
    expect(v.score).toBeLessThan(ALERT_PIN);
  });

  test('a list message gives its importance, and lists a server channel that is otherwise not listed', () => {
    // Below the list: unread in its channel, and the channel is not in the inbox.
    arrive('quiet', 'lee', { decision: 'drop', score: 0.2, reasons: ['Below the list: importance 20%, under your level of 60%'] });
    expect(att.view(cid('quiet'))).toBeUndefined();
    expect(unreadOf('quiet')).toBe(1);
    // On the list: the channel is listed while that message is unread.
    arrive('chan', 'lee', { decision: 'digest', score: 0.8, reasons: ['On the list: importance 80%, at or over your level of 60%'] });
    const v = att.view(cid('chan'))!;
    expect(v).toBeDefined();
    expect(parts('chan').importance).toBe(20);
    expect(parts('chan').pinged).toBeUndefined();
    expect(v.reasons).toContain('On your list: importance 80%');
    expect(v.score).toBeLessThan(ALERT_PIN);
    // The more important, the higher: another channel at 30%.
    arrive('side', 'lee', { decision: 'digest', score: 0.3, reasons: ['On the list: importance 30%, at or over your level of 20%'] });
    expect(parts('side').importance).toBe(7.5);
    expect(att.view(cid('side'))!.score).toBeLessThan(att.view(cid('chan'))!.score);
    // Read, the channel leaves the inbox again.
    store.markRead(cid('side'), clock);
    flush();
    expect(att.view(cid('side'))).toBeUndefined();
  });

  test('swiped away on the phone, it is seen: the pin, the lift and the importance go, and it stays unread', () => {
    const alert = store.one<{ id: string }>(`SELECT t.message_id AS id FROM triage t JOIN message m ON m.id = t.message_id WHERE m.conversation_id = ? AND t.decision = 'push'`, cid('dm'))!.id;
    const conv = store.one<{ id: string }>(`SELECT t.message_id AS id FROM triage t JOIN message m ON m.id = t.message_id WHERE m.conversation_id = ?`, cid('trio'))!.id;
    const listed = store.one<{ id: string }>(`SELECT t.message_id AS id FROM triage t JOIN message m ON m.id = t.message_id WHERE m.conversation_id = ?`, cid('chan'))!.id;
    const before = { dm: att.view(cid('dm'))!.score, trio: att.view(cid('trio'))!.score, chan: att.view(cid('chan'))!.score };
    swipe('dm', alert);
    swipe('trio', conv);
    swipe('chan', listed);
    for (const c of ['dm', 'trio', 'chan']) {
      const p = parts(c);
      expect(p.pinged).toBeUndefined();
      expect(p.importance).toBeUndefined();
      // Still unread: no read receipt went anywhere, and the row says so.
      expect(unreadOf(c)).toBe(1);
      expect(p.unread).toBeGreaterThan(0);
      expect(att.view(cid(c))).toBeDefined();
    }
    expect(att.view(cid('dm'))!.score).toBeLessThan(ALERT_PIN);
    expect(att.view(cid('dm'))!.reasons.some((r) => r.startsWith('Alerted you'))).toBe(false);
    expect(att.view(cid('dm'))!.reasons).toContain('1 unread message');
    expect(att.view(cid('trio'))!.score).toBeLessThan(before.trio - 20);
    expect(att.view(cid('chan'))!.score).toBeLessThan(before.chan - 15);
    expect(before.dm).toBeGreaterThan(ALERT_PIN);
  });

  test('until something new arrives: the next alert there pins it again, and an older swipe does not count for it', () => {
    arrive('dm', 'sam', { decision: 'push', score: 0.9, reasons: ['Matches keyword “stove”'] });
    const v = att.view(cid('dm'))!;
    expect(v.score).toBeGreaterThan(ALERT_PIN);
    expect(v.reasons).toContain('Alerted you: Matches keyword “stove”');
    expect(parts('dm')).toMatchObject({ pinged: 55, importance: 22.5 });
    // A Conversation message after a seen alert: the lift, without the pin.
    arrive('trio', 'lee', { decision: 'quiet', score: 0.4, reasons: ['You usually answer here'] });
    expect(parts('trio')).toMatchObject({ pinged: 15, importance: 10 });
    expect(att.view(cid('trio'))!.score).toBeLessThan(ALERT_PIN);
    // Reading it anywhere takes all of it away with the unread count.
    store.markRead(cid('dm'), clock);
    flush();
    expect(att.view(cid('dm'))!.score).toBeLessThan(ALERT_PIN);
    expect(parts('dm').pinged).toBeUndefined();
    expect(parts('dm').unread).toBeUndefined();
  });

  test('a message below the list is nothing new for the row: what you swiped away stays seen until the next one in a tier', () => {
    arrive('chan', 'kim', { decision: 'drop', score: 0.1, reasons: ['Below the list: importance 10%, under your level of 60%'] });
    expect(unreadOf('chan')).toBe(2);
    expect(parts('chan').importance).toBeUndefined();
    arrive('chan', 'kim', { decision: 'digest', score: 0.7, reasons: ['On the list: importance 70%, at or over your level of 60%'] });
    expect(parts('chan').importance).toBe(17.5);
  });
});
