/**
 * Moderating (docs/moderation.md, protocol moderation.ts): removing, banning and unbanning, admins, roles and timeouts
 * on a group's or server's members, ending a group, your own member label, and deleting someone else's message or
 * clearing reactions as a moderator. Each passes on only what a fresh read says this account may do (the About for
 * members, the reaction context for messages), one at a time, from a click on the hub's own page; the adapter checks
 * again, and the network has the last word. Every one leaves a line in the account's log.
 */
import type * as P from '@dither-chat/protocol';
import { memberLabelProblem, modActionProblem, modRefusal, modVerb, NETWORK_META, reactionClearProblem, spanLabel, VOICE_MOD_OPS } from '@dither-chat/protocol';
import { hubId } from '@dither-chat/protocol/ids';
import type { AccountRow, Store } from './store.ts';

type Kind = P.AboutTarget['kind'];

type Cmd =
  | { t: 'about'; target: P.AboutTarget }
  | { t: 'moderate'; target: P.AboutTarget; action: P.ModAction }
  | { t: 'bans'; target: P.AboutTarget }
  | { t: 'setLabel'; conversation: string; text: string; emoji?: string }
  | { t: 'reactionContext'; conversation: string }
  | { t: 'redact'; conversation: string; message: string; moderator: true }
  | ({ t: 'clearReactions'; conversation: string; message: string } & P.ReactionClear);

export interface ModerationDeps {
  store: Store;
  online: (accountId: string) => boolean;
  command: <T>(accountId: string, cmd: Cmd, timeoutMs?: number) => Promise<T>;
  /** Which account speaks for a conversation, honouring a request. */
  pickAccount: (conversationId: string, requested?: string) => string | null;
  /** Keeps an About as the place page's and turns it into hub terms (about.ts Abouts). */
  keep: (kind: Kind, id: string, network: P.Network, accountId: string, about: P.About) => P.AboutView;
  note?: (accountId: string, line: string) => void;
  flush?: () => void;
  now?: () => number;
}

export class ModerationError extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message);
  }
}

/** At most this many moderating actions an hour, per account: each is one click, and nothing here is batch. */
export const MOD_PER_HOUR = 30;
const HOUR = 3_600_000;

export class Moderation {
  private recent = new Map<string, number[]>();
  constructor(private d: ModerationDeps) {}

  private get now() {
    return this.d.now?.() ?? Date.now();
  }

  private account(kind: Kind, id: string, requested?: string): string | null {
    if (kind === 'conversation') return this.d.pickAccount(id, requested);
    const vs = this.d.store.vantageAccounts('space', id);
    if (requested && vs.includes(requested)) return requested;
    return vs.find((a) => this.d.online(a)) ?? vs[0] ?? null;
  }

  /** The account, able and connected, or a refusal in words. */
  private able(accountId: string | null, network: P.Network, cap: P.Capability, what: string): AccountRow {
    const net = NETWORK_META[network].name;
    if (!accountId) throw new ModerationError('None of your accounts is in it.', 409);
    const acc = this.d.store.account(accountId);
    if (!acc) throw new ModerationError('No such account', 404);
    const caps: P.Capability[] = JSON.parse(acc.capabilities ?? '[]');
    if (!caps.includes(cap)) throw new ModerationError(`${what} isn't built for ${acc.label} on ${net} yet.`, 409);
    if (!this.d.online(acc.id)) throw new ModerationError(`${net} · ${acc.label} is not connected`, 409);
    return acc;
  }

  /** One slot of the hour, or a refusal that says when the next frees up. */
  private pace(accountId: string) {
    const now = this.now;
    const list = (this.recent.get(accountId) ?? []).filter((t) => now - t < HOUR);
    if (list.length >= MOD_PER_HOUR) {
      const mins = Math.max(1, Math.ceil((list[0]! + HOUR - now) / 60_000));
      throw new ModerationError(`That is ${MOD_PER_HOUR} moderating actions in an hour from this account: the next frees up in ${mins} minute${mins === 1 ? '' : 's'}.`, 429);
    }
    list.push(now);
    this.recent.set(accountId, list);
  }
  private unpace(accountId: string) {
    this.recent.get(accountId)?.pop();
  }

