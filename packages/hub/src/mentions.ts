/**
 * The composer's @ picker (docs/mentions.md): GET /api/conversations/:id/mentionables?q=&account= answers who this
 * conversation can ping, as rows of section 'here'.
 *
 * Sources, merged by identity:
 *  - the conversation's stored participants, without your own accounts;
 *  - who wrote here lately, from the stored messages;
 *  - the network's own answer (the adapter command `mentionables`, capability 'mentionables'): the people it knows here
 *    that the hub does not store (a Discord server's members, a Matrix room's), its roles, and whether you may write
 *    @everyone. Asked through the account the composer sends from, with a short wait: no answer in time and the rows
 *    are what the hub knows, `partial`. Nothing in the answer is stored.
 *
 * Order: how well the name matches what was typed (whole, start, a word's start, anywhere), then how much you talk with
 * them (the inbox's per-person tallies, attention.ts: turns they addressed to you and you answered, decayed), then
 * when they last spoke here.
 *
 * Later sections (friends, everyone known: the `scope` a place may set) go after these rows; `section` says which.
 */
import type * as P from '@dither-chat/protocol';
import { hubId } from '@dither-chat/protocol/ids';
import { sumTallies, type Tally } from './attention.ts';
import type { Store } from './store.ts';

/** How long the hub waits for the network's answer before it answers with what it knows. */
export const NETWORK_WAIT = 1500;
/** At most this many people in an answer, and asked of the network. */
export const PEOPLE_MAX = 20;
/** The stored messages read for who wrote here lately, newest first. */
const RECENT_MESSAGES = 3000;
/** Longest query passed on. */
const QUERY_MAX = 64;

export interface MentionDeps {
  store: Store;
  online: (accountId: string) => boolean;
  command: <T>(accountId: string, cmd: { t: 'mentionables'; conversation: string; query: string; limit: number }, timeoutMs?: number) => Promise<T>;
  /** Which account speaks for a conversation (the one that would send), honouring a request. */
  pickAccount: (conversationId: string, requested?: string) => string | null;
  now?: () => number;
  /** How long to wait for the network, in ms (NETWORK_WAIT). */
  wait?: number;
}

/** The query as matched: no leading @, lower case, trimmed. */
export const cleanQuery = (q: string | null | undefined) => (q ?? '').replace(/^@+/, '').trim().slice(0, QUERY_MAX).toLocaleLowerCase();

/**
 * How well any of the names matches `q` (already cleaned): 4 the whole name, 3 its start, 2 the start of one of its
 * words, 1 anywhere in it, 0 not at all. An empty query matches everything alike (1).
 */
export function matchTier(names: (string | null | undefined)[], q: string): number {
  if (!q) return 1;
  let best = 0;
  for (const raw of names) {
    if (!raw) continue;
    const n = raw.toLocaleLowerCase().replace(/^@+/, '');
    const t = n === q ? 4 : n.startsWith(q) ? 3 : n.split(/[\s._\-:]+/).some((w) => w.startsWith(q)) ? 2 : n.includes(q) ? 1 : 0;
    if (t > best) best = t;
    if (best === 4) break;
  }
  return best;
}

interface Candidate {
  row: P.MentionRow;
  tier: number;
  /** Kinds in the order they come on a tie: people, then roles, then @everyone and @here. */
  order: number;
  talk: number;
  lastSpoke: number;
}

/** What a body says for @everyone on this network, if it has one: Discord's two, Matrix's @room. */
function everyoneRows(network: P.Network): P.MentionRow[] {
  const row = (kind: 'everyone' | 'here', word: string): P.MentionRow => ({ kind, insert: `@${word} `, pings: true, section: 'here', name: word, network });
  if (network === 'discord') return [row('everyone', 'everyone'), row('here', 'here')];
  if (network === 'matrix') return [row('everyone', 'room')];
  return [];
}

/**
 * The picker's rows for a conversation, or null when there is no such conversation. `params`: q (what follows the @),
 * account (the account the composer sends from). Only section 'here' for now (`scope` is read by later sections).
 */
