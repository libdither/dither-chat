/**
 * A reaction pill's tooltip (reactions.ts): who reacted and, where known, when (docs/reactions.md "When").
 */
import { expect, mock, test } from 'bun:test';
import type * as P from '@dither-chat/protocol';
import { selfIds, stateMock } from './fixtures/state.ts';

mock.module('../src/state.ts', stateMock);
const { reactedAt, reactionTip } = await import('../src/reactions.ts');
const { stamp } = await import('../src/format.ts');

const now = new Date(2026, 10, 7, 15, 0).getTime();
const names: Record<string, string> = { ann: 'Ann', bo: 'Bo', cy: 'Cy', me: 'Me' };
const nameOf = (id: string) => names[id] ?? id;
const pill = (r: Partial<P.ReactionView>): P.ReactionView => ({ key: '👍', style: 'normal', count: r.identityIds?.length ?? 0, identityIds: [], ...r });

test('with no time known: who, in a line, and nothing under it', () => {
  expect(reactionTip(pill({ identityIds: ['ann', 'bo'] }), 'signal', nameOf, now)).toEqual({ text: 'Ann and Bo', lines: [], note: null });
  expect(reactionTip(pill({ count: 40, identityIds: ['ann'] }), 'discord', nameOf, now).text).toBe('Ann and 39 others');
});

test('one person: their name, and when', () => {
  const a = new Date(2026, 10, 7, 9, 30).getTime();
  expect(reactionTip(pill({ identityIds: ['ann'], at: { ann: a } }), 'signal', nameOf, now)).toEqual({ text: 'Ann', lines: [stamp(a, now)], note: null });
});

test('the network’s own times: a line each, earliest first, those with none before them', () => {
  const a = new Date(2026, 10, 7, 9, 30).getTime();
  const b = new Date(2026, 10, 6, 20, 0).getTime();
  const r = pill({ identityIds: ['ann', 'bo', 'cy'], at: { ann: a, bo: b } });
  expect(reactionTip(r, 'signal', nameOf, now)).toEqual({ text: 'Ann, Bo and Cy', lines: ['Cy', `Bo · ${stamp(b, now)}`, `Ann · ${stamp(a, now)}`], note: null });
});

test('Discord’s are when the hub heard: "by", and a note saying why', () => {
  const t = new Date(2026, 10, 7, 14, 1).getTime();
  selfIds.add('me');
  const r = pill({ count: 3, identityIds: ['me', 'ann'], seenAt: { me: t, ann: t - 60_000 } });
  expect(reactionTip(r, 'discord', nameOf, now)).toEqual({
    text: 'You, Ann and 1 other',
    lines: [`Ann · by ${stamp(t - 60_000, now)}`, `You · by ${stamp(t, now)}`, 'and 1 other'],
    note: `Discord doesn't say when people react: "by" is when the hub first heard.`,
  });
  selfIds.delete('me');
});

test('a network that gives times but not this one (Telegram, for one taken back) says it didn’t, not that it never does', () => {
  const t = new Date(2026, 10, 7, 14, 1).getTime();
  const r = pill({ count: 1, identityIds: ['ann'], seenAt: { ann: t } });
  expect(reactionTip(r, 'telegram', nameOf, now).note).toBe(`Telegram didn't say when for these: "by" is when the hub first heard.`);
  expect(reactionTip(r, 'x', nameOf, now).note).toBe(`X doesn't say when people react: "by" is when the hub first heard.`);
});

test('at most eight people, then how many more', () => {
  const ids = Array.from({ length: 12 }, (_, i) => `p${i}`);
  const r = pill({ count: 20, identityIds: ids, at: Object.fromEntries(ids.map((id, i) => [id, now - (12 - i) * 60_000])) });
  const { lines } = reactionTip(r, 'matrix', nameOf, now);
  expect(lines).toHaveLength(9);
  expect(lines[0].startsWith('p0 · ')).toBe(true);
  expect(lines.at(-1)).toBe('and 12 others');
});

test('the network’s time wins over when the hub heard', () => {
  expect(reactedAt({ at: { ann: 5 }, seenAt: { ann: 9 } }, 'ann')).toEqual({ at: 5, seen: false });
  expect(reactedAt({ seenAt: { ann: 9 } }, 'ann')).toEqual({ at: 9, seen: true });
  expect(reactedAt({}, 'ann')).toBeNull();
});
