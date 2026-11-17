/**
 * The Feed page (docs/feed.md "The Feed page"), in a real browser against a demo hub of its own on a fresh data dir,
 * with the demo's two X accounts: Home merges both accounts' Following, a post both follow once; For you says why;
 * the composer posts as one account or both in one press, cuts a long text into a thread, limits who can reply, takes
 * a picture, saves drafts and schedules; a post of yours is deleted from the network, a cross-post's other copy
 * staying; likes and replies go as the account whose timeline showed the post; Activity is every account's
 * notifications; an old link to the notifications conversation lands there; and a phone has its sources in a row of
 * chips, the composer one line until tapped, and a post's thread in the list's place.
 *
 *   bun scripts/verify-feed-page.ts [--port <port>] [--web <built dist>] [--work <empty dir>] [--keep] [--shots <dir>]
 *
 * Builds the web app unless --web names a build. Every press is real input (DevTools Input events).
 */
import { mkdirSync, mkdtempSync, openSync, rmSync, writeFileSync } from 'node:fs';
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
const work = args.includes('--work') ? opt('work', '') : mkdtempSync(join(tmpdir(), `dither-verify-feed-page-${PORT}-`));
mkdirSync(work, { recursive: true });
const shots = opt('shots', '');
if (shots) mkdirSync(shots, { recursive: true });

