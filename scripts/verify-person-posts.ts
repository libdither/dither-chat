/**
 * A person's Posts tab (docs/places.md "A person's networks"), end to end against a plain demo hub in headless
 * Chromium, with real input: Theo, one person on Signal, Discord and X, chatted with on Signal, has a row of
 * All · Signal · Posts, Posts last with X's glyph; pressed, the body is their posts as GET /api/persons/:id/posts gives them, newest first,
 * every row theirs, no message box under it and the head still there; scrolling down loads the older pages; a post
 * opens its thread on top, and the browser's Back and Escape each return to the Posts tab, still chosen, the same
 * rows, scrolled where it was; Ctrl+Shift+] and [ reach the tab from the message box and leave it; someone with no
 * account on a network of posts (Sam Rivera, Alice Chen, whose X account is someone else so far) has no such tab;
 * and on the All tab what Theo wrote to you in
 * public is one short row at its time, whose "Answer there" opens the post. A phone of 390 too, and no page errors.
 *
 *   bun packages/hub/src/main.ts --demo --data <fresh dir> --port <port> --web packages/web/dist
 *   bun scripts/verify-person-posts.ts http://127.0.0.1:<port> [/tmp/shots]
 *
 * Pictures, with a folder: person-posts, person-all, person-post-open, and each with phone- before it.
 */
import { mkdirSync } from 'node:fs';
import { launch } from './browser.ts';

const hub = process.argv[2] ?? 'http://127.0.0.1:8577';
const shots = process.argv[3];
if (shots) mkdirSync(shots, { recursive: true });

const get = (path: string) => fetch(`${hub}${path}`).then((r) => r.json()) as Promise<any>;
const boot = await get('/api/bootstrap');
if (!boot.accounts.every((a: any) => a.demo)) throw new Error('not a demo hub');
const byName = (name: string) => boot.persons.find((q: any) => q.name === name);
const theo = byName('Theo');
const sam = byName('Sam Rivera');
const alice = byName('Alice Chen');
if (!theo || !sam || !alice) throw new Error('the demo world lacks Theo, Sam Rivera or Alice Chen');
const nets = (p: any) => p.identityIds.map((id: string) => boot.identities.find((i: any) => i.id === id)?.network);
if (!nets(theo).includes('x')) throw new Error("Theo's X account is not theirs: demo.ts applyDemoOverlay joins it");

/** Every post of Theo's the hub has, page by page as the tab asks for them. */
const all: any[] = [];
for (let before: string | null = null, n = 0; n < 20; n++) {
  const v: any = await get(`/api/persons/${theo.id}/posts?limit=20${before ? `&before=${encodeURIComponent(before)}` : ''}`);
  all.push(...v.posts);
  before = v.before;
  if (!before) break;
}
if (all.length <= 20) throw new Error(`Theo has ${all.length} posts logged: the demo should log more than a page`);

