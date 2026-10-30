/**
 * The Matrix adapter: one Client-Server API session per hub account.
 *
 *   login (password -> access token, saved to secret.json) or whoami
 *   /sync loop with a lazy-loading filter, resuming from the stored since token
 *   joined-room state -> SpaceFact / ConversationFact / IdentityFact
 *   timeline events -> MessageFact, reaction, delete, read, typing
 *   hub commands -> send, history, markRead, react, edit, redact, fetchMedia, actions
 *
 * Initial sync emits facts with live=false (backfill, no notifications);
 * incremental syncs emit live=true.
 */

import { join } from 'node:path';
import type * as P from '@dither-chat/protocol';
import type { HubLink } from '@dither-chat/protocol/client';
import { AdapterDb, type ThreadRow } from './db.ts';
import { markdownToMatrix, snippet } from './format.ts';
import { enc, MatrixClient, MatrixError } from './http.ts';
import { isRedacted, mentionsUser, MESSAGE_TYPES, plainTextOf, relationOf, renderContent, replyTarget, type Relation } from './messages.ts';
import { Directory, Room, STRUCTURAL, type MxEvent } from './rooms.ts';

export const VERSION = '0.1.0';
const CAPABILITIES: P.Capability[] = ['send', 'history', 'react', 'edit', 'redact', 'markRead', 'threads', 'media'];

const SYNC_TIMEOUT = 30_000;
const TIMELINE_LIMIT = 50;
const GAP_PAGES = 4;
const MAX_MEDIA = 24 * 1024 * 1024;
const KEEP_EVENTS = 200_000;
const BACKOFF = [1, 2, 5, 10, 30, 60];

const FILTER = {
  room: {
    state: { lazy_load_members: true },
    timeline: { limit: TIMELINE_LIMIT, lazy_load_members: true, unread_thread_notifications: true },
    ephemeral: { types: ['m.receipt', 'm.typing'] },
    account_data: { types: ['m.fully_read'] },
  },
  presence: { not_types: ['*'] },
  account_data: { types: ['m.direct', 'm.push_rules'] },
};
const FILTER_KEY = `filter:${Bun.hash(JSON.stringify(FILTER)).toString(36)}`;
const LAZY = JSON.stringify({ lazy_load_members: true });

interface Config {
  homeserver?: string;
  userId?: string;
}

interface Secret {
  password?: string;
  accessToken?: string;
  deviceId?: string;
  userId?: string;
}

type Mode = 'sync' | 'gap' | 'history' | 'fetch';
interface Ctx {
  live: boolean;
  mode: Mode;
  /** Message facts emitted (history replies with this). */
  count: number;
}

class NeedsLogin extends Error {}
class Restart extends Error {}

const describe = (e: unknown) => (e instanceof MatrixError ? `${e.errcode}: ${e.error}` : String((e as any)?.message ?? e));
const threadId = (roomId: string, root: string) => `${roomId}|${root}`;

export function splitConversation(id: string): { roomId: string; root?: string } {
  const i = id.indexOf('|');
  return i < 0 ? { roomId: id } : { roomId: id.slice(0, i), root: id.slice(i + 1) };
}

export class MatrixAdapter {
  private hub!: HubLink;
  private db!: AdapterDb;
  private config: Config = {};
  private dir = new Directory('');
  private client: MatrixClient | null = null;
  private selfId = '';
  private deviceId = '';
  private self: P.IdentityFact | null = null;
  private status: P.AccountStatus = 'connecting';
  private attention: Omit<P.Attention, 'since'> | null = null;
  /** Last JSON emitted per fact key, so unchanged structure isn't re-sent every sync. */
  private emitted = new Map<string, string>();
  private pendingIdentities = new Map<string, P.IdentityFact>();
  private recentTs = new Map<string, number>();
  private announcedInvites = new Set<string>();
  private syncAbort: AbortController | null = null;
  private restartSession = false;
  private wakeUp: (() => void) | null = null;
  private resyncWaiters: ((rooms: number) => void)[] = [];
  private online = false;
  private stopped = false;

  // ================================================================ lifecycle

  start(hub: HubLink) {
    this.hub = hub;
    this.config = hub.config as Config;
    this.db = new AdapterDb(join(hub.accountDir, 'matrix.sqlite'));
    for (const r of this.db.loadRooms()) this.dir.rooms.set(r.id, r);
    this.dir.setDirect(JSON.parse(this.db.get('m.direct') ?? '{}'));
    this.dir.pushRules = JSON.parse(this.db.get('m.push_rules') ?? 'null');
    const pruned = this.db.prune(KEEP_EVENTS);
    if (pruned) this.log('info', `pruned ${pruned} old events from the local index`);
    this.run().catch((e) => this.log('error', `adapter loop crashed: ${describe(e)}`));
  }

  /** Every (re)connect to the hub: hello, status, and a snapshot of the structure. */
  onConnect() {
    this.hub.emit({ t: 'hello', network: 'matrix', version: VERSION, capabilities: CAPABILITIES });
    this.emitStatus();
    if (!this.selfId) return;
    this.emitted.clear();
    this.emitStructure();
    this.emitThreads();
  }

  async shutdown() {
    this.stopped = true;
    this.syncAbort?.abort();
    this.wakeUp?.();
    try {
      this.db?.close();
    } catch {}
  }

  private log(level: 'debug' | 'info' | 'warn' | 'error', msg: string, data?: unknown) {
    // The hub appends these to adapter.log; only fall back to stdout (also captured there) while disconnected.
    if (this.hub.connected) this.hub.emit({ t: 'log', level, msg, ...(data !== undefined ? { data } : {}) });
    else if (level !== 'debug') console.log(`[${level}] ${msg}${data !== undefined ? ' ' + JSON.stringify(data) : ''}`);
  }

  private emitStatus() {
    this.hub.emit({ t: 'status', status: this.status, attention: this.attention, ...(this.self ? { self: this.self } : {}) });
  }

  private setStatus(status: P.AccountStatus, attention: Omit<P.Attention, 'since'> | null) {
    if (status === this.status && JSON.stringify(attention) === JSON.stringify(this.attention)) return;
    this.status = status;
    this.attention = attention;
    this.emitStatus();
  }

  private sleep(ms: number) {
    return new Promise<void>((r) => {
      const t = setTimeout(r, ms);
      this.wakeUp = () => {
        clearTimeout(t);
        r();
      };
    }).finally(() => (this.wakeUp = null));
  }

  private async run() {
    let failures = 0;
    while (!this.stopped) {
      try {
        await this.session();
        failures = 0;
        await this.syncLoop();
      } catch (e) {
        if (this.stopped) return;
        if (e instanceof Restart) continue;
        if (e instanceof NeedsLogin) {
          this.online = false;
          this.log('warn', `needs login: ${e.message}`);
          this.setStatus('attention', { kind: 'login', message: e.message });
          await this.waitForCredentials();
          continue;
        }
        failures++;
        const delay = BACKOFF[Math.min(failures - 1, BACKOFF.length - 1)];
        this.log('warn', `homeserver session failed (${describe(e)}); retrying in ${delay}s`);
        if (failures >= 3) this.setStatus('error', { kind: 'unknown', message: `Cannot reach the homeserver: ${describe(e)}` });
        else this.setStatus('connecting', null);
        await this.sleep(delay * 1000);
      }
    }
  }

