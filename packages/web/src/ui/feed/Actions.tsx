/** @jsxRuntime classic */
/** @jsx h */
/** @jsxFrag Fragment */
/**
 * What can be done to a post, under it (docs/feed.md "Answering"): reply, repost (Repost or Quote, as X asks), like,
 * and the views X counts. Like and repost are one press each, shown at once and taken back if the network says no.
 * Who liked or reposted shows on hovering the button for a moment (a long press on a phone, as Discord shows who
 * reacted): ranked for you by the hub (reactors.ts), each opening their profile. Where the network shows likers only
 * to the author (X), only your own posts' likers can be seen.
 */
import { createPortal, Fragment, h, type ComponentChildren } from 'preact';
import type * as P from '@dither-chat/protocol';
import { NETWORK_META } from '@dither-chat/protocol';
// Its own path, so the rules ride in this chunk, not the app's start.
import { postRulesFor } from '@dither-chat/protocol/compose';
import { useEffect, useLayoutEffect, useRef, useState } from 'preact/hooks';
import { api, db, openProfile } from '../../state.ts';
import type { Kit } from './lazy.tsx';

const HOVER_MS = 450;
const LEAVE_MS = 220;

export interface AnswerCtx {
  kit: Kit;
  network: P.Network;
  /** Reply to this post: the page opens a composer under it. */
  onReply?: (p: P.PostFact) => void;
  /** Quote this post. */
  onQuote?: (p: P.PostFact) => void;
  /**
   * What you did to posts on this page, kept by the page so a bar drawn again (another style, a branch unfolded)
   * shows it: the post's viewer and counts as last changed here.
   */
  acted?: ReadonlyMap<string, { viewer: P.PostViewer; counts: P.PostFact['counts'] }>;
  onActed?: (post: string, s: { viewer: P.PostViewer; counts: P.PostFact['counts'] }) => void;
}

/** Answers kept a while per post and kind: hovering back and forth reads once (the hub keeps them too). */
const seen = new Map<string, { at: number; v: P.ReactorsView }>();
const SEEN_MS = 5 * 60_000;

/**
 * A panel over the page, at the body so no scrolling box clips it (a chain's `overflow: hidden`): under its anchor,
 * above when there is no room, inside the window. Closes on Escape and on a press outside it and its anchor.
 */
function Floating({ anchor, onClose, children, label, role = 'dialog', hover }: { anchor: HTMLElement | null; onClose: () => void; children: ComponentChildren; label: string; role?: 'dialog' | 'menu'; hover?: { enter: () => void; leave: () => void } }) {
  const panel = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState<{ top: number; left: number } | null>(null);
  useLayoutEffect(() => {
    const place = () => {
      const a = anchor?.getBoundingClientRect();
      const el = panel.current;
      if (!a || !el) return;
      const w = el.offsetWidth;
      const h = el.offsetHeight;
      const below = a.bottom + 6 + h <= innerHeight - 8 || a.top - 6 - h < 8;
      setPos({ top: below ? a.bottom + 6 : a.top - 6 - h, left: Math.max(8, Math.min(a.left, innerWidth - w - 8)) });
    };
    place();
    const ro = new ResizeObserver(place);
    if (panel.current) ro.observe(panel.current);
    addEventListener('scroll', place, true);
    addEventListener('resize', place);
    return () => (ro.disconnect(), removeEventListener('scroll', place, true), removeEventListener('resize', place));
  }, [anchor]);
  useEffect(() => {
    const down = (e: PointerEvent) => {
      const t = e.target as Node;
      if (!panel.current?.contains(t) && !anchor?.contains(t)) onClose();
    };
    const key = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return;
      onClose();
      anchor?.focus();
    };
    addEventListener('pointerdown', down, true);
    addEventListener('keydown', key);
    return () => (removeEventListener('pointerdown', down, true), removeEventListener('keydown', key));
  }, [anchor]);
  return createPortal(
    <div
      ref={panel}
      class={`pa-float ${role === 'menu' ? 'pa-menu' : 'pa-pop'}`}
      role={role}
      aria-label={label}
      style={pos ? { top: `${pos.top}px`, left: `${pos.left}px` } : { visibility: 'hidden', top: '0', left: '0' }}
      onPointerEnter={hover?.enter}
      onPointerLeave={hover?.leave}
    >
      {children}
    </div>,
    document.body,
  );
}

