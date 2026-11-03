/**
 * dither-chat Discord adapter (one process per account).
 *
 * Spawns and supervises the sandbox (Xvfb + real Chromium + our extension +
 * x11vnc), runs the loopback WebSocket server the extension connects to, and maps
 * the raw Discord objects the in-page hook forwards into protocol facts for the
 * hub. Commands from the hub are run back through the client's own code paths,
 * paced like a human.
 *
 * Started by the hub supervisor with DITHER_* env; see protocol/adapter-client.ts.
 */

import { readFileSync } from 'node:fs';
import { linkHub } from '@dither-chat/protocol/client';
import type * as P from '@dither-chat/protocol';
import type { BridgeUp, HookCommand, PageState, RawChannel, RawEmoji, RawGuild, RawUser } from './discord-types.ts';
import { messageEvents, newState, openedDirect, translateDispatch, translateSnapshot, userFacts } from './ingest.ts';
import { customEmoji, DISCORD_EPOCH, guildIconUrl, mapUser } from './map.ts';
import { BridgeServer, PaceQueue } from './server.ts';
import { Sandbox, pickDisplay } from './sandbox.ts';

const CAPABILITIES: P.Capability[] = ['send', 'history', 'react', 'edit', 'redact', 'markRead', 'typing', 'threads', 'media', 'liveView', 'sendMedia', 'openDirect', 'calls', 'forward'];
const WIDTH = 1280;
const HEIGHT = 800;

const hub = linkHub({ onCommand, onConnect, onShutdown });
const log = (level: 'debug' | 'info' | 'warn' | 'error', msg: string, data?: unknown) => hub.log(level, msg, data);

interface RawReactionContext {
  canReact: boolean;
  reason?: string;
  existingOnly?: boolean;
  nitro: boolean;
  custom: { guild: RawGuild; here: boolean; emoji: RawEmoji[] }[];
}

// -------------------------------------------------------------------- state
const { display, vncPort } = pickDisplay(hub.accountId, hub.config);
const adapterPort = Number(hub.config.adapterPort ?? process.env.DITHER_ADAPTER_WS_PORT ?? 8700 + display);
const startUrl: string = hub.config.startUrl ?? 'https://discord.com/app';

const st = newState();
let selfUser: RawUser | undefined;
let lastPage: PageState = 'loading';
let lastFinders: Record<string, boolean> = {};
let gotFinders = false;
let snapshotReceived = false;

let status: P.AccountStatus = 'connecting';
let attention: Omit<P.Attention, 'since'> | null = null;

function pushStatus(extra: Partial<Extract<P.AdapterEvent, { t: 'status' }>> = {}) {
  hub.emit({
    t: 'status',
    status,
    attention,
    liveView: { vncPort, width: WIDTH, height: HEIGHT },
    ...(selfUser ? { self: mapUser(selfUser, { isSelf: true }) } : {}),
    ...extra,
  });
}

function setStatus(s: P.AccountStatus, att: Omit<P.Attention, 'since'> | null) {
  status = s;
  attention = att;
  pushStatus();
}

// --------------------------------------------------------------- bridge server
/** A loopback-only token for the extension<->adapter socket (distinct from the hub token). */
function deriveBridgeToken(): string {
  return Buffer.from(new Bun.CryptoHasher('sha256').update(`${hub.accountId}:bridge:${process.env.DITHER_ADAPTER_TOKEN ?? ''}`).digest()).toString('base64url').slice(0, 32);
}
const bridgeToken: string = hub.config.__bridgeToken ?? deriveBridgeToken();

const bridge = new BridgeServer({
  port: adapterPort,
  token: bridgeToken,
  onMessage: handleBridge,
  onConnect: () => log('info', 'sandbox extension attached'),
  onDisconnect: () => log('info', 'sandbox extension detached'),
  log,
});

const pace = new PaceQueue({ minGapMs: 1200, jitterMs: 600, log: (m, d) => log('debug', m, d) });
const historyPace = new PaceQueue({ minGapMs: 1500, jitterMs: 1500, log: (m, d) => log('debug', m, d) });

let sandbox: Sandbox | null = null;

