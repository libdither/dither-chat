import type { Server, ServerWebSocket, Socket, WebSocketHandler } from 'bun';
import { createHmac } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, statSync, utimesSync, writeFileSync } from 'node:fs';
import { join, normalize, resolve } from 'node:path';
import type * as P from '@dither-chat/protocol';
import { ATTACHMENT_LIMITS, directTarget, discordEmojiUrl, IMPORT_CHUNK, MAX_UPLOAD, NETWORK_META, NETWORKS, sendBlocker } from '@dither-chat/protocol';
import { hubId } from '@dither-chat/protocol/ids';
import type { Store } from './store.ts';
import type { AdapterSocketData, Supervisor } from './supervisor.ts';
import type { PushService } from './push.ts';
import type { ReadQueue } from './readqueue.ts';
import { validDailyDigest, validQuietHours, type Triage } from './triage.ts';
import type { TriageVotes, Vote } from './votes.ts';
import { cleanFileName, Uploads } from './uploads.ts';
import { ImportSources } from './imports/sources.ts';
import { Calls, type CallSocketData, type TurnConfig, type VoiceSocketData } from './calls.ts';
import { compress } from './compress.ts';
import { forwardMessage } from './forward.ts';
import { UsageStore } from './usage.ts';
import type { Attention } from './attention.ts';
import type { ActivityStore } from './activity.ts';
import { Devices } from './devices.ts';
import { changesOf } from './journal.ts';
import { syncResponse } from './sync.ts';
import { TypingGate } from './typing.ts';
import { hostAllowed, hostNames } from './hosts.ts';
import { fetchPublicToFile } from './fetchsafe.ts';
import { AboutError, Abouts } from './about.ts';
import { People } from './people.ts';

const ACCOUNT_COLORS = ['#F2A541', '#E86A92', '#B794F6', '#FF8C61', '#9BE15D', '#5CC8FF', '#F7D154', '#FF6B6B'];

type ClientData = { kind: 'client' };
type LiveViewData = { kind: 'liveview'; accountId: string; port: number; tcp?: Socket<unknown>; queue: Uint8Array[] };
type WsData = ClientData | LiveViewData | AdapterSocketData | CallSocketData | VoiceSocketData;

export interface ServerOpts {
  port: number;
  hostname: string;
  dataDir: string;
  webDist: string;
  secret: string;
  /** PEM paths. When set, the main port speaks HTTPS and plainPort handles what cannot use it. */
  tls?: { cert: string; key: string; ca?: string };
  plainPort?: number;
  push?: PushService;
  readQueue?: ReadQueue;
  /** Rescore categories after they change. */
  onCategoriesChanged?: (force?: boolean) => void;
  /** Every place's P(yes) for one question, not saved (categorize.ts probe). */
  probeCategory?: (question: string) => Promise<P.CategoryProbe>;
  onDemoReset?: () => Promise<void>;
  /** TURN relay for direct-mode calls, so their media leaves from this machine. */
  turn?: TurnConfig;
  /** The inbox's ranking (attention.ts, docs/inbox.md). */
  attention?: Attention;
  /** The activity log (activity.ts, docs/activity.md). */
  activity?: ActivityStore;
  /** Per-device notification rules (devices.ts, docs/devices.md). */
  devices?: Devices;
  /** Your votes on triage and the rules learned from them (votes.ts, docs/notifications.md). */
  votes?: TriageVotes;
}

// ------------------------------------------------------------------ access

/** A category's threshold from a request: a probability, or null for the provider's default. */
const threshold = (t: unknown): number | null => (typeof t === 'number' && t > 0 && t <= 1 ? t : null);
const v4 = (ip: string) => ip.replace(/^::ffff:/, '');
export function isLoopback(ip: string) {
  return ip === '::1' || v4(ip).startsWith('127.');
}
export function isTailnet(ip: string) {
  const a = v4(ip);
  const m = a.match(/^(\d+)\.(\d+)\./);
  if (m && +m[1] === 100 && +m[2] >= 64 && +m[2] <= 127) return true; // 100.64.0.0/10
  return ip.toLowerCase().startsWith('fd7a:115c:a1e0:');
}

/**
 * Cross-site pages get no say here: the hub has no login, only "you are on the tailnet", so a page
 * open on a tailnet device must not be able to drive it. Browsers always send Origin on these.
 */
export function sameOrigin(req: Request): boolean {
  const origin = req.headers.get('origin');
  if (!origin) return true; // not a browser: the CLI, curl
  try {
    const o = new URL(origin);
    return o.host === req.headers.get('host') || o.hostname === 'localhost' || o.hostname === '127.0.0.1'; // the vite dev proxy
  } catch {
    return false;
  }
}

/** A name this hub does not have (hosts.ts). DITHER_ALLOWED_HOSTS adds one. */
const unknownHost = () => new Response('unknown host: add it to DITHER_ALLOWED_HOSTS (docs/deploy.md)', { status: 421 });

/** Adapter kinds: a package name under packages/ or extractors/, never a path. */
export const validAdapterName = (a: unknown): a is string => typeof a === 'string' && /^[a-z][a-z0-9-]{0,31}$/.test(a);

// ------------------------------------------------------------------ media

export function mediaSigner(secret: string) {
  return (raw: string | null | undefined, accountId: string | null | undefined): string | null => {
    if (!raw) return null;
    if (raw.startsWith('data:')) return raw;
    const sig = createHmac('sha256', secret).update(`${raw}|${accountId ?? ''}`).digest('base64url').slice(0, 16);
    return `/media/${sig}/${Buffer.from(raw).toString('base64url')}${accountId ? `?a=${accountId}` : ''}`;
  };
}

/** An error after the command went to the adapter: whether it was carried out is not known. */
const unknownOutcome = (e: unknown) => /timed out|disconnected mid/i.test(String((e as Error)?.message ?? e));

export class HubServer {
  server!: Server<WsData>;
  private plain?: Server<WsData>;
  /** Listeners on the other addresses of a comma-separated `hostname` (DITHER_HOST), e.g. loopback and the tailnet IP. */
  private extra: Server<WsData>[] = [];
  /** The names a request's Host may carry (hosts.ts): DNS rebinding gets nowhere. */
  private names = hostNames();
  private clients = new Set<ServerWebSocket<ClientData>>();
  private flushTimer?: Timer;
  private pruneTimer?: Timer;
  private uploads: Uploads;
  /** Raw history sources waiting to be imported (imports/sources.ts, docs/import.md). */
  readonly imports: ImportSources;
  private typingGate = new TypingGate();
  private usage: UsageStore;
  readonly calls: Calls;
  readonly abouts: Abouts;
  readonly people: People;
  /** This process. A client that sees it change knows the hub restarted, and may have a new web build. */
  readonly boot = Buffer.from(crypto.getRandomValues(new Uint8Array(6))).toString('base64url');
  /** Sends by the client's id for them, so one retried after a lost answer goes out once (state.ts queues sends). */
  private sends = new Map<string, { at: number; done: Promise<Response> }>();

  constructor(
    private store: Store,
    private sup: Supervisor,
    private triage: Triage,
    private opts: ServerOpts,
  ) {
    this.uploads = new Uploads(join(opts.dataDir, 'uploads'));
    this.imports = new ImportSources(opts.dataDir, (msg) => console.warn(msg));
    this.calls = new Calls(store, sup, { turn: opts.turn, pickAccount: (c, a) => this.pickAccount(c, a) });
    this.abouts = new Abouts({
      store,
      online: (a) => sup.online(a),
      command: (a, c, t) => sup.command(a, c, t),
      pickAccount: (c, a) => this.pickAccount(c, a),
    });
    this.people = new People({ store, online: (a) => sup.online(a), command: (a, c, t) => sup.command(a, c, t) });
    sup.calls = this.calls;
    this.usage = new UsageStore(store.db, (changed, removed, all) =>
      this.broadcast([{ t: 'usage', places: this.usage.get(changed), removed, ...(all ? { replace: true as const } : {}) }]),
    );
  }

