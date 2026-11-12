import { describe, expect, test } from 'bun:test';
import { emptyTally, foldMessage, freshState, record, scoreConversation, WEIGHTS, type ScoreInput, type Tally } from '../src/attention.ts';
import { DEFAULT_OWED_TABLE, fitOwedTable, OWED_AGES, owedChance, rateTurns, validTable, type OwedTurn } from '../src/owed.ts';

const MIN = 60_000;
const HOUR = 60 * MIN;
const DAY = 24 * HOUR;
const T0 = Date.UTC(2026, 0, 1, 9);

describe('the owed table', () => {
  test('a turn weighs less the longer it stays open, and nothing once the window is past', () => {
    const at = (h: number) => owedChance(DEFAULT_OWED_TABLE, 'direct', 0.97, h * HOUR);
    expect(at(0)).toBeGreaterThan(at(1));
    expect(at(1)).toBeGreaterThan(at(12));
    expect(at(12)).toBeGreaterThan(at(48));
    expect(at(72)).toBe(0);
    expect(at(24 * 14)).toBe(0);
  });

  test('a higher reply rate never weighs less, and someone you never answer is owed nothing', () => {
    let last = -1;
    for (let r = 0; r <= 1; r += 0.01) {
      const c = owedChance(DEFAULT_OWED_TABLE, 'direct', r, 3 * HOUR);
      expect(c).toBeGreaterThanOrEqual(last - 1e-9);
      last = c;
    }
    expect(owedChance(DEFAULT_OWED_TABLE, 'group', 0, 0)).toBe(0);
  });

  test('fits the chance of an answer given the turn is still open, by age', () => {
    // Half the turns answered within 10 minutes, the rest never: once 10 minutes have passed, almost nothing is owed.
    const turns: OwedTurn[] = [];
    for (let i = 0; i < 400; i++) {
      const addressed = T0 + i * 4 * DAY;
      turns.push({ conversationId: `c${i % 5}`, shape: 'direct', authorKey: `p${i % 5}`, addressed, answeredAt: i % 2 ? addressed + 10 * MIN : null, timed: true });
    }
    const t = fitOwedTable(turns, { now: T0 + 2000 * DAY });
    expect(validTable(t)).toBe(true);
    expect(t.fittedAt).toBe(T0 + 2000 * DAY);
    const rate = 0.5;
    expect(owedChance(t, 'direct', rate, 0)).toBeGreaterThan(0.3);
    expect(owedChance(t, 'direct', rate, HOUR)).toBeLessThan(0.1);
    // Groups had none: they keep the default.
    expect(t.chance.group).toEqual(DEFAULT_OWED_TABLE.chance.group);
    // The chances never rise with age.
    for (const rows of [t.chance.direct, t.chance.group]) for (const r of rows) for (let i = 1; i < OWED_AGES.length; i++) expect(r[i]).toBeLessThanOrEqual(r[i - 1]);
  });

  test('a turn still open within its window, and a reaction, say nothing about how turns end', () => {
    const now = T0 + 10 * DAY;
    const turns: OwedTurn[] = Array.from({ length: 300 }, (_, i) => ({ conversationId: 'c', shape: 'direct', authorKey: 'p', addressed: now - HOUR - i, answeredAt: null, timed: true }));
    turns.push(...Array.from({ length: 300 }, (_, i): OwedTurn => ({ conversationId: 'c', shape: 'direct', authorKey: 'p', addressed: T0 + i, answeredAt: T0 + i, timed: false })));
    const t = fitOwedTable(turns, { now });
    expect(t.turns.direct.every((n) => n === 0)).toBe(true);
  });

  test('a turn is rated by the answers that were over before it began', () => {
    const turns: OwedTurn[] = [
      { conversationId: 'c', shape: 'direct', authorKey: 'p', addressed: T0, answeredAt: T0 + MIN, timed: true },
      { conversationId: 'c', shape: 'direct', authorKey: 'p', addressed: T0 + 30 * MIN, answeredAt: null, timed: true },
      { conversationId: 'c', shape: 'direct', authorKey: 'p', addressed: T0 + 10 * DAY, answeredAt: null, timed: true },
    ];
    const [a, b, c] = rateTurns(turns);
    // Nothing was over before the first: the prior.
    expect(a.rate).toBeCloseTo(0.5, 5);
    // The first was answered before the second began.
    expect(b.rate).toBeGreaterThan(a.rate);
    // The second ran out before the third.
    expect(c.rate).toBeLessThan(b.rate);
  });
});

describe('what you owe, scored', () => {
  const now = T0 + 40 * DAY;
  const habit = (answered: number, of: number): Tally => {
    const t = emptyTally();
    for (let i = 0; i < of; i++) record(t, now - (i + 1) * DAY, i < answered ? 30 * MIN : null);
    return t;
  };
  function owed(ageH: number, x: Partial<ScoreInput> = {}): ScoreInput {
    const s = freshState();
    foldMessage(s, () => emptyTally(), { id: 'm', ts: now - ageH * HOUR, author: 'sam', authorKey: 'p_sam', mine: false, bot: false, mentionsMe: false, repliesToMe: false, question: false, pushed: false, ignore: false }, { shape: 'direct', members: 2 });
    return { now, shape: 'direct', members: 2, lastMessageAt: now - ageH * HOUR, state: s, author: habit(19, 20), authorName: 'Sam', unread: 0, mentions: 0, pinged: null, muted: null, usage: null, ...x };
  }

  test('is the table\'s chance times the weight, with the rate and age it was read at', () => {
    const r = scoreConversation(owed(5));
    expect(r.owed).not.toBeNull();
    expect(r.owed!.age).toBe(5 * HOUR);
    expect(r.parts.owed).toBeCloseTo(WEIGHTS.owed * owedChance(DEFAULT_OWED_TABLE, 'direct', r.owed!.rate, 5 * HOUR), 1);
    expect(r.owedSince).toBe(now - 5 * HOUR);
  });

  test('a turn weighing about nothing is not shown as owed, though the row needs you for something else', () => {
    const r = scoreConversation(owed(24 * 14, { unread: 3, pinged: 'Direct message' }));
    expect(r.needs).toBe(true);
    expect(r.owed!.chance).toBe(0);
    expect(r.owedSince).toBeNull();
    expect(r.parts.owed ?? 0).toBe(0);
  });

  test('uses the table it is given', () => {
    const flat = { ...DEFAULT_OWED_TABLE, chance: { direct: DEFAULT_OWED_TABLE.chance.direct.map((r) => r.map(() => 0.5)), group: DEFAULT_OWED_TABLE.chance.group } };
    expect(scoreConversation(owed(5, { owedTable: flat })).parts.owed).toBeCloseTo(30, 1);
  });
});
