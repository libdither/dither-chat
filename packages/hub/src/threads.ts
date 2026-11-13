/**
 * Threads, forums and group DMs beyond messages (docs/threads.md): which threads your accounts follow and how each
 * notifies them, starting threads and forum posts, archiving and locking, a forum's tags and its posts' first
 * messages, publishing in an announcement channel, a channel's archived threads on request, and running a group you
 * own (taking someone out, handing it over, its picture).
 *
 * The adapters say a thread's and a forum's facts with their conversation facts (protocol threads.ts); the hub keeps
 * the latest per account and adds them to the conversation's view. Whether you follow a thread also reaches triage as
 * the thread's native mute, which the adapter sends with it. Each write passes on only what a fresh About says this
 * account may do, and only from a click on the hub's own page.
 */
import type { Database } from 'bun:sqlite';
import type * as P from '@dither-chat/protocol';
import { NETWORK_META, postProblem, threadNameProblem, MUTE_TIMERS } from '@dither-chat/protocol';
import { hubId } from '@dither-chat/protocol/ids';
import type { AccountRow, Store } from './store.ts';

type Row = Record<string, any>;

type Cmd =
  | { t: 'about'; target: P.AboutTarget }
  | { t: 'threads'; conversation: string; archived: boolean; offset: number; mine?: boolean }
  | Omit<Extract<P.ThreadsCommand, { t: 'followThread' }>, 'id'>
  | Omit<Extract<P.ThreadsCommand, { t: 'threadNotify' }>, 'id'>
  | Omit<Extract<P.ThreadsCommand, { t: 'threadState' }>, 'id'>
  | Omit<Extract<P.ThreadsCommand, { t: 'createThread' }>, 'id'>
  | Omit<Extract<P.ThreadsCommand, { t: 'createPost' }>, 'id'>
  | Omit<Extract<P.ThreadsCommand, { t: 'crosspost' }>, 'id'>
  | Omit<Extract<P.ThreadsCommand, { t: 'removeMember' }>, 'id'>
  | Omit<Extract<P.ThreadsCommand, { t: 'setOwner' }>, 'id'>
  | Omit<Extract<P.ThreadsCommand, { t: 'setPicture' }>, 'id'>;

export interface ThreadsDeps {
  store: Store;
  online: (accountId: string) => boolean;
  command: <T>(accountId: string, cmd: Cmd, timeoutMs?: number) => Promise<T>;
  /** Which account speaks for a conversation, honouring a request. */
  pickAccount: (conversationId: string, requested?: string) => string | null;
  /** Files uploaded for a post or a picture (uploads.ts): null when one has expired. */
  uploads?: { get(ids: string[]): P.OutgoingAttachment[] | null; remove(ids: string[]): void };
  note?: (accountId: string, line: string) => void;
  flush?: () => void;
  now?: () => number;
  /** An About in hub terms (about.ts Abouts). */
  aboutView?: (kind: 'conversation', id: string, network: P.Network, accountId: string, about: P.About) => P.AboutView;
}

export class ThreadsError extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message);
  }
}

const made = new WeakSet<Database>();

/** The tables: each account's facts of a thread, and a forum's own (the same for every account). */
export function threadTables(db: Database) {
  if (made.has(db)) return;
  db.exec(`CREATE TABLE IF NOT EXISTS thread_info (
    conversation_id TEXT NOT NULL,
    account_id      TEXT NOT NULL REFERENCES account(id) ON DELETE CASCADE,
    data            TEXT NOT NULL,
    updated_at      INTEGER NOT NULL,
    PRIMARY KEY (conversation_id, account_id)
  )`);
  db.exec(`CREATE TABLE IF NOT EXISTS forum_info (
    conversation_id TEXT PRIMARY KEY,
    data            TEXT NOT NULL,
    updated_at      INTEGER NOT NULL
  )`);
  made.add(db);
}

const caps = (store: Store, accountId: string): P.Capability[] => JSON.parse(store.account(accountId)?.capabilities ?? '[]');

