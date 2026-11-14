/** @jsxRuntime classic */
/** @jsx h */
/** @jsxFrag Fragment */
/**
 * A post, drawn the same wherever it shows (docs/feed.md "The feed's page"): in a thread, under one of your posts in the
 * feed, in the posts the hub logged, on a profile. Nothing here is X's: a post is who, when, words, pictures, what it
 * quotes and its counts, which a Mastodon toot, a Reddit or YouTube comment or a Discourse reply also is.
 */
import { Fragment, h, type ComponentChildren } from 'preact';
import type * as P from '@dither-chat/protocol';
import { useEffect, useState } from 'preact/hooks';
import { loadTranslation, openProfile, translation } from '../../state.ts';
import type { Kit } from './lazy.tsx';
import { askTranslation, trRev, trState } from './translate.ts';

/**
 * One post's text with its links (and on X its @handles); in another language, translated (docs/translate.md): by
 * itself when the settings say so, else on "Translate post". Shown under the original ("Translated from Japanese by
 * Grok via X · Hide") or in its place ("· Show original"), as the settings say; either way a press goes back.
 */
export function Text({ p, kit, network, cls }: { p: P.PostFact; kit: Kit; network: P.Network; cls: string }) {
  trRev.value;
  const tr = translation.value;
  useEffect(() => void loadTranslation(), []);
  const [asked, setAsked] = useState(false);
  // The reader's own choice on this post: the original in place of the translation, or the translation hidden.
  const [flipped, setFlipped] = useState(false);
  const set = tr?.settings;
  const can = !!set && !!p.text && kit.translate.needsTranslation(p.lang, set.to) && (tr!.networks.includes(network) || !!set.serverUrl);
  const want = can && (set!.auto || asked);
  const item: P.TranslateItem | null = want ? { key: `${network}:${p.id}`, text: p.text, network, post: p.id, ...(p.lang ? { lang: p.lang } : {}) } : null;
  useEffect(() => {
    if (item && set) askTranslation(item, set.to);
  }, [item?.key, set?.to]);
  if (!p.text) return null;
  const original = (
    <p class={cls}>
      <kit.Linked text={p.text} network={network} markdown={false} />
    </p>
  );
  if (!can || !set) return original;
  const stop = (e: Event) => e.stopPropagation();
  if (!want)
    return (
      <>
        {original}
        <button class="tr-ask" onClick={(e) => (stop(e), setAsked(true))}>
          Translate post
        </button>
      </>
    );
  const st = trState(set.to, item!.key);
  const from = kit.translate.languageName((st?.s === 'done' && st.t.from) || p.lang || '');
  if (!st || st.s === 'loading')
    return (
      <>
        {original}
        <span class="tr-note tr-busy" aria-live="polite">
          <kit.Icon name="globe" size={12} /> Translating from {from}…
        </span>
      </>
    );
  if (st.s === 'failed')
    return (
      <>
        {original}
        <span class="tr-note tr-failed">
          <kit.Icon name="globe" size={12} /> Could not translate: {st.why}
          <button class="tr-btn" onClick={(e) => (stop(e), askTranslation(item!, set.to, true))}>
            Try again
          </button>
        </span>
      </>
    );
  const said = `Translated from ${from} by ${st.t.by}`;
  const translated = (
    <p class={`${cls} tr-text`} lang={set.to}>
      <kit.Linked text={st.t.text} network={network} markdown={false} />
    </p>
  );
  if (set.show === 'replace')
    return (
      <>
        {flipped ? original : translated}
        <span class="tr-note">
          <kit.Icon name="globe" size={12} /> {flipped ? `Written in ${from}` : said} ·{' '}
          <button class="tr-btn" aria-pressed={flipped} onClick={(e) => (stop(e), setFlipped(!flipped))}>
            {flipped ? 'Show translation' : 'Show original'}
          </button>
        </span>
      </>
    );
  return (
    <>
      {original}
      {flipped ? (
        <button class="tr-ask" onClick={(e) => (stop(e), setFlipped(false))}>
          Show translation
        </button>
      ) : (
        <div class="tr-box">
          <span class="tr-note">
            <kit.Icon name="globe" size={12} /> {said} ·{' '}
            <button class="tr-btn" onClick={(e) => (stop(e), setFlipped(true))}>
              Hide
            </button>
          </span>
          {translated}
        </div>
      )}
    </>
  );
}

/** Pictures in a thread: each opens the full picture. */
export function Pics({ media }: { media?: P.PostMedia[] }) {
  const shown = (media ?? []).slice(0, 4);
  if (!shown.length) return null;
  return (
    <div class={`post-media n${shown.length}`}>
      {shown.map((m) => (
        <a class="post-pic" href={m.url} target="_blank" rel="noreferrer" title={m.alt || 'Open the picture'}>
          <img src={m.url} alt={m.alt ?? ''} loading="lazy" />
          {m.kind !== 'image' && <span class="post-pic-kind">{m.kind === 'gif' ? 'GIF' : '▶'}</span>}
        </a>
      ))}
    </div>
  );
}

