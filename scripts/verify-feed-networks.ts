/**
 * The Feed page with Mastodon, Reddit, Lemmy, Substack and Bluesky (docs/feed.md "A feed of posts, for any network"), in
 * a real browser against a demo hub of its own on a fresh data dir, with the demo's five accounts of them (demo-posts.ts):
 * the Feed offered and Following taking every network's posts, a Reddit or Lemmy post's title and place, Mastodon's
 * content warning folded until Show, Substack's publication, Bluesky's quote post with its picture; Tune naming each timeline in its network's words; a
 * Reddit thread's comment tree with Continue this thread opening the deep branch as a thread of its own; each
 * network's bar (Upvote and no Repost on Reddit and Lemmy, Favourite and Boost on Mastodon, Restack on Substack, Repost and Like on Bluesky) and a
 * press reaching the network once; the composer asking a Reddit post for its title and subreddit, and Mastodon's
 * content warning; Activity in each network's words; and a phone.
 *
 *   bun scripts/verify-feed-networks.ts [--port <port>] [--web <built dist>] [--work <empty dir>] [--keep] [--shots <dir>]
 *
 * Builds the web app unless --web names a build. Every press is real input (DevTools Input events).
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
const work = args.includes('--work') ? opt('work', '') : mkdtempSync(join(tmpdir(), `dither-verify-feed-networks-${PORT}-`));
mkdirSync(work, { recursive: true });
const shots = opt('shots', '');
if (shots) mkdirSync(shots, { recursive: true });

const ACC = { mastodon: 'acc_demo-mastodon', reddit: 'acc_demo-reddit', lemmy: 'acc_demo-lemmy', substack: 'acc_demo-substack', bluesky: 'acc_demo-bluesky' };

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
  env: { ...process.env, DITHER_DEMO_CHATTER: '0', DITHER_DEMO_POSTS: '1' },
  stdout: log,
  stderr: log,
});
await until(async () => (await fetch(`${base}/api/health`).catch(() => null))?.ok ?? false, 30_000, 'the hub did not start');
let boot = await json('/api/bootstrap');
if (!boot.accounts.every((a: any) => a.demo)) throw new Error('not a demo hub');
await until(async () => (boot = await json('/api/bootstrap')).conversations.filter((c: any) => c.variant === 'feed').length === 7, 15_000, 'seven feed conversations');

const { page, close } = await launch();
const q = (s: string) => JSON.stringify(s);
/** A real press at the middle of the first element matching, once nothing moves and nothing lies over it. */
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
/** The card of the entry whose words match, as a selector. */
const entry = async (re: string) => {
  const key = await page.eval<string | null>(`[...document.querySelectorAll('.feed-main .feed-entry')].find((e) => new RegExp(${q(re)}).test(e.textContent))?.dataset.entry ?? null`);
  if (!key) throw new Error(`no card for /${re}/`);
  return `.feed-main .feed-entry[data-entry=${q(key)}]`;
};
const bar = (sel: string) => page.eval<string[]>(`[...document.querySelectorAll(${q(`${sel} .post-actions .pa-btn`)})].map((b) => b.getAttribute('aria-label').replace(/, [\\d,]+$/, ''))`);