  start() {
    const self = this;
    const guarded = (handler: (req: Request, server: Server<WsData>) => Promise<Response | undefined> | Response | undefined) =>
      async (req: Request, server: Server<WsData>) => {
        try {
          return await compress(req, await handler(req, server));
        } catch (e: any) {
          console.error('request failed', req.method, new URL(req.url).pathname, e);
          return Response.json({ error: String(e?.message ?? e) }, { status: 500 });
        }
      };
    const tls = this.opts.tls;
    const websocket: WebSocketHandler<WsData> = {
      maxPayloadLength: 32 * 1024 * 1024,
        open(ws) {
          const d = ws.data;
          if (d.kind === 'client') self.clients.add(ws as ServerWebSocket<ClientData>);
          else if (d.kind === 'adapter') self.sup.attach(ws as ServerWebSocket<AdapterSocketData>);
          else if (d.kind === 'call') return;
          else if (d.kind === 'voice') self.calls.voiceOpen(ws as ServerWebSocket<VoiceSocketData>);
          else self.openLiveView(ws as ServerWebSocket<LiveViewData>);
        },
        message(ws, msg) {
          const d = ws.data;
          if (d.kind === 'client') {
            // The client's heartbeat: after a phone wakes, a dead socket shows in seconds rather than at a TCP timeout.
            if (msg === 'ping') ws.send('pong');
          } else if (d.kind === 'adapter') self.sup.receive(ws as ServerWebSocket<AdapterSocketData>, msg);
          else if (d.kind === 'call') self.calls.message(ws as ServerWebSocket<CallSocketData>, msg);
          else if (d.kind === 'voice') self.calls.voiceMessage(ws as ServerWebSocket<VoiceSocketData>, msg);
          else if (d.kind === 'liveview') {
            const buf = typeof msg === 'string' ? new TextEncoder().encode(msg) : new Uint8Array(msg);
            if (d.tcp) d.tcp.write(buf);
            else d.queue.push(buf);
          }
        },
        close(ws) {
          const d = ws.data;
          if (d.kind === 'client') self.clients.delete(ws as ServerWebSocket<ClientData>);
          else if (d.kind === 'adapter') self.sup.detach(ws as ServerWebSocket<AdapterSocketData>);
          else if (d.kind === 'call') self.calls.close(ws as ServerWebSocket<CallSocketData>);
          else if (d.kind === 'voice') self.calls.voiceClose(ws as ServerWebSocket<VoiceSocketData>);
          else d.tcp?.end();
        },
    };
    const common = { idleTimeout: 120, websocket };
    // One listener per address: binding loopback and the tailnet address rather than 0.0.0.0 keeps the LAN out.
    const hosts = this.opts.hostname.split(',').map((h) => h.trim()).filter(Boolean);
    const [first, ...rest] = hosts.length ? hosts : ['0.0.0.0'];
    const serve = (hostname: string) =>
      Bun.serve<WsData, never>({
        ...common,
        port: this.opts.port,
        hostname,
        ...(tls ? { tls: { cert: Bun.file(tls.cert), key: Bun.file(tls.key) } } : {}),
        fetch: guarded((req, server) => self.route(req, server)),
      });
    this.server = serve(first);
    this.extra = rest.map(serve);
    // Adapters on this machine still speak ws://, and a device has to fetch the CA before it can trust HTTPS.
    if (tls && this.opts.plainPort) {
      const plain = (hostname: string) =>
        Bun.serve<WsData, never>({
          ...common,
          port: this.opts.plainPort,
          hostname,
          fetch: guarded((req, server) => self.plainRoute(req, server)),
        });
      this.plain = plain(first);
      this.extra.push(...rest.map(plain));
    }
    this.flushTimer = setInterval(() => this.flush(), 80);
    this.imports.resume();
    this.store.journal.prune();
    this.pruneTimer = setInterval(() => this.store.journal.prune(), 3_600_000);
    return this.server;
  }

  stop() {
    clearInterval(this.flushTimer);
    clearInterval(this.pruneTimer);
    this.imports.stop();
    this.flush();
    this.server?.stop(true);
    this.plain?.stop(true);
    for (const s of this.extra) s.stop(true);
  }

  flush() {
    const events = this.store.flush();
    const a = this.opts.attention;
    if (a) {
      const changed: string[] = [];
      const removed: string[] = [];
      let rules = false;
      for (const e of events) {
        if (e.t === 'conversation') changed.push(e.conversation.id);
        else if (e.t === 'conversation.removed') removed.push(e.id);
        else if (e.t === 'rules') rules = true;
      }
      events.push(...(rules ? a.rescoreAll() : a.sync(changed, removed)));
    }
    this.broadcast(events);
  }

  /** To every client, and into the journal: a frame that changed something ends with its position (docs/sync.md). */
  broadcast(events: P.ClientEvent[]) {
    if (!events.length) return;
    if (events.some((e) => e.t === 'resync')) this.store.journal.restart();
    const seq = this.store.journal.record(changesOf(events));
    const frame = JSON.stringify(seq === null ? events : [...events, { t: 'sync', seq } satisfies P.ClientEvent]);
    for (const c of this.clients) c.send(frame);
  }

  private openLiveView(ws: ServerWebSocket<LiveViewData>) {
    const d = ws.data;
    Bun.connect({
      hostname: '127.0.0.1',
      port: d.port,
      socket: {
        open(sock) {
          d.tcp = sock;
          for (const b of d.queue) sock.write(b);
          d.queue = [];
        },
        data(_sock, data) {
          ws.sendBinary(data);
        },
        close() {
          try {
            ws.close();
          } catch {}
        },
        error() {
          try {
            ws.close(1011, 'vnc error');
          } catch {}
        },
      },
    }).catch(() => ws.close(1011, 'vnc unreachable'));
  }

  // ---------------------------------------------------------------- routing

  /** The plaintext listener next to HTTPS. WireGuard already authenticates the tailnet, so a CA fetched here is safe to trust. */
  private plainRoute(req: Request, server: Server<WsData>): Promise<Response | undefined> | Response {
    const url = new URL(req.url);
    const ip = server.requestIP(req)?.address ?? '';
    if (isLoopback(ip) && url.pathname === '/adapter') return this.route(req, server);
    if (!isLoopback(ip) && !isTailnet(ip)) return new Response('tailnet only', { status: 403 });
    if (!hostAllowed(req.headers.get('host'), this.names)) return unknownHost();
    if (url.pathname === '/ca.crt') return this.caCert();
    if (url.pathname === '/api/health') return Response.json({ ok: true, now: Date.now() });
    if (url.pathname === '/trust') return new Response(this.trustPage(req), { headers: { 'content-type': 'text/html; charset=utf-8' } });
    const host = (req.headers.get('host') ?? url.host).replace(/:\d+$/, '');
    return Response.redirect(`https://${host}:${this.opts.port}${url.pathname}${url.search}${url.hash}`, 307);
  }

  private caCert(): Response {
    const ca = this.opts.tls?.ca;
    if (!ca || !existsSync(ca)) return new Response('this hub has no private CA', { status: 404 });
    return new Response(Bun.file(ca), { headers: { 'content-type': 'application/x-x509-ca-cert', 'content-disposition': 'attachment; filename="dither-chat-ca.crt"', 'cache-control': 'no-cache' } });
  }

  private trustPage(req: Request): string {
    const host = (req.headers.get('host') ?? '').replace(/:\d+$/, '');
    const fp = this.opts.tls?.ca && existsSync(this.opts.tls.ca) ? new Bun.CryptoHasher('sha256').update(Buffer.from(readFileSync(this.opts.tls.ca, 'utf8').replace(/-----[^-]+-----|\s/g, ''), 'base64')).digest('hex').toUpperCase().match(/../g)!.join(':') : 'none';
    return `<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>Trust dither-chat</title>
<style>body{font:16px system-ui;max-width:40em;margin:2em auto;padding:0 1em;line-height:1.5}code{word-break:break-all}</style>
<h1>Trust this hub</h1><p>Installing dither-chat needs HTTPS, and this hub uses a private certificate authority limited to the tailnet.</p>
<ol><li><a href="/ca.crt">Download the certificate</a></li><li>Install it as a trusted CA on this device (steps below)</li><li><a href="https://${host}:${this.opts.port}/">Open dither-chat</a> and install it</li></ol>
<p>SHA-256 fingerprint:<br><code>${fp}</code></p>
<ul><li><b>Android:</b> Settings → Security → More security settings → Install from device storage → CA certificate. The exact path varies by vendor; search settings for "CA certificate".</li>
<li><b>iOS:</b> open the download in Safari, Settings → Profile Downloaded → Install, then Settings → General → About → Certificate Trust Settings → enable it. Install with Share → Add to Home Screen.</li>
<li><b>Desktop:</b> see docs/deploy.md for your browser.</li></ul>`;
  }

