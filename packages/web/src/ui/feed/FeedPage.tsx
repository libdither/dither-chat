/** @jsxRuntime classic */
/** @jsx h */
/** @jsxFrag Fragment */
/**
 * The Feed page (docs/feed.md "The Feed page"): posts in one place, apart from conversations. A list of sources on the
 * left (Home, Activity, Your posts, Drafts, then each account's own timelines), the composer on top of the posts, and
 * a post's thread beside them (on a phone, in their place).
 *
 * The composer posts as any of your accounts, several at once: one text, or each account's own words; too long for one
 * post, it offers a thread; who may reply; pictures; saved as a draft or scheduled, both kept on the hub. Likes,
 * reposts and replies on a card go through the account whose timeline showed the post.
 */
import { Fragment, h, type ComponentChildren } from 'preact';
import type * as P from '@dither-chat/protocol';
import { NETWORK_META } from '@dither-chat/protocol';
// Its own path, so the rules ride in this chunk, not the app's start.
import { composeState, postRulesFor, splitThread, type PostRules } from '@dither-chat/protocol/compose';
import { useEffect, useMemo, useRef, useState } from 'preact/hooks';
import { api, db, go, loadTimeline, markRead, timelineKey, timelines } from '../../state.ts';
import { rev, timelineRev } from '../../versions.ts';
import type { Kit } from './lazy.tsx';
import { PostActions, type AnswerCtx } from './Actions.tsx';
import { PostComposer, Ring } from './Composer.tsx';
import { addMine, dropDraft, dropPost, drafts, editing, line, loadDrafts, loadSources, more, openSource, refresh, saveDraft, sources } from './feedstate.ts';
import { Row } from './Post.tsx';
import { ThreadView } from './Thread.tsx';
import { Unit } from './Units.tsx';

// ------------------------------------------------------------------ sources

type Kind = 'home' | 'activity' | 'mine' | 'drafts' | 'following' | 'foryou';
interface Src {
  kind: Kind;
  /** One account's own (`<account>:following` …), else every account's. */
  account?: string;
}
function parseSource(s: string): Src {
  if (s === 'home' || s === 'activity' || s === 'mine' || s === 'drafts') return { kind: s };
  const m = s.match(/^(.+):(following|foryou|mine|activity)$/);
  return m ? { kind: m[2] as Kind, account: m[1] } : { kind: 'home' };
}

const accounts = () => sources.value?.accounts ?? [];
const accountOf = (id: string | undefined) => accounts().find((a) => a.accountId === id);
const handleOf = (kit: Kit, a: P.FeedAccountView | undefined) => (a ? (kit.handle(a.identityId) ? `@${kit.handle(a.identityId)}` : a.label) : '');

/** Where the Feed opens: Home once an account can read its timeline, else Activity. */
function defaultSource(): string {
  return accounts().some((a) => a.home) ? 'home' : 'activity';
}

/** A network's notifications conversations, every account's or one's. */
function activityConvs(account?: string): P.ConversationView[] {
  return [...db.conversations.values()].filter((c) => c.variant === 'feed' && (!account || c.vantages.some((v) => v.accountId === account)));
}
const said = (cs: P.ConversationView[]) => cs.reduce((n, c) => n + c.vantages.reduce((m, v) => m + (v.mentions ?? 0), 0), 0);

function titleOf(kit: Kit, s: Src): { title: string; sub: string; icon: string } {
  const a = accountOf(s.account);
  const who = handleOf(kit, a);
  switch (s.kind) {
    case 'home':
      return { title: 'Home', sub: 'Who your accounts follow, newest first', icon: 'home' };
    case 'activity':
      return { title: 'Activity', sub: who || 'Likes, replies, quotes and follows', icon: 'bell' };
    case 'mine':
      return { title: s.account ? 'Posts' : 'Your posts', sub: who || 'From every account', icon: 'pencil' };
    case 'drafts':
      return { title: 'Drafts', sub: 'Kept on the hub, and scheduled posts', icon: 'clock' };
    case 'following':
      return { title: 'Following', sub: who, icon: 'users' };
    case 'foryou':
      return { title: 'For you', sub: who, icon: 'sparkles' };
  }
}

