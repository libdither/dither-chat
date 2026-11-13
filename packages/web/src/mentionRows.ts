/**
 * The @ picker's rows (docs/mentions.md). At once, from what this device holds: the conversation's people and who
 * wrote in its loaded messages. Then the hub's answer (GET /api/conversations/:id/mentionables), which adds what the
 * hub stores and what the network knows here (a server's members, its roles, @everyone where you may) and orders them;
 * it replaces the first rows, and is kept a minute so typing back over a name asks nothing again.
 */
import type * as P from '@dither-chat/protocol';
import { accountName } from './chatroutes.ts';
import { api, db, isSelfIdentity, timelines } from './state.ts';

/** The query as matched: no leading @, lower case, trimmed (the hub's cleanQuery). */
export const cleanQuery = (q: string) => q.replace(/^@+/, '').trim().slice(0, 64).toLocaleLowerCase();

/** How well any of the names matches: 4 whole, 3 its start, 2 a word's start, 1 anywhere, 0 not (as the hub's matchTier). */
export function matchTier(names: (string | null | undefined)[], q: string): number {
  if (!q) return 1;
  let best = 0;
  for (const raw of names) {
    if (!raw) continue;
    const n = raw.toLocaleLowerCase().replace(/^@+/, '');
    const t = n === q ? 4 : n.startsWith(q) ? 3 : n.split(/[\s._\-:]+/).some((w) => w.startsWith(q)) ? 2 : n.includes(q) ? 1 : 0;
    if (t > best) best = t;
  }
  return best;
}

/** Rows from this device alone: the people in the conversation and who wrote in what is loaded of it, best match first, then who spoke last. */
export function localRows(conversationId: string, query: string, max = 20): P.MentionRow[] {
  const c = db.conversations.get(conversationId);
  if (!c) return [];
  const q = cleanQuery(query);
  const spoke = new Map<string, number>();
  for (const m of timelines.get('c:' + conversationId)?.messages ?? []) if (m.authorId && !m.deleted && m.kind !== 'system') spoke.set(m.authorId, Math.max(spoke.get(m.authorId) ?? 0, m.ts));
  const out: { row: P.MentionRow; tier: number; at: number }[] = [];
  for (const id of new Set([...c.participantIds, ...spoke.keys()])) {
    const i = db.identities.get(id);
    if (!i || isSelfIdentity(id)) continue;
    const person = i.personId ? db.persons.get(i.personId) : undefined;
    const name = person && !person.isSelf ? person.name : accountName(i);
    const tier = matchTier([name, i.nickname, i.displayName, i.handle], q);
    if (!tier) continue;
    out.push({
      row: {
        kind: 'identity',
        insert: `<@${i.nativeId}> `,
        pings: true,
        section: 'here',
        name,
        network: i.network,
        identityId: i.id,
        ...(i.handle && i.handle !== name ? { handle: i.handle } : {}),
        ...(i.avatar ? { avatar: i.avatar } : {}),
        ...(i.isBot ? { isBot: true } : {}),
      },
      tier,
      at: spoke.get(id) ?? 0,
    });
  }
  out.sort((a, b) => b.tier - a.tier || b.at - a.at || a.row.name.localeCompare(b.row.name));
  return out.slice(0, max).map((x) => x.row);
}

/**
 * The hub's rows, with (only when the network did not answer) this device's that it left out at the end of the
 * people here, before friends and everyone. A full answer stands alone: it already holds what this device knows, in
 * the hub's order.
 */
export function mergeRows(hub: P.MentionablesView, local: P.MentionRow[]): P.MentionRow[] {
  if (!hub.partial) return hub.rows;
  const seen = new Set(hub.rows.map((r) => r.insert));
  const here = hub.rows.filter((r) => r.section === 'here');
  return [...here, ...local.filter((r) => !seen.has(r.insert)), ...hub.rows.slice(here.length)];
}

const answers = new Map<string, { at: number; value: Promise<P.MentionablesView>; known?: P.MentionablesView }>();
const KEEP = 60_000;
/** The places' @ settings (docs/mentions.md): a change asks the hub again rather than draw a minute-old answer. */
function settings(): string {
  let s = '';
  for (const p of db.placePrefs.values()) if (p.mentionScope || p.mentionSameNetwork !== undefined) s += `${p.kind}:${p.id}:${p.mentionScope ?? ''}:${p.mentionSameNetwork ?? ''};`;
  return s;
}
const keyOf = (conversationId: string, accountId: string | undefined, q: string) => `${conversationId}|${accountId ?? ''}|${q}|${settings()}`;

/** The hub's rows for what was typed, when it answered them this last minute: drawn at once, without asking again. */
export function knownRows(conversationId: string, accountId: string | undefined, query: string): P.MentionablesView | null {
  const hit = answers.get(keyOf(conversationId, accountId, cleanQuery(query)));
  return hit && Date.now() - hit.at < KEEP ? (hit.known ?? null) : null;
}

/** The hub's rows for what was typed, through the account the composer sends from. */
export function hubRows(conversationId: string, accountId: string | undefined, query: string): Promise<P.MentionablesView> {
  const q = cleanQuery(query);
  const key = keyOf(conversationId, accountId, q);
  const hit = answers.get(key);
  if (hit && Date.now() - hit.at < KEEP) return hit.value;
  const params = new URLSearchParams({ q, ...(accountId ? { account: accountId } : {}) });
  const value = api<P.MentionablesView>(`/api/conversations/${conversationId}/mentionables?${params}`);
  const entry: { at: number; value: Promise<P.MentionablesView>; known?: P.MentionablesView } = { at: Date.now(), value };
  answers.set(key, entry);
  // An answer without the network's part is asked again next time, and a failed one too.
  value.then(
    (v) => (v.partial ? answers.delete(key) : (entry.known = v)),
    () => answers.delete(key),
  );
  if (answers.size > 200) answers.delete(answers.keys().next().value!);
  return value;
}
