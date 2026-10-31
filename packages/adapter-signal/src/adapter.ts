/**
 * Signal adapter: a linked device driven through signal-cli.
 *
 *   no account   -> `signal-cli link` (LinkFlow), status 'attention' + QR URI
 *   linked       -> `signal-cli daemon --socket` (Daemon), JSON-RPC for commands,
 *                   `receive` notifications for incoming envelopes
 *   unlinked     -> back to linking (signal-cli keeps contacts/groups and relinks in place)
 *
 * The hub side is abstracted as AdapterHost so tests can drive the adapter
 * without a hub, and the signal-cli binary is injectable so tests can use a fake.
 */

import { existsSync, mkdirSync, readFileSync, rmSync, unlinkSync, writeFileSync } from 'node:fs';
import { join, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import type * as P from '@dither-chat/protocol';
import { ChildRegistry, type Logger } from './cli.ts';
import { Daemon, type DaemonExit } from './daemon.ts';
import { LinkFlow } from './link.ts';
import {
  contactIdentity,
  describeGroupChange,
  directConversation,
  displayNameOf,
  fileUrl,
  groupConversation,
  type MapContext,
  type MapResult,
  mapReceive,
  msgId,
  noteToSelf,
  parseConversation,
  parseMsgId,
  type SeenMessage,
} from './mapping.ts';
import { fromSignal, toSignal } from './markdown.ts';
import { RpcError, type RpcClient } from './rpc.ts';
import { AdapterState } from './state.ts';
import type { SigContact, SigGroup, SigReceive, SigSendResult } from './types.ts';

export const ADAPTER_VERSION = '0.1.0';
export const CAPABILITIES: P.Capability[] = ['send', 'react', 'edit', 'redact', 'markRead', 'typing', 'media'];
export const LINK_MESSAGE = 'Scan this QR code in Signal → Settings → Linked devices';

export interface AdapterHost {
  emit(ev: P.AdapterEvent): void;
  log: Logger;
  accountDir: string;
  config: Record<string, any>;
  secret(): Record<string, any>;
  saveSecret(value: unknown): void;
}

export interface AdapterOptions {
  /** argv prefix for signal-cli (resolved lazily: may run `nix build`). */
  signalCli: () => Promise<string[]>;
  linkRotateMs?: number;
  linkMaxActiveMs?: number;
  restartBackoffMs?: number[];
  /** Re-read contacts and groups at these offsets after the daemon is ready (sync data trickles in after linking)... */
  resnapshotMs?: number[];
  /** ...and then every this often. */
  resnapshotEveryMs?: number;
  expirySweepMs?: number;
  daemonReadyTimeoutMs?: number;
  daemonHealthEveryMs?: number;
}

type Phase = 'starting' | 'linking' | 'daemon' | 'relinking' | 'stopped' | 'broken';
type Status = Extract<P.AdapterEvent, { t: 'status' }>;

interface LinkedAccount {
  number: string;
  aci: string;
}

const lc = (s: string | null | undefined) => (s ? s.toLowerCase() : null);

export class SignalAdapter {
  readonly signalDir: string;
  private socketPath: string;
  private children: ChildRegistry;
  private state: AdapterState;
  private argv0: string[] = [];
  private env: Record<string, string | undefined>;
  private phase: Phase = 'starting';
  private account: LinkedAccount | null = null;
  private selfName: string | undefined;
  private link: LinkFlow | null = null;
  private daemon: Daemon | null = null;
  private restarts = 0;
  private restartTimer?: Timer;
  private snapshotTimers: Timer[] = [];
  private snapshotInterval?: Timer;
  private snapshotRunning = false;
  private snapshotAgain = false;
  private debouncedSnapshot?: Timer;
  private expiryTimer?: Timer;
  private lastStatus: Status | null = null;
  private facts = new Map<string, Record<string, unknown>>();
  private names = new Map<string, string>();
  private byNumber = new Map<string, string>();
  private knownGroups = new Set<string>();
  private timers = new Map<string, number>(); // conversation -> disappearing timer (s)
  private groupRefreshing = new Set<string>();
  private pendingGroupUpdates = new Map<string, SeenMessage>();
  private seenKeys = new Set<string>();
  /** conversation -> newest message timestamp we sent (or saw synced) a read receipt for */
  private acked = new Map<string, number>();
  private stickerCache = new Map<string, Map<number, { emoji?: string | null; contentType?: string | null }> | null>();

  constructor(
    private host: AdapterHost,
    private opts: AdapterOptions,
  ) {
    this.signalDir = resolve(host.accountDir, 'signal-cli');
    this.socketPath = socketPathFor(host.accountDir);
    this.children = new ChildRegistry(join(host.accountDir, 'signal-cli.pids'), this.signalDir, host.log);
    this.state = new AdapterState(join(host.accountDir, 'state.json'));
    for (const [id, g] of this.state.groups) {
      this.knownGroups.add(id);
      if (g.messageExpirationTime) this.timers.set(`group:${id}`, g.messageExpirationTime);
    }
    // Keep the user's own ~/.config/signal-cli/config.json (account, output, ...) out of our runs.
    const globalCfg = join(host.accountDir, 'signal-cli.global.json');
    if (!existsSync(globalCfg)) writeFileSync(globalCfg, '{}\n', { mode: 0o600 });
    this.env = { ...process.env, SIGNAL_CLI_CONFIG: globalCfg };
  }

  // ---------------------------------------------------------------- lifecycle

  hello() {
    this.host.emit({ t: 'hello', network: 'signal', version: ADAPTER_VERSION, capabilities: CAPABILITIES });
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
      this.argv0 = await this.opts.signalCli();
      await this.children.reapOrphans();
    } catch (e: any) {
      this.phase = 'broken';
      this.host.log('error', String(e?.message ?? e));
      this.setStatus('error', { kind: 'unknown', message: `signal-cli is not available: ${e?.message ?? e}` });
      return;
    }
    if (this.phase === 'stopped') return;
    this.account = this.findAccount();
    if (this.account) this.startDaemon();
    else this.startLink();
    this.expiryTimer = setInterval(() => this.sweepExpired(), this.opts.expirySweepMs ?? 30_000);
  }

  async shutdown() {
    this.phase = 'stopped';
    clearTimeout(this.restartTimer);
    clearInterval(this.expiryTimer);
    this.stopSnapshots();
    await Promise.all([this.link?.stop(), this.daemon?.stop()]);
    await this.children.killAll(3000);
    this.state.flush();
  }

  private setStatus(status: P.AccountStatus, attention?: Status['attention'], self?: P.IdentityFact) {
    const ev: Status = { t: 'status', status };
    if (attention !== undefined) ev.attention = attention;
    if (self) ev.self = self;
    this.lastStatus = ev;
    this.host.emit(ev);
  }

  private get self(): string {
    if (!this.account) throw new Error('Signal is not linked yet');
    return this.account.aci;
  }

  private get rpc(): RpcClient {
    const r = this.daemon?.rpc;
    if (!r?.open) throw new Error(this.account ? 'signal-cli is not connected yet' : 'Signal is not linked yet');
    return r;
  }

  private base(...rest: string[]) {
    const trust = this.host.config.trustNewIdentities ?? 'always';
    return [...this.argv0, '--config', this.signalDir, '--trust-new-identities', String(trust), ...rest];
  }

  /** signal-cli's own account list (<config>/data/accounts.json). */
  private readAccounts(): { number: string; uuid?: string }[] {
    const p = join(this.signalDir, 'data', 'accounts.json');
    if (!existsSync(p)) return [];
    try {
      const j = JSON.parse(readFileSync(p, 'utf8'));
      return (j.accounts ?? []).filter((a: any) => a?.number && (!a.environment || a.environment === 'LIVE'));
    } catch {
      return [];
    }
  }

  private findAccount(): LinkedAccount | null {
    const list = this.readAccounts().filter((a) => a.uuid);
    if (!list.length) return null;
    const s = this.host.secret();
    const pick = list.find((a) => lc(a.uuid) === lc(s.aci)) ?? list.find((a) => a.number === s.number) ?? list[0];
    return { number: pick.number, aci: lc(pick.uuid)! };
  }

  // ---------------------------------------------------------------- linking

  private startLink(reason?: 'unlinked' | 'relink') {
    if (this.phase === 'stopped') return;
    this.phase = 'linking';
    this.host.log('info', `starting device linking${reason ? ` (${reason})` : ''}`);
    const intro = reason === 'unlinked' ? 'This device was unlinked from your phone. ' : '';
    this.link = new LinkFlow({
      argv: (name) => this.base('link', '-n', name),
      env: this.env,
      deviceName: String(this.host.config.deviceName ?? 'dither-chat'),
      children: this.children,
      log: this.host.log,
      rotateAfterMs: this.opts.linkRotateMs,
      maxActiveMs: this.opts.linkMaxActiveMs,
      onUri: (qr, note, qrRefreshAt) => this.setStatus('attention', { kind: 'link_device', message: (note ? note + ' ' : '') + intro + LINK_MESSAGE, qr, qrRefreshAt }),
      onScanned: () => this.setStatus('connecting', null),
      onTrouble: (message) => this.setStatus('attention', { kind: 'link_device', message }),
      onPaused: () =>
        this.setStatus('attention', {
          kind: 'link_device',
          message: 'The QR code expired. Press New code for another one.',
        }),
      onLinked: (number) => this.linked(number).catch((e) => this.host.log('error', `after linking: ${e?.stack ?? e}`)),
    });
    this.link.start();
  }

  private async linked(number: string) {
    this.link = null;
    const acc = this.readAccounts().find((a) => a.number === number && a.uuid);
    if (!acc) {
      this.host.log('error', `linked as ${number}, but signal-cli's account list has no ACI for it`);
      this.setStatus('error', { kind: 'unknown', message: 'Linking finished but signal-cli did not record the account; relink.' });
      return;
    }
    this.account = { number, aci: lc(acc.uuid)! };
    this.host.saveSecret({ ...this.host.secret(), number, aci: this.account.aci, linkedAt: Date.now() });
    this.host.log('info', `linked as ${redactNumber(number)}`);
    this.restarts = 0;
    this.startDaemon();
  }

  // ---------------------------------------------------------------- daemon

  private startDaemon() {
    if (this.phase === 'stopped' || !this.account) return;
    this.phase = 'daemon';
    if (this.lastStatus?.status !== 'error') this.setStatus('connecting', null);
    const d = new Daemon({
      argv: this.base('-a', this.account.aci, 'daemon', '--socket', this.socketPath, '--receive-mode', 'on-connection', '--no-receive-stdout', '--ignore-stories'),
      env: this.env,
      socketPath: this.socketPath,
      children: this.children,
      log: this.host.log,
      readyTimeoutMs: this.opts.daemonReadyTimeoutMs,
      healthEveryMs: this.opts.daemonHealthEveryMs,
      onNotification: (method, params) => {
        if (d === this.daemon && method === 'receive') this.received(params as SigReceive);
      },
      onReady: () => {
        if (d === this.daemon) this.daemonReady().catch((e) => this.host.log('error', `daemon setup failed: ${e?.stack ?? e}`));
      },
      onExit: (info) => {
        if (d === this.daemon) this.daemonExited(info);
      },
    });
    this.daemon = d;
    d.start();
  }

  private async daemonReady() {
    const acc = this.account!;
    // The number may have changed on the phone since we linked.
    const now = this.readAccounts().find((a) => lc(a.uuid) === acc.aci);
    if (now && now.number !== acc.number) {
      acc.number = now.number;
      this.host.saveSecret({ ...this.host.secret(), number: now.number });
    }
    let me: SigContact | undefined;
    try {
      me = (await this.rpc.call<SigContact[]>('listContacts', { recipient: [acc.aci], allRecipients: true }, 30_000))?.find((c) => lc(c.uuid) === acc.aci);
    } catch (e: any) {
      this.host.log('warn', `could not read your own profile: ${e?.message ?? e}`);
    }
    this.selfName = (me && displayNameOf(me)) || this.selfName;
    const self: P.IdentityFact = { nativeId: acc.aci, handle: acc.number, isSelf: true };
    if (this.selfName) self.displayName = this.selfName;
    const avatar = this.avatarOf(acc.aci, acc.number);
    if (avatar) self.avatarUrl = avatar;
    this.setStatus('online', null, self);
    this.facts.set(`i:${acc.aci}`, { ...self });
    this.emitFact({ t: 'conversation', conversation: noteToSelf(acc.aci) });
    for (const peer of this.state.dms) this.emitFact({ t: 'conversation', conversation: directConversation(acc.aci, peer) });
    this.stopSnapshots();
    for (const at of this.opts.resnapshotMs ?? [0, 30_000, 120_000, 600_000]) this.snapshotTimers.push(setTimeout(() => void this.snapshot(), at));
    this.snapshotInterval = setInterval(() => void this.snapshot(), this.opts.resnapshotEveryMs ?? 1_800_000);
  }

  private stopSnapshots() {
    this.snapshotTimers.forEach(clearTimeout);
    this.snapshotTimers = [];
    clearInterval(this.snapshotInterval);
    clearTimeout(this.debouncedSnapshot);
  }

  private daemonExited(info: DaemonExit) {
    this.daemon = null;
    this.stopSnapshots();
    if (this.phase !== 'daemon') return;
    if (info.notRegistered) {
      this.host.log('warn', 'signal-cli says this device is no longer registered; relinking');
      this.startLink('unlinked');
      return;
    }
    if (info.wasReady && info.uptimeMs > 120_000) this.restarts = 0;
    const delays = this.opts.restartBackoffMs ?? [1000, 2000, 5000, 10_000, 30_000, 60_000];
    const delay = delays[Math.min(this.restarts, delays.length - 1)];
    this.restarts++;
    const why = info.lastErr || `exited with code ${info.code}${info.signal ? ` (${info.signal})` : ''}`;
    this.host.log('warn', `signal-cli daemon stopped (${why}); restarting in ${Math.round(delay / 1000)}s`);
    if (this.restarts >= 3) this.setStatus('error', { kind: 'unknown', message: `signal-cli keeps stopping: ${why}` });
    else this.setStatus('connecting', null);
    clearTimeout(this.restartTimer);
    this.restartTimer = setTimeout(() => this.startDaemon(), delay);
  }

  // ---------------------------------------------------------------- facts

  /** Emit identity/conversation facts only when they add something. */
  private emitFact(ev: Extract<P.AdapterEvent, { t: 'identity' | 'conversation' }>) {
    const fact = (ev.t === 'identity' ? ev.identity : ev.conversation) as unknown as Record<string, unknown>;
    const key = `${ev.t === 'identity' ? 'i' : 'c'}:${fact.nativeId}`;
    const prev = this.facts.get(key);
    const merged = { ...(prev ?? {}) };
    for (const [k, v] of Object.entries(fact)) if (v !== undefined) merged[k] = v;
    if (prev && stableJson(prev) === stableJson(merged)) return;
    this.facts.set(key, merged);
    this.host.emit(ev);
  }

  private avatarOf(aci: string, number?: string | null): string | undefined {
    const names = [number && `profile-${number}`, `profile-${aci}`, number && `contact-${number}`, `contact-${aci}`].filter(Boolean) as string[];
    for (const n of names) {
      const p = join(this.signalDir, 'avatars', n);
      if (existsSync(p)) return fileUrl(p);
    }
    return undefined;
  }

  private groupAvatar(groupId: string): string | undefined {
    const p = join(this.signalDir, 'avatars', `group-${groupId.replace(/\//g, '_')}`);
    return existsSync(p) ? fileUrl(p) : undefined;
  }

  private nameOf = (aci: string): string => this.names.get(aci) ?? (String(this.facts.get(`i:${aci}`)?.handle ?? '') || 'Someone');

  /** Contacts, everyone relevant, groups, known 1:1s. */
  async snapshot() {
    if (!this.daemon?.rpc?.open || !this.account) return;
    if (this.snapshotRunning) {
      this.snapshotAgain = true;
      return;
    }
    this.snapshotRunning = true;
    const self = this.account.aci;
    try {
      const rpc = this.rpc;
      const everyone = (await rpc.call<SigContact[]>('listContacts', { allRecipients: true }, 300_000)) ?? [];
      const contacts = (await rpc.call<SigContact[]>('listContacts', {}, 300_000)) ?? [];
      const groups = (await rpc.call<SigGroup[]>('listGroups', {}, 120_000)) ?? [];
      const contactIds = new Set(contacts.map((c) => lc(c.uuid)).filter((x): x is string => !!x));
      const all = new Map<string, SigContact>();
      for (const c of [...everyone, ...contacts]) {
        const id = lc(c.uuid);
        if (!id) continue;
        all.set(id, c);
        const name = displayNameOf(c);
        if (name) this.names.set(id, name);
        if (c.number) this.byNumber.set(c.number, id);
        if (c.messageExpirationTime !== undefined && id !== self) this.timers.set(`dm:${self}:${id}`, c.messageExpirationTime);
      }
      const relevant = new Set<string>([...contactIds, ...this.state.dms]);
      for (const g of groups) if (g.isMember !== false) for (const m of g.members ?? []) if (m.uuid) relevant.add(lc(m.uuid)!);
      for (const [id, c] of all) {
        if (id === self || !relevant.has(id)) continue;
        const f = contactIdentity(c, { contact: contactIds.has(id) && !c.isHidden, avatarUrl: this.avatarOf(id, c.number) });
        if (f) this.emitFact({ t: 'identity', identity: f });
      }
      const me = all.get(self);
      if (me) {
        const name = displayNameOf(me);
        if (name && name !== this.selfName) {
          this.selfName = name;
          this.emitFact({ t: 'identity', identity: { nativeId: self, handle: this.account.number, displayName: name, isSelf: true } });
        }
      }
      for (const g of groups) this.applyGroup(g);
      this.emitFact({ t: 'conversation', conversation: noteToSelf(self) });
      for (const peer of this.state.dms) this.emitFact({ t: 'conversation', conversation: directConversation(self, peer) });
      this.state.save();
      this.host.log('debug', `snapshot: ${contacts.length} contacts, ${all.size} recipients, ${groups.length} groups, ${this.state.dms.size} 1:1s`);
    } catch (e: any) {
      this.host.log('warn', `could not read contacts/groups: ${e?.message ?? e}`);
    } finally {
      this.snapshotRunning = false;
      if (this.snapshotAgain) {
        this.snapshotAgain = false;
        this.scheduleSnapshot(1000);
      }
    }
  }

  private scheduleSnapshot(delay: number) {
    clearTimeout(this.debouncedSnapshot);
    this.debouncedSnapshot = setTimeout(() => void this.snapshot(), delay);
  }

  /** Emit a group's conversation fact. Groups you left or were removed from keep their history (no `leave`). */
  private applyGroup(g: SigGroup) {
    if (g.isMember === false && !this.knownGroups.has(g.id)) return; // pending invitations, groups left long ago
    this.emitFact({ t: 'conversation', conversation: groupConversation(g, { avatarUrl: this.groupAvatar(g.id) }) });
    this.knownGroups.add(g.id);
    this.state.groups.set(g.id, g);
    this.timers.set(`group:${g.id}`, g.messageExpirationTime ?? 0);
  }

  private async refreshGroup(groupId: string) {
    if (this.groupRefreshing.has(groupId)) return;
    this.groupRefreshing.add(groupId);
    try {
      const [g] = (await this.rpc.call<SigGroup[]>('listGroups', { groupId: [groupId] }, 60_000)) ?? [];
      if (!g) return;
      const before = this.state.groups.get(groupId);
      for (const m of g.members ?? []) {
        const id = lc(m.uuid);
        if (id && m.number && !this.byNumber.has(m.number)) this.byNumber.set(m.number, id);
      }
      this.applyGroup(g);
      const pend = this.pendingGroupUpdates.get(groupId);
      if (pend) {
        this.pendingGroupUpdates.delete(groupId);
        const body = describeGroupChange(before, g, pend.author, this.self, this.nameOf);
        if (body !== pend.text) {
          this.host.emit({ t: 'message', live: true, message: { nativeId: pend.nativeId, conversation: pend.conversation, author: pend.author, ts: pend.ts, kind: 'system', body } });
          this.state.remember(pend.nativeId, pend.conversation, body);
        }
      }
      this.state.save();
    } catch (e: any) {
      this.host.log('debug', `group refresh failed: ${e?.message ?? e}`);
    } finally {
      this.groupRefreshing.delete(groupId);
    }
  }

  // ---------------------------------------------------------------- incoming

  mapContext(): MapContext {
    return {
      self: this.self,
      selfNumber: this.account?.number,
      signalDir: this.signalDir,
      conversationOf: (id) => this.state.conversationOf(id),
      aciOfNumber: (n) => this.byNumber.get(n),
      knownGroup: (g) => this.knownGroups.has(g),
      sticker: (packId, stickerId) => this.stickerInfo(packId, stickerId),
      nameOf: (aci) => this.names.get(aci),
      once: (key) => {
        if (this.seenKeys.has(key)) return false;
        this.seenKeys.add(key);
        if (this.seenKeys.size > 2000) this.seenKeys.delete(this.seenKeys.values().next().value!);
        return true;
      },
    };
  }

  private stickerInfo(packId: string, stickerId: number) {
    let pack = this.stickerCache.get(packId);
    if (pack === undefined || pack === null) {
      const p = join(this.signalDir, 'stickers', packId.replace(/[^0-9a-f]/gi, ''), 'manifest.json');
      if (!existsSync(p)) return undefined; // still downloading; don't cache the miss
      try {
        const m = JSON.parse(readFileSync(p, 'utf8'));
        pack = new Map();
        for (const s of [...(m.stickers ?? []), ...(m.cover ? [m.cover] : [])]) pack.set(Number(s.id ?? s.file), { emoji: s.emoji, contentType: s.contentType });
        this.stickerCache.set(packId, pack);
      } catch {
        return undefined;
      }
    }
    return pack.get(stickerId);
  }

  /** One `receive` notification. Public for tests. */
  received(rcv: SigReceive) {
    if (!this.account) return;
    let r: MapResult;
    try {
      r = mapReceive(rcv, this.mapContext());
    } catch (e: any) {
      this.host.log('error', `could not map an incoming envelope: ${e?.message ?? e}`, { ts: rcv.envelope?.timestamp });
      return;
    }
    this.apply(r);
  }

  private apply(r: MapResult) {
    const self = this.self;
    for (const l of r.logs) this.host.log(l.level, l.msg, l.data);
    for (const ev of r.events) {
      if (ev.t === 'identity') {
        if (ev.identity.displayName) this.names.set(ev.identity.nativeId, ev.identity.displayName);
        if (ev.identity.handle && /^\+\d+$/.test(ev.identity.handle)) this.byNumber.set(ev.identity.handle, ev.identity.nativeId);
        this.emitFact(ev);
      } else if (ev.t === 'conversation') {
        const c = ev.conversation;
        if (c.shape === 'direct') {
          const peer = c.participants?.find((p) => p !== self);
          if (peer && !this.state.dms.has(peer)) {
            this.state.dms.add(peer);
            this.state.save();
          }
        }
        if (c.nativeId.startsWith('group:') && c.participants) this.knownGroups.add(c.nativeId.slice(6));
        this.emitFact(ev);
      } else {
        this.host.emit(ev);
        if (ev.t === 'delete') this.purge(ev.nativeId);
        if (ev.t === 'read') {
          this.state.takeUnread(ev.conversation, ev.upToTs);
          this.acked.set(ev.conversation, Math.max(this.acked.get(ev.conversation) ?? 0, ev.upToTs));
          this.startExpiry(ev.conversation, ev.upToTs);
        }
      }
    }
    for (const m of r.messages) {
      this.state.remember(m.nativeId, m.conversation, m.text, m.replyTo, m.files);
      if (m.author !== self && !m.edited && m.kind !== 'system' && m.kind !== 'call' && m.ts > (this.acked.get(m.conversation) ?? 0)) {
        this.state.addUnread(m.conversation, m.author, m.ts);
      }
      if (m.timer !== undefined) this.timers.set(m.conversation, m.timer);
      if (m.expiresInSeconds) this.trackExpiry(m, m.expiresInSeconds, m.author === self ? Date.now() : undefined);
      if (m.groupUpdate) this.pendingGroupUpdates.set(m.groupUpdate, m);
    }
    for (const g of r.refreshGroups) setTimeout(() => void this.refreshGroup(g), 500);
    if (r.resync) this.scheduleSnapshot(5000);
  }

  // ---------------------------------------------------------------- disappearing messages

  /** Remember a disappearing message. Its timer starts when it is read (or at once for your own). */
  private trackExpiry(m: { nativeId: string; conversation: string; ts: number; files?: string[] }, ttl: number, started?: number) {
    if (!ttl || this.state.expiring.some((e) => e.id === m.nativeId)) return;
    this.state.expiring.push({ id: m.nativeId, conversation: m.conversation, ts: m.ts, ttl, ...(started ? { started } : {}), ...(m.files?.length ? { files: m.files } : {}) });
    this.state.save();
  }

  private startExpiry(conversation: string, upToTs: number) {
    const now = Date.now();
    let changed = false;
    for (const e of this.state.expiring) {
      if (e.conversation === conversation && e.ts <= upToTs && !e.started) {
        e.started = now;
        changed = true;
      }
    }
    if (changed) this.state.save();
  }

  /** A message is gone (remote delete, expiry, redact): drop its text and downloaded files, as Signal clients do. */
  private purge(id: string, extraFiles: string[] = []) {
    const attachments = join(this.signalDir, 'attachments') + sep;
    for (const f of new Set([...this.state.forget(id), ...extraFiles])) {
      const p = resolve(f);
      if (p.startsWith(attachments)) rmSync(p, { force: true });
    }
  }

  /** Delete disappearing messages whose timer ran out, including their downloaded files. Public for tests. */
  sweepExpired(now = Date.now()) {
    const keep: typeof this.state.expiring = [];
    for (const e of this.state.expiring) {
      if (e.started && e.started + e.ttl * 1000 <= now) {
        this.host.emit({ t: 'delete', conversation: e.conversation, nativeId: e.id });
        this.purge(e.id, e.files);
      } else keep.push(e);
    }
    if (keep.length !== this.state.expiring.length) {
      this.state.expiring = keep;
      this.state.save();
    }
  }

  // ---------------------------------------------------------------- commands

  private target(conversation: string): Record<string, unknown> {
    const t = parseConversation(conversation, this.self);
    if (!t) throw new Error(`not a Signal conversation of this account: ${conversation}`);
    if (t.kind === 'group') return { groupId: t.groupId };
    if (t.kind === 'self') return { noteToSelf: true };
    return { recipient: [t.peer] };
  }

  private message(id: string) {
    const m = parseMsgId(id);
    if (!m) throw new Error(`not a Signal message id: ${id}`);
    return m;
  }

  async command(cmd: P.AdapterCommand): Promise<unknown> {
    switch (cmd.t) {
      case 'history':
        // Linked devices receive no history from the phone.
        return { count: 0, done: true };
      case 'send':
        return this.send(cmd.conversation, cmd.body, cmd.replyTo);
      case 'edit':
        return this.edit(cmd.conversation, cmd.message, cmd.body);
      case 'react': {
        const m = this.message(cmd.message);
        await this.call('sendReaction', { ...this.target(cmd.conversation), emoji: cmd.key, targetAuthor: m.author, targetTimestamp: m.ts, ...(cmd.remove ? { remove: true } : {}) });
        this.host.emit({ t: 'reaction', conversation: cmd.conversation, message: cmd.message, author: this.self, key: cmd.key, ...(cmd.remove ? { remove: true } : {}) });
        return {};
      }
      case 'reactionContext':
        return this.reactionContext(cmd.conversation);
      case 'reactors':
        return { authors: [] }; // Signal names every reactor up front
      case 'redact': {
        const m = this.message(cmd.message);
        if (m.author !== this.self) throw new Error('Signal only lets you delete your own messages for everyone');
        await this.call('remoteDelete', { ...this.target(cmd.conversation), targetTimestamp: m.ts });
        this.host.emit({ t: 'delete', conversation: cmd.conversation, nativeId: cmd.message });
        this.purge(cmd.message);
        return {};
      }
      case 'markRead':
        return this.markRead(cmd.conversation, cmd.upTo);
      case 'fetchMedia':
        return this.fetchMedia(cmd.url);
      case 'action':
        return this.action(cmd.action, cmd.args);
      case 'shutdown':
        return undefined;
    }
  }

  /** Signal has no custom emoji or super reactions. The one thing that stops you is having left the group. */
  private reactionContext(conversation: string): P.ReactionContext {
    const t = parseConversation(conversation, this.self);
    const left = t?.kind === 'group' && this.state.groups.get(t.groupId)?.isMember === false;
    return { canReact: !left, ...(left ? { reason: 'You are no longer in this group.' } : {}), custom: [] };
  }

  private async call<T = SigSendResult>(method: string, params: Record<string, unknown>, timeoutMs = 90_000): Promise<T> {
    try {
      const r = await this.rpc.call<T>(method, params, timeoutMs);
      if (this.lastStatus?.attention?.kind === 'rate_limited') this.setStatus('online', null);
      return r;
    } catch (e) {
      if (e instanceof RpcError && e.code === -5) {
        this.setStatus('attention', { kind: 'rate_limited', message: `Signal is rate limiting this device: ${e.message}` });
      }
      throw e;
    }
  }

  private async send(conversation: string, body: string, replyTo?: string) {
    const self = this.self;
    const st = toSignal(body);
    const params: Record<string, unknown> = { ...this.target(conversation), message: st.text };
    if (st.textStyles.length) params.textStyle = st.textStyles;
    if (st.mentions.length) params.mention = st.mentions;
    if (replyTo) {
      const q = this.message(replyTo);
      params.quoteTimestamp = q.ts;
      params.quoteAuthor = q.author;
      const text = this.state.textOf(replyTo);
      if (text) params.quoteMessage = text;
    }
    const res = await this.call('send', params);
    this.logPartialFailure('send', res);
    const ts = res.timestamp;
    const nativeId = msgId(self, ts);
    const t = parseConversation(conversation, self)!;
    if (t.kind === 'dm') this.apply(emptyResult({ t: 'conversation', conversation: directConversation(self, t.peer) }));
    const fact: P.MessageFact = { nativeId, conversation, author: self, ts, kind: 'text', body: fromSignal(st.text, st.styles, st.mentionRanges) };
    if (replyTo) fact.replyTo = replyTo;
    this.host.emit({ t: 'message', live: true, message: fact });
    this.state.remember(nativeId, conversation, st.text, replyTo);
    const timer = this.timers.get(conversation);
    if (timer) this.trackExpiry({ nativeId, conversation, ts }, timer, Date.now());
    return { nativeId };
  }

  private async edit(conversation: string, message: string, body: string) {
    const self = this.self;
    const m = this.message(message);
    if (m.author !== self) throw new Error('you can only edit your own messages');
    const st = toSignal(body);
    const params: Record<string, unknown> = { ...this.target(conversation), message: st.text, editTimestamp: m.ts };
    if (st.textStyles.length) params.textStyle = st.textStyles;
    if (st.mentions.length) params.mention = st.mentions;
    // Clients rebuild the message from the edit, so a quote has to be sent again.
    const replyTo = this.state.replyOf(message);
    const q = replyTo ? parseMsgId(replyTo) : null;
    if (q) {
      params.quoteTimestamp = q.ts;
      params.quoteAuthor = q.author;
      const text = this.state.textOf(replyTo!);
      if (text) params.quoteMessage = text;
    }
    const res = await this.call('send', params);
    this.logPartialFailure('edit', res);
    this.host.emit({
      t: 'message',
      live: true,
      message: { nativeId: message, conversation, author: self, ts: m.ts, editedTs: res.timestamp, kind: 'text', body: fromSignal(st.text, st.styles, st.mentionRanges) },
    });
    this.state.remember(message, conversation, st.text);
    return { nativeId: message };
  }

  private async markRead(conversation: string, upTo: string) {
    const self = this.self;
    const m = this.message(upTo);
    const acks = this.state.takeUnread(conversation, m.ts);
    // Nothing tracked (e.g. after a restart): acknowledge the target itself, once.
    if (!acks.length && m.author !== self && m.ts > (this.acked.get(conversation) ?? 0)) acks.push([m.author, m.ts]);
    this.acked.set(conversation, Math.max(this.acked.get(conversation) ?? 0, m.ts));
    this.startExpiry(conversation, m.ts);
    const byAuthor = new Map<string, number[]>();
    for (const [a, ts] of acks) if (a !== self) (byAuthor.get(a) ?? byAuthor.set(a, []).get(a)!).push(ts);
    for (const [author, tss] of byAuthor) {
      // Also tells your other devices (the phone) that these are read.
      await this.call('sendReceipt', { recipient: author, targetTimestamp: tss.sort((a, b) => a - b), type: 'read' });
    }
    return { receipts: [...byAuthor.values()].reduce((n, l) => n + l.length, 0) };
  }

  private logPartialFailure(what: string, res: SigSendResult) {
    const failed = (res?.results ?? []).filter((r) => r.type !== 'SUCCESS');
    if (failed.length) this.host.log('warn', `${what}: ${failed.length} recipient(s) failed`, failed.map((f) => ({ type: f.type, uuid: f.recipientAddress?.uuid })));
  }

  private async fetchMedia(url: string) {
    if (!url.startsWith('file://')) throw new Error(`Signal media is served from disk; cannot fetch ${url.split(':')[0]} URLs`);
    const p = resolve(fileURLToPath(url));
    if (!p.startsWith(this.signalDir + sep) || !existsSync(p)) throw new Error('no such Signal media file');
    const bytes = readFileSync(p);
    return { mime: sniffMime(bytes, p), base64: bytes.toString('base64') };
  }

  private async action(action: string, args: any): Promise<unknown> {
    switch (action) {
      case 'relink':
        await this.relink();
        return { ok: true };
      case 'startLink':
      case 'refreshLink':
        if (this.phase === 'linking' && this.link) {
          this.link.refresh();
          return { ok: true };
        }
        if (!this.account) {
          this.startLink();
          return { ok: true };
        }
        throw new Error('already linked; use "relink" to link this account again');
      case 'resync':
        if (!this.daemon?.rpc?.open) throw new Error(this.account ? 'signal-cli is not connected yet' : 'Signal is not linked yet');
        // Ask the phone for contacts, groups and settings again, then re-read what signal-cli has.
        await this.call('sendSyncRequest', {}).catch((e) => this.host.log('warn', `sendSyncRequest failed: ${e?.message ?? e}`));
        await this.snapshot();
        this.scheduleSnapshot(30_000);
        return { ok: true };
      case 'typing': {
        const t = parseConversation(String(args?.conversation ?? ''), this.self);
        if (!t || t.kind === 'self') return { ok: false };
        await this.call('sendTyping', { ...(t.kind === 'group' ? { groupId: t.groupId } : { recipient: [t.peer] }), ...(args?.stop ? { stop: true } : {}) });
        return { ok: true };
      }
      case 'status':
        return {
          phase: this.phase,
          linked: !!this.account,
          number: this.account?.number ?? null,
          aci: this.account?.aci ?? null,
          connected: !!this.daemon?.rpc?.open,
          restarts: this.restarts,
          linkUri: this.link?.currentUri ? 'present' : null,
        };
      default:
        throw new Error(`unknown action "${action}" (relink, startLink, resync, typing, status)`);
    }
  }

  /** Forget this device's Signal identity entirely and link again. */
  private async relink() {
    this.host.log('info', 'relink: wiping signal-cli data');
    this.phase = 'relinking';
    clearTimeout(this.restartTimer);
    this.stopSnapshots();
    await this.link?.stop();
    this.link = null;
    await this.daemon?.stop();
    this.daemon = null;
    await this.children.killAll(3000);
    rmSync(this.signalDir, { recursive: true, force: true });
    try {
      if (existsSync(this.socketPath)) unlinkSync(this.socketPath);
    } catch {}
    this.state.clear();
    this.facts.clear();
    this.names.clear();
    this.byNumber.clear();
    this.knownGroups.clear();
    this.timers.clear();
    this.pendingGroupUpdates.clear();
    const { number: _n, aci: _a, linkedAt: _l, ...rest } = this.host.secret();
    this.host.saveSecret(rest);
    this.account = null;
    this.selfName = undefined;
    this.restarts = 0;
    this.startLink('relink');
  }
}