  private async route(req: Request, server: Server<WsData>): Promise<Response | undefined> {
    const url = new URL(req.url);
    const path = url.pathname;
    const ip = server.requestIP(req)?.address ?? '';

    if (path === '/adapter') {
      if (!isLoopback(ip)) return new Response('adapters connect from localhost only', { status: 403 });
      const accountId = this.sup.authorize(url.searchParams.get('account'), url.searchParams.get('token'));
      if (!accountId) return new Response('bad adapter token', { status: 401 });
      if (server.upgrade(req, { data: { kind: 'adapter', accountId } satisfies AdapterSocketData })) return undefined;
      return new Response('upgrade failed', { status: 400 });
    }

    // Everything else: this machine and the tailnet only, never the LAN.
    if (!isLoopback(ip) && !isTailnet(ip)) return new Response('tailnet only', { status: 403 });
    // And only under a name this hub has (hosts.ts), so a page that rebinds its own domain here gets nothing.
    if (!hostAllowed(req.headers.get('host'), this.names)) return unknownHost();

    if (path.startsWith('/api/') && req.method !== 'GET' && !sameOrigin(req)) return new Response('cross-site request refused', { status: 403 });
    if ((path === '/api/live' || path.startsWith('/api/liveview/') || path.startsWith('/api/call')) && !sameOrigin(req)) return new Response('cross-site socket refused', { status: 403 });
    if (path === '/ca.crt') return this.caCert();

    if (path === '/api/live') {
      if (server.upgrade(req, { data: { kind: 'client' } satisfies ClientData })) return undefined;
      return new Response('upgrade failed', { status: 400 });
    }
    if (path === '/api/call') {
      if (server.upgrade(req, { data: { kind: 'call' } satisfies CallSocketData })) return undefined;
      return new Response('upgrade failed', { status: 400 });
    }
    if (path === '/api/calls') return Response.json(this.calls.stats());
    let m: RegExpMatchArray | null;
    // Call lab (scripts/call-lab.ts): only on a hub started with DITHER_LAB=1, from loopback, never from a browser.
    if (process.env.DITHER_LAB === '1' && req.method === 'POST' && !req.headers.get('origin') && /^(127\.|::1$|::ffff:127\.)/.test(server.requestIP(req)?.address ?? '') && (m = path.match(/^\/api\/lab\/([\w-]+)$/))) {
      const b = (await req.json()) as { op: string; timeout?: number };
      try {
        return Response.json({ ok: true, result: await this.sup.command(m[1], { t: 'lab', lab: b, timeout: b.timeout }, (b.timeout ?? 30_000) + 5000) });
      } catch (e: any) {
        return Response.json({ ok: false, error: String(e?.message ?? e) });
      }
    }
    if ((m = path.match(/^\/api\/call\/([\w-]+)\/voice$/))) return this.calls.upgradeVoice(req, server, m[1], url);
    if ((m = path.match(/^\/api\/liveview\/([\w-]+)$/))) {
      const acc = this.store.account(m[1]);
      const lv = acc?.live_view ? (JSON.parse(acc.live_view) as { vncPort: number }) : null;
      if (!lv) return new Response('no live view for this account', { status: 404 });
      const proto = req.headers.get('sec-websocket-protocol');
      const headers = proto?.split(',').map((s) => s.trim()).includes('binary') ? { 'Sec-WebSocket-Protocol': 'binary' } : undefined;
      if (server.upgrade(req, { data: { kind: 'liveview', accountId: m[1], port: lv.vncPort, queue: [] } satisfies LiveViewData, headers })) return undefined;
      return new Response('upgrade failed', { status: 400 });
    }
    if (path === '/api/voice/dave') return this.daveCurrent();
    if ((m = path.match(/^\/voice\/dave\/([0-9a-f]{16})\/(libdave\.mjs|libdave\.wasm)$/))) return this.daveFile(m[1], m[2]);
    if ((m = path.match(/^\/media\/([\w-]+)\/([\w-]+)$/))) return this.media(m[1], m[2], url.searchParams.get('a'));
    // Custom emoji inside message bodies: the id is all a body has, and it can only reach Discord's CDN.
    if ((m = path.match(/^\/emoji\/discord\/(\d+)(\.animated)?$/))) return this.fetchMedia(discordEmojiUrl(m[1], !!m[2]), null);
    if (path.startsWith('/api/')) return this.api(req, url, path);
    return this.static(path);
  }

