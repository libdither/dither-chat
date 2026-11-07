/**
 * The people graph (GET /api/graph, docs/people-graph.md): people and the places they share, built from what the hub
 * already has. A person stands for all their identities; an identity no person holds stands alone. Places are
 * communities (a channel or category counts toward its server) and group chats. Links come from:
 *  - server members seen, only while the adversarial `members` setting records them;
 *  - the mutual servers a fetched profile named;
 *  - the participants of groups, and of channels inside a server.
 * Only people and places with a link are sent; you are left out. Ids, names and indexes, never message text.
 */
import type * as P from '@dither-chat/protocol';
import { GRAPH_SOURCE } from '@dither-chat/protocol';
import { hubId } from '@dither-chat/protocol/ids';
import type { Store } from './store.ts';

type Row = Record<string, any>;

export function peopleGraph(s: Store): P.PeopleGraph {
  const db = s.db;
  const members = s.recordsMembers();
  const accounts = db.query('SELECT id, self_identity FROM account ORDER BY position, created_at').all() as Row[];
  const accIx = new Map(accounts.map((a, i) => [a.id as string, i]));

  const self = new Set<string>(accounts.map((a) => a.self_identity).filter(Boolean));
  for (const r of db.query('SELECT i.id FROM identity i JOIN person p ON p.id = i.person_id WHERE p.is_self = 1').all() as Row[]) self.add(r.id);

  // Communities, and the community each section or subspace sits in.
  const spaces = new Map<string, Row>((db.query('SELECT id, network, kind, name FROM space').all() as Row[]).map((r) => [r.id, r]));
  const parents = new Map<string, string[]>();
  for (const e of db.query(`SELECT parent_id, child_id FROM space_edge WHERE child_kind = 'space'`).all() as Row[]) {
    const l = parents.get(e.child_id);
    if (l) l.push(e.parent_id);
    else parents.set(e.child_id, [e.parent_id]);
  }
  const rootCache = new Map<string, string | null>();
  const community = (id: string): string | null => {
    if (rootCache.has(id)) return rootCache.get(id)!;
    let out: string | null = null;
    const seen = new Set<string>();
    const walk = [id];
    while (walk.length) {
      const x = walk.shift()!;
      if (seen.has(x)) continue;
      seen.add(x);
      if (spaces.get(x)?.kind === 'community') {
        out = x;
        break;
      }
      walk.push(...(parents.get(x) ?? []));
    }
    rootCache.set(id, out);
    return out;
  };
  // The server a channel is in.
  const convSpace = new Map<string, string>();
  for (const e of db.query(`SELECT parent_id, child_id FROM space_edge WHERE child_kind = 'conversation'`).all() as Row[]) {
    const c = community(e.parent_id);
    if (c && !convSpace.has(e.child_id)) convSpace.set(e.child_id, c);
  }

  // People, made only when a link needs them.
  const idents = new Map<string, Row>(
    (db.query('SELECT i.id, i.network, i.display_name, i.handle, i.is_bot, i.person_id, p.name AS person_name FROM identity i LEFT JOIN person p ON p.id = i.person_id').all() as Row[]).map((r) => [r.id, r]),
  );
  const byPerson = new Map<string, Row[]>();
  for (const r of idents.values()) if (r.person_id) (byPerson.get(r.person_id) ?? byPerson.set(r.person_id, []).get(r.person_id)!).push(r);
  const people: P.GraphPerson[] = [];
  const personIx = new Map<string, number>();
  const personOf = (identityId: string): number | null => {
    if (self.has(identityId)) return null;
    const r = idents.get(identityId);
    if (!r) return null;
    const key = r.person_id ?? identityId;
    let i = personIx.get(key);
    if (i === undefined) {
      i = people.length;
      personIx.set(key, i);
      const list = r.person_id ? byPerson.get(r.person_id)! : [r];
      const networks = [...new Set(list.map((x) => x.network as P.Network))];
      people.push({
        id: key,
        ...(r.person_id ? {} : { identity: true as const }),
        name: r.person_name ?? r.display_name ?? r.handle ?? 'Someone',
        networks,
        dm: [],
        ...(list.every((x) => x.is_bot) ? { bot: true as const } : {}),
      });
    }
    return i;
  };

  const places: P.GraphPlace[] = [];
  const placeIx = new Map<string, number>();
  const groups = new Map<string, Row>((db.query(`SELECT id, network, name FROM conversation WHERE shape = 'group'`).all() as Row[]).map((r) => [r.id, r]));
  const placeOf = (id: string): number | null => {
    let i = placeIx.get(id);
    if (i !== undefined) return i;
    const sp = spaces.get(id);
    const g = sp ? null : groups.get(id);
    if (!sp && !g) return null;
    i = places.length;
    placeIx.set(id, i);
    places.push({ id, kind: sp ? 'space' : 'group', name: (sp ?? g)!.name ?? null, network: (sp ?? g)!.network, accounts: [] });
    return i;
  };

  const links = new Map<number, number>();
  const link = (identityId: string, placeId: string | null, source: number) => {
    if (!placeId) return;
    const p = personOf(identityId);
    if (p === null) return;
    const q = placeOf(placeId);
    if (q === null) return;
    const k = p * 2 ** 22 + q;
    links.set(k, (links.get(k) ?? 0) | source);
  };

  if (members)
    for (const r of db.query('SELECT space_id, identity_id FROM membership').all() as Row[]) link(r.identity_id, community(r.space_id), GRAPH_SOURCE.members);

  for (const r of db.query('SELECT target_id, data FROM about').all() as Row[]) {
    const network = idents.get(r.target_id)?.network;
    if (!network) continue;
    let mutual: unknown;
    try {
      mutual = JSON.parse(r.data)?.mutualSpaces;
    } catch {
      continue;
    }
    if (!Array.isArray(mutual)) continue;
    for (const m of mutual) if (m && typeof m.id === 'string') link(r.target_id, community(hubId('spc', network, m.id)), GRAPH_SOURCE.profile);
  }

  for (const r of db.query(`SELECT p.conversation_id, p.identity_id, c.shape FROM participant p JOIN conversation c ON c.id = p.conversation_id WHERE c.shape IN ('group', 'channel')`).all() as Row[])
    link(r.identity_id, r.shape === 'group' ? r.conversation_id : (convSpace.get(r.conversation_id) ?? null), GRAPH_SOURCE.participant);

  // Which accounts see each place, and which have a direct chat with each person.
  const push = (l: number[], x: number | undefined) => x !== undefined && !l.includes(x) && l.push(x);
  for (const v of db.query('SELECT account_id, target_kind, target_id FROM vantage').all() as Row[]) {
    const id = v.target_kind === 'space' ? community(v.target_id) : groups.has(v.target_id) ? v.target_id : convSpace.get(v.target_id);
    const q = id ? placeIx.get(id) : undefined;
    if (q !== undefined) push(places[q].accounts, accIx.get(v.account_id));
  }
  for (const r of db
    .query(`SELECT p.identity_id, v.account_id FROM participant p JOIN conversation c ON c.id = p.conversation_id AND c.shape = 'direct' JOIN vantage v ON v.target_kind = 'conversation' AND v.target_id = c.id`)
    .all() as Row[]) {
    const r2 = idents.get(r.identity_id);
    const i = r2 ? personIx.get(r2.person_id ?? r.identity_id) : undefined;
    if (i !== undefined) push(people[i].dm, accIx.get(r.account_id));
  }

  if (members)
    for (const c of db.query('SELECT space_id, total FROM member_coverage WHERE total IS NOT NULL').all() as Row[]) {
      const q = placeIx.get(c.space_id);
      if (q !== undefined) places[q].total = c.total;
    }

  const flat: number[] = [];
  for (const [k, src] of links) flat.push(Math.floor(k / 2 ** 22), k % 2 ** 22, src);
  return { members, accounts: accounts.map((a) => a.id), people, places, links: flat };
}
