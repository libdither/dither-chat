import { describe, expect, test } from 'bun:test';
import type * as P from '@dither-chat/protocol';
import { historyItems } from '../src/historyRows.ts';

const M = 60_000;
const msg = (x: Partial<P.MessageView> = {}): P.MessageView =>
  ({ id: 'm1', conversationId: 'c1', network: 'signal', nativeId: 'n1', authorId: 'me', ts: 0, editedTs: 5 * M, kind: 'text', body: 'leaving at 5:45 from the gym', replyToId: null, threadId: null, mentionsSelf: false, deleted: false, attachments: [], embeds: [], reactions: [], seenVia: [], triage: null, ...x }) as P.MessageView;
const hist = (x: Partial<P.MessageHistoryView> = {}): P.MessageHistoryView => ({
  versions: [
    { body: 'leaving at 6', at: 0 },
    { body: 'leaving at 5:45', at: 2 * M },
    { body: 'leaving at 5:45 from the gym', at: 5 * M },
  ],
  events: [],
  reactions: [],
  receipts: [],
  identities: [],
  ...x,
});
const kinds = (xs: { kind: string }[]) => xs.map((x) => x.kind);

describe('historyItems', () => {
  test('oldest first: sent with what it first said, then each edit as before and after', () => {
    const xs = historyItems(msg(), hist(), 'edits');
    expect(kinds(xs)).toEqual(['sent', 'edit', 'edit']);
    expect(xs[0]).toMatchObject({ body: 'leaving at 6' });
    expect(xs[2]).toMatchObject({ before: 'leaving at 5:45', after: 'leaving at 5:45 from the gym', at: 5 * M });
  });

  test('reactions: made, taken back with when it was made, and those there before the hub, without edits', () => {
    const m = msg({ reactions: [{ key: '👍', style: 'normal', count: 3, identityIds: ['a', 'b'], at: { a: 3 * M } }] as P.ReactionView[] });
    const h = hist({
      reactions: [{ identityId: 'a', key: '👍', style: 'normal', at: 3 * M }],
      events: [{ kind: 'unreact', actorId: 'c', at: 4 * M, data: { key: '😂', style: 'normal', added: 1 * M } }],
    });
    const xs = historyItems(m, h, 'reactions');
    expect(kinds(xs)).toEqual(['before', 'react', 'react', 'unreact']);
    expect(xs[0]).toMatchObject({ reactions: [{ actorId: 'b', key: '👍' }], more: 1 });
    expect(xs[1]).toMatchObject({ actorId: 'c', key: '😂', at: 1 * M });
  });

  test('all: reads fold into one row between two edits, deliveries into one, pins in their place', () => {
    const h = hist({
      receipts: [
        { identityId: 'a', state: 'delivered', at: 1 * M },
        { identityId: 'a', state: 'read', at: 1 * M },
        { identityId: 'b', state: 'delivered', at: 3 * M },
        { identityId: 'b', state: 'read', at: 3 * M },
        { identityId: 'c', state: 'read', at: 4 * M },
      ],
      events: [{ kind: 'pin', actorId: 'a', at: 6 * M, data: null }],
    });
    const xs = historyItems(msg(), h, 'all');
    expect(kinds(xs)).toEqual(['sent', 'receipts', 'edit', 'receipts', 'receipts', 'edit', 'pin']);
    const reads = xs.filter((x) => x.kind === 'receipts' && x.state === 'read') as Extract<(typeof xs)[number], { kind: 'receipts' }>[];
    expect(reads.map((r) => r.who.map((w) => w.identityId))).toEqual([['a'], ['b', 'c']]);
    const delivered = xs.find((x) => x.kind === 'receipts' && x.state === 'delivered');
    expect(delivered).toMatchObject({ from: 1 * M, at: 3 * M, who: [{ identityId: 'a' }, { identityId: 'b' }] });
  });
});
