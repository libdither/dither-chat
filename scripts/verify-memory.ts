/**
 * Memory and leaks (docs/perf.md, "Memory"): against a demo hub of its own on the perf world at a tenth of its size, in
 * headless Chromium, the same round of clicks again and again, and what the page holds counted after each round with
 * the garbage collected first. A round opens each of a few conversations (the biggest channel, a DM, a group, a thread,
 * others), draws older messages at the top of the biggest, opens and closes the details panel, goes to a person's page,
 * a profile, Settings, Mail and Feed, and comes back to where it started. Then a phone's round of the same, smaller.
 *
 * What is judged is growth between the round after the warm-up (`--first`, 2) and the last (`--cycles`), never a size:
 * DOM elements on the page, DOM nodes alive (detached ones too), event listeners, intervals running, object URLs not
 * revoked, open sockets, observers still observing, and the app's own caches (perf.ts `sized`: timelines, messages
 * held, kept pages). Each may grow by its allowance (GATES) and by what scripts/memory-known.json lists, with a reason.
 * The JS heap and the hub's resident memory are printed, per round, and go in the job's summary.
 *
 *   bun scripts/verify-memory.ts                         # what CI runs: builds the app, seeds a world, starts a hub
 *   bun scripts/verify-memory.ts --cycles 50 --cpu 4 --scale 1 --phone-cycles 0   # the long local run
 *   bun scripts/verify-memory.ts --web <dist> --out <file.json> --keep --verbose
 *   bun scripts/verify-memory.ts --snapshots <dir>       # heap snapshots after round 2 and the last, to compare
 *
 * Nothing is sent, deleted or changed on the hub: the app's visits (POST /api/usage) are answered in the page, as
 * verify-response.ts does, so the hub's rankings stay where they were and every round meets the same world.
 */
