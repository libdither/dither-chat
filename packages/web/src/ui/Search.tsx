import type * as P from '@dither-chat/protocol';
import { mailSearchable, NETWORKS, parseSearch, searchOp, searchOps, setSearchOp, toggleSearchOp } from '@dither-chat/protocol';
import type { ComponentType } from 'preact';
import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'preact/hooks';
import { clock, dayLabel } from '../format.ts';
import { authorName, communitiesOf, convLabel, convTitle, netName, plainBody, plainMarkdown, resolveTokens, visibleConv } from '../model.ts';
import { api, back, db, go, mailRev, openMessage, openProfile, rev } from '../state.ts';
import { retention } from '../history.ts';
import { Avatar, Empty, NetBadge, NetGlyph } from './bits.tsx';
import { Icon } from './icons.tsx';
import { HeadOrb } from './Offline.tsx';
import { homeRoute } from '../opening.ts';
import { Menuable } from './ContextMenu.tsx';
import { identityMenu, messageMenu, personMenu } from './menus.tsx';
import { readableSearch, recentSearches, rememberSearch, SearchBox } from './SearchBox.tsx';
import { preloadMail } from './mail/lazy.tsx';
import { Loading } from './Loader.tsx';
import { MoreResults } from './more.tsx';
import { jumpMatches, jumpTargets, type JumpTarget } from '../jump.ts';
import { focusSearch } from './SearchLazy.tsx';
import './search.css';

/** Split a snippet into text and matches. It is plain text, so it stays out of innerHTML. */
function Snippet({ text, network }: { text: string; network: P.Network }) {
  return (
    <>
      {plainMarkdown(resolveTokens(text, network))
        .split(/(\u0001[^\u0002]*\u0002)/)
        .map((part) => (part.startsWith('\u0001') ? <mark>{part.slice(1, -1)}</mark> : part))}
    </>
  );
}



/**
 * A conversation has no unique name (and a DM has none at all), so the header's button scopes by id: a conversation's,
 * or a person's for every chat with them.
 */
function scopeOf(q: string): { id: string; label: string; network?: P.Network } | null {
  const id = searchOp(q, 'in');
  const c = id ? db.conversations.get(id) : null;
  if (c) return { id: c.id, label: c.shape === 'direct' ? convTitle(c) : convLabel(c), network: c.network };
  const p = id ? db.persons.get(id) : null;
  return p ? { id: p.id, label: `every chat with ${p.name}` } : null;
}


const SORTS: [string | null, string][] = [
  [null, 'Top, then newest'],
  ['relevance', 'Best match'],
  ['newest', 'Newest'],
  ['oldest', 'Oldest'],
];

const MORE: [op: string, val: string, label: string][] = [
  ['is', 'pinned', 'Pinned'],
  ['is', 'edited', 'Edited'],
  ['is', 'deleted', 'Deleted'],
  ['has', 'attachment', 'Has a file'],
  ['has', 'link', 'Has a link'],
  ['has', 'embed', 'Has an embed'],
  ['has', 'reaction', 'Has reactions'],
];

