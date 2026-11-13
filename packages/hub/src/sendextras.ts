/**
 * The hub's routes for sending with more than words (docs/sending.md): Send later (sendlater.ts) with a network's own
 * scheduled messages beside it, saved messages and reminders on the network (saved.ts), and taking the previews off
 * your own message.
 *
 *   GET    /api/scheduled                   the list: the hub's, and (?network=1) each account's own scheduled messages
 *   POST   /api/scheduled                   ScheduleBody -> ScheduledSendView
 *   PATCH  /api/scheduled/:id               { body?, dueAt? } -> ScheduledSendView
 *   POST   /api/scheduled/:id/send          send it now -> ScheduledSendView
 *   DELETE /api/scheduled/:id               cancel (a network's own: ?account=)
 *   GET    /api/saved                       SavedPage; ?fresh=1 asks the networks, ?account= & before= for more
 *   POST   /api/messages/:id/save           { dueAt?: number | null, remove?: true } -> SavedView | {}
 *   POST   /api/messages/:id/remove-previews {}
 */
import type * as P from '@dither-chat/protocol';
import { NETWORK_META } from '@dither-chat/protocol';
import { keepSaved, savedTables, savedViews } from './saved.ts';
import { type LaterSend, nativeView, SendLater } from './sendlater.ts';
import type { Store } from './store.ts';

type Row = Record<string, any>;

export interface SendExtrasDeps {
  store: Store;
  online: (accountId: string) => boolean;
  command: <T = unknown>(accountId: string, cmd: any, timeoutMs?: number) => Promise<T>;
  /** The hub's send (server.ts sendOnce). */
  send: (conversationId: string, b: LaterSend) => Promise<Response>;
  /** A chat's route for a send, as POST /api/chats/:id/messages picks it (server.ts), or an error sentence. */
  chatRoute: (chatId: string, b: { route?: { conversationId?: string; accountId?: string }; replyTo?: string }) => { conversationId: string; accountId: string } | string;
  pickAccount: (conversationId: string, requested?: string) => string | null;
  files: (ids: string[]) => string[] | null;
  dropFiles: (ids: string[]) => void;
  broadcast: (events: P.ClientEvent[]) => void;
  flush: () => void;
  /** Message views and the identities they name, for the saved list. */
  messages: (ids: string[]) => { messages: P.MessageView[]; identities: P.IdentityView[] };
}

class Refused extends Error {
  constructor(
    message: string,
    readonly status = 400,
  ) {
    super(message);
  }
}

const caps = (store: Store, accountId: string): P.Capability[] => JSON.parse(store.account(accountId)?.capabilities ?? '[]');

export class SendExtras {
  readonly later: SendLater;

  constructor(private d: SendExtrasDeps) {
    savedTables(d.store.db);
    this.later = new SendLater(d.store, { send: d.send, online: d.online, files: d.files, dropFiles: d.dropFiles, broadcast: d.broadcast });
  }

  static handles(path: string): boolean {
    return path === '/api/scheduled' || /^\/api\/scheduled\/[\w-]+(\/send)?$/.test(path) || path === '/api/saved' || /^\/api\/messages\/[\w-]+\/(save|remove-previews)$/.test(path);
  }

  async route(req: Request, url: URL, path: string): Promise<Response | null> {
    if (!SendExtras.handles(path)) return null;
    const method = req.method;
    const body = async <T>() => (await req.json().catch(() => ({}))) as T;
    let m: RegExpMatchArray | null;
    try {
      if (path === '/api/scheduled' && method === 'GET') return Response.json({ items: await this.scheduled(url.searchParams.get('network') === '1') });
      if (path === '/api/scheduled' && method === 'POST') return Response.json(this.schedule(await body<P.ScheduleBody>()));
      if ((m = path.match(/^\/api\/scheduled\/([\w-]+)\/send$/)) && method === 'POST') return Response.json(await this.later.sendNow(m[1]));
      if ((m = path.match(/^\/api\/scheduled\/([\w-]+)$/))) {
        if (method === 'PATCH') return Response.json(this.later.edit(m[1], await body<{ body?: unknown; dueAt?: unknown }>()));
        if (method === 'DELETE') {
          if (m[1].startsWith('nsch_')) await this.cancelNative(m[1]);
          else this.later.cancel(m[1]);
          return Response.json({ ok: true });
        }
      }
      if (path === '/api/saved' && method === 'GET') return Response.json(await this.saved(url));
      if ((m = path.match(/^\/api\/messages\/([\w-]+)\/save$/)) && method === 'POST') return Response.json(await this.save(m[1], await body<{ dueAt?: unknown; remove?: unknown; accountId?: unknown }>()));
      if ((m = path.match(/^\/api\/messages\/([\w-]+)\/remove-previews$/)) && method === 'POST') return Response.json(await this.removePreviews(m[1]));
      return Response.json({ error: 'not found' }, { status: 404 });
    } catch (e) {
      const status = e instanceof Refused ? e.status : typeof (e as { status?: unknown }).status === 'number' ? (e as { status: number }).status : 502;
      return Response.json({ error: (e as Error).message }, { status });
    }
  }

