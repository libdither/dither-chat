/**
 * The composer's @ picker (docs/mentions.md): GET /api/conversations/:id/mentionables?q=&account=&scope=&same= answers
 * who this conversation can ping, in sections.
 *
 * Section 'here', from sources merged by identity:
 *  - the conversation's stored participants, without your own accounts;
 *  - who wrote here lately, from the stored messages;
 *  - the network's own answer (the adapter command `mentionables`, capability 'mentionables'): the people it knows here
 *    that the hub does not store (a Discord server's members, a Matrix room's), its roles, and whether you may write
 *    @everyone. Asked through the account the composer sends from, with a short wait: no answer in time and the rows
 *    are what the hub knows, `partial`. Nothing in the answer is stored.
 *
 * Then, as the place's setting says (`mentionSetting`, or `scope` and `same` asked for): 'friends', the people you
 * are friends with or have as a contact on any network, or have a direct chat with; and 'everyone', every person the
 * hub knows. A person shown here is not repeated. Their row carries their accounts; what it inserts is the network's
 * mention where they have an account on it, else a reference the hub lowers to plain @Name on send (mentionrefs.ts).
 *
 * Order in each section: how well the name matches what was typed (whole, start, a word's start, anywhere), then how
 * much you talk with them (the inbox's per-person tallies, attention.ts: turns they addressed to you and you answered,
 * decayed), then when they last spoke here.
 */
import type * as P from '@dither-chat/protocol';
import { identityRef, MENTION_SCOPES, personRef } from '@dither-chat/protocol';
import { hubId } from '@dither-chat/protocol/ids';
import { sumTallies, type Tally } from './attention.ts';
import { storeResolve } from './mentionrefs.ts';
import type { Store } from './store.ts';

/** How long the hub waits for the network's answer before it answers with what it knows. */
export const NETWORK_WAIT = 1500;
/** At most this many people in a section, and asked of the network. */
export const PEOPLE_MAX = 20;
/** The stored messages read for who wrote here lately, newest first. */
const RECENT_MESSAGES = 3000;
/** Everyone you know with nothing typed: who wrote anywhere in this many of the newest messages, and your friends. */
const RECENT_ANYWHERE = 2000;
/** People read for a name typed, before they are ranked. */
const NAME_CANDIDATES = 300;
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

type Row = Record<string, any>;

/** Whom the picker offers in a conversation, and where that was set. */
export interface MentionSetting {
  scope: P.MentionScope;
  same: boolean;
  /** 'default', or the place that set the scope: 'conversation', 'space' or 'folder' and its id. */
  from: { kind: 'default' } | { kind: P.PlaceKind; id: string };
}

/**
 * The place setting for a conversation (place_pref mention_scope, mention_same): its own; else its thread's parent's;
 * else its spaces', nearest first; else a folder's that holds any of them (or, for a direct chat, the person). Scope
 * and same-network each come from the nearest place that sets them. Unset everywhere: 'here' on a messaging network,
 * 'everyone' where the account keeps references (`refs`: the Calendar chat), and every network.
 */
