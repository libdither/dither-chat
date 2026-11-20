/**
 * The Feed page (docs/feed.md "The Feed page"), in a real browser against a demo hub of its own on a fresh data dir,
 * with the demo's two X accounts: Following merges both accounts' Following, a post both follow once; Discover takes
 * both accounts' For you in turns and says why each post is there; a feed's order swaps at once without asking X
 * again; Tune changes how much each timeline gets; a new feed is made, named and deleted; the composer posts as one
 * account or both in one press, cuts a long text into a thread, limits who can reply, takes a picture, saves drafts
 * and schedules; a post of yours is deleted from the network, a cross-post's other copy staying; likes and replies go
 * as the account whose timeline showed the post; Activity is every account's notifications; an old link to the
 * notifications conversation lands there; an account switched off and on again while the page is open is followed with
 * no reload; and a phone has its feeds as tabs, the order under them, Activity behind the
 * bell, Your posts and Drafts behind ⋯, the composer in a sheet from the pencil button, and a thread in the list's
 * place.
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
  env: { ...process.env, DITHER_DEMO_CHATTER: '0', DITHER_DEMO_POSTS: '0' },
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
/** A real press at the middle of the first element matching, once nothing on the page is moving (a sheet sliding in
 * moves what it holds between finding it and pressing) and nothing else lies over that point (a toast stays six
 * seconds). Centring one at the end of its scroller scrolls the window too, which the app puts back between the press
 * and its release: the window goes back first. */
async function tap(sel: string) {
  let r: { x: number; y: number; over?: string } | null = null;
  const end = Date.now() + 15_000;
  do {
    r = await page.eval<{ x: number; y: number; over?: string } | null>(
      `(() => { const e = document.querySelector(${q(sel)}); if (!e) return null; const moving = document.getAnimations().find((a) => a.playState === 'running' && a.effect?.getTiming().iterations !== Infinity); if (moving) return { x: 0, y: 0, over: 'an animation still running' }; e.scrollIntoView({ block: 'center' }); window.scrollTo(0, 0); const b = e.getBoundingClientRect(); const x = b.left + b.width / 2, y = b.top + b.height / 2; const at = document.elementFromPoint(x, y); return { x, y, ...(b.width && b.height && at && (at === e || e.contains(at)) ? {} : { over: at ? at.outerHTML.slice(0, 120) : 'nothing' }) }; })()`,
    );
    if (r && !r.over) break;
    await Bun.sleep(50);
  } while (Date.now() < end);
  if (!r) throw new Error(`nothing to press: ${sel}`);
  if (r.over) throw new Error(`${sel} is covered or not drawn: ${r.over}`);
  for (const type of ['mousePressed', 'mouseReleased']) await page.send('Input.dispatchMouseEvent', { type, x: r.x, y: r.y, button: 'left', clickCount: 1 });
}
const typeText = (text: string) => page.send('Input.insertText', { text });
const count = (sel: string) => page.eval<number>(`document.querySelectorAll(${q(sel)}).length`);
const text = (sel: string) => page.eval<string>(`document.querySelector(${q(sel)})?.textContent ?? ''`);
const overflow = (sel: string) => page.eval<number>(`(() => { const e = document.querySelector(${q(sel)}); return e ? e.scrollWidth - e.clientWidth : -1; })()`);
const mine = () => json('/api/feed/entries?source=mine');
const mixOf = async (id: string) => (await json('/api/feed/sources')).mixes.find((m: any) => m.id === id);
const shownKeys = () => page.eval<string[]>(`[...document.querySelectorAll('.feed-main .feed-entry')].map((e) => e.dataset.entry)`);
/** A sheet closed has given back its history entry (phone.ts dropLayer): a navigation before then is undone by it. */
const settled = () =>
  page.until(`!document.querySelector('.sheet') && history.state?.layer === undefined`, 5000).catch(async (e) => {
    throw new Error(`${e.message}\n  state: ${await page.eval<string>(`JSON.stringify({ state: history.state, hash: location.hash, sheets: document.querySelectorAll('.sheet').length, len: history.length })`)}`);
  });
/** A range moved as a drag ends: its value, then input and change. */
const slide = (sel: string, v: number) =>
  page.eval(`(() => { const i = document.querySelector(${q(sel)}); i.value = ${v}; i.dispatchEvent(new Event('input', { bubbles: true })); i.dispatchEvent(new Event('change', { bubbles: true })); })()`);
