/**
 * Every click stays small (docs/perf.md, "Every click"): against a demo hub on the perf world at a tenth of its size,
 * in headless Chromium, on each kind of page, every control on screen is clicked in turn with a real mouse, and what
 * the click drew is counted: each component's renders (from ?perf=1, perf.ts), layouts and style recalculations.
 *
 * A click fails when it draws most of a list again: ten or more of one component on the page, and at least half of
 * them rendered again by the click, as every message did when the details panel opened (2026-11-20). What the click
 * set off counts too, until the page is still: the requests it made, the hub's answers on the socket, what they drew.
 * The app's clocks are held so they never land in a click (INIT); each page runs them, and a visit the hub hears of,
 * as cases of their own (BACKGROUND).
 *
 * scripts/response-known.json lists the lists clicks drew again when this check began, page and control, so that it
 * fails only on new ones. One fixed is said, and `--update` writes the list again: in a pull request it may only
 * shrink, unless the pull request says why a click now has to draw a whole list.
 *
 * Times (click to the next frame, the longest task) are printed and go in the job's summary, never judged: a shared
 * runner's times say little (docs/testing.md, "No timing gates").
 *
 *   bun scripts/verify-response.ts                       # builds the app, seeds a world, starts a hub of its own
 *   bun scripts/verify-response.ts --web <dist>          # a build to use (built with --minify false: it reads names)
 *   bun scripts/verify-response.ts --only <text>         # pages or controls whose name has this in it
 *   bun scripts/verify-response.ts --out <file.json>     # every click's numbers
 *   bun scripts/verify-response.ts --cpu 4               # slower, to see the times as a slower machine would
 *   bun scripts/verify-response.ts --shard 2/4           # every fourth page from the second, as CI's jobs run it
 *   bun scripts/verify-response.ts --update              # writes scripts/response-known.json from this run
 *
 * Clicks change the demo world (a rule set, a chat read): each page has a hub of its own on a fresh copy of the
 * world, and starts from a fresh load with its settings back to the defaults, so a page reads the same in any run or
 * part. Nothing that sends, deletes, leaves, calls or signs out is
 * pressed (SKIP).
 */
import { appendFileSync, cpSync, existsSync, mkdtempSync, openSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Database } from 'bun:sqlite';
import { launch, type Page } from './browser.ts';
import { seedWorld } from './perf-world.ts';

const argv = process.argv.slice(2);
const opt = (name: string, dflt: string) => {
  const i = argv.indexOf(`--${name}`);
  return i >= 0 && argv[i + 1] ? argv[i + 1] : dflt;
};
const root = join(import.meta.dir, '..');
const ONLY = opt('only', '').toLowerCase();
const OUT = opt('out', '');
const CPU = Number(opt('cpu', '1'));
const SCALE = Number(opt('scale', '0.1'));
/** `--shard 2/4`: the second quarter of the pages, for CI's jobs side by side. */
const [SHARD, SHARDS] = opt('shard', '1/1').split('/').map(Number);

/** A component counts as a list from this many on the page. */
const LIST = 10;
/** A click draws a list again when it renders at least this share of it. */
const SHARE = 0.5;

/** What clicks drew again when the check began: `page / control` to the components, as printed. */
const KNOWN_FILE = join(import.meta.dir, 'response-known.json');
const UPDATE = argv.includes('--update');
const known: Record<string, string[]> = existsSync(KNOWN_FILE) ? JSON.parse(readFileSync(KNOWN_FILE, 'utf8')).known : {};
const seenWide: Record<string, string[]> = {};

/** Never pressed: what sends, deletes, leaves, calls, signs out or opens another site. Matched on the control's name. */
const SKIP = /\b(send|delete|remove|leave|sign ?out|log ?out|block|report|forget|reset|unlink|split|merge|kick|ban|archive|mark all|disconnect|call|ring|video|voice|join|record|upload|attach|install|update|reload|download|export|copy|share|unfriend|mute everyone|end)\b/i;

// ------------------------------------------------------------------ the app, the world, the hub

const work = mkdtempSync(join(tmpdir(), 'dither-response-'));
const running: { hub?: ReturnType<typeof Bun.spawn> } = {};
process.on('exit', () => {
  running.hub?.kill();
  rmSync(work, { recursive: true, force: true });
});

