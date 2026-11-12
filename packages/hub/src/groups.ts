/**
 * Making a group (docs/group-settings.md "Making a group"): one of your accounts makes a new group on its own network
 * with people it knows. The sibling of adding people (about.ts addMembers), with the same rules: only from a click,
 * paced per account, a few people at a time, logged, one person refused does not stop the rest.
 */
import type * as P from '@dither-chat/protocol';
import { createGroupNotBuilt, createGroupProblem, GROUP_RULES, NETWORK_META } from '@dither-chat/protocol';
import { hubId } from '@dither-chat/protocol/ids';
import { AboutError, candidatePool, caps } from './about.ts';
import { givePace, type PaceKind, takePace } from './add.ts';
import type { Attempt } from './attempts.ts';
import type { Store } from './store.ts';

export interface GroupDeps {
  store: Store;
  online: (accountId: string) => boolean;
  command: <T>(accountId: string, cmd: { t: 'createGroup'; name?: string; people: string[] }, timeoutMs?: number) => Promise<T>;
  /** A line in the account's log on the hub. */
  note?: (accountId: string, line: string) => void;
  now?: () => number;
}

/** How long the hub waits for a group to be made: on some networks each person is a request of its own. */
export const CREATE_GROUP_TIMEOUT = 90_000;

export class Groups {
  constructor(private d: GroupDeps) {}

  /**
   * GET /api/groups/candidates (`?account=` for one): every connected account that can make a group, with whom it could
   * put in one (the same pool adding people offers, by the rule's `who`); the other connected chat accounts, with why not.
   */
  candidates(requested?: string): P.GroupCandidatesView {
    const s = this.d.store;
    const out: P.GroupCandidatesView = { accounts: [], unable: [], identities: [] };
    const seen = new Set<string>();
    for (const acc of s.accounts()) {
      if (requested && acc.id !== requested) continue;
      if (acc.network === 'email' || !this.d.online(acc.id)) continue;
      const network = acc.network as P.Network;
      const rule = GROUP_RULES[network];
      if (!rule || !caps(s, acc.id).includes('createGroup')) {
        out.unable.push({ accountId: acc.id, network, reason: createGroupNotBuilt(network) });
        continue;
      }
      const pool = candidatePool(s, acc.id, network, rule.who);
      out.accounts.push({ accountId: acc.id, network, rule, candidates: pool.candidates });
      for (const i of pool.identities) if (!seen.has(i.id)) (seen.add(i.id), out.identities.push(i));
    }
    return out;
  }