  /** In attention: wait for the relogin action or an edited secret.json. */
  private async waitForCredentials() {
    const before = JSON.stringify(this.hub.secret());
    while (!this.stopped) {
      await this.sleep(15_000);
      if (this.restartSession) {
        this.restartSession = false;
        return;
      }
      if (JSON.stringify(this.hub.secret()) !== before) return;
    }
  }

  // ================================================================ session

  private async homeserver(userHint?: string): Promise<string> {
    const cfg = typeof this.config.homeserver === 'string' ? this.config.homeserver.trim().replace(/\/+$/, '') : '';
    if (cfg) return /^https?:\/\//.test(cfg) ? cfg : `https://${cfg}`;
    const server = userHint?.split(':').slice(1).join(':');
    if (!server) throw new NeedsLogin('Set "homeserver" (and "userId") in the account config.');
    try {
      const res = await fetch(`https://${server}/.well-known/matrix/client`, { signal: AbortSignal.timeout(10_000) });
      const base = res.ok ? ((await res.json()) as any)?.['m.homeserver']?.base_url : null;
      if (typeof base === 'string' && /^https?:\/\//.test(base)) return base.replace(/\/+$/, '');
    } catch {}
    return `https://${server}`;
  }

  private async session() {
    this.restartSession = false;
    const secret = this.hub.secret<Secret>();
    const userHint = secret.userId ?? this.config.userId;
    const client = new MatrixClient(await this.homeserver(userHint));
    if (secret.accessToken) {
      client.accessToken = secret.accessToken;
      try {
        const who = await client.request('GET', '/_matrix/client/v3/account/whoami');
        this.adopt(client, who.user_id, who.device_id ?? secret.deviceId ?? '');
      } catch (e) {
        if (!(e instanceof MatrixError && e.isAuth)) throw e;
        if (!secret.password) {
          throw new NeedsLogin(`The homeserver rejected the access token (${e.errcode}). Run the "relogin" action with {"password": "..."}.`);
        }
        this.log('info', 'access token rejected; logging in with the stored password');
        await this.login(client, secret, userHint);
      }
    } else if (secret.password) {
      await this.login(client, secret, userHint);
    } else {
      throw new NeedsLogin('No password or access token in secret.json.');
    }

    let profile: { displayname?: string; avatar_url?: string } = {};
    try {
      profile = await client.request('GET', `/_matrix/client/v3/profile/${enc(this.selfId)}`, { retries: 1 });
    } catch (e) {
      this.log('debug', `profile lookup failed: ${describe(e)}`);
    }
    this.self = { nativeId: this.selfId, handle: this.selfId, isSelf: true };
    if (profile.displayname) this.self.displayName = profile.displayname;
    if (typeof profile.avatar_url === 'string' && profile.avatar_url.startsWith('mxc://')) this.self.avatarUrl = profile.avatar_url;
    this.attention = null;
    this.status = this.online ? 'online' : 'connecting';
    this.emitStatus();
    this.log('info', `session ready: ${this.selfId} device ${this.deviceId} on ${client.baseUrl}`);
  }

  private async login(client: MatrixClient, secret: Secret, user: string | undefined) {
    if (!user) throw new NeedsLogin('Set "userId" in the account config or secret to log in with a password.');
    let res: any;
    try {
      res = await client.request('POST', '/_matrix/client/v3/login', {
        auth: false,
        retries: 2,
        body: {
          type: 'm.login.password',
          identifier: { type: 'm.id.user', user },
          password: secret.password,
          initial_device_display_name: 'dither-chat',
          ...(secret.deviceId ? { device_id: secret.deviceId } : {}),
        },
      });
    } catch (e) {
      if (e instanceof MatrixError && (e.status === 403 || e.errcode === 'M_FORBIDDEN' || e.errcode === 'M_USER_DEACTIVATED' || e.errcode === 'M_INVALID_USERNAME')) {
        throw new NeedsLogin(`Login failed: ${e.error}`);
      }
      throw e;
    }
    client.accessToken = res.access_token;
    const { password: _dropped, ...rest } = secret;
    this.hub.saveSecret({ ...rest, userId: res.user_id, accessToken: res.access_token, deviceId: res.device_id });
    this.log('info', `logged in as ${res.user_id} (device ${res.device_id}); password removed from secret.json`);
    this.adopt(client, res.user_id, res.device_id);
  }

  private adopt(client: MatrixClient, userId: string, deviceId: string) {
    const prev = this.db.get('user');
    if (prev && prev !== userId) {
      this.log('warn', `account changed from ${prev} to ${userId}; dropping local sync state`);
      this.db.tx(() => {
        for (const t of ['kv', 'room', 'state', 'event', 'edit', 'reaction', 'thread']) this.db.db.query(`DELETE FROM ${t}`).run();
      });
      this.dir.rooms.clear();
      this.dir.setDirect({});
      this.dir.pushRules = null;
    }
    this.db.set('user', userId);
    this.client = client;
    this.selfId = userId;
    this.deviceId = deviceId;
    this.dir.selfId = userId;
    if (this.config.userId && this.config.userId !== userId) this.log('warn', `config userId ${this.config.userId} differs from the logged-in ${userId}`);
  }

  private api(): MatrixClient {
    if (!this.client || !this.selfId) throw new Error('not logged in to the homeserver yet');
    return this.client;
  }

  // ================================================================ sync loop

  private async filterId(): Promise<string> {
    const cached = this.db.get(FILTER_KEY);
    if (cached) return cached;
    const res = await this.api().request('POST', `/_matrix/client/v3/user/${enc(this.selfId)}/filter`, { body: FILTER });
    this.db.set(FILTER_KEY, res.filter_id);
    return res.filter_id;
  }

  private async hubReady() {
    while (!this.hub.connected && !this.stopped) await Bun.sleep(250);
  }

  private async syncLoop() {
    let filter = await this.filterId();
    let failures = 0;
    while (!this.stopped) {
      await this.hubReady();
      if (this.restartSession) throw new Restart();
      const since = this.db.get('since');
      const initial = !since;
      const ac = new AbortController();
      this.syncAbort = ac;
      let res: any;
      const t0 = Date.now();
      try {
        res = await this.api().request('GET', '/_matrix/client/v3/sync', {
          // The first sync of a session returns at once, so the account shows online without waiting out a long poll.
          query: { filter, since: since ?? undefined, timeout: initial || !this.online ? 0 : SYNC_TIMEOUT, set_presence: 'offline' },
          timeoutMs: initial ? 300_000 : SYNC_TIMEOUT + 30_000,
          signal: ac.signal,
          retries: 0,
        });
      } catch (e) {
        if (this.stopped) return;
        if (this.restartSession) throw new Restart();
        if (ac.signal.aborted) continue; // resync requested
        if (e instanceof MatrixError) {
          if (e.isAuth) throw new NeedsLogin(`The homeserver ended the session (${e.errcode}: ${e.error}). Run the "relogin" action with {"password": "..."}.`);
          if (e.isRateLimit) {
            await this.sleep(Math.min(e.retryAfterMs ?? 5000, 120_000));
            continue;
          }
          if (/filter/i.test(e.error) && e.status === 400) {
            this.db.set(FILTER_KEY, null);
            filter = await this.filterId();
            continue;
          }
        }
        failures++;
        const delay = BACKOFF[Math.min(failures - 1, BACKOFF.length - 1)];
        this.log('warn', `sync failed (${describe(e)}); retrying in ${delay}s`);
        if (failures >= 4) this.setStatus('error', { kind: 'unknown', message: `Sync keeps failing: ${describe(e)}` });
        else if (!this.online) this.setStatus('connecting', null);
        await this.sleep(delay * 1000);
        continue;
      } finally {
        if (this.syncAbort === ac) this.syncAbort = null;
      }
      failures = 0;
      const fetched = Date.now() - t0;
      await this.processSync(res, initial);
      this.db.set('since', res.next_batch);
      if (initial) {
        const rooms = this.dir.joined().length;
        this.log('info', `initial sync: ${rooms} joined rooms (fetched in ${fetched}ms, processed in ${Date.now() - t0 - fetched}ms)`);
        for (const w of this.resyncWaiters.splice(0)) w(rooms);
      }
      if (!this.online || this.status !== 'online') {
        this.online = true;
        this.setStatus('online', null);
      }
    }
  }

  // ================================================================ sync processing

  private async processSync(res: any, initial: boolean) {
    const ctx: Ctx = { live: !initial, mode: 'sync', count: 0 };
    let structural = initial;

    for (const ev of res.account_data?.events ?? []) {
      if (ev?.type === 'm.direct') {
        this.dir.setDirect(ev.content ?? {});
        this.db.set('m.direct', JSON.stringify(ev.content ?? {}));
        structural = true;
      } else if (ev?.type === 'm.push_rules') {
        this.dir.pushRules = ev.content ?? null;
        this.db.set('m.push_rules', JSON.stringify(ev.content ?? null));
        structural = true;
      }
    }

    const joins = Object.entries<any>(res.rooms?.join ?? {});
    const newRooms = new Set(joins.map(([id]) => id).filter((id) => !this.dir.rooms.has(id)));
    const touched: Room[] = [];
    this.db.tx(() => {
      for (const [id, jr] of joins) {
        const room = this.dir.room(id);
        if (room.membership !== 'join') {
          room.membership = 'join';
          structural = true;
        }
        if (jr.summary && typeof jr.summary === 'object') {
          const s = { ...room.summary };
          if (Array.isArray(jr.summary['m.heroes'])) s.heroes = jr.summary['m.heroes'];
          if (typeof jr.summary['m.joined_member_count'] === 'number') s.joined = jr.summary['m.joined_member_count'];
          if (typeof jr.summary['m.invited_member_count'] === 'number') s.invited = jr.summary['m.invited_member_count'];
          if (JSON.stringify(s) !== JSON.stringify(room.summary)) {
            room.summary = s;
            structural = true;
          }
        }
        for (const ev of jr.state?.events ?? []) if (this.applyState(room, ev)) structural = true;
        for (const ev of jr.timeline?.events ?? []) if (ev?.state_key !== undefined && this.applyState(room, ev)) structural = true;
        if (room.backToken === null && typeof jr.timeline?.prev_batch === 'string') room.backToken = jr.timeline.prev_batch;
        touched.push(room);
      }
    });

    for (const [id] of Object.entries<any>(res.rooms?.leave ?? {})) {
      const room = this.dir.rooms.get(id);
      if (!room) continue;
      this.leaveRoom(room);
      structural = true;
    }
    for (const id of Object.keys(res.rooms?.invite ?? {})) {
      if (this.announcedInvites.has(id)) continue;
      this.announcedInvites.add(id);
      this.log('info', `pending invite to ${id} (accept it in a Matrix client; invites are not shown in the hub yet)`);
    }

    if (structural) {
      await this.loadMembers();
      this.emitStructure();
    } else this.flushIdentities();

    for (const [id, jr] of joins) {
      const room = this.dir.room(id);
      const before = room.latestEvent;
      const events: MxEvent[] = jr.timeline?.events ?? [];
      if (!initial && newRooms.has(id)) {
        // A room that just appeared: what happened before we joined is history, not news.
        let joinedAt = -1;
        events.forEach((e, i) => {
          if (e?.type === 'm.room.member' && e.state_key === this.selfId && e.content?.membership === 'join') joinedAt = i;
        });
        await this.processTimeline(room, events.slice(0, joinedAt + 1 || events.length), { ...ctx, live: false });
        if (joinedAt >= 0) await this.processTimeline(room, events.slice(joinedAt + 1), ctx);
      } else {
        await this.processTimeline(room, events, ctx);
      }
      if (events.length) room.latestEvent = events[events.length - 1].event_id;
      if (!initial && before && jr.timeline?.limited && typeof jr.timeline.prev_batch === 'string') await this.fillGap(room, jr.timeline.prev_batch, before);
    }
    for (const [id, jr] of joins) {
      const room = this.dir.rooms.get(id);
      if (!room) continue;
      this.readState(room, jr);
      if (!initial) this.typing(room, jr);
    }
    if (initial) this.emitThreads();
    this.db.tx(() => {
      for (const room of touched) if (this.dir.rooms.has(room.id)) this.db.saveRoom(room);
    });
    // Threads whose activity is older than the sync window would otherwise only appear on scrollback.
    const discover = initial ? this.dir.joined() : [...newRooms].map((id) => this.dir.rooms.get(id)).filter((r): r is Room => !!r);
    if (discover.length) await this.discoverThreads(discover);
  }

  /** Recent threads per room (GET /threads): thread conversations plus their roots. */
  private async discoverThreads(rooms: Room[]) {
    const queue = rooms.filter((r) => !r.isSpace && r.membership === 'join');
    let unsupported = false;
    const worker = async () => {
      for (let room = queue.shift(); room && !unsupported; room = queue.shift()) {
        try {
          const res: any = await this.api().request('GET', `/_matrix/client/v1/rooms/${enc(room.id)}/threads`, { query: { limit: 10, include: 'all' }, retries: 1 });
          for (const root of res.chunk ?? []) {
            if (!root?.event_id || typeof root.type !== 'string' || this.db.thread(threadId(room.id, root.event_id))) continue;
            const ctx: Ctx = { live: false, mode: 'fetch', count: 0 };
            await this.ensureThread(room, root.event_id, ctx, root);
            await this.processEvent(room, root, ctx);
          }
        } catch (e) {
          // An unknown endpoint (old server) turns discovery off; other errors only skip the room.
          if (e instanceof MatrixError && (e.errcode === 'M_UNRECOGNIZED' || (e.status === 404 && e.errcode === 'HTTP_404'))) unsupported = true;
          else this.log('debug', `thread discovery in ${room.id} failed: ${describe(e)}`);
        }
      }
    };
    await Promise.all([worker(), worker(), worker(), worker()]);
  }

  /** Apply one state event. Returns true if it changes how rooms are presented. */
  private applyState(room: Room, ev: MxEvent): boolean {
    if (!ev || typeof ev.type !== 'string' || typeof ev.state_key !== 'string' || !ev.event_id) return false;
    if (!room.setState(ev)) return false;
    this.db.saveState(room.id, ev);
    if (ev.type === 'm.room.member' && ev.state_key !== this.selfId) {
      const m = ev.content?.membership;
      if (m === 'join' || m === 'invite') this.pendingIdentities.set(ev.state_key, this.dir.identity(room, ev.state_key));
    }
    return STRUCTURAL.has(ev.type);
  }

  /** Lazy loading only sends members who speak; small rooms get their full member list once. */
  private async loadMembers() {
    const need = this.dir.joined().filter((r) => {
      if (r.membersLoaded || r.isSpace) return false;
      const p = this.dir.place(r);
      return p.kind === 'conversation' && (p.shape === 'direct' || p.shape === 'group' || p.shape === 'self');
    });
    for (let i = 0; i < need.length; i += 8) {
      await Promise.all(
        need.slice(i, i + 8).map(async (room) => {
          try {
            const res = await this.api().request('GET', `/_matrix/client/v3/rooms/${enc(room.id)}/joined_members`);
            this.db.tx(() => {
              for (const [user, info] of Object.entries<any>(res.joined ?? {})) {
                const ev: MxEvent = {
                  type: 'm.room.member',
                  state_key: user,
                  event_id: `~joined:${user}`,
                  sender: user,
                  origin_server_ts: 0,
                  content: {
                    membership: 'join',
                    ...(typeof info?.display_name === 'string' ? { displayname: info.display_name } : {}),
                    ...(typeof info?.avatar_url === 'string' ? { avatar_url: info.avatar_url } : {}),
                  },
                };
                this.applyState(room, ev);
              }
              room.membersLoaded = true;
              this.db.saveRoom(room);
            });
          } catch (e) {
            this.log('warn', `could not load members of ${room.id}: ${describe(e)}`);
          }
        }),
      );
    }
  }

  // ================================================================ structure facts

  private emitOnce(key: string, value: unknown, ev: () => P.AdapterEvent): boolean {
    const json = JSON.stringify(value);
    if (this.emitted.get(key) === json) return false;
    this.emitted.set(key, json);
    this.hub.emit(ev());
    return true;
  }

  private emitIdentity(f: P.IdentityFact, onlyIfNew = false) {
    if (f.nativeId === this.selfId) return;
    if (onlyIfNew && this.emitted.has(`idn:${f.nativeId}`)) return;
    this.emitOnce(`idn:${f.nativeId}`, f, () => ({ t: 'identity', identity: f }));
  }

  private flushIdentities() {
    for (const f of this.pendingIdentities.values()) this.emitIdentity(f);
    this.pendingIdentities.clear();
  }

  private emitConversation(f: P.ConversationFact): boolean {
    return this.emitOnce(`cnv:${f.nativeId}`, f, () => ({ t: 'conversation', conversation: f }));
  }

  /** Spaces, then rooms (with their participants' identities). Only changed facts are sent. */
  private emitStructure() {
    this.flushIdentities();
    const rooms = this.dir.joined();
    for (const room of rooms) {
      if (!room.isSpace) continue;
      const f = this.dir.spaceFact(room);
      this.emitOnce(`spc:${room.id}`, f, () => ({ t: 'space', space: f }));
    }
    for (const room of rooms) {
      const place = this.dir.place(room);
      if (place.kind !== 'conversation') continue;
      const f = this.dir.conversationFact(room, place.shape);
      for (const u of f.participants ?? []) this.emitIdentity(this.dir.identity(room, u), true);
      if (place.shape === 'direct') this.emitIdentity(this.dir.identity(room, this.dir.peerOf(room)!));
      if (this.emitConversation(f) && f.mute) {
        room.lastMute = JSON.stringify(f.mute);
        this.db.saveRoom(room);
      }
    }
  }

  private emitThreadFact(t: ThreadRow) {
    const f: P.ConversationFact = { nativeId: t.id, shape: 'thread', variant: 'text', name: t.name || 'Thread', parentConversation: t.room };
    if (this.dir.rooms.get(t.room)?.encrypted) f.encrypted = true;
    this.emitConversation(f);
  }

  private emitThreads() {
    for (const t of this.db.threads()) if (this.dir.rooms.get(t.room)?.membership === 'join') this.emitThreadFact(t);
  }

  private leaveRoom(room: Room) {
    this.hub.emit({ t: 'leave', kind: room.isSpace ? 'space' : 'conversation', nativeId: room.id });
    for (const t of this.db.threadsOf(room.id)) {
      this.hub.emit({ t: 'leave', kind: 'conversation', nativeId: t.id });
      this.emitted.delete(`cnv:${t.id}`);
    }
    this.emitted.delete(`${room.isSpace ? 'spc' : 'cnv'}:${room.id}`);
    this.dir.rooms.delete(room.id);
    this.db.deleteRoom(room.id);
    this.log('info', `left ${room.isSpace ? 'space' : 'room'} ${room.id}`);
  }

  // ================================================================ timeline -> facts

  private noteTs(ev: MxEvent) {
    this.recentTs.set(ev.event_id, ev.origin_server_ts);
    if (this.recentTs.size > 20_000) {
      const drop = [...this.recentTs.keys()].slice(0, 5_000);
      for (const k of drop) this.recentTs.delete(k);
    }
  }

  private eventTs(id: string): number | null {
    return this.recentTs.get(id) ?? this.db.event(id)?.ts ?? null;
  }

  private async processTimeline(room: Room, events: MxEvent[], ctx: Ctx) {
    for (const ev of events) {
      try {
        await this.processEvent(room, ev, ctx);
      } catch (e) {
        this.log('warn', `could not process ${ev?.type} ${ev?.event_id} in ${room.id}: ${describe(e)}`);
      }
    }
  }

  private async processEvent(room: Room, ev: MxEvent, ctx: Ctx) {
    if (!ev?.event_id || typeof ev.type !== 'string' || typeof ev.sender !== 'string') return;
    ev.content ??= {};
    this.noteTs(ev);
    if (ev.state_key !== undefined) {
      this.db.putEvent(ev, room.id, room.id, false);
      return;
    }
    if (isRedacted(ev)) return this.redactedEvent(room, ev, ctx);
    switch (ev.type) {
      case 'm.reaction':
        return this.reactionEvent(room, ev);
      case 'm.room.redaction':
        return this.redactionEvent(room, ev, ctx);
      default:
        if (MESSAGE_TYPES.has(ev.type)) return this.messageEvent(room, ev, ctx);
        this.db.putEvent(ev, room.id, room.id, false);
    }
  }

  /** The conversation a message-like event lives in: the room, or its thread. */
  private async conversationOf(room: Room, ev: MxEvent, rel: Relation, ctx: Ctx): Promise<string> {
    if (rel.relType === 'm.thread' && rel.eventId && rel.eventId !== ev.event_id) return this.ensureThread(room, rel.eventId, ctx);
    return room.id;
  }

  private async messageEvent(room: Room, ev: MxEvent, ctx: Ctx) {
    const rel = relationOf(ev.content);
    if (rel.relType === 'm.replace' && rel.eventId) {
      if (ev.type === 'm.room.encrypted') this.db.putEvent(ev, room.id, room.id, false);
      else await this.editEvent(room, ev, rel, ctx);
      return;
    }
    const conv = await this.conversationOf(room, ev, rel, ctx);
    // A thread root: the server bundles a thread summary into it.
    if (conv === room.id && ev.unsigned?.['m.relations']?.['m.thread']) await this.ensureThread(room, ev.event_id, ctx, ev);
    this.db.putEvent(ev, room.id, conv, true);
    const f = this.buildMessage(room, ev, conv, ctx);
    if (f) {
      this.hub.emit({ t: 'message', message: f, live: ctx.live });
      ctx.count++;
    }
    if (conv !== room.id) this.bumpThread(conv, ev);
  }

  /** The latest valid replacement of a message, from our index or bundled by the server. */
  private latestEdit(ev: MxEvent): { content: any; ts: number } | null {
    const row = this.db.edit(ev.event_id);
    let best = row && row.sender === ev.sender ? { content: JSON.parse(row.content), ts: row.ts, id: row.id } : null;
    const bundled = ev.unsigned?.['m.relations']?.['m.replace'];
    const nc = bundled?.content?.['m.new_content'];
    if (bundled && bundled.sender === ev.sender && nc && typeof nc === 'object' && typeof bundled.event_id === 'string') {
      const ts = Number(bundled.origin_server_ts) || 0;
      if (!best || ts > best.ts) {
        best = { content: nc, ts, id: bundled.event_id };
        this.db.putEdit({ target: ev.event_id, id: bundled.event_id, sender: bundled.sender, ts, content: JSON.stringify(nc) });
      }
    }
    return best;
  }

  private reactionSnapshot(target: string): { key: string; authors: string[] }[] {
    const by = new Map<string, Set<string>>();
    for (const r of this.db.reactionsFor(target)) (by.get(r.key) ?? by.set(r.key, new Set()).get(r.key)!).add(r.sender);
    return [...by].map(([key, authors]) => ({ key, authors: [...authors] }));
  }

  private buildMessage(room: Room, ev: MxEvent, conv: string, ctx: Ctx): P.MessageFact | null {
    const rel = relationOf(ev.content);
    const edit = this.latestEdit(ev);
    const rendered = renderContent(ev.type, edit ? edit.content : ev.content, edit ? false : !!rel.inReplyTo);
    if (!rendered) return null;
    const f: P.MessageFact = { nativeId: ev.event_id, conversation: conv, author: ev.sender, ts: ev.origin_server_ts, kind: rendered.kind, body: rendered.body };
    if (edit) f.editedTs = edit.ts;
    const reply = replyTarget(rel);
    if (reply) f.replyTo = reply;
    if (rendered.attachments?.length) f.attachments = rendered.attachments;
    if (rendered.extra) f.extra = rendered.extra;
    if (ev.sender !== this.selfId && (mentionsUser(ev.content, this.selfId) || (edit && mentionsUser(edit.content, this.selfId)))) f.mentionsSelf = true;
    const thread = threadId(room.id, ev.event_id);
    if (conv === room.id && this.db.thread(thread)) f.threadRoot = thread;
    // Backfill: reactions seen earlier (in newer events) would otherwise have been dropped by the hub.
    if (ctx.mode !== 'sync') {
      const reactions = this.reactionSnapshot(ev.event_id);
      if (reactions.length) f.reactions = reactions;
    }
    return f;
  }

  private threadName(room: Room, root: MxEvent | null): string {
    if (!root) return 'Thread';
    const edit = this.latestEdit(root);
    const text = edit && typeof edit.content.body === 'string' ? edit.content.body : plainTextOf(root);
    return snippet(text, 60, (u) => room.memberName(u) ?? u) || 'Thread';
  }

  /** Make sure a thread conversation exists (its fact is emitted before its messages). */
  private async ensureThread(room: Room, rootId: string, ctx: Ctx, rootEv?: MxEvent): Promise<string> {
    const id = threadId(room.id, rootId);
    const existing = this.db.thread(id);
    if (existing) {
      if (!this.emitted.has(`cnv:${id}`)) this.emitThreadFact(existing);
      return id;
    }
    let root = rootEv ?? this.db.eventJson(rootId);
    if (!root) root = await this.fetchEvent(room.id, rootId);
    const t: ThreadRow = { id, room: room.id, root: rootId, name: this.threadName(room, root), latest: null, latest_ts: 0, back_token: null, done: 0 };
    this.db.putThread(t);
    this.emitThreadFact(t);
    // The root lives in the parent room; (re-)emit it so it points at its thread.
    if (!rootEv && root && !isRedacted(root)) {
      this.db.putEvent(root, room.id, room.id, true);
      const f = this.buildMessage(room, root, room.id, { ...ctx, mode: 'fetch' });
      if (f) this.hub.emit({ t: 'message', message: f, live: false });
    }
    return id;
  }

  private bumpThread(id: string, ev: MxEvent) {
    const t = this.db.thread(id);
    if (t && ev.origin_server_ts >= t.latest_ts) this.db.putThread({ ...t, latest: ev.event_id, latest_ts: ev.origin_server_ts });
  }

  private async fetchEvent(roomId: string, eventId: string): Promise<MxEvent | null> {
    try {
      const ev = await this.api().request<MxEvent>('GET', `/_matrix/client/v3/rooms/${enc(roomId)}/event/${enc(eventId)}`, { retries: 1 });
      if (ev?.event_id) this.noteTs(ev);
      return ev?.event_id ? ev : null;
    } catch (e) {
      this.log('debug', `could not fetch ${eventId} in ${roomId}: ${describe(e)}`);
      return null;
    }
  }

  private async editEvent(room: Room, ev: MxEvent, rel: Relation, ctx: Ctx) {
    this.db.putEvent(ev, room.id, room.id, false);
    const target = rel.eventId!;
    const nc = ev.content['m.new_content'];
    if (!nc || typeof nc !== 'object') return;
    const row = this.db.event(target);
    if (row && row.sender !== ev.sender) return; // only the author can edit
    if (!this.db.putEdit({ target, id: ev.event_id, sender: ev.sender, ts: ev.origin_server_ts, content: JSON.stringify(nc) })) return;
    if (row?.redacted) return;
    if (row?.json) {
      const original = JSON.parse(row.json) as MxEvent;
      const f = this.buildMessage(room, original, row.conv, ctx);
      if (f) this.hub.emit({ t: 'message', message: f, live: ctx.live });
      return;
    }
    // Older than anything we have: when backfilling it will be paged in (and pick the edit up); otherwise fetch it.
    if (ctx.mode === 'history') return;
    const original = await this.fetchEvent(room.id, target);
    if (original && original.sender === ev.sender && !isRedacted(original)) await this.messageEvent(room, original, { live: false, mode: 'fetch', count: 0 });
  }

  private reactionEvent(room: Room, ev: MxEvent) {
    this.db.putEvent(ev, room.id, room.id, false);
    const rel = relationOf(ev.content);
    if (rel.relType !== 'm.annotation' || !rel.eventId || !rel.key) return;
    this.db.putReaction({ id: ev.event_id, room: room.id, target: rel.eventId, key: rel.key, sender: ev.sender, ts: ev.origin_server_ts });
    const conv = this.db.event(rel.eventId)?.conv ?? room.id;
    this.hub.emit({ t: 'reaction', conversation: conv, message: rel.eventId, author: ev.sender, key: rel.key });
  }

  private async redactionEvent(room: Room, ev: MxEvent, ctx: Ctx) {
    this.db.putEvent(ev, room.id, room.id, false);
    const target = typeof ev.redacts === 'string' ? ev.redacts : ev.content?.redacts;
    if (typeof target === 'string') await this.applyRedaction(room, target);
  }

  private async applyRedaction(room: Room, target: string) {
    const rx = this.db.reaction(target);
    if (rx) {
      this.db.deleteReaction(target);
      if (!this.db.reactionsBy(rx.target, rx.sender, rx.key).length) {
        const conv = this.db.event(rx.target)?.conv ?? rx.room;
        this.hub.emit({ t: 'reaction', conversation: conv, message: rx.target, author: rx.sender, key: rx.key, remove: true });
      }
      return;
    }
    const edited = this.db.dropEdit(target);
    if (edited) {
      // An edit was redacted: show the previous version again (the server bundles the latest remaining edit).
      const row = this.db.event(edited);
      const original = await this.fetchEvent(room.id, edited);
      if (original && !row?.redacted) await this.messageEvent(room, original, { live: false, mode: 'fetch', count: 0 });
      return;
    }
    const row = this.db.event(target);
    if (row?.redacted) return;
    if (row && !MESSAGE_TYPES.has(row.type)) return;
    this.db.markRedacted(target);
    this.hub.emit({ t: 'delete', conversation: row?.conv ?? room.id, nativeId: target });
  }

  /** A message we see only in its redacted form: a tombstone, so the timeline shows "deleted". */
  private async redactedEvent(room: Room, ev: MxEvent, ctx: Ctx) {
    if (ev.type === 'm.reaction') {
      if (this.db.reaction(ev.event_id)) await this.applyRedaction(room, ev.event_id);
      this.db.putEvent(ev, room.id, room.id, false);
      return;
    }
    if (!MESSAGE_TYPES.has(ev.type)) {
      this.db.putEvent(ev, room.id, room.id, false);
      return;
    }
    const known = this.db.event(ev.event_id);
    if (known?.redacted) return;
    const conv = known?.conv ?? room.id;
    if (!known?.json) {
      this.hub.emit({ t: 'message', live: false, message: { nativeId: ev.event_id, conversation: conv, author: ev.sender, ts: ev.origin_server_ts, kind: 'text', body: '' } });
    }
    this.db.putEvent(ev, room.id, conv, false);
    this.db.markRedacted(ev.event_id);
    this.hub.emit({ t: 'delete', conversation: conv, nativeId: ev.event_id });
  }

  /** After a limited incremental sync: page back until we reach what we already had. */
  private async fillGap(room: Room, from: string, stopAt: string | null) {
    if (!stopAt) return;
    const stopTs = this.eventTs(stopAt);
    const collected: MxEvent[] = [];
    let token: string | undefined = from;
    try {
      for (let page = 0; page < GAP_PAGES && token; page++) {
        const res: any = await this.api().request('GET', `/_matrix/client/v3/rooms/${enc(room.id)}/messages`, {
          query: { from: token, dir: 'b', limit: 100, filter: LAZY },
        });
        this.historyMembers(room, res.state);
        let reached = false;
        for (const ev of res.chunk ?? []) {
          if (ev.event_id === stopAt || (stopTs !== null && ev.origin_server_ts < stopTs)) {
            reached = true;
            break;
          }
          collected.push(ev);
        }
        token = reached || !(res.chunk?.length) ? undefined : res.end;
      }
    } catch (e) {
      this.log('warn', `gap fill in ${room.id} failed: ${describe(e)}`);
    }
    if (token) {
      room.backToken = token;
      this.log('info', `gap in ${room.id} not closed after ${GAP_PAGES} pages; history will continue from there`);
    }
    collected.reverse();
    if (collected.length) this.log('debug', `filled a gap of ${collected.length} events in ${room.id}`);
    await this.processTimeline(room, collected, { live: false, mode: 'gap', count: 0 });
  }

  /** Member events that come with /messages pages: identities only (they may be historical). */
  private historyMembers(room: Room, state: MxEvent[] | undefined) {
    for (const ev of state ?? []) {
      if (ev?.type !== 'm.room.member' || typeof ev.state_key !== 'string' || ev.state_key === this.selfId) continue;
      const f: P.IdentityFact = { nativeId: ev.state_key, handle: ev.state_key };
      if (typeof ev.content?.displayname === 'string' && ev.content.displayname) f.displayName = ev.content.displayname;
      if (typeof ev.content?.avatar_url === 'string' && ev.content.avatar_url.startsWith('mxc://')) f.avatarUrl = ev.content.avatar_url;
      if (this.dir.isContact(ev.state_key)) f.contact = true;
      this.emitIdentity(room.memberName(ev.state_key) ? this.dir.identity(room, ev.state_key) : f, true);
    }
  }

  // ================================================================ read state, typing

  private readState(room: Room, jr: any) {
    if (room.isSpace) return; // spaces are not conversations: no read state to report
    let best: number | null = null;
    const consider = (eventId: unknown) => {
      if (typeof eventId !== 'string') return;
      const ts = this.eventTs(eventId);
      if (ts !== null && (best === null || ts > best)) best = ts;
    };
    const threadReads = new Map<string, number>();
    for (const ev of jr.ephemeral?.events ?? []) {
      if (ev?.type !== 'm.receipt') continue;
      for (const [eventId, byType] of Object.entries<any>(ev.content ?? {})) {
        for (const rt of ['m.read', 'm.read.private']) {
          const r = byType?.[rt]?.[this.selfId];
          if (!r) continue;
          if (typeof r.thread_id === 'string' && r.thread_id !== 'main') {
            const ts = this.eventTs(eventId);
            if (ts !== null) threadReads.set(r.thread_id, Math.max(threadReads.get(r.thread_id) ?? 0, ts));
          } else consider(eventId);
        }
      }
    }
    for (const ev of jr.account_data?.events ?? []) if (ev?.type === 'm.fully_read') consider(ev.content?.event_id);

    const n = jr.unread_notifications;
    const counts = typeof n?.notification_count === 'number';
    if (counts || best !== null) {
      this.hub.emit({
        t: 'read',
        conversation: room.id,
        upToTs: best ?? 0,
        ...(counts ? { unread: n.notification_count, mentions: typeof n.highlight_count === 'number' ? n.highlight_count : 0 } : {}),
      });
    }
    for (const [root, ts] of threadReads) {
      const id = threadId(room.id, root);
      if (this.db.thread(id)) this.hub.emit({ t: 'read', conversation: id, upToTs: ts });
    }
    for (const [root, c] of Object.entries<any>(jr.unread_thread_notifications ?? {})) {
      const id = threadId(room.id, root);
      if (this.db.thread(id) && typeof c?.notification_count === 'number') {
        this.hub.emit({ t: 'read', conversation: id, upToTs: 0, unread: c.notification_count, mentions: c.highlight_count ?? 0 });
      }
    }
  }

  private typing(room: Room, jr: any) {
    for (const ev of jr.ephemeral?.events ?? []) {
      if (ev?.type !== 'm.typing' || !Array.isArray(ev.content?.user_ids)) continue;
      for (const u of ev.content.user_ids) if (typeof u === 'string' && u !== this.selfId) this.hub.emit({ t: 'typing', conversation: room.id, author: u });
    }
  }

  // ================================================================ commands

  async command(cmd: P.AdapterCommand): Promise<unknown> {
    switch (cmd.t) {
      case 'send':
        return this.send(cmd.conversation, cmd.body, cmd.replyTo);
      case 'history':
        return this.history(cmd.conversation, cmd.limit);
      case 'markRead':
        return this.markRead(cmd.conversation, cmd.upTo);
      case 'react':
        return this.react(cmd.conversation, cmd.message, cmd.key, !!cmd.remove);
      case 'edit':
        return this.edit(cmd.conversation, cmd.message, cmd.body);
      case 'redact':
        return this.redact(cmd.conversation, cmd.message);
      case 'fetchMedia':
        return this.fetchMedia(cmd.url);
      case 'action':
        return this.action(cmd.action, cmd.args);
      case 'shutdown':
        return undefined;
    }
  }

  private names(roomId: string) {
    const room = this.dir.rooms.get(roomId);
    return {
      user: (id: string) => room?.memberName(id) ?? this.namesAnywhere(id),
      room: (id: string) => {
        const r = this.dir.rooms.get(id);
        return r ? this.dir.displayName(r) : undefined;
      },
    };
  }

  private namesAnywhere(user: string): string | undefined {
    for (const r of this.dir.rooms.values()) {
      const n = r.memberName(user);
      if (n) return n;
    }
    return undefined;
  }

  private joinedRoom(roomId: string): Room {
    const room = this.dir.rooms.get(roomId);
    if (!room || room.membership !== 'join') throw new Error(`not joined to ${roomId}`);
    return room;
  }

  private async sendEvent(roomId: string, type: string, content: unknown): Promise<string> {
    const res = await this.api().request('PUT', `/_matrix/client/v3/rooms/${enc(roomId)}/send/${enc(type)}/${enc(this.api().txnId())}`, { body: content });
    return res.event_id;
  }

  private async send(conversation: string, body: string, replyTo?: string) {
    const { roomId, root } = splitConversation(conversation);
    this.joinedRoom(roomId);
    const out = markdownToMatrix(body, this.names(roomId));
    const content: Record<string, any> = { msgtype: 'm.text', body: out.body };
    if (out.formatted) {
      content.format = 'org.matrix.custom.html';
      content.formatted_body = out.formatted;
    }
    const mentions = new Set(out.mentions);
    if (replyTo) {
      const target = this.db.event(replyTo);
      if (target && target.sender !== this.selfId) mentions.add(target.sender);
    }
    content['m.mentions'] = mentions.size ? { user_ids: [...mentions] } : {};
    if (root) {
      const latest = this.db.thread(threadId(roomId, root))?.latest ?? root;
      content['m.relates_to'] = { rel_type: 'm.thread', event_id: root, is_falling_back: !replyTo, 'm.in_reply_to': { event_id: replyTo ?? latest } };
    } else if (replyTo) {
      content['m.relates_to'] = { 'm.in_reply_to': { event_id: replyTo } };
    }
    return { nativeId: await this.sendEvent(roomId, 'm.room.message', content) };
  }

  private async edit(conversation: string, message: string, body: string) {
    const { roomId } = splitConversation(conversation);
    this.joinedRoom(roomId);
    const orig = this.db.event(message);
    if (orig && orig.sender !== this.selfId) throw new Error('only your own messages can be edited');
    const out = markdownToMatrix(body, this.names(roomId));
    const newContent: Record<string, any> = { msgtype: 'm.text', body: out.body, 'm.mentions': out.mentions.length ? { user_ids: out.mentions } : {} };
    if (out.formatted) {
      newContent.format = 'org.matrix.custom.html';
      newContent.formatted_body = out.formatted;
    }
    // Only mentions that are new in this edit notify again.
    const before = new Set<string>(orig?.json ? (JSON.parse(orig.json).content?.['m.mentions']?.user_ids ?? []) : []);
    const fresh = out.mentions.filter((u) => !before.has(u));
    const content: Record<string, any> = {
      msgtype: 'm.text',
      body: `* ${out.body}`,
      'm.new_content': newContent,
      'm.mentions': fresh.length ? { user_ids: fresh } : {},
      'm.relates_to': { rel_type: 'm.replace', event_id: message },
    };
    if (out.formatted) {
      content.format = 'org.matrix.custom.html';
      content.formatted_body = `* ${out.formatted}`;
    }
    return { nativeId: await this.sendEvent(roomId, 'm.room.message', content) };
  }

  private async redact(conversation: string, message: string, reason?: string) {
    const { roomId } = splitConversation(conversation);
    const res = await this.api().request('PUT', `/_matrix/client/v3/rooms/${enc(roomId)}/redact/${enc(message)}/${enc(this.api().txnId())}`, {
      body: reason ? { reason } : {},
    });
    return { nativeId: res.event_id };
  }

  private async react(conversation: string, message: string, key: string, remove: boolean) {
    const { roomId } = splitConversation(conversation);
    this.joinedRoom(roomId);
    let mine = this.db.reactionsBy(message, this.selfId, key);
    if (!remove) {
      if (mine.length) return { nativeId: mine[0].id };
      const id = await this.sendEvent(roomId, 'm.reaction', { 'm.relates_to': { rel_type: 'm.annotation', event_id: message, key } });
      this.db.putReaction({ id, room: roomId, target: message, key, sender: this.selfId, ts: Date.now() });
      return { nativeId: id };
    }
    if (!mine.length) {
      // Reacted before our window (or from another client): ask the server.
      try {
        const res = await this.api().request('GET', `/_matrix/client/v1/rooms/${enc(roomId)}/relations/${enc(message)}/m.annotation/m.reaction`, { query: { limit: 100 } });
        for (const ev of res.chunk ?? []) {
          const rel = relationOf(ev.content);
          if (ev.sender === this.selfId && rel.key === key) this.db.putReaction({ id: ev.event_id, room: roomId, target: message, key, sender: this.selfId, ts: ev.origin_server_ts });
        }
      } catch (e) {
        this.log('debug', `relations lookup failed: ${describe(e)}`);
      }
      mine = this.db.reactionsBy(message, this.selfId, key);
    }
    for (const r of mine) await this.redact(roomId, r.id);
    return { removed: mine.length };
  }

  private async markRead(conversation: string, upTo: string) {
    const { roomId, root } = splitConversation(conversation);
    this.joinedRoom(roomId);
    const c = this.api();
    await c.request('POST', `/_matrix/client/v3/rooms/${enc(roomId)}/receipt/m.read/${enc(upTo)}`, { body: root ? { thread_id: root } : {} });
    if (!root) await c.request('POST', `/_matrix/client/v3/rooms/${enc(roomId)}/read_markers`, { body: { 'm.fully_read': upTo } });
    return { ok: true };
  }

  private async history(conversation: string, limit: number): Promise<{ count: number; done: boolean }> {
    const { roomId, root } = splitConversation(conversation);
    const room = this.joinedRoom(roomId);
    const want = Math.max(1, Math.min(limit || 50, 200));
    const ctx: Ctx = { live: false, mode: 'history', count: 0 };
    if (root) return this.threadHistory(room, root, want, ctx);
    for (let page = 0; page < 6 && ctx.count < want && room.backToken; page++) {
      const res: any = await this.api().request('GET', `/_matrix/client/v3/rooms/${enc(room.id)}/messages`, {
        query: { from: room.backToken, dir: 'b', limit: Math.min(100, want - ctx.count + 10), filter: LAZY },
      });
      this.historyMembers(room, res.state);
      await this.processTimeline(room, [...(res.chunk ?? [])].reverse(), ctx);
      room.backToken = typeof res.end === 'string' && res.end && res.chunk?.length ? res.end : '';
      this.db.saveRoom(room);
    }
    return { count: ctx.count, done: !room.backToken };
  }

  private async threadHistory(room: Room, root: string, want: number, ctx: Ctx): Promise<{ count: number; done: boolean }> {
    const id = await this.ensureThread(room, root, ctx);
    let t = this.db.thread(id)!;
    for (let page = 0; page < 6 && ctx.count < want && !t.done; page++) {
      const res: any = await this.api().request('GET', `/_matrix/client/v1/rooms/${enc(room.id)}/relations/${enc(root)}/m.thread`, {
        query: { dir: 'b', limit: Math.min(100, want - ctx.count + 10), from: t.back_token ?? undefined },
      });
      await this.processTimeline(room, [...(res.chunk ?? [])].reverse(), ctx);
      t = { ...this.db.thread(id)!, back_token: res.next_batch ?? null, done: res.next_batch ? 0 : 1 };
      this.db.putThread(t);
    }
    if (!this.db.event(root)?.json) {
      const ev = await this.fetchEvent(room.id, root);
      if (ev) await this.processEvent(room, ev, { live: false, mode: 'fetch', count: 0 });
    }
    return { count: ctx.count, done: !!t.done };
  }

  private async fetchMedia(url: string): Promise<{ mime: string; base64: string }> {
    const m = url.match(/^mxc:\/\/([^/]+)\/([^/?#]+)/);
    if (!m) throw new Error(`not an mxc:// URL: ${url}`);
    const c = this.api();
    const path = `${enc(m[1])}/${enc(m[2])}`;
    let res = await c.raw('GET', `/_matrix/client/v1/media/download/${path}`, { timeoutMs: 60_000 });
    if (!res.ok && [400, 403, 404, 405].includes(res.status)) {
      const legacy = await c.raw('GET', `/_matrix/media/v3/download/${path}`, { timeoutMs: 60_000 });
      if (legacy.ok) res = legacy;
    }
    if (!res.ok) throw new Error(`media download failed: HTTP ${res.status}`);
    if (Number(res.headers.get('content-length') ?? 0) > MAX_MEDIA) throw new Error('media too large to proxy');
    const bytes = new Uint8Array(await res.arrayBuffer());
    if (bytes.length > MAX_MEDIA) throw new Error('media too large to proxy');
    const mime = (res.headers.get('content-type') ?? 'application/octet-stream').split(';')[0].trim() || 'application/octet-stream';
    return { mime, base64: Buffer.from(bytes).toString('base64') };
  }

  private async action(action: string, args: unknown) {
    switch (action) {
      case 'resync':
        return this.resync();
      case 'relogin':
        return this.relogin(args);
      case 'status':
        return {
          userId: this.selfId || null,
          deviceId: this.deviceId || null,
          homeserver: this.client?.baseUrl ?? null,
          status: this.status,
          since: this.db.get('since'),
          rooms: this.dir.joined().filter((r) => !r.isSpace).length,
          spaces: this.dir.joined().filter((r) => r.isSpace).length,
          threads: this.db.threads().length,
        };
      default:
        throw new Error(`unknown action "${action}" (matrix supports resync, relogin, status)`);
    }
  }

  /** Forget the since token and run a full initial sync (facts re-sent with live=false). */
  private async resync() {
    this.api();
    this.db.set('since', null);
    this.emitted.clear();
    const done = new Promise<number>((r) => this.resyncWaiters.push(r));
    this.syncAbort?.abort();
    const rooms = await Promise.race([done, Bun.sleep(50_000).then(() => -1)]);
    return rooms < 0 ? { started: true, note: 'initial sync still running' } : { ok: true, rooms };
  }

  private async relogin(args: unknown) {
    const secret = this.hub.secret<Secret>();
    const password = typeof (args as any)?.password === 'string' ? (args as any).password : secret.password;
    if (!password) throw new Error('relogin needs args {"password": "..."} (or a password in secret.json)');
    const { accessToken: _old, ...rest } = secret;
    this.hub.saveSecret({ ...rest, password, ...(typeof (args as any)?.userId === 'string' ? { userId: (args as any).userId } : {}) });
    this.restartSession = true;
    this.syncAbort?.abort();
    this.wakeUp?.();
    return { ok: true };
  }
}