/** The kit for posts on the Feed page: a post opens beside the source, and acts as the given account. */
function feedKit(kit: Kit, source: string, account?: string): Kit {
  const open = (network: P.Network, post: string) => go({ view: 'feed', source, post: kit.feed.postKey(network, post) });
  return { ...kit, account, openPost: open, backToPost: open };
}

function SourceRow({ to, at, icon, label, count, dot, kit }: { to: string; at: string; icon: string; label: string; count?: number; dot?: boolean; kit: Kit }) {
  return (
    <button class={`feed-src ${to === at ? 'active' : ''}`} aria-current={to === at ? 'page' : undefined} data-source={to} onClick={() => go({ view: 'feed', source: to })}>
      <kit.Icon name={icon} size={16} />
      <span class="feed-src-label">{label}</span>
      {dot && <span class="feed-src-dot" aria-label="New" />}
      {!!count && <span class="feed-src-count">{count}</span>}
    </button>
  );
}

export function FeedSidebar({ source, kit }: { source?: string; kit: Kit }) {
  useEffect(() => void loadSources(), []);
  // Activity's dots follow the notifications conversations as they change.
  rev.value;
  const v = sources.value;
  const at = source ?? defaultSource();
  const accs = v?.accounts ?? [];
  const many = accs.length > 1;
  return (
    <div class="sidebar-inner feed-side">
      <header class="side-head">
        <h1>Feed</h1>
        <span class="side-sub">{accs.length ? `${accs.length} account${many ? 's' : ''} with posts` : 'Posts from your accounts'}</span>
      </header>
      <nav class="side-scroll feed-srcs" aria-label="Feed sources">
        {accs.some((a) => a.home) && <SourceRow to="home" at={at} icon="home" label="Home" kit={kit} />}
        <SourceRow to="activity" at={at} icon="bell" label="Activity" dot={said(activityConvs()) > 0} kit={kit} />
        <SourceRow to="mine" at={at} icon="pencil" label="Your posts" kit={kit} />
        <SourceRow to="drafts" at={at} icon="clock" label="Drafts" count={v?.drafts} kit={kit} />
        {accs.map((a) => (
          <section class="feed-src-acc" aria-label={handleOf(kit, a)}>
            <h2 class="feed-src-head">
              <kit.Avatar id={a.identityId ?? a.accountId} name={kit.name(a.identityId)} url={kit.avatarUrl(a.identityId)} size={18} />
              <span>{handleOf(kit, a)}</span>
              <span class="feed-src-net">{NETWORK_META[a.network].name}</span>
              {!a.online && <span class="feed-src-off" title="Not connected: what the hub holds shows, nothing new is read">offline</span>}
            </h2>
            {a.home && (
              <>
                <SourceRow to={`${a.accountId}:following`} at={at} icon="users" label="Following" kit={kit} />
                <SourceRow to={`${a.accountId}:foryou`} at={at} icon="sparkles" label="For you" kit={kit} />
              </>
            )}
            {a.feedConvId && <SourceRow to={`${a.accountId}:activity`} at={at} icon="bell" label="Activity" dot={said(activityConvs(a.accountId)) > 0} kit={kit} />}
            <SourceRow to={`${a.accountId}:mine`} at={at} icon="pencil" label="Posts" kit={kit} />
          </section>
        ))}
      </nav>
    </div>
  );
}