export function Counts({ p, kit, big }: { p: P.PostFact; kit: Kit; big?: boolean }) {
  const c = p.counts;
  if (!c) return null;
  const items: [number | undefined, string, string][] = [
    [c.replies, 'reply', 'replies'],
    [c.reposts, 'repost', 'reposts'],
    [c.quotes, 'quote', 'quotes'],
    [c.likes, 'like', 'likes'],
    [c.views, 'view', 'views'],
  ];
  const shown = items.filter(([n]) => n !== undefined && (big || n > 0));
  if (!shown.length) return null;
  return (
    <span class={`post-counts ${big ? 'big' : ''}`}>
      {shown.map(([n, one, many]) => (
        <span title={`${n!.toLocaleString()} ${n === 1 ? one : many}`}>
          <b>{kit.feed.shortCount(n!)}</b> {n === 1 ? one : many}
        </span>
      ))}
    </span>
  );
}

/** A quoted post inside one: its byline and words, opening its own thread. */
export function QuotedIn({ p, kit, network }: { p: P.PostFact; kit: Kit; network: P.Network }) {
  const who = p.author ?? null;
  return (
    <a class="post-quoted thread-quoted" href={kit.feed.postHref(network, p.id)} onClick={(e) => e.stopPropagation()}>
      <span class="post-by">
        <kit.Avatar id={who ?? p.id} name={kit.name(who)} url={kit.avatarUrl(who)} size={16} />
        <b>{kit.name(who)}</b>
        {kit.handle(who) && <span class="post-handle">@{kit.handle(who)}</span>}
        <span class="post-handle">· {kit.ago(p.ts)}</span>
      </span>
      {p.text && <span class="post-clip">{p.text}</span>}
      {p.media?.[0] && <img class="thread-quoted-pic" src={p.media[0].url} alt={p.media[0].alt ?? ''} loading="lazy" />}
    </a>
  );
}

/** Someone's name and handle, opening their profile. */
export function Who({ id, kit }: { id: string | null; kit: Kit }) {
  const name = kit.name(id);
  return (
    <button class="post-who" onClick={(e) => (e.stopPropagation(), openProfile(id))} title={`${name}'s profile`}>
      <b>{name}</b>
      {kit.handle(id) && <span class="post-handle">@{kit.handle(id)}</span>}
    </button>
  );
}

/** A post in a thread, small: their picture on the left with the line down to the next, then who, when and what. */
export function Row({ p, kit, network, line, focal, size = 36, above, tag, hideQuote, below }: {
  p: P.PostFact;
  kit: Kit;
  network: P.Network;
  line: boolean;
  focal?: boolean;
  /** Its picture's size. */
  size?: number;
  /** Marks over it ("Pinned", "replied to your post"). */
  above?: ComponentChildren;
  /** A word after its time ("new", "quoted"). */
  tag?: string;
  /** Leave out the post it quotes when it is this one (a quote under the post it quotes, in the feed). */
  hideQuote?: string;
  /** In place of its counts: what can be done to it (Actions.tsx), and a composer answering it. */
  below?: ComponentChildren;
}) {
  const shown = p.repostOf ?? p;
  const who = shown.author ?? null;
  const open = (e: MouseEvent) => {
    if (focal || !kit.feed.opensPost(e)) return;
    kit.openPost(network, shown.id);
  };
  return (
    <article class={`thread-post ${line ? 'line' : ''}`} data-post={shown.id} onClick={open} tabIndex={focal ? undefined : 0} onKeyDown={(e) => !focal && e.key === 'Enter' && e.target === e.currentTarget && kit.openPost(network, shown.id)}>
      <button class="thread-face" onClick={(e) => (e.stopPropagation(), openProfile(who))} aria-label={`${kit.name(who)}'s profile`}>
        <kit.Avatar id={who ?? shown.id} name={kit.name(who)} url={kit.avatarUrl(who)} size={size} />
      </button>
      <div class="thread-main">
        {above}
        {p.repostOf && (
          <span class="post-mark">
            <kit.Icon name="repeat" size={11} /> {kit.name(p.author ?? null)} reposted
          </span>
        )}
        <div class="thread-head">
          <Who id={who} kit={kit} />
          <span class="post-handle" title={kit.fullTime(shown.ts)}>
            · {kit.ago(shown.ts)}
          </span>
          {tag && <span class={`post-tag ${tag === 'new' ? 'new' : ''}`}>{tag}</span>}
        </div>
        <Text p={shown} kit={kit} network={network} cls="post-text" />
        <Pics media={shown.media} />
        {shown.quoteOf && shown.quoteOf.id !== hideQuote && <QuotedIn p={shown.quoteOf} kit={kit} network={network} />}
        {below ?? <Counts p={shown} kit={kit} />}
      </div>
    </article>
  );
}