/** A conversation fact's thread and forum parts (store.ts ingest), kept as the adapter said them last. */
export function ingestThreadFacts(store: Store, acc: AccountRow, f: P.ConversationFact, now = Date.now()) {
  if (!f?.thread && !f?.forum) return;
  threadTables(store.db);
  const id = hubId('cnv', acc.network, f.nativeId);
  if (f.thread && typeof f.thread === 'object') {
    // A fact says only what the network said this time: what it left out stays as it was.
    const was = store.one<{ data: string }>('SELECT data FROM thread_info WHERE conversation_id = ? AND account_id = ?', id, acc.id);
    let merged: P.ThreadFact = f.thread;
    try {
      if (was) merged = { ...(JSON.parse(was.data) as P.ThreadFact), ...f.thread };
    } catch {}
    // A membership told without a mute or a setting has none.
    if (f.thread.joined !== undefined) {
      if (f.thread.notify === undefined) delete merged.notify;
      if (f.thread.muted === undefined) delete merged.muted;
      if (f.thread.mutedUntil === undefined) delete merged.mutedUntil;
    }
    if (f.thread.owner) store.ensureIdentity(acc, f.thread.owner);
    const data = JSON.stringify(merged);
    if (was?.data !== data) {
      store.db
        .query('INSERT INTO thread_info (conversation_id, account_id, data, updated_at) VALUES (?, ?, ?, ?) ON CONFLICT (conversation_id, account_id) DO UPDATE SET data = excluded.data, updated_at = excluded.updated_at')
        .run(id, acc.id, data, now);
      // Its view changed: clients hear of it, and a kept bootstrap is made again.
      store.dirty.conversations.add(id);
    }
  }
  if (f.forum && typeof f.forum === 'object' && Array.isArray(f.forum.tags)) {
    const data = JSON.stringify(f.forum);
    if (store.one<{ data: string }>('SELECT data FROM forum_info WHERE conversation_id = ?', id)?.data !== data) {
      store.db.query('INSERT INTO forum_info (conversation_id, data, updated_at) VALUES (?, ?, ?) ON CONFLICT (conversation_id) DO UPDATE SET data = excluded.data, updated_at = excluded.updated_at').run(id, data, now);
      store.dirty.conversations.add(id);
    }
  }
}

/** What threadParts hands the store for one conversation: its thread and forum parts, and where its first message is. */
export interface ThreadParts {
  thread?: Omit<P.ThreadView, 'first' | 'cover'>;
  forum?: P.ForumView;
  /** A post's first message's hub id (a forum post's starts the thread and has its id). */
  firstId?: string;
}

const parse = <T>(s: string): T | null => {
  try {
    return JSON.parse(s) as T;
  } catch {
    return null;
  }
};

/** The thread and forum parts of these conversations, in a couple of queries, for store.ts conversationViews. */
export function threadParts(store: Store, rows: { id: string; network: string; native_id: string; shape: string; variant: string | null }[]): Map<string, ThreadParts> {
  const out = new Map<string, ThreadParts>();
  const threads = rows.filter((r) => r.shape === 'thread');
  const forums = rows.filter((r) => r.variant === 'forum' || r.variant === 'media');
  if (!threads.length && !forums.length) return out;
  threadTables(store.db);
  if (threads.length) {
    const list = JSON.stringify(threads.map((r) => r.id));
    const facts = store.db.query('SELECT conversation_id, account_id, data FROM thread_info WHERE conversation_id IN (SELECT value FROM json_each(?))').all(list) as Row[];
    const by = new Map<string, Row[]>();
    for (const f of facts) (by.get(f.conversation_id) ?? by.set(f.conversation_id, []).get(f.conversation_id)!).push(f);
    for (const r of threads) {
      const firstId = hubId('msg', r.network as P.Network, r.native_id);
      const mine = by.get(r.id) ?? [];
      if (!mine.length) {
        out.set(r.id, { firstId });
        continue;
      }
      const all = mine.map((m) => ({ accountId: m.account_id as string, f: parse<P.ThreadFact>(m.data) ?? {} }));
      // The facts of the thread itself are the same from every account; the newest-known wins where they differ.
      const any = <K extends keyof P.ThreadFact>(k: K) => all.map((a) => a.f[k]).find((v) => v !== undefined);
      const following = all.filter((a) => a.f.joined === true);
      const lead = following[0]?.f ?? {};
      const net = r.network as P.Network;
      const owner = any('owner');
      out.set(r.id, {
        firstId,
        thread: {
          following: following.map((a) => a.accountId),
          notFollowing: all.filter((a) => a.f.joined === false).map((a) => a.accountId),
          notify: lead.notify ?? null,
          muted: lead.muted === true && (!lead.mutedUntil || lead.mutedUntil > Date.now()),
          mutedUntil: lead.mutedUntil ?? null,
          locked: any('locked') === true,
          tags: any('tags') ?? [],
          pinned: any('pinned') === true,
          private: any('private') === true,
          ownerId: owner ? hubId('idn', net, owner) : null,
          createdAt: any('createdAt') ?? null,
          messageCount: any('messageCount') ?? null,
        },
      });
    }
  }
  if (forums.length) {
    const list = JSON.stringify(forums.map((r) => r.id));
    for (const f of store.db.query('SELECT conversation_id, data FROM forum_info WHERE conversation_id IN (SELECT value FROM json_each(?))').all(list) as Row[]) {
      const fact = parse<P.ForumFact>(f.data);
      if (!fact) continue;
      const v: P.ForumView = { tags: fact.tags ?? [], sort: fact.sort ?? 'activity', layout: fact.layout ?? 'list', tagRequired: fact.tagRequired === true };
      out.set(f.conversation_id, { ...(out.get(f.conversation_id) ?? {}), forum: v });
    }
    // A media channel the adapter has not described yet still lays out as a gallery.
    for (const r of forums) if (!out.get(r.id)?.forum) out.set(r.id, { ...(out.get(r.id) ?? {}), forum: { tags: [], sort: 'activity', layout: r.variant === 'media' ? 'gallery' : 'list', tagRequired: false } });
  }
  return out;
}

