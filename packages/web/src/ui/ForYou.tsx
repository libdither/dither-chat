/**
 * For you (docs/foryou.md): the right pane with no conversation open, and the phone's For you tab. Single messages
 * from channels, threads and big groups that triage rated, one per burst, from a snapshot the hub took when the pane
 * opened (nothing reorders under you; "N new" takes a fresh one). Clicking an item opens its chat at that message, and
 * back comes here where you were. Seeing an item marks nothing read; what was on screen, for how long, and what you
 * did with it goes to the hub (ids and numbers only). Not the X notifications feed (ui/feed/, docs/feed.md).
 */
import type * as P from '@dither-chat/protocol';
import { signal } from '@preact/signals';
import { useEffect, useLayoutEffect, useRef, useState } from 'preact/hooks';
import { burstLine, FRESH_EVERY, Impressions, onScreen, wantsFresh } from '../foryou.ts';
import { deviceId } from '../activity.ts';
import { countKey } from '../clicklog.ts';
import { ago, fullTime } from '../format.ts';
import { authorName, convLabel, crumbs, plainBody } from '../model.ts';
import { phone } from '../phone.ts';
import { adoptIdentities, api, db, go, rev, route } from '../state.ts';
import { inUse } from '../usage.ts';
import { viewer, type ViewerImage } from '../viewer.ts';
import { Avatar } from './bits.tsx';
import { openMenu } from './ContextMenu.tsx';
import { Icon } from './icons.tsx';
import { HeadOrb } from './Offline.tsx';
import { inboxMenu } from './Rail.tsx';
import { isLottie } from './Sticker.tsx';

// ------------------------------------------------------------------ the session's snapshot

interface Feed {
  epoch: string | null;
  at: number;
  items: P.ForYouItem[];
  quoted: Map<string, P.MessageView>;
  next: number | null;
  loading: boolean;
  failed: string | null;
  /** New items a fresh snapshot would bring. */
  fresh: number;
  hidden: Set<string>;
  marks: Map<string, 'more' | 'less'>;
  closedAt: number | null;
  /** Where the pane was scrolled to when it closed. */
  scroll: number;
  focus: string | null;
  /** Items drawn: the first DRAWN, and more as the end of them comes near. */
  drawn: number;
}
const empty = (): Feed => ({ epoch: null, at: 0, items: [], quoted: new Map(), next: null, loading: false, failed: null, fresh: 0, hidden: new Set(), marks: new Map(), closedAt: null, scroll: 0, focus: null, drawn: DRAWN });
const feed = signal<Feed>(empty());
const update = (f: (s: Feed) => Partial<Feed>) => (feed.value = { ...feed.value, ...f(feed.value) });

const PAGE = 20;
/** Items drawn at first, and each time the end of them comes near. */
const DRAWN = 10;
/** Where the pane is scrolled to, kept as you scroll: a closing pane's own element may be gone by then. */
let lastScroll = 0;

async function load(fresh: boolean) {
  const s = feed.value;
  if (s.loading) return;
  const epoch = fresh ? null : s.epoch;
  const from = fresh ? 0 : s.items.length ? (s.next ?? s.items.length) : 0;
  if (!fresh && s.epoch && s.next === null) return;
  update(() => ({ loading: true, failed: null }));
  try {
    const p = await api<P.ForYouPage>(`/api/foryou?limit=${PAGE}&from=${from}${epoch ? `&epoch=${encodeURIComponent(epoch)}` : ''}`);
    adoptIdentities(p.identities);
    const restart = fresh || p.reset || p.epoch !== s.epoch;
    const quoted = new Map(restart ? [] : feed.value.quoted);
    for (const m of p.quoted) quoted.set(m.id, m);
    update((s) => ({
      epoch: p.epoch,
      at: p.at,
      items: restart ? p.items : [...s.items, ...p.items.filter((i) => !s.items.some((x) => x.id === i.id))],
      quoted,
      next: p.next,
      loading: false,
      fresh: 0,
      ...(restart ? { hidden: new Set<string>(), marks: new Map(), scroll: (lastScroll = 0), focus: null, drawn: DRAWN } : {}),
    }));
  } catch (e) {
    update(() => ({ loading: false, failed: (e as Error).message }));
  }
}

