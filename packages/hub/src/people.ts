/**
 * What the networks say about a person (docs/profile.md): asks one adapter for one identity's profile (the `profile`
 * command), keeps the answer, and turns it into hub ids. Asked only when someone opens a profile; the last answer
 * shows at once while a fresh one comes.
 */
import type * as P from '@dither-chat/protocol';
import { NETWORK_META } from '@dither-chat/protocol';
import { hubId } from '@dither-chat/protocol/ids';
import type { Store } from './store.ts';

type Row = Record<string, any>;

export interface PeopleDeps {
  store: Store;
  online: (accountId: string) => boolean;
  command: <T>(accountId: string, cmd: { t: 'profile'; who: string }, timeoutMs?: number) => Promise<T>;
}

const caps = (store: Store, accountId: string): P.Capability[] => JSON.parse(store.account(accountId)?.capabilities ?? '[]');

const statusText = (st: P.PersonAbout['status']) => (st ? [st.emoji, st.text].filter(Boolean).join(' ') || undefined : undefined);

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
    if (!force && k && Date.now() - k.at < FRESH_MS) return this.view(identityId, k.accountId, k.about, k.at, undefined);
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
        // What their profile said before, if it says something else now (docs/history.md).
        if (k && about)
          s.logChanges('identity', identityId, accountId, [
            ['bio', k.about.bio, about.bio ?? ''],
            ['status', statusText(k.about.status), statusText(about.status) ?? ''],
            ['pronouns', k.about.pronouns, about.pronouns ?? ''],
            ['banner', k.about.banner, about.banner],
          ]);
        s.db
          .query('INSERT INTO about (target_id, account_id, data, fetched_at) VALUES (?, ?, ?, ?) ON CONFLICT (target_id, account_id) DO UPDATE SET data = excluded.data, fetched_at = excluded.fetched_at')
          .run(identityId, accountId, JSON.stringify(about ?? {}), Date.now());
        return this.view(identityId, accountId, about ?? {}, Date.now(), undefined);
      } catch (e) {
        const stale = `Could not ask ${net}: ${(e as Error).message}`;
        return k ? this.view(identityId, k.accountId, k.about, k.at, stale) : this.view(identityId, accountId, {}, Date.now(), stale);
      }
    }
    return k ? this.view(identityId, k.accountId, k.about, k.at, why!) : this.view(identityId, accountId, {}, Date.now(), why!);
  }

  private keptOne(identityId: string): { about: P.PersonAbout; at: number; accountId: string } | null {
    const r = this.d.store.one<Row>('SELECT data, fetched_at, account_id FROM about WHERE target_id = ? ORDER BY fetched_at DESC LIMIT 1', identityId);
    if (!r) return null;
    try {
      return { about: JSON.parse(r.data), at: r.fetched_at, accountId: r.account_id };
    } catch {
      return null;
    }
  }

  /** Native ids to hub ids, pictures to signed paths. */
  view(identityId: string, accountId: string | null, a: P.PersonAbout, fetchedAt: number, stale: string | undefined): P.PersonAboutView {
    const s = this.d.store;
    const network = s.nativeOf('identity', identityId)!.network;
    const acc = accountId ? s.account(accountId) : null;
    const ident = (native: string) => (acc ? s.ensureIdentity(acc, native) : hubId('idn', network, native));
    const { avatar, banner, mutualSpaces, mutualFriends, friends, ...rest } = a;
    const spaces = mutualSpaces?.map((m) => {
      const id = hubId('spc', network, m.id);
      const known = s.one<Row>('SELECT id FROM space WHERE id = ?', id);
      return { spaceId: known ? id : null, nativeId: m.id, ...(m.nick ? { nick: m.nick } : {}), ...(m.roles?.length ? { roles: m.roles } : {}), ...(m.joinedAt ? { joinedAt: m.joinedAt } : {}) };
    });
    const mf = mutualFriends?.map(ident);
    const fr = friends?.map(ident);
    return {
      ...rest,
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
      identities: s.identitiesByIds([...(mf ?? []), ...(fr ?? [])]),
    };
  }
}