// ------------------------------------------------------------------ helpers

function emptyResult(ev: P.AdapterEvent): MapResult {
  return { events: [ev], messages: [], refreshGroups: [], resync: false, logs: [] };
}

function stableJson(o: Record<string, unknown>) {
  return JSON.stringify(Object.keys(o).sort().map((k) => [k, o[k]]));
}

function redactNumber(n: string) {
  return n.length > 5 ? n.slice(0, 3) + '…' + n.slice(-2) : n;
}

/** UNIX socket paths are limited to ~107 bytes; fall back to a private runtime dir. */
export function socketPathFor(accountDir: string): string {
  const p = join(resolve(accountDir), 'signal-cli.sock');
  if (Buffer.byteLength(p) <= 100) return p;
  const base = process.env.XDG_RUNTIME_DIR || '/tmp';
  const h = new Bun.CryptoHasher('sha256').update(resolve(accountDir)).digest('hex').slice(0, 16);
  const dir = join(base, `dither-signal-${h}`);
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  return join(dir, 'rpc.sock');
}

function sniffMime(b: Uint8Array, path: string): string {
  const head = (n: number) => Buffer.from(b.subarray(0, n)).toString('latin1');
  if (head(4) === '\x89PNG') return 'image/png';
  if (b[0] === 0xff && b[1] === 0xd8) return 'image/jpeg';
  if (head(4) === 'GIF8') return 'image/gif';
  if (head(4) === 'RIFF' && Buffer.from(b.subarray(8, 12)).toString('latin1') === 'WEBP') return 'image/webp';
  if (Buffer.from(b.subarray(4, 8)).toString('latin1') === 'ftyp') return 'video/mp4';
  const t = Bun.file(path).type;
  return t && !t.startsWith('application/octet-stream') ? t.split(';')[0] : 'application/octet-stream';
}
