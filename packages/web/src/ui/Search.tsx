import type * as P from '@dither-chat/protocol';
import { parseSearch, searchOp, setSearchOp } from '@dither-chat/protocol';
import { useEffect, useRef, useState } from 'preact/hooks';
import { clock, dayLabel } from '../format.ts';
import { allCommunities, authorName, communitiesOf, convLabel, convTitle, netName, people, resolveTokens, visibleConv } from '../model.ts';
import { api, db, go, openMessage, openProfile, rev, route } from '../state.ts';
import { Avatar, Empty, NetBadge, NetGlyph } from './bits.tsx';
import { Icon } from './icons.tsx';
import { homeRoute } from './Sidebar.tsx';

/** Split a snippet into text and matches. It is plain text, so it stays out of innerHTML. */
function Snippet({ text, network }: { text: string; network: P.Network }) {
  return (
    <>
      {resolveTokens(text, network)
        .split(/(\u0001[^\u0002]*\u0002)/)
        .map((part) => (part.startsWith('\u0001') ? <mark>{part.slice(1, -1)}</mark> : part))}
    </>
  );
}

const HAS: [string, string][] = [
  ['attachment', 'Attachment'],
  ['image', 'Image'],
  ['link', 'Link'],
  ['reaction', 'Reaction'],
];

/** A conversation has no unique name (and a DM has none at all), so the header's button scopes by id. */
function scopeOf(q: string): P.ConversationView | null {
  const id = searchOp(q, 'in');
  return (id && db.conversations.get(id)) || null;
}

function Filters({ q, set }: { q: string; set: (q: string) => void }) {
  const on = (op: string, val: string) => searchOp(q, op)?.toLowerCase() === val;
  const toggle = (op: string, val: string) => set(setSearchOp(q, op, on(op, val) ? null : val));
  const field = (op: string, label: string, list?: string) => (
    <label class="search-field">
      <span>{label}</span>
      <input class="input" list={list} value={searchOp(q, op) ?? ''} onChange={(e) => set(setSearchOp(q, op, (e.target as HTMLInputElement).value.trim() || null))} />
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
        {(['discord', 'signal', 'matrix'] as const).map((n) => (
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
        <button class={`chip-btn ${on('sort', 'relevance') ? 'on' : ''}`} onClick={() => toggle('sort', 'relevance')}>
          Best match
        </button>
      </div>
      <div class="search-fields">
        {field('from', 'From', 'search-people')}
        {!scopeOf(q) && field('in', 'In', 'search-places')}
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
        <button class="search-place" onClick={() => go({ view: 'profile', person: p.id })}>
          <Avatar id={p.id} name={p.name} url={p.avatar} size={24} /> {p.name} <small>Person</small>
        </button>
      ))}
      {spaces.map((s) => (
        <button class="search-place" onClick={() => go({ view: 'space', space: s.id })}>
          <Avatar id={s.id} name={s.name} url={s.icon} size={24} square network={s.network} /> {s.name} <small>{netName(s.network)} community</small>
        </button>
      ))}
      {convs.map((c) => (
        <button class="search-place" onClick={() => go(homeRoute(c))}>
          <NetGlyph network={c.network} size={14} /> {convLabel(c)} <small>{communitiesOf(c)[0]?.name ?? netName(c.network)}</small>
        </button>
      ))}
    </div>
  );
}