let web = opt('web', '');
const build = web
  ? Promise.resolve()
  : (async () => {
      web = join(work, 'web');
      // Not minified, so a component reads as its own name.
      const b = Bun.spawn(['bunx', '--bun', 'vite', 'build', '--outDir', web, '--emptyOutDir', '--minify', 'false'], { cwd: join(root, 'packages/web'), stdout: 'ignore', stderr: 'pipe' });
      const err = await new Response(b.stderr).text();
      if ((await b.exited) !== 0) throw new Error('web build failed:\n' + err);
    })();
// The world is seeded once and settled by a first hub; each page then gets a hub of its own on a copy of it, so what
// one page's clicks change (a chat read, a rule) is not there for the next, and a page reads the same in any part.
const seeded = join(work, 'world');
const world = seedWorld(seeded, { scale: SCALE });
await build;
let base = '';
let hubs = 0;
const getJson = async (path: string) => (await fetch(`${base}${path}`)).json() as Promise<any>;
async function until(fn: () => Promise<boolean>, ms: number, what: string) {
  const end = Date.now() + ms;
  while (!(await fn().catch(() => false))) {
    if (Date.now() > end) throw new Error(what);
    await Bun.sleep(200);
  }
}
/** A hub on `dir` at a port of its own (a new address, so the page keeps nothing from the last), ready and still. */
async function startHub(dir: string) {
  if (running.hub) running.hub.kill(), await running.hub.exited;
  const l = Bun.listen({ hostname: '127.0.0.1', port: 0, socket: { data() {} } });
  const port = l.port;
  l.stop(true);
  base = `http://127.0.0.1:${port}`;
  const log = openSync(join(work, `hub-${++hubs}.log`), 'a');
  running.hub = Bun.spawn(['bun', join(root, 'packages/hub/src/main.ts'), '--demo', '--data', dir, '--port', String(port), '--host', '127.0.0.1', '--web', web], {
    env: { ...process.env, DITHER_DEMO_CHATTER: '0', DITHER_CALENDAR_URL: 'off' },
    stdout: log,
    stderr: log,
  });
  await until(async () => (await fetch(`${base}/api/health`)).ok, 30_000, 'the hub did not start');
  await until(async () => (await getJson('/api/bootstrap')).accounts.every((a: any) => a.status === 'online'), 30_000, 'demo accounts not online');
  await journalStill();
}
/**
 * Until the hub has no scores still to come out of what already happened (GET /api/attention/waiting): a change can
 * score again only 5 s later, which would land in a later click.
 */
const scored = () => until(async () => !(await getJson('/api/attention/waiting')).waiting, 20_000, 'the hub kept scoring for 20 s');
/** The demo world settles for a few seconds after its accounts come online: until its journal stands still. */
async function journalStill() {
  let seq = -1;
  let still = Date.now();
  while (Date.now() - still < 3000) {
    await Bun.sleep(500);
    const now = (await getJson('/api/bootstrap')).sync?.seq ?? 0;
    if (now !== seq) (seq = now), (still = Date.now());
  }
}
await startHub(seeded);
// The hub looks at every attachment's file a while after it starts (mediainfo.ts: 15 s, then every 30 s) and sends the
// messages again with what it found. In the world every page's hub starts from, it has done so already.
{
  const db = new Database(join(seeded, 'hub.sqlite'), { readonly: true });
  const left = () => {
    const cursor = Number((db.query(`SELECT value FROM meta WHERE key = 'media_info_cursor'`).get() as { value: string } | null)?.value ?? 0);
    const last = (db.query('SELECT MAX(rowid) AS m FROM attachment').get() as { m: number | null }).m ?? 0;
    return last - cursor;
  };
  await until(async () => left() <= 0, 120_000, 'the hub did not look at every attachment in 2 minutes');
  db.close();
  await journalStill();
}
const boot = await getJson('/api/bootstrap');
if (!boot.accounts.every((a: any) => a.demo)) throw new Error('not a demo hub');
// Stopped, so the copies hold everything it wrote.
running.hub!.kill();
await running.hub!.exited;
running.hub = undefined;
/** A fresh copy of the settled world, its three big chats read (a chat is read a moment after it opens, which would
 * land in its page's first click). */
