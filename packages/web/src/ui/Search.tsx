import type * as P from '@dither-chat/protocol';
import { mailSearchable, NETWORKS, parseSearch, searchOp, searchOps, setSearchOp, toggleSearchOp } from '@dither-chat/protocol';
import type { ComponentType } from 'preact';
import { useEffect, useRef, useState } from 'preact/hooks';
import { clock, dayLabel } from '../format.ts';
import { allCommunities, authorName, communitiesOf, convLabel, convTitle, netName, people, plainBody, plainMarkdown, resolveTokens, visibleConv } from '../model.ts';
import { api, back, db, go, mailRev, openMessage, openProfile, rev, route } from '../state.ts';
import { retention } from '../history.ts';
import { Avatar, Empty, NetBadge, NetGlyph, Skeleton } from './bits.tsx';
import { Icon } from './icons.tsx';
import { homeRoute } from './Sidebar.tsx';
import { Menuable } from './ContextMenu.tsx';
import { conversationMenu, identityMenu, messageMenu, personMenu, spaceMenu } from './menus.tsx';
import { readableSearch, recentSearches, rememberSearch, SearchBox } from './SearchBox.tsx';
import { preloadMail } from './mail/lazy.tsx';
import { countKey } from '../clicklog.ts';

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

const HAS: [string, string][] = [
  ['attachment', 'Attachment'],
  ['image', 'Image'],
  ['video', 'Video'],
  ['link', 'Link'],
  ['embed', 'Embed'],
  ['reaction', 'Reaction'],
];

const SORTS: [string | null, string][] = [
  [null, 'Newest'],
  ['oldest', 'Oldest'],
  ['relevance', 'Best match'],
];

/** A conversation has no unique name (and a DM has none at all), so the header's button scopes by id. */
function scopeOf(q: string): P.ConversationView | null {
  const id = searchOp(q, 'in');
  return (id && db.conversations.get(id)) || null;
}

const IS: [string, string][] = [
  ['pinned', 'Pinned'],
  ['edited', 'Edited'],
  ['deleted', 'Deleted'],
];

function Filters({ q, set }: { q: string; set: (q: string) => void }) {
  const on = (op: string, val: string) => searchOp(q, op)?.toLowerCase() === val;
  const toggle = (op: string, val: string) => set(setSearchOp(q, op, on(op, val) ? null : val));
  const is = searchOps(q, 'is');
  const field = (op: string, label: string, list?: string, placeholder?: string) => (
    <label class="search-field">
      <span>{label}</span>
      <input class="input" list={list} placeholder={placeholder} value={searchOp(q, op) ?? ''} onChange={(e) => set(setSearchOp(q, op, (e.target as HTMLInputElement).value.trim() || null))} />
    </label>
  );
  const date = (op: string, label: string) => (
    <label class="search-field">
      <span>{label}</span>
      <input class="input" type="date" value={searchOp(q, op) ?? ''} onChange={(e) => set(setSearchOp(q, op, (e.target as HTMLInputElement).value || null))} />
    </label>
  );
  return (
    <div class="search-filters">
      <div class="level-picker">
        {NETWORKS.map((n) => (
          <button class={`chip-btn ${on('network', n) ? 'on' : ''}`} onClick={() => toggle('network', n)}>
            <NetBadge network={n} size={14} /> {netName(n)}
          </button>
        ))}
        {HAS.map(([v, label]) => (
          <button class={`chip-btn ${on('has', v) ? 'on' : ''}`} onClick={() => toggle('has', v)}>
            {label}
          </button>
        ))}
        <button class={`chip-btn ${on('mentions', 'me') ? 'on' : ''}`} onClick={() => toggle('mentions', 'me')}>
          <Icon name="at" size={13} /> Mentions me
        </button>
        {IS.filter(([v]) => v !== 'deleted' || (retention.value.adversarial && retention.value.show !== 'hidden')).map(([v, label]) => (
          <button class={`chip-btn ${is.includes(v) ? 'on' : ''}`} onClick={() => set(toggleSearchOp(q, 'is', v))}>
            {label}
          </button>
        ))}
      </div>
      <div class="search-sort" role="radiogroup" aria-label="Sort">
        {SORTS.map(([v, label]) => {
          const cur = searchOp(q, 'sort')?.toLowerCase();
          const active = v === null ? !cur || cur === 'newest' : cur === v;
          return (
            <button class={active ? 'on' : ''} role="radio" aria-checked={active} onClick={() => set(setSearchOp(q, 'sort', v))}>
              {label}
            </button>
          );
        })}
      </div>
      <div class="search-fields">
        {field('from', 'From', 'search-people', 'Anyone')}
        {!scopeOf(q) && field('in', 'In', 'search-places', 'Anywhere')}
        {date('after', 'After')}
        {date('before', 'Before')}
      </div>
      <datalist id="search-people">
        {[...db.persons.values()].filter((p) => !p.isSelf).map((p) => <option value={p.name} />)}
      </datalist>
      <datalist id="search-places">
        {allCommunities().map((s) => <option value={s.name} />)}
        {[...db.conversations.values()].filter((c) => c.name && visibleConv(c) && c.shape !== 'thread').slice(0, 200).map((c) => <option value={c.name!} />)}
      </datalist>
    </div>
  );
}

