/** A post's replies as a tree (ui/feed/tree.ts, docs/feed.md "Threads"). */
import { expect, test } from 'bun:test';
import type * as P from '@dither-chat/protocol';
import { replyTree, treeChains, treeSize } from '../src/ui/feed/tree.ts';

const p = (id: string, to: string, replies?: number): P.PostView => ({ id, url: '', ts: 0, text: id, replyTo: { id: to }, messageId: null, ...(replies !== undefined ? { counts: { replies } } : {}) });
const shape = (nodes: ReturnType<typeof replyTree>): unknown => nodes.map((n) => (n.children.length ? [n.post.id, shape(n.children)] : n.post.id));

test("X's chains and what was logged later make one tree, siblings in the order they came", () => {
  // Chains as X gives them: [a, a1, a11], [b]; then logged: a2 under a, a12 under a1; then a branch opened: b1.
  const tree = replyTree('r', [p('a', 'r'), p('a1', 'a'), p('a11', 'a1'), p('b', 'r'), p('a2', 'a'), p('a12', 'a1'), p('b1', 'b')]);
  expect(shape(tree)).toEqual([['a', [['a1', ['a11', 'a12']], 'a2']], ['b', ['b1']]]);
  expect(treeSize(tree)).toBe(7);
  expect(tree[0].size).toBe(4);
});

test('a post seen twice is one node with its newer copy; one answering outside the thread is left out; no cycles', () => {
  const newer = { ...p('a', 'r'), text: 'newer' };
  const tree = replyTree('r', [p('a', 'r'), p('x', 'elsewhere'), newer, p('c', 'd'), p('d', 'c')]);
  expect(shape(tree)).toEqual(['a']);
  expect(tree[0].post.text).toBe('newer');
});

test('what the network counts under a post and the tree lacks is hidden, to load', () => {
  const tree = replyTree('r', [p('a', 'r', 3), p('a1', 'a', 0)]);
  expect(tree[0].hidden).toBe(2);
  expect(tree[0].children[0].hidden).toBe(0);
});

test('a tree read as chains: each branch its own chain, after the one it hangs from', () => {
  const tree = replyTree('r', [p('a', 'r'), p('a1', 'a'), p('a11', 'a1'), p('a12', 'a1'), p('a2', 'a'), p('b', 'r')]);
  expect(treeChains(tree).map((c) => c.map((x) => x.id).join('>'))).toEqual(['a>a1>a11', 'a12', 'a2', 'b']);
});
