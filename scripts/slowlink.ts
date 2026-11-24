/**
 * A slow link between a browser and a hub: a TCP proxy that holds every byte as a poor phone link would, for
 * verify-perf's slow pass (docs/perf.md, "Over a slow link").
 *
 * DevTools' own throttling (Network.emulateNetworkConditions) is set per page: the service worker's requests, its whole
 * precache, go round it, and so does nothing else share the page's link. Here everything the browser asks of the hub
 * goes through one link: each direction sends at its rate, one packet at a time, and each packet arrives half a round
 * trip after it left. A new connection waits a round trip (the handshake) before its first byte goes. Which connection
 * sends next: in turn (`fair`, as a router that queues each flow on its own does, and roughly what TCP's congestion
 * control comes to when flows share a bottleneck) or first come first served (`fifo`, a deep shared buffer).
 *
 * It reads the browser's requests (HTTP/1.1, one at a time on a connection: Chromium does not pipeline) and puts each
 * byte the hub sends on that connection to the request it answers, with the time it reached the browser.
 */

/** What a request is for, from its path and the browser's Sec-Fetch-Dest. */
type ReqKind = 'document' | 'script' | 'style' | 'bootstrap' | 'api' | 'pages' | 'pictures' | 'precache' | 'socket' | 'other';
export const REQ_KINDS: ReqKind[] = ['document', 'script', 'style', 'bootstrap', 'api', 'pages', 'pictures', 'precache', 'socket', 'other'];

export interface Req {
  method: string;
  path: string;
  /** Sec-Fetch-Dest. */
  dest: string;
  kind: ReqKind;
  /** When the browser sent it (epoch ms). */
  at: number;
  /** When its first and last byte reached the browser (0: none yet). */
  first: number;
  last: number;
  /** Bytes of the answer on the wire (headers and body, as the hub sent them), and when each packet reached the browser. */
  bytes: number;
  arrivals: [t: number, n: number][];
}

interface SlowLink {
  port: number;
  /** Every request the browser sent through it, in the order sent. */
  reqs: Req[];
  close(): void;
}

const MTU = 1500;
const clock = () => performance.timeOrigin + performance.now();

function kindOf(method: string, path: string, dest: string, upgrade: boolean): ReqKind {
  const p = path.split('?')[0];
  if (upgrade) return 'socket';
  if (p === '/api/bootstrap') return 'bootstrap';
  // A conversation's page, or a person's chat of several routes (prefetch.ts, Timeline.tsx).
  if (/^\/api\/(conversations\/[^/]+\/(messages|history)|chats\/[^/]+\/messages)$/.test(p)) return 'pages';
  if (p.startsWith('/api/')) return 'api';
  if (p.startsWith('/media/') || p.startsWith('/emoji/') || dest === 'image') return 'pictures';
  if (dest === 'document' || dest === 'iframe') return 'document';
  if (dest === 'script' || dest === 'worker') return 'script';
  if (dest === 'style') return 'style';
  // The worker's own script, and every file it fetches to keep (sw.js fillShell: fetch() has no destination).
  if (dest === 'serviceworker' || (dest === 'empty' && method === 'GET')) return 'precache';
  return 'other';
}

/** One direction of the link: packets leave one at a time at `rate` bytes/ms and land `delay` ms later. */
class Pipe {
  private freeAt = 0;
  private queues = new Map<number, { flow: Flow; piece: Uint8Array; req?: Req }[]>();
  private turn: number[] = [];
  private timer: ReturnType<typeof setTimeout> | undefined;
  constructor(
    private rate: number,
    private delay: number,
    private fair: boolean,
  ) {}
  /** A chunk to send; an empty one closes the flow once everything before it has landed. */
  push(flow: Flow, chunk: Uint8Array, req?: Req) {
    // An idle link sends from now; a busy one keeps its schedule, so a late timer costs no bandwidth.
    if (!this.turn.length) this.freeAt = Math.max(this.freeAt, clock());
    const key = this.fair ? flow.id : 0;
    let q = this.queues.get(key);
    if (!q) this.queues.set(key, (q = [])), this.turn.push(key);
    if (!chunk.length) q.push({ flow, piece: chunk });
    for (let i = 0; i < chunk.length; i += MTU) q.push({ flow, piece: chunk.subarray(i, i + MTU), req });
    if (!this.timer) this.pump();
  }
  /** Sends every packet whose turn has come, then waits for the next. */
  private pump() {
    this.timer = undefined;
    const now = clock();
    while (this.turn.length && this.freeAt <= now + 1) {
      const key = this.turn.shift()!;
      const q = this.queues.get(key)!;
      const { flow, piece, req } = q.shift()!;
      if (q.length) this.turn.push(key);
      else this.queues.delete(key);
      this.freeAt += piece.length / this.rate;
      const at = this.freeAt + this.delay;
      setTimeout(() => flow.land(piece, at, req), Math.max(0, at - now));
    }
    if (this.turn.length) this.timer = setTimeout(() => this.pump(), Math.max(0, this.freeAt - now));
  }
}

