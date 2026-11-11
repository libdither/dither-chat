/**
 * Network search and index jobs (docs/indexing.md), end to end against a demo hub in headless Chromium: a search's
 * "On the networks" part asked on a click, its places as they are asked, the archive messages it brings back below
 * the hub's own hits, and more places on request; then a job made from a server's About page, followed on Settings →
 * Indexing until it is done, and the folder's and the channel's menus offering the same.
 *
 *   bun scripts/verify-indexing.ts http://127.0.0.1:8791 /tmp/dc-indexing-shots
 * Asks the demo networks and stores what they send; point it at a demo hub (--demo) with its own data dir.
 */
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { launch, type Page } from './browser.ts';

const hub = process.argv[2] ?? 'http://127.0.0.1:8791';
const shots = process.argv[3] ?? '/tmp/dc-indexing-shots';
mkdirSync(shots, { recursive: true });

const boot = (await fetch(`${hub}/api/bootstrap`).then((r) => r.json())) as any;
if (!boot.accounts.every((a: any) => a.demo)) throw new Error('not a demo hub');
const dither = boot.spaces.find((s: any) => s.name === 'libdither' && s.kind === 'community');
const general = boot.conversations.find((c: any) => c.network === 'discord' && c.name === 'general');
const folder = boot.folders.find((f: any) => f.items.some((i: any) => i.id === dither?.id));
if (!dither || !general || !folder) throw new Error('the demo world lacks libdither, its #general or its folder');