/** YYYY-MM-DD, `days` from today, on this device's calendar. */
function dayFrom(days: number): string {
  const d = new Date();
  d.setDate(d.getDate() + days);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

/** `after:` a day means from the next day, so "the last 7 days" is after the day 8 days ago. */
const DATES: [label: string, ops: () => Record<string, string | null>][] = [
  ['Today', () => ({ during: 'today', after: null, before: null })],
  ['Last 7 days', () => ({ during: null, after: dayFrom(-8), before: null })],
  ['Last 30 days', () => ({ during: null, after: dayFrom(-31), before: null })],
  ['This year', () => ({ during: null, after: `${new Date().getFullYear() - 1}-12-31`, before: null })],
];

const setOps = (q: string, ops: Record<string, string | null>) => Object.entries(ops).reduce((t, [op, v]) => setSearchOp(t, op, v), q);

function dateLabel(q: string): string | null {
  const during = searchOp(q, 'during');
  if (during) return during === 'today' ? 'Today' : during === 'yesterday' ? 'Yesterday' : during;
  const after = searchOp(q, 'after');
  const before = searchOp(q, 'before');
  const preset = DATES.find(([, ops]) => {
    const o = ops();
    return !o.during && o.after === after && !before;
  });
  if (preset) return preset[0];
  if (after && before) return `${after} – ${before}`;
  if (after) return `After ${after}`;
  if (before) return `Before ${before}`;
  return null;
}

/** A name to search by (From, In): what Ctrl+K would jump to for it, or what was typed. */
function NamePick({ kinds, placeholder, pick }: { kinds: JumpTarget['kind'][]; placeholder: string; pick: (v: string) => void }) {
  const [t, setT] = useState('');
  const all = useMemo(() => jumpTargets().filter((j) => kinds.includes(j.kind)), []);
  const found = t.trim() ? jumpMatches(all, t, 6) : [...all].sort((a, b) => (b.score ?? 0) - (a.score ?? 0) || b.last - a.last).slice(0, 6);
  // A chat by its id (it has no unique name); a person or community by name.
  const value = (j: JumpTarget) => (j.kind === 'place' ? j.key : j.label);
  return (
    <div class="search-pick">
      <input
        class="input"
        autoFocus
        placeholder={placeholder}
        value={t}
        onInput={(e) => setT((e.target as HTMLInputElement).value)}
        onKeyDown={(e) => {
          if (e.key === 'Enter' && !e.isComposing) (e.preventDefault(), found[0] ? pick(value(found[0])) : t.trim() && pick(t.trim()));
        }}
      />
      {found.map((j) => (
        <button class="search-pick-row" onClick={() => pick(value(j))}>
          <JumpIcon j={j} size={20} /> <span>{j.label}</span> <small>{j.sub}</small>
        </button>
      ))}
      {t.trim() && (
        <button class="search-pick-row" onClick={() => pick(t.trim())}>
          <Icon name="search" size={14} /> <span>Any name with “{t.trim()}”</span>
        </button>
      )}
    </div>
  );
}

type Chip = 'from' | 'in' | 'date' | 'network' | 'more' | 'sort';

/**
 * One row of chips (docs/search.md, "In the app"): From, In, Date, Network, Mentions me, More, and the sort. Each opens
 * a picker; a set chip shows its value and an × that clears it. They edit operators in the text, as typing them would.
 */
function FilterBar({ q, set }: { q: string; set: (q: string) => void }) {
  const [open, setOpen] = useState<Chip | null>(null);
  const bar = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => {
    if (!open) return;
    const away = (e: PointerEvent) => !bar.current?.contains(e.target as Node) && setOpen(null);
    const esc = (e: KeyboardEvent) => e.key === 'Escape' && (e.preventDefault(), e.stopPropagation(), setOpen(null));
    document.addEventListener('pointerdown', away, true);
    document.addEventListener('keydown', esc, true);
    return () => (document.removeEventListener('pointerdown', away, true), document.removeEventListener('keydown', esc, true));
  }, [open]);
  const apply = (next: string) => (set(next), setOpen(null));
  const scoped = !!scopeOf(q);
  const from = searchOp(q, 'from');
  const place = scoped ? null : searchOp(q, 'in');
  const date = dateLabel(q);
  const nets = searchOps(q, 'network');
  const mine = [...new Set([...db.accounts.values()].map((a) => a.network))].filter((n) => (NETWORKS as readonly string[]).includes(n)) as P.Network[];
  const more = MORE.filter(([op, v]) => (op === 'is' ? searchOps(q, 'is').includes(v) : searchOps(q, 'has').includes(v)));
  const moreShown = MORE.filter(([op, v]) => op !== 'is' || v !== 'deleted' || (retention.value.adversarial && retention.value.show !== 'hidden'));
  const sortNow = searchOp(q, 'sort')?.toLowerCase() ?? null;
  const sortLabel = SORTS.find(([v]) => v === sortNow)?.[1] ?? SORTS[0][1];
  const chip = (key: Chip, label: string, value: string | null, clear: () => string, extra = '') => (
    <span class={`search-chip ${value ? 'on' : ''} ${extra}`}>
      <button class="search-chip-main" aria-expanded={open === key} onClick={() => setOpen(open === key ? null : key)}>
        {value ? value : label} <Icon name="chevronDown" size={11} />
      </button>
      {value && (
        <button class="search-chip-x" aria-label={`Clear ${label}`} onClick={() => apply(clear())}>
          <Icon name="x" size={11} />
        </button>
      )}
    </span>
  );
  const name = (v: string | null) => (v && db.conversations.get(v) ? convTitle(db.conversations.get(v)!) : v);
  return (
    <div class="search-chips" ref={bar}>
      <div class="search-chip-row">
        {chip('from', 'From', from && `From: ${from}`, () => setSearchOp(q, 'from', null))}
        {!scoped && chip('in', 'In', place && `In: ${name(place)}`, () => setSearchOp(q, 'in', null))}
        {chip('date', 'Date', date, () => setOps(q, { during: null, after: null, before: null }))}
        {mine.length > 1 && chip('network', 'Network', nets.length ? nets.map((n) => netName(n as P.Network)).join(', ') : null, () => setSearchOp(q, 'network', null))}
        <span class={`search-chip ${searchOp(q, 'mentions')?.toLowerCase() === 'me' ? 'on' : ''}`}>
          <button class="search-chip-main" onClick={() => set(setSearchOp(q, 'mentions', searchOp(q, 'mentions')?.toLowerCase() === 'me' ? null : 'me'))}>
            <Icon name="at" size={12} /> Mentions me
          </button>
        </span>
        {chip('more', 'More', more.length ? more.map(([, , l]) => l).join(', ') : null, () => more.reduce((t, [op, v]) => (op === 'is' ? toggleSearchOp(t, 'is', v) : setSearchOp(t, 'has', null)), q))}
        {chip('sort', sortLabel, null, () => q, 'search-chip-sort')}
      </div>
      {open && (
        <div class="search-chip-pop" role="dialog">
          {open === 'from' && <NamePick kinds={['person']} placeholder="Someone’s name" pick={(v) => apply(setSearchOp(q, 'from', v))} />}
          {open === 'in' && <NamePick kinds={['place', 'community']} placeholder="A chat, channel or server" pick={(v) => apply(setSearchOp(q, 'in', v))} />}
          {open === 'date' && (
            <div class="search-pick">
              {DATES.map(([label, ops]) => (
                <button class={`search-pick-row ${date === label ? 'on' : ''}`} onClick={() => apply(setOps(q, ops()))}>
                  {label}
                </button>
              ))}
              <div class="search-pick-dates">
                <label>
                  <span>After</span>
                  <input class="input" type="date" value={searchOp(q, 'after') ?? ''} onChange={(e) => set(setOps(q, { during: null, after: (e.target as HTMLInputElement).value || null }))} />
                </label>
                <label>
                  <span>Before</span>
                  <input class="input" type="date" value={searchOp(q, 'before') ?? ''} onChange={(e) => set(setOps(q, { during: null, before: (e.target as HTMLInputElement).value || null }))} />
                </label>
              </div>
            </div>
          )}
          {open === 'network' && (
            <div class="search-pick">
              {mine.map((n) => (
                <button class={`search-pick-row ${nets.includes(n) ? 'on' : ''}`} onClick={() => set(toggleSearchOp(q, 'network', n))}>
                  <NetBadge network={n} size={14} /> {netName(n)} {nets.includes(n) && <Icon name="check" size={13} />}
                </button>
              ))}
            </div>
          )}
          {open === 'more' && (
            <div class="search-pick">
              {moreShown.map(([op, v, label]) => {
                const on = more.some(([o, x]) => o === op && x === v);
                return (
                  <button class={`search-pick-row ${on ? 'on' : ''}`} onClick={() => set(op === 'is' ? toggleSearchOp(q, 'is', v) : setSearchOp(q, 'has', on ? null : v))}>
                    {label} {on && <Icon name="check" size={13} />}
                  </button>
                );
              })}
            </div>
          )}
          {open === 'sort' && (
            <div class="search-pick">
              {SORTS.map(([v, label]) => (
                <button class={`search-pick-row ${v === sortNow ? 'on' : ''}`} onClick={() => apply(setSearchOp(q, 'sort', v))}>
                  {label} {v === sortNow && <Icon name="check" size={13} />}
                </button>
              ))}
            </div>
          )}
        </div>
      )}
    </div>
  );
}

