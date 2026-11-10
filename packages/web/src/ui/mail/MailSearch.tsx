/**
 * Mail search (docs/mail.md, slice 7). In Mail, a search is a list key (`s:<query>`, protocol searchList), so the
 * route needs nothing new: the sidebar shows this in place of a list, and a thread opens beside it as from a list.
 *
 * The hub's own hits come at once (GET /api/mail/search); when they are under 20, or when you ask, the servers are
 * searched too, and what only they found shows after, under "On the server", with each server's note (Proton cannot
 * search the text of messages). MailSearchGroup is the app search page's Mail group: the hub's top five.
 */
import type * as P from '@dither-chat/protocol';
import { searchList, searchOps, setSearchOp, toggleSearchOp } from '@dither-chat/protocol';
import { useEffect, useRef, useState } from 'preact/hooks';
import { senderLine } from '../../mail/model.ts';
import { api, db, go, mailRev } from '../../state.ts';
import { mailChanged } from '../../versions.ts';
import { Avatar, Empty, Skeleton } from '../bits.tsx';
import { Icon } from '../icons.tsx';
import { listTime } from './MessageCard.tsx';

/** Under this many of the hub's own hits, the servers are asked without asking you. */
const ASK_SERVER_UNDER = 20;

interface Found {
  q: string;
  hits: P.MailSearchHit[];
  next: string | null;
  mode: P.MailSearchPage['mode'] | null;
  corrected: string | null;
  loading: boolean;
  error: string | null;
  server: P.MailSearchPage['server'] | null;
  serverLoading: boolean;
}

/** The last few searches, so going back from a thread shows them at once. */
const held = new Map<string, Found>();
const keep = (f: Found) => {
  held.delete(f.q);
  held.set(f.q, f);
  while (held.size > 6) held.delete(held.keys().next().value!);
  mailChanged();
};

/** A search's answer, unless it has been dropped from `held` meanwhile. */
const update = (q: string, patch: Partial<Found>) => {
  const f = held.get(q);
  if (f) keep({ ...f, ...patch });
};

const ask = (q: string, o: { cursor?: string | null; limit?: number; server?: boolean } = {}) =>
  api<P.MailSearchPage>(`/api/mail/search?q=${encodeURIComponent(q)}&limit=${o.limit ?? 50}${o.cursor ? `&cursor=${encodeURIComponent(o.cursor)}` : ''}${o.server ? '&server=1' : ''}`);

/** Threads from a page go where the reader and the lists find them. */
const absorb = (hits: P.MailSearchHit[]) => hits.forEach((h) => db.mail.threads.set(h.thread.id, h.thread));

async function run(q: string) {
  keep({ q, hits: [], next: null, mode: null, corrected: null, loading: true, error: null, server: null, serverLoading: false });
  try {
    const p = await ask(q);
    absorb(p.hits);
    update(q, { hits: p.hits, next: p.next, mode: p.mode, corrected: p.corrected ?? null, loading: false });
    if (p.hits.length < ASK_SERVER_UNDER && !p.next) void askServers(q);
  } catch (e) {
    update(q, { loading: false, error: (e as Error).message });
  }
}

async function more(q: string) {
  const f = held.get(q);
  if (!f?.next || f.loading) return;
  update(q, { loading: true });
  try {
    // A corrected search pages on as corrected.
    const p = await ask(f.corrected ?? q, { cursor: f.next });
    absorb(p.hits);
    const have = new Set(f.hits.map((h) => h.thread.id));
    update(q, { hits: [...f.hits, ...p.hits.filter((h) => !have.has(h.thread.id))], next: p.next, loading: false });
  } catch (e) {
    update(q, { loading: false, error: (e as Error).message });
  }
}

async function askServers(q: string) {
  const f = held.get(q);
  if (!f || f.serverLoading) return;
  update(q, { serverLoading: true });
  try {
    const p = await ask(q, { limit: 1, server: true });
    absorb(p.server?.hits ?? []);
    update(q, { server: p.server ?? { hits: [], accounts: [] }, serverLoading: false });
  } catch (e) {
    update(q, { server: { hits: [], accounts: [] }, serverLoading: false, error: (e as Error).message });
  }
}

/** A snippet's matches, marked; it is plain text, so it stays out of innerHTML. */
function Marked({ text }: { text: string }) {
  return (
    <>
      {text.split(/(\u0001[^\u0002]*\u0002)/).map((part) => (part.startsWith('\u0001') ? <mark>{part.slice(1, -1)}</mark> : part))}
    </>
  );
}

