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
import { Fragment, h } from 'preact';
import type * as P from '@dither-chat/protocol';
import { NETWORK_META } from '@dither-chat/protocol';
// Its own path, so the rules ride in this chunk, not the app's start.
import { postRulesFor } from '@dither-chat/protocol/compose';
import { useEffect, useRef, useState } from 'preact/hooks';
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
}

/** Who liked or reposted, ranked: a page from the hub, more on asking. */
export function ReactorsList({ network, post, kind, kit, count, compact }: { network: P.Network; post: string; kind: 'like' | 'repost'; kit: Kit; count?: number; compact?: boolean }) {
  const [v, setV] = useState<P.ReactorsView | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [more, setMore] = useState(false);
  const take = (page: P.ReactorsView) => page.identities.forEach((i) => db.identities.has(i.id) || db.identities.set(i.id, i));
  useEffect(() => {
    let live = true;
    setV(null);
    setError(null);
    api<P.ReactorsView>(`/api/posts/${network}/${post}/reactors?kind=${kind}`).then(
      (page) => {
        if (!live) return;
        take(page);
        setV(page);
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
        const seen = new Set(v.people.map((p) => p.identityId));
        setV({ ...v, people: [...v.people, ...page.people.filter((p) => !seen.has(p.identityId))], more: page.more });
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
}: {
  kind: 'reply' | 'repost' | 'like';
  on: boolean;
  n?: number;
  label: string;
  onPress: (e: MouseEvent) => void;
  who: (() => h.JSX.Element) | null;
  kit: Kit;
  disabled?: boolean;
}) {
  const [shown, setShown] = useState<'pop' | 'sheet' | null>(null);
  const enter = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const leave = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const press = kit.useLongPress(() => who && setShown('sheet'));
  const hover = {
    onPointerEnter: (e: PointerEvent) => {
      if (!who || e.pointerType === 'touch') return;
      clearTimeout(leave.current);
      enter.current = setTimeout(() => setShown('pop'), HOVER_MS);
    },
    onPointerLeave: () => {
      clearTimeout(enter.current);
      leave.current = setTimeout(() => setShown((s) => (s === 'pop' ? null : s)), LEAVE_MS);
    },
  };
  useEffect(() => () => (clearTimeout(enter.current), clearTimeout(leave.current)), []);
  return (
    <span class="pa-slot" {...hover}>
      <button
        class={`pa-btn ${kind} ${on ? 'on' : ''}`}
        aria-pressed={kind === 'reply' ? undefined : on}
        aria-label={`${label}${n !== undefined ? `, ${n.toLocaleString()}` : ''}`}
        title={who ? `${label} · hold or hover to see who` : label}
        onClick={onPress}
        disabled={disabled}
        {...press}
        onKeyDown={(e) => who && (e.key === 'ArrowDown' || (e.key === 'Enter' && e.shiftKey)) && (e.preventDefault(), setShown('pop'))}
      >
        <kit.Icon name={kind === 'like' ? 'heart' : kind === 'repost' ? 'repeat' : 'reply'} size={16} />
        {n !== undefined && n > 0 && <span class="pa-n">{kit.feed.shortCount(n)}</span>}
      </button>
      {shown === 'pop' && who && (
        <div class="pa-pop" role="dialog" aria-label={kind === 'like' ? 'Liked by' : 'Reposted by'} onPointerEnter={() => clearTimeout(leave.current)} onKeyDown={(e) => e.key === 'Escape' && setShown(null)}>
          {who()}
        </div>
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
 * thread is about. Changes show at once; the network's answer settles them.
 */
export function PostActions({ p, ctx, big }: { p: P.PostFact; ctx: AnswerCtx; big?: boolean }) {
  const { kit, network } = ctx;
  const rules = postRulesFor(network);
  const [viewer, setViewer] = useState<P.PostViewer>(p.viewer ?? {});
  const [counts, setCounts] = useState(p.counts ?? {});
  const [busy, setBusy] = useState<string | null>(null);
  const [menu, setMenu] = useState(false);
  useEffect(() => {
    setViewer(p.viewer ?? {});
    setCounts(p.counts ?? {});
  }, [p.id, p.viewer?.liked, p.viewer?.reposted, p.counts?.likes, p.counts?.reposts]);
  if (!rules) return null;
  const mine = kit.isSelf(p.author ?? null);
  const act = (act: P.PostAct) => {
    const key = act.endsWith('like') ? 'liked' : 'reposted';
    const count = key === 'liked' ? 'likes' : 'reposts';
    const on = !act.startsWith('un');
    const before = { viewer, counts };
    setViewer({ ...viewer, [key]: on });
    if (counts[count] !== undefined && !!viewer[key] !== on) setCounts({ ...counts, [count]: Math.max(0, counts[count]! + (on ? 1 : -1)) });
    setBusy(key);
    api<{ viewer: P.PostViewer }>(`/api/posts/${network}/${p.id}/act`, { method: 'POST', body: { act } }).then(
      (r) => {
        setViewer((v) => ({ ...v, ...r.viewer }));
        setBusy(null);
      },
      (e) => {
        setViewer(before.viewer);
        setCounts(before.counts);
        setBusy(null);
        kit.toast({ title: `Could not ${act.replace(/^un/, 'undo ')}`, body: (e as Error).message, kind: 'error' });
      },
    );
  };
  // X shows who liked a post only to its author; who reposted to anyone.
  const likers = rules.likersVisible === 'all' || (rules.likersVisible === 'author' && mine);
  const list = (kind: 'like' | 'repost', n?: number) => () => <ReactorsList network={network} post={p.id} kind={kind} kit={kit} count={n} compact />;
  return (
    <div class={`post-actions ${big ? 'big' : ''}`} role="group" aria-label="Answer">
      {rules.actions.reply && ctx.onReply && <CountButton kind="reply" on={false} n={counts.replies} label={rules.words.reply} onPress={(e) => (e.stopPropagation(), ctx.onReply!(p))} who={null} kit={kit} />}
      {rules.actions.repost && (
        <span class="pa-menu-wrap">
          <CountButton
            kind="repost"
            on={!!viewer.reposted}
            n={counts.reposts}
            label={viewer.reposted ? 'Undo repost' : 'Repost'}
            onPress={(e) => (e.stopPropagation(), setMenu(!menu))}
            who={(counts.reposts ?? 0) > 0 ? list('repost', counts.reposts) : null}
            kit={kit}
            disabled={busy === 'reposted'}
          />
          {menu && (
            <div class="pa-menu" role="menu" onKeyDown={(e) => e.key === 'Escape' && setMenu(false)}>
              <button role="menuitem" onClick={() => (setMenu(false), act(viewer.reposted ? 'unrepost' : 'repost'))}>
                <kit.Icon name="repeat" size={14} /> {viewer.reposted ? 'Undo repost' : 'Repost'}
              </button>
              {rules.actions.quote && ctx.onQuote && (
                <button role="menuitem" onClick={() => (setMenu(false), ctx.onQuote!(p))}>
                  <kit.Icon name="quote" size={14} /> {rules.words.quote}
                </button>
              )}
            </div>
          )}
        </span>
      )}
      {rules.actions.like && (
        <CountButton
          kind="like"
          on={!!viewer.liked}
          n={counts.likes}
          label={viewer.liked ? 'Unlike' : 'Like'}
          onPress={(e) => (e.stopPropagation(), act(viewer.liked ? 'unlike' : 'like'))}
          who={likers && (counts.likes ?? 0) > 0 ? list('like', counts.likes) : null}
          kit={kit}
          disabled={busy === 'liked'}
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