async function freshHub() {
  const dir = join(work, `data-${hubs + 1}`);
  cpSync(seeded, dir, { recursive: true });
  await startHub(dir);
  rmSync(join(work, `data-${hubs - 1}`), { recursive: true, force: true });
  for (const c of [bigChannel, bigDm, bigGroup]) await fetch(`${base}/api/conversations/${c.id}/read`, { method: 'POST', headers: { 'content-type': 'application/json', origin: base }, body: '{}' });
  await scored();
}

// ------------------------------------------------------------------ the pages

const [bigChannel, , bigDm, bigGroup] = world.open;
const channel = boot.conversations.find((c: any) => c.id === bigChannel.id);
const space = channel?.spaceIds?.[0];
const dmConv = boot.conversations.find((c: any) => c.id === bigDm.id);
const person = dmConv?.peerPersonId ?? boot.persons.find((p: any) => p.id !== boot.selfPersonId)?.id;
const folder = boot.folders.find((f: any) => f.items.some((i: any) => i.kind === 'conversation'));
const account = boot.accounts[0];

interface PageCase {
  name: string;
  at: string;
  /** Settings this page opens with, over the defaults. */
  prefs?: Record<string, unknown>;
  /** What the mouse rests on (its last on the page), so that what shows on hover is clicked too. */
  hover?: string;
}
const PAGES: PageCase[] = [
  { name: 'a channel', at: `#/inbox/c/${bigChannel.id}` },
  { name: 'a channel, details open', at: `#/inbox/c/${bigChannel.id}`, prefs: { details: true } },
  { name: 'a channel, a message hovered', at: `#/inbox/c/${bigChannel.id}`, hover: '.timeline-scroll .msg .msg-body' },
  // Its stream (docs/threads.md "The channel stream"): the channel's own messages and its threads', where it has any.
  ...(boot.conversations.some((c: any) => c.parentId === bigChannel.id) ? [{ name: "a channel's stream", at: `#/inbox/c/${bigChannel.id}`, prefs: { channelViews: { [bigChannel.id]: 'stream' } } }] : []),
  { name: 'a DM', at: `#/inbox/c/${bigDm.id}` },
  { name: 'a DM, details open', at: `#/inbox/c/${bigDm.id}`, prefs: { details: true } },
  { name: 'a group', at: `#/inbox/c/${bigGroup.id}` },
  { name: 'For you', at: '#/foryou' },
  ...(space ? [{ name: 'a server', at: `#/s/${space}/c/${bigChannel.id}` }] : []),
  ...(folder ? [{ name: 'a folder', at: `#/f/${folder.id}` }] : []),
  { name: 'People', at: '#/people' },
  ...(person ? [{ name: 'a person', at: `#/people/${person}` }, { name: "a person's profile", at: `#/p/${person}` }] : []),
  { name: "a channel's About", at: `#/about/c/${bigChannel.id}` },
  { name: 'Search', at: '#/search?q=deploy' },
  { name: 'Notices', at: '#/notices' },
  { name: 'Requests', at: '#/requests' },
  { name: 'Accounts', at: `#/accounts/${account.id}` },
  { name: 'Settings', at: '#/settings' },
  { name: 'the directory', at: '#/directory' },
  { name: 'a mail list', at: '#/inbox?mail=v%3Aupdates%3A*' },
  { name: 'Feed', at: '#/feed' },
];

// ------------------------------------------------------------------ the browser

