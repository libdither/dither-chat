/** @jsxRuntime classic */
/** @jsx h */
/** @jsxFrag Fragment */
/**
 * The Feed page (docs/feed.md "The Feed page"): posts in one place, apart from conversations. Your feeds first:
 * Following, Discover and any you make, each timelines from any of your accounts in one list, each with its share, in
 * an order you swap at will (protocol mix.ts). Then Activity (every account's notifications), Your posts and Drafts.
 *
 * On a computer: the feeds and the rest listed on the left, the composer over the posts, and a post's thread or the
 * feed's tuning beside them. On a phone: the feeds as tabs across the top, the order under them, Activity behind the
 * bell, Your posts and Drafts behind ⋯, the composer behind the pencil button, a post's thread in the page's place.
 *
 * The composer posts as any of your accounts, several at once: one text, or each account's own words; too long for one
 * post, it offers a thread; who may reply; pictures; saved as a draft or scheduled, both kept on the hub. Likes,
 * reposts and replies on a card go through the account whose timeline showed the post.
 */
import { Fragment, h, type ComponentChildren } from 'preact';
import type * as P from '@dither-chat/protocol';
import { NETWORK_META } from '@dither-chat/protocol';
// Their own paths, so the rules and the orders ride in this chunk, not the app's start.
import { composeState, postRulesFor, splitThread, type PostRules } from '@dither-chat/protocol/compose';
import { MIX_ORDERS, SHARE_WEIGHTS } from '@dither-chat/protocol/mix';
import { useEffect, useMemo, useRef, useState } from 'preact/hooks';
import { api, db, go, loadTimeline, markRead, previousRoute, timelineKey, timelines } from '../../state.ts';
import { rev, timelineRev } from '../../versions.ts';
import type { Kit } from './lazy.tsx';
import { PostActions, type AnswerCtx } from './Actions.tsx';
import { PostComposer, Ring } from './Composer.tsx';
import { addMine, dropDraft, dropMix, dropPost, drafts, editing, line, loadDrafts, loadSources, more, newMix, openSource, refresh, saveDraft, saveMix, sources, tuning } from './feedstate.ts';
import { Row } from './Post.tsx';
import { ThreadView } from './Thread.tsx';
import { Unit } from './Units.tsx';

// ------------------------------------------------------------------ sources

type Src =
  | { kind: 'mix'; id: string; mix: P.FeedMixView | undefined }
  | { kind: 'line'; account: string; feed: P.HomeFeed }
  | { kind: 'activity' | 'mine' | 'drafts'; account?: string };

const accounts = () => sources.value?.accounts ?? [];
const mixes = () => sources.value?.mixes ?? [];
const accountOf = (id: string | undefined) => accounts().find((a) => a.accountId === id);
const handleOf = (kit: Kit, a: P.FeedAccountView | undefined) => (a ? (kit.handle(a.identityId) ? `@${kit.handle(a.identityId)}` : a.label) : '');

/** `home`, the merged source of old links, is Following now. */
const normal = (s: string) => (s === 'home' ? 'following' : s);

function parseSource(s: string): Src {
  if (s === 'activity' || s === 'mine' || s === 'drafts') return { kind: s };
  const m = s.match(/^(.+):(following|foryou|mine|activity)$/);
  if (m) return m[2] === 'mine' || m[2] === 'activity' ? { kind: m[2], account: m[1] } : { kind: 'line', account: m[1], feed: m[2] as P.HomeFeed };
  return { kind: 'mix', id: s, mix: mixes().find((x) => x.id === s) };
}

/** Where the Feed opens: Following once an account can read its timeline, else Activity. */
function defaultSource(): string {
  return accounts().some((a) => a.home) ? 'following' : 'activity';
}

/** A network's notifications conversations, every account's or one's. */
function activityConvs(account?: string): P.ConversationView[] {
  return [...db.conversations.values()].filter((c) => c.variant === 'feed' && (!account || c.vantages.some((v) => v.accountId === account)));
}
const said = (cs: P.ConversationView[]) => cs.reduce((n, c) => n + c.vantages.reduce((m, v) => m + (v.mentions ?? 0), 0), 0);

/** The orders a feed can have, in words. */
const ORDER: Record<P.MixOrder, { name: string; line: string; icon: string }> = {
  newest: { name: 'Newest first', line: 'Everything from the timelines that are on, by time.', icon: 'clock' },
  turns: { name: 'Taking turns', line: 'The timelines take turns, each in its own order (a For you as the network ranks it), by how much each gets.', icon: 'repeat' },
  liked: { name: 'Most liked', line: 'What people liked, reposted and answered most, against how old it is.', icon: 'heart' },
  spread: { name: 'Spread out', line: 'Newest first, but no one person fills the list: each further post of theirs sinks three hours.', icon: 'users' },
};
const SHARE_WORDS = ['Off', 'Less', 'Even', 'More', 'Most'];
const FEED_WORDS: Record<P.HomeFeed, string> = { following: 'Following', foryou: 'For you' };
const mixIcon = (id: string) => (id === 'following' ? 'users' : id === 'discover' ? 'sparkles' : 'rss');
const onOf = (m: P.FeedMixView) => m.sources.filter((x) => x.share > 0);
/** A timeline's colour in a feed's tuning and its mark on a card. */
const hue = (i: number) => `hsl(${(i * 137 + 250) % 360} 65% 60%)`;

function titleOf(kit: Kit, s: Src): { title: string; sub: string; icon: string } {
  const who = handleOf(kit, accountOf(s.kind === 'mix' ? undefined : s.account));
  switch (s.kind) {
    case 'mix': {
      const n = s.mix ? onOf(s.mix).length : 0;
      return { title: s.mix?.name ?? 'Feed', sub: s.mix ? `${n} timeline${n === 1 ? '' : 's'} · ${ORDER[s.mix.order].name}` : '', icon: mixIcon(s.id) };
    }
    case 'line':
      return { title: FEED_WORDS[s.feed], sub: `${who} alone, in ${NETWORK_META[accountOf(s.account)?.network ?? 'x'].name}'s own order`, icon: s.feed === 'following' ? 'users' : 'sparkles' };
    case 'activity':
      return { title: 'Activity', sub: who || 'Likes, replies, quotes and follows, from every account', icon: 'bell' };
    case 'mine':
      return { title: 'Your posts', sub: who || 'From every account', icon: 'pencil' };
    case 'drafts':
      return { title: 'Drafts', sub: 'Kept on the hub, and scheduled posts', icon: 'clock' };
  }
}

/** The kit for posts on the Feed page: a post opens beside the source, and acts as the given account. */
function feedKit(kit: Kit, source: string, account?: string): Kit {
  const open = (network: P.Network, post: string) => go({ view: 'feed', source, post: kit.feed.postKey(network, post) });
  return { ...kit, account, openPost: open, backToPost: open };
}

const toFeed = (source: string, replace = false) => go({ view: 'feed', source }, replace);

/** A new feed, opened with its tuning, for its name and timelines. */
async function makeMix(kit: Kit) {
  try {
    const m = await newMix();
    toFeed(m.id);
    tuning.value = true;
  } catch (e) {
    kit.toast({ title: 'Could not make a feed', body: (e as Error).message, kind: 'error' });
  }
}

