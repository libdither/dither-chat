/** @jsxRuntime classic */
/** @jsx h */
/** @jsxFrag Fragment */
/**
 * A post's replies drawn as a comment section (docs/feed.md "Threads"), from the tree tree.ts makes. Four ways, the
 * reader's choice, kept on the device:
 *
 * - **Tree** (as Reddit): each reply under the one it answers, a line down its left that folds the branch when
 *   clicked, "N more replies" where the network counts more than are known, "Continue this thread" past six deep.
 * - **Compact** (as Hacker News): the same tree without pictures, a narrow indent and [–] to fold.
 * - **Flat** (as YouTube and Discourse): replies to the post, each with every answer under it in one level, oldest
 *   first, saying whom each answers.
 * - **Chains** (as X): each reply and the answers under it as a chain joined by its pictures.
 */
import { Fragment, h, type ComponentChildren } from 'preact';
import type * as P from '@dither-chat/protocol';
import { openProfile } from '../../state.ts';
import { useEffect, useRef, useState } from 'preact/hooks';
import type { Kit } from './lazy.tsx';
import { Counts, Pics, QuotedIn, Row, Text, Who } from './Post.tsx';
import { treeChains, type TreeNode } from './tree.ts';

export type CommentStyle = 'tree' | 'compact' | 'flat' | 'chains';
export const COMMENT_STYLES: { id: CommentStyle; label: string; title: string }[] = [
  { id: 'tree', label: 'Tree', title: 'Each reply under the one it answers, as on Reddit' },
  { id: 'compact', label: 'Compact', title: 'The tree, dense and without pictures, as on Hacker News' },
  { id: 'flat', label: 'Flat', title: 'One level of replies under each, as on YouTube' },
  { id: 'chains', label: 'Chains', title: 'Each reply and the answers under it in a line, as on X' },
];
/** The style menu: a quiet word beside Replies ("Tree ▾") that opens the four, each with what it is like. */
export function StyleMenu({ style, pick, kit }: { style: CommentStyle; pick: (s: CommentStyle) => void; kit: Kit }) {
  const [open, setOpen] = useState(false);
  const box = useRef<HTMLSpanElement>(null);
  // Closes on a press outside it, as a menu does.
  useEffect(() => {
    if (!open) return;
    const down = (e: PointerEvent) => !box.current?.contains(e.target as Node) && setOpen(false);
    const key = (e: KeyboardEvent) => e.key === 'Escape' && (setOpen(false), box.current?.querySelector<HTMLElement>('.ct-style-btn')?.focus());
    addEventListener('pointerdown', down, true);
    addEventListener('keydown', key);
    return () => (removeEventListener('pointerdown', down, true), removeEventListener('keydown', key));
  }, [open]);
  const current = COMMENT_STYLES.find((s) => s.id === style)!;
  return (
    <span class="ct-style" ref={box}>
      <button class="ct-style-btn" aria-haspopup="menu" aria-expanded={open} title="How replies are drawn" onClick={() => setOpen(!open)}>
        {current.label} <kit.Icon name="chevronDown" size={12} />
      </button>
      {open && (
        <div class="ct-style-menu" role="menu">
          {COMMENT_STYLES.map((s) => (
            <button role="menuitemradio" aria-checked={s.id === style} class={s.id === style ? 'on' : ''} onClick={() => (pick(s.id), setOpen(false))}>
              <b>{s.label}</b>
              <span>{s.title}</span>
            </button>
          ))}
        </div>
      )}
    </span>
  );
}

/** Past this depth a branch opens as a thread of its own. */
export const MAX_DEPTH = 6;

export interface CommentCtx {
  kit: Kit;
  network: P.Network;
  /** The thread's author: their replies say OP. */
  op: string | null;
  folded: ReadonlySet<string>;
  fold: (id: string) => void;
  /** Branches being read, and those the network had nothing more under. */
  loading: ReadonlySet<string>;
  done: ReadonlySet<string>;
  /** Branches the network could not be asked for, and why: the button stays, to try again. */
  failed: ReadonlyMap<string, string>;
  load: (n: TreeNode) => void;
  /** What goes under a reply in place of its counts: its actions, and a composer when answering it. */
  below?: (p: P.PostFact) => ComponentChildren;
}

