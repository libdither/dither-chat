/**
 * About and settings (docs/group-settings.md): asks the adapter for a conversation's or space's About, keeps the
 * answer, turns it into hub ids, and passes a change on only when the network's rules and a fresh About say this
 * account may make it.
 */
import type * as P from '@dither-chat/protocol';
import { ABOUT_LABEL, aboutChangeProblem, ADD_MEMBERS_MAX, addMembersNotBuilt, NETWORK_META } from '@dither-chat/protocol';
import { hubId } from '@dither-chat/protocol/ids';
import { addTables, givePace, takePace } from './add.ts';
import type { Attempt } from './attempts.ts';
import type { Store } from './store.ts';

export interface AboutDeps {
  store: Store;
  online: (accountId: string) => boolean;
  command: <T>(
    accountId: string,
    cmd: { t: 'about'; target: P.AboutTarget } | { t: 'configure'; target: P.AboutTarget; change: P.AboutChange } | { t: 'addMembers'; target: P.AboutTarget; people: string[] },
    timeoutMs?: number,
  ) => Promise<T>;
  /** Which account speaks for a conversation (the one that would send), honouring a request. */
  pickAccount: (conversationId: string, requested?: string) => string | null;
  /** A line in the account's log on the hub. */
  note?: (accountId: string, line: string) => void;
  now?: () => number;
}

/** How long the hub waits for people to be added: each is its own request on some networks. */
export const ADD_MEMBERS_TIMEOUT = 90_000;
/** At most this many people offered to pick from. */
const CANDIDATES_MAX = 400;

type Kind = P.AboutTarget['kind'];

export class AboutError extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message);
  }
}

export const caps = (store: Store, accountId: string): P.Capability[] => JSON.parse(store.account(accountId)?.capabilities ?? '[]');

export class Abouts {
  constructor(private d: AboutDeps) {}

  private target(kind: Kind, id: string): { network: P.Network; nativeId: string } | null {
    return this.d.store.nativeOf(kind, id);
  }

  private account(kind: Kind, id: string, requested?: string): string | null {
    if (kind === 'conversation') return this.d.pickAccount(id, requested);
    const vs = this.d.store.vantageAccounts('space', id);
    if (requested && vs.includes(requested)) return requested;
    return vs.find((a) => this.d.online(a)) ?? vs[0] ?? null;
  }

  /** The About as the network has it now, or the last one kept, or what the hub knows itself. */
  async get(kind: Kind, id: string, requested?: string): Promise<P.AboutView> {
    const t = this.target(kind, id);
    if (!t) throw new AboutError(`no such ${kind}`, 404);
    const accountId = this.account(kind, id, requested);
    const name = accountId ? this.d.store.account(accountId)?.label : null;
    if (accountId && this.d.online(accountId) && caps(this.d.store, accountId).includes('about')) {
      try {
        const about = await this.d.command<P.About>(accountId, { t: 'about', target: { kind, nativeId: t.nativeId } }, 30_000);
        this.keep(id, accountId, about);
        return this.view(kind, id, t.network, accountId, about, Date.now(), undefined, caps(this.d.store, accountId).includes('configure'));
      } catch (e) {
        return this.fallback(kind, id, t.network, accountId, `Could not ask ${NETWORK_META[t.network].name}: ${(e as Error).message}`);
      }
    }
    const why = !accountId
      ? `None of your accounts is in this ${kind}.`
      : !this.d.online(accountId)
        ? `${NETWORK_META[t.network].name} · ${name} is not connected; this is what it said last.`
        : `This account's adapter cannot read settings yet.`;
    return this.fallback(kind, id, t.network, accountId, why);
  }