  // ------------------------------------------------------------------ send later

  private schedule(b: P.ScheduleBody): P.ScheduledSendView {
    let where: { conversationId: string; accountId: string };
    if (typeof b.chatId === 'string' && b.chatId) {
      const r = this.d.chatRoute(b.chatId, { route: b.route, replyTo: b.replyTo });
      if (typeof r === 'string') throw new Refused(r, 409);
      where = r;
    } else {
      const cid = String(b.conversationId ?? '');
      if (!this.d.store.nativeOf('conversation', cid)) throw new Refused('no such conversation', 404);
      // The account it goes from is picked now, so the list can say which, and kept even while it is offline.
      const acc = typeof b.accountId === 'string' && b.accountId ? b.accountId : this.accountFor(cid);
      if (!acc) throw new Refused('no account of yours is in this conversation', 409);
      where = { conversationId: cid, accountId: acc };
    }
    const c = caps(this.d.store, where.accountId);
    if (b.silent === true && !c.includes('silentSend')) throw new Refused(`${this.label(where.accountId)} cannot send silently`, 409);
    if (b.mentionReplied === false && !c.includes('replyMention')) throw new Refused(`${this.label(where.accountId)} cannot reply without a ping`, 409);
    return this.later.create({
      ...where,
      body: typeof b.body === 'string' ? b.body : '',
      replyTo: typeof b.replyTo === 'string' && b.replyTo ? b.replyTo : null,
      attachments: Array.isArray(b.attachments) ? b.attachments : [],
      silent: b.silent === true,
      ...(typeof b.mentionReplied === 'boolean' && b.replyTo ? { mentionReplied: b.mentionReplied } : {}),
      dueAt: b.dueAt,
    });
  }

  /** Any account of yours with a vantage on it, the connected one first; the hub's own pick when one is connected. */
  private accountFor(conversationId: string): string | null {
    const live = this.d.pickAccount(conversationId);
    if (live) return live;
    const r = this.d.store.db.query(`SELECT account_id FROM vantage WHERE target_kind = 'conversation' AND target_id = ? LIMIT 1`).get(conversationId) as Row | null;
    return r?.account_id ?? null;
  }

  /** The hub's list, and (`network`) each connected account's own scheduled messages, asked now. */
  private async scheduled(network: boolean): Promise<P.ScheduledSendView[]> {
    const out = this.later.list();
    if (!network) return out;
    const accounts = this.d.store.accounts().filter((a) => this.d.online(a.id) && caps(this.d.store, a.id).includes('nativeScheduled'));
    const lists = await Promise.all(
      accounts.map(async (a) => {
        try {
          const r = await this.d.command<P.NativeScheduledResult>(a.id, { t: 'nativeScheduled' }, 30_000);
          return r?.enabled ? (r.scheduled ?? []).map((f) => nativeView(a.id, a.network as P.Network, f)) : [];
        } catch {
          return [];
        }
      }),
    );
    return [...out, ...lists.flat()].sort((x, y) => x.dueAt - y.dueAt);
  }

  private async cancelNative(id: string) {
    const m = id.match(/^nsch_(acc_[\w-]+?)_(\d+)$/);
    if (!m) throw new Refused('no such message', 404);
    const [, accountId, nativeId] = m;
    if (!caps(this.d.store, accountId).includes('nativeScheduled')) throw new Refused('That account cannot cancel it here', 409);
    if (!this.d.online(accountId)) throw new Refused(`${this.label(accountId)} is not connected`, 409);
    await this.d.command(accountId, { t: 'cancelScheduled', nativeId }, 30_000).catch((e: Error) => {
      throw new Refused(`${NETWORK_META[this.d.store.account(accountId)!.network as P.Network].name} refused it: ${e.message}`, 502);
    });
  }

  // ------------------------------------------------------------------ saved on the network

