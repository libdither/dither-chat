/** @jsxRuntime classic */
/** @jsx h */
/** @jsxFrag Fragment */
/**
 * Events from Luma and Partiful on the Feed page (docs/events.md): a card in a feed, and the event's page opened from it.
 *
 * The card: a date block, the cover, the title, when (in the event's zone, and in yours when it differs), where (or that
 * the site gives the address after an RSVP), the price, the hosts, and who is going as the site showed it: faces, the
 * people you know first and ringed, "N going". The page: all that, the description, every guest the site showed (the
 * people you know apart), the hosts, links to the site and its .ics, the event's conversation, and RSVP buttons, which
 * ask first: an RSVP is seen by the host and the guests.
 */
import { Fragment, h } from 'preact';
import type * as P from '@dither-chat/protocol';
import { NETWORK_META } from '@dither-chat/protocol';
import { useEffect, useState } from 'preact/hooks';
import { api, db, go, openProfile } from '../../state.ts';
import type { Kit } from '../feed/lazy.tsx';
import './events.css';
import { dateBlock, eventWhen, eventWhere, goingLine, rsvpChoices, rsvpWords } from './eventfmt.ts';

/** Faces in a card's row of guests. */
const ROW_FACES = 8;

function DateBlock({ e }: { e: P.EventFact }) {
  const d = dateBlock(e);
  return (
    <span class="ev-date" aria-hidden="true">
      <span class="ev-date-mon">{d.month}</span>
      <span class="ev-date-day">{d.day}</span>
      <span class="ev-date-wd">{d.weekday}</span>
    </span>
  );
}

/** A row of faces: the people you know ringed, then the rest, and how many more. */
function Faces({ ids, known, kit, more, size = 22 }: { ids: string[]; known: Set<string>; kit: Kit; more: number; size?: number }) {
  if (!ids.length) return null;
  return (
    <span class="ev-faces">
      {ids.map((id) => (
        <span class={`ev-face ${known.has(id) ? 'known' : ''}`} title={`${kit.name(id)}${known.has(id) ? ' · you know them' : ''}`}>
          <kit.Avatar id={id} name={kit.name(id)} url={kit.avatarUrl(id)} size={size} />
        </span>
      ))}
      {more > 0 && <span class="ev-faces-more">+{more}</span>}
    </span>
  );
}

const names = (kit: Kit, ids: string[], max = 3) => {
  const n = ids.slice(0, max).map((id) => kit.name(id));
  return ids.length > max ? `${n.join(', ')} and ${ids.length - max} more` : n.length > 1 ? `${n.slice(0, -1).join(', ')} and ${n[n.length - 1]}` : (n[0] ?? '');
};

/** The facts both the card and the page show: when, where, price, your RSVP. */
function Facts({ e, network }: { e: P.EventFact; network: P.Network }) {
  const when = eventWhen(e);
  const mine = rsvpWords(e);
  return (
    <div class="ev-facts">
      <span class="ev-when">
        {when.there}
        {when.here && <span class="ev-here"> · {when.here}</span>}
      </span>
      <span class={`ev-where ${e.place || e.online ? '' : 'hidden'}`}>{eventWhere(e)}</span>
      <span class="ev-chips">
        {e.price && <span class="ev-chip">{e.price}</span>}
        {mine && <span class={`ev-chip mine ${e.rsvp ?? ''}`}>{mine}</span>}
        <span class="ev-chip net" style={{ color: NETWORK_META[network].color }}>
          {NETWORK_META[network].name}
        </span>
      </span>
    </div>
  );
}

