/**
 * About and settings (docs/group-settings.md): asks the adapter for a conversation's or space's About, keeps the
 * answer, turns it into hub ids, and passes a change on only when the network's rules and a fresh About say this
 * account may make it.
 */
import type * as P from '@dither-chat/protocol';
import { ABOUT_LABEL, aboutChangeProblem, NETWORK_META } from '@dither-chat/protocol';
import { hubId } from '@dither-chat/protocol/ids';
import type { Store } from './store.ts';

export interface AboutDeps {
  store: Store;
  online: (accountId: string) => boolean;
  command: <T>(accountId: string, cmd: { t: 'about'; target: P.AboutTarget } | { t: 'configure'; target: P.AboutTarget; change: P.AboutChange }, timeoutMs?: number) => Promise<T>;
  /** Which account speaks for a conversation (the one that would send), honouring a request. */
  pickAccount: (conversationId: string, requested?: string) => string | null;
}

type Kind = P.AboutTarget['kind'];

export class AboutError extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message);
  }
}

const caps = (store: Store, accountId: string): P.Capability[] => JSON.parse(store.account(accountId)?.capabilities ?? '[]');

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
      const found = about.pinned.messages.map((n) => s.messageView(hubId('msg', network, n))).filter((m): m is P.MessageView => !!m && !m.deleted);
      pinned = { messages: found, missing: about.pinned.messages.length - found.length, canEdit: about.pinned.canEdit, ...(about.pinned.reason ? { reason: about.pinned.reason } : {}) };
    }
    const coverage = kind === 'space' && s.one<{ n: number }>(`SELECT 1 AS n FROM space WHERE id = ? AND kind = 'community'`, id) ? s.memberCoverage(id) : undefined;
    const canConfigure =
      configurable && !stale && (Object.values(fields).some((f) => f?.canEdit) || !!about.invite?.canCreate || !!about.invite?.canRevoke || !!about.pinned?.canEdit);
    return {
      ...about,
      fields,
      members,
      identities: s.identitiesByIds(members?.list.map((m) => m.identityId) ?? []),
      pinned,
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
  };
}