function SourceRow({ to, at, icon, label, hint, count, dot, kit }: { to: string; at: string; icon: string; label: string; hint?: string; count?: number; dot?: boolean; kit: Kit }) {
  return (
    <button class={`feed-src ${to === at ? 'active' : ''}`} aria-current={to === at ? 'page' : undefined} data-source={to} onClick={() => toFeed(to)}>
      <kit.Icon name={icon} size={16} />
      <span class="feed-src-label">{label}</span>
      {hint && <span class="feed-src-hint">{hint}</span>}
      {dot && <span class="feed-src-dot" aria-label="New" />}
      {!!count && <span class="feed-src-count">{count}</span>}
    </button>
  );
}

export function FeedSidebar({ source, kit }: { source?: string; kit: Kit }) {
  useEffect(() => void loadSources(), []);
  // Activity's dot follows the notifications conversations as they change.
  rev.value;
  const v = sources.value;
  const at = normal(source ?? defaultSource());
  const accs = v?.accounts ?? [];
  const home = accs.some((a) => a.home);
  // One account's own Activity or Posts is Activity's or Your posts' row, filtered.
  const row = at.replace(/^.+:(activity|mine)$/, '$1');
  return (
    <div class="sidebar-inner feed-side">
      <header class="side-head">
        <h1>Feed</h1>
        <span class="side-sub">{accs.length ? `Posts from ${accs.length} account${accs.length > 1 ? 's' : ''}` : 'Posts from your accounts'}</span>
      </header>
      <nav class="side-scroll feed-srcs" aria-label="Feed">
        {home && (
          <>
            <h2 class="feed-src-group">Feeds</h2>
            {mixes().map((m) => (
              <SourceRow to={m.id} at={at} icon={mixIcon(m.id)} label={m.name} hint={ORDER[m.order].name} kit={kit} />
            ))}
            <button class="feed-src feed-src-new" onClick={() => void makeMix(kit)} data-track="feed: new feed">
              <kit.Icon name="plus" size={16} />
              <span class="feed-src-label">New feed</span>
            </button>
          </>
        )}
        <h2 class="feed-src-group">Yours</h2>
        <SourceRow to="activity" at={row} icon="bell" label="Activity" dot={said(activityConvs()) > 0} kit={kit} />
        <SourceRow to="mine" at={row} icon="pencil" label="Your posts" kit={kit} />
        <SourceRow to="drafts" at={row} icon="clock" label="Drafts" count={v?.drafts} kit={kit} />
        {accs.some((a) => !a.online) && (
          <p class="feed-src-offline">
            <kit.Icon name="alert" size={13} /> {accs.filter((a) => !a.online).map((a) => handleOf(kit, a)).join(', ')} not connected: what the hub holds shows, nothing new is read.
          </p>
        )}
      </nav>
    </div>
  );
}

// ------------------------------------------------------------------ the page

export function FeedPane({ source, post, kit, onBack }: { source?: string; post?: string; kit: Kit; onBack?: () => void }) {
  useEffect(() => void loadSources(), []);
  sources.value;
  const at = normal(source ?? defaultSource());
  const s = parseSource(at);
  const fk = useMemo(() => feedKit(kit, at), [at]);
  const src = post ? kit.feed.parsePostKey(post) : null;
  const l = s.kind === 'mix' || s.kind === 'line' || s.kind === 'mine' ? line(at).value : null;
  const phone = kit.phone.value;
  const mix = s.kind === 'mix' ? s.mix : undefined;
  // Tuning is the feed's: another source closes it.
  useEffect(() => {
    if (!mix) tuning.value = false;
  }, [at, !!mix]);
  const tune = !!mix && tuning.value;
  const [composing, setComposing] = useState(false);
  const side = src ? (
    <ThreadView key={post} src={src} kit={fk} onBack={() => (onBack && phone ? onBack() : toFeed(at))} />
  ) : tune && !phone ? (
    <TunePanel mix={mix!} kit={kit} entries={l?.entries ?? []} onClose={() => (tuning.value = false)} />
  ) : null;
  const composer = s.kind === 'mix' || s.kind === 'line' || s.kind === 'mine' ? (phone ? null : <FeedComposer kit={fk} fixed={s.kind === 'line' ? s.account : undefined} />) : null;
  return (
    <section class={`pane feed-page ${side ? 'with-post' : ''} ${phone ? 'is-phone' : ''}`} aria-label="Feed">
      <div class="feed-main">
        {phone && s.kind === 'mix' ? <PhoneHead s={s} l={l} kit={kit} /> : <PageHead s={s} at={at} l={l} kit={kit} phone={phone} />}
        {s.kind === 'activity' ? (
          <ActivityList account={s.account} kit={fk} />
        ) : s.kind === 'drafts' ? (
          <DraftsList kit={fk} onEdit={() => (phone ? setComposing(true) : toFeed(defaultSource()))} />
        ) : (
          <EntriesList source={at} s={s} order={mix?.order} kit={fk} top={composer} />
        )}
        {phone && s.kind !== 'activity' && accounts().some((a) => a.publish) && (
          <button class="feed-fab" aria-label="New post" onClick={() => setComposing(true)} data-composer="open">
            <kit.Icon name="pencil" size={22} />
          </button>
        )}
      </div>
      {side && <div class="feed-thread">{side}</div>}
      {phone && tune && (
        <kit.Sheet label={`Tune ${mix!.name}`} onClose={() => (tuning.value = false)} tall class="feed-tune-sheet">
          <TunePanel mix={mix!} kit={kit} entries={l?.entries ?? []} onClose={() => (tuning.value = false)} />
        </kit.Sheet>
      )}
      {phone && composing && (
        <kit.Sheet label="New post" onClose={() => setComposing(false)} tall class="feed-compose-sheet">
          <FeedComposer kit={fk} fixed={s.kind === 'line' ? s.account : undefined} sheet onDone={() => setComposing(false)} />
        </kit.Sheet>
      )}
    </section>
  );
}

type LineState = ReturnType<typeof line>['value'];

const readWords = (kit: Kit, l: LineState | null) => (l?.reading === 'top' ? 'reading…' : l?.readAt ? `read ${kit.ago(l.readAt)}` : '');

/** A computer's head over the posts, and a phone's over a page that is not a feed (with Back). */
function PageHead({ s, at, l, kit, phone }: { s: Src; at: string; l: LineState | null; kit: Kit; phone: boolean }) {
  const t = titleOf(kit, s);
  const mix = s.kind === 'mix' ? s.mix : undefined;
  const read = readWords(kit, l);
  const back = () => {
    const prev = previousRoute();
    if (prev?.view === 'feed') history.back();
    else toFeed(defaultSource(), true);
  };
  return (
    <header class="conv-head feed-head">
      {phone ? (
        <button class="icon-btn feed-back" aria-label="Back to the feed" onClick={back}>
          <kit.Icon name="back" size={20} />
        </button>
      ) : (
        <span class="conv-head-icon">
          <kit.Icon name={t.icon} size={18} />
        </span>
      )}
      <div class="conv-head-text">
        <h2>{t.title}</h2>
        <div class="conv-head-sub">
          <span class="muted-label">
            {t.sub}
            {read && ` · ${read}`}
          </span>
        </div>
      </div>
      {(s.kind === 'activity' || s.kind === 'mine') && <AccountFilter kind={s.kind} account={s.account} kit={kit} />}
      {mix && <OrderButton mix={mix} kit={kit} />}
      {mix && (
        <button class={`btn feed-tune-btn ${tuning.value ? 'on' : ''}`} aria-pressed={tuning.value} onClick={() => (tuning.value = !tuning.value)} data-track="feed: tune">
          <kit.Icon name="settings" size={15} /> Tune
        </button>
      )}
      {l && (
        <button class="icon-btn" title="Read again" aria-label="Read again" disabled={!!l.reading} onClick={() => void refresh(at)} data-track="feed: refresh">
          <kit.Icon name="refresh" size={16} />
        </button>
      )}
    </header>
  );
}