function MoreUnder({ n, ctx, under }: { n: TreeNode; ctx: CommentCtx; under?: boolean }) {
  if (!n.hidden || ctx.done.has(n.post.id)) return null;
  const busy = ctx.loading.has(n.post.id);
  const why = ctx.failed.get(n.post.id);
  const who = under ? ` under ${ctx.kit.name(n.post.author ?? null)}` : '';
  return (
    <span class="ct-more-wrap">
      <button class="ct-more" onClick={() => ctx.load(n)} disabled={busy}>
        {busy ? 'Loading…' : why ? 'Try again' : `${n.hidden} more ${n.hidden === 1 ? 'reply' : 'replies'}${who}`}
      </button>
      {why && !busy && <span class="ct-more-why">{why}</span>}
    </span>
  );
}

function Head({ p, ctx, avatar, folded, size }: { p: P.PostView; ctx: CommentCtx; avatar: number; folded: boolean; size: number }) {
  const { kit } = ctx;
  const who = p.author ?? null;
  return (
    <div class="ct-head">
      {avatar > 0 && (
        <button class="ct-face" onClick={() => openProfile(who)} aria-label={`${kit.name(who)}'s profile`}>
          <kit.Avatar id={who ?? p.id} name={kit.name(who)} url={kit.avatarUrl(who)} size={avatar} />
        </button>
      )}
      <Who id={who} kit={kit} />
      {who && who === ctx.op && <span class="post-tag op" title="Wrote the post">OP</span>}
      <a class="post-handle ct-time" href={kit.feed.postHref(ctx.network, p.id)} title={`${kit.fullTime(p.ts)}: open as a thread`}>
        · {kit.ago(p.ts)}
      </a>
      {folded && size > 0 && (
        <span class="ct-folded">
          {size} more {size === 1 ? 'reply' : 'replies'}
        </span>
      )}
    </div>
  );
}

function Body({ p, ctx }: { p: P.PostView; ctx: CommentCtx }) {
  return (
    <>
      <Text p={p} kit={ctx.kit} network={ctx.network} cls="post-text ct-text" />
      <Pics media={p.media} />
      {p.quoteOf && <QuotedIn p={p.quoteOf} kit={ctx.kit} network={ctx.network} />}
      {ctx.below ? ctx.below(p) : <Counts p={{ ...p, counts: p.counts ? { likes: p.counts.likes, reposts: p.counts.reposts } : undefined }} kit={ctx.kit} />}
    </>
  );
}

/** Tree and Compact: one reply, its rail, and what is under it. */
function Node({ n, depth, ctx, compact }: { n: TreeNode; depth: number; ctx: CommentCtx; compact: boolean }) {
  const p = n.post;
  const folded = ctx.folded.has(p.id);
  const name = ctx.kit.name(p.author ?? null);
  return (
    <div class={`ct-node ${folded ? 'folded' : ''}`} data-post={p.id} data-depth={depth}>
      <div class="ct-side">
        {compact ? (
          <button class="ct-toggle" onClick={() => ctx.fold(p.id)} aria-expanded={!folded} aria-label={folded ? `Unfold ${name}'s reply` : `Fold ${name}'s reply`}>
            {folded ? '[+]' : '[–]'}
          </button>
        ) : (
          <button class="ct-face" onClick={() => openProfile(p.author ?? null)} aria-label={`${name}'s profile`}>
            <ctx.kit.Avatar id={p.author ?? p.id} name={name} url={ctx.kit.avatarUrl(p.author ?? null)} size={24} />
          </button>
        )}
        {!folded && (
          <button
            class="ct-rail"
            onClick={() => ctx.fold(p.id)}
            aria-expanded="true"
            aria-label={n.size ? `Fold ${name}'s reply and the ${n.size} under it` : `Fold ${name}'s reply`}
            title="Fold"
          />
        )}
      </div>
      <div class="ct-main">
        <Head p={p} ctx={ctx} avatar={0} folded={folded} size={n.size} />
        {folded ? (
          !compact && (
            <button class="ct-unfold" onClick={() => ctx.fold(p.id)} aria-expanded={false}>
              Show
            </button>
          )
        ) : (
          <>
            <Body p={p} ctx={ctx} />
            {n.children.length > 0 &&
              (depth + 1 >= MAX_DEPTH ? (
                <a class="ct-continue" href={ctx.kit.feed.postHref(ctx.network, p.id)}>
                  Continue this thread ({n.size}) ›
                </a>
              ) : (
                <div class="ct-kids">
                  {n.children.map((c) => (
                    <Node key={c.post.id} n={c} depth={depth + 1} ctx={ctx} compact={compact} />
                  ))}
                </div>
              ))}
            <MoreUnder n={n} ctx={ctx} />
          </>
        )}
      </div>
    </div>
  );
}

