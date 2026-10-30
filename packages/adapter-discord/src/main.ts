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

import { linkHub } from '@dither-chat/protocol/client';
import type * as P from '@dither-chat/protocol';
import type { BridgeUp, HookCommand, PageState, RawUser } from './discord-types.ts';
import { messageEvents, newState, translateDispatch, translateSnapshot } from './ingest.ts';
import { DISCORD_EPOCH, mapUser } from './map.ts';
import { BridgeServer, PaceQueue } from './server.ts';
import { Sandbox, pickDisplay } from './sandbox.ts';

const CAPABILITIES: P.Capability[] = ['send', 'history', 'react', 'edit', 'redact', 'markRead', 'typing', 'threads', 'media', 'liveView'];
const WIDTH = 1280;
const HEIGHT = 800;

const hub = linkHub({ onCommand, onConnect, onShutdown });
const log = (level: 'debug' | 'info' | 'warn' | 'error', msg: string, data?: unknown) => hub.log(level, msg, data);

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
  }
}

function onPageState(state: PageState) {
  if (state === 'captcha') setStatus('attention', { kind: 'captcha', message: 'A captcha is on screen. Open the live view to solve it.', liveView: true });
  else if (state === 'verify') setStatus('attention', { kind: 'verify', message: 'Discord wants to verify this login. Open the live view.', liveView: true });
  else if (state === 'login') setStatus('attention', { kind: 'login', message: 'Not logged in. Open the live view and sign in.', liveView: true });
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
      const hc: HookCommand = { kind: 'send', channelId: cmd.conversation, content: cmd.body, replyTo: cmd.replyTo, nonce };
      const r = await pace.run('send', () => bridge.request<{ nativeId: string | null }>(hc, 30_000));
      return { nativeId: r?.nativeId ?? null };
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
    case 'react':
      return pace.run('react', () => bridge.request({ kind: 'react', channelId: cmd.conversation, messageId: cmd.message, emoji: cmd.key, remove: cmd.remove }, 20_000));
    case 'edit':
      return pace.run('edit', () => bridge.request({ kind: 'edit', channelId: cmd.conversation, messageId: cmd.message, content: cmd.body }, 20_000));
    case 'redact':
      return pace.run('redact', () => bridge.request({ kind: 'redact', channelId: cmd.conversation, messageId: cmd.message }, 20_000));
    case 'fetchMedia':
      return fetchMedia(cmd.url);
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