/** A fresh snapshot: "N new", or a pull down on the phone's tab. */
export const refreshForYou = () => load(true);

async function checkFresh() {
  const s = feed.value;
  if (!s.epoch || s.loading) return;
  try {
    const r = await api<{ fresh: number; known: boolean }>(`/api/foryou/fresh?epoch=${encodeURIComponent(s.epoch)}`);
    // The hub no longer has this snapshot (it restarted): the next page asked for starts a fresh one anyway.
    if (feed.value.epoch === s.epoch) update(() => ({ fresh: r.known ? r.fresh : Math.max(1, feed.value.fresh) }));
  } catch {}
}

// ------------------------------------------------------------------ what was on screen, to the hub

let seen: Impressions | null = null;
let outbox: P.ForYouEvent[] = [];
let flushing = false;
async function flush(keepalive = false) {
  if (seen) outbox.push(...seen.due(deviceId(), keepalive));
  if (!outbox.length || flushing) return;
  const events = outbox;
  outbox = [];
  if (keepalive) {
    // The page is going away: one try that outlives it.
    void fetch('/api/foryou/events', { method: 'POST', keepalive: true, headers: { 'content-type': 'application/json' }, body: JSON.stringify({ events }) }).catch(() => {});
    return;
  }
  flushing = true;
  try {
    await api('/api/foryou/events', { body: { events } });
  } catch {
    // Kept for the next try, newest last; a resent event changes nothing on the hub.
    outbox = [...events, ...outbox].slice(-500);
  } finally {
    flushing = false;
  }
}
const note = (itemId: string, kind: P.ForYouEventKind) => {
  outbox.push({ itemId, device: deviceId(), kind, at: Date.now() });
  void flush();
};

// ------------------------------------------------------------------ actions

function open(it: P.ForYouItem) {
  note(it.id, 'clicked');
  update(() => ({ focus: it.id }));
  // Its chat, scrolled to it, in context. Opening the chat reads it, as any open does; the item itself never did.
  go({ view: 'inbox', conv: it.message.conversationId, msg: it.message.id });
}
function hide(it: P.ForYouItem) {
  note(it.id, 'hidden');
  update((s) => ({ hidden: new Set(s.hidden).add(it.id) }));
}
function mark(it: P.ForYouItem, kind: 'more' | 'less') {
  if (feed.value.marks.get(it.id) === kind) return;
  note(it.id, kind);
  update((s) => ({ marks: new Map(s.marks).set(it.id, kind) }));
  // "Less like this" is triage's own mark too, as on How it sorts (docs/notifications.md).
  if (kind === 'less' && it.message.triage) void api(`/api/messages/${encodeURIComponent(it.message.id)}/feedback`, { body: { less: true } }).catch(() => {});
}

// ------------------------------------------------------------------ the pane

