/**
 * Events from Luma and Partiful (docs/events.md): who was seen at which event, the people you know at one, an event's
 * page and an RSVP sent from it.
 *
 * An event is a post (PostFact with `event`), logged as message `post:<event id>` in the account's posts conversation
 * like any post (posts.ts). Each time one is logged its hosts, and its guests when the site showed them by name, are
 * recorded in `event_seen` (identity, event, role, RSVP when the site said it, first and last seen). A hidden guest list
 * (guestsShown 'count' or 'hidden') never leaves a guest here: its guests are dropped before anything is kept
 * (protocol withoutHiddenGuests) and a read that finds the list hidden removes the guests recorded before.
 *
 * Guests are a membership, not chat: no DM, group or person is made for them, so they stay out of People's lists. They
 * are identities with what the site showed of their profile (people.ts keepAbout), which Same person? reads, and their
 * pictures are hashed after everyone else's (matches.ts), so a guest who is someone you know can be found.
 */
import type { Database } from 'bun:sqlite';
import type * as P from '@dither-chat/protocol';
import { EVENT_CARD_GUESTS, guestsNamed, postNativeId, withoutHiddenGuests } from '@dither-chat/protocol';
import { hubId } from '@dither-chat/protocol/ids';
import type { Store } from './store.ts';

type Row = Record<string, any>;

/** An account as recording needs it. */
interface Acc {
  network: P.Network;
  self_identity: string | null;
}

/**
 * Record who was seen at the events among `posts` (logged through `acc`). Hosts as hosts, named guests as guests, the
 * account itself with its own RSVP; a hidden list removes the event's guests recorded before (not you, nor its hosts).
 */
export function recordEvents(db: Database, acc: Acc, posts: readonly P.PostFact[], now = Date.now()) {
  const events = posts.flatMap((p) => [p, ...(p.repostOf ? [p.repostOf] : []), ...(p.quoteOf ? [p.quoteOf] : [])]).filter((p) => p.event);
  if (!events.length) return;
  const put = db.query(
    `INSERT INTO event_seen (identity_id, network, event_id, role, rsvp, first_at, seen_at) VALUES (?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT (identity_id, network, event_id) DO UPDATE SET seen_at = excluded.seen_at,
       role = CASE WHEN event_seen.role = 'host' THEN 'host' ELSE excluded.role END,
       rsvp = COALESCE(excluded.rsvp, event_seen.rsvp)`,
  );
  const self = acc.self_identity;
  db.transaction(() => {
    for (const raw of events) {
      const p = withoutHiddenGuests(raw);
      const e = p.event!;
      const idn = (n: string) => hubId('idn', acc.network, n);
      const hosts = new Set((e.hosts ?? []).map(idn));
      for (const h of hosts) put.run(h, acc.network, p.id, 'host', null, now, now);
      if (guestsNamed(e)) {
        for (const g of e.guests ?? []) {
          const id = idn(g);
          if (!hosts.has(id) && id !== self) put.run(id, acc.network, p.id, 'guest', null, now, now);
        }
      } else {
        // The host hid the list since: what was kept of it goes.
        db.query(`DELETE FROM event_seen WHERE network = ? AND event_id = ? AND role = 'guest' AND identity_id != ?`).run(acc.network, p.id, self ?? '');
      }
      if (self && (e.hosting || e.rsvp)) put.run(self, acc.network, p.id, e.hosting ? 'host' : 'guest', e.rsvp ?? null, now, now);
    }
  })();
}

/**
 * Of these identities, the ones that belong to someone you have a direct chat or a group with: through their person
 * (any of their accounts) or the identity itself. An event's own conversation does not count: being at a party with
 * someone is not knowing them.
 */
export function knownOf(db: Database, ids: readonly string[]): Set<string> {
  const out = new Set<string>();
  const list = [...new Set(ids)];
  for (let i = 0; i < list.length; i += 400) {
    const chunk = list.slice(i, i + 400);
    const marks = chunk.map(() => '?').join(',');
    const rows = db
      .query(
        `SELECT i.id FROM identity i WHERE i.id IN (${marks}) AND EXISTS (
           SELECT 1 FROM identity j JOIN participant p ON p.identity_id = j.id JOIN conversation c ON c.id = p.conversation_id
           WHERE (j.id = i.id OR (i.person_id IS NOT NULL AND j.person_id = i.person_id))
             AND c.shape IN ('direct', 'group') AND c.native_id NOT LIKE 'event:%'
             AND j.id NOT IN (SELECT self_identity FROM account WHERE self_identity IS NOT NULL))`,
      )
      .all(...chunk) as Row[];
    for (const r of rows) out.add(r.id);
  }
  return out;
}