/** One thread found: who wrote, when the matching message came, the subject, and what matched. */
function HitRow({ hit, list, active, showAccount }: { hit: P.MailSearchHit; list: string; active?: boolean; showAccount: boolean }) {
  // The hub's newer copy of the thread, once it has sent one (read, starred).
  const t = db.mail.threads.get(hit.thread.id) ?? hit.thread;
  const other = [...t.from].reverse().find((f) => !f.self) ?? t.from[t.from.length - 1];
  const name = other?.name || other?.email || '?';
  const account = db.mail.accounts.get(t.accountId);
  return (
    <button class={`row mail-row mail-hit ${active ? 'active' : ''} ${t.unread ? 'unread' : ''}`} data-thread={t.id} onClick={() => go({ view: 'mail', list, thread: t.id })}>
      <span class="row-avatar">
        <Avatar id={other?.email ?? t.id} name={name} size={36} />
      </span>
      <span class="row-main">
        <span class="row-top">
          <span class="row-title">
            {showAccount && account && <span class="mail-acc-dot" style={{ background: account.color }} title={account.address ?? account.label} />}
            <span class="mail-row-who">{senderLine(t)}</span>
            {t.count > 1 && <span class="mail-count">{t.count}</span>}
          </span>
          {t.flagged && <Icon name="star" size={12} class="mail-star" />}
          {t.attachments && <Icon name="paperclip" size={12} class="mail-clip" />}
          <span class="row-time">{listTime(hit.at)}</span>
        </span>
        <span class="row-bottom">
          <span class="mail-row-subject">{t.subject || '(no subject)'}</span>
          {hit.matches > 1 && <span class="mail-hit-n" title={`${hit.matches} messages in it match`}>{hit.matches}</span>}
          {t.unread > 0 && <span class="unread-dot" />}
        </span>
        {(hit.snippet || t.preview) && (
          <span class="row-bottom">
            <span class="row-preview mail-hit-snip">{hit.snippet ? <Marked text={hit.snippet} /> : t.preview}</span>
          </span>
        )}
      </span>
    </button>
  );
}

const CHIPS: [string, string, string][] = [
  ['is', 'unread', 'Unread'],
  ['is', 'starred', 'Starred'],
  ['has', 'attachment', 'Attachment'],
];

/** What the servers said: who could not be asked, and what they cannot search. */
function ServerNotes({ server }: { server: NonNullable<P.MailSearchPage['server']> }) {
  const label = (id: string) => {
    const a = db.mail.accounts.get(id);
    return a?.address ?? a?.label ?? id;
  };
  const lines = server.accounts.flatMap((a) => [
    ...(a.state === 'failed' || a.state === 'offline' ? [`${label(a.accountId)}: ${a.state === 'offline' ? 'not searched' : 'the search failed'}${a.error ? ` (${a.error})` : ''}.`] : []),
    ...(a.note ? [`${label(a.accountId)}: ${a.note}`] : []),
  ]);
  if (!lines.length) return null;
  return (
    <div class="mail-search-notes">
      {lines.map((l) => (
        <p class="mail-list-note mail-search-note">{l}</p>
      ))}
    </div>
  );
}

