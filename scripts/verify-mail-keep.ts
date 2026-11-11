/**
 * Keeping all mail (docs/mail.md "Keeping all mail"), on Settings → Indexing in headless Chromium against a demo hub:
 * a row per mail account with its keep switch, what it holds of the server's count, its bodies, the room it takes and
 * how far its walk has come; Gmail's month audits; Pause and Resume; turning keeping off and on; on a desktop in the
 * dark theme and a phone in the light one, with nothing off the side of the screen and no page errors.
 *
 *   DITHER_DEMO_MAIL_GMAIL=1 bun packages/hub/src/main.ts --demo --data <fresh dir> --port 8798 --web <built web>
 *   bun scripts/verify-mail-keep.ts http://127.0.0.1:8798 [screenshot dir]
 *
 * Changes keeping on the demo hub's accounts; use a fresh data dir.
 */
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { launch, type Page } from './browser.ts';

const hub = process.argv[2] ?? 'http://127.0.0.1:8798';
const shots = process.argv[3] ?? '/tmp/dc-mail-keep-shots';
mkdirSync(shots, { recursive: true });

const boot = (await fetch(`${hub}/api/bootstrap`).then((r) => r.json())) as any;
if (!boot.accounts.every((a: any) => a.demo)) throw new Error('not a demo hub');

let failures = 0;
const check = (ok: unknown, what: string, detail?: unknown) => {
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${what}${detail !== undefined ? `  ${JSON.stringify(detail)}` : ''}`);
  if (!ok) failures++;
};

// The demo's mail: walked and every body fetched, at the budget (two calls a second), before the page looks.
const keep = async () => (await fetch(`${hub}/api/mail/keep`).then((r) => r.json())) as { accounts: any[]; disk: { free: number | null; floor: number } };
for (let i = 0; i < 120; i++) {
  const k = await keep();
  if (k.accounts.length && k.accounts.every((a) => a.walk.complete && a.bodies === a.messages.held)) break;
  await Bun.sleep(1000);
}
const first = await keep();
check(first.accounts.length >= 1, 'GET /api/mail/keep lists the mail accounts', first.accounts.length);
check(
  first.accounts.every((a) => a.keep && a.walk.complete && a.bodies === a.messages.held),
  'each kept, walked to the end, every body here',
  first.accounts.map((a) => [a.walk.complete, a.bodies, a.messages.held]),
);

const b = await launch();
const p: Page = b.page;
const count = (sel: string) => p.eval<number>(`document.querySelectorAll(${JSON.stringify(sel)}).length`);
const texts = (sel: string) => p.eval<string[]>(`[...document.querySelectorAll(${JSON.stringify(sel)})].map((x) => x.textContent.trim())`);
const wide = () => p.eval<number>(`document.documentElement.scrollWidth - document.documentElement.clientWidth`);
/** The theme (as verify-mail.ts sets it), taken at the next load. */
const theme = (t: 'dither-dark' | 'dither-light') => p.eval(`localStorage.setItem('dither-chat:prefs', JSON.stringify({ ...JSON.parse(localStorage.getItem('dither-chat:prefs') || '{}'), theme: ${JSON.stringify(t)} }))`);

async function open() {
  await p.eval(`(location.hash = '#/settings', location.reload())`).catch(() => {});
  await Bun.sleep(800);
  await p.until(`!!document.querySelector('#set-indexing-mail [data-mail-keep]')`, 20000);
  await p.eval(`document.getElementById('set-indexing-mail').scrollIntoView({ block: 'start' })`);
  await Bun.sleep(300);
}

try {
  await p.size(1280, 900);
  await p.send('Emulation.setTimezoneOverride', { timezoneId: 'Etc/UTC' });
  await p.goto(`${hub}/#/inbox`);
  await theme('dither-dark');
  await open();
  const rows = await count('#set-indexing-mail [data-mail-keep]');
  check(rows === first.accounts.length, 'a row per mail account under Indexing → Mail', rows);
  const lines = await texts('#set-indexing-mail [data-mail-keep] .job-line');
  check(lines.some((l) => /^[\d,]+ of [\d,]+ messages held · [\d,]+ with their text · [\d.]+ (KB|MB|GB) here$/.test(l)), 'messages held of the server’s count, bodies, the room it takes', lines[0]);
  check(lines.some((l) => /Every mailbox listed to its end/.test(l)), 'the walk: complete', lines.filter((l) => /mailbox/.test(l)));
  const gmail = first.accounts.find((a) => a.audit);
  if (gmail) {
    for (let i = 0; i < 60 && !(await keep()).accounts.find((a) => a.accountId === gmail.accountId)?.audit.checked; i++) await Bun.sleep(1000);
    await open();
    const g = await texts(`[data-mail-keep="${gmail.accountId}"] .job-line`);
    check(g.some((l) => /[\d,]+ of [\d,]+ months? match Gmail/.test(l)), 'Gmail: its months audited', g.filter((l) => /month/.test(l)));
  }
  check(lines.some((l) => /Searches still ask its server/.test(l)), 'not searched locally yet, and why');
  check((await count('#set-indexing-mail .keep-toggle input:checked')) === rows, 'the keep switch on for each');
  check((await wide()) <= 0, 'nothing off the side on a desktop');
  await p.shot(join(shots, 'keep-desktop-dark.png'));

  // Pause, then Resume.
  const id = first.accounts[0].accountId;
  await p.eval(`[...document.querySelectorAll('[data-mail-keep="${id}"] .job-buttons button')].find((x) => /Pause/.test(x.textContent)).click()`);
  await p.until(`/Paused/.test(document.querySelector('[data-mail-keep="${id}"] .job-pill').textContent)`, 8000);
  check(true, 'Pause shows Paused');
  await p.eval(`[...document.querySelectorAll('[data-mail-keep="${id}"] .job-buttons button')].find((x) => /Resume/.test(x.textContent)).click()`);
  await p.until(`!/Paused/.test(document.querySelector('[data-mail-keep="${id}"] .job-pill').textContent)`, 8000);
  check(true, 'Resume takes it back');

  // Off (it asks first), then on again.
  await p.eval(`window.confirm = () => true; document.querySelector('[data-mail-keep="${id}"] .keep-toggle input').click()`);
  await p.until(`/Not kept/.test(document.querySelector('[data-mail-keep="${id}"] .job-pill').textContent)`, 8000);
  check(/A year of mail/.test((await texts(`[data-mail-keep="${id}"] .job-line`)).join(' ')), 'off: a year of mail, as before');
  await p.eval(`document.querySelector('[data-mail-keep="${id}"] .keep-toggle input').click()`);
  await p.until(`!/Not kept/.test(document.querySelector('[data-mail-keep="${id}"] .job-pill').textContent)`, 8000);
  check((await keep()).accounts.find((a) => a.accountId === id)?.keep === true, 'and on again');

  // A phone, in the light theme.
  await p.size(390, 844, true);
  await theme('dither-light');
  await open();
  check((await wide()) <= 0, 'nothing off the side on a phone');
  await p.shot(join(shots, 'keep-phone-light.png'));
  check(p.errors.length === 0, 'no page errors', p.errors.slice(0, 3));
} finally {
  await b.close();
}
console.log(failures ? `${failures} failed` : 'all ok');
process.exit(failures ? 1 : 0);