const INIT = `(() => {
  window.__lt = [];
  // Requests in flight and messages on the socket: a click is done once these are still too.
  window.__net = { inflight: 0, done: 0, ws: 0, soon: 0 };
  // The app's own clocks would land in whichever click is running when they strike: the 5 s usage tick that counts
  // a visit 3 s after a place opens, the minute's re-sort, the ping. Held here; the check runs them as cases of their own.
  window.__held = new Map();
  let heldId = 1e9;
  const si = window.setInterval, ci = window.clearInterval;
  window.setInterval = function (fn, ms, ...a) {
    if (typeof fn !== 'function' || !(ms >= 5000)) return si.call(this, fn, ms, ...a);
    __held.set(++heldId, () => fn(...a));
    return heldId;
  };
  window.clearInterval = function (id) { if (!__held.delete(id)) ci.call(this, id); };
  // A timeout a moment away (a chat's read 600 ms after it opens, a tooltip's delay) is waited for like a request.
  const st = window.setTimeout, ct = window.clearTimeout, soon = new Set();
  window.setTimeout = function (fn, ms, ...a) {
    if (!(ms >= 100 && ms <= 3000) || typeof fn !== 'function') return st.call(this, fn, ms, ...a);
    const id = st.call(this, (...b) => { if (soon.delete(id)) __net.soon--; fn(...b); }, ms, ...a);
    soon.add(id), __net.soon++;
    return id;
  };
  window.clearTimeout = function (id) { if (soon.delete(id)) __net.soon--; return ct.call(this, id); };
  const f = window.fetch;
  window.fetch = function (input, init) {
    // A visit the usage tracker counted (usage.ts): answered here, so the hub's event does not land in the next click.
    const url = input instanceof Request ? input.url : String(input);
    if (init?.method === 'POST' && url.split('?')[0].endsWith('/api/usage')) return Promise.resolve(new Response('{"applied":0}', { headers: { 'content-type': 'application/json' } }));
    __net.inflight++;
    return f.apply(this, arguments).finally(() => { __net.inflight--; __net.done++; });
  };
  const W = window.WebSocket;
  // The hub's events by kind, so a click's line says what came while it settled.
  window.__events = [];
  window.WebSocket = class extends W {
    constructor(...a) {
      super(...a);
      this.addEventListener('message', (e) => {
        __net.ws++;
        try { for (const ev of JSON.parse(e.data)) __events.push(ev.t); } catch (err) {}
      });
    }
  };
  try { new PerformanceObserver((l) => { for (const e of l.getEntries()) __lt.push([e.startTime, e.duration]); }).observe({ type: 'longtask', buffered: true }); } catch (e) {}
})()`;
const COMPONENTS = 'JSON.parse(JSON.stringify(window.__ditherPerf.components))';
type Counts = { mounts: Record<string, number>; updates: Record<string, number>; live: Record<string, number>; again: Record<string, number> };

/**
 * Until nothing has rendered, no request is out and nothing came on the socket for `quiet` ms (or `ms` have gone).
 * Short timeouts count as in flight (INIT), so a chat's read 600 ms after it opens is waited for, and the hub's answer,
 * and a re-sort of the lists, which waits until 4 s after the last touch and asks again every 1.5 s (arrange.ts).
 * False when the page was never still: what it was doing would land in the next click.
 */
async function settle(p: Page, quiet = 700, ms = 12_000): Promise<boolean> {
  const sig = () => p.eval<string>(`JSON.stringify([window.__ditherPerf?.components.updates, window.__ditherPerf?.components.mounts, window.__net?.done, window.__net?.ws, window.__net?.inflight || window.__net?.soon ? Math.random() : 0])`);
  let last = await sig();
  let still = Date.now();
  const end = Date.now() + ms;
  while (Date.now() < end && Date.now() - still < quiet) {
    await Bun.sleep(50);
    const now = await sig();
    if (now !== last) (last = now), (still = Date.now());
  }
  return Date.now() - still >= quiet;
}
async function metrics(p: Page) {
  const r = await p.send<{ metrics: { name: string; value: number }[] }>('Performance.getMetrics');
  return Object.fromEntries(r.metrics.map((x) => [x.name, x.value])) as Record<string, number>;
}