  private async api(req: Request, url: URL, path: string): Promise<Response> {
    const s = this.store;
    const method = req.method;
    const body = async <T>() => (method === 'GET' ? ({} as T) : ((await req.json().catch(() => ({}))) as T));
    const ok = (x: unknown = { ok: true }) => Response.json(x);
    const bad = (msg: string, status = 400) => Response.json({ error: msg }, { status });
    let m: RegExpMatchArray | null;
    const num = (k: string) => (url.searchParams.get(k) ? Number(url.searchParams.get(k)) : null);

    if (path === '/api/health') return ok({ ok: true, now: Date.now() });
    if (path === '/api/demo/reset' && method === 'POST') {
      if (!this.opts.onDemoReset) return bad('demo is not enabled', 404);
      await this.opts.onDemoReset();
      this.flush();
      this.broadcast([{ t: 'resync' }]);
      return ok();
    }
    if (path === '/api/bootstrap') {
      // Everything changed so far is in the journal, so the position below covers what this reads.
      this.flush();
      return ok({ ...s.bootstrap(), attention: this.opts.attention?.list(), devices: this.opts.devices?.list(), sync: s.journal.position() } satisfies P.Bootstrap);
    }
    if (path === '/api/sync' && method === 'POST') {
      const b = await body<P.SyncRequest>();
      this.flush();
      return ok(syncResponse({ store: s, attention: this.opts.attention, usage: this.usage, devices: this.opts.devices, boot: this.boot }, b));
    }
    // The inbox's ranking (attention.ts, docs/inbox.md).
    if (path.startsWith('/api/attention')) {
      const a = this.opts.attention;
      if (!a) return bad('attention is off', 404);
      if (path === '/api/attention' && method === 'GET') return ok({ now: Date.now(), items: a.list() });
      if ((m = path.match(/^\/api\/attention\/([\w-]+)$/)) && method === 'GET') {
        const x = a.explain(m[1]);
        return x ? ok(x) : bad('not in the inbox', 404);
      }
      // After importing history some other way than the ingest: fold these conversations (or all) again.
      if (path === '/api/attention/rebuild' && method === 'POST') {
        const b = await body<{ conversations?: string[] }>();
        a.invalidate(Array.isArray(b.conversations) ? b.conversations.filter((x) => typeof x === 'string') : undefined);
        return ok();
      }
    }
    if (path === '/api/inbox') return ok(s.inbox(num('since') ?? Date.now() - 7 * 86_400_000));
    if (path === '/api/search') return ok(s.search(url.searchParams.get('q') ?? '', Math.min(num('limit') ?? 40, 100), url.searchParams.get('cursor'), num('context') ?? 0));

    if ((m = path.match(/^\/api\/messages\/([\w-]+)\/context$/))) {
      const page = s.messageContext(m[1], Math.min(num('around') ?? 30, 100));
      return page ? ok(page) : bad('no such message', 404);
    }
    if ((m = path.match(/^\/api\/conversations\/([\w-]+)\/messages$/)) && num('after') !== null) return ok(s.messagesAfter(m[1], num('after')!, Math.min(num('limit') ?? 60, 200)));
    if ((m = path.match(/^\/api\/conversations\/([\w-]+)\/messages$/))) return ok(s.messages(m[1], num('before'), Math.min(num('limit') ?? 60, 200)));
    if ((m = path.match(/^\/api\/persons\/([\w-]+)\/profile$/)) || (m = path.match(/^\/api\/identities\/([\w-]+)\/profile$/))) {
      const p = s.profile(path.startsWith('/api/persons/') ? { personId: m[1] } : { identityId: m[1] });
      return p ? ok({ ...p, abouts: this.people.kept(p.identityIds) }) : bad('nobody by that id', 404);
    }
    // What changed (docs/history.md): a place's name, description, settings and members; a person's names, pictures
    // and profile across their identities.
    if ((m = path.match(/^\/api\/(conversations|spaces|persons|identities)\/([\w-]+)\/changes$/))) {
      const limit = Math.min(num('limit') ?? 100, 500);
      const kind = m[1] === 'conversations' ? 'conversation' : m[1] === 'spaces' ? 'space' : 'identity';
      const targets =
        m[1] === 'persons'
          ? (s.db.query('SELECT id FROM identity WHERE person_id = ?').all(m[2]) as { id: string }[]).map((r) => ({ kind: 'identity' as const, id: r.id }))
          : [{ kind: kind as P.ChangeView['target']['kind'], id: m[2] }];
      const changes = s.changes(targets, limit);
      // Whoever they name, and whoever made them, for rendering.
      const named = new Set(changes.flatMap((c) => [c.identityId, c.actorId, c.target.kind === 'identity' ? c.target.id : undefined].filter((x): x is string => !!x)));
      return ok({ changes, identities: s.identitiesByIds(named) });
    }
    if ((m = path.match(/^\/api\/messages\/([\w-]+)\/history$/))) {
      const h = s.messageHistory(m[1]);
      return h ? ok(h) : bad('no such message', 404);
    }
    if (path === '/api/retention') {
      if (method === 'PUT') {
        const b = await body<Partial<P.RetentionSettings>>();
        const cur = s.retention();
        const bool = (v: unknown, d: boolean) => (typeof v === 'boolean' ? v : d);
        const sources: P.RetentionSettings['sources'] = {};
        for (const [k, v] of Object.entries(b.sources ?? cur.sources)) {
          if (!/^[\w-]{1,64}$/.test(k) || !v || typeof v !== 'object') continue;
          const o: Partial<P.KeepSettings> = {};
          for (const f of ['deleted', 'disappearing', 'edits', 'reactions', 'receipts'] as const) if (typeof v[f] === 'boolean') o[f] = v[f];
          if (Object.keys(o).length) sources[k] = o;
        }
        s.setRetention({
          deleted: bool(b.deleted, cur.deleted),
          disappearing: bool(b.disappearing, cur.disappearing),
          edits: bool(b.edits, cur.edits),
          reactions: bool(b.reactions, cur.reactions),
          receipts: bool(b.receipts, cur.receipts),
          changes: bool(b.changes, cur.changes),
          statuses: bool(b.statuses, cur.statuses),
          adversarial: bool(b.adversarial, cur.adversarial),
          show: b.show === 'hidden' || b.show === 'collapsed' ? b.show : cur.show,
          sources,
        });
        this.broadcast([{ t: 'retention', retention: s.retention() }]);
      }
      return ok(s.retention());
    }
    if (path === '/api/retention/erase' && method === 'POST') {
      const b = await body<{ what?: string }>();
      const kinds = ['deleted', 'disappeared', 'edits', 'reactions', 'receipts', 'changes', 'statuses'] as const;
      if (!kinds.includes(b.what as (typeof kinds)[number])) return bad(`what: ${kinds.join(', ')}`);
      const n = s.eraseKept(b.what as (typeof kinds)[number]);
      this.flush();
      return ok({ erased: n });
    }
    // What the network says about one identity (people.ts, docs/profile.md). ?fresh=1 asks even if a recent answer is kept.
    if ((m = path.match(/^\/api\/identities\/([\w-]+)\/about$/))) {
      if (!s.nativeOf('identity', m[1])) return bad('no such identity', 404);
      const v = await this.people.get(m[1], url.searchParams.get('fresh') === '1');
      this.flush();
      return ok(v);
    }
    if ((m = path.match(/^\/api\/identities\/([\w-]+)\/person$/)) && method === 'POST') {
      if (!s.nativeOf('identity', m[1])) return bad('no such identity', 404);
      const personId = s.ensurePerson(m[1]);
      this.flush();
      return ok({ personId });
    }
    if ((m = path.match(/^\/api\/persons\/([\w-]+)\/timeline$/))) return ok(s.personTimeline(m[1], num('before'), Math.min(num('limit') ?? 60, 200)));
    if ((m = path.match(/^\/api\/conversations\/([\w-]+)\/notify$/))) return ok(this.triage.effectiveLevel(m[1]));
    // About and settings (about.ts, docs/group-settings.md). GET reads, POST changes one thing.
    if ((m = path.match(/^\/api\/(conversations|spaces)\/([\w-]+)\/about$/))) {
      const kind = m[1] === 'spaces' ? 'space' : 'conversation';
      try {
        if (method === 'POST') {
          const b = await body<{ change?: P.AboutChange; accountId?: string }>();
          const v = await this.abouts.configure(kind, m[2], b.change as P.AboutChange, b.accountId);
          this.flush();
          return ok(v);
        }
        const v = await this.abouts.get(kind, m[2], url.searchParams.get('account') ?? undefined);
        this.flush();
        return ok(v);
      } catch (e) {
        if (e instanceof AboutError) return bad(e.message, e.status);
        throw e;
      }
    }
    if ((m = path.match(/^\/api\/conversations\/([\w-]+)\/reaction-context$/))) {
      const conv = s.nativeOf('conversation', m[1]);
      if (!conv) return bad('no such conversation', 404);
      const accountId = this.pickAccount(m[1], url.searchParams.get('account') ?? undefined);
      if (!accountId || !this.sup.online(accountId)) return ok({ accountId, canReact: false, reason: 'No connected account can react here.', custom: [] } satisfies P.ReactionContextView);
      const ctx = await this.sup.command<P.ReactionContext>(accountId, { t: 'reactionContext', conversation: conv.nativeId }, 15_000).catch(() => null);
      return ok(s.reactionContextView(accountId, conv.network, ctx ?? { canReact: true, custom: [] }));
    }

    if (path === '/api/uploads' && method === 'POST') {
      if (Number(req.headers.get('content-length') ?? 0) > MAX_UPLOAD) return bad('that file is too large', 413);
      const bytes = new Uint8Array(await req.arrayBuffer());
      if (!bytes.length) return bad('empty file');
      if (bytes.length > MAX_UPLOAD) return bad('that file is too large', 413);
      return ok(this.uploads.put(bytes, cleanFileName(req.headers.get('x-file-name')), req.headers.get('content-type') ?? ''));
    }
    // History sources (docs/import.md): uploaded in pieces at their offset, so a dropped connection resumes.
    if (path.startsWith('/api/imports')) {
      const fail = (e: any) => Response.json({ error: String(e?.message ?? e), ...(e?.received !== undefined ? { received: e.received } : {}) }, { status: e?.status ?? 400 });
      try {
        if (path === '/api/imports' && method === 'GET') return ok({ sources: this.imports.list() });
        if (path === '/api/imports' && method === 'POST') {
          const b = await body<{ accountId?: string; name?: string; size?: number; label?: string }>();
          const acc = b.accountId ? s.account(b.accountId) : null;
          if (!acc) return bad('no such account', 404);
          return ok(this.imports.create({ network: acc.network as P.Network, accountId: acc.id, name: String(b.name ?? ''), size: Number(b.size), label: b.label }));
        }
        if ((m = path.match(/^\/api\/imports\/([\w.-]+)\/data$/)) && method === 'PUT') {
          if (Number(req.headers.get('content-length') ?? 0) > IMPORT_CHUNK) return bad('piece too large', 413);
          return ok(await this.imports.put(m[1], num('offset') ?? -1, req.body));
        }
        if ((m = path.match(/^\/api\/imports\/([\w.-]+)\/passphrase$/)) && method === 'POST') return ok(this.imports.setPassphrase(m[1], String((await body<{ passphrase?: string }>()).passphrase ?? '')));
        if ((m = path.match(/^\/api\/imports\/([\w.-]+)\/check$/)) && method === 'POST') {
          void this.imports.check(m[1]);
          return ok(this.imports.view(m[1]));
        }
        if ((m = path.match(/^\/api\/imports\/([\w.-]+)$/))) {
          if (method === 'GET') return this.imports.view(m[1]) ? ok(this.imports.view(m[1])) : bad('no such source', 404);
          if (method === 'PATCH') {
            const b = await body<{ label?: string; accountId?: string | null }>();
            if (b.accountId && !s.account(b.accountId)) return bad('no such account', 404);
            const net = b.accountId ? (s.account(b.accountId)!.network as P.Network) : undefined;
            return ok(this.imports.patch(m[1], { label: b.label, accountId: b.accountId, network: net }));
          }
          if (method === 'DELETE') return (this.imports.remove(m[1]), ok());
        }
      } catch (e) {
        return fail(e);
      }
    }
    if ((m = path.match(/^\/api\/conversations\/([\w-]+)\/send$/)) && method === 'POST') {
      const b = await body<{ body?: string; accountId?: string; replyTo?: string; attachments?: string[]; clientId?: string }>();
      // A send retried after its answer was lost goes out once: the retry gets the first one's answer.
      const key = typeof b.clientId === 'string' && b.clientId ? `${m[1]}|${b.clientId.slice(0, 64)}` : null;
      const now = Date.now();
      for (const [k, v] of this.sends) if (now - v.at > 15 * 60_000) this.sends.delete(k);
      const earlier = key ? this.sends.get(key) : undefined;
      if (earlier) return (await earlier.done).clone();
      const done = this.sendNow(m[1], b);
      if (key) this.sends.set(key, { at: now, done });
      try {
        const res = await done;
        if (key && !res.ok) this.sends.delete(key);
        return res.clone();
      } catch (e) {
        // The adapter took it and then went quiet: it may well have gone out. A retry with the same id gets this
        // answer rather than a second copy; a new send (a new id) is the person's call.
        if (key && unknownOutcome(e)) {
          const answer = Response.json({ error: 'The network did not answer in time. It may have been sent: look before sending it again.', unknown: true }, { status: 504 });
          this.sends.set(key, { at: now, done: Promise.resolve(answer) });
          return answer.clone();
        }
        if (key) this.sends.delete(key);
        throw e;
      }
    }
    if ((m = path.match(/^\/api\/messages\/([\w-]+)\/forward$/)) && method === 'POST') {
      const b = await body<P.ForwardRequest>();
      const r = await forwardMessage(
        {
          store: s,
          uploads: this.uploads,
          online: (a) => this.sup.online(a),
          command: (a, c, t) => this.sup.command(a, c, t),
          pickAccount: (c, a) => this.pickAccount(c, a),
          sendRefusal: (c, a) => this.sendRefusal(c, a),
          media: (raw, a) => this.mediaBytes(raw, a),
        },
        m[1],
        { targets: Array.isArray(b.targets) ? b.targets : [], note: b.note },
      );
      this.flush();
      return 'error' in r ? bad(r.error, r.status) : ok({ results: r });
    }
    if (path === '/api/directs' && method === 'POST') {
      const b = await body<{ accountId?: string; peer?: string }>();
      const acc = b.accountId ? s.account(b.accountId) : null;
      if (!acc) return bad('no such account', 404);
      const name = NETWORK_META[acc.network].name;
      if (!(JSON.parse(acc.capabilities) as P.Capability[]).includes('openDirect')) return bad(`${acc.label} cannot start conversations on ${name}`, 409);
      if (!this.sup.online(acc.id)) return bad(`${acc.label} is not connected`, 409);
      const target = directTarget(acc.network, b.peer ?? '');
      if ('error' in target) return bad(target.error);
      if (acc.self_identity === hubId('idn', acc.network, target.peer)) return bad('That is this account');
      const r = await this.sup.command<P.OpenDirectResult>(acc.id, { t: 'openDirect', peer: target.peer }, 60_000).catch((e: Error) => e);
      if (r instanceof Error) return bad(r.message, 502);
      const id = hubId('cnv', acc.network, r.conversation);
      s.touchConversation(id);
      this.flush();
      return ok({ conversation: s.conversationView(id), existed: r.existed, startsAtFirstSend: !!r.startsAtFirstSend } satisfies P.OpenedDirect);
    }
    if ((m = path.match(/^\/api\/conversations\/([\w-]+)\/read$/)) && method === 'POST') {
      const b = await body<{ upToTs?: number }>();
      const targets = s.markRead(m[1], b.upToTs ?? Date.now());
      const conv = s.nativeOf('conversation', m[1]);
      for (const t of targets) {
        if (conv && t.upTo && this.sup.online(t.accountId))
          this.sup.command(t.accountId, { t: 'markRead', conversation: conv.nativeId, upTo: t.upTo }).catch(() => {});
      }
      this.flush();
      return ok();
    }
    if (path === '/api/read-all') {
      const q = this.opts.readQueue;
      if (!q) return bad('not available', 404);
      if (method === 'POST') {
        const b = await body<{ conversations?: string[] }>();
        if (!Array.isArray(b.conversations)) return bad('which conversations?');
        const marked = q.add(b.conversations);
        this.flush();
        return ok({ marked, pending: q.pending() });
      }
      return ok({ pending: q.pending() });
    }
    if ((m = path.match(/^\/api\/conversations\/([\w-]+)\/history$/)) && method === 'POST') {
      const b = await body<{ beforeTs?: number; limit?: number }>();
      const conv = s.nativeOf('conversation', m[1]);
      const accountId = this.pickAccount(m[1]);
      if (!conv || !accountId) return ok({ count: 0, done: true });
      const r = await this.sup.command(accountId, { t: 'history', conversation: conv.nativeId, beforeTs: b.beforeTs, limit: b.limit ?? 50 }, 60_000).catch((e) => ({ error: String(e.message) }));
      return ok(r ?? { count: 0, done: true });
    }
    if ((m = path.match(/^\/api\/messages\/([\w-]+)\/react$/)) && method === 'POST') {
      const b = await body<{ key: string; remove?: boolean; style?: P.ReactionStyle; accountId?: string }>();
      if (!b.key) return bad('nothing to react with');
      const msg = s.one<{ conversation_id: string; native_id: string }>('SELECT conversation_id, native_id FROM message WHERE id = ?', m[1]);
      if (!msg) return bad('no such message', 404);
      const conv = s.nativeOf('conversation', msg.conversation_id)!;
      const style = b.style ?? 'normal';
      // Taking a reaction back has to go through the account that made it.
      const accountId = (b.remove && s.reactionAccount(m[1], b.key, style)) || this.pickAccount(msg.conversation_id, b.accountId);
      if (!accountId) return bad('no connected account can react here', 409);
      await this.sup.command(accountId, { t: 'react', conversation: conv.nativeId, message: msg.native_id, key: b.key, remove: b.remove, style, emoji: s.customEmoji(conv.network, b.key) });
      this.flush();
      return ok({ ok: true, accountId });
    }
    if ((m = path.match(/^\/api\/messages\/([\w-]+)\/reactors$/))) {
      const key = url.searchParams.get('key') ?? '';
      const style = (url.searchParams.get('style') ?? 'normal') as P.ReactionStyle;
      const msg = s.one<{ conversation_id: string; native_id: string }>('SELECT conversation_id, native_id FROM message WHERE id = ?', m[1]);
      if (!msg) return bad('no such message', 404);
      const shown = () => s.messageView(m![1])?.reactions.find((r) => r.key === key && r.style === style);
      const before = shown();
      // Only ask the network when it has not told us everyone already.
      if (before && before.count > before.identityIds.length) {
        const conv = s.nativeOf('conversation', msg.conversation_id)!;
        const accountId = this.pickAccount(msg.conversation_id);
        const acc = accountId ? s.account(accountId) : null;
        if (acc && this.sup.online(acc.id)) {
          const r = await this.sup.command<{ authors?: string[] }>(acc.id, { t: 'reactors', conversation: conv.nativeId, message: msg.native_id, key, style }, 20_000).catch(() => null);
          if (r?.authors?.length) s.addKnownReactors(acc, m[1], key, style, r.authors);
          this.flush();
        }
      }
      const after = shown();
      return ok({ count: after?.count ?? 0, identityIds: after?.identityIds ?? [], identities: s.identitiesByIds(after?.identityIds ?? []) });
    }
    if ((m = path.match(/^\/api\/messages\/([\w-]+)\/(edit|delete)$/)) && method === 'POST') {
      const edit = m[2] === 'edit';
      const b = await body<{ body?: string }>();
      if (edit && !b.body?.trim()) return bad('empty message');
      const msg = s.one<{ conversation_id: string; native_id: string; author_id: string }>('SELECT conversation_id, native_id, author_id FROM message WHERE id = ?', m[1]);
      if (!msg) return bad('no such message', 404);
      // Only the account that wrote it can change it, and only on a network that allows it.
      const acc = s.accounts().find((a) => a.self_identity === msg.author_id);
      if (!acc) return bad('this message is not yours', 403);
      if (!(JSON.parse(acc.capabilities) as P.Capability[]).includes(edit ? 'edit' : 'redact')) return bad(`${NETWORK_META[acc.network].name} does not support this here`, 409);
      if (!this.sup.online(acc.id)) return bad(`${acc.label} is not connected`, 409);
      const conversation = s.nativeOf('conversation', msg.conversation_id)!.nativeId;
      await this.sup.command(acc.id, edit ? { t: 'edit', conversation, message: msg.native_id, body: b.body! } : { t: 'redact', conversation, message: msg.native_id });
      this.flush();
      return ok();
    }
    // A vote: { vote: 'up' | 'down' } from where it is now, or { feedback: level | null } straight to a level.
    if ((m = path.match(/^\/api\/messages\/([\w-]+)\/feedback$/)) && method === 'POST') {
      const b = await body<{ vote?: 'up' | 'down'; feedback?: P.NotifyTier | null }>();
      const v: Vote | undefined = b.vote === 'up' || b.vote === 'down' ? b.vote : b.feedback === null || ['push', 'quiet', 'digest', 'drop'].includes(b.feedback as string) ? (b.feedback as Vote) : undefined;
      if (v === undefined) return bad('Say vote: up or down, or feedback: a level or null');
      if (!this.opts.votes) {
        s.triageFeedback(m[1], v === 'up' || v === 'down' ? null : v);
        return ok();
      }
      try {
        const r = this.opts.votes.vote(m[1], v);
        this.flush();
        return ok(r);
      } catch (e: any) {
        return bad(e.message, 409);
      }
    }
    if (path === '/api/triage/policy' && method === 'GET') return this.opts.votes ? ok(this.opts.votes.view()) : bad('No triage here', 404);
    // What the shadow model would have done lately (shadow.ts): counts only.
    if (path === '/api/triage/shadow' && method === 'GET') return this.opts.votes ? ok(this.opts.votes.shadow()) : bad('No triage here', 404);
    if (path === '/api/triage/policy/relearn' && method === 'POST' && this.opts.votes) {
      this.opts.votes.learn('you asked');
      return ok(this.opts.votes.view());
    }
    // Forget something the model learned, for good ({ rejected: true }), or let it be learned again.
    if ((m = path.match(/^\/api\/triage\/factors\/([^/]+)$/)) && method === 'POST' && this.opts.votes) {
      const b = await body<{ rejected?: boolean }>();
      if (typeof b.rejected !== 'boolean') return bad('Say rejected: true or false');
      this.opts.votes.forget(decodeURIComponent(m[1]), b.rejected);
      return ok(this.opts.votes.view());
    }

    if (path === '/api/persons/merge' && method === 'POST') {
      const b = await body<{ into: string; from: string }>();
      s.mergePersons(b.into, b.from);
      this.flush();
      return ok();
    }
    if ((m = path.match(/^\/api\/persons\/([\w-]+)$/)) && method === 'PATCH') {
      s.updatePerson(m[1], await body());
      this.flush();
      return ok();
    }
    if ((m = path.match(/^\/api\/identities\/([\w-]+)\/split$/)) && method === 'POST') {
      const personId = s.splitIdentity(m[1]);
      this.flush();
      return ok({ personId });
    }
    if (path === '/api/folders' && method === 'PUT') {
      const b = await body<{ folders: P.FolderView[] }>();
      s.setFolders(b.folders ?? []);
      return ok();
    }
    if (path === '/api/place-prefs' && method === 'PATCH') {
      const b = await body<{ items: P.PlacePrefPatch[] }>();
      s.patchPlacePrefs(b.items ?? []);
      return ok();
    }
    // The activity log (activity.ts, docs/activity.md). Hub-only: never journaled or sent to other clients.
    if (path.startsWith('/api/activity')) {
      const a = this.opts.activity;
      if (!a) return bad('the activity log is not available', 404);
      if (path === '/api/activity' && method === 'GET') return ok(a.info());
      if (path === '/api/activity' && method === 'DELETE') return (a.clear(), ok(a.info()));
      if (path === '/api/activity/settings' && method === 'PUT') return ok({ settings: a.setSettings(await body<Partial<P.ActivitySettings>>()) });
      if (path === '/api/activity/visits' && method === 'POST') {
        const b = await body<{ visits?: Partial<P.VisitRecord>[] }>();
        return ok({ applied: a.visits(Array.isArray(b.visits) ? b.visits : []), enabled: a.enabled });
      }
      if (path === '/api/activity/notifications' && method === 'POST') {
        const b = await body<{ events?: Partial<P.NotificationEvent>[] }>();
        return ok({ applied: a.events(Array.isArray(b.events) ? b.events : []), enabled: a.enabled });
      }
      if (path === '/api/activity/features' && method === 'GET') {
        const cid = url.searchParams.get('conversation');
        return ok(cid ? a.features(cid) : { places: a.top(Number(url.searchParams.get('limit')) || 10) });
      }
      const lines = path === '/api/activity/export' ? a.exportLog() : path === '/api/activity/examples' ? a.examples() : null;
      if (lines && method === 'GET') {
        const name = path.endsWith('examples') ? 'dither-triage-examples' : 'dither-activity';
        const enc = new TextEncoder();
        const stream = new ReadableStream({
          pull(c) {
            let chunk = '';
            for (let i = 0; i < 500; i++) {
              const n = lines.next();
              if (n.done) {
                if (chunk) c.enqueue(enc.encode(chunk));
                return c.close();
              }
              chunk += n.value + '\n';
            }
            c.enqueue(enc.encode(chunk));
          },
        });
        return new Response(stream, { headers: { 'content-type': 'application/x-ndjson', 'content-disposition': `attachment; filename="${name}-${new Date().toISOString().slice(0, 10)}.jsonl"` } });
      }
    }
    // Usage and automatic order (usage.ts, docs/organize.md).
    if (path === '/api/usage' || path === '/api/arrange') {
      const u = this.usage;
      if (path === '/api/arrange' && method === 'PATCH') {
        const arrange = u.patchArrange(await body());
        this.broadcast([{ t: 'arrange', arrange }]);
        return ok(arrange);
      }
      if (method === 'GET') return ok(u.state());
      if (method === 'POST') {
        const b = await body<{ batch?: string; deltas?: Partial<P.UsageDelta>[] }>();
        return ok({ applied: u.apply(typeof b.batch === 'string' ? b.batch.slice(0, 64) : undefined, Array.isArray(b.deltas) ? b.deltas : []) });
      }
      if (method === 'DELETE') {
        const b = await body<{ kind?: string; id?: string }>();
        u.reset(b.kind && b.id ? { kind: b.kind, id: b.id } : undefined);
        return ok();
      }
    }
    if (path.startsWith('/api/push')) {
      const push = this.opts.push;
      if (!push) return bad('push is not available', 404);
      if (path === '/api/push' && method === 'GET') return ok({ publicKey: push.publicKey, devices: push.devices(), servers: push.servers(), pending: push.pendingList(), topic: push.topicView() } satisfies P.PushInfo);
      if (path === '/api/push/subscribe' && method === 'POST') {
        const b = await body<{ subscription: { endpoint?: string; keys?: { p256dh?: string; auth?: string } }; label?: string; clears?: boolean }>();
        const sub = b.subscription;
        if (!sub?.endpoint || !sub.keys?.p256dh || !sub.keys?.auth) return bad('that is not a push subscription');
        const id = push.subscribe({ endpoint: sub.endpoint, p256dh: sub.keys.p256dh, auth: sub.keys.auth }, b.label, b.clears === true);
        if (id) {
          this.opts.devices?.touch();
          return ok({ id });
        }
        // Held for a while: allowing the server from the app (below) registers it without asking the device again.
        const p = push.pendingFor(sub.endpoint);
        if (!p) return bad('the hub cannot send to that push endpoint');
        const how = p.http ? `type ${p.origin} under Settings → Notifications → Push servers` : `open Settings → Notifications and tap Allow`;
        return Response.json({ error: `the hub does not send through ${p.origin} yet: ${how}`, server: p.origin, http: p.http }, { status: 403 });
      }
      // Which push servers the hub may POST to. Only the app itself changes this: a same-origin page, never a bare request.
      if (path === '/api/push/servers' && (method === 'POST' || method === 'DELETE')) {
        if (!req.headers.get('origin') || !sameOrigin(req)) return bad('push servers are allowed from the app itself', 403);
        const b = await body<{ origin?: string; typed?: boolean; allowPrivate?: boolean; dismiss?: boolean }>();
        if (typeof b.origin !== 'string' || !b.origin) return bad('which server?');
        if (method === 'DELETE' && b.dismiss) return (push.dismiss(b.origin), ok());
        if (method === 'DELETE') {
          const r = push.revoke(b.origin);
          return r.ok ? ok(r) : bad(r.error!);
        }
        const r = await push.approve(b.origin, { typed: !!b.typed, allowPrivate: !!b.allowPrivate });
        return r.ok ? ok(r) : Response.json(r, { status: r.confirm ? 409 : 400 });
      }
      if (path === '/api/push/arrived' && method === 'POST') {
        const b = await body<{ id?: string }>();
        if (typeof b.id === 'string') push.arrived(b.id);
        return ok();
      }
      if (path === '/api/push/unsubscribe' && method === 'POST') {
        const b = await body<{ id?: string; endpoint?: string }>();
        push.remove(b);
        this.opts.devices?.touch();
        return ok();
      }
      if (path === '/api/push/test' && method === 'POST') {
        const b = await body<{ id?: string; endpoint?: string }>();
        return ok(await push.test(b));
      }
    }
    if (path === '/api/directory/stats') return ok(s.placeStats(Date.now() - 7 * 86_400_000));
    if (path === '/api/categories' && method === 'POST') {
      const b = await body<Partial<P.CategoryView>>();
      if (!b.name?.trim()) return bad('a category needs a name');
      const id = s.putCategory({ name: b.name.trim(), question: b.question?.trim() || `Is this community about ${b.name.trim()}?`, keywords: b.keywords ?? [], color: b.color ?? null, threshold: threshold(b.threshold) });
      this.opts.onCategoriesChanged?.();
      return ok({ id });
    }
    if (path === '/api/categories/probe' && method === 'POST') {
      const b = await body<{ question?: string }>();
      const question = b.question?.trim().slice(0, 300);
      if (!question) return bad('what should it ask?');
      if (!this.opts.probeCategory) return bad('no categorizer on this hub', 503);
      return ok(await this.opts.probeCategory(question));
    }
    if (path === '/api/categories/rescore' && method === 'POST') {
      this.opts.onCategoriesChanged?.(true);
      return ok();
    }
    if (path === '/api/category-overrides' && method === 'PUT') {
      const b = await body<{ categoryId: string; kind: 'space' | 'conversation'; id: string; assigned: boolean | null }>();
      if (!b.categoryId || !b.id || !['space', 'conversation'].includes(b.kind)) return bad('which category and place?');
      s.setCategoryOverride(b.categoryId, b.kind, b.id, b.assigned ?? null);
      return ok();
    }
    if ((m = path.match(/^\/api\/categories\/([\w-]+)$/))) {
      const cur = s.categories().find((c) => c.id === m![1]);
      if (!cur) return bad('no such category', 404);
      if (method === 'DELETE') {
        s.deleteCategory(cur.id);
        return ok();
      }
      if (method === 'PATCH') {
        const b = await body<Partial<P.CategoryView>>();
        s.putCategory({ ...cur, ...b, id: cur.id, threshold: 'threshold' in b ? threshold(b.threshold) : cur.threshold });
        this.opts.onCategoriesChanged?.();
        return ok();
      }
    }
    if (path === '/api/privacy') {
      if (method === 'PUT') {
        const b = await body<Partial<P.PrivacySettings>>();
        if (typeof b.shareTyping !== 'boolean') return bad('shareTyping: true or false');
        s.setPrivacy({ shareTyping: b.shareTyping });
      }
      return ok(s.privacy());
    }
    if ((m = path.match(/^\/api\/conversations\/([\w-]+)\/typing$/)) && method === 'POST') {
      const b = await body<{ accountId?: string; stop?: boolean }>();
      return ok(this.typing(m[1], b.accountId, !!b.stop));
    }
    if (path === '/api/quiet-hours') {
      if (method === 'PUT') {
        const b = await body<Partial<P.QuietHours>>();
        if (!validQuietHours(b)) return bad('quiet hours need a start, an end and a time zone');
        s.setQuietHours({ enabled: !!b.enabled, start: b.start, end: b.end, timezone: b.timezone, days: b.days ?? [], allowStarred: !!b.allowStarred });
      }
      return ok({ quietHours: s.quietHours() });
    }
    if (path === '/api/daily-digest') {
      if (method === 'PUT') {
        const b = await body<Partial<P.DailyDigest>>();
        if (!validDailyDigest(b)) return bad('the digest needs a time and a time zone');
        this.triage.setDailyDigest({ enabled: !!b.enabled, time: b.time, timezone: b.timezone });
      }
      return ok({ dailyDigest: s.dailyDigest() });
    }
    // Per-device notification rules (docs/devices.md).
    if (path.startsWith('/api/devices')) {
      const d = this.opts.devices;
      if (!d) return bad('per-device rules are not available', 404);
      if (path === '/api/devices' && method === 'GET') return ok({ devices: d.list() });
      if (path === '/api/devices/hello' && method === 'POST') {
        const b = await body<{ id?: string; label?: string; endpoint?: string | null }>();
        if (!Devices.validId(b.id)) return bad('which device?');
        d.hello(b.id, typeof b.label === 'string' ? b.label : '', typeof b.endpoint === 'string' ? b.endpoint : null);
        return ok();
      }
      if (path === '/api/devices/rules' && method === 'PUT') {
        const b = await body<{ device?: string; scope?: P.DeviceScope; target?: string; level?: P.DeviceLevel | null }>();
        if (!Devices.validId(b.device) || typeof b.target !== 'string' || !b.target) return bad('which device and place?');
        const err = d.setRule(b.device, b.scope as P.DeviceScope, b.target, b.level ?? null);
        return err ? bad(err) : ok();
      }
      if (path === '/api/devices' && method === 'DELETE') {
        const b = await body<{ id?: string }>();
        if (!Devices.validId(b.id)) return bad('which device?');
        d.forget(b.id);
        return ok();
      }
    }
    if (path === '/api/rules' && method === 'PUT') {
      const b = await body<{ scope: P.NotifyScope; target: string | null; level: P.NotifyLevel | null }>();
      s.setRule(b.scope, b.target ?? null, b.level ?? null);
      // Conversations under this rule now explain themselves differently.
      for (const c of s.raw<{ id: string }>('SELECT id FROM conversation')) s.dirty.conversations.add(c.id);
      return ok();
    }

    if (path === '/api/accounts' && method === 'POST') {
      const b = await body<{ network: P.Network; label?: string; color?: string; adapter?: string; config?: unknown; secret?: unknown }>();
      if (!NETWORKS.includes(b.network)) return bad('unknown network');
      if (b.adapter !== undefined && !validAdapterName(b.adapter)) return bad('unknown adapter');
      if (s.accounts().some((a) => a.demo)) return bad('This is a demo hub. Real accounts go on a hub with its own data dir, started without --demo.');
      const used = new Set(s.accounts().map((a) => a.color));
      const color = b.color ?? ACCOUNT_COLORS.find((c) => !used.has(c)) ?? ACCOUNT_COLORS[0];
      const acc = s.createAccount({ network: b.network, label: b.label?.trim() || NETWORK_META[b.network].name, color, adapter: b.adapter ?? b.network, config: b.config });
      if (this.sup.created) await this.sup.created(acc, b.secret ?? {});
      else {
        this.sup.writeSecret(acc.id, b.secret ?? {});
        this.sup.start(acc.id);
      }
      return ok(s.accountView(acc));
    }
    if ((m = path.match(/^\/api\/accounts\/([\w-]+)$/))) {
      const acc = s.account(m[1]);
      if (!acc) return bad('no such account', 404);
      if (method === 'DELETE') {
        await this.sup.stop(acc.id);
        await this.sup.forget?.(acc.id);
        s.deleteAccount(acc.id);
        this.flush();
        return ok();
      }
      if (method === 'PATCH') {
        const b = await body<{ label?: string; color?: string; enabled?: boolean }>();
        s.updateAccount(acc.id, {
          ...(b.label !== undefined ? { label: b.label } : {}),
          ...(b.color !== undefined ? { color: b.color } : {}),
          ...(b.enabled !== undefined ? { enabled: b.enabled ? 1 : 0 } : {}),
        });
        if (b.enabled === false) {
          await this.sup.stop(acc.id);
          s.updateAccount(acc.id, { status: 'disabled' });
        } else if (b.enabled === true) this.sup.start(acc.id);
        return ok();
      }
    }
    if ((m = path.match(/^\/api\/accounts\/([\w-]+)\/action$/)) && method === 'POST') {
      const b = await body<{ action: string; args?: unknown }>();
      if (b.action === 'restart') {
        await this.sup.restart(m[1]);
        return ok();
      }
      const r = await this.sup.command(m[1], { t: 'action', action: b.action, args: b.args }, 60_000);
      return ok({ ok: true, result: r });
    }
    if ((m = path.match(/^\/api\/accounts\/([\w-]+)\/log$/))) {
      const p = join(this.sup.accountDir(m[1]), 'adapter.log');
      // The tail only: the file is rotated at 10 MB (housekeeping.ts) and need not be read whole.
      const f = Bun.file(p);
      const text = existsSync(p) ? await f.slice(Math.max(0, f.size - 24_000)).text() : '';
      return new Response(text.slice(-20_000), { headers: { 'content-type': 'text/plain; charset=utf-8' } });
    }
    return bad('not found', 404);
  }