/** A phone's Feed tab: the bell and ⋯ in the head, the feeds as tabs, the order under them. */
function PhoneHead({ s, l, kit }: { s: Extract<Src, { kind: 'mix' }>; l: LineState | null; kit: Kit }) {
  rev.value;
  const [menu, setMenu] = useState(false);
  const n = said(activityConvs());
  const v = sources.value;
  const tabs = useRef<HTMLElement>(null);
  // The open feed's tab in view.
  useEffect(() => tabs.current?.querySelector<HTMLElement>('[aria-selected="true"]')?.scrollIntoView({ block: 'nearest', inline: 'nearest' }), [s.id]);
  const read = readWords(kit, l);
  return (
    <>
      <header class="feed-phone-head">
        <h1>Feed</h1>
        <span class="compose-spacer" />
        <button class="icon-btn feed-bell" aria-label={n ? `Activity, ${n} new` : 'Activity'} onClick={() => toFeed('activity')} data-source="activity">
          <kit.Icon name="bell" size={22} />
          {n > 0 && <span class="feed-bell-count">{n > 99 ? '99+' : n}</span>}
        </button>
        <button class="icon-btn" aria-label="More" onClick={() => setMenu(true)}>
          <kit.Icon name="more" size={22} />
        </button>
      </header>
      <nav class="feed-tabs" role="tablist" aria-label="Your feeds" ref={tabs}>
        {mixes().map((m) => (
          <button role="tab" class="feed-tab" aria-selected={m.id === s.id} data-source={m.id} onClick={() => toFeed(m.id, true)}>
            {m.name}
          </button>
        ))}
        <button class="feed-tab feed-tab-add" aria-label="New feed" onClick={() => void makeMix(kit)}>
          <kit.Icon name="plus" size={18} />
        </button>
      </nav>
      {s.mix && (
        <div class="feed-orderline">
          <OrderButton mix={s.mix} kit={kit} />
          <span class="feed-orderline-read">{read}</span>
          <button class="link-btn feed-tune-btn" onClick={() => (tuning.value = true)} data-track="feed: tune">
            <kit.Icon name="settings" size={15} /> Tune
          </button>
        </div>
      )}
      {menu && (
        <kit.Sheet label="Feed" onClose={() => setMenu(false)}>
          <button class="sheet-action" onClick={() => (setMenu(false), toFeed('mine'))} data-source="mine">
            <kit.Icon name="pencil" size={20} /> Your posts
          </button>
          <button class="sheet-action" onClick={() => (setMenu(false), toFeed('drafts'))} data-source="drafts">
            <kit.Icon name="clock" size={20} /> Drafts{v?.drafts ? ` (${v.drafts})` : ''}
          </button>
          <button class="sheet-action" onClick={() => (setMenu(false), (tuning.value = true))}>
            <kit.Icon name="settings" size={20} /> Tune {s.mix?.name ?? 'this feed'}
          </button>
          <button class="sheet-action" onClick={() => (setMenu(false), void makeMix(kit))}>
            <kit.Icon name="plus" size={20} /> New feed
          </button>
        </kit.Sheet>
      )}
    </>
  );
}

/** A feed's order, swapped from a menu (a sheet on a phone): the same posts, put in the new order at once. */
function OrderButton({ mix, kit }: { mix: P.FeedMixView; kit: Kit }) {
  const [open, setOpen] = useState(false);
  const phone = kit.phone.value;
  const box = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open || phone) return;
    const away = (e: Event) => !box.current?.contains(e.target as Node) && setOpen(false);
    const esc = (e: KeyboardEvent) => e.key === 'Escape' && setOpen(false);
    document.addEventListener('pointerdown', away);
    document.addEventListener('keydown', esc);
    return () => (document.removeEventListener('pointerdown', away), document.removeEventListener('keydown', esc));
  }, [open, phone]);
  const pick = (o: P.MixOrder) => {
    setOpen(false);
    if (o !== mix.order) void saveMix(mix.id, { order: o }).catch((e) => kit.toast({ title: 'Could not change the order', body: (e as Error).message, kind: 'error' }));
  };
  const list = (
    <div class="feed-orders" role="menu" aria-label="Order">
      {MIX_ORDERS.map((o) => (
        <button role="menuitemradio" aria-checked={o === mix.order} class={`feed-order ${o === mix.order ? 'on' : ''}`} data-order={o} onClick={() => pick(o)}>
          <kit.Icon name={ORDER[o].icon} size={18} />
          <span class="feed-order-text">
            <b>{ORDER[o].name}</b>
            <small>{ORDER[o].line}</small>
          </span>
          {o === mix.order && <kit.Icon name="check" size={16} />}
        </button>
      ))}
    </div>
  );
  return (
    <div class="feed-order-box" ref={box}>
      <button class="feed-order-btn" aria-haspopup="menu" aria-expanded={open} onClick={() => setOpen(!open)} data-track="feed: order">
        <kit.Icon name={ORDER[mix.order].icon} size={15} />
        <span>{ORDER[mix.order].name}</span>
        <span class="feed-order-caret" aria-hidden="true">▾</span>
      </button>
      {open &&
        (phone ? (
          <kit.Sheet label="Order" onClose={() => setOpen(false)}>
            <h3 class="feed-sheet-title">Order of {mix.name}</h3>
            {list}
          </kit.Sheet>
        ) : (
          <div class="feed-order-menu">{list}</div>
        ))}
    </div>
  );
}

/** Activity's and Your posts' accounts: all of them, or one. */
function AccountFilter({ kind, account, kit }: { kind: 'activity' | 'mine'; account?: string; kit: Kit }) {
  const accs = accounts().filter((a) => kind === 'mine' || a.feedConvId);
  if (accs.length < 2) return null;
  return (
    <select class="feed-filter" aria-label="Which account" value={account ?? ''} onChange={(e) => toFeed((e.currentTarget as HTMLSelectElement).value ? `${(e.currentTarget as HTMLSelectElement).value}:${kind}` : kind, true)}>
      <option value="">All accounts</option>
      {accs.map((a) => (
        <option value={a.accountId}>{handleOf(kit, a)}</option>
      ))}
    </select>
  );
}

// ------------------------------------------------------------------ tuning a feed

/**
 * A feed's tuning: its name, its order, and how much of it each timeline gets, with what the posts showing now came
 * from. Each change is saved and the posts put in order again as it is made.
 */