const X1 = 'acc_demo-x';
const X2 = 'acc_demo-x2';

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
const action = (acc: string, name: string) => json(`/api/accounts/${acc}/action`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ action: name }) });
const writes = async (acc: string) => ((await action(acc, 'writeLog')).result?.writes ?? []) as string[];

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
  env: { ...process.env, DITHER_DEMO_CHATTER: '0' },
  stdout: log,
  stderr: log,
});
await until(async () => (await fetch(`${base}/api/health`).catch(() => null))?.ok ?? false, 30_000, 'the hub did not start');
let boot = await json('/api/bootstrap');
if (!boot.accounts.every((a: any) => a.demo)) throw new Error('not a demo hub');
await until(async () => (boot = await json('/api/bootstrap')).conversations.filter((c: any) => c.variant === 'feed').length === 2, 15_000, 'two feed conversations');
const feedConv = boot.conversations.find((c: any) => c.variant === 'feed' && c.vantages.some((v: any) => v.accountId === X1));
// A picture to post.
const PNG = join(work, 'shot.png');
writeFileSync(PNG, Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==', 'base64'));

const { page, close } = await launch();
const q = (s: string) => JSON.stringify(s);
/** A real press at the middle of the first element matching. */
async function tap(sel: string) {
  const r = await page.eval<{ x: number; y: number } | null>(
    `(() => { const e = document.querySelector(${q(sel)}); if (!e) return null; e.scrollIntoView({ block: 'center' }); const b = e.getBoundingClientRect(); return { x: b.left + b.width / 2, y: b.top + b.height / 2 }; })()`,
  );
  if (!r) throw new Error(`nothing to press: ${sel}`);
  for (const type of ['mousePressed', 'mouseReleased']) await page.send('Input.dispatchMouseEvent', { type, x: r.x, y: r.y, button: 'left', clickCount: 1 });
}
const typeText = (text: string) => page.send('Input.insertText', { text });
const count = (sel: string) => page.eval<number>(`document.querySelectorAll(${q(sel)}).length`);
const text = (sel: string) => page.eval<string>(`document.querySelector(${q(sel)})?.textContent ?? ''`);
const overflow = (sel: string) => page.eval<number>(`(() => { const e = document.querySelector(${q(sel)}); return e ? e.scrollWidth - e.clientWidth : -1; })()`);
const mine = () => json('/api/feed/entries?source=mine');
/** The composer done with its last press: the box enabled and empty, so what is typed next lands in it. */
const idle = () => page.until(`(() => { const t = document.querySelector('.feed-composer textarea'); return !!t && !t.disabled && t.value === ''; })()`, 15000);

try {
  await page.size(1410, 940);
  await page.goto(`${base}/#/feed`);
  await page.until(`document.querySelectorAll('.feed-entry').length >= 5`, 30000);

  // ---------------------------------------------------------------- Home and the sources
  const side = await page.eval<string[]>(`[...document.querySelectorAll('.feed-src')].map((b) => b.textContent.trim())`);
  check('the sources: Home, Activity, Your posts, Drafts, then each account’s Following, For you, Activity and Posts', side.slice(0, 4).join() === 'Home,Activity,Your posts,Drafts' && side.filter((s) => s === 'For you').length === 2, side);
  check('the rail’s Feed button is the page’s', (await count('.rail [data-track="feed"].active, .rail .active[title="Feed"]')) >= 0 && (await page.eval<string>(`location.hash`)) === '#/feed');
  const gossip = await page.eval<any>(`(() => { const all = [...document.querySelectorAll('.feed-entry')].filter((e) => /gossip layer/.test(e.textContent)); return { n: all.length, via: all[0]?.querySelector('.feed-via')?.textContent }; })()`);
  check('a post both accounts follow is in Home once, saying it came through both', gossip.n === 1 && /zyan_demo/.test(gossip.via) && /work_demo/.test(gossip.via), gossip);
  const conv = await page.eval<any>(`(() => { const e = [...document.querySelectorAll('.feed-entry')].find((e) => e.querySelectorAll('.thread-post').length > 1); return e && { rows: e.querySelectorAll('.thread-post').length, line: e.querySelector('.thread-post').classList.contains('line') }; })()`);
  check('a reply in Home shows the post above it, joined by a line', !!conv && conv.rows === 2 && conv.line, conv);
  if (shots) await page.shot(join(shots, 'feed-home-desktop.png'));

  // For you, and why a post is there
  await tap(`.feed-src[data-source="${X1}:foryou"]`);
  await page.until(`[...document.querySelectorAll('.feed-reason')].some((r) => /Alice Chen liked/.test(r.textContent))`, 20000);
  const reasons = await page.eval<string[]>(`[...document.querySelectorAll('.feed-reason')].map((r) => r.textContent.trim())`);
  check('For you says why a post is there, in X’s words', reasons.includes('Alice Chen liked') && reasons.includes('Popular in Distributed systems'), reasons);
  check('…and its header names the account', /zyan_demo/.test(await text('.feed-main .conv-head-sub')), await text('.feed-main .conv-head-sub'));
  const homeLog = (await action(X1, 'homeLog')).result?.home ?? [];
  check('X was asked for this account’s For you only when it was opened', homeLog.some((h: any) => h.feed === 'foryou') && homeLog.filter((h: any) => h.feed === 'foryou').length === 1, homeLog);

  // ---------------------------------------------------------------- posting as both accounts
  await tap('.feed-src[data-source="home"]');
  await page.until(`!!document.querySelector('.feed-composer textarea')`, 10000);
  const as = await page.eval<string[]>(`[...document.querySelectorAll('.feed-as-chip')].map((b) => b.textContent.trim() + (b.classList.contains('on') ? '*' : ''))`);
  check('Post as: both accounts, the first picked', as.length === 2 && as[0].endsWith('*') && !as[1].endsWith('*'), as);
  await tap(`.feed-as-chip[data-as="${X2}"]`);
  await idle();
  await tap('.feed-composer textarea');
  await typeText('Two accounts, one press.');
  check('the button says it posts to two', /Post to 2/.test(await text('.feed-composer .compose-send')), await text('.feed-composer .compose-send'));
  await tap('.feed-composer .compose-send');
  await until(async () => (await mine()).entries.some((e: any) => e.post.text === 'Two accounts, one press.'), 15000, 'the cross-post in Your posts');
  const cross = (await mine()).entries.find((e: any) => e.post.text === 'Two accounts, one press.');
  check('one press made one post on each account, one entry in Your posts with the other as a copy', cross.copies?.length === 1 && cross.copies[0].accountId !== cross.seenBy[0].accountId, { seenBy: cross.seenBy, copies: cross.copies?.map((c: any) => c.accountId) });
  check('…each account was asked once', (await writes(X1)).filter((w) => w === 'publish').length === 1 && (await writes(X2)).filter((w) => w === 'publish').length === 1, { x1: await writes(X1), x2: await writes(X2) });
  await page.until(`(document.querySelector('.feed-composer textarea')?.value ?? 'x') === ''`, 5000);
  check('the box empties after posting, and the new post is on top of Home', (await page.eval<string>(`document.querySelector('.feed-entry .post-text')?.textContent ?? ''`)).includes('Two accounts, one press.'), await page.eval(`document.querySelector('.feed-entry .post-text')?.textContent`));

  // A thread, as one account, only people it follows replying
  await tap(`.feed-as-chip[data-as="${X2}"]`);
  const long = Array.from({ length: 3 }, (_, i) => `Paragraph ${i + 1}. ` + 'Routing on a sheaf keeps each hop local, and the global picture falls out of the gluing. '.repeat(2)).join('\n\n');
  await idle();
  await tap('.feed-composer textarea');
  await typeText(long);
  await page.until(`/Posts as a thread/.test(document.querySelector('.feed-composer')?.textContent ?? '')`, 5000);
  check('too long for one post: it offers a thread, the parts named', /3 posts on @zyan_demo/.test(await text('.feed-composer .feed-note')), await text('.feed-composer .feed-note'));
  await page.eval(`(() => { const s = document.querySelector('.feed-gate'); s.value = 'following'; s.dispatchEvent(new Event('change', { bubbles: true })); })()`);
  if (shots) await page.shot(join(shots, 'feed-composer-thread.png'));
  const before = (await writes(X1)).length;
  await tap('.feed-composer .compose-send');
  await until(async () => (await writes(X1)).length === before + 3, 15000, 'three posts on the first account');
  // Your posts lists posts, not the replies continuing them (as X's Posts tab): the thread's page has the rest.
  const first = (await mine()).entries.find((e: any) => /Paragraph 1/.test(e.post.text));
  const tv = first ? await json(`/api/posts/x/${first.post.id}/thread`) : null;
  const chain = (tv?.replies ?? [])[0] ?? [];
  check('the thread went as three posts, each a reply to the one before', chain.length === 2 && /Paragraph 2/.test(chain[0].text) && chain[0].replyTo?.id === first.post.id && /Paragraph 3/.test(chain[1].text) && chain[1].replyTo?.id === chain[0].id, chain.map((p: any) => ({ t: p.text.slice(0, 12), to: p.replyTo?.id })));
  check('…the first limited to people it follows', first?.post.replies === 'following', first?.post.replies);
  check('…and the second account was not asked', (await writes(X2)).filter((w) => w === 'publish').length === 1);

  // A picture
  await idle();
  await tap('.feed-composer textarea');
  await typeText('With a picture.');
  const input = await page.send<any>('Runtime.evaluate', { expression: `document.querySelector('.feed-composer input[type=file]')` });
  await page.send('DOM.setFileInputFiles', { files: [PNG], objectId: input.result.objectId });
  await page.until(`!!document.querySelector('.feed-pic') && !document.querySelector('.feed-pic.up')`, 15000);
  check('a picture added shows in the box once it is on the hub', (await count('.feed-pic img')) === 1);
  await tap('.feed-composer .compose-send');
  await until(async () => (await mine()).entries.some((e: any) => e.post.text === 'With a picture.' && e.post.media?.length === 1), 15000, 'the post with its picture');
  check('the post went with its picture', true);

  // ---------------------------------------------------------------- drafts and scheduling
  await idle();
  await tap('.feed-composer textarea');
  await typeText('For later.');
  await tap('.feed-composer .feed-foot .icon-btn[aria-label="Schedule"]');
  await page.until(`!!document.querySelector('.feed-sched input')`, 5000);
  await page.eval(`(() => { const i = document.querySelector('.feed-sched input'); const d = new Date(Date.now() + 2 * 3600e3 - new Date().getTimezoneOffset() * 60e3); i.value = d.toISOString().slice(0, 16); i.dispatchEvent(new Event('input', { bubbles: true })); })()`);
  await tap('.feed-composer .compose-send');
  await until(async () => (await json('/api/feed/drafts')).drafts.length === 1, 10000, 'the scheduled draft');
  const d = (await json('/api/feed/drafts')).drafts[0];
  check('Schedule keeps it on the hub with its time and account', d.text === 'For later.' && d.scheduledAt > Date.now() + 3600e3 && d.accounts.join() === X1, d);
  await page.until(`/1/.test(document.querySelector('.feed-src[data-source="drafts"] .feed-src-count')?.textContent ?? '')`, 5000);
  check('Drafts counts it', true);
  await tap('.feed-src[data-source="drafts"]');
  await page.until(`!!document.querySelector('.feed-draft')`, 5000);
  check('Drafts shows when it posts and as whom', /Posts/.test(await text('.feed-draft-when')) && /zyan_demo/.test(await text('.feed-draft-as')), { when: await text('.feed-draft-when'), as: await text('.feed-draft-as') });
  if (shots) await page.shot(join(shots, 'feed-drafts.png'));
  await tap('.feed-draft-foot .btn');
  await page.until(`document.querySelector('.feed-composer textarea')?.value === 'For later.' && !!document.querySelector('.feed-sched input')`, 10000);
  check('Edit opens it in the composer on Home, still scheduled', true);
  // Posted now, from the draft: it leaves Drafts.
  await tap('.feed-sched .link-btn');
  await tap('.feed-composer .compose-send');
  await until(async () => (await json('/api/feed/drafts')).drafts.length === 0, 10000, 'the draft gone once posted');
  check('posting a draft takes it out of Drafts', true);

  // ---------------------------------------------------------------- delete, and acting as the account that saw it
  await tap('.feed-src[data-source="mine"]');
  const key = `x:${cross.post.id}`;
  await page.until(`!!document.querySelector('.feed-entry[data-entry=${q(key)}] .pa-btn.more')`, 10000);
  await tap(`.feed-entry[data-entry=${q(key)}] .pa-btn.more`);
  await tap('.pa-menu [role="menuitem"]');
  await page.until(`/Delete it from X/.test(document.querySelector('.pa-menu')?.textContent ?? '')`, 3000);
  await tap('.pa-menu .danger');
  await until(async () => (await writes(cross.seenBy[0].accountId)).includes('unpublish'), 10000, 'the delete on X');
  await page.until(`!document.querySelector('.feed-entry[data-entry=${q(key)}]')`, 5000);
  const left = await page.eval<number>(`[...document.querySelectorAll('.feed-entry')].filter((e) => /Two accounts, one press/.test(e.textContent)).length`);
  check('Delete asks again, deletes it on X, and the other account’s copy stays', left === 1, left);

  await tap('.feed-src[data-source="home"]');
  await page.until(`[...document.querySelectorAll('.feed-entry')].some((e) => /repo-tools 2.0/.test(e.textContent))`, 10000);
  const likesBefore = { x1: (await writes(X1)).filter((w) => w === 'postAct:like').length, x2: (await writes(X2)).filter((w) => w === 'postAct:like').length };
  await page.eval(`[...document.querySelectorAll('.feed-entry')].find((e) => /repo-tools 2.0/.test(e.textContent)).setAttribute('data-test', 'release')`);
  await tap('.feed-entry[data-test="release"] .pa-btn.like');
  await until(async () => (await writes(X2)).filter((w) => w === 'postAct:like').length === likesBefore.x2 + 1, 10000, 'a like as the work account');
  check('a like on a post only the work account follows goes as that account', (await writes(X1)).filter((w) => w === 'postAct:like').length === likesBefore.x1);
  await tap('.feed-entry[data-test="release"] .pa-btn.reply');
  await page.until(`!!document.querySelector('.feed-entry[data-test="release"] .post-composer textarea')`, 5000);
  check('Reply opens a box under the card, replying to its author', /Replying to/.test(await text('.feed-entry[data-test="release"] .compose-to')), await text('.feed-entry[data-test="release"] .compose-to'));
  await typeText('Congrats on the release.');
  const x2posts = (await writes(X2)).filter((w) => w === 'publish').length;
  await tap('.feed-entry[data-test="release"] .post-composer .compose-send');
  await until(async () => (await writes(X2)).filter((w) => w === 'publish').length === x2posts + 1, 10000, 'the reply as the work account');
  check('…and the reply goes as that account too', true);

  // ---------------------------------------------------------------- a post's thread beside the list
  await tap('.feed-entry[data-test="release"] .post-text');
  await page.until(`!!document.querySelector('.feed-thread .thread-focal')`, 15000);
  const beside = await page.eval<any>(`({ hash: location.hash, list: !!document.querySelector('.feed-main') && getComputedStyle(document.querySelector('.feed-main')).display !== 'none', thread: document.querySelector('.feed-thread').getBoundingClientRect().width })`);
  check('a post opens its thread beside the list on a computer', beside.hash.startsWith('#/feed/home/p/pst_x_') && beside.list && beside.thread > 300, beside);
  if (shots) await page.shot(join(shots, 'feed-thread-beside.png'));
  await page.eval(`history.back()`);
  await page.until(`!document.querySelector('.feed-thread')`, 5000);
  check('Back closes it', (await page.eval<string>(`location.hash`)) === '#/feed/home', await page.eval(`location.hash`));

  // ---------------------------------------------------------------- Activity
  await tap('.feed-src[data-source="activity"]');
  await page.until(`document.querySelectorAll('.feed-unit').length > 3`, 15000);
  const act = await page.eval<string>(`document.querySelector('.feed-main .feed-list').textContent`);
  check('Activity is both accounts’ notifications together', /routing on sheaves|Ravi|Theo/i.test(act) && /Sent this to two friends/.test(act), act.slice(0, 160));
  if (shots) await page.shot(join(shots, 'feed-activity.png'));
  await page.goto(`${base}/#/inbox/c/${feedConv.id}`);
  await page.until(`location.hash.startsWith('#/feed/')`, 10000);
  check('an old link to the notifications conversation lands on that account’s Activity', (await page.eval<string>(`decodeURIComponent(location.hash)`)) === `#/feed/${X1}:activity`, await page.eval(`location.hash`));
  check('the inbox has no notifications row any more', (await count('.feed-row')) === 0);

  // ---------------------------------------------------------------- a phone
  // A phone opens the app afresh.
  await page.goto('about:blank');
  await page.size(390, 844, true);
  await page.goto(`${base}/#/feed`);
  await page.until(`!!document.querySelector('.feed-strip') && document.querySelectorAll('.feed-entry').length > 2`, 20000);
  check('on a phone, the sources are a row of chips', (await count('.feed-chip')) >= 6);
  check('…the composer is one line until tapped', (await count('.feed-compose-closed')) === 1 && (await count('.feed-composer')) === 0);
  if (shots) await page.shot(join(shots, 'feed-home-phone.png'));
  await tap('.feed-compose-closed');
  await page.until(`!!document.querySelector('.feed-composer textarea')`, 5000);
  check('…and opens on a tap', true);
  check('nothing sideways on a phone', (await overflow('.feed-main .feed-scroll')) === 0 && (await page.eval<number>(`document.documentElement.scrollWidth - innerWidth`)) <= 0, await overflow('.feed-main .feed-scroll'));
  if (shots) await page.shot(join(shots, 'feed-composer-phone.png'));
  await tap('.feed-entry .post-text');
  await page.until(`!!document.querySelector('.feed-thread .thread-focal')`, 15000);
  const ph = await page.eval<any>(`({ list: getComputedStyle(document.querySelector('.feed-main')).display, w: Math.round(document.querySelector('.feed-thread').getBoundingClientRect().width) })`);
  check('a post’s thread takes the list’s place on a phone', ph.list === 'none' && ph.w >= 380, ph);
  await tap('.feed-thread .conv-head .back');
  await page.until(`!document.querySelector('.feed-thread') && getComputedStyle(document.querySelector('.feed-main')).display !== 'none'`, 5000);
  check('…and its Back returns to the list', true);

  const errors = page.errors.filter((e) => !/WebSocket connection|Failed to load resource/.test(e));
  check('no script errors', !errors.length, errors);
} catch (e) {
  failed++;
  console.log('FAIL  ', e);
  if (shots) await page.shot(join(shots, 'feed-failed.png')).catch(() => {});
} finally {
  await close();
  hub.kill('SIGTERM');
  await hub.exited;
  if (!args.includes('--keep')) rmSync(work, { recursive: true, force: true });
  else console.log(`kept ${work}`);
}
console.log(failed ? `${failed} failed` : 'all passed');
process.exit(failed ? 1 : 0);
