/**
 * Posts' threads and links in bios (docs/feed.md "Threads", docs/profile.md), in a real browser against a demo hub of
 * its own on a fresh data dir. The demo X account's routing post has a thread: the author continuing it, Ravi and the
 * author going back and forth, two more replies, and two on a second page.
 *
 *   bun scripts/verify-x-threads.ts [--port 8697] [--web <built dist>] [--work <empty dir>] [--keep] [--shots <dir>]
 *
 * Checks, on a desktop and a phone: a link in a bio is a link (with its scheme, and a bare address); a card in the
 * feed opens its post's thread in the app; the thread shows the post large, the author's own continuation first, the
 * chains joined by a line, and more replies on asking; a reply opens with what it answers above it; a profile's recent
 * post opens its thread; the posts read are logged as messages in a read-only posts conversation that search finds and
 * whose message opens its thread; nothing is sent to X but the reads; nothing sideways; no script errors.
 */
import { mkdirSync, mkdtempSync, openSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { launch } from './browser.ts';

const args = process.argv.slice(2);
const opt = (k: string, d: string) => (args.includes(`--${k}`) ? args[args.indexOf(`--${k}`) + 1] : d);
const PORT = Number(opt('port', '8697'));
const root = resolve(import.meta.dir, '..');
const base = `http://127.0.0.1:${PORT}`;
const work = args.includes('--work') ? opt('work', '') : mkdtempSync(join(tmpdir(), `dither-verify-x-threads-${PORT}-`));
mkdirSync(work, { recursive: true });
const shots = opt('shots', '');
if (shots) mkdirSync(shots, { recursive: true });
const X_ACC = 'acc_demo-x';

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
const action = (name: string) => json(`/api/accounts/${X_ACC}/action`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ action: name }) });

let web = opt('web', '');
if (!web) {
  web = join(work, 'web');
  console.log('building the web app…');
  const b = Bun.spawnSync(['bunx', '--bun', 'vite', 'build', '--outDir', web, '--emptyOutDir'], { cwd: join(root, 'packages/web'), stdout: 'pipe', stderr: 'pipe' });
  if (b.exitCode !== 0) throw new Error('web build failed:\n' + b.stderr.toString());
}
if (Bun.spawnSync(['sh', '-c', `ss -ltn | grep -q ':${PORT} '`]).exitCode === 0) throw new Error(`something is already listening on ${PORT}`);
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
await until(async () => (boot = await json('/api/bootstrap')).conversations.some((c: any) => c.variant === 'feed'), 15_000, 'no feed conversation');
const feed = boot.conversations.find((c: any) => c.variant === 'feed');
const alice = boot.identities.find((i: any) => i.network === 'x' && i.handle === 'alicechen_dev');
const quinn = boot.identities.find((i: any) => i.network === 'x' && i.handle === 'quinnwrites');

const { page, close } = await launch();
const load = async (hash: string) => {
  await page.goto('about:blank');
  await page.goto(`${base}/${hash}`);
};
const overflow = (sel: string) => page.eval<number>(`(() => { const s = document.querySelector(${JSON.stringify(sel)}); return s ? s.scrollWidth - s.clientWidth : -1; })()`);
const thread = () =>
  page.eval<any>(`(() => {
    const f = document.querySelector('.thread-focal');
    return {
      hash: location.hash,
      focal: f?.querySelector('.thread-focal-text')?.textContent ?? null,
      focalWho: f?.querySelector('.post-who b')?.textContent ?? null,
      ancestors: [...document.querySelectorAll('.thread-list > .thread-post')].map((p) => p.querySelector('.post-who b')?.textContent),
      chains: [...document.querySelectorAll('.thread-chain')].map((c) => [...c.querySelectorAll('.thread-post')].map((p) => p.querySelector('.post-who b')?.textContent)),
      lines: document.querySelectorAll('.thread-post.line').length,
      more: !!document.querySelector('.thread-more'),
      openOnX: f?.querySelector('.post-open')?.href ?? null,
      stored: document.querySelector('.thread-stored')?.textContent ?? null,
    };
  })()`);

