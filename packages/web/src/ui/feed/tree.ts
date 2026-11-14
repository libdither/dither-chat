/**
 * A post's replies as a tree (docs/feed.md "Threads"), pure: whatever posts are known under it (the network's chains,
 * what the hub logged before, branches opened since) put under the post each answers. A network that shows replies as
 * chains (X) or as a tree (Reddit, Mastodon) gives the same tree; how it is drawn is the page's choice.
 */
import type * as P from '@dither-chat/protocol';

export interface TreeNode {
  post: P.PostView;
  children: TreeNode[];
  /** Replies the network counts under it that no known post is: what "N more replies" loads. */
  hidden: number;
  /** Every post below it. */
  size: number;
}

/**
 * The replies under `rootId`, as a tree. Siblings keep the order they first came in (the network's order: X puts the
 * author's own continuation first, then what it ranks highest), so a branch opened later goes after them. A post seen
 * twice is one node; a post whose parent is not known is left out (it answers something outside this thread).
 */
export function replyTree(rootId: string, posts: readonly P.PostView[]): TreeNode[] {
  const byId = new Map<string, P.PostView>();
  const order: string[] = [];
  for (const p of posts) {
    if (p.id === rootId) continue;
    if (!byId.has(p.id)) order.push(p.id);
    // A later copy is the newer read (its counts): keep it, in the first one's place.
    byId.set(p.id, p);
  }
  const kids = new Map<string, string[]>();
  for (const id of order) {
    const parent = byId.get(id)!.replyTo?.id;
    if (!parent) continue;
    (kids.get(parent) ?? kids.set(parent, []).get(parent)!).push(id);
  }
  const seen = new Set<string>([rootId]);
  const build = (id: string): TreeNode[] =>
    (kids.get(id) ?? [])
      .filter((k) => !seen.has(k) && (seen.add(k), true))
      .map((k) => {
        const post = byId.get(k)!;
        const children = build(k);
        return { post, children, hidden: Math.max(0, (post.counts?.replies ?? 0) - children.length), size: children.reduce((n, c) => n + 1 + c.size, 0) };
      });
  return build(rootId);
}

/**
 * A run: the node, then while the last has exactly one answer, that answer. A back-and-forth (one reply each, turn
 * after turn) is one run, drawn down one column instead of a step in per turn; the tree branches, and indents, only
 * where a reply has two answers or more.
 */
export function runOf(n: TreeNode): TreeNode[] {
  const run = [n];
  for (let x = n; x.children.length === 1; ) run.push((x = x.children[0]));
  return run;
}

/** The people taking turns in a run, when it is two of them going back and forth (each step the other one). */
export function runPair(run: readonly TreeNode[]): [string, string] | null {
  const a = run[0]?.post.author;
  const b = run[1]?.post.author;
  if (!a || !b || a === b) return null;
  return run.every((x, i) => x.post.author === (i % 2 ? b : a)) ? [a, b] : null;
}

/** How many posts a tree holds. */
export const treeSize = (nodes: readonly TreeNode[]) => nodes.reduce((n, c) => n + 1 + c.size, 0);

/**
 * The tree read as X's chains: each branch follows its first replies down as one chain; the other replies at each
 * step start chains of their own right after it, the nearest to the chain's end first.
 */
export function treeChains(nodes: readonly TreeNode[]): P.PostView[][] {
  const out: P.PostView[][] = [];
  const walk = (n: TreeNode) => {
    const path = [n];
    while (path[path.length - 1].children.length) path.push(path[path.length - 1].children[0]);
    out.push(path.map((x) => x.post));
    for (const step of path.slice().reverse()) step.children.slice(1).forEach(walk);
  };
  nodes.forEach(walk);
  return out;
}
