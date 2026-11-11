/**
 * The Conversation rule (tiers.ts, docs/notifications.md): people talking with you. A DM, a message about you, a chat
 * you wrote in during the last day, or one where you answer openings often enough; never a bot, a place kept to the
 * list, or your notes to yourself. And the tally it reads (interact.ts `answerRate`): of the times someone started
 * talking in a chat while you were away, how often you wrote back within three hours.
 */
import { describe, expect, test } from 'bun:test';
import { ENGAGED, Interactions, OPENING_ANSWER, OPENING_LULL, OPENING_PRIOR, RATE_HALF_LIFE } from '../src/interact.ts';
import { ANSWER_RATE, conversing, CONVERSING_REASON, TOOK_PART, type Part } from '../src/tiers.ts';

const MIN = 60_000;
const HOUR = 60 * MIN;
const DAY = 24 * HOUR;
const T0 = Date.UTC(2026, 10, 1, 9);

describe('the Conversation rule', () => {
  /** A message in a channel, not about you, from a person. */
  const f = (x: Partial<Parameters<typeof conversing>[0]> = {}) => ({ shape: 'channel', bot: false, mention: false, reply: false, ...x });
  /** You never wrote there and never answered anyone there. */
  const away: Part = { lastOwn: null, answerRate: 0 };

  test('the constants', () => {
    expect(TOOK_PART).toBe(24 * HOUR);
    expect(ANSWER_RATE).toBe(0.1);
  });

  test('a DM is one, whoever wrote when', () => {
    expect(conversing(f({ shape: 'direct' }), away, T0)).toBe('dm');
    expect(CONVERSING_REASON.dm).toBe('A direct message');
  });

  test('a message about you is one: it mentions you by name or replies to yours', () => {
    expect(conversing(f({ mention: true }), away, T0)).toBe('about');
    expect(conversing(f({ reply: true }), away, T0)).toBe('about');
    expect(conversing(f({ shape: 'group', mention: true, reply: true }), away, T0)).toBe('about');
    expect(CONVERSING_REASON.about).toBe('About you');
    // Nothing about you, in a place you never wrote: not one.
    expect(conversing(f(), away, T0)).toBeNull();
    expect(conversing(f({ shape: 'group' }), away, T0)).toBeNull();
    expect(conversing(f({ shape: 'thread' }), away, T0)).toBeNull();
  });

  test('a chat you wrote in during the last day is one, to the minute', () => {
    const wrote = (ago: number): Part => ({ lastOwn: T0 - ago, answerRate: 0 });
    expect(conversing(f(), wrote(MIN), T0)).toBe('wrote');
    expect(conversing(f(), wrote(0), T0)).toBe('wrote');
    expect(conversing(f(), wrote(TOOK_PART), T0)).toBe('wrote');
    expect(conversing(f(), wrote(TOOK_PART + 1), T0)).toBeNull();
    expect(conversing(f(), wrote(3 * DAY), T0)).toBeNull();
    // What you wrote after the message (history that came late) says nothing of then.
    expect(conversing(f(), { lastOwn: T0 + MIN, answerRate: 0 }, T0)).toBeNull();
    expect(CONVERSING_REASON.wrote).toBe('You wrote here in the last day');
  });

  test('a chat where you answer one opening in ten or more is one', () => {
    const rate = (answerRate: number): Part => ({ lastOwn: null, answerRate });
    expect(conversing(f(), rate(ANSWER_RATE), T0)).toBe('answers');
    expect(conversing(f(), rate(0.6), T0)).toBe('answers');
    expect(conversing(f(), rate(0.0999), T0)).toBeNull();
    // Long since you wrote there, and still one.
    expect(conversing(f(), { lastOwn: T0 - 40 * DAY, answerRate: 0.3 }, T0)).toBe('answers');
    expect(CONVERSING_REASON.answers).toBe('You usually answer here');
  });

  test('the first reason that holds is the one given', () => {
    const all: Part = { lastOwn: T0 - MIN, answerRate: 0.9 };
    expect(conversing(f({ shape: 'direct', mention: true }), all, T0)).toBe('dm');
    expect(conversing(f({ mention: true }), all, T0)).toBe('about');
    expect(conversing(f(), all, T0)).toBe('wrote');
    expect(conversing(f(), { ...all, lastOwn: null }, T0)).toBe('answers');
  });

  test('never: from a bot, a place kept to the list, your notes to yourself', () => {
    const all: Part = { lastOwn: T0 - MIN, answerRate: 0.9 };
    for (const shape of ['direct', 'group', 'channel']) {
      expect(conversing(f({ shape, bot: true, mention: true, reply: true }), all, T0)).toBeNull();
      expect(conversing(f({ shape, cap: true, mention: true, reply: true }), all, T0)).toBeNull();
    }
    expect(conversing(f({ shape: 'self', mention: true }), all, T0)).toBeNull();
    // Not capped, said outright, changes nothing.
    expect(conversing(f({ shape: 'direct', cap: false }), away, T0)).toBe('dm');
  });
});