  /** Change one thing, through the account whose view this is. Answers with the About as it now stands. */
  async configure(kind: Kind, id: string, change: P.AboutChange, requested?: string): Promise<P.AboutView> {
    const t = this.target(kind, id);
    if (!t) throw new AboutError(`no such ${kind}`, 404);
    if (!change || typeof change !== 'object' || typeof (change as { key?: unknown }).key !== 'string') throw new AboutError('what should change?', 400);
    const problem = aboutChangeProblem(t.network, kind, change);
    if (problem) throw new AboutError(problem, 400);
    const accountId = this.account(kind, id, requested);
    if (!accountId) throw new AboutError(`None of your accounts is in this ${kind}.`, 409);
    const acc = this.d.store.account(accountId)!;
    if (!this.d.online(accountId)) throw new AboutError(`${NETWORK_META[t.network].name} · ${acc.label} is not connected`, 409);
    if (!caps(this.d.store, accountId).includes('configure')) throw new AboutError(`${acc.label} cannot change settings on ${NETWORK_META[t.network].name}`, 409);
    const target = { kind, nativeId: t.nativeId };
    // Never on a stale answer: what this account may do can have changed since the panel opened.
    const fresh = await this.d.command<P.About>(accountId, { t: 'about', target }, 30_000).catch((e: Error) => {
      throw new AboutError(`Could not ask ${NETWORK_META[t.network].name}: ${e.message}`, 502);
    });
    const refusal = refusalOf(fresh, change);
    if (refusal) throw new AboutError(refusal, 403);
    const after = await this.d.command<P.About>(accountId, { t: 'configure', target, change }, 60_000).catch((e: Error) => {
      throw new AboutError(e.message, 502);
    });
    const about = after && typeof after === 'object' && 'fields' in after ? after : fresh;
    this.keep(id, accountId, about);
    return this.view(kind, id, t.network, accountId, about, Date.now(), undefined, true);
  }

  /**
   * GET /api/conversations/:id/members/candidates: whom this account could add here, by the About it last gave (asked
   * again only when none is kept): its friends where the network adds only friends, else its contacts and the people
   * it has a direct conversation with, else also everyone in its other groups. People it talked with lately first;
   * nobody in it already, nobody whose request still waits on you, and never the account itself or a bot.
   */
  async candidates(id: string, requested?: string): Promise<P.MemberCandidatesView> {
    const t = this.target('conversation', id);
    if (!t) throw new AboutError('no such conversation', 404);
    const accountId = this.account('conversation', id, requested);
    if (!accountId) throw new AboutError('None of your accounts is in this conversation.', 409);
    let about = this.kept(id, accountId)?.about ?? null;
    if (!about && this.d.online(accountId) && caps(this.d.store, accountId).includes('about')) {
      about = await this.d.command<P.About>(accountId, { t: 'about', target: { kind: 'conversation', nativeId: t.nativeId } }, 30_000).catch(() => null);
      if (about) this.keep(id, accountId, about);
    }
    const adding = about?.adding;
    const who: P.AddWho = adding?.who ?? 'known';
    const inIt = new Set((this.d.store.db.query('SELECT identity_id FROM participant WHERE conversation_id = ?').all(id) as { identity_id: string }[]).map((r) => r.identity_id));
    for (const m of about?.members?.list ?? []) inIt.add(hubId('idn', t.network, m.id));
    return {
      accountId,
      who,
      mode: adding?.mode ?? 'add',
      ...(adding?.room !== undefined ? { room: adding.room } : {}),
      ...candidatePool(this.d.store, accountId, t.network, who, inIt),
    };
  }

