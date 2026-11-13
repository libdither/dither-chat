/**
 * Notices (docs/notices.md), end to end against a demo hub in headless Chromium: the demo's fake source has a GitHub
 * account and dither-accounts' own, with notices of each urgency there before the hub started (a catch-up finds them,
 * quietly) and two that arrive live a few seconds after it did (they notify). The inbox has a Notices row; #/notices
 * lists them newest first with their tier and why; a row opens to its reasons and marks; "Should have alerted" is
 * kept; #/notices/<id> (where a notification's tap goes) opens one and marks it read; and Settings offers Notices
 * among each device's rules. Then the same list at a phone's width.
 *
 *   bun scripts/verify-notices.ts http://127.0.0.1:8497 [/tmp/shots]
 * The hub must be a fresh demo hub (--demo) with its own data dir: this marks notices read and marks them.
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
const notices = async () => (await fetch(`${hub}/api/notices`).then((r) => r.json())) as P.NoticesPage;
const by = (p: P.NoticesPage, title: string) => p.items.find((n) => n.title === title);

check(boot.notices?.access === 'granted', 'the bootstrap says this hub has notices', boot.notices);
// The two live ones come a few seconds after the start.
for (let i = 0; i < 100 && (await notices()).items.length < 8; i++) await Bun.sleep(100);
const first = await notices();
check(first.items.length === 8, 'eight notices: six found by the catch-up, two live', first.items.length);
check(first.accounts.map((a) => a.kind).sort().join() === 'github,notices', 'from a GitHub account and dither-accounts’ own', first.accounts);
const tier = (t: string) => by(first, t)?.triage?.decision;
check(tier('Potential secret leaked in a commit') === 'push', 'a security alert (high) is an alert', by(first, 'Potential secret leaked in a commit')?.triage?.reasons);
check(by(first, 'Potential secret leaked in a commit')?.triage?.reasons.includes('Came by a catch-up: no notification'), 'found by the catch-up: rated, not notified');
check(tier('CI: check failed on main') === 'drop', 'CI (low) is below the list', by(first, 'CI: check failed on main')?.triage?.reasons);
check(tier('Notices: machine notifications through triage') === 'digest', 'a review asked of you (normal) is on the list');
check(tier('Proton Mail stopped') === 'push' && !by(first, 'Proton Mail stopped')?.triage?.reasons.some((r) => r.includes('no notification')), 'a live "stopped" (high) is an alert that notified', by(first, 'Proton Mail stopped')?.triage?.reasons);
check(tier('Delivery: one notification per group') === 'digest', 'a live assignment (normal, not urgent) is a row on the list', by(first, 'Delivery: one notification per group')?.triage?.reasons);

const { page: p, close } = await launch();
try {
  await p.size(1280, 860);
  await p.goto(`${hub}/#/inbox`);
  // The row is there at once; its count once the list is fetched.
  await p.until(`!!document.querySelector('.notices-row .requests-count')`, 15000).catch(() => {});
  const row = await p.eval<string>(`document.querySelector('.notices-row').textContent`);
  check(/Notices\s*8/.test(row), 'the inbox has a Notices row with the unread count', row);
  await p.eval(`document.querySelector('.notices-row').click()`);
  await p.until(`location.hash === '#/notices' && document.querySelectorAll('.notice-card').length === 8`, 10000);
  const cards = await p.eval<{ id: string; tier: string; title: string; why: string; unread: boolean }[]>(
    `[...document.querySelectorAll('.notice-card')].map((c) => ({ id: c.dataset.notice, tier: c.dataset.tier, title: c.querySelector('.notice-title').textContent, why: c.querySelector('.notice-why').textContent, unread: c.classList.contains('unread') }))`,
  );
  check(cards.map((c) => c.title).join('|') === first.items.map((n) => n.title).join('|'), 'newest first, as the hub keeps them', cards.map((c) => c.title));
  check(cards.every((c) => c.unread), 'all unread, each with its dot');
  check(cards.find((c) => c.title === 'Proton Mail stopped')?.why.startsWith('Alert'), 'each says its tier and why', cards.find((c) => c.title === 'Proton Mail stopped')?.why);
  if (shots) await p.shot(`${shots}/notices.png`);

  // Open the review request: its reasons and marks.
  const review = cards.find((c) => c.title === 'Notices: machine notifications through triage')!;
  await p.eval(`document.querySelector('[data-notice="${review.id}"] .notice-head').click()`);
  await p.until(`!!document.querySelector('[data-notice="${review.id}"] .notice-actions')`, 3000);
  const acts = await p.eval<string[]>(`[...document.querySelectorAll('[data-notice="${review.id}"] .notice-actions > *')].map((b) => b.textContent.trim())`);
  check(acts.join('|') === 'Open|Mark read|Less like this|Should have alerted', 'a list row offers Open, Mark read, Less like this and Should have alerted', acts);
  check(await p.eval(`document.querySelector('[data-notice="${review.id}"] .notice-actions a').getAttribute('target') === '_blank'`), 'Open goes to its link in a new tab');
  await p.eval(`document.querySelector('[data-notice="${review.id}"] [data-act="alert"]').click()`);
  await p.until(`!!document.querySelector('[data-notice="${review.id}"] [data-act="alert"].on')`, 5000);
  check(by(await notices(), review.title)?.triage?.marks?.alert === true, '"Should have alerted" is kept with it');
  await p.eval(`document.querySelector('[data-notice="${review.id}"] [data-act="read"]').click()`);
  await p.until(`!document.querySelector('[data-notice="${review.id}"]').classList.contains('unread')`, 5000);
  check(by(await notices(), review.title)?.unread === false, 'Mark read reads it at the hub');
  if (shots) await p.shot(`${shots}/notices-open.png`);

  // Where a notification's tap goes: #/notices/<id> opens it and reads it.
  const alert = cards.find((c) => c.title === 'Proton Mail stopped')!;
  await p.goto(`${hub}/#/notices/${alert.id}`);
  await p.until(`!!document.querySelector('[data-notice="${alert.id}"].focused .notice-actions')`, 10000);
  await p.until(`!document.querySelector('[data-notice="${alert.id}"]').classList.contains('unread')`, 5000);
  check(by(await notices(), 'Proton Mail stopped')?.unread === false, 'opened from its notification, it is read');
  const alertActs = await p.eval<string[]>(`[...document.querySelectorAll('[data-notice="${alert.id}"] .notice-actions > *')].map((b) => b.textContent.trim())`);
  check(alertActs.includes('Alert was wrong') && !alertActs.includes('Mark read'), 'an alert offers "Alert was wrong"', alertActs);

  // Each device's rules list Notices.
  await p.goto(`${hub}/#/settings`);
  await p.until(`!!document.querySelector('#set-devices .device-block [data-device-net="notice"]')`, 15000).catch(() => {});
  check(await p.eval(`!!document.querySelector('#set-devices .device-block [data-device-net="notice"]')`), 'Settings offers Notices among a device’s rules');

  // A phone.
  await p.size(390, 844, true);
  await p.goto(`${hub}/#/notices`);
  await p.until(`document.querySelectorAll('.notice-card').length === 8`, 10000);
  check(await p.eval(`document.documentElement.scrollWidth <= window.innerWidth`), 'no sideways scroll at a phone’s width');
  if (shots) await p.shot(`${shots}/notices-phone.png`);
  check(!p.errors.length, 'no page errors', p.errors);
} finally {
  await close();
}
console.log(failures ? `${failures} FAILED` : 'all ok');
process.exit(failures ? 1 : 0);
