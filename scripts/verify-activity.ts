/**
 * The activity log (docs/activity.md), end to end in headless Chromium against a demo hub: a visit from an inbox
 * row with its rank and score, a message sent during it and what it saw and left behind, the rail, going back, a notification tap that opens the
 * app (its id in the hash, then gone from the address bar) linked to its visit, Settings → Privacy, the features,
 * and both exports without message text.
 *
 *   bun scripts/verify-activity.ts http://127.0.0.1:8491
 *
 * The hub must be a fresh demo hub (--demo) with its own data dir: this sends a message. Start it with
 * DITHER_ACTIVITY_FEATURES=1 to check that triage keeps what it knew.
 */
import { launch } from './browser.ts';

const hub = process.argv[2] ?? 'http://127.0.0.1:8491';
const boot = (await fetch(`${hub}/api/bootstrap`).then((r) => r.json())) as any;
if (!boot.accounts.every((a: any) => a.demo)) throw new Error('not a demo hub');

let failures = 0;
const check = (ok: unknown, what: string, detail: unknown = '') => {
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${what}${detail !== '' ? `  ${JSON.stringify(detail)}` : ''}`);
  if (!ok) failures++;
};
const get = (p: string) => fetch(`${hub}${p}`).then((r) => r.json()) as Promise<any>;
const log = async () =>
  (await fetch(`${hub}/api/activity/export`).then((r) => r.text()))
    .trim()
    .split('\n')
    .map((l) => JSON.parse(l));

const { page, close } = await launch();
await page.size(1280, 900);
// Headless windows never have focus, and the log only counts time in a focused window.
await page.send('Emulation.setFocusEmulationEnabled', { enabled: true });

async function click(selector: string) {
  const r = await page.eval<{ x: number; y: number } | null>(`(() => { const e = document.querySelector(${JSON.stringify(selector)}); if (!e) return null; e.scrollIntoView({ block: 'center' }); const r = e.getBoundingClientRect(); return { x: r.x + r.width / 2, y: r.y + r.height / 2 }; })()`);
  if (!r) throw new Error(`nothing matches ${selector}`);
  for (const type of ['mouseMoved', 'mousePressed', 'mouseReleased']) await page.send('Input.dispatchMouseEvent', { type, x: r.x, y: r.y, button: 'left', clickCount: 1 });
}
/** What the page has not sent yet goes now, as when it is hidden. */
const flush = async () => {
  await page.eval(`window.dispatchEvent(new Event('pagehide'))`);
  await Bun.sleep(800);
};

try {
  await page.goto(hub);
  await page.until(`document.querySelectorAll('.sidebar .conv-row[data-row]').length > 2`, 15000);
  const t0 = Date.now();

  // ---------------------------------------------------------------- an inbox row, with a message sent
  const second = await page.eval<string>(`document.querySelectorAll('.sidebar .conv-row[data-row]')[1].getAttribute('data-row')`);
  await click(`.sidebar .conv-row[data-row="${second}"]`);
  await page.until(`!!document.querySelector('.composer textarea')`, 8000);
  await Bun.sleep(4000);
  await page.eval(`document.querySelector('.composer textarea').focus()`);
  await page.send('Input.insertText', { text: `activity check ${t0.toString(36)}` });
  await page.send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13, text: '\r' });
  await page.send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13 });
  await Bun.sleep(1500);

  // ---------------------------------------------------------------- the rail, then back
  await click('.rail .rail-btn[data-tip="Settings"]');
  await page.until(`location.hash === '#/settings'`, 5000);
  await Bun.sleep(4000);
  await page.eval(`history.back()`);
  await page.until(`location.hash.includes(${JSON.stringify(second)})`, 5000);
  await Bun.sleep(4000);
  await flush();

  let rows = await log();
  const visits = rows.filter((r) => r.type === 'visit' && r.start >= t0);
  const fromInbox = visits.find((v) => v.conversationId === second && v.source === 'inbox');
  check(fromInbox, 'a visit from an inbox row', visits.map((v) => [v.view, v.source]));
  check(fromInbox?.rank === 1 && typeof fromInbox?.score === 'number', '…with its rank and attention score then', { rank: fromInbox?.rank, score: fromInbox?.score, needs: fromInbox?.needs });
  check(fromInbox?.sent === 1, '…the message sent during it', fromInbox?.sent);
  check(fromInbox?.active >= 3 && fromInbox?.next === 'settings' && fromInbox?.closed, '…its time in use, and where the user went next', { active: fromInbox?.active, next: fromInbox?.next });
  check(fromInbox?.device && fromInbox?.deviceLabel === 'Chrome on Linux', '…and the device', [fromInbox?.device, fromInbox?.deviceLabel]);
  check(
    typeof fromInbox?.seenToTs === 'number' && fromInbox?.typed >= 1 && fromInbox?.draftLeft === false && fromInbox?.exit === 'route' && typeof fromInbox?.owedShown === 'boolean',
    '…what it saw and left behind: the newest message on screen, typing, no draft, ended by going elsewhere',
    { seenToTs: fromInbox?.seenToTs != null, typed: fromInbox?.typed, draftLeft: fromInbox?.draftLeft, exit: fromInbox?.exit, owedShown: fromInbox?.owedShown },
  );
  check(visits.some((v) => v.view === 'settings' && v.source === 'rail'), 'settings, from the rail');
  check(visits.some((v) => v.conversationId === second && v.source === 'back'), 'back to the conversation, from history');

  // ---------------------------------------------------------------- a notification tap that opens the app
  const n = rows.find((r) => r.type === 'notification' && r.conversationId && !r.visitId);
  if (!n) throw new Error('the demo hub sent no notification');
  // A fresh load, as when sw.js or the Android app opens the app at the notification's hash.
  await page.goto('about:blank');
  await page.goto(`${hub}/#/inbox/c/${n.conversationId}?n=${n.id}`);
  await page.until(`document.querySelectorAll('.sidebar .conv-row[data-row]').length > 2`, 15000);
  check(!(await page.eval<string>('location.hash')).includes('n='), 'the push id is not left in the address bar', await page.eval('location.hash'));
  await Bun.sleep(4000);
  await flush();
  rows = await log();
  const tapped = rows.find((r) => r.type === 'notification' && r.id === n.id);
  const tapVisit = rows.find((r) => r.type === 'visit' && r.pushId === n.id);
  check(tapVisit?.source === 'notification' && tapVisit?.conversationId === n.conversationId, 'the tap starts a visit that names the push', tapVisit && [tapVisit.source, tapVisit.view]);
  check(tapped?.visitId === tapVisit?.id && tapped?.tappedAt >= n.sentAt, '…and the notification links to it, with its tap time', { visitId: tapped?.visitId, tappedAt: tapped?.tappedAt });
  check(tapped?.events?.some((e: any) => e.event === 'tapped'), '…and the page said it was tapped', tapped?.events);
  const f = await get(`/api/activity/features?conversation=${n.conversationId}`);
  check(f.conversation?.pushes >= 1 && f.conversation?.tapped >= 1, 'the features count it', f.conversation);

  // ---------------------------------------------------------------- a tap while the app is open: sw.js posts `open` to the page
  const n2 = rows.find((r) => r.type === 'notification' && r.conversationId && !r.visitId && r.conversationId !== n.conversationId);
  if (n2) {
    await page.eval(`navigator.serviceWorker.dispatchEvent(new MessageEvent('message', { data: { t: 'open', hash: '#/inbox/c/${n2.conversationId}?n=${n2.id}' } }))`);
    await page.until(`location.hash === '#/inbox/c/${n2.conversationId}'`, 5000);
    await Bun.sleep(4000);
    await flush();
    const warm = (await log()).find((r) => r.type === 'notification' && r.id === n2.id);
    check(warm?.visitId && warm?.tappedAt, 'a tap with the app open links its visit too', { visitId: warm?.visitId });
  }

  // ---------------------------------------------------------------- Settings → Privacy
  await page.goto(`${hub}/#/settings`);
  await page.until(`!!document.querySelector('#set-activity')`, 10000);
  const text = await page.eval<string>(`document.querySelector('#set-activity').textContent`);
  check(/Keep an activity log/.test(text) && /\d+ visits? and \d+ notifications? recorded/.test(text), 'Privacy shows the switch and what is kept', text.match(/\d+ visits?[^.]*\./)?.[0]);
  await page.eval(`document.querySelector('#set-activity details').open = true`);
  await page.until(`!document.querySelector('#set-activity details').textContent.includes('Loading')`, 5000);
  check(await page.eval(`!!document.querySelector('#set-activity .activity-table tbody tr')`), '"What it has learned" lists places');
  await click('#set-activity .toggle-row input');
  await Bun.sleep(600);
  check((await get('/api/activity')).settings.enabled === false, 'turning it off reaches the hub');
  const before = (await get('/api/activity')).visits;
  await page.goto(`${hub}/#/inbox`);
  await Bun.sleep(4000);
  await flush();
  check((await get('/api/activity')).visits === before, '…and nothing new is recorded');
  await fetch(`${hub}/api/activity/settings`, { method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ enabled: true }) });

  // ---------------------------------------------------------------- the exports
  const examples = (await fetch(`${hub}/api/activity/examples`).then((r) => r.text())).trim().split('\n');
  const parsed = examples.map((l) => JSON.parse(l));
  check(parsed.length > 0 && parsed.every((e) => e.triage && e.outcome && 'label' in e), 'training examples: one per triaged message, with decision, outcome and label', parsed.length);
  const texts = boot.conversations.map((c: any) => c.lastMessage?.text).filter((t: string) => t && t.length >= 12);
  const all = examples.join('\n') + JSON.stringify(rows);
  check(!texts.some((t: string) => all.includes(t)) && !all.includes(`activity check ${t0.toString(36)}`), 'no message text in either export', texts.length);
  const kept = parsed.filter((e) => e.inputs);
  console.log(`      ${kept.length} examples carry what triage knew then (needs DITHER_ACTIVITY_FEATURES=1 on the hub)`);
  check(page.errors.length === 0, 'no page errors', page.errors.slice(0, 3));
} catch (e) {
  check(false, 'ran to the end', String(e));
} finally {
  await close();
}
console.log(failures ? `${failures} failed` : 'all passed');
process.exit(failures ? 1 : 0);