  /**
   * POST /api/conversations/:id/members { identities, accountId? }: add these people through the account whose view
   * this is, when a fresh About says it may and there is room. Each person counts once against the account's day.
   */
  async addMembers(id: string, b: { identities?: unknown; accountId?: unknown }, a?: Attempt): Promise<P.AddMembersView> {
    const t = this.target('conversation', id);
    if (!t) throw new AboutError('no such conversation', 404);
    // For the hub's log (attempts.ts), filled in as it becomes known.
    if (a) a.network = t.network;
    const wanted = Array.isArray(b.identities) ? [...new Set(b.identities)] : [];
    if (!wanted.length || wanted.length > ADD_MEMBERS_MAX || !wanted.every((x) => typeof x === 'string' && x)) throw new AboutError(`Pick 1 to ${ADD_MEMBERS_MAX} people`, 400);
    const accountId = this.account('conversation', id, typeof b.accountId === 'string' ? b.accountId : undefined);
    if (!accountId) throw new AboutError('None of your accounts is in this conversation.', 409);
    const acc = this.d.store.account(accountId)!;
    const net = NETWORK_META[t.network].name;
    const group = this.d.store.one<{ name: string | null }>('SELECT name FROM conversation WHERE id = ?', id)?.name ?? 'a group';
    if (a) Object.assign(a, { accountId, what: group });
    const people: { identityId: string; nativeId: string }[] = [];
    for (const identityId of wanted as string[]) {
      const n = this.d.store.nativeOf('identity', identityId);
      if (!n) throw new AboutError('Nobody by that id', 404);
      if (n.network !== t.network) throw new AboutError(`Only ${net} people can be added to a ${net} group`, 400);
      if (identityId === acc.self_identity) throw new AboutError('That is this account', 400);
      // Left out of the candidates on purpose.
      if (this.d.store.isSelf(identityId)) throw new AboutError('That is one of your own accounts', 400);
      people.push({ identityId, nativeId: n.nativeId });
    }
    if (!caps(this.d.store, accountId).includes('addMembers')) throw new AboutError(addMembersNotBuilt(t.network), 409);
    if (!this.d.online(accountId)) throw new AboutError(`${net} · ${acc.label} is not connected`, 409);
    const target = { kind: 'conversation' as const, nativeId: t.nativeId };
    // Never on a stale answer: who may add, and how many fit, can have changed since the panel opened.
    const fresh = await this.d.command<P.About>(accountId, { t: 'about', target }, 30_000).catch((e: Error) => {
      throw new AboutError(`Could not ask ${net}: ${e.message}`, 502);
    });
    this.keep(id, accountId, fresh);
    const adding = fresh.adding;
    if (!adding?.can) throw new AboutError(adding?.reason ?? 'You cannot add people here.', 403);
    const inIt = new Set((fresh.members?.list ?? []).map((m) => m.id));
    const todo = people.filter((p) => !inIt.has(p.nativeId));
    if (!todo.length) throw new AboutError(people.length === 1 ? 'They are in it already' : 'They are all in it already', 409);
    if (adding.room !== undefined && todo.length > adding.room) throw new AboutError(adding.room ? `Only ${adding.room} more fit here` : 'There is no room for anyone else', 409);
    // One slot each, all or none.
    const db = this.d.store.db;
    const at = this.d.now?.() ?? Date.now();
    let taken = 0;
    for (; taken < todo.length; taken++) {
      const p = takePace(db, acc, 'members', at);
      if (!p.ok) {
        for (let i = 0; i < taken; i++) givePace(db, acc.id, 'members', at);
        throw new AboutError(taken ? `${p.error} (${taken} of the ${todo.length} would fit)` : p.error, 429);
      }
    }
    let r: P.AddMembersResult;
    try {
      r = (await this.d.command<P.AddMembersResult>(accountId, { t: 'addMembers', target, people: todo.map((p) => p.nativeId) }, ADD_MEMBERS_TIMEOUT)) ?? { added: [] };
    } catch (e) {
      const msg = String((e as Error)?.message ?? e);
      if (/timed out/i.test(msg)) throw new AboutError(`${net} did not answer in ${ADD_MEMBERS_TIMEOUT / 1000} seconds. It may still have gone through: look again in a minute.`, 504);
      // Refused before anything went out (the adapter's own check): the slots are given back.
      if (!/disconnected|not connected/i.test(msg)) for (let i = 0; i < taken; i++) givePace(db, acc.id, 'members', at);
      throw new AboutError(msg, 502);
    }
    const byNative = new Map(todo.map((p) => [p.nativeId, p.identityId]));
    const ids = (xs: unknown) => (Array.isArray(xs) ? xs : []).map((x) => byNative.get(String(x))).filter((x): x is string => !!x);
    const added = ids(r.added);
    const invited = ids(r.invited);
    const failed = (Array.isArray(r.failed) ? r.failed : [])
      .map((f) => ({ identityId: byNative.get(String(f?.id)) ?? '', reason: typeof f?.reason === 'string' && f.reason ? f.reason.slice(0, 300) : `${net} refused` }))
      .filter((f) => f.identityId);
    const names = (xs: string[]) => this.d.store.identitiesByIds(xs).map((i) => i.handle ?? i.displayName ?? i.nativeId).join(', ');
    this.d.note?.(
      accountId,
      `[add] ${[added.length && `added ${names(added)}`, invited.length && `invited ${names(invited)}`, failed.length && `could not add ${names(failed.map((f) => f.identityId))}`].filter(Boolean).join('; ') || 'added nobody'} (${group})`,
    );
    let about: P.AboutView | null = null;
    if (r.about && typeof r.about === 'object' && 'fields' in r.about) {
      this.keep(id, accountId, r.about);
      about = this.view('conversation', id, t.network, accountId, r.about, Date.now(), undefined, caps(this.d.store, accountId).includes('configure'));
    }
    return { accountId, added, invited, failed, about };
  }

