/**
 * A thread as a chat or a tree (docs/places.md "A thread as a chat or a tree", "The box"), in a real browser against a
 * demo hub of its own on a fresh data dir:
 *
 * - a post's thread: the switch row (Chat · Thread) under its header; Chat lists every reply known, at any depth, oldest
 *   first, with a day line where the day changes and, over a reply that answers a reply, a line saying what it answers
 *   (a press brings that reply into view, lit); the choice is kept after a reload; your own reply has Delete in its ⋯,
 *   and Delete takes it off the page and off X; with the box aimed at a reply, Escape takes the aim off before a second
 *   Escape leaves the page; nothing sideways on a phone, the box at the bottom;
 * - a mail thread: one where a mail has two answers shows the row and, as Thread, nests both answers under it (a mail
 *   with one answer goes on in its column), its rail folding a branch; a straight thread shows no row.
 *
 * Every press is real input (DevTools Input events).
 *
 *   bun scripts/verify-thread-views.ts [--port <port>] [--web <built dist>] [--work <empty dir>] [--keep] [--shots <dir>]
 */
import { mkdirSync, mkdtempSync, openSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { launch } from './browser.ts';

const args = process.argv.slice(2);
const opt = (k: string, d: string) => (args.includes(`--${k}`) ? args[args.indexOf(`--${k}`) + 1] : d);
const root = resolve(import.meta.dir, '..');
const PORT = Number(opt('port', '0')) || (await (async () => {
  const l = Bun.listen({ hostname: '127.0.0.1', port: 0, socket: { data() {} } });
  const p = l.port;
  l.stop(true);
  return p;
})());
const base = `http://127.0.0.1:${PORT}`;
const work = args.includes('--work') ? opt('work', '') : mkdtempSync(join(tmpdir(), `dither-verify-thread-views-${PORT}-`));
mkdirSync(work, { recursive: true });
const shots = opt('shots', '');
if (shots) mkdirSync(shots, { recursive: true });
const X_ACC = 'acc_demo-x';
/** The demo's own post with replies on X ("Greedy routing", demo-x.ts pid(1)). */
const ROUTING = '1900000000000104729';

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
const writes = async () => ((await json(`/api/accounts/${X_ACC}/action`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ action: 'writeLog' }) })).result?.writes ?? []) as string[];

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
  env: { ...process.env, DITHER_DEMO_CHATTER: '0', DITHER_DEMO_POSTS: '0' },
  stdout: log,
  stderr: log,
});
await until(async () => (await fetch(`${base}/api/health`).catch(() => null))?.ok ?? false, 30_000, 'the hub did not start');
let boot = await json('/api/bootstrap');
if (!boot.accounts.every((a: any) => a.demo)) throw new Error('not a demo hub');
await until(async () => (boot = await json('/api/bootstrap')).conversations.some((c: any) => c.variant === 'feed') && (boot.mail?.threads ?? []).some((t: any) => /Cabin weekend/.test(t.subject)), 30_000, 'no feed or mail yet');
const feed = boot.conversations.find((c: any) => c.variant === 'feed' && c.network === 'x');
const cabin = boot.mail.threads.find((t: any) => /Cabin weekend/.test(t.subject));
const lease = boot.mail.threads.find((t: any) => /Lease renewal/.test(t.subject));

