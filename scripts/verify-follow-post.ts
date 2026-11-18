/**
 * Following a post (docs/feed.md "Following a post"), in a real browser against a demo hub of its own on a fresh data
 * dir: Follow replies on a thread from the Feed page makes the post a chat in the inbox, with a toast whose View opens
 * it; a reply someone writes later (the demo's newReply action) is found by the hub's next check and arrives unread,
 * the row saying what it says; opening the chat shows the post's thread with that reply marked New, and reads the chat;
 * Stop Following from the row's menu stops the checks, the chat staying with a note; a phone keeps the bell, as an
 * icon.
 *
 *   bun scripts/verify-follow-post.ts [--port <port>] [--web <built dist>] [--work <empty dir>] [--keep] [--shots <dir>]
 *
 * Builds the web app unless --web names a build. Every press is real input (DevTools Input events). The hub's first
 * check comes 1.5 s after following here (DITHER_FOLLOW_FIRST_MS), not five minutes.
 */
import { mkdirSync, mkdtempSync, openSync, rmSync } from 'node:fs';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { launch } from './browser.ts';

const args = process.argv.slice(2);
const opt = (k: string, d: string) => (args.includes(`--${k}`) ? args[args.indexOf(`--${k}`) + 1] : d);
const freePort = () =>
  new Promise<number>((ok) => {
    const s = createServer().listen(0, '127.0.0.1', () => {
      const p = (s.address() as { port: number }).port;
      s.close(() => ok(p));
    });
  });
const PORT = Number(opt('port', '0')) || (await freePort());
const root = resolve(import.meta.dir, '..');
const base = `http://127.0.0.1:${PORT}`;
const work = args.includes('--work') ? opt('work', '') : mkdtempSync(join(tmpdir(), `dither-verify-follow-post-${PORT}-`));
mkdirSync(work, { recursive: true });
const shots = opt('shots', '');
if (shots) mkdirSync(shots, { recursive: true });

