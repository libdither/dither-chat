/** src/snapshot.ts: what the start-up snapshot keeps, and its caps. Kept message pages: keptpages.test.ts. IndexedDB itself: docs/android.md's measurements. */
import { expect, mock, test } from 'bun:test';
import { stateMock } from './fixtures/state.ts';

mock.module('../src/state.ts', stateMock);
const { buildRest, mailRest, MAX_MAIL_BODIES, MAX_MAIL_CHARS } = await import('../src/snapshot.ts');

const msg = (id: string, ts: number, extra: Record<string, unknown> = {}): any => ({ id, conversationId: 'c', ts, authorId: `idn_${id}`, body: 'x', replyToId: null, reactions: [], attachments: [], embeds: [], ...extra });
const tl = (key: string, n: number, extra: Record<string, unknown> = {}): any => ({ key, messages: Array.from({ length: n }, (_, i) => msg(`${key}-${i}`, i)), hasMore: true, loading: false, ...extra });
const ids = new Map([['idn_a-59', { id: 'idn_a-59' }], ['idn_q', { id: 'idn_q' }], ['idn_r', { id: 'idn_r' }], ['idn_unused', { id: 'idn_unused' }]] as any);

test('the inbox brings along what its messages quote and who reacted; kept pages are not in the rest', () => {
  const quoted = new Map([['q', msg('q', 0)]]) as any;
  const rest = JSON.parse(buildRest({ inbox: [msg('m', 1, { replyToId: 'q', authorId: null, reactions: [{ identityIds: ['idn_r'] }] }), msg('a-59', 2)], identities: ids, quoted }));
  expect(rest.quoted.map((m: any) => m.id)).toEqual(['q']);
  expect(rest.identities.map((i: any) => i.id).sort()).toEqual(['idn_a-59', 'idn_q', 'idn_r']);
  expect(rest.timelines).toBeUndefined();
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
  const rest = JSON.parse(buildRest({ inbox: [], identities: new Map(), quoted: new Map(), mail: { details: [detail(1)], bodies: [] } }));
  expect(rest.mail.details).toHaveLength(1);
});

test('keeps the Triage board’s mail, newest first, as many as the inbox (slice 9)', () => {
  const item = (i: number): any => ({ kind: 'mail', id: `mml_${i}`, threadId: 'mth_a', accountId: 'a', from: { name: null, email: 'x@y.example' }, subject: 's', preview: null, ts: i, unread: true, triage: { decision: 'push', score: 1, reasons: [], decidedBy: 'rules', feedback: null } });
  const rest = JSON.parse(buildRest({ inbox: [], identities: ids, quoted: new Map(), mailTriage: Array.from({ length: 150 }, (_, i) => item(150 - i)) }));
  expect(rest.mailTriage).toHaveLength(100);
  expect(rest.mailTriage[0].id).toBe('mml_150');
  expect(JSON.parse(buildRest({ inbox: [], identities: ids, quoted: new Map() })).mailTriage).toBeUndefined();
});