// ---------------------------------------------------------------------- boot
async function boot() {
  bridge.start();
  const wsUrl = `ws://127.0.0.1:${bridge.port}/`;
  sandbox = new Sandbox({
    accountDir: hub.accountDir,
    display,
    vncPort,
    width: WIDTH,
    height: HEIGHT,
    wsUrl,
    token: bridgeToken,
    startUrl,
    noSandbox: !!hub.config.noSandbox || process.env.DITHER_CHROMIUM_NO_SANDBOX === '1',
    lab: hub.config.lab === true && process.env.DITHER_LAB === '1',
    log,
  });

  // Report the live view immediately so the "Needs you" card can open it.
  setStatus('connecting', null);

  try {
    await sandbox.start();
  } catch (e: any) {
    log('error', 'sandbox failed to start', String(e?.message ?? e));
    setStatus('error', { kind: 'unknown', message: `Sandbox failed: ${String(e?.message ?? e)}`, liveView: false });
    return;
  }
  pushStatus();

  const secret = hub.secret<{ token?: string; email?: string; password?: string }>();
  if (secret.token || secret.password) {
    // Auto-login is intentionally not wired up in this build; the user logs in
    // once through the live view and the persistent profile keeps the session.
    log('info', 'secret.json present, but auto-login is not enabled; log in via the live view once');
  }

  // Watchdog: if Chromium dies, surface it; the hub supervisor will restart us.
  const watch = setInterval(() => {
    if (sandbox && !sandbox.browserAlive) {
      clearInterval(watch);
      log('warn', 'chromium exited; adapter will exit for a supervised restart');
      void shutdownAndExit(1);
    }
  }, 5000);
}

// ------------------------------------------------------------- bridge handling
function handleBridge(msg: BridgeUp) {
  switch (msg.t) {
    case 'ready':
      log('info', 'extension service worker ready');
      break;
    case 'log':
      hub.log(msg.level, `[hook] ${msg.msg}`, msg.data);
      break;
    case 'finders':
      lastFinders = msg.results;
      gotFinders = true;
      log('info', 'finder results', { results: msg.results, detail: msg.detail });
      evaluateHealth();
      break;
    case 'page':
      lastPage = msg.state;
      onPageState(msg.state);
      break;
    case 'connection':
      log('info', `discord gateway ${msg.open ? 'open' : 'closed'}`);
      break;
    case 'snapshot':
      ingestSnapshot(msg.data);
      break;
    case 'identities':
      for (const u of msg.users) hub.emit({ t: 'identity', identity: mapUser(u, { contact: st.friends.has(u.id) }) });
      break;
    case 'dispatch':
      for (const ev of translateDispatch(msg.event, msg.data, st)) hub.emit(ev);
      break;
    case 'loginIssue':
      onLoginIssue(msg);
      break;
    case 'call':
      for (const u of msg.users ?? []) hub.emit({ t: 'identity', identity: mapUser(u, { contact: st.friends.has(u.id) }) });
      hub.emit({
        t: 'call',
        call: msg.call,
        ...(msg.signal !== undefined ? { signal: msg.signal } : {}),
        ...(msg.state ? { state: { conversation: msg.state.channelId, participants: msg.state.participants } } : {}),
        ...(msg.ended ? { ended: msg.ended } : {}),
      });
      break;
  }
}

/** Why the last sign-in failed, in words, for the account card. The page itself just starts over. */
let loginNote: string | null = null;

function onLoginIssue(i: Extract<BridgeUp, { t: 'loginIssue' }>) {
  log('warn', `sign-in: ${i.route} answered ${i.status}${i.captcha ? ` captcha ${i.captcha}` : ''}${i.message ? `: ${i.message}` : ''}`);
  if (i.route.includes('remote-auth') && /ticket/i.test(i.message ?? '')) {
    loginNote = "Discord's QR ticket ran out while the captcha was open, so the page started over. Sign in with email and password instead: there is no ticket to run out, and you can paste into the live view.";
  } else if (i.captcha === 'invalid-response') {
    loginNote = 'Discord rejected the captcha answer and asked for another. Open the live view to finish it.';
  } else return;
  if (lastPage === 'login') onPageState('login');
}

function onPageState(state: PageState) {
  if (state === 'captcha') setStatus('attention', { kind: 'captcha', message: 'A captcha is on screen. Open the live view to solve it.', liveView: true });
  else if (state === 'verify') setStatus('attention', { kind: 'verify', message: 'Discord wants to verify this login. Open the live view.', liveView: true });
  else if (state === 'login') setStatus('attention', { kind: 'login', message: loginNote ?? 'Not logged in. Open the live view and sign in.', liveView: true });
  else if (state === 'crashed') setStatus('attention', { kind: 'unknown', message: 'The Discord page failed to load and is reloading. Open the live view if it stays stuck.', liveView: true });
  else if (state === 'app') {
    if (gotFinders && evaluateHealth()) return;
    // Logged in; wait for the snapshot before claiming 'online'.
    if (snapshotReceived) setStatus('online', null);
    else if (status !== 'online') setStatus('connecting', null);
  }
}