let failed = 0;
const check = (name: string, ok: boolean, detail: unknown = '') => {
  if (!ok) failed++;
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail !== '' ? `  ${typeof detail === 'string' ? detail : JSON.stringify(detail)}` : ''}`);
};
async function until(fn: () => Promise<boolean> | boolean, ms: number, what: string) {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (await Promise.resolve().then(fn).catch(() => false)) return;
    await Bun.sleep(100);
  }
  throw new Error(`timed out: ${what}`);
}
const json = (path: string, init?: RequestInit) => fetch(`${base}${path}`, init).then((r) => r.json()) as Promise<any>;
const action = (acc: string, name: string, a?: unknown) => json(`/api/accounts/${acc}/action`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ action: name, args: a }) });

let web = opt('web', '');
if (!web) {
  web = join(work, 'web');
  console.log('building the web app…');
  const b = Bun.spawnSync(['bunx', '--bun', 'vite', 'build', '--outDir', web, '--emptyOutDir'], { cwd: join(root, 'packages/web'), stdout: 'pipe', stderr: 'pipe' });
  if (b.exitCode !== 0) throw new Error('web build failed:\n' + b.stderr.toString());
}
if ((await fetch(`${base}/api/health`).catch(() => null))?.ok) throw new Error(`something is already listening on ${PORT}`);
const log = openSync(join(work, 'hub.log'), 'a');
const hub = Bun.spawn(['bun', join(root, 'packages/hub/src/main.ts'), '--demo', '--data', join(work, 'data'), '--port', String(PORT), '--host', '127.0.0.1', '--web', web], {
  env: { ...process.env, DITHER_DEMO_CHATTER: '0', DITHER_FOLLOW_FIRST_MS: '1500' },
  stdout: log,
  stderr: log,
});
await until(async () => (await fetch(`${base}/api/health`).catch(() => null))?.ok ?? false, 30_000, 'the hub did not start');
const boot = await json('/api/bootstrap');
if (!boot.accounts.every((a: any) => a.demo)) throw new Error('not a demo hub');
const conv = async (id: string) => ((await json('/api/bootstrap')).conversations as any[]).find((c) => c.id === id);
const unread = (c: any) => (c?.vantages ?? []).reduce((n: number, v: any) => n + v.unread, 0);

const { page, close } = await launch();
const q = (s: string) => JSON.stringify(s);
/** A real press at the middle of the first element matching, once nothing on the page is moving and nothing else lies
 * over that point. */
async function tap(sel: string, button: 'left' | 'right' = 'left') {
  let r: { x: number; y: number; over?: string } | null = null;
  const end = Date.now() + 15_000;
  do {
    r = await page.eval<{ x: number; y: number; over?: string } | null>(
      `(() => { const e = document.querySelector(${q(sel)}); if (!e) return null; const moving = document.getAnimations().find((a) => a.playState === 'running' && a.effect?.getTiming().iterations !== Infinity); if (moving) return { x: 0, y: 0, over: 'an animation still running' }; e.scrollIntoView({ block: 'center' }); const b = e.getBoundingClientRect(); const x = b.left + b.width / 2, y = b.top + b.height / 2; const at = document.elementFromPoint(x, y); return { x, y, ...(b.width && b.height && at && (at === e || e.contains(at)) ? {} : { over: at ? at.outerHTML.slice(0, 120) : 'nothing' }) }; })()`,
    );
    if (r && !r.over) break;
    await Bun.sleep(50);
  } while (Date.now() < end);
  if (!r) throw new Error(`nothing to press: ${sel}`);
  if (r.over) throw new Error(`${sel} is covered or not drawn: ${r.over}`);
  for (const type of ['mousePressed', 'mouseReleased']) await page.send('Input.dispatchMouseEvent', { type, x: r.x, y: r.y, button, buttons: button === 'right' ? 2 : 1, clickCount: 1 });
}
/** Closes the toasts showing (their ×, real presses) but one saying `keep`, so a screenshot shows what it is of. */
async function clearToasts(keep?: RegExp) {
  for (let i = 0; i < 6; i++) {
    // Toasts are keyed by their id: the one marked leaves the page when it is closed, whatever else comes meanwhile.
    const marked = await page.eval<boolean>(`(() => { const ts = [...document.querySelectorAll('.toast')]; ts.forEach((t) => t.removeAttribute('data-test')); const t = ts.find((t) => !${keep ? keep.toString() : '/$^/'}.test(t.textContent)); t?.setAttribute('data-test', 'stray'); return !!t; })()`);
    if (!marked) return;
    await tap('.toast[data-test="stray"] .toast-x');
    await page.until(`!document.querySelector('.toast[data-test="stray"]')`, 5000);
  }
}
const text = (sel: string) => page.eval<string>(`document.querySelector(${q(sel)})?.textContent ?? ''`);
const bell = () => page.eval<{ pressed: string | null; label: string; shown: boolean } | null>(`(() => { const b = document.querySelector('.follow-btn'); return b && { pressed: b.getAttribute('aria-pressed'), label: b.getAttribute('aria-label'), shown: getComputedStyle(b.querySelector('.follow-btn-label')).display !== 'none' }; })()`);

try {
  await page.size(1410, 940);
  // ---------------------------------------------------------------- following, from the Feed page
  await page.goto(`${base}/#/feed/mine`);
  await page.until(`[...document.querySelectorAll('.feed-entry')].some((e) => /Greedy routing/.test(e.textContent))`, 30000);
  await page.eval(`[...document.querySelectorAll('.feed-entry')].find((e) => /Greedy routing/.test(e.textContent)).setAttribute('data-test', 'routing')`);
  await tap('.feed-entry[data-test="routing"] .post-text');
  await page.until(`/Greedy routing/.test(document.querySelector('.feed-thread .thread-focal')?.textContent ?? '') && !!document.querySelector('.feed-thread .follow-btn')`, 15000);
  const post = (await page.eval<string>(`location.hash`)).match(/\/p\/pst_x_(\d+)/)?.[1] ?? '';
  check('a thread from the Feed page has the bell, not pressed', (await bell())?.pressed === 'false' && (await bell())?.label === 'Follow replies' && !!post, { bell: await bell(), post });
  const before = await page.eval<number>(`document.querySelectorAll('.feed-thread .ct-node, .feed-thread .thread-post').length`);
  await tap('.feed-thread .follow-btn');
  await page.until(`document.querySelector('.feed-thread .follow-btn')?.getAttribute('aria-pressed') === 'true'`, 10000);
  check('Follow replies: the bell is pressed and says Following replies', (await bell())?.label === 'Following replies', await bell());
  await page.until(`[...document.querySelectorAll('.toast')].some((t) => /New replies will come to your inbox/.test(t.textContent))`, 5000);
  const toast = await page.eval<string>(`[...document.querySelectorAll('.toast')].find((t) => /New replies will come/.test(t.textContent)).textContent`);
  check('…a toast says where new replies go, with View', /Replies to your post, in your inbox/.test(toast) && /View/.test(toast), toast);
  if (shots) await clearToasts(/New replies will come/).then(() => page.shot(join(shots, 'follow-feed-thread.png')));

  const f = await json(`/api/posts/x/${post}/follow`);
  const cid: string = f.conversationId;
  check('the hub follows it: a check due, nothing found yet', f.stopped === null && typeof f.next === 'number' && !(f.fresh ?? []).length, f);
  const c0 = await conv(cid);
  check('…as a chat of its own, named for the post, nothing unread', c0?.variant === 'follow' && c0.name === 'Replies to your post' && unread(c0) === 0, c0 && { variant: c0.variant, name: c0.name, unread: unread(c0) });
  check('the replies already there stay in the thread', before > 1 && before === (await page.eval<number>(`document.querySelectorAll('.feed-thread .ct-node, .feed-thread .thread-post').length`)), before);

  // ---------------------------------------------------------------- View, the chat in the inbox
  await page.eval(`[...document.querySelectorAll('.toast')].find((t) => /New replies will come/.test(t.textContent)).setAttribute('data-test', 'follow-toast')`);
  await tap('.toast[data-test="follow-toast"]');
  await page.until(`location.hash.includes(${q(cid)}) && !!document.querySelector('.thread-pane .thread-focal')`, 15000);
  check('View opens the chat: the post’s thread', /Greedy routing/.test(await text('.thread-pane .thread-focal')), await page.eval(`location.hash`));
  await page.until(`document.querySelectorAll(${q(`.conv-row[data-row="${cid}"]`)}).length === 1`, 10000);
  check('…and its row is in the inbox', true);
  check('…with nothing marked New', (await page.eval<number>(`document.querySelectorAll('.thread-pane .post-tag.new').length`)) === 0);

  // ---------------------------------------------------------------- a reply someone writes later
  await page.goto(`${base}/#/inbox`);
  await page.until(`!document.querySelector('.thread-pane') && !!document.querySelector(${q(`.conv-row[data-row="${cid}"]`)})`, 10000);
  const said = 'Late to this, but the churn numbers are what sold me.';
  const wrote = (await action(f.accountId, 'newReply', { post, text: said })).result;
  check('someone answers the post on X (demo)', typeof wrote?.id === 'string', wrote);
  await until(async () => unread(await conv(cid)) === 1, 20_000, 'the reply found and unread');
  check('the hub’s next check finds it: one unread', true);
  await page.until(`document.querySelector(${q(`.conv-row[data-row="${cid}"]`)})?.classList.contains('unread') && /churn numbers/.test(document.querySelector(${q(`.conv-row[data-row="${cid}"]`)}).textContent)`, 10000);
  check('…its row is unread and says what the reply says', true);
  if (shots) {
    await clearToasts();
    await page.eval(`document.querySelector(${q(`.conv-row[data-row="${cid}"]`)}).scrollIntoView({ block: 'center' })`);
    await page.shot(join(shots, 'follow-inbox-row.png'));
  }

  // ---------------------------------------------------------------- opening it
  await tap(`.conv-row[data-row="${cid}"]`);
  await page.until(`!!document.querySelector('.thread-pane .post-tag.new')`, 15000);
  const marked = await page.eval<{ n: number; text: string }>(
    `(() => { const t = [...document.querySelectorAll('.thread-pane .post-tag.new')]; const p = t[0].closest('[data-post]'); return { n: t.length, text: p?.textContent ?? '', id: p?.dataset.post }; })()`,
  );
  check('opening it shows the thread, the new reply marked New', marked.n === 1 && marked.text.includes(said), marked);
  await until(async () => unread(await conv(cid)) === 0, 10_000, 'the chat read');
  check('…and reads the chat', true);
  if (shots) await clearToasts().then(() => page.shot(join(shots, 'follow-chat-new.png')));

  // ---------------------------------------------------------------- Stop Following, from the row's menu
  await tap(`.conv-row[data-row="${cid}"]`, 'right');
  await page.until(`[...document.querySelectorAll('.cm-item, .sheet-action')].some((b) => b.textContent.trim().startsWith('Stop Following'))`, 5000);
  await page.eval(`[...document.querySelectorAll('.cm-item, .sheet-action')].find((b) => b.textContent.trim().startsWith('Stop Following')).setAttribute('data-test', 'stop')`);
  const items = await page.eval<string[]>(`[...document.querySelectorAll('.cm-item, .sheet-action')].map((b) => b.textContent.trim())`);
  check('the row’s menu has Stop Following, and no Index (the hub made this chat)', !items.some((l) => l.startsWith('Index')), items);
  if (shots) await page.shot(join(shots, 'follow-menu.png'));
  await tap('[data-test="stop"]');
  await until(async () => (await json(`/api/posts/x/${post}/follow`)).stopped !== null, 10_000, 'the follow stopped');
  const stopped = await json(`/api/posts/x/${post}/follow`);
  check('Stop Following stops the checks', stopped.why === 'unfollowed' && stopped.next === null, stopped);
  await page.until(`/You stopped following/.test(document.querySelector('.thread-pane .follow-note')?.textContent ?? '')`, 10000);
  check('…the chat stays, with a note, and the bell says Follow replies again', (await conv(cid))?.variant === 'follow' && (await bell())?.pressed === 'false' && (await bell())?.label === 'Follow replies', await bell());
  check('…and the reply it found is still there', (await page.eval<string>(`document.querySelector('.thread-pane')?.textContent ?? ''`)).includes(said));
  if (shots) await clearToasts().then(() => page.shot(join(shots, 'follow-stopped.png')));

  // Follow again from the bell, then stop from it.
  await tap('.thread-pane .follow-btn');
  await page.until(`document.querySelector('.thread-pane .follow-btn')?.getAttribute('aria-pressed') === 'true' && !document.querySelector('.thread-pane .follow-note')`, 10000);
  check('the bell follows it again: the note goes', (await json(`/api/posts/x/${post}/follow`)).stopped === null);

  // ---------------------------------------------------------------- a phone
  await page.size(412, 900);
  await page.until(`!!document.querySelector('.thread-pane .follow-btn')`, 10000);
  const ph = await bell();
  check('a phone keeps the bell, as an icon', ph?.pressed === 'true' && ph.shown === false && (await page.eval<number>(`document.querySelector('.thread-pane .follow-btn').getBoundingClientRect().width`)) < 60, ph);
  if (shots) await clearToasts().then(() => page.shot(join(shots, 'follow-phone.png')));
  await tap('.thread-pane .follow-btn');
  await until(async () => (await json(`/api/posts/x/${post}/follow`)).stopped !== null, 10_000, 'stopped from the phone');
  check('…and stops from it', true);

  const errors = page.errors.filter((e) => !/WebSocket connection|Failed to load resource/.test(e));
  check('no script errors', !errors.length, errors);
} catch (e) {
  failed++;
  console.log('FAIL  ', e);
  if (shots) await page.shot(join(shots, 'follow-failed.png')).catch(() => {});
} finally {
  await close();
  hub.kill('SIGTERM');
  await hub.exited;
  if (!args.includes('--keep')) rmSync(work, { recursive: true, force: true });
  else console.log(`kept ${work}`);
}
console.log(failed ? `${failed} failed` : 'all passed');
process.exit(failed ? 1 : 0);