  private name(kind: Kind, id: string): string {
    const s = this.d.store;
    return (kind === 'space' ? s.one<{ name: string }>('SELECT name FROM space WHERE id = ?', id) : s.one<{ name: string | null }>('SELECT name FROM conversation WHERE id = ?', id))?.name ?? `a ${kind}`;
  }
  private who(identityId: string): string {
    const i = this.d.store.identitiesByIds([identityId])[0];
    return i?.displayName ?? i?.handle ?? i?.nativeId ?? 'someone';
  }

  private async fresh(accountId: string, network: P.Network, target: P.AboutTarget): Promise<P.About> {
    return this.d.command<P.About>(accountId, { t: 'about', target }, 30_000).catch((e: Error) => {
      throw new ModerationError(`Could not ask ${NETWORK_META[network].name}: ${e.message}`, 502);
    });
  }

  // ------------------------------------------------------------ members

  /** POST /api/(conversations|spaces)/:id/moderate { action, accountId? }: `who` a hub identity id. */
  async moderate(kind: Kind, id: string, b: { action?: unknown; accountId?: unknown }): Promise<P.AboutView> {
    const t = this.d.store.nativeOf(kind, id);
    if (!t) throw new ModerationError(`no such ${kind}`, 404);
    const problem = modActionProblem(b.action);
    if (problem) throw new ModerationError(problem, 400);
    const a = b.action as P.ModAction;
    const accountId = this.account(kind, id, typeof b.accountId === 'string' ? b.accountId : undefined);
    const acc = this.able(accountId, t.network, 'moderate', 'Moderating from here');
    let action: P.ModAction = a;
    let whoId: string | null = null;
    if (a.op !== 'end') {
      const n = this.d.store.nativeOf('identity', a.who);
      if (!n || n.network !== t.network) throw new ModerationError('Nobody by that id here', 404);
      if (a.who === acc.self_identity || this.d.store.isSelf(a.who)) throw new ModerationError('That is one of your own accounts', 400);
      whoId = a.who;
      action = { ...a, who: n.nativeId };
    }
    // A move names a voice channel of the same server, by its hub id.
    if (action.op === 'move') {
      const to = this.d.store.nativeOf('conversation', action.to);
      // The adapter checks it is in the same server: the hub keeps channels under categories, not under one server id.
      const voice = to && this.d.store.one<{ ok: number }>(`SELECT 1 AS ok FROM conversation WHERE id = ? AND variant IN ('voice', 'stage')`, action.to);
      if (!to || to.network !== t.network || !voice) throw new ModerationError('Move them to a voice channel of the same server', 400);
      action = { ...action, to: to.nativeId };
    }
    const target = { kind, nativeId: t.nativeId };
    // Never on a stale answer: who may do what, and who is in it, can have changed since the page opened.
    const fresh = await this.fresh(acc.id, t.network, target);
    const member = action.op === 'end' ? undefined : fresh.members?.list.find((m) => m.id === (action as { who: string }).who);
    if (action.op !== 'end' && action.op !== 'ban' && action.op !== 'unban' && !VOICE_MOD_OPS.includes(action.op) && !member && fresh.members && !fresh.members.complete) {
      throw new ModerationError(`${NETWORK_META[t.network].name} has not loaded them as a member here: open the member list in ${NETWORK_META[t.network].name} first.`, 409);
    }
    if (action.op === 'unban' && fresh.moderation?.banned && !fresh.moderation.banned.includes(action.who)) throw new ModerationError('They are not banned here', 409);
    const refusal = modRefusal(fresh.moderation, action, member?.mod, !!member);
    if (refusal) throw new ModerationError(refusal, 403);
    this.pace(acc.id);
    let about: P.About;
    try {
      about = await this.d.command<P.About>(acc.id, { t: 'moderate', target, action }, 45_000);
    } catch (e) {
      const msg = String((e as Error).message ?? e);
      if (!/timed out/i.test(msg)) this.unpace(acc.id);
      throw new ModerationError(/timed out/i.test(msg) ? `${NETWORK_META[t.network].name} did not answer in time. It may still have gone through: look again in a minute.` : msg, /timed out/i.test(msg) ? 504 : 502);
    }
    this.d.note?.(acc.id, `[moderate] ${logLine(t.network, action, whoId ? this.who(whoId) : '', fresh.roles)} in ${this.name(kind, id)}`);
    const after = about && typeof about === 'object' && 'fields' in about ? about : fresh;
    return this.d.keep(kind, id, t.network, acc.id, after);
  }