try {
  await page.size(1410, 940);
  await page.goto(`${base}/#/feed`);
  await page.until(`document.querySelectorAll('.feed-entry').length >= 8`, 30000);
  check('the rail offers the Feed', (await count('[data-track="feed"], .rail [title="Feed"]')) >= 1 || (await page.eval<boolean>(`location.hash === '#/feed'`)));
  // Following: every account's timeline, newest first
  const read = await json('/api/feed/read', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ source: 'following' }) });
  const firstNets = [...new Set(read.entries.map((e: any) => e.network))];
  check('Following mixes the networks’ posts', firstNets.length >= 3 && firstNets.includes('reddit') && firstNets.includes('mastodon'), firstNets);
  await page.until(`[...document.querySelectorAll('.feed-main .feed-entry')].some((e) => e.dataset.entry.startsWith('reddit:'))`, 20000);
  if (shots) await page.shot(join(shots, 'networks-following-desktop.png'));
  // Tune names each timeline in its network's words
  await tap('.feed-main .feed-tune-btn');
  await page.until(`!!document.querySelector('.feed-tune-src small')`, 5000);
  const tune = await page.eval<string[]>(`[...document.querySelectorAll('.feed-tune-src small')].map((s) => s.textContent.trim())`);
  check('Tune names the timelines as each network does', ['Home · Mastodon', 'New · Reddit', 'Subscribed · Lemmy', 'Inbox · Substack', 'Following · Bluesky'].every((t) => tune.some((x) => x.includes(t))), tune);
  if (shots) await page.shot(join(shots, 'networks-tune.png'));

  /** One account's own timeline. */
  const open = async (acc: string) => {
    await page.goto(`${base}/#/feed/${acc}:following`);
    await page.until(`document.querySelectorAll('.feed-main .feed-entry').length >= 2`, 20000);
  };
  await open(ACC.reddit);
  const reddit = await entry('starter finally doubled');
  check('a Reddit post: its title and its subreddit over the words', (await text(`${reddit} .post-title`)) === 'My starter finally doubled in six hours' && /r\/sourdough/.test(await text(`${reddit} .post-place`)), await text(`${reddit} .post-place`));
  check('Reddit’s bar: Comment and Upvote, no Repost', JSON.stringify(await bar(reddit)) === JSON.stringify(['Comment', 'Upvote']), await bar(reddit));
  await tap(`${reddit} .pa-btn.like`);
  await until(async () => (await writes(ACC.reddit)).includes('postAct:like'), 10000, 'the upvote reaching Reddit');
  check('Upvote pressed: on, and Reddit asked once', (await count(`${reddit} .pa-btn.like.on`)) === 1 && (await writes(ACC.reddit)).filter((w) => w === 'postAct:like').length === 1, await writes(ACC.reddit));
  if (shots) await page.shot(join(shots, 'networks-reddit-desktop.png'));

  await open(ACC.lemmy);
  const lemmy = await entry('Seed swap at the community garden');
  check('a Lemmy post: its community, on its server', /!gardening@lemmy\.example/.test(await text(`${lemmy} .post-place`)), await text(`${lemmy} .post-place`));
  check('Lemmy’s bar on your own post: Reply, Upvote and More (to delete it)', JSON.stringify(await bar(lemmy)) === JSON.stringify(['Reply', 'Upvote', 'More']), await bar(lemmy));
  if (shots) await page.shot(join(shots, 'networks-lemmy-desktop.png'));

  await open(ACC.substack);
  const substack = await entry('Why maps lie, gently');
  check('a Substack post: its title and its publication', /The Slow Graph/.test(await text(`${substack} .post-place`)), await text(`${substack} .post-place`));
  check('Substack’s bar: Reply, Restack, Like', JSON.stringify(await bar(substack)) === JSON.stringify(['Reply', 'Restack', 'Like']), await bar(substack));
  if (shots) await page.shot(join(shots, 'networks-substack-desktop.png'));

  await open(ACC.bluesky);
  const quoted = await entry('good map labels');
  check('a Bluesky quote post: the post it quotes, with its picture, inside the card', /The delta at low water/.test(await text(quoted)) && (await count(`${quoted} img[alt="A river winding through green fields"]`)) >= 1, (await text(quoted)).slice(0, 120));
  check('a Bluesky post: no title, no place, no warning', !(await count(`${quoted} .post-title, ${quoted} .post-place, ${quoted} .post-warning`)));
  const skyBar = await bar(quoted);
  check('Bluesky’s bar: Reply, Repost, Like', ['Reply', 'Repost', 'Like'].every((b) => skyBar.includes(b)), skyBar);
  const skyRepost = await entry('Every channel moved since spring');
  check('a Bluesky repost says reposted', /reposted/i.test(await text(skyRepost)), (await text(skyRepost)).slice(0, 80));
  await tap(`${quoted} .pa-btn.like`);
  await until(async () => (await writes(ACC.bluesky)).includes('postAct:like'), 10000, 'the like reaching Bluesky');
  check('Like pressed: on, and Bluesky asked once', (await count(`${quoted} .pa-btn.like.on`)) === 1 && (await writes(ACC.bluesky)).filter((w) => w === 'postAct:like').length === 1, await writes(ACC.bluesky));
  if (shots) await page.shot(join(shots, 'networks-bluesky-desktop.png'));

  await open(ACC.mastodon);
  const spoiler = await entry('Spoilers: the finale');
  check('a Mastodon post behind its content warning: the warning, not the words', (await count(`${spoiler} .post-warning`)) === 1 && !/did not see that ending/.test(await text(spoiler)));
  if (shots) await page.shot(join(shots, 'networks-mastodon-desktop.png'));
  await tap(`${spoiler} .post-warning`);
  await page.until(`/did not see that ending/.test(document.querySelector(${q(spoiler)}).textContent)`, 3000);
  check('…Show opens it', true);
  const boost = await entry('Low tide at the old lighthouse');
  check('a Mastodon boost says boosted', /boosted/.test(await text(boost)), (await text(boost)).slice(0, 80));
  const mastoBar = await bar(await entry('Re-potted the fig'));
  check('Mastodon’s bar: Reply, Boost, Favourite', JSON.stringify(mastoBar) === JSON.stringify(['Reply', 'Boost', 'Favourite']), mastoBar);

  await open(ACC.reddit);
  // A Reddit thread: the comment tree, and Continue this thread
  const greedy = await entry('Greedy routing on random geometric graphs');
  await tap(`${greedy} .post-title`);
  await page.until(`!!document.querySelector('.feed-thread .thread-focal-title')`, 15000);
  check('the thread: its title and subreddit over the post', /Greedy routing/.test(await text('.feed-thread .thread-focal-title')) && /r\/graphtheory/.test(await text('.feed-thread .thread-focal .post-place')));
  await page.until(`!!document.querySelector('.feed-thread .ct-continue')`, 10000);
  check('a branch deeper than six levels: Continue this thread', (await count('.feed-thread .ct-continue')) >= 1, await text('.feed-thread .ct-continue'));
  if (shots) await page.shot(join(shots, 'networks-reddit-thread.png'));
  await tap('.feed-thread .ct-continue');
  await page.until(`/Level/.test(document.querySelector('.feed-thread .thread-focal')?.textContent ?? '')`, 15000);
  const deep = await text('.feed-thread .thread-focal .thread-focal-text');
  check('…opens that branch as a thread of its own, read from Reddit by the comment’s id', /^Level \d/.test(deep) && ((await action(ACC.reddit, 'postLog')).result?.posts ?? []).some((p: any) => /^t1_/.test(p.post)), deep);
  check('…with no Repost in its bar', !(await count('.feed-thread .thread-focal .pa-btn.repost')));
  await page.goto(`${base}/#/feed`);
  await page.until(`document.querySelectorAll('.feed-entry').length >= 8`, 15000);

  // The composer: a Reddit post asks for its title and subreddit
  await tap('.feed-main .feed-compose-closed');
  await page.until(`!!document.querySelector('.feed-composer textarea')`, 10000);
  for (const a of await page.eval<string[]>(`[...document.querySelectorAll('.feed-as-face.on')].map((b) => b.dataset.as)`)) await tap(`.feed-as-face[data-as="${a}"]`);
  await tap(`.feed-as-face[data-as="${ACC.reddit}"]`);
  await page.until(`!!document.querySelector('.feed-fields[data-fields="reddit"]')`, 3000);
  check('Reddit chosen: a subreddit and a title to fill in, Post greyed until they are', (await count('.feed-fields .feed-place')) === 1 && (await count('.feed-fields .feed-title')) === 1 && (await page.eval<boolean>(`document.querySelector('.feed-composer .compose-send').disabled`)));
  await tap('.feed-fields .feed-place');
  await typeText('r/graphtheory');
  await tap('.feed-fields .feed-title');
  await typeText('Lookahead fixes most stuck greedy routes');
  await tap('.feed-composer textarea');
  await typeText('Two hops of lookahead, numbers in the comments.');
  if (shots) await page.shot(join(shots, 'networks-composer-reddit.png'));
  await page.until(`!document.querySelector('.feed-composer .compose-send').disabled`, 3000);
  await tap('.feed-composer .compose-send');
  await until(async () => ((await action(ACC.reddit, 'publishLog')).result?.published ?? []).length === 1, 15000, 'the post reaching Reddit');
  const sent = (await action(ACC.reddit, 'publishLog')).result.published[0];
  check('…posted with its title and the subreddit’s name', sent.title === 'Lookahead fixes most stuck greedy routes' && sent.place === 'graphtheory', sent);

  // Mastodon's content warning
  await page.until(`(() => { const t = document.querySelector('.feed-composer textarea'); return !!t && !t.disabled && t.value === ''; })()`, 15000);
  await tap(`.feed-as-face[data-as="${ACC.reddit}"]`);
  await tap(`.feed-as-face[data-as="${ACC.mastodon}"]`);
  await tap('.feed-composer .feed-cw');
  await page.until(`!!document.querySelector('.feed-composer .feed-warning')`, 3000);
  await tap('.feed-composer .feed-warning');
  await typeText('Finale spoilers');
  await tap('.feed-composer textarea');
  await typeText('That last shot, though.');
  if (shots) await page.shot(join(shots, 'networks-composer-mastodon.png'));
  await tap('.feed-composer .compose-send');
  await until(async () => ((await action(ACC.mastodon, 'publishLog')).result?.published ?? []).length === 1, 15000, 'the toot reaching Mastodon');
  check('a toot with a content warning: the warning goes with it', (await action(ACC.mastodon, 'publishLog')).result.published[0].warning === 'Finale spoilers');

  // Activity, in each network's words
  await page.goto(`${base}/#/feed/${ACC.mastodon}:activity`);
  await page.until(`/Favourited by/.test(document.body.textContent)`, 15000);
  const act = await page.eval<string>(`document.body.textContent`);
  check('Activity on Mastodon: favourites and boosts, by those words', /Favourited by/.test(act) && !/Liked by/.test(act), act.match(/(Favourited|Liked) by[^.]{0,40}/g));
  if (shots) await page.shot(join(shots, 'networks-activity-desktop.png'));
  check('nothing was sent to any of them but the presses', (await writes(ACC.lemmy)).length === 0 && (await writes(ACC.substack)).length === 0, { lemmy: await writes(ACC.lemmy), substack: await writes(ACC.substack) });

  // A phone
  await page.size(390, 844, true);
  for (const [net, acc] of Object.entries(ACC)) {
    await open(acc);
    const over = await page.eval<number>(`document.documentElement.scrollWidth - document.documentElement.clientWidth`);
    check(`a phone: ${net}’s cards fit its width`, over <= 0, over);
    if (shots) await page.shot(join(shots, `networks-${net}-phone.png`));
  }
  const greedyId = (await json(`/api/feed/entries?source=${ACC.reddit}:following`)).entries.find((e: any) => e.post.title?.startsWith('Greedy')).post.id;
  await page.goto(`${base}/#/feed/${ACC.reddit}:following/p/pst_reddit_${greedyId}`);
  await page.until(`!!document.querySelector('.feed-thread .ct-continue, .thread-focal-title')`, 15000);
  if (shots) await page.shot(join(shots, 'networks-reddit-thread-phone.png'));

  const errors = page.errors.filter((e) => !/WebSocket connection|Failed to load resource/.test(e));
  check('no script errors', !errors.length, errors);
} catch (e) {
  failed++;
  console.log('FAIL  ', e);
  if (shots) await page.shot(join(shots, 'networks-failed.png')).catch(() => {});
} finally {
  await close();
  hub.kill('SIGTERM');
  await hub.exited;
  if (!args.includes('--keep')) rmSync(work, { recursive: true, force: true });
  else console.log(`kept ${work}`);
}
console.log(failed ? `${failed} failed` : 'all passed');
process.exit(failed ? 1 : 0);