export function MailSearch({ q, active }: { q: string; active?: string }) {
  mailRev.value;
  const [draft, setDraft] = useState(q);
  const box = useRef<HTMLInputElement>(null);
  const list = searchList(q);
  const f = q.trim() ? held.get(q) : undefined;
  useEffect(() => setDraft(q), [q]);
  useEffect(() => {
    if (!q.trim()) box.current?.focus();
    else if (!held.has(q)) void run(q);
  }, [q]);
  const set = (next: string) => go({ view: 'mail', list: searchList(next.trim()) }, true);
  const showAccount = db.mail.accounts.size > 1;
  const serverHits = f?.server?.hits ?? [];
  return (
    <div class="mail-search">
      <form
        class="search search-box mail-search-box"
        role="search"
        onSubmit={(e) => {
          e.preventDefault();
          // What is in the box now, even before an input's render has caught up. The same again: search again.
          const next = (box.current?.value ?? draft).trim();
          if (next === q && next) void run(q);
          else set(next);
        }}
      >
        <Icon name="search" size={15} />
        <input ref={box} aria-label="Search mail" placeholder="Search mail" enterkeyhint="search" value={draft} onInput={(e) => setDraft((e.target as HTMLInputElement).value)} />
        {draft && (
          <button type="button" class="icon-btn small" aria-label="Clear" title="Clear" onClick={() => (setDraft(''), set(''), box.current?.focus())}>
            <Icon name="x" size={14} />
          </button>
        )}
      </form>
      <div class="inbox-chips mail-chips mail-search-chips" role="group" aria-label="Only">
        {CHIPS.map(([op, v, label]) => {
          const on = searchOps(q, op).includes(v);
          return (
            <button class={`chip-btn ${on ? 'on' : ''}`} aria-pressed={on} onClick={() => set(op === 'is' ? toggleSearchOp(q, op, v) : setSearchOp(q, op, on ? null : v))}>
              {label}
            </button>
          );
        })}
      </div>
      <div class="side-scroll mail-list" aria-label="Mail found" aria-busy={!!f?.loading}>
        {!q.trim() && (
          <Empty icon="search" title="Search your mail">
            Words match subjects, people and the text of mail this hub has fetched; the servers are searched too when few match here. from:, to:, with:, subject:, in:, label:, has:attachment, is:unread, is:starred, account:, before:, during: and after: narrow it.
          </Empty>
        )}
        {f?.corrected && f.hits.length > 0 && (
          <p class="mail-list-note">
            Nothing matched “{q}”, so these are for <b>{f.corrected}</b>.
          </p>
        )}
        {f?.mode === 'substring' && f.hits.length > 0 && <p class="mail-list-note">These match inside words, not whole words.</p>}
        {f?.hits.map((h) => <HitRow key={h.thread.id} hit={h} list={list} active={h.thread.id === active} showAccount={showAccount} />)}
        {f?.loading && <Skeleton rows={f.hits.length ? 2 : 6} />}
        {f?.error && (
          <div class="mail-list-note" role="alert">
            Could not search: {f.error}{' '}
            <button class="link-btn" onClick={() => void run(q)}>
              Try again
            </button>
          </div>
        )}
        {f && !f.loading && f.next && (
          <button class="mail-more" onClick={() => void more(q)}>
            More results
          </button>
        )}
        {f && !f.loading && !f.next && !f.server && !f.serverLoading && f.hits.length > 0 && (
          <button class="mail-more" onClick={() => void askServers(q)}>
            Search the servers too
          </button>
        )}
        {f?.serverLoading && <p class="mail-list-note">Searching the servers…</p>}
        {serverHits.length > 0 && (
          <>
            <h3 class="mail-search-head">On the server</h3>
            {serverHits.map((h) => (
              <HitRow key={h.thread.id} hit={h} list={list} active={h.thread.id === active} showAccount={showAccount} />
            ))}
          </>
        )}
        {f && !f.loading && !f.serverLoading && !f.hits.length && !serverHits.length && !f.error && (
          <Empty icon="search" title="No mail matches">
            {f.server ? 'Not here, and not on the servers either.' : 'Only mail this hub holds is searched here.'}
          </Empty>
        )}
        {f?.server && <ServerNotes server={f.server} />}
      </div>
    </div>
  );
}

/** The app search page's Mail group: the hub's own top five, and the way to the rest in Mail. */
export function MailSearchGroup({ q }: { q: string }) {
  mailRev.value;
  const [page, setPage] = useState<{ q: string; hits: P.MailSearchHit[]; more: boolean } | null>(null);
  useEffect(() => {
    let live = true;
    ask(q, { limit: 5 })
      .then((p) => {
        if (!live) return;
        absorb(p.hits);
        setPage({ q, hits: p.hits, more: !!p.next });
      })
      .catch(() => live && setPage({ q, hits: [], more: false }));
    return () => {
      live = false;
    };
  }, [q]);
  if (!page || page.q !== q || !page.hits.length) return null;
  const list = searchList(q);
  return (
    <section class="search-group mail-search-group" aria-label="Mail">
      <button class="search-group-head" tabIndex={-1} onClick={() => go({ view: 'mail', list })}>
        <Icon name="mail" size={12} /> Mail
      </button>
      {page.hits.map((h) => (
        <HitRow key={h.thread.id} hit={h} list={list} showAccount={db.mail.accounts.size > 1} />
      ))}
      <button class="link-btn mail-search-all" onClick={() => go({ view: 'mail', list })}>
        {page.more ? 'More in Mail' : 'Open in Mail'}
      </button>
    </section>
  );
}