  /** GET /api/(conversations|spaces)/:id/bans: who is banned, from the About (Signal) or one read of the list (Discord). */
  async bans(kind: Kind, id: string, requested?: string): Promise<P.BansView> {
    const t = this.d.store.nativeOf(kind, id);
    if (!t) throw new ModerationError(`no such ${kind}`, 404);
    const acc = this.able(this.account(kind, id, requested), t.network, 'moderate', 'Moderating from here');
    const target = { kind, nativeId: t.nativeId };
    const fresh = await this.fresh(acc.id, t.network, target);
    const m = fresh.moderation;
    if (!m?.ban?.can) throw new ModerationError(m?.ban?.reason ?? 'You cannot see who is banned here.', 403);
    let r: P.BansResult = { banned: (m.banned ?? []).map((id) => ({ id })) };
    if (m.bansOnRequest) {
      r = await this.d.command<P.BansResult>(acc.id, { t: 'bans', target }, 30_000).catch((e: Error) => {
        throw new ModerationError(e.message, 502);
      });
    }
    const banned = (r?.banned ?? []).filter((x) => typeof x?.id === 'string' && x.id).map((x) => ({ identityId: this.d.store.ensureIdentity(acc, x.id), ...(typeof x.reason === 'string' && x.reason ? { reason: x.reason.slice(0, 500) } : {}) }));
    this.d.flush?.();
    return { accountId: acc.id, banned, ...(r?.more ? { more: true } : {}), identities: this.d.store.identitiesByIds(banned.map((x) => x.identityId)) };
  }

  /** POST /api/conversations/:id/label { text, emoji?, accountId? }: your own member label there. */
  async setLabel(id: string, b: { text?: unknown; emoji?: unknown; accountId?: unknown }): Promise<P.AboutView> {
    const t = this.d.store.nativeOf('conversation', id);
    if (!t) throw new ModerationError('no such conversation', 404);
    const problem = memberLabelProblem(b.text, b.emoji);
    if (problem) throw new ModerationError(problem, 400);
    const acc = this.able(this.account('conversation', id, typeof b.accountId === 'string' ? b.accountId : undefined), t.network, 'memberLabels', 'Member labels');
    const target = { kind: 'conversation' as const, nativeId: t.nativeId };
    const fresh = await this.fresh(acc.id, t.network, target);
    if (!fresh.label?.canEdit) throw new ModerationError(fresh.label?.reason ?? 'You cannot set a label here.', 403);
    const text = (b.text as string).trim();
    const emoji = typeof b.emoji === 'string' ? b.emoji.trim() : undefined;
    const about = await this.d.command<P.About>(acc.id, { t: 'setLabel', conversation: t.nativeId, text, ...(emoji !== undefined ? { emoji } : {}) }, 45_000).catch((e: Error) => {
      throw new ModerationError(e.message, 502);
    });
    this.d.note?.(acc.id, `[label] ${text ? `set your label to "${emoji ? `${emoji} ` : ''}${text}"` : 'cleared your label'} in ${this.name('conversation', id)}`);
    return this.d.keep('conversation', id, t.network, acc.id, about && 'fields' in about ? about : fresh);
  }

  // ------------------------------------------------------------ messages

  private async messageContext(messageId: string, requested?: string) {
    const s = this.d.store;
    const msg = s.one<{ conversation_id: string; native_id: string; author_id: string | null }>('SELECT conversation_id, native_id, author_id FROM message WHERE id = ?', messageId);
    if (!msg) throw new ModerationError('no such message', 404);
    const conv = s.nativeOf('conversation', msg.conversation_id)!;
    const acc = this.able(this.d.pickAccount(msg.conversation_id, requested), conv.network, 'moderate', 'Moderating from here');
    const ctx = await this.d.command<P.ReactionContext>(acc.id, { t: 'reactionContext', conversation: conv.nativeId }, 15_000).catch((e: Error) => {
      throw new ModerationError(`Could not ask ${NETWORK_META[conv.network].name}: ${e.message}`, 502);
    });
    return { msg, conv, acc, mod: ctx?.moderation };
  }