/** Every control on screen, once per kind: its name, and where to click. */
const CONTROLS = `(() => {
  const sel = 'button, [role=button], [role=tab], [role=switch], [role=menuitem], [role=menuitemradio], [role=checkbox], [role=option], a[href], summary, input[type=checkbox], input[type=radio], select';
  const seen = new Map();
  const out = [];
  for (const el of document.querySelectorAll(sel)) {
    if (el.disabled || el.closest('[inert], [aria-hidden=true]')) continue;
    if (el.tagName === 'A' && !(el.getAttribute('href') || '').startsWith('#')) continue;
    const r = el.getBoundingClientRect();
    if (r.width < 4 || r.height < 4 || r.bottom <= 0 || r.right <= 0 || r.top >= innerHeight || r.left >= innerWidth) continue;
    const x = Math.min(Math.max(r.left + r.width / 2, 1), innerWidth - 1), y = Math.min(Math.max(r.top + r.height / 2, 1), innerHeight - 1);
    const top = document.elementFromPoint(x, y);
    if (!top || !(top === el || el.contains(top))) continue;
    const text = (el.innerText || el.value || '').replace(/\\s+/g, ' ').trim().slice(0, 32);
    const label = el.dataset.track || el.getAttribute('aria-label') || el.title || '';
    const cls = (typeof el.className === 'string' ? el.className : '').split(/\\s+/).filter((c) => c && !/^(on|active|sel|selected|open|hot|cur|current|unread|dim)$/.test(c)).sort().join('.');
    // Rows of a list are one kind: their class, not their text.
    // One kind for every row of a list (their class), every numbered one ("Profile of Member 12"), and every card or
    // button whose words are a name or a time: words join the class only when they are a few plain ones ("Idle").
    const words = text.replace(/\\d+/g, '#');
    const plain = words.length <= 20 && /^[A-Za-z #&'()-]+$/.test(words) && !/row|item|member|conv|msg|link-row|person|card/.test(cls);
    const kind = (label || (cls || el.tagName.toLowerCase()) + (plain ? ':' + words : '')).replace(/\\d+/g, '#').replace(/\\s+/g, ' ').replace(/\\b[AP]M\\b/g, '').slice(0, 80);
    const n = seen.get(kind) ?? 0;
    seen.set(kind, n + 1);
    if (n) continue;
    out.push({ name: (label || text || cls || el.tagName.toLowerCase()).slice(0, 60), kind, x, y });
  }
  return out;
})()`;

interface Result {
  page: string;
  control: string;
  kind: string;
  ms: number;
  longest: number;
  mounts: number;
  updates: number;
  layouts: number;
  recalcs: number;
  top: [string, number][];
  wholesale: string[];
  moved: boolean;
}

