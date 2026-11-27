/** When they are likely to answer you, in words (theiranswer.ts, docs/profile.md "When they answer"). */
import { describe, expect, test } from 'bun:test';
import type * as P from '@dither-chat/protocol';
import { answerLine } from '../src/theiranswer.ts';

const MIN = 60_000;
const HOUR = 60 * MIN;
// Noon UTC, said in UTC: the times read the same on any machine.
const NOW = Date.UTC(2026, 10, 18, 12, 0);
const utc = () => 0;
const view = (half: number | null, likely: number | null, week = 90): P.TheirAnswerView => ({ waiting: NOW - 10 * MIN, by: new Array(48).fill(0), half, likely, week, turns: 20, days: 40, own: 0.8 });

describe('the answer line', () => {
  test('the times a half and 8 in 10 are reached, saying the day when it is not today', () => {
    expect(answerLine(view(NOW + 2 * HOUR, NOW + 20 * HOUR), NOW, false, utc)).toMatch(/^Likely by 2:00\sPM, 8 in 10 by tomorrow 8:00\sAM$/);
    expect(answerLine(view(NOW + 2 * HOUR, NOW + 60 * HOUR), NOW, true, utc)).toMatch(/^likely by 2:00\sPM, 8 in 10 by Sat 12:00\sAM$/);
  });
  test('any minute; no 8 in 10 within the week; no half within it', () => {
    expect(answerLine(view(NOW + 3 * MIN, null), NOW, false, utc)).toBe('Likely any minute');
    expect(answerLine(view(null, null, 35), NOW, false, utc)).toBe('35% chance of an answer within the week');
  });
});
