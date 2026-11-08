/** src/snapshot.ts: what the start-up snapshot keeps, and its caps. IndexedDB itself: docs/android.md's measurements. */
import { expect, mock, test } from 'bun:test';

mock.module('../src/state.ts', () => ({ db: {}, inbox: { value: [] }, loaded: { value: false }, quoted: new Map(), rev: { value: 0 }, timelines: new Map() }));
const { buildRest, mailRest, MAX_MAIL_BODIES, MAX_MAIL_CHARS, MAX_MESSAGES, MAX_REST_CHARS, MAX_TIMELINES } = await import('../src/snapshot.ts');

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

test('mail: the threads and bodies the reader opened last, within the caps', () => {
  const body = (i: number, n = 10): any => ({ messageId: `m${i}`, text: 'x'.repeat(n), quoteAt: null, html: null, bcc: [], replyTo: [], attachments: [], warnings: [] });
  const detail = (i: number): any => ({ thread: { id: `t${i}` }, messages: [] });
  const kept = mailRest({ details: [detail(1), detail(2)], bodies: Array.from({ length: MAX_MAIL_BODIES + 5 }, (_, i) => body(i)) });
  expect(kept.details.map((d: any) => d.thread.id)).toEqual(['t2', 't1']);
  expect(kept.bodies).toHaveLength(MAX_MAIL_BODIES);
  expect(kept.bodies[0].messageId).toBe(`m${MAX_MAIL_BODIES + 4}`);
  // One too big is left out; smaller ones still fit.
  expect(mailRest({ details: [], bodies: [body(1, 10), body(2, MAX_MAIL_CHARS)] }).bodies.map((b: any) => b.messageId)).toEqual(['m1']);
  const rest = JSON.parse(buildRest({ inbox: [], timelines: [], identities: new Map(), quoted: new Map(), mail: { details: [detail(1)], bodies: [] } }));
  expect(rest.mail.details).toHaveLength(1);
});
