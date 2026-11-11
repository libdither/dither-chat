/**
 * Chats (docs/chats.md): what you talk to, as one thing, whichever of your accounts and theirs carry it.
 *
 * A chat is `person:<id>`, every direct conversation with that person, or a conversation id, that conversation alone.
 * Nothing new is stored for a chat itself: its routes (a conversation and one of your accounts in it) are read from
 * the conversations, participants and vantages there are now, so a merge, a split or a new account changes them at
 * once. What is stored is the route you chose (`chat_route`), read against the routes there are, so a route that went
 * away is passed over rather than followed.
 */
import type * as P from '@dither-chat/protocol';
import type { Store } from './store.ts';

type Row = Record<string, any>;

export type ChatRef = { kind: 'person'; personId: string } | { kind: 'conversation'; conversationId: string };

/** `person:<id>` or a conversation id, as the address has it; null when neither exists. */
export function chatRef(store: Store, id: string): ChatRef | null {
  if (id.startsWith('person:')) {
    const personId = id.slice('person:'.length);
    return store.one('SELECT 1 FROM person WHERE id = ?', personId) ? { kind: 'person', personId } : null;
  }
  return store.one('SELECT 1 FROM conversation WHERE id = ?', id) ? { kind: 'conversation', conversationId: id } : null;
}

export const chatIdOf = (ref: ChatRef) => (ref.kind === 'person' ? `person:${ref.personId}` : ref.conversationId);

/**
 * Every way to reach the chat, the most recent first. A person's: each direct conversation with one of their accounts,
 * once for each of your accounts in it.
 */
export function chatRoutes(store: Store, ref: ChatRef): P.ChatRoute[] {
  const rows =
    ref.kind === 'person'
      ? store.db
          .query(
            `SELECT c.id, c.network, c.last_message_at, v.account_id, v.unread, v.mentions, a.self_identity,
                    (SELECT i.id FROM participant p JOIN identity i ON i.id = p.identity_id WHERE p.conversation_id = c.id AND i.person_id = ?1 LIMIT 1) AS theirs
             FROM conversation c JOIN vantage v ON v.target_kind = 'conversation' AND v.target_id = c.id JOIN account a ON a.id = v.account_id
             WHERE c.shape = 'direct' AND EXISTS (SELECT 1 FROM participant p JOIN identity i ON i.id = p.identity_id WHERE p.conversation_id = c.id AND i.person_id = ?1)
             ORDER BY COALESCE(c.last_message_at, 0) DESC, c.id, a.position, a.id`,
          )
          .all(ref.personId)
      : store.db
          .query(
            `SELECT c.id, c.network, c.shape, c.last_message_at, v.account_id, v.unread, v.mentions, a.self_identity,
                    CASE WHEN c.shape = 'direct' THEN (SELECT p.identity_id FROM participant p WHERE p.conversation_id = c.id AND p.identity_id != a.self_identity LIMIT 1) END AS theirs
             FROM conversation c JOIN vantage v ON v.target_kind = 'conversation' AND v.target_id = c.id JOIN account a ON a.id = v.account_id
             WHERE c.id = ? ORDER BY a.position, a.id`,
          )
          .all(ref.conversationId);
  return (rows as Row[]).map((r) => ({
    conversationId: r.id,
    accountId: r.account_id,
    network: r.network,
    theirIdentityId: r.theirs ?? null,
    myIdentityId: r.self_identity ?? null,
    lastTs: r.last_message_at ?? null,
    unread: r.unread,
    mentions: r.mentions,
  }));
}

const same = (a: { conversationId: string; accountId: string }, b: { conversationId: string; accountId: string }) => a.conversationId === b.conversationId && a.accountId === b.accountId;

/**
 * Where a message goes when the sender does not say: the route you chose, while the chat still has it; else the one
 * of the latest message, through the account that sent your latest message there when it still can.
 */
export function defaultRoute(store: Store, chatId: string, routes: P.ChatRoute[]): P.ChatView['route'] {
  if (!routes.length) return null;
  const chosen = store.one<{ conversation_id: string; account_id: string }>('SELECT conversation_id, account_id FROM chat_route WHERE chat_id = ?', chatId);
  if (chosen) {
    const hit = routes.find((r) => same(r, { conversationId: chosen.conversation_id, accountId: chosen.account_id }));
    if (hit) return { conversationId: hit.conversationId, accountId: hit.accountId, why: 'chosen' };
  }
  const conv = routes[0].conversationId;
  const mine = store.one<{ account_id: string }>(
    `SELECT s.account_id FROM message m JOIN message_seen s ON s.message_id = m.id JOIN account a ON a.id = s.account_id
     WHERE m.conversation_id = ? AND m.author_id = a.self_identity ORDER BY m.ts DESC LIMIT 1`,
    conv,
  );
  const hit = (mine && routes.find((r) => r.conversationId === conv && r.accountId === mine.account_id)) || routes[0];
  return { conversationId: hit.conversationId, accountId: hit.accountId, why: 'latest' };
}

export function chatView(store: Store, ref: ChatRef): P.ChatView {
  const id = chatIdOf(ref);
  const routes = chatRoutes(store, ref);
  const person = ref.kind === 'person' ? store.one<Row>('SELECT name, name_source FROM person WHERE id = ?', ref.personId) : null;
  const conv = ref.kind === 'conversation' ? store.conversationView(ref.conversationId) : null;
  return {
    id,
    kind: ref.kind,
    personId: ref.kind === 'person' ? ref.personId : null,
    conversationId: ref.kind === 'conversation' ? ref.conversationId : null,
    name: person?.name ?? conv?.name ?? '',
    nameSource: person ? (person.name_source as P.NameSource) : null,
    routes,
    route: defaultRoute(store, id, routes),
  };
}

/** Choose the route a chat sends through (null: none chosen, the latest message's again). False when the chat has no such route. */
export function chooseRoute(store: Store, ref: ChatRef, route: { conversationId: string; accountId: string } | null): boolean {
  const id = chatIdOf(ref);
  if (route === null) {
    store.db.query('DELETE FROM chat_route WHERE chat_id = ?').run(id);
    return true;
  }
  if (!chatRoutes(store, ref).some((r) => same(r, route))) return false;
  store.db
    .query(
      `INSERT INTO chat_route (chat_id, conversation_id, account_id, set_at) VALUES (?, ?, ?, ?)
       ON CONFLICT (chat_id) DO UPDATE SET conversation_id = excluded.conversation_id, account_id = excluded.account_id, set_at = excluded.set_at`,
    )
    .run(id, route.conversationId, route.accountId, Date.now());
  return true;
}

/**
 * A cursor into a chat's history: `<ts>` alone (older clients), or `<ts>:<message id>`, the oldest message held, so
 * messages that share its time in two conversations are neither skipped nor shown twice.
 */
export function parseCursor(s: string | null): { ts: number; id: string | null } | null {
  if (!s) return null;
  const at = s.indexOf(':');
  const ts = Number(at < 0 ? s : s.slice(0, at));
  if (!Number.isFinite(ts)) return null;
  return { ts, id: at < 0 ? null : s.slice(at + 1) || null };
}
