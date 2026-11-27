/**
 * Chat scroll-up smoothness and jitter verification under varied device resource constraints
 * (docs/perf.md, "Scrolling up").
 *
 * Reuses scripts/browser.ts (DevTools Protocol CPU throttling & synthesized touch/mouse scrolls),
 * scripts/perf-world.ts (realistic seeded chat history with replies, mentions, reactions and images)
 * and scripts/slowlink.ts (TCP proxy with realistic RTT and bandwidth caps).
 *
 *   bun scripts/verify-scroll-up.ts                                 # desktop, phone, lowend (1 run, 0.1 scale)
 *   bun scripts/verify-scroll-up.ts --profiles desktop,laptop,phone,lowend --runs 3 --scale 1
 *   bun scripts/verify-scroll-up.ts --ab /tmp/ab/base,/tmp/ab/cand --runs 3
 *   bun scripts/verify-scroll-up.ts --ci                            # structural/count checks only, no timing gates
 *   bun scripts/verify-scroll-up.ts --out out/scroll-up.json        # perf-trend.ts compatible output
 */
import { existsSync, mkdirSync, mkdtempSync, openSync, readFileSync, renameSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { launch, type Page } from './browser.ts';
import { seedWorld, type World, type WorldConv } from './perf-world.ts';
import { slowLink } from './slowlink.ts';

const args = process.argv.slice(2);
if (args.includes('--help') || args.includes('-h')) {
  console.log(readFileSync(import.meta.path, 'utf8').split('*/')[0].replace(/^\/\*\*\n/, '').replace(/^ \* ?/gm, ''));
  process.exit(0);
}
const opt = (k: string, d: string) => (args.includes(`--${k}`) ? args[args.indexOf(`--${k}`) + 1] : d);
const CI = args.includes('--ci');
const KEEP = args.includes('--keep');
const VERBOSE = args.includes('--verbose');
const SCALE = Number(opt('scale', '0.1'));
const RUNS = Number(opt('runs', CI ? '1' : '1'));
const GESTURES = Number(opt('gestures', CI ? '6' : '8'));
const OUT = opt('out', '');
const AB = opt('ab', '').split(',').filter(Boolean).map((d) => resolve(d));
if (AB.length === 1) throw new Error('--ab wants two builds or more, separated by commas');
for (const d of AB) if (!existsSync(join(d, 'index.html'))) throw new Error(`--ab: ${d} is not a built web app (no index.html)`);

interface Profile {
  name: string;
  width: number;
  height: number;
  mobile: boolean;
  cpu: number;
  /** Network throttling via slowLink (null = loopback). */
  link: { rtt: number; down: number; up: number } | null;
  source: 'default' | 'mouse';
  /** Distance per upward scroll gesture (CSS px) and speed (px/s). */
  distance: number;
  speed: number;
}

const ALL_PROFILES: Record<string, Profile> = {
  desktop: { name: 'desktop', width: 1280, height: 800, mobile: false, cpu: 1, link: null, source: 'mouse', distance: 2200, speed: 2400 },
  laptop: { name: 'laptop', width: 1280, height: 800, mobile: false, cpu: 4, link: { rtt: 40, down: 50e6, up: 20e6 }, source: 'mouse', distance: 2200, speed: 2200 },
  // Headless Chromium's touch gesture synthesizer stops after touchstart on HiDPI emulated mobile; 'default' drives real smooth compositor scroll on the phone layout.
  phone: { name: 'phone', width: 390, height: 844, mobile: true, cpu: 4, link: { rtt: 80, down: 20e6, up: 10e6 }, source: 'default', distance: 2400, speed: 1800 },
  lowend: { name: 'lowend', width: 390, height: 844, mobile: true, cpu: 6, link: { rtt: 300, down: 1.6e6, up: 0.75e6 }, source: 'default', distance: 2400, speed: 1800 },
};

const profileNames = opt('profiles', CI ? 'desktop,phone' : 'desktop,laptop,phone,lowend').split(',').filter(Boolean);
const PROFILES: Profile[] = profileNames.map((name) => {
  const p = ALL_PROFILES[name];
  if (!p) throw new Error(`unknown profile: ${name} (${Object.keys(ALL_PROFILES).join(', ')})`);
  return CI ? { ...p, cpu: 1, link: name === 'phone' ? { rtt: 80, down: 20e6, up: 10e6 } : null } : p;
});

type Kind = 'ms' | 'count' | 'tally' | 'frames' | 'px';
type Metrics = Record<string, { v: number; kind: Kind; runs?: number[] }>;

const root = resolve(import.meta.dir, '..');
const work = mkdtempSync(join(tmpdir(), 'dither-scroll-up-'));
const running: { hub?: ReturnType<typeof Bun.spawn> } = {};

/** Long-task observer installed before app scripts load. */
const INIT = `(() => {
  window.__perf = { lt: [] };
  try {
    new PerformanceObserver((l) => {
      for (const e of l.getEntries()) __perf.lt.push([e.startTime, e.duration]);
    }).observe({ type: 'longtask', buffered: true });
  } catch (e) {}
})()`;

/**
 * In-page per-frame scroll probe. Tracks:
 * - Frame pacing (dt, p95, max, >33ms jank, >50ms slow)
 * - Visual discontinuities on the center message in view:
 *   - snapBacks: message jumped UP (dTop < -2px) during an upward scroll
 *   - pauseJumps: message moved (|dTop| > 1.5px) while reading (no input)
 * - Top-wall hits: hitting the top edge of drawn content while scrolling up
 * - Spinner visibility, peak DOM nodes / message elements, and upward distance traveled.
 */
const PROBE_START = `(() => {
  const scroller = document.querySelector('.timeline-scroll');
  if (!scroller) throw new Error('no .timeline-scroll');
  const st = {
    active: true,
    phase: 'idle', // 'scroll' | 'settle' | 'pause' | 'idle'
    frames: [],
    lastT: 0,
    trackedId: null,
    trackedTop: 0,
    snapBacks: 0,
    snapMaxPx: 0,
    snapTotalPx: 0,
    pauseJumps: 0,
    pauseMaxPx: 0,
    pauseTotalPx: 0,
    wallHits: 0,
    wallHitFrames: 0,
    wallStallMs: 0,
    inWall: false,
    spinnerShows: 0,
    spinnerFrames: 0,
    inSpinner: false,
    distancePx: 0,
    peakMsgs: 0,
    peakNodes: 0,
    events: [],
    seenIds: new Set(),
  };
  const pickCenter = () => {
    const box = scroller.getBoundingClientRect();
    const mid = box.top + box.height * 0.5;
    let best = null;
    let bestDist = Infinity;
    for (const el of scroller.querySelectorAll('.msg[id]')) {
      const r = el.getBoundingClientRect();
      if (r.bottom < box.top + 8 || r.top > box.bottom - 8) continue;
      const d = Math.abs((r.top + r.height / 2) - mid);
      if (d < bestDist) {
        bestDist = d;
        best = { id: el.id, top: r.top };
      }
    }
    return best;
  };
  const step = (now) => {
    const dt = st.lastT ? now - st.lastT : 0;
    st.lastT = now;
    if (dt > 0) st.frames.push(dt);
    const box = scroller.getBoundingClientRect();
    const cur = st.trackedId ? document.getElementById(st.trackedId) : null;
    if (cur) {
      const r = cur.getBoundingClientRect();
      const dTop = r.top - st.trackedTop;
      st.trackedTop = r.top;
      if (dTop > 0 && st.phase === 'scroll') st.distancePx += dTop;
      if (st.phase === 'scroll' && dTop < -2) {
        const px = Math.abs(dTop);
        st.snapBacks++;
        st.snapTotalPx += px;
        if (px > st.snapMaxPx) st.snapMaxPx = px;
        if (st.events.length < 30) st.events.push({ kind: 'snap', t: Math.round(now), px: Math.round(px), id: st.trackedId, scrollTop: Math.round(scroller.scrollTop) });
      } else if (st.phase === 'pause' && Math.abs(dTop) > 1.5) {
        const px = Math.abs(dTop);
        st.pauseJumps++;
        st.pauseTotalPx += px;
        if (px > st.pauseMaxPx) st.pauseMaxPx = px;
        if (st.events.length < 30) st.events.push({ kind: 'pauseJump', t: Math.round(now), px: Math.round(dTop), id: st.trackedId, scrollTop: Math.round(scroller.scrollTop) });
      }
      // Re-pick center message if tracked one scrolled near or out of viewport bounds.
      if (r.top < box.top + 20 || r.bottom > box.bottom - 20) {
        const next = pickCenter();
        st.trackedId = next?.id ?? null;
        st.trackedTop = next?.top ?? 0;
      }
    } else {
      const next = pickCenter();
      st.trackedId = next?.id ?? null;
      st.trackedTop = next?.top ?? 0;
    }
    const msgs = scroller.querySelectorAll('.msg[id]');
    if (msgs.length > st.peakMsgs) st.peakMsgs = msgs.length;
    for (const m of msgs) st.seenIds.add(m.id);
    // Check top-wall hit: within 4px of top edge while scrolling up and no timeline-start marker.
    const rem = scroller.scrollHeight + scroller.scrollTop - scroller.clientHeight;
    const atStart = !!scroller.querySelector('.timeline-start');
    const hitWall = !atStart && rem <= 4 && Math.abs(scroller.scrollTop) > 10;
    if (hitWall) {
      st.wallHitFrames++;
      if (dt > 0) st.wallStallMs += dt;
      if (!st.inWall) {
        st.inWall = true;
        st.wallHits++;
        if (st.events.length < 30) st.events.push({ kind: 'wall', t: Math.round(now), rem: Math.round(rem), msgs: msgs.length });
      }
    } else st.inWall = false;
    const spin = !!scroller.querySelector('.loading.inline');
    if (spin) {
      st.spinnerFrames++;
      if (!st.inSpinner) (st.inSpinner = true), st.spinnerShows++;
    } else st.inSpinner = false;
    if (st.frames.length % 10 === 0) {
      const nodes = document.getElementsByTagName('*').length;
      if (nodes > st.peakNodes) st.peakNodes = nodes;
    }
    if (st.active) requestAnimationFrame(step);
  };
  window.__scrollProbe = {
    setPhase(p) {
      st.phase = p;
      const next = pickCenter();
      st.trackedId = next?.id ?? null;
      st.trackedTop = next?.top ?? 0;
    },
    stop() {
      st.active = false;
      const nodes = document.getElementsByTagName('*').length;
      if (nodes > st.peakNodes) st.peakNodes = nodes;
      const sorted = [...st.frames].sort((a, b) => a - b);
      const p95 = sorted[Math.floor(sorted.length * 0.95)] ?? 0;
      const max = sorted.at(-1) ?? 0;
      return {
        frameCount: st.frames.length,
        frameP95: Math.round(p95),
        frameMax: Math.round(max),
        jankFrames: st.frames.filter((d) => d > 33).length,
        slowFrames: st.frames.filter((d) => d > 50).length,
        snapBacks: st.snapBacks,
        snapMaxPx: Math.round(st.snapMaxPx),
        snapTotalPx: Math.round(st.snapTotalPx),
        pauseJumps: st.pauseJumps,
        pauseMaxPx: Math.round(st.pauseMaxPx),
        pauseTotalPx: Math.round(st.pauseTotalPx),
        wallHits: st.wallHits,
        wallStallMs: Math.round(st.wallStallMs),
        spinnerShows: st.spinnerShows,
        spinnerFrames: st.spinnerFrames,
        distancePx: Math.round(st.distancePx),
        peakMsgs: st.peakMsgs,
        peakNodes: st.peakNodes,
        uniqueMsgs: st.seenIds.size,
        events: st.events,
      };
    },
  };
  requestAnimationFrame(step);
})()`;

interface ProbeResult {
  frameCount: number;
  frameP95: number;
  frameMax: number;
  jankFrames: number;
  slowFrames: number;
  snapBacks: number;
  snapMaxPx: number;
  snapTotalPx: number;
  pauseJumps: number;
  pauseMaxPx: number;
  pauseTotalPx: number;
  wallHits: number;
  wallStallMs: number;
  spinnerShows: number;
  spinnerFrames: number;
  distancePx: number;
  peakMsgs: number;
  peakNodes: number;
  uniqueMsgs: number;
  events: unknown[];
}

function freePort(): number {
  const s = Bun.listen({ hostname: '127.0.0.1', port: 0, socket: { data() {} } });
  const p = s.port;
  s.stop(true);
  return p;
}

function median(xs: number[]): number {
  const s = [...xs].sort((a, b) => a - b);
  return s.length % 2 ? s[(s.length - 1) / 2] : Math.round((s[s.length / 2 - 1] + s[s.length / 2]) / 2);
}

function useBuild(dir: string) {
  const link = join(work, 'web-ab');
  const next = `${link}.next`;
  rmSync(next, { force: true });
  symlinkSync(dir, next);
  renameSync(next, link);
}

async function getMetrics(page: Page) {
  const r = await page.send<{ metrics: { name: string; value: number }[] }>('Performance.getMetrics');
  return Object.fromEntries(r.metrics.map((x) => [x.name, x.value])) as Record<string, number>;
}
const getRenders = (page: Page) => page.eval<Record<string, number>>('({ ...window.__ditherPerf.renders })');
const getMounts = (page: Page) => page.eval<Record<string, number>>('({ ...window.__ditherPerf.components.mounts })');

async function settle(page: Page, quietMs = 450, maxMs = 5000) {
  let last = JSON.stringify(await getRenders(page));
  let still = Date.now();
  const end = Date.now() + maxMs;
  while (Date.now() < end && Date.now() - still < quietMs) {
    await Bun.sleep(100);
    const now = JSON.stringify(await getRenders(page));
    if (now !== last) (last = now), (still = Date.now());
  }
}

async function runProfile(hubPort: number, conv: WorldConv, prof: Profile): Promise<{ metrics: Metrics; events: unknown[] }> {
  const link = prof.link ? await slowLink({ target: hubPort, ...prof.link }) : null;
  const origin = `http://127.0.0.1:${link ? link.port : hubPort}`;
  const b = await launch();
  const page = b.page;
  try {
    await page.size(prof.width, prof.height, prof.mobile);
    await page.send('Performance.enable');
    if (prof.cpu > 1) await page.send('Emulation.setCPUThrottlingRate', { rate: prof.cpu });
    await page.send('Page.addScriptToEvaluateOnNewDocument', { source: INIT });

    await page.goto(`${origin}/?perf=1&ahead=0#/inbox/c/${conv.id}`);
    // Wait until bootstrap, timeline open, and initial slices/read-marking have settled (as verify-perf.ts does),
    // so startup loads never leak into the scroll measurement window.
    await page.until(`window.__ditherPerf && performance.getEntriesByName('dither:fresh').length > 0 && performance.getEntriesByName('dither:timeline').length > 0 && document.querySelectorAll('.timeline-scroll .msg').length >= 15`, 60_000);
    await settle(page, 800, 10_000);

    // Measure baseline before scrolling begins.
    const r0 = await getRenders(page);
    const mt0 = await getMounts(page);
    const m0 = await getMetrics(page);
    const lt0 = await page.eval<number>('__perf.lt.length');
    const reqsBefore = link ? link.reqs.length : await page.eval<number>(`performance.getEntriesByType('resource').length`);
    const initialMsgs = await page.eval<number>(`document.querySelectorAll('.timeline-scroll .msg[id]').length`);

    await page.eval(PROBE_START);
    const at = await page.eval<{ x: number; y: number }>(`(() => {
      const r = document.querySelector('.timeline-scroll').getBoundingClientRect();
      return { x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2) };
    })()`);

    for (let i = 0; i < GESTURES; i++) {
      await page.eval(`window.__scrollProbe.setPhase('scroll')`);
      // Positive yDistance scrolls UP (content moves down).
      await page.send('Input.synthesizeScrollGesture', {
        x: at.x,
        y: at.y,
        yDistance: prof.distance,
        speed: prof.speed,
        gestureSourceType: prof.source,
      });
      // Alternate rapid back-to-back flicks (short gap) and reading pauses (check settling jitter).
      if (i % 2 === 1) {
        // Brief deceleration settle before checking stationary reading stability.
        await page.eval(`window.__scrollProbe.setPhase('settle')`);
        await Bun.sleep(150);
        await page.eval(`window.__scrollProbe.setPhase('pause')`);
        await Bun.sleep(450);
      } else {
        await Bun.sleep(120);
      }
    }
    // Final pause to observe any late settling jumps after scrolling ends.
    await page.eval(`window.__scrollProbe.setPhase('settle')`);
    await Bun.sleep(150);
    await page.eval(`window.__scrollProbe.setPhase('pause')`);
    await Bun.sleep(500);

    const probe = await page.eval<ProbeResult>(`window.__scrollProbe.stop()`);
    const r1 = await getRenders(page);
    const mt1 = await getMounts(page);
    const m1 = await getMetrics(page);
    const lts = await page.eval<[number, number][]>(`__perf.lt.slice(${lt0})`);
    const pagesFetched = link
      ? link.reqs.slice(reqsBefore).filter((r) => r.kind === 'pages').length
      : await page.eval<number>(`performance.getEntriesByType('resource').slice(${reqsBefore}).filter((r) => /\\/messages\\?/.test(r.name)).length`);
    const totalMsgRenders = (r1.MessageItem ?? 0) - (r0.MessageItem ?? 0);
    // Find mounts of MessageItem (unminified or minified: any extra renders beyond unique new messages drawn).
    const newUnique = Math.max(0, probe.uniqueMsgs - initialMsgs);
    const redundantMsgRenders = Math.max(0, totalMsgRenders - newUnique);
    const totalMountsDelta = Object.values(mt1).reduce((s, v) => s + v, 0) - Object.values(mt0).reduce((s, v) => s + v, 0);
    void totalMountsDelta;

    if (page.errors.length) throw new Error(`page errors in ${prof.name}: ${page.errors.slice(0, 3).join('; ')}`);
    if (probe.distancePx < 500) throw new Error(`${prof.name} barely scrolled (${probe.distancePx}px)`);

    const out: Metrics = {};
    const put = (k: string, v: number, kind: Kind) => (out[k] = { v: Math.round(v), kind });
    put('frameP95', probe.frameP95, 'ms');
    put('frameMax', probe.frameMax, 'ms');
    put('jankFrames', probe.jankFrames, 'frames');
    put('slowFrames', probe.slowFrames, 'frames');
    put('snapBacks', probe.snapBacks, 'count');
    put('snapMaxPx', probe.snapMaxPx, 'px');
    put('pauseJumps', probe.pauseJumps, 'count');
    put('pauseMaxPx', probe.pauseMaxPx, 'px');
    put('wallHits', probe.wallHits, 'count');
    put('wallStallMs', probe.wallStallMs, 'ms');
    put('spinnerShows', probe.spinnerShows, 'count');
    put('distancePx', probe.distancePx, 'px');
    put('uniqueMsgs', probe.uniqueMsgs, 'count');
    put('pagesFetched', pagesFetched, 'count');
    put('messageRenders', totalMsgRenders, 'tally');
    put('redundantRenders', redundantMsgRenders, 'tally');
    put('timelineRenders', (r1.Timeline ?? 0) - (r0.Timeline ?? 0), 'tally');
    put('appRenders', (r1.App ?? 0) - (r0.App ?? 0), 'tally');
    put('sidebarRenders', (r1.InboxSidebar ?? 0) - (r0.InboxSidebar ?? 0), 'tally');
    put('layouts', m1.LayoutCount - m0.LayoutCount, 'tally');
    put('longestTask', Math.max(0, ...lts.map((t) => t[1])), 'ms');
    put('busyMs', (m1.TaskDuration - m0.TaskDuration) * 1000, 'ms');
    put('peakMsgs', probe.peakMsgs, 'count');
    put('peakNodes', probe.peakNodes, 'count');
    return { metrics: out, events: probe.events };
  } finally {
    await b.close();
    link?.close();
  }
}

async function main() {
  mkdirSync(work, { recursive: true });
  let web = opt('web', '');
  if (!web && !AB.length) {
    web = join(work, 'web');
    console.log('building the web app…');
    const b = Bun.spawnSync(['bunx', '--bun', 'vite', 'build', '--outDir', web, '--emptyOutDir'], { cwd: join(root, 'packages/web'), stdout: 'ignore', stderr: 'pipe' });
    if (b.exitCode !== 0) throw new Error('web build failed:\n' + b.stderr.toString());
  }
  const data = join(work, 'data');
  const world: World = seedWorld(data, { scale: SCALE });
  console.log(`seeded world (scale=${SCALE}, big=${world.open[0].messages} msgs) in ${(world.ms / 1000).toFixed(1)}s`);

  if (AB.length) {
    web = join(work, 'web-ab');
    useBuild(AB[0]);
  }
  const port = freePort();
  const log = openSync(join(work, 'hub.log'), 'a');
  running.hub = Bun.spawn(['bun', join(root, 'packages/hub/src/main.ts'), '--demo', '--data', data, '--port', String(port), '--host', '127.0.0.1', '--web', web], {
    env: { ...process.env, DITHER_DEMO_CHATTER: '0', DITHER_CALENDAR_URL: 'off' },
    stdout: log,
    stderr: log,
  });
  const base = `http://127.0.0.1:${port}`;
  const end = Date.now() + 90_000;
  while (!(await fetch(`${base}/api/health`).then((r) => r.ok, () => false))) {
    if (Date.now() > end || running.hub.exitCode !== null) throw new Error('hub did not start:\n' + readFileSync(join(work, 'hub.log'), 'utf8').slice(-2000));
    await Bun.sleep(200);
  }
  // Wait for demo accounts online and the hub's startup journal to stand still (as verify-perf.ts does),
  // so startup demo events don't fire InboxSidebar renders during the first scroll run.
  const accEnd = Date.now() + 30_000;
  while (Date.now() < accEnd) {
    const boot = (await fetch(`${base}/api/bootstrap`).then((r) => r.json())) as { accounts: { status: string; demo?: boolean }[] };
    if (boot.accounts.every((a) => a.status === 'online')) {
      if (!boot.accounts.every((a) => a.demo)) throw new Error('not a demo hub');
      break;
    }
    await Bun.sleep(200);
  }
  let seq = -1;
  let still = Date.now();
  while (Date.now() - still < 5000) {
    await Bun.sleep(1000);
    const now = ((await fetch(`${base}/api/bootstrap`).then((r) => r.json())) as { sync?: { seq?: number } }).sync?.seq ?? 0;
    if (now !== seq) (seq = now), (still = Date.now());
  }

  const big = world.open[0];
  const builds = AB.length ? AB.map((dir, i) => ({ label: String.fromCharCode(65 + i), dir })) : [{ label: '', dir: web }];
  const allRuns: Record<string, Record<string, Metrics[]>> = Object.fromEntries(builds.map((b) => [b.label, Object.fromEntries(PROFILES.map((p) => [p.name, []]))]));

  for (const prof of PROFILES) {
    for (let r = 0; r < RUNS; r++) {
      for (const { label, dir } of r % 2 ? [...builds].reverse() : builds) {
        if (AB.length) useBuild(dir);
        const res = await runProfile(port, big, prof);
        allRuns[label][prof.name].push(res.metrics);
        const m = res.metrics;
        const tag = `${label ? `${label} ` : ''}${prof.name} #${r + 1}`;
        console.log(
          `${tag.padEnd(14)} p95=${String(m.frameP95.v).padStart(3)}ms max=${String(m.frameMax.v).padStart(4)}ms jank=${String(m.jankFrames.v).padStart(2)} slow=${String(m.slowFrames.v).padStart(2)} | ` +
            `snaps=${m.snapBacks.v}(${m.snapMaxPx.v}px) pauseJumps=${m.pauseJumps.v}(${m.pauseMaxPx.v}px) | ` +
            `walls=${m.wallHits.v}(${m.wallStallMs.v}ms) spin=${m.spinnerShows.v} | ` +
            `dist=${m.distancePx.v}px msgs=${m.uniqueMsgs.v} peak=${m.peakMsgs.v}/${m.peakNodes.v} | ` +
            `msgR=${m.messageRenders.v}(red=${m.redundantRenders.v}) tlR=${m.timelineRenders.v} lay=${m.layouts.v} lt=${m.longestTask.v}ms busy=${m.busyMs.v}ms`,
        );
        if (VERBOSE && res.events.length) console.log('   events:', JSON.stringify(res.events.slice(0, 12)));
      }
    }
  }

  const flat: Metrics = {};
  if (!AB.length) {
    for (const prof of PROFILES) {
      const list = allRuns[''][prof.name];
      for (const k of Object.keys(list[0])) {
        const xs = list.map((x) => x[k].v);
        flat[`${prof.name}.${k}`] = { v: median(xs), kind: list[0][k].kind, runs: xs };
      }
    }
    if (OUT) writeFileSync(OUT, JSON.stringify({ scale: SCALE, gestures: GESTURES, runs: RUNS, metrics: flat }, null, 1) + '\n');
  } else {
    console.log('\n=== A/B MEDIAN COMPARISON ===');
    const [a, ...rest] = builds;
    console.log(`${'metric'.padEnd(28)} ${a.label.padStart(10)}${rest.map((b) => `${b.label.padStart(10)} ${'diff'.padStart(10)}`).join('')}`);
    for (const prof of PROFILES) {
      const keys = Object.keys(allRuns[a.label][prof.name][0]);
      for (const k of keys) {
        const av = median(allRuns[a.label][prof.name].map((x) => x[k].v));
        const cols = rest
          .map((b) => {
            const bv = median(allRuns[b.label][prof.name].map((x) => x[k].v));
            const d = bv - av;
            const pct = av ? `${d >= 0 ? '+' : ''}${Math.round((d / av) * 100)}%` : d === 0 ? '0' : `${d >= 0 ? '+' : ''}${d}`;
            return `${String(bv).padStart(10)} ${pct.padStart(10)}`;
          })
          .join('');
        console.log(`${`${prof.name}.${k}`.padEnd(28)} ${String(av).padStart(10)}${cols}`);
      }
    }
  }

  // CI structural checks (no timing gates, docs/testing.md).
  let failed = 0;
  if (CI) {
    for (const prof of PROFILES) {
      const m = Object.fromEntries(Object.keys(allRuns[''][prof.name][0]).map((k) => [k, median(allRuns[''][prof.name].map((x) => x[k].v))]));
      const check = (ok: boolean, what: string, got: unknown) => {
        console.log(`${ok ? 'ok  ' : 'FAIL'} [${prof.name}] ${what} (${got})`);
        if (!ok) failed++;
      };
      check(m.snapBacks === 0, 'no upward scroll snap-backs', `${m.snapBacks}, max ${m.snapMaxPx}px`);
      check(m.pauseJumps === 0, 'no viewport jumps during pauses', `${m.pauseJumps}, max ${m.pauseMaxPx}px`);
      check(m.appRenders === 0, 'no App renders while scrolling up', m.appRenders);
      check(m.sidebarRenders <= 1, 'no per-page InboxSidebar renders while scrolling up', m.sidebarRenders);
      check(m.redundantRenders <= 25, 'minimal redundant MessageItem renders', m.redundantRenders);
      check(m.uniqueMsgs > 120, 'scrolled across multiple older pages', m.uniqueMsgs);
    }
  }
  return failed;
}

try {
  const failed = await main();
  process.exit(failed ? 1 : 0);
} finally {
  running.hub?.kill();
  await running.hub?.exited;
  if (!KEEP) rmSync(work, { recursive: true, force: true });
}
