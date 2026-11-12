/**
 * Load and chat-switch performance against a demo hub of its own, grown to the live hub's size (docs/perf.md).
 *
 *   bun scripts/verify-perf.ts [--port 8620] [--runs 3] [--cpu 1,4] [--pages 15] [--web <built dist>]
 *                              [--update] [--out results.json] [--baseline scripts/perf-baseline.json] [--css <css>]
 *                              [--work <empty dir>] [--keep] [--size 390x844] [--scale 1] [--phone-cpu 4] [--ci]
 *
 * Builds the web app (unless --web names a build), seeds a fresh world (scripts/perf-world.ts) in a temp dir, starts
 * a hub on it, and measures in headless Chromium at each CPU throttle, `runs` times each:
 *
 *   cold load to the list; first open of six conversations, reopening them, `pages` older pages in the biggest, the
 *   long timeline reopened, a message arriving while it is open; then a relaunch from the device's snapshot and the
 *   same six opened again. Times, long tasks, and counts: renders of App, the inbox list and messages, LayoutCount,
 *   DOM nodes, .msg elements. Then a phone's pass (`--phone-cpu`, 4× here and 1× in CI): flicking the lists, typing,
 *   the tabs, a person's page and Mail (phoneRun). Those passes fetch nothing ahead (?ahead=0); the phone's `ahead` pass
 *   measures fetching ahead (prefetch.ts) against the same steps without it (aheadRun).
 *
 * Medians go against the baseline: a count over its baseline fails (bytes get 1%), a time over baseline × 1.25 +
 * 50 ms fails. --update writes the medians as the new baseline.
 *
 * --ci: what CI runs. A world a tenth the size, a warm-up run and then one at 1×, five older pages, against
 * scripts/perf-baseline-ci.json. Only counts, renders, layouts and bytes are judged (a count may go 1% over: each run's
 * arriving message moves the long timeline's window by one), and of those only the ones the baseline marks as steady
 * (`gate`, from the spread of `--ci --update --runs 5`): after the warm-up they come out the same in every run, so one
 * is enough. Times are printed, never judged; with GITHUB_STEP_SUMMARY set they all go in the job's summary too. No
 * run is tried again.
 */
