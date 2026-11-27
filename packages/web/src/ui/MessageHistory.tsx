/**
 * One message's history as one list (docs/history.md "A message's history"), latest at the bottom: what it says now
 * on top, then from when it was sent, each edit as the words it took out and put in, reactions made and taken back
 * (docs/reactions.md "When"), pins, and for your own who got and read it. On a computer it hangs from what opened it;
 * on a phone it is a page of its own. Rows and focus: messageHistory.ts. A chunk of its own, loaded the first time one
 * opens (MessageHistoryLazy.tsx).
 */
import type * as P from '@dither-chat/protocol';
import { createPortal } from 'preact/compat';
import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'preact/hooks';
import { clock, dayLabel, fullTime, sameDay } from '../format.ts';
import { changesInContext, historyItems, type HistoryItem } from '../historyRows.ts';
import { historyOf, type HistoryFocus } from '../messageHistory.ts';
import { identityName, plainBody } from '../model.ts';
import { phone, useLayer } from '../phone.ts';
import { whenTitle } from '../reactions.ts';
import { api, db, isSelfIdentity, metaRev, rev } from '../state.ts';
import { wordDiff, type Part } from '../wordDiff.ts';
import { Avatar } from './bits.tsx';
import { Icon } from './icons.tsx';
import { Loading } from './Loader.tsx';
import { Glyph } from './Reactions.tsx';
import './MessageHistory.css';

import { STATE } from './Ticks.tsx';
const TITLE: Record<HistoryFocus, string> = { all: 'History', edits: 'Edits', reactions: 'Reactions' };

export function MessageHistoryLayer() {
  const open = historyOf.value;
  return open ? <HistoryLayer key={open.m.id} m={open.m} focus={open.focus} anchor={open.anchor} /> : null;
}

/** A computer's popover by what opened it, or a phone's page; Escape and back close it (phone.ts layers). */
function HistoryLayer({ m, focus: first, anchor }: { m: P.MessageView; focus: HistoryFocus; anchor?: DOMRect }) {
  const [focus, setFocus] = useState(first);
  const close = () => (historyOf.value = null);
  useLayer(close);
  useLayoutEffect(() => {
    const k = (e: KeyboardEvent) => e.key === 'Escape' && (e.preventDefault(), close());
    window.addEventListener('keydown', k);
    return () => window.removeEventListener('keydown', k);
  }, []);
  const box = useRef<HTMLDivElement>(null);
  const page = phone.value;
  // The side it first opened on, so growing (its rows loading, or switching to all of it) keeps it there rather than
  // jumping.
  const side = useRef<'below' | 'above' | null>(null);
  // Below what opened it when there is room for most of it, else above; inside the window either way, placed again
  // whenever its size changes (it first draws as "Loading…", far shorter than its rows).
  useLayoutEffect(() => {
    const el = box.current;
    if (!el || page) return;
    const place = () => {
      const { width: w, height: h } = el.getBoundingClientRect();
      if (!anchor) {
        el.style.left = `${Math.max(8, (innerWidth - w) / 2)}px`;
        el.style.top = `${Math.max(8, (innerHeight - h) / 3)}px`;
        return;
      }
      el.style.left = `${Math.max(8, Math.min(innerWidth - w - 8, anchor.left))}px`;
      const below = innerHeight - anchor.bottom - 14, above = anchor.top - 14;
      side.current ??= below >= 300 || below >= above ? 'below' : 'above';
      el.style.top = `${side.current === 'below' ? Math.max(8, Math.min(anchor.bottom + 6, innerHeight - h - 8)) : Math.max(8, anchor.top - h - 6)}px`;
    };
    place();
    const ro = new ResizeObserver(place);
    ro.observe(el);
    return () => ro.disconnect();
  }, [page, anchor]);
  const body = <MessageHistory m={m} focus={focus} onAll={() => setFocus('all')} page={page} />;
  if (page)
    return createPortal(
      <div class="mh-page" role="dialog" aria-modal="true" aria-label="Message history" ref={box}>
        <header class="mh-page-head">
          <button class="icon-btn" onClick={close} aria-label="Back">
            <Icon name="back" />
          </button>
          <h2>{focus === 'all' ? 'Message history' : TITLE[focus]}</h2>
        </header>
        {body}
      </div>,
      document.body,
    );
  return createPortal(
    <div class="mh-layer" onMouseDown={(e) => e.target === e.currentTarget && close()}>
      <div class="mh-pop" role="dialog" aria-label="Message history" ref={box}>
        {body}
      </div>
    </div>,
    document.body,
  );
}