function JumpIcon({ j, size }: { j: JumpTarget; size: number }) {
  if (j.person) return <Avatar id={j.person.id} name={j.person.name} url={j.person.avatar} size={size} />;
  if (j.space) return <Avatar id={j.space.id} name={j.space.name} url={j.space.icon} size={size} square network={j.space.network} />;
  if (j.conv) return <NetGlyph network={j.conv.network as P.Network} size={Math.round(size * 0.65)} />;
  return <Icon name="folder" size={Math.round(size * 0.7)} />;
}

/** Ctrl+K's matches for the words, at once (jump.ts): people, chats, communities and folders to go straight to. */
function JumpTo({ found, text, onGo }: { found: JumpTarget[]; text: string; onGo: () => void }) {
  if (!found.length) return null;
  return (
    <div class="search-jump">
      {found.map((j) => (
        <button class="search-jump-row" data-track={`search: jump (${j.kind})`} onClick={() => (onGo(), go(j.to))}>
          <span class="search-jump-icon"><JumpIcon j={j} size={26} /></span>
          <span class="search-jump-label">{markWords(j.label, text).split(/(\u0001[^\u0002]*\u0002)/).map((part) => (part.startsWith('\u0001') ? <mark>{part.slice(1, -1)}</mark> : part))}</span>
          <small>{j.sub}</small>
        </button>
      ))}
    </div>
  );
}