export async function mentionables(d: MentionDeps, conversationId: string, params: URLSearchParams): Promise<P.MentionablesView | null> {
  const s = d.store;
  const db = s.db;
  const conv = s.one<{ network: P.Network; native_id: string; shape: P.Shape }>('SELECT network, native_id, shape FROM conversation WHERE id = ?', conversationId);
  if (!conv) return null;
  const now = (d.now ?? Date.now)();
  const q = cleanQuery(params.get('q'));
  const network = conv.network;

  // You, on every account and as the person marked as you.
  const self = new Set(
    (db.query('SELECT self_identity AS id FROM account WHERE self_identity IS NOT NULL UNION SELECT i.id FROM person p CROSS JOIN identity i ON i.person_id = p.id WHERE p.is_self = 1').all() as { id: string }[]).map(
      (r) => r.id,
    ),
  );

  // What the hub stores: the participants, and who wrote here lately.
  const lastSpoke = new Map<string, number>();
  for (const r of db
    .query(
      `SELECT author_id AS id, MAX(ts) AS at FROM (SELECT author_id, ts FROM message WHERE conversation_id = ? AND deleted = 0 AND kind != 'system' AND author_id IS NOT NULL ORDER BY ts DESC LIMIT ${RECENT_MESSAGES}) GROUP BY author_id`,
    )
    .all(conversationId) as { id: string; at: number }[])
    lastSpoke.set(r.id, r.at);
  const stored = new Set<string>([...(db.query('SELECT identity_id AS id FROM participant WHERE conversation_id = ?').all(conversationId) as { id: string }[]).map((r) => r.id), ...lastSpoke.keys()]);

  // The network's answer, through the account that would send.
  const accountId = d.pickAccount(conversationId, params.get('account') ?? undefined);
  const caps: P.Capability[] = accountId ? JSON.parse(s.account(accountId)?.capabilities ?? '[]') : [];
  const ask = !!accountId && caps.includes('mentionables') && d.online(accountId);
  let answer: P.Mentionables | null = null;
  const wait = d.wait ?? NETWORK_WAIT;
  if (ask) answer = await within(d.command<P.Mentionables>(accountId!, { t: 'mentionables', conversation: conv.native_id, query: q, limit: PEOPLE_MAX }, wait + 500), wait);
  // The hub's own list can be short of who is here: a channel lists nobody, and a group may not have said who is in it.
  const listed = !!s.one('SELECT 1 FROM participant WHERE conversation_id = ? LIMIT 1', conversationId);
  const partial = !answer && (conv.shape === 'channel' || conv.shape === 'thread' || !listed);

  const people = new Map<string, { identity?: P.IdentityView; net?: P.MentionablePerson; lastSpoke: number }>();
  for (const i of s.identitiesByIds([...stored].filter((id) => !self.has(id)))) people.set(i.id, { identity: i, lastSpoke: lastSpoke.get(i.id) ?? 0 });
  const fromNet = (Array.isArray(answer?.people) ? answer.people : []).filter((p) => p && typeof p.nativeId === 'string' && p.nativeId && typeof p.name === 'string');
  const netIds = fromNet.map((p) => hubId('idn', network, p.nativeId));
  const known = new Map(s.identitiesByIds(netIds.filter((id) => !people.has(id))).map((i) => [i.id, i]));
  fromNet.forEach((p, i) => {
    const id = netIds[i];
    if (self.has(id)) return;
    const had = people.get(id);
    const spoke = Math.max(had?.lastSpoke ?? 0, typeof p.lastSpoke === 'number' ? p.lastSpoke : 0);
    people.set(id, { identity: had?.identity ?? known.get(id), net: p, lastSpoke: spoke });
  });

  // How much you talk with each: the inbox's tallies, by their person, else the identity.
  const keyOf = (id: string, i?: P.IdentityView) => i?.personId ?? id;
  const keys = [...new Set([...people].map(([id, x]) => keyOf(id, x.identity)))];
  const tallies = new Map<string, Tally[]>();
  for (let i = 0; i < keys.length; i += 400) {
    const chunk = keys.slice(i, i + 400);
    for (const r of db.query(`SELECT author_key, tally FROM conv_author_feature WHERE author_key IN (${chunk.map(() => '?').join(',')})`).all(...chunk) as { author_key: string; tally: string }[]) {
      try {
        (tallies.get(r.author_key) ?? tallies.set(r.author_key, []).get(r.author_key)!).push(JSON.parse(r.tally));
      } catch {}
    }
  }
  const talkOf = (key: string) => {
    const t = tallies.get(key);
    if (!t?.length) return 0;
    const sum = sumTallies(t, now);
    return sum.addressed + sum.replied;
  };
  const personNames = new Map(
    (() => {
      const ids = [...new Set([...people.values()].map((x) => x.identity?.personId).filter((x): x is string => !!x))];
      return ids.length ? (db.query(`SELECT id, name FROM person WHERE is_self = 0 AND id IN (${ids.map(() => '?').join(',')})`).all(...ids) as { id: string; name: string }[]).map((r) => [r.id, r.name] as const) : [];
    })(),
  );

  const out: Candidate[] = [];
  for (const [id, x] of people) {
    const i = x.identity;
    const nativeId = i?.nativeId ?? x.net!.nativeId;
    const personName = i?.personId ? personNames.get(i.personId) : undefined;
    const name = personName ?? i?.nickname ?? i?.displayName ?? x.net?.name ?? i?.handle ?? x.net?.handle ?? nativeId;
    const handle = i?.handle ?? x.net?.handle ?? undefined;
    const tier = matchTier([name, i?.nickname, i?.displayName, x.net?.name, handle, personName], q);
    if (!tier) continue;
    const avatar = i?.avatar ?? (x.net?.avatar ? s.mediaUrl(x.net.avatar, accountId) : null);
    const row: P.MentionRow = {
      kind: 'identity',
      insert: `<@${nativeId}> `,
      pings: true,
      section: 'here',
      name,
      network,
      ...(handle && handle !== name ? { handle } : {}),
      ...(avatar ? { avatar } : {}),
      // Only an identity the hub has: one the network named alone stays unstored.
      ...(i ? { identityId: i.id } : {}),
      ...(i?.personId && personName ? { personId: i.personId } : {}),
      ...((i?.isBot ?? x.net?.isBot) ? { isBot: true } : {}),
    };
    out.push({ row, tier, order: 0, talk: talkOf(keyOf(id, i)), lastSpoke: x.lastSpoke });
  }
  for (const r of Array.isArray(answer?.roles) ? answer.roles : []) {
    if (!r || typeof r.id !== 'string' || typeof r.name !== 'string') continue;
    const tier = matchTier([r.name], q);
    if (!tier) continue;
    out.push({ row: { kind: 'role', insert: `<@&${r.id}> `, pings: true, section: 'here', name: r.name, network, roleId: r.id, ...(typeof r.color === 'string' && /^#[0-9a-f]{6}$/i.test(r.color) ? { color: r.color } : {}) }, tier, order: 1, talk: 0, lastSpoke: 0 });
  }
  if (answer?.everyone === true)
    for (const row of everyoneRows(network)) {
      const tier = matchTier([row.name], q);
      if (tier) out.push({ row, tier, order: 2, talk: 0, lastSpoke: 0 });
    }

  out.sort((a, b) => b.tier - a.tier || a.order - b.order || b.talk - a.talk || b.lastSpoke - a.lastSpoke || a.row.name.localeCompare(b.row.name));
  // People capped; the roles and @everyone that match stay.
  let n = 0;
  const rows = out.filter((c) => c.order !== 0 || n++ < PEOPLE_MAX).map((c) => c.row);
  return { rows, ...(partial ? { partial: true } : {}) };
}

/** The promise's value, or null when it fails or takes longer than `ms`. */
function within<T>(p: Promise<T>, ms: number): Promise<T | null> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  return Promise.race([p.catch(() => null), new Promise<null>((r) => (timer = setTimeout(() => r(null), ms)))]).finally(() => clearTimeout(timer));
}
