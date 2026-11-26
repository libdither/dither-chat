/**
 * Search, end to end against a demo hub in headless Chromium: the box's operator suggestions (people with pictures),
 * picking one by keyboard, results as you type with no Enter, a misspelt search corrected on Enter, Jump to (Ctrl+K's matches),
 * top matches above the newest, hits grouped by conversation with context, the tabs and filter chips, recent searches,
 * walking the results with the arrow keys, Ctrl+F in a chat, the inbox box narrowing the inbox in place (fast typing,
 * the newest messages, Full results, a phone), and more results loading on scroll.
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
  await type('hackath');
  await p.until(`document.querySelectorAll('.search-hit').length > 0`, 8000);
  check((await hash()).includes('q=hackath'), 'results come as you type, with no Enter', await hash());
  check(!(await recentSearches()).includes('hackath'), 'a search typed is not yet a recent one');
  await clearBox();
  await closeList();
  // As you type (typing=1) a word the index lacks finds nothing yet: corrections and inside words wait for Enter.
  await type('hackaton');
  await p.until(`location.hash.includes('q=hackaton') && !!document.querySelector('.search-results .empty')`, 8000).catch(() => {});
  check((await p.eval<number>(`document.querySelectorAll('.search-hit').length`)) === 0 && !(await p.eval<boolean>(`!!document.querySelector('.search-note')`)), 'as you type, a misspelt word is not corrected yet');
  // Enter searches in full, and keeps it among the recent searches (so does opening a result).
  await key('Enter');
  await p.until(`!!document.querySelector('.search-note')`, 8000).catch(() => {});
  const note = await p.eval<string>(`document.querySelector('.search-note')?.textContent ?? ''`);
  check(note.includes('hackathon'), 'Enter corrects a misspelt word, and says so', note);

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
  // The inbox's box narrows the inbox in place (docs/search.md "In the inbox"): the cursor stays, nothing opens.
  const inbox = `.sidebar .search-box input`;
  // The box keeps its words while the app moves between pages: each step starts it empty, by its ✕.
  const emptyInbox = async () => {
    await p.eval(`document.querySelector('.sidebar .search-clear')?.click()`);
    await p.until(`document.querySelector('${inbox}').value === ''`, 3000).catch(() => {});
    await p.eval(`document.querySelector('${inbox}').focus()`);
  };
  await p.goto(`${hub}/#/`);
  await p.until(`!!document.querySelector('${inbox}') && document.querySelectorAll('.inbox-side .side-scroll button.row .row-title').length > 2`, 8000);
  const titles = () => p.eval<string[]>(`[...document.querySelectorAll('.inbox-side .side-scroll [data-row-key] .row-title')].map((t) => t.textContent.trim())`);
  const name = (await titles()).map((t) => t.split(/[^\p{L}\p{N}]+/u).find((w) => w.length >= 4)).find(Boolean)!;
  await p.eval(`document.querySelector('${inbox}').focus()`);
  await type('in:gen');
  await p.until(`document.querySelectorAll('.search-suggest-row').length > 0`, 3000).catch(() => {});
  check((await p.eval<string>(`document.querySelector('${inbox}').value`)) === 'in:gen' && (await p.eval(`document.activeElement === document.querySelector('${inbox}')`)) === true && !(await hash()).includes('search'), 'typing in the inbox box keeps the cursor there and the inbox in place', await hash());
  check((await rows()).some((r) => r.includes('general')) && (await onTop()), 'its suggestions follow, on top of the list below', await rows());
  await p.shot(join(shots, 'sidebar-suggest.png'));

  // Fast typing: key after key with no wait. Every letter stays in the box, and the list narrows to what holds them.
  const fast = async (word: string) => {
    await p.goto(`${hub}/#/`);
    await p.until(`!!document.querySelector('${inbox}')`, 8000);
    await emptyInbox();
    for (const c of word) {
      await p.send('Input.dispatchKeyEvent', { type: 'keyDown', key: c, code: `Key${c.toUpperCase()}`, text: c, windowsVirtualKeyCode: c.toUpperCase().charCodeAt(0) });
      await p.send('Input.dispatchKeyEvent', { type: 'keyUp', key: c, code: `Key${c.toUpperCase()}` });
    }
    await p.until(`document.querySelector('${inbox}').value.length >= ${word.length} && !!document.querySelector('.inbox-found')`, 5000).catch(() => {});
    return { box: await p.eval<string>(`document.querySelector('${inbox}').value`), hash: await hash(), titles: await titles() };
  };
  const word = name.toLowerCase();
  const typed = [await fast(word), await fast(word)];
  check(typed.every((t) => t.box === word && !t.hash.includes('search')), 'fast typing in the inbox box loses no letter', typed.map((t) => t.box));
  const holds = (t: string) => t.toLowerCase().split(/[^\p{L}\p{N}]+/u).some((w) => w.startsWith(word));
  check(typed[1].titles.length > 0 && typed[1].titles.some(holds), 'the inbox narrows to the chats named so, from the first key', { word, titles: typed[1].titles });

  // Messages: the newest few, from the hub a moment later, and Full results opens the search page with the words.
  await p.eval(`document.querySelector('${inbox}').select()`);
  await type('the');
  await p.until(`!document.querySelector('.inbox-found.waiting') && document.querySelectorAll('.inbox-found .inbox-hit').length > 0`, 8000).catch(() => {});
  const found = await p.eval<{ hits: number; more: boolean; rows: number }>(`({ hits: document.querySelectorAll('.inbox-found .inbox-hit').length, more: !!document.querySelector('.inbox-found-more'), rows: document.querySelectorAll('.inbox-side .side-scroll button.row').length })`);
  check(found.hits > 0 && found.hits <= 3 && found.more, 'the newest three messages show under the chats, with more a tap away', found);
  await p.shot(join(shots, 'sidebar-found.png'));
  // From the box, Down walks the rows and then the messages.
  await closeList();
  await key('ArrowDown');
  const walked = await p.eval<boolean>(`!!document.activeElement?.closest('.inbox-side .side-scroll')`);
  check(walked, 'Down from the inbox box reaches the list');
  await p.eval(`document.querySelector('${inbox}').focus()`);
  await closeList();
  await key('Escape');
  check((await p.eval<string>(`document.querySelector('${inbox}').value`)) === '' && !(await p.eval<boolean>(`!!document.querySelector('.inbox-found')`)) && !(await hash()).includes('search'), 'Escape empties the box and gives the whole inbox back', await hash());
  await type('the');
  await p.until(`!!document.querySelector('.inbox-found-full')`, 5000).catch(() => {});
  await p.eval(`document.querySelector('.inbox-found-full').click()`);
  await p.until(`decodeURIComponent(location.hash).includes('search') && document.querySelectorAll('.search-hit').length > 0`, 8000).catch(() => {});
  check((await hash()).includes('q=the') && (await p.eval<string>(`document.querySelector('${box}')?.value ?? ''`)) === 'the', 'Full results opens the search page with the words', await hash());

  // The inbox box's words fit it: a key hint where there is room, "…" where there is not, never cut mid-letter.
  await p.goto(`${hub}/#/`);
  await p.until(`!!document.querySelector('.sidebar .search-box input')`, 8000);
  await emptyInbox();
  await p.eval(`document.activeElement?.blur()`);
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
  // On a phone the inbox box narrows the inbox in place too: no page change at the tap.
  await p.goto(`${hub}/#/`);
  await p.until(`!!document.querySelector('${inbox}')`, 8000);
  await emptyInbox();
  await type('lib');
  await p.until(`document.querySelectorAll('.inbox-found .search-jump-row').length > 0 && document.querySelectorAll('.inbox-found .inbox-hit').length > 0`, 8000).catch(() => {});
  const phoneFound = { hash: await hash(), places: await p.eval<number>(`document.querySelectorAll('.inbox-found .search-jump-row').length`), hits: await p.eval<number>(`document.querySelectorAll('.inbox-found .inbox-hit').length`), focused: await p.eval<boolean>(`document.activeElement === document.querySelector('${inbox}')`) };
  check(!phoneFound.hash.includes('search') && phoneFound.focused && phoneFound.places > 0 && phoneFound.hits > 0, 'on a phone the inbox box finds places and messages in place, the keyboard kept', phoneFound);
  await p.shot(join(shots, 'phone-found.png'));
  await p.eval(`document.querySelector('.inbox-found-full').click()`);
  await p.until(`decodeURIComponent(location.hash).includes('q=lib') && document.querySelectorAll('.search-hit').length > 0`, 8000).catch(() => {});
  check((await hash()).includes('q=lib') && (await p.eval<boolean>(`document.activeElement !== document.querySelector('${box}')`)), 'Full results on a phone opens the page to read, with no keyboard', await hash());
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
