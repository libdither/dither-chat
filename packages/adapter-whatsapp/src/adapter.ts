/**
 * WhatsApp adapter: this hub as a linked device (like WhatsApp Web), through whatsmeow in
 * bridge/main.go. See docs/whatsapp.md for why this and not the web client in a sandbox.
 *
 *   not linked   -> the bridge shows QR codes; status 'attention' (link_device) with the code.
 *                   Or a pairing code for a phone number (action pairPhone), for when the only
 *                   screen is the phone itself.
 *   linked       -> connected: history sync on the first link, then live events; whatsmeow
 *                   reconnects on its own after network trouble
 *   unlinked     -> back to linking (the phone removed the device, or it went 14 days without
 *                   the phone being online)
 *   temp. banned -> attention, and no reconnect until the ban expires
 *
 * Nothing here talks to WhatsApp except through the bridge. To look like WhatsApp Web, the
 * adapter only does what a person in WhatsApp Web would cause: it never marks itself online
 * (that also keeps the phone getting notifications), never looks up numbers on its own and
 * fetches profile pictures only when one is shown.
 */

import { existsSync, mkdirSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import type * as P from '@dither-chat/protocol';
import { Bridge, type Logger } from './bridge.ts';
import { toWhatsApp } from './format.ts';
import { Aliases, avatarUrl, bare, contextOf, ignoredChat, isGroup, isPhoneJid, isUser, Mapper, type MapOut, mediaOf, msgId, phoneOf } from './mapping.ts';
import { State, type StoredMsg } from './state.ts';
import type { BridgeEvent, WaContact, WaGroup, WaMessage, WaSelf } from './types.ts';

export const ADAPTER_VERSION = '0.1.0';
export const CAPABILITIES: P.Capability[] = ['send', 'history', 'react', 'edit', 'redact', 'markRead', 'typing', 'media', 'sendMedia', 'e2ee', 'openDirect', 'forward'];
export const LINK_MESSAGE = 'Scan this QR code in WhatsApp → Settings → Linked devices → Link a device';
/** WhatsApp lets you edit for 15 minutes. */
export const EDIT_WINDOW_MS = 15 * 60_000;

export interface AdapterHost {
  emit(ev: P.AdapterEvent): void;
  log: Logger;
  accountDir: string;
  config: Record<string, any>;
}

export interface AdapterOptions {
  /** argv prefix for the bridge (resolved lazily: may run `nix build`). */
  bridge: () => Promise<string[]>;
  /** Seconds between bridge restarts after it dies, last one repeating. */
  restartBackoffMs?: number[];
  /** A bridge that ran this long gets a fresh backoff. */
  stableAfterMs?: number;
  /** How long to wait for the phone to answer a history request. */
  historyTimeoutMs?: number;
  /** Least time between two full snapshots (groups, contacts). */
  snapshotEveryMs?: number;
  expirySweepMs?: number;
  /** fetch, for profile pictures (tests replace it). */
  fetch?: typeof fetch;
}

type Phase = 'starting' | 'linking' | 'connecting' | 'online' | 'banned' | 'replaced' | 'stopped' | 'broken';
type Status = Extract<P.AdapterEvent, { t: 'status' }>;

const BACKOFF = [1000, 2000, 5000, 10_000, 30_000, 60_000];

export class WhatsAppAdapter {
  readonly state: State;
  readonly aliases: Aliases;
  readonly mapper: Mapper;
  private bridge: Bridge | null = null;
  private phase: Phase = 'starting';
  private argv: string[] = [];
  private restarts = 0;
  private bridgeStarted = 0;
  private restartTimer?: Timer;
  private banTimer?: Timer;
  private expiryTimer?: Timer;
  private lastStatus: Status | null = null;
  private self: WaSelf = { loggedIn: false };
  private published = new Map<string, string>();
  private groupFetch = new Map<string, Promise<void>>();
  private historyWaiters = new Map<string, (count: number) => void>();
  private historyCounts = new Map<string, number>();
  private pendingReads = new Map<string, { unread: number; lastTs: number }>();
  private lastSnapshot = 0;
  private noAvatar = new Map<string, number>();

  constructor(
    private host: AdapterHost,
    private opts: AdapterOptions,
  ) {
    this.state = new State(join(host.accountDir, 'state.db'));
    this.aliases = new Aliases(this.state);
    this.mapper = new Mapper(this.state, this.aliases, () => this.selfIds(), (id) => this.nameOf(id));
    const s = this.state.get('self');
    if (s) this.self = { ...JSON.parse(s), loggedIn: false };
  }

  // ---------------------------------------------------------------- lifecycle

  hello() {
    this.host.emit({ t: 'hello', network: 'whatsapp', version: ADAPTER_VERSION, capabilities: CAPABILITIES });
  }

  /** Every (re)connect to the hub: hello and the current status. */
  onHubConnect() {
    this.hello();
    if (this.lastStatus) this.host.emit(this.lastStatus);
  }

  async start() {
    this.hello();
    this.setStatus('connecting', null);
    try {
      this.argv = await this.opts.bridge();
    } catch (e: any) {
      this.phase = 'broken';
      this.host.log('error', String(e?.message ?? e));
      this.setStatus('error', { kind: 'unknown', message: `The WhatsApp bridge is not available: ${e?.message ?? e}` });
      return;
    }
    if (this.phase === 'stopped') return;
    this.spawn();
    this.expiryTimer = setInterval(() => this.sweepExpired(), this.opts.expirySweepMs ?? 60_000);
  }

  async shutdown() {
    this.phase = 'stopped';
    clearTimeout(this.restartTimer);
    clearTimeout(this.banTimer);
    clearInterval(this.expiryTimer);
    await this.bridge?.stop();
    this.state.close();
  }

  private spawn() {
    if (this.phase === 'stopped') return;
    const cfg = this.host.config;
    const args = ['--db', join(this.host.accountDir, 'whatsmeow.db'), '--os-name', String(cfg.deviceName ?? 'dither-chat'), '--platform', String(cfg.platform ?? 'DESKTOP')];
    if (cfg.debug) args.push('--log', 'DEBUG');
    this.bridgeStarted = Date.now();
    const b = new Bridge({
      argv: [...this.argv, ...args],
      env: process.env,
      log: this.host.log,
      onEvent: (ev) => this.onBridge(ev),
      onExit: (code) => this.onBridgeExit(b, code),
    });
    this.bridge = b;
    this.host.log('info', `WhatsApp bridge started (pid ${b.pid})`);
  }

  private onBridgeExit(b: Bridge, code: number | null) {
    if (this.bridge !== b) return;
    this.bridge = null;
    for (const [, w] of this.historyWaiters) w(0);
    this.historyWaiters.clear();
    if (this.phase === 'stopped' || this.phase === 'banned' || this.phase === 'replaced' || this.phase === 'broken') return;
    if (Date.now() - this.bridgeStarted > (this.opts.stableAfterMs ?? 120_000)) this.restarts = 0;
    const backoff = this.opts.restartBackoffMs ?? BACKOFF;
    const delay = backoff[Math.min(this.restarts++, backoff.length - 1)];
    this.host.log('warn', `WhatsApp bridge exited (code ${code}); restarting in ${Math.round(delay / 1000)}s`);
    if (this.phase === 'online') this.setStatus('connecting', null);
    this.restartTimer = setTimeout(() => this.spawn(), delay);
  }

  /** Stop the bridge and start a fresh one (after an unlink, or on request). */
  private async respawn() {
    clearTimeout(this.restartTimer);
    const b = this.bridge;
    this.bridge = null;
    await b?.stop();
    this.restarts = 0;
    this.spawn();
  }

  private setStatus(status: P.AccountStatus, attention?: Status['attention'], self?: P.IdentityFact) {
    const ev: Status = { t: 'status', status };
    if (attention !== undefined) ev.attention = attention;
    if (self) ev.self = self;
    this.lastStatus = ev;
    this.host.emit(ev);
  }

  private get rpc(): Bridge {
    if (!this.bridge?.alive) throw new Error('WhatsApp is not connected yet');
    return this.bridge;
  }

  private requireLinked() {
    if (!this.self.loggedIn || !this.self.jid) throw new Error('WhatsApp is not linked yet: scan the QR code on the account page');
  }

  selfIds() {
    const jids = [this.self.jid, this.self.lid].filter((j): j is string => !!j).map(bare);
    return { id: jids.length ? this.aliases.id(jids[0]) : 'self', jids };
  }

  // ---------------------------------------------------------------- bridge events

  private onBridge(ev: BridgeEvent) {
    switch (ev.t) {
      case 'ready':
        this.self.loggedIn = ev.loggedIn;
        if (!ev.loggedIn) this.phase = 'linking';
        else this.phase = 'connecting';
        this.rpc.call('connect').catch((e) => this.host.log('warn', `connect: ${e.message}`));
        return;
      case 'fatal':
        this.phase = 'broken';
        this.setStatus('error', { kind: 'unknown', message: ev.error });
        return;
      case 'qr':
        this.phase = 'linking';
        this.setStatus('attention', { kind: 'link_device', message: LINK_MESSAGE, qr: ev.code, qrRefreshAt: Date.now() + ev.timeoutMs });
        return;
      case 'qr_done':
        if (ev.result === 'success') this.setStatus('connecting', null);
        else if (ev.result === 'timeout') this.setStatus('attention', { kind: 'link_device', message: 'The QR code expired. Press New code for another one.' });
        else if (ev.result === 'err-client-outdated') this.outdated();
        else if (ev.result === 'err-scanned-without-multidevice') this.setStatus('attention', { kind: 'link_device', message: 'That phone has an old WhatsApp without linked devices. Update WhatsApp, then press New code.' });
        else this.setStatus('attention', { kind: 'link_device', message: `Linking failed (${ev.error ?? ev.result}). Press New code to try again.` });
        return;
      case 'paired':
        this.self = { ...this.self, loggedIn: true, jid: ev.jid, lid: ev.lid, businessName: ev.businessName };
        this.saveSelf();
        this.host.log('info', `linked as ${ev.jid} (${ev.platform ?? 'phone'})`);
        this.setStatus('connecting', null);
        return;
      case 'pair_error':
        this.setStatus('attention', { kind: 'link_device', message: `Linking failed: ${ev.error}. Press New code to try again.` });
        return;
      case 'connected':
        return this.connected(ev);
      case 'disconnected':
        if (this.phase === 'online') {
          this.phase = 'connecting';
          this.setStatus('connecting', null);
        }
        return;
      case 'keepalive_timeout':
        if (ev.errors >= 2 && this.phase === 'online') this.setStatus('connecting', null);
        return;
      case 'keepalive_restored':
        if (this.phase === 'online') this.setStatus('online', null, this.selfIdentity());
        return;
      case 'logged_out':
        return this.unlinked(ev.reason);
      case 'stream_replaced':
        this.phase = 'replaced';
        this.setStatus('error', { kind: 'unknown', message: 'Another copy of this linked device connected, so WhatsApp closed this one. Press Reconnect if that copy is gone.' });
        this.bridge?.stop();
        return;
      case 'temporary_ban':
        return this.banned(ev.message, ev.expireSec);
      case 'client_outdated':
        return this.outdated();
      case 'connect_failure':
        this.host.log('warn', `WhatsApp refused the connection: ${ev.message}`);
        if (this.phase !== 'linking') this.setStatus('error', { kind: 'unknown', message: `WhatsApp refused the connection: ${ev.message}` });
        return;
      case 'stream_error':
        this.host.log('warn', `stream error ${ev.code}`);
        return;
      case 'message':
        return this.apply(this.mapper.message(ev), ev.info.pushName && !ev.info.fromMe ? { jid: ev.info.sender, alt: ev.info.senderAlt, name: ev.info.pushName } : undefined, ev.history);
      case 'undecryptable':
        return this.undecryptable(ev);
      case 'history':
        return this.history(ev);
      case 'history_done':
        return this.historyDone(ev);
      case 'receipt':
        return this.receipt(ev);
      case 'chat_presence': {
        if (ev.fromMe || ev.state !== 'composing' || ignoredChat(bare(ev.chat))) return;
        this.host.emit({ t: 'typing', conversation: this.mapper.convId(ev.chat), author: this.mapper.who(ev.sender) });
        return;
      }
      case 'push_name':
        this.aliases.link(ev.jid, ev.alt);
        return this.personChanged(this.mapper.who(ev.jid), { pushName: ev.name });
      case 'business_name':
        return this.personChanged(this.mapper.who(ev.jid), { businessName: ev.name });
      case 'contact':
        this.aliases.link(ev.jid, ev.alt);
        return this.personChanged(this.mapper.who(ev.jid), { fullName: ev.fullName, firstName: ev.firstName });
      case 'mute':
        return this.patchChat(ev.jid, { mute: ev.muted ? { level: 'none', ...(ev.until && ev.until > 0 && ev.until < 1e14 ? { until: ev.until * 1000 } : {}) } : { level: 'all' } });
      case 'archive':
        return this.patchChat(ev.jid, { archived: ev.archived });
      case 'pin':
        return;
      case 'mark_chat_read': {
        const conv = this.mapper.convId(ev.jid);
        if (!this.state.chat(conv)) return;
        this.host.emit(ev.read ? { t: 'read', conversation: conv, upToTs: ev.ts, unread: 0, mentions: 0 } : { t: 'read', conversation: conv, upToTs: 0, unread: 1 });
        return;
      }
      case 'delete_chat': {
        const conv = this.mapper.convId(ev.jid);
        if (!this.state.chat(conv)) return;
        this.state.dropChat(conv);
        this.host.emit({ t: 'leave', kind: 'conversation', nativeId: conv });
        return;
      }
      case 'clear_chat':
        return;
      case 'delete_for_me': {
        const conv = this.mapper.convId(ev.chat);
        const id = msgId(conv, ev.id);
        this.state.dropMsg(id);
        this.host.emit({ t: 'delete', conversation: conv, nativeId: id });
        return;
      }
      case 'picture':
        return this.picture(ev.jid, ev.remove ? undefined : ev.id);
      case 'group':
        return this.putGroup(ev.group);
      case 'group_change':
        return this.groupChange(ev);
      case 'app_state_synced':
        if (ev.name === 'critical_unblock_low' || ev.name === 'regular_high') this.loadContacts().catch((e) => this.host.log('warn', `contacts: ${e.message}`));
        return;
      case 'offline_sync':
        if (ev.done) this.host.log('info', `caught up on ${ev.total} events received while offline`);
        return;
    }
  }

  private saveSelf() {
    const { loggedIn: _, ...rest } = this.self;
    this.state.set('self', JSON.stringify(rest));
  }

  private connected(ev: WaSelf) {
    this.phase = 'online';
    this.restarts = 0;
    this.self = { ...this.self, ...ev, loggedIn: true };
    if (this.self.jid && this.self.lid) this.aliases.link(this.self.jid, this.self.lid);
    this.saveSelf();
    const me = this.selfIds().id;
    this.personChanged(me, { pushName: ev.pushName, businessName: ev.businessName, phone: phoneOf(bare(ev.jid ?? '')) }, false);
    this.setStatus('online', null, this.selfIdentity());
    this.snapshot(false).catch((e) => this.host.log('warn', `snapshot: ${e?.message ?? e}`));
  }

  private unlinked(reason: string) {
    this.host.log('warn', `WhatsApp logged this device out (${reason})`);
    this.self = { loggedIn: false };
    this.state.set('self', null);
    this.phase = 'linking';
    this.setStatus('attention', { kind: 'link_device', message: 'WhatsApp unlinked this device (removed on the phone, or the phone was offline for 14 days). Getting a new code…' });
    // whatsmeow has deleted the session; a fresh bridge starts linking.
    this.respawn().catch(() => {});
  }

  private banned(message: string, expireSec: number) {
    this.phase = 'banned';
    const until = expireSec > 0 ? Date.now() + expireSec * 1000 : 0;
    const when = until ? ` It ends ${new Date(until).toISOString().replace('T', ' ').slice(0, 16)} UTC; dither-chat stays disconnected until then.` : ' dither-chat stays disconnected; press Reconnect once the ban is over.';
    this.setStatus('attention', { kind: 'rate_limited', message: `${message}.${when}` });
    this.bridge?.stop();
    if (until) this.banTimer = setTimeout(() => (this.phase = 'connecting', this.spawn()), expireSec * 1000 + 60_000);
  }

  private outdated() {
    this.phase = 'broken';
    this.setStatus('error', { kind: 'selector_broken', message: 'WhatsApp says this client is too old. Update whatsmeow in packages/adapter-whatsapp/bridge (go get go.mau.fi/whatsmeow@latest), then restart the account.' });
    this.bridge?.stop();
  }

  // ---------------------------------------------------------------- people

  private nameOf(id: string): string {
    const p = this.state.person(id);
    const phone = p?.phone ?? this.aliases.jids(id).map(phoneOf).find(Boolean);
    return p?.fullName || p?.pushName || p?.businessName || phone || 'WhatsApp user';
  }

  private identity(id: string): P.IdentityFact {
    const p = this.state.person(id);
    const jids = this.aliases.jids(id);
    const phone = p?.phone ?? jids.map(phoneOf).find(Boolean);
    const isSelf = id === this.selfIds().id;
    const f: P.IdentityFact = { nativeId: id, displayName: this.nameOf(id) };
    if (phone) f.handle = phone;
    if (isSelf) f.isSelf = true;
    if (p?.fullName) f.contact = true;
    // Pictures for people you know or talk to, not for every stranger in a big group.
    if (isSelf || p?.fullName || this.state.chat(id)) f.avatarUrl = p?.avatar ?? avatarUrl(jids[0]);
    return f;
  }

  private selfIdentity(): P.IdentityFact {
    return this.identity(this.selfIds().id);
  }

  /** Emit an identity if it is new to this run or changed. */
  private publish(id: string) {
    if (!id || id === 'self') return;
    const f = this.identity(id);
    const key = JSON.stringify(f);
    if (this.published.get(id) === key) return;
    this.published.set(id, key);
    this.host.emit({ t: 'identity', identity: f });
  }

  private personChanged(id: string, patch: { fullName?: string; firstName?: string; pushName?: string; businessName?: string; phone?: string; avatar?: string }, emit = true) {
    if (!id) return;
    this.state.putPerson({ id, ...patch });
    if (emit || this.published.has(id)) this.publish(id);
  }

  private picture(jid: string, pictureId: string | undefined) {
    const j = bare(jid);
    if (isGroup(j)) {
      const chat = this.state.chat(j);
      if (chat) this.putChat(j, chat.jid, { ...chat.fact, avatarUrl: avatarUrl(j, pictureId) } as P.ConversationFact, 0);
      return;
    }
    const id = this.mapper.who(j);
    this.state.putPerson({ id, avatar: avatarUrl(j, pictureId) });
    this.publish(id);
  }

  private async loadContacts() {
    const list = await this.rpc.call<WaContact[]>('contacts');
    for (const c of list) {
      if (!isUser(bare(c.jid))) continue;
      this.aliases.link(c.jid, c.alt);
      const id = this.mapper.who(c.jid);
      this.state.putPerson({ id, fullName: c.fullName, firstName: c.firstName, pushName: c.pushName, businessName: c.businessName, phone: phoneOf(bare(c.jid)) ?? (c.alt ? phoneOf(bare(c.alt)) : undefined) });
      if (c.fullName) this.publish(id);
    }
  }

  // ---------------------------------------------------------------- conversations

  private putChat(id: string, jid: string, fact: P.ConversationFact, lastTs: number) {
    this.state.putChat({ id, jid, fact, lastTs });
    for (const p of fact.participants ?? []) this.publish(p);
    this.host.emit({ t: 'conversation', conversation: fact });
  }

  private patchChat(jid: string, patch: Partial<P.ConversationFact>) {
    const j = bare(jid);
    if (ignoredChat(j)) return;
    const id = this.mapper.convId(j);
    const cur = this.state.chat(id);
    if (!cur) {
      // Remember it for when the chat shows up.
      this.state.set(`patch:${id}`, JSON.stringify({ ...JSON.parse(this.state.get(`patch:${id}`) ?? '{}'), ...patch }));
      return;
    }
    this.putChat(id, cur.jid, { ...cur.fact, ...patch } as P.ConversationFact, 0);
  }

  /** Make sure the hub knows a conversation before a message lands in it. */
  private ensureChat(id: string, jid: string, ts: number, group: boolean) {
    const cur = this.state.chat(id);
    if (cur) {
      if (ts > cur.lastTs) this.state.putChat({ ...cur, lastTs: ts });
      return;
    }
    const saved = this.state.get(`patch:${id}`);
    const patch = saved ? JSON.parse(saved) : {};
    if (saved) this.state.set(`patch:${id}`, null);
    if (group) {
      this.putChat(id, jid, { nativeId: id, shape: 'group', name: 'WhatsApp group', encrypted: true, avatarUrl: avatarUrl(id), ...patch }, ts);
      this.fetchGroup(jid);
    } else {
      this.putChat(id, jid, this.mapper.direct(jid, patch), ts);
    }
  }

  private fetchGroup(jid: string) {
    if (this.groupFetch.has(jid) || !this.bridge?.alive) return;
    const p = this.rpc
      .call<WaGroup>('group', { jid })
      .then((g) => this.putGroup(g))
      .catch((e) => this.host.log('warn', `group ${jid}: ${e.message}`))
      .finally(() => setTimeout(() => this.groupFetch.delete(jid), 30_000));
    this.groupFetch.set(jid, p);
  }

  private putGroup(g: WaGroup) {
    if (g.addressing) this.state.set(`addr:${g.jid}`, g.addressing);
    if (g.ephemeral) this.state.set(`timer:${g.jid}`, String(g.ephemeral));
    else this.state.set(`timer:${g.jid}`, null);
    const { conversation, space } = this.mapper.group(g);
    if (space) this.host.emit({ t: 'space', space });
    if (conversation) {
      const cur = this.state.chat(g.jid);
      const keep: Partial<P.ConversationFact> = {};
      if (cur?.fact.mute) keep.mute = cur.fact.mute;
      if (cur?.fact.archived !== undefined) keep.archived = cur.fact.archived;
      if (cur?.fact.avatarUrl) keep.avatarUrl = cur.fact.avatarUrl;
      const saved = this.state.get(`patch:${g.jid}`);
      if (saved) this.state.set(`patch:${g.jid}`, null);
      this.putChat(g.jid, g.jid, { ...conversation, ...keep, ...(saved ? JSON.parse(saved) : {}) }, cur?.lastTs ?? 0);
    }
  }

  private groupChange(ev: Extract<BridgeEvent, { t: 'group_change' }>) {
    const jid = bare(ev.jid);
    if (ev.deleted || ev.leave.some((j) => this.mapper.isSelf(j))) {
      this.state.dropChat(jid);
      this.host.emit({ t: 'leave', kind: 'conversation', nativeId: jid });
      return;
    }
    const actor = ev.sender ? this.mapper.who(ev.sender) : '';
    const who = actor === this.selfIds().id ? 'You' : actor ? this.nameOf(actor) : 'Someone';
    const names = (js: string[]) => js.map((j) => (this.mapper.isSelf(j) ? 'you' : this.nameOf(this.mapper.who(j)))).join(', ');
    const lines: string[] = [];
    if (ev.name !== undefined) lines.push(`${who} renamed the group to “${ev.name}”.`);
    if (ev.topic !== undefined) lines.push(`${who} changed the group description.`);
    if (ev.join.length) lines.push(ev.join.length === 1 && this.mapper.who(ev.join[0]) === actor ? `${who} joined.` : `${who} added ${names(ev.join)}.`);
    if (ev.leave.length) lines.push(ev.leave.length === 1 && this.mapper.who(ev.leave[0]) === actor ? `${who} left.` : `${who} removed ${names(ev.leave)}.`);
    if (lines.length && this.state.chat(jid)) {
      this.host.emit({ t: 'message', message: { nativeId: msgId(jid, `gc-${ev.ts}`), conversation: jid, author: actor || this.selfIds().id, ts: ev.ts, kind: 'system', body: lines.join(' ') }, live: true });
    }
    this.groupFetch.delete(jid);
    this.fetchGroup(jid);
  }

  /** Groups and contacts, at most every few minutes. force: on request. */
  private async snapshot(force: boolean) {
    if (!force && Date.now() - this.lastSnapshot < (this.opts.snapshotEveryMs ?? 10 * 60_000)) return;
    this.lastSnapshot = Date.now();
    this.publish(this.selfIds().id);
    await this.loadContacts().catch((e) => this.host.log('warn', `contacts: ${e.message}`));
    const groups = await this.rpc.call<WaGroup[]>('groups');
    const seen = new Set<string>();
    // Communities first, so their groups land in a known space.
    for (const g of [...groups].sort((a, b) => Number(!!b.isParent) - Number(!!a.isParent))) {
      seen.add(g.jid);
      this.putGroup(g);
    }
    if (force) {
      for (const c of this.state.chats()) {
        if (isGroup(c.id) && !seen.has(c.id)) {
          this.state.dropChat(c.id);
          this.host.emit({ t: 'leave', kind: 'conversation', nativeId: c.id });
        }
      }
    }
    for (const c of this.state.chats()) if (!isGroup(c.id)) this.publish(c.id);
    this.host.log('info', `snapshot: ${groups.length} groups, ${this.state.chats().length} chats`);
  }

  // ---------------------------------------------------------------- messages

  private apply(out: MapOut, pushName?: { jid: string; alt?: string; name: string }, history?: boolean) {
    if (pushName) {
      this.aliases.link(pushName.jid, pushName.alt);
      const id = this.mapper.who(pushName.jid);
      this.state.putPerson({ id, pushName: pushName.name });
    }
    for (const t of out.touched) this.ensureChat(t.id, t.jid, t.ts, t.group);
    for (const m of out.remember) this.state.putMsg(m);
    for (const id of out.forget) this.state.dropMsg(id);
    for (const ev of out.events) {
      if (ev.t === 'message') {
        this.publish(ev.message.author);
        for (const r of ev.message.reactions ?? []) for (const a of r.authors) this.publish(a);
        const exp = contextOf(this.state.msg(ev.message.nativeId)?.content)?.expiration;
        if (exp) this.state.set(`timer:${ev.message.conversation}`, String(exp));
      } else if (ev.t === 'reaction') this.publish(ev.author);
      this.host.emit(ev);
    }
    if (history) for (const t of out.touched) this.historyCounts.set(t.id, (this.historyCounts.get(t.id) ?? 0) + out.events.length);
  }

  private undecryptable(ev: Extract<BridgeEvent, { t: 'undecryptable' }>) {
    if (ev.unavailableType === 'view_once') return;
    const info = ev.info;
    const out = this.mapper.message({ info, message: { conversation: 'x' } });
    const fact = out.events.find((e): e is Extract<P.AdapterEvent, { t: 'message' }> => e.t === 'message');
    if (!fact) return;
    fact.message.kind = 'encrypted';
    fact.message.body = 'Waiting for this message. Opening WhatsApp on your phone can help.';
    out.remember = [];
    this.apply(out);
  }

  private history(ev: Extract<BridgeEvent, { t: 'history' }>) {
    for (const m of ev.lidMappings) this.aliases.link(m.pn, m.lid);
    for (const p of ev.pushnames) {
      if (!isUser(bare(p.jid))) continue;
      this.state.putPerson({ id: this.mapper.who(p.jid), pushName: p.name });
    }
    for (const c of ev.conversations) {
      const h = this.mapper.historyConversation(c);
      if (!h) continue;
      const id = this.mapper.convId(h.chat);
      if (c.ephemeralExpiration) this.state.set(`timer:${id}`, String(c.ephemeralExpiration));
      const cur = this.state.chat(id);
      const base: P.ConversationFact = cur?.fact
        ? (cur.fact as P.ConversationFact)
        : isGroup(h.chat)
          ? { nativeId: id, shape: 'group', name: h.patch.name ?? 'WhatsApp group', encrypted: true, avatarUrl: avatarUrl(id) }
          : this.mapper.direct(h.chat);
      this.putChat(id, cur?.jid ?? h.chat, { ...base, ...h.patch }, h.lastTs ?? 0);
      if (isGroup(h.chat) && !cur) this.fetchGroup(h.chat);
      if (h.unread !== undefined && ev.syncType !== 'ON_DEMAND') this.pendingReads.set(id, { unread: h.unread, lastTs: h.lastTs ?? 0 });
    }
    this.host.log('info', `history sync ${ev.syncType} #${ev.chunkOrder ?? 0}: ${ev.conversations.length} chats${ev.progress ? `, ${ev.progress}%` : ''}`);
  }

  private historyDone(ev: Extract<BridgeEvent, { t: 'history_done' }>) {
    // Read state after the messages, so the counts land on conversations that have them.
    for (const [conv, r] of this.pendingReads) {
      const upTo = r.unread ? (this.state.db.query('SELECT ts FROM msg WHERE conversation = ? ORDER BY ts DESC LIMIT 1 OFFSET ?').get(conv, r.unread) as { ts: number } | null)?.ts ?? 0 : Math.max(r.lastTs, Date.now() - 1000);
      this.host.emit({ t: 'read', conversation: conv, upToTs: upTo, unread: r.unread, mentions: 0 });
    }
    this.pendingReads.clear();
    if (ev.syncType === 'ON_DEMAND') {
      for (const [conv, w] of this.historyWaiters) {
        const n = this.historyCounts.get(conv);
        if (n !== undefined) {
          this.historyWaiters.delete(conv);
          w(n);
        }
      }
    }
    this.historyCounts.clear();
  }

  private receipt(ev: Extract<BridgeEvent, { t: 'receipt' }>) {
    // Your phone (or another linked device) read these: that is read state. Others' receipts are not.
    if (ev.type !== 'read-self' && !(ev.fromMe && ev.type === 'read')) return;
    if (!ev.fromMe) return;
    const chat = bare(ev.chat);
    if (ignoredChat(chat)) return;
    const conv = this.mapper.convId(chat);
    if (!this.state.chat(conv)) return;
    let upTo = 0;
    for (const id of ev.ids) upTo = Math.max(upTo, this.state.msg(msgId(conv, id))?.ts ?? 0);
    if (!upTo) upTo = ev.ts;
    const acked = Number(this.state.get(`acked:${conv}`) ?? 0);
    if (upTo > acked) this.state.set(`acked:${conv}`, String(upTo));
    this.host.emit({ t: 'read', conversation: conv, upToTs: upTo });
  }

  private sweepExpired() {
    for (const m of this.state.expired(Date.now())) {
      this.state.dropMsg(m.id);
      this.host.emit({ t: 'delete', conversation: m.conversation, nativeId: m.id });
    }
  }

  // ---------------------------------------------------------------- commands

  async command(cmd: P.AdapterCommand): Promise<unknown> {
    switch (cmd.t) {
      case 'send':
        return this.send(cmd.conversation, cmd.body, cmd.replyTo, cmd.attachments);
      case 'forward':
        return this.forward(cmd.conversation, cmd.source, cmd.note);
      case 'openDirect':
        return this.openDirect(cmd.peer);
      case 'history':
        return this.fetchHistory(cmd.conversation, cmd.beforeTs, cmd.limit);
      case 'markRead':
        return this.markRead(cmd.conversation, cmd.upTo);
      case 'react':
        return this.react(cmd.conversation, cmd.message, cmd.key, !!cmd.remove);
      case 'reactionContext':
        return this.reactionContext(cmd.conversation);
      case 'reactors': {
        const rows = this.state.db.query('SELECT author FROM react WHERE msg = ? AND key = ?').all(cmd.message, cmd.key) as { author: string }[];
        for (const r of rows) this.publish(r.author);
        return { authors: rows.map((r) => r.author) };
      }
      case 'edit':
        return this.edit(cmd.conversation, cmd.message, cmd.body);
      case 'redact':
        return this.redact(cmd.conversation, cmd.message);
      case 'fetchMedia':
        return this.fetchMedia(cmd.url);
      case 'action':
        return this.action(cmd.action, cmd.args);
      case 'call':
        throw new Error('WhatsApp calls are not supported');
      case 'lab':
      case 'shutdown':
        return undefined;
    }
  }

  /** JID to send to for a conversation. */
  private chatJid(conversation: string): string {
    const c = this.state.chat(conversation);
    if (c) return c.jid;
    if (isGroup(conversation)) return conversation;
    return this.aliases.jids(conversation)[0];
  }

  private ownJid(): string {
    return bare(this.self.jid ?? '');
  }

  /** The JID to mention someone by, in the addressing mode this chat uses. */
  private mentionJid(chat: string, id: string): string | null {
    const jids = this.aliases.jids(id).filter(isUser);
    if (!jids.length) return null;
    const lid = this.state.get(`addr:${chat}`) === 'lid';
    return (lid ? jids.find((j) => !isPhoneJid(j)) : jids.find(isPhoneJid)) ?? jids[0];
  }

  /** contextInfo for a reply: the quoted message's key and content. */
  private replyContext(chat: string, replyTo: string | undefined): Record<string, unknown> {
    const ctx: Record<string, unknown> = {};
    const timer = Number(this.state.get(`timer:${this.mapper.convId(chat)}`) ?? 0);
    if (timer) ctx.expiration = timer;
    if (!replyTo) return ctx;
    const q = this.state.msg(replyTo);
    if (!q) return ctx;
    ctx.stanzaID = q.wid;
    ctx.participant = q.fromMe ? this.ownJid() : q.sender || q.chat;
    if (q.content) ctx.quotedMessage = quotable(q.content);
    return ctx;
  }

  private async send(conversation: string, body: string, replyTo: string | undefined, attachments: P.OutgoingAttachment[] | undefined): Promise<{ nativeId: string }> {
    this.requireLinked();
    const chat = this.chatJid(conversation);
    const wa = toWhatsApp(body, (id) => this.mentionJid(chat, id), (id) => this.nameOf(id));
    const base = this.replyContext(chat, replyTo);
    const ctx = { ...base, ...(wa.mentions.length ? { mentionedJID: wa.mentions } : {}) };
    const hasCtx = Object.keys(ctx).length > 0;
    let first: string | undefined;
    if (attachments?.length) {
      for (const [i, a] of attachments.entries()) {
        const m = await this.mediaMessage(a, i === 0 ? wa.text : '', i === 0 ? ctx : base.expiration ? { expiration: base.expiration } : {});
        const id = await this.sendRaw(chat, m);
        first ??= id;
      }
      return { nativeId: first! };
    }
    if (!wa.text.trim()) throw new Error('nothing to send');
    const message: WaMessage = hasCtx ? { extendedTextMessage: { text: wa.text, contextInfo: ctx } } : { conversation: wa.text };
    return { nativeId: await this.sendRaw(chat, message) };
  }

  /** Send a message and publish it (WhatsApp does not echo what this device sends). */
  private async sendRaw(chat: string, message: WaMessage): Promise<string> {
    const r = await this.rpc.call<{ id: string; ts: number }>('send', { chat, message }, 120_000);
    const out = this.mapper.message({ info: { id: r.id, chat, sender: this.ownJid(), fromMe: true, isGroup: isGroup(chat), ts: r.ts || Date.now() }, message });
    this.apply(out);
    return msgId(this.mapper.convId(chat), r.id);
  }

  private async mediaMessage(a: P.OutgoingAttachment, caption: string, ctx: Record<string, unknown>): Promise<WaMessage> {
    const kind = a.kind === 'image' && a.mime !== 'image/gif' ? 'image' : a.kind === 'video' ? 'video' : a.kind === 'audio' ? 'audio' : 'document';
    const up = await this.rpc.call<{ url: string; directPath: string; mediaKey: string; fileEncSHA256: string; fileSHA256: string; fileLength: number; thumbnail?: string; width?: number; height?: number }>('upload', { path: a.path, kind }, 300_000);
    const media: Record<string, unknown> = {
      url: up.url,
      directPath: up.directPath,
      mediaKey: up.mediaKey,
      fileEncSHA256: up.fileEncSHA256,
      fileSHA256: up.fileSHA256,
      fileLength: String(up.fileLength),
      mimetype: a.mime,
    };
    if (Object.keys(ctx).length) media.contextInfo = ctx;
    if (caption && kind !== 'audio') media.caption = caption;
    if (kind === 'image') {
      if (up.thumbnail) media.JPEGThumbnail = up.thumbnail;
      if (up.width) media.width = up.width;
      if (up.height) media.height = up.height;
      return { imageMessage: media };
    }
    if (kind === 'video') return { videoMessage: media };
    if (kind === 'audio') return { audioMessage: media };
    media.fileName = a.name;
    media.title = a.name;
    return { documentMessage: media };
  }

  private async forward(conversation: string, source: { conversation: string; message: string }, note?: string): Promise<{ nativeId?: string; fallback?: string }> {
    this.requireLinked();
    const src = this.state.msg(source.message);
    if (!src?.content) return { fallback: 'the original is not in this WhatsApp account’s store' };
    const fwd = forwardable(src.content);
    if (!fwd) return { fallback: 'WhatsApp cannot forward this kind of message' };
    const chat = this.chatJid(conversation);
    const timer = Number(this.state.get(`timer:${this.mapper.convId(chat)}`) ?? 0);
    if (timer) {
      const inner = Object.values(fwd)[0] as Record<string, any>;
      inner.contextInfo = { ...inner.contextInfo, expiration: timer };
    }
    const nativeId = await this.sendRaw(chat, fwd);
    if (note?.trim()) await this.send(conversation, note, undefined, undefined);
    return { nativeId };
  }

  private async openDirect(peer: string): Promise<P.OpenDirectResult> {
    this.requireLinked();
    let jid = peer.includes('@') ? bare(peer) : '';
    if (!jid) {
      const phone = peer.replace(/[^\d+]/g, '');
      const [r] = await this.rpc.call<{ query: string; jid: string; isIn: boolean; alt?: string }[]>('isOnWhatsApp', { phones: [phone.startsWith('+') ? phone : `+${phone}`] });
      if (!r?.isIn) throw new Error(`${peer} is not on WhatsApp`);
      jid = bare(r.jid);
      this.aliases.link(jid, r.alt);
    }
    const id = this.mapper.convId(jid);
    const existed = !!this.state.chat(id);
    if (!existed) this.ensureChat(id, jid, 0, false);
    return { conversation: id, existed, startsAtFirstSend: !existed };
  }

  private async fetchHistory(conversation: string, beforeTs: number | undefined, limit: number): Promise<{ count: number; done: boolean }> {
    this.requireLinked();
    const oldest = this.state.oldest(conversation);
    if (!oldest || (beforeTs !== undefined && oldest.ts > beforeTs + 60_000)) return { count: 0, done: true };
    const prev = this.historyWaiters.get(conversation);
    if (prev) prev(0);
    const got = new Promise<number>((resolve) => {
      this.historyWaiters.set(conversation, resolve);
      setTimeout(() => {
        if (this.historyWaiters.get(conversation) === resolve) this.historyWaiters.delete(conversation);
        resolve(0);
      }, this.opts.historyTimeoutMs ?? 40_000);
    });
    await this.rpc.call('historyRequest', { chat: oldest.chat, msgId: oldest.wid, fromMe: oldest.fromMe, ts: oldest.ts, sender: oldest.sender, count: Math.min(Math.max(limit, 1), 50) });
    const count = await got;
    return { count, done: count === 0 };
  }

  private async markRead(conversation: string, upTo: string) {
    this.requireLinked();
    const target = this.state.msg(upTo);
    const upToTs = target?.ts ?? Date.now();
    const acked = Number(this.state.get(`acked:${conversation}`) ?? 0);
    const msgs = this.state.incomingUpTo(conversation, upToTs, acked);
    if (msgs.length) {
      const chat = this.chatJid(conversation);
      const bySender = new Map<string, StoredMsg[]>();
      for (const m of msgs) (bySender.get(m.sender) ?? bySender.set(m.sender, []).get(m.sender)!).push(m);
      for (const [sender, list] of bySender) {
        await this.rpc.call('markRead', { chat, sender: isGroup(chat) ? sender : '', ids: list.map((m) => m.wid), ts: Date.now() });
      }
    }
    if (upToTs > acked) this.state.set(`acked:${conversation}`, String(upToTs));
    this.host.emit({ t: 'read', conversation, upToTs });
    return { marked: msgs.length };
  }

  private messageKey(m: StoredMsg) {
    const key: Record<string, unknown> = { remoteJID: m.chat, fromMe: m.fromMe, ID: m.wid };
    if (!m.fromMe && isGroup(m.chat) && m.sender) key.participant = m.sender;
    return key;
  }

  private async react(conversation: string, message: string, key: string, remove: boolean) {
    this.requireLinked();
    const m = this.state.msg(message);
    if (!m) throw new Error('That message is not in this WhatsApp account’s store');
    const me = this.selfIds().id;
    const prev = this.state.reaction(message, me);
    if (remove && prev !== key) return {};
    await this.rpc.call('send', { chat: m.chat, message: { reactionMessage: { key: this.messageKey(m), text: remove ? '' : key, senderTimestampMS: String(Date.now()) } } });
    if (prev && prev !== key) this.host.emit({ t: 'reaction', conversation, message, author: me, key: prev, remove: true });
    this.host.emit({ t: 'reaction', conversation, message, author: me, key, ...(remove ? { remove: true } : {}) });
    this.state.setReaction(message, me, remove ? null : key);
    return {};
  }

  private reactionContext(conversation: string): P.ReactionContext {
    const c = this.state.chat(conversation);
    if (!c) return { canReact: false, reason: 'Not in this chat any more', custom: [] };
    return { canReact: true, reason: 'One reaction per person: a new one replaces yours', custom: [] };
  }

  private async edit(conversation: string, message: string, body: string) {
    this.requireLinked();
    const m = this.state.msg(message);
    if (!m?.fromMe) throw new Error('You can only edit your own messages');
    if (Date.now() - m.ts > EDIT_WINDOW_MS) throw new Error('WhatsApp only allows edits in the first 15 minutes');
    const wa = toWhatsApp(body, (id) => this.mentionJid(m.chat, id), (id) => this.nameOf(id));
    const edited: WaMessage = wa.mentions.length ? { extendedTextMessage: { text: wa.text, contextInfo: { mentionedJID: wa.mentions } } } : { conversation: wa.text };
    const pm = { key: { remoteJID: m.chat, fromMe: true, ID: m.wid }, type: 'MESSAGE_EDIT', editedMessage: edited, timestampMS: String(Date.now()) };
    const r = await this.rpc.call<{ id: string; ts: number }>('send', { chat: m.chat, message: { editedMessage: { message: { protocolMessage: pm } } } });
    this.apply(this.mapper.message({ info: { id: r.id, chat: m.chat, sender: this.ownJid(), fromMe: true, isGroup: isGroup(m.chat), ts: r.ts || Date.now() }, message: { protocolMessage: pm }, flags: ['edit'] }));
    return {};
  }

  private async redact(conversation: string, message: string) {
    this.requireLinked();
    const m = this.state.msg(message);
    if (!m) throw new Error('That message is not in this WhatsApp account’s store');
    await this.rpc.call('send', { chat: m.chat, message: { protocolMessage: { key: this.messageKey(m), type: 'REVOKE' } } });
    this.state.dropMsg(message);
    this.host.emit({ t: 'delete', conversation, nativeId: message });
    return {};
  }

  private async fetchMedia(url: string): Promise<{ mime: string; base64: string }> {
    if (url.startsWith('wa-media:')) {
      const id = url.slice('wa-media:'.length);
      const m = this.state.msg(id);
      const media = mediaOf(m?.content);
      if (!m || !media) throw new Error('unknown WhatsApp media');
      const dir = join(this.host.accountDir, 'tmp');
      mkdirSync(dir, { recursive: true, mode: 0o700 });
      const dest = join(dir, crypto.randomUUID());
      try {
        const r = await this.rpc.call<{ path: string; directPath?: string }>('download', { message: { [media.key]: media.media }, dest, info: { id: m.wid, chat: m.chat, sender: m.sender, fromMe: m.fromMe } }, 120_000);
        if (r.directPath) this.state.updateContent(id, { ...m.content, [media.key]: { ...media.media, directPath: r.directPath } });
        const mime = (media.media.mimetype || 'application/octet-stream').split(';')[0].trim();
        return { mime, base64: readFileSync(dest).toString('base64') };
      } finally {
        if (existsSync(dest)) rmSync(dest);
      }
    }
    if (url.startsWith('wa-avatar:')) {
      const jid = url.slice('wa-avatar:'.length).split('?')[0];
      const miss = this.noAvatar.get(jid);
      if (miss && Date.now() - miss < 6 * 3600_000) throw new Error('no profile picture');
      const chat = this.state.chat(jid);
      const community = isGroup(jid) && !chat; // a community's parent group is a space, not a chat
      const p = await this.rpc.call<{ url: string; id: string } | null>('avatar', { jid, community });
      if (!p?.url) {
        this.noAvatar.set(jid, Date.now());
        throw new Error('no profile picture');
      }
      const res = await (this.opts.fetch ?? fetch)(p.url, { signal: AbortSignal.timeout(20_000) });
      if (!res.ok) throw new Error(`profile picture: HTTP ${res.status}`);
      return { mime: res.headers.get('content-type') ?? 'image/jpeg', base64: Buffer.from(await res.arrayBuffer()).toString('base64') };
    }
    throw new Error(`WhatsApp cannot fetch ${url.split(':')[0]} URLs`);
  }

  private async action(action: string, args: any): Promise<unknown> {
    switch (action) {
      case 'startLink':
      case 'refreshLink':
        if (this.self.loggedIn) throw new Error('Already linked. Use relink to link another phone.');
        if (!this.bridge?.alive) {
          await this.respawn();
          return { started: true };
        }
        await this.rpc.call('link');
        return { started: true };
      case 'pairPhone': {
        if (this.self.loggedIn) throw new Error('Already linked');
        const phone = String(args?.phone ?? '').trim();
        if (!/^\+?[\d\s().-]{7,20}$/.test(phone)) throw new Error('Give the phone number with its country code, like +15551234567');
        const r = await this.rpc.call<{ code: string }>('pairPhone', { phone }, 60_000);
        const code = r.code.length === 8 ? `${r.code.slice(0, 4)}-${r.code.slice(4)}` : r.code;
        this.setStatus('attention', { kind: 'link_device', message: `On your phone: WhatsApp → Settings → Linked devices → Link a device → Link with phone number instead, then enter ${code}`, detail: { pairCode: code } });
        return { code };
      }
      case 'relink':
      case 'logout':
        if (this.bridge?.alive && this.self.loggedIn) await this.rpc.call('logout').catch((e) => this.host.log('warn', `logout: ${e.message}`));
        this.unlinked(action);
        return {};
      case 'reconnect':
        clearTimeout(this.banTimer);
        this.phase = 'connecting';
        await this.respawn();
        return {};
      case 'resync':
        await this.snapshot(true);
        return { chats: this.state.chats().length };
      case 'typing': {
        const conv = String(args?.conversation ?? '');
        await this.rpc.call('chatPresence', { chat: this.chatJid(conv), state: args?.stop ? 'paused' : 'composing' });
        return {};
      }
      case 'status': {
        const b = this.bridge?.alive ? await this.rpc.call('status').catch(() => null) : null;
        return { phase: this.phase, bridge: b, chats: this.state.chats().length, messages: this.state.countMsgs() };
      }
    }
    throw new Error(`unknown action "${action}" (startLink, refreshLink, pairPhone, relink, logout, reconnect, resync, typing, status)`);
  }
}

/** A message as a quote: no quote of its own, no mentions to re-ping. */
export function quotable(m: WaMessage): WaMessage {
  const out: WaMessage = {};
  for (const [k, v] of Object.entries(m)) {
    if (k === 'messageContextInfo' || k === 'senderKeyDistributionMessage') continue;
    if (v && typeof v === 'object' && 'contextInfo' in (v as object)) {
      const { contextInfo: _, ...rest } = v as Record<string, unknown>;
      (out as any)[k] = rest;
    } else (out as any)[k] = v;
  }
  return out;
}

/** The message to send to forward this one, WhatsApp's way, or null if it cannot be forwarded. */
export function forwardable(m: WaMessage): WaMessage | null {
  if (m.reactionMessage || m.protocolMessage || m.pollCreationMessage || m.pollCreationMessageV2 || m.pollCreationMessageV3 || m.pollCreationMessageV5) return null;
  const media = mediaOf(m);
  if (media?.media.viewOnce) return null;
  const q = quotable(m);
  let key = Object.keys(q).find((k) => k !== 'messageContextInfo');
  if (!key) return null;
  let inner = q[key] as Record<string, unknown> | string;
  const prevScore = Number(contextOf(m)?.forwardingScore ?? 0);
  if (key === 'conversation') {
    key = 'extendedTextMessage';
    inner = { text: inner as string };
  }
  if (typeof inner !== 'object' || inner === null) return null;
  return { [key]: { ...inner, contextInfo: { isForwarded: true, forwardingScore: prevScore + 1 } } } as WaMessage;
}