/** A phone's sources, a row of chips over the page (the list has no room beside it). */
function SourceStrip({ at, kit }: { at: string; kit: Kit }) {
  const accs = accounts();
  const chips: [string, string][] = [
    ...(accs.some((a) => a.home) ? [['home', 'Home'] as [string, string]] : []),
    ['activity', 'Activity'],
    ['mine', 'Your posts'],
    ['drafts', 'Drafts'],
    ...accs.flatMap((a): [string, string][] =>
      a.home
        ? [
            [`${a.accountId}:following`, `Following · ${handleOf(kit, a)}`],
            [`${a.accountId}:foryou`, `For you · ${handleOf(kit, a)}`],
          ]
        : [],
    ),
  ];
  return (
    <nav class="feed-strip" aria-label="Feed sources">
      {chips.map(([to, label]) => (
        <button class={`feed-chip ${to === at ? 'on' : ''}`} aria-current={to === at ? 'page' : undefined} onClick={() => go({ view: 'feed', source: to }, true)}>
          {label}
        </button>
      ))}
    </nav>
  );
}

// ------------------------------------------------------------------ the page

export function FeedPane({ source, post, kit, onBack }: { source?: string; post?: string; kit: Kit; onBack?: () => void }) {
  useEffect(() => void loadSources(), []);
  sources.value;
  const at = source ?? defaultSource();
  const s = parseSource(at);
  const fk = useMemo(() => feedKit(kit, at), [at]);
  const t = titleOf(kit, s);
  const src = post ? kit.feed.parsePostKey(post) : null;
  const l = s.kind === 'activity' || s.kind === 'drafts' ? null : line(at).value;
  const phone = kit.phone.value;
  return (
    <section class={`pane feed-page ${src ? 'with-post' : ''}`} aria-label="Feed">
      <div class="feed-main">
        <header class="conv-head">
          <span class="conv-head-icon">
            <kit.Icon name={t.icon} size={18} />
          </span>
          <div class="conv-head-text">
            <h2>{t.title}</h2>
            <div class="conv-head-sub">
              <span class="muted-label">
                {t.sub}
                {l?.reading === 'top' ? ' · reading…' : l?.readAt ? ` · read ${kit.ago(l.readAt)}` : ''}
              </span>
            </div>
          </div>
          {l && (
            <button class="icon-btn" title="Read again" aria-label="Read again" disabled={!!l.reading} onClick={() => void refresh(at)} data-track="feed: refresh">
              <kit.Icon name="refresh" size={16} />
            </button>
          )}
        </header>
        {phone && <SourceStrip at={at} kit={kit} />}
        {s.kind === 'activity' ? (
          <ActivityList account={s.account} kit={fk} />
        ) : s.kind === 'drafts' ? (
          <DraftsList kit={fk} />
        ) : (
          <EntriesList key={at} source={at} s={s} kit={fk} top={<FeedComposer kit={fk} fixed={s.account} />} />
        )}
      </div>
      {src && (
        <div class="feed-thread">
          <ThreadView key={post} src={src} kit={fk} onBack={() => (onBack && phone ? onBack() : go({ view: 'feed', source: at }))} />
        </div>
      )}
    </section>
  );
}

