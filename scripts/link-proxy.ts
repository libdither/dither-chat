/**
 * A bad link between a page and a hub, for tests (scripts/verify-link.ts, docs/sync.md "A bad link"). A TCP proxy on a
 * port of its own that the test steers: Chrome's DevTools can take the whole network away, but cannot stall one
 * connection while the rest work, delay a socket's frames, or shape a link the way a slow phone network does.
 *
 *   const link = await linkProxy(hubPort);    // listens on 127.0.0.1:<link.port>
 *   link.stall((c) => c.kind === 'ws');       // the live socket goes silent: open, but nothing gets through
 *   link.hangOn(/^POST \/api\/sync/);         // a request like that, and its connection, goes silent from then on
 *   link.cut();                               // every connection closed at once
 *   link.shape({ bytesPerSec: 187_500, queueBytes: 375_000 });  // the hub's bytes through one queue, as a slow link
 *
 * Silent means a black hole: what is sent is dropped and nothing comes back, as a phone that slept, a NAT that forgot
 * the connection, or a network that went away under it. Neither end hears of it.
 */
import { connect, createServer, type Server, type Socket } from 'node:net';

export interface Conn {
  id: number;
  /** `ws` once its first request is a websocket upgrade to /api/live; `http` otherwise; `new` before its first bytes. */
  kind: 'new' | 'ws' | 'http';
  /** Request lines seen on it, in order: `GET /api/health`. */
  requests: string[];
  /** Silent: nothing more crosses, either way. */
  silent: boolean;
  closed: boolean;
  openedAt: number;
  client: Socket;
  hub: Socket;
}

export interface LinkProxy {
  port: number;
  conns: Conn[];
  /** Every connection that matches goes silent; with `andNew`, every one opened from now on that matches too. */
  stall(match: (c: Conn) => boolean, andNew?: boolean): void;
  /** A request whose line matches goes silent, and its connection with it, from now until `clear()`. */
  hangOn(line: RegExp): void;
  /** Nothing new goes silent (connections already silent stay so). */
  clear(): void;
  /** Close every connection, both ends, at once. */
  cut(): void;
  /** The hub's bytes to the page through one queue at this rate, holding at most queueBytes; null for none. */
  shape(o: { bytesPerSec: number; queueBytes: number } | null): void;
  /** Bytes in the slow link's queue right now (not counting what waits to enter it). */
  queued(): number;
  close(): Promise<void>;
}

const REQUEST_LINE = /(?:^|\r\n)((?:GET|POST|PUT|PATCH|DELETE|HEAD|OPTIONS) \S+) HTTP\/1\.1\r\n/g;