/** The list done asking for pages: not reading, and either nothing more to ask for or its end out of reach (FeedPage's
 * Scroll asks for more while its end is within 600 px). */
const listSettled = () =>
  page.until(`(() => { const s = document.querySelector('.feed-main .feed-scroll'); return !!s && !s.hasAttribute('data-reading') && (s.hasAttribute('data-end') || s.scrollHeight - s.scrollTop - s.clientHeight >= 600); })()`, 15000);
/** The composer done with its last press: the box enabled and empty, so what is typed next lands in it. */
const idle = () => page.until(`(() => { const t = document.querySelector('.feed-composer textarea'); return !!t && !t.disabled && t.value === ''; })()`, 15000);

try {
  await page.size(1410, 940);
  await page.goto(`${base}/#/feed`);
  await page.until(`document.querySelectorAll('.feed-entry').length >= 5`, 30000);

  // ---------------------------------------------------------------- your feeds
  const side = await page.eval<string[]>(`[...document.querySelectorAll('.feed-src')].map((b) => b.querySelector('.feed-src-label').textContent.trim())`);
  check('the list: Following and Discover, New feed, then Activity, Your posts and Drafts, one of each', side.join() === 'Following,Discover,New feed,Activity,Your posts,Drafts', side);
  check('the Feed opens on Following', (await page.eval<string>(`location.hash`)) === '#/feed' && /Following/.test(await text('.feed-main .conv-head h2')), await text('.feed-main .conv-head h2'));
  check('…its head says how many timelines and in what order', /2 timelines · Newest first/.test(await text('.feed-main .conv-head-sub')), await text('.feed-main .conv-head-sub'));
  const gossip = await page.eval<any>(`(() => { const all = [...document.querySelectorAll('.feed-entry')].filter((e) => /gossip layer/.test(e.textContent)); return { n: all.length, via: all[0]?.querySelector('.feed-via')?.textContent }; })()`);
  check('a post both accounts follow is in Following once, saying which timeline it came through and that one more had it', gossip.n === 1 && /_demo · Following \(\+1\)/.test(gossip.via), gossip);
  const conv = await page.eval<any>(`(() => { const e = [...document.querySelectorAll('.feed-entry')].find((e) => e.querySelectorAll('.thread-post').length > 1); return e && { rows: e.querySelectorAll('.thread-post').length, line: e.querySelector('.thread-post').classList.contains('line') }; })()`);
  check('a reply in Following shows the post above it, joined by a line', !!conv && conv.rows === 2 && conv.line, conv);
  if (shots) await page.shot(join(shots, 'feed-following-desktop.png'));

  // Discover: both accounts' For you, taking turns, and why a post is there
  await tap('.feed-src[data-source="discover"]');
  await page.until(`[...document.querySelectorAll('.feed-reason')].some((r) => /Alice Chen liked/.test(r.textContent))`, 20000);
  const reasons = await page.eval<string[]>(`[...document.querySelectorAll('.feed-reason')].map((r) => r.textContent.trim())`);
  check('Discover says why a post is there, in X’s words', reasons.includes('Alice Chen liked') && reasons.includes('Popular in Distributed systems'), reasons);
  check('…its head says it takes turns', /Taking turns/.test(await text('.feed-main .conv-head-sub')), await text('.feed-main .conv-head-sub'));
  // Snug fits more on the screen than one page of each: the list asks for the next pages first.
  await listSettled();
  const homeLog = async () => [...((await action(X1, 'homeLog')).result?.home ?? []), ...((await action(X2, 'homeLog')).result?.home ?? [])];
  const asked = await homeLog();
  check('X was asked for each account’s For you once, when Discover opened', asked.filter((h: any) => h.feed === 'foryou' && !h.cursor).length === 2, asked);
  const vias = await page.eval<string[]>(`[...document.querySelectorAll('.feed-main .feed-via')].slice(0, 4).map((v) => v.textContent.replace(/ \\(.*/, ''))`);
  check('…the two accounts take turns', vias.length === 4 && vias[0] !== vias[1] && vias[0] === vias[2], vias);

  // The order, swapped from the head's menu: the same posts, at once, nothing asked of X
  const turns = await shownKeys();
  await tap('.feed-main .feed-order-btn');
  await page.until(`document.querySelectorAll('.feed-order-menu .feed-order').length === 4`, 3000);
  check('the order menu: Newest first, Taking turns, Most liked, Spread out, the one in use ticked', (await page.eval<string>(`[...document.querySelectorAll('.feed-order-menu .feed-order b')].map((b) => b.textContent).join()`)) === 'Newest first,Taking turns,Most liked,Spread out' && (await count('.feed-order-menu .feed-order.on[data-order="turns"]')) === 1);
  if (shots) await page.shot(join(shots, 'feed-order-menu.png'));
  await tap('.feed-order-menu [data-order="newest"]');
  await page.until(`/Newest first/.test(document.querySelector('.feed-main .conv-head-sub').textContent)`, 3000);
  await until(async () => (await shownKeys()).join() !== turns.join(), 5000, 'the list in its new order');
  const want = (await json('/api/feed/entries?source=discover')).entries.map((e: any) => e.key);
  check('Newest first: the list put in the new order, as the hub orders it', (await shownKeys()).join() === want.join() && (await mixOf('discover')).order === 'newest', { shown: (await shownKeys()).slice(0, 3), want: want.slice(0, 3) });
  check('…the same posts', [...(await shownKeys())].sort().join() === [...turns].sort().join());
  check('…and X was not asked again', (await homeLog()).length === asked.length);
  await tap('.feed-main .feed-order-btn');
  await tap('.feed-order-menu [data-order="liked"]');
  await until(async () => (await mixOf('discover')).order === 'liked', 5000, 'Most liked saved');
  await until(async () => (await shownKeys()).join() === (await json('/api/feed/entries?source=discover')).entries.map((e: any) => e.key).join(), 5000, 'Most liked shown');
  check('Most liked: swapped too', true);

  // Tune: how much each timeline gets
  await tap('.feed-main .feed-tune-btn');
  await page.until(`!!document.querySelector('.feed-thread .feed-tune')`, 3000);
  const rows = await page.eval<string[]>(`[...document.querySelectorAll('.feed-tune-src')].map((r) => r.dataset.src + '=' + r.querySelector('.feed-tune-share').textContent)`);
  check('Tune, beside the posts: every timeline with how much it gets, For yous Even, Followings Off', rows.length === 4 && rows.filter((r) => r.endsWith(':foryou=Even')).length === 2 && rows.filter((r) => r.endsWith(':following=Off')).length === 2, rows);
  const pcts = await page.eval<string[]>(`[...document.querySelectorAll('.feed-tune-pct')].map((p) => p.textContent).filter(Boolean)`);
  check('…what the posts showing came from, as shares of the list', pcts.length === 2 && pcts.reduce((n, p) => n + parseInt(p), 0) >= 99, pcts);
  if (shots) await page.shot(join(shots, 'feed-tune-desktop.png'));
  await slide(`.feed-tune-src[data-src="${X2}:foryou"] input[type=range]`, 0);
  await until(async () => (await mixOf('discover')).sources.find((x: any) => x.accountId === X2 && x.feed === 'foryou').share === 0, 5000, 'the share saved');
  await page.until(`document.querySelectorAll('.feed-main .feed-via').length === 0 && document.querySelectorAll('.feed-main .feed-entry').length > 0`, 5000);
  const only = (await json('/api/feed/entries?source=discover')).entries;
  check('a timeline turned off leaves the feed: only the first account’s For you, no “which timeline” line', only.every((e: any) => e.seenBy[0].accountId === X1 && e.seenBy[0].feed === 'foryou'), only.map((e: any) => e.seenBy[0]));
  await tap('.feed-tune-foot .link-btn');
  await until(async () => (await mixOf('discover')).order === 'turns' && (await mixOf('discover')).sources.filter((x: any) => x.share === 2).length === 2, 5000, 'Discover put back');
  check('Put back as it was: Discover taking turns between both For yous again', true);
  await tap('.feed-tune-head .icon-btn');

  // A feed of your own
  await tap('.feed-src-new');
  await page.until(`/^#\\/feed\\/m-/.test(location.hash) && !!document.querySelector('.feed-tune')`, 5000);
  const made = decodeURIComponent((await page.eval<string>(`location.hash`)).slice('#/feed/'.length));
  check('New feed: made, opened, and its tuning open to name it', made.startsWith('m-') && (await page.eval<string>(`document.querySelector('.feed-tune-name input').value`)) === 'New feed');
  await page.eval(`(() => { const i = document.querySelector('.feed-tune-name input'); i.focus(); i.select(); })()`);
  await typeText('Friends');
  await page.eval(`document.querySelector('.feed-tune-name input').dispatchEvent(new Event('change', { bubbles: true }))`);
  await page.until(`[...document.querySelectorAll('.feed-src .feed-src-label')].some((l) => l.textContent === 'Friends')`, 5000);
  check('…named, and listed under Feeds', true);
  await tap('.feed-tune-foot .danger');
  await page.until(`![...document.querySelectorAll('.feed-src .feed-src-label')].some((l) => l.textContent === 'Friends') && location.hash === '#/feed/following'`, 5000);
  check('…and deleted, back on Following', !(await json('/api/feed/sources')).mixes.some((m: any) => m.id === made));

  // ---------------------------------------------------------------- posting as both accounts
  await tap('.feed-src[data-source="following"]');
  // Snug, the page's spacing at first (look.ts): the composer is one line until it is used.
  await page.until(`!!document.querySelector('.feed-main .feed-compose-closed')`, 10000);
  check('snug at first: the composer one line until used', (await count('.feed-page.dens-snug')) === 1 && !(await count('.feed-composer textarea')));
  await tap('.feed-main .feed-compose-closed');
  await page.until(`!!document.querySelector('.feed-composer textarea')`, 10000);
  const as = await page.eval<string[]>(`[...document.querySelectorAll('.feed-as-face')].map((b) => b.dataset.as + (b.classList.contains('on') ? '*' : ''))`);
  check('Post as: both accounts’ pictures, the first pressed in', as.length === 2 && as[0].endsWith('*') && !as[1].endsWith('*'), as);
  check('…and who posts it in words', /Posting as @zyan_demo$/.test(await text('.feed-as-names')), await text('.feed-as-names'));
  await tap(`.feed-as-face[data-as="${X2}"]`);
  check('a second picture pressed: both in words', /Posting as @zyan_demo and @work_demo/.test(await text('.feed-as-names')), await text('.feed-as-names'));
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
  check('the box empties after posting, and the new post is on top of Following', (await page.eval<string>(`document.querySelector('.feed-entry .post-text')?.textContent ?? ''`)).includes('Two accounts, one press.'), await page.eval(`document.querySelector('.feed-entry .post-text')?.textContent`));

  // A thread, as one account, only people it follows replying
  await tap(`.feed-as-face[data-as="${X2}"]`);
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
  check('Edit opens it in the composer on Following, still scheduled', true);
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

  await tap('.feed-src[data-source="following"]');
  await page.until(`[...document.querySelectorAll('.feed-entry')].some((e) => /repo-tools 2.0/.test(e.textContent))`, 10000);
  const likesBefore = { x1: (await writes(X1)).filter((w) => w === 'postAct:like').length, x2: (await writes(X2)).filter((w) => w === 'postAct:like').length };
  await page.eval(`[...document.querySelectorAll('.feed-entry')].find((e) => /repo-tools 2.0/.test(e.textContent)).setAttribute('data-test', 'release')`);
  await tap('.feed-entry[data-test="release"] .pa-btn.like');
  await until(async () => (await writes(X2)).filter((w) => w === 'postAct:like').length === likesBefore.x2 + 1, 10000, 'a like as the work account');
  check('a like on a post only the work account follows goes as that account', (await writes(X1)).filter((w) => w === 'postAct:like').length === likesBefore.x1);
  await tap('.feed-entry[data-test="release"] .pa-btn.reply');
  await page.until(`document.activeElement === document.querySelector('.feed-entry[data-test="release"] .post-composer textarea')`, 5000);
  check('Reply opens a box under the card, replying to its author', /Replying to/.test(await text('.feed-entry[data-test="release"] .compose-to')), await text('.feed-entry[data-test="release"] .compose-to'));
  await typeText('Congrats on the release.');
  await page.until(`document.querySelector('.feed-entry[data-test="release"] .post-composer textarea')?.value === 'Congrats on the release.'`, 5000);
  const x2posts = (await writes(X2)).filter((w) => w === 'publish').length;
  await tap('.feed-entry[data-test="release"] .post-composer .compose-send');
  await until(async () => (await writes(X2)).filter((w) => w === 'publish').length === x2posts + 1, 10000, 'the reply as the work account');
  check('…and the reply goes as that account too', true);

  // ---------------------------------------------------------------- reading threads ahead
  // A card with replies that stays on the screen has its thread read before it is opened, and says so by its count.
  await page.until(`!!document.querySelector('.feed-main .pa-pre[data-pre="ready"]')`, 10000);
  check('a card with replies on the screen has its thread read ahead, a dot by its count', true);

  // ---------------------------------------------------------------- a post's thread beside the list
  await tap('.feed-entry[data-test="release"] .post-text');
  await page.until(`!!document.querySelector('.feed-thread .thread-focal')`, 15000);
  const beside = await page.eval<any>(`({ hash: location.hash, list: !!document.querySelector('.feed-main') && getComputedStyle(document.querySelector('.feed-main')).display !== 'none', thread: document.querySelector('.feed-thread').getBoundingClientRect().width })`);
  check('a post opens its thread beside the list on a computer', beside.hash.startsWith('#/feed/following/p/pst_x_') && beside.list && beside.thread > 300, beside);
  if (shots) await page.shot(join(shots, 'feed-thread-beside.png'));
  await page.eval(`history.back()`);
  await page.until(`!document.querySelector('.feed-thread')`, 5000);
  check('Back closes it', (await page.eval<string>(`location.hash`)) === '#/feed/following', await page.eval(`location.hash`));

  // The long thread on Your posts: read ahead, so it opens with its replies at once. A fresh start, as reading ahead
  // goes at twelve a minute and the steps above have had their share.
  await page.eval(`(location.hash = '#/feed/mine', location.reload())`);
  await page.until(`[...document.querySelectorAll('.feed-main .feed-entry')].some((e) => /Greedy routing in dither/.test(e.textContent))`, 10000);
  // Read ahead once it is on the screen: brought there.
  await page.eval(`(() => { const e = [...document.querySelectorAll('.feed-main .feed-entry')].find((e) => /Greedy routing in dither/.test(e.textContent)); e.setAttribute('data-test', 'routing'); e.scrollIntoView({ block: 'center' }); })()`);
  await page.until(`!!document.querySelector('.feed-entry[data-test="routing"] .pa-pre[data-pre="ready"]')`, 10000);
  // Watched from before the press: did the thread ever say it was still reading its replies?
  await page.eval(`(() => { window.__coming = false; const o = new MutationObserver(() => { if (document.querySelector('.feed-thread .thread-coming')) window.__coming = true; if (document.querySelector('.feed-thread .ct [data-post]')) o.disconnect(); }); o.observe(document.body, { childList: true, subtree: true }); })()`);
  await tap('.feed-entry[data-test="routing"] .post-text');
  await page.until(`document.querySelectorAll('.feed-thread .ct [data-post]').length > 3`, 10000);
  check('a thread read ahead opens with its replies, never “Reading the replies…”', !(await page.eval<boolean>(`window.__coming`)));
  check('no Reply button on the post itself: its box is under it', !(await count('.feed-thread .thread-focal .pa-btn.reply')) && (await count('.feed-thread .thread-focal .compose-closed')) === 1);

  // Show more replies, until there are none to show: then it is gone.
  for (let i = 0; i < 5 && (await count('.feed-thread .thread-more')); i++) {
    const n = await count('.feed-thread [data-post]');
    await tap('.feed-thread .thread-more');
    await page.until(`document.querySelectorAll('.feed-thread [data-post]').length > ${n} || !document.querySelector('.feed-thread .thread-more')`, 10000).catch(async (e) => {
      throw new Error(`${e.message}\n  button: ${await page.eval<string>(`(() => { const b = document.querySelector('.feed-thread .thread-more'); return JSON.stringify({ text: b?.textContent, pre: b?.dataset.pre, disabled: b?.disabled, n: document.querySelectorAll('.feed-thread [data-post]').length }); })()`)}`);
    });
  }
  const shown = await page.eval<any>(`({ more: !!document.querySelector('.feed-thread .thread-more'), n: document.querySelectorAll('.feed-thread .ct [data-post]').length, said: Number(/\\d+/.exec(document.querySelector('.feed-thread .thread-replies-bar')?.textContent ?? '')?.[0]) })`);
  check('Show more replies goes once every reply is shown', !shown.more && shown.n >= shown.said, shown);

  // The reply styles, as pictures: the replies move to their places.
  for (const [st, sel] of [['compact', '.ct.compact'], ['flat', '.ct.ct-flatlist'], ['chains', '.thread-chain'], ['tree', '.ct.tree']]) {
    await tap(`.feed-thread .ct-style [data-seg="${st}"]`);
    await page.until(`!!document.querySelector('.feed-thread ${sel}') && document.querySelector('.feed-thread .ct-style [data-seg="${st}"]').getAttribute('aria-checked') === 'true'`, 5000);
  }
  check('the reply styles switch from their pictures', true);

  // Check for new replies: asks the network again.
  await tap('.feed-thread .thread-check');
  await page.until(`[...document.querySelectorAll('.toast')].some((t) => /new repl/i.test(t.textContent))`, 10000);
  check('Check for new replies asks again and says what came', true, await page.eval(`[...document.querySelectorAll('.toast')].map((t) => t.textContent).find((t) => /new repl/i.test(t))`));

  // A reply begun and thought better of: Cancel, and Undo brings it back.
  await tap('.feed-thread .thread-focal .compose-closed');
  await page.until(`document.activeElement?.matches('.feed-thread .thread-focal textarea')`, 5000);
  await typeText('A reply I think better of.');
  await tap('.feed-thread .thread-focal .compose-cancel');
  await page.until(`!!document.querySelector('.feed-thread .thread-focal .compose-closed')`, 5000);
  check('Cancel closes the reply box', true);
  await page.until(`[...document.querySelectorAll('.toast')].some((t) => /Reply discarded/.test(t.textContent))`, 5000);
  await page.eval(`[...document.querySelectorAll('.toast')].find((t) => /Reply discarded/.test(t.textContent)).setAttribute('data-test', 'discarded')`);
  await tap('.toast[data-test="discarded"] .toast-action');
  await page.until(`document.querySelector('.feed-thread .thread-focal textarea')?.value === 'A reply I think better of.'`, 5000);
  check('…and Undo brings back what was written', true);
  await tap('.feed-thread .thread-focal .compose-cancel');
  await page.eval(`history.back()`);
  await page.until(`!document.querySelector('.feed-thread')`, 5000);

  // A quote opens beside the list, and its words can be selected: one of yours quotes a post.
  await page.until(`location.hash === '#/feed/mine' && !!document.querySelector('.feed-main .post-quoted .post-clip')`, 10000);
  const qb = await page.eval<any>(`(() => { const e = document.querySelector('.feed-main .post-quoted .post-clip'); e.scrollIntoView({ block: 'center' }); window.scrollTo(0, 0); const b = e.getBoundingClientRect(); return { x: b.left + 3, y: b.top + 6, w: Math.min(b.width - 8, 160) }; })()`);
  const mouse = (type: string, x: number, buttons: number) => page.send('Input.dispatchMouseEvent', { type, x, y: qb.y, button: 'left', buttons, clickCount: 1 });
  await mouse('mousePressed', qb.x, 1);
  for (let i = 1; i <= 8; i++) await mouse('mouseMoved', qb.x + (i * qb.w) / 8, 1);
  await mouse('mouseReleased', qb.x + qb.w, 0);
  const sel = await page.eval<any>(`({ sel: getSelection().toString().length, hash: location.hash })`);
  check('words in a quote can be selected, and the drag opens nothing', sel.sel > 3 && sel.hash === '#/feed/mine', sel);
  await page.eval(`getSelection().removeAllRanges()`);
  const quoted = await page.eval<string>(`document.querySelector('.feed-main .post-quoted').dataset.quote`);
  await tap('.feed-main .post-quoted .post-by');
  await page.until(`!!document.querySelector('.feed-thread .thread-focal')`, 15000);
  const qh = await page.eval<string>(`location.hash`);
  check('a quote opens its post beside the list', qh === `#/feed/mine/p/pst_x_${quoted}` && (await count('.feed-main .feed-entry')) > 0, qh);
  await page.eval(`history.back()`);
  await page.until(`!document.querySelector('.feed-thread')`, 5000);

  // The page's spacing, from its pictures in the head.
  await tap('.feed-src[data-source="following"]');
  await page.until(`document.querySelectorAll('.feed-main .feed-entry').length > 3`, 10000);
  await tap('.feed-density [data-seg="dense"]');
  await page.until(`!!document.querySelector('.dens-dense .feed-main')`, 3000);
  const faces = await page.eval<number>(`Math.round(document.querySelector('.feed-main .feed-entry .thread-face').getBoundingClientRect().width)`);
  check('Dense: small faces', faces <= 28, faces);
  if (shots) await page.shot(join(shots, 'feed-dense.png'));
  await tap('.feed-density [data-seg="roomy"]');
  await page.until(`!!document.querySelector('.dens-roomy .feed-main .feed-composer textarea')`, 3000);
  check('Roomy: the composer open', true);
  await tap('.feed-density [data-seg="snug"]');
  await page.until(`!!document.querySelector('.dens-snug .feed-main .feed-compose-closed')`, 3000);
  check('…and back to snug, it closes to its line', true);

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
  check('…and Activity’s row stays marked, filtered to that account', (await count('.feed-src.active[data-source="activity"]')) === 1 && (await page.eval<string>(`document.querySelector('.feed-filter')?.value ?? ''`)) === X1);
  await page.eval(`(() => { const s = document.querySelector('.feed-filter'); s.value = ''; s.dispatchEvent(new Event('change', { bubbles: true })); })()`);
  await page.until(`location.hash === '#/feed/activity'`, 3000);
  check('…All accounts in its filter: every account’s Activity again', true);

  // ---------------------------------------------------------------- an account that goes and comes back
  // The page follows the accounts as they are, with no reload (FeedPane asks for the sources again when one changes):
  // one switched off leaves Following or says it is not connected, and back on, its timelines are in Following again.
  await tap('.feed-src[data-source="following"]');
  const sub = `(document.querySelector('.feed-main .conv-head-sub')?.textContent ?? '')`;
  const offline = `(document.querySelector('.feed-src-offline')?.textContent ?? '')`;
  await page.until(`/2 timelines/.test(${sub})`, 10000);
  await page.eval(`window.__samePage = 1`);
  const enable = (enabled: boolean) => fetch(`${base}/api/accounts/${X2}`, { method: 'PATCH', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ enabled }) }).then((r) => r.ok);
  check('an account switched off while the Feed is open…', await enable(false));
  await page.until(`/1 timeline\\b/.test(${sub}) || /work_demo/.test(${offline})`, 15000);
  check('…the page says so: one timeline fewer, or that it is not connected', true, { sub: await page.eval(sub), offline: await page.eval(offline) });
  check('…and back on…', await enable(true));
  await page.until(`/2 timelines/.test(${sub}) && !/work_demo/.test(${offline})`, 20000);
  check('…Following has both accounts’ timelines again, with no reload', (await page.eval<number | undefined>(`window.__samePage`)) === 1, await page.eval(sub));

  // ---------------------------------------------------------------- a phone
  // A phone opens the app afresh.
  await page.goto('about:blank');
  await page.size(390, 844, true);
  await page.goto(`${base}/#/feed`);
  await page.until(`!!document.querySelector('.feed-tabs') && document.querySelectorAll('.feed-entry').length > 2`, 20000);
  const tabs = await page.eval<string[]>(`[...document.querySelectorAll('.feed-tab')].map((t) => (t.textContent.trim() || t.getAttribute('aria-label')) + (t.getAttribute('aria-selected') === 'true' ? '*' : ''))`);
  check('on a phone, the feeds are tabs across the top, Following open, then New feed', tabs.join() === 'Following*,Discover,New feed', tabs);
  check('…the order under them, Activity behind the bell, the composer behind the pencil button, no box in the list', (await count('.feed-orderline .feed-order-btn')) === 1 && (await count('.feed-phone-head .feed-bell')) === 1 && (await count('.feed-fab')) === 1 && (await count('.feed-main .feed-composer, .feed-main .feed-compose-closed')) === 0);
  check('nothing sideways on a phone', (await overflow('.feed-main .feed-scroll')) === 0 && (await page.eval<number>(`document.documentElement.scrollWidth - innerWidth`)) <= 0, await overflow('.feed-main .feed-scroll'));
  if (shots) await page.shot(join(shots, 'feed-phone-following.png'));
  await tap('.feed-tab[data-source="discover"]');
  await page.until(`location.hash === '#/feed/discover' && [...document.querySelectorAll('.feed-reason')].length > 0`, 10000);
  check('a tab opens its feed', true);
  await tap('.feed-orderline .feed-order-btn');
  await page.until(`document.querySelectorAll('.sheet .feed-order').length === 4`, 3000);
  check('the order opens as a sheet', true);
  if (shots) await page.shot(join(shots, 'feed-phone-order.png'));
  await tap('.sheet .feed-order[data-order="spread"]');
  await until(async () => (await mixOf('discover')).order === 'spread', 5000, 'Spread out saved');
  await page.until(`!document.querySelector('.sheet') && /Spread out/.test(document.querySelector('.feed-orderline').textContent)`, 3000);
  check('…a pick swaps it and closes the sheet', true);
  await tap('.feed-orderline .feed-tune-btn');
  await page.until(`!!document.querySelector('.feed-tune-sheet .feed-tune-src')`, 3000);
  check('Tune is a tall sheet on a phone', (await count('.feed-tune-sheet .feed-tune-src')) === 4);
  if (shots) await page.shot(join(shots, 'feed-phone-tune.png'));
  await tap('.feed-tune-sheet .feed-tune-head .icon-btn');
  await settled();
  await tap('.feed-tab[data-source="following"]');
  await page.until(`location.hash === '#/feed/following'`, 5000);

  // The composer, in a sheet from the pencil button
  await tap('.feed-fab');
  await page.until(`!!document.querySelector('.feed-compose-sheet .feed-composer textarea')`, 5000);
  check('the pencil button opens the composer in a sheet, who posts it as pictures on top', (await count('.feed-compose-sheet .feed-as-face')) === 2);
  await page.until(`document.activeElement === document.querySelector('.feed-compose-sheet textarea')`, 3000);
  await typeText('From a phone.');
  if (shots) await page.shot(join(shots, 'feed-phone-compose.png'));
  await tap('.feed-compose-sheet .compose-send');
  await until(async () => (await mine()).entries.some((e: any) => e.post.text === 'From a phone.'), 15000, 'the phone post');
  await page.until(`!document.querySelector('.feed-compose-sheet')`, 5000);
  check('…Post posts it and closes the sheet', (await page.eval<string>(`document.querySelector('.feed-entry .post-text')?.textContent ?? ''`)).includes('From a phone.'));
  await settled();

  // Activity behind the bell, Your posts and Drafts behind ⋯, each a page with Back
  await tap('.feed-phone-head .feed-bell');
  await page.until(`location.hash === '#/feed/activity' && document.querySelectorAll('.feed-unit').length > 2`, 10000);
  check('the bell opens Activity, a page with Back', (await count('.feed-head .feed-back')) === 1);
  if (shots) await page.shot(join(shots, 'feed-phone-activity.png'));
  await tap('.feed-head .feed-back');
  await page.until(`location.hash === '#/feed/following' && !!document.querySelector('.feed-tabs')`, 5000);
  check('…Back returns to the feed', true);
  await tap('.feed-phone-head .icon-btn[aria-label="More"]');
  await page.until(`!!document.querySelector('.sheet .sheet-action[data-source="drafts"]')`, 3000);
  check('⋯ holds Your posts, Drafts, Tune and New feed', (await page.eval<string>(`[...document.querySelectorAll('.sheet .sheet-action')].map((b) => b.textContent.trim()).join()`)).startsWith('Your posts,Drafts'));
  if (shots) await page.shot(join(shots, 'feed-phone-menu.png'));
  // A navigation from inside a sheet takes its entry over (phone.ts takeOverLayers).
  await tap('.sheet .sheet-action[data-source="mine"]');
  await page.until(`location.hash === '#/feed/mine' && [...document.querySelectorAll('.feed-entry')].some((e) => /From a phone/.test(e.textContent))`, 10000);
  check('…Your posts lists what you posted', true);
  await tap('.feed-head .feed-back');
  await page.until(`location.hash === '#/feed/following'`, 5000);

  // A post's thread in the list's place
  await page.until(`document.querySelectorAll('.feed-entry .post-text').length > 0`, 5000);
  await tap('.feed-entry .post-text');
  await page.until(`!!document.querySelector('.feed-thread .thread-focal')`, 15000);
  const ph = await page.eval<any>(`({ list: getComputedStyle(document.querySelector('.feed-main')).display, w: Math.round(document.querySelector('.feed-thread').getBoundingClientRect().width) })`);
  check('a post’s thread takes the list’s place on a phone', ph.list === 'none' && ph.w >= 380, ph);
  if (shots) await page.shot(join(shots, 'feed-phone-thread.png'));
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