/** A scroller that asks for more near its end, and again while what it shows does not fill it. */
function Scroll({ children, onEnd, can, deps }: { children: ComponentChildren; onEnd: () => void; can: boolean; deps: unknown[] }) {
  const el = useRef<HTMLDivElement>(null);
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

function EntriesList({ source, s, kit, top }: { source: string; s: Src; kit: Kit; top: ComponentChildren }) {
  const l = line(source).value;
  useEffect(() => void openSource(source), [source]);
  const [acted, setActed] = useState<Map<string, { viewer: P.PostViewer; counts: P.PostFact['counts'] }>>(new Map());
  const [answering, setAnswering] = useState<{ key: string; mode: 'reply' | 'quote' } | null>(null);
  const many = accounts().length > 1;
  const net = NETWORK_META[(accountOf(s.account) ?? accounts()[0])?.network ?? 'x'].name;
  return (
    <Scroll onEnd={() => void more(source)} can={l.loaded && !l.reading && (l.before !== null || l.older)} deps={[l.entries.length]}>
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
          via={many && s.kind === 'home'}
          acted={acted}
          onActed={(id, st) => setActed((m) => new Map(m).set(id, st))}
          answering={answering?.key === e.key ? answering.mode : null}
          setAnswering={(mode) => setAnswering(mode ? { key: e.key, mode } : null)}
        />
      ))}
      {l.reading === 'older' && <kit.Loading inline label="Older posts…" />}
      {l.loaded && !l.reading && !l.entries.length && !l.error && (
        <kit.Empty icon={s.kind === 'mine' ? 'pencil' : 'home'} title={s.kind === 'mine' ? 'No posts yet' : 'Nothing here yet'}>
          {s.kind === 'mine' ? 'What you post from here, or the hub reads from your profile, shows here.' : s.kind === 'foryou' ? `${net}'s own picks for this account show here once read.` : 'Posts from the people your accounts follow show here once read.'}
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
  via: boolean;
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
      {via && e.seenBy.length > 0 && (
        <span class="post-mark feed-via" title="The account whose timeline showed it: likes and replies go as it">
          via {e.seenBy.map((x) => handleOf(kit, accountOf(x.accountId))).filter((x, i, all) => all.indexOf(x) === i).join(', ')}
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

function DraftsList({ kit }: { kit: Kit }) {
  useEffect(() => void loadDrafts(), []);
  const ds = drafts.value;
  return (
    <Scroll onEnd={() => {}} can={false} deps={[]}>
      {!ds && <kit.Loading inline label="Loading drafts…" />}
      {ds && !ds.length && (
        <kit.Empty icon="clock" title="No drafts">
          Save a post for later, or schedule one, from the composer on Home.
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
            <button class="btn" onClick={() => ((editing.value = d), go({ view: 'feed', source: 'home' }))}>
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

function FeedComposer({ kit, fixed }: { kit: Kit; fixed?: string }) {
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
  const [open, setOpen] = useState(!kit.phone.value || !!text);
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
        if (kit.phone.value) setOpen(false);
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
  return (
    <div class="post-composer feed-composer" data-composer="feed">
      <div class="feed-as" role="group" aria-label="Post as">
        <span class="feed-as-label">Post as</span>
        {accs.map((a) => {
          const on = as.includes(a.accountId);
          return (
            <button
              class={`feed-as-chip ${on ? 'on' : ''} ${a.online ? '' : 'off'}`}
              aria-pressed={on}
              disabled={!!fixed && a.accountId !== fixed}
              title={a.online ? `${handleOf(kit, a)} on ${NETWORK_META[a.network].name}` : `${handleOf(kit, a)} is not connected`}
              onClick={() => toggle(a.accountId)}
              data-as={a.accountId}
            >
              <kit.Avatar id={a.identityId ?? a.accountId} name={kit.name(a.identityId)} url={kit.avatarUrl(a.identityId)} size={20} />
              <span>{handleOf(kit, a)}</span>
              {on && <kit.Icon name="check" size={12} />}
            </button>
          );
        })}
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
        <button class="btn" disabled={sending || (!text.trim() && !own)} onClick={() => void save(false)} title="Keep it on the hub, in Drafts">
          Save
        </button>
        {when !== null ? (
          <button class="btn primary compose-send" disabled={!chosen.length || empty || !!over.length || !scheduleAt || scheduleAt < Date.now()} onClick={() => void save(true)}>
            Schedule
          </button>
        ) : (
          <button class="btn primary compose-send" disabled={!sendable || sending} onClick={() => void post()} title={`${words.post} (Ctrl+Enter)`}>
            {sending ? 'Posting…' : chosen.length > 1 ? `${words.post} to ${chosen.length}` : words.post}
          </button>
        )}
      </div>
    </div>
  );
}