/** Where one direction of a connection lands: a socket, written as fast as it drains. */
class Flow {
  private pending: Uint8Array[] = [];
  private ending = false;
  sock: { write(b: Uint8Array): number; end(): void } | null = null;
  constructor(public id: number) {}
  land(piece: Uint8Array, at: number, req?: Req) {
    if (!piece.length) return this.end();
    if (req) {
      req.bytes += piece.length;
      req.first ||= at;
      req.last = at;
      req.arrivals.push([at, piece.length]);
    }
    this.pending.push(piece);
    this.flush();
  }
  flush() {
    if (!this.sock) return;
    while (this.pending.length) {
      const b = this.pending[0];
      const n = this.sock.write(b);
      if (n < b.length) {
        this.pending[0] = b.subarray(Math.max(0, n));
        return;
      }
      this.pending.shift();
    }
    if (this.ending) this.sock.end();
  }
  end() {
    this.ending = true;
    this.flush();
  }
}

interface Conn {
  id: number;
  up: Flow;
  down: Flow;
  /** Bytes the browser sent before the handshake's round trip was over. */
  early: Uint8Array[] | null;
  head: string;
  bodyLeft: number;
  socket: boolean;
  req?: Req;
}

/**
 * Starts the link in front of `target` on a free port of its own. rtt in ms; down and up in bits per second.
 */
export async function slowLink(o: { target: number; rtt: number; down: number; up: number; queue?: 'fair' | 'fifo' }): Promise<SlowLink> {
  const fair = (o.queue ?? 'fair') === 'fair';
  const downPipe = new Pipe(o.down / 8 / 1000, o.rtt / 2, fair);
  const upPipe = new Pipe(o.up / 8 / 1000, o.rtt / 2, fair);
  const reqs: Req[] = [];
  let ids = 0;
  /** The browser's bytes as they go up: each request's head read, so the hub's answer can be put to it. */
  const read = (c: Conn, b: Uint8Array) => {
    let i = 0;
    while (i < b.length && !c.socket) {
      if (c.bodyLeft > 0) {
        const n = Math.min(c.bodyLeft, b.length - i);
        c.bodyLeft -= n;
        i += n;
        continue;
      }
      const end = indexOfCrlf2(b, i, c.head);
      const take = end < 0 ? b.length : end;
      c.head += Buffer.from(b.subarray(i, take)).toString('latin1');
      i = take;
      if (end < 0) break;
      const [line, ...hs] = c.head.split('\r\n');
      c.head = '';
      const headers = new Map(hs.filter(Boolean).map((h) => [h.slice(0, h.indexOf(':')).trim().toLowerCase(), h.slice(h.indexOf(':') + 1).trim()]));
      const [method, path] = line.split(' ');
      const upgrade = headers.get('upgrade')?.toLowerCase() === 'websocket';
      const dest = headers.get('sec-fetch-dest') ?? '';
      c.req = { method, path, dest, kind: kindOf(method, path, dest, upgrade), at: clock(), first: 0, last: 0, bytes: 0, arrivals: [] };
      reqs.push(c.req);
      c.bodyLeft = Number(headers.get('content-length') ?? 0);
      c.socket = upgrade;
    }
  };
  const server = Bun.listen<Conn>({
    hostname: '127.0.0.1',
    port: 0,
    socket: {
      open(browser) {
        const c: Conn = { id: ++ids, up: new Flow(ids), down: new Flow(ids), early: [], head: '', bodyLeft: 0, socket: false };
        browser.data = c;
        c.down.sock = browser;
        // The handshake: nothing the browser sends leaves before a round trip.
        setTimeout(() => {
          const early = c.early!;
          c.early = null;
          for (const b of early) upPipe.push(c.up, b);
        }, o.rtt);
        void Bun.connect<Conn>({
          hostname: '127.0.0.1',
          port: o.target,
          data: c,
          socket: {
            open(hub) {
              c.up.sock = hub;
              c.up.flush();
            },
            data(_hub, b) {
              downPipe.push(c.down, new Uint8Array(b), c.req);
            },
            drain: () => c.up.flush(),
            // Closed by the hub: the browser hears it after the last byte before it.
            close: () => downPipe.push(c.down, new Uint8Array(0)),
            connectError: () => c.down.end(),
          },
        }).catch(() => c.down.end());
      },
      data(browser, b) {
        const c = browser.data;
        const copy = new Uint8Array(b);
        read(c, copy);
        if (c.early) c.early.push(copy);
        else upPipe.push(c.up, copy);
      },
      drain: (browser) => browser.data.down.flush(),
      close(browser) {
        const c = browser.data;
        if (c.early) c.early.push(new Uint8Array(0));
        else upPipe.push(c.up, new Uint8Array(0));
      },
    },
  });
  return {
    port: server.port,
    reqs,
    close: () => server.stop(true),
  };
}

/** Where a request's head ends (just past its blank line), counting what came before in `head`; -1 if not yet. */
function indexOfCrlf2(b: Uint8Array, from: number, head: string): number {
  // The blank line may straddle two reads.
  const tail = head.slice(-3);
  for (let i = from; i < b.length; i++) {
    if (b[i] !== 10) continue;
    const before = (k: number) => (i - k >= from ? b[i - k] : tail.charCodeAt(tail.length - (k - (i - from))));
    if (before(1) === 13 && before(2) === 10 && before(3) === 13) return i + 1;
  }
  return -1;
}