function TunePanel({ mix, kit, entries, onClose }: { mix: P.FeedMixView; kit: Kit; entries: readonly P.FeedEntryView[]; onClose: () => void }) {
  const [name, setName] = useState(mix.name);
  // A share dragged shows its word before it is let go.
  const [dragging, setDragging] = useState<Record<string, number>>({});
  useEffect(() => (setName(mix.name), setDragging({})), [mix.id, mix.name]);
  const fail = (e: unknown) => kit.toast({ title: 'Could not change the feed', body: (e as Error).message, kind: 'error' });
  const keyOf = (x: { accountId: string; feed: string }) => `${x.accountId}:${x.feed}`;
  const from = new Map<string, number>();
  for (const e of entries) {
    const k = e.seenBy[0] ? keyOf(e.seenBy[0]) : '';
    from.set(k, (from.get(k) ?? 0) + 1);
  }
  const total = entries.length;
  // Following and Discover as they came: their own kind of timeline, even; Newest first and Taking turns.
  const first = mix.id === 'following';
  const changed =
    mix.order !== (first ? 'newest' : 'turns') || mix.name !== (first ? 'Following' : 'Discover') || mix.sources.some((x) => x.share !== ((x.feed === 'following') === first ? 2 : 0));
  return (
    <section class="feed-tune" aria-label={`Tune ${mix.name}`} data-tune={mix.id}>
      <header class="feed-tune-head">
        <h3>Tune {mix.name}</h3>
        <button class="icon-btn" aria-label="Close" onClick={onClose}>
          <kit.Icon name="x" size={16} />
        </button>
      </header>
      <div class="feed-tune-body">
        <label class="feed-tune-name">
          <span>Name</span>
          <input
            value={name}
            maxLength={40}
            onInput={(e) => setName((e.currentTarget as HTMLInputElement).value)}
            onChange={() => name.trim() && name.trim() !== mix.name && void saveMix(mix.id, { name: name.trim() }).catch(fail)}
          />
        </label>
        <h4 class="feed-tune-sub">Order</h4>
        <div class="feed-orders" role="radiogroup" aria-label="Order">
          {MIX_ORDERS.map((o) => (
            <button role="radio" aria-checked={o === mix.order} class={`feed-order ${o === mix.order ? 'on' : ''}`} data-order={o} onClick={() => o !== mix.order && void saveMix(mix.id, { order: o }).catch(fail)}>
              <kit.Icon name={ORDER[o].icon} size={18} />
              <span class="feed-order-text">
                <b>{ORDER[o].name}</b>
                <small>{ORDER[o].line}</small>
              </span>
              {o === mix.order && <kit.Icon name="check" size={16} />}
            </button>
          ))}
        </div>
        <h4 class="feed-tune-sub">Timelines</h4>
        <p class="feed-tune-hint">
          {mix.order === 'newest' ? 'Newest first shows all of each timeline that is on; how much each gets counts in the other orders.' : 'How much of the feed each gets.'}
        </p>
        <ul class="feed-tune-srcs">
          {mix.sources.map((x, i) => {
            const a = accountOf(x.accountId);
            const share = dragging[keyOf(x)] ?? x.share;
            const n = from.get(keyOf(x)) ?? 0;
            return (
              <li class={`feed-tune-src ${share ? '' : 'off'}`} data-src={keyOf(x)}>
                <span class="feed-tune-swatch" style={{ background: hue(i) }} aria-hidden="true" />
                <kit.Avatar id={a?.identityId ?? x.accountId} name={kit.name(a?.identityId)} url={kit.avatarUrl(a?.identityId)} size={28} />
                <button class="feed-tune-who" title="This timeline alone" onClick={() => toFeed(keyOf(x))}>
                  <b>{handleOf(kit, a)}</b>
                  <small>
                    {FEED_WORDS[x.feed]} · {NETWORK_META[a?.network ?? 'x'].name}
                  </small>
                </button>
                <span class="feed-tune-share">{SHARE_WORDS[share]}</span>
                <input
                  type="range"
                  min={0}
                  max={SHARE_WEIGHTS.length - 1}
                  step={1}
                  value={share}
                  aria-label={`How much of ${handleOf(kit, a)}'s ${FEED_WORDS[x.feed]}`}
                  aria-valuetext={SHARE_WORDS[share]}
                  onInput={(e) => setDragging({ ...dragging, [keyOf(x)]: Number((e.currentTarget as HTMLInputElement).value) })}
                  onChange={(e) => {
                    const v = Number((e.currentTarget as HTMLInputElement).value);
                    const { [keyOf(x)]: _, ...rest } = dragging;
                    setDragging(rest);
                    if (v !== x.share) void saveMix(mix.id, { sources: [{ ...x, share: v }] }).catch(fail);
                  }}
                />
                <span class="feed-tune-pct" title={`Of the ${total} posts showing now`}>{total && x.share ? `${Math.round((n / total) * 100)}%` : ''}</span>
              </li>
            );
          })}
        </ul>
        {total > 0 && (
          <>
            <div class="feed-tune-bar" role="img" aria-label={`Where the ${total} posts showing now came from`}>
              {mix.sources.map((x, i) => {
                const n = from.get(keyOf(x)) ?? 0;
                return n ? <span style={{ flexGrow: n, background: hue(i) }} title={`${handleOf(kit, accountOf(x.accountId))} · ${FEED_WORDS[x.feed]}: ${n}`} /> : null;
              })}
            </div>
            <p class="feed-tune-hint">Where the {total} posts showing now came from.</p>
          </>
        )}
        <footer class="feed-tune-foot">
          {mix.custom ? (
            <button class="btn danger" onClick={() => void dropMix(mix.id).then(() => (onClose(), toFeed('following', true)), fail)}>
              <kit.Icon name="trash" size={14} /> Delete this feed
            </button>
          ) : (
            changed && (
              <button class="link-btn" onClick={() => void dropMix(mix.id).catch(fail)}>
                Put {mix.name} back as it was
              </button>
            )
          )}
        </footer>
      </div>
    </section>
  );
}

/** A scroller that asks for more near its end, and again while what it shows does not fill it. */
function Scroll({ children, onEnd, can, deps, reset }: { children: ComponentChildren; onEnd: () => void; can: boolean; deps: unknown[]; reset?: unknown }) {
  const el = useRef<HTMLDivElement>(null);
  // A feed put in another order starts from its top.
  useEffect(() => void el.current?.scrollTo({ top: 0 }), [reset]);
  const near = () => {
    const e = el.current;
    return !!e && e.scrollHeight - e.scrollTop - e.clientHeight < 600;
  };
  useEffect(() => {
    if (can && near()) onEnd();
  }, [can, ...deps]);
  return (
    <div class="feed-scroll" ref={el} onScroll={() => can && near() && onEnd()}>
      <div class="feed-list">{children}</div>
    </div>
  );
}

