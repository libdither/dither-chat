/**
 * Search, end to end against a demo hub in headless Chromium: the box's operator suggestions (people with pictures),
 * picking one by keyboard, results as you type with no Enter, a misspelt search corrected, Jump to (Ctrl+K's matches),
 * top matches above the newest, hits grouped by conversation with context, the tabs and filter chips, recent searches,
 * walking the results with the arrow keys, Ctrl+F in a chat, the inbox box handing over to the search page (fast typing
 * included), and more results loading on scroll.
 *
 *   bun scripts/verify-search.ts http://127.0.0.1:8791 /tmp/dc-search-shots
 * Only reads; still, point it at a demo hub (--demo) with its own data dir.
 */
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { launch, type Page } from './browser.ts';

const hub = process.argv[2] ?? 'http://127.0.0.1:8791';
const shots = process.argv[3] ?? '/tmp/dc-search-shots';
mkdirSync(shots, { recursive: true });

const boot = (await fetch(`${hub}/api/bootstrap`).then((r) => r.json())) as any;
if (!boot.accounts.every((a: any) => a.demo)) throw new Error('not a demo hub');
const dither = boot.spaces.find((s: any) => s.name === 'libdither');
const general = boot.conversations.find((c: any) => c.network === 'discord' && c.name === 'general');