/** If we are logged in but core modules did not resolve, the client changed on us. Returns true if broken. */
function evaluateHealth(): boolean {
  if (lastPage !== 'app') return false;
  const critical = ['Dispatcher', 'ChannelStore', 'MessageActions'];
  const broken = critical.filter((k) => !lastFinders[k]);
  if (broken.length) {
    setStatus('attention', { kind: 'selector_broken', message: `Discord changed; these hooks no longer resolve: ${broken.join(', ')}`, detail: lastFinders, liveView: true });
    return true;
  }
  // A later report (modules from a lazy chunk) can clear an earlier failure.
  if (attention?.kind === 'selector_broken') setStatus(snapshotReceived ? 'online' : 'connecting', null);
  return false;
}

// ------------------------------------------------------------------- snapshot
function ingestSnapshot(data: Parameters<typeof translateSnapshot>[0]) {
  snapshotReceived = true;
  if (data.self) selfUser = data.self;
  const { events, backfillTargets } = translateSnapshot(data, st);
  for (const ev of events) hub.emit(ev);
  setStatus('online', null);
  log('info', 'snapshot ingested', { guilds: st.guilds.size, conversations: st.known.size, friends: st.friends.size });
  void startupBackfill(backfillTargets);
}

const backfilled = new Set<string>();

/** Fetch only recent messages for the given channels (DMs + unread mentions); everything else loads lazily. Every reconnect re-sends the snapshot, so each channel only once. */
async function startupBackfill(targets: string[]) {
  const todo = targets.filter((id) => !backfilled.has(id)).slice(0, 40);
  for (const id of todo) backfilled.add(id);
  for (const channelId of todo) {
    try {
      await historyPace.run('backfill', async () => {
        const res = await bridge.request<{ messages: any[] }>({ kind: 'history', channelId, limit: 20 }, 30_000);
        for (const raw of res.messages ?? []) for (const ev of messageEvents(raw, st, false)) hub.emit(ev);
      });
    } catch (e) {
      log('debug', 'backfill failed', { channelId, error: String(e) });
    }
  }
  if (todo.length) log('info', 'startup backfill complete', { channels: todo.length });
}

// ------------------------------------------------------------- hub -> adapter
async function onCommand(cmd: P.AdapterCommand): Promise<unknown> {
  switch (cmd.t) {
    case 'send': {
      const nonce = randomNonce();
      const files = cmd.attachments?.map((f) => ({ name: f.name, mime: f.mime, size: f.size, base64: readFileSync(f.path).toString('base64') }));
      const hc: HookCommand = { kind: 'send', channelId: cmd.conversation, content: cmd.body, replyTo: cmd.replyTo, nonce, ...(files?.length ? { files } : {}) };
      const r = await pace.run('send', () => bridge.request<{ nativeId: string | null }>(hc, files?.length ? 170_000 : 30_000));
      return { nativeId: r?.nativeId ?? null };
    }
    case 'forward': {
      const hc: HookCommand = { kind: 'forward', channelId: cmd.conversation, source: { channelId: cmd.source.conversation, messageId: cmd.source.message }, note: cmd.note, nonce: randomNonce() };
      const r = await pace.run('send', () => bridge.request<{ nativeId: string | null }>(hc, 30_000));
      return { nativeId: r?.nativeId ?? null };
    }
    case 'openDirect': {
      if (cmd.peer === st.selfId) throw new Error('that is this account');
      const r = await pace.run('openDirect', () => bridge.request<{ channelId: string; existed: boolean; channel?: RawChannel | null }>({ kind: 'openDirect', userId: cmd.peer }, 30_000));
      for (const ev of openedDirect(cmd.peer, r, st)) hub.emit(ev);
      return { conversation: r.channelId, existed: r.existed } satisfies P.OpenDirectResult;
    }
    case 'history': {
      const beforeId = cmd.beforeTs ? tsToSnowflake(cmd.beforeTs) : undefined;
      const r = await historyPace.run('history', () => bridge.request<{ messages: any[] }>({ kind: 'history', channelId: cmd.conversation, limit: cmd.limit, beforeId }, 45_000));
      const messages = r?.messages ?? [];
      for (const raw of messages) for (const ev of messageEvents(raw, st, false)) hub.emit(ev);
      return { count: messages.length, done: messages.length < cmd.limit };
    }
    case 'markRead':
      return pace.run('markRead', () => bridge.request({ kind: 'markRead', channelId: cmd.conversation, messageId: cmd.upTo }, 20_000));
    case 'typing':
      // Not paced: it must not wait behind reads, and the client throttles it itself.
      return bridge.request({ kind: 'typing', channelId: cmd.conversation, ...(cmd.stop ? { stop: true } : {}) }, 10_000);
    case 'react': {
      const burst = cmd.style === 'super';
      await pace.run('react', () => bridge.request({ kind: 'react', channelId: cmd.conversation, messageId: cmd.message, emoji: cmd.key, remove: cmd.remove, burst }, 20_000));
      // Discord pushes nothing for server channels that are not open in the client, so say it ourselves.
      hub.emit({ t: 'reaction', conversation: cmd.conversation, message: cmd.message, author: st.selfId, key: cmd.key, ...(cmd.remove ? { remove: true } : {}), ...(burst ? { style: 'super' as const } : {}), ...(cmd.emoji ? { emoji: cmd.emoji } : {}) });
      return {};
    }
    case 'reactors': {
      const res = await historyPace.run('reactors', () => bridge.request<{ users: RawUser[] }>({ kind: 'reactors', channelId: cmd.conversation, messageId: cmd.message, emoji: cmd.key, burst: cmd.style === 'super' }, 20_000));
      for (const ev of userFacts(res.users ?? [], st)) hub.emit(ev);
      return { authors: (res.users ?? []).map((u) => u.id) };
    }
    case 'reactionContext': {
      const r = await bridge.request<RawReactionContext>({ kind: 'reactionContext', channelId: cmd.conversation }, 10_000);
      return {
        canReact: r.canReact,
        reason: r.reason,
        existingOnly: r.existingOnly,
        custom: r.custom.map((g) => ({ id: g.guild.id, name: g.guild.name, icon: guildIconUrl(g.guild), emoji: g.emoji.map((e) => customEmoji(e)!) })),
        super: r.nitro ? { available: true } : { available: false, reason: 'Super reactions need Discord Nitro.' },
      } satisfies P.ReactionContext;
    }
    case 'edit':
      return pace.run('edit', () => bridge.request({ kind: 'edit', channelId: cmd.conversation, messageId: cmd.message, content: cmd.body }, 20_000));
    case 'redact':
      return pace.run('redact', () => bridge.request({ kind: 'redact', channelId: cmd.conversation, messageId: cmd.message }, 20_000));
    case 'fetchMedia':
      return fetchMedia(cmd.url);
    case 'call': {
      const { t: _t, id: _id, conversation, ...rest } = cmd as P.AdapterCommand & { t: 'call'; conversation?: string };
      const hc = { kind: 'call', ...rest, ...(conversation ? { channelId: conversation } : {}) } as HookCommand;
      return bridge.request(hc, cmd.op === 'join' ? 40_000 : 15_000);
    }
    case 'lab':
      if (process.env.DITHER_LAB !== '1') throw new Error('not a lab hub');
      return bridge.request({ ...cmd.lab, kind: 'lab' } as HookCommand, cmd.timeout ?? 30_000);
    case 'action':
      return handleAction(cmd.action);
    default:
      throw new Error(`unsupported command ${(cmd as any).t}`);
  }
}

