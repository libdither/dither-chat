/**
 * A stage end to end on a demo hub (docs/calls.md "Demo calls", "The room view"): two devices in headless Chromium, as
 * the demo's two Discord accounts, on the libdither server's stage, and the demo call room in a third browser as the
 * far end of both. The main account moderates the stage. Checks, through the app's own buttons:
 *
 * - joining a stage opens the room as the conversation's page, with the dock still there;
 * - the zones: the topic and counts, speakers on top with their roles, the audience with "+N more", hands up;
 * - the listener asks to speak; the moderator sees the request and invites; the listener is invited, speaks, and is a
 *   speaker on both devices; the moderator moves them back to the audience from their face's menu;
 * - a simulated person with a hand up, invited, becomes a speaker;
 * - the Room / Chat switch, and the channel's chat beside the room;
 * - Leave quietly ends the call; no page errors.
 *
 *   bun packages/hub/src/main.ts --demo --data /tmp/x --port 8579 --web packages/web/dist
 *   bun scripts/verify-stage-demo.ts http://127.0.0.1:8579 [screenshot dir]
 *
 * Use a fresh demo world each run. With a screenshot dir it saves the room as a listener, with a hand up, as a speaker,
 * as the moderator with requests, and at phone width.
 */
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { launch, type Page } from './browser.ts';

const hub = (process.argv[2] ?? 'http://127.0.0.1:8579').replace(/\/$/, '');
const shots = process.argv[3] ?? '';
if (shots) mkdirSync(shots, { recursive: true });
const MAIN = 'acc_demo-discord-main';
const ALT = 'acc_demo-discord-alt';

const boot = (await fetch(`${hub}/api/bootstrap`).then((r) => r.json())) as any;
if (!boot.accounts.every((a: any) => a.demo)) throw new Error('not a demo hub');
const stage = boot.conversations.find((c: any) => c.variant === 'stage' && c.vantages.some((v: any) => v.accountId === MAIN) && c.vantages.some((v: any) => v.accountId === ALT));
if (!stage) throw new Error('no stage channel both demo Discord accounts see');
const selfOf = (acc: string) => boot.accounts.find((a: any) => a.id === acc)?.selfIdentityId as string;
const altSelf = selfOf(ALT);

let failures = 0;
const check = (ok: unknown, what: string, detail: unknown = '') => {
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${what}${detail !== '' ? `  ${typeof detail === 'string' ? detail : JSON.stringify(detail)}` : ''}`);
  if (!ok) failures++;
};
const wait = async (p: Page, expr: string, ms = 15_000) => p.until(expr, ms).then(() => true, () => false);
const shot = async (p: Page, name: string) => {
  if (!shots) return;
  await new Promise((r) => setTimeout(r, 400));
  await p.shot(join(shots, `${name}.png`));
};

const MEDIA = ['--use-fake-ui-for-media-stream', '--use-fake-device-for-media-stream', '--autoplay-policy=no-user-gesture-required'];
const room = await launch({ args: MEDIA });
const a = await launch({ args: MEDIA });
const b = await launch({ args: MEDIA });
const browsers = [room, a, b];

/** A device page as one demo account, in the stage's chat. */
async function device(p: Page, account: string) {
  await p.send('Runtime.enable');
  await p.size(1280, 800);
  await p.goto(hub);
  await p.eval(`localStorage.setItem('dither-chat:prefs', JSON.stringify({ ...JSON.parse(localStorage.getItem('dither-chat:prefs') || '{}'), callMode: 'bridge', sendAs: { ${JSON.stringify(stage.id)}: ${JSON.stringify(account)} } }))`);
  await p.goto(`${hub}/?calls=1#/inbox/c/${stage.id}`);
  await p.until(`!!document.querySelector('.call-join')`, 30_000);
}
const me = (p: Page) => p.eval<string | undefined>(`document.querySelector('.croom')?.dataset.me`);
const press = (p: Page, track: string) => p.eval(`document.querySelector('[data-track="${track}"]').click()`);
const text = (p: Page, sel: string) => p.eval<string>(`document.querySelector(${JSON.stringify(sel)})?.textContent ?? ''`);