const b = await launch();
const p = b.page;
const results: Result[] = [];
let reloads = 0;
let failures = 0;
const fail = (what: string) => {
  failures++;
  console.log(`FAIL ${what}`);
};
const t0 = performance.now();
try {
  await p.size(1280, 800, false);
  // CI's runners are on UTC: here too, so that a time in a control's name reads the same.
  await p.send('Emulation.setTimezoneOverride', { timezoneId: 'UTC' });
  await p.send('Performance.enable');
  await p.send('Page.addScriptToEvaluateOnNewDocument', { source: INIT });
  if (CPU > 1) await p.send('Emulation.setCPUThrottlingRate', { rate: CPU });

  /** The page fresh: settings at their defaults with this page's over them, loaded, nothing rendering. */
  async function start(c: PageCase) {
    await p.goto(`${base}/api/health`);
    await p.eval(`localStorage.setItem('dither-chat:prefs', ${JSON.stringify(JSON.stringify(c.prefs ?? {}))})`);
    await p.goto(`${base}/?perf=1&ahead=0${c.at}`);
    // Drawn from the device's copy first, then again with the hub's data (dither:fresh): after both.
    await p.until(`!!window.__ditherPerf && performance.getEntriesByName('dither:fresh').length > 0 && !!document.querySelector('.pane, .sidebar')`, 30_000);
    await settle(p, 500);
    await scored();
    await settle(p, 500);
    await rest();
    reloads++;
  }
  async function click(x: number, y: number) {
    await p.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x, y });
    await p.send('Input.dispatchMouseEvent', { type: 'mousePressed', x, y, button: 'left', buttons: 1, clickCount: 1 });
    await p.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x, y, button: 'left', buttons: 0, clickCount: 1 });
  }
  /** The mouse where it shows nothing: on the title bar's empty middle. */
  const rest = () => p.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: 640, y: 3 });
  async function hover(c: PageCase) {
    if (!c.hover) return;
    const at = await p.eval<{ x: number; y: number } | null>(
      `(() => { const all = [...document.querySelectorAll(${JSON.stringify(c.hover)})]; const el = all[all.length - 1]; if (!el) return null; const r = el.getBoundingClientRect(); return { x: r.x + Math.min(r.width / 2, 120), y: r.y + Math.min(r.height / 2, 10) }; })()`,
    );
    if (at) await p.send('Input.dispatchMouseEvent', { type: 'mouseMoved', ...at }), await settle(p, 150);
  }
  /** Where the page is: the same after a click was taken back (Escape, back) means no reload is needed. Not how many
   * elements it has: back on a chat, its timeline draws another window of messages. */
  const STATE = `JSON.stringify([location.hash, localStorage.getItem('dither-chat:prefs'), document.querySelectorAll('[role=dialog], [role=menu], [aria-modal=true], .cm').length])`;
  const ESCAPE = { key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 };
  /** Takes the click back: Escape while something is open over the page, back while the address moved. */
  async function undo(c: PageCase, state: string) {
    const hash = JSON.parse(state)[0];
    const overlay = () => p.eval<boolean>(`!!document.querySelector('[role=dialog], [role=menu], [aria-modal=true], .cm')`);
    for (let i = 0; i < 4 && (await p.eval<string>(STATE)) !== state; i++) {
      await rest();
      await p.eval('document.activeElement?.blur?.(); 0');
      // Escape closes what is open over the page. With nothing open it would leave the page, so the address instead.
      if (await overlay()) await p.send('Input.dispatchKeyEvent', { type: 'rawKeyDown', ...ESCAPE }), await p.send('Input.dispatchKeyEvent', { type: 'keyUp', ...ESCAPE });
      else if ((await p.eval<string>('location.hash')) !== hash) await p.eval(`location.hash = ${JSON.stringify(hash)}; 0`);
      else break;
      await settle(p, 150);
      await hover(c);
    }
    if ((await p.eval<string>(STATE)) !== state) await start(c), await hover(c);
  }


  /**
   * What `act` draws: the components rendered again and mounted until the page is still, judged against the known list
   * under `page / kind`. `act` sets window.__click to the time to the frame after it.
   */
  async function measure(page: PageCase, name: string, kind: string, act: () => Promise<void>) {
    const hash = await p.eval<string>('location.hash');
    const before = await p.eval<Counts>(COMPONENTS);
    const m0 = await metrics(p);
    const lt0 = await p.eval<number>('__lt.length');
    const ev0 = await p.eval<number>('__events.length');
    await p.eval('window.__ditherPerf.fresh(); 0');
    await act();
    const ms = await p.eval<number>(`Promise.race([window.__click, new Promise((r) => setTimeout(() => r(-1), 5000))])`);
    // The mouse leaves, as a hand does: a list does not re-sort under the pointer (arrange.ts), and that re-sort counts.
    await rest();
    if (!(await settle(p))) fail(`${page.name} / ${name}: the page was never still for 700 ms in 12 s`);
    // The scores the click set off on the hub, and what they draw.
    await scored();
    await settle(p);
    const after = await p.eval<Counts>(COMPONENTS);
    const m1 = await metrics(p);
    const lts = await p.eval<[number, number][]>(`__lt.slice(${lt0})`);
    const events = Object.entries((await p.eval<string[]>(`__events.slice(${ev0})`)).reduce((m, t) => ((m[t] = (m[t] ?? 0) + 1), m), {} as Record<string, number>)).map(([t, n]) => (n > 1 ? `${t}×${n}` : t));
    const diff = (k: 'mounts' | 'updates') => Object.fromEntries(Object.keys(after[k]).map((n) => [n, after[k][n] - (before[k][n] ?? 0)]).filter(([, v]) => (v as number) > 0)) as Record<string, number>;
    const mounts = diff('mounts');
    const updates = diff('updates');
    // How many of them rendered again, each once, against how many there were.
    const again = after.again;
    const comps = Object.keys(again).filter((n) => (before.live[n] ?? 0) >= LIST && again[n] >= SHARE * (before.live[n] ?? 0)).sort();
    const wholesale = comps.map((n) => `${n} ${again[n]} of ${before.live[n]}`);
    const sum = (m: Record<string, number>) => Object.values(m).reduce((a, b) => a + b, 0);
    const r: Result = {
      page: page.name,
      control: name,
      kind,
      ms: Math.round(ms),
      longest: Math.round(Math.max(0, ...lts.map((t) => t[1]))),
      mounts: sum(mounts),
      updates: sum(updates),
      layouts: m1.LayoutCount - m0.LayoutCount,
      recalcs: m1.RecalcStyleCount - m0.RecalcStyleCount,
      top: Object.entries(updates).sort((a, b) => b[1] - a[1]).slice(0, 4),
      wholesale,
      moved: (await p.eval<string>('location.hash')) !== hash,
    };
    results.push(r);
    const key = `${page.name} / ${kind}`;
    if (comps.length) seenWide[key] = comps;
    const added = comps.filter((n) => !(known[key] ?? []).includes(n));
    const line = `${String(r.ms).padStart(5)} ms  ${String(r.updates).padStart(4)} again ${String(r.mounts).padStart(4)} new ${String(r.layouts).padStart(2)} layouts  ${name}${r.moved ? ' →' : ''}  ${r.top.map(([n, v]) => `${n} ${v}`).join(', ')}${events.length ? `  [hub: ${events.join(' ')}]` : ''}`;
    if (added.length && !UPDATE) fail(`${page.name} / ${name} draws a list again: ${wholesale.join(', ')}\n${line}`);
    else console.log(`  ${wholesale.length ? 'old ' : 'ok  '}${line}${wholesale.length ? `\n         draws again, as known: ${wholesale.join(', ')}` : ''}`);
  }
  /** The clock in the page from now to the frame after. */
  const FRAME = `window.__click = (() => { const t = performance.now(); return new Promise((res) => requestAnimationFrame(() => setTimeout(() => res(performance.now() - t)))); })()`;
  /** What happens with no click, on each page: the clocks INIT held, and a visit the hub hears of from another device. */
  const BACKGROUND: { name: string; act: () => Promise<void> }[] = [
    { name: "held: the app's clocks", act: () => p.eval(`${FRAME}; [...__held.values()].forEach((f) => f()); 0`) },
    {
      name: 'hub: a visit counted',
      act: async () => {
        const ws = await p.eval<number>(`${FRAME}; __net.ws`);
        const at = Date.now();
        const deltas = [{ kind: 'conversation', id: bigGroup.id, seconds: 30, visits: 1, at, lastVisit: at }];
        const res = await fetch(`${base}/api/usage`, { method: 'POST', headers: { 'content-type': 'application/json', origin: base }, body: JSON.stringify({ batch: `check-${at}`, deltas }) });
        if (!res.ok) throw new Error(`usage: ${res.status}`);
        // The hub's event on the socket; settle() waits for what it sets off.
        await p.until(`__net.ws > ${ws}`, 5000);
      },
    },
  ];

  // The rail's and the list's controls are on most pages: they are clicked on the first page only, and every other page
  // clicks what the first has not. Each part reads the first page's controls, so a page clicks the same in any part.
  const first = new Set<string>();
  if (SHARD !== 1 || (ONLY && !PAGES[0].name.toLowerCase().includes(ONLY))) {
    await freshHub();
    await start(PAGES[0]);
    for (const c of await p.eval<{ kind: string }[]>(CONTROLS)) first.add(c.kind);
  }
  for (const [i, page] of PAGES.entries()) {
    if (i % SHARDS !== SHARD - 1) continue;
    if (ONLY && !page.name.toLowerCase().includes(ONLY) && !ONLY.startsWith('control:')) continue;
    await freshHub();
    await start(page);
    await hover(page);
    const state = await p.eval<string>(STATE);
    const controls = (await p.eval<{ name: string; kind: string; x: number; y: number }[]>(CONTROLS)).filter((c) => !SKIP.test(c.name) && !SKIP.test(c.kind) && !first.has(c.kind));
    if (i === 0) for (const c of controls) first.add(c.kind);
    console.log(`\n${page.name} (${page.at.replace(/[a-z]+_[\w-]{6,}/g, '…')}): ${controls.length} controls`);
    let fresh = true;
    for (const bg of ONLY.startsWith('control:') ? [] : BACKGROUND) {
      try {
        if (!fresh) await undo(page, state);
        fresh = false;
        await measure(page, bg.name, bg.name, bg.act);
      } catch (err) {
        fail(`${page.name} / ${bg.name} did not run: ${(err as Error).message.split('\n')[0]}`);
        await start(page).catch(() => {});
      }
    }
    for (const c of controls) {
      if (ONLY.startsWith('control:') && !c.name.toLowerCase().includes(ONLY.slice(8))) continue;
      try {
      if (!fresh) await undo(page, state);
      fresh = false;
      // The same control on the page as it is now: where it is.
      const at = await p.eval<{ x: number; y: number } | null>(`(${CONTROLS}).find((x) => x.kind === ${JSON.stringify(c.kind)}) ?? null`);
      if (!at) {
        console.log(`  -    ${c.name}: not on the page again`);
        continue;
      }
      // Click to the frame after it, timed in the page from the press.
      await measure(page, c.name, c.kind, async () => {
        await p.eval(`window.__click = new Promise((res) => addEventListener('pointerdown', () => { const t = performance.now(); requestAnimationFrame(() => setTimeout(() => res(performance.now() - t))); }, { once: true, capture: true })); 0`);
        await click(at.x, at.y);
      });
      } catch (err) {
        // A click that could not be measured (it took the page somewhere else entirely) fails; the page loads again.
        fail(`${page.name} / ${c.name} did not run: ${(err as Error).message.split('\n')[0]}`);
        fresh = false;
        await start(page).catch(() => {});
      }
    }
  }
} catch (err) {
  fail(`ran to the end: ${(err as Error).stack ?? err}`);
} finally {
  await b.close();
}