/**
 * An event post as a card or the event's page shows it (`post` already in hub ids: feed.ts postView): its guests with
 * the people you know first, trimmed to `limit` on a card, and what the hub adds (EventPostView). `named` collects every
 * identity it names, for the page to draw.
 */
export function eventDecorated(store: Store, post: P.PostView, network: P.Network, accountId: string | null, named: Set<string>, limit: number | null = EVENT_CARD_GUESTS): P.PostView {
  const e = post.event;
  if (!e) return post;
  const guests = guestsNamed(e) ? (e.guests ?? []) : [];
  const known = knownOf(store.db, [...e.hosts, ...guests]);
  // People you know first, each group in the site's order.
  const ordered = [...guests.filter((g) => known.has(g)), ...guests.filter((g) => !known.has(g))];
  const shown = limit === null ? ordered : ordered.slice(0, limit);
  for (const h of e.hosts) named.add(h);
  for (const g of shown) named.add(g);
  const conv = e.conversation ? hubId('cnv', network, e.conversation) : null;
  const conversationId = conv && store.one('SELECT 1 FROM conversation WHERE id = ?', conv) ? conv : null;
  const { guests: _all, ...rest } = e;
  return {
    ...post,
    event: { ...rest, ...(guestsNamed(e) ? { guests: shown } : {}) },
    eventView: { known: [...e.hosts, ...ordered].filter((x) => known.has(x)), guestsMore: ordered.length - shown.length, conversationId, accountId },
  };
}

/** The events these identities were seen at, hosting first, then the newest start (a profile's Events). */
export function eventsOf(store: Store, identityIds: readonly string[], limit = 50): P.PersonEventView[] {
  if (!identityIds.length) return [];
  const marks = identityIds.map(() => '?').join(',');
  const rows = store.db
    .query(`SELECT identity_id, network, event_id, role, rsvp, first_at, seen_at FROM event_seen WHERE identity_id IN (${marks}) ORDER BY seen_at DESC LIMIT 500`)
    .all(...identityIds) as Row[];
  const out: P.PersonEventView[] = [];
  const seen = new Set<string>();
  for (const r of rows) {
    const key = `${r.network}:${r.event_id}`;
    if (seen.has(key)) continue;
    seen.add(key);
    const mid = hubId('msg', r.network, postNativeId(r.event_id));
    const m = store.one<Row>('SELECT id, extra, deleted FROM message WHERE id = ?', mid);
    let p: P.PostFact | null = null;
    try {
      p = m?.extra ? ((JSON.parse(m.extra) as { post?: P.PostFact }).post ?? null) : null;
    } catch {}
    const e = p?.event;
    const place = e?.place ? [e.place.name, e.place.city].filter(Boolean).join(', ') || null : e?.online ? 'Online' : null;
    out.push({
      network: r.network,
      event: r.event_id,
      identityId: r.identity_id,
      role: r.role === 'host' ? 'host' : 'guest',
      rsvp: r.rsvp ?? null,
      title: p?.title ?? null,
      start: e?.start ?? null,
      ...(e?.timeZone ? { timeZone: e.timeZone } : {}),
      url: p?.url || null,
      place,
      messageId: m && !m.deleted ? m.id : null,
      firstAt: r.first_at,
      seenAt: r.seen_at,
    });
  }
  const now = Date.now();
  // Hosting first; then upcoming soonest, then past newest.
  const rank = (v: P.PersonEventView) => (v.start === null ? 2 : v.start >= now ? 0 : 1);
  out.sort((a, b) => Number(b.role === 'host') - Number(a.role === 'host') || rank(a) - rank(b) || (rank(a) === 0 ? (a.start ?? 0) - (b.start ?? 0) : (b.start ?? b.seenAt) - (a.start ?? a.seenAt)));
  return out.slice(0, limit);
}

