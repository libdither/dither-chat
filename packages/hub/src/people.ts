/**
 * What the networks say about a person (docs/profile.md): asks one adapter for one identity's profile (the `profile`
 * command), keeps the answer, and turns it into hub ids. Asked only when someone opens a profile; the last answer
 * shows at once while a fresh one comes.
 */
import type * as P from '@dither-chat/protocol';
import { BIO_LIMIT, bioLength, NETWORK_META } from '@dither-chat/protocol';
import { hubId } from '@dither-chat/protocol/ids';
import { linkOf, setLink } from './add.ts';
import { postAuthors, postView } from './feed.ts';
import type { Store } from './store.ts';

type Row = Record<string, any>;

export interface PeopleDeps {
  store: Store;
  online: (accountId: string) => boolean;
  command: <T>(accountId: string, cmd: PeopleCommand, timeoutMs?: number) => Promise<T>;
  /** A line in the account's log (supervisor note), for changes made on the owner's click. */
  note?: (accountId: string, line: string) => void;
}

type PeopleCommand =
  | { t: 'profile'; who: string }
  | { t: 'setProfile'; change: P.ProfileChange }
  | { t: 'verify'; who: string; safetyNumber?: string; clear?: true }
  | { t: 'block'; target: { kind: 'identity' | 'conversation'; nativeId: string }; unblock?: true }
  | { t: 'setContact'; who: string; nickname?: string; note?: string };

/** An error with the HTTP status the route answers with. */
const fail = (message: string, status: number) => Object.assign(new Error(message), { status });

const caps = (store: Store, accountId: string): P.Capability[] => JSON.parse(store.account(accountId)?.capabilities ?? '[]');

/**
 * Networks whose About is what their customStatus events carry (the text, and Signal's emoji): a profile's bio there
 * is the person's status, not a separate field.
 */
const ABOUT_IS_STATUS = new Set<P.Network>(['signal', 'whatsapp']);

/** A fresh answer this recent is not asked again. */
const FRESH_MS = 10 * 60_000;

export class People {
  /** Asks in flight, so two tabs opening one profile ask once. */
  private asking = new Map<string, Promise<P.PersonAboutView>>();

  constructor(private d: PeopleDeps) {}

  /**
   * Which account asks about someone: yours, if it is you; else one that shares a conversation with them, connected
   * and able to; else any connected account on their network.
   */
  accountFor(identityId: string): string | null {
    const s = this.d.store;
    const n = s.nativeOf('identity', identityId);
    if (!n) return null;
    const usable = (a: string) => this.d.online(a) && caps(s, a).includes('profile');
    const own = s.one<Row>('SELECT id FROM account WHERE self_identity = ?', identityId);
    if (own) return own.id;
    const shared = (
      s.db
        .query(
          `SELECT v.account_id AS id, COUNT(*) AS n FROM participant p JOIN vantage v ON v.target_kind = 'conversation' AND v.target_id = p.conversation_id
           WHERE p.identity_id = ? GROUP BY v.account_id ORDER BY n DESC`,
        )
        .all(identityId) as Row[]
    ).map((r) => r.id as string);
    const all = (s.db.query('SELECT id FROM account WHERE network = ?').all(n.network) as Row[]).map((r) => r.id as string);
    return shared.find(usable) ?? all.find(usable) ?? shared[0] ?? all[0] ?? null;
  }

  /** The last answers kept for these identities, newest first, for the profile's first paint. */
  kept(identityIds: string[]): P.PersonAboutView[] {
    const out: P.PersonAboutView[] = [];
    for (const id of identityIds) {
      const k = this.keptOne(id);
      if (k) out.push(this.view(id, k.accountId, k.about, k.at, undefined));
    }
    return out;
  }

  /** Fresh from the network, unless a fresh one is kept; else the last kept, saying why. */
  async get(identityId: string, force = false): Promise<P.PersonAboutView> {
    const live = this.asking.get(identityId);
    if (live) return live;
    const p = this.ask(identityId, force).finally(() => this.asking.delete(identityId));
    this.asking.set(identityId, p);
    return p;
  }