export function SearchPane({ q }: { q: string }) {
  rev.value;
  const [page, setPage] = useState<P.SearchPage | null>(null);
  const [hits, setHits] = useState<P.SearchHit[]>([]);
  const [loading, setLoading] = useState(false);
  const scope = scopeOf(q);
  // The box shows what you typed. A conversation scope is the chip below it, not an opaque id in the text.
  const typed = scope ? setSearchOp(q, 'in', null) : q;
  const [draft, setDraft] = useState(typed);
  const box = useRef<HTMLInputElement>(null);
  const set = (next: string) => go({ view: 'search', q: next }, true);
  const absorb = (p: P.SearchPage) => p.identities.forEach((i) => db.identities.set(i.id, i));
  useEffect(() => setDraft(typed), [q]);
  useEffect(() => {
    if (!typed) box.current?.focus();
  }, []);
  useEffect(() => {
    if (!q.trim()) {
      setPage(null);
      setHits([]);
      return;
    }
    let live = true;
    setLoading(true);
    api<P.SearchPage>(`/api/search?q=${encodeURIComponent(q)}`)
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
    const p = await api<P.SearchPage>(`/api/search?q=${encodeURIComponent(q)}&cursor=${encodeURIComponent(page!.next!)}`);
    absorb(p);
    setPage(p);
    setHits([...hits, ...p.hits]);
  };
  const parsed = parseSearch(q);
  const text = [...parsed.phrases, ...parsed.terms].join(' ');
  const visible = hits.filter((h) => {
    const c = db.conversations.get(h.message.conversationId);
    return c && visibleConv(c);
  });
  const strangers = (page?.people ?? []).filter((id) => !db.identities.get(id)?.personId).slice(0, 6);
  return (
    <section class="pane search-pane">
      <header class="conv-head search-head">
        <button class="icon-btn" onClick={() => go({ view: 'inbox' })} aria-label="Back" title="Back">
          <Icon name="back" />
        </button>
        <form
          class="search search-main"
          onSubmit={(e) => {
            e.preventDefault();
            set(scope ? setSearchOp(draft.trim(), 'in', scope.id) : draft.trim());
          }}
        >
          <Icon name="search" size={15} />
          <input ref={box} aria-label="Search" placeholder={scope ? `Search in ${convTitle(scope)}` : 'Search messages, people and places'} value={draft} onInput={(e) => setDraft((e.target as HTMLInputElement).value)} />
        </form>
      </header>
      {scope && (
        <div class="search-scope">
          <button class="chip-btn on" title="Search everywhere instead" onClick={() => set(setSearchOp(q, 'in', null))}>
            <NetGlyph network={scope.network} size={11} /> In {scope.shape === 'direct' ? convTitle(scope) : convLabel(scope)} <Icon name="x" size={12} />
          </button>
        </div>
      )}
      <Filters q={q} set={set} />
      <div class="search-results">
        {!q.trim() && (
          <Empty icon="search" title="Search everything on this hub">
            Words match anywhere in a message and the last one matches as a prefix. Use "quotes" for a phrase, -word to exclude, or from:, in:, network:, has:, mentions:me, after: and before:.
          </Empty>
        )}
        <Places text={text} />
        {strangers.length > 0 && (
          <div class="search-places">
            {strangers.map((id) => (
              <button class="search-place" onClick={() => openProfile(id)}>
                <Avatar id={id} name={authorName(id)} url={db.identities.get(id)?.avatar} size={24} network={db.identities.get(id)?.network} /> {authorName(id)} <small>Seen in chats</small>
              </button>
            ))}
          </div>
        )}
        {loading && <div class="timeline-loading">Searching…</div>}
        {page && !loading && !visible.length && <Empty icon="search" title="No matching messages">Only what your accounts have fetched is stored here, so older messages may exist on the network.</Empty>}
        {page?.mode === 'substring' && visible.length > 0 && <p class="set-help search-note">No whole-word match, so these match inside words.</p>}
        {visible.map(({ message: m, snippet }) => {
          const c = db.conversations.get(m.conversationId)!;
          const com = communitiesOf(c)[0];
          return (
            <button class="search-hit" onClick={() => openMessage(c.id, m.id)}>
              <Avatar id={m.authorId ?? m.id} name={authorName(m.authorId)} url={db.identities.get(m.authorId ?? '')?.avatar} size={30} network={m.network} />
              <span class="search-hit-main">
                <span class="search-hit-top">
                  <b>{authorName(m.authorId)}</b>
                  <span class="search-hit-place">
                    <NetGlyph network={m.network} size={10} /> {c.shape === 'direct' ? convTitle(c) : convLabel(c)}
                    {com ? ` · ${com.name}` : ''}
                  </span>
                  <span class="search-hit-time">{dayLabel(m.ts)} {clock(m.ts)}</span>
                </span>
                <span class="search-hit-body">
                  <Snippet text={snippet} network={m.network} />
                  {m.attachments.length > 0 && <span class="search-att"> <Icon name="file" size={11} /> {m.attachments.length}</span>}
                </span>
              </span>
            </button>
          );
        })}
        {page?.next && (
          <button class="btn ghost small search-more" onClick={more}>
            More results
          </button>
        )}
      </div>
    </section>
  );
}