  private async sendNow(conversationId: string, b: { body?: string; accountId?: string; replyTo?: string; attachments?: string[] }): Promise<Response> {
    const s = this.store;
    const ok = (x: unknown) => Response.json(x);
    const bad = (msg: string, status = 400) => Response.json({ error: msg }, { status });
    const ids = b.attachments ?? [];
    if (!b.body?.trim() && !ids.length) return bad('empty message');
    const conv = s.nativeOf('conversation', conversationId);
    if (!conv) return bad('no such conversation', 404);
    const accountId = this.pickAccount(conversationId, b.accountId);
    if (!accountId) return bad('no connected account can send here', 409);
    const refused = this.sendRefusal(conversationId, accountId);
    if (refused) return bad(refused, 409);
    const replyTo = b.replyTo ? s.nativeOf('message', b.replyTo)?.nativeId : undefined;
    const files = this.uploads.get(ids);
    if (!files) return bad('that upload has expired, attach the file again', 410);
    if (files.length) {
      const acc = s.account(accountId)!;
      const limit = ATTACHMENT_LIMITS[conv.network];
      const name = NETWORK_META[conv.network].name;
      if (!(JSON.parse(acc.capabilities) as P.Capability[]).includes('sendMedia')) return bad(`${acc.label} cannot send files on ${name}`, 409);
      if (files.length > limit.files) return bad(`${name} takes ${limit.files} files at a time`, 413);
      if (files.some((f) => f.size > limit.bytes)) return bad(`${name} takes files up to ${limit.bytes / 1024 / 1024} MB`, 413);
    }
    const result = await this.sup.command(accountId, { t: 'send', conversation: conv.nativeId, body: b.body ?? '', replyTo, ...(files.length ? { attachments: files } : {}) }, files.length ? 180_000 : undefined);
    this.uploads.remove(ids);
    // Message ids are derived from the network's, so this is the message's id whether or not it is stored yet.
    const native = (result as { nativeId?: unknown } | undefined)?.nativeId;
    const messageId = typeof native === 'string' && native ? hubId('msg', conv.network, native) : undefined;
    return ok({ ok: true, accountId, result, ...(messageId ? { messageId } : {}) } satisfies P.SendResult);
  }