describe('how often you answer openings', () => {
  const other = (conv: string, ts: number, author = 'ann') => ({ conv, ts, author, mine: false });
  const mine = (conv: string, ts: number) => ({ conv, ts, author: 'me', mine: true });
  /** The rate with nothing decayed: answered of openings, with the five unanswered every chat starts with. */
  const plain = (answered: number, openings: number) => answered / (openings + OPENING_PRIOR);

  test('the constants', () => {
    expect(OPENING_LULL).toBe(5 * MIN);
    expect(OPENING_ANSWER).toBe(3 * HOUR);
    expect(OPENING_PRIOR).toBe(5);
    expect(ENGAGED).toBe(15 * MIN);
    expect(RATE_HALF_LIFE).toBe(30 * DAY);
  });

  test('an opening you answer within three hours counts for you; until then it waits and counts for nothing', () => {
    const fold = new Interactions();
    expect(fold.answerRate('g', T0)).toBe(0);
    expect(fold.lastOwn('g')).toBeNull();
    fold.message(other('g', T0));
    // Still waiting: nothing is known of it yet.
    expect(fold.answerRate('g', T0 + MIN)).toBe(0);
    fold.message(mine('g', T0 + 10 * MIN));
    expect(fold.lastOwn('g')).toBe(T0 + 10 * MIN);
    expect(fold.answerRate('g', T0 + 11 * MIN)).toBeCloseTo(plain(1, 1), 3);
    // One answered opening is enough for the rule; another chat knows nothing of it.
    expect(fold.answerRate('g', T0 + 11 * MIN)).toBeGreaterThanOrEqual(0.1);
    expect(fold.answerRate('elsewhere', T0 + 11 * MIN)).toBe(0);
  });

  test('to the minute: an answer at three hours counts, one after does not', () => {
    const at = new Interactions();
    at.message(other('g', T0));
    at.message(mine('g', T0 + OPENING_ANSWER));
    expect(at.answerRate('g', T0 + OPENING_ANSWER + MIN)).toBeCloseTo(plain(1, 1), 3);
    const after = new Interactions();
    after.message(other('g', T0));
    after.message(mine('g', T0 + OPENING_ANSWER + MIN));
    expect(after.answerRate('g', T0 + OPENING_ANSWER + 2 * MIN)).toBe(0);
    // That unanswered opening counts against the next one you do answer.
    after.message(other('g', T0 + DAY));
    after.message(mine('g', T0 + DAY + MIN));
    const r = after.answerRate('g', T0 + DAY + 2 * MIN);
    expect(r).toBeCloseTo(plain(1, 2), 2);
    expect(r).toBeLessThan(plain(1, 1) - 0.01);
  });

  test('where you never wrote the rate is 0, however much was said there', () => {
    const fold = new Interactions();
    for (let i = 0; i < 50; i++) fold.message(other('busy', T0 + i * HOUR, `p${i % 5}`));
    expect(fold.answerRate('busy', T0 + 60 * HOUR)).toBe(0);
    expect(fold.lastOwn('busy')).toBeNull();
  });

  test('only the first message after five minutes of silence opens: a burst is one opening', () => {
    const fold = new Interactions();
    // Three people within a few minutes, nobody answered: one opening, not three.
    fold.message(other('g', T0, 'ann'));
    fold.message(other('g', T0 + 2 * MIN, 'bo'));
    fold.message(other('g', T0 + 6 * MIN, 'cy'));
    fold.message(other('g', T0 + DAY, 'ann'));
    fold.message(mine('g', T0 + DAY + MIN));
    const r = fold.answerRate('g', T0 + DAY + 2 * MIN);
    expect(r).toBeCloseTo(plain(1, 2), 2);
    expect(r).toBeGreaterThan(plain(1, 4) + 0.02);
    // More than five minutes after the last message of anyone (and you long done writing): a new opening.
    fold.message(other('g', T0 + DAY + 30 * MIN, 'bo'));
    expect(fold.answerRate('g', T0 + DAY + 30 * MIN + OPENING_ANSWER + MIN)).toBeCloseTo(plain(1, 3), 2);
  });

  test('while you are writing there nobody opens anything: a message within fifteen minutes of yours is not an opening', () => {
    const fold = new Interactions();
    fold.message(other('g', T0));
    fold.message(mine('g', T0 + MIN));
    const before = fold.answerRate('g', T0 + 2 * MIN);
    // Ten minutes after yours, after a lull: you are still in it. Never answered, and it costs nothing.
    fold.message(other('g', T0 + 11 * MIN));
    expect(fold.answerRate('g', T0 + 11 * MIN + OPENING_ANSWER + MIN)).toBeCloseTo(before, 3);
    // Twenty minutes after yours: you had left. That one is an opening, and going unanswered it counts.
    const gone = new Interactions();
    gone.message(other('g', T0));
    gone.message(mine('g', T0 + MIN));
    gone.message(other('g', T0 + 21 * MIN));
    expect(gone.answerRate('g', T0 + 21 * MIN + OPENING_ANSWER + MIN)).toBeCloseTo(plain(1, 2), 2);
  });

  test('your message answers every opening still waiting there, and none elsewhere', () => {
    const fold = new Interactions();
    fold.message(other('g', T0));
    fold.message(other('g', T0 + HOUR));
    fold.message(other('h', T0 + HOUR));
    fold.message(mine('g', T0 + 2 * HOUR));
    expect(fold.answerRate('g', T0 + 2 * HOUR + MIN)).toBeCloseTo(plain(2, 2), 3);
    expect(fold.answerRate('h', T0 + 5 * HOUR)).toBe(0);
  });

  test('the last months count most: an answer loses half its weight in thirty days', () => {
    const fold = new Interactions();
    fold.message(other('g', T0));
    fold.message(mine('g', T0 + MIN));
    expect(fold.answerRate('g', T0 + 2 * MIN)).toBeCloseTo(1 / 6, 3);
    expect(fold.answerRate('g', T0 + RATE_HALF_LIFE)).toBeCloseTo(0.5 / 5.5, 3);
    // Two months on it is under the rule's one in ten.
    const later = fold.answerRate('g', T0 + 2 * RATE_HALF_LIFE);
    expect(later).toBeCloseTo(0.25 / 5.25, 3);
    expect(later).toBeLessThan(0.1);
    // Asked about a time before the tally's own, nothing grows back.
    expect(fold.answerRate('g', T0 - DAY)).toBeCloseTo(1 / 6, 3);
  });

  test('history that arrives late is ignored: it says nothing about how you answer now', () => {
    const fold = new Interactions();
    // Something newer was folded first (a live message elsewhere); then a backfill of an old exchange.
    fold.message(other('live', T0 + DAY));
    fold.message(other('g', T0));
    fold.message(mine('g', T0 + 2 * MIN));
    expect(fold.answerRate('g', T0 + 2 * DAY)).toBe(0);
    // When you last wrote there is still known.
    expect(fold.lastOwn('g')).toBe(T0 + 2 * MIN);
    // In order, the same exchange counts.
    const inOrder = new Interactions();
    inOrder.message(other('g', T0));
    inOrder.message(mine('g', T0 + 2 * MIN));
    inOrder.message(other('live', T0 + DAY));
    expect(inOrder.answerRate('g', T0 + 2 * DAY)).toBeGreaterThan(0.1);
  });
});
