/**
 * What the networks say about a person (docs/profile.md): asks one adapter for one identity's profile (the `profile`
 * command), keeps the answer, and turns it into hub ids. Asked only when someone opens a profile; the last answer
 * shows at once while a fresh one comes.
 */
import type * as P from '@dither-chat/protocol';
import { BIO_LIMIT, bioLength, NETWORK_META } from '@dither-chat/protocol';
import { hubId } from '@dither-chat/protocol/ids';
import { linkOf } from './add.ts';
import { postAuthors, postView } from './feed.ts';
import type { Store } from './store.ts';

type Row = Record<string, any>;

export interface PeopleDeps {
  store: Store;
  online: (accountId: string) => boolean;
  command: <T>(accountId: string, cmd: { t: 'profile'; who: string } | { t: 'setProfile'; change: { bio?: string } }, timeoutMs?: number) => Promise<T>;
}

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
    const s = this.d.store;
    const n = s.nativeOf('identity', identityId);
    if (!n) throw Object.assign(new Error('no such identity'), { status: 404 });
    const net = NETWORK_META[n.network].name;
    const acc = s.one<Row>('SELECT id, label FROM account WHERE self_identity = ?', identityId);
    if (!acc) throw Object.assign(new Error('Only your own profile can be changed.'), { status: 403 });
    if (!caps(s, acc.id).includes('editProfile')) throw Object.assign(new Error(`Your bio on ${net} cannot be changed from here.`), { status: 409 });
    if (!this.d.online(acc.id)) throw Object.assign(new Error(`${net} · ${acc.label} is not connected.`), { status: 409 });
    const limit = BIO_LIMIT[n.network];
    const len = bioLength(bio);
    if (limit !== undefined && len > limit) throw Object.assign(new Error(`Too long for ${net}: ${len} characters, and it takes ${limit}.`), { status: 400 });
    let about: P.PersonAbout;
    try {
      about = (await this.d.command<P.PersonAbout>(acc.id, { t: 'setProfile', change: { bio } }, 20_000)) ?? {};
    } catch (e) {
      throw Object.assign(new Error(`${net} did not take it: ${(e as Error).message}`), { status: 502 });
    }
    // What the network has now, as if the profile had been asked again.
    const k = this.keptOne(identityId);
    const { unasked: _, ...was } = k?.about ?? {};
    const now = { ...was, ...about, bio: about.bio ?? bio };
    this.keep(identityId, acc.id, n.network, now);
    s.dirty.identities.add(identityId);
    return this.view(identityId, acc.id, now, Date.now(), undefined);
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
    const { avatar, banner, mutualSpaces, mutualFriends, friends, posts, ...rest } = a;
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
