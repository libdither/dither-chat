/**
 * A new build never reloads a page in sight (packages/web/src/update.ts, pwa.ts), in a real browser against a demo hub:
 *
 *   - a tab in sight shows the bar and keeps running, idle or busy;
 *   - out of sight but busy (text typed, an old message jumped to) it waits; once idle, it takes the new build;
 *   - the bar takes it at once, busy or not;
 *   - a window out of sight lets a new build in only once no other window is in sight, and then each takes it;
 *   - a second window in sight, updated by the first one's bar, keeps its build and shows the bar;
 *   - with --restart, a hub restarted with a new build (a deploy) offers it the same way.
 *
 *   bun scripts/verify-update.ts http://127.0.0.1:8731 --dist <the hub's --web dir> [--restart "<command>"]
 *
 * It makes "new builds" by changing the build id in <dist>/sw.js, and puts the file back at the end. Run it against
 * a demo hub serving a copy of packages/web/dist, never the real one.
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { launch, type Page } from './browser.ts';

const args = process.argv.slice(2);
const base = args.find((a) => /^https?:/.test(a));
const di = args.indexOf('--dist');
const dist = di >= 0 ? args[di + 1] : null;
const ri = args.indexOf('--restart');
const restart = ri >= 0 ? args[ri + 1] : null;
if (!base || !dist) throw new Error('usage: bun scripts/verify-update.ts <hub url> --dist <dir> [--restart "<command>"]');

let failed = 0;
const check = (name: string, ok: boolean, detail: unknown = '') => {
  if (!ok) failed++;
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail !== '' ? `  ${typeof detail === 'string' ? detail : JSON.stringify(detail)}` : ''}`);
};

const hub = async <T = any>(path: string): Promise<T> => {
  const r = await fetch(base + path);
  if (!r.ok) throw new Error(`${path}: ${r.status}`);
  return r.json() as Promise<T>;
};
const post = async (path: string, body: unknown) => {
  const r = await fetch(base + path, { method: 'POST', body: JSON.stringify(body), headers: { 'content-type': 'application/json' } });
  if (!r.ok) throw new Error(`${path}: ${r.status} ${await r.text()}`);
  return r.json();
};

const boot = await hub('/api/bootstrap');
if (!boot.accounts.every((a: any) => a.demo)) throw new Error('not a demo hub');
// A conversation with history to jump back into: an old message whose window does not reach the latest ones. Demo
// chats are short, so it writes 70 messages (more than a page) into a channel first.
const sender = new Set(boot.accounts.filter((a: any) => a.status === 'online' && a.capabilities.includes('send')).map((a: any) => a.id));
const channel = boot.conversations.find((c: any) => c.shape === 'channel' && c.variant === 'text' && c.vantages.some((v: any) => sender.has(v.accountId)));
if (!channel) throw new Error('no channel to write in');
const conv: string = channel.id;
const oldest = await hub(`/api/conversations/${conv}/messages?limit=60`);
for (let i = 0; i < 70; i++) await post(`/api/conversations/${conv}/send`, { body: `history ${i}` });
const old: string = (oldest.messages[0] ?? (await hub(`/api/conversations/${conv}/messages?limit=60`)).messages[0]).id;

const swPath = join(dist, 'sw.js');
const original = readFileSync(swPath, 'utf8');
let builds = 0;
/** A new build: the same files under a new id, which is a new worker to the browser. */
const newBuild = () => {
  const id = `verify${++builds}${Date.now().toString(36)}`;
  writeFileSync(swPath, original.replace(/const BUILD = '[^']*'/, `const BUILD = '${id}'`));
  return id;
};

const { page: a, newPage, close } = await launch();
// Focus emulation keeps a page "visible" whatever happens; without it, switching tabs hides it, as on a real device.
await a.send('Emulation.setFocusEmulationEnabled', { enabled: false });
await a.size(1200, 800);

const ready = (p: Page) => p.until(`!!navigator.serviceWorker.controller && !!document.querySelector('.timeline-scroll .msg')`, 20000);
let tag = 0;
/** Marks the page; a reload forgets it. */
const mark = async (p: Page) => {
  const t = ++tag;
  await p.eval(`window.__verifyMark = ${t}`);
  return t;
};
const kept = (p: Page, t: number) => p.eval<boolean>(`window.__verifyMark === ${t}`).catch(() => false);
const bar = (p: Page) => p.eval<boolean>(`!!document.querySelector('.update-bar')`).catch(() => false);
const activeBuild = (p: Page) => p.eval<string>(`caches.keys().then(ks => ks.filter(k => k.startsWith('dither-shell-')).join(','))`);
const ask = (p: Page) => p.eval(`navigator.serviceWorker.getRegistration().then(r => r.update()).then(() => true, () => false)`);
const waiting = (p: Page) => p.eval<boolean>(`navigator.serviceWorker.getRegistration().then(r => !!r.waiting)`);
/** Out of sight: another tab in front, as when the app goes to the background. */
let blank: string | null = null;
const hide = async (p: Page) => {
  blank ??= (await p.send<{ targetId: string }>('Target.createTarget', { url: 'about:blank' })).targetId;
  await p.send('Target.activateTarget', { targetId: blank });
  await p.until(`document.visibilityState === 'hidden'`, 3000);
};
const show = async (p: Page) => {
  await p.send('Page.bringToFront');
  await p.until(`document.visibilityState === 'visible'`, 3000);
};
const type = async (p: Page, text: string) => {
  await p.eval(`(() => { const ta = document.querySelector('.composer textarea'); ta.focus(); })()`);
  await p.send('Input.insertText', { text });
};
const clearText = (p: Page) =>
  p.eval(`(() => { const ta = document.querySelector('.composer textarea'); const set = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value').set; set.call(ta, ''); ta.dispatchEvent(new Event('input', { bubbles: true })); })()`);

try {
  await a.goto(`${base}/#/inbox/c/${conv}`);
  await ready(a);

  // ------------------------------------------------------------------ in sight: the bar, never a reload

  let t = await mark(a);
  const first = newBuild();
  await ask(a);
  await a.until(`!!document.querySelector('.update-bar')`, 15000).then(
    () => check('a new build shows the bar', true),
    () => check('a new build shows the bar', false),
  );
  await Bun.sleep(4000);
  check('a tab in sight and idle does not reload by itself', await kept(a, t));
  await type(a, 'half a thought');
  await Bun.sleep(4000);
  check('…nor one in sight and busy', (await kept(a, t)) && (await waiting(a)));

  // ------------------------------------------------------------------ out of sight: only once idle

  await a.eval(`location.hash = ${JSON.stringify(`#/inbox/c/${conv}?m=${old}`)}`);
  await a.until(`!!document.querySelector('.jump-latest')`, 10000).then(
    () => check('jumping to an old message leaves the latest out of the window', true),
    () => check('jumping to an old message leaves the latest out of the window', false),
  );
  t = await mark(a);
  await hide(a);
  await Bun.sleep(6000);
  check('out of sight with text typed and an old message open, it waits', (await kept(a, t)) && (await waiting(a)));
  await clearText(a);
  await Bun.sleep(6500);
  check('…the text gone, the old message still open: it still waits', (await kept(a, t)) && (await waiting(a)));
  await a.eval(`document.querySelector('.jump-latest').click()`);
  await a.until(`window.__verifyMark !== ${t}`, 15000).then(
    () => check('…and back at the latest, out of sight and idle, it takes the new build', true),
    () => check('…and back at the latest, out of sight and idle, it takes the new build', false),
  );
  await show(a);
  await ready(a);
  check('…which is the one in control now', (await activeBuild(a)) === `dither-shell-${first}`, await activeBuild(a));
  check('…and no bar after it', !(await bar(a)));

  // ------------------------------------------------------------------ the bar: at once

  t = await mark(a);
  const second = newBuild();
  await ask(a);
  await a.until(`!!document.querySelector('.update-bar')`, 15000);
  await type(a, 'still typing');
  await a.eval(`document.querySelector('.update-bar').click()`);
  await a.until(`window.__verifyMark !== ${t}`, 15000).then(
    () => check('the bar takes the new build at once, even while busy', true),
    () => check('the bar takes the new build at once, even while busy', false),
  );
  await ready(a);
  check('…and the page runs it', (await activeBuild(a)) === `dither-shell-${second}`, await activeBuild(a));
  check('…with the half-written message still in its box', await a.eval<boolean>(`document.querySelector('.composer textarea').value.includes('still typing')`));
  await clearText(a);

  // ------------------------------------------------------------------ another window

  const b = await newPage(`${base}/#/inbox/c/${conv}`, { newWindow: true });
  await b.send('Emulation.setFocusEmulationEnabled', { enabled: false });
  await ready(b);
  let ta = await mark(a);
  let tb = await mark(b);
  const third = newBuild();
  await ask(b);
  await b.until(`!!document.querySelector('.update-bar')`, 15000);
  // The second window out of sight and idle, the first one in sight: the new build waits for the first one.
  const blankB = (await b.send<{ targetId: string }>('Target.createTarget', { url: 'about:blank' })).targetId;
  await b.send('Target.activateTarget', { targetId: blankB });
  await b.until(`document.visibilityState === 'hidden'`, 3000).catch(() => {});
  check('one window out of sight, the other in sight', (await b.eval(`document.visibilityState`)) === 'hidden' && (await a.eval(`document.visibilityState`)) === 'visible');
  await Bun.sleep(6000);
  check('a window out of sight does not let a new build in while another window is in sight', (await kept(a, ta)) && (await kept(b, tb)) && (await waiting(b)));
  // Now neither is in sight: the new build goes in, and both take it.
  await hide(a);
  const both = await Promise.all([a, b].map((p, i) => p.until(`window.__verifyMark !== ${[ta, tb][i]}`, 20000).then(() => true, () => false)));
  check('…once no window is in sight, it goes in, and each takes it', both.every(Boolean), both);
  await show(a);
  await show(b);
  await ready(a);
  await ready(b);
  check('…both on the new build', (await activeBuild(a)) === `dither-shell-${third}` && (await activeBuild(b)) === `dither-shell-${third}`, [await activeBuild(a), await activeBuild(b)]);

  // The bar in one window, the other in sight.
  ta = await mark(a);
  tb = await mark(b);
  const fourth = newBuild();
  await ask(b);
  await b.until(`!!document.querySelector('.update-bar')`, 15000);
  await a.until(`!!document.querySelector('.update-bar')`, 15000).catch(() => {});
  check('both windows are in sight', (await a.eval(`document.visibilityState`)) === 'visible' && (await b.eval(`document.visibilityState`)) === 'visible');
  await b.eval(`document.querySelector('.update-bar').click()`);
  await b.until(`window.__verifyMark !== ${tb}`, 15000).then(
    () => check('the window whose bar was tapped reloads', true),
    () => check('the window whose bar was tapped reloads', false),
  );
  await ready(b);
  await Bun.sleep(4000);
  check('the other window in sight keeps its build, without a reload', await kept(a, ta));
  check('…and shows the bar', await bar(a));
  await a.eval(`document.querySelector('.update-bar').click()`);
  await a.until(`window.__verifyMark !== ${ta}`, 15000).then(
    () => check('…which reloads it into the new build', true),
    () => check('…which reloads it into the new build', false),
  );
  await ready(a);
  check('…the same one as the other window', (await activeBuild(a)) === `dither-shell-${fourth}`, await activeBuild(a));

  // ------------------------------------------------------------------ a deploy: the hub restarts with a new build

  if (restart) {
    t = await mark(a);
    newBuild();
    const r = Bun.spawnSync(['sh', '-c', restart], { stdout: 'inherit', stderr: 'inherit' });
    check('the hub restarted', r.exitCode === 0);
    await a.until(`!!document.querySelector('.update-bar')`, 30000).then(
      () => check('a restarted hub with a new build shows the bar', true),
      () => check('a restarted hub with a new build shows the bar', false),
    );
    await Bun.sleep(3000);
    check('…without reloading the page in sight', await kept(a, t));
  }

  const errors = a.errors.filter((e) => !/ERR_INTERNET_DISCONNECTED|ERR_CONNECTION_REFUSED|WebSocket connection/.test(e));
  check('no script errors', !errors.length, errors);
} finally {
  writeFileSync(swPath, original);
  await close();
}
console.log(failed ? `${failed} failed` : 'all passed');
process.exit(failed ? 1 : 0);