  private keep(targetId: string, accountId: string, about: P.About) {
    // Settings that changed since this account last said (docs/history.md). Name, description and picture come with
    // the conversation itself and are logged there.
    const prev = this.kept(targetId, accountId);
    if (prev && prev.accountId === accountId) {
      const kind = this.d.store.one<{ n: number }>('SELECT 1 AS n FROM space WHERE id = ?', targetId) ? 'space' : 'conversation';
      for (const [k, f] of Object.entries(about.fields) as [P.AboutKey, P.AboutSetting][]) {
        if (k === 'name' || k === 'topic' || k === 'avatar' || f.value === null) continue;
        const was = prev.about.fields[k]?.value;
        if (was === undefined || was === null || JSON.stringify(was) === JSON.stringify(f.value)) continue;
        this.d.store.logChange(kind, targetId, k, String(was), String(f.value), accountId);
      }
    }
    this.d.store.db
      .query('INSERT INTO about (target_id, account_id, data, fetched_at) VALUES (?, ?, ?, ?) ON CONFLICT (target_id, account_id) DO UPDATE SET data = excluded.data, fetched_at = excluded.fetched_at')
      .run(targetId, accountId, JSON.stringify(about), Date.now());
  }

  private kept(targetId: string, accountId: string | null): { about: P.About; at: number; accountId: string } | null {
    const r = this.d.store.one<{ data: string; fetched_at: number; account_id: string }>(
      'SELECT data, fetched_at, account_id FROM about WHERE target_id = ? ORDER BY (account_id = ?) DESC, fetched_at DESC LIMIT 1',
      targetId,
      accountId ?? '',
    );
    if (!r) return null;
    try {
      return { about: JSON.parse(r.data), at: r.fetched_at, accountId: r.account_id };
    } catch {
      return null;
    }
  }

  /** Nothing editable: the last answer kept, else the name, topic, picture and members the hub stores. */
  private fallback(kind: Kind, id: string, network: P.Network, accountId: string | null, stale: string): P.AboutView {
    const k = this.kept(id, accountId);
    if (k) return this.view(kind, id, network, k.accountId, readOnly(k.about, stale), k.at, stale, false);
    const s = this.d.store;
    const row =
      kind === 'conversation'
        ? s.one<{ name: string | null; topic: string | null; avatar_url: string | null; encrypted: number }>('SELECT name, topic, avatar_url, encrypted FROM conversation WHERE id = ?', id)
        : s.one<{ name: string | null; topic: string | null; avatar_url: string | null; encrypted: number }>('SELECT name, topic, icon_url AS avatar_url, 0 AS encrypted FROM space WHERE id = ?', id);
    const fields: P.AboutFields = {};
    const no = { canEdit: false, reason: stale };
    if (row?.name) fields.name = { value: row.name, ...no };
    if (row?.topic) fields.topic = { value: row.topic, ...no };
    if (row?.avatar_url) fields.avatar = { value: row.avatar_url, ...no };
    if (row?.encrypted) fields.encrypted = { value: true, ...no };
    const parts = kind === 'conversation' ? (s.db.query('SELECT i.native_id FROM participant p JOIN identity i ON i.id = p.identity_id WHERE p.conversation_id = ?').all(id) as { native_id: string }[]) : [];
    const about: P.About = { fields, ...(parts.length ? { members: { list: parts.map((p) => ({ id: p.native_id })), complete: true } } : {}) };
    return this.view(kind, id, network, accountId, about, Date.now(), stale, false);
  }