import { appendFileSync, existsSync, mkdtempSync, openSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { launch, type Page } from './browser.ts';
import { seedWorld } from './perf-world.ts';

const argv = process.argv.slice(2);
const opt = (name: string, dflt: string) => {
  const i = argv.indexOf(`--${name}`);
  return i >= 0 && argv[i + 1] ? argv[i + 1] : dflt;
};
const root = join(import.meta.dir, '..');
/** Rounds at a desktop's size; the first `FIRST` are the warm-up, and growth is counted from there to the last. */
const CYCLES = Number(opt('cycles', '6'));
const FIRST = Number(opt('first', '2'));
/** Rounds at a phone's size, after the desktop's; 0 leaves the phone out. */
const PHONE_CYCLES = Number(opt('phone-cycles', '5'));
const CPU = Number(opt('cpu', '1'));
const SCALE = Number(opt('scale', '0.1'));
const OUT = opt('out', '');
const KEEP = argv.includes('--keep');
/** Each step's time, to see where a round goes. */
const VERBOSE = argv.includes('--verbose');
/** A dir to write heap snapshots to, after round FIRST and the last, for DevTools' Comparison view. */
const SNAPSHOTS = opt('snapshots', '');
/** A pass's page, its name and when its last step ended. */
interface Ctx {
  p: Page;
  name: string;
  at: number;
}
const step = (c: Ctx, what: string) => {
  if (VERBOSE) console.log(`    ${c.name} ${String(Math.round(performance.now() - c.at)).padStart(5)} ms  ${what}`);
  c.at = performance.now();
};

/**
 * How much each count may grow from round FIRST to the last, at most, in all: what one round's noise can move it by.
 * A count that grows a little every round grows past it within a few. `heap` (bytes) is printed only.
 */
const GATES: Record<string, number> = {
  elements: 0,
  nodes: 0,
  listeners: 0,
  intervals: 0,
  objectUrls: 0,
  sockets: 0,
  observers: 0,
  marks: 0,
  'held.timelines': 0,
  'held.messagesHeld': 0,
  'held.quoted': 0,
  'held.keptPages': 0,
  'held.identities': 0,
  'held.readTimers': 0,
  'held.readClosedAt': 0,
  'held.glancing': 0,
  'held.outgoing': 0,
  'held.sendUploads': 0,
  'held.editDrafts': 0,
  'held.mailBodies': 0,
  'held.mailDetails': 0,
};
/** Growth known when the check began, by count, with why: judged on top of GATES. It should only shrink. */
const KNOWN_FILE = join(import.meta.dir, 'memory-known.json');
const known: Record<string, { growth: number; why: string }> = existsSync(KNOWN_FILE) ? JSON.parse(readFileSync(KNOWN_FILE, 'utf8')).known : {};

// ------------------------------------------------------------------ the app, the world, the hub

const work = mkdtempSync(join(tmpdir(), 'dither-memory-'));
const running: { hub?: ReturnType<typeof Bun.spawn> } = {};
process.on('exit', () => {
  running.hub?.kill();
  if (KEEP) console.log(`kept ${work}`);
  else rmSync(work, { recursive: true, force: true });
});
const t0 = performance.now();
const secs = () => ((performance.now() - t0) / 1000).toFixed(1);

let web = opt('web', '');
const build = web
  ? Promise.resolve()
  : (async () => {
      web = join(work, 'web');
      const b = Bun.spawn(['bunx', '--bun', 'vite', 'build', '--outDir', web, '--emptyOutDir'], { cwd: join(root, 'packages/web'), stdout: 'ignore', stderr: 'pipe' });
      const err = await new Response(b.stderr).text();
      if ((await b.exited) !== 0) throw new Error('web build failed:\n' + err);
    })();
build.catch(() => {});
const data = join(work, 'data');
const world = seedWorld(data, { scale: SCALE });
console.log(`seeded in ${(world.ms / 1000).toFixed(1)} s:`, JSON.stringify(world.counts));

// A port of its own: other checks and hubs run beside this one.
const l = Bun.listen({ hostname: '127.0.0.1', port: 0, socket: { data() {} } });
const PORT = l.port;
l.stop(true);
const base = `http://127.0.0.1:${PORT}`;
const getJson = async (path: string) => {
  const r = await fetch(base + path);
  if (!r.ok) throw new Error(`${path}: ${r.status}`);
  return r.json() as Promise<any>;
};
async function until(fn: () => Promise<boolean>, ms: number, what: string) {
  const end = Date.now() + ms;
  while (!(await fn().catch(() => false))) {
    if (Date.now() > end) throw new Error(what);
    await Bun.sleep(200);
  }
}
await build;
const log = openSync(join(work, 'hub.log'), 'a');
running.hub = Bun.spawn(['bun', join(root, 'packages/hub/src/main.ts'), '--demo', '--data', data, '--port', String(PORT), '--host', '127.0.0.1', '--web', web], {
  env: { ...process.env, DITHER_DEMO_CHATTER: '0', DITHER_CALENDAR_URL: 'off' },
  stdout: log,
  stderr: log,
});
await until(async () => (await fetch(`${base}/api/health`)).ok, 30_000, 'the hub did not start');
await until(async () => (await getJson('/api/bootstrap')).accounts.every((a: any) => a.status === 'online'), 30_000, 'demo accounts not online');
// The demo world settles for a few seconds after its accounts come online: until its journal stands still.
{
  let seq = -1;
  let still = Date.now();
  while (Date.now() - still < 3000) {
    await Bun.sleep(500);
    const now = (await getJson('/api/bootstrap')).sync?.seq ?? 0;
    if (now !== seq) (seq = now), (still = Date.now());
  }
}
const boot = await getJson('/api/bootstrap');
if (!boot.accounts.every((a: any) => a.demo)) throw new Error('not a demo hub');
console.log(`hub up on a port of its own at ${secs()} s`);

/** The hub's resident memory, from /proc (MB): it has no endpoint for its heap. Printed only. */
function hubMemory() {
  const pid = running.hub?.pid;
  const s = pid ? (() => {
    try {
      return readFileSync(`/proc/${pid}/status`, 'utf8');
    } catch {
      return '';
    }
  })() : '';
  const kb = (k: string) => Number(s.match(new RegExp(`^${k}:\\s+(\\d+)`, 'm'))?.[1] ?? 0);
  return { rss: Math.round(kb('VmRSS') / 1024), peak: Math.round(kb('VmHWM') / 1024) };
}

// ------------------------------------------------------------------ the rounds

const [bigChannel, otherChannel, bigDm, bigGroup, midChannel, smallDm] = world.open;
const thread = boot.conversations.filter((c: any) => c.shape === 'thread' && c.lastMessageAt).sort((a: any, b: any) => b.lastMessageAt - a.lastMessageAt)[0];
const dmConv = boot.conversations.find((c: any) => c.id === bigDm.id);
const person = dmConv?.peerPersonId ?? boot.persons.find((p: any) => p.id !== boot.selfPersonId)?.id;
if (!person) throw new Error('no person to open');
const convs: string[] = [bigChannel.id, bigDm.id, bigGroup.id, otherChannel.id, midChannel.id, smallDm.id, ...(thread ? [thread.id] : [])];
const START = '#/inbox';

/**
 * Before the app's scripts: what it keeps running, counted. Intervals set and not cleared, timeouts pending, object
 * URLs made and not revoked (with where each was made), sockets open, observers observing (held weakly, so one the
 * page let go of and the collector took counts no more). Requests and socket frames, for knowing when the page is still.
 * A visit the usage tracker counted is answered here, so the hub's rankings stay put round after round.
 */
const INIT = `(() => {
  const where = () => (new Error().stack || '').split('\\n').slice(3, 5).map((s) => s.trim().replace(/\\(?https?:\\/\\/[^/]+/, '(')).join(' < ');
  const M = (window.__mem = { intervals: new Map(), timeouts: new Set(), urls: new Map(), sockets: [], observers: [] });
  window.__net = { inflight: 0, done: 0, ws: 0, soon: 0 };
  const si = window.setInterval, st = window.setTimeout, ci = window.clearInterval, ct = window.clearTimeout;
  window.setInterval = function (fn, ms, ...a) {
    const id = si.call(this, fn, ms, ...a);
    M.intervals.set(id, (ms | 0) + 'ms ' + where());
    return id;
  };
  window.setTimeout = function (fn, ms, ...a) {
    const short = ms >= 100 && ms <= 3000 && typeof fn === 'function';
    const id = st.call(this, typeof fn === 'function' ? (...b) => { M.timeouts.delete(id); if (short) __net.soon--; fn(...b); } : fn, ms, ...a);
    M.timeouts.add(id);
    if (short) __net.soon++, M.timeouts.add('s' + id);
    return id;
  };
  const clear = (id) => {
    M.intervals.delete(id);
    if (M.timeouts.delete(id) && M.timeouts.delete('s' + id)) __net.soon--;
  };
  window.clearInterval = function (id) { clear(id); return ci.call(this, id); };
  window.clearTimeout = function (id) { clear(id); return ct.call(this, id); };
  const make = URL.createObjectURL, revoke = URL.revokeObjectURL;
  URL.createObjectURL = function (o) { const u = make.call(URL, o); M.urls.set(u, where()); return u; };
  URL.revokeObjectURL = function (u) { M.urls.delete(u); return revoke.call(URL, u); };
  const f = window.fetch;
  window.fetch = function (input, init) {
    const url = input instanceof Request ? input.url : String(input);
    if (init?.method === 'POST' && url.split('?')[0].endsWith('/api/usage')) return Promise.resolve(new Response('{"applied":0}', { headers: { 'content-type': 'application/json' } }));
    __net.inflight++;
    return f.apply(this, arguments).finally(() => { __net.inflight--; __net.done++; });
  };
  const W = window.WebSocket;
  window.WebSocket = class extends W {
    constructor(...a) {
      super(...a);
      M.sockets.push(new WeakRef(this));
      this.addEventListener('message', () => __net.ws++);
    }
  };
  for (const name of ['ResizeObserver', 'IntersectionObserver', 'MutationObserver']) {
    const O = window[name];
    if (!O) continue;
    const on = new WeakMap();
    const proto = O.prototype, observe = proto.observe, disconnect = proto.disconnect;
    proto.observe = function (...a) {
      if (!on.has(this)) { on.set(this, true); M.observers.push([name, new WeakRef(this), on, where()]); }
      on.set(this, true);
      return observe.apply(this, a);
    };
    proto.disconnect = function () { on.set(this, false); return disconnect.call(this); };
  }
})()`;

/** What the page holds now, as counted in it. */
const IN_PAGE = `(() => {
  const M = __mem;
  const observers = M.observers.filter(([, r, on]) => { const o = r.deref(); return o && on.get(o); });
  M.observers = M.observers.filter(([, r]) => r.deref());
  return {
    elements: document.getElementsByTagName('*').length,
    intervals: M.intervals.size,
    timeouts: [...M.timeouts].filter((x) => typeof x !== 'string').length,
    objectUrls: M.urls.size,
    sockets: M.sockets.filter((r) => { const s = r.deref(); return s && s.readyState <= 1; }).length,
    observers: observers.length,
    marks: performance.getEntriesByType('mark').length + performance.getEntriesByType('measure').length,
    held: window.__ditherPerf?.held?.() ?? {},
    where: { intervals: [...M.intervals.values()], objectUrls: [...M.urls.values()], observers: observers.map(([n, , , w]) => n + ' ' + w) },
  };
})()`;

type Sample = Record<string, number>;
interface Where {
  intervals: string[];
  objectUrls: string[];
  observers: string[];
}

/**
 * Until nothing has rendered, no request is out, no short timeout (100 ms to 3 s: a chat read 600 ms after it opens) is
 * pending and nothing came on the socket for `quiet` ms. Before a count, 700 ms; between steps less does.
 */
async function settle(p: Page, quiet = 300, ms = 15_000) {
  const sig = () => p.eval<string>(`JSON.stringify([window.__ditherPerf?.renders, window.__ditherPerf?.components?.updates, window.__net?.done, window.__net?.ws, window.__net?.inflight || window.__net?.soon ? Math.random() : 0])`);
  let last = await sig();
  let still = Date.now();
  const end = Date.now() + ms;
  while (Date.now() < end && Date.now() - still < quiet) {
    await Bun.sleep(50);
    const now = await sig();
    if (now !== last) (last = now), (still = Date.now());
  }
  if (Date.now() - still < quiet) console.warn(`  the page was never still for ${quiet} ms in ${ms / 1000} s`);
}

/** The garbage collected (twice: what the first frees can let more go), then everything counted. */
async function sample(p: Page): Promise<{ s: Sample; where: Where }> {
  await settle(p, 700);
  await p.send('HeapProfiler.collectGarbage');
  await Bun.sleep(50);
  await p.send('HeapProfiler.collectGarbage');
  const r = await p.send<{ metrics: { name: string; value: number }[] }>('Performance.getMetrics');
  const m = Object.fromEntries(r.metrics.map((x) => [x.name, x.value]));
  const dom = await p.send<{ documents: number; nodes: number; jsEventListeners: number }>('Memory.getDOMCounters');
  const detached = await p
    .send<{ detachedNodes: unknown[] }>('DOM.getDetachedDomNodes')
    .then((x) => x.detachedNodes.length)
    .catch(() => -1);
  const x = await p.eval<any>(IN_PAGE);
  const held = Object.fromEntries(Object.entries(x.held as Record<string, number>).map(([k, v]) => [`held.${k}`, v]));
  return {
    s: {
      heap: Math.round(m.JSHeapUsedSize),
      nodes: dom.nodes,
      detached,
      listeners: dom.jsEventListeners,
      documents: dom.documents,
      elements: x.elements,
      intervals: x.intervals,
      timeouts: x.timeouts,
      objectUrls: x.objectUrls,
      sockets: x.sockets,
      observers: x.observers,
      marks: x.marks,
      ...held,
    },
    where: x.where,
  };
}

/** The page's heap, written to `file` (DevTools' Memory tab opens it). */
const snapshotChunks = new WeakMap<Page, string[]>();
async function heapSnapshot(p: Page, file: string) {
  let chunks = snapshotChunks.get(p);
  if (!chunks) {
    const mine: string[] = (chunks = []);
    snapshotChunks.set(p, mine);
    p.on('HeapProfiler.addHeapSnapshotChunk', (x) => mine.push(x.chunk));
    await p.send('HeapProfiler.enable');
  }
  await p.send('HeapProfiler.takeHeapSnapshot', { reportProgress: false });
  writeFileSync(file, chunks.join(''));
  chunks.length = 0;
  console.log(`  wrote ${file}`);
}

/** Switch to a conversation by its address and wait for its `dither:timeline` mark. */
async function openConv(c: Ctx, id: string) {
  const p = c.p;
  await p.eval(`(async () => {
    const key = 'c:${id}';
    const t0 = performance.now();
    const seen = new Promise((res, rej) => {
      const o = new PerformanceObserver((l) => { for (const e of l.getEntries()) if (e.name === 'dither:timeline' && e.detail?.key === key && e.startTime >= t0) { o.disconnect(); res(0); } });
      o.observe({ type: 'mark' });
      setTimeout(() => (o.disconnect(), rej(new Error('no dither:timeline mark for ' + key))), 30000);
    });
    location.hash = '#/inbox/c/${id}';
    return seen;
  })()`);
  await settle(p);
  step(c, `open ${id.slice(0, 12)}`);
}

/** Up to the top of what is drawn, until more is drawn above (from memory, or an older page from the hub). */
async function older(c: Ctx) {
  const p = c.p;
  await p.eval(`(async () => {
    const el = document.querySelector('.timeline-scroll');
    const n0 = el.querySelectorAll('.msg').length;
    const t0 = performance.now();
    el.scrollTop = -el.scrollHeight;
    el.dispatchEvent(new Event('scroll'));
    while (el.querySelectorAll('.msg').length <= n0) {
      if (performance.now() - t0 > 30000) throw new Error('nothing more drawn at the top');
      await new Promise((r) => requestAnimationFrame(r));
    }
  })()`);
  await settle(p);
  step(c, 'older');
}

async function go(c: Ctx, hash: string, ready: string) {
  const p = c.p;
  await p.eval(`location.hash = ${JSON.stringify(hash)}; 0`);
  await p.until(ready, 15_000).catch(() => {
    throw new Error(`${hash}: no ${ready}`);
  });
  await settle(p);
  step(c, hash.slice(0, 20));
}

/** Click a control by its selector, with a real mouse. */
async function click(c: Ctx, sel: string) {
  const p = c.p;
  const at = await p.eval<{ x: number; y: number } | null>(`(() => { const e = document.querySelector(${JSON.stringify(sel)}); if (!e) return null; const r = e.getBoundingClientRect(); return { x: r.x + r.width / 2, y: r.y + r.height / 2 }; })()`);
  if (!at) throw new Error(`no ${sel}`);
  await p.send('Input.dispatchMouseEvent', { type: 'mouseMoved', ...at });
  await p.send('Input.dispatchMouseEvent', { type: 'mousePressed', ...at, button: 'left', buttons: 1, clickCount: 1 });
  await p.send('Input.dispatchMouseEvent', { type: 'mouseReleased', ...at, button: 'left', buttons: 0, clickCount: 1 });
  await p.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: 640, y: 3 });
  await settle(p);
  step(c, `click ${sel}`);
}