function Places({ text }: { text: string }) {
  const n = text.toLowerCase();
  if (n.length < 2) return null;
  const persons = people().map((x) => x.person).filter((p) => p.name.toLowerCase().includes(n)).slice(0, 6);
  const spaces = allCommunities().filter((s) => s.name.toLowerCase().includes(n)).slice(0, 6);
  const convs = [...db.conversations.values()].filter((c) => visibleConv(c) && c.shape !== 'direct' && convTitle(c).toLowerCase().includes(n)).slice(0, 8);
  if (!persons.length && !spaces.length && !convs.length) return null;
  return (
    <div class="search-places">
      {persons.map((p) => (
        <Menuable build={() => personMenu(p)}>{(ctx) => <button class="search-place" onClick={() => go({ view: 'profile', person: p.id })} {...ctx}>
          <Avatar id={p.id} name={p.name} url={p.avatar} size={24} /> {p.name} <small>Person</small>
        </button>}</Menuable>
      ))}
      {spaces.map((s) => (
        <Menuable build={() => spaceMenu(s)}>{(ctx) => <button class="search-place" onClick={() => go({ view: 'space', space: s.id })} {...ctx}>
          <Avatar id={s.id} name={s.name} url={s.icon} size={24} square network={s.network} /> {s.name} <small>{netName(s.network)} community</small>
        </button>}</Menuable>
      ))}
      {convs.map((c) => (
        <Menuable build={() => conversationMenu(c)}>{(ctx) => <button class="search-place" onClick={() => go(homeRoute(c))} {...ctx}>
          <NetGlyph network={c.network} size={14} /> {convLabel(c)} <small>{communitiesOf(c)[0]?.name ?? netName(c.network)}</small>
        </button>}</Menuable>
      ))}
    </div>
  );
}

/** A hit, or a line of what was said around it. */
function Line({ m, hit, snippet }: { m: P.MessageView; hit?: boolean; snippet?: string }) {
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
      </span>
    </button>}</Menuable>
  );
}