try {
  // ------------------------------------------------------------------ links in bios
  await page.size(1280, 860);
  await load(`#/i/${alice.id}`);
  await page.until(`[...document.querySelectorAll('.pf-bio a.text-link, .pf-acct-bio a.text-link')].length > 0`, 20000);
  const aliceLinks = await page.eval<any[]>(`[...document.querySelectorAll('.pf-bio a.text-link, .pf-acct-bio a.text-link')].map((a) => ({ href: a.href, text: a.textContent, target: a.target }))`);
  check('a link in a bio is a link, opening in a new tab', aliceLinks.some((l) => l.href === 'https://alicechen.dev/notes' && l.text === 'https://alicechen.dev/notes' && l.target === '_blank'), aliceLinks);
  if (shots) await page.shot(join(shots, 'x-bio-link-desktop.png'));
  await load(`#/i/${quinn.id}`);
  await page.until(`[...document.querySelectorAll('.pf-bio a.text-link, .pf-acct-bio a.text-link')].length > 0`, 20000);
  const quinnLinks = await page.eval<any[]>(`[...document.querySelectorAll('.pf-bio a.text-link, .pf-acct-bio a.text-link')].map((a) => ({ href: a.href, text: a.textContent }))`);
  check('…and so is a bare address, given https', quinnLinks.some((l) => l.href === 'https://quinnwrites.blog/' && l.text === 'quinnwrites.blog'), quinnLinks);

  // ------------------------------------------------------------------ a feed card opens the thread
  await load(`#/inbox/c/${feed.id}`);
  await page.until(`document.querySelectorAll('.feed-card').length >= 7`, 20000);
  await page.eval(`[...document.querySelectorAll('.feed-card[data-type="like"]')].find((c) => c.dataset.count === '5').querySelector('.feed-what').click()`);
  await page.until(`location.hash.includes('pst_x_') && !!document.querySelector('.thread-focal') && document.querySelectorAll('.thread-chain').length > 0`, 20000);
  let t = await thread();
  check('a card in the feed opens its post in the app', /^#\/inbox\/c\/pst_x_\d+$/.test(t.hash) && /Greedy routing/.test(t.focal ?? ''), t.hash);
  check('the post large, by its author, with Open on X', t.focalWho === 'You' && /^https:\/\/x\.com\/zyan_demo\/status\/\d+$/.test(t.openOnX ?? ''), t);
  check('replies in chains, the author continuing first, Ravi and the author back and forth', t.chains.length === 4 && t.chains[0].every((w: string) => w === 'You') && t.chains[1].join('>') === 'Ravi>You>Ravi', t.chains);
  check('a chain is joined by a line', t.lines === 3, t.lines);
  check('Show more replies while X has more', t.more);
  check('nothing sideways on a desktop', (await overflow('.thread-scroll')) === 0);
  if (shots) await page.shot(join(shots, 'x-thread-desktop.png'));
  await page.eval(`document.querySelector('.thread-more').click()`);
  await page.until(`document.querySelectorAll('.thread-chain').length >= 6 && !document.querySelector('.thread-more')`, 15000);
  t = await thread();
  check('more replies come on asking, and the button goes when there are no more', t.chains.length === 6 && t.chains.slice(4).map((c: string[]) => c[0]).join(',') === 'Theo,Quinn', t.chains);

  // ------------------------------------------------------------------ a reply opens with what it answers
  await page.eval(`[...document.querySelectorAll('.thread-chain')][1].querySelector('.thread-post .post-text').click()`);
  await page.until(`!!document.querySelector('.thread-focal') && /refill|churn/.test(document.querySelector('.thread-focal-text')?.textContent ?? '') && document.querySelectorAll('.thread-list > .thread-post').length > 0`, 15000);
  t = await thread();
  check("a reply opens its own thread with what it answers above it", t.focalWho === 'Ravi' && t.ancestors.join('>') === 'You' && t.chains.length === 1 && t.chains[0].join('>') === 'You', t);
  if (shots) await page.shot(join(shots, 'x-thread-reply-desktop.png'));

  // ------------------------------------------------------------------ logged as messages
  boot = await json('/api/bootstrap');
  const posts = boot.conversations.find((c: any) => c.variant === 'posts');
  check('the posts read are logged in one posts conversation for the account', !!posts && posts.network === 'x' && posts.vantages.every((v: any) => v.unread === 0), posts && { name: posts.name, vantages: posts.vantages });
  const msgs = (await json(`/api/conversations/${posts.id}/messages?limit=100`)).messages;
  // The thread's ten, and the posts of the two profiles opened above.
  check('each post once, with the post in its view', msgs.length >= 10 && new Set(msgs.map((m: any) => m.nativeId)).size === msgs.length && msgs.every((m: any) => m.post?.id && m.nativeId === `post:${m.post.id}`), msgs.length);
  const found = await json(`/api/search?q=${encodeURIComponent('refill pushed')}`);
  const hit = found.hits.find((h: any) => h.message.conversationId === posts.id);
  check('search finds a logged post by its words', !!hit, found.hits.length);
  await load('#/inbox');
  await page.until(`document.querySelectorAll('[data-row]').length > 3`, 20000);
  const inbox = await page.eval<boolean>(`!!document.querySelector('[data-row="${posts.id}"]')`);
  check('the posts conversation is not an inbox row', !inbox);
  await load(`#/inbox/c/${posts.id}?m=${hit.message.id}`);
  await page.until(`!!document.querySelector('.thread-focal')`, 20000);
  t = await thread();
  check("a logged post's message (a search hit) opens its thread", t.focalWho === 'Ravi' && t.ancestors.length === 3, t);
  await load(`#/inbox/c/${posts.id}`);
  await page.until(`document.querySelectorAll('[data-posts-view] .thread-post').length >= 10`, 20000);
  check('the posts conversation lists what was logged, newest first', true);
  if (shots) await page.shot(join(shots, 'x-posts-list-desktop.png'));
  const sendRes = await fetch(`${base}/api/conversations/${posts.id}/send`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ body: 'hi' }) });
  check('nothing can be sent there', sendRes.status === 409, sendRes.status);

  // ------------------------------------------------------------------ a profile's post opens its thread
  await load(`#/i/${alice.id}`);
  await page.until(`!!document.querySelector('.pf-posts .post-item')`, 20000);
  await page.eval(`document.querySelector('.pf-posts .post-item .post-text').click()`);
  await page.until(`location.hash.includes('pst_x_') && !!document.querySelector('.thread-focal')`, 15000);
  t = await thread();
  check("a profile's recent post opens its thread", t.focalWho === 'Alice Chen', t);

  // ------------------------------------------------------------------ X was asked for the threads and nothing else
  const reads = (await action('postLog')).result?.posts ?? null;
  const sends = (await action('sendLog')).result?.sent ?? null;
  const marks = (await action('readLog')).result?.reads ?? null;
  check('X was asked for each thread, the second page with its cursor', Array.isArray(reads) && reads.length >= 4 && reads.some((r: any) => r.cursor === 'more-1'), reads);
  check('…and sent nothing: no message, no read mark', Array.isArray(sends) && !sends.length && Array.isArray(marks) && !marks.length, { sends, marks });

  // ------------------------------------------------------------------ light, and a phone
  await page.eval(`localStorage.setItem('dither-chat:prefs', JSON.stringify({ ...JSON.parse(localStorage.getItem('dither-chat:prefs') || '{}'), theme: 'dither-light' }))`);
  await load(`#/inbox/c/pst_x_${t.hash.match(/pst_x_(\d+)/)![1]}`);
  await page.until(`!!document.querySelector('.thread-focal')`, 20000);
  if (shots) await page.shot(join(shots, 'x-thread-light.png'));
  await page.eval(`localStorage.setItem('dither-chat:prefs', JSON.stringify({ ...JSON.parse(localStorage.getItem('dither-chat:prefs') || '{}'), theme: 'dither-dark' }))`);
  await page.size(390, 844, true);
  await load(`#/inbox/c/${feed.id}`);
  await page.until(`document.querySelectorAll('.feed-card').length >= 7`, 20000);
  await page.eval(`document.querySelector('.feed-card[data-type="reply"] .feed-text').click()`);
  await page.until(`!!document.querySelector('.thread-focal') && document.querySelectorAll('.thread-list > .thread-post').length > 0`, 20000);
  await Bun.sleep(300);
  const ph = await page.eval<any>(`({ back: !!document.querySelector('.thread-pane .conv-head .back'), w: document.querySelector('.thread-pane').getBoundingClientRect().width })`);
  check('on a phone: a reply card opens its thread full width with Back', ph.back && ph.w >= 380, ph);
  check('nothing sideways on a phone', (await overflow('.thread-scroll')) === 0, await overflow('.thread-scroll'));
  if (shots) await page.shot(join(shots, 'x-thread-phone.png'));
  await page.eval(`document.querySelector('.thread-pane .conv-head .back').click()`);
  // A phone files every page opened in the inbox on top of the inbox's list (pages.ts): Back shows the list.
  await page.until(`location.hash === '#/inbox' && !!document.querySelector('.feed-row')`, 10000);
  check('Back shows the inbox, as from any page opened there', true);
  await load(`#/i/${alice.id}`);
  await page.until(`[...document.querySelectorAll('a.text-link')].length > 0`, 20000);
  if (shots) await page.shot(join(shots, 'x-bio-link-phone.png'));

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
