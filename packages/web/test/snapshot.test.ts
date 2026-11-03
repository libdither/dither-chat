/** src/snapshot.ts: what the start-up snapshot keeps, and its caps. IndexedDB itself: docs/android.md's measurements. */
import { expect, mock, test } from 'bun:test';

mock.module('../src/state.ts', () => ({ db: {}, inbox: { value: [] }, loaded: { value: false }, quoted: new Map(), rev: { value: 0 }, timelines: new Map() }));
const { buildRest, MAX_MESSAGES, MAX_REST_CHARS, MAX_TIMELINES } = await import('../src/snapshot.ts');

const msg = (id: string, ts: number, extra: Record<string, unknown> = {}): any => ({ id, conversationId: 'c', ts, authorId: `idn_${id}`, body: 'x', replyToId: null, reactions: [], attachments: [], embeds: [], ...extra });
const tl = (key: string, n: number, extra: Record<string, unknown> = {}): any => ({ key, messages: Array.from({ length: n }, (_, i) => msg(`${key}-${i}`, i)), hasMore: true, loading: false, ...extra });
const ids = new Map([['idn_a-59', { id: 'idn_a-59' }], ['idn_q', { id: 'idn_q' }], ['idn_r', { id: 'idn_r' }], ['idn_unused', { id: 'idn_unused' }]] as any);

test('keeps the newest messages of the most recently opened conversations', () => {
  const rest = JSON.parse(buildRest({ inbox: [], timelines: [tl('a', 60), tl('b', 5)], identities: ids, quoted: new Map() }));
  expect(rest.timelines.map((t: any) => t.key)).toEqual(['a', 'b']);
  expect(rest.timelines[0].messages).toHaveLength(MAX_MESSAGES);
  expect(rest.timelines[0].messages.at(-1).id).toBe('a-59');
  expect(rest.identities.map((i: any) => i.id)).toEqual(['idn_a-59']);
});

test('no window around an old message, and no more than the caps', () => {
  const many = Array.from({ length: MAX_TIMELINES + 5 }, (_, i) => tl(`t${i}`, 1));
  const rest = JSON.parse(buildRest({ inbox: [], timelines: [tl('old', 3, { detached: true }), ...many], identities: ids, quoted: new Map() }));
  expect(rest.timelines.some((t: any) => t.key === 'old')).toBe(false);
  expect(rest.timelines.length).toBeLessThanOrEqual(MAX_TIMELINES);
  const huge = [tl('h1', 1, { messages: [msg('big', 1, { body: 'x'.repeat(MAX_REST_CHARS) })] }), tl('h2', 2)];
  expect(JSON.parse(buildRest({ inbox: [], timelines: huge, identities: ids, quoted: new Map() })).timelines.map((t: any) => t.key)).toEqual([]);
});

test('brings along what replies quote and who reacted', () => {
  const quoted = new Map([['q', msg('q', 0)]]) as any;
  const t = tl('a', 0, { messages: [msg('m', 1, { replyToId: 'q', authorId: null, reactions: [{ identityIds: ['idn_r'] }] })] });
  const rest = JSON.parse(buildRest({ inbox: [], timelines: [t], identities: ids, quoted }));
  expect(rest.quoted.map((m: any) => m.id)).toEqual(['q']);
  expect(rest.identities.map((i: any) => i.id).sort()).toEqual(['idn_q', 'idn_r']);
});