/** Who liked or reposted, ranked: a page from the hub, more on asking. */
export function ReactorsList({ network, post, kind, kit, count, compact }: { network: P.Network; post: string; kind: 'like' | 'repost'; kit: Kit; count?: number; compact?: boolean }) {
  const [v, setV] = useState<P.ReactorsView | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [more, setMore] = useState(false);
  const take = (page: P.ReactorsView) => page.identities.forEach((i) => db.identities.has(i.id) || db.identities.set(i.id, i));
  useEffect(() => {
    let live = true;
    const k = `${network}:${post}:${kind}`;
    const had = seen.get(k);
    if (had && Date.now() - had.at < SEEN_MS) {
      setV(had.v);
      return;
    }
    setV(null);
    setError(null);
    api<P.ReactorsView>(`/api/posts/${network}/${post}/reactors?kind=${kind}`).then(
      (page) => {
        take(page);
        seen.set(k, { at: Date.now(), v: page });
        if (live) setV(page);
      },
      (e) => live && setError((e as Error).message),
    );
    return () => void (live = false);
  }, [network, post, kind]);
  const loadMore = () => {
    if (!v?.more) return;
    setMore(true);
    api<P.ReactorsView>(`/api/posts/${network}/${post}/reactors?kind=${kind}&cursor=${encodeURIComponent(v.more)}`).then(
      (page) => {
        take(page);
        const have = new Set(v.people.map((p) => p.identityId));
        // One list, most relevant first across the pages read.
        const next = { ...v, people: [...v.people, ...page.people.filter((p) => !have.has(p.identityId))].sort((a, b) => b.score - a.score), more: page.more };
        seen.set(`${network}:${post}:${kind}`, { at: Date.now(), v: next });
        setV(next);
        setMore(false);
      },
      () => setMore(false),
    );
  };
  const named = v?.people.length ?? 0;
  const unnamed = count !== undefined ? count - named : 0;
  return (
    <div class={`post-reactors ${compact ? 'compact' : ''}`} data-reactors={kind}>
      <div class="post-reactors-head">
        <kit.Icon name={kind === 'like' ? 'heart' : 'repeat'} size={13} />
        <b>{kind === 'like' ? 'Liked by' : 'Reposted by'}</b>
        {count !== undefined && <span class="post-handle">{kit.feed.shortCount(count)}</span>}
        <span class="post-reactors-sort" title="Who you talk with, who follows you and who many follow first">most relevant first</span>
      </div>
      {!v && !error && <kit.Loading inline label="Reading who…" />}
      {error && <p class="post-reactors-note">{error}</p>}
      {v && (
        <ul class="post-reactors-list">
          {v.people.map((r) => (
            <li>
              <button class="post-reactor" onClick={() => openProfile(r.identityId)} title={`${kit.name(r.identityId)}'s profile`}>
                <kit.Avatar id={r.identityId} name={kit.name(r.identityId)} url={kit.avatarUrl(r.identityId)} size={30} />
                <span class="post-reactor-who">
                  <span class="post-reactor-name">
                    <b>{kit.name(r.identityId)}</b>
                    {kit.handle(r.identityId) && <span class="post-handle">@{kit.handle(r.identityId)}</span>}
                  </span>
                  {r.why.length > 0 && <span class="post-reactor-why">{r.why.slice(0, 2).join(' · ')}</span>}
                </span>
                {r.ts && (
                  <span class="post-handle" title={kit.fullTime(r.ts)}>
                    {kit.ago(r.ts)}
                  </span>
                )}
              </button>
            </li>
          ))}
        </ul>
      )}
      {v?.more && (
        <button class="ct-more post-reactors-more" onClick={loadMore} disabled={more}>
          {more ? 'Loading…' : 'Show more'}
        </button>
      )}
      {v && !v.more && (v.note || (v.from === 'notifications' && unnamed > 0)) && (
        <p class="post-reactors-note">
          {v.note ?? ''}
          {v.from === 'notifications' && unnamed > 0 ? ` ${NETWORK_META[network].name} counts ${count!.toLocaleString()}; your notifications named ${named}.` : ''}
        </p>
      )}
      {v && !v.people.length && !v.note && <p class="post-reactors-note">Nobody yet.</p>}
    </div>
  );
}