  /** POST /api/messages/:id/moderate-delete: someone else's message, deleted for everyone as a moderator may. */
  async deleteMessage(messageId: string, b: { accountId?: unknown }): Promise<{ ok: true }> {
    const { msg, conv, acc, mod } = await this.messageContext(messageId, typeof b.accountId === 'string' ? b.accountId : undefined);
    if (msg.author_id && this.d.store.isSelf(msg.author_id)) throw new ModerationError('That message is yours: delete it the usual way', 400);
    if (!mod?.delete) throw new ModerationError(conv.network === 'signal' ? 'Only group admins can delete others’ messages.' : 'You need the Manage Messages permission here.', 403);
    this.pace(acc.id);
    try {
      await this.d.command(acc.id, { t: 'redact', conversation: conv.nativeId, message: msg.native_id, moderator: true }, 30_000);
    } catch (e) {
      this.unpace(acc.id);
      throw new ModerationError((e as Error).message, 502);
    }
    this.d.note?.(acc.id, `[moderate] deleted a message by ${msg.author_id ? this.who(msg.author_id) : 'someone'} in ${this.name('conversation', msg.conversation_id)}`);
    return { ok: true };
  }

  /** POST /api/messages/:id/clear-reactions { key?, identityId? }: all, one emoji's, or one person's reaction. */
  async clearReactions(messageId: string, b: { key?: unknown; identityId?: unknown; accountId?: unknown }): Promise<{ ok: true }> {
    const clear: P.ReactionClear = {};
    if (b.key !== undefined) clear.key = b.key as string;
    let whoName = '';
    if (b.identityId !== undefined) {
      const n = typeof b.identityId === 'string' ? this.d.store.nativeOf('identity', b.identityId) : null;
      if (!n) throw new ModerationError('Nobody by that id', 404);
      clear.who = n.nativeId;
      whoName = this.who(b.identityId as string);
    }
    const problem = reactionClearProblem(clear);
    if (problem) throw new ModerationError(problem, 400);
    const { msg, conv, acc, mod } = await this.messageContext(messageId, typeof b.accountId === 'string' ? b.accountId : undefined);
    if (!mod?.reactions) throw new ModerationError(conv.network === 'discord' ? 'You need the Manage Messages permission here.' : `${NETWORK_META[conv.network].name} does not let anyone remove others’ reactions.`, 403);
    this.pace(acc.id);
    try {
      await this.d.command(acc.id, { t: 'clearReactions', conversation: conv.nativeId, message: msg.native_id, ...clear }, 30_000);
    } catch (e) {
      this.unpace(acc.id);
      throw new ModerationError((e as Error).message, 502);
    }
    const what = clear.who ? `${whoName}'s ${clear.key} reaction` : clear.key ? `every ${clear.key} reaction` : 'every reaction';
    this.d.note?.(acc.id, `[moderate] removed ${what} on a message in ${this.name('conversation', msg.conversation_id)}`);
    return { ok: true };
  }

  // ------------------------------------------------------------ routes

  static handles(path: string): boolean {
    return /^\/api\/(conversations|spaces)\/[\w-]+\/(moderate|bans)$/.test(path) || /^\/api\/conversations\/[\w-]+\/label$/.test(path) || /^\/api\/messages\/[\w-]+\/(moderate-delete|clear-reactions)$/.test(path);
  }