const { page, close } = await launch();
const q = (s: string) => JSON.stringify(s);
/** A real press at the middle of the first element matching, once it holds still and nothing lies over it. */
async function tap(sel: string) {
  let r: { x: number; y: number; over?: string } | null = null;
  const end = Date.now() + 10_000;
  do {
    r = await page.eval<{ x: number; y: number; over?: string } | null>(
      `(() => { const e = document.querySelector(${q(sel)}); if (!e) return null; e.scrollIntoView({ block: 'nearest' }); return new Promise((ok) => { const a = e.getBoundingClientRect(); requestAnimationFrame(() => requestAnimationFrame(() => { const b = e.getBoundingClientRect(); const x = b.left + b.width / 2, y = b.top + b.height / 2; if (a.top !== b.top || a.left !== b.left) return ok({ x, y, over: 'it moved' }); const at = document.elementFromPoint(x, y); ok({ x, y, ...(at && (at === e || e.contains(at)) ? {} : { over: at ? at.outerHTML.slice(0, 120) : 'nothing' }) }); })); }); })()`,
    );
    if (r && !r.over) break;
    await Bun.sleep(50);
  } while (Date.now() < end);
  if (!r) throw new Error(`nothing to press: ${sel}`);
  if (r.over) throw new Error(`${sel} is covered or not drawn: ${r.over}`);
  for (const type of ['mousePressed', 'mouseReleased']) await page.send('Input.dispatchMouseEvent', { type, x: r.x, y: r.y, button: 'left', buttons: 1, clickCount: 1 });
}
const key = async (k: string, code = k, vk = 0) => {
  await page.send('Input.dispatchKeyEvent', { type: 'keyDown', key: k, code, windowsVirtualKeyCode: vk });
  await page.send('Input.dispatchKeyEvent', { type: 'keyUp', key: k, code, windowsVirtualKeyCode: vk });
};
const escape = () => key('Escape', 'Escape', 27);
/** Marks the first element `find` (a page expression) gives with data-test, to press it by a selector. */
const mark = (find: string, name: string) => page.eval<boolean>(`(() => { document.querySelectorAll('[data-test="${name}"]').forEach((e) => e.removeAttribute('data-test')); const e = ${find}; e?.setAttribute('data-test', '${name}'); return !!e; })()`);
const sideways = () => page.eval<any>(`({ doc: document.documentElement.scrollWidth - innerWidth, scroll: (() => { const s = document.querySelector('.thread-scroll, .timeline-scroll'); return s ? s.scrollWidth - s.clientWidth : -1; })(), box: (() => { const b = document.querySelector('.thread-box, .composer'); return b ? Math.round(b.getBoundingClientRect().right - innerWidth) : null; })() })`);

