/** @jsxRuntime classic */
/** @jsx h */
/** @jsxFrag Fragment */
/**
 * A post's replies drawn as a comment section (docs/feed.md "Threads"), from the tree tree.ts makes. Four ways, the
 * reader's choice, kept on the device:
 *
 * - **Tree** (as Reddit, with LessWrong's thin lines): each reply under the one it answers, a hairline down its left
 *   that folds the branch when clicked, "Continue this thread" past six levels in. A reply with one answer goes on in
 *   the same column (a run), so a back-and-forth reads down the page instead of stepping right each turn; only a
 *   reply with two answers or more branches, and indents. A run longer than eight shows its first three and last two.
 * - **Compact** (as Hacker News): the same tree and runs without pictures, and [–] to fold.
 * - **Flat** (as YouTube and Discourse): replies to the post, each with every answer under it in one level, oldest
 *   first, saying whom each answers.
 * - **Chains** (as X): each reply and the answers under it as a chain joined by its pictures.
 *
 * "N more replies" (the network counts more under a reply than are known) loads by itself as it comes near the screen
 * (ctx.auto, a few at a time); its button stays for when that is used up or fails.
 */
import { Fragment, h, type ComponentChildren } from 'preact';
import type * as P from '@dither-chat/protocol';
import { openProfile } from '../../state.ts';
import { useEffect, useRef, useState } from 'preact/hooks';
import type { Kit } from './lazy.tsx';
import { Counts, Pics, QuotedIn, Row, Text, Who } from './Post.tsx';
import { runOf, runPair, treeChains, type TreeNode } from './tree.ts';

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
/** A run longer than this shows its first RUN_HEAD and last RUN_TAIL, with the rest behind a button. */
export const RUN_FOLD = 8;
const RUN_HEAD = 3;
const RUN_TAIL = 2;

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
  /** Load a reply's hidden answers without a press, as it nears the screen (the thread decides how many and when). */
  auto?: (n: TreeNode) => void;
  /** What "near the screen" is measured against: the thread's scroller. */
  root?: { current: HTMLElement | null };
  /** What goes under a reply in place of its counts: its actions, and a composer when answering it. */
  below?: (p: P.PostFact) => ComponentChildren;
}

function MoreUnder({ n, ctx, under }: { n: TreeNode; ctx: CommentCtx; under?: boolean }) {
  const id = n.post.id;
  const busy = ctx.loading.has(id);
  const why = ctx.failed.get(id);
  const wanted = !!n.hidden && !ctx.done.has(id) && !busy && !why;
  const box = useRef<HTMLSpanElement>(null);
  // Near the screen (two screens or so ahead: X takes seconds to answer), it loads by itself.
  useEffect(() => {
    const el = box.current;
    if (!wanted || !ctx.auto || !el || typeof IntersectionObserver === 'undefined') return;
    const io = new IntersectionObserver((es) => es.some((e) => e.isIntersecting) && (io.disconnect(), ctx.auto!(n)), { root: ctx.root?.current ?? null, rootMargin: '1600px 0px' });
    io.observe(el);
    return () => io.disconnect();
  }, [wanted, id]);
  if (!n.hidden || ctx.done.has(id)) return null;
  const who = under ? ` under ${ctx.kit.name(n.post.author ?? null)}` : '';
  const many = `${n.hidden} more ${n.hidden === 1 ? 'reply' : 'replies'}`;
  return (
    <span class="ct-more-wrap" ref={box}>
      <button class="ct-more" onClick={() => ctx.load(n)} disabled={busy}>
        {busy ? `Loading ${many}…` : why ? 'Try again' : `${many}${who}`}
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

/** One post of a run, after the first: its head with a small picture, what it says, and what may load under it. */
function Step({ n, ctx, compact }: { n: TreeNode; ctx: CommentCtx; compact: boolean }) {
  return (
    <div class="ct-step" data-post={n.post.id}>
      <Head p={n.post} ctx={ctx} avatar={compact ? 0 : 20} folded={false} size={0} />
      <Body p={n.post} ctx={ctx} />
      <MoreUnder n={n} ctx={ctx} />
    </div>
  );
}

/** Tree and Compact: one reply and the run that goes on from it in its column, its rail, and the branches under it. */
function Node({ n, depth, ctx, compact }: { n: TreeNode; depth: number; ctx: CommentCtx; compact: boolean }) {
  const p = n.post;
  const folded = ctx.folded.has(p.id);
  const name = ctx.kit.name(p.author ?? null);
  const run = runOf(n);
  const last = run[run.length - 1];
  const steps = run.slice(1);
  // A long run shows its ends; `run:<id>` in "folded" means its middle was opened.
  const whole = run.length <= RUN_FOLD || ctx.folded.has(`run:${p.id}`);
  const head = whole ? steps : steps.slice(0, RUN_HEAD - 1);
  const tail = whole ? [] : steps.slice(-RUN_TAIL);
  const gap = steps.length - head.length - tail.length;
  const pair = runPair(run);
  const between = pair ? ` between ${ctx.kit.name(pair[0])} and ${ctx.kit.name(pair[1])}` : '';
  return (
    <div class={`ct-node ${folded ? 'folded' : ''}`} data-post={p.id} data-depth={depth}>
      <div class="ct-side">
        {compact && (
          <button class="ct-toggle" onClick={() => ctx.fold(p.id)} aria-expanded={!folded} aria-label={folded ? `Unfold ${name}'s reply` : `Fold ${name}'s reply`}>
            {folded ? '[+]' : '[–]'}
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
        <Head p={p} ctx={ctx} avatar={compact ? 0 : 20} folded={folded} size={n.size} />
        {folded ? (
          !compact && (
            <button class="ct-unfold" onClick={() => ctx.fold(p.id)} aria-expanded={false}>
              Show
            </button>
          )
        ) : (
          <>
            <Body p={p} ctx={ctx} />
            {run.length > 1 && <MoreUnder n={n} ctx={ctx} />}
            {steps.length > 0 && (
              <div class={`ct-run ${pair ? 'pair' : ''}`} aria-label={pair ? `Back and forth${between}` : undefined}>
                {head.map((x) => (
                  <Step key={x.post.id} n={x} ctx={ctx} compact={compact} />
                ))}
                {gap > 0 && (
                  <button class="ct-run-gap" onClick={() => ctx.fold(`run:${p.id}`)}>
                    {gap} more{between}
                  </button>
                )}
                {tail.map((x) => (
                  <Step key={x.post.id} n={x} ctx={ctx} compact={compact} />
                ))}
              </div>
            )}
            {last.children.length > 0 &&
              (depth + 1 >= MAX_DEPTH ? (
                <a class="ct-continue" href={ctx.kit.feed.postHref(ctx.network, last.post.id)}>
                  Continue this thread ({last.size}) ›
                </a>
              ) : (
                <div class="ct-kids">
                  {last.children.map((c) => (
                    <Node key={c.post.id} n={c} depth={depth + 1} ctx={ctx} compact={compact} />
                  ))}
                </div>
              ))}
            {run.length === 1 && <MoreUnder n={n} ctx={ctx} />}
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