async function handleAction(action: string): Promise<unknown> {
  if (action === 'resync') {
    log('info', 'resync requested; reloading is manual via the live view for now');
    return { note: 'reload the tab in the live view to resync' };
  }
  return { note: `no such action: ${action}` };
}

/** cdn.discordapp.com URLs are public but signed/expiring; fetch them in-process. */
async function fetchMedia(url: string): Promise<{ mime: string; base64: string }> {
  if (!/^https:\/\/([a-z0-9-]+\.)?discordapp\.(com|net)\//i.test(url)) {
    // Only resolve Discord CDN media here; anything else the hub fetches directly.
    throw new Error('refusing to fetch non-Discord media');
  }
  const res = await fetch(url, { signal: AbortSignal.timeout(20_000) });
  if (!res.ok) throw new Error(`cdn fetch failed: ${res.status}`);
  const mime = res.headers.get('content-type') ?? 'application/octet-stream';
  const buf = Buffer.from(await res.arrayBuffer());
  return { mime, base64: buf.toString('base64') };
}

function tsToSnowflake(ms: number): string {
  const v = (BigInt(Math.max(0, Math.floor(ms))) - DISCORD_EPOCH) << 22n;
  return (v < 0n ? 0n : v).toString();
}

function randomNonce(): string {
  // Discord nonces are snowflake-ish strings; any unique string works for dedupe.
  return String(((BigInt(Date.now()) - DISCORD_EPOCH) << 22n) | BigInt(Math.floor(Math.random() * 4194304)));
}

// ----------------------------------------------------------------- lifecycle
function onConnect() {
  hub.emit({ t: 'hello', network: 'discord', version: '0.1.0', capabilities: CAPABILITIES });
  pushStatus();
}

async function onShutdown() {
  await cleanup();
}

async function cleanup() {
  try {
    bridge.stop();
  } catch {}
  try {
    await sandbox?.stop();
  } catch {}
}

async function shutdownAndExit(code: number) {
  await cleanup();
  process.exit(code);
}

process.on('SIGTERM', () => void shutdownAndExit(0));
process.on('SIGINT', () => void shutdownAndExit(0));

boot().catch((e) => {
  log('error', 'adapter boot failed', String(e?.message ?? e));
  void shutdownAndExit(1);
});
