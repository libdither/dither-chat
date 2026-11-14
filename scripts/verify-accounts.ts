/**
 * The one list of accounts (docs/accounts.md "One list"), end to end against a demo hub in headless Chromium: chat,
 * mail and notices accounts in one list, each with its feature icons; a Google account whose mail this hub may not read
 * shows mail dim, and its page asks dither-accounts for it; Add account offers the chat networks and dither-accounts'
 * kinds side by side, adds a Proton Mail account (which then asks you to sign in), and asks to add a kind it may not
 * yet; then the list at a phone's width, and in the light theme.
 *
 *   bun scripts/verify-accounts.ts http://127.0.0.1:8497 [/tmp/shots]
 * The hub must be a fresh demo hub (--demo) with its own data dir: this adds an account and asks for access.
 */
import { mkdirSync } from 'node:fs';
import type * as P from '@dither-chat/protocol';
import { launch } from './browser.ts';

const hub = process.argv[2] ?? 'http://127.0.0.1:8497';
const shots = process.argv[3];
if (shots) mkdirSync(shots, { recursive: true });

const boot = (await fetch(`${hub}/api/bootstrap`).then((r) => r.json())) as P.Bootstrap;
if (!boot.accounts.every((a) => a.demo)) throw new Error('not a demo hub');