export function ForYou() {
  rev.value;
  // A phone draws this pane under the inbox list too; it is only open on its own tab.
  const shown = !phone.value || route.value.view === 'foryou';
  const s = feed.value;
  const scroll = useRef<HTMLDivElement>(null);

  // Opening: carry on where you were, or a fresh snapshot after a while away. Closing keeps the place.
  useEffect(() => {
    if (!shown) return;
    if (wantsFresh(feed.value, Date.now())) void load(true);
    else void checkFresh();
    return () => {
      update(() => ({ closedAt: Date.now(), scroll: lastScroll }));
      void flush();
    };
  }, [shown]);
  // Back from an item: where it was.
  useLayoutEffect(() => {
    if (shown && scroll.current && feed.value.scroll) scroll.current.scrollTop = feed.value.scroll;
  }, [shown, s.epoch]);

  // "N new", asked every so often while the pane is open and the page visible.
  useEffect(() => {
    if (!shown) return;
    const t = setInterval(() => document.visibilityState === 'visible' && void checkFresh(), FRESH_EVERY);
    return () => clearInterval(t);
  }, [shown]);

  // What is on screen, and for how long: an observer for the items, a tick for the clock, and the page's comings and goings.
  useEffect(() => {
    if (!shown || !scroll.current || typeof IntersectionObserver === 'undefined') return;
    seen ??= new Impressions(Date.now());
    const io = new IntersectionObserver(
      (es) => {
        for (const e of es) {
          const id = (e.target as HTMLElement).dataset.item;
          if (id) seen!.set(id, e.isIntersecting && onScreen(e.intersectionRatio, e.intersectionRect.height, e.rootBounds?.height ?? 0), Date.now(), inUse());
        }
      },
      { root: scroll.current, threshold: [0, 0.25, 0.5, 0.75, 1] },
    );
    const watch = () => scroll.current?.querySelectorAll<HTMLElement>('[data-item]').forEach((el) => io.observe(el));
    watch();
    const mo = new MutationObserver(watch);
    mo.observe(scroll.current, { childList: true });
    const tick = setInterval(() => {
      seen!.tick(Date.now(), inUse());
      void flush();
    }, 1000);
    const vis = () => {
      seen!.tick(Date.now(), inUse());
      if (document.visibilityState === 'hidden') void flush(true);
    };
    document.addEventListener('visibilitychange', vis);
    addEventListener('pagehide', vis);
    return () => {
      io.disconnect();
      mo.disconnect();
      clearInterval(tick);
      document.removeEventListener('visibilitychange', vis);
      removeEventListener('pagehide', vis);
      // Off screen now: what was on it stops counting.
      for (const el of scroll.current?.querySelectorAll<HTMLElement>('[data-item]') ?? []) seen!.set(el.dataset.item!, false, Date.now(), inUse());
      void flush();
    };
  }, [shown, s.epoch]);

  // j, k, Enter and x; never while typing, or with a menu or dialog over the page.
  useEffect(() => {
    if (!shown || phone.value) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.ctrlKey || e.metaKey || e.altKey || e.defaultPrevented) return;
      const el = e.target as HTMLElement | null;
      if (el?.closest?.('input, textarea, select, [contenteditable], .cm, .sheet-layer, .modal-backdrop, .switcher-back')) return;
      if (document.querySelector('.cm, .sheet-layer, .modal-backdrop, .switcher-back, .viewer')) return;
      const s = feed.value;
      const items = s.items.filter((i) => !s.hidden.has(i.id));
      const at = items.findIndex((i) => i.id === s.focus);
      const cur = at >= 0 ? items[at] : null;
      switch (e.key) {
        case 'j':
        case 'k': {
          const to = items[Math.min(items.length - 1, Math.max(0, at + (e.key === 'j' ? 1 : at < 0 ? 0 : -1)))];
          if (!to) return;
          const i = items.indexOf(to);
          update((x) => ({ focus: to.id, drawn: Math.max(x.drawn, i + 1) }));
          requestAnimationFrame(() => document.querySelector(`.foryou [data-item="${CSS.escape(to.id)}"]`)?.scrollIntoView({ block: 'nearest' }));
          break;
        }
        case 'Enter':
          if (!cur || el?.closest?.('button, a')) return;
          open(cur);
          break;
        case 'x':
          if (!cur) return;
          hide(cur);
          break;
        default:
          return;
      }
      countKey(`for you: key ${e.key}`);
      e.preventDefault();
    };
    addEventListener('keydown', onKey);
    return () => removeEventListener('keydown', onKey);
  }, [shown]);

  if (!shown) return <section class="pane foryou" aria-label="For you" />;
  const items = s.items.filter((i) => !s.hidden.has(i.id));
  return (
    <section class="pane foryou" aria-label="For you" data-track-area="for you">
      <header class="foryou-head">
        <h2>For you</h2>
        {s.fresh > 0 && (
          <button
            class="foryou-new"
            data-track="new"
            title="Take the list again with what came since"
            onClick={() => {
              void refreshForYou();
              if (scroll.current) scroll.current.scrollTop = 0;
            }}
          >
            {s.fresh} new <Icon name="chevronUp" size={12} />
          </button>
        )}
        <span class="foryou-actions">
          <HeadOrb />
          <button class="btn ghost small" data-track="how it sorts" title="Why these: what triage rated, and how" onClick={() => go({ view: 'model' })}>
            <Icon name="sparkles" size={14} /> How it sorts
          </button>
          <button
            class="icon-btn small"
            data-track="inbox menu"
            title="More"
            aria-label="More"
            onClick={(e) => {
              const r = (e.currentTarget as HTMLElement).getBoundingClientRect();
              openMenu({ x: r.right, y: r.bottom }, inboxMenu(), e.currentTarget);
            }}
          >
            <Icon name="more" size={16} />
          </button>
        </span>
      </header>
      <div
        class="foryou-scroll"
        ref={scroll}
        onScroll={(e) => {
          const el = e.currentTarget as HTMLElement;
          lastScroll = el.scrollTop;
          if (el.scrollTop + el.clientHeight < el.scrollHeight - 600) return;
          // Near the end: draw more of what came, then the next page of the same snapshot.
          if (s.drawn < items.length) update((x) => ({ drawn: x.drawn + DRAWN }));
          else if (s.next !== null && !s.loading) void load(false);
        }}
      >
        {!items.length && !s.loading && s.epoch && (
          <div class="foryou-empty">
            <Icon name="sparkles" size={34} />
            <h3>Nothing for you right now</h3>
            <p>Messages from channels and big groups that triage rates show here, one per burst. What needs you is in the inbox.</p>
            <button class="link-btn" data-track="how it sorts (empty)" onClick={() => go({ view: 'model' })}>
              How it sorts
            </button>
          </div>
        )}
        {s.failed && !items.length && (
          <div class="foryou-empty">
            <p>Could not load: {s.failed}</p>
            <button class="link-btn" data-track="try again" onClick={() => void load(true)}>
              Try again
            </button>
          </div>
        )}
        {items.slice(0, s.drawn).map((it) => (
          <Item key={it.id} it={it} quoted={it.message.replyToId ? s.quoted.get(it.message.replyToId) : undefined} focused={s.focus === it.id} mark={s.marks.get(it.id)} />
        ))}
        {(s.next !== null || items.length > s.drawn) && items.length > 0 && (
          <button
            class="btn ghost small foryou-more"
            data-track="more"
            disabled={s.loading}
            onClick={() => (s.drawn < items.length ? update((x) => ({ drawn: x.drawn + DRAWN })) : void load(false))}
          >
            {s.loading ? 'Loading…' : 'More'}
          </button>
        )}
        {!s.epoch && s.loading && <div class="foryou-loading">Loading…</div>}
      </div>
      {items.length > 0 && !phone.value && (
        <div class="foryou-keys" aria-hidden="true">
          <kbd>j</kbd> <kbd>k</kbd> move · <kbd>Enter</kbd> open at the message · <kbd>x</kbd> hide
        </div>
      )}
    </section>
  );
}