let failures = 0;
const check = (ok: unknown, what: string, detail?: unknown) => {
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${what}${detail !== undefined ? `  ${JSON.stringify(detail)}` : ''}`);
  if (!ok) failures++;
};

const b = await launch();
const p: Page = b.page;
const text = (sel: string) => p.eval<string>(`document.querySelector(${JSON.stringify(sel)})?.textContent ?? ''`);
const count = (sel: string) => p.eval<number>(`document.querySelectorAll(${JSON.stringify(sel)}).length`);
const menuItems = () => p.eval<string[]>(`[...document.querySelectorAll('[role="menuitem"]')].map((b) => b.textContent.trim())`);
const contextMenu = (sel: string) => p.eval(`document.querySelector(${JSON.stringify(sel)}).dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, clientX: 300, clientY: 30 }))`);

try {
  await p.size(1280, 860);
  await p.send('Emulation.setTimezoneOverride', { timezoneId: 'Etc/UTC' });
  await p.goto(`${hub}/#/inbox`);
  await p.until(`!!document.querySelector('.sidebar')`, 15000);

  // The loader, held long enough to see: the hub's own search answers slowly here.
  await p.eval(`(() => {
    const real = window.fetch;
    window.fetch = (u, o) => String(u).startsWith('/api/search?') ? new Promise((r) => setTimeout(r, 1500)).then(() => real(u, o)) : real(u, o);
    location.hash = '#/search?q=' + encodeURIComponent('borrow checker');
  })()`);
  await p.until(`!!document.querySelector('.search-results .loading .dither-orb')`, 5000).catch(() => {});
  check((await count('.search-results .loading .dither-orb')) > 0 && (await text('.search-results .loading')).includes('Searching'), 'a search shows the orb while it waits');
  await Bun.sleep(700);
  await p.shot(join(shots, 'loading-search.png'));
  check((await count('.skeleton, .spinner')) === 0, 'no skeleton or spinner anywhere');

  await p.until(`!!document.querySelector('.net-search-go') && !document.querySelector('.search-results > .loading')`, 10000);
  const local = await count('.search-hit');
  const go = await text('.net-search-go');
  check(/Search Discord and Matrix too/.test(go), 'it offers the networks your accounts can search, by name', go);
  // A fresh demo hub has none of the archive: few hits of its own, so the offer comes first, not only at the end.
  check(local >= 5 || (await count('.net-search.offer .btn.primary')) === 1, 'few hits of its own make the offer prominent', local);
  check((await count('.ns-place')) === 0, 'and does not ask them by itself');

  await p.eval(`document.querySelector('.net-search-go').click()`);
  await p.until(`document.querySelectorAll('.ns-place').length > 0 || /Choosing/.test(document.querySelector('.net-search').textContent)`, 8000);
  await p.shot(join(shots, 'net-search-asking.png'));
  await p.until(`document.querySelectorAll('.ns-place').length > 0 && !document.querySelector('.ns-place.queued, .ns-place.searching') && document.querySelectorAll('.net-search .search-hit').length > 0`, 90000);
  const places = await p.eval<string[]>(`[...document.querySelectorAll('.ns-place')].map((x) => x.textContent)`);
  check(places.length >= 2 && places.every((x) => /\d+ found, \d+ new|Failed/.test(x)), 'each place asked says what it found', places);
  check(/Ordered by (jev|keywords|your own messages)/.test(await text('.net-search-head')), 'and how they were put in order', await text('.net-search-head'));
  const netHits = await p.eval<string[]>(`[...document.querySelectorAll('.net-search .search-hit .search-hit-body')].map((x) => x.textContent)`);
  check(netHits.some((h) => /borrow checker is complaining about a lifetime again/.test(h)), 'the archive messages it found show as hits', netHits.slice(0, 3));
  check((await count('.search-hit')) === local + netHits.length, 'below the hub’s own, which stay as they were');
  const ids = await p.eval<string[]>(`[...document.querySelectorAll('.search-hit-main')].map((x) => x.closest('.search-block').textContent)`);
  check(new Set(ids).size === ids.length, 'with no hit shown twice');
  const more = await text('.net-search .search-more');
  check(/Search \d+ more places?/.test(more), 'more places are offered', more);
  await p.shot(join(shots, 'net-search-done.png'));

  const before = await count('.ns-place');
  await p.eval(`document.querySelector('.net-search .search-more').click()`);
  await p.until(`document.querySelectorAll('.ns-place').length > ${before}`, 10000).catch(() => {});
  check((await count('.ns-place')) > before, 'and asked on a click', { before, after: await count('.ns-place') });
  await p.until(`!document.querySelector('.ns-place.queued, .ns-place.searching')`, 90000).catch(() => {});

  await p.eval(`document.querySelector('.net-search .search-hit').click()`);
  await p.until(`/[?&]m=/.test(location.hash)`, 5000).catch(() => {});
  check(/[?&]m=/.test(await p.eval<string>(`location.hash`)), 'a hit opens its message', await p.eval<string>(`location.hash`));

  // A new query starts over, without the last one's network answers.
  await p.goto(`${hub}/#/search?q=${encodeURIComponent('hackathon')}`);
  await p.until(`!!document.querySelector('.net-search-go')`, 10000);
  check((await count('.ns-place')) === 0, 'a new query asks nothing until asked');

  // A job from libdither's About page.
  await p.goto(`${hub}/#/about/s/${dither.id}`);
  await p.until(`!!document.querySelector('[data-action="index"]')`, 10000);
  await p.eval(`document.querySelector('[data-action="index"]').click()`);
  await p.until(`!!document.querySelector('.index-dialog')`, 4000);
  const boxes = await p.eval<{ checked: boolean; disabled: boolean }[]>(`[...document.querySelectorAll('.index-dialog input[type=checkbox]')].map((i) => ({ checked: i.checked, disabled: i.disabled }))`);
  check(boxes.length === 2 && boxes[0].checked && !boxes[1].checked && !boxes[1].disabled, 'history is ticked, members may be', boxes);
  check((await text('.index-dialog')).includes('Repeats fetch only what is new'), 'it says what it costs');
  await p.eval(`document.querySelectorAll('.index-dialog input[type=checkbox]')[1].click()`);
  await p.shot(join(shots, 'index-dialog.png'));
  await p.eval(`[...document.querySelectorAll('.index-dialog .btn.primary')].find((x) => /Start/.test(x.textContent)).click()`);
  await p.until(`[...document.querySelectorAll('.toast')].some((t) => t.textContent.includes('Indexing libdither'))`, 5000).catch(() => {});
  check(await p.eval(`[...document.querySelectorAll('.toast')].some((t) => t.textContent.includes('Indexing libdither'))`), 'starting says so');
  await p.eval(`[...document.querySelectorAll('.toast')].find((t) => t.textContent.includes('Indexing libdither')).click()`);
  await p.until(`location.hash.startsWith('#/settings') && !!document.querySelector('#set-indexing .job')`, 8000);
  check((await text('#set-indexing .job')).includes('libdither'), 'the toast goes to Settings → Indexing, with the job');
  await p.until(`!!document.querySelector('#set-indexing .job.running')`, 20000).catch(() => {});
  await p.eval(`document.getElementById('set-indexing').scrollIntoView({ block: 'start' })`);
  await p.shot(join(shots, 'indexing-running.png'));
  await p.until(`!!document.querySelector('#set-indexing .job.done')`, 240000);
  const line = await p.eval<string>(`[...document.querySelectorAll('#set-indexing .job.done .job-line')].map((x) => x.textContent).join(' | ')`);
  check(/[1-9][\d,]* messages fetched in \d+ pages/.test(line) && /members? listed/.test(line), 'it runs to done and says what it fetched', line);
  check((await count('#set-indexing .job.done .job-buttons .btn')) >= 2 && /Run now/.test(await text('#set-indexing .job.done .job-buttons')), 'a done job may run again');
  await p.eval(`document.getElementById('set-indexing').scrollIntoView({ block: 'start' })`);
  await p.shot(join(shots, 'indexing-done.png'));

  // Repeat and priority change the job on the hub.
  await p.eval(`(() => { const s = document.querySelector('#set-indexing .job .job-field select'); s.value = '168'; s.dispatchEvent(new Event('change', { bubbles: true })); })()`);
  await Bun.sleep(600);
  const jobs = (await fetch(`${hub}/api/jobs`).then((r) => r.json())) as any;
  check(jobs.jobs.some((j: any) => j.target.id === dither.id && j.repeatHours === 168), 'Weekly repeats it weekly', jobs.jobs.map((j: any) => j.repeatHours));

  // The folder's menu and the channel's offer it too; a channel has no member list of its own.
  await p.goto(`${hub}/#/f/${folder.id}`);
  await p.until(`!!document.querySelector('.folder-head')`, 8000);
  await contextMenu('.folder-head');
  await p.until(`document.querySelectorAll('[role="menuitem"]').length > 0`, 4000);
  check((await menuItems()).some((x) => x.includes('Index Servers in This Folder')), 'a folder’s menu offers indexing its servers', await menuItems());
  await p.eval(`document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))`);
  await Bun.sleep(200);
  await p.goto(`${hub}/#/c/${general.id}`);
  await p.until(`!!document.querySelector('.conv-head')`, 8000);
  await contextMenu('.conv-head');
  await p.until(`[...document.querySelectorAll('[role="menuitem"]')].some((b) => b.textContent.includes('Index This Channel'))`, 4000).catch(() => {});
  check((await menuItems()).some((x) => x.includes('Index This Channel')), 'a channel’s menu offers indexing it', await menuItems());
  await p.eval(`[...document.querySelectorAll('[role="menuitem"]')].find((b) => b.textContent.includes('Index This Channel')).click()`);
  await p.until(`!!document.querySelector('.index-dialog')`, 4000);
  const chan = await p.eval<boolean[]>(`[...document.querySelectorAll('.index-dialog input[type=checkbox]')].map((i) => i.disabled)`);
  check(chan[1] === true && (await text('.index-dialog')).includes('no member list'), 'members are off for one channel, with why', chan);
  await p.shot(join(shots, 'index-dialog-channel.png'));

  // On a phone.
  await p.size(390, 844, true);
  await p.goto(`${hub}/#/search?q=${encodeURIComponent('borrow checker')}`);
  await p.until(`!!document.querySelector('.net-search-go')`, 10000);
  await p.eval(`document.querySelector('.net-search-go').click()`);
  await p.until(`document.querySelectorAll('.ns-place').length > 0 && !document.querySelector('.ns-place.queued, .ns-place.searching')`, 90000).catch(() => {});
  await p.eval(`document.querySelector('.net-search').scrollIntoView({ block: 'start' })`);
  check((await p.eval<number>(`document.documentElement.scrollWidth`)) <= 390, 'on a phone nothing runs off the side');
  await p.shot(join(shots, 'phone-net-search.png'));
  await p.goto(`${hub}/#/settings`);
  await p.until(`!!document.querySelector('#set-indexing .job')`, 10000);
  await p.eval(`document.getElementById('set-indexing').scrollIntoView({ block: 'start' })`);
  await Bun.sleep(300);
  await p.shot(join(shots, 'phone-indexing.png'));
  check(!p.errors.length, 'no page errors', p.errors);
} finally {
  await b.close();
}
console.log(failures ? `${failures} failed` : 'all passed');
process.exit(failures ? 1 : 0);
