/**
 * Status dots (docs/profile.md, "Status dots"): which dot an avatar shows, from the hub's latest presence
 * (`db.presence`, PresenceNowView). Pure. A presence frame moves only `presenceRev` (versions.ts), so the dots draw
 * again and the lists they sit in do not.
 *
 * A person is as present as their most present account: online, then do not disturb, then idle, then offline (the
 * order the Activity chart merges in). The tooltip names the network ("Online on Zulip"). Nothing known: no dot.
 */
import type * as P from '@dither-chat/protocol';
import { NETWORK_META, PRESENCE_LABEL } from '@dither-chat/protocol';

export type DotState = P.PresenceNowView['state'];

export interface Dot {
  state: DotState;
  /** The networks they are this way on, in the order heard most recently first. */
  networks: P.Network[];
  title: string;
}

/** What a dot reads: the latest presence by identity, identities (for their network and person), persons. */
export interface PresenceDb {
  presence: Map<string, P.PresenceNowView>;
  identities: Map<string, Pick<P.IdentityView, 'id' | 'network' | 'personId'>>;
  persons: Map<string, Pick<P.PersonView, 'id' | 'identityIds' | 'name'>>;
}

const RANK: Record<DotState, number> = { online: 3, dnd: 2, idle: 1, offline: 0 };
const label = (s: DotState) => (s === 'offline' ? 'Offline' : PRESENCE_LABEL[s]);
const netName = (n: P.Network) => NETWORK_META[n]?.name ?? n;
const and = (xs: string[]) => (xs.length < 2 ? (xs[0] ?? '') : `${xs.slice(0, -1).join(', ')} and ${xs[xs.length - 1]}`);

/** The dot for these identities taken as one person: the most present state, and where. Null when none is known. */
export function dotOf(db: PresenceDb, identityIds: readonly string[]): Dot | null {
  let best: DotState | null = null;
  const at = new Map<P.Network, number>();
  for (const id of identityIds) {
    const p = db.presence.get(id);
    const net = db.identities.get(id)?.network;
    if (!p || !net) continue;
    if (best === null || RANK[p.state] > RANK[best]) {
      best = p.state;
      at.clear();
    }
    if (p.state === best) at.set(net, Math.max(at.get(net) ?? 0, p.at));
  }
  if (best === null) return null;
  const networks = [...at.keys()].sort((a, b) => at.get(b)! - at.get(a)!);
  return { state: best, networks, title: `${label(best)} on ${and(networks.map(netName))}` };
}

/** One identity's dot, merged with the rest of its person's accounts. */
export function identityDot(db: PresenceDb, identityId: string | null | undefined): Dot | null {
  if (!identityId) return null;
  const pid = db.identities.get(identityId)?.personId;
  const person = pid ? db.persons.get(pid) : undefined;
  return dotOf(db, person ? [...new Set([identityId, ...person.identityIds])] : [identityId]);
}

export function personDot(db: PresenceDb, personId: string | null | undefined): Dot | null {
  const p = personId ? db.persons.get(personId) : undefined;
  return p ? dotOf(db, p.identityIds) : null;
}

/**
 * A group's dot: shown only while someone in it is around (online, busy or idle), the most present of them; the
 * tooltip names who, a few at most. Offline people are no dot here: a group of people who are away is not news.
 */
export function groupDot(db: PresenceDb, memberIds: readonly string[], nameOf: (identityId: string) => string): Dot | null {
  const seen = new Set<string>();
  const around: { name: string; dot: Dot }[] = [];
  for (const id of memberIds) {
    const pid = db.identities.get(id)?.personId;
    const key = pid ?? id;
    if (seen.has(key)) continue;
    seen.add(key);
    const dot = identityDot(db, id);
    if (dot && dot.state !== 'offline') around.push({ name: nameOf(id), dot });
  }
  if (!around.length) return null;
  around.sort((a, b) => RANK[b.dot.state] - RANK[a.dot.state]);
  const best = around[0].dot.state;
  const networks = [...new Set(around.filter((a) => a.dot.state === best).flatMap((a) => a.dot.networks))];
  const named = around.slice(0, 3).map((a) => `${a.name} (${label(a.dot.state).toLowerCase()})`);
  const more = around.length > 3 ? ` and ${around.length - 3} more` : '';
  return { state: best, networks, title: `Around: ${named.join(', ')}${more}` };
}

/** Apply a bootstrap's list or a live frame. True when anything changed. */
export function applyPresence(map: Map<string, P.PresenceNowView>, ev: { items: P.PresenceNowView[]; removed: string[]; replace?: true }): boolean {
  let changed = false;
  if (ev.replace && map.size) {
    map.clear();
    changed = true;
  }
  for (const v of ev.items) {
    const was = map.get(v.identityId);
    if (was && was.state === v.state && was.at === v.at && (was.devices ?? []).join() === (v.devices ?? []).join()) continue;
    map.set(v.identityId, v);
    changed = true;
  }
  for (const id of ev.removed) changed = map.delete(id) || changed;
  return changed;
}
