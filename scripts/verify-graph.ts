/**
 * The people graph (docs/people-graph.md), end to end against a demo hub in headless Chromium: /api/graph uses server
 * members only once their switch is on; the graph opens from the People header as a chunk of its own; it draws,
 * filters by network, account and server, finds someone, and a click on a node picks it and opens its page; an empty
 * graph says how it fills in; and a synthetic graph of ~11k nodes stays responsive, capped with "showing N of M".
 *
 *   bun scripts/verify-graph.ts http://127.0.0.1:8670 [/tmp/shots]
 * The hub must be a demo hub (--demo). It turns server members on (and back off at the end).
 */
import { mkdirSync } from 'node:fs';
import { launch } from './browser.ts';

const hub = process.argv[2] ?? 'http://127.0.0.1:8670';
const shots = process.argv[3];
if (shots) mkdirSync(shots, { recursive: true });

const boot = (await fetch(`${hub}/api/bootstrap`).then((r) => r.json())) as any;
if (!boot.accounts.every((a: any) => a.demo)) throw new Error('not a demo hub');

let failures = 0;
const check = (ok: unknown, what: string, detail: unknown = '') => {
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${what}${detail !== '' ? `  ${JSON.stringify(detail)}` : ''}`);
  if (!ok) failures++;
};
const graph = () => fetch(`${hub}/api/graph`).then((r) => r.json()) as Promise<any>;
const retention = (b: unknown) => fetch(`${hub}/api/retention`, { method: 'PUT', body: JSON.stringify(b), headers: { 'content-type': 'application/json' } });
const bits = (g: any) => {
  let or = 0;
  for (let i = 2; i < g.links.length; i += 3) or |= g.links[i];
  return or;
};
const pairsUnique = (g: any) => new Set(Array.from({ length: g.links.length / 3 }, (_, k) => `${g.links[3 * k]}:${g.links[3 * k + 1]}`)).size === g.links.length / 3;

// The endpoint: members off, then on.
await retention({ adversarial: false, members: false });
const off = await graph();
check(off.members === false && !(bits(off) & 1), 'members off: no link from members seen', { members: off.members, sources: bits(off) });
check(off.places.some((p: any) => p.kind === 'group') && off.links.length > 0, 'group chats already link people', { people: off.people.length, places: off.places.length });
await retention({ adversarial: true, members: true });
await fetch(`${hub}/api/demo/reset`, { method: 'POST' });
let on: any = null;
for (let i = 0; i < 40; i++) {
  on = await graph();
  if (bits(on) & 1) break;
  await Bun.sleep(250);
}
check(on.members === true && bits(on) & 1, 'members on: members seen link people to their server', { sources: bits(on) });
check(pairsUnique(on), 'each person–place pair once');
check(!JSON.stringify(on).match(/"(body|text|bio)"/), 'no message text or profile fields');
const dither = on.places.findIndex((p: any) => p.kind === 'space' && /dither/i.test(p.name ?? ''));
check(dither >= 0 && on.places[dither].total > 0, 'the demo server, with the network’s member count', on.places[dither]);

const { page: p, close } = await launch({ args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader'] });
const click = async (sel: string) => {
  const r = await p.eval<{ x: number; y: number } | null>(
    `(() => { const e = [...document.querySelectorAll(${JSON.stringify(sel)})].find((x) => x.getBoundingClientRect().width > 0); if (!e) return null; e.scrollIntoView({ block: 'nearest' }); const b = e.getBoundingClientRect(); return { x: b.x + b.width / 2, y: b.y + b.height / 2 }; })()`,
  );
  if (!r) throw new Error(`nothing matches ${sel}`);
  await clickAt(r.x, r.y);
};
const clickAt = async (x: number, y: number, clickCount = 1) => {
  for (const type of ['mousePressed', 'mouseReleased']) await p.send('Input.dispatchMouseEvent', { type, x, y, button: 'left', clickCount });
};
const status = () => p.eval<string>(`document.querySelector('.pg-showing')?.textContent ?? ''`);
const shownPeople = async () => Number((await status()).match(/Showing ([\d,]+) of/)?.[1].replace(/,/g, '') ?? -1);
const select = (label: string, value: string | number) =>
  p.eval(`(() => { const s = document.querySelector('select[aria-label=${JSON.stringify(label)}]'); s.value = ${JSON.stringify(String(value))}; s.dispatchEvent(new Event('change', { bubbles: true })); })()`);
const chunks = () => p.eval<string[]>(`performance.getEntriesByType('resource').map((e) => e.name.split('/').pop()).filter((n) => /\\.js$/.test(n))`);
/** A graph the hub did not send: the page asks /api/graph and gets this. */
const fake = (g: unknown) =>
  p.eval(`(() => { const body = ${JSON.stringify(JSON.stringify(g))}; const f = window.__realFetch ??= window.fetch; window.fetch = (u, ...a) => String(u).includes('/api/graph') ? Promise.resolve(new Response(body, { headers: { 'content-type': 'application/json' } })) : f(u, ...a); })()`);

try {
  await p.size(1360, 900);
  await p.goto(`${hub}/#/people`);
  await p.until(`!!document.querySelector('.side-graph')`, 15000);
  check(!(await chunks()).some((n) => n.startsWith('GraphView')), 'the graph is not loaded with the app');
  await click('.side-graph');
  await p.until(`!!document.querySelector('.pg-canvas canvas') && /Showing/.test(document.querySelector('.pg-showing')?.textContent ?? '')`, 15000);
  check((await p.eval('location.hash')) === '#/people/graph', 'the People header opens it', await p.eval('location.hash'));
  check((await chunks()).some((n) => n.startsWith('GraphView')) && (await chunks()).some((n) => n.startsWith('layout.worker')), 'as a chunk of its own, with its layout worker', (await chunks()).filter((n) => /Graph|layout/.test(n)));
  check(!(await p.eval<boolean>(`document.body.innerText.includes('no WebGL')`)), 'drawn with WebGL');
  const all = await shownPeople();
  check(all > 0 && all === on.people.filter((x: any) => !x.bot).length, 'everyone but bots, at first', await status());
  await Bun.sleep(1500);
  if (shots) await p.shot(`${shots}/graph.png`);
  // Something is drawn: read the canvas back in the frame it is drawn (a nudge of the zoom asks for one).
  const drawn = await p.eval<number>(`new Promise((res) => { const h = document.querySelector('.pg-canvas'); const b = h.getBoundingClientRect(); h.dispatchEvent(new WheelEvent('wheel', { deltaY: 0.01, clientX: b.x + 10, clientY: b.y + 10, bubbles: true, cancelable: true })); requestAnimationFrame(() => { const c = document.querySelector('.pg-gl'); const x = document.createElement('canvas'); x.width = c.width; x.height = c.height; const g = x.getContext('2d'); g.drawImage(c, 0, 0); const d = g.getImageData(0, 0, x.width, x.height).data; let n = 0; for (let i = 3; i < d.length; i += 4 * 7) if (d[i] > 0) n++; res(n); }); })`);
  check(drawn > 200, 'nodes and links on the canvas', drawn);

  // Filters.
  await click('.pg-controls [aria-label="Network"] .chip-btn');
  const netName = await p.eval<string>(`document.querySelector('.pg-controls [aria-label="Network"] .chip-btn.on')?.textContent.trim()`);
  const byNet = await shownPeople();
  check(byNet > 0 && byNet <= all, `by network (${netName})`, await status());
  await click('.pg-controls [aria-label="Network"] .chip-btn.on');
  const signal = on.accounts.findIndex((id: string) => boot.accounts.find((a: any) => a.id === id)?.network === 'signal');
  await select('Account', signal);
  await Bun.sleep(100);
  const bySignal = await shownPeople();
  check(bySignal > 0 && bySignal < all, 'by account', await status());
  await select('Account', '');
  await select('Server or group', dither);
  await Bun.sleep(100);
  const byServer = await shownPeople();
  const inDither = new Set<number>();
  for (let k = 0; k < on.links.length; k += 3) if (on.links[k + 1] === dither && !on.people[on.links[k]].bot) inDither.add(on.links[k]);
  check(byServer === inDither.size, 'by server: its people', { shown: byServer, members: inDither.size });
  await select('Server or group', '');
  await click('.pg-controls [aria-label="Show"] .chip-btn');
  check((await shownPeople()) < all, 'groups off', await status());
  await click('.pg-controls [aria-label="Show"] .chip-btn');

  // Find someone; they are picked and brought to the middle; a click there picks them on the canvas; a double-click opens.
  const alice = on.people.find((x: any) => x.name === 'Alice Chen');
  await p.eval(`(() => { const i = document.querySelector('.pg-find input'); i.value = 'Alice'; i.dispatchEvent(new Event('input', { bubbles: true })); })()`);
  await p.until(`!!document.querySelector('.pg-hits .pg-row')`, 3000);
  await click('.pg-hits .pg-row');
  await p.until(`!!document.querySelector('.pg-card')`, 3000);
  check((await p.eval<string>(`document.querySelector('.pg-card-name').textContent`)) === 'Alice Chen', 'find picks them');
  const card = await p.eval<string>(`document.querySelector('.pg-card').innerText`);
  check(/shares places with/i.test(card) && /in (\d+ places|one place)/i.test(card), 'the card: where they are and who they share it with', card.split('\n').slice(0, 8));
  await p.until(`document.querySelector('.pg-canvas').dataset.settled === '1'`, 15000);
  if (shots) await p.shot(`${shots}/graph-picked.png`);
  const mid = await p.eval<{ x: number; y: number }>(`(() => { const b = document.querySelector('.pg-canvas').getBoundingClientRect(); return { x: b.x + b.width / 2, y: b.y + b.height / 2 }; })()`);
  await click('.pg-card-head .icon-btn');
  await p.until(`!document.querySelector('.pg-card')`, 3000);
  await clickAt(mid.x, mid.y);
  await p.until(`!!document.querySelector('.pg-card')`, 3000);
  check((await p.eval<string>(`document.querySelector('.pg-card-name')?.textContent`)) === 'Alice Chen', 'a click on a node picks it');
  await clickAt(mid.x, mid.y, 2);
  await p.send('Input.dispatchMouseEvent', { type: 'mousePressed', x: mid.x, y: mid.y, button: 'left', clickCount: 2 });
  await p.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: mid.x, y: mid.y, button: 'left', clickCount: 2 });
  await p.until(`location.hash.startsWith('#/p/')`, 3000).catch(() => {});
  check((await p.eval('location.hash')) === `#/p/${alice.id}`, 'a double-click opens their page', await p.eval('location.hash'));
  await p.eval('history.back()');
  await p.until(`!!document.querySelector('.pg-card') || !!document.querySelector('.pg-canvas')`, 5000);
  // A place's card opens its About.
  await select('Server or group', dither);
  await p.eval(`(() => { const i = document.querySelector('.pg-find input'); i.value = ${JSON.stringify(on.places[dither].name)}; i.dispatchEvent(new Event('input', { bubbles: true })); })()`);
  await p.until(`!!document.querySelector('.pg-hits .pg-row')`, 3000);
  await click('.pg-hits .pg-row');
  await p.until(`!!document.querySelector('.pg-card')`, 3000);
  await click('.pg-card-name');
  await p.until(`location.hash.startsWith('#/about/s/')`, 3000).catch(() => {});
  check((await p.eval('location.hash')) === `#/about/s/${on.places[dither].id}`, 'a server’s name opens its About', await p.eval('location.hash'));

  // Light theme too.
  await p.eval(`localStorage.setItem('dither-chat:prefs', JSON.stringify({ ...JSON.parse(localStorage.getItem('dither-chat:prefs') || '{}'), theme: 'light' }))`);
  await p.goto(`${hub}/#/people/graph`);
  await p.eval('location.reload()');
  await Bun.sleep(500);
  await p.until(`/Showing/.test(document.querySelector('.pg-showing')?.textContent ?? '')`, 15000);
  await Bun.sleep(1500);
  if (shots) await p.shot(`${shots}/graph-light.png`);
  check((await p.eval('document.documentElement.dataset.theme')) === 'light', 'in the light theme', await p.eval('document.documentElement.dataset.theme'));

  // Nothing to draw yet: it says how it fills in.
  await fake({ members: false, accounts: [], people: [], places: [], links: [] });
  await click('.pg-head-tools .icon-btn');
  await p.until(`!!document.querySelector('.pg-empty')`, 3000);
  const empty = await p.eval<string>(`document.querySelector('.pg-empty').innerText`);
  check(empty.includes('Record server members') && empty.includes('Adversarial features'), 'an empty graph says how it fills in', empty.split('\n'));

  // ~11k nodes: capped, saying so, and the page keeps up while it lays out.
  const P = 10_500;
  const Q = 1_200;
  const links: number[] = [];
  for (let i = 0; i < P; i++) {
    const k = 1 + Math.floor(Math.random() ** 3 * 4);
    const seen = new Set<number>();
    for (let j = 0; j < k; j++) {
      const q = Math.floor(Math.random() ** 2 * Q);
      if (!seen.has(q)) links.push(i, q, 1), seen.add(q);
    }
  }
  const big = {
    members: true,
    accounts: on.accounts,
    people: Array.from({ length: P }, (_, i) => ({ id: `idn_x${i}`, identity: true, name: `Person ${i}`, networks: [i % 3 ? 'discord' : 'signal'], dm: [] })),
    places: Array.from({ length: Q }, (_, q) => ({ id: `spc_x${q}`, kind: 'space', name: `Server ${q}`, network: q % 3 ? 'discord' : 'signal', accounts: [0] })),
    links,
  };
  await fake(big);
  await select('At most', 6000).catch(() => {});
  await click('.pg-head-tools .icon-btn');
  const t0 = Date.now();
  await p.until(`/of 10,500 people/.test(document.querySelector('.pg-showing')?.textContent ?? '')`, 15000);
  const firstPaint = Date.now() - t0;
  const capped = await status();
  check(/^Showing [\d,]+ of 10,500 people/.test(capped) && /busiest/.test(capped), 'a big graph is capped, and says so', capped);
  // Frames while it lays out: the worker keeps the page's thread free.
  const frames = await p.eval<number[]>(`new Promise((res) => { const t = []; let last = performance.now(); const f = (now) => { t.push(now - last); last = now; if (t.length < 90) requestAnimationFrame(f); else res(t); }; requestAnimationFrame(f); })`);
  const sorted = [...frames].sort((a, b) => a - b);
  const median = sorted[Math.floor(sorted.length / 2)];
  check(median < 50, 'frames during layout (median ms)', { median: Math.round(median), p90: Math.round(sorted[Math.floor(sorted.length * 0.9)]), firstPaintMs: firstPaint });
  await select('At most', 20000);
  await p.until(`/Showing 10,500 of 10,500/.test(document.querySelector('.pg-showing')?.textContent ?? '')`, 15000).catch(() => {});
  check(/Showing 10,500 of 10,500 people/.test(await status()), 'all of it, when asked', await status());
  const t1 = performance.now();
  for (let i = 0; i < 20; i++) await p.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: mid.x + i * 7, y: mid.y + i * 3 });
  const hoverMs = (performance.now() - t1) / 20;
  check(hoverMs < 50, 'hovering 11k nodes (ms per move, round trip)', Math.round(hoverMs));
  await Bun.sleep(4000);
  if (shots) await p.shot(`${shots}/graph-11k.png`);
  await select('At most', 6000);

  // On a phone: a page of its own over the People list, nothing wider than the screen.
  await p.size(390, 844, true);
  await p.goto(`${hub}/#/people`);
  await p.eval('location.reload()');
  await Bun.sleep(500);
  await p.until(`[...document.querySelectorAll('.side-graph')].some((e) => e.getBoundingClientRect().width > 0)`, 15000);
  await click('.side-graph');
  await p.until(`/Showing/.test(document.querySelector('.pg-showing')?.textContent ?? '')`, 15000);
  await Bun.sleep(1500);
  const wide = await p.eval<{ page: number; pane: number; w: number }>(`({ page: document.scrollingElement.scrollWidth, pane: document.querySelector('.pg-pane').scrollWidth, w: innerWidth })`);
  check(wide.page <= wide.w && wide.pane <= wide.w, 'on a phone, nothing wider than the screen', wide);
  const stage = await p.eval<number>(`document.querySelector('.pg-canvas').getBoundingClientRect().height`);
  check(stage > 250, 'and the graph has room', Math.round(stage));
  if (shots) await p.shot(`${shots}/graph-phone.png`);

  check(!p.errors.length, 'no page errors', p.errors.slice(0, 5));
} finally {
  await close();
  await retention({ adversarial: false, members: false });
}
console.log(failures ? `\n${failures} failed` : '\nall passed');
process.exit(failures ? 1 : 0);
