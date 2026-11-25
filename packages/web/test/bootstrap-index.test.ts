/** src/syncmodel.ts applyBootstrapTo: what is where, threads and categories indexed as the hub sent them. */
import { expect, test } from 'bun:test';
import type * as P from '@dither-chat/protocol';
import { applyBootstrapTo, emptyDb } from '../src/syncmodel.ts';

const edge = (parentId: string, childId: string, position: string | null = null, childKind: 'space' | 'conversation' = 'conversation'): P.SpaceEdgeView => ({ parentId, childId, childKind, position });
const conv = (id: string, parentId: string | null = null) => ({ id, parentId }) as unknown as P.ConversationView;
const boot = (b: Partial<P.Bootstrap>): P.Bootstrap =>
  ({ selfPersonId: null, accounts: [], persons: [], identities: [], spaces: [], edges: [], conversations: [], folders: [], placePrefs: [], categories: [], placeCategories: [], categoryProvider: 'keyword', rules: [], reactionUsage: [], now: 0, ...b }) as P.Bootstrap;

test('edges in order; a repeated one takes the first one\'s place, both ways', () => {
  const db = emptyDb();
  const again = edge('s1', 'a', '9');
  applyBootstrapTo(db, boot({ edges: [edge('s1', 'a', '1'), edge('s1', 'b'), edge('s2', 'a'), again, edge('s1', 'x', null, 'space'), edge('s1', 'a', null, 'space')] }));
  expect(db.children.get('s1')).toEqual([again, edge('s1', 'b'), edge('s1', 'x', null, 'space'), edge('s1', 'a', null, 'space')]);
  expect(db.children.get('s2')).toEqual([edge('s2', 'a')]);
  // A conversation and a space with one id are both under s1; the parents index keeps one edge per parent.
  expect(db.parents.get('a')).toEqual([edge('s1', 'a', null, 'space'), edge('s2', 'a')]);
});

test("a channel's threads in the conversations' order, and a place's categories in the hub's", () => {
  const db = emptyDb();
  const pc = (id: string, categoryId: string) => ({ kind: 'conversation', id, categoryId }) as unknown as P.PlaceCategoryView;
  applyBootstrapTo(db, boot({ conversations: [conv('c'), conv('t2', 'c'), conv('t1', 'c'), conv('d'), conv('t3', 'd')], placeCategories: [pc('c', 'x'), pc('d', 'x'), pc('c', 'y')] }));
  expect(db.threads.get('c')).toEqual(['t2', 't1']);
  expect(db.threads.get('d')).toEqual(['t3']);
  expect(db.placeCategories.get('conversation:c')!.map((x) => x.categoryId)).toEqual(['x', 'y']);
});

test('thousands of topics in a few channels index as the copying version did', () => {
  // A seeded mix: three channels with 1,000 to 3,000 topics each, interleaved with plain conversations.
  let seed = 7;
  const rand = () => ((seed = (seed * 1103515245 + 12345) % 2147483648) / 2147483648);
  const convs: P.ConversationView[] = [conv('a'), conv('b'), conv('c')];
  const want = { a: 1000, b: 2000, c: 3000 } as Record<string, number>;
  const made = { a: 0, b: 0, c: 0 } as Record<string, number>;
  while (Object.keys(want).some((k) => made[k] < want[k])) {
    const open = Object.keys(want).filter((k) => made[k] < want[k]);
    const p = open[Math.floor(rand() * open.length)];
    convs.push(conv(`${p}-t${made[p]++}`, p));
    if (rand() < 0.1) convs.push(conv(`plain${convs.length}`));
  }
  const db = emptyDb();
  applyBootstrapTo(db, boot({ conversations: convs }));
  // The copying version, for comparison.
  const old = new Map<string, string[]>();
  for (const c of convs) if (c.parentId) old.set(c.parentId, [...(old.get(c.parentId) ?? []), c.id]);
  expect([...db.threads]).toEqual([...old]);
  expect(db.threads.get('c')!.length).toBe(3000);
});