let failures = 0;
const check = (ok: unknown, what: string, detail: unknown = '') => {
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${what}${detail !== '' ? `  ${JSON.stringify(detail)}` : ''}`);
  if (!ok) failures++;
};

const { page: p, close } = await launch();
const shot = async (name: string) => shots && (await p.shot(`${shots}/${name}.png`));
/**
 * Where to press `sel`: its middle, once it is wholly on screen and nothing covers it there (a notice coming in, a
 * toast). A press on whatever covered it would be a press on something else.
 */
const at = async (sel: string, pick = '') => {
  const uncovered = `(() => { const e = [...document.querySelectorAll(${JSON.stringify(sel)})].find((x) => { const b = x.getBoundingClientRect(); return b.width > 0 && b.top >= 0 && b.bottom <= innerHeight && b.left >= 0 && b.right <= innerWidth && x.innerText.includes(${JSON.stringify(pick)}); }); if (!e) return false; const b = e.getBoundingClientRect(); return e.contains(document.elementFromPoint(b.x + Math.min(b.width / 2, 40), b.y + Math.min(b.height / 2, 30))); })()`;
  await p.until(uncovered, 8000).catch(() => {
    throw new Error(`${sel} ${pick}: not on screen, or something covers it`);
  });
  const r = await p.eval<{ x: number; y: number } | null>(
    `(() => { const e = [...document.querySelectorAll(${JSON.stringify(sel)})].find((x) => { const b = x.getBoundingClientRect(); return b.width > 0 && b.top >= 0 && b.bottom <= innerHeight && b.left >= 0 && b.right <= innerWidth && x.innerText.includes(${JSON.stringify(pick)}); }); if (!e) return null; const b = e.getBoundingClientRect(); return { x: b.x + Math.min(b.width / 2, 40), y: b.y + Math.min(b.height / 2, 30) }; })()`,
  );
  if (!r) throw new Error(`nothing on screen matches ${sel} ${pick}`);
  return r;
};
const mouse = (type: string, x: number, y: number, buttons = 1) => p.send('Input.dispatchMouseEvent', { type, x, y, button: 'left', buttons, clickCount: 1 });
const click = async (sel: string, pick = '') => {
  const r = await at(sel, pick);
  await mouse('mousePressed', r.x, r.y);
  await mouse('mouseReleased', r.x, r.y, 0);
};
const tap = async (sel: string, pick = '') => {
  const r = await at(sel, pick);
  await p.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x: r.x, y: r.y }] });
  await p.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
};
const key = async (k: string, code: string, vk: number, modifiers = 0) => {
  await p.send('Input.dispatchKeyEvent', { type: 'rawKeyDown', key: k, code, modifiers, windowsVirtualKeyCode: vk });
  await p.send('Input.dispatchKeyEvent', { type: 'keyUp', key: k, code, modifiers, windowsVirtualKeyCode: vk });
};
/** Ctrl+Shift with a bracket, by its physical key, as a real keyboard sends it. */
const chord = (dir: 1 | -1) => (dir === 1 ? key('}', 'BracketRight', 221, 10) : key('{', 'BracketLeft', 219, 10));
/** A turn of the wheel over `sel`, and its scroll finished: a tap while a page still scrolls only stops it. */
const wheel = async (sel: string, dy: number) => {
  const r = await at(sel);
  await p.eval(`(() => { const e = document.querySelector(${JSON.stringify(sel)}); window.__scrolled = false; e.addEventListener('scrollend', () => (window.__scrolled = true), { once: true }); })()`);
  await p.send('Input.dispatchMouseEvent', { type: 'mouseWheel', x: r.x, y: r.y, deltaX: 0, deltaY: dy });
  await p.until('window.__scrolled === true', 8000);
};

const tabs = () => p.eval<{ id: string; label: string; on: boolean; glyph: boolean }[]>(`[...document.querySelectorAll('.pane .person-tabs [role=tab]')].filter((t) => { const b = t.closest('.pane').getBoundingClientRect(); return b.width > 0 && b.left > -1 && b.left < innerWidth; }).map((t) => ({ id: t.dataset.tab, label: t.innerText.trim(), on: t.getAttribute('aria-selected') === 'true', glyph: !!t.querySelector('svg') }))`);
const chosen = async () => (await tabs()).find((t) => t.on)?.id ?? null;
const rows = () => p.eval<string[]>(`[...document.querySelectorAll('[data-person-posts] [data-person-post]')].map((e) => e.dataset.personPost)`);
const scrollTop = () => p.eval<number>(`document.querySelector('[data-person-posts]')?.scrollTop ?? -1`);
const authors = () => p.eval<string[]>(`[...document.querySelectorAll('[data-person-posts] .thread-chain > .thread-post .thread-head .post-who b')].map((b) => b.textContent)`);
const composer = () => p.eval<boolean>(`[...document.querySelectorAll('.pane .composer')].some((c) => c.getBoundingClientRect().width > 0)`);
const hash = () => p.eval<string>('location.hash');
/** The person's page in place, its left edge at the window's or the list's, and no post's page on screen (a phone slides between them). */
const home = () =>
  p.until(
    `(() => { const t = document.querySelector('.pane .person-tabs [role=tab]'); if (!t) return false; const pane = t.closest('.pane').getBoundingClientRect(); const posts = [...document.querySelectorAll('.pane [data-focal]')].some((f) => { const b = f.closest('.pane').getBoundingClientRect(); return b.right > 1 && b.left < innerWidth - 1; }); return !posts && pane.right <= innerWidth + 0.5 && document.getAnimations().every((a) => !(a instanceof CSSTransition) || a.playState !== 'running'); })()`,
    8000,
  );
const ids = all.map((v) => v.post.id);

const open = async (hashTo: string) => {
  await p.goto(`${hub}/${hashTo}`);
  await p.until(`!!document.querySelector('.pane .person-tabs [role=tab]')`, 20000);
};

/** One pass, on the page's size: the computer's or the phone's. */
async function pass(phone: boolean) {
  const name = (n: string) => (phone ? `phone-${n}` : n);
  const press = phone ? tap : click;
  await open(`#/people/${theo.id}`);
  const t0 = await tabs();
  check(t0.map((t) => t.id).join() === 'all,net:signal,posts', `${name('row')}: All, Signal, then Posts last`, t0.map((t) => t.id));
  const pt = t0.find((t) => t.id === 'posts');
  check(pt?.label === 'Posts' && pt.glyph && !pt.on, "the Posts tab says Posts after X's glyph (Theo posts on X alone)", pt);

  // All: what Theo wrote to you in public, one short row at its time.
  const toYou = all.filter((v) => v.toYou);
  await p.until(`!!document.querySelector('.pane [data-public-row]')`, 15000);
  const pub = await p.eval<{ id: string; text: string }[]>(`[...document.querySelectorAll('.pane [data-public-row]')].map((e) => ({ id: e.dataset.publicRow, text: e.innerText.replace(/\\s+/g, ' ').trim() }))`);
  check(pub.length === toYou.length && pub.every((r) => toYou.some((v) => v.post.id === r.id)), `${name('All')}: a row for each post of theirs written to you`, pub);
  const q = pub.find((r) => /Any chance the simulator runs/.test(r.text));
  check(!!q && /^Theo replied to your post on X · /.test(q.text) && /Answer there$/.test(q.text), 'the row: "replied to your post on X", the first words, Answer there', q);
  await shot(name('person-all'));
  await press(`.pane [data-public-row="${pub[0]?.id}"] button`, 'Answer there');
  await p.until(`location.hash.includes('pst_x_')`, 8000);
  check((await hash()).endsWith(`pst_x_${pub[0]?.id}`), 'Answer there opens that post', await hash());
  await p.eval('history.back()');
  await home();
  check((await chosen()) === 'all', 'and Back comes to All again', await chosen());

  // The Posts tab.
  await press('.pane .person-tabs [role=tab][data-tab="posts"]');
  await p.until(`document.querySelectorAll('[data-person-posts] [data-person-post]').length > 0`, 15000);
  check((await chosen()) === 'posts', `${name('Posts')}: the tab is chosen`, await chosen());
  const first = await rows();
  check(first.join() === ids.slice(0, first.length).join() && first.length >= 1, 'the rows are their posts, newest first, as the hub lists them', { first: first.slice(0, 5), want: ids.slice(0, 5) });
  check((await authors()).every((a) => a === 'Theo'), 'every row is theirs', [...new Set(await authors())]);
  check(!(await composer()), 'no message box on the Posts tab');
  check(await p.eval<boolean>(`!!document.querySelector('.pane .conv-head')`), 'the head stays');
  check(!(await p.eval<boolean>(`[...document.querySelectorAll('.pane .conv-head .pair-only')].some((e) => e.getBoundingClientRect().width > 0)`)), 'and its line says no "only this": their posts are no one route');
  const mark = (id: string) => p.eval<string>(`document.querySelector('[data-person-posts] [data-person-post="${id}"] .pp-to-you')?.textContent ?? ''`);
  const shown = ids.slice(0, first.length);
  const marks = await Promise.all(shown.map(mark));
  const says: Record<string, string> = { reply: 'Replied to your post', mention: 'Mentioned you', quote: 'Quoted your post' };
  const want = shown.map((id) => says[all.find((v) => v.post.id === id)?.toYou ?? ''] ?? '');
  check(marks.join('|') === want.join('|') && want.some(Boolean), 'their replies to you say so over them, and no other row does', marks);
  await shot(name('person-posts'));

  // Older pages as it scrolls: down to the end, then everything is there once.
  for (let i = 0; i < 40 && (await rows()).length < ids.length; i++) {
    const n = (await rows()).length;
    await wheel('[data-person-posts]', 2000);
    await p.until(`document.querySelectorAll('[data-person-posts] [data-person-post]').length > ${n} || (() => { const e = document.querySelector('[data-person-posts]'); return e.scrollTop + e.clientHeight >= e.scrollHeight - 2; })()`, 8000);
  }
  await p.until(`document.querySelectorAll('[data-person-posts] [data-person-post]').length >= ${ids.length}`, 8000).catch(() => {});
  const everything = await rows();
  check(everything.join() === ids.join(), 'scrolling down loads the older pages: every post once, in order', { got: everything.length, want: ids.length });

  // Up a little, then a post on screen opened, and back two ways.
  await wheel('[data-person-posts]', -900);
  await p.until(`document.querySelector('[data-person-posts]').scrollTop < document.querySelector('[data-person-posts]').scrollHeight - document.querySelector('[data-person-posts]').clientHeight - 400`, 4000);
  const before = await scrollTop();
  const target = await p.eval<string>(`[...document.querySelectorAll('[data-person-posts] [data-person-post]')].find((e) => { const b = e.getBoundingClientRect(); return b.top > 120 && b.bottom < innerHeight - 40; })?.dataset.personPost ?? ''`);
  for (const how of ['Back', 'Escape'] as const) {
    await press(`[data-person-posts] [data-person-post="${target}"] .post-text`);
    await p.until(`location.hash.includes('pst_x_${target}')`, 8000);
    await p.until(`!!document.querySelector('.pane [data-focal]')`, 15000);
    check((await p.eval<string>(`document.querySelector('.pane [data-focal]')?.closest('[data-post]')?.dataset.post ?? document.querySelector('.pane [data-focal]')?.dataset.post ?? ''`)) === target, `a post opens its thread (${how} next)`, target);
    if (how === 'Back') await shot(name('person-post-open'));
    if (how === 'Back') await p.eval('history.back()');
    else await key('Escape', 'Escape', 27);
    await home();
    await p.until(`document.querySelectorAll('[data-person-posts] [data-person-post]').length > 0`, 8000);
    const back = await scrollTop();
    check((await chosen()) === 'posts' && (await rows()).join() === everything.join() && Math.abs(back - before) <= 2, `${how} returns to the Posts tab, the same rows, scrolled where it was`, { tab: await chosen(), rows: (await rows()).length, before, back });
  }

  if (!phone) {
    // The keys: from the message box on Signal, ] reaches Posts; from Posts, [ goes back to Signal.
    await click('.pane .person-tabs [role=tab][data-tab="net:signal"]');
    await p.until(`document.querySelector('.pane .person-tabs [data-tab="net:signal"]')?.getAttribute('aria-selected') === 'true' && !!document.querySelector('.pane .composer [contenteditable], .pane .composer textarea')`, 8000);
    await click('.pane .composer [contenteditable], .pane .composer textarea');
    await chord(1);
    await p.until(`document.querySelector('.pane .person-tabs [data-tab="posts"]')?.getAttribute('aria-selected') === 'true'`, 4000).catch(() => {});
    check((await chosen()) === 'posts', 'Ctrl+Shift+] from the message box on Signal: Posts', await chosen());
    await chord(-1);
    await p.until(`document.querySelector('.pane .person-tabs [data-tab="net:signal"]')?.getAttribute('aria-selected') === 'true'`, 4000).catch(() => {});
    check((await chosen()) === 'net:signal', 'Ctrl+Shift+[ from Posts: Signal again', await chosen());
    await chord(1);
    await p.until(`document.querySelector('.pane .person-tabs [data-tab="posts"]')?.getAttribute('aria-selected') === 'true'`, 4000).catch(() => {});
    await chord(1);
    await p.until(`document.querySelector('.pane .person-tabs [data-tab="all"]')?.getAttribute('aria-selected') === 'true'`, 4000).catch(() => {});
    check((await chosen()) === 'all', 'and ] past Posts wraps round to All', await chosen());

    // Nobody else's row has it: Sam Rivera (Signal, Matrix, mail), Alice Chen (five networks and mail; X's Alice is apart).
    for (const who of [sam, alice]) {
      await open(`#/people/${who.id}`);
      const t = await tabs();
      check(t.length > 1 && !t.some((x) => x.id === 'posts'), `${who.name}: no Posts tab`, t.map((x) => x.id));
    }
  }
}

await p.size(1410, 940);
await pass(false);
await p.size(390, 844, true);
await pass(true);

check(!p.errors.length, 'no page errors', p.errors.slice(0, 5));
await close();
console.log(failures ? `\n${failures} failed` : '\nall ok');
process.exit(failures ? 1 : 0);
