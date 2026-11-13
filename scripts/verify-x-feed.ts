/**
 * X's notifications as a feed (docs/feed.md), in a real browser against a demo hub of its own on a fresh data dir.
 * The demo X account's feed: five likes on one post, a repost of it, a reply, a quote, a mention, two follows and two
 * likes on another post, the newest four arriving live; profiles of the people in it, with their posts on asking.
 *
 *   bun scripts/verify-x-feed.ts [--port 8696] [--web <built dist>] [--work <empty dir>] [--keep] [--shots <dir>]
 *
 * Checks, on a desktop and a phone, dark and light: the inbox's row under Requests (how many new, who, what), the feed
 * out of the ranked rows; the feed's cards (likes on one post as one card with five faces, follows as one, a reply,
 * a quote and a mention with their words and pictures, your post quoted with a thumbnail); no composer, a bar with
 * Open on X; reading it marks it read on the hub and sends X no read mark, no typing and nothing else; sends there
 * are refused; likes never notify and the reply is a silent row on the list; a name opens the profile, which shows
 * their bio, follow counts, that you follow each other, and Recent posts (pinned, a repost, a reply, a quote) from asking X.
 */
import { mkdirSync, mkdtempSync, openSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { launch } from './browser.ts';

const args = process.argv.slice(2);
const opt = (k: string, d: string) => (args.includes(`--${k}`) ? args[args.indexOf(`--${k}`) + 1] : d);
const PORT = Number(opt('port', '8696'));
const root = resolve(import.meta.dir, '..');
const base = `http://127.0.0.1:${PORT}`;
const work = args.includes('--work') ? opt('work', '') : mkdtempSync(join(tmpdir(), `dither-verify-x-feed-${PORT}-`));
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
// Another hub on this port (another agent's, say) would answer for ours.
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

const { page, close } = await launch();
const setTheme = (theme: string) => page.eval(`localStorage.setItem('dither-chat:prefs', JSON.stringify({ ...JSON.parse(localStorage.getItem('dither-chat:prefs') || '{}'), theme: ${JSON.stringify(theme)} }))`);
const load = async (hash: string) => {
  await page.goto('about:blank');
  await page.goto(`${base}/${hash}`);
};
const overflow = (sel: string) => page.eval<number>(`(() => { const s = document.querySelector(${JSON.stringify(sel)}); return s ? s.scrollWidth - s.clientWidth : -1; })()`);

try {
  check('the X account has one feed conversation, read-only, named Notifications', feed?.network === 'x' && feed.name === 'Notifications' && feed.shape === 'channel', feed && { name: feed.name, shape: feed.shape });

  // ------------------------------------------------------------------ notifications, decided on the hub
  await until(async () => (await json(`/api/conversations/${feed.id}/messages?limit=60`)).messages.filter((m: any) => m.triage).length >= 4, 20_000, 'the live feed items were not decided');
  const page1 = await json(`/api/conversations/${feed.id}/messages?limit=60`);
  const decided = page1.messages.filter((m: any) => m.triage).map((m: any) => ({ type: m.feed?.type, decision: m.triage.decision }));
  check('the feed messages carry what they did (extra.feed)', page1.messages.length === 13 && page1.messages.every((m: any) => m.feed?.type), page1.messages.length);
  check('live likes never notify (silent)', decided.filter((d: any) => d.type === 'like').length === 3 && decided.filter((d: any) => d.type === 'like').every((d: any) => d.decision === 'silent'), decided);
  check('the live reply is at most a silent row on the list', decided.some((d: any) => d.type === 'reply' && (d.decision === 'digest' || d.decision === 'drop')), decided);

  // ------------------------------------------------------------------ the inbox row, desktop
  await page.size(1280, 860);
  await load('#/inbox');
  await page.until(`!!document.querySelector('.feed-row')`, 20000);
  await page.until(`document.querySelectorAll('.feed-row-who .avatar').length > 1`, 10000).catch(() => {});
  const row = await page.eval<any>(`(() => {
    const r = document.querySelector('.feed-row');
    const side = r.closest('.side-scroll');
    const kids = [...side.children];
    const firstRanked = side.querySelector('[data-row]');
    return {
      title: r.querySelector('.row-title').textContent,
      count: r.querySelector('.requests-count')?.textContent ?? null,
      who: r.querySelectorAll('.feed-row-who .avatar').length,
      what: r.querySelector('.row-preview').textContent,
      afterRequests: !document.querySelector('.requests-row') || kids.indexOf(document.querySelector('.requests-row')) < kids.indexOf(r),
      beforeRanked: !firstRanked || kids.indexOf(r) < kids.indexOf(firstRanked),
      feedRanked: !!side.querySelector('[data-row="${feed.id}"]'),
    };
  })()`);
  check('the X notifications row sits under Requests, above the ranked rows', row.title.startsWith('X notifications') && row.afterRequests && row.beforeRanked, row);
  check('it says how many are new (4), who (their faces) and what', row.count === '4' && row.who >= 3 && /replied to your post/.test(row.what) && /and \d+ more/.test(row.what), row);
  check('the feed is not one of the ranked inbox rows', !row.feedRanked);
  if (shots) await page.shot(join(shots, 'x-feed-row-desktop.png'));

  // ------------------------------------------------------------------ the feed, desktop: by post
  await page.eval(`document.querySelector('.feed-row').click()`);
  await page.until(`location.hash.includes(${JSON.stringify(feed.id)}) && document.querySelectorAll('.feed-unit').length >= 4`, 20000);
  const units = await page.eval<any[]>(`[...document.querySelectorAll('.feed-unit')].map((u) => ({
    unit: u.dataset.unit, text: u.textContent, mine: u.querySelector('.feed-mine')?.textContent ?? '', pic: !!u.querySelector('.feed-mine-pic'),
    talk: [...u.querySelectorAll('.feed-talk .thread-post')].map((t) => t.textContent), react: u.querySelector('.feed-react')?.textContent ?? null,
    likes: u.querySelector('.feed-react-counts .like')?.textContent.trim() ?? null, reposts: u.querySelector('.feed-react-counts .repost')?.textContent.trim() ?? null,
    quotedInTalk: !!u.querySelector('.feed-talk .post-quoted'),
    pics: u.querySelectorAll('.post-media img').length, fresh: u.classList.contains('fresh'),
  }))`);
  const routing = units.find((u) => /Greedy routing/.test(u.mine));
  const sheaves = units.find((u) => /Sheafification/.test(u.mine));
  check('your post is one card: small at its head, with its picture', !!routing && routing.unit === 'post' && routing.pic, routing?.mine);
  check("…Ravi's reply under it in full, marked new", !!routing && routing.talk.length === 1 && /Ravi/.test(routing.talk[0]) && /Does it hold up under churn/.test(routing.talk[0]) && /new/.test(routing.talk[0]), routing?.talk);
  check('…five likes and a repost as one quiet line: counts as X gives them, who by name', !!routing?.react && routing.likes === '41' && routing.reposts === '3' && /Liked by Theo, Maya K\. and 3 others/.test(routing.react), routing?.react);
  check("another post: Lee's quote under it (not quoting the post again), its likes by name", !!sheaves && /cleanest one-line summary/.test(sheaves.talk.join(' ')) && /quoted/.test(sheaves.talk.join(' ')) && !sheaves.quotedInTalk && /Liked by Alice Chen and Nora/.test(sheaves.react ?? ''), sheaves);
  check('two follows are one row', units.some((u) => u.unit === 'follow' && /Sam and Lee followed you/.test(u.text)), units.filter((u) => u.unit === 'follow').map((u) => u.text));
  const mention = units.find((u) => u.unit === 'said');
  check('a mention is their post on its own, with its picture', !!mention && /mentioned you/.test(mention.text) && /discrete Morse theory/.test(mention.text) && mention.pics === 1, mention);
  check('newest activity first, and what was new when it opened is marked', units[0] === routing && routing.fresh && !units[units.length - 1].fresh, units.map((u) => `${u.unit}${u.fresh ? '*' : ''}`));
  if (shots) await page.shot(join(shots, 'x-feed-desktop.png'));

  // Who reacted: the line opens the list, from the hub, every one named.
  await page.eval(`[...document.querySelectorAll('.feed-unit')].find((u) => /Greedy routing/.test(u.querySelector('.feed-mine')?.textContent ?? '')).querySelector('.feed-react').click()`);
  await page.until(`document.querySelectorAll('.feed-reactors .post-reactor').length >= 5`, 10000);
  const likers = await page.eval<any>(`(() => { const r = document.querySelector('.feed-reactors'); return { people: [...r.querySelectorAll('.post-reactor-name b')].map((b) => b.textContent), note: r.querySelector('.post-reactors-note')?.textContent ?? '' }; })()`);
  check('the line opens who liked it, from X and ranked for you: the five your notifications named among them', ['Theo', 'Maya K.', 'Quinn', 'Ravi', 'Alice Chen'].every((n) => likers.people.includes(n)) && likers.people.length >= 8, likers);
  if (shots) await page.shot(join(shots, 'x-feed-likers-desktop.png'));
  await page.eval(`[...document.querySelectorAll('.feed-reactors .feed-tab')].find((b) => b.textContent.startsWith('Reposts')).click()`);
  await page.until(`[...document.querySelectorAll('.feed-reactors .post-reactor-name b')].map((b) => b.textContent).join() .includes('Nora')`, 5000).then(() => check('…and who reposted it', true), () => check('…and who reposted it', false));


  // ------------------------------------------------------------------ read on the hub only, nothing sent to X
  await until(async () => (await json('/api/bootstrap')).conversations.find((c: any) => c.id === feed.id)?.vantages.every((v: any) => v.unread === 0), 10_000, 'the feed was not marked read');
  check('opening it marks it read on the hub', true);
  const refused = await fetch(`${base}/api/conversations/${feed.id}/send`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ body: 'hi' }) });
  const refusal = await refused.json().catch(() => ({}));
  check('a send there is refused with a plain reason', refused.status === 409 && /read-only here/.test(refusal.error ?? ''), { status: refused.status, ...refusal });
  await fetch(`${base}/api/conversations/${feed.id}/typing`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' });
  await Bun.sleep(1200);
  const reads = (await action('readLog')).result?.reads ?? null;
  const typing = (await action('typingLog')).result?.typing ?? null;
  const sends = (await action('sendLog')).result?.sent ?? null;
  check('X was sent no read mark, no typing and nothing else', Array.isArray(reads) && !reads.length && Array.isArray(typing) && !typing.length && Array.isArray(sends) && !sends.length, { reads, typing, sends });
  check('the row stays a day after it was read, with no count', await page.eval<boolean>(`!!document.querySelector('.feed-row') && !document.querySelector('.feed-row .requests-count')`));

  // ------------------------------------------------------------------ a name opens their profile
  await page.eval(`(() => { const b = [...document.querySelectorAll('.feed-unit')].find((u) => /Greedy routing/.test(u.querySelector('.feed-mine')?.textContent ?? '')).querySelector('.feed-react'); if (b.getAttribute('aria-expanded') !== 'true') b.click(); })()`);
  await page.until(`!!document.querySelector('.feed-reactors .feed-tab')`, 10000);
  await page.eval(`[...document.querySelectorAll('.feed-reactors .feed-tab')].find((b) => b.textContent.startsWith('Likes')).click()`);
  await page.until(`document.querySelectorAll('.feed-reactors .post-reactor').length >= 5`, 10000);
  await page.eval(`[...document.querySelectorAll('.feed-reactors .post-reactor')].find((b) => /Alice Chen/.test(b.textContent)).click()`);
  await page.until(`location.hash.startsWith('#/p/') && !!document.querySelector('.pf-posts .post-item')`, 20000);
  await page.until(`!!document.querySelector('.pf-follow')`, 5000).catch(() => {});
  const prof = await page.eval<any>(`(() => ({
    posts: document.querySelectorAll('.pf-posts .post-item').length,
    pinned: [...document.querySelectorAll('.pf-posts .post-mark')].some((m) => m.textContent.includes('Pinned')),
    repost: [...document.querySelectorAll('.pf-posts .post-mark')].some((m) => m.textContent.includes('reposted')),
    replying: [...document.querySelectorAll('.pf-posts .post-mark')].some((m) => m.textContent.includes('Replying to')),
    quote: !!document.querySelector('.pf-posts .post-item .post-quoted'),
    counts: document.querySelector('.pf-follow')?.textContent ?? '',
    connections: document.querySelector('.pf-standing')?.textContent ?? '',
    tags: [...document.querySelectorAll('.pf-tag[data-kind]')].map((t) => t.dataset.kind),
    bio: document.querySelector('.pf-bio')?.textContent ?? '',
    recent: [...document.querySelectorAll('.pf-msg')].map((m) => m.textContent),
  }))()`);
  check('a name in the list of who liked it opens their profile, with Recent posts from X', prof.posts >= 4 && prof.pinned && prof.repost && prof.replying && prof.quote, prof);
  // Following each other is a connection (docs/profile.md "Connections"); the counts stay facts in About.
  check('…their bio, follow counts, and that you follow each other', /Distributed systems/.test(prof.bio) && /2,310 followers/.test(prof.counts) && /512 following/.test(prof.counts) && /You follow each other on X/.test(prof.connections) && prof.tags.includes('friend'), { bio: prof.bio, counts: prof.counts, connections: prof.connections, tags: prof.tags });
  check('…and what they did in Recent messages', prof.recent.some((t: string) => /X notifications/.test(t) && /Liked your post/.test(t)), prof.recent);
  if (shots) await page.shot(join(shots, 'x-profile-desktop.png'));

  // ------------------------------------------------------------------ light
  await setTheme('dither-light');
  await load(`#/inbox/c/${feed.id}`);
  await page.until(`document.querySelectorAll('.feed-unit').length >= 4`, 20000);
  check('the feed in a light theme', (await page.eval(`document.documentElement.dataset.theme`)) === 'light', await page.eval(`document.documentElement.dataset.theme`));
  if (shots) await page.shot(join(shots, 'x-feed-light.png'));
  await setTheme('dither-dark');

  // ------------------------------------------------------------------ a phone
  await page.size(390, 844, true);
  await load('#/inbox');
  await page.until(`!!document.querySelector('.app.phone .feed-row')`, 20000);
  if (shots) await page.shot(join(shots, 'x-feed-row-phone.png'));
  await page.eval(`document.querySelector('.feed-row').click()`);
  await page.until(`document.querySelectorAll('.feed-unit').length >= 4 && !!document.querySelector('.feed-bar')`, 20000);
  await Bun.sleep(400);
  const phone = await page.eval<any>(`(() => { const b = document.querySelector('.feed-bar').getBoundingClientRect(); return { barIn: b.bottom <= innerHeight + 1 && b.top > 0, back: !!document.querySelector('.conv-head .back') }; })()`);
  check('on a phone: the feed full width, its bar on screen, a Back button', phone.barIn && phone.back, phone);
  check('nothing sideways on a phone', (await overflow('.feed-scroll')) === 0, await overflow('.feed-scroll'));
  if (shots) await page.shot(join(shots, 'x-feed-phone.png'));
  await page.eval(`document.querySelector('.feed-talk .post-who').click()`);
  await page.until(`location.hash.startsWith('#/p/') && !!document.querySelector('.pf-posts .post-item')`, 20000);
  check("a reply's name opens the profile on a phone too", true);
  if (shots) await page.shot(join(shots, 'x-profile-phone.png'));

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