export class Threads {
  constructor(private d: ThreadsDeps) {
    threadTables(d.store.db);
  }

  private get now() {
    return this.d.now?.() ?? Date.now();
  }

  private conv(id: string): { network: P.Network; nativeId: string; row: Row } {
    const t = this.d.store.nativeOf('conversation', id);
    const row = this.d.store.one<Row>('SELECT * FROM conversation WHERE id = ?', id);
    if (!t || !row) throw new ThreadsError('no such conversation', 404);
    return { ...t, row };
  }

  /** The account, connected and able to do this; or why not. */
  private able(conversationId: string, requested: unknown, network: P.Network, cap: P.Capability, what: string): AccountRow {
    const accountId = this.d.pickAccount(conversationId, typeof requested === 'string' ? requested : undefined);
    const net = NETWORK_META[network].name;
    if (!accountId) throw new ThreadsError('None of your connected accounts is in it.', 409);
    const acc = this.d.store.account(accountId)!;
    if (!caps(this.d.store, accountId).includes(cap)) throw new ThreadsError(`${what} on ${net} isn't built for this account yet.`, 409);
    if (!this.d.online(accountId)) throw new ThreadsError(`${net} · ${acc.label} is not connected`, 409);
    return acc;
  }

  private async ask<T>(acc: AccountRow, cmd: Cmd, timeout = 45_000): Promise<T> {
    try {
      return await this.d.command<T>(acc.id, cmd, timeout);
    } catch (e) {
      throw new ThreadsError(String((e as Error).message ?? e), 502);
    }
  }

  /** A fresh About: never act on an old answer to "may I". */
  private async fresh(acc: AccountRow, network: P.Network, nativeId: string): Promise<P.About> {
    return this.d.command<P.About>(acc.id, { t: 'about', target: { kind: 'conversation', nativeId } }, 30_000).catch((e: Error) => {
      throw new ThreadsError(`Could not ask ${NETWORK_META[network].name}: ${e.message}`, 502);
    });
  }

  private view(id: string, network: P.Network, acc: AccountRow, about: P.About): P.AboutView | P.About {
    return this.d.aboutView ? this.d.aboutView('conversation', id, network, acc.id, about) : about;
  }

  private name(id: string): string {
    return this.d.store.one<{ name: string | null }>('SELECT name FROM conversation WHERE id = ?', id)?.name ?? 'a conversation';
  }

  private files(ids: unknown): { ids: string[]; files: P.OutgoingAttachment[] } {
    const list = Array.isArray(ids) ? ids.filter((x): x is string => typeof x === 'string') : [];
    if (!list.length) return { ids: [], files: [] };
    const files = this.d.uploads?.get(list);
    if (!files) throw new ThreadsError('that upload has expired, attach the file again', 410);
    return { ids: list, files };
  }