  private async ask(identityId: string, force: boolean): Promise<P.PersonAboutView> {
    const s = this.d.store;
    const n = s.nativeOf('identity', identityId);
    if (!n) throw new Error('no such identity');
    const accountId = this.accountFor(identityId);
    const k = this.keptOne(identityId);
    // What the network showed unasked (a `personAbout` event) is no answer: it has no posts, so the network is asked.
    if (!force && k && !k.about.unasked && Date.now() - k.at < FRESH_MS) return this.view(identityId, k.accountId, k.about, k.at, undefined);
    const net = NETWORK_META[n.network].name;
    const why = !accountId
      ? `None of your accounts is on ${net}.`
      : !this.d.online(accountId)
        ? `${net} · ${s.account(accountId)?.label} is not connected; this is what it said last.`
        : !caps(s, accountId).includes('profile')
          ? `The ${net} adapter cannot read profiles yet.`
          : null;
    if (accountId && !why) {
      try {
        const about = await this.d.command<P.PersonAbout>(accountId, { t: 'profile', who: n.nativeId }, 20_000);
        this.keep(identityId, accountId, n.network, about);
        return this.view(identityId, accountId, about ?? {}, Date.now(), undefined);
      } catch (e) {
        const stale = `Could not ask ${net}: ${(e as Error).message}`;
        return k ? this.view(identityId, k.accountId, k.about, k.at, stale) : this.view(identityId, accountId, {}, Date.now(), stale);
      }
    }
    return k ? this.view(identityId, k.accountId, k.about, k.at, why!) : this.view(identityId, accountId, {}, Date.now(), why!);
  }

  /**
   * Change your own bio on one network (capability 'editProfile'). Only an account's own identity, through that
   * account; the network's limit is checked here first. Throws with an HTTP status for the route.
   */
  async setBio(identityId: string, bio: string): Promise<P.PersonAboutView> {
    return this.setOwn(identityId, { bio });
  }

  /**
   * Change your own profile on one network: the bio, and where the adapter's last answer listed them as `editable`,
   * the name, the emoji, the picture (a file in the spool, or null) and the username. Throws with an HTTP status.
   */
  async setOwn(identityId: string, change: P.ProfileChange): Promise<P.PersonAboutView> {
    const s = this.d.store;
    const n = s.nativeOf('identity', identityId);
    if (!n) throw fail('no such identity', 404);
    const net = NETWORK_META[n.network].name;
    const acc = s.one<Row>('SELECT id, label FROM account WHERE self_identity = ?', identityId);
    if (!acc) throw fail('Only your own profile can be changed.', 403);
    if (!caps(s, acc.id).includes('editProfile')) throw fail(`Your profile on ${net} cannot be changed from here.`, 409);
    if (!this.d.online(acc.id)) throw fail(`${net} · ${acc.label} is not connected.`, 409);
    const fields = (Object.keys(change) as P.ProfileField[]).filter((k) => change[k] !== undefined);
    if (!fields.length) throw fail('Nothing to change.', 400);
    const editable = this.keptOne(identityId)?.about.editable ?? ['bio'];
    const extra = fields.find((f) => f !== 'bio' && !editable.includes(f));
    if (extra) throw fail(`Your ${extra} on ${net} cannot be changed from here.`, 409);
    if (change.bio !== undefined) {
      const limit = BIO_LIMIT[n.network];
      const len = bioLength(change.bio);
      if (limit !== undefined && len > limit) throw fail(`Too long for ${net}: ${len} characters, and it takes ${limit}.`, 400);
    }
    let about: P.PersonAbout;
    try {
      about = (await this.d.command<P.PersonAbout>(acc.id, { t: 'setProfile', change }, 60_000)) ?? {};
    } catch (e) {
      throw fail(`${net} did not take it: ${(e as Error).message}`, 502);
    }
    // What the network has now, as if the profile had been asked again.
    const k = this.keptOne(identityId);
    const { unasked: _, ...was } = k?.about ?? {};
    const now = { ...was, ...about, ...(change.bio !== undefined ? { bio: about.bio ?? change.bio } : {}) };
    if (change.username === null && !about.username) delete now.username;
    this.keep(identityId, acc.id, n.network, now);
    s.dirty.identities.add(identityId);
    return this.view(identityId, acc.id, now, Date.now(), undefined);
  }