try {
  await page.size(1410, 940);
  // ------------------------------------------------------------------ a post's thread: the switch row
  await page.goto(`${base}/#/inbox/c/${feed.id}`);
  await page.until(`document.querySelectorAll('.feed-unit').length >= 4`, 20000);
  await mark(`[...document.querySelectorAll('.feed-unit[data-unit="post"] .feed-mine')].find((a) => /Greedy routing/.test(a.textContent))`, 'routing');
  await tap('[data-test="routing"]');
  await page.until(`location.hash.includes('pst_x_${ROUTING}') && document.querySelectorAll('.thread-pane .ct-node').length > 0`, 20000);
  const row = await page.eval<any>(`(() => { const r = document.querySelector('.thread-pane .view-switch'); return r && { tabs: [...r.querySelectorAll('[role=tab]')].map((t) => t.textContent), on: r.querySelector('[aria-selected=true]')?.textContent, afterHead: r.previousElementSibling?.matches('.conv-head, .thread-crumb') }; })()`);
  check("a post's thread: the switch row under its header, Chat · Thread, Thread first chosen", row?.tabs.join() === 'Chat,Thread' && row.on === 'Thread' && row.afterHead, row);

  // ------------------------------------------------------------------ as a chat
  await tap('.thread-pane [data-tab="chat"]');
  await page.until(`!!document.querySelector('.thread-pane .ct-chat') && !document.querySelector('.thread-pane .ct-style')`, 5000);
  check('Chat: the replies in one column; the tree’s style pictures gone', true);
  const thread = await json(`/api/posts/x/${ROUTING}/thread`);
  const known = new Map<string, any>([...thread.replies.flat(), ...(thread.logged ?? [])].filter((p: any) => p.id !== ROUTING).map((p: any) => [p.id, p]));
  const drawn = await page.eval<string[]>(`[...document.querySelectorAll('.thread-pane .ct-chat-row')].map((r) => r.dataset.post)`);
  const times = drawn.map((id) => known.get(id)?.ts ?? NaN);
  // What the thread holds now (read ahead goes on): the count by Replies, the same in both views.
  const shownN = await page.eval<number>(`Number(document.querySelector('.thread-pane .thread-replies-n')?.textContent)`);
  const deep = drawn.filter((id) => { const to = known.get(id)?.replyTo?.id; return to && to !== ROUTING && known.get(to)?.replyTo?.id && known.get(to).replyTo.id !== ROUTING; });
  check('every reply the thread holds, at any depth, each once', drawn.length === shownN && drawn.every((id) => known.has(id)) && new Set(drawn).size === drawn.length && deep.length > 0, { drawn: drawn.length, shownN, deep: deep.length });
  check('…oldest first', times.every((t, i) => i === 0 || t >= times[i - 1]), times);
  const answers = await page.eval<any[]>(`[...document.querySelectorAll('.thread-pane .ct-chat-row')].map((r) => ({ id: r.dataset.post, line: r.querySelector(':scope > .ct-answers b')?.textContent ?? null }))`);
  const byId = new Map(known);
  const wrong = answers.filter((a) => {
    const p = byId.get(a.id);
    const to = p?.replyTo?.id;
    if (!to || to === ROUTING) return a.line !== null;
    return a.line === null;
  });
  check('a reply to a reply has a line over it saying what it answers; a reply to the post none', !wrong.length && answers.some((a) => a.line), { wrong, lines: answers.filter((a) => a.line).length });
  // Days: a day line wherever the day changes from the post through the replies, as a chat has.
  const days = await page.eval<any>(`(() => { const post = ${JSON.stringify((thread.focal.repostOf ?? thread.focal).ts)}; const ts = ${JSON.stringify(times)}; let d = new Date(post).toDateString(), n = 0; for (const t of ts) { const e = new Date(t).toDateString(); if (e !== d) n++; d = e; } return { want: n, drawn: document.querySelectorAll('.thread-pane .ct-chat .day-sep').length }; })()`);
  check('a day line wherever the day changes', days.want === days.drawn, days);
  // The line over a reply brings the reply it answers into view, lit.
  await mark(`document.querySelector('.thread-pane .ct-chat-row .ct-answers')`, 'answers');
  const target = await page.eval<string>(`(() => { const row = document.querySelector('[data-test="answers"]').closest('.ct-chat-row'); return ${JSON.stringify(Object.fromEntries([...known].map(([id, p]) => [id, p.replyTo?.id ?? null])))}[row.dataset.post]; })()`);
  await page.eval(`document.querySelector('.thread-scroll').scrollTop = 0`);
  await tap('[data-test="answers"]');
  await page.until(`document.querySelector(${q(`.thread-pane .ct-chat-row[data-post="${target}"]`)})?.classList.contains('ct-lit')`, 3000).then(
    () => check('a press on that line lights the reply it answers', true),
    () => check('a press on that line lights the reply it answers', false),
  );
  if (shots) await page.shot(join(shots, 'thread-chat.png'));
  // Kept on the device.
  await page.eval('location.reload()');
  await page.until(`!!document.querySelector('.thread-pane .ct-chat')`, 20000).then(
    () => check('the choice is kept: Chat again after a reload', true),
    () => check('the choice is kept: Chat again after a reload', false),
  );

  // ------------------------------------------------------------------ your reply, posted and deleted
  await page.eval(`(() => { const a = document.querySelector('.thread-box .compose-text'); a.focus(); })()`);
  await page.send('Input.insertText', { text: 'A note to delete again.' });
  let w0 = (await writes()).length;
  await tap('.thread-box .compose-send');
  await page.until(`[...document.querySelectorAll('.thread-pane .ct-chat-row')].pop()?.textContent.includes('A note to delete again.')`, 10000).then(
    () => check('posted from the box, the reply is the chat’s newest, at its end', true),
    async () => check('posted from the box, the reply is the chat’s newest, at its end', false, await page.eval(`({ last: [...document.querySelectorAll('.thread-pane .ct-chat-row')].pop()?.textContent.slice(0, 80), box: document.querySelector('.thread-box .compose-text')?.value, toasts: [...document.querySelectorAll('.toast')].map((t) => t.textContent.slice(0, 80)), err: document.querySelector('.compose-error')?.textContent, send: document.querySelector('.thread-box .compose-send')?.textContent, ta: document.querySelector('.thread-box .compose-text')?.disabled, focus: document.activeElement?.className })`)),
  );
  const mine = await page.eval<string>(`[...document.querySelectorAll('.thread-pane .ct-chat-row')].pop().dataset.post`);
  await tap(`.thread-pane .ct-chat-row[data-post="${mine}"] .pa-btn.more`);
  await mark(`[...document.querySelectorAll('.pa-float [role=menuitem]')].find((b) => /Delete/.test(b.textContent))`, 'delete');
  await tap('[data-test="delete"]');
  await mark(`[...document.querySelectorAll('.pa-float [role=menuitem]')].find((b) => /Delete it from X/.test(b.textContent))`, 'sure');
  await tap('[data-test="sure"]');
  await page.until(`!document.querySelector(${q(`.thread-pane [data-post="${mine}"]`)})`, 10000).then(
    () => check('your reply’s ⋯ has Delete; asked again, it goes from the page', true),
    () => check('your reply’s ⋯ has Delete; asked again, it goes from the page', false),
  );
  await until(async () => (await writes()).length >= w0 + 2, 5000, 'the delete did not reach X');
  check('…and from X: posted once, deleted once', (await writes()).slice(w0).join() === 'publish,unpublish', (await writes()).slice(w0));

  // ------------------------------------------------------------------ Escape: the aim first, then the page
  const here = await page.eval<string>('location.hash');
  await mark(`[...document.querySelectorAll('.thread-pane .ct-chat-row')].find((r) => r.querySelector('.post-who b')?.textContent === 'Ravi')?.querySelector('.pa-btn.reply')`, 'reply');
  await tap('[data-test="reply"]');
  // Reply puts the cursor in the box a moment after it aims it: wait for that, then take the cursor out, so the Escapes
  // below are the page's and not the box's.
  await page.until(`!!document.querySelector('.thread-box')?.dataset.aimed && document.activeElement?.matches('.thread-box .compose-text')`, 3000);
  await page.eval(`document.activeElement?.blur()`);
  await escape();
  await page.until(`!document.querySelector('.thread-box')?.dataset.aimed`, 3000);
  check('aimed at a reply, Escape takes the aim off and the page stays', (await page.eval<string>('location.hash')) === here);
  await escape();
  await page.until(`location.hash !== ${q(here)}`, 3000).then(
    () => check('…a second Escape leaves the page', true),
    () => check('…a second Escape leaves the page', false),
  );

  // ------------------------------------------------------------------ a phone
  await page.size(390, 844, true);
  await page.goto(`${base}/#/inbox/c/pst_x_${ROUTING}`);
  await page.until(`!!document.querySelector('.thread-pane .ct-chat') && !!document.querySelector('.thread-box')`, 20000);
  let sw = await sideways();
  check('on a phone, as a chat: nothing sideways, the box inside the screen', sw.doc <= 0 && sw.scroll === 0 && sw.box !== null && sw.box <= 0, sw);
  if (shots) await page.shot(join(shots, 'phone-thread-chat.png'));
  await tap('.thread-pane [data-tab="thread"]');
  await page.until(`!!document.querySelector('.thread-pane .ct-node')`, 5000);
  sw = await sideways();
  check('…and as a thread', sw.doc <= 0 && sw.scroll === 0 && sw.box !== null && sw.box <= 0, sw);

  // ------------------------------------------------------------------ mail threads
  await page.size(1410, 940);
  await page.goto(`${base}/#/inbox/c/${lease.id}`);
  await page.until(`document.querySelectorAll('.mail-thread-pane [id^="m-"]').length >= 3`, 20000);
  check('a mail thread where nobody branched: no switch row', !(await page.eval<boolean>(`!!document.querySelector('.mail-thread-pane .view-switch')`)));
  await page.goto(`${base}/#/inbox/c/${cabin.id}`);
  await page.until(`document.querySelectorAll('.mail-thread-pane [id^="m-"]').length >= 4 && !!document.querySelector('.mail-thread-pane [data-tab="thread"]')`, 20000);
  check('one where a mail has two answers: the row, Chat first chosen', (await page.eval<string>(`document.querySelector('.mail-thread-pane .view-switch [aria-selected=true]')?.textContent`)) === 'Chat');
  await tap('.mail-thread-pane [data-tab="thread"]');
  await page.until(`document.querySelectorAll('.mail-thread-pane .mail-tree-row').length === 4`, 5000);
  const tree = await page.eval<any[]>(`[...document.querySelectorAll('.mail-thread-pane .mail-tree-row')].map((r) => ({ depth: Number(r.dataset.depth), who: r.querySelector('.msg-author, .msg-name, .msg-head b')?.textContent ?? '', text: r.textContent.slice(0, 400) }))`);
  const said = (t: any, s: string) => t.text.includes(s);
  check(
    'as Thread: both answers to Rosa’s first mail step in under it; Rosa’s answer to yours goes on under yours',
    tree.length === 4 && tree[0].depth === 0 && said(tree[0], 'The cabin is free') && tree[1].depth === 1 && said(tree[1], 'board games') && tree[2].depth === 1 && said(tree[2], 'firewood') && tree[3].depth === 1 && said(tree[3], 'Is there a bus'),
    tree.map((t) => `${t.depth} ${t.text.replace(/\s+/g, ' ').slice(0, 60)}`),
  );
  if (shots) await page.shot(join(shots, 'mail-thread.png'));
  // The rail folds a branch: yours and Rosa's answer to it.
  await mark(`[...document.querySelectorAll('.mail-thread-pane .mail-tree-row.head')].find((r) => r.textContent.includes('board games')).querySelector('.mail-tree-rail')`, 'rail');
  await tap('[data-test="rail"]');
  await page.until(`!document.querySelector('.mail-thread-pane').textContent.includes('firewood') && !!document.querySelector('.mail-thread-pane .mail-tree-more')`, 3000).then(
    () => check('its rail folds the branch: "1 more mail" in its place', true),
    () => check('its rail folds the branch: "1 more mail" in its place', false),
  );
  await tap('.mail-thread-pane .mail-tree-more');
  await page.until(`document.querySelector('.mail-thread-pane').textContent.includes('firewood')`, 3000).then(
    () => check('…and unfolds again', true),
    () => check('…and unfolds again', false),
  );
  await page.eval('location.reload()');
  await page.until(`document.querySelectorAll('.mail-thread-pane .mail-tree-row').length === 4`, 20000).then(
    () => check('the mail choice is kept: Thread again after a reload', true),
    () => check('the mail choice is kept: Thread again after a reload', false),
  );
  await page.size(390, 844, true);
  await page.goto(`${base}/#/inbox/c/${cabin.id}`);
  await page.until(`document.querySelectorAll('.mail-thread-pane .mail-tree-row').length === 4`, 20000);
  sw = await sideways();
  check('a mail thread as a tree on a phone: nothing sideways', sw.doc <= 0 && sw.scroll <= 0, sw);
  if (shots) await page.shot(join(shots, 'phone-mail-thread.png'));

  const errors = page.errors.filter((e) => !/WebSocket connection|Failed to load resource/.test(e));
  check('no script errors', !errors.length, errors);
} catch (e) {
  failed++;
  console.log('FAIL  ', e);
} finally {
  await close();
  hub.kill('SIGTERM');
  await hub.exited;
  if (!args.includes('--keep')) rmSync(work, { recursive: true, force: true });
  else console.log(`kept ${work}`);
}
console.log(failed ? `${failed} failed` : 'all passed');
process.exit(failed ? 1 : 0);