  // ------------------------------------------------------------ following

  /** POST /api/conversations/:id/follow { follow, accountId? } */
  async follow(id: string, b: { follow?: unknown; accountId?: unknown }): Promise<P.ThreadFact> {
    const t = this.conv(id);
    if (t.row.shape !== 'thread') throw new ThreadsError('Only a thread can be followed', 400);
    if (typeof b.follow !== 'boolean') throw new ThreadsError('Follow or unfollow?', 400);
    const acc = this.able(id, b.accountId, t.network, 'followThreads', 'Following threads');
    const r = await this.ask<P.ThreadFact>(acc, { t: 'followThread', conversation: t.nativeId, follow: b.follow });
    this.d.note?.(acc.id, `[thread] ${b.follow ? 'followed' : 'unfollowed'} ${this.name(id)}`);
    return r ?? {};
  }

  /** POST /api/conversations/:id/thread-notify { notify?, muted?, minutes?, accountId? } */
  async notify(id: string, b: { notify?: unknown; muted?: unknown; minutes?: unknown; accountId?: unknown }): Promise<P.ThreadFact> {
    const t = this.conv(id);
    if (t.row.shape !== 'thread') throw new ThreadsError('Only a thread has these settings', 400);
    const notify = b.notify === undefined ? undefined : b.notify;
    if (notify !== undefined && notify !== 'all' && notify !== 'mentions' && notify !== 'none') throw new ThreadsError('All messages, only mentions, or nothing?', 400);
    if (b.muted !== undefined && typeof b.muted !== 'boolean') throw new ThreadsError('Mute or unmute?', 400);
    if (notify === undefined && b.muted === undefined) throw new ThreadsError('Nothing to change', 400);
    const minutes = b.minutes === undefined ? null : b.minutes;
    if (b.muted === true && !MUTE_TIMERS.includes(minutes as number | null)) throw new ThreadsError('That is not one of the timers', 400);
    const acc = this.able(id, b.accountId, t.network, 'followThreads', 'Thread notifications');
    const until = b.muted === true && typeof minutes === 'number' ? this.now + minutes * 60_000 : undefined;
    const r = await this.ask<P.ThreadFact>(acc, { t: 'threadNotify', conversation: t.nativeId, ...(notify ? { notify } : {}), ...(typeof b.muted === 'boolean' ? { muted: b.muted } : {}), ...(until ? { until } : {}) });
    this.d.note?.(acc.id, `[thread] ${notify ? `notifications: ${notify}` : b.muted ? 'muted' : 'unmuted'} in ${this.name(id)}`);
    return r ?? {};
  }

  /** POST /api/conversations/:id/thread-state { archived?, locked?, accountId? }: checked against a fresh About first. */
  async state(id: string, b: { archived?: unknown; locked?: unknown; accountId?: unknown }): Promise<P.AboutView | P.About> {
    const t = this.conv(id);
    if (t.row.shape !== 'thread') throw new ThreadsError('Only a thread is archived or locked', 400);
    const archived = typeof b.archived === 'boolean' ? b.archived : undefined;
    const locked = typeof b.locked === 'boolean' ? b.locked : undefined;
    if (archived === undefined && locked === undefined) throw new ThreadsError('Archive or lock?', 400);
    const acc = this.able(id, b.accountId, t.network, 'threadState', 'Archiving threads');
    const fresh = (await this.fresh(acc, t.network, t.nativeId)).thread;
    if (!fresh) throw new ThreadsError('That is not a thread here', 409);
    if (archived !== undefined && archived !== fresh.archived && !fresh.canArchive) throw new ThreadsError(fresh.reason ?? 'You may not archive it', 403);
    if (locked !== undefined && locked !== fresh.locked && !fresh.canLock) throw new ThreadsError(fresh.reason ?? 'You may not lock it', 403);
    const about = await this.ask<P.About>(acc, { t: 'threadState', conversation: t.nativeId, ...(archived !== undefined ? { archived } : {}), ...(locked !== undefined ? { locked } : {}) }, 60_000);
    this.d.note?.(acc.id, `[thread] ${[archived === undefined ? '' : archived ? 'archived' : 'unarchived', locked === undefined ? '' : locked ? 'locked' : 'unlocked'].filter(Boolean).join(' and ')} ${this.name(id)}`);
    return this.view(id, t.network, acc, about);
  }