/** A count's button: its press does the thing; hovering it a moment (or a long press) shows who. */
function CountButton({
  kind,
  on,
  n,
  label,
  onPress,
  who,
  kit,
  disabled,
  menu,
}: {
  kind: 'reply' | 'repost' | 'like';
  on: boolean;
  n?: number;
  label: string;
  onPress: () => void;
  who: (() => h.JSX.Element) | null;
  kit: Kit;
  disabled?: boolean;
  /** It opens a menu (Repost): said to assistive tech, and the menu drawn over the page. */
  menu?: { open: boolean; close: () => void; items: ComponentChildren };
}) {
  const [shown, setShown] = useState<'pop' | 'sheet' | null>(null);
  const btn = useRef<HTMLButtonElement>(null);
  const enter = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const leave = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const press = kit.useLongPress(() => who && setShown('sheet'));
  const stay = () => clearTimeout(leave.current);
  const go = () => {
    clearTimeout(enter.current);
    leave.current = setTimeout(() => setShown((s) => (s === 'pop' ? null : s)), LEAVE_MS);
  };
  useEffect(() => () => (clearTimeout(enter.current), clearTimeout(leave.current)), []);
  return (
    <span
      class="pa-slot"
      onPointerEnter={(e) => {
        if (!who || e.pointerType === 'touch' || menu?.open) return;
        stay();
        enter.current = setTimeout(() => setShown('pop'), HOVER_MS);
      }}
      onPointerLeave={go}
    >
      <button
        ref={btn}
        class={`pa-btn ${kind} ${on ? 'on' : ''}`}
        aria-pressed={kind === 'reply' || menu ? undefined : on}
        aria-haspopup={menu ? 'menu' : undefined}
        aria-expanded={menu ? menu.open : undefined}
        aria-label={`${label}${n !== undefined ? `, ${n.toLocaleString()}` : ''}`}
        title={who ? `${label} · hold or hover to see who` : label}
        onClick={(e) => {
          e.stopPropagation();
          // A press is not a hover: no list opening under the menu or after the like.
          clearTimeout(enter.current);
          setShown(null);
          onPress();
        }}
        disabled={disabled}
        {...press}
        onKeyDown={(e) => {
          // Holding Enter or Space would press it again and again.
          if (e.repeat && (e.key === 'Enter' || e.key === ' ')) e.preventDefault();
          if (who && e.key === 'ArrowDown') (e.preventDefault(), setShown('pop'));
        }}
      >
        <kit.Icon name={kind === 'like' ? 'heart' : kind === 'repost' ? 'repeat' : 'reply'} size={16} />
        {n !== undefined && n > 0 && <span class="pa-n">{kit.feed.shortCount(n)}</span>}
      </button>
      {menu?.open && (
        <Floating anchor={btn.current} onClose={menu.close} label={label} role="menu">
          {menu.items}
        </Floating>
      )}
      {shown === 'pop' && who && (
        <Floating anchor={btn.current} onClose={() => setShown(null)} label={kind === 'like' ? 'Liked by' : 'Reposted by'} hover={{ enter: stay, leave: go }}>
          {who()}
        </Floating>
      )}
      {shown === 'sheet' && who && (
        <kit.Sheet onClose={() => setShown(null)} label={kind === 'like' ? 'Liked by' : 'Reposted by'}>
          {who()}
        </kit.Sheet>
      )}
    </span>
  );
}

/**
 * The bar under a post: reply, repost (a menu: Repost or Undo, and Quote), like, views. `big`: under the post a
 * thread is about. Changes show at once; the network's answer settles them, and a refusal takes back only its own.
 */