let failures = 0;
const check = (ok: unknown, what: string, detail?: unknown) => {
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${what}${detail !== undefined ? `  ${JSON.stringify(detail)}` : ''}`);
  if (!ok) failures++;
};

const b = await launch();
const p: Page = b.page;
const CODES: Record<string, number> = { ArrowDown: 40, ArrowUp: 38, Escape: 27, Enter: 13, Tab: 9 };
async function key(k: string, modifiers = 0) {
  const code = k.length === 1 ? `Key${k.toUpperCase()}` : k;
  const text = k.length === 1 && !modifiers ? k : k === 'Enter' ? '\r' : undefined;
  await p.send('Input.dispatchKeyEvent', { type: 'keyDown', key: k, code, text, modifiers, windowsVirtualKeyCode: CODES[k] ?? k.toUpperCase().charCodeAt(0) });
  await p.send('Input.dispatchKeyEvent', { type: 'keyUp', key: k, code, modifiers });
  await Bun.sleep(100);
}
const type = async (s: string) => (await p.send('Input.insertText', { text: s }), await Bun.sleep(150));
const box = `.search-pane .search-main input`;
const clearBox = () => p.eval(`(() => { const i = document.querySelector('${box}'); i.focus(); i.select(); })()`).then(() => key('Backspace'));
const rows = () => p.eval<string[]>(`[...document.querySelectorAll('.search-suggest-row')].map((r) => r.querySelector('.search-suggest-label').textContent)`);
const hash = () => p.eval<string>(`decodeURIComponent(location.hash)`);
/** Escape for the box's list only while it is open: with it closed, Escape leaves search (docs/desktop.md "Escape and back"). */
const closeList = async () => void ((await rows()).length && (await key('Escape')));
const recentSearches = () => p.eval<string[]>(`JSON.parse(localStorage.getItem('dc.recentSearches') ?? '[]')`);

try {
  await p.size(1280, 800);
  await p.send('Emulation.setTimezoneOverride', { timezoneId: 'Etc/UTC' });
  await p.goto(`${hub}/#/search`);
  await p.until(`!!document.querySelector('${box}')`, 15000);
  await p.eval(`localStorage.removeItem('dc.recentSearches'); document.querySelector('${box}').focus()`);
  await Bun.sleep(150);
  const ops = await rows();
  check(ops[0] === 'from:' && ops.includes('has:') && ops.includes('in:'), 'an empty box lists the operators', ops);

  await type('fr');
  check((await rows()).join() === 'from:', 'a word suggests the operator it starts', await rows());
  await key('ArrowDown');
  await key('Enter');
  check((await p.eval(`document.querySelector('${box}').value`)) === 'from:', 'Enter takes it');
  const people = await rows();
  check(people.length > 0 && (await p.eval<number>(`document.querySelectorAll('.search-suggest-row .avatar').length`)) === people.length, 'from: lists people with their pictures', people);
  const first = people[0];
  await type(first.slice(0, 3));
  check((await rows())[0] === first, 'typing narrows them');
  await p.shot(join(shots, 'suggest-from.png'));
  await key('Tab');
  const v = await p.eval<string>(`document.querySelector('${box}').value`);
  check(v === `from:${/\s/.test(first) ? `"${first}"` : first} `, 'Tab takes the first, quoted when it has spaces', v);

  await clearBox();
  await type('has:im');
  check((await rows()).join() === 'image', 'has: lists the kinds', await rows());
  await key('Escape');
  check((await rows()).length === 0, 'Escape closes the list');

  // A chat picked from in:'s list becomes the In chip; its id never shows in the box.
  await clearBox();
  await closeList();
  await type('hello in:gener');
  await p.until(`[...document.querySelectorAll('.search-suggest-row')].some((r) => r.textContent.includes('general') && !r.textContent.includes('community'))`, 3000).catch(() => {});
  await p.eval(`[...document.querySelectorAll('.search-suggest-row')].find((r) => r.textContent.includes('general') && !r.textContent.includes('community')).click()`);
  await p.until(`!!document.querySelector('.search-scope')`, 3000).catch(() => {});
  const picked = { box: await p.eval<string>(`document.querySelector('${box}').value`), hash: await hash(), chip: await p.eval<string>(`document.querySelector('.search-scope')?.textContent ?? ''`) };
  const pickedId = picked.hash.match(/in:(cnv_\S+?)(?:&|\s|$)/)?.[1];
  check(picked.box === 'hello ' && !!pickedId && boot.conversations.some((c: any) => c.id === pickedId) && picked.chip.includes('general'), 'a chat picked from in: is the In chip, the box keeps the words', picked);
  await type('world');
  await p.until(`decodeURIComponent(location.hash).includes('hello world')`, 3000).catch(() => {});
  check((await hash()).includes(`in:${pickedId}`) && (await p.eval<string>(`document.querySelector('${box}').value`)) === 'hello world', 'typing on keeps the chip', await hash());
  await p.eval(`document.querySelector('.search-scope button').click()`);
  await p.until(`!document.querySelector('.search-scope')`, 3000).catch(() => {});
  check(!(await hash()).includes('in:'), "the chip's × searches everywhere", await hash());

  await clearBox();
  await closeList();
  await type('hackaton');
  await p.until(`document.querySelectorAll('.search-hit').length > 0`, 8000);
  check((await hash()).includes('q=hackaton'), 'results come as you type, with no Enter', await hash());
  check(!(await recentSearches()).includes('hackaton'), 'a search typed is not yet a recent one');
  // Enter keeps it among the recent searches (so does opening a result).
  await key('Enter');
  const note = await p.eval<string>(`document.querySelector('.search-note')?.textContent ?? ''`);
  check(note.includes('hackathon'), 'a misspelt word is corrected, and says so', note);

  await clearBox();
  await type('the');
  await key('Enter');
  await p.until(`document.querySelectorAll('.search-hit').length > 3`, 8000);
  const top = await p.eval<{ head: boolean; why: number }>(`({ head: [...document.querySelectorAll('.search-sec')].some((h) => h.textContent === 'Top matches'), why: document.querySelectorAll('.search-hit-why').length })`);
  check(top.head, 'the best matches come first, above the newest', top);
  const groups = await p.eval<{ n: number; heads: number; ctx: number }>(`({ n: document.querySelectorAll('.search-group').length, heads: document.querySelectorAll('.search-group-head').length, ctx: document.querySelectorAll('.search-ctx').length })`);
  check(groups.n > 1 && groups.heads === groups.n && groups.ctx > 0, 'hits come grouped by conversation, with lines around them', groups);
  await p.shot(join(shots, 'results.png'));

  // From the box, Down walks into the results; Up from the first goes back.
  await p.eval(`document.querySelector('${box}').focus()`);
  await closeList();
  await key('ArrowDown');
  const at = () => p.eval<number>(`[...document.querySelectorAll('.search-jump-row, .search-hit')].indexOf(document.activeElement)`);
  check((await at()) === 0, 'Down from the box reaches the first result');
  await key('ArrowDown');
  check((await at()) === 1, 'Down again, the second');
  await key('ArrowUp');
  await key('ArrowUp');
  check((await p.eval(`document.activeElement === document.querySelector('${box}')`)) === true, 'Up from the first goes back to the box');

  await p.eval(`document.querySelector('.search-chip-sort .search-chip-main').click()`);
  await p.until(`!!document.querySelector('.search-chip-pop')`, 3000);
  await p.eval(`[...document.querySelectorAll('.search-chip-pop .search-pick-row')].find((b) => b.textContent.trim() === 'Oldest').click()`);
  await p.until(`decodeURIComponent(location.hash).includes('sort:oldest')`, 3000).catch(() => {});
  check((await hash()).includes('sort:oldest'), 'the sort chip sets sort:oldest', await hash());

  // The filter chips: From picks a person as Ctrl+K would find them, and shows them on the chip.
  await p.eval(`[...document.querySelectorAll('.search-chip-main')].find((b) => b.textContent.trim().startsWith('From')).click()`);
  await p.until(`!!document.querySelector('.search-chip-pop .search-pick-row')`, 3000);
  await p.shot(join(shots, 'chip-from.png'));
  await p.eval(`document.querySelector('.search-chip-pop .search-pick-row').click()`);
  await p.until(`decodeURIComponent(location.hash).includes('from:')`, 3000).catch(() => {});
  check((await hash()).includes('from:') && (await p.eval<string>(`document.querySelector('.search-chip.on')?.textContent ?? ''`)).startsWith('From:'), 'the From chip sets from: and shows who', await hash());
  await p.eval(`document.querySelector('.search-chip.on .search-chip-x').click()`);
  await p.until(`!decodeURIComponent(location.hash).includes('from:')`, 3000).catch(() => {});
  check(!(await hash()).includes('from:'), 'its × clears it', await hash());

  // Jump to: Ctrl+K's matches, from the first letter, before the hub answers.
  await clearBox();
  await type('lib');
  await p.until(`document.querySelectorAll('.search-jump-row').length > 0`, 3000).catch(() => {});
  const jumps = await p.eval<string[]>(`[...document.querySelectorAll('.search-jump-row .search-jump-label')].map((r) => r.textContent)`);
  check(jumps.some((j) => j.toLowerCase().includes('libdither')), 'Jump to lists places Ctrl+K would', jumps);
  await p.shot(join(shots, 'jump-to.png'));
  await p.eval(`[...document.querySelectorAll('.search-tabs button')].find((b) => b.textContent === 'Chats').click()`);
  await Bun.sleep(200);
  check((await p.eval<number>(`document.querySelectorAll('.search-hit').length`)) === 0 && (await p.eval<number>(`document.querySelectorAll('.search-jump-row').length`)) > 0, 'the Chats tab shows places, not messages');
  await p.eval(`[...document.querySelectorAll('.search-tabs button')].find((b) => b.textContent === 'All').click()`);

  await p.goto(`${hub}/#/search`);
  await p.until(`!!document.querySelector('${box}')`, 8000);
  await p.eval(`document.querySelector('${box}').focus()`);
  await Bun.sleep(150);
  const recent = await rows();
  check(recent[0]?.startsWith('the') && recent.includes('hackaton'), 'recent searches come first in an empty box', recent);
  await p.shot(join(shots, 'recent.png'));
  check((await p.eval<number>(`document.querySelectorAll('.search-recent .search-place').length`)) >= 2, 'and on the empty search page');

  // Ctrl+F in a chat searches that chat.
  await p.goto(`${hub}/#/s/${dither.id}/c/${general.id}`);
  await p.until(`document.querySelectorAll('.msg-body').length > 2`, 15000);
  await p.eval(`document.activeElement?.blur()`);
  await key('f', 2);
  await p.until(`!!document.querySelector('.search-scope')`, 5000).catch(() => {});
  check((await hash()).includes(`in:${general.id}`) && (await p.eval<string>(`document.querySelector('.search-scope')?.textContent ?? ''`)).includes('general'), 'Ctrl+F in a chat searches it', await hash());
  await key('f', 2);
  check((await p.eval(`document.activeElement === document.querySelector('${box}')`)) === true, 'Ctrl+F again goes to the box');
  // The list must sit on top of what is below it, not be clipped by it.
  // Every row, so the ones under a toast (a demo message arriving, above everything for a moment) do not decide it.
  const onTop = () => p.eval<boolean>(`(() => { const rs = [...document.querySelectorAll('.search-suggest-row')]; const at = (r) => { const b = r.getBoundingClientRect(); return document.elementFromPoint(b.left + 30, b.top + b.height / 2); }; return rs.length > 0 && rs.every((r) => { const e = at(r); return !!e && (r.contains(e) || !!e.closest('.toasts')); }) && rs.some((r) => r.contains(at(r))); })()`);
  await p.goto(`${hub}/#/`);
  await p.until(`!!document.querySelector('.sidebar .search-box input')`, 8000);
  await p.eval(`document.querySelector('.sidebar .search-box input').focus()`);
  await type('in:gen');
  await p.until(`document.activeElement === document.querySelector('${box}')`, 3000).catch(() => {});
  check((await p.eval<string>(`document.querySelector('${box}')?.value ?? ''`)) === 'in:gen' && (await p.eval(`document.activeElement === document.querySelector('${box}')`)) === true, 'typing in the inbox box opens search, the cursor and the words carried over', await hash());
  await p.until(`document.querySelectorAll('.search-suggest-row').length > 0`, 3000).catch(() => {});
  check((await rows()).some((r) => r.includes('general')) && (await onTop()), 'its suggestions follow, on top of the list below', await rows());
  await p.shot(join(shots, 'sidebar-suggest.png'));

  // Fast typing: key after key with no wait, so some land in the inbox box before the search page's box has the cursor.
  // Each of them must reach the page, in order.
  const fast = async () => {
    await p.goto(`${hub}/#/`);
    await p.until(`!!document.querySelector('.sidebar .search-box input')`, 8000);
    await p.eval(`document.querySelector('.sidebar .search-box input').focus()`);
    for (const c of 'searching') {
      await p.send('Input.dispatchKeyEvent', { type: 'keyDown', key: c, code: `Key${c.toUpperCase()}`, text: c, windowsVirtualKeyCode: c.toUpperCase().charCodeAt(0) });
      await p.send('Input.dispatchKeyEvent', { type: 'keyUp', key: c, code: `Key${c.toUpperCase()}` });
    }
    // The query goes into the address a moment after the last key (TYPE_PAUSE_MS): wait for that too.
    await p.until(`document.activeElement === document.querySelector('${box}') && document.querySelector('${box}').value.length >= 9 && new URLSearchParams(location.hash.split('?')[1]).get('q')?.length >= 9`, 5000).catch(() => {});
    return p.eval<{ box: string; inbox: string; q: string }>(`({ box: document.querySelector('${box}')?.value, inbox: document.querySelector('.sidebar .search-box input').value, q: new URLSearchParams(location.hash.split('?')[1]).get('q') })`);
  };
  const typed = [await fast(), await fast()];
  check(typed.every((t) => t.box === 'searching' && t.q === 'searching' && t.inbox === ''), 'fast typing in the inbox box loses no letter, and the inbox box lets go of it', typed);

  // The inbox box's words fit it: a key hint where there is room, "…" where there is not, never cut mid-letter.
  await p.goto(`${hub}/#/`);
  await p.until(`!!document.querySelector('.sidebar .search-box input')`, 8000);
  const fits = () => p.eval<{ hint: boolean; ellipsis: boolean; overlap: boolean }>(`(() => { const f = document.querySelector('.sidebar .search-box'); const i = f.querySelector('input'); const k = f.querySelector('.search-hint'); const shown = !!k && getComputedStyle(k).display !== 'none'; const ib = i.getBoundingClientRect(), kb = k?.getBoundingClientRect(); return { hint: shown, ellipsis: getComputedStyle(i).textOverflow === 'ellipsis', overlap: shown && ib.right > kb.left + 0.5 }; })()`);
  const wide = await fits();
  await p.eval(`document.querySelector('.sidebar .inbox-search').style.width = '190px'`);
  const narrow = await fits();
  check(wide.hint && !wide.overlap && wide.ellipsis && !narrow.hint && narrow.ellipsis, 'the inbox box shows Ctrl K when it has room and ends in "…" when it has not', { wide, narrow });
  await p.shot(join(shots, 'sidebar-narrow.png'));

  // More results load as the list nears its end, no tap needed.
  await p.goto(`${hub}/#/search?q=the`);
  await p.until(`document.querySelectorAll('.search-hit').length > 0 && !!document.querySelector('.search-more')`, 10000);
  const before = await p.eval<number>(`document.querySelectorAll('.search-hit').length`);
  await p.eval(`(() => { const l = document.querySelector('.search-results'); l.scrollTop = l.scrollHeight; })()`);
  await p.until(`document.querySelectorAll('.search-hit').length > ${before}`, 8000).catch(() => {});
  const after = await p.eval<number>(`document.querySelectorAll('.search-hit').length`);
  check(after > before, 'scrolling to the end loads more results', { before, after });

  await p.size(390, 844, true);
  // On a phone the inbox box opens the search page at the tap.
  await p.goto(`${hub}/#/`);
  await p.until(`!!document.querySelector('.sidebar .search-box input')`, 8000);
  await p.eval(`document.querySelector('.sidebar .search-box input').focus()`);
  await p.until(`document.activeElement === document.querySelector('${box}')`, 3000).catch(() => {});
  check((await hash()).includes('search') && (await p.eval(`document.activeElement === document.querySelector('${box}')`)) === true, 'on a phone a tap on the inbox box opens search, ready to type', await hash());
  await type('lib');
  await p.until(`document.querySelectorAll('.search-jump-row').length > 0 && document.querySelectorAll('.search-hit').length > 0`, 5000).catch(() => {});
  await key('Escape');
  await p.shot(join(shots, 'phone-results.png'));
  await p.goto(`${hub}/#/search`);
  await p.until(`!!document.querySelector('${box}')`, 8000);
  await p.eval(`document.querySelector('${box}').focus()`);
  await type('from:');
  check((await rows()).length > 0 && (await onTop()), 'on a phone the list shows over the filters', await rows());
  await p.shot(join(shots, 'phone-suggest.png'));
  check(!p.errors.length, 'no page errors', p.errors);
} finally {
  await b.close();
}
console.log(failures ? `${failures} failed` : 'all passed');
process.exit(failures ? 1 : 0);
