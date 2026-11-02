import type { Server, ServerWebSocket, Socket, WebSocketHandler } from 'bun';
import { createHmac } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { join, normalize, resolve } from 'node:path';
import type * as P from '@dither-chat/protocol';
import { ATTACHMENT_LIMITS, discordEmojiUrl, MAX_UPLOAD, NETWORK_META, NETWORKS } from '@dither-chat/protocol';
import type { Store } from './store.ts';
import type { AdapterSocketData, Supervisor } from './supervisor.ts';
import type { PushService } from './push.ts';
import type { ReadQueue } from './readqueue.ts';
import { validQuietHours, type Triage } from './triage.ts';
import { cleanFileName, Uploads } from './uploads.ts';

const ACCOUNT_COLORS = ['#F2A541', '#E86A92', '#B794F6', '#FF8C61', '#9BE15D', '#5CC8FF', '#F7D154', '#FF6B6B'];

type ClientData = { kind: 'client' };
type LiveViewData = { kind: 'liveview'; accountId: string; port: number; tcp?: Socket<unknown>; queue: Uint8Array[] };
type WsData = ClientData | LiveViewData | AdapterSocketData;

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
  onDemoReset?: () => Promise<void>;
}

// ------------------------------------------------------------------ access

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

// ------------------------------------------------------------------ media

export function mediaSigner(secret: string) {
  return (raw: string | null | undefined, accountId: string | null | undefined): string | null => {
    if (!raw) return null;
    if (raw.startsWith('data:')) return raw;
    const sig = createHmac('sha256', secret).update(`${raw}|${accountId ?? ''}`).digest('base64url').slice(0, 16);
    return `/media/${sig}/${Buffer.from(raw).toString('base64url')}${accountId ? `?a=${accountId}` : ''}`;
  };
}

export class HubServer {
  server!: Server<WsData>;
  private plain?: Server<WsData>;
  private clients = new Set<ServerWebSocket<ClientData>>();
  private flushTimer?: Timer;
  private uploads: Uploads;

  constructor(
    private store: Store,
    private sup: Supervisor,
    private triage: Triage,
    private opts: ServerOpts,
  ) {
    this.uploads = new Uploads(join(opts.dataDir, 'uploads'));
  }

  start() {
    const self = this;
    const guarded = (handler: (req: Request, server: Server<WsData>) => Promise<Response | undefined> | Response | undefined) =>
      async (req: Request, server: Server<WsData>) => {
        try {
          return await handler(req, server);
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
          else self.openLiveView(ws as ServerWebSocket<LiveViewData>);
        },
        message(ws, msg) {
          const d = ws.data;
          if (d.kind === 'adapter') self.sup.receive(ws as ServerWebSocket<AdapterSocketData>, msg);
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
          else d.tcp?.end();
        },
    };
    const common = { idleTimeout: 120, websocket };
    this.server = Bun.serve<WsData, never>({
      ...common,
      port: this.opts.port,
      hostname: this.opts.hostname,
      ...(tls ? { tls: { cert: Bun.file(tls.cert), key: Bun.file(tls.key) } } : {}),
      fetch: guarded((req, server) => self.route(req, server)),
    });
    // Adapters on this machine still speak ws://, and a device has to fetch the CA before it can trust HTTPS.
    if (tls && this.opts.plainPort) {
      this.plain = Bun.serve<WsData, never>({
        ...common,
        port: this.opts.plainPort,
        hostname: this.opts.hostname,
        fetch: guarded((req, server) => self.plainRoute(req, server)),
      });
    }
    this.flushTimer = setInterval(() => this.flush(), 80);
    return this.server;
  }

  stop() {
    clearInterval(this.flushTimer);
    this.server?.stop(true);
    this.plain?.stop(true);
  }

  flush() {
    this.broadcast(this.store.flush());
  }