/** One round: every place and back to START. `warm`: the first, which loads older pages from the hub once. */
async function round(c: Ctx, phone: boolean, warm: boolean) {
  const p = c.p;
  c.at = performance.now();
  for (const id of convs) await openConv(c, id);
  // The biggest channel: older messages drawn at the top. The first round loads three pages from the hub, so that every
  // later round's draws from memory: each page from the hub stays held for as long as the page is open (by design),
  // and a round that loaded one more each time would grow by a page whatever else it did.
  await openConv(c, bigChannel.id);
  for (let i = 0; i < (warm ? 3 : 1); i++) await older(c);
  if (!phone) {
    await click(c, '.hdr-btn[data-track="details"]');
    await p.until(`document.querySelector('.app.with-details') !== null`, 5000);
    await click(c, '.hdr-btn[data-track="details"]');
    await p.until(`document.querySelector('.app.with-details') === null`, 5000);
  }
  await go(c, `#/people/${person}`, `location.hash.startsWith('#/people/')`);
  await go(c, `#/p/${person}`, `location.hash.startsWith('#/p/')`);
  await go(c, '#/settings', `location.hash === '#/settings'`);
  await go(c, '#/inbox?mail=v%3Aupdates%3A*', `location.hash.includes('mail=')`);
  await go(c, '#/feed', `location.hash === '#/feed'`);
  // Back, as the browser's button does, then to where the round began.
  await p.eval('history.back(); 0');
  await settle(p);
  await go(c, START, `location.hash === ${JSON.stringify(START)}`);
}