  /** Native ids to hub ids, media to signed paths, pins to the messages the hub has. */
  view(kind: Kind, id: string, network: P.Network, accountId: string | null, about: P.About, fetchedAt: number, stale: string | undefined, configurable: boolean): P.AboutView {
    const s = this.d.store;
    const acc = accountId ? s.account(accountId) : null;
    const fields: P.AboutFields = { ...about.fields };
    if (fields.avatar?.value) fields.avatar = { ...fields.avatar, value: s.mediaUrl(fields.avatar.value, accountId) ?? '' };
    const members = about.members && {
      list: about.members.list.map((m) => ({
        identityId: acc ? s.ensureIdentity(acc, m.id) : hubId('idn', network, m.id),
        ...(m.role ? { role: m.role } : {}),
        ...(m.rank !== undefined ? { rank: m.rank } : {}),
        ...(m.color ? { color: m.color } : {}),
      })),
      total: about.members.total,
      complete: about.members.complete,
    };
    let pinned: P.AboutView['pinned'];
    if (about.pinned) {
      const ids = about.pinned.messages.map((n) => hubId('msg', network, n));
      // Pins the hub saw that a network without a readable list could not name (polls.ts sits beside: docs/polls.md).
      if (!about.pinned.complete && kind === 'conversation') for (const m of pinnedSeen(s, id)) if (!ids.includes(m)) ids.push(m);
      const found = ids.map((m) => s.messageView(m)).filter((m): m is P.MessageView => !!m && !m.deleted);
      pinned = { messages: found, missing: ids.length - found.length, canEdit: about.pinned.canEdit, ...(about.pinned.reason ? { reason: about.pinned.reason } : {}) };
    }
    const coverage = kind === 'space' && s.one<{ n: number }>(`SELECT 1 AS n FROM space WHERE id = ? AND kind = 'community'`, id) ? s.memberCoverage(id) : undefined;
    const adding = addingOf(s, kind, id, network, accountId, about.adding, stale);
    const canConfigure =
      configurable && !stale && (Object.values(fields).some((f) => f?.canEdit) || !!about.invite?.canCreate || !!about.invite?.canRevoke || !!about.pinned?.canEdit || !!about.nick?.canEdit);
    return {
      ...about,
      fields,
      members,
      identities: s.identitiesByIds(members?.list.map((m) => m.identityId) ?? []),
      pinned,
      // A group's owner in hub ids, as the members are (threads.ts AboutOwnership).
      ...(about.ownership ? { ownership: { ...about.ownership, ...(about.ownership.owner ? { owner: acc ? s.ensureIdentity(acc, about.ownership.owner) : hubId('idn', network, about.ownership.owner) } : {}) } } : {}),
      ...(adding ? { adding } : { adding: undefined }),
      ...(coverage ? { coverage } : {}),
      target: { kind, id },
      network,
      accountId,
      fetchedAt,
      ...(stale ? { stale } : {}),
      canConfigure,
    };
  }
}

/**
 * Whom this account could put in a group on its network (adding people, making a group): its friends where the network
 * takes only friends, else its contacts and the people it has a direct conversation with, else also everyone in its
 * other groups. People it talked with lately first, at most CANDIDATES_MAX; nobody in `inIt`, nobody whose request
 * still waits on you (adding them would answer it), and never the account itself or a bot.
 */
export function candidatePool(store: Store, accountId: string, network: P.Network, who: P.AddWho, inIt: ReadonlySet<string> = new Set()): Pick<P.MemberCandidatesView, 'candidates' | 'identities'> {
  const db = store.db;
  addTables(db);
  const acc = store.account(accountId)!;
  const links = new Map((db.query(`SELECT identity_id, relationship FROM person_link WHERE account_id = ? AND relationship IN ('friend', 'contact')`).all(accountId) as { identity_id: string; relationship: P.PersonRelationship }[]).map((r) => [r.identity_id, r.relationship]));
  // When this account last had a message with each person in a direct conversation.
  const talked = new Map(
    (
      db
        .query(
          `SELECT p.identity_id AS id, MAX(c.last_message_at) AS at FROM vantage v JOIN conversation c ON c.id = v.target_id AND c.shape = 'direct'
           JOIN participant p ON p.conversation_id = c.id WHERE v.account_id = ? AND v.target_kind = 'conversation' GROUP BY p.identity_id`,
        )
        .all(accountId) as { id: string; at: number | null }[]
    ).map((r) => [r.id, r.at ?? 0]),
  );
  const pool = new Set<string>(who === 'friends' ? [...links].filter(([, r]) => r === 'friend').map(([i]) => i) : [...links.keys(), ...talked.keys()]);
  if (who === 'known')
    for (const r of db
      .query(`SELECT DISTINCT p.identity_id AS id FROM vantage v JOIN conversation c ON c.id = v.target_id AND c.shape = 'group' JOIN participant p ON p.conversation_id = c.id WHERE v.account_id = ? AND v.target_kind = 'conversation'`)
      .all(accountId) as { id: string }[])
      pool.add(r.id);
  const asking = new Set((db.query('SELECT from_id FROM add_request WHERE account_id = ? AND from_id IS NOT NULL').all(accountId) as { from_id: string }[]).map((r) => r.from_id));
  const ids = [...pool].filter((i) => !inIt.has(i) && !asking.has(i) && i !== acc.self_identity && !store.isSelf(i));
  const rows = store.identitiesByIds(ids).filter((i) => i.network === network && !i.isBot);
  const name = (i: P.IdentityView) => (i.personId ? store.one<{ name: string }>('SELECT name FROM person WHERE id = ?', i.personId)?.name : null) ?? i.nickname ?? i.displayName ?? i.handle ?? i.nativeId;
  const named = rows.map((i) => ({ i, at: talked.get(i.id) ?? 0, name: name(i).toLocaleLowerCase() }));
  named.sort((a, b) => b.at - a.at || a.name.localeCompare(b.name));
  const shown = named.slice(0, CANDIDATES_MAX);
  return {
    candidates: shown.map(({ i, at }) => ({ identityId: i.id, ...(links.get(i.id) ? { relationship: links.get(i.id) } : {}), ...(at ? { lastTalked: at } : {}) })),
    identities: shown.map((x) => x.i),
  };
}