  broadcast(events: P.ClientEvent[]) {
    if (!events.length) return;
    const frame = JSON.stringify(events);
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

    if (path.startsWith('/api/') && req.method !== 'GET' && !sameOrigin(req)) return new Response('cross-site request refused', { status: 403 });
    if ((path === '/api/live' || path.startsWith('/api/liveview/')) && !sameOrigin(req)) return new Response('cross-site socket refused', { status: 403 });
    if (path === '/ca.crt') return this.caCert();

    if (path === '/api/live') {
      if (server.upgrade(req, { data: { kind: 'client' } satisfies ClientData })) return undefined;
      return new Response('upgrade failed', { status: 400 });
    }
    let m: RegExpMatchArray | null;
    if ((m = path.match(/^\/api\/liveview\/([\w-]+)$/))) {
      const acc = this.store.account(m[1]);
      const lv = acc?.live_view ? (JSON.parse(acc.live_view) as { vncPort: number }) : null;
      if (!lv) return new Response('no live view for this account', { status: 404 });
      const proto = req.headers.get('sec-websocket-protocol');
      const headers = proto?.split(',').map((s) => s.trim()).includes('binary') ? { 'Sec-WebSocket-Protocol': 'binary' } : undefined;
      if (server.upgrade(req, { data: { kind: 'liveview', accountId: m[1], port: lv.vncPort, queue: [] } satisfies LiveViewData, headers })) return undefined;
      return new Response('upgrade failed', { status: 400 });
    }
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
    if (path === '/api/bootstrap') return ok(s.bootstrap());
    if (path === '/api/inbox') return ok(s.inbox(num('since') ?? Date.now() - 7 * 86_400_000));
    if (path === '/api/search') return ok(s.search(url.searchParams.get('q') ?? '', Math.min(num('limit') ?? 40, 100), url.searchParams.get('cursor')));

    if ((m = path.match(/^\/api\/messages\/([\w-]+)\/context$/))) {
      const page = s.messageContext(m[1], Math.min(num('around') ?? 30, 100));
      return page ? ok(page) : bad('no such message', 404);
    }
    if ((m = path.match(/^\/api\/conversations\/([\w-]+)\/messages$/)) && num('after') !== null) return ok(s.messagesAfter(m[1], num('after')!, Math.min(num('limit') ?? 60, 200)));
    if ((m = path.match(/^\/api\/conversations\/([\w-]+)\/messages$/))) return ok(s.messages(m[1], num('before'), Math.min(num('limit') ?? 60, 200)));
    if ((m = path.match(/^\/api\/persons\/([\w-]+)\/profile$/)) || (m = path.match(/^\/api\/identities\/([\w-]+)\/profile$/))) {
      const p = s.profile(path.startsWith('/api/persons/') ? { personId: m[1] } : { identityId: m[1] });
      return p ? ok(p) : bad('nobody by that id', 404);
    }
    if ((m = path.match(/^\/api\/identities\/([\w-]+)\/person$/)) && method === 'POST') {
      if (!s.nativeOf('identity', m[1])) return bad('no such identity', 404);
      const personId = s.ensurePerson(m[1]);
      this.flush();
      return ok({ personId });
    }
    if ((m = path.match(/^\/api\/persons\/([\w-]+)\/timeline$/))) return ok(s.personTimeline(m[1], num('before'), Math.min(num('limit') ?? 60, 200)));
    if ((m = path.match(/^\/api\/conversations\/([\w-]+)\/notify$/))) return ok(this.triage.effectiveLevel(m[1]));
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
    if ((m = path.match(/^\/api\/conversations\/([\w-]+)\/send$/)) && method === 'POST') {
      const b = await body<{ body?: string; accountId?: string; replyTo?: string; attachments?: string[] }>();
      const ids = b.attachments ?? [];
      if (!b.body?.trim() && !ids.length) return bad('empty message');
      const conv = s.nativeOf('conversation', m[1]);
      if (!conv) return bad('no such conversation', 404);
      const accountId = this.pickAccount(m[1], b.accountId);
      if (!accountId) return bad('no connected account can send here', 409);
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
      return ok({ ok: true, accountId, result });
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
    if ((m = path.match(/^\/api\/messages\/([\w-]+)\/feedback$/)) && method === 'POST') {
      const b = await body<{ feedback: P.TriageView['feedback'] }>();
      s.triageFeedback(m[1], b.feedback ?? null);
      return ok();
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
    if (path.startsWith('/api/push')) {
      const push = this.opts.push;
      if (!push) return bad('push is not available', 404);
      if (path === '/api/push' && method === 'GET') return ok({ publicKey: push.publicKey, devices: push.devices(), ntfy: !!process.env.DITHER_NTFY_URL });
      if (path === '/api/push/subscribe' && method === 'POST') {
        const b = await body<{ subscription: { endpoint?: string; keys?: { p256dh?: string; auth?: string } }; label?: string }>();
        const sub = b.subscription;
        if (!sub?.endpoint || !sub.keys?.p256dh || !sub.keys?.auth) return bad('that is not a push subscription');
        const id = push.subscribe({ endpoint: sub.endpoint, p256dh: sub.keys.p256dh, auth: sub.keys.auth }, b.label);
        return id ? ok({ id }) : bad('that push service is not one browsers use');
      }
      if (path === '/api/push/unsubscribe' && method === 'POST') {
        const b = await body<{ id?: string; endpoint?: string }>();
        push.remove(b);
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
      const id = s.putCategory({ name: b.name.trim(), question: b.question?.trim() || `Is this community about ${b.name.trim()}?`, keywords: b.keywords ?? [], color: b.color ?? null });
      this.opts.onCategoriesChanged?.();
      return ok({ id });
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
        s.putCategory({ ...cur, ...b, id: cur.id });
        this.opts.onCategoriesChanged?.();
        return ok();
      }
    }
    if (path === '/api/quiet-hours') {
      if (method === 'PUT') {
        const b = await body<Partial<P.QuietHours>>();
        if (!validQuietHours(b)) return bad('quiet hours need a start, an end and a time zone');
        s.setQuietHours({ enabled: !!b.enabled, start: b.start, end: b.end, timezone: b.timezone, days: b.days ?? [], allowStarred: !!b.allowStarred });
      }
      return ok({ quietHours: s.quietHours() });
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
      const used = new Set(s.accounts().map((a) => a.color));
      const color = b.color ?? ACCOUNT_COLORS.find((c) => !used.has(c)) ?? ACCOUNT_COLORS[0];
      const acc = s.createAccount({ network: b.network, label: b.label?.trim() || NETWORK_META[b.network].name, color, adapter: b.adapter ?? b.network, config: b.config });
      this.sup.writeSecret(acc.id, b.secret ?? {});
      this.sup.start(acc.id);
      return ok(s.accountView(acc));
    }
    if ((m = path.match(/^\/api\/accounts\/([\w-]+)$/))) {
      const acc = s.account(m[1]);
      if (!acc) return bad('no such account', 404);
      if (method === 'DELETE') {
        await this.sup.stop(acc.id);
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
      const text = existsSync(p) ? readFileSync(p, 'utf8') : '';
      return new Response(text.slice(-20_000), { headers: { 'content-type': 'text/plain; charset=utf-8' } });
    }
    return bad('not found', 404);
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

  // ---------------------------------------------------------------- media

  private async media(sig: string, b64: string, accountId: string | null): Promise<Response> {
    const raw = Buffer.from(b64, 'base64url').toString('utf8');
    const expect = createHmac('sha256', this.opts.secret).update(`${raw}|${accountId ?? ''}`).digest('base64url').slice(0, 16);
    if (sig !== expect) return new Response('bad signature', { status: 403 });
    return this.fetchMedia(raw, accountId);
  }

  private async fetchMedia(raw: string, accountId: string | null): Promise<Response> {
    const cacheDir = join(this.opts.dataDir, 'media-cache');
    if (!existsSync(cacheDir)) mkdirSync(cacheDir, { recursive: true });
    const key = new Bun.CryptoHasher('sha256').update(raw).digest('hex');
    const file = join(cacheDir, key);
    const headers = (mime: string) => ({ 'content-type': mime, 'cache-control': 'private, max-age=604800, immutable' });
    if (existsSync(file) && existsSync(file + '.mime')) return new Response(Bun.file(file), { headers: headers(readFileSync(file + '.mime', 'utf8')) });

    let bytes: Uint8Array;
    let mime = 'application/octet-stream';
    if (raw.startsWith('https://') || raw.startsWith('http://')) {
      const res = await fetch(raw, { signal: AbortSignal.timeout(20_000) });
      if (!res.ok) return new Response('upstream failed', { status: 502 });
      mime = res.headers.get('content-type') ?? mime;
      bytes = new Uint8Array(await res.arrayBuffer());
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
    writeFileSync(file, bytes);
    writeFileSync(file + '.mime', mime);
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

  /** Queue a notification for connected clients (and ntfy, if configured). */
  notify(ev: Extract<P.ClientEvent, { t: 'notify' }>) {
    this.store.dirty.extra.push(ev);
  }
}