export async function linkProxy(hubPort: number, hubHost = '127.0.0.1'): Promise<LinkProxy> {
  const conns: Conn[] = [];
  let stallNew: ((c: Conn) => boolean) | null = null;
  let hang: RegExp | null = null;
  let nextId = 1;

  // ---------------------------------------------------------------- the slow link: one queue, drained at a rate
  // What the hub sends is read at once and waits in its connection's backlog (the hub's own send buffer, in effect);
  // from the backlogs it goes into the link's one queue, a slice at a time from each connection in turn, while the queue
  // has room. So each connection's bytes wait behind what the queue holds, and no more: a pong on a quiet connection
  // enters it as soon as there is room, as a small packet does at a router, not after the rest of a download.
  let shaping: { bytesPerSec: number; queueBytes: number } | null = null;
  const queue: { c: Conn; buf: Buffer }[] = [];
  let queuedBytes = 0;
  const backlog = new Map<Conn, Buffer[]>();
  let turn = 0;
  let pump: ReturnType<typeof setInterval> | null = null;
  let last = 0;
  let credit = 0;
  const SLICE = 16 * 1024;
  const admit = () => {
    while (shaping && queuedBytes < shaping.queueBytes && backlog.size) {
      const order = [...backlog.keys()];
      const c = order[turn++ % order.length];
      const bufs = backlog.get(c)!;
      const take = Math.min(SLICE, shaping.queueBytes - queuedBytes);
      let part = bufs[0];
      if (part.length > take) {
        bufs[0] = part.subarray(take);
        part = part.subarray(0, take);
      } else bufs.shift();
      if (!bufs.length) backlog.delete(c);
      queue.push({ c, buf: part });
      queuedBytes += part.length;
    }
  };
  const drain = () => {
    const now = performance.now();
    credit += ((now - last) / 1000) * shaping!.bytesPerSec;
    last = now;
    while (queue.length && credit >= 1) {
      const head = queue[0];
      const n = Math.min(head.buf.length, Math.floor(credit));
      if (!head.c.silent && !head.c.closed) head.c.client.write(head.buf.subarray(0, n));
      credit -= n;
      queuedBytes -= n;
      if (n === head.buf.length) queue.shift();
      else head.buf = head.buf.subarray(n);
    }
    // An idle link saves up nothing.
    if (!queue.length) credit = 0;
    admit();
  };
  const toClient = (c: Conn, buf: Buffer) => {
    if (c.silent || c.closed) return;
    if (!shaping) return void c.client.write(buf);
    (backlog.get(c) ?? backlog.set(c, []).get(c)!).push(buf);
    admit();
  };

  const server: Server = createServer({ noDelay: true }, (client) => {
    const hub = connect({ port: hubPort, host: hubHost, noDelay: true });
    const c: Conn = { id: nextId++, kind: 'new', requests: [], silent: false, closed: false, openedAt: Date.now(), client, hub };
    conns.push(c);
    const end = () => {
      if (c.closed) return;
      c.closed = true;
      client.destroy();
      hub.destroy();
    };
    client.on('data', (buf: Buffer) => {
      if (c.silent) return;
      const text = buf.toString('latin1');
      for (const m of text.matchAll(REQUEST_LINE)) {
        c.requests.push(m[1]);
        if (c.kind === 'new') c.kind = /^GET \/api\/live\b/.test(m[1]) && /\r\nupgrade: websocket/i.test(text) ? 'ws' : 'http';
        if (hang?.test(m[1])) c.silent = true;
      }
      if (c.kind !== 'new' && stallNew?.(c)) c.silent = true;
      if (!c.silent) hub.write(buf);
    });
    hub.on('data', (buf: Buffer) => toClient(c, buf));
    // A silent connection stays open: the page must find out by itself that nothing comes.
    client.on('close', end);
    hub.on('close', () => !c.silent && end());
    client.on('error', () => {});
    hub.on('error', () => {});
  });
  await new Promise<void>((res) => server.listen(0, '127.0.0.1', res));
  const port = (server.address() as { port: number }).port;

  return {
    port,
    conns,
    stall(match, andNew = false) {
      for (const c of conns) if (!c.closed && c.kind !== 'new' && match(c)) c.silent = true;
      if (andNew) stallNew = match;
    },
    hangOn(line) {
      hang = line;
    },
    clear() {
      stallNew = null;
      hang = null;
    },
    cut() {
      for (const c of conns) if (!c.closed) (c.closed = true), c.client.destroy(), c.hub.destroy();
    },
    shape(o) {
      shaping = o;
      if (pump) clearInterval(pump);
      pump = null;
      if (!o) {
        for (const { c, buf } of queue.splice(0)) if (!c.silent && !c.closed) c.client.write(buf);
        for (const [c, bufs] of backlog) for (const buf of bufs) if (!c.silent && !c.closed) c.client.write(buf);
        backlog.clear();
        queuedBytes = 0;
        return;
      }
      last = performance.now();
      credit = 0;
      pump = setInterval(drain, 5);
    },
    queued: () => queuedBytes,
    async close() {
      if (pump) clearInterval(pump);
      for (const c of conns) c.client.destroy(), c.hub.destroy();
      await new Promise<void>((res) => server.close(() => res()));
    },
  };
}