export function mentionSetting(store: Store, conversationId: string, refs: boolean): MentionSetting {
  const c = store.one<Row>('SELECT id, shape, parent_id FROM conversation WHERE id = ?', conversationId);
  const chain: [P.PlaceKind, string][] = [];
  if (c) {
    chain.push(['conversation', c.id]);
    const base = c.shape === 'thread' && c.parent_id ? c.parent_id : c.id;
    if (base !== c.id) chain.push(['conversation', base]);
    // Spaces, breadth first: a Matrix space graph may have cycles.
    const seen = new Set<string>();
    let frontier = store.raw<Row>(`SELECT parent_id AS id FROM space_edge WHERE child_kind = 'conversation' AND child_id = ?`, base).map((r) => r.id as string);
    while (frontier.length) {
      const next: string[] = [];
      for (const id of frontier) {
        if (seen.has(id)) continue;
        seen.add(id);
        chain.push(['space', id]);
        next.push(...store.raw<Row>(`SELECT parent_id AS id FROM space_edge WHERE child_kind = 'space' AND child_id = ?`, id).map((r) => r.id as string));
      }
      frontier = next;
    }
    const held: [string, string][] = chain.map(([k, id]) => [k, id]);
    if (c.shape === 'direct')
      for (const r of store.raw<Row>(
        'SELECT DISTINCT i.person_id AS id FROM participant pa JOIN identity i ON i.id = pa.identity_id JOIN person p ON p.id = i.person_id WHERE pa.conversation_id = ? AND p.is_self = 0',
        c.id,
      ))
        held.push(['person', r.id]);
    for (const [kind, id] of held)
      for (const f of store.raw<Row>('SELECT folder_id FROM folder_item WHERE item_kind = ? AND item_id = ? ORDER BY folder_id', kind, id)) chain.push(['folder', f.folder_id]);
    // A folder inside a folder: the outer one says for it when it does not.
    for (const [, id] of chain.filter(([k]) => k === 'folder')) for (const f of store.raw<Row>('SELECT parent_id FROM folder WHERE id = ? AND parent_id IS NOT NULL', id)) chain.push(['folder', f.parent_id]);
  }
  const prefs = new Map(
    (chain.length ? store.raw<Row>(`SELECT kind, id, mention_scope, mention_same FROM place_pref WHERE mention_scope IS NOT NULL OR mention_same IS NOT NULL`) : []).map((r) => [`${r.kind}:${r.id}`, r]),
  );
  let scope: MentionSetting['scope'] | null = null;
  let same: boolean | null = null;
  let from: MentionSetting['from'] = { kind: 'default' };
  for (const [kind, id] of chain) {
    const p = prefs.get(`${kind}:${id}`);
    if (!p) continue;
    if (!scope && MENTION_SCOPES.includes(p.mention_scope)) (scope = p.mention_scope), (from = { kind, id });
    if (same === null && p.mention_same !== null) same = !!p.mention_same;
    if (scope && same !== null) break;
  }
  return { scope: scope ?? (refs ? 'everyone' : 'here'), same: same ?? false, from };
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

const byRank = (a: Candidate, b: Candidate) => b.tier - a.tier || a.order - b.order || b.talk - a.talk || b.lastSpoke - a.lastSpoke || a.row.name.localeCompare(b.row.name);
const likeEscape = (s: string) => s.replace(/[\\%_]/g, (c) => '\\' + c);
const inList = (n: number) => Array.from({ length: n }, () => '?').join(',');

/**
 * The picker's rows for a conversation, or null when there is no such conversation. `params`: q (what follows the @),
 * account (the account the composer sends from), scope ('here', 'friends' or 'everyone'; the place's setting when
 * absent), same ('1' or '0': friends and everyone only on this network; the place's setting when absent).
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
  // An account that keeps references (the calendar) is given them, and is the one to say what they do: nobody is pinged by a network.
  const refs = caps.includes('personRefs');
  const setting = mentionSetting(s, conversationId, refs);
  const asked = params.get('scope') as P.MentionScope | null;
  const scope = asked && MENTION_SCOPES.includes(asked) ? asked : setting.scope;
  const sameParam = params.get('same');
  const same = sameParam === '1' ? true : sameParam === '0' ? false : setting.same;
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
  const tallies = new Map<string, Tally[]>();
  const loadTallies = (keys: string[]) => {
    const want = keys.filter((k) => !tallies.has(k));
    for (const k of want) tallies.set(k, []);
    for (let i = 0; i < want.length; i += 400) {
      const chunk = want.slice(i, i + 400);
      for (const r of db.query(`SELECT author_key, tally FROM conv_author_feature WHERE author_key IN (${inList(chunk.length)})`).all(...chunk) as { author_key: string; tally: string }[]) {
        try {
          tallies.get(r.author_key)!.push(JSON.parse(r.tally));
        } catch {}
      }
    }
  };
  const talkOf = (key: string) => {
    const t = tallies.get(key);
    if (!t?.length) return 0;
    const sum = sumTallies(t, now);
    return sum.addressed + sum.replied;
  };
  const keyOf = (id: string, i?: P.IdentityView) => i?.personId ?? id;
  loadTallies([...new Set([...people].map(([id, x]) => keyOf(id, x.identity)))]);
  const personNames = new Map(
    (() => {
      const ids = [...new Set([...people.values()].map((x) => x.identity?.personId).filter((x): x is string => !!x))];
      return ids.length ? (db.query(`SELECT id, name FROM person WHERE is_self = 0 AND id IN (${inList(ids.length)})`).all(...ids) as { id: string; name: string }[]).map((r) => [r.id, r.name] as const) : [];
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
      // Where references are kept, one the hub stores is named by reference, so the account says who it is.
      insert: refs && i ? `${identityRef(i.id)} ` : `<@${nativeId}> `,
      pings: !refs,
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

  out.sort(byRank);
  // People capped; the roles and @everyone that match stay.
  let n = 0;
  const rows = out.filter((c) => c.order !== 0 || n++ < PEOPLE_MAX).map((c) => c.row);

  // Someone here who is one person on other networks too: their accounts, so the picker can name one of those.
  const persons = [...new Set(rows.map((r) => r.personId).filter((x): x is string => !!x))];
  const theirs = new Map<string, Row[]>();
  for (let i = 0; i < persons.length; i += 400) {
    const chunk = persons.slice(i, i + 400);
    for (const r of db.query(`SELECT * FROM identity WHERE person_id IN (${inList(chunk.length)}) ORDER BY updated_at DESC`).all(...chunk) as Row[])
      if (!self.has(r.id)) (theirs.get(r.person_id) ?? theirs.set(r.person_id, []).get(r.person_id)!).push(r);
  }
  const views = new Map(s.identitiesByIds([...theirs.values()].filter((l) => l.length > 1).flat().map((r) => r.id)).map((v) => [v.id, v]));
  for (const r of rows) {
    const list = r.personId ? theirs.get(r.personId) : undefined;
    if (list && list.length > 1) r.accounts = list.map((i) => accountRow(i, views.get(i.id), personNames.get(r.personId!)!, r.personId!, 'here', network, refs));
  }

  if (scope !== 'here') {
    // Who is shown here already, by person.
    const shown = new Set(rows.map((r) => (r.identityId ? people.get(r.identityId)?.identity?.personId : undefined)).filter((x): x is string => !!x));
    const sections = personSections(s, { conversationId, network, q, scope, same, refs, self, shown, loadTallies, talkOf });
    rows.push(...sections);
  }
  return { rows, ...(partial ? { partial: true } : {}), scope, ...(same ? { sameNetwork: true } : {}) };
}

/**
 * Sections 'friends' and (for scope 'everyone') 'everyone': persons, best first, each with their accounts. A person
 * with an account on this network inserts its mention (pings); one without inserts a reference the hub lowers to plain
 * @Name on send. Where references are kept, rows insert references and ping nobody.
 */
function personSections(
  s: Store,
  o: {
    conversationId: string;
    network: P.Network;
    q: string;
    scope: P.MentionScope;
    same: boolean;
    refs: boolean;
    self: Set<string>;
    shown: Set<string>;
    loadTallies: (keys: string[]) => void;
    talkOf: (key: string) => number;
  },
): P.MentionRow[] {
  const db = s.db;
  // Friends: linked as a friend or contact on any account, starred, or someone you have a direct chat with.
  const friends = new Set(
    (
      db
        .query(
          `SELECT i.person_id AS id FROM person_link l JOIN identity i ON i.id = l.identity_id WHERE l.relationship IN ('friend', 'contact') AND i.person_id IS NOT NULL
           UNION SELECT id FROM person WHERE starred = 1
           UNION SELECT i.person_id FROM conversation c JOIN participant pa ON pa.conversation_id = c.id JOIN identity i ON i.id = pa.identity_id
             WHERE c.shape = 'direct' AND i.person_id IS NOT NULL`,
        )
        .all() as { id: string }[]
    ).map((r) => r.id),
  );
  let candidates: string[];
  if (o.scope === 'friends') candidates = [...friends];
  else if (o.q) {
    // Everyone whose name, or an account's, holds what was typed.
    const like = `%${likeEscape(o.q)}%`;
    candidates = (
      db
        .query(
          `SELECT p.id FROM person p WHERE p.is_self = 0 AND (p.name LIKE ?1 ESCAPE '\\' OR EXISTS (SELECT 1 FROM identity i WHERE i.person_id = p.id
             AND (i.nickname LIKE ?1 ESCAPE '\\' OR i.display_name LIKE ?1 ESCAPE '\\' OR i.handle LIKE ?1 ESCAPE '\\'))) LIMIT ${NAME_CANDIDATES}`,
        )
        .all(like) as { id: string }[]
    ).map((r) => r.id);
    for (const f of friends) candidates.push(f);
  } else {
    // Nothing typed: your friends, and who wrote anywhere lately; the rest wait for a name.
    const recent = db
      .query(`SELECT DISTINCT i.person_id AS id FROM (SELECT author_id FROM message ORDER BY ts DESC LIMIT ${RECENT_ANYWHERE}) m JOIN identity i ON i.id = m.author_id WHERE i.person_id IS NOT NULL`)
      .all() as { id: string }[];
    candidates = [...friends, ...recent.map((r) => r.id)];
  }
  const ids = [...new Set(candidates)].filter((id) => !o.shown.has(id));
  if (!ids.length) return [];

  const persons = new Map<string, Row>();
  const accounts = new Map<string, Row[]>();
  for (let i = 0; i < ids.length; i += 400) {
    const chunk = ids.slice(i, i + 400);
    for (const r of db.query(`SELECT id, name, avatar_url, is_self FROM person WHERE id IN (${inList(chunk.length)})`).all(...chunk) as Row[]) if (!r.is_self) persons.set(r.id, r);
    for (const r of db.query(`SELECT * FROM identity WHERE person_id IN (${inList(chunk.length)}) ORDER BY updated_at DESC`).all(...chunk) as Row[]) {
      if (o.self.has(r.id)) {
        persons.delete(r.person_id);
        continue;
      }
      (accounts.get(r.person_id) ?? accounts.set(r.person_id, []).get(r.person_id)!).push(r);
    }
  }
  // Who matches, by section, ranked; then rows for the ones shown.
  const matched: Record<'friends' | 'everyone', { pid: string; list: Row[]; here: Row[]; tier: number }[]> = { friends: [], everyone: [] };
  for (const [pid, p] of persons) {
    const all = accounts.get(pid) ?? [];
    const here = all.filter((r) => r.network === o.network);
    const list = o.same ? here : all;
    if (!list.length) continue;
    const tier = matchTier([p.name, ...list.flatMap((r) => [r.nickname, r.display_name, r.handle])], o.q);
    if (!tier) continue;
    const section = friends.has(pid) ? 'friends' : 'everyone';
    if (section === 'everyone' && o.scope !== 'everyone') continue;
    matched[section].push({ pid, list, here, tier });
  }
  o.loadTallies([...matched.friends, ...matched.everyone].map((m) => m.pid));
  const resolve = storeResolve(s, o.conversationId);
  const rows: P.MentionRow[] = [];
  for (const section of ['friends', 'everyone'] as const) {
    const ranked = matched[section]
      .map((m) => ({ m, c: { row: { name: persons.get(m.pid)!.name } as P.MentionRow, tier: m.tier, order: 0, talk: o.talkOf(m.pid), lastSpoke: 0 } }))
      .sort((a, b) => byRank(a.c, b.c))
      .slice(0, PEOPLE_MAX);
    const views = new Map(s.identitiesByIds(ranked.flatMap(({ m }) => m.list.map((r) => r.id))).map((v) => [v.id, v]));
    for (const { m } of ranked) {
      const p = persons.get(m.pid)!;
      // Their account on this network to mention: the one the hub would lower a reference to.
      const best = m.here.length && !o.refs ? resolve('person', m.pid) : null;
      const native = best && 'nativeId' in best ? best.nativeId : null;
      const sub = m.list.map((r) => accountRow(r, views.get(r.id), p.name, m.pid, section, o.network, o.refs));
      const lead = (native ? sub.find((x) => x.insert === `<@${native}> `) : undefined) ?? sub[0];
      const avatar = p.avatar_url ? s.mediaUrl(p.avatar_url, null) : lead.avatar;
      rows.push({
        kind: 'person',
        insert: native ? `<@${native}> ` : `${personRef(m.pid)} `,
        pings: !!native,
        section,
        name: p.name,
        personId: m.pid,
        ...(native ? { network: o.network, identityId: lead.identityId } : m.list.length === 1 ? { network: lead.network } : {}),
        ...(avatar ? { avatar } : {}),
        ...(m.list.every((r) => r.is_bot) ? { isBot: true } : {}),
        accounts: sub,
      });
    }
  }
  return rows;
}

/** One of a person's accounts as a row: its mention on this network (pings), else a reference (does not). */
function accountRow(r: Row, v: P.IdentityView | undefined, personName: string, personId: string, section: P.MentionRow['section'], network: P.Network, refs: boolean): P.MentionRow {
  const on = r.network === network && !refs;
  return {
    kind: 'identity',
    insert: on ? `<@${r.native_id}> ` : `${identityRef(r.id)} `,
    pings: on,
    section,
    name: r.nickname || r.display_name || r.handle || personName,
    network: r.network,
    identityId: r.id,
    personId,
    ...(r.handle && r.handle !== (r.nickname || r.display_name) ? { handle: r.handle } : {}),
    ...(v?.avatar ? { avatar: v.avatar } : {}),
    ...(r.is_bot ? { isBot: true } : {}),
  };
}

/** The promise's value, or null when it fails or takes longer than `ms`. */
function within<T>(p: Promise<T>, ms: number): Promise<T | null> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  return Promise.race([p.catch(() => null), new Promise<null>((r) => (timer = setTimeout(() => r(null), ms)))]).finally(() => clearTimeout(timer));
}