  // ------------------------------------------------------------ starting

  /** POST /api/conversations/:id/threads { name, message?, private?, body?, attachments?, accountId? } */
  async createThread(id: string, b: { name?: unknown; message?: unknown; private?: unknown; body?: unknown; attachments?: unknown; accountId?: unknown }): Promise<P.CreatedThreadView> {
    const t = this.conv(id);
    if (t.row.shape !== 'channel' || t.row.variant === 'forum' || t.row.variant === 'media' || t.row.variant === 'voice' || t.row.variant === 'stage') throw new ThreadsError('Threads start in a text or announcement channel', 400);
    const problem = threadNameProblem(b.name);
    if (problem) throw new ThreadsError(problem, 400);
    let message: string | undefined;
    if (b.message !== undefined) {
      const m = typeof b.message === 'string' ? this.d.store.one<{ conversation_id: string }>('SELECT conversation_id FROM message WHERE id = ?', b.message) : null;
      if (!m || m.conversation_id !== id) throw new ThreadsError('That message is not in this channel', 400);
      message = this.d.store.nativeOf('message', b.message as string)!.nativeId;
    }
    const acc = this.able(id, b.accountId, t.network, 'createThreads', 'Starting threads');
    const { ids, files } = this.files(b.attachments);
    const r = await this.ask<P.CreateThreadResult>(
      acc,
      { t: 'createThread', conversation: t.nativeId, name: (b.name as string).trim(), ...(message ? { message } : {}), ...(b.private === true ? { private: true } : {}), ...(typeof b.body === 'string' && b.body.trim() ? { body: b.body } : {}), ...(files.length ? { attachments: files } : {}) },
      files.length ? 180_000 : 60_000,
    );
    if (ids.length) this.d.uploads?.remove(ids);
    this.d.note?.(acc.id, `[thread] started ${(b.name as string).trim()} in ${this.name(id)}`);
    return { conversationId: hubId('cnv', t.network, r.conversation) };
  }

  /** POST /api/conversations/:id/posts { name, body, tags?, attachments?, accountId? }: a post in a forum. */
  async createPost(id: string, b: { name?: unknown; body?: unknown; tags?: unknown; attachments?: unknown; accountId?: unknown }): Promise<P.CreatedThreadView> {
    const t = this.conv(id);
    if (t.row.variant !== 'forum' && t.row.variant !== 'media') throw new ThreadsError('Posts start in a forum or media channel', 400);
    const forum = threadParts(this.d.store, [t.row as any]).get(id)?.forum ?? null;
    const atts = Array.isArray(b.attachments) ? b.attachments.length : 0;
    const problem = postProblem({ name: b.name, body: b.body, tags: b.tags, files: atts }, forum && forum.tags.length ? forum : null);
    if (problem) throw new ThreadsError(problem, 400);
    if (t.row.variant === 'media' && !atts) throw new ThreadsError('A media channel post starts with a picture or a video', 400);
    const acc = this.able(id, b.accountId, t.network, 'forumPosts', 'Starting forum posts');
    const { ids, files } = this.files(b.attachments);
    const r = await this.ask<P.CreateThreadResult>(
      acc,
      { t: 'createPost', conversation: t.nativeId, name: (b.name as string).trim(), body: typeof b.body === 'string' ? b.body : '', ...(Array.isArray(b.tags) && b.tags.length ? { tags: b.tags as string[] } : {}), ...(files.length ? { attachments: files } : {}) },
      files.length ? 180_000 : 60_000,
    );
    if (ids.length) this.d.uploads?.remove(ids);
    this.d.note?.(acc.id, `[thread] posted ${(b.name as string).trim()} in ${this.name(id)}`);
    return { conversationId: hubId('cnv', t.network, r.conversation) };
  }