// ------------------------------------------------------------------ an item

/** A picture in an item: a file the network called just a file shows as one when its bytes are a picture. */
const isImage = (a: P.AttachmentView) => !isLottie(a) && (a.kind === 'image' || (a.kind === 'file' && a.info?.kind === 'image'));

function authorAvatar(id: string | null) {
  const i = id ? db.identities.get(id) : undefined;
  return (i?.personId ? db.persons.get(i.personId)?.avatar : null) ?? i?.avatar ?? null;
}

function Item({ it, quoted, focused, mark: marked }: { it: P.ForYouItem; quoted?: P.MessageView; focused: boolean; mark?: 'more' | 'less' }) {
  const m = it.message;
  const c = db.conversations.get(m.conversationId);
  const place = c ? crumbs(c) : [];
  const where = c ? convLabel(c) : 'this chat';
  const text = plainBody(m.body, m.network);
  const [all, setAll] = useState(false);
  const long = text.length > 420 || text.split('\n').length > 6;
  const images = m.attachments.filter(isImage);
  const files = m.attachments.filter((a) => !isImage(a));
  const pics: ViewerImage[] = images.map((a) => ({ url: a.url, name: a.name, width: a.width, height: a.height }));
  const burst = burstLine(it.burst.count, where);
  const also = (it.also ?? []).map((id) => db.conversations.get(id)).filter((x): x is P.ConversationView => !!x);
  return (
    <article
      class={`fy-item ${focused ? 'focused' : ''}`}
      data-track="item"
      data-item={it.id}
      data-pos={it.position}
      data-slot={it.slot}
      title={it.reasons.join(' · ')}
      onClick={(e) => {
        if ((e.target as HTMLElement).closest('button, a')) return;
        open(it);
      }}
    >
      <div class="fy-place">
        <span class="fy-crumbs">{place.map((p) => p.label).join(' › ')}</span>
        <span class="fy-time" title={fullTime(m.ts)}>
          {ago(m.ts)}
        </span>
        {it.slot === 'explore' && <span class="fy-trying">Trying: new to you</span>}
      </div>
      <div class="fy-body">
        <Avatar id={m.authorId ?? m.id} name={authorName(m.authorId)} url={authorAvatar(m.authorId)} size={32} network={m.network} />
        <div class="fy-main">
          <b class="fy-author">{authorName(m.authorId)}</b>
          {m.replyToId && (
            <div class="fy-quote" title="What it answers">
              <Icon name="reply" size={11} /> {quoted ? <b>{authorName(quoted.authorId)}</b> : null} <span>{quoted ? plainBody(quoted.body, quoted.network) || 'Attachment' : 'an earlier message'}</span>
            </div>
          )}
          {text ? (
            <div class={`fy-text ${all ? 'all' : ''}`}>{text}</div>
          ) : (
            !m.attachments.length && <div class="fy-text muted">{m.kind === 'encrypted' ? 'Encrypted message' : 'Message'}</div>
          )}
          {long && !all && (
            <button class="link-btn fy-more-text" data-track="more text" onClick={() => setAll(true)}>
              more
            </button>
          )}
          {images.length > 0 && (
            <span class="fy-thumbs">
              {images.map((a, i) => (
                <a
                  class="fy-thumb"
                  href={a.url}
                  target="_blank"
                  rel="noreferrer"
                  data-track="picture"
                  onClick={(e) => {
                    if (e.button !== 0 || e.ctrlKey || e.metaKey || e.shiftKey) return;
                    e.preventDefault();
                    viewer.value = { images: pics, index: i };
                  }}
                >
                  <img src={a.url} alt={a.name ?? ''} loading="lazy" />
                </a>
              ))}
            </span>
          )}
          {files.map((a) => (
            <span class="fy-file">
              <Icon name={isLottie(a) ? 'smile' : 'paperclip'} size={11} /> {a.name ?? 'file'}
            </span>
          ))}
        </div>
      </div>
      <div class="fy-foot">
        {burst && <span class="fy-burst">{burst}</span>}
        {also.length > 0 && <span class="fy-also">also in {also.map(convLabel).join(', ')}</span>}
        <span class="fy-actions">
          <button class={`icon-btn small ${marked === 'more' ? 'on' : ''}`} data-track="more like this" title="More like this" aria-label="More like this" aria-pressed={marked === 'more'} onClick={() => mark(it, 'more')}>
            <Icon name="plus" size={14} />
          </button>
          <button class={`icon-btn small ${marked === 'less' ? 'on' : ''}`} data-track="less like this" title="Less like this" aria-label="Less like this" aria-pressed={marked === 'less'} onClick={() => mark(it, 'less')}>
            <Icon name="chevronDown" size={14} />
          </button>
          <button class="icon-btn small" data-track="hide" title="Hide (x)" aria-label="Hide" onClick={() => hide(it)}>
            <Icon name="x" size={14} />
          </button>
        </span>
      </div>
    </article>
  );
}