const nameOf = (id?: string | null) => (!id ? 'Someone' : isSelfIdentity(id) ? 'You' : (db.persons.get(db.identities.get(id)?.personId ?? '')?.name ?? identityName(id)));

/** The list itself: what it says now, then its history from the start, scrolled to the latest. */
function MessageHistory({ m, focus, onAll, page }: { m: P.MessageView; focus: HistoryFocus; onAll?: () => void; page?: boolean }) {
  rev.value;
  const [h, setH] = useState<P.MessageHistoryView | null>(null);
  useEffect(() => {
    api<P.MessageHistoryView>(`/api/messages/${m.id}/history`).then(
      (x) => {
        for (const i of x.identities) if (!db.identities.has(i.id)) db.identities.set(i.id, i);
        setH(x);
      },
      () => setH({ versions: [{ body: m.body, at: m.editedTs ?? m.ts }], events: [], reactions: [], receipts: [], identities: [] }),
    );
  }, [m.id, m.body, m.events, m.reactions, m.receipts?.read, m.receipts?.delivered]);
  const items = useMemo(() => (h ? historyItems(m, h, focus) : []), [h, focus, m]);
  const list = useRef<HTMLDivElement>(null);
  // The latest is at the bottom: start there, and again when the list changes under you.
  useLayoutEffect(() => {
    const el = list.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [items]);
  const last = h?.versions.at(-1);
  const edited = (h?.versions.length ?? 0) > 1;
  return (
    <div class={`mh ${page ? 'page' : ''}`}>
      <div class="mh-now">
        {page ? (
          <div class="mh-now-who">
            <Face id={m.authorId} size={36} />
            <div>
              <b>{nameOf(m.authorId)}</b> <time>{fullTime(m.ts)}</time>
              <p>{plainBody(m.body, m.network) || 'Empty'}</p>
            </div>
          </div>
        ) : (
          <>
            <span class="mh-meta">{edited && last?.at ? `Now · edited ${clock(last.at)}` : 'Now'}</span>
            <p>{plainBody(m.body, m.network) || 'Empty'}</p>
          </>
        )}
      </div>
      {/* Opened on a part of it: which, and the way to all of it. All of it needs no heading. */}
      {focus !== 'all' && (
        <div class="mh-bar">
          <h4>{TITLE[focus]}</h4>
          {onAll && (
            <button class="link" onClick={onAll}>
              All history
            </button>
          )}
        </div>
      )}
      <div class="mh-list" ref={list}>
        {!h ? <Loading label="Loading…" /> : items.length ? <Rows m={m} items={items} page={page} /> : <p class="mh-empty">Nothing kept about this message yet.</p>}
      </div>
    </div>
  );
}

function Rows({ m, items, page }: { m: P.MessageView; items: HistoryItem[]; page?: boolean }) {
  // A custom emoji still on the message draws as itself; one taken back from it, by its name.
  const glyph = (key: string) => <Glyph k={key} emoji={m.reactions.find((r) => r.key === key)?.emoji} size={15} />;
  const out = [];
  // Days only where there is more than today to tell apart.
  const now = Date.now();
  const days = items.some((it) => !sameDay(it.at, now));
  let day: number | null = null;
  for (const it of items) {
    if (days && (day === null || !sameDay(day, it.at))) {
      day = it.at;
      out.push(<div class="mh-day">{dayLabel(it.at)}</div>);
    }
    out.push(<Row it={it} glyph={glyph} m={m} face={page ? 20 : 16} />);
  }
  return <>{out}</>;
}

function Time({ at, seen, from }: { at: number; seen?: boolean; from?: number }) {
  const span = from != null && clock(from) !== clock(at) ? `${clock(from)}–${clock(at)}` : clock(at);
  return (
    <time title={seen ? whenTitle({ at, seen: true }) : fullTime(at)}>
      {seen ? '~' : ''}
      {span}
    </time>
  );
}

function Row({ it, glyph, m, face }: { it: HistoryItem; glyph: (key: string) => preact.JSX.Element; m: P.MessageView; face: number }) {
  metaRev.value; // who did each thing, by name
  const [open, setOpen] = useState(false);
  switch (it.kind) {
    case 'sent':
      return (
        <div class="mh-row">
          <Icon name="send" size={14} />
          <span class="mh-what">
            <b>{nameOf(m.authorId)}</b> sent it
          </span>
          <Time at={it.at} />
        </div>
      );
    case 'edit': {
      const before = plainBody(it.before, m.network), after = plainBody(it.after, m.network);
      const short = changesInContext(before, after);
      // "Whole text" only where words were left out.
      const cut = short.some((p) => p.k === 'gap');
      return (
        <div class="mh-row">
          <Icon name="pencil" size={14} />
          <span class="mh-what">
            <b>{nameOf(it.actorId)}</b> edited it
            <span class="mh-text">
              <Diff parts={open ? wordDiff(before, after) : short} />
              {/* At the end of the words, not a line of its own. */}
              {cut && (
                <button class="link mh-more" onClick={() => setOpen(!open)}>
                  {open ? 'Less' : 'Whole text'}
                </button>
              )}
            </span>
          </span>
          <Time at={it.at} />
        </div>
      );
    }
    case 'react':
    case 'unreact':
      return (
        <div class={`mh-row ${it.kind === 'unreact' ? 'quiet' : ''}`}>
          <Face id={it.actorId} size={face} />
          <span class="mh-what">
            {it.kind === 'react' ? (
              <>
                <b>{nameOf(it.actorId)}</b> reacted {glyph(it.key)}
              </>
            ) : it.cleared ? (
              <>
                <b>{nameOf(it.actorId)}</b> had {glyph(it.key)} removed by a moderator
              </>
            ) : (
              <>
                <b>{nameOf(it.actorId)}</b> took back {glyph(it.key)}
              </>
            )}
          </span>
          <Time at={it.at} seen={it.seen} />
        </div>
      );
    case 'pin':
    case 'unpin':
      return (
        <div class="mh-row">
          <Icon name="pin" size={14} />
          <span class="mh-what">
            <b>{nameOf(it.actorId)}</b> {it.kind === 'pin' ? 'pinned it' : 'unpinned it'}
          </span>
          <Time at={it.at} />
        </div>
      );
    case 'before':
      return (
        <div class="mh-row">
          <Icon name="smile" size={14} />
          <span class="mh-what">
            Reactions already there when it arrived
            <span class="mh-pills">
              {it.reactions.map((r) => (
                <span class="mh-pill" title={nameOf(r.actorId)}>
                  <Face id={r.actorId} size={16} />
                  {glyph(r.key)}
                </span>
              ))}
              {it.more > 0 && <span class="mh-pill">+{it.more} not named</span>}
            </span>
          </span>
        </div>
      );
    case 'receipts': {
      const names = it.who.map((w) => nameOf(w.identityId));
      const shown = it.state === 'delivered' ? `${it.who.length}` : names.length <= 3 ? and(names) : `${names.slice(0, 2).join(', ')} and ${names.length - 2} others`;
      return (
        <div class="mh-row">
          <Icon name={it.state === 'played' ? 'play' : it.state === 'read' ? 'eye' : 'check'} size={14} />
          <span class="mh-what">
            <button class="mh-who" onClick={() => setOpen(!open)} aria-expanded={open}>
              {STATE[it.state]} <b>{shown}</b>
            </button>
            {open && (
              <span class="mh-people">
                {it.who.map((w) => (
                  <span>
                    <Face id={w.identityId} size={18} />
                    {nameOf(w.identityId)} <time>{clock(w.at)}</time>
                  </span>
                ))}
              </span>
            )}
          </span>
          <Time at={it.at} from={it.from} />
        </div>
      );
    }
  }
}

const and = (xs: string[]) => (xs.length <= 1 ? (xs[0] ?? '') : `${xs.slice(0, -1).join(', ')} and ${xs.at(-1)}`);

function Face({ id, size = 20 }: { id?: string | null; size?: number }) {
  const i = db.identities.get(id ?? '');
  const p = i?.personId ? db.persons.get(i.personId) : null;
  return <Avatar id={p?.id ?? id ?? '?'} name={p?.name ?? (id ? identityName(id) : '?')} url={p?.avatar ?? i?.avatar} size={size} />;
}

function Diff({ parts }: { parts: (Part | { k: 'gap' })[] }) {
  return (
    <>
      {parts.map((p, i) => (p.k === 'gap' ? <span class="mh-gap">{i === 0 ? '… ' : i === parts.length - 1 ? ' …' : ' … '}</span> : p.k === '=' ? p.t : p.k === '-' ? <del>{p.t}</del> : <ins>{p.t}</ins>))}
    </>
  );
}