/** Hits in a row from one conversation share its heading, as in Discord; context already shown is not shown twice. */
function Results({ hits }: { hits: P.SearchHit[] }) {
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
                <Line m={h.message} hit snippet={h.snippet} />
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

/** Up and Down walk the results; Up from the first goes back to the box. */
function walk(e: KeyboardEvent, box: HTMLInputElement | null) {
  if (e.key !== 'ArrowDown' && e.key !== 'ArrowUp') return;
  const all = [...(e.currentTarget as HTMLElement).querySelectorAll<HTMLElement>('.search-hit')];
  const i = all.indexOf(document.activeElement as HTMLElement);
  if (i < 0) return;
  e.preventDefault();
  const next = all[i + (e.key === 'ArrowDown' ? 1 : -1)];
  if (next) next.focus();
  else if (e.key === 'ArrowUp') box?.focus();
}

/** `onBack` when searching is a page (one conversation's): App knows where that goes back to. */
export function SearchPane({ q, onBack }: { q: string; onBack?: () => void }) {
  rev.value;
  const [page, setPage] = useState<P.SearchPage | null>(null);
  const [hits, setHits] = useState<P.SearchHit[]>([]);
  const [loading, setLoading] = useState(false);
  const scope = scopeOf(q);
  // The box shows what you typed. A conversation scope is the chip below it, not an opaque id in the text.
  const typed = scope ? setSearchOp(q, 'in', null) : q;
  const [draft, setDraft] = useState(typed);
  const box = useRef<HTMLInputElement>(null);
  const list = useRef<HTMLDivElement>(null);
  const set = (next: string) => go({ view: 'search', q: next }, true);
  const absorb = (p: P.SearchPage) => p.identities.forEach((i) => db.identities.set(i.id, i));
  const ask = (query: string, cursor?: string) => api<P.SearchPage>(`/api/search?q=${encodeURIComponent(query)}&context=1${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ''}`);
  useEffect(() => setDraft(typed), [q]);
  useEffect(() => {
    if (!typed) box.current?.focus();
  }, []);
  useEffect(() => {
    if (!q.trim()) {
      setPage(null);
      setHits([]);
      setLoading(false);
      return;
    }
    let live = true;
    setLoading(true);
    ask(q)
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
  }, [q]);
  const more = async () => {
    // A corrected search pages on as corrected.
    const p = await ask(page!.corrected ?? q, page!.next!);
    absorb(p);
    setPage({ ...p, corrected: page!.corrected });
    setHits([...hits, ...p.hits]);
  };
  const parsed = parseSearch(q);
  const text = [...parsed.phrases, ...parsed.terms].join(' ');
  const visible = hits.filter((h) => {
    const c = db.conversations.get(h.message.conversationId);
    return c && visibleConv(c);
  });
  const strangers = (page?.people ?? []).filter((id) => !db.identities.get(id)?.personId).slice(0, 6);
  const recent = !q.trim() ? recentSearches() : [];
  const first = () => list.current?.querySelector<HTMLElement>('.search-hit')?.focus();
  return (
    <section class="pane search-pane">
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
          placeholder={scope ? `Search in ${convTitle(scope)}` : 'Search messages, people and places'}
          submit={(t) => {
            const next = scope ? setSearchOp(t, 'in', scope.id) : t;
            rememberSearch(next);
            set(next);
          }}
        />
      </header>
      {scope && (
        <div class="search-scope">
          <button class="chip-btn on" title="Search everywhere instead" onClick={() => set(setSearchOp(q, 'in', null))}>
            <NetGlyph network={scope.network} size={11} /> In {scope.shape === 'direct' ? convTitle(scope) : convLabel(scope)} <Icon name="x" size={12} />
          </button>
        </div>
      )}
      <Filters q={q} set={set} />
      <div class="search-results" ref={list} onKeyDown={(e) => walk(e, box.current)}>
        {!q.trim() && (
          <Empty icon="search" title="Search everything on this hub">
            Words match anywhere in a message and the last one matches as a prefix. Use "quotes" for a phrase, -word to exclude, or from:, mentions:, in:, has:, is:pinned, network:, account:, before:, during: and after:. Ctrl+F in a chat searches that chat.
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
        <Places text={text} />
        {strangers.length > 0 && (
          <div class="search-places">
            {strangers.map((id) => (
              <Menuable build={() => identityMenu(id)}>{(ctx) => <button class="search-place" onClick={() => openProfile(id)} {...ctx}>
                <Avatar id={id} name={authorName(id)} url={db.identities.get(id)?.avatar} size={24} network={db.identities.get(id)?.network} /> {authorName(id)} <small>Seen in chats</small>
              </button>}</Menuable>
            ))}
          </div>
        )}
        <MailGroup q={q} />
        {loading && <Skeleton rows={4} />}
        {page && !loading && !visible.length && <Empty icon="search" title="No matching messages">Only what your accounts have fetched is stored here, so older messages may exist on the network.</Empty>}
        {page?.corrected && visible.length > 0 && (
          <p class="set-help search-note">
            Nothing matched “{readableSearch(typed)}”, so these are for <b>{readableSearch(scope ? setSearchOp(page.corrected, 'in', null) : page.corrected)}</b>.
          </p>
        )}
        {page?.mode === 'substring' && visible.length > 0 && <p class="set-help search-note">These match inside words, not whole words.</p>}
        <Results hits={visible} />
        {page?.next && (
          <button class="btn ghost small search-more" onClick={more}>
            More results
          </button>
        )}
      </div>
    </section>
  );
}

/** Ctrl+F: search the chat you are in, or with search open, go to its box. */
export function FindShortcut() {
  useEffect(() => {
    const k = (e: KeyboardEvent) => {
      if (!(e.ctrlKey || e.metaKey) || e.shiftKey || e.altKey || e.key.toLowerCase() !== 'f') return;
      e.preventDefault();
      countKey('keys: Ctrl+F (search)');
      const r = route.value;
      const input = document.querySelector<HTMLInputElement>('.search-pane .search-main input');
      if (r.view === 'search' && !r.conv && input) return (input.focus(), input.select());
      const conv = r.view !== 'profile' && 'conv' in r ? r.conv : undefined;
      go({ view: 'search', q: conv ? `in:${conv}` : '' });
    };
    window.addEventListener('keydown', k);
    return () => window.removeEventListener('keydown', k);
  }, []);
  return null;
}
