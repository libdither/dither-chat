import { describe, expect, test } from 'bun:test';
import type * as P from '@dither-chat/protocol';
import { mailTree } from '../src/mail/threadtree.ts';

/** A mail of an invented thread: its id, when, and the mail it answers. */
const mail = (id: string, ts: number, inReplyTo?: string) => ({ id, ts, mail: { messageId: `<${id}@x.example>`, ...(inReplyTo ? { inReplyTo: `<${inReplyTo}@x.example>` } : {}) } }) as unknown as P.MessageView;

describe('mailTree', () => {
  test('a thread nobody branched is in its chat order, one column, no branch', () => {
    const t = mailTree([mail('c', 3, 'b'), mail('a', 1), mail('b', 2, 'a')]);
    expect(t.order.map((m) => m.id)).toEqual(['a', 'b', 'c']);
    expect([...t.rows.values()].every((r) => r.depth === 0 && r.branch === null)).toBe(true);
    expect(t.branched).toBe(false);
  });
  test('two answers to one mail step in, each under it, oldest first; a run goes on in its column', () => {
    // a has two answers (b, c); b has one (d), which follows b in b's column.
    const t = mailTree([mail('a', 1), mail('b', 2, 'a'), mail('c', 3, 'a'), mail('d', 4, 'b')]);
    expect(t.order.map((m) => m.id)).toEqual(['a', 'b', 'd', 'c']);
    expect(t.branched).toBe(true);
    expect(t.rows.get('b')).toEqual({ depth: 1, branch: 'b', size: 1 });
    expect(t.rows.get('d')).toEqual({ depth: 1, branch: 'b', size: 0 });
    expect(t.rows.get('c')).toEqual({ depth: 1, branch: 'c', size: 0 });
  });
  test('a mail answering one not here, and a loop, still show, at the top', () => {
    const t = mailTree([mail('x', 1, 'gone'), mail('p', 2, 'q'), mail('q', 3, 'p')]);
    expect(t.order.map((m) => m.id).sort()).toEqual(['p', 'q', 'x']);
    expect(t.rows.get('x')?.depth).toBe(0);
  });
});