try {
  await room.page.goto(`${hub}/demo/callroom.html`);
  check(await wait(room.page, `/Open/.test(document.getElementById('status').textContent)`), 'the call room connects to the hub');

  // ------------------------------------------------------------ the listener joins
  await device(b.page, ALT);
  await b.page.eval(`document.querySelector('.call-join').click()`);
  check(await wait(b.page, `!!document.querySelector('.croom') && !!document.querySelector('[data-call-connected]')`, 20_000), 'joining the stage opens the room');
  check(await wait(b.page, `!!document.querySelector('.call-dock')`, 2000), 'the dock is still there');
  check(await wait(b.page, `document.querySelectorAll('.croom-speakers [data-role=speaker]').length === 3`), 'three speakers', await b.page.eval(`document.querySelectorAll('.croom-speakers [data-role=speaker]').length`));
  check(/Office hours/.test(await text(b.page, '.croom-title b')), 'the topic is the title', await text(b.page, '.croom-title'));
  check(/3 speaking · 21 listening/.test(await text(b.page, '.croom-title span')), 'the counts', await text(b.page, '.croom-title span'));
  check(/Moderator/.test(await text(b.page, '.croom-speakers')) && /Speaker/.test(await text(b.page, '.croom-speakers')), 'speakers show Moderator and Speaker', await text(b.page, '.croom-speakers'));
  check(/^\+3/.test(await text(b.page, '.croom-more')), 'the audience shows "+N more"', await text(b.page, '.croom-more'));
  check((await me(b.page)) === 'audience' && (await b.page.eval(`document.querySelector('.croom-audience [data-role]')?.dataset.who`)) === altSelf, 'you listen, first in the audience');
  check(/Hands up · 2/.test(await text(b.page, '.croom-side')), 'hands up, for a listener', await text(b.page, '.croom-side h4'));
  check(await wait(b.page, `/slides are pinned/.test(document.querySelector('.croom-chat')?.textContent ?? '')`, 8000), "the channel's chat beside the room");
  check(await wait(b.page, `[...document.querySelectorAll('.croom-speakers .croom-av')].some((x) => x.classList.contains('speaking'))`, 8000), 'someone is ringed as speaking');
  await shot(b.page, 'listener');
  if (shots) {
    // The dock keeps its compact stage section (what a stage was before the room).
    await b.page.eval(`document.querySelector('.call-dock-title').click()`);
    await wait(b.page, `!!document.querySelector('.call-stage')`, 5000);
    await shot(b.page, 'dock');
    await b.page.eval(`document.querySelector('.call-dock-title').click()`);
  }

  // ------------------------------------------------------------ the moderator joins
  await device(a.page, MAIN);
  await a.page.eval(`document.querySelector('.call-join').click()`);
  check(await wait(a.page, `document.querySelector('.croom')?.dataset.moderator === '1'`, 20_000), 'the moderator joins, as a moderator');
  check(/Asking to speak · 2/.test(await text(a.page, '.croom-requests h4')), 'the moderator sees the requests', await text(a.page, '.croom-requests h4'));

  // ------------------------------------------------------------ a hand, an invite, speaking
  await press(b.page, 'stage raise hand');
  check(await wait(b.page, `document.querySelector('.croom')?.dataset.me === 'hand'`, 5000), 'the listener raises a hand', await me(b.page));
  await shot(b.page, 'hand-up');
  check(await wait(a.page, `!!document.querySelector('.croom-request[data-who="${altSelf}"] .croom-invite')`, 5000), "the moderator sees the listener's request");
  await shot(a.page, 'moderator');
  await a.page.eval(`document.querySelector('.croom-request[data-who="${altSelf}"] .croom-invite').click()`);
  check(await wait(b.page, `document.querySelector('.croom')?.dataset.me === 'invited'`, 5000), 'the listener is invited', await me(b.page));
  await press(b.page, 'stage speak');
  check(await wait(b.page, `document.querySelector('.croom')?.dataset.me === 'speaker'`, 5000), 'the invited speaks', await me(b.page));
  check(await wait(a.page, `!!document.querySelector('.croom-speakers [data-who="${altSelf}"]')`, 5000), 'the moderator sees them among the speakers');
  check(await wait(b.page, `!!document.querySelector('[data-track="room mic"]') && !!document.querySelector('[data-track="stage listen"]')`, 2000), "a speaker's buttons: the mic and Move to audience");
  await shot(b.page, 'speaker');

  // The moderator moves them back from their face's menu.
  await a.page.eval(`document.querySelector('.croom-speakers [data-who="${altSelf}"] .croom-person').click()`);
  check(await wait(a.page, `!!document.querySelector('[data-track="stage audience"]')`, 3000), "a moderator's tap on a speaker offers Move to the audience");
  await press(a.page, 'stage audience');
  check(await wait(b.page, `document.querySelector('.croom')?.dataset.me === 'audience'`, 5000), 'the moderator moves them to the audience', await me(b.page));

  // A simulated hand, invited, says yes.
  const hand = await a.page.eval<string>(`[...document.querySelectorAll('.croom-request')].map((r) => r.dataset.who).find((w) => w !== ${JSON.stringify(altSelf)})`);
  await a.page.eval(`document.querySelector('.croom-request[data-who="${hand}"] .croom-invite').click()`);
  check(await wait(a.page, `!!document.querySelector('.croom-speakers [data-who="${hand}"]')`, 6000), 'an invited person from the audience becomes a speaker');

  // ------------------------------------------------------------ Room / Chat
  await press(b.page, 'room switch chat');
  check(await wait(b.page, `!document.querySelector('.croom') && !!document.querySelector('.composer, [contenteditable], textarea')`, 5000), 'Chat shows the channel instead');
  await press(b.page, 'room switch room');
  check(await wait(b.page, `!!document.querySelector('.croom')`, 5000), 'Room brings the room back');

  // ------------------------------------------------------------ phone width
  if (shots) {
    await b.page.size(390, 844, true);
    await wait(b.page, `!!document.querySelector('.croom')`, 5000);
    await shot(b.page, 'phone');
    await b.page.size(1280, 800);
  }

  // ------------------------------------------------------------ leaving
  await press(b.page, 'room leave quietly');
  check(await wait(b.page, `!document.querySelector('.croom') && (window.__activeCall.value === null || window.__activeCall.value.phase === 'ended')`, 8000), 'Leave quietly ends the call and the room');
  await press(a.page, 'room leave quietly');
  check(await wait(room.page, `window.__room.summary().length === 0`, 8000), 'the far end lets go of both calls');

  for (const [n, x] of [['moderator', a], ['listener', b]] as const) check(x.page.errors.length === 0, `no page errors on the ${n}`, x.page.errors.slice(0, 3));
} finally {
  for (const x of browsers) await x.close().catch(() => {});
}
console.log(failures ? `\n${failures} failed` : '\nall passed');
process.exit(failures ? 1 : 0);