  /** An account that can do `cap` for someone: one sharing a chat with them first, connected. Throws with a status. */
  private ableFor(identityId: string, cap: P.Capability, what: string): { id: string; label: string; native: string; network: P.Network } {
    const s = this.d.store;
    const n = s.nativeOf('identity', identityId);
    if (!n) throw fail('no such identity', 404);
    if (s.one<Row>('SELECT id FROM account WHERE self_identity = ?', identityId)) throw fail('That is one of your own accounts', 400);
    const net = NETWORK_META[n.network].name;
    const all = (s.db.query('SELECT id FROM account WHERE network = ?').all(n.network) as Row[]).map((r) => r.id as string).filter((a) => caps(s, a).includes(cap));
    if (!all.length) throw fail(`${what} on ${net} isn't built for your accounts there yet`, 409);
    const shared = (
      s.db
        .query(
          `SELECT DISTINCT v.account_id AS id FROM participant p JOIN vantage v ON v.target_kind = 'conversation' AND v.target_id = p.conversation_id WHERE p.identity_id = ?`,
        )
        .all(identityId) as Row[]
    ).map((r) => r.id as string);
    const id = [...shared.filter((a) => all.includes(a)), ...all].find((a) => this.d.online(a));
    if (!id) throw fail(`${net} · ${s.account(all[0])?.label} is not connected`, 409);
    return { id, label: s.account(id)!.label, native: n.nativeId, network: n.network };
  }

  /**
   * Mark your safety number with someone verified (the digits the owner compared) or clear the mark (capability
   * 'safetyNumbers'). The answer is their profile, kept as a fresh one.
   */
  async verify(identityId: string, b: { safetyNumber?: unknown; clear?: unknown }): Promise<P.PersonAboutView> {
    const acc = this.ableFor(identityId, 'safetyNumbers', 'Safety numbers');
    const clear = b.clear === true;
    if (!clear && typeof b.safetyNumber !== 'string') throw fail('safetyNumber: the digits you compared', 400);
    let about: P.PersonAbout;
    try {
      about = (await this.d.command<P.PersonAbout>(acc.id, { t: 'verify', who: acc.native, ...(clear ? { clear: true as const } : { safetyNumber: b.safetyNumber as string }) }, 60_000)) ?? {};
    } catch (e) {
      throw fail((e as Error).message, 409);
    }
    this.d.note?.(acc.id, `[people] ${clear ? 'cleared the verified mark of' : 'verified'} a safety number`);
    this.keep(identityId, acc.id, acc.network, about);
    return this.view(identityId, acc.id, about, Date.now(), undefined);
  }

  /** Block or unblock someone (capability 'block'), on the owner's click. Their account's list says so at once. */
  async block(identityId: string, unblock: boolean): Promise<{ blocked: boolean; accountId: string }> {
    const acc = this.ableFor(identityId, 'block', unblock ? 'Unblocking' : 'Blocking');
    let r: { blocked?: boolean } | null;
    try {
      r = await this.d.command<{ blocked?: boolean }>(acc.id, { t: 'block', target: { kind: 'identity', nativeId: acc.native }, ...(unblock ? { unblock: true as const } : {}) }, 60_000);
    } catch (e) {
      throw fail((e as Error).message, 409);
    }
    const blocked = typeof r?.blocked === 'boolean' ? r.blocked : !unblock;
    const s = this.d.store;
    this.d.note?.(acc.id, `[people] ${blocked ? 'blocked' : 'unblocked'} someone`);
    // Their relationship event says the same soon after; an unblocked contact comes back as one then.
    if (caps(s, acc.id).includes('relationships')) setLink(s, acc.id, identityId, blocked ? 'blocked' : linkOf(s.db, acc.id, identityId) === 'blocked' ? 'stranger' : null);
    s.db.query(`UPDATE about SET data = json_set(data, '$.relationship', ?) WHERE target_id = ? AND account_id = ?`).run(blocked ? 'blocked' : 'stranger', identityId, acc.id);
    s.dirty.identities.add(identityId);
    return { blocked, accountId: acc.id };
  }

