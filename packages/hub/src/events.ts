/**
 * An event's page and an RSVP sent from it (docs/events.md "The event's page"): GET /api/events/:network/:event and
 * POST …/rsvp. Who was seen where, and the people you know at an event, are eventseen.ts's.
 */
import type * as P from '@dither-chat/protocol';
import { EVENT_RSVP_CHOICES, isEventNetwork, NETWORK_META, postNativeId, withoutHiddenGuests } from '@dither-chat/protocol';
import { hubId } from '@dither-chat/protocol/ids';
import { eventDecorated } from './eventseen.ts';
import { postView } from './feed.ts';
import type { Posts } from './posts.ts';
import { PostsError } from './posts.ts';
import type { Store } from './store.ts';

type Row = Record<string, any>;

interface EventsDeps {
  store: Store;
  posts: Posts;
  online: (accountId: string) => boolean;
  command: <T>(accountId: string, cmd: { t: 'action'; action: string; args?: unknown }, timeoutMs?: number) => Promise<T>;
}

/** An event's page and its RSVP (GET /api/events/:network/:event, POST …/rsvp). */
export class Events {
  constructor(private d: EventsDeps) {}

  /** The event as the hub logged it, every guest the site showed, through `accountId` (or the account that saw it). */
  page(network: string, event: string, accountId?: string | null): P.EventPageView {
    if (!isEventNetwork(network)) throw new PostsError('Not an event site.', 404);
    const s = this.d.store;
    const net = network as P.Network;
    const m = s.one<Row>('SELECT id, extra, conversation_id FROM message WHERE id = ? AND deleted = 0', hubId('msg', net, postNativeId(event)));
    let p: P.PostFact | null = null;
    try {
      p = m?.extra ? ((JSON.parse(m.extra) as { post?: P.PostFact }).post ?? null) : null;
    } catch {}
    if (!m || !p?.event) throw new PostsError('The hub holds no such event: open it from a feed first.', 404);
    const acc = (accountId && s.account(accountId)?.network === net ? s.account(accountId) : null) ?? this.accountOf(net, m.conversation_id);
    const named = new Set<string>();
    const base: P.PostView = { ...postView(withoutHiddenGuests(p), net, (u) => s.mediaUrl(u, acc?.id ?? null)), messageId: m.id };
    if (base.author) named.add(base.author);
    const post = eventDecorated(s, base, net, acc?.id ?? null, named, null);
    return { network: net, event, post, identities: s.identitiesByIds(named), canRsvp: !!acc && this.d.online(acc.id) };
  }

  /** The account whose posts conversation logged it, else the first on the network. */
  private accountOf(network: P.Network, conversationId: string) {
    const s = this.d.store;
    const v = s.one<Row>(`SELECT account_id FROM vantage WHERE target_kind = 'conversation' AND target_id = ? ORDER BY account_id LIMIT 1`, conversationId);
    const r = v ?? s.one<Row>('SELECT id AS account_id FROM account WHERE network = ? AND enabled = 1 ORDER BY created_at LIMIT 1', network);
    return r ? s.account(r.account_id) : null;
  }

  /**
   * An RSVP sent as `account` (visible to the host and the guests: the page asks first). The site's answer (the event
   * as it now stands) is logged; then the page again.
   */
  async rsvp(network: string, event: string, body: unknown): Promise<P.EventPageView> {
    const b = (body ?? {}) as { account?: unknown; status?: unknown; note?: unknown };
    if (!isEventNetwork(network)) throw new PostsError('Not an event site.', 404);
    if (typeof b.account !== 'string') throw new PostsError('account: the account to answer as', 400);
    if (!EVENT_RSVP_CHOICES.includes(b.status as P.EventRsvpChoice)) throw new PostsError(`status: ${EVENT_RSVP_CHOICES.join(', ')}`, 400);
    if (b.note !== undefined && (typeof b.note !== 'string' || b.note.length > 500)) throw new PostsError('note: up to 500 characters', 400);
    const s = this.d.store;
    const acc = s.account(b.account);
    if (!acc || acc.network !== network) throw new PostsError('No such account on that site.', 404);
    const name = NETWORK_META[acc.network].name;
    if (!this.d.online(acc.id)) throw new PostsError(`${name} · ${acc.label} is not connected.`, 409);
    this.page(network, event, acc.id);
    const args: P.EventRsvpArgs = { eventId: event, status: b.status as P.EventRsvpChoice, ...(b.note ? { note: b.note as string } : {}) };
    let r: unknown;
    try {
      r = await this.d.command<unknown>(acc.id, { t: 'action', action: 'rsvp', args }, 60_000);
    } catch (e) {
      throw new PostsError(`${name} did not take the RSVP: ${(e as Error).message}`, 502);
    }
    const fresh = r as Partial<P.PostFact> | null;
    if (fresh && typeof fresh.id === 'string' && fresh.id === event && fresh.event) this.d.posts.log(acc.id, [fresh as P.PostFact]);
    else this.noteOwn(acc.id, event, args.status);
    return this.page(network, event, acc.id);
  }

  /** The site said yes and gave nothing back: the logged event shows your RSVP as sent. */
  private noteOwn(accountId: string, event: string, status: P.EventRsvpChoice) {
    const s = this.d.store;
    const acc = s.account(accountId)!;
    const m = s.one<Row>('SELECT extra FROM message WHERE id = ?', hubId('msg', acc.network, postNativeId(event)));
    let p: P.PostFact | null = null;
    try {
      p = m?.extra ? ((JSON.parse(m.extra) as { post?: P.PostFact }).post ?? null) : null;
    } catch {}
    if (p?.event) this.d.posts.log(accountId, [{ ...p, event: { ...p.event, rsvp: status } }]);
  }
}
