/**
 * What a reconnect costs, in bytes on the wire and time, for docs/sync.md. Two ways of coming back:
 *
 *   full:  what the app did on every reconnect before delta sync: /api/bootstrap, /api/inbox, the usage totals, and
 *          the first page of every open timeline again.
 *   delta: what it does now: one POST /api/sync from the position it had, with the ends of its open timelines.
 *
 *   bun scripts/measure-sync.ts http://127.0.0.1:8471 [--open 3] [--runs 5]
 *
 * Only sizes and times are printed, never what the hub answered. Against a demo hub or a copy of a real database
 * served by a hub of its own (docs/sync.md), never the live hub: it only reads, but there is no reason to load it.
 */
const args = process.argv.slice(2);
const base = args.find((a) => !a.startsWith('--') && /^https?:/.test(a));
if (!base) throw new Error('usage: bun scripts/measure-sync.ts <hub url> [--open N] [--runs N]');
const opt = (n: string, d: number) => {
  const i = args.indexOf(`--${n}`);
  return i >= 0 ? Number(args[i + 1]) : d;
};
const OPEN = opt('open', 3);
const RUNS = opt('runs', 5);
// What a current Firefox or Chromium sends.
const headers = { 'accept-encoding': 'gzip, deflate, br, zstd', origin: base };

interface Got {
  wire: number;
  raw: number;
  ms: number;
  text: string;
}

async function get(path: string, init: { method?: string; body?: unknown } = {}): Promise<Got> {
  const t0 = performance.now();
  const res = await fetch(base + path, {
    method: init.method ?? (init.body !== undefined ? 'POST' : 'GET'),
    body: init.body !== undefined ? JSON.stringify(init.body) : undefined,
    headers: { ...headers, ...(init.body !== undefined ? { 'content-type': 'application/json' } : {}) },
    decompress: false,
  } as RequestInit);
  const bytes = new Uint8Array(await res.arrayBuffer());
  const ms = performance.now() - t0;
  if (!res.ok) throw new Error(`${path}: ${res.status}`);
  const enc = res.headers.get('content-encoding');
  const plain = enc === 'zstd' ? Bun.zstdDecompressSync(bytes) : enc === 'gzip' ? Bun.gunzipSync(bytes) : bytes;
  return { wire: bytes.byteLength, raw: plain.byteLength, ms, text: new TextDecoder().decode(plain) };
}

const kb = (n: number) => (n < 10_240 ? `${(n / 1024).toFixed(1)} KB` : `${Math.round(n / 1024)} KB`);
const median = (xs: number[]) => [...xs].sort((a, b) => a - b)[Math.floor(xs.length / 2)];

const boot = JSON.parse((await get('/api/bootstrap')).text) as {
  conversations: { id: string; lastMessageAt: number | null }[];
  sync?: { epoch: string; seq: number; v: number };
};
// The conversations an app would most likely have open: the most recently active ones.
const openIds = boot.conversations
  .filter((c) => c.lastMessageAt)
  .sort((a, b) => b.lastMessageAt! - a.lastMessageAt!)
  .slice(0, OPEN)
  .map((c) => c.id);
const pages = new Map<string, { id: string; ts: number }[]>();
for (const id of openIds) pages.set(id, JSON.parse((await get(`/api/conversations/${id}/messages?limit=60`)).text).messages);

async function full() {
  const parts = [await get('/api/bootstrap'), await get('/api/inbox'), await get('/api/usage')];
  for (const id of openIds) parts.push(await get(`/api/conversations/${id}/messages?limit=60`));
  return parts;
}

// The position a client would hold: taken before the clock starts, as the client has it already.
let s = boot.sync!;
async function delta() {
  const timelines = openIds.map((id) => {
    const ms = pages.get(id)!;
    return { key: `c:${id}`, seq: s.seq, newest: ms.at(-1)?.ts ?? 0, oldest: ms[0]?.ts ?? 0 };
  });
  return [await get('/api/sync', { body: { v: s.v, epoch: s.epoch, since: s.seq, timelines } })];
}

async function measure(name: string, run: () => Promise<Got[]>) {
  const wire: number[] = [];
  const raw: number[] = [];
  const ms: number[] = [];
  for (let i = 0; i < RUNS; i++) {
    if (boot.sync) s = JSON.parse((await get('/api/bootstrap')).text).sync;
    const t0 = performance.now();
    const parts = await run();
    ms.push(performance.now() - t0);
    wire.push(parts.reduce((n, p) => n + p.wire, 0));
    raw.push(parts.reduce((n, p) => n + p.raw, 0));
  }
  console.log(`${name.padEnd(6)} ${kb(median(wire)).padStart(8)} on the wire, ${kb(median(raw)).padStart(8)} of JSON, ${median(ms).toFixed(0).padStart(5)} ms (median of ${RUNS}, ${OPEN} open timelines)`);
}

console.log(`${base}: ${boot.conversations.length} conversations`);
await measure('full', full);
if (boot.sync) await measure('delta', delta);
else console.log('delta  (this hub has no /api/sync)');

export {};