  /**
   * You are typing in a conversation, or stopped: tell its network through the account that would send (docs/typing.md).
   * Best effort and never waited for. Nothing goes out when you chose not to share it; a stop always may.
   */
  typing(conversationId: string, requested: string | undefined, stop: boolean): { sent: boolean; accountId?: string; why?: string } {
    if (!stop && !this.store.privacy().shareTyping) return { sent: false, why: 'off' };
    const conv = this.store.nativeOf('conversation', conversationId);
    const accountId = conv && this.pickAccount(conversationId, requested);
    if (!conv || !accountId || !this.sup.online(accountId)) return { sent: false, why: 'no connected account' };
    const acc = this.store.account(accountId)!;
    if (!(JSON.parse(acc.capabilities) as P.Capability[]).includes('typing')) return { sent: false, why: 'not on this network' };
    if (this.sendRefusal(conversationId, accountId)) return { sent: false, why: 'cannot write here' };
    if (!this.typingGate.allow(accountId, conversationId, stop)) return { sent: false, why: 'throttled' };
    this.sup.command(accountId, { t: 'typing', conversation: conv.nativeId, ...(stop ? { stop: true } : {}) }, 15_000).catch(() => {});
    return { sent: true, accountId };
  }

  private sendRefusal(conversationId: string, accountId: string | null): string | null {
    const c = this.store.conversationView(conversationId);
    const acc = accountId ? this.store.account(accountId) : null;
    return c ? sendBlocker(c, acc ? this.store.accountView(acc) : null) : 'No such conversation';
  }