  private async saved(url: URL): Promise<P.SavedPage> {
    const fresh = url.searchParams.get('fresh') === '1';
    const only = url.searchParams.get('account');
    const before = url.searchParams.get('before') ? Number(url.searchParams.get('before')) : undefined;
    const accounts = this.d.store.accounts().filter((a) => caps(this.d.store, a.id).includes('savedMessages') && (!only || a.id === only));
    const errors: P.SavedPage['errors'] = [];
    const more: string[] = [];
    if (fresh || before !== undefined) {
      for (const a of accounts) {
        if (!this.d.online(a.id)) {
          errors.push({ accountId: a.id, error: `${this.label(a.id)} is not connected: this is what it said last` });
          continue;
        }
        try {
          const r = await this.d.command<P.SavedListResult>(a.id, { t: 'savedList', ...(before !== undefined ? { before } : {}) }, 45_000);
          // The first page is everything up to its oldest; a later page adds to what is kept.
          keepSaved(this.d.store.db, a, r?.saved ?? [], before === undefined && !r?.more);
          if (r?.more) more.push(a.id);
        } catch (e) {
          errors.push({ accountId: a.id, error: `${NETWORK_META[a.network as P.Network].name} did not answer: ${(e as Error).message}` });
        }
      }
      this.d.flush();
    }
    const saved = savedViews(
      this.d.store.db,
      accounts.map((a) => a.id),
    );
    return { saved, ...this.d.messages(saved.map((s) => s.messageId)), errors, more };
  }

  private async save(messageId: string, b: { dueAt?: unknown; remove?: unknown; accountId?: unknown }): Promise<P.SavedView | Record<string, never>> {
    const s = this.d.store;
    const row = s.db.query('SELECT conversation_id, native_id, network FROM message WHERE id = ?').get(messageId) as Row | null;
    if (!row) throw new Refused('no such message', 404);
    const conv = s.nativeOf('conversation', row.conversation_id)!;
    const accountId = typeof b.accountId === 'string' && b.accountId ? b.accountId : this.d.pickAccount(row.conversation_id);
    if (!accountId || !this.d.online(accountId)) throw new Refused('No connected account can save it on the network', 409);
    if (!caps(s, accountId).includes('savedMessages')) throw new Refused(`${this.label(accountId)} cannot save messages on ${NETWORK_META[row.network as P.Network].name}`, 409);
    const remove = b.remove === true;
    const dueAt = typeof b.dueAt === 'number' && Number.isFinite(b.dueAt) ? b.dueAt : undefined;
    if (dueAt !== undefined && dueAt < Date.now()) throw new Refused('Pick a time from now on');
    try {
      const r = await this.d.command<P.SavedFact | Record<string, never>>(accountId, { t: 'save', conversation: conv.nativeId, message: row.native_id, ...(remove ? { remove: true } : {}), ...(dueAt !== undefined ? { dueAt } : {}) }, 30_000);
      const acc = s.account(accountId)!;
      if (remove) s.db.query('DELETE FROM saved_message WHERE account_id = ? AND message_id = ?').run(accountId, messageId);
      else if (r && 'message' in r) keepSaved(s.db, acc, [r as P.SavedFact], false);
      else keepSaved(s.db, acc, [{ conversation: conv.nativeId, message: row.native_id, savedAt: Date.now(), ...(dueAt !== undefined ? { dueAt } : {}) }], false);
    } catch (e) {
      throw new Refused(`${NETWORK_META[row.network as P.Network].name} refused it: ${(e as Error).message}`, 502);
    }
    return remove ? {} : (savedViews(s.db, [accountId]).find((v) => v.messageId === messageId) ?? {});
  }

  // ------------------------------------------------------------------ previews

  private async removePreviews(messageId: string): Promise<{ ok: true }> {
    const s = this.d.store;
    const row = s.db.query('SELECT conversation_id, native_id, network, author_id FROM message WHERE id = ?').get(messageId) as Row | null;
    if (!row) throw new Refused('no such message', 404);
    if (!s.isSelf(row.author_id)) throw new Refused('Only your own messages', 403);
    const conv = s.nativeOf('conversation', row.conversation_id)!;
    // The account that wrote it: its own identity on that network.
    const accountId = s.accounts().find((a) => a.self_identity === row.author_id)?.id ?? null;
    if (!accountId || !this.d.online(accountId)) throw new Refused('The account that wrote it is not connected', 409);
    if (!caps(s, accountId).includes('suppressEmbeds')) throw new Refused(`${this.label(accountId)} cannot remove previews`, 409);
    try {
      await this.d.command(accountId, { t: 'suppressEmbeds', conversation: conv.nativeId, message: row.native_id }, 30_000);
    } catch (e) {
      throw new Refused(`${NETWORK_META[row.network as P.Network].name} refused it: ${(e as Error).message}`, 502);
    }
    return { ok: true };
  }

  private label(accountId: string): string {
    const a = this.d.store.account(accountId);
    return a ? `${NETWORK_META[a.network as P.Network]?.name ?? a.network} · ${a.label}` : 'That account';
  }
}