interface Pass {
  name: string;
  samples: Sample[];
  where: Where[];
  hub: { rss: number; peak: number }[];
  ms: number[];
}

async function pass(name: string, cycles: number, phone: boolean): Promise<Pass> {
  const b = await launch();
  const p = b.page;
  const out: Pass = { name, samples: [], where: [], hub: [], ms: [] };
  const ctx: Ctx = { p, name, at: 0 };
  try {
    if (phone) await p.size(390, 844, true);
    else await p.size(1280, 800, false);
    await p.send('Emulation.setTimezoneOverride', { timezoneId: 'UTC' });
    await p.send('Performance.enable');
    await p.send('DOM.enable').catch(() => {});
    if (CPU > 1) await p.send('Emulation.setCPUThrottlingRate', { rate: CPU });
    await p.send('Page.addScriptToEvaluateOnNewDocument', { source: INIT });
    await p.goto(`${base}/?perf=1&ahead=0${START}`);
    await p.until(`!!window.__ditherPerf && performance.getEntriesByName('dither:fresh').length > 0 && !!document.querySelector('.pane, .sidebar')`, 30_000);
    await settle(p);
    for (let i = 1; i <= cycles; i++) {
      const c0 = performance.now();
      await round(ctx, phone, i === 1);
      const { s, where } = await sample(p);
      if (SNAPSHOTS && (i === FIRST || i === cycles)) await heapSnapshot(p, join(SNAPSHOTS, `${name}-${i}.heapsnapshot`));
      out.ms.push(Math.round(performance.now() - c0));
      out.samples.push(s);
      out.where.push(where);
      out.hub.push(hubMemory());
      console.log(
        `${name} round ${String(i).padStart(2)}: heap ${(s.heap / 1e6).toFixed(1)} MB, ${s.elements} elements, ${s.nodes} nodes (${s.detached} detached), ${s.listeners} listeners, ${s.intervals} intervals, ${s.timeouts} timeouts, ${s.objectUrls} object URLs, ${s.sockets} sockets, ${s.observers} observers; ${s['held.timelines']} timelines holding ${s['held.messagesHeld']} messages; hub ${out.hub.at(-1)!.rss} MB (${((performance.now() - c0) / 1000).toFixed(1)} s)`,
      );
    }
    if (p.errors.length) console.warn('page errors:', p.errors.slice(0, 5));
  } finally {
    await b.close();
  }
  return out;
}