  /**
   * POST /api/groups { accountId, name?, identities }: make the group through that account. The rules first, then one
   * `groups` slot and one `members` slot per person, all or none; the adapter's own refusal gives them back.
   * `a` is filled in as the account and network become known, for the hub's log (attempts.ts).
   */
  async create(b: { accountId?: unknown; name?: unknown; identities?: unknown }, a?: Attempt): Promise<P.CreateGroupView> {
    const s = this.d.store;
    if (typeof b.accountId !== 'string' || !b.accountId) throw new AboutError('Which account makes it?', 400);
    if (b.name !== undefined && b.name !== null && typeof b.name !== 'string') throw new AboutError('A name is words', 400);
    if (!Array.isArray(b.identities) || !b.identities.every((x) => typeof x === 'string' && x)) throw new AboutError('Pick the people to put in it', 400);
    const wanted = [...new Set(b.identities as string[])];
    const acc = s.account(b.accountId);
    if (!acc) throw new AboutError('No such account', 404);
    const network = acc.network as P.Network;
    const net = NETWORK_META[network].name;
    const rule = GROUP_RULES[network];
    if (a) Object.assign(a, { accountId: acc.id, network, what: rule?.noun ?? 'a group' });
    if (!rule || !caps(s, acc.id).includes('createGroup')) throw new AboutError(createGroupNotBuilt(network), 409);
    const name = typeof b.name === 'string' ? b.name.trim() || undefined : undefined;
    const problem = createGroupProblem(network, name, wanted.length);
    if (problem) throw new AboutError(problem, 400);
    const people: { identityId: string; nativeId: string }[] = [];
    for (const identityId of wanted) {
      const n = s.nativeOf('identity', identityId);
      if (!n) throw new AboutError('Nobody by that id', 404);
      if (n.network !== network) throw new AboutError(`Only ${net} people can be in a ${net} ${rule.noun}`, 400);
      if (identityId === acc.self_identity) throw new AboutError('That is this account', 400);
      // Left out of the candidates on purpose, as adding people does.
      if (s.isSelf(identityId)) throw new AboutError('That is one of your own accounts', 400);
      people.push({ identityId, nativeId: n.nativeId });
    }
    if (!this.d.online(acc.id)) throw new AboutError(`${net} · ${acc.label} is not connected`, 409);

    // One group and one slot per person, all or none.
    const db = s.db;
    const at = this.d.now?.() ?? Date.now();
    const taken: PaceKind[] = [];
    const giveBack = () => {
      for (const k of taken) givePace(db, acc.id, k, at);
    };
    const g = takePace(db, acc, 'groups', at);
    if (!g.ok) throw new AboutError(g.error, 429);
    taken.push('groups');
    for (let i = 0; i < people.length; i++) {
      const p = takePace(db, acc, 'members', at);
      if (!p.ok) {
        giveBack();
        throw new AboutError(i ? `${p.error} (${i} of the ${people.length} would fit)` : p.error, 429);
      }
      taken.push('members');
    }

    let r: P.CreateGroupResult;
    try {
      r = await this.d.command<P.CreateGroupResult>(acc.id, { t: 'createGroup', ...(name ? { name } : {}), people: people.map((p) => p.nativeId) }, CREATE_GROUP_TIMEOUT);
    } catch (e) {
      const msg = String((e as Error)?.message ?? e);
      if (/timed out/i.test(msg)) throw new AboutError(`${net} did not answer in ${CREATE_GROUP_TIMEOUT / 1000} seconds. It may still have gone through: look again in a minute.`, 504);
      // Refused before anything went out (the adapter's own check, or the network's): the slots are given back.
      if (!/disconnected|not connected/i.test(msg)) giveBack();
      throw new AboutError(msg, 502);
    }
    // The adapter's facts came before its reply, so the conversation is in the store by now.
    const native = r && typeof r.conversation === 'string' ? r.conversation : '';
    const conversation = native ? s.conversationView(hubId('cnv', network, native)) : null;
    if (!conversation) throw new AboutError(`${net} made something but did not say which conversation it made`, 502);

    const byNative = new Map(people.map((p) => [p.nativeId, p.identityId]));
    const ids = (xs: unknown) => (Array.isArray(xs) ? xs : []).map((x) => byNative.get(String(x))).filter((x): x is string => !!x);
    const added = ids(r.added);
    const invited = ids(r.invited);
    const failed = (Array.isArray(r.failed) ? r.failed : [])
      .map((f) => ({ identityId: byNative.get(String(f?.id)) ?? '', reason: typeof f?.reason === 'string' && f.reason ? f.reason.slice(0, 300) : `${net} refused` }))
      .filter((f) => f.identityId);
    const notes = (Array.isArray(r.notes) ? r.notes : []).filter((n): n is string => typeof n === 'string' && !!n).map((n) => n.slice(0, 300));
    const names = (xs: string[]) => {
      const by = new Map(s.identitiesByIds(xs).map((i) => [i.id, i.handle ?? i.displayName ?? i.nativeId]));
      return xs.map((x) => by.get(x) ?? x).join(', ');
    };
    const called = name ?? conversation.name;
    this.d.note?.(
      acc.id,
      `[add] ${[
        `made ${rule.noun}${called ? ` "${called}"` : ''}${added.length ? ` with ${names(added)}` : ''}`,
        invited.length && `invited ${names(invited)}`,
        failed.length && `could not add ${names(failed.map((f) => f.identityId))}`,
      ]
        .filter(Boolean)
        .join('; ')}`,
    );
    return { accountId: acc.id, conversation, added, invited, failed, notes };
  }
}