  /** Block or unblock a group (capability 'block'), through an account in it. */
  async blockConversation(conversationId: string, unblock: boolean): Promise<{ blocked: boolean; accountId: string }> {
    const s = this.d.store;
    const n = s.nativeOf('conversation', conversationId);
    if (!n) throw fail('no such conversation', 404);
    const net = NETWORK_META[n.network].name;
    const ids = (s.db.query(`SELECT account_id FROM vantage WHERE target_kind = 'conversation' AND target_id = ?`).all(conversationId) as Row[]).map((r) => r.account_id as string).filter((a) => caps(s, a).includes('block'));
    if (!ids.length) throw fail(`Blocking groups on ${net} isn't built for your accounts there yet`, 409);
    const id = ids.find((a) => this.d.online(a));
    if (!id) throw fail(`${net} · ${s.account(ids[0])?.label} is not connected`, 409);
    let r: { blocked?: boolean } | null;
    try {
      r = await this.d.command<{ blocked?: boolean }>(id, { t: 'block', target: { kind: 'conversation', nativeId: n.nativeId }, ...(unblock ? { unblock: true as const } : {}) }, 60_000);
    } catch (e) {
      throw fail((e as Error).message, 409);
    }
    const blocked = typeof r?.blocked === 'boolean' ? r.blocked : !unblock;
    this.d.note?.(id, `[people] ${blocked ? 'blocked' : 'unblocked'} a group`);
    return { blocked, accountId: id };
  }

  /**
   * Your nickname or note for someone, kept on their network too (capability 'contactNotes'): through each connected
   * account on that network that can. Best effort, after the change is saved here; a failure is a log line.
   */
  pushContactNotes(identityId: string, change: { nickname?: string; note?: string }) {
    const s = this.d.store;
    const n = s.nativeOf('identity', identityId);
    if (!n || s.isSelf(identityId)) return;
    const ids = (s.db.query('SELECT id FROM account WHERE network = ?').all(n.network) as Row[]).map((r) => r.id as string).filter((a) => caps(s, a).includes('contactNotes') && this.d.online(a));
    for (const id of ids) {
      this.d
        .command(id, { t: 'setContact', who: n.nativeId, ...change }, 60_000)
        .then(() => this.d.note?.(id, `[people] kept your ${change.nickname !== undefined ? 'nickname' : 'note'} for someone on ${NETWORK_META[n.network].name} too`))
        .catch((e) => this.d.note?.(id, `[people] could not keep your ${change.nickname !== undefined ? 'nickname' : 'note'} on ${NETWORK_META[n.network].name}: ${(e as Error).message}`));
    }
  }

  /** A person's note changed here: to each of their accounts on a network that keeps notes. */
  pushPersonNote(personId: string, note: string) {
    const ids = (this.d.store.db.query('SELECT id FROM identity WHERE person_id = ?').all(personId) as Row[]).map((r) => r.id as string);
    for (const id of ids) this.pushContactNotes(id, { note });
  }

  /** An answer from the network: what changed since the last one, the status it carries, and the answer kept. */
  private keep(identityId: string, accountId: string, network: P.Network, about: P.PersonAbout | null | undefined) {
    if (about) keepAbout(this.d.store, identityId, accountId, network, about, Date.now());
    else
      this.d.store.db
        .query('INSERT INTO about (target_id, account_id, data, fetched_at) VALUES (?, ?, ?, ?) ON CONFLICT (target_id, account_id) DO UPDATE SET data = excluded.data, fetched_at = excluded.fetched_at')
        .run(identityId, accountId, '{}', Date.now());
  }

  private keptOne(identityId: string): { about: Kept; at: number; accountId: string } | null {
    return keptAbout(this.d.store, identityId);
  }

