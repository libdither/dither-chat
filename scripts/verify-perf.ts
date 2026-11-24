/**
 * Load and chat-switch performance against a demo hub of its own, grown to the live hub's size (docs/perf.md).
 *
 *   bun scripts/verify-perf.ts [--port 8620] [--runs 3] [--cpu 1,4] [--pages 15] [--web <built dist>]
 *                              [--update] [--out results.json] [--baseline scripts/perf-baseline.json] [--css <css>]
 *                              [--work <empty dir>] [--keep] [--size 390x844] [--scale 1] [--phone-cpu 4] [--ci]
 *                              [--slow-cpu 4] [--slow-rtt 300] [--slow-down 1.6] [--slow-up 0.75] [--slow-queue fair]
 *
 * Builds the web app (unless --web names a build), seeds a fresh world (scripts/perf-world.ts) in a temp dir, starts
 * a hub on it, and measures in headless Chromium at each CPU throttle, `runs` times each:
 *
 *   cold load to the list; first open of six conversations, reopening them, `pages` older pages in the biggest, the
 *   long timeline reopened, a message arriving while it is open; then a relaunch from the device's snapshot and the
 *   same six opened again. Times, long tasks, and counts: renders of App, the inbox list and messages, LayoutCount,
 *   DOM nodes, .msg elements. Then a phone's pass (`--phone-cpu`, 4× here and 1× in CI): flicking the lists, typing,
 *   the tabs, a person's page and Mail (phoneRun). Those passes fetch nothing ahead (?ahead=0); the phone's `ahead` pass
 *   measures fetching ahead (prefetch.ts) against the same steps without it (aheadRun). Last, the `slow` pass loads the
 *   app over a poor phone link (slowlink.ts): a cold start, then a relaunch from the device's snapshot (slowRun).
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
 *
 * For trying a change (docs/perf.md, "A/B a change"):
 *
 *   --only desktop,phone,ahead,slow   just those passes (the throttles of the rest are left out)
 *   --ab <distA>,<distB>[,...]         one hub and one world; the runs take the builds in turn (A B B A A B ...) and
 *                                      the output is each build's medians and ranges side by side, with the difference
 *   --keep-world <dir>                 keep the world as seeded, before the hub ever runs on it, to reuse
 *   --age <dir>                        keep the hub's state as the ahead pass first finds it, after the passes before it
 *   --world <dir>                      run on a copy of a kept or aged world instead of seeding: refused when its scale,
 *                                      its day or the code that seeds it differ from this run's
 */
import { Database } from 'bun:sqlite';
import { createHash } from 'node:crypto';
import { cpSync, existsSync, mkdirSync, mkdtempSync, openSync, readdirSync, readFileSync, renameSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { findBrowser, launch, type Page } from './browser.ts';
import { seedWorld, worldAnchor, type World, type WorldConv } from './perf-world.ts';
import { REQ_KINDS, slowLink, type Req } from './slowlink.ts';

const args = process.argv.slice(2);
if (args.includes('--help') || args.includes('-h')) {
  // This file's opening comment.
  console.log(readFileSync(import.meta.path, 'utf8').split('*/')[0].replace(/^\/\*\*\n/, '').replace(/^ \* ?/gm, ''));
  process.exit(0);
}
const opt = (k: string, d: string) => (args.includes(`--${k}`) ? args[args.indexOf(`--${k}`) + 1] : d);
const CI = args.includes('--ci');
const PORT = Number(opt('port', '8620'));
/** Builds to compare (--ab), each a built web app's directory, labelled A, B, C… in the order given. */
const AB = opt('ab', '').split(',').filter(Boolean).map((d) => resolve(d));
if (AB.length === 1) throw new Error('--ab wants two builds or more, separated by commas');
for (const d of AB) if (!existsSync(join(d, 'index.html'))) throw new Error(`--ab: ${d} is not a built web app (no index.html)`);
/** The passes to run (--only); the rest are left out as `--<pass>-cpu 0` would. */
const PASSES = ['desktop', 'phone', 'ahead', 'slow'];
const ONLY = opt('only', '') ? new Set(opt('only', '').split(',')) : null;
for (const p of ONLY ?? []) if (!PASSES.includes(p)) throw new Error(`--only: no pass called ${p} (${PASSES.join(', ')})`);
const only = (pass: string, xs: number[]) => (ONLY && !ONLY.has(pass) ? [] : xs);
/** A world kept or aged by an earlier run, to run on instead of seeding one (--world); where to keep this run's (--keep-world, --age). */
const WORLD = opt('world', '');
const KEEP_WORLD = opt('keep-world', '');
const AGE = opt('age', '');
if (WORLD && KEEP_WORLD) throw new Error('--world reuses a world, --keep-world keeps a freshly seeded one: not both');
/** Measured runs at each throttle; their medians are what counts. CI's are steady after the warm-up, so it takes one. */
const RUNS = Number(opt('runs', CI ? '1' : '3'));
/**
 * Runs first that are not counted. The first run on a fresh hub draws more than the rest, 1.4 times the message
 * renders and twice the layouts: it marks the six read and leaves the hub as later runs find it. So a warm-up is a
 * whole run at the real pace; a hurried one leaves that to the first counted run (docs/perf.md). An A/B takes one, so
 * that run is not the first build's alone.
 */
const WARMUP = Number(opt('warmup', CI || AB.length ? '1' : '0'));
const CPUS = only('desktop', opt('cpu', CI ? '1' : '1,4').split(',').map(Number).filter((x) => x > 0));
/** Throttles for the phone pass (phoneRun), after the desktop's; `--phone-cpu 0` leaves it out. */
const PHONE_CPUS = only('phone', opt('phone-cpu', CI ? '1' : '4').split(',').map(Number).filter((x) => x > 0));
/** Throttles for fetching ahead (aheadRun), at a phone's size; `--ahead-cpu 0` leaves it out. */
const AHEAD_CPUS = only('ahead', opt('ahead-cpu', CI ? '1' : '4').split(',').map(Number).filter((x) => x > 0));
/** The round trip the ahead pass puts between page and hub, as a phone on the tailnet has (docs/android.md: 80 ms, 20/10 Mbit/s). */
const AHEAD_RTT = Number(opt('ahead-rtt', '80'));
/** Throttles for the slow link's pass (slowRun), at a phone's size; `--slow-cpu 0` leaves it out. */
const SLOW_CPUS = only('slow', opt('slow-cpu', CI ? '1' : '4').split(',').map(Number).filter((x) => x > 0));
/**
 * The slow link (slowlink.ts): its round trip in ms, and Mbit/s down and up. Lighthouse's phone on "slow 4G" (1.6 and
 * 0.75 Mbit/s) with a round trip between its 150 ms and the 562.5 ms it gives DevTools for the same link (docs/perf.md).
 */
const SLOW_RTT = Number(opt('slow-rtt', '300'));
const SLOW_DOWN = Number(opt('slow-down', '1.6'));
const SLOW_UP = Number(opt('slow-up', '0.75'));
/** Which connection sends next on it: in turn (`fair`) or first come first served (`fifo`, a deep shared buffer). */
const SLOW_QUEUE = opt('slow-queue', 'fair') === 'fifo' ? 'fifo' : 'fair';
const PAGES = Number(opt('pages', CI ? '5' : '15'));
/** The world's size against the live hub's (perf-world.ts). */
const SCALE = Number(opt('scale', CI ? '0.1' : '1'));
const UPDATE = args.includes('--update');
if (AB.length && (UPDATE || CI)) throw new Error('--ab compares builds with each other, never with a baseline: not with --update or --ci');
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
 * Counts no baseline may go over, at any throttle: what scoped renders bought (docs/perf.md), and more. An --update
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
  // Over the slow link (slowRun): one catch-up a start (one more is a socket replaced), and the app itself from the
  // service worker on a relaunch.
  'socket.resyncs': 0,
  'relaunch.toContent.shell': 0,
};
/** Counts no run may come under, whatever the baseline says: every open fetching ahead was meant to serve did (aheadRun), and more. */
const FLOORS: Record<string, number> = {
  'ahead.served': 5,
  'ahead.relaunchServed': 3,
  // Over the slow link: the worker took the page over, and the relaunch drew the list from the snapshot.
  'precache.tookOver': 1,
  'relaunch.fromSnapshot': 1,
};
// The world, the build and the hub's log. Its own prefix: a cleanup of someone else's temp dirs must not take it.
const work = args.includes('--work') ? opt('work', '') : mkdtempSync(join(tmpdir(), `dither-verify-perf-${PORT}-`));
const running: { hub?: ReturnType<typeof Bun.spawn> } = {};
/** Every request of each slow run, for --out: kind, path, sent, first and last byte (ms from the page's start), bytes. */
const slowLog: unknown[][][] = [];
/** The inbox's first rows (those fetching ahead takes: prefetch.ts AHEAD) as the last ahead run with it found them. */
const AHEAD_ROWS = 12;
let aheadRows: string[] = [];
/** The hub's scores as the ahead run read its rows (with --age or --world). */
let aheadScores: Scores = [];