export function PostActions({ p, ctx, big }: { p: P.PostFact; ctx: AnswerCtx; big?: boolean }) {
  const { kit, network } = ctx;
  const rules = postRulesFor(network);
  const kept = ctx.acted?.get(p.id);
  const [viewer, setViewer] = useState<P.PostViewer>(kept?.viewer ?? p.viewer ?? {});
  const [counts, setCounts] = useState(kept?.counts ?? p.counts ?? {});
  const [busy, setBusy] = useState<ReadonlySet<string>>(new Set());
  const [menu, setMenu] = useState(false);
  useEffect(() => {
    const k = ctx.acted?.get(p.id);
    setViewer(k?.viewer ?? p.viewer ?? {});
    setCounts(k?.counts ?? p.counts ?? {});
  }, [p.id, p.viewer?.liked, p.viewer?.reposted, p.counts?.likes, p.counts?.reposts]);
  if (!rules) return null;
  const mine = kit.isSelf(p.author ?? null);
  const act = (act: P.PostAct) => {
    const key = act.endsWith('like') ? 'liked' : 'reposted';
    const count = key === 'liked' ? 'likes' : 'reposts';
    if (busy.has(key)) return;
    const on = !act.startsWith('un');
    const was = !!viewer[key];
    const nextViewer = { ...viewer, [key]: on };
    const nextCounts = counts[count] !== undefined && was !== on ? { ...counts, [count]: Math.max(0, counts[count]! + (on ? 1 : -1)) } : counts;
    setViewer(nextViewer);
    setCounts(nextCounts);
    ctx.onActed?.(p.id, { viewer: nextViewer, counts: nextCounts });
    setBusy((b) => new Set(b).add(key));
    const done = () =>
      setBusy((b) => {
        const n = new Set(b);
        n.delete(key);
        return n;
      });
    api<{ viewer: P.PostViewer }>(`/api/posts/${network}/${p.id}/act`, { method: 'POST', body: { act } }).then(
      (r) => {
        done();
        setViewer((v) => {
          const n = { ...v, [key]: r.viewer[key] ?? on };
          ctx.onActed?.(p.id, { viewer: n, counts: nextCounts });
          return n;
        });
      },
      (e) => {
        done();
        // Only this one goes back: a repost pressed meanwhile stands.
        setViewer((v) => ({ ...v, [key]: was }));
        setCounts((c) => (c[count] !== undefined && was !== on ? { ...c, [count]: Math.max(0, c[count]! + (on ? -1 : 1)) } : c));
        kit.toast({ title: `Could not ${act.replace(/^un/, 'undo ')}`, body: (e as Error).message, kind: 'error' });
      },
    );
  };
  // X shows who liked a post only to its author; who reposted to anyone.
  const likers = rules.likersVisible === 'all' || (rules.likersVisible === 'author' && mine);
  const list = (kind: 'like' | 'repost', n?: number) => () => <ReactorsList network={network} post={p.id} kind={kind} kit={kit} count={n} compact />;
  return (
    <div class={`post-actions ${big ? 'big' : ''}`} role="group" aria-label="Answer">
      {rules.actions.reply && ctx.onReply && <CountButton kind="reply" on={false} n={counts.replies} label={rules.words.reply} onPress={() => ctx.onReply!(p)} who={null} kit={kit} />}
      {rules.actions.repost && (
        <CountButton
          kind="repost"
          on={!!viewer.reposted}
          n={counts.reposts}
          label={viewer.reposted ? 'Undo repost' : 'Repost'}
          onPress={() => setMenu(!menu)}
          who={(counts.reposts ?? 0) > 0 ? list('repost', counts.reposts) : null}
          kit={kit}
          disabled={busy.has('reposted')}
          menu={{
            open: menu,
            close: () => setMenu(false),
            items: (
              <>
                <button role="menuitem" autoFocus onClick={() => (setMenu(false), act(viewer.reposted ? 'unrepost' : 'repost'))}>
                  <kit.Icon name="repeat" size={14} /> {viewer.reposted ? 'Undo repost' : 'Repost'}
                </button>
                {rules.actions.quote && ctx.onQuote && (
                  <button role="menuitem" onClick={() => (setMenu(false), ctx.onQuote!(p))}>
                    <kit.Icon name="quote" size={14} /> {rules.words.quote}
                  </button>
                )}
              </>
            ),
          }}
        />
      )}
      {rules.actions.like && (
        <CountButton
          kind="like"
          on={!!viewer.liked}
          n={counts.likes}
          label={viewer.liked ? 'Unlike' : 'Like'}
          onPress={() => act(viewer.liked ? 'unlike' : 'like')}
          who={likers && (counts.likes ?? 0) > 0 ? list('like', counts.likes) : null}
          kit={kit}
          disabled={busy.has('liked')}
        />
      )}
      {(counts.views ?? 0) > 0 && (
        <span class="pa-views" title={`${counts.views!.toLocaleString()} views`}>
          <kit.Icon name="eye" size={15} /> {kit.feed.shortCount(counts.views!)}
        </span>
      )}
    </div>
  );
}