  /** POST /api/messages/:id/crosspost { accountId? }: your message in an announcement channel, to its followers. */
  async crosspost(messageId: string, b: { accountId?: unknown }): Promise<{ ok: true }> {
    const m = this.d.store.one<Row>('SELECT conversation_id, author_id FROM message WHERE id = ?', messageId);
    if (!m) throw new ThreadsError('no such message', 404);
    const t = this.conv(m.conversation_id);
    if (t.row.variant !== 'announcement' || t.row.shape !== 'channel') throw new ThreadsError('Only a message in an announcement channel is published', 400);
    const acc = this.able(m.conversation_id, b.accountId, t.network, 'crosspost', 'Publishing');
    await this.ask(acc, { t: 'crosspost', conversation: t.nativeId, message: this.d.store.nativeOf('message', messageId)!.nativeId });
    this.d.note?.(acc.id, `[thread] published a message in ${this.name(m.conversation_id)}`);
    return { ok: true };
  }

  // ------------------------------------------------------------ archived threads

  /** GET /api/conversations/:id/threads?archived=1&mine=1&offset=N: one page, asked of the network on the owner's click. */
  async page(id: string, q: { archived: boolean; mine: boolean; offset: number; accountId?: string | null }): Promise<P.ThreadPageView> {
    const t = this.conv(id);
    if (t.row.shape !== 'channel') throw new ThreadsError('Only a channel has threads', 400);
    let acc: AccountRow;
    try {
      acc = this.able(id, q.accountId ?? undefined, t.network, q.mine ? 'myThreads' : 'listThreads', q.mine ? 'Listing your private threads' : 'Listing threads');
    } catch (e) {
      return { conversationIds: [], more: false, next: null, note: (e as Error).message };
    }
    const offset = Math.max(0, Math.floor(q.offset) || 0);
    const r = await this.ask<P.ThreadsResult>(acc, { t: 'threads', conversation: t.nativeId, archived: q.archived, offset, ...(q.mine ? { mine: true } : {}) }, 60_000);
    if (r?.retryAfterMs) return { conversationIds: [], more: true, next: offset, note: `${NETWORK_META[t.network].name} is still listing this channel's threads: look again in a moment.` };
    // The page's threads as the adapter named them; an older one does not, and then those under the channel, newest first.
    const ids = Array.isArray(r?.ids)
      ? r.ids.map((n) => hubId('cnv', t.network, n))
      : (this.d.store.db.query('SELECT id FROM conversation WHERE parent_id = ? AND archived = ? ORDER BY COALESCE(last_message_at, 0) DESC').all(id, q.archived ? 1 : 0) as Row[]).map((x) => x.id as string);
    const count = r?.count ?? 0;
    return { conversationIds: ids, more: !!r?.more, next: r?.more ? offset + count : null };
  }

  // ------------------------------------------------------------ groups

  /** POST /api/conversations/:id/members/:identityId/(remove|owner) { accountId? }: checked against a fresh About. */
  async member(id: string, identityId: string, op: 'remove' | 'owner', b: { accountId?: unknown }): Promise<P.AboutView | P.About> {
    const t = this.conv(id);
    if (t.row.shape !== 'group') throw new ThreadsError('Only a group has an owner', 400);
    const who = this.d.store.nativeOf('identity', identityId);
    if (!who || who.network !== t.network) throw new ThreadsError('no such person here', 404);
    const acc = this.able(id, b.accountId, t.network, op === 'remove' ? 'removeMembers' : 'transferOwner', op === 'remove' ? 'Removing people' : 'Handing a group over');
    const o = (await this.fresh(acc, t.network, t.nativeId)).ownership;
    if (!o) throw new ThreadsError('This group has no owner here', 409);
    if (op === 'remove' ? !o.canRemove : !o.canTransfer) throw new ThreadsError(o.reason ?? 'You may not do this here', 403);
    const about = await this.ask<P.About>(acc, op === 'remove' ? { t: 'removeMember', target: { kind: 'conversation', nativeId: t.nativeId }, who: who.nativeId } : { t: 'setOwner', target: { kind: 'conversation', nativeId: t.nativeId }, who: who.nativeId });
    const name = this.d.store.one<{ display_name: string | null; handle: string | null }>('SELECT display_name, handle FROM identity WHERE id = ?', identityId);
    this.d.note?.(acc.id, `[group] ${op === 'remove' ? 'removed' : 'handed over to'} ${name?.display_name ?? name?.handle ?? 'someone'} ${op === 'remove' ? 'from' : 'in'} ${this.name(id)}`);
    return this.view(id, t.network, acc, about);
  }