/** Flat: a reply to the post, then everything under it in one level, oldest first, each saying whom it answers. */
function FlatBranch({ n, ctx }: { n: TreeNode; ctx: CommentCtx }) {
  const below: { node: TreeNode; to: string | null }[] = [];
  const walk = (x: TreeNode) =>
    x.children.forEach((c) => {
      below.push({ node: c, to: x.post.author ?? null });
      walk(c);
    });
  walk(n);
  below.sort((a, b) => a.node.post.ts - b.node.post.ts);
  const folded = ctx.folded.has(n.post.id);
  return (
    <div class="ct-flat" data-post={n.post.id}>
      <div class="ct-flat-top">
        <Head p={n.post} ctx={ctx} avatar={32} folded={false} size={0} />
        <Body p={n.post} ctx={ctx} />
      </div>
      {below.length > 0 && (
        <button class="ct-flat-toggle" onClick={() => ctx.fold(n.post.id)} aria-expanded={!folded}>
          {folded ? `▸ ${below.length} ${below.length === 1 ? 'reply' : 'replies'}` : `▾ Hide ${below.length === 1 ? 'reply' : 'replies'}`}
        </button>
      )}
      {!folded && below.length > 0 && (
        <div class="ct-flat-kids">
          {below.map(({ node, to }) => (
            <div class="ct-flat-reply" key={node.post.id} data-post={node.post.id}>
              <Head p={node.post} ctx={ctx} avatar={24} folded={false} size={0} />
              {to && node.post.author !== to && <span class="ct-to">to @{ctx.kit.handle(to) ?? ctx.kit.name(to)}</span>}
              <Body p={node.post} ctx={ctx} />
              <MoreUnder n={node} ctx={ctx} />
            </div>
          ))}
        </div>
      )}
      <MoreUnder n={n} ctx={ctx} />
    </div>
  );
}

/** The replies, in the reader's style. */
export function Comments({ nodes, style, ctx }: { nodes: TreeNode[]; style: CommentStyle; ctx: CommentCtx }) {
  if (style === 'chains') {
    const byId = new Map<string, TreeNode>();
    const index = (x: TreeNode) => (byId.set(x.post.id, x), x.children.forEach(index));
    nodes.forEach(index);
    const tops = new Set(nodes.map((x) => x.post.id));
    return (
      <>
        {treeChains(nodes).map((chain) => {
          const first = chain[0];
          const to = !tops.has(first.id) && first.replyTo?.author ? ctx.kit.handle(first.replyTo.author) : null;
          return (
            <div class="thread-chain" key={first.id}>
              {chain.map((p, i) => (
                <Row p={p} kit={ctx.kit} network={ctx.network} line={i < chain.length - 1} above={i === 0 && to ? <span class="post-mark">Replying to @{to}</span> : undefined} below={ctx.below?.(p)} />
              ))}
              {chain.map((p) => byId.get(p.id)).map((x) => x && <MoreUnder n={x} ctx={ctx} under />)}
            </div>
          );
        })}
      </>
    );
  }
  if (style === 'flat')
    return (
      <div class="ct ct-flatlist">
        {nodes.map((n) => (
          <FlatBranch key={n.post.id} n={n} ctx={ctx} />
        ))}
      </div>
    );
  return (
    <div class={`ct ${style === 'compact' ? 'compact' : 'tree'}`}>
      {nodes.map((n) => (
        <Node key={n.post.id} n={n} depth={0} ctx={ctx} compact={style === 'compact'} />
      ))}
    </div>
  );
}