  async route(req: Request, url: URL, path: string): Promise<Response | null> {
    if (!Moderation.handles(path)) return null;
    const method = req.method;
    const body = async <T>() => (await req.json().catch(() => ({}))) as T;
    // A write is the owner's click on the hub's own page: a browser sends Origin, and the server has refused any other site's.
    const fromPage = () => {
      if (!req.headers.get('origin')) throw new ModerationError('This is done from the app itself', 403);
    };
    const done = (v: unknown) => {
      this.d.flush?.();
      return Response.json(v);
    };
    let m: RegExpMatchArray | null;
    try {
      if ((m = path.match(/^\/api\/(conversations|spaces)\/([\w-]+)\/moderate$/)) && method === 'POST') {
        fromPage();
        return done(await this.moderate(m[1] === 'spaces' ? 'space' : 'conversation', m[2], await body()));
      }
      if ((m = path.match(/^\/api\/(conversations|spaces)\/([\w-]+)\/bans$/)) && method === 'GET') return done(await this.bans(m[1] === 'spaces' ? 'space' : 'conversation', m[2], url.searchParams.get('account') ?? undefined));
      if ((m = path.match(/^\/api\/conversations\/([\w-]+)\/label$/)) && method === 'POST') {
        fromPage();
        return done(await this.setLabel(m[1], await body()));
      }
      if ((m = path.match(/^\/api\/messages\/([\w-]+)\/moderate-delete$/)) && method === 'POST') {
        fromPage();
        return done(await this.deleteMessage(m[1], await body()));
      }
      if ((m = path.match(/^\/api\/messages\/([\w-]+)\/clear-reactions$/)) && method === 'POST') {
        fromPage();
        return done(await this.clearReactions(m[1], await body()));
      }
    } catch (e) {
      if (e instanceof ModerationError) return Response.json({ error: e.message }, { status: e.status });
      throw e;
    }
    return Response.json({ error: 'not found' }, { status: 404 });
  }
}

/** The account log's words for an action: "kicked Ana", "timed out Ana for an hour", "gave Ana the Helper role". */
export function logLine(network: P.Network, a: P.ModAction, who: string, roles?: P.AboutRole[]): string {
  switch (a.op) {
    case 'remove':
      return `${network === 'discord' ? 'kicked' : 'removed'} ${who}`;
    case 'ban':
      return `banned ${who}${a.deleteSeconds ? ` and deleted their messages from the last ${spanLabel(a.deleteSeconds)}` : ''}`;
    case 'unban':
      return `unbanned ${who}`;
    case 'admin':
      return a.remove ? `took admin from ${who}` : `made ${who} an admin`;
    case 'role': {
      const role = roles?.find((r) => r.id === a.role)?.name ?? 'a role';
      return a.remove ? `took the ${role} role from ${who}` : `gave ${who} the ${role} role`;
    }
    case 'timeout':
      return a.seconds ? `timed out ${who} for ${spanLabel(a.seconds)}` : `ended ${who}'s timeout`;
    case 'end':
      return modVerb(network, a).toLowerCase();
    case 'voiceMute':
      return a.on ? `server-muted ${who}` : `server-unmuted ${who}`;
    case 'voiceDeafen':
      return a.on ? `server-deafened ${who}` : `server-undeafened ${who}`;
    case 'move':
      return `moved ${who} to another voice channel`;
    case 'disconnect':
      return `disconnected ${who} from voice`;
  }
}

/** About.moderation in hub terms: the banned and those asking to join as hub identity ids. */
export function moderationView(store: Store, acc: AccountRow | null, network: P.Network, m: P.AboutModeration | undefined): P.AboutModerationView | undefined {
  if (!m || typeof m !== 'object') return undefined;
  const ids = (xs: unknown) => (Array.isArray(xs) ? xs.filter((x): x is string => typeof x === 'string' && !!x).map((x) => (acc ? store.ensureIdentity(acc, x) : hubId('idn', network, x))) : undefined);
  const { banned, requesting, ...rest } = m;
  const b = ids(banned);
  const r = ids(requesting);
  return { ...rest, ...(b ? { banned: b } : {}), ...(r ? { requesting: r } : {}) };
}

/** The same moderation with every power locked, saying why (a stale About). */
export function lockedModeration(m: P.AboutModeration, reason: string): P.AboutModeration {
  const out: P.AboutModeration = { ...m };
  for (const k of ['remove', 'ban', 'admins', 'roles', 'timeout', 'end', 'voiceMute', 'voiceDeafen', 'voiceMove'] as const) if (out[k]) (out as Record<string, unknown>)[k] = { ...out[k], can: false, reason };
  return out;
}