/** The words' starts marked in a name, as the hub marks a snippet. */
function markWords(label: string, text: string): string {
  let out = label;
  for (const w of text.toLowerCase().split(/\s+/).filter(Boolean)) out = out.replace(new RegExp(w.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i'), (m) => `\u0001${m}\u0002`);
  return out;
}

/** People as the hub ranked them (by any name, handle, old name, note, status or bio), less those Jump to shows. */
function Places({ found, skip, max }: { found: P.PersonHit[]; skip: Set<string>; max: number }) {
  const persons = found.filter(({ id }) => !skip.has(db.identities.get(id)?.personId ?? id)).slice(0, max);
  if (!persons.length) return null;
  return (
    <div class="search-places">
      {persons.map(({ id, match }) => {
        const i = db.identities.get(id);
        const p = i?.personId ? db.persons.get(i.personId) : undefined;
        return (
          <Menuable build={() => (p ? personMenu(p) : identityMenu(id))}>{(ctx) => <button class="search-place" onClick={() => openProfile(id)} {...ctx}>
            <Avatar id={p?.id ?? id} name={authorName(id)} url={p?.avatar ?? i?.avatar} size={24} network={p ? undefined : i?.network} /> {authorName(id)}{' '}
            <small>{match ? <Snippet text={match} network={i?.network ?? 'discord'} /> : p ? 'Person' : 'Seen in chats'}</small>
          </button>}</Menuable>
        );
      })}
    </div>
  );
}

/** The pictures among the hits, as a grid; a tap opens the message. */
function PictureGrid({ hits }: { hits: P.SearchHit[] }) {
  const pics = hits.flatMap((h) => h.message.attachments.filter((a) => a.kind === 'image').map((a) => ({ a, m: h.message })));
  if (!pics.length) return null;
  return (
    <div class="search-pictures">
      {pics.map(({ a, m }) => (
        <button class="search-picture" title={`${authorName(m.authorId)} · ${dayLabel(m.ts)}`} onClick={() => openMessage(m.conversationId, m.id)}>
          <img src={a.url} alt={a.alt ?? a.name ?? ''} loading="lazy" decoding="async" />
        </button>
      ))}
    </div>
  );
}

/** A hit, or a line of what was said around it. */
function Line({ m, hit, snippet, why }: { m: P.MessageView; hit?: boolean; snippet?: string; why?: string }) {
  const c = db.conversations.get(m.conversationId)!;
  const open = () => openMessage(c.id, m.id);
  if (!hit)
    return (
      <button class="search-ctx" tabIndex={-1} onClick={open}>
        <b>{authorName(m.authorId)}</b> <span>{plainBody(m.body, m.network) || (m.attachments.length ? `${m.attachments.length} file${m.attachments.length > 1 ? 's' : ''}` : '')}</span>
      </button>
    );
  return (
    <Menuable build={() => messageMenu(m)}>{(ctx) => <button class="search-hit" onClick={open} {...ctx}>
      <Avatar id={m.authorId ?? m.id} name={authorName(m.authorId)} url={db.identities.get(m.authorId ?? '')?.avatar} size={30} network={m.network} />
      <span class="search-hit-main">
        <span class="search-hit-top">
          <b>{authorName(m.authorId)}</b>
          {m.pinned && <Icon name="pin" size={11} />}
          {m.deleted && <span class="search-hit-gone">{m.gone?.how === 'disappeared' ? 'Disappeared' : 'Deleted'}</span>}
          <span class="search-hit-time">{dayLabel(m.ts)} {clock(m.ts)}</span>
        </span>
        <span class="search-hit-body">
          <Snippet text={snippet ?? ''} network={m.network} />
          {m.attachments.length > 0 && <span class="search-att"><Icon name="file" size={11} /> {m.attachments.length}</span>}
        </span>
        {why && <span class="search-hit-why">{why}</span>}
      </span>
    </button>}</Menuable>
  );
}

/** Hits in a row from one conversation share its heading, as in Discord; context already shown is not shown twice. */
function Results({ hits, why }: { hits: P.SearchHit[]; why?: boolean }) {
  const groups: { c: P.ConversationView; hits: P.SearchHit[] }[] = [];
  for (const h of hits) {
    const c = db.conversations.get(h.message.conversationId)!;
    if (groups[groups.length - 1]?.c.id === c.id) groups[groups.length - 1].hits.push(h);
    else groups.push({ c, hits: [h] });
  }
  return (
    <>
      {groups.map(({ c, hits }) => {
        const com = communitiesOf(c)[0];
        const ids = new Set(hits.map((h) => h.message.id));
        const shown = new Set<string>();
        const ctx = (ms: P.MessageView[] | undefined) => (ms ?? []).filter((m) => !ids.has(m.id) && !shown.has(m.id) && shown.add(m.id)).map((m) => <Line m={m} />);
        return (
          <section class="search-group">
            <button class="search-group-head" tabIndex={-1} onClick={() => go(homeRoute(c))}>
              <NetGlyph network={c.network} size={12} /> {c.shape === 'direct' ? convTitle(c) : convLabel(c)}
              {com && <small>{com.name}</small>}
            </button>
            {hits.map((h) => (
              <div class="search-block">
                {ctx(h.before)}
                <Line m={h.message} hit snippet={h.snippet} why={why ? h.why : undefined} />
                {ctx(h.after)}
              </div>
            ))}
          </section>
        );
      })}
    </>
  );
}

/**
 * Mail's own top hits beside the chats' (ui/mail/MailSearch.tsx, docs/mail.md), when the hub has mail and the query
 * means something there. A request of its own, drawn by Mail's chunk once loaded: the chats' results never wait for it.
 */
function MailGroup({ q }: { q: string }) {
  mailRev.value;
  const on = db.mail.access.state === 'granted' && db.mail.accounts.size > 0 && mailSearchable(q);
  const [Group, setGroup] = useState<ComponentType<{ q: string }> | null>(null);
  useEffect(() => {
    if (on && !Group) preloadMail().then((m) => setGroup(() => m.MailSearchGroup), () => {});
  }, [on]);
  return on && Group ? <Group q={q} /> : null;
}

/** Under this many of the hub's own hits, the networks are offered first thing, not only at the end. */
const OFFER_UNDER = 5;

const RANKED: Record<P.NetSearchView['ranked'], string> = { jev: 'Ordered by jev', keyword: 'Ordered by keywords', local: 'Ordered by your own messages' };

/** "Discord", "Discord and Matrix", "Discord, Matrix and Slack". */
const andList = (xs: string[]) => (xs.length > 1 ? `${xs.slice(0, -1).join(', ')} and ${xs[xs.length - 1]}` : (xs[0] ?? ''));

/** The networks some account of yours can search on its own servers. */
function searchableNetworks(): P.Network[] {
  return [...new Set([...db.accounts.values()].filter((a) => a.status !== 'disabled' && a.capabilities.includes('search')).map((a) => a.network))];
}

/** One place being asked: what it is, how well jev thinks it fits, and how the asking went. */
function NetPlace({ p, jev }: { p: P.NetSearchPlace; jev: boolean }) {
  return (
    <li class={`ns-place ${p.state}`}>
      <NetGlyph network={p.network} size={12} />
      <span class="ns-place-name">{p.name}</span>
      {/* A keyword match's score is a count of words found, not a likelihood: only jev's is worth showing. */}
      {jev && p.score !== null && (
        <span class="ns-fit" title="How likely jev thinks it is that people there talk about this">
          {Math.round(p.score * 100)}% fit
        </span>
      )}
      <span class="ns-state">
        {p.state === 'queued' && 'Waiting'}
        {p.state === 'searching' && <Loading inline label="Searching" />}
        {p.state === 'done' && `${p.found} found, ${p.fresh} new`}
        {p.state === 'failed' && <span class="ns-failed" title={p.error ?? undefined}>Failed{p.error ? `: ${p.error}` : ''}</span>}
      </span>
    </li>
  );
}

/**
 * On the networks (docs/search.md): the networks' own search, for what the hub has not stored. Only ever on a click:
 * Discord searches one server per request and rate-limits it, so the hub asks a few places at a time, best first,
 * and this follows it each second while any is still being asked. What it finds is stored, so the hub's own search
 * finds it from then on; here it shows below the hub's own hits, without those.
 */
function NetworkSearch({ q, local, few }: { q: string; local: P.SearchHit[]; few: boolean }) {
  rev.value;
  const nets = searchableNetworks();
  const [view, setView] = useState<P.NetSearchView | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // The query each answer is for, so one that comes back after the query changed is dropped.
  const current = useRef(q);
  current.current = q;
  const absorb = (v: P.NetSearchView) => v.identities.forEach((i) => db.identities.set(i.id, i));
  useEffect(() => {
    setView(null);
    setError(null);
    setBusy(false);
  }, [q]);
  // Follow it while any place is still being asked; a new query or leaving the page stops it.
  useEffect(() => {
    if (!view?.running) return;
    let live = true;
    const id = view.id;
    const t = setInterval(() => {
      api<P.NetSearchView>(`/api/search/network/${id}`).then(
        (v) => {
          if (!live || current.current !== q) return;
          absorb(v);
          setView(v);
        },
        (e) => {
          if (!live) return;
          setError(e.status === 404 ? 'That search is over. Search again.' : e.message);
          setView((v) => v && { ...v, running: false });
        },
      );
    }, 1000);
    return () => {
      live = false;
      clearInterval(t);
    };
  }, [view?.id, view?.running, q]);
  if (!nets.length || !q.trim()) return null;
  const send = async (path: string, body: unknown) => {
    setBusy(true);
    setError(null);
    const asked = q;
    try {
      const v = await api<P.NetSearchView>(path, { body });
      if (current.current !== asked) return;
      absorb(v);
      setView(v);
    } catch (e: any) {
      if (current.current === asked) setError(e.status === 404 ? 'That search is over. Search again.' : e.message);
    } finally {
      if (current.current === asked) setBusy(false);
    }
  };
  const start = () => send('/api/search/network', { q });
  const more = () => view && send(`/api/search/network/${view.id}/more`, {});
  const shownHere = new Set(local.map((h) => h.message.id));
  const hits = (view?.hits ?? []).filter((h) => {
    const c = db.conversations.get(h.message.conversationId);
    return !shownHere.has(h.message.id) && c && visibleConv(c);
  });
  const names = andList(nets.map(netName));
  const finished = view && !view.running && view.places.length > 0;
  return (
    <section class={`net-search ${few && !view ? 'offer' : ''}`} aria-label="On the networks">
      <h3 class="net-search-head">
        <Icon name="globe" size={14} /> On the networks
        {view && view.places.length > 0 && <small>{RANKED[view.ranked]}</small>}
      </h3>
      {!view && (
        <>
          {few && <p class="set-help net-search-why">Only what your accounts have fetched is stored here. {names} can search their own servers for the rest.</p>}
          <button class={`btn small ${few ? 'primary' : 'ghost'} net-search-go`} disabled={busy} onClick={() => void start()}>
            <Icon name="search" size={13} /> Search {names} too
          </button>
        </>
      )}
      {((busy && !view) || (view?.running && !view.places.length)) && <Loading inline label="Choosing where to look…" />}
      {view && view.places.length > 0 && (
        <ul class="ns-places" aria-live="polite">
          {view.places.map((p) => (
            <NetPlace p={p} jev={view.ranked === 'jev'} />
          ))}
        </ul>
      )}
      {view?.note && <p class="set-help net-search-note">{view.note}</p>}
      {error && (
        <p class="set-help net-search-note net-search-error" role="alert">
          {error}
        </p>
      )}
      <Results hits={hits} />
      {finished && !hits.length && <p class="set-help net-search-note">{view.hits.length ? 'Nothing new: what they found is already above.' : 'Nothing found there.'}</p>}
      {view && view.left > 0 && view.places.length > 0 && (
        <button class="btn ghost small search-more" disabled={busy} onClick={() => void more()}>
          Search {view.left} more place{view.left === 1 ? '' : 's'}
        </button>
      )}
    </section>
  );
}

/** Up and Down walk the results; Up from the first goes back to the box. */
function walk(e: KeyboardEvent, box: HTMLInputElement | null) {
  if (e.key !== 'ArrowDown' && e.key !== 'ArrowUp') return;
  const all = [...(e.currentTarget as HTMLElement).querySelectorAll<HTMLElement>('.search-jump-row, .search-hit')];
  const i = all.indexOf(document.activeElement as HTMLElement);
  if (i < 0) return;
  e.preventDefault();
  const next = all[i + (e.key === 'ArrowDown' ? 1 : -1)];
  if (next) next.focus();
  else if (e.key === 'ArrowUp') box?.focus();
}

type Tab = 'all' | 'messages' | 'people' | 'chats' | 'pictures' | 'links' | 'files';
const TABS: [Tab, string][] = [
  ['all', 'All'],
  ['messages', 'Messages'],
  ['people', 'People'],
  ['chats', 'Chats'],
  ['pictures', 'Pictures'],
  ['links', 'Links'],
  ['files', 'Files'],
];
/** What a tab adds to the query it sends. */
const TAB_HAS: Partial<Record<Tab, string>> = { pictures: 'image', links: 'link', files: 'file' };

/** How long after the last key the search goes out (docs/search.md, "In the app"). */
const TYPE_PAUSE_MS = 150;

/** `onBack` when searching is a page (one conversation's): App knows where that goes back to. */
export default function SearchPane({ q, onBack }: { q: string; onBack?: () => void }) {
  rev.value;
  const [page, setPage] = useState<P.SearchPage | null>(null);
  const [hits, setHits] = useState<P.SearchHit[]>([]);
  const [loading, setLoading] = useState(false);
  const [tab, setTab] = useState<Tab>('all');
  const scope = scopeOf(q);
  // The box shows what you typed. A conversation scope is the chip below it, not an opaque id in the text.
  const typed = scope ? setSearchOp(q, 'in', null) : q;
  const [draft, setDraft] = useState(typed);
  const box = useRef<HTMLInputElement>(null);
  const list = useRef<HTMLDivElement>(null);
  const set = (next: string) => {
    sent.current = next;
    go({ view: 'search', q: next }, true);
  };
  // The query this pane last put in the route: a different one came from elsewhere (a chip, Back, a link) and resets the box.
  const sent = useRef(q);
  const absorb = (p: P.SearchPage) => p.identities.forEach((i) => db.identities.set(i.id, i));
  const asked = TAB_HAS[tab] ? setSearchOp(q, 'has', TAB_HAS[tab]!) : q;
  const ask = (query: string, cursor?: string) => api<P.SearchPage>(`/api/search?q=${encodeURIComponent(query)}&context=1${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ''}`);
  useEffect(() => {
    if (q !== sent.current) (sent.current = q, setDraft(typed));
  }, [q]);
  // As you type: the search goes out a moment after the last key, no Enter needed.
  useEffect(() => {
    const next = scope ? setSearchOp(draft, 'in', scope.id) : draft;
    if (next === q) return;
    const t = setTimeout(() => set(next), TYPE_PAUSE_MS);
    return () => clearTimeout(t);
  }, [draft]);
  const focusAsked = focusSearch.value;
  useEffect(() => {
    const el = box.current;
    if (!el) return;
    el.focus();
    el.setSelectionRange(el.value.length, el.value.length);
  }, [focusAsked]);
  useEffect(() => {
    if (!q.trim()) {
      setPage(null);
      setHits([]);
      setLoading(false);
      return;
    }
    let live = true;
    setLoading(true);
    // What was found for the last query stays, dimmed, until this one's answer replaces it.
    ask(asked)
      .then((p) => {
        if (!live) return;
        absorb(p);
        setPage(p);
        setHits(p.hits);
      })
      .finally(() => live && setLoading(false));
    return () => {
      live = false;
    };
  }, [asked]);
  const [moreBusy, setMoreBusy] = useState(false);
  const asking = useRef<string | null>(null);
  const current = useRef(asked);
  current.current = asked;
  const more = async () => {
    const from = page;
    const was = asked;
    if (!from?.next || asking.current) return;
    asking.current = was;
    setMoreBusy(true);
    try {
      // A corrected search pages on as corrected.
      const p = await ask(from.corrected ?? was, from.next);
      if (current.current !== was) return; // another search since
      absorb(p);
      setPage({ ...p, corrected: from.corrected, top: from.top });
      setHits((h) => [...h, ...p.hits]);
    } finally {
      asking.current = null;
      setMoreBusy(false);
    }
  };
  const parsed = parseSearch(q);
  const text = [...parsed.phrases, ...parsed.terms].join(' ');
  const shown = (h: P.SearchHit) => {
    const c = db.conversations.get(h.message.conversationId);
    return !!c && visibleConv(c);
  };
  const visible = hits.filter(shown);
  const top = tab === 'all' && !searchOp(q, 'sort') ? (page?.top ?? []).filter(shown) : [];
  const topIds = new Set(top.map((h) => h.message.id));
  const rest = top.length ? visible.filter((h) => !topIds.has(h.message.id)) : visible;
  const targets = useMemo(jumpTargets, []);
  const jumpAll = scope ? [] : jumpMatches(targets, text, 40);
  const jumps = tab === 'all' ? jumpAll.slice(0, 5) : tab === 'people' ? jumpAll.filter((j) => j.kind === 'person') : tab === 'chats' ? jumpAll.filter((j) => j.kind !== 'person') : [];
  const jumped = new Set(jumps.map((j) => j.key));
  const recent = !q.trim() ? recentSearches() : [];
  const first = () => list.current?.querySelector<HTMLElement>('.search-jump-row, .search-hit')?.focus();
  const remember = () => rememberSearch(q);
  const messagesShown = tab === 'all' || tab === 'messages' || tab === 'links' || tab === 'files';
  return (
    <section class={`pane search-pane ${loading ? 'searching' : ''}`}>
      <header class="conv-head search-head">
        <button class="icon-btn search-back" data-track="pager: back button" onClick={onBack ?? (() => back({ view: 'inbox' }))} aria-label="Back" title="Back">
          <Icon name="back" />
        </button>
        <SearchBox
          class="search-main"
          inputRef={box}
          value={draft}
          setValue={setDraft}
          onDown={first}
          busy={loading}
          placeholder={scope ? `Search in ${scope.label}` : 'Search messages, people and places'}
          submit={(t) => {
            const next = scope ? setSearchOp(t, 'in', scope.id) : t;
            rememberSearch(next);
            set(next);
          }}
        />
        <HeadOrb />
      </header>
      {scope && (
        <div class="search-scope">
          <button class="chip-btn on" title="Search everywhere instead" onClick={() => set(setSearchOp(q, 'in', null))}>
            {scope.network ? <NetGlyph network={scope.network} size={11} /> : <Icon name="user" size={12} />} In {scope.label} <Icon name="x" size={12} />
          </button>
        </div>
      )}
      {q.trim() && (
        <nav class="search-tabs" role="tablist">
          {TABS.filter(([t]) => !scope || (t !== 'people' && t !== 'chats')).map(([t, label]) => (
            <button role="tab" aria-selected={tab === t} class={tab === t ? 'on' : ''} data-track={`search: tab (${t})`} onClick={() => setTab(t)}>
              {label}
            </button>
          ))}
        </nav>
      )}
      {q.trim() && <FilterBar q={q} set={set} />}
      <div class="search-results" ref={list} onKeyDown={(e) => walk(e, box.current)} onClickCapture={(e) => (e.target as HTMLElement).closest('.search-hit, .search-ctx, .search-place, .search-picture') && remember()}>
        {!q.trim() && (
          <Empty icon="search" title="Search everything on this hub">
            Results come as you type. Use "quotes" for a phrase, -word to exclude, or from:, mentions:, in:, has:, is:pinned, network:, account:, before:, during: and after:. Ctrl+F in a chat searches that chat.
          </Empty>
        )}
        {recent.length > 0 && (
          <div class="search-places search-recent">
            {recent.map((r) => (
              <button class="search-place" onClick={() => (rememberSearch(r), set(r))}>
                <Icon name="clock" size={13} /> {readableSearch(r)}
              </button>
            ))}
          </div>
        )}
        {jumps.length > 0 && <h3 class="search-sec">Jump to</h3>}
        <JumpTo found={jumps} text={text} onGo={remember} />
        {(tab === 'all' || tab === 'people') && (page?.people.length ?? 0) > 0 && (
          <>
            {tab === 'all' && <h3 class="search-sec">People</h3>}
            <Places found={page?.people ?? []} skip={jumped} max={tab === 'people' ? 12 : 6} />
          </>
        )}
        {tab === 'all' && <MailGroup q={q} />}
        {loading && !page && <Loading label="Searching…" />}
        {page && messagesShown && !visible.length && !loading && !jumps.length && <Empty icon="search" title="No matching messages">Only what your accounts have fetched is stored here, so older messages may exist on the network.</Empty>}
        {page?.corrected && visible.length > 0 && (
          <p class="set-help search-note">
            Nothing matched “{readableSearch(typed)}”, so these are for <b>{readableSearch(scope ? setSearchOp(page.corrected, 'in', null) : page.corrected)}</b>.
          </p>
        )}
        {page?.mode === 'substring' && visible.length > 0 && <p class="set-help search-note">These match inside words, not whole words.</p>}
        {top.length > 0 && (
          <>
            <h3 class="search-sec">Top matches</h3>
            <Results hits={top} why />
            {rest.length > 0 && <h3 class="search-sec">Newest</h3>}
          </>
        )}
        {tab === 'pictures' && <PictureGrid hits={visible} />}
        {messagesShown && <Results hits={rest} why={searchOp(q, 'sort')?.toLowerCase() === 'relevance'} />}
        {(messagesShown || tab === 'pictures') && page?.next && <MoreResults key={page.next} class="btn ghost small search-more" root=".search-results" busy={moreBusy} onMore={() => void more()} />}
        {messagesShown && page && !loading && <NetworkSearch q={q} local={hits} few={!page.next && visible.length < OFFER_UNDER} />}
      </div>
    </section>
  );
}