  /** Native ids to hub ids, pictures to signed paths. */
  view(identityId: string, accountId: string | null, a: P.PersonAbout, fetchedAt: number, stale: string | undefined): P.PersonAboutView {
    const s = this.d.store;
    const network = s.nativeOf('identity', identityId)!.network;
    const acc = accountId ? s.account(accountId) : null;
    const ident = (native: string) => (acc ? s.ensureIdentity(acc, native) : hubId('idn', network, native));
    const { avatar, banner, mutualSpaces, mutualFriends, friends, decoration, badges, posts, ...rest } = a;
    const spaces = mutualSpaces?.map((m) => {
      const id = hubId('spc', network, m.id);
      const known = s.one<Row>('SELECT id FROM space WHERE id = ?', id);
      return { spaceId: known ? id : null, nativeId: m.id, ...(m.nick ? { nick: m.nick } : {}), ...(m.roles?.length ? { roles: m.roles } : {}), ...(m.joinedAt ? { joinedAt: m.joinedAt } : {}) };
    });
    const mf = mutualFriends?.map(ident);
    const fr = friends?.map(ident);
    // Their posts (X, docs/feed.md): authors as hub ids, pictures signed; whoever a repost or quote names comes along.
    const ps = posts?.map((p) => postView(p, network, (u) => s.mediaUrl(u, accountId)));
    const named = [...new Set((posts ?? []).flatMap((p) => postAuthors(p)))].map((n) => hubId('idn', network, n)).filter((id) => id !== identityId);
    // The account's own list says how you stand, when it has them on it (add.ts person_link); else the profile.
    const listed = accountId ? linkOf(s.db, accountId, identityId) : null;
    return {
      ...rest,
      ...(listed ? { relationship: listed } : {}),
      identityId,
      network,
      accountId,
      fetchedAt,
      ...(stale ? { stale } : {}),
      ...(avatar ? { avatar: s.mediaUrl(avatar, accountId) } : {}),
      ...(banner ? { banner: s.mediaUrl(banner, accountId) } : {}),
      ...(decoration ? { decoration: s.mediaUrl(decoration, accountId) ?? undefined } : {}),
      ...(badges?.length ? { badges: badges.map((b) => ({ name: b.name, ...(b.icon ? { icon: s.mediaUrl(b.icon, accountId) ?? undefined } : {}) })) } : {}),
      ...(spaces ? { mutualSpaces: spaces } : {}),
      ...(mf ? { mutualFriends: mf } : {}),
      ...(fr ? { friends: fr } : {}),
      ...(ps ? { posts: ps } : {}),
      identities: s.identitiesByIds([...(mf ?? []), ...(fr ?? []), ...named]),
    };
  }
}

/** A kept answer: what the network said, and whether it said it unasked (a `personAbout` event). */
type Kept = P.PersonAbout & { unasked?: true };

/** The newest answer kept for someone, from any account. */
export function keptAbout(store: Store, identityId: string): { about: Kept; at: number; accountId: string } | null {
  const r = store.one<Row>('SELECT data, fetched_at, account_id FROM about WHERE target_id = ? ORDER BY fetched_at DESC LIMIT 1', identityId);
  if (!r) return null;
  try {
    return { about: JSON.parse(r.data), at: r.fetched_at, accountId: r.account_id };
  } catch {
    return null;
  }
}

/**
 * Keep what a network said about someone (the `about` table): what changed since the last answer (docs/history.md),
 * the status it carries, and the answer. `unasked`: a `personAbout` event (X's notifications, docs/feed.md), seen at
 * `at`: kept unless an answer newer than that is held, with the posts of the last asked answer kept, and marked so
 * that opening the profile still asks the network. Returns whether it was kept.
 */
export function keepAbout(store: Store, identityId: string, accountId: string, network: P.Network, about: P.PersonAbout, at: number, unasked = false): boolean {
  const s = store;
  const k = keptAbout(s, identityId);
  if (unasked) {
    if (k && k.at >= at) return false;
    const { posts: _, ...seen } = about;
    about = { ...seen, ...(k?.about.posts ? { posts: k.about.posts } : {}), unasked: true } as Kept;
  }
  // What their profile said before, if it says something else now (docs/history.md).
  if (k)
    s.logChanges('identity', identityId, accountId, [
      // On Signal and WhatsApp the About is the status, logged as one below.
      ['bio', ABOUT_IS_STATUS.has(network) ? undefined : k.about.bio, ABOUT_IS_STATUS.has(network) ? undefined : (about.bio ?? '')],
      ['pronouns', k.about.pronouns, about.pronouns ?? ''],
      ['banner', k.about.banner, about.banner],
    ]);
  // The status as of now, the same as an adapter's customStatus says it.
  const st = ABOUT_IS_STATUS.has(network) ? { text: about.bio, emoji: about.status?.emoji } : 'status' in about ? (about.status ?? null) : undefined;
  if (st !== undefined) s.setStatus(identityId, st, accountId);
  s.db
    .query('INSERT INTO about (target_id, account_id, data, fetched_at) VALUES (?, ?, ?, ?) ON CONFLICT (target_id, account_id) DO UPDATE SET data = excluded.data, fetched_at = excluded.fetched_at')
    .run(identityId, accountId, JSON.stringify(about), at);
  return true;
}
