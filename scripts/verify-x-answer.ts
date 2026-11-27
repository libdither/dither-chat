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
  env: { ...process.env, DITHER_DEMO_CHATTER: '0', DITHER_DEMO_POSTS: '0' },
  stdout: log,
  stderr: log,
});
await until(async () => (await fetch(`${base}/api/health`).catch(() => null))?.ok ?? false, 30_000, 'the hub did not start');
let boot = await json('/api/bootstrap');
if (!boot.accounts.every((a: any) => a.demo)) throw new Error('not a demo hub');
await until(async () => (boot = await json('/api/bootstrap')).conversations.some((c: any) => c.variant === 'feed'), 15_000, 'no feed conversation');
const feed = boot.conversations.find((c: any) => c.variant === 'feed');

const { page, close } = await launch();
const load = async (hash: string) => {
  await page.goto('about:blank');
  await page.goto(`${base}/${hash}`);
};
const overflow = (sel: string) => page.eval<number>(`(() => { const s = document.querySelector(${JSON.stringify(sel)}); return s ? s.scrollWidth - s.clientWidth : -1; })()`);


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
  // Reply aims the box at the bottom at the post.
  check('under your post: reply, repost, like and ⋯ (yours: Delete), with counts', bar.buttons.join(',') === 'reply,repost,like,more' && /41/.test(bar.like), bar);
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

  // ------------------------------------------------------------------ like and repost: one press each
  // Back to the thread, drawn afresh, and Like pressed the moment its button is drawn: before the page's effects
  // have run, as a quick press can be on a busy machine. The press stands (the bar's first effect once undid it).
  let w0 = (await writes())!.length;
  await page.eval(`(() => {
    const o = new MutationObserver(() => {
      const b = document.querySelector('${focalLike}');
      if (b) (o.disconnect(), b.click());
    });
    o.observe(document.body, { subtree: true, childList: true });
    history.back();
  })()`);
  await page.until(`document.querySelector('${focalLike}').classList.contains('on') && /42/.test(document.querySelector('${focalLike}').textContent)`, 5000);
  await until(async () => (await writes())!.length > w0, 5000, 'the like did not reach X');
  check('a like shows at once (42) and reaches X once', (await writes())!.slice(w0).join() === 'postAct:like', (await writes())!.slice(w0));
  await page.eval(`document.querySelector('.thread-focal .pa-btn.repost').click()`);
  await page.until(`!!document.querySelector('.pa-float.pa-menu')`, 3000);
  const menu = await page.eval<string[]>(`[...document.querySelectorAll('.pa-float.pa-menu button')].map((b) => b.textContent.trim())`);
  check('repost asks, as X does: Repost or Quote', menu.join('|') === 'Repost|Quote', menu);
  if (shots) await page.shot(join(shots, 'answer-repost-menu.png'));
  w0 = (await writes())!.length;
  await page.eval(`document.querySelector('.pa-float.pa-menu button').click()`);
  await page.until(`document.querySelector('.thread-focal .pa-btn.repost').classList.contains('on')`, 5000);
  await until(async () => (await writes())!.length > w0, 5000, 'the repost did not reach X');
  check('Repost reposts', (await writes())!.slice(w0).join() === 'postAct:repost');
  const here = await page.eval<string>('location.hash');
  await load(here);
  await page.until(`!!document.querySelector('${focalLike}')`, 20000);
  const kept = await page.eval<any>(`({ liked: document.querySelector('${focalLike}').classList.contains('on'), reposted: document.querySelector('.thread-focal .pa-btn.repost').classList.contains('on') })`);
  check('read again, X says you liked and reposted it', kept.liked && kept.reposted, kept);

  // A refusal takes back only what it refused.
  await action('failNextAct');
  const firstReply = `[...document.querySelectorAll('.ct-node[data-depth="0"]')][0]`;
  await page.eval(`${firstReply}.querySelector(':scope > .ct-main .pa-btn.like').click()`);
  await page.until(`!${firstReply}.querySelector(':scope > .ct-main .pa-btn.like').classList.contains('on') && !!document.querySelector('.toast')`, 8000).then(
    () => check('a like X refuses goes back, with a toast saying why', true),
    () => check('a like X refuses goes back, with a toast saying why', false),
  );

  // ------------------------------------------------------------------ one box, at the bottom, counting as X counts
  const BOX = '.thread-box .compose-text';
  const box = await page.eval<any>(`({ under: !!document.querySelector('.thread-focal .post-composer, .thread-focal .compose-closed, .ct-node .post-composer'), bottom: !!document.querySelector('.thread-pane > .thread-box'), lead: document.querySelector('.thread-box .compose-lead')?.textContent ?? '' })`);
  check('one box, at the bottom of the page, none under the post', !box.under && box.bottom, box);
  check('…its line says where it goes and as whom: "Reply to yourself on X · as @zyan_demo"', /^Reply to yourself on X · as @zyan_demo/.test(box.lead), box.lead);
  await page.eval(`document.querySelector('.thread-focal .post-actions .pa-btn.reply').click()`);
  await page.until(`document.activeElement === document.querySelector('${BOX}')`, 3000).then(
    () => check('Reply on the post focuses the box', true),
    () => check('Reply on the post focuses the box', false),
  );
  const hashBefore = await page.eval<string>('location.hash');
  await page.send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 });
  await page.until(`document.activeElement !== document.querySelector('${BOX}')`, 3000).then(
    () => check('Escape in the empty box leaves the box, not the page', true),
    () => check('Escape in the empty box leaves the box, not the page', false),
  );
  check('…the page stays', (await page.eval<string>('location.hash')) === hashBefore);
  const ring = () => page.eval<any>(`(() => { const c = document.querySelector('.thread-box .post-composer'); return { level: [...c.classList].find((x) => ['ok', 'warn', 'over'].includes(x)), n: c.querySelector('.ring-n')?.textContent ?? null, svg: !!c.querySelector('.compose-ring svg'), mark: c.querySelector('.compose-back mark')?.textContent ?? null, send: !c.querySelector('.compose-send').disabled, aim: !!document.querySelector('.thread-box .compose-aim') }; })()`);
  await type(BOX, 'a'.repeat(100));
  let r = await ring();
  check('answering the post: no aim bar; a ring and no number at 100', r.level === 'ok' && r.svg && r.n === null && r.send && !r.aim, r);
  await type(BOX, 'a'.repeat(265));
  r = await ring();
  check('from 20 left the number shows: 15, in warning', r.level === 'warn' && r.n === '15' && r.send, r);
  if (shots) await page.shot(join(shots, 'answer-compose-warn.png'));
  await type(BOX, 'a'.repeat(286));
  r = await ring();
  check('past 280: -6 in red, the six too many marked, Post greyed', r.level === 'over' && r.n === '-6' && r.mark === 'aaaaaa' && !r.send, r);
  if (shots) await page.shot(join(shots, 'answer-compose-over.png'));
  await type(BOX, `日本語 ${'語'.repeat(140)}`);
  r = await ring();
  // 日本語 and a space are 7; 140 more CJK characters are 280: 287, the last four marked.
  check('CJK counts two: 144 characters are 287, over by 7, the last four marked', r.level === 'over' && r.n === '-7' && r.mark === '語語語語', r);
  await type(BOX, 'see https://example.com/a/very/long/path/that/would/be/long ' + 'a'.repeat(240));
  r = await ring();
  // "see " 4, the link 23, a space 1, 240 more: 268.
  check('a link counts 23 however long: 12 left', r.n === '12', r);
  w0 = (await writes())!.length;
  await type(BOX, 'Thanks all: the write-up is coming this week.');
  await page.eval(`document.querySelector('.thread-box .compose-send').click()`);
  await page.until(`[...document.querySelectorAll('.ct-node[data-depth="0"]')][0]?.textContent.includes('write-up is coming')`, 10000);
  const top = await page.eval<any>(`(() => { const n = document.querySelector('.ct-node[data-depth="0"]'); return { who: n.querySelector('.post-who b')?.textContent, op: !!n.querySelector('.post-tag.op') }; })()`);
  check('Post: the reply is at the top of the tree, yours (OP)', top.who === 'You' && top.op, top);
  check('…and reached X once', (await writes())!.slice(w0).join() === 'publish', (await writes())!.slice(w0));
  check('…the box is empty again', (await page.eval<string>(`document.querySelector('${BOX}')?.value ?? 'gone'`)) === '');
  // A second reply from the same box is a second post, not the first one again.
  w0 = (await writes())!.length;
  await type(BOX, 'And the simulator runs in the browser now.');
  await page.eval(`document.querySelector('.thread-box .compose-send').click()`);
  await page.until(`[...document.querySelectorAll('.ct-node[data-depth="0"]')][0]?.textContent.includes('runs in the browser now')`, 10000);
  check('a second reply from the same box posts too', (await writes())!.slice(w0).join() === 'publish', (await writes())!.slice(w0));
  if (shots) await page.shot(join(shots, 'answer-replied.png'));

  // ------------------------------------------------------------------ a reply to a reply, from the same box; a quote
  const ravi = `[...document.querySelectorAll('.ct-node')].find((n) => n.querySelector(':scope > .ct-main .post-who b')?.textContent === 'Ravi')`;
  const raviId = await page.eval<string>(`${ravi}.dataset.post`);
  await page.eval(`${ravi}.querySelector(':scope > .ct-main .pa-btn.reply').click()`);
  await page.until(`document.querySelector('.thread-box')?.dataset.aimed === '${raviId}' && document.activeElement === document.querySelector('${BOX}')`, 3000);
  r = await page.eval<any>(`({ bar: document.querySelector('.thread-box .compose-aim')?.textContent ?? '', lead: document.querySelector('.thread-box .compose-lead')?.textContent ?? '', boxes: document.querySelectorAll('.post-composer').length })`);
  check('Reply under a reply aims the one box at it: "Replying to @ravi_routes" and its first words, the line "Reply to Ravi"', /Replying to @ravi_routes/.test(r.bar) && /Does it hold up/.test(r.bar) && /^Reply to Ravi on X/.test(r.lead) && r.boxes === 1, r);
  if (shots) await page.shot(join(shots, 'answer-reply-to-reply.png'));
  // Escape takes the aim off first, from the box or from the page; the page stays.
  await page.send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 });
  await page.until(`!document.querySelector('.thread-box')?.dataset.aimed && !document.querySelector('.compose-aim')`, 3000);
  check('Escape takes the aim off, and the page stays', (await page.eval<string>('location.hash')) === hashBefore);
  await page.eval(`${ravi}.querySelector(':scope > .ct-main .pa-btn.reply').click()`);
  // The cursor lands in the box a moment after the aim: wait for it, then take it out, so this Escape is the page's.
  await page.until(`document.querySelector('.thread-box')?.dataset.aimed === '${raviId}' && document.activeElement === document.querySelector('${BOX}')`, 3000);
  await page.eval(`document.activeElement.blur()`);
  await page.until(`document.activeElement === document.body`, 3000);
  await page.send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 });
  await page.until(`!document.querySelector('.thread-box')?.dataset.aimed`, 3000);
  check('…from outside the box too, before anything leaves the page', (await page.eval<string>('location.hash')) === hashBefore);
  // The ✕ takes it off; then aimed again and posted: the reply goes under Ravi's.
  await page.eval(`${ravi}.querySelector(':scope > .ct-main .pa-btn.reply').click()`);
  await page.until(`!!document.querySelector('.thread-box .compose-aim .icon-btn')`, 3000);
  await page.eval(`document.querySelector('.thread-box .compose-aim .icon-btn').click()`);
  await page.until(`!document.querySelector('.thread-box')?.dataset.aimed`, 3000);
  check('…and so does its ✕', true);
  await page.eval(`${ravi}.querySelector(':scope > .ct-main .pa-btn.reply').click()`);
  await page.until(`document.querySelector('.thread-box')?.dataset.aimed === '${raviId}'`, 3000);
  w0 = (await writes())!.length;
  await type(BOX, 'Under churn it holds: 1.35 at a fifth gone.');
  await page.eval(`document.querySelector('.thread-box .compose-send').click()`);
  await page.until(`${ravi}?.textContent.includes('1.35 at a fifth gone')`, 10000).then(
    () => check('posted from the bottom box, the reply shows under the reply it answers', true),
    () => check('posted from the bottom box, the reply shows under the reply it answers', false),
  );
  check('…reached X once, the aim gone after', (await writes())!.slice(w0).join() === 'publish' && !(await page.eval<boolean>(`!!document.querySelector('.thread-box')?.dataset.aimed`)), (await writes())!.slice(w0));
  await page.eval(`[...document.querySelectorAll('.ct-node')].find((n) => n.querySelector(':scope > .ct-main .post-who b')?.textContent === 'Alice Chen').querySelector(':scope > .ct-main .pa-btn.repost').click()`);
  await page.until(`!!document.querySelector('.pa-float.pa-menu')`, 3000);
  await page.eval(`[...document.querySelectorAll('.pa-float.pa-menu button')].find((b) => /Quote/.test(b.textContent)).click()`);
  await page.until(`!!document.querySelector('.thread-box .post-composer[data-composer="quote"] .post-quoted') && /Quoting @alicechen_dev/.test(document.querySelector('.thread-box .compose-aim')?.textContent ?? '')`, 3000);
  w0 = (await writes())!.length;
  await type(BOX, 'The best question in the thread.');
  if (shots) await page.shot(join(shots, 'answer-quote.png'));
  await page.send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13, modifiers: 2 });
  await page.until(`!document.querySelector('.post-composer[data-composer="quote"]')`, 10000);
  check('Quote: aims the box, the post quoted in it; Ctrl+Enter posts it, once', (await writes())!.slice(w0).join() === 'publish', (await writes())!.slice(w0));

  // ------------------------------------------------------------------ the account it answers as
  const w2 = async () => ((await json(`/api/accounts/acc_demo-x2/action`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ action: 'writeLog' }) })).result?.writes ?? []) as string[];
  check('two X accounts that post: the line has a toggle between them', (await page.eval<number>(`document.querySelectorAll('.thread-box .compose-lead button.pair-token').length`)) === 1);
  await page.eval(`document.querySelector('.thread-box .compose-lead button.pair-token').click()`);
  await page.until(`/as @work_demo/.test(document.querySelector('.thread-box .compose-lead')?.textContent ?? '')`, 3000);
  check('…pressed, it posts as @work_demo', true);
  if (shots) await page.shot(join(shots, 'answer-as-work.png'));
  const own0 = (await writes())!.length;
  const work0 = (await w2()).length;
  const alice = `[...document.querySelectorAll('.ct-node')].find((n) => n.querySelector(':scope > .ct-main .post-who b')?.textContent === 'Alice Chen').querySelector(':scope > .ct-main .pa-btn.like')`;
  await page.eval(`${alice}.click()`);
  await until(async () => (await w2()).length > work0, 5000, 'the like did not reach the work account');
  await type(BOX, 'From the work account: we are hiring for this.');
  await page.eval(`document.querySelector('.thread-box .compose-send').click()`);
  await until(async () => (await w2()).length > work0 + 1, 10000, 'the reply did not reach the work account');
  check('a like and a reply on the page go out as the account picked, and nothing as the other', (await w2()).slice(work0).join() === 'postAct:like,publish' && (await writes())!.length === own0, { work: (await w2()).slice(work0), own: (await writes())!.slice(own0) });
  await load(here);
  await page.until(`!!document.querySelector('.thread-box .compose-lead')`, 20000);
  check('…remembered on the device for X: still @work_demo after a reload', /as @work_demo/.test(await page.eval<string>(`document.querySelector('.thread-box .compose-lead').textContent`)));
  await page.eval(`document.querySelector('.thread-box .compose-lead button.pair-token').click()`);
  await page.until(`/as @zyan_demo/.test(document.querySelector('.thread-box .compose-lead')?.textContent ?? '')`, 3000);
  // Your own reply has Delete in its ⋯ (the work account's, as it wrote it).
  check('your reply in the thread has ⋯ with Delete', (await page.eval<number>(`[...document.querySelectorAll('.ct-node')].filter((n) => n.querySelector(':scope > .ct-main .post-who b')?.textContent === 'You' && n.querySelector(':scope > .ct-main .pa-btn.more')).length`)) > 0);

  // ------------------------------------------------------------------ someone else's post: likers are theirs to see
  const ravisTitle = await page.eval<string>(`[...document.querySelectorAll('.ct-node')].find((n) => n.querySelector(':scope > .ct-main .post-who b')?.textContent === 'Ravi').querySelector(':scope > .ct-main .pa-btn.like').title`);
  check("someone else's post: no list of who liked it (X shows it only to its author)", !/hover to see who/.test(ravisTitle), ravisTitle);

  // The refused like stays taken back after the tree changed under it (two replies were added on top).
  const stillOff = await page.eval<boolean>(`![...document.querySelectorAll('.ct-node[data-depth="0"]')].find((n) => /Setup: a random geometric graph/.test(n.querySelector(':scope > .ct-main .ct-text')?.textContent ?? '')).querySelector(':scope > .ct-main .pa-btn.like').classList.contains('on')`);
  check('…and stays taken back when the tree changes around it', stillOff);

  // ------------------------------------------------------------------ in Chains the menu is over the page, not clipped
  await page.eval(`document.querySelector('.ct-style .look-btn[aria-label="Chains"]').click()`);
  await page.until(`document.querySelectorAll('.thread-chain .thread-post.line').length > 0`, 3000);
  await page.eval(`document.querySelector('.thread-chain .thread-post.line .pa-btn.repost').scrollIntoView({ block: 'center' })`);
  await Bun.sleep(150);
  await page.eval(`document.querySelector('.thread-chain .thread-post.line .pa-btn.repost').click()`);
  await page.until(`!!document.querySelector('.pa-float.pa-menu')`, 3000);
  // On top of the page: toasts (the demo's urgent notices, the refused like) stand over everything, menus included.
  const vis = await page.eval<any>(`(() => { const m = document.querySelector('.pa-float.pa-menu').getBoundingClientRect(); const hit = document.elementsFromPoint(m.x + m.width / 2, m.y + m.height / 2).find((e) => !e.closest('.toast, .toasts')); return { h: Math.round(m.height), onTop: !!hit?.closest('.pa-menu'), hit: hit?.className ?? null, inWindow: m.bottom <= innerHeight && m.top >= 0 }; })()`);
  check('in Chains the repost menu is whole and on top (not clipped by the chain)', vis.h > 50 && vis.onTop && vis.inWindow, vis);
  await page.send('Input.dispatchMouseEvent', { type: 'mousePressed', x: 30, y: 300, button: 'left', clickCount: 1 });
  await page.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: 30, y: 300, button: 'left', clickCount: 1 });
  await page.until(`!document.querySelector('.pa-float.pa-menu')`, 3000).then(
    () => check('…and a press outside closes it', true),
    () => check('…and a press outside closes it', false),
  );

  // ------------------------------------------------------------------ the styles, as pictures beside Replies
  await page.eval(`document.querySelector('.ct-style .look-btn[aria-label="Tree"]').click()`);
  await page.until(`!!document.querySelector('.ct.tree')`, 3000);
  const st = await page.eval<any>(`({ name: document.querySelector('.ct-style-name')?.textContent.trim(), pictures: [...document.querySelectorAll('.ct-style .look-btn')].map((b) => b.getAttribute('aria-label')), on: document.querySelector('.ct-style .look-btn[aria-checked="true"]')?.getAttribute('aria-label') })`);
  check('the styles are four pictures beside Replies, the one in use named ("Tree")', st.name === 'Tree' && st.pictures.join() === 'Tree,Compact,Flat,Chains' && st.on === 'Tree', st);
  if (shots) await toReplies(), await page.shot(join(shots, 'answer-style-menu.png'));
  await page.eval(`document.querySelector('.ct-style .look-btn[aria-label="Compact"]').click()`);
  await page.until(`!!document.querySelector('.ct.compact') && document.querySelector('.ct-style-name')?.textContent.trim() === 'Compact'`, 3000);
  check('…and pressing one draws it', true);
  await page.eval(`document.querySelector('.ct-style .look-btn[aria-label="Tree"]').click()`);
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
  check('X got exactly the presses made: like, repost, the refused like, three replies, a quote', final.join() === 'postAct:like,postAct:repost,postAct:like,publish,publish,publish,publish', final);
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