// Known lists no longer drawn again, of the pages and controls this run clicked.
const ran = new Set(results.map((r) => `${r.page} / ${r.kind}`));
const fixed = Object.entries(known).filter(([k, xs]) => ran.has(k) && xs.some((n) => !(seenWide[k] ?? []).includes(n)));
if (fixed.length) console.log(`\nNo longer drawn again (bun scripts/verify-response.ts --update writes it down):\n${fixed.map(([k, xs]) => `  ${k}: ${xs.filter((n) => !(seenWide[k] ?? []).includes(n)).join(', ')}`).join('\n')}`);
if (UPDATE) {
  if (SHARDS !== 1 || ONLY) throw new Error('--update wants every page: no --shard or --only');
  writeFileSync(KNOWN_FILE, JSON.stringify({ note: 'bun scripts/verify-response.ts --update (docs/perf.md, "Every click"): lists that clicks draw again, page / control to the components. It should only shrink.', known: Object.fromEntries(Object.entries(seenWide).sort()) }, null, 1) + '\n');
  console.log(`wrote ${KNOWN_FILE}: ${Object.keys(seenWide).length} clicks that draw a list again`);
}

const secs = ((performance.now() - t0) / 1000).toFixed(0);
const slow = [...results].sort((a, b) => b.ms - a.ms).slice(0, 15);
console.log(`\n${results.length} clicks on ${new Set(results.map((r) => r.page)).size} pages in ${secs} s (${reloads} loads). The slowest to their next frame (not judged):`);
for (const r of slow) console.log(`${String(r.ms).padStart(6)} ms (longest task ${r.longest} ms)  ${r.page} / ${r.control}`);
if (OUT) writeFileSync(OUT, JSON.stringify(results, null, 1));
if (process.env.GITHUB_STEP_SUMMARY) {
  const rows = slow.map((r) => `| ${r.page} | ${r.control.replace(/\|/g, '\\|')} | ${r.ms} | ${r.longest} | ${r.updates} | ${r.mounts} | ${r.layouts} |`);
  appendFileSync(
    process.env.GITHUB_STEP_SUMMARY,
    `### Every click (verify-response)\n\n${results.length} clicks, ${failures} drew a list again.\n\nThe slowest, not judged:\n\n| page | control | ms to the next frame | longest task | rendered again | new | layouts |\n|---|---|---|---|---|---|---|\n${rows.join('\n')}\n`,
  );
}
console.log(failures ? `\n${failures} failed` : '\nall passed');
process.exit(failures ? 1 : 0);
