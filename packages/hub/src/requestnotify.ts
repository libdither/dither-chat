/**
 * A new request from someone you know notifies once (docs/add.md "Requests"): at the Active level, a silent
 * notification on phones, through the hub's push path like a message's (main.ts). Requests from strangers, message
 * requests among them, only count on the inbox's Requests row.
 *
 * Someone you know: they have a person here, or they share a group, a conversation or a server with the account the
 * request came to. A message request's own conversation makes a person and a shared conversation, which say nothing.
 *
 * Each request is judged once (add_request_seen), a little after it arrives, so an account's first sync has said who
 * people are. Quiet hours hold it as they hold chat (people set to always notify through, where you let them), and a
 * place set to Nothing or the digest, for the person, the account, the network or everything, keeps it silent.
 */
import type { Database } from 'bun:sqlite';
import type * as P from '@dither-chat/protocol';
import { NETWORK_META } from '@dither-chat/protocol';
import { addTables, onRequestsHeard } from './add.ts';
import type { Store } from './store.ts';
import { inQuietHours } from './triage.ts';

type Row = Record<string, any>;

const DAY = 24 * 3_600_000;

export const REQUEST_NOTICE = {
  /** How long after it arrives a request is judged: the account's first sync says who people are. */
  settleMs: 20_000,
  /** Older than this when the hub first hears of it (an account that was away, a list from before): not news. */
  recentMs: 2 * DAY,
  /** How long a judged request is remembered after it went, so one that comes back is not news again. */
  keepMs: 90 * DAY,
};

export interface RequestNotice {
  requestId: string;
  accountId: string;
  network: P.Network;
  title: string;
  body: string;
  reason: string;
  icon?: string;
}

/** Does this account know them: a person here, or a place they share with it? `held`: a message request's own conversation. */
export function knownTo(db: Database, accountId: string, identityId: string, held: string | null): boolean {
  const i = db
    .query(
      `SELECT i.person_id, p.manual, p.is_self, (SELECT COUNT(*) FROM identity o WHERE o.person_id = i.person_id) AS ids,
              EXISTS (SELECT 1 FROM notify_rule n WHERE n.scope = 'person' AND n.target = i.person_id AND n.level = 'all') AS always
       FROM identity i LEFT JOIN person p ON p.id = i.person_id WHERE i.id = ?`,
    )
    .get(identityId) as Row | null;
  if (!i || i.is_self) return false;
  // A message request's conversation made their person: only one you named, set to always notify or merged counts then.
  if (i.person_id && (!held || i.manual || i.always || i.ids > 1)) return true;
  const other = held ?? '';
  const shares =
    db
      .query(
        `SELECT 1 FROM participant pa JOIN vantage v ON v.target_kind = 'conversation' AND v.target_id = pa.conversation_id AND v.account_id = ?
         WHERE pa.identity_id = ? AND pa.conversation_id != ? LIMIT 1`,
      )
      .get(accountId, identityId, other) ||
    db.query(`SELECT 1 FROM membership m JOIN vantage v ON v.target_kind = 'space' AND v.target_id = m.space_id AND v.account_id = ? WHERE m.identity_id = ? LIMIT 1`).get(accountId, identityId) ||
    // A server's channels list no members: someone who wrote in one the account sees is in it.
    db
      .query(
        `SELECT 1 FROM message m JOIN vantage v ON v.target_kind = 'conversation' AND v.target_id = m.conversation_id AND v.account_id = ?
         WHERE m.author_id = ? AND m.conversation_id != ? LIMIT 1`,
      )
      .get(accountId, identityId, other);
  return !!shares;
}

/** A person, the account, its network or everything set to Nothing or the digest: no notification for requests either. */
function silenced(store: Store, accountId: string, network: string, personId: string | null): string | null {
  const rules = new Map(store.rules().map((r) => [`${r.scope}:${r.target ?? ''}`, r.level]));
  for (const [key, what] of [
    [`person:${personId ?? ''}`, 'this person'],
    [`account:${accountId}`, 'this account'],
    [`network:${network}`, 'this network'],
    ['global:', 'everything'],
  ] as const) {
    if (key === 'person:') continue;
    const l = rules.get(key);
    if (l) return l === 'none' || l === 'digest' ? what : null;
  }
  return null;
}