function EntriesList({ source, s, order, kit, top }: { source: string; s: Src; order?: P.MixOrder; kit: Kit; top: ComponentChildren }) {
  const l = line(source).value;
  useEffect(() => void openSource(source), [source]);
  const [acted, setActed] = useState<Map<string, { viewer: P.PostViewer; counts: P.PostFact['counts'] }>>(new Map());
  const [answering, setAnswering] = useState<{ key: string; mode: 'reply' | 'quote' } | null>(null);
  // Which timeline a card came through, when the feed takes more than one.
  const on = s.kind === 'mix' && s.mix ? s.mix.sources.map((x, i) => ({ ...x, i })).filter((x) => x.share > 0) : [];
  const net = NETWORK_META[(accountOf(s.kind === 'mix' ? undefined : s.account) ?? accounts()[0])?.network ?? 'x'].name;
  const empty =
    s.kind === 'mine'
      ? ['pencil', 'No posts yet', 'What you post from here, or the hub reads from your profile, shows here.']
      : s.kind === 'mix' && s.mix && !on.length
        ? ['settings', 'No timelines in this feed', 'Tune it to choose which timelines it takes.']
        : s.kind === 'line' && s.feed === 'foryou'
          ? ['sparkles', 'Nothing here yet', `${net}'s own picks for this account show here once read.`]
          : ['home', 'Nothing here yet', 'Posts from the people your accounts follow show here once read.'];
  return (
    <Scroll onEnd={() => void more(source)} can={l.loaded && !l.reading && (l.before !== null || l.older)} deps={[l.entries.length]} reset={order}>
      {top}
      {l.reading === 'top' && !l.entries.length && <kit.Loading inline label={`Reading from ${net}…`} />}
      {!l.loaded && <kit.Loading inline label="Loading…" />}
      {l.notes.map((n) => (
        <p class="feed-note" role="note">
          <kit.Icon name="info" size={13} /> {handleOf(kit, accountOf(n.accountId))}: {n.text}
        </p>
      ))}
      {l.error && (
        <p class="feed-note error" role="alert">
          <kit.Icon name="alert" size={13} /> {l.error}{' '}
          <button class="link-btn" onClick={() => void refresh(source)}>
            Try again
          </button>
        </p>
      )}
      {l.entries.map((e) => (
        <EntryCard
          key={e.key}
          e={e}
          kit={kit}
          via={on.length > 1 ? on : null}
          acted={acted}
          onActed={(id, st) => setActed((m) => new Map(m).set(id, st))}
          answering={answering?.key === e.key ? answering.mode : null}
          setAnswering={(mode) => setAnswering(mode ? { key: e.key, mode } : null)}
        />
      ))}
      {l.reading === 'older' && <kit.Loading inline label="Older posts…" />}
      {l.loaded && !l.reading && !l.entries.length && !l.error && (
        <kit.Empty icon={empty[0]} title={empty[1]}>
          {empty[2]}
        </kit.Empty>
      )}
      {l.loaded && !l.reading && l.entries.length > 0 && l.before === null && !l.older && <p class="feed-end">That is everything read so far.</p>}
    </Scroll>
  );
}

const REASON_ICON: Record<NonNullable<P.HomeReason['kind']>, string> = { like: 'heart', follow: 'users', reply: 'reply', topic: 'hash', community: 'groups', pinned: 'pin', other: 'sparkles' };

/** One post in a source: the conversation above it, why it is there, which account saw it, and what can be done. */
function EntryCard({ e, kit, via, acted, onActed, answering, setAnswering }: {
  e: P.FeedEntryView;
  kit: Kit;
  /** The feed's timelines, when it takes more than one: the card says which it came through. */
  via: { accountId: string; feed: P.HomeFeed; i: number }[] | null;
  acted: ReadonlyMap<string, { viewer: P.PostViewer; counts: P.PostFact['counts'] }>;
  onActed: (id: string, s: { viewer: P.PostViewer; counts: P.PostFact['counts'] }) => void;
  answering: 'reply' | 'quote' | null;
  setAnswering: (m: 'reply' | 'quote' | null) => void;
}) {
  const acting = e.seenBy[0]?.accountId;
  const acc = accountOf(acting);
  const shown = e.post.repostOf ?? e.post;
  const del = async (p: P.PostFact) => {
    try {
      await api(`/api/posts/${e.network}/${p.id}/delete`, { method: 'POST', body: { account: acting } });
      dropPost(e.network, p.id);
      kit.toast({ title: `Deleted from ${NETWORK_META[e.network].name}`, body: '', kind: 'info' }, 3000);
    } catch (err) {
      kit.toast({ title: 'Could not delete it', body: (err as Error).message, kind: 'error' });
    }
  };
  const ctx: AnswerCtx = {
    kit,
    network: e.network,
    ...(acting ? { account: acting } : {}),
    onReply: () => setAnswering(answering === 'reply' ? null : 'reply'),
    onQuote: () => setAnswering('quote'),
    acted,
    onActed,
    ...(acc?.unpublish && !e.post.repostOf && kit.isSelf(shown.author) ? { onDelete: del } : {}),
  };
  const marks = (
    <>
      {e.reason && (
        <span class="post-mark feed-reason">
          <kit.Icon name={REASON_ICON[e.reason.kind ?? 'other']} size={11} /> {e.reason.text}
        </span>
      )}
      {via && e.seenBy[0] && (
        <span class="post-mark feed-via" title="The timeline it came through: likes and replies go as its account">
          <span class="feed-via-dot" style={{ background: hue(via.find((x) => x.accountId === e.seenBy[0].accountId && x.feed === e.seenBy[0].feed)?.i ?? 0) }} aria-hidden="true" />
          {handleOf(kit, accountOf(e.seenBy[0].accountId))} · {e.seenBy[0].feed === 'mine' ? 'Posts' : FEED_WORDS[e.seenBy[0].feed]}
          {e.seenBy.length > 1 && ` (+${e.seenBy.length - 1})`}
        </span>
      )}
    </>
  );
  return (
    <div class="feed-entry" data-entry={e.key}>
      {e.above?.map((p) => (
        <Row p={p} kit={kit} network={e.network} line />
      ))}
      <Row
        p={e.post}
        kit={kit}
        network={e.network}
        line={false}
        above={marks}
        below={
          <>
            <PostActions p={shown} ctx={ctx} />
            {answering && (
              <PostComposer
                key={`${answering}:${shown.id}`}
                network={e.network}
                target={answering === 'quote' ? { quote: shown } : { replyTo: shown }}
                kit={kit}
                account={acting}
                autoFocus
                onCancel={() => setAnswering(null)}
                onPosted={() => {
                  setAnswering(null);
                  kit.toast({ title: answering === 'quote' ? 'Quoted' : 'Replied', body: '', kind: 'info' }, 3000);
                }}
              />
            )}
          </>
        }
      />
      {!!e.copies?.length && (
        <p class="feed-copies">
          Also posted as{' '}
          {e.copies.map((c, i) => (
            <>
              {i > 0 && ', '}
              <a href={kit.feed.postHref(e.network, c.post.id)} onClick={(ev) => (ev.preventDefault(), kit.openPost(e.network, c.post.id))}>
                {handleOf(kit, accountOf(c.accountId))}
              </a>
            </>
          ))}
        </p>
      )}
    </div>
  );
}

// ------------------------------------------------------------------ Activity