import { existsSync, mkdirSync, mkdtempSync, openSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { findBrowser, launch, type Page } from './browser.ts';
import { seedWorld, type World, type WorldConv } from './perf-world.ts';

const args = process.argv.slice(2);
const opt = (k: string, d: string) => (args.includes(`--${k}`) ? args[args.indexOf(`--${k}`) + 1] : d);
const CI = args.includes('--ci');
const PORT = Number(opt('port', '8620'));
/** Measured runs at each throttle; their medians are what counts. CI's are steady after the warm-up, so it takes one. */
const RUNS = Number(opt('runs', CI ? '1' : '3'));
/**
 * Runs first that are not counted. The first run on a fresh hub draws more than the rest, 1.4 times the message
 * renders and twice the layouts: it marks the six read and leaves the hub as later runs find it. So a warm-up is a
 * whole run at the real pace; a hurried one leaves that to the first counted run (docs/perf.md).
 */
const WARMUP = Number(opt('warmup', CI ? '1' : '0'));
const CPUS = opt('cpu', CI ? '1' : '1,4').split(',').map(Number).filter((x) => x > 0);
/** Throttles for the phone pass (phoneRun), after the desktop's; `--phone-cpu 0` leaves it out. */
const PHONE_CPUS = opt('phone-cpu', CI ? '1' : '4').split(',').map(Number).filter((x) => x > 0);
/** Throttles for fetching ahead (aheadRun), at a phone's size; `--ahead-cpu 0` leaves it out. */
const AHEAD_CPUS = opt('ahead-cpu', CI ? '1' : '4').split(',').map(Number).filter((x) => x > 0);
/** The round trip the ahead pass puts between page and hub, as a phone on the tailnet has (docs/android.md: 80 ms, 20/10 Mbit/s). */
const AHEAD_RTT = Number(opt('ahead-rtt', '80'));
const PAGES = Number(opt('pages', CI ? '5' : '15'));
/** The world's size against the live hub's (perf-world.ts). */
const SCALE = Number(opt('scale', CI ? '0.1' : '1'));
const UPDATE = args.includes('--update');
const OUT = opt('out', '');
/** Extra CSS for every page, to try a style change without a build (e.g. content-visibility on desktop). */
const CSS = opt('css', '');
/** The window, 1280x800 (a desktop); 390x844 measures a phone's layout. */
const [WIDTH, HEIGHT] = opt('size', '1280x800').split('x').map(Number);
const root = resolve(import.meta.dir, '..');
const BASELINE = resolve(opt('baseline', join(root, CI ? 'scripts/perf-baseline-ci.json' : 'scripts/perf-baseline.json')));
const base = `http://127.0.0.1:${PORT}`;

/**
 * count: the page's structure (nodes, messages), exact. tally: renders and layouts, which a frame boundary can move by
 * one or two. frames: frames slower than 50 ms during a flick, a time in all but name, never judged in CI.
 */
type Kind = 'ms' | 'count' | 'tally' | 'bytes' | 'frames';
/** gate (CI's baseline only): whether CI judges it; false for one that moved between runs of the same code. */
type Metrics = Record<string, { v: number; kind: Kind; gate?: boolean }>;
/**
 * Render counts no baseline may go over, at any throttle: what scoped renders bought (docs/perf.md). An --update
 * fails on them too, so a regression cannot become the new baseline.
 */
const CEILINGS: Record<string, number> = {
  'open.first.renders': 12, // App, at most twice per switch, six switches
  'open.again.renders': 12,
  'relaunch.open.renders': 12,
  'open.first.sidebarRenders': 18, // the inbox list, three per switch
  'arrival.renders': 1,
  'arrival.messageRenders': 5, // the new message and its neighbours
  'arrival.sidebarRenders': 2,
  'long.reopen.msgs': 250, // the window
};
/** Counts no run may come under, whatever the baseline says: every open fetching ahead was meant to serve did (aheadRun). */
const FLOORS: Record<string, number> = {
  'ahead.served': 5,
  'ahead.relaunchServed': 3,
};
// The world, the build and the hub's log. Its own prefix: a cleanup of someone else's temp dirs must not take it.
const work = args.includes('--work') ? opt('work', '') : mkdtempSync(join(tmpdir(), `dither-verify-perf-${PORT}-`));
const running: { hub?: ReturnType<typeof Bun.spawn> } = {};

async function main() {
  const t0 = performance.now();
  const secs = () => ((performance.now() - t0) / 1000).toFixed(1);
  mkdirSync(work, { recursive: true });
  // ------------------------------------------------------------------ the app, the world, the hub
  let web = opt('web', '');
  let built = Promise.resolve('');
  if (!web) {
    web = join(work, 'web');
    console.log('building the web app…');
    // While the world is seeded and the hub starts: the hub reads it only when a page is asked for.
    const b = Bun.spawn(['bunx', '--bun', 'vite', 'build', '--outDir', web, '--emptyOutDir'], { cwd: join(root, 'packages/web'), stdout: 'ignore', stderr: 'pipe' });
    const err = new Response(b.stderr).text();
    built = b.exited.then(async (code) => {
      if (code !== 0) throw new Error('web build failed:\n' + (await err));
      return secs();
    });
    built.catch(() => {}); // awaited below; not an unhandled rejection meanwhile
  }
  const data = join(work, 'data');
  const world = seedWorld(data, { scale: SCALE });
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
  const boot = await getJson('/api/bootstrap');
  if (!boot.accounts.every((a: any) => a.demo)) throw new Error('not a demo hub');
  console.log(`hub up, its demo accounts online, at ${secs()} s; web build done at ${(await built) || '-'} s`);
  // Then until its journal stands still (it moves for about five seconds): a first run that meets the demo world still
  // settling counts its renders. A warm-up run stands in for the wait: the world settles while it runs, uncounted.
  if (!WARMUP) {
    let seq = -1;
    let still = Date.now();
    while (Date.now() - still < 5000) {
      await Bun.sleep(1000);
      const now = (await getJson('/api/bootstrap')).sync?.seq ?? 0;
      if (now !== seq) (seq = now), (still = Date.now());
    }
  }

  const metrics: Metrics = {};
  const put = (k: string, v: number, kind: Kind) => (metrics[k] = { v: Math.round(v), kind });
  // ------------------------------------------------------------------ the hub's side, once the world has settled
  const hubSide = async () => {
    put('hub.bootstrap.bytes', (await (await fetch(`${base}/api/bootstrap`)).arrayBuffer()).byteLength, 'bytes');
    put('hub.bootstrap.ms', await timed('/api/bootstrap'), 'ms');
    put('hub.inbox.ms', await timed('/api/inbox'), 'ms');
  };
  if (!WARMUP) await hubSide();

  // ------------------------------------------------------------------ the browser's
  // Desktop passes ("4x.…"), then the phone's ("p4x.…").
  const runs: Record<string, Metrics[]> = {};
  const passes = [
    ...CPUS.map((cpu) => ({ key: String(cpu), cpu, phone: false, ahead: false })),
    ...PHONE_CPUS.map((cpu) => ({ key: `p${cpu}`, cpu, phone: true, ahead: false })),
    ...AHEAD_CPUS.map((cpu) => ({ key: `a${cpu}`, cpu, phone: true, ahead: true })),
  ];
  for (const { key, cpu, phone, ahead } of passes) {
    runs[key] = [];
    const go = () => (ahead ? aheadRun(cpu) : phone ? phoneRun(cpu, world) : run(cpu, world));
    for (let i = 0; i < (phone ? 0 : WARMUP); i++) {
      const m = await run(cpu, world);
      console.log(`${cpu}× warm-up run, not counted: cold ${m['cold.list'].v} ms, first open ${m['open.first'].v} ms, message renders ${m['open.first.messageRenders'].v}`);
    }
    if (!metrics['hub.bootstrap.bytes']) await hubSide();
    for (let i = 0; i < RUNS; i++) {
      // A run that fails (a timeout on a busy machine) is tried once more, but not in CI; its error and the hub's log are shown.
      const m = await go().catch((e) => {
        console.warn(`${key}× run ${i + 1} failed${CI ? '' : ', trying again'}: ${e.message}\n${readFileSync(join(work, 'hub.log'), 'utf8').split('\n').slice(-15).join('\n')}`);
        if (CI) throw e;
        return go();
      });
      runs[key].push(m);
      if (ahead)
        console.log(`ahead ${cpu}× run ${i + 1}: ${m['ahead.pages'].v} pages and ${m['ahead.pictures'].v} pictures fetched ahead, ${m['ahead.requests'].v} requests, ${m['ahead.bytes'].v} B; the first five rows open in ${m['ahead.open'].v} ms (${m['ahead.served'].v} of 5 from it), ${m['noahead.open']?.v ?? '-'} ms without; right after a relaunch ${m['ahead.relaunch'].v} ms (${m['ahead.relaunchServed'].v} of 3 kept), ${m['noahead.relaunch']?.v ?? '-'} ms without`);
      else if (phone)
        console.log(`phone ${cpu}× run ${i + 1}: cold ${m['cold.list'].v} ms, ${m['cold.nodes'].v} nodes; open ${m['open.ms'].v} ms; keystroke to frame p90 ${m['typing.keyP90'].v} ms; slow frames: list ${m['listScroll.slowFrames'].v}, timeline ${m['tlScroll.slowFrames'].v}; longest task: open ${m['open.longest'].v}, Home ${m['homeTab.longest'].v}, Catch up ${m['catchUp.longest'].v}, You ${m['you.longest'].v}, person ${m['person.longest'].v}, Mail ${m['mail.longest'].v} ms`);
      else
        console.log(`${cpu}× run ${i + 1}: cold ${m['cold.list'].v} ms, first open ${m['open.first'].v} ms, reopen ${m['open.again'].v} ms, older page ${m['older.page'].v} ms, long reopen ${m['long.reopen'].v} ms, arrival ${m['arrival.busy'].v} ms busy, relaunch ${m['relaunch.list'].v} ms, open after ${m['relaunch.open'].v} ms`);
    }
    for (const k of Object.keys(runs[key][0])) {
      const xs = runs[key].map((r) => r[k]?.v).filter((x) => x !== undefined);
      metrics[`${key}x.${k}`] = { v: median(xs), kind: runs[key][0][k].kind };
    }
  }

  // ------------------------------------------------------------------ against the baseline
  if (OUT) writeFileSync(OUT, JSON.stringify({ world, metrics, runs }, null, 1));
  if (CI && UPDATE) {
    if (RUNS < 5) throw new Error('--ci --update wants --runs 5 or more, to tell the steady counts from the rest');
    for (const [k, m] of Object.entries(metrics)) if (m.kind !== 'ms') m.gate = steady(m.kind, spread(k, runs) ?? [m.v]);
  }
  const old = existsSync(BASELINE) ? (JSON.parse(readFileSync(BASELINE, 'utf8')) as { metrics: Metrics }) : null;
  let failed = 0;
  const rows: { k: string; b?: number; v: number; kind: Kind; change: string; verdict: string; runs: number[] }[] = [];
  console.log(`\n${'metric'.padEnd(34)} ${'baseline'.padStart(10)} ${'now'.padStart(10)}  change`);
  for (const [k, m] of Object.entries(metrics)) {
    const b = old?.metrics[k];
    const ceiling = CEILINGS[k.replace(/^[pa]?\d+x\./, '')];
    const floor = FLOORS[k.replace(/^[pa]?\d+x\./, '')];
    const capped = (ceiling !== undefined && m.v > ceiling) || (floor !== undefined && m.v < floor);
    if (capped) failed++;
    // In CI: times never, and of the rest only what the baseline found steady.
    const judged = !CI || (m.kind !== 'ms' && m.kind !== 'frames' && (UPDATE ? m.gate : b?.gate) !== false);
    const over = judged && b && m.v > b.v + allowed(m.kind, b.v);
    if (over && !UPDATE) failed++;
    const change = b ? `${m.v >= b.v ? '+' : ''}${b.v ? Math.round(((m.v - b.v) / b.v) * 100) : 0}%` : 'new';
    const verdict = over || capped ? 'FAIL' : judged ? '' : m.kind === 'ms' || m.kind === 'frames' ? 'not judged' : 'not steady';
    const xs = spread(k, runs) ?? [m.v];
    rows.push({ k, b: b?.v, v: m.v, kind: m.kind, change, verdict, runs: xs });
    const note = [m.kind === 'ms' ? '' : `(${m.kind})`, capped ? (floor !== undefined ? `under its floor of ${floor}` : `over its ceiling of ${ceiling}`) : '', CI && !judged ? `${verdict}: ${xs.join(' ')}` : ''].filter(Boolean).join(' ');
    console.log(`${(over || capped ? 'FAIL ' : '     ') + k.padEnd(29)} ${String(b?.v ?? '').padStart(10)} ${String(m.v).padStart(10)}  ${change}${note ? ' ' + note : ''}`);
  }
  if (UPDATE && failed) console.log(`\n${failed} over their ceilings: the baseline is not written`);
  else if (UPDATE) {
    const chromium = Bun.spawnSync([findBrowser(), '--version']).stdout.toString().trim();
    const note = CI
      ? 'bun scripts/verify-perf.ts --ci --update --runs 5 (docs/perf.md). CI judges the counts marked gate, never the times.'
      : 'bun scripts/verify-perf.ts --update (docs/perf.md). Times are of the machine it ran on.';
    writeFileSync(BASELINE, JSON.stringify({ note, at: new Date().toISOString().slice(0, 10), runs: RUNS, pages: PAGES, scale: SCALE, chromium, world: world.counts, metrics }, null, 1) + '\n');
    console.log(`\nwrote ${BASELINE}`);
  } else if (!old) console.log('\nno baseline yet: run with --update');
  else console.log(failed ? `\n${failed} over the baseline` : '\nall within the baseline');
  if (process.env.GITHUB_STEP_SUMMARY) summary(rows, world, failed);
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
    await page.size(WIDTH, HEIGHT, WIDTH < 700);
    await page.send('Performance.enable');
    if (cpu > 1) await page.send('Emulation.setCPUThrottlingRate', { rate: cpu });
    await page.send('Page.addScriptToEvaluateOnNewDocument', { source: INIT });
    if (CSS) await page.send('Page.addScriptToEvaluateOnNewDocument', { source: `document.addEventListener('DOMContentLoaded', () => document.head.append(Object.assign(document.createElement('style'), { textContent: ${JSON.stringify(CSS)} })))` });
    const lastIds = new Map<string, string>();
    for (const c of world.open) lastIds.set(c.id, (await getJson(`/api/conversations/${c.id}/messages?limit=1`)).messages.at(-1).id);

    // Cold: a device that has never seen this hub.
    await page.goto(`${base}/?perf=1&ahead=0#/inbox`);
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
      put(`${name}.sidebarRenders`, xs.reduce((s, x) => s + x.sidebarRenders, 0), 'tally');
      put(`${name}.messageRenders`, xs.reduce((s, x) => s + x.messageRenders, 0), 'tally');
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
    put('long.reopen.messageRenders', back.messageRenders, 'tally');
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
    put('arrival.sidebarRenders', a.renders.InboxSidebar ?? 0, 'tally');
    put('arrival.layouts', a.layouts, 'tally');

    // Relaunch: the app opened again later, from the snapshot it kept.
    await until(async () => ((await page.eval<number | null>(SNAPSHOT_TIMELINES)) ?? 0) >= world.open.length, 20_000, 'the snapshot did not keep the timelines').catch((e) => console.warn(e.message));
    await page.goto(`${base}/api/health`);
    await Bun.sleep(1000);
    await page.goto(`${base}/?perf=1&ahead=0#/inbox`);
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

/**
 * A phone (390 × 844, touch): a cold load, then what the desktop run does not cover: flicking the inbox list and a long
 * timeline, typing in the composer, the tabs (Catch up, Search, You, Home), People and a person's page, and Mail's list.
 * Each step's DOM nodes, renders and layouts, its longest task, and for a flick its frames slower than 50 ms.
 */
async function phoneRun(cpu: number, world: World): Promise<Metrics> {
  const b = await launch();
  const page = b.page;
  const m: Metrics = {};
  const put = (k: string, v: number, kind: Kind = 'ms') => (m[k] = { v: Math.round(v), kind });
  type Part = 'nodes' | 'renders' | 'sidebarRenders' | 'messageRenders' | 'layouts' | 'longest' | 'busy';
  const step = async (name: string, fn: () => Promise<Record<string, number> | void>, keep: Part[]) => {
    const m0 = await metrics(page);
    const r0 = await renders(page);
    const lt0 = await page.eval<number>('__perf.lt.length');
    const extra = (await fn()) ?? {};
    await settle(page);
    const lts = await page.eval<[number, number][]>(`__perf.lt.slice(${lt0})`);
    const d = diff(r0, await renders(page));
    const m1 = await metrics(page);
    const all: Record<Part, number> = {
      nodes: await page.eval<number>(`document.getElementsByTagName('*').length`),
      renders: d.App ?? 0,
      sidebarRenders: d.InboxSidebar ?? 0,
      messageRenders: d.MessageItem ?? 0,
      layouts: m1.LayoutCount - m0.LayoutCount,
      longest: Math.max(0, ...lts.map((t) => t[1])),
      busy: (m1.TaskDuration - m0.TaskDuration) * 1000,
    };
    for (const k of keep) put(`${name}.${k}`, all[k], k === 'nodes' ? 'count' : k === 'longest' || k === 'busy' ? 'ms' : 'tally');
    for (const [k, v] of Object.entries(extra)) put(`${name}.${k}`, v, k === 'slowFrames' ? 'frames' : 'ms');
  };
  /** A touch flick over `sel` (positive dy scrolls up), counting frames over 50 ms while it runs. */
  const flick = (sel: string, dy: number) => async () => {
    await page.eval(`(() => { window.__fr = []; let on = true; window.__frStop = () => (on = false); const f = (t) => { __fr.push(t); if (on) requestAnimationFrame(f); }; requestAnimationFrame(f); })()`);
    const at = await page.eval<{ x: number; y: number }>(`(() => { const r = document.querySelector(${JSON.stringify(sel)}).getBoundingClientRect(); return { x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2) }; })()`);
    await page.send('Input.synthesizeScrollGesture', { x: at.x, y: at.y, yDistance: dy, speed: 1500, gestureSourceType: 'touch' });
    await page.eval('__frStop()');
    const fr = await page.eval<number[]>('__fr');
    return { slowFrames: fr.slice(1).filter((t, i) => t - fr[i] > 50).length };
  };
  const key = async (k: string) => {
    const named = k === 'Backspace' ? { key: k, code: k, windowsVirtualKeyCode: 8 } : { key: k, code: k === ' ' ? 'Space' : `Key${k.toUpperCase()}`, text: k, windowsVirtualKeyCode: k === ' ' ? 32 : k.toUpperCase().charCodeAt(0) };
    await page.send('Input.dispatchKeyEvent', { type: 'keyDown', ...named });
    await page.send('Input.dispatchKeyEvent', { type: 'keyUp', ...named, text: undefined });
  };
  /** Keystrokes into the composer, each timed from the key to the frame after it; then taken back, never sent. */
  const typing = async () => {
    await page.eval(`(() => { document.querySelector('.composer textarea').focus(); window.__keys = []; document.addEventListener('keydown', (e) => { const ts = e.timeStamp; requestAnimationFrame(() => setTimeout(() => __keys.push(performance.now() - ts))); }, true); })()`);
    for (const ch of 'the deploy went fine tonight') {
      await key(ch);
      await Bun.sleep(120);
    }
    await Bun.sleep(300);
    const ks = (await page.eval<number[]>('__keys')).sort((a, b) => a - b);
    await page.eval(`document.querySelector('.composer textarea').select()`);
    await key('Backspace');
    return { keyP90: ks[Math.floor(ks.length * 0.9)] ?? 0, keyMax: ks.at(-1) ?? 0 };
  };
  const tab = (label: string) => async () => {
    const ok = await page.eval<boolean>(`(() => { const t = document.querySelector(${JSON.stringify(`.tabbar .tab[data-track="tabs: ${label}"]`)}); t?.click(); return !!t; })()`);
    if (!ok) throw new Error(`no ${label} tab`);
  };
  const hash = (h: string) => async () => void (await page.eval(`location.hash = ${JSON.stringify(h)}`));
  try {
    await page.size(390, 844, true);
    await page.send('Performance.enable');
    if (cpu > 1) await page.send('Emulation.setCPUThrottlingRate', { rate: cpu });
    await page.send('Page.addScriptToEvaluateOnNewDocument', { source: INIT });
    const big = world.open[0];
    const lastId = (await getJson(`/api/conversations/${big.id}/messages?limit=1`)).messages.at(-1).id;
    const boot = await getJson('/api/bootstrap');
    const person = boot.identities.find((i: any) => i.nativeId === world.open[2].member)?.personId;
    if (!person) throw new Error('no person for the biggest direct conversation');

    await page.goto(`${base}/?perf=1&ahead=0#/inbox`);
    const cold = await loaded(page);
    put('cold.list', cold.list);
    put('cold.longest', cold.longest);
    put('cold.layouts', cold.layouts, 'tally');
    put('cold.nodes', cold.nodes, 'count');
    await step('listScroll', flick('.side-scroll', -4000), ['sidebarRenders', 'layouts']);
    const t0 = (await metrics(page)).TaskDuration;
    const o = await open(page, big, lastId);
    put('open.ms', o.painted);
    put('open.longest', o.longest);
    put('open.busy', ((await metrics(page)).TaskDuration - t0) * 1000);
    put('open.layouts', o.layouts, 'tally');
    put('open.messageRenders', o.messageRenders, 'tally');
    await step('tlScroll', flick('.timeline-scroll', 3000), ['messageRenders', 'longest']);
    // Past what opening it set off (marked read, the snapshot saved), so the keys are counted alone.
    await Bun.sleep(2000);
    await settle(page);
    await step('typing', typing, ['renders', 'sidebarRenders', 'messageRenders', 'layouts']);
    // Each first open: its longest task and main-thread time (`busy`), and what it drew.
    await step('home', hash('#/inbox'), ['nodes', 'sidebarRenders', 'longest', 'busy']);
    await step('catchUp', tab('Catch up'), ['nodes', 'renders', 'longest', 'busy']);
    await step('search', tab('Search'), ['nodes', 'renders', 'longest', 'busy']);
    await step('you', tab('You'), ['nodes', 'renders', 'longest', 'busy']);
    // The Home tab brings back the conversation that was open, under the list: its messages are drawn again.
    await step('homeTab', tab('Home'), ['nodes', 'sidebarRenders', 'messageRenders', 'longest', 'busy']);
    await step('people', async () => void (await page.eval(`document.querySelector('.rail-btn[data-track="people"]').click()`)), ['nodes', 'longest', 'busy']);
    await step('person', hash(`#/people/${person}`), ['nodes', 'renders', 'messageRenders', 'longest', 'busy']);
    await step('mail', hash('#/mail'), ['nodes', 'renders', 'longest', 'busy']);
    if (page.errors.length) console.warn('page errors:', page.errors.slice(0, 5));
  } finally {
    await b.close();
  }
  return m;
}

/**
 * Fetching ahead at a phone's size (prefetch.ts, docs/perf.md "Fetching ahead"). A device that never saw the hub loads
 * the inbox and waits until fetching ahead is done: pages, pictures, requests and bytes it took. Then the first five
 * rows open one after another, each timed to its `dither:timeline` mark, with where each came from; then the app is
 * opened again and the next three rows open at once, before anything is fetched ahead in that start. The same in a
 * browser that fetches nothing ahead (?ahead=0) for the times to compare (not in CI). Both over a phone's link (AHEAD_RTT): on
 * loopback a page from the hub takes no time to come, and fetching ahead saves only that.
 */
async function aheadRun(cpu: number): Promise<Metrics> {
  const m: Metrics = {};
  const put = (k: string, v: number, kind: Kind = 'ms') => (m[k] = { v: Math.round(v), kind });
  const one = async (ahead: boolean) => {
    const b = await launch();
    const page = b.page;
    try {
      await page.size(390, 844, true);
      await page.send('Performance.enable');
      if (cpu > 1) await page.send('Emulation.setCPUThrottlingRate', { rate: cpu });
      await page.send('Network.enable');
      if (AHEAD_RTT) await page.send('Network.emulateNetworkConditions', { offline: false, latency: AHEAD_RTT, downloadThroughput: 2.5e6, uploadThroughput: 1.25e6 });
      await page.send('Page.addScriptToEvaluateOnNewDocument', { source: INIT });
      const url = `${base}/?perf=1${ahead ? '' : '&ahead=0'}#/inbox`;
      await page.goto(url);
      await loaded(page);
      const out: Record<string, number> = {};
      if (ahead) {
        await page.until(`window.__ditherAhead?.idle && __ditherAhead.pages.length > 0`, 60_000).catch(() => console.warn('fetching ahead did not finish'));
        await settle(page);
        const x = await page.eval<{ pages: number; pictures: number; requests: number; bytes: number }>(`(() => {
          // A conversation's page, or a person's chat of several routes (docs/chats.md), and pictures.
          const ids = new Set(__ditherAhead.pages.map((k) => k.slice(2)));
          const mine = performance.getEntriesByType('resource').filter((r) => {
            const p = new URL(r.name).pathname.split('/');
            return (p[2] === 'conversations' && ids.has(p[3]) && /^(messages|history)$/.test(p[4])) || (p[2] === 'chats' && ids.has(p[3].replace(/^person:/, '')) && p[4] === 'messages') || p[1] === 'media';
          });
          return { pages: __ditherAhead.pages.length, pictures: __ditherAhead.pictures, requests: mine.length, bytes: mine.reduce((s, r) => s + r.transferSize, 0) };
        })()`);
        Object.assign(out, x);
      }
      // Conversations, not mail threads, in the order on screen.
      const rows = await page.eval<string[]>(`[...document.querySelectorAll('.side-scroll [data-row]')].map((e) => e.getAttribute('data-row')).filter((id) => id.startsWith('cnv_')).slice(0, 8)`);
      if (rows.length < 8) throw new Error(`only ${rows.length} conversations in the inbox`);
      const before = ahead ? await page.eval<number>('__ditherAhead.opens.ahead') : 0;
      const times: number[] = [];
      for (const id of rows.slice(0, 5)) times.push(await openRow(page, id));
      out.open = median(times);
      if (ahead) out.served = (await page.eval<number>('__ditherAhead.opens.ahead')) - before;
      // Away and back: the page saves what it keeps as it goes out of sight. With fetching ahead, until the next three
      // rows' pages are stored: a slow save cut short by the relaunch is not what this measures.
      await page.eval(`Object.defineProperty(document, 'visibilityState', { value: 'hidden', configurable: true }), document.dispatchEvent(new Event('visibilitychange'))`);
      await Bun.sleep(1500);
      if (ahead)
        await page.until(`new Promise((res) => { const r = indexedDB.open('dither-chat'); r.onsuccess = () => { const t = r.result.transaction('pages'); const k = t.objectStore('pages').getAllKeys(); t.oncomplete = () => { r.result.close(); res(${JSON.stringify(rows.slice(5, 8).map((id) => `c:${id}`))}.every((x) => k.result.includes(x))); }; }; r.onerror = () => res(false); })`, 15_000).catch(() => console.warn('the next three rows were not all kept'));
      await page.goto(`${base}/api/health`);
      await page.goto(url);
      await page.until(`window.__perf?.list != null`, 30_000);
      const again: number[] = [];
      for (const id of rows.slice(5, 8)) again.push(await openRow(page, id));
      out.relaunch = median(again);
      // From the device: kept, or caught up ahead if that started first.
      if (ahead) out.relaunchServed = await page.eval<number>('__ditherAhead.opens.kept + __ditherAhead.opens.ahead');
      return out;
    } finally {
      await b.close();
    }
  };
  const a = await one(true);
  // CI judges no times, so it leaves out the run that is only there for them.
  const n = CI ? null : await one(false);
  put('ahead.pages', a.pages, 'count');
  put('ahead.pictures', a.pictures, 'count');
  put('ahead.requests', a.requests, 'count');
  put('ahead.bytes', a.bytes, 'bytes');
  put('ahead.open', a.open);
  put('ahead.served', a.served, 'count');
  if (n) put('noahead.open', n.open);
  put('ahead.relaunch', a.relaunch);
  put('ahead.relaunchServed', a.relaunchServed, 'count');
  if (n) put('noahead.relaunch', n.relaunch);
  return m;
}

/** On a phone: from the inbox to a row's conversation, timed to its `dither:timeline` mark; then back to the inbox. */
async function openRow(page: Page, id: string): Promise<number> {
  const ms = await page.eval<number>(`(async () => {
    const key = 'c:${id}';
    const t0 = performance.now();
    const seen = new Promise((res, rej) => {
      const o = new PerformanceObserver((l) => { for (const e of l.getEntries()) if (e.name === 'dither:timeline' && e.detail?.key === key && e.startTime >= t0) { o.disconnect(); res(e.startTime - t0); } });
      o.observe({ type: 'mark' });
      setTimeout(() => rej(new Error('no dither:timeline mark for ' + key)), 30000);
    });
    location.hash = '#/inbox/c/${id}';
    return seen;
  })()`);
  await settle(page);
  await page.eval(`location.hash = '#/inbox'`);
  await settle(page);
  return ms;
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
  const d = diff(r0, await renders(page));
  return { painted, renders: d.App ?? 0, sidebarRenders: d.InboxSidebar ?? 0, messageRenders: d.MessageItem ?? 0, layouts: (await metrics(page)).LayoutCount - m0.LayoutCount, longest: Math.max(0, ...lts.map((t) => t[1])), ...x };
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
  // The page shows a slice at a time (slices.ts): what it drew once it is all in.
  const x = await page.eval<{ moved: number | null; msgs: number }>(`(() => {
    const first = document.getElementById(window.__first.id);
    return { moved: first ? Math.round(first.getBoundingClientRect().top - window.__first.top) : null, msgs: document.querySelectorAll('.timeline-scroll .msg').length };
  })()`);
  return { ...r, msgs: x.msgs, moved: x.moved === null || Math.abs(x.moved) > 2 };
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

/** How many message pages the device keeps (keptpages.ts): records in the page store, or in an older build's rest. */
const SNAPSHOT_TIMELINES = `new Promise((res) => {
  const r = indexedDB.open('dither-chat');
  r.onerror = () => res(null);
  r.onsuccess = () => {
    try {
      const d = r.result;
      if (d.objectStoreNames.contains('pages')) {
        const t = d.transaction('pages');
        const keys = t.objectStore('pages').getAllKeys();
        t.oncomplete = () => res(keys.result.filter((k) => !String(k).startsWith('#')).length);
        t.onerror = () => res(null);
        return;
      }
      const t = d.transaction('snapshot');
      const last = t.objectStore('snapshot').get('last');
      const rest = t.objectStore('snapshot').get('rest');
      t.oncomplete = () => {
        const s = last.result, x = rest.result;
        const text = x && s && x.savedAt > s.savedAt ? x.rest : s?.rest;
        res(text ? (JSON.parse(text).timelines ?? []).length : null);
      };
      t.onerror = () => res(null);
    } catch (e) { res(null); }
  };
})`;

// ------------------------------------------------------------------ helpers

/** Every run's value of a per-throttle metric ("1x.cold.nodes"), or null for the hub's own. */
function spread(k: string, runs: Record<string, Metrics[]>): number[] | null {
  const m = k.match(/^([pa]?\d+)x\.(.+)$/);
  return m ? runs[m[1]].map((r) => r[m[2]]?.v).filter((x) => x !== undefined) : null;
}
/**
 * How far over its baseline a value may go. A time: a quarter and 50 ms. Renders and layouts: two or 10% (a frame
 * boundary moves them). Bytes: 1%. A count of the page's structure: nothing locally; in CI 1% or two, since each run's
 * arriving message moves the long timeline's window by one message and the runs it is the median of are always the same.
 */
function allowed(kind: Kind, b: number): number {
  return kind === 'ms' ? b * 0.25 + 50 : kind === 'frames' ? Math.max(3, b) : kind === 'tally' ? Math.max(2, b * 0.1) : kind === 'bytes' ? b * 0.01 : CI ? Math.max(2, b * 0.01) : 0;
}
/** Steady enough to judge: its runs spread over at most half what it may go over by (a tally: one), so noise cannot fail it. */
function steady(kind: Kind, xs: number[]): boolean {
  const d = Math.max(...xs) - Math.min(...xs);
  return kind === 'ms' || kind === 'frames' ? false : kind === 'tally' ? d <= 1 : d <= allowed(kind, Math.min(...xs)) / 2;
}

/** The job's summary (GitHub Actions): what was judged and how it went, then the times, for reading only. */
function summary(rows: { k: string; b?: number; v: number; kind: Kind; change: string; verdict: string; runs: number[] }[], world: World, failed: number) {
  const line = (r: (typeof rows)[number]) => `| ${r.verdict === 'FAIL' ? '**FAIL**' : r.verdict || 'ok'} | \`${r.k}\` | ${r.b ?? ''} | ${r.v} | ${r.change} | ${r.runs.join(' ')} |`;
  const head = '| | metric | baseline | now | change | runs |\n|---|---|---|---|---|---|';
  const out = [
    `### verify-perf${CI ? ' --ci' : ''}: ${failed ? `${failed} over the baseline` : 'all within the baseline'}`,
    '',
    `World: ${Object.entries(world.counts).map(([k, v]) => `${v} ${k}`).join(', ')}. ${WARMUP ? `${WARMUP} warm-up and ` : ''}${RUNS} ${RUNS === 1 ? 'run' : 'runs'} at ${CPUS.map((c) => `${c}×`).join(', ')}, ${PAGES} older pages${RUNS > 1 ? '; medians' : ''}.`,
    '',
    '#### Counts, renders, layouts and bytes',
    '',
    head,
    ...rows.filter((r) => r.kind !== 'ms').map(line),
    '',
    `#### Times (ms${CI ? ', not judged: a shared runner' : ''})`,
    '',
    head,
    ...rows.filter((r) => r.kind === 'ms').map(line),
    '',
  ];
  writeFileSync(process.env.GITHUB_STEP_SUMMARY!, out.join('\n') + '\n', { flag: 'a' });
}

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
