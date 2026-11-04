/**
 * Search, end to end against a demo hub in headless Chromium: the box's operator suggestions (people with pictures),
 * picking one by keyboard, a misspelt search corrected, hits grouped by conversation with context, recent searches,
 * walking the results with the arrow keys, the sort control, and Ctrl+F in a chat.
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

  await clearBox();
  await type('hackaton');
  await key('Enter');
  await p.until(`document.querySelectorAll('.search-hit').length > 0`, 8000);
  check((await hash()).includes('q=hackaton'), 'Enter searches', await hash());
  const note = await p.eval<string>(`document.querySelector('.search-note')?.textContent ?? ''`);
  check(note.includes('hackathon'), 'a misspelt word is corrected, and says so', note);

  await clearBox();
  await type('the');
  await key('Enter');
  await p.until(`document.querySelectorAll('.search-hit').length > 3`, 8000);
  const groups = await p.eval<{ n: number; heads: number; ctx: number }>(`({ n: document.querySelectorAll('.search-group').length, heads: document.querySelectorAll('.search-group-head').length, ctx: document.querySelectorAll('.search-ctx').length })`);
  check(groups.n > 1 && groups.heads === groups.n && groups.ctx > 0, 'hits come grouped by conversation, with lines around them', groups);
  await p.shot(join(shots, 'results.png'));

  // From the box, Down walks into the results; Up from the first goes back.
  await p.eval(`document.querySelector('${box}').focus()`);
  await key('Escape');
  await key('ArrowDown');
  const at = () => p.eval<number>(`[...document.querySelectorAll('.search-hit')].indexOf(document.activeElement)`);
  check((await at()) === 0, 'Down from the box reaches the first hit');
  await key('ArrowDown');
  check((await at()) === 1, 'Down again, the second');
  await key('ArrowUp');
  await key('ArrowUp');
  check((await p.eval(`document.activeElement === document.querySelector('${box}')`)) === true, 'Up from the first goes back to the box');

  await p.eval(`[...document.querySelectorAll('.search-sort button')].find((b) => b.textContent === 'Oldest').click()`);
  await Bun.sleep(400);
  check((await hash()).includes('sort:oldest'), 'the sort control sets sort:oldest', await hash());

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
  const onTop = () => p.eval<boolean>(`(() => { const r = document.querySelector('.search-suggest-row'); if (!r) return false; const b = r.getBoundingClientRect(); const at = document.elementFromPoint(b.left + 30, b.top + b.height / 2); return !!at && r.contains(at); })()`);
  await p.goto(`${hub}/#/`);
  await p.until(`!!document.querySelector('.sidebar .search-box input')`, 8000);
  await p.eval(`document.querySelector('.sidebar .search-box input').focus()`);
  await type('in:gen');
  check((await rows()).some((r) => r.includes('general')) && (await onTop()), 'the inbox box suggests too, on top of the list below it', await rows());
  await p.shot(join(shots, 'sidebar-suggest.png'));

  await p.size(390, 844, true);
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