async function main() {
  const t0 = performance.now();
  const secs = () => ((performance.now() - t0) / 1000).toFixed(1);
  mkdirSync(work, { recursive: true });
  // ------------------------------------------------------------------ the app, the world, the hub
  let web = opt('web', '');
  let built = Promise.resolve('');
  if (!web && !AB.length) {
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
  let world: World;
  let kept: (Kept & { ms: number }) | null = null;
  if (WORLD) {
    kept = reuseWorld(WORLD, data);
    world = { ...kept.world, ms: kept.ms };
  } else {
    world = seedWorld(data, { scale: SCALE });
    console.log(`seeded in ${(world.ms / 1000).toFixed(1)} s:`, JSON.stringify(world.counts));
    if (KEEP_WORLD) keepWorld(KEEP_WORLD, data, world);
  }
  // Which passes run before the ahead pass, and so make the hub what it finds: an aged world is for it and the slow pass after it.
  if (kept?.aged && (CPUS.length || PHONE_CPUS.length || !AHEAD_CPUS.length)) throw new Error(`${WORLD} is aged for the ahead pass (${kept.aged.before}): run it with --only ahead or --only ahead,slow`);
  if (kept?.aged && AGE) throw new Error(`${WORLD} is aged already: age a world kept as seeded (--keep-world), or seed one`);
  if (AGE && !AHEAD_CPUS.length) throw new Error('--age keeps the hub as the ahead pass finds it: the ahead pass must run');
  if ((await fetch(`${base}/api/health`).catch(() => null))?.ok) throw new Error(`something is already listening on ${PORT}`);
  // An A/B serves each build in turn from one path, switched between runs (the hub reads its files as they are asked for).
  if (AB.length) {
    web = join(work, 'web-ab');
    useBuild(AB[0]);
  }
  const log = openSync(join(work, 'hub.log'), 'a');
  running.hub = Bun.spawn(['bun', join(root, 'packages/hub/src/main.ts'), '--demo', '--data', data, '--port', String(PORT), '--host', '127.0.0.1', '--web', web], {
    env: { ...process.env, DITHER_DEMO_CHATTER: '0' },
    stdout: log,
    stderr: log,
  });
  // Until it answers, or its process ends. A full-size world's start takes 4 s on a quiet machine and 18 s or more on a
  // loaded one (its models, adapters and first scoring: the `startup:` line in hub.log), so no fixed deadline but three
  // minutes, past which it is stuck.
  const hub = running.hub;
  await until(async () => hub.exitCode !== null || ((await fetch(`${base}/api/health`).catch(() => null))?.ok ?? false), 180_000, 'the hub did not start').then(
    () => {
      if (hub.exitCode !== null) throw new Error(`the hub exited (${hub.exitCode})`);
    },
  ).catch((e) => {
    throw new Error(`${e.message}; its log ends:\n${readFileSync(join(work, 'hub.log'), 'utf8').split('\n').slice(-25).join('\n')}`);
  });
  // The demo accounts bring their own world in once they are up.
  await until(async () => (await getJson('/api/bootstrap')).accounts.every((a: any) => a.status === 'online'), 30_000, 'demo accounts not online');
  const boot = await getJson('/api/bootstrap');
  if (!boot.accounts.every((a: any) => a.demo)) throw new Error('not a demo hub');
  console.log(`hub up, its demo accounts online, at ${secs()} s; web build done at ${(await built) || '-'} s`);
  // Then until its journal stands still (it moves for about five seconds): a first run that meets the demo world still
  // settling counts its renders. A warm-up run stands in for the wait: the world settles while it runs, uncounted.
  const warmsUp = WARMUP > 0 && CPUS.length > 0;
  if (!warmsUp) await journalStill();

  const metrics: Metrics = {};
  const put = (k: string, v: number, kind: Kind) => (metrics[k] = { v: Math.round(v), kind });
  // ------------------------------------------------------------------ the hub's side, once the world has settled
  const hubSide = async () => {
    put('hub.bootstrap.bytes', (await (await fetch(`${base}/api/bootstrap`)).arrayBuffer()).byteLength, 'bytes');
    put('hub.bootstrap.ms', await timed('/api/bootstrap'), 'ms');
    put('hub.inbox.ms', await timed('/api/inbox'), 'ms');
  };
  if (kept?.aged) await restoreReads(kept, join(WORLD, 'data', 'hub.sqlite'), join(data, 'hub.sqlite'));
  if (!warmsUp) await hubSide();

  // ------------------------------------------------------------------ the browser's
  // Desktop passes ("4x.…"), then the phone's ("p4x.…").
  /** Each build's runs, by pass (one build, labelled '', unless --ab). */
  const builds = AB.length ? AB.map((dir, i) => ({ label: String.fromCharCode(65 + i), dir })) : [{ label: '', dir: web }];
  const runsOf: Record<string, Record<string, Metrics[]>> = Object.fromEntries(builds.map((b) => [b.label, {}]));
  const runs = runsOf[builds[0].label];
  const passes = [
    ...CPUS.map((cpu) => ({ key: String(cpu), cpu, phone: false, ahead: false, slow: false })),
    ...PHONE_CPUS.map((cpu) => ({ key: `p${cpu}`, cpu, phone: true, ahead: false, slow: false })),
    ...AHEAD_CPUS.map((cpu) => ({ key: `a${cpu}`, cpu, phone: true, ahead: true, slow: false })),
    ...SLOW_CPUS.map((cpu) => ({ key: `s${cpu}`, cpu, phone: true, ahead: false, slow: true })),
  ];
  /** The first ahead run's rows: checked against the aged world's (--world), or kept with it (--age). */
  let firstAhead = true;
  for (const { key, cpu, phone, ahead, slow } of passes) {
    if (ahead && firstAhead && AGE) await ageWorld(AGE, data, world, passes.filter((p) => !p.ahead && !p.slow).map((p) => `${p.key}x ${WARMUP && !p.phone ? `${WARMUP} warm-up + ` : ''}${RUNS} runs`).join(', ') || 'nothing');
    for (const b of builds) runsOf[b.label][key] = [];
    const go = () => (slow ? slowRun(cpu) : ahead ? aheadRun(cpu) : phone ? phoneRun(cpu, world) : run(cpu, world));
    if (AB.length) useBuild(builds[0].dir);
    for (let i = 0; i < (phone ? 0 : WARMUP); i++) {
      const m = await run(cpu, world);
      console.log(`${cpu}× warm-up run, not counted: cold ${m['cold.list'].v} ms, first open ${m['open.first'].v} ms, message renders ${m['open.first.messageRenders'].v}`);
    }
    if (!metrics['hub.bootstrap.bytes']) await hubSide();
    for (let i = 0; i < RUNS; i++) {
      // In turn, back and forth (A B, B A, A B…), so a hub that drifts from run to run (each run's arriving message, the
      // order its opens leave) drifts under each build alike.
      for (const { label, dir } of i % 2 ? [...builds].reverse() : builds) {
        if (AB.length) useBuild(dir);
        // The hub's scores as the first ahead run on an aged world finds them, to explain a changed order (checkAheadRows).
        const scoresBefore = ahead && firstAhead && kept?.aged ? await scores() : null;
        const name = `${label ? `${label} ` : ''}${key}`;
        // A run that fails (a timeout on a busy machine) is tried once more, but not in CI; its error and the hub's log are shown.
        const m = await go().catch((e) => {
          console.warn(`${name}× run ${i + 1} failed${CI ? '' : ', trying again'}: ${e.message}\n${readFileSync(join(work, 'hub.log'), 'utf8').split('\n').slice(-15).join('\n')}`);
          if (CI) throw e;
          return go();
        });
        runsOf[label][key].push(m);
        if (ahead && firstAhead) {
          firstAhead = false;
          if (AGE) keepAheadRows(AGE, aheadRows, aheadScores);
          if (kept?.aged) checkAheadRows(kept, aheadRows, aheadScores.length ? aheadScores : scoresBefore!);
        }
        const by = label ? `${label}: ` : '';
        if (slow)
          console.log(`${by}slow link ${cpu}× run ${i + 1}: cold to content ${m['cold.content'].v} ms (${m['cold.toContent.requests'].v} requests, ${m['cold.toContent.bytes'].v} B), the bootstrap ${m['cold.bootstrap.bytes'].v} B in ${m['cold.bootstrap'].v} ms beside ${m['cold.competing.bytes'].v} B of ${m['cold.competing.requests'].v} others; first open ${m['open.ms'].v} ms; precache ${m['precache.requests'].v} requests, ${m['precache.bytes'].v} B, done at ${m['precache.ms'].v} ms; relaunch to content ${m['relaunch.content'].v} ms after ${m['relaunch.toContent.answers'].v} answers, to fresh ${m['relaunch.fresh'].v} ms; socket opened ${m['socket.opens'].v}, ${m['socket.pings'].v} pings, the slowest pong ${m['socket.pongMax'].v} ms, ${m['socket.drops'].v} closed by the app, ${m['socket.resyncs'].v} catch-ups more than one a start`);
        else if (ahead)
          console.log(`${by}ahead ${cpu}× run ${i + 1}: ${m['ahead.pages'].v} pages and ${m['ahead.pictures'].v} pictures fetched ahead, ${m['ahead.requests'].v} requests, ${m['ahead.bytes'].v} B; the first five rows open in ${m['ahead.open'].v} ms (${m['ahead.served'].v} of 5 from it), ${m['noahead.open']?.v ?? '-'} ms without; right after a relaunch ${m['ahead.relaunch'].v} ms (${m['ahead.relaunchServed'].v} of 3 kept), ${m['noahead.relaunch']?.v ?? '-'} ms without`);
        else if (phone)
          console.log(`${by}phone ${cpu}× run ${i + 1}: cold ${m['cold.list'].v} ms, ${m['cold.nodes'].v} nodes; open ${m['open.ms'].v} ms; keystroke to frame p90 ${m['typing.keyP90'].v} ms; slow frames: list ${m['listScroll.slowFrames'].v}, timeline ${m['tlScroll.slowFrames'].v}; longest task: open ${m['open.longest'].v}, Home ${m['homeTab.longest'].v}, For you ${m['forYou.longest'].v}, You ${m['you.longest'].v}, person ${m['person.longest'].v}, Mail ${m['mail.longest'].v} ms`);
        else
          console.log(`${by}${cpu}× run ${i + 1}: cold ${m['cold.list'].v} ms, first open ${m['open.first'].v} ms, reopen ${m['open.again'].v} ms, older page ${m['older.page'].v} ms, long reopen ${m['long.reopen'].v} ms, arrival ${m['arrival.busy'].v} ms busy, relaunch ${m['relaunch.list'].v} ms, open after ${m['relaunch.open'].v} ms`);
      }
    }
    if (AB.length) continue;
    for (const k of Object.keys(runs[key][0])) {
      const xs = runs[key].map((r) => r[k]?.v).filter((x) => x !== undefined);
      metrics[`${key}x.${k}`] = { v: median(xs), kind: runs[key][0][k].kind };
    }
  }
  if (AB.length) return abReport(builds, runsOf, metrics, world);

  // ------------------------------------------------------------------ against the baseline
  if (OUT) writeFileSync(OUT, JSON.stringify({ world, metrics, runs, ...(slowLog.length ? { slowRequests: slowLog } : {}) }, null, 1));
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
    const ceiling = CEILINGS[k.replace(/^[pas]?\d+x\./, '')];
    const floor = FLOORS[k.replace(/^[pas]?\d+x\./, '')];
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
 * timeline, typing in the composer, the tabs (For you, Search, You, Home), People and a person's page, and Mail's list.
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
    await step('forYou', tab('For you'), ['nodes', 'renders', 'longest', 'busy']);
    await step('search', tab('Search'), ['nodes', 'renders', 'longest', 'busy']);
    await step('you', tab('You'), ['nodes', 'renders', 'longest', 'busy']);
    // The Home tab brings back the conversation that was open, under the list: its messages are drawn again.
    await step('homeTab', tab('Home'), ['nodes', 'sidebarRenders', 'messageRenders', 'longest', 'busy']);
    await step('people', async () => void (await page.eval(`document.querySelector('.rail-btn[data-track="people"]').click()`)), ['nodes', 'longest', 'busy']);
    await step('person', hash(`#/people/${person}`), ['nodes', 'renders', 'messageRenders', 'longest', 'busy']);
    await step('mail', hash('#/inbox?mail=v%3Aupdates%3A*'), ['nodes', 'renders', 'longest', 'busy']);
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
      if (ahead) {
        aheadRows = await page.eval<string[]>(`[...document.querySelectorAll('.side-scroll [data-row]')].slice(0, ${AHEAD_ROWS}).map((e) => e.getAttribute('data-row'))`);
        if (AGE || WORLD) aheadScores = await scores();
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
        await page.until(`new Promise((res) => { const r = indexedDB.open('dither-chat'); r.onsuccess = () => { const t = r.result.transaction('pages'); const k = t.objectStore('pages').getAllKeys(); t.oncomplete = () => { r.result.close(); res(${JSON.stringify(rows.slice(5, 8).map((id) => `c:${id}`))}.every((x) => k.result.includes(x))); }; }; r.onerror = () => res(false); })`, 15_000).catch(async () => console.warn(`the next three rows were not all kept\n${await aheadDump(page, rows.slice(5, 8).map((id) => `c:${id}`))}`));
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

/**
 * The live socket's life in the page: opened, closed by the app (one its heartbeat gave up on, or a spare that lost the
 * race with a late pong: state.ts probe), closed from the far end, and the heartbeat's pings with the longest wait for
 * a pong.
 */
const SOCKETS = `(() => {
  const W = window.WebSocket;
  window.__sock = { opened: 0, dropped: 0, closed: 0, pings: 0, pongMax: 0, fresh: 0 };
  // Each catch-up with the hub marks dither:fresh (state.ts); counted as they come, whatever is kept of them.
  new PerformanceObserver((l) => (__sock.fresh += l.getEntriesByName('dither:fresh').length)).observe({ type: 'mark' });
  window.WebSocket = class extends W {
    constructor(u, p) {
      super(u, p);
      if (!String(u).includes('/api/live')) return;
      __sock.opened++;
      let mine = false;
      const close = this.close.bind(this);
      this.close = (...a) => { if (!mine && this.readyState <= 1) (mine = true), __sock.dropped++; return close(...a); };
      this.addEventListener('close', () => mine || __sock.closed++);
      let sent = 0;
      const send = this.send.bind(this);
      this.send = (d) => { if (d === 'ping') (sent = performance.now()), __sock.pings++; return send(d); };
      this.addEventListener('message', (e) => { if (e.data === 'pong' && sent) (__sock.pongMax = Math.max(__sock.pongMax, performance.now() - sent)), (sent = 0); });
    }
  };
})()`;

/**
 * Over a poor phone link (slowlink.ts, docs/perf.md "Over a slow link"), at a phone's size: a device that never saw the
 * hub loads the app, opens the first conversation in its list, and stays until the service worker has kept the whole
 * build and fetching ahead is done; then the app is opened again, from the snapshot it kept. Requests and bytes on the
 * link before the list showed (`dither:content`) and before the hub's data was in (`dither:fresh`), by kind; what shared
 * the link with the bootstrap; and the live socket, which should never be given up while it works: each start catches
 * up with the hub once (a bootstrap or a sync), and one more means a socket was replaced.
 */
async function slowRun(cpu: number): Promise<Metrics> {
  const link = await slowLink({ target: PORT, rtt: SLOW_RTT, down: SLOW_DOWN * 1e6, up: SLOW_UP * 1e6, queue: SLOW_QUEUE });
  const via = `http://127.0.0.1:${link.port}`;
  const url = `${via}/?perf=1#/inbox`;
  const b = await launch();
  const page = b.page;
  const m: Metrics = {};
  const put = (k: string, v: number, kind: Kind = 'ms') => (m[k] = { v: Math.round(v), kind });
  /** Requests sent from `from` until `t`: how many, how many had their whole answer by then, and the bytes that had come. */
  const upTo = (from: number, t: number, kind?: string) => {
    const rs = link.reqs.filter((r) => r.at >= from && r.at <= t && (!kind || r.kind === kind));
    return { requests: rs.length, answers: rs.filter((r) => r.last && r.last <= t).length, bytes: rs.reduce((s, r) => s + bytesBy(r, t), 0) };
  };
  /** The page's start (epoch ms), and when the list showed and the hub's data was in. Over this link, two minutes at most. */
  const marks = async () => {
    await page.until(`window.__perf?.list != null && performance.getEntriesByName('dither:content').length > 0 && performance.getEntriesByName('dither:fresh').length > 0`, 120_000).catch(() => {
      throw new Error(`no list and fresh data over the slow link; page errors: ${JSON.stringify(page.errors.slice(0, 5))}`);
    });
    return page.eval<{ origin: number; content: number; fresh: number; source: string }>(`(() => {
      const c = performance.getEntriesByName('dither:content')[0];
      return { origin: performance.timeOrigin, content: performance.timeOrigin + c.startTime, fresh: performance.timeOrigin + performance.getEntriesByName('dither:fresh')[0].startTime, source: c.detail?.source };
    })()`);
  };
  /** Catch-ups with the hub in this page (a bootstrap or a sync from the journal: state.ts marks each `dither:fresh`). */
  const freshes = () => page.eval<number>('__sock.fresh');
  const sockets = () => page.eval<{ opened: number; dropped: number; closed: number; pings: number; pongMax: number }>('({ ...__sock })');
  try {
    await page.size(390, 844, true);
    if (cpu > 1) await page.send('Emulation.setCPUThrottlingRate', { rate: cpu });
    await page.send('Page.addScriptToEvaluateOnNewDocument', { source: INIT });
    await page.send('Page.addScriptToEvaluateOnNewDocument', { source: SOCKETS });

    // Cold: nothing on the device, not even the app. Once the bootstrap has begun to come, the app is brought back to
    // the front, as someone who looked away while it loaded would: its heartbeat pings the socket (state.ts probe)
    // while the link is at its busiest, and a pong later than PONG_WAIT drops a socket that was fine.
    await page.goto(url);
    const n = link.reqs.length;
    for (let i = 0; i < 1200 && !link.reqs.slice(n).some((r) => r.kind === 'bootstrap' && r.first); i++) await Bun.sleep(50);
    await page.eval(`window.dispatchEvent(new Event('focus'))`);
    const cold = await marks();
    put('cold.content', cold.content - cold.origin);
    put('cold.fresh', cold.fresh - cold.origin);
    const toContent = upTo(cold.origin, cold.content);
    put('cold.toContent.requests', toContent.requests, 'count');
    put('cold.toContent.bytes', toContent.bytes, 'bytes');
    const toFresh = upTo(cold.origin, cold.fresh);
    put('cold.toFresh.requests', toFresh.requests, 'count');
    put('cold.toFresh.bytes', toFresh.bytes, 'bytes');
    for (const k of REQ_KINDS) {
      const x = upTo(cold.origin, cold.content, k);
      put(`cold.${k}.requests`, x.requests, 'count');
      put(`cold.${k}.bytes`, x.bytes, 'bytes');
    }
    // The bootstrap on the wire, from asked to its last byte, and what else came down the link meanwhile.
    const boot = link.reqs.find((r) => r.kind === 'bootstrap' && r.at >= cold.origin);
    if (!boot?.last) throw new Error('no bootstrap over the slow link');
    put('cold.bootstrap', boot.last - boot.at);
    put('cold.bootstrap.bytes', boot.bytes, 'bytes');
    const others = link.reqs.filter((r) => r !== boot && r.kind !== 'socket' && r.arrivals.some(([t]) => t > boot.at && t <= boot.last));
    put('cold.competing.requests', others.length, 'count');
    put('cold.competing.bytes', others.reduce((s, r) => s + bytesBy(r, boot.last) - bytesBy(r, boot.at), 0), 'bytes');
    for (const k of ['precache', 'pictures', 'pages'] as const) put(`cold.beforeBootstrap.${k}`, link.reqs.filter((r) => r.kind === k && r.at >= cold.origin && r.at < boot.last).length, 'count');

    // The first conversation in the list, as someone who just got the app would.
    const row = await page.eval<string | undefined>(`[...document.querySelectorAll('.side-scroll [data-row]')].map((e) => e.getAttribute('data-row')).find((id) => id.startsWith('cnv_'))`);
    if (!row) throw new Error('no conversation in the inbox');
    put('open.ms', await openRow(page, row));

    // Until the service worker has the whole build (it claims the page once it has) and fetching ahead is done.
    const took = await page.until(`!!navigator.serviceWorker.controller`, 90_000).then(
      () => 1,
      async () => {
        const st = await page.eval(`navigator.serviceWorker.getRegistration().then((r) => JSON.stringify({ installing: r?.installing?.state, waiting: r?.waiting?.state, active: r?.active?.state }))`).catch((e) => e.message);
        console.warn(`the service worker did not take over within 90 s: ${st}`);
        return 0;
      },
    );
    put('precache.tookOver', took, 'count');
    await page.until(`window.__ditherAhead?.idle`, 60_000).catch(() => console.warn('fetching ahead did not finish'));
    const kept = link.reqs.filter((r) => r.kind === 'precache' && r.at >= cold.origin);
    put('precache.requests', kept.length, 'count');
    put('precache.bytes', kept.reduce((s, r) => s + r.bytes, 0), 'bytes');
    put('precache.ms', Math.max(0, ...kept.map((r) => r.last)) - cold.origin);
    const ahead = link.reqs.filter((r) => r.kind === 'pages' && r.at >= cold.origin);
    put('ahead.requests', ahead.length, 'count');
    put('ahead.bytes', ahead.reduce((s, r) => s + r.bytes, 0), 'bytes');
    const s1 = await sockets();
    const coldFresh = await freshes();
    put('cold.stay', Date.now() - cold.origin);
    log(link.reqs, cold.origin);

    // Away and back: the page saves its snapshot as it goes out of sight; then the app opened again.
    await page.eval(`Object.defineProperty(document, 'visibilityState', { value: 'hidden', configurable: true }), document.dispatchEvent(new Event('visibilitychange'))`);
    await Bun.sleep(1500);
    await page.goto(`${via}/api/health`);
    const n0 = link.reqs.length;
    await page.goto(url);
    const warm = await marks();
    put('relaunch.content', warm.content - warm.origin);
    put('relaunch.fresh', warm.fresh - warm.origin);
    put('relaunch.fromSnapshot', warm.source === 'snapshot' ? 1 : 0, 'count');
    if (warm.source !== 'snapshot') console.warn(`slow relaunch loaded from the ${warm.source}, not the snapshot`);
    const r1 = upTo(warm.origin, warm.content);
    put('relaunch.toContent.requests', r1.requests, 'count');
    put('relaunch.toContent.answers', r1.answers, 'count');
    put('relaunch.toContent.bytes', r1.bytes, 'bytes');
    // The app itself from the network: none once the service worker has it.
    put('relaunch.toContent.shell', link.reqs.filter((r) => r.at >= warm.origin && r.at <= warm.content && ['document', 'script', 'style'].includes(r.kind)).length, 'count');
    const r2 = upTo(warm.origin, warm.fresh);
    put('relaunch.toFresh.requests', r2.requests, 'count');
    put('relaunch.toFresh.bytes', r2.bytes, 'bytes');
    await settle(page);
    const s2 = await sockets();
    put('socket.opens', s1.opened + s2.opened, 'count');
    put('socket.drops', s1.dropped + s2.dropped, 'count');
    put('socket.closes', s1.closed + s2.closed, 'count');
    put('socket.pings', s1.pings + s2.pings, 'count');
    put('socket.resyncs', coldFresh + (await freshes()) - 2, 'count');
    put('socket.pongMax', Math.max(s1.pongMax, s2.pongMax));
    log(link.reqs.slice(n0), warm.origin);
    if (page.errors.length) console.warn('page errors:', page.errors.slice(0, 5));
  } finally {
    await b.close();
    link.close();
  }
  return m;
}

/** Bytes of a request's answer that had reached the browser by `t`. */
function bytesBy(r: Req, t: number) {
  let n = 0;
  for (const [at, k] of r.arrivals) if (at <= t) n += k;
  return n;
}
/** For --out: each request, its times from the page's start. */
function log(reqs: Req[], origin: number) {
  const ms = (t: number) => (t ? Math.round(t - origin) : null);
  slowLog.push(reqs.map((r) => [r.kind, r.path, r.dest, ms(r.at), ms(r.first), ms(r.last), r.bytes]));
}

/**
 * What fetching ahead left on the device when the next rows were not all kept: the rows on screen (each marked K when
 * its page is in IndexedDB, F when it was fetched ahead), the pages fetched ahead, and every key in the page store.
 */
async function aheadDump(page: Page, wanted: string[]): Promise<string> {
  const x = await page
    .eval<{ rows: string[]; ahead: string[]; opens: Record<string, number>; idle: boolean; keys: string[] | null }>(
      `new Promise((res) => {
        const a = window.__ditherAhead ?? {};
        const out = { rows: [...document.querySelectorAll('.side-scroll [data-row]')].slice(0, 20).map((e) => e.getAttribute('data-row')), ahead: a.pages ?? [], opens: a.opens ?? {}, idle: !!a.idle, keys: null };
        const r = indexedDB.open('dither-chat');
        r.onerror = () => res(out);
        r.onsuccess = () => {
          try {
            const t = r.result.transaction('pages');
            const k = t.objectStore('pages').getAllKeys();
            t.oncomplete = () => (r.result.close(), res({ ...out, keys: k.result.map(String) }));
            t.onerror = () => res(out);
          } catch (e) { res(out); }
        };
      })`,
    )
    .catch((e) => e as Error);
  if (x instanceof Error) return `  (no dump: ${x.message})`;
  const keyOf = (row: string) => (row.startsWith('person:') ? `p:${row.slice('person:'.length)}` : `c:${row}`);
  const keys = new Set(x.keys ?? []);
  const ahead = new Set(x.ahead);
  const mark = (key: string) => `${keys.has(key) ? 'K' : '-'}${ahead.has(key) ? 'F' : '-'}`;
  return [
    `  wanted: ${wanted.map((w) => `${w} ${mark(w)}`).join(', ')} (K kept in IndexedDB, F fetched ahead)`,
    `  rows on screen: ${x.rows.map((r, i) => `${i + 1}.${r} ${mark(keyOf(r))}`).join(', ')}`,
    `  fetched ahead (${x.ahead.length}${x.idle ? ', idle' : ', still going'}): ${x.ahead.join(' ')}; opens ${JSON.stringify(x.opens)}`,
    `  IndexedDB pages (${x.keys?.length ?? 'unreadable'}): ${(x.keys ?? []).join(' ')}`,
  ].join('\n');
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

// ------------------------------------------------------------------ builds in turn (--ab)

/** Serve `dir` from now on: the hub's --web is a link, swapped whole between runs (never while a browser is open). */
function useBuild(dir: string) {
  const link = join(work, 'web-ab');
  const next = `${link}.next`;
  rmSync(next, { force: true });
  symlinkSync(dir, next);
  renameSync(next, link);
}

/**
 * Each build's medians and ranges side by side, with each build's difference from A and how sure it is (`p`, an exact
 * Mann-Whitney test of its runs against A's: how often the runs dealt to the builds at random split as far apart). Ceilings
 * and floors are judged for every build; nothing goes against a baseline. Returns how many were over a ceiling or floor.
 */
function abReport(builds: { label: string; dir: string }[], runsOf: Record<string, Record<string, Metrics[]>>, hub: Metrics, world: World): number {
  const [a, ...rest] = builds;
  console.log(`\n${builds.map((b) => `${b.label}: ${b.dir}`).join('\n')}`);
  console.log(`${RUNS} runs of each, in turn${WARMUP && CPUS.length ? `, after ${WARMUP} warm-up run${WARMUP > 1 ? 's' : ''} of A at each desktop throttle` : ''}; median (lowest–highest). p: how often a random split of the runs is as far apart (under 0.05 marked *; with five runs each the least it can be is 0.008, with three 0.1).`);
  for (const [k, m] of Object.entries(hub)) console.log(`${k.padEnd(34)} ${m.v} (the hub's own: the same for every build)`);
  const cell = (xs: number[]) => (xs.length ? `${median(xs)} (${Math.min(...xs)}–${Math.max(...xs)})` : '-');
  console.log(`\n${'metric'.padEnd(34)} ${`${a.label}`.padStart(26)}${rest.map((b) => `${b.label.padStart(26)} ${`${b.label}−${a.label}`.padStart(8)} ${'%'.padStart(6)} ${'p'.padStart(6)}`).join('')}`);
  let failed = 0;
  const out: Record<string, { metrics: Metrics; runs: Record<string, Metrics[]> }> = {};
  for (const b of builds) out[b.label] = { metrics: {}, runs: runsOf[b.label] };
  for (const key of Object.keys(runsOf[a.label])) {
    const names = [...new Set(builds.flatMap((b) => runsOf[b.label][key].flatMap((r) => Object.keys(r))))];
    for (const k of names) {
      const of = (b: { label: string }) => runsOf[b.label][key].map((r) => r[k]?.v).filter((x): x is number => x !== undefined);
      const kind = builds.map((b) => runsOf[b.label][key].find((r) => r[k])?.[k].kind).find(Boolean)!;
      const flags: string[] = [];
      for (const b of builds) {
        const xs = of(b);
        if (!xs.length) continue;
        const v = median(xs);
        out[b.label].metrics[`${key}x.${k}`] = { v, kind };
        const ceiling = CEILINGS[k];
        const floor = FLOORS[k];
        if (ceiling !== undefined && v > ceiling) flags.push(`${b.label} over its ceiling of ${ceiling}`);
        if (floor !== undefined && v < floor) flags.push(`${b.label} under its floor of ${floor}`);
      }
      failed += flags.length;
      const xa = of(a);
      const cols = rest.map((b) => {
        const xb = of(b);
        if (!xa.length || !xb.length) return `${cell(xb).padStart(26)} ${''.padStart(8)} ${''.padStart(6)} ${''.padStart(6)}`;
        const d = median(xb) - median(xa);
        const p = mannWhitneyP(xa, xb);
        const pct = median(xa) ? `${d >= 0 ? '+' : ''}${Math.round((d / median(xa)) * 100)}%` : '';
        return `${cell(xb).padStart(26)} ${`${d >= 0 ? '+' : ''}${Math.round(d * 10) / 10}`.padStart(8)} ${pct.padStart(6)} ${`${p.toFixed(2)}${p < 0.05 ? '*' : ' '}`.padStart(6)}`;
      });
      const note = [kind === 'ms' ? '' : `(${kind})`, flags.length ? `FAIL: ${flags.join(', ')}` : ''].filter(Boolean).join(' ');
      console.log(`${(flags.length ? 'FAIL ' : '     ') + `${key}x.${k}`.padEnd(29)} ${cell(xa).padStart(26)}${cols.join('')}${note ? `  ${note}` : ''}`);
    }
  }
  if (OUT) writeFileSync(OUT, JSON.stringify({ world, hub, ab: builds.map((b) => ({ ...b, ...out[b.label] })), ...(slowLog.length ? { slowRequests: slowLog } : {}) }, null, 1));
  console.log(failed ? `\n${failed} over a ceiling or under a floor` : '\nevery build within the ceilings and floors');
  return failed;
}

/** Two-sided exact Mann-Whitney p of two samples (mid-ranks for ties); a normal approximation past 200,000 splits. */
function mannWhitneyP(a: number[], b: number[]): number {
  const all = [...a, ...b];
  const n = all.length;
  const k = a.length;
  const order = all.map((v, i) => [v, i]).sort((x, y) => x[0] - y[0]);
  const rank: number[] = [];
  for (let i = 0; i < n; ) {
    let j = i;
    while (j + 1 < n && order[j + 1][0] === order[i][0]) j++;
    for (let t = i; t <= j; t++) rank[order[t][1]] = (i + j) / 2 + 1;
    i = j + 1;
  }
  const mid = (k * (n + 1)) / 2;
  const seen = Math.abs(rank.slice(0, k).reduce((s, r) => s + r, 0) - mid);
  let splits = 1;
  for (let i = 0; i < k; i++) splits = (splits * (n - i)) / (i + 1);
  if (splits > 200_000) {
    const z = seen / Math.sqrt((k * (n - k) * (n + 1)) / 12);
    // 1 - erf(z / √2), Abramowitz and Stegun 7.1.26.
    const x = z / Math.SQRT2;
    const t = 1 / (1 + 0.3275911 * x);
    return Math.min(1, t * (0.254829592 + t * (-0.284496736 + t * (1.421413741 + t * (-1.453152027 + t * 1.061405429)))) * Math.exp(-x * x));
  }
  let as = 0;
  const pick = (from: number, left: number, sum: number) => {
    if (!left) return void (Math.abs(sum - mid) >= seen - 1e-9 && as++);
    for (let i = from; i <= n - left; i++) pick(i + 1, left - 1, sum + rank[i]);
  };
  pick(0, k, 0);
  return as / splits;
}

// ------------------------------------------------------------------ worlds kept to reuse (--keep-world, --age, --world)

/** A kept world's world.json. Its data dir beside it is the hub's, as seeded (or aged): each run works on a copy. */
interface Kept {
  format: number;
  scale: number;
  /** perf-world.ts's anchor: the last midnight less a minute, the day it was seeded. */
  anchor: number;
  /** A hash of each file that seeds it or lays out its database. */
  code: Record<string, string>;
  seededAt: number;
  world: Omit<World, 'ms'>;
  /** Kept as the ahead pass first found the hub (--age): after what, and the rows that pass then saw. */
  aged?: { before: string; at: number; rows?: string[]; scores?: Scores; atRows?: Scores };
}
const KEPT_FORMAT = 1;
/** The hub's inbox scores (bootstrap `attention`), the 40 best: what a changed order is explained by. */
type Scores = { id: string; score: number; reasons: string[] }[];
async function scores(): Promise<Scores> {
  const boot = await getJson('/api/bootstrap');
  return ((boot.attention ?? []) as Scores).sort((a, b) => b.score - a.score).slice(0, 40).map(({ id, score, reasons }) => ({ id, score: Math.round(score * 10) / 10, reasons }));
}
/** What seeds the world and what its database looks like: one changed, a kept world may not be what a seed gives now. */
const WORLD_CODE = ['scripts/perf-world.ts', 'packages/hub/src/demo.ts', 'packages/hub/src/store.ts', 'packages/hub/src/schema.sql', 'packages/protocol/src/ids.ts'];
function worldCode(): Record<string, string> {
  const mail = readdirSync(join(root, 'packages/hub/src/mail')).filter((f) => /^schema(?:-[\w-]+)?\.sql$/.test(f)).sort().map((f) => `packages/hub/src/mail/${f}`);
  return Object.fromEntries([...WORLD_CODE, ...mail].map((f) => [f, createHash('sha256').update(readFileSync(join(root, f))).digest('hex').slice(0, 16)]));
}

/** A dir for a kept world: new, empty, or one kept before (replaced). Never anything else. */
function keepDir(dir: string) {
  if (existsSync(dir) && readdirSync(dir).length && !existsSync(join(dir, 'world.json'))) throw new Error(`${dir} is not empty and holds no kept world: not overwriting it`);
  rmSync(join(dir, 'world.json'), { force: true });
  rmSync(join(dir, 'data'), { recursive: true, force: true });
  mkdirSync(dir, { recursive: true });
}
function stamp(world: World, aged?: Kept['aged']): Kept {
  const { ms: _, ...w } = world;
  return { format: KEPT_FORMAT, scale: SCALE, anchor: worldAnchor(), code: worldCode(), seededAt: Date.now(), world: w, ...(aged ? { aged } : {}) };
}
function copyDir(from: string, to: string) {
  // A reflink where the disk has them: a full-size world is about a gigabyte.
  const r = Bun.spawnSync(['cp', '-a', '--reflink=auto', from, to], { stderr: 'pipe' });
  if (r.exitCode !== 0) throw new Error(`copying ${from}: ${r.stderr.toString()}`);
}

/** The world as seeded, before the hub ever ran on it. */
function keepWorld(dir: string, data: string, world: World) {
  keepDir(dir);
  copyDir(data, join(dir, 'data'));
  writeFileSync(join(dir, 'world.json'), JSON.stringify(stamp(world), null, 1));
  console.log(`kept the world in ${dir}: reuse it with --world ${dir}`);
}

/**
 * The hub as the ahead pass first finds it, after the passes before it and once its journal stands still: its
 * databases copied while it runs (VACUUM INTO, a consistent copy; AGENTS.md), with the rest of its data dir. The ahead pass's first rows are added once it has run.
 */
async function ageWorld(dir: string, data: string, world: World, before: string) {
  // What the last pages sent as they closed (their visits go to the hub as a browser closes) is in first: else it can
  // land after the ahead pass has drawn its list, which a copy that has it would then not match.
  await journalStill();
  const t0 = performance.now();
  keepDir(dir);
  const tmp = join(dir, 'data.part');
  rmSync(tmp, { recursive: true, force: true });
  mkdirSync(tmp);
  const at = Date.now();
  const scored = await scores();
  // Each database (the hub's, and its auth and approvals) as one consistent copy; the rest of the dir as it is.
  for (const f of readdirSync(data)) {
    if (/\.sqlite-(wal|shm)$|^traces$|^backups$/.test(f)) continue;
    if (!f.endsWith('.sqlite')) {
      cpSync(join(data, f), join(tmp, f), { recursive: true });
      continue;
    }
    const db = new Database(join(data, f), { readonly: true });
    try {
      db.exec(`VACUUM INTO '${join(tmp, f).replaceAll("'", "''")}'`);
    } finally {
      db.close();
    }
  }
  renameSync(tmp, join(dir, 'data'));
  writeFileSync(join(dir, 'world.json'), JSON.stringify(stamp(world, { before, at, scores: scored }), null, 1));
  console.log(`aged the world in ${dir} after ${before}, in ${((performance.now() - t0) / 1000).toFixed(1)} s`);
}
function keepAheadRows(dir: string, rows: string[], atRows: Scores) {
  const k = JSON.parse(readFileSync(join(dir, 'world.json'), 'utf8')) as Kept;
  k.aged!.rows = rows;
  k.aged!.atRows = atRows;
  writeFileSync(join(dir, 'world.json'), JSON.stringify(k, null, 1));
  console.log(`the ahead pass's first rows, kept with the aged world: ${rows.join(' ')}`);
}
/** The aged world must give the ahead pass the inbox the run that aged it saw: else it measures another order. */
function checkAheadRows(k: Kept, rows: string[], scoresNow: Scores) {
  if (JSON.stringify(rows) === JSON.stringify(k.aged!.rows)) return console.log(`the ahead pass's first rows are the ones the run that aged this world saw (${rows.length})`);
  // The hub's scores then and now, for every row in either list: which moved, and the reasons it gives.
  const then = new Map((k.aged!.atRows ?? k.aged!.scores ?? []).map((x) => [x.id, x]));
  const now = new Map(scoresNow.map((x) => [x.id, x]));
  const ids = [...new Set([...k.aged!.rows!, ...rows].map((r) => r.replace(/^channel:/, '')).filter((r) => r.startsWith('cnv_')))];
  const show = (x?: { score: number; reasons: string[] }) => (x ? `${x.score} (${x.reasons.join('; ') || 'no reasons'})` : 'not among the 40 best');
  const moved = ids.filter((id) => then.get(id)?.score !== now.get(id)?.score).map((id) => `  ${id}: then ${show(then.get(id))}\n  ${' '.repeat(id.length)}  now  ${show(now.get(id))}`);
  throw new Error(`the ahead pass found the inbox in another order than the run that aged this world (${k.aged!.before}) did, so it would measure another order: age it again with --age.\n  then: ${k.aged!.rows!.join(' ')}\n  now:  ${rows.join(' ')}\n${moved.length ? `the hub's scores that moved:\n${moved.join('\n')}` : "the hub's scores did not move: the page ordered them differently"}`);
}

/**
 * What the demo's start took back. Each demo account sends its world again when it starts, with each conversation's
 * read point as the demo began it; the hub counts unread again from there, and a couple of demo chats that a first
 * start leaves with nothing unread come back with two or three (their newest messages sit after the read point the
 * demo gives). A run that never restarts its hub keeps what it had. So once the hub has settled, each conversation
 * whose read point or unread count differs from the aged world's is marked read again as the app marks it (POST
 * …/read): up to the aged read point, or, where the aged world had nothing unread, up to its newest message. Then the
 * hub's 40 best scores are compared with the aging run's.
 */
async function restoreReads(k: Kept, agedDb: string, liveDb: string) {
  type V = { id: string; at: number | null; unread: number; mentions: number; newest: number | null };
  const read = (file: string) => {
    const db = new Database(file, { readonly: true });
    try {
      const rows = db
        .query(
          `SELECT v.target_id id, MAX(v.last_read_ts) at, SUM(v.unread) unread, SUM(v.mentions) mentions, (SELECT MAX(ts) FROM message m WHERE m.conversation_id = v.target_id) newest
           FROM vantage v WHERE v.target_kind = 'conversation' GROUP BY v.target_id`,
        )
        .all() as V[];
      return new Map(rows.map((r) => [r.id, r]));
    } finally {
      db.close();
    }
  };
  const then = read(agedDb);
  const now = read(liveDb);
  const fixes: [string, number][] = [];
  const left: string[] = [];
  for (const [id, t] of then) {
    const n = now.get(id);
    if (!n || (n.at === t.at && n.unread === t.unread && n.mentions === t.mentions)) continue;
    if ((t.at ?? 0) > (n.at ?? 0)) fixes.push([id, t.at!]);
    else if (t.unread === 0 && t.mentions === 0 && n.newest) fixes.push([id, n.newest]);
    else left.push(id);
  }
  for (const [id, at] of fixes) {
    const r = await fetch(`${base}/api/conversations/${id}/read`, { method: 'POST', headers: { 'content-type': 'application/json', origin: base }, body: JSON.stringify({ upToTs: at }) });
    if (!r.ok) throw new Error(`marking ${id} read again: ${r.status}`);
  }
  await journalStill();
  console.log(`marked read again ${fixes.length} conversation${fixes.length === 1 ? '' : 's'} the demo's start had changed${left.length ? `; could not put back ${left.join(' ')}` : ''}`);
  // The hub's view against the aging run's: the same 40, each within a point (scores drift with the minutes since).
  const was = new Map((k.aged!.scores ?? []).map((x) => [x.id, x.score]));
  const is = await scores();
  const off = is.filter((x) => !was.has(x.id) || Math.abs(was.get(x.id)! - x.score) > 1).map((x) => `${x.id} ${was.get(x.id) ?? 'not among them'} → ${x.score}`);
  console.log(off.length ? `the hub's 40 best scores differ from the aging run's: ${off.join(', ')}` : `the hub's 40 best scores are the aging run's, each within a point`);
}

/**
 * A copy of a kept world in `data`, or an error saying why it is stale: another scale, another day (the seed is
 * anchored at the last midnight), or a change to what seeds it. A world kept as seeded is dated as a fresh one
 * would be (the demo accounts' epoch, which dates their own messages, is when it was seeded); an aged one cannot be,
 * and its ahead pass's first rows are checked instead (checkAheadRows).
 */
function reuseWorld(dir: string, data: string): Kept & { ms: number } {
  const t0 = performance.now();
  const file = join(dir, 'world.json');
  if (!existsSync(file)) throw new Error(`--world: no ${file}; keep a world with --keep-world <dir> or --age <dir>`);
  const k = JSON.parse(readFileSync(file, 'utf8')) as Kept;
  const why: string[] = [];
  const day = (t: number) => new Date(t).toISOString().slice(0, 10);
  if (k.format !== KEPT_FORMAT) why.push(`it was kept by another version of this script (format ${k.format}, now ${KEPT_FORMAT})`);
  if (k.scale !== SCALE) why.push(`its scale is ${k.scale}, this run's ${SCALE}`);
  if (k.anchor !== worldAnchor()) why.push(`it was seeded for ${day(k.anchor + 60_000)}, anchored at that day's midnight: today's world would be a day newer`);
  const code = worldCode();
  const changed = [...new Set([...Object.keys(code), ...Object.keys(k.code ?? {})])].filter((f) => code[f] !== k.code?.[f]);
  if (changed.length) why.push(`what seeds it has changed since: ${changed.join(', ')}`);
  if (k.aged && !k.aged.rows) why.push('the run that aged it stopped before its first ahead run');
  if (why.length) throw new Error(`--world ${dir} is stale, so it is not used: ${why.join('; ')}. Keep a new one (--keep-world or --age).`);
  copyDir(join(dir, 'data'), data);
  if (!k.aged) {
    const db = new Database(join(data, 'hub.sqlite'));
    try {
      const now = Date.now();
      db.query(`UPDATE account SET config = json_set(config, '$.epoch', ?), created_at = ? WHERE demo = 1`).run(now, now);
    } finally {
      db.close();
    }
  }
  const ms = Math.round(performance.now() - t0);
  const ago = (t: number) => `${Math.round((Date.now() - t) / 60_000)} min ago`;
  console.log(`a copy of the world kept ${ago(k.seededAt)} in ${dir}${k.aged ? `, aged ${ago(k.aged.at)} after ${k.aged.before}` : ''}, in ${(ms / 1000).toFixed(1)} s:`, JSON.stringify(k.world.counts));
  return { ...k, ms };
}

// ------------------------------------------------------------------ helpers

/** Every run's value of a per-throttle metric ("1x.cold.nodes"), or null for the hub's own. */
function spread(k: string, runs: Record<string, Metrics[]>): number[] | null {
  const m = k.match(/^([pas]?\d+)x\.(.+)$/);
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

/** Until the hub's journal has stood still for five seconds. */
async function journalStill() {
  let seq = -1;
  let still = Date.now();
  while (Date.now() - still < 5000) {
    await Bun.sleep(1000);
    const now = (await getJson('/api/bootstrap')).sync?.seq ?? 0;
    if (now !== seq) (seq = now), (still = Date.now());
  }
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
