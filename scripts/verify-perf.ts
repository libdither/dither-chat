/**
 * Load and chat-switch performance against a demo hub of its own, grown to the live hub's size (docs/perf.md).
 *
 *   bun scripts/verify-perf.ts [--port 8620] [--runs 3] [--cpu 1,4] [--pages 15] [--web <built dist>]
 *                              [--update] [--out results.json] [--baseline scripts/perf-baseline.json] [--css <css>]
 *                              [--work <empty dir>] [--keep]
 *
 * Builds the web app (unless --web names a build), seeds a fresh world (scripts/perf-world.ts) in a temp dir, starts
 * a hub on it, and measures in headless Chromium at each CPU throttle, `runs` times each:
 *
 *   cold load to the list; first open of six conversations, reopening them, `pages` older pages in the biggest, the
 *   long timeline reopened, a message arriving while it is open; then a relaunch from the device's snapshot and the
 *   same six opened again. Times, long tasks, and counts: App renders, LayoutCount, DOM nodes, .msg elements.
 *
 * Medians go against the baseline: a count over its baseline fails (bytes get 1%), a time over baseline × 1.25 +
 * 50 ms fails. --update writes the medians as the new baseline. It runs locally: CI has no browser.
 */
import { existsSync, mkdirSync, mkdtempSync, openSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { launch, type Page } from './browser.ts';
import { seedWorld, type World, type WorldConv } from './perf-world.ts';

const args = process.argv.slice(2);
const opt = (k: string, d: string) => (args.includes(`--${k}`) ? args[args.indexOf(`--${k}`) + 1] : d);
const PORT = Number(opt('port', '8620'));
const RUNS = Number(opt('runs', '3'));
const CPUS = opt('cpu', '1,4').split(',').map(Number);
const PAGES = Number(opt('pages', '15'));
const UPDATE = args.includes('--update');
const OUT = opt('out', '');
/** Extra CSS for every page, to try a style change without a build (e.g. content-visibility on desktop). */
const CSS = opt('css', '');
const root = resolve(import.meta.dir, '..');
const BASELINE = resolve(opt('baseline', join(root, 'scripts/perf-baseline.json')));
const base = `http://127.0.0.1:${PORT}`;

/** count: the page's structure (nodes, messages), exact. tally: renders and layouts, which a frame boundary can move by one or two. */
type Kind = 'ms' | 'count' | 'tally' | 'bytes';
type Metrics = Record<string, { v: number; kind: Kind }>;
// The world, the build and the hub's log. Its own prefix: a cleanup of someone else's temp dirs must not take it.
const work = args.includes('--work') ? opt('work', '') : mkdtempSync(join(tmpdir(), `dither-verify-perf-${PORT}-`));
const running: { hub?: ReturnType<typeof Bun.spawn> } = {};

async function main() {
  mkdirSync(work, { recursive: true });
  // ------------------------------------------------------------------ the app, the world, the hub
  let web = opt('web', '');
  if (!web) {
    web = join(work, 'web');
    console.log('building the web app…');
    const b = Bun.spawnSync(['bunx', '--bun', 'vite', 'build', '--outDir', web, '--emptyOutDir'], { cwd: join(root, 'packages/web'), stdout: 'pipe', stderr: 'pipe' });
    if (b.exitCode !== 0) throw new Error('web build failed:\n' + b.stderr.toString());
  }
  const data = join(work, 'data');
  const world = seedWorld(data);
  console.log(`seeded in ${(world.ms / 1000).toFixed(1)} s:`, JSON.stringify(world.counts));
  if ((await fetch(`${base}/api/health`).catch(() => null))?.ok) throw new Error(`something is already listening on ${PORT}`);
  const log = openSync(join(work, 'hub.log'), 'a');
  running.hub = Bun.spawn(['bun', join(root, 'packages/hub/src/main.ts'), '--demo', '--data', data, '--port', String(PORT), '--host', '127.0.0.1', '--web', web], {
    env: { ...process.env, DITHER_DEMO_CHATTER: '0' },
    stdout: log,
    stderr: log,
  });
  await until(async () => (await fetch(`${base}/api/health`).catch(() => null))?.ok ?? false, 30_000, 'the hub did not start');
  // The demo accounts bring their own world in once they are up.
  await until(async () => (await getJson('/api/bootstrap')).accounts.every((a: any) => a.status === 'online'), 30_000, 'demo accounts not online');
  // Then until its journal stands still: a first run that meets the demo world still settling counts its renders.
  let seq = -1;
  let still = Date.now();
  while (Date.now() - still < 5000) {
    await Bun.sleep(1000);
    const now = (await getJson('/api/bootstrap')).sync?.seq ?? 0;
    if (now !== seq) (seq = now), (still = Date.now());
  }
  const boot = await getJson('/api/bootstrap');
  if (!boot.accounts.every((a: any) => a.demo)) throw new Error('not a demo hub');

  const metrics: Metrics = {};
  const put = (k: string, v: number, kind: Kind) => (metrics[k] = { v: Math.round(v), kind });
  // ------------------------------------------------------------------ the hub's side
  put('hub.bootstrap.bytes', (await (await fetch(`${base}/api/bootstrap`)).arrayBuffer()).byteLength, 'bytes');
  put('hub.bootstrap.ms', await timed('/api/bootstrap'), 'ms');
  put('hub.inbox.ms', await timed('/api/inbox'), 'ms');

  // ------------------------------------------------------------------ the browser's
  const runs: Record<number, Metrics[]> = {};
  for (const cpu of CPUS) {
    runs[cpu] = [];
    for (let i = 0; i < RUNS; i++) {
      // A run that fails (a timeout on a busy machine) is tried once more; its error and the hub's log are shown.
      const m = await run(cpu, world).catch((e) => {
        console.warn(`${cpu}× run ${i + 1} failed, trying again: ${e.message}\n${readFileSync(join(work, 'hub.log'), 'utf8').split('\n').slice(-15).join('\n')}`);
        return run(cpu, world);
      });
      runs[cpu].push(m);
      console.log(`${cpu}× run ${i + 1}: cold ${m['cold.list'].v} ms, first open ${m['open.first'].v} ms, reopen ${m['open.again'].v} ms, older page ${m['older.page'].v} ms, long reopen ${m['long.reopen'].v} ms, arrival ${m['arrival.busy'].v} ms busy, relaunch ${m['relaunch.list'].v} ms, open after ${m['relaunch.open'].v} ms`);
    }
    for (const k of Object.keys(runs[cpu][0])) {
      const xs = runs[cpu].map((r) => r[k]?.v).filter((x) => x !== undefined);
      metrics[`${cpu}x.${k}`] = { v: median(xs), kind: runs[cpu][0][k].kind };
    }
  }

  // ------------------------------------------------------------------ against the baseline
  if (OUT) writeFileSync(OUT, JSON.stringify({ world, metrics, runs }, null, 1));
  const old = existsSync(BASELINE) ? (JSON.parse(readFileSync(BASELINE, 'utf8')) as { metrics: Metrics }) : null;
  let failed = 0;
  console.log(`\n${'metric'.padEnd(34)} ${'baseline'.padStart(10)} ${'now'.padStart(10)}  change`);
  for (const [k, m] of Object.entries(metrics)) {
    const b = old?.metrics[k];
    const over = b && (m.kind === 'ms' ? m.v > b.v * 1.25 + 50 : m.kind === 'bytes' ? m.v > b.v * 1.01 : m.kind === 'tally' ? m.v > b.v + Math.max(2, b.v * 0.1) : m.v > b.v);
    if (over && !UPDATE) failed++;
    const change = b ? `${m.v >= b.v ? '+' : ''}${b.v ? Math.round(((m.v - b.v) / b.v) * 100) : 0}%` : 'new';
    console.log(`${(over ? 'FAIL ' : '     ') + k.padEnd(29)} ${String(b?.v ?? '').padStart(10)} ${String(m.v).padStart(10)}  ${change}${m.kind === 'ms' ? '' : ` (${m.kind})`}`);
  }
  if (UPDATE) {
    const chromium = Bun.spawnSync(['chromium', '--version']).stdout.toString().trim();
    writeFileSync(BASELINE, JSON.stringify({ note: 'bun scripts/verify-perf.ts --update (docs/perf.md). Times are of the machine it ran on.', at: new Date().toISOString().slice(0, 10), runs: RUNS, pages: PAGES, chromium, world: world.counts, metrics }, null, 1) + '\n');
    console.log(`\nwrote ${BASELINE}`);
  } else if (!old) console.log('\nno baseline yet: run with --update');
  else console.log(failed ? `\n${failed} over the baseline` : '\nall within the baseline');
  return failed;
}

// ------------------------------------------------------------------ one run in a fresh browser

/** Long tasks, and when the list first showed rows; installed before the app's own scripts. */
const INIT = `(() => {
  window.__perf = { lt: [], list: null };
  try { new PerformanceObserver((l) => { for (const e of l.getEntries()) __perf.lt.push([e.startTime, e.duration]); }).observe({ type: 'longtask', buffered: true }); } catch (e) {}
  const mo = new MutationObserver(() => {
    if (__perf.list === null && document.querySelector('.side-scroll .conv-row')) {
      mo.disconnect();
      requestAnimationFrame(() => setTimeout(() => (__perf.list = performance.now())));
    }
  });
  mo.observe(document, { subtree: true, childList: true });
})()`;

async function run(cpu: number, world: World): Promise<Metrics> {
  const b = await launch();
  const page = b.page;
  const m: Metrics = {};
  const put = (k: string, v: number, kind: Kind = 'ms') => (m[k] = { v: Math.round(v), kind });
  try {
    await page.size(1280, 800);
    await page.send('Performance.enable');
    if (cpu > 1) await page.send('Emulation.setCPUThrottlingRate', { rate: cpu });
    await page.send('Page.addScriptToEvaluateOnNewDocument', { source: INIT });
    if (CSS) await page.send('Page.addScriptToEvaluateOnNewDocument', { source: `document.addEventListener('DOMContentLoaded', () => document.head.append(Object.assign(document.createElement('style'), { textContent: ${JSON.stringify(CSS)} })))` });
    const lastIds = new Map<string, string>();
    for (const c of world.open) lastIds.set(c.id, (await getJson(`/api/conversations/${c.id}/messages?limit=1`)).messages.at(-1).id);

    // Cold: a device that has never seen this hub.
    await page.goto(`${base}/?perf=1#/inbox`);
    const cold = await loaded(page);
    put('cold.list', cold.list);
    put('cold.fresh', cold.fresh);
    put('cold.longest', cold.longest);
    put('cold.longTasks', cold.longTotal);
    put('cold.renders', cold.renders.App ?? 0, 'tally');
    put('cold.layouts', cold.layouts, 'tally');
    put('cold.nodes', cold.nodes, 'count');
    put('cold.bootstrapBytes', cold.bootstrapBytes, 'bytes');

    const pass = async (name: string) => {
      const xs = [];
      for (const c of world.open) xs.push(await open(page, c, lastIds.get(c.id)!));
      put(`${name}`, median(xs.map((x) => x.painted)));
      put(`${name}.max`, Math.max(...xs.map((x) => x.painted)));
      put(`${name}.longest`, Math.max(...xs.map((x) => x.longest)));
      put(`${name}.renders`, xs.reduce((s, x) => s + x.renders, 0), 'tally');
      put(`${name}.layouts`, xs.reduce((s, x) => s + x.layouts, 0), 'tally');
    };
    await pass('open.first');
    await pass('open.again');

    // A long timeline: older pages in the biggest conversation, then away and back, then a message arriving.
    const big = world.open[0];
    await open(page, big, lastIds.get(big.id)!);
    const pages = [];
    for (let i = 0; i < PAGES; i++) pages.push(await older(page));
    put('older.page', median(pages.map((p) => p.ms)));
    put('older.last', pages.at(-1)!.ms);
    put('older.msgs', pages.at(-1)!.msgs, 'count');
    put('older.viewMoves', pages.filter((p) => p.moved).length, 'count');
    await open(page, world.open[1], lastIds.get(world.open[1].id)!);
    const back = await open(page, big, lastIds.get(big.id)!);
    put('long.reopen', back.painted);
    put('long.reopen.longest', back.longest);
    put('long.reopen.renders', back.renders, 'tally');
    put('long.reopen.layouts', back.layouts, 'tally');
    put('long.reopen.nodes', back.nodes, 'count');
    put('long.reopen.msgs', back.msgs, 'count');
    put('long.reopen.quotes', back.quotes, 'count');
    const a = await arrival(page, big);
    put('arrival.shown', a.shown);
    put('arrival.busy', a.busy);
    put('arrival.longest', a.longest);
    put('arrival.renders', a.renders.App ?? 0, 'tally');
    put('arrival.messageRenders', a.renders.MessageItem ?? 0, 'tally');
    put('arrival.layouts', a.layouts, 'tally');

    // Relaunch: the app opened again later, from the snapshot it kept.
    await until(async () => ((await page.eval<number | null>(SNAPSHOT_TIMELINES)) ?? 0) >= world.open.length, 20_000, 'the snapshot did not keep the timelines').catch((e) => console.warn(e.message));
    await page.goto(`${base}/api/health`);
    await Bun.sleep(1000);
    await page.goto(`${base}/?perf=1#/inbox`);
    const warm = await loaded(page);
    if (warm.source !== 'snapshot') console.warn(`relaunch loaded from the ${warm.source}, not the snapshot`);
    put('relaunch.list', warm.list);
    put('relaunch.fresh', warm.fresh);
    put('relaunch.longest', warm.longest);
    put('relaunch.renders', warm.renders.App ?? 0, 'tally');
    await pass('relaunch.open');
    if (page.errors.length) console.warn('page errors:', page.errors.slice(0, 5));
  } finally {
    await b.close();
  }
  return m;
}

async function metrics(page: Page) {
  const r = await page.send<{ metrics: { name: string; value: number }[] }>('Performance.getMetrics');
  return Object.fromEntries(r.metrics.map((x) => [x.name, x.value])) as Record<string, number>;
}
const renders = (page: Page) => page.eval<Record<string, number>>('({ ...window.__ditherPerf.renders })');
const diff = (a: Record<string, number>, b: Record<string, number>) => Object.fromEntries(Object.keys(b).map((k) => [k, b[k] - (a[k] ?? 0)]));

/** Until nothing has rendered for half a second (or five seconds have gone). */
async function settle(page: Page) {
  let last = JSON.stringify(await renders(page));
  let still = Date.now();
  const end = Date.now() + 5000;
  while (Date.now() < end && Date.now() - still < 500) {
    await Bun.sleep(100);
    const now = JSON.stringify(await renders(page));
    if (now !== last) (last = now), (still = Date.now());
  }
}

async function loaded(page: Page) {
  await page.until(`window.__perf?.list != null && !!window.__ditherPerf`, 30_000).catch(() => {
    throw new Error(`the list did not show; page errors: ${JSON.stringify(page.errors.slice(0, 5))}`);
  });
  await page.until(`performance.getEntriesByName('dither:fresh').length > 0`, 30_000).catch(() => {
    throw new Error(`nothing fresh from the hub; page errors: ${JSON.stringify(page.errors.slice(0, 5))}`);
  });
  await settle(page);
  const x = await page.eval<any>(`(() => {
    const fresh = performance.getEntriesByName('dither:fresh')[0];
    const content = performance.getEntriesByName('dither:content')[0];
    const boot = performance.getEntriesByType('resource').find((r) => new URL(r.name).pathname === '/api/bootstrap');
    const lts = __perf.lt.filter((t) => t[0] < fresh.startTime + 1000);
    return { list: __perf.list, fresh: fresh.startTime, source: content?.detail?.source, longest: Math.max(0, ...lts.map((t) => t[1])), longTotal: lts.reduce((s, t) => s + t[1], 0),
      nodes: document.getElementsByTagName('*').length, bootstrapBytes: boot ? boot.decodedBodySize : 0 };
  })()`);
  return { ...x, renders: await renders(page), layouts: (await metrics(page)).LayoutCount };
}

/** Switch to a conversation; timed to its `dither:timeline` mark, checked against the newest message on screen. */
async function open(page: Page, c: WorldConv, lastId: string) {
  const m0 = await metrics(page);
  const r0 = await renders(page);
  const lt0 = await page.eval<number>('__perf.lt.length');
  const painted = await page.eval<number>(`(async () => {
    const key = 'c:${c.id}';
    const t0 = performance.now();
    const seen = new Promise((res, rej) => {
      const o = new PerformanceObserver((l) => { for (const e of l.getEntries()) if (e.name === 'dither:timeline' && e.detail?.key === key && e.startTime >= t0) { o.disconnect(); res(e.startTime - t0); } });
      o.observe({ type: 'mark' });
      setTimeout(() => rej(new Error('no dither:timeline mark for ' + key)), 30000);
    });
    location.hash = '#/inbox/c/${c.id}';
    return seen;
  })()`);
  await settle(page);
  const shown = await page.eval<boolean>(`!!document.getElementById(${JSON.stringify(`m-${lastId}`)})`);
  if (!shown) throw new Error(`${c.id}: its newest message is not on screen after the mark`);
  const lts = await page.eval<[number, number][]>(`__perf.lt.slice(${lt0})`);
  const x = await page.eval<{ nodes: number; msgs: number; quotes: number }>(`({ nodes: document.getElementsByTagName('*').length, msgs: document.querySelectorAll('.timeline-scroll .msg').length, quotes: document.querySelectorAll('.timeline-scroll .reply-quote').length })`);
  return { painted, renders: diff(r0, await renders(page)).App ?? 0, layouts: (await metrics(page)).LayoutCount - m0.LayoutCount, longest: Math.max(0, ...lts.map((t) => t[1])), ...x };
}

/**
 * Scroll to the top of the open timeline and time the next older page onto the screen. `moved`: the message that was
 * first did not stay where it was (at the very top the browser keeps the view there, and pages load one after another).
 */
async function older(page: Page) {
  const r = await page.eval<{ ms: number; msgs: number }>(`(async () => {
    const el = document.querySelector('.timeline-scroll');
    const n0 = el.querySelectorAll('.msg').length;
    const t0 = performance.now();
    el.scrollTop = -el.scrollHeight;
    const first = el.querySelector('.msg');
    window.__first = { id: first.id, top: first.getBoundingClientRect().top };
    el.dispatchEvent(new Event('scroll'));
    while (el.querySelectorAll('.msg').length <= n0) {
      if (performance.now() - t0 > 30000) throw new Error('no older page');
      await new Promise((r) => requestAnimationFrame(r));
    }
    await new Promise((r) => requestAnimationFrame(() => setTimeout(r)));
    return { ms: performance.now() - t0, msgs: el.querySelectorAll('.msg').length };
  })()`);
  await settle(page);
  const moved = await page.eval<number | null>(`(() => {
    const first = document.getElementById(window.__first.id);
    return first ? Math.round(first.getBoundingClientRect().top - window.__first.top) : null;
  })()`);
  return { ...r, moved: moved === null || Math.abs(moved) > 2 };
}

/** A message from someone else arriving in the open conversation. */
async function arrival(page: Page, c: WorldConv) {
  await Bun.sleep(1000);
  const body = `perf arrival ${Date.now().toString(36)}`;
  const m0 = await metrics(page);
  const r0 = await renders(page);
  const lt0 = await page.eval<number>('__perf.lt.length');
  const waiting = page.eval<number>(`(async () => {
    const t0 = performance.now();
    const has = () => [...document.querySelectorAll('.timeline-scroll .msg-body')].slice(-3).some((e) => e.textContent.includes(${JSON.stringify(body)}));
    while (!has()) {
      if (performance.now() - t0 > 20000) throw new Error('the message did not arrive');
      await new Promise((r) => requestAnimationFrame(r));
    }
    return performance.now() - t0;
  })()`);
  const said = await fetch(`${base}/api/accounts/${c.accountId}/action`, { method: 'POST', headers: { 'content-type': 'application/json', origin: base }, body: JSON.stringify({ action: 'say', args: { conversation: c.nativeId, author: c.member, body } }) });
  if (!said.ok) throw new Error(`say: ${said.status}`);
  const shown = await waiting;
  await settle(page);
  const m1 = await metrics(page);
  const lts = await page.eval<[number, number][]>(`__perf.lt.slice(${lt0})`);
  return { shown, busy: (m1.TaskDuration - m0.TaskDuration) * 1000, layouts: m1.LayoutCount - m0.LayoutCount, longest: Math.max(0, ...lts.map((t) => t[1])), renders: diff(r0, await renders(page)) };
}

/** How many timelines the device's snapshot holds (snapshot.ts). */
const SNAPSHOT_TIMELINES = `new Promise((res) => {
  const r = indexedDB.open('dither-chat', 1);
  r.onupgradeneeded = () => r.result.createObjectStore('snapshot');
  r.onerror = () => res(null);
  r.onsuccess = () => {
    try {
      const g = r.result.transaction('snapshot').objectStore('snapshot').get('last');
      g.onsuccess = () => res(g.result ? JSON.parse(g.result.rest).timelines.length : null);
      g.onerror = () => res(null);
    } catch (e) { res(null); }
  };
})`;

// ------------------------------------------------------------------ helpers

async function getJson(path: string) {
  const r = await fetch(base + path);
  if (!r.ok) throw new Error(`${path}: ${r.status}`);
  return r.json() as Promise<any>;
}
/** The median of five requests, after one to warm up. */
async function timed(path: string) {
  await fetch(base + path).then((r) => r.arrayBuffer());
  const xs = [];
  for (let i = 0; i < 5; i++) {
    const t0 = performance.now();
    await fetch(base + path).then((r) => r.arrayBuffer());
    xs.push(performance.now() - t0);
  }
  return median(xs);
}
function median(xs: number[]) {
  const s = [...xs].sort((a, b) => a - b);
  return s.length % 2 ? s[(s.length - 1) / 2] : (s[s.length / 2 - 1] + s[s.length / 2]) / 2;
}
async function until(fn: () => Promise<boolean>, ms: number, what: string) {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (await fn().catch(() => false)) return;
    await Bun.sleep(200);
  }
  throw new Error(what);
}

let code = 1;
try {
  code = (await main()) ? 1 : 0;
} catch (e) {
  console.error(e);
} finally {
  running.hub?.kill();
  await running.hub?.exited;
  if (args.includes('--keep')) console.log(`kept ${work}`);
  else if (!args.includes('--work')) rmSync(work, { recursive: true, force: true });
}
process.exit(code);