/** One event in a feed: opens its page. */
export function EventCard({ e, kit, reason, onOpen }: { e: P.FeedEntryView; kit: Kit; reason?: preact.ComponentChildren; onOpen: () => void }) {
  const p = e.post;
  const ev = p.event!;
  const v = p.eventView;
  const known = new Set(v?.known ?? []);
  const guests = ev.guests ?? [];
  const knownGuests = guests.filter((g) => known.has(g));
  const knownHosts = ev.hosts.filter((h) => known.has(h));
  const cover = p.media?.[0];
  const open = (x: MouseEvent | KeyboardEvent) => {
    if ((x.target as HTMLElement).closest('a,button')) return;
    if ('button' in x && x.button !== 0) return;
    onOpen();
  };
  return (
    <div class="ev-card" role="link" tabIndex={0} onClick={open} onKeyDown={(x) => x.key === 'Enter' && x.target === x.currentTarget && open(x)}>
      {reason && <div class="ev-reason">{reason}</div>}
      <div class="ev-card-body">
        <DateBlock e={ev} />
        <div class="ev-card-main">
          <h3 class="ev-title">{p.title || 'An event'}</h3>
          <Facts e={ev} network={e.network} />
          {!!ev.hosts.length && (
            <div class="ev-hosts-line">
              <Faces ids={ev.hosts.slice(0, 3)} known={known} kit={kit} more={0} size={18} />
              <span>Hosted by {names(kit, ev.hosts)}</span>
            </div>
          )}
          <div class="ev-going">
            <Faces ids={guests.slice(0, ROW_FACES)} known={known} kit={kit} more={Math.max(0, guests.length - ROW_FACES) + (v?.guestsMore ?? 0)} />
            <span class="ev-going-n">{goingLine(ev, v?.guestsMore ?? 0)}</span>
          </div>
          {(knownGuests.length > 0 || knownHosts.length > 0) && (
            <div class="ev-know">
              <kit.Icon name="users" size={12} /> You know {names(kit, [...knownHosts, ...knownGuests])}
            </div>
          )}
        </div>
        {cover && <img class="ev-cover" src={cover.url} alt={cover.alt ?? ''} loading="lazy" {...(cover.width && cover.height ? { width: cover.width, height: cover.height } : {})} />}
      </div>
    </div>
  );
}

/** Someone in a list on the event's page: their face and name, opening their profile. */
function Person({ id, kit, known, note }: { id: string; kit: Kit; known: boolean; note?: string }) {
  return (
    <button class={`ev-person ${known ? 'known' : ''}`} onClick={() => openProfile(id)} title={`Open ${kit.name(id)}'s profile`}>
      <kit.Avatar id={id} name={kit.name(id)} url={kit.avatarUrl(id)} size={32} />
      <span class="ev-person-name">{kit.name(id)}</span>
      {note && <span class="ev-person-note">{note}</span>}
    </button>
  );
}

type Load = { s: 'loading' } | { s: 'failed'; why: string } | { s: 'ok'; v: P.EventPageView };