// ------------------------------------------------------------------ run and judge

const hubBefore = hubMemory();
const passes: Pass[] = [];
let failed = 0;
try {
  // Side by side, in two browsers on the one hub: they only read from it, and what is judged is counts, not times.
  passes.push(...(await Promise.all([pass('desktop', CYCLES, false), ...(PHONE_CYCLES > 0 ? [pass('phone', PHONE_CYCLES, true)] : [])])));
} catch (e) {
  failed++;
  console.log(`FAIL the rounds did not run: ${(e as Error).stack ?? e}`);
  console.log(readFileSync(join(work, 'hub.log'), 'utf8').split('\n').slice(-15).join('\n'));
}
const hubAfter = hubMemory();

const rows: { pass: string; k: string; first: number; last: number; growth: number; perRound: string; allowed: number | null; verdict: string }[] = [];
for (const ps of passes) {
  const n = ps.samples.length;
  if (n <= FIRST) {
    console.log(`${ps.name}: only ${n} rounds, none after round ${FIRST} to judge`);
    continue;
  }
  const a = ps.samples[FIRST - 1];
  const z = ps.samples[n - 1];
  console.log(`\n${ps.name}: round ${FIRST} to round ${n} (${n - FIRST} rounds; a round takes about ${(ps.ms.slice(FIRST).reduce((s, x) => s + x, 0) / (n - FIRST) / 1000).toFixed(1)} s)`);
  console.log(`${'count'.padEnd(22)} ${'round ' + FIRST}`.padEnd(32) + `${'round ' + n}`.padStart(10) + '  growth   per round');
  for (const k of Object.keys(z)) {
    const growth = z[k] - (a[k] ?? 0);
    const perRound = k === 'heap' ? `${((growth / (n - FIRST)) / 1024).toFixed(1)} KB` : (growth / (n - FIRST)).toFixed(2);
    const gate = GATES[k];
    const allowed = gate === undefined ? null : gate + (known[`${ps.name} ${k}`]?.growth ?? 0);
    const over = allowed !== null && growth > allowed;
    if (over) failed++;
    const verdict = over ? 'FAIL' : allowed === null ? 'printed' : 'ok';
    rows.push({ pass: ps.name, k, first: a[k] ?? 0, last: z[k], growth, perRound, allowed, verdict });
    const show = (v: number) => (k === 'heap' ? `${(v / 1e6).toFixed(2)} MB` : String(v));
    console.log(`${over ? 'FAIL ' : '     '}${k.padEnd(22)} ${show(a[k] ?? 0).padStart(10)} ${show(z[k]).padStart(10)}  ${(k === 'heap' ? `${(growth / 1e6).toFixed(2)} MB` : `${growth >= 0 ? '+' : ''}${growth}`).padStart(8)}  ${perRound}${allowed !== null && allowed > 0 ? `  (may grow ${allowed}${known[`${ps.name} ${k}`] ? `: ${known[`${ps.name} ${k}`].why}` : ''})` : ''}`);
    if (over) {
      // Where what grew was made, for the counts the page can say that of.
      const w = (ps.where.at(-1) as any)?.[k] as string[] | undefined;
      const w0 = new Set((ps.where[FIRST - 1] as any)?.[k] ?? []);
      if (w) for (const x of w.filter((x) => !w0.has(x)).slice(0, 5)) console.log(`        new: ${x}`);
    }
  }
  console.log(`  heap by round (MB): ${ps.samples.map((s) => (s.heap / 1e6).toFixed(1)).join(' ')}`);
  console.log(`  nodes by round: ${ps.samples.map((s) => s.nodes).join(' ')}`);
  console.log(`  listeners by round: ${ps.samples.map((s) => s.listeners).join(' ')}`);
}
console.log(`\nhub: ${hubBefore.rss} MB resident before the rounds, ${hubAfter.rss} MB after (peak ${hubAfter.peak} MB); printed only`);
console.log(`${failed ? `${failed} grew past what they may` : 'nothing grew past what it may'} in ${secs()} s`);