/** Every account's notifications, or one's, drawn as the feed's page draws them, newest first. */
function ActivityList({ account, kit }: { account?: string; kit: Kit }) {
  rev.value;
  const convs = activityConvs(account);
  const keys = convs.map((c) => timelineKey('c', c.id));
  for (const k of keys) timelineRev(k).value;
  useEffect(() => keys.forEach((k) => void loadTimeline(k)), [keys.join()]);
  // What was new when it opened, each account's by its own read line.
  const readTs = useMemo(() => new Map(convs.map((c) => [c.id, Math.min(...c.vantages.map((v) => v.lastReadTs ?? 0))])), [keys.join()]);
  const unread = convs.filter((c) => c.vantages.some((v) => v.unread > 0));
  useEffect(() => {
    if (document.visibilityState === 'visible') for (const c of unread) markRead(c.id);
  }, [unread.map((c) => c.id).join()]);
  const ts = keys.map((k) => timelines.get(k));
  // Each account's units apart (a post is one account's), then together by their newest activity.
  const units = convs.flatMap((c, i) => kit.feed.feedUnits(ts[i]?.messages ?? [], readTs.get(c.id) ?? Infinity)).sort((a, b) => b.ts - a.ts);
  const loading = ts.some((t) => !t || t.loading);
  const hasMore = ts.some((t) => t?.hasMore);
  return (
    <Scroll onEnd={() => keys.forEach((k, i) => ts[i]?.hasMore && !ts[i]!.loading && void loadTimeline(k, true))} can={hasMore && !loading} deps={[units.length]}>
      {units.map((u) => (
        <Unit key={u.key} u={u} kit={kit} />
      ))}
      {loading && <kit.Loading inline label="Loading notifications…" />}
      {!loading && !units.length && (
        <kit.Empty icon="bell" title="Nothing yet">
          {convs.length ? 'When people like, repost, reply to or quote your posts, mention you or follow you, it shows here.' : 'An account that has notifications (X) shows them here.'}
        </kit.Empty>
      )}
    </Scroll>
  );
}

// ------------------------------------------------------------------ drafts

function DraftsList({ kit, onEdit }: { kit: Kit; onEdit: () => void }) {
  useEffect(() => void loadDrafts(), []);
  const ds = drafts.value;
  return (
    <Scroll onEnd={() => {}} can={false} deps={[]}>
      {!ds && <kit.Loading inline label="Loading drafts…" />}
      {ds && !ds.length && (
        <kit.Empty icon="clock" title="No drafts">
          Save a post for later, or schedule one, from the composer.
        </kit.Empty>
      )}
      {ds?.map((d) => (
        <article class={`feed-draft ${d.failed ? 'failed' : ''}`} data-draft={d.id}>
          <div class="feed-draft-head">
            {d.scheduledAt ? (
              <span class="feed-draft-when">
                <kit.Icon name="clock" size={13} /> {d.scheduledAt > Date.now() ? 'Posts' : 'Was due'} {kit.fullTime(d.scheduledAt)}
              </span>
            ) : (
              <span class="feed-draft-when">Draft · {kit.ago(d.updatedAt)}</span>
            )}
            <span class="feed-draft-as">as {d.accounts.map((a) => handleOf(kit, accountOf(a))).join(', ') || 'no account yet'}</span>
          </div>
          <p class="feed-draft-text">{kit.feed.clip(d.text || Object.values(d.own ?? {})[0] || '', 280)}</p>
          {d.failed && (
            <p class="feed-note error" role="alert">
              <kit.Icon name="alert" size={13} /> {d.failed}
            </p>
          )}
          <div class="feed-draft-foot">
            <button class="btn" onClick={() => ((editing.value = d), onEdit())}>
              <kit.Icon name="pencil" size={14} /> Edit
            </button>
            <button class="btn" onClick={() => void dropDraft(d.id).catch((e) => kit.toast({ title: 'Could not delete the draft', body: (e as Error).message, kind: 'error' }))}>
              <kit.Icon name="trash" size={14} /> Delete
            </button>
          </div>
        </article>
      ))}
    </Scroll>
  );
}

// ------------------------------------------------------------------ the composer

const LAST_AS = 'dither.feed.as';
const TEXT = 'dither.feed.text';
const read = (k: string) => {
  try {
    return localStorage.getItem(k);
  } catch {
    return null;
  }
};
const keep = (k: string, v: string | null) => {
  try {
    if (v) localStorage.setItem(k, v);
    else localStorage.removeItem(k);
  } catch {
    /* a private window: kept while the page is open */
  }
};
const fresh = () => (typeof crypto !== 'undefined' && 'randomUUID' in crypto ? crypto.randomUUID() : `${Date.now()}-${Math.random().toString(36).slice(2)}`);

const GATE_WORDS: Record<P.ReplyGate, string> = {
  everyone: 'Everyone can reply',
  following: 'Accounts you follow',
  mentioned: 'Only accounts you mention',
  verified: 'Verified accounts',
};

interface Pic {
  local: string;
  name: string;
  mime: string;
  id?: string;
  error?: string;
}

/** What one account would post: its words cut into a thread when they are too long and the network threads. */
function partsFor(text: string, rules: PostRules, split: boolean): { parts: string[]; over: number } {
  const st = composeState(text, rules);
  if (st.remaining >= 0 || !split) return { parts: [text.trim()], over: Math.max(0, -st.remaining) };
  return { parts: splitThread(text, rules), over: 0 };
}

/** The local time a datetime-local field shows, for a ms epoch. */
const localInput = (ms: number) => {
  const d = new Date(ms - new Date(ms).getTimezoneOffset() * 60_000);
  return d.toISOString().slice(0, 16);
};

/** The composer: over the posts on a computer, in a sheet from the pencil button on a phone (`sheet`, closed by
 * `onDone` once posted or saved). */