const SAYS: Record<P.RequestFact['kind'], (who: string, target: string | null) => string> = {
  friend: (who) => `${who} wants to be friends`,
  follow: (who) => `${who} asked to follow you`,
  invite: (who, t) => (t ? `${who} invited you to ${t}` : `${who} invited you to a group`),
  message: (who) => `${who} sent you a message request`,
  join: (who, t) => (t ? `${who} asked to join ${t}` : `${who} asked to join your group`),
};

/**
 * Judge one request, once: what to notify, or null. Marks it seen whatever the answer, unless it is gone already (it
 * may come back, and is judged then).
 */
export function judgeRequest(store: Store, accountId: string, nativeId: string, now = Date.now()): RequestNotice | null {
  const db = store.db;
  addTables(db);
  const r = db
    .query(
      `SELECT r.*, a.network, a.label, i.display_name, i.handle, i.avatar_url, i.seen_via, i.person_id, p.name AS person_name
       FROM add_request r JOIN account a ON a.id = r.account_id LEFT JOIN identity i ON i.id = r.from_id LEFT JOIN person p ON p.id = i.person_id
       WHERE r.account_id = ? AND r.native_id = ?`,
    )
    .get(accountId, nativeId) as Row | null;
  if (!r) return null;
  if (!db.query('INSERT OR IGNORE INTO add_request_seen (account_id, native_id, at) VALUES (?, ?, ?)').run(accountId, nativeId, now).changes) return null;
  if (r.ts < now - REQUEST_NOTICE.recentMs || !r.from_id) return null;
  const held = r.kind === 'message' && r.target_kind === 'conversation' ? r.target_id : null;
  if (!knownTo(db, accountId, r.from_id, held)) return null;
  if (silenced(store, accountId, r.network, r.person_id)) return null;
  const q = store.quietHours();
  if (inQuietHours(q, now) && !(q!.allowStarred && r.person_id && store.rules().some((x) => x.scope === 'person' && x.target === r.person_id && x.level === 'all'))) return null;
  const net = NETWORK_META[r.network as P.Network].name;
  const who = r.person_name ?? r.display_name ?? r.handle ?? 'Someone';
  const icon = r.avatar_url ? store.media(r.avatar_url, r.seen_via ?? accountId) : null;
  return {
    requestId: r.id,
    accountId,
    network: r.network,
    title: SAYS[r.kind as P.RequestFact['kind']](who, r.target_name),
    body: `On ${net} ${r.label}. It waits under Requests.`,
    reason: 'A request from someone you know',
    ...(icon && (!icon.startsWith('data:') || icon.length < 1500) ? { icon } : {}),
  };
}

/** Requests heard from the adapters, judged once each after they settle (`due`, called every few seconds). */
export class RequestNotifier {
  private waiting = new Map<string, { accountId: string; nativeId: string; at: number }>();
  private pruned = 0;

  constructor(
    private store: Store,
    private now = () => Date.now(),
  ) {
    onRequestsHeard(store, (accountId, ids) => this.heard(accountId, ids));
  }

  heard(accountId: string, nativeIds: string[]) {
    const at = this.now();
    for (const nativeId of nativeIds) {
      const k = `${accountId}\0${nativeId}`;
      if (!this.waiting.has(k)) this.waiting.set(k, { accountId, nativeId, at });
    }
  }

  /** What notifies now: the requests that have settled, each judged once. */
  due(now = this.now()): RequestNotice[] {
    const out: RequestNotice[] = [];
    for (const [k, w] of this.waiting) {
      if (now - w.at < REQUEST_NOTICE.settleMs) continue;
      this.waiting.delete(k);
      const n = judgeRequest(this.store, w.accountId, w.nativeId, now);
      if (n) out.push(n);
    }
    if (now - this.pruned > DAY) {
      this.pruned = now;
      this.store.db
        .query('DELETE FROM add_request_seen WHERE at < ? AND NOT EXISTS (SELECT 1 FROM add_request r WHERE r.account_id = add_request_seen.account_id AND r.native_id = add_request_seen.native_id)')
        .run(now - REQUEST_NOTICE.keepMs);
    }
    return out;
  }
}

/** Device rules for a request's notification (devices.ts): its account's, then its network's. */
export function requestChain(db: Database, requestId: string): string[] | null {
  addTables(db);
  const r = db.query('SELECT r.account_id, a.network FROM add_request r JOIN account a ON a.id = r.account_id WHERE r.id = ?').get(requestId) as Row | null;
  return r ? [`account:${r.account_id}`, `network:${r.network}`] : null;
}