if (OUT) writeFileSync(OUT, JSON.stringify({ world: world.counts, cycles: CYCLES, first: FIRST, cpu: CPU, scale: SCALE, hub: { before: hubBefore, after: hubAfter }, passes }, null, 1));
if (process.env.GITHUB_STEP_SUMMARY) {
  const line = (r: (typeof rows)[number]) =>
    `| ${r.verdict === 'FAIL' ? '**FAIL**' : r.verdict} | ${r.pass} | \`${r.k}\` | ${r.k === 'heap' ? (r.first / 1e6).toFixed(2) + ' MB' : r.first} | ${r.k === 'heap' ? (r.last / 1e6).toFixed(2) + ' MB' : r.last} | ${r.k === 'heap' ? (r.growth / 1e6).toFixed(2) + ' MB' : r.growth} | ${r.perRound} | ${r.allowed ?? ''} |`;
  appendFileSync(
    process.env.GITHUB_STEP_SUMMARY,
    [
      `### Memory (verify-memory): ${failed ? `${failed} grew past what they may` : 'nothing grew'}`,
      '',
      `Rounds ${FIRST} to the last, the garbage collected before each count. Hub: ${hubBefore.rss} MB resident before, ${hubAfter.rss} MB after.`,
      '',
      '| | pass | count | first | last | growth | per round | may grow |',
      '|---|---|---|---|---|---|---|---|',
      ...rows.map(line),
      '',
    ].join('\n') + '\n',
  );
}
process.exit(failed ? 1 : 0);