let failures = 0;
const check = (ok: unknown, what: string, detail: unknown = '') => {
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${what}${detail !== '' ? `  ${JSON.stringify(detail)}` : ''}`);
  if (!ok) failures++;
};
const WORK = 'acc_demo-work-google';
type Row = { id: string; kind: string; name: string; pill: string; icons: string[] };
const rows = `[...document.querySelectorAll('.acc-row')].map((r) => ({ id: r.dataset.account, kind: r.dataset.kind, name: r.querySelector('.row-title').textContent.trim(), pill: r.querySelector('.status-pill').textContent, icons: [...r.querySelectorAll('.feat')].map((f) => f.dataset.feature + ':' + f.dataset.state) }))`;

const { page: p, close } = await launch();
try {
  await p.size(1280, 860);
  await p.goto(`${hub}/#/accounts`);
  await p.until(`document.querySelectorAll('.acc-row').length > 8`, 15000);
  const list = await p.eval<Row[]>(rows);
  const row = (id: string) => list.find((r) => r.id === id);
  check(!(await p.eval<boolean>(`!!document.querySelector('.acc-mail-group')`)), 'no Mail group of its own: one list');
  check(row('acc_demo-mail')?.icons.join() === 'mail:on', 'the mail account is a row, with a mail icon', row('acc_demo-mail'));
  check(row('acc_demo-github')?.icons.join() === 'notices:on', 'a notices account is a row too', row('acc_demo-github'));
  const discord = list.find((r) => r.kind === 'discord')!;
  check(discord.icons[0] === 'chat:on' && discord.icons.includes('spaces:on'), 'a Discord account: chats, and its servers', discord);
  check(list.find((r) => r.kind === 'x')?.icons.join() === 'chat:on,feed:on', 'X: chats and its feed', list.find((r) => r.kind === 'x'));
  check(row(WORK)?.icons.join() === 'mail:off', 'a Google account whose mail this hub may not read: mail dim', row(WORK));
  // One kind's accounts together.
  const kinds = list.map((r) => r.kind);
  check(kinds.every((k, i) => kinds.indexOf(k) === i || kinds[i - 1] === k), 'accounts of one kind sit together', kinds);
  if (shots) await p.shot(`${shots}/list.png`);

  // The dim one's page: ask for its mail.
  await p.eval(`document.querySelector('.acc-row[data-account="${WORK}"]').click()`);
  await p.until(`!!document.querySelector('[data-account-pane="${WORK}"] .feat-chip[data-feature="mail"]')`, 5000);
  check(await p.eval(`document.querySelector('.feat-chip[data-feature="mail"]').dataset.state === 'off'`), 'its page says mail is not shown here');
  if (shots) await p.shot(`${shots}/ungranted.png`);
  await p.eval(`document.querySelector('.feat-chip[data-feature="mail"] .btn').click()`);
  await p.until(`document.querySelector('.feat-chip[data-feature="mail"]').dataset.state === 'asked'`, 5000);
  check(true, '"Show it here" asks dither-accounts, and the feature says it waits there');
  check(await p.eval(`document.querySelector('.acc-row[data-account="${WORK}"] .feat').dataset.state === 'asked'`), 'its row’s icon says so too');
  if (shots) await p.shot(`${shots}/asked.png`);

  // The mail account's page: its Mail section, not a card under the list.
  await p.eval(`document.querySelector('.acc-row[data-account="acc_demo-mail"]').click()`);
  await p.until(`!!document.querySelector('[data-account-pane="acc_demo-mail"] [data-mail-section]')`, 5000);
  const kv = await p.eval<string>(`document.querySelector('[data-mail-section] .kv').textContent`);
  check(/Addresszyan@dither\.example/.test(kv) && /AccessRead and send/.test(kv), 'a mail account’s page has its Mail section', kv.slice(0, 120));
  if (shots) await p.shot(`${shots}/mail-account.png`);

  // Add account: the chat networks and dither-accounts' kinds side by side.
  await p.eval(`document.querySelector('.add-btn').click()`);
  await p.until(`!!document.querySelector('.net-opt[data-kind="proton"]')`, 5000);
  const tiles = await p.eval<string[]>(`[...document.querySelectorAll('.net-opt')].map((t) => t.dataset.kind)`);
  check(tiles.includes('discord') && tiles.includes('proton') && tiles.includes('imap') && tiles.includes('github'), 'Add account offers chat networks and mail and notices kinds together', tiles);
  check(!tiles.includes('email'), 'no "mail is added elsewhere" tile');
  if (shots) await p.shot(`${shots}/add.png`);
  // A kind it may not add yet: asking.
  await p.eval(`document.querySelector('.net-opt[data-kind="imap"]').click()`);
  await p.until(`!!document.querySelector('.add-ask')`, 3000);
  await p.eval(`document.querySelector('.add-ask .btn.primary').click()`);
  await p.until(`document.querySelector('.add-ask')?.dataset.asked === 'pending'`, 5000);
  check(true, 'IMAP: dither-chat may not add it yet, and asking says it waits on dither-accounts’ page');
  if (shots) await p.shot(`${shots}/add-asked.png`);
  // Proton Mail: added here.
  await p.eval(`document.querySelector('.net-opt[data-kind="proton"]').click()`);
  await p.until(`[...document.querySelectorAll('.modal-actions .btn.primary')].some((b) => b.textContent === 'Add Proton Mail')`, 3000);
  await p.eval(`document.querySelector('.add-form .modal-actions').scrollIntoView({ block: 'end' })`);
  if (shots) await p.shot(`${shots}/add-proton.png`);
  await p.eval(`(() => { const i = document.querySelector('.add-form input.input'); i.value = 'Personal'; i.dispatchEvent(new Event('input', { bubbles: true })); })()`);
  await p.eval(`[...document.querySelectorAll('.modal-actions .btn.primary')].find((b) => b.textContent === 'Add Proton Mail').click()`);
  await p.until(`/^#\\/accounts\\/acc_demo-proton-/.test(location.hash) && !!document.querySelector('[data-mail-section]')`, 8000);
  const made = await p.eval<string>(`location.hash.split('/')[2]`);
  const pane = await p.eval<{ pill: string; callout: string; chip: string }>(
    `({ pill: document.querySelector('.account-pane .status-pill').textContent, callout: document.querySelector('[data-mail-section] .det-callout')?.textContent ?? '', chip: document.querySelector('.feat-chip[data-feature="mail"]').dataset.state })`,
  );
  check(pane.pill === 'Needs you' && /Sign in to Proton/.test(pane.callout) && pane.chip === 'trouble', 'the new Proton Mail account opens, asking you to sign in', pane);
  check((await p.eval<Row[]>(rows)).some((r) => r.id === made && r.kind === 'proton' && r.icons.join() === 'mail:trouble'), 'and it is in the list with the others, its mail icon dotted');
  if (shots) await p.shot(`${shots}/proton-added.png`);

  // Light theme.
  await p.eval(`localStorage.setItem('dither-chat:prefs', JSON.stringify({ ...JSON.parse(localStorage.getItem('dither-chat:prefs') || '{}'), theme: 'light' }))`);
  await p.goto(`${hub}/#/accounts/acc_demo-mail`);
  await p.eval(`location.reload()`);
  await p.until(`!!document.querySelector('[data-mail-section]')`, 10000);
  if (shots) await p.shot(`${shots}/light.png`);
  await p.eval(`localStorage.setItem('dither-chat:prefs', JSON.stringify({ ...JSON.parse(localStorage.getItem('dither-chat:prefs') || '{}'), theme: 'dark' }))`);

  // A phone: the list, then Settings' accounts.
  await p.size(390, 844, true);
  await p.goto(`${hub}/#/accounts`);
  await p.until(`document.querySelectorAll('.acc-row').length > 8`, 10000);
  const overflow = await p.eval<number>(`document.documentElement.scrollWidth - document.documentElement.clientWidth`);
  check(overflow <= 0, 'no sideways scroll at a phone’s width', overflow);
  if (shots) await p.shot(`${shots}/phone-list.png`);
  await p.goto(`${hub}/#/accounts/${WORK}`);
  await p.until(`!!document.querySelector('.feat-strip')`, 10000);
  if (shots) await p.shot(`${shots}/phone-account.png`);
  check(p.errors.length === 0, 'no page errors', p.errors);
} finally {
  await close();
}

console.log(failures ? `${failures} failed` : 'all ok');
process.exit(failures ? 1 : 0);