  /** POST /api/conversations/:id/picture { upload: id | null, accountId? }: a group's picture, or none. */
  async picture(id: string, b: { upload?: unknown; accountId?: unknown }): Promise<P.AboutView | P.About> {
    const t = this.conv(id);
    if (t.row.shape !== 'group') throw new ThreadsError('Only a group has a picture to change here', 400);
    if (b.upload !== null && typeof b.upload !== 'string') throw new ThreadsError('Which picture?', 400);
    const acc = this.able(id, b.accountId, t.network, 'groupPicture', 'Changing the picture');
    const fresh = await this.fresh(acc, t.network, t.nativeId);
    if (!fresh.fields.avatar?.canEdit) throw new ThreadsError(fresh.fields.avatar?.reason ?? 'You may not change the picture here', 403);
    const { ids, files } = this.files(b.upload ? [b.upload] : []);
    if (files[0] && !/^image\//.test(files[0].mime)) throw new ThreadsError('A picture is an image', 400);
    const about = await this.ask<P.About>(acc, { t: 'setPicture', target: { kind: 'conversation', nativeId: t.nativeId }, picture: files[0] ?? null }, 120_000);
    if (ids.length) this.d.uploads?.remove(ids);
    this.d.note?.(acc.id, `[group] ${files[0] ? 'changed' : 'removed'} the picture of ${this.name(id)}`);
    return this.view(id, t.network, acc, about);
  }

  // ------------------------------------------------------------ routes

  static handles(path: string): boolean {
    return /^\/api\/conversations\/[\w-]+\/(follow|thread-notify|thread-state|threads|posts|picture|members\/[\w-]+\/(remove|owner))$/.test(path) || /^\/api\/messages\/[\w-]+\/crosspost$/.test(path);
  }

  async route(req: Request, url: URL, path: string): Promise<Response | null> {
    if (!Threads.handles(path)) return null;
    const method = req.method;
    const body = async <T>() => (await req.json().catch(() => ({}))) as T;
    // A write is the owner's click on the hub's own page: a browser sends Origin, and the server has refused any other site's.
    const fromPage = () => {
      if (!req.headers.get('origin')) throw new ThreadsError('This is done from the app itself', 403);
    };
    const done = (v: unknown) => {
      this.d.flush?.();
      return Response.json(v);
    };
    let m: RegExpMatchArray | null;
    try {
      if ((m = path.match(/^\/api\/conversations\/([\w-]+)\/threads$/))) {
        if (method === 'GET') {
          const flag = (k: string) => url.searchParams.get(k) === '1';
          return done(await this.page(m[1], { archived: flag('archived'), mine: flag('mine'), offset: Number(url.searchParams.get('offset') ?? 0), accountId: url.searchParams.get('account') }));
        }
        if (method === 'POST') {
          fromPage();
          return done(await this.createThread(m[1], await body()));
        }
      }
      if (method !== 'POST') return Response.json({ error: 'not found' }, { status: 404 });
      fromPage();
      if ((m = path.match(/^\/api\/conversations\/([\w-]+)\/follow$/))) return done(await this.follow(m[1], await body()));
      if ((m = path.match(/^\/api\/conversations\/([\w-]+)\/thread-notify$/))) return done(await this.notify(m[1], await body()));
      if ((m = path.match(/^\/api\/conversations\/([\w-]+)\/thread-state$/))) return done(await this.state(m[1], await body()));
      if ((m = path.match(/^\/api\/conversations\/([\w-]+)\/posts$/))) return done(await this.createPost(m[1], await body()));
      if ((m = path.match(/^\/api\/conversations\/([\w-]+)\/picture$/))) return done(await this.picture(m[1], await body()));
      if ((m = path.match(/^\/api\/conversations\/([\w-]+)\/members\/([\w-]+)\/(remove|owner)$/))) return done(await this.member(m[1], m[2], m[3] as 'remove' | 'owner', await body()));
      if ((m = path.match(/^\/api\/messages\/([\w-]+)\/crosspost$/))) return done(await this.crosspost(m[1], await body()));
    } catch (e) {
      if (e instanceof ThreadsError) return Response.json({ error: e.message }, { status: e.status });
      throw e;
    }
    return Response.json({ error: 'not found' }, { status: 404 });
  }
}