  /**
   * What a push needs for replying from the notification: whether to offer it, and what to quote. The send itself is
   * re-checked when it arrives, since this can be out of date by then. A DM has no need for a quote.
   */
  replyFields(conversationId: string, messageId: string): { canReply?: true; replyTo?: string } {
    if (this.sendRefusal(conversationId, this.pickAccount(conversationId))) return {};
    return this.store.conversationView(conversationId)?.shape === 'direct' ? { canReply: true } : { canReply: true, replyTo: messageId };
  }

  /** Which account sends into a conversation: the requested one, else the last one you used there, else any connected. */
  private pickAccount(conversationId: string, requested?: string): string | null {
    const vs = this.store.vantageAccounts('conversation', conversationId);
    if (requested && vs.includes(requested)) return requested;
    const last = this.store.one<{ account_id: string }>(
      `SELECT s.account_id FROM message m JOIN message_seen s ON s.message_id = m.id JOIN account a ON a.id = s.account_id
       WHERE m.conversation_id = ? AND m.author_id = a.self_identity ORDER BY m.ts DESC LIMIT 1`,
      conversationId,
    );
    if (last && vs.includes(last.account_id) && this.sup.online(last.account_id)) return last.account_id;
    return vs.find((a) => this.sup.online(a)) ?? vs[0] ?? null;
  }