/** An event's page, opened from its card (`#/feed/<source>/p/<network>:<event>`). */
export function EventView({ network, event, kit, onBack }: { network: P.Network; event: string; kit: Kit; onBack: () => void }) {
  const [st, setSt] = useState<Load>({ s: 'loading' });
  const [asking, setAsking] = useState<P.EventRsvpChoice | null>(null);
  const [sending, setSending] = useState(false);
  const take = (v: P.EventPageView) => {
    v.identities.forEach((i) => db.identities.set(i.id, i));
    setSt({ s: 'ok', v });
  };
  useEffect(() => {
    let live = true;
    setSt({ s: 'loading' });
    api<P.EventPageView>(`/api/events/${network}/${encodeURIComponent(event)}${kit.account ? `?account=${encodeURIComponent(kit.account)}` : ''}`).then(
      (v) => live && take(v),
      (e) => live && setSt({ s: 'failed', why: (e as Error).message }),
    );
    return () => void (live = false);
  }, [network, event]);
  const site = NETWORK_META[network].name;
  const head = (title: string) => (
    <div class="pane-head ev-head">
      <button class="icon-btn" onClick={onBack} aria-label="Back" title="Back">
        <kit.Icon name="back" size={18} />
      </button>
      <h2 class="ev-head-title">{title}</h2>
    </div>
  );
  if (st.s === 'loading')
    return (
      <section class="pane ev-page">
        {head('Event')}
        <kit.Loading fill />
      </section>
    );
  if (st.s === 'failed')
    return (
      <section class="pane ev-page">
        {head('Event')}
        <kit.Empty icon="alert" title="Could not open the event">
          {st.why}
        </kit.Empty>
      </section>
    );
  const { post: p, canRsvp } = st.v;
  const ev = p.event!;
  const v = p.eventView;
  const known = new Set(v?.known ?? []);
  const guests = ev.guests ?? [];
  const knownGuests = guests.filter((g) => known.has(g));
  const others = guests.filter((g) => !known.has(g));
  const cover = p.media?.[0];
  const send = async (status: P.EventRsvpChoice) => {
    if (!v?.accountId) return;
    setSending(true);
    try {
      take(await api<P.EventPageView>(`/api/events/${network}/${encodeURIComponent(event)}/rsvp`, { method: 'POST', body: { account: v.accountId, status } }));
      kit.toast({ title: `RSVP sent to ${site}`, body: '', kind: 'info' }, 3000);
      setAsking(null);
    } catch (e) {
      kit.toast({
        title: 'Could not RSVP',
        body: (e as Error).message,
        kind: 'error',
      });
    } finally {
      setSending(false);
    }
  };
  const choice = asking && rsvpChoices(network).find((c) => c.status === asking);
  return (
    <section class="pane ev-page" aria-label={p.title || 'Event'}>
      {head(p.title || 'Event')}
      <div class="ev-scroll">
        {cover && <img class="ev-hero" src={cover.url} alt={cover.alt ?? ''} />}
        <div class="ev-top">
          <DateBlock e={ev} />
          <div>
            <h1 class="ev-title big">{p.title || 'An event'}</h1>
            <Facts e={ev} network={network} />
            {ev.place?.address && <div class="ev-address">{ev.place.address}</div>}
          </div>
        </div>
        <div class="ev-links">
          {p.url && (
            <a class="btn" href={p.url} target="_blank" rel="noreferrer">
              <kit.Icon name="external" size={14} /> Open on {site}
            </a>
          )}
          {ev.ics && (
            <a class="btn" href={ev.ics} target="_blank" rel="noreferrer">
              <kit.Icon name="calendar" size={14} /> Add to calendar (.ics)
            </a>
          )}
          {ev.place?.url && (
            <a class="btn" href={ev.place.url} target="_blank" rel="noreferrer">
              <kit.Icon name="globe" size={14} /> Map
            </a>
          )}
          {v?.conversationId && (
            <button class="btn" onClick={() => go({ view: 'inbox', conv: v.conversationId! })}>
              <kit.Icon name="chat" size={14} /> The event's chat
            </button>
          )}
        </div>
        {!ev.hosting && (
          <div class="ev-rsvp" role="group" aria-label="RSVP">
            {choice ? (
              <div class="ev-confirm" role="alertdialog" aria-label="Send this RSVP?">
                <p>
                  Tell {site} “{choice.label}”? The host
                  {ev.guestsShown === 'all' || ev.guestsShown === 'sample' ? ' and the other guests' : ''} will see it.
                </p>
                <button class="btn primary" disabled={sending} onClick={() => void send(choice.status)}>
                  {sending ? 'Sending…' : `Send “${choice.label}”`}
                </button>
                <button class="btn" disabled={sending} onClick={() => setAsking(null)}>
                  Cancel
                </button>
              </div>
            ) : (
              <>
                {rsvpChoices(network).map((c) => (
                  <button
                    class={`btn ev-rsvp-btn ${ev.rsvp === c.status ? 'on' : ''}`}
                    disabled={!canRsvp || ev.rsvp === c.status}
                    aria-pressed={ev.rsvp === c.status}
                    onClick={() => setAsking(c.status)}
                  >
                    {c.label}
                  </button>
                ))}
                {!canRsvp && (
                  <span class="ev-rsvp-why">
                    Your {site} account is not connected: RSVP on {site}.
                  </span>
                )}
              </>
            )}
          </div>
        )}
        {p.text && (
          <div class="ev-about">
            <kit.Linked text={p.text} network={network} markdown={false} />
          </div>
        )}
        {!!ev.tags?.length && (
          <div class="ev-tags">
            {ev.tags.map((t) => (
              <span class="ev-chip">{t}</span>
            ))}
          </div>
        )}
        <h3 class="ev-sub">Hosts</h3>
        <div class="ev-people">
          {ev.hosts.map((id) => (
            <Person id={id} kit={kit} known={known.has(id)} />
          ))}
        </div>
        <h3 class="ev-sub">
          Who is going <span class="ev-sub-n">{goingLine(ev)}</span>
        </h3>
        {ev.guestsShown === 'hidden' || ev.guestsShown === 'count' ? (
          <p class="ev-note">The host shows {ev.guestsShown === 'count' ? 'only the count' : 'no guest list'} to people who have not RSVP'd, so nothing of it is kept here.</p>
        ) : (
          <>
            {knownGuests.length > 0 && (
              <>
                <h4 class="ev-sub2">People you know</h4>
                <div class="ev-people">
                  {knownGuests.map((id) => (
                    <Person id={id} kit={kit} known />
                  ))}
                </div>
              </>
            )}
            {others.length > 0 && (
              <>
                {knownGuests.length > 0 && <h4 class="ev-sub2">Others {site} showed</h4>}
                <div class="ev-people">
                  {others.map((id) => (
                    <Person id={id} kit={kit} known={false} />
                  ))}
                </div>
              </>
            )}
            {ev.guestsShown === 'sample' && <p class="ev-note">{site} shows only some of the guests until you RSVP.</p>}
          </>
        )}
      </div>
    </section>
  );
}