/** Why this account may not make this change, by the About it just gave; null if it may. */
export function refusalOf(about: P.About, change: P.AboutChange): string | null {
  if (change.key === 'invite') {
    const inv = about.invite;
    const may = change.op === 'create' ? inv?.canCreate : inv?.canRevoke;
    return may ? null : (inv?.reason ?? 'You cannot change the invite link here.');
  }
  if (change.key === 'pin') return about.pinned?.canEdit ? null : (about.pinned?.reason ?? 'You cannot pin messages here.');
  const f = about.fields[change.key];
  if (!f) return `${ABOUT_LABEL[change.key]} is not a setting here.`;
  return f.canEdit ? null : (f.reason ?? `You cannot change ${ABOUT_LABEL[change.key].toLowerCase()} here.`);
}

/** The same About with nothing editable, saying why. */
export function readOnly(about: P.About, reason: string): P.About {
  const fields: P.AboutFields = {};
  for (const [k, f] of Object.entries(about.fields) as [P.AboutKey, P.AboutSetting][]) (fields as Record<string, P.AboutSetting>)[k] = { ...f, canEdit: false, reason };
  return {
    ...about,
    fields,
    ...(about.invite ? { invite: { ...about.invite, canCreate: false, canRevoke: false, reason } } : {}),
    ...(about.pinned ? { pinned: { ...about.pinned, canEdit: false, reason } } : {}),
    ...(about.adding ? { adding: { ...about.adding, can: false, reason } } : {}),
    ...(about.leaving ? { leaving: { ...about.leaving, can: false, reason } } : {}),
    ...(about.nick ? { nick: { ...about.nick, canEdit: false, reason } } : {}),
  };
}

/**
 * Adding people, as this view may offer it: what the adapter said, locked while stale or when the account cannot
 * (an adapter without 'addMembers'); for a group whose adapter says nothing, why not, so the panel never offers a
 * button nothing is behind and never leaves the reader guessing.
 */
function addingOf(s: Store, kind: Kind, id: string, network: P.Network, accountId: string | null, adding: P.AboutAdding | undefined, stale: string | undefined): P.AboutAdding | undefined {
  const able = !!accountId && caps(s, accountId).includes('addMembers');
  if (adding && typeof adding === 'object') {
    const a: P.AboutAdding = { can: !!adding.can, who: adding.who ?? 'known', mode: adding.mode === 'invite' ? 'invite' : 'add', ...(typeof adding.reason === 'string' ? { reason: adding.reason } : {}), ...(typeof adding.room === 'number' ? { room: adding.room } : {}) };
    if (stale) return { ...a, can: false, reason: stale };
    if (!able) return { ...a, can: false, reason: addMembersNotBuilt(network) };
    return a;
  }
  if (able || kind !== 'conversation') return undefined;
  const group = s.one<{ shape: string }>('SELECT shape FROM conversation WHERE id = ?', id)?.shape === 'group';
  return group ? { can: false, reason: addMembersNotBuilt(network), who: 'known', mode: 'add' } : undefined;
}

/** Messages of a conversation the hub last saw pinned (their latest pin or unpin event is a pin), newest pin first. */
export function pinnedSeen(s: { db: { query(sql: string): { all(...a: unknown[]): unknown[] } } }, conversationId: string): string[] {
  const rows = s.db
    .query(
      `SELECT e.message_id, MAX(e.at) AS at, (SELECT e2.kind FROM message_event e2 WHERE e2.message_id = e.message_id AND e2.kind IN ('pin', 'unpin') ORDER BY e2.at DESC, e2.rowid DESC LIMIT 1) AS last
       FROM message_event e JOIN message m ON m.id = e.message_id
       WHERE m.conversation_id = ? AND e.kind IN ('pin', 'unpin') GROUP BY e.message_id ORDER BY at DESC LIMIT 50`,
    )
    .all(conversationId) as { message_id: string; last: string }[];
  return rows.filter((r) => r.last === 'pin').map((r) => r.message_id);
}
