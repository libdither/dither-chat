/** A post's replies as a tree (ui/feed/tree.ts, docs/feed.md "Threads"). */
import { expect, test } from 'bun:test';
import type * as P from '@dither-chat/protocol';
import { replyTree, runOf, runPair, treeChains, treeSize } from '../src/ui/feed/tree.ts';

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

test('a back-and-forth is one run down a column; the run ends where a reply has two answers', () => {
  const by = (id: string, to: string, author: string): P.PostView => ({ ...p(id, to), author });
  // a (ann) <- b (bo) <- c (ann) <- d (bo), and d has two answers: e, f.
  const tree = replyTree('r', [by('a', 'r', 'ann'), by('b', 'a', 'bo'), by('c', 'b', 'ann'), by('d', 'c', 'bo'), by('e', 'd', 'cy'), by('f', 'd', 'ann')]);
  const run = runOf(tree[0]);
  expect(run.map((x) => x.post.id)).toEqual(['a', 'b', 'c', 'd']);
  expect(run[3].children.map((x) => x.post.id)).toEqual(['e', 'f']);
  expect(runPair(run)).toEqual(['ann', 'bo']);
  // Three people, or the same one twice in a row, is a run but no pair.
  expect(runPair(runOf(replyTree('r', [by('a', 'r', 'ann'), by('b', 'a', 'bo'), by('c', 'b', 'cy')])[0]))).toBeNull();
  expect(runPair(runOf(replyTree('r', [by('a', 'r', 'ann'), by('b', 'a', 'ann')])[0]))).toBeNull();
  // A reply alone is a run of one.
  expect(runOf(replyTree('r', [by('a', 'r', 'ann')])[0]).length).toBe(1);
});