function FeedComposer({ kit, fixed, sheet, onDone }: { kit: Kit; fixed?: string; sheet?: boolean; onDone?: () => void }) {
  const accs = accounts().filter((a) => a.publish);
  const first = () => {
    const last = (read(LAST_AS) ?? '').split(',').filter((a) => accs.some((x) => x.accountId === a));
    return fixed && accs.some((a) => a.accountId === fixed) ? [fixed] : last.length ? last : accs.slice(0, 1).map((a) => a.accountId);
  };
  const [as, setAs] = useState<string[]>(first);
  const [text, setText] = useState(() => read(TEXT) ?? '');
  const [own, setOwn] = useState<Record<string, string> | null>(null);
  const [split, setSplit] = useState(true);
  const [gate, setGate] = useState<P.ReplyGate>('everyone');
  const [pics, setPics] = useState<Pic[]>([]);
  const [when, setWhen] = useState<string | null>(null);
  const [draftId, setDraftId] = useState(fresh);
  const [key, setKey] = useState(fresh);
  const [sending, setSending] = useState(false);
  const [results, setResults] = useState<P.PublishResult[] | null>(null);
  const [open, setOpen] = useState(!kit.phone.value || !!text || !!sheet);
  useEffect(() => void (sheet && setTimeout(() => area.current?.focus(), 300)), []);
  const file = useRef<HTMLInputElement>(null);
  const area = useRef<HTMLTextAreaElement>(null);
  // The accounts come after the first draw: pick then.
  useEffect(() => {
    if (!as.length && accs.length) setAs(first());
  }, [accs.length]);
  useEffect(() => keep(TEXT, text), [text]);
  // A draft opened from Drafts.
  const ed = editing.value;
  useEffect(() => {
    if (!ed) return;
    editing.value = null;
    setAs(ed.accounts.length ? ed.accounts : first());
    setText(ed.text);
    setOwn(ed.own && Object.keys(ed.own).length ? ed.own : null);
    setGate(ed.replies ?? 'everyone');
    setWhen(ed.scheduledAt ? localInput(ed.scheduledAt) : null);
    setDraftId(ed.id);
    setKey(fresh());
    setResults(null);
    setOpen(true);
    setTimeout(() => area.current?.focus());
  }, [ed]);
  // The box grows with what is written.
  useEffect(() => {
    const a = area.current;
    if (!a) return;
    a.style.height = 'auto';
    a.style.height = `${Math.min(a.scrollHeight, 360)}px`;
  }, [text, open]);

  if (!accs.length) return null;
  const chosen = accs.filter((a) => as.includes(a.accountId));
  const rulesOf = (a: P.FeedAccountView) => postRulesFor(a.network)!;
  const words = rulesOf(chosen[0] ?? accs[0]).words;
  const textOf = (a: P.FeedAccountView) => own?.[a.accountId] ?? text;
  const plans = chosen.map((a) => ({ a, rules: rulesOf(a), ...partsFor(textOf(a), rulesOf(a), split) }));
  const gates = chosen.length ? chosen.map((a) => rulesOf(a).replyGates).reduce((x, y) => x.filter((g) => y.includes(g))) : [];
  const noMedia = chosen.filter((a) => !a.media);
  const maxPics = chosen.length ? Math.min(...chosen.map((a) => rulesOf(a).media.images)) : 0;
  const video = pics.some((p) => p.mime.startsWith('video/'));
  const canAddPic = !noMedia.length && pics.length < (video ? 1 : maxPics);
  const uploading = pics.some((p) => !p.id && !p.error);
  const offline = chosen.filter((a) => !a.online);
  const empty = plans.some((p) => !p.parts.join('').trim()) && !pics.length;
  const over = plans.filter((p) => p.over > 0);
  const sendable = chosen.length > 0 && !empty && !over.length && !uploading && !pics.some((p) => p.error) && !offline.length && !(pics.length && noMedia.length);
  const scheduleAt = when ? new Date(when).getTime() : null;

  const toggle = (id: string) => {
    if (fixed) return;
    const next = as.includes(id) ? as.filter((x) => x !== id) : [...as, id];
    setAs(next);
    if (own) setOwn(Object.fromEntries(next.map((a) => [a, own[a] ?? text])));
  };
  const clear = () => {
    setText('');
    setOwn(null);
    setPics([]);
    setWhen(null);
    setGate('everyone');
    setDraftId(fresh());
    setKey(fresh());
  };
  const addFiles = async (files: FileList | null) => {
    if (!files) return;
    const add = [...files].slice(0, Math.max(0, maxPics - pics.length));
    for (const f of add) {
      const pic: Pic = { local: URL.createObjectURL(f), name: f.name, mime: f.type || 'application/octet-stream' };
      setPics((ps) => [...ps, pic]);
      try {
        const up = await kit.uploadFile(f, f.name, pic.mime);
        setPics((ps) => ps.map((p) => (p.local === pic.local ? { ...p, id: up.id } : p)));
      } catch (e) {
        setPics((ps) => ps.map((p) => (p.local === pic.local ? { ...p, error: (e as Error).message } : p)));
      }
    }
  };
  const destinations = (only?: string[]): P.PublishDestination[] =>
    plans
      .filter((p) => !only || only.includes(p.a.accountId))
      .map((p) => ({ accountId: p.a.accountId, text: p.parts[0] ?? '', ...(p.parts.length > 1 ? { parts: p.parts.slice(1) } : {}) }));
  const post = async (only?: string[]) => {
    if (sending) return;
    setSending(true);
    const pressKey = only ? fresh() : key;
    try {
      const v = await api<P.PublishView>('/api/feed/publish', {
        method: 'POST',
        body: {
          key: pressKey,
          destinations: destinations(only),
          ...(pics.length ? { media: pics.map((p) => p.id!) } : {}),
          ...(gate !== 'everyone' ? { replies: gate } : {}),
        } satisfies P.PublishRequest,
      });
      const had = only ? (results ?? []).filter((r) => !only.includes(r.accountId)) : [];
      const all = [...had, ...v.results];
      setResults(all);
      const ok = v.results.filter((r) => r.ok && r.post);
      if (ok.length) {
        const [lead, ...rest] = ok;
        const net = accountOf(lead.accountId)?.network ?? 'x';
        addMine([
          {
            key: `${net}:${lead.post!.id}`,
            network: net,
            post: lead.post!,
            seenBy: [{ accountId: lead.accountId, feed: 'mine' }],
            ...(rest.length ? { copies: rest.map((r) => ({ accountId: r.accountId, post: r.post! })) } : {}),
            at: lead.post!.ts,
          },
        ]);
      }
      if (all.every((r) => r.ok)) {
        keep(LAST_AS, as.join(','));
        if (editing.value === null && drafts.value?.some((d) => d.id === draftId)) void dropDraft(draftId).catch(() => {});
        clear();
        kit.toast({ title: all.length > 1 ? `Posted as ${all.map((r) => handleOf(kit, accountOf(r.accountId))).join(' and ')}` : 'Posted', body: '', kind: 'info' }, 3000);
        onDone?.();
      }
    } catch (e) {
      kit.toast({ title: 'Could not post', body: (e as Error).message, kind: 'error' });
    }
    setSending(false);
  };
  const save = async (schedule: boolean) => {
    try {
      const d = await saveDraft(draftId, {
        text,
        accounts: as,
        ...(own ? { own } : {}),
        ...(gate !== 'everyone' ? { replies: gate } : {}),
        ...(schedule && scheduleAt ? { scheduledAt: scheduleAt } : {}),
      });
      clear();
      kit.toast({ title: d.scheduledAt ? `Scheduled for ${kit.fullTime(d.scheduledAt)}` : 'Saved to Drafts', body: '', kind: 'info' }, 3000);
      onDone?.();
    } catch (e) {
      kit.toast({ title: 'Could not save it', body: (e as Error).message, kind: 'error' });
    }
  };

  if (!open)
    return (
      <button class="compose-closed feed-compose-closed" onClick={() => (setOpen(true), setTimeout(() => area.current?.focus()))} data-composer="feed">
        <span>{words.placeholder}</span>
        <span class="compose-closed-btn">{words.post}</span>
      </button>
    );
  const failed = (results ?? []).filter((r) => !r.ok);
  // Save, and Post (or Schedule): at the foot on a computer, at the top right of a phone's sheet, clear of the keyboard.
  const saveBtn = (
    <button class={sheet ? 'link-btn' : 'btn'} disabled={sending || (!text.trim() && !own)} onClick={() => void save(false)} title="Keep it on the hub, in Drafts">
      Save
    </button>
  );
  const send =
    when !== null ? (
      <button class="btn primary compose-send" disabled={!chosen.length || empty || !!over.length || !scheduleAt || scheduleAt < Date.now()} onClick={() => void save(true)}>
        Schedule
      </button>
    ) : (
      <button class="btn primary compose-send" disabled={!sendable || sending} onClick={() => void post()} title={`${words.post} (Ctrl+Enter)`}>
        {sending ? 'Posting…' : chosen.length > 1 ? `${words.post} to ${chosen.length}` : words.post}
      </button>
    );
  return (
    <div class={`post-composer feed-composer ${sheet ? 'in-sheet' : ''}`} data-composer="feed">
      {sheet && (
        <header class="feed-compose-head">
          <button class="link-btn" onClick={onDone}>
            Cancel
          </button>
          <h3>New post</h3>
          {saveBtn}
          {send}
        </header>
      )}
      {/* Who posts it: your accounts' pictures, each pressed in or out, and their names in words. */}
      <div class="feed-as" role="group" aria-label="Post as">
        <div class="feed-as-faces">
          {accs.map((a) => {
            const on = as.includes(a.accountId);
            return (
              <button
                class={`feed-as-face ${on ? 'on' : ''} ${a.online ? '' : 'off'}`}
                aria-pressed={on}
                aria-label={`Post as ${handleOf(kit, a)}`}
                disabled={!!fixed && a.accountId !== fixed}
                title={a.online ? `${handleOf(kit, a)} on ${NETWORK_META[a.network].name}` : `${handleOf(kit, a)} is not connected`}
                onClick={() => toggle(a.accountId)}
                data-as={a.accountId}
              >
                <kit.Avatar id={a.identityId ?? a.accountId} name={kit.name(a.identityId)} url={kit.avatarUrl(a.identityId)} size={sheet ? 38 : 32} />
                {on && (
                  <span class="feed-as-tick" aria-hidden="true">
                    <kit.Icon name="check" size={10} />
                  </span>
                )}
              </button>
            );
          })}
        </div>
        <span class="feed-as-names">
          {chosen.length ? (
            <>
              Posting as <b>{chosen.map((a) => handleOf(kit, a)).join(' and ')}</b>
            </>
          ) : (
            'Tap a picture to choose who posts it'
          )}
        </span>
      </div>
      {own ? (
        chosen.map((a) => (
          <label class="feed-own">
            <span class="feed-own-who">{handleOf(kit, a)}</span>
            <textarea class="compose-text" rows={2} value={own[a.accountId] ?? ''} aria-label={`What ${handleOf(kit, a)} posts`} onInput={(e) => setOwn({ ...own, [a.accountId]: (e.currentTarget as HTMLTextAreaElement).value })} disabled={sending} />
          </label>
        ))
      ) : (
        <textarea
          ref={area}
          class="compose-text"
          rows={2}
          value={text}
          placeholder={words.placeholder}
          aria-label={words.post}
          onInput={(e) => setText((e.currentTarget as HTMLTextAreaElement).value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && (e.ctrlKey || e.metaKey) && sendable) (e.preventDefault(), void post());
          }}
          disabled={sending}
        />
      )}
      {pics.length > 0 && (
        <div class="feed-pics">
          {pics.map((p) => (
            <figure class={`feed-pic ${p.error ? 'bad' : p.id ? '' : 'up'}`} title={p.error ?? p.name}>
              {p.mime.startsWith('video/') ? <video src={p.local} muted /> : <img src={p.local} alt={p.name} />}
              <button class="feed-pic-x" aria-label={`Remove ${p.name}`} onClick={() => (URL.revokeObjectURL(p.local), setPics(pics.filter((x) => x !== p)))}>
                <kit.Icon name="x" size={12} />
              </button>
              {!p.id && !p.error && <span class="feed-pic-up">Sending…</span>}
            </figure>
          ))}
        </div>
      )}
      {plans.some((p) => p.parts.length > 1) && (
        <p class="feed-note" role="note">
          <kit.Icon name="thread" size={13} /> Posts as a thread: {plans.filter((p) => p.parts.length > 1).map((p) => `${p.parts.length} posts on ${handleOf(kit, p.a)}`).join(', ')}.{' '}
          <button class="link-btn" onClick={() => setSplit(false)}>
            Keep it one post
          </button>
        </p>
      )}
      {!split && over.length > 0 && (
        <p class="feed-note" role="note">
          Too long for one post.{' '}
          <button class="link-btn" onClick={() => setSplit(true)}>
            Post it as a thread
          </button>
        </p>
      )}
      {offline.length > 0 && (
        <p class="feed-note error" role="note">
          <kit.Icon name="alert" size={13} /> {offline.map((a) => handleOf(kit, a)).join(', ')} {offline.length > 1 ? 'are' : 'is'} not connected.
        </p>
      )}
      {pics.length > 0 && noMedia.length > 0 && (
        <p class="feed-note error" role="note">
          <kit.Icon name="alert" size={13} /> Pictures cannot be posted from {noMedia.map((a) => handleOf(kit, a)).join(', ')} yet.
        </p>
      )}
      {when !== null && (
        <label class="feed-sched">
          <kit.Icon name="clock" size={14} /> Post at{' '}
          <input type="datetime-local" value={when} min={localInput(Date.now())} onInput={(e) => setWhen((e.currentTarget as HTMLInputElement).value)} />
          <button class="link-btn" onClick={() => setWhen(null)}>
            Not scheduled
          </button>
        </label>
      )}
      {failed.length > 0 && (
        <div class="feed-results" role="alert">
          {(results ?? []).map((r) => (
            <p class={`feed-result ${r.ok ? 'ok' : 'bad'}`}>
              <kit.Icon name={r.ok ? 'check' : 'alert'} size={13} /> {handleOf(kit, accountOf(r.accountId))}: {r.ok ? 'posted' : r.error}
              {r.unsure && ' Look on the network before posting again.'}
            </p>
          ))}
          <button class="btn" disabled={sending} onClick={() => void post(failed.filter((r) => !r.post).map((r) => r.accountId))}>
            Post again where it failed
          </button>
        </div>
      )}
      <div class="compose-foot feed-foot">
        <input ref={file} type="file" hidden multiple accept="image/*,video/mp4,video/quicktime" onChange={(e) => (void addFiles((e.currentTarget as HTMLInputElement).files), ((e.currentTarget as HTMLInputElement).value = ''))} />
        <button class="icon-btn" disabled={!canAddPic || sending} title={noMedia.length ? `Pictures cannot be posted from ${noMedia.map((a) => handleOf(kit, a)).join(', ')} yet` : 'Add pictures or a video'} aria-label="Add pictures" onClick={() => file.current?.click()}>
          <kit.Icon name="image" size={18} />
        </button>
        {gates.length > 1 && (
          <select class="feed-gate" value={gate} aria-label="Who can reply" onChange={(e) => setGate((e.currentTarget as HTMLSelectElement).value as P.ReplyGate)}>
            {gates.map((g) => (
              <option value={g}>{GATE_WORDS[g]}</option>
            ))}
          </select>
        )}
        {chosen.length > 1 && (
          <button class="link-btn" onClick={() => setOwn(own ? null : Object.fromEntries(chosen.map((a) => [a.accountId, text])))} title="Different words on each account">
            {own ? 'Same words everywhere' : 'Write each apart'}
          </button>
        )}
        <span class="compose-spacer" />
        {(own ? plans : plans.slice(0, 1)).map((p) => (
          <span class="feed-count" title={handleOf(kit, p.a)}>
            {own && plans.length > 1 && <span class="feed-count-who">{handleOf(kit, p.a)}</span>}
            {/* A thread's count is its last post's, the one being written. */}
            <Ring st={composeState(p.parts.length > 1 ? p.parts[p.parts.length - 1] : textOf(p.a), p.rules)} rules={p.rules} />
          </span>
        ))}
        <button class="icon-btn" title={when === null ? 'Schedule' : 'Not scheduled'} aria-label="Schedule" aria-pressed={when !== null} disabled={sending || !!pics.length} onClick={() => setWhen(when === null ? localInput(Date.now() + 3_600_000) : null)}>
          <kit.Icon name="clock" size={18} />
        </button>
        {!sheet && saveBtn}
        {!sheet && send}
      </div>
    </div>
  );
}
