/**
 * Answering on X (docs/feed.md "Answering"), in a real browser against a demo hub of its own on a fresh data dir: like
 * and repost with the bar under a post, who liked it on hovering the button (ranked, opening a profile), a long press
 * showing it on a phone, the composer counting as X counts (the ring, the number from 20 left, a red negative past
 * 280 with what is too much marked, Post greyed), a reply posted to the top of the tree, a reply to a reply, a quote,
 * the quiet style menu, and what reached the demo X account: exactly the presses made.
 *
 *   bun scripts/verify-x-answer.ts [--port 8694] [--web <built dist>] [--work <empty dir>] [--keep] [--shots <dir>]
 */
import { mkdirSync, mkdtempSync, openSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { launch } from './browser.ts';

const args = process.argv.slice(2);
const opt = (k: string, d: string) => (args.includes(`--${k}`) ? args[args.indexOf(`--${k}`) + 1] : d);
const PORT = Number(opt('port', '8694'));
const root = resolve(import.meta.dir, '..');
const base = `http://127.0.0.1:${PORT}`;
const work = args.includes('--work') ? opt('work', '') : mkdtempSync(join(tmpdir(), `dither-verify-x-answer-${PORT}-`));
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
      // The comment tree: each reply's depth and who wrote it, in page order ("2:Nora").
      tree: [...document.querySelectorAll('.ct-node')].map((n) => n.dataset.depth + ':' + (n.querySelector(':scope > .ct-main .post-who b')?.textContent ?? '')),
      flat: [...document.querySelectorAll('.ct-flat')].map((f) => [f.querySelector('.ct-flat-top .post-who b')?.textContent, f.querySelectorAll('.ct-flat-reply').length]),
      style: document.querySelector('.thread-style [aria-pressed="true"]')?.textContent ?? null,
      lines: document.querySelectorAll('.thread-post.line').length,
      more: !!document.querySelector('.thread-more'),
      openOnX: f?.querySelector('.post-open')?.href ?? null,
      stored: document.querySelector('.thread-stored')?.textContent ?? null,
    };
  })()`);


const center = (sel: string) => page.eval<{ x: number; y: number } | null>(`(() => { const r = document.querySelector(${JSON.stringify(sel)})?.getBoundingClientRect(); return r ? { x: r.x + r.width / 2, y: r.y + r.height / 2 } : null; })()`);
const hover = async (sel: string) => {
  const c = await center(sel);
  if (!c) throw new Error(`nothing to hover: ${sel}`);
  await page.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: c.x - 40, y: c.y - 40 });
  await page.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: c.x, y: c.y });
};
const type = async (sel: string, text: string) => {
  await page.eval(`(() => { const a = document.querySelector(${JSON.stringify(sel)}); a.focus(); a.select(); })()`);
  await page.send('Input.insertText', { text });
};
const toReplies = async () => {
  await page.eval(`document.querySelector('.thread-replies-bar')?.scrollIntoView({ block: 'start' })`);
  await Bun.sleep(150);
};
const writes = async () => ((await action('writeLog')).result?.writes ?? null) as string[] | null;
const focalLike = '.thread-focal .post-actions .pa-btn.like';

try {
  await page.size(1280, 900);
  // ------------------------------------------------------------------ the bar under your post, and who liked it
  await load(`#/inbox/c/${feed.id}`);
  await page.until(`document.querySelectorAll('.feed-unit').length >= 4`, 20000);
  await page.eval(`[...document.querySelectorAll('.feed-unit[data-unit="post"] .feed-mine')].find((a) => /Greedy routing/.test(a.textContent)).click()`);
  await page.until(`!!document.querySelector('${focalLike}') && document.querySelectorAll('.ct-node').length > 0`, 20000);
  const bar = await page.eval<any>(`(() => { const b = document.querySelector('.thread-focal .post-actions'); return { buttons: [...b.querySelectorAll('.pa-btn')].map((x) => x.className.replace('pa-btn ', '').trim()), like: b.querySelector('.pa-btn.like').textContent, title: b.querySelector('.pa-btn.like').title }; })()`);
  check('under your post: reply, repost and like, with counts', bar.buttons.join(',') === 'reply,repost,like' && /41/.test(bar.like), bar);
  check('…the like button says it shows who on hovering', /hover to see who/.test(bar.title), bar.title);
  await hover(focalLike);
  await page.until(`document.querySelectorAll('.pa-pop .post-reactor').length >= 5`, 10000);
  const pop = await page.eval<any>(`(() => { const p = document.querySelector('.pa-pop'); return { head: p.querySelector('.post-reactors-head')?.textContent, people: [...p.querySelectorAll('.post-reactor')].map((r) => ({ name: r.querySelector('.post-reactor-name b')?.textContent, why: r.querySelector('.post-reactor-why')?.textContent ?? '' })), more: !!p.querySelector('.post-reactors-more') }; })()`);
  check('hovering the like button shows who liked it, most relevant first', /Liked by/.test(pop.head) && /most relevant first/.test(pop.head) && pop.people.length === 8 && pop.more, pop);
  check('…saying why: followers, follows you', pop.people.some((p: any) => /184K followers/.test(p.why)) && pop.people.some((p: any) => /Follows you|follow each other/.test(p.why)), pop.people);
  if (shots) await page.shot(join(shots, 'answer-likers-hover.png'));
  await page.eval(`document.querySelector('.pa-pop .post-reactors-more').click()`);
  await page.until(`document.querySelectorAll('.pa-pop .post-reactor').length > 8`, 10000);
  check('…Show more brings the rest', true);
  await page.eval(`[...document.querySelectorAll('.pa-pop .post-reactor')].find((r) => /Ravi/.test(r.textContent)).click()`);
  await page.until(`location.hash.startsWith('#/i/') || location.hash.startsWith('#/p/')`, 10000);
  check('a name in it opens their profile', true);
  await page.eval(`history.back()`);
  await page.until(`!!document.querySelector('${focalLike}')`, 20000);

  // ------------------------------------------------------------------ like and repost: one press each
  let w0 = (await writes())!.length;
  await page.eval(`document.querySelector('${focalLike}').click()`);
  await page.until(`document.querySelector('${focalLike}').classList.contains('on') && /42/.test(document.querySelector('${focalLike}').textContent)`, 5000);
  await until(async () => (await writes())!.length > w0, 5000, 'the like did not reach X');
  check('a like shows at once (42) and reaches X once', (await writes())!.slice(w0).join() === 'postAct:like', (await writes())!.slice(w0));
  await page.eval(`document.querySelector('.thread-focal .pa-btn.repost').click()`);
  await page.until(`!!document.querySelector('.thread-focal .pa-menu')`, 3000);
  const menu = await page.eval<string[]>(`[...document.querySelectorAll('.thread-focal .pa-menu button')].map((b) => b.textContent.trim())`);
  check('repost asks, as X does: Repost or Quote', menu.join('|') === 'Repost|Quote', menu);
  if (shots) await page.shot(join(shots, 'answer-repost-menu.png'));
  w0 = (await writes())!.length;
  await page.eval(`document.querySelector('.thread-focal .pa-menu button').click()`);
  await page.until(`document.querySelector('.thread-focal .pa-btn.repost').classList.contains('on')`, 5000);
  await until(async () => (await writes())!.length > w0, 5000, 'the repost did not reach X');
  check('Repost reposts', (await writes())!.slice(w0).join() === 'postAct:repost');
  const here = await page.eval<string>('location.hash');
  await load(here);
  await page.until(`!!document.querySelector('${focalLike}')`, 20000);
  const kept = await page.eval<any>(`({ liked: document.querySelector('${focalLike}').classList.contains('on'), reposted: document.querySelector('.thread-focal .pa-btn.repost').classList.contains('on') })`);
  check('read again, X says you liked and reposted it', kept.liked && kept.reposted, kept);

  // ------------------------------------------------------------------ the composer, counting as X counts
  await page.eval(`document.querySelector('.thread-focal .compose-closed').click()`);
  await page.until(`!!document.querySelector('.thread-focal .compose-text')`, 3000);
  const ring = () => page.eval<any>(`(() => { const c = document.querySelector('.thread-focal .composer'); return { level: [...c.classList].find((x) => ['ok', 'warn', 'over'].includes(x)), n: c.querySelector('.ring-n')?.textContent ?? null, svg: !!c.querySelector('.compose-ring svg'), mark: c.querySelector('.compose-back mark')?.textContent ?? null, send: !c.querySelector('.compose-send').disabled, to: c.querySelector('.compose-to')?.textContent ?? null }; })()`);
  await type('.thread-focal .compose-text', 'a'.repeat(100));
  let r = await ring();
  check('a reply box under the post, "Replying to @zyan_demo"; a ring and no number at 100', r.level === 'ok' && r.svg && r.n === null && r.send && /Replying to @zyan_demo/.test(r.to), r);
  await type('.thread-focal .compose-text', 'a'.repeat(265));
  r = await ring();
  check('from 20 left the number shows: 15, in warning', r.level === 'warn' && r.n === '15' && r.send, r);
  if (shots) await page.shot(join(shots, 'answer-compose-warn.png'));
  await type('.thread-focal .compose-text', 'a'.repeat(286));
  r = await ring();
  check('past 280: -6 in red, the six too many marked, Post greyed', r.level === 'over' && r.n === '-6' && r.mark === 'aaaaaa' && !r.send, r);
  if (shots) await page.shot(join(shots, 'answer-compose-over.png'));
  await type('.thread-focal .compose-text', `日本語 ${'語'.repeat(140)}`);
  r = await ring();
  // 日本語 and a space are 7; 140 more CJK characters are 280: 287, the last four marked.
  check('CJK counts two: 144 characters are 287, over by 7, the last four marked', r.level === 'over' && r.n === '-7' && r.mark === '語語語語', r);
  await type('.thread-focal .compose-text', 'see https://example.com/a/very/long/path/that/would/be/long ' + 'a'.repeat(240));
  r = await ring();
  // "see " 4, the link 23, a space 1, 240 more: 268.
  check('a link counts 23 however long: 12 left', r.n === '12', r);
  w0 = (await writes())!.length;
  await type('.thread-focal .compose-text', 'Thanks all: the write-up is coming this week.');
  await page.eval(`document.querySelector('.thread-focal .compose-send').click()`);
  await page.until(`[...document.querySelectorAll('.ct-node[data-depth="0"]')][0]?.textContent.includes('write-up is coming')`, 10000);
  const top = await page.eval<any>(`(() => { const n = document.querySelector('.ct-node[data-depth="0"]'); return { who: n.querySelector('.post-who b')?.textContent, op: !!n.querySelector('.post-tag.op') }; })()`);
  check('Post: the reply is at the top of the tree, yours (OP)', top.who === 'You' && top.op, top);
  check('…and reached X once', (await writes())!.slice(w0).join() === 'publish', (await writes())!.slice(w0));
  check('…the box is empty again', (await page.eval<string>(`document.querySelector('.thread-focal .compose-text, .thread-focal .compose-closed')?.value ?? ''`)) === '');
  if (shots) await page.shot(join(shots, 'answer-replied.png'));

  // ------------------------------------------------------------------ a reply to a reply; a quote
  await page.eval(`[...document.querySelectorAll('.ct-node')].find((n) => n.querySelector(':scope > .ct-main .post-who b')?.textContent === 'Ravi').querySelector(':scope > .ct-main .pa-btn.reply').click()`);
  await page.until(`!!document.querySelector('.ct-node .composer')`, 3000);
  r = await page.eval<any>(`({ to: document.querySelector('.ct-node .composer .compose-to')?.textContent, focused: document.activeElement?.classList.contains('compose-text') })`);
  check('Reply under a reply opens a box there, focused, "Replying to @ravi_routes"', /@ravi_routes/.test(r.to) && r.focused, r);
  if (shots) await page.shot(join(shots, 'answer-reply-to-reply.png'));
  await page.send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 });
  await page.until(`!document.querySelector('.ct-node .composer')`, 3000);
  check('Escape closes it', true);
  await page.eval(`[...document.querySelectorAll('.ct-node')].find((n) => n.querySelector(':scope > .ct-main .post-who b')?.textContent === 'Alice Chen').querySelector(':scope > .ct-main .pa-btn.repost').click()`);
  await page.until(`!!document.querySelector('.ct-node .pa-menu')`, 3000);
  await page.eval(`[...document.querySelectorAll('.ct-node .pa-menu button')].find((b) => /Quote/.test(b.textContent)).click()`);
  await page.until(`!!document.querySelector('.composer[data-composer="quote"] .post-quoted')`, 3000);
  w0 = (await writes())!.length;
  await type('.composer[data-composer="quote"] .compose-text', 'The best question in the thread.');
  if (shots) await page.shot(join(shots, 'answer-quote.png'));
  await page.send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13, modifiers: 2 });
  await page.until(`!document.querySelector('.composer[data-composer="quote"]')`, 10000);
  check('Quote: the post quoted under a box of your own; Ctrl+Enter posts it, once', (await writes())!.slice(w0).join() === 'publish', (await writes())!.slice(w0));

  // ------------------------------------------------------------------ someone else's post: likers are theirs to see
  const ravisTitle = await page.eval<string>(`[...document.querySelectorAll('.ct-node')].find((n) => n.querySelector(':scope > .ct-main .post-who b')?.textContent === 'Ravi').querySelector(':scope > .ct-main .pa-btn.like').title`);
  check("someone else's post: no list of who liked it (X shows it only to its author)", !/hover to see who/.test(ravisTitle), ravisTitle);

  // ------------------------------------------------------------------ the style menu, out of the way
  const st = await page.eval<any>(`({ btn: document.querySelector('.ct-style-btn')?.textContent.trim(), segmented: document.querySelectorAll('.thread-replies-bar .feed-tab').length })`);
  check('the style is a quiet word beside Replies ("Tree"), not four buttons', st.btn === 'Tree' && st.segmented === 0, st);
  await page.eval(`document.querySelector('.ct-style-btn').click()`);
  await page.until(`document.querySelectorAll('.ct-style-menu button').length === 4`, 3000);
  if (shots) await toReplies(), await page.shot(join(shots, 'answer-style-menu.png'));
  await page.eval(`[...document.querySelectorAll('.ct-style-menu button')].find((b) => /Compact/.test(b.textContent)).click()`);
  await page.until(`!!document.querySelector('.ct.compact') && !document.querySelector('.ct-style-menu')`, 3000);
  check('…its menu has the four, and choosing one draws it', true);
  await page.eval(`document.querySelector('.ct-style-btn').click()`);
  await page.eval(`[...document.querySelectorAll('.ct-style-menu button')].find((b) => /Tree/.test(b.textContent)).click()`);
  await page.until(`!!document.querySelector('.ct.tree')`, 3000);

  // ------------------------------------------------------------------ a phone: a long press shows who
  await page.size(390, 844, true);
  await load(here);
  await page.until(`!!document.querySelector('${focalLike}')`, 20000);
  await page.eval(`document.querySelector('${focalLike}').scrollIntoView({ block: 'center' })`);
  await Bun.sleep(200);
  const c = (await center(focalLike))!;
  const touch = (type: string, pts: { x: number; y: number }[]) => page.send('Input.dispatchTouchEvent', { type, touchPoints: pts.map((p, i) => ({ ...p, id: i + 1, radiusX: 6, radiusY: 6, force: 1 })) });
  const likedBefore = await page.eval<boolean>(`document.querySelector('${focalLike}').classList.contains('on')`);
  await touch('touchStart', [c]);
  await Bun.sleep(650);
  await touch('touchEnd', []);
  await page.until(`document.querySelectorAll('.sheet .post-reactor').length >= 5`, 10000);
  const sheet = await page.eval<any>(`({ people: document.querySelectorAll('.sheet .post-reactor').length, liked: document.querySelector('${focalLike}').classList.contains('on') })`);
  check('on a phone, a long press on like shows who liked it in a sheet, and does not unlike', sheet.people >= 5 && sheet.liked === likedBefore, sheet);
  check('nothing sideways on a phone', (await overflow('.thread-scroll')) === 0, await overflow('.thread-scroll'));
  await Bun.sleep(500);
  const sheetBox = await page.eval<any>(`(() => { const r = document.querySelector('.sheet').getBoundingClientRect(); return { w: Math.round(r.width), top: Math.round(r.top), bottom: Math.round(r.bottom), h: innerHeight, anim: getComputedStyle(document.querySelector('.sheet')).transform, list: document.querySelector('.sheet .post-reactors')?.getBoundingClientRect().height }; })()`);
  check('…the sheet is the width of the screen, up from the bottom', sheetBox.w >= 380 && sheetBox.bottom <= sheetBox.h + 1, sheetBox);
  if (shots) await page.shot(join(shots, 'answer-likers-phone.png'));

  const final = (await writes())!;
  check('X got exactly the presses made: like, repost, a reply, a quote', final.join() === 'postAct:like,postAct:repost,publish,publish', final);
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
