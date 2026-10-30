import type { Server, ServerWebSocket, Socket } from 'bun';
import { createHmac } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { join, normalize, resolve } from 'node:path';
import type * as P from '@dither-chat/protocol';
import { NETWORK_META, NETWORKS } from '@dither-chat/protocol';
import type { Store } from './store.ts';
import type { AdapterSocketData, Supervisor } from './supervisor.ts';
import type { Triage } from './triage.ts';

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
  private clients = new Set<ServerWebSocket<ClientData>>();
  private flushTimer?: Timer;

  constructor(
    private store: Store,
    private sup: Supervisor,
    private triage: Triage,
    private opts: ServerOpts,
  ) {}

  start() {
    const self = this;
    this.server = Bun.serve<WsData, never>({
      port: this.opts.port,
      hostname: this.opts.hostname,
      idleTimeout: 120,
      async fetch(req, server) {
        try {
          return await self.route(req, server);
        } catch (e: any) {
          console.error('request failed', req.method, new URL(req.url).pathname, e);
          return Response.json({ error: String(e?.message ?? e) }, { status: 500 });
        }
      },
      websocket: {
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
      },
    });
    this.flushTimer = setInterval(() => this.flush(), 80);
    return this.server;
  }

  stop() {
    clearInterval(this.flushTimer);
    this.server?.stop(true);
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
    if (path === '/api/search') return ok(s.search(url.searchParams.get('q') ?? '', 60));

    if ((m = path.match(/^\/api\/conversations\/([\w-]+)\/messages$/))) return ok(s.messages(m[1], num('before'), Math.min(num('limit') ?? 60, 200)));
    if ((m = path.match(/^\/api\/persons\/([\w-]+)\/timeline$/))) return ok(s.personTimeline(m[1], num('before'), Math.min(num('limit') ?? 60, 200)));
    if ((m = path.match(/^\/api\/conversations\/([\w-]+)\/notify$/))) return ok(this.triage.effectiveLevel(m[1]));

    if ((m = path.match(/^\/api\/conversations\/([\w-]+)\/send$/)) && method === 'POST') {
      const b = await body<{ body: string; accountId?: string; replyTo?: string }>();
      if (!b.body?.trim()) return bad('empty message');
      const conv = s.nativeOf('conversation', m[1]);
      if (!conv) return bad('no such conversation', 404);
      const accountId = this.pickAccount(m[1], b.accountId);
      if (!accountId) return bad('no connected account can send here', 409);
      const replyTo = b.replyTo ? s.nativeOf('message', b.replyTo)?.nativeId : undefined;
      const result = await this.sup.command(accountId, { t: 'send', conversation: conv.nativeId, body: b.body, replyTo });
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
    if ((m = path.match(/^\/api\/conversations\/([\w-]+)\/history$/)) && method === 'POST') {
      const b = await body<{ beforeTs?: number; limit?: number }>();
      const conv = s.nativeOf('conversation', m[1]);
      const accountId = this.pickAccount(m[1]);
      if (!conv || !accountId) return ok({ count: 0, done: true });
      const r = await this.sup.command(accountId, { t: 'history', conversation: conv.nativeId, beforeTs: b.beforeTs, limit: b.limit ?? 50 }, 60_000).catch((e) => ({ error: String(e.message) }));
      return ok(r ?? { count: 0, done: true });
    }
    if ((m = path.match(/^\/api\/messages\/([\w-]+)\/react$/)) && method === 'POST') {
      const b = await body<{ key: string; remove?: boolean; accountId?: string }>();
      const msg = s.one<{ conversation_id: string; native_id: string }>('SELECT conversation_id, native_id FROM message WHERE id = ?', m[1]);
      if (!msg) return bad('no such message', 404);
      const conv = s.nativeOf('conversation', msg.conversation_id)!;
      const accountId = this.pickAccount(msg.conversation_id, b.accountId);
      if (!accountId) return bad('no connected account', 409);
      await this.sup.command(accountId, { t: 'react', conversation: conv.nativeId, message: msg.native_id, key: b.key, remove: b.remove });
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
      return ok();
    }
    if ((m = path.match(/^\/api\/identities\/([\w-]+)\/split$/)) && method === 'POST') {
      s.splitIdentity(m[1]);
      this.flush();
      return ok();
    }
    if (path === '/api/folders' && method === 'PUT') {
      const b = await body<{ folders: P.FolderView[] }>();
      s.setFolders(b.folders ?? []);
      return ok();
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
        headers: { 'cache-control': immutable ? 'public, max-age=31536000, immutable' : 'no-cache' },
      });
    }
    const index = join(root, 'index.html');
    if (existsSync(index)) return new Response(Bun.file(index), { headers: { 'cache-control': 'no-cache', 'content-type': 'text/html; charset=utf-8' } });
    return new Response('dither-chat hub is running; the web app has not been built yet (bun run web:build).', { status: 200 });
  }

  /** Queue a notification for connected clients (and ntfy, if configured). */
  notify(ev: Extract<P.ClientEvent, { t: 'notify' }>) {
    this.store.dirty.extra.push(ev);
  }
}