  // ---------------------------------------------------------------- voice crypto

  /**
   * Discord's DAVE library for direct-mode calls, as scripts/dave/update.ts extracted, tested and promoted
   * it. Never part of this repo: it lives in DITHER_DAVE_DIR. The device loads it into an opaque-origin
   * worker, hence the open CORS header; it is public code and holds nothing of the user's.
   */
  private daveRoot(): string {
    return process.env.DITHER_DAVE_DIR ?? join(this.opts.dataDir, 'dave');
  }

  private daveCurrent(): Response {
    const file = join(this.daveRoot(), 'current.json');
    if (!existsSync(file)) return Response.json({ error: 'No DAVE library yet. Run: bun scripts/dave/update.ts --root ' + this.daveRoot() }, { status: 404 });
    const cur = JSON.parse(readFileSync(file, 'utf8')) as { dir: string; build?: string; maxProtocolVersion?: number };
    const id = cur.dir.split('/').filter(Boolean).pop()!;
    return Response.json({ id, build: cur.build ?? null, maxProtocolVersion: cur.maxProtocolVersion ?? null, module: `/voice/dave/${id}/libdave.mjs` }, { headers: { 'cache-control': 'no-cache' } });
  }

  private daveFile(id: string, name: string): Response {
    const file = join(this.daveRoot(), id, name);
    if (!existsSync(file)) return new Response('not found', { status: 404 });
    return new Response(Bun.file(file), {
      headers: {
        'content-type': name.endsWith('.wasm') ? 'application/wasm' : 'text/javascript; charset=utf-8',
        'access-control-allow-origin': '*',
        'cache-control': 'public, max-age=31536000, immutable',
      },
    });
  }

  // ---------------------------------------------------------------- media

  private async media(sig: string, b64: string, accountId: string | null): Promise<Response> {
    const raw = Buffer.from(b64, 'base64url').toString('utf8');
    const expect = createHmac('sha256', this.opts.secret).update(`${raw}|${accountId ?? ''}`).digest('base64url').slice(0, 16);
    if (sig !== expect) return new Response('bad signature', { status: 403 });
    return this.fetchMedia(raw, accountId);
  }

  /** The bytes behind a stored media URL, for sending them on. */
  private async mediaBytes(raw: string, accountId: string | null): Promise<{ bytes: Uint8Array; mime: string } | null> {
    const data = raw.match(/^data:([^;,]+)?(;base64)?,(.*)$/s);
    if (data) return { mime: data[1] ?? 'application/octet-stream', bytes: data[2] ? Buffer.from(data[3], 'base64') : new TextEncoder().encode(decodeURIComponent(data[3])) };
    const res = await this.fetchMedia(raw, accountId);
    if (!res.ok) return null;
    return { bytes: new Uint8Array(await res.arrayBuffer()), mime: res.headers.get('content-type') ?? 'application/octet-stream' };
  }

  private async fetchMedia(raw: string, accountId: string | null): Promise<Response> {
    const cacheDir = join(this.opts.dataDir, 'media-cache');
    if (!existsSync(cacheDir)) mkdirSync(cacheDir, { recursive: true, mode: 0o700 });
    const key = new Bun.CryptoHasher('sha256').update(raw).digest('hex');
    const file = join(cacheDir, key);
    const headers = (mime: string) => ({ 'content-type': mime, 'cache-control': 'private, max-age=604800, immutable' });
    if (existsSync(file) && existsSync(file + '.mime')) {
      // Recently seen stays longest when the cache is trimmed (mediacache.ts).
      try {
        const t = new Date();
        utimesSync(file, t, t);
      } catch {}
      return new Response(Bun.file(file), { headers: headers(readFileSync(file + '.mime', 'utf8')) });
    }

    let bytes: Uint8Array;
    let mime = 'application/octet-stream';
    if (raw.startsWith('https://') || raw.startsWith('http://')) {
      // A URL from someone else's message: public addresses only, redirects checked, size capped (fetchsafe.ts).
      const r = await fetchPublicToFile(raw, file);
      if (!r.ok) return new Response(r.error, { status: r.status });
      writeFileSync(file + '.mime', r.mime, { mode: 0o600 });
      return new Response(Bun.file(file), { headers: headers(r.mime) });
    } else if (raw.startsWith('file://')) {
      const p = normalize(decodeURIComponent(raw.slice('file://'.length)));
      const root = resolve(this.opts.dataDir);
      if (!resolve(p).startsWith(root + '/') || !existsSync(p) || !statSync(p).isFile()) return new Response('not found', { status: 404 });
      return new Response(Bun.file(p), { headers: { 'cache-control': 'private, max-age=604800' } });
    } else {
      if (!accountId) return new Response('no account to resolve media', { status: 404 });
      const r = await this.sup.command<{ mime: string; base64: string }>(accountId, { t: 'fetchMedia', url: raw }, 30_000).catch(() => null);
      if (!r) return new Response('adapter could not fetch media', { status: 502 });
      mime = r.mime;
      bytes = Buffer.from(r.base64, 'base64');
    }
    // Decrypted attachments end up here too.
    writeFileSync(file, bytes, { mode: 0o600 });
    writeFileSync(file + '.mime', mime, { mode: 0o600 });
    return new Response(Buffer.from(bytes), { headers: headers(mime) });
  }

  // ---------------------------------------------------------------- static PWA

  private static(path: string): Response {
    const root = resolve(this.opts.webDist);
    const candidate = resolve(join(root, normalize(decodeURIComponent(path))));
    if (candidate.startsWith(root) && existsSync(candidate) && statSync(candidate).isFile()) {
      const immutable = path.startsWith('/assets/');
      return new Response(Bun.file(candidate), {
        headers: {
          'cache-control': immutable ? 'public, max-age=31536000, immutable' : 'no-cache',
          ...(path.endsWith('.webmanifest') ? { 'content-type': 'application/manifest+json' } : {}),
        },
      });
    }
    // A hashed asset from another build must fail as itself: as HTML it would poison a cache.
    if (path.startsWith('/assets/')) return new Response('not found', { status: 404 });
    const index = join(root, 'index.html');
    if (existsSync(index)) return new Response(Bun.file(index), { headers: { 'cache-control': 'no-cache', 'content-type': 'text/html; charset=utf-8' } });
    return new Response('dither-chat hub is running; the web app has not been built yet (bun run web:build).', { status: 200 });
  }

  /** Queue a notification for connected clients. */
  notify(ev: Extract<P.ClientEvent, { t: 'notify' }>) {
    this.store.dirty.extra.push(ev);
  }
}
