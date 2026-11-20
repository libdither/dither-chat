/**
 * A stage end to end on a demo hub (docs/calls.md "Demo calls", "The room view"): two devices in headless Chromium, as
 * the demo's two Discord accounts, on the libdither server's stage, and the demo call room in a third browser as the
 * far end of both. The main account moderates the stage. Checks, through the app's own buttons:
 *
 * - joining a stage opens the room beside the channel's real chat on a wide pane, with no Room / Chat switch there;
 * - the zones: the topic and counts, speakers with their ranks, who asks to speak, the audience with "+N more";
 * - a listener has no microphone open (the browser was never asked), no camera or screen, and one Leave on screen;
 * - "+N more" opens the whole audience, searchable; a moderator invites from it;
 * - a moderator gets Speak and no Ask to speak, sees the requests oldest first, and faces that open a menu;
 * - the listener asks to speak; the moderator invites; "You're invited to speak" is said; Speak opens the microphone;
 *   the moderator moves them back from their face's menu, and the microphone closes;
 * - a simulated hand, invited, becomes a speaker;
 * - on a narrow pane: Room / Chat, one of them at a time, the requests' count on Room for a moderator, the requests
 *   above the audience, one Leave on screen either way; a call left from Chat opens as a room next time;
 * - Leave quietly ends the call; no page errors.
 *
 *   bun packages/hub/src/main.ts --demo --data /tmp/x --port 8579 --web packages/web/dist
 *   bun scripts/verify-stage-demo.ts http://127.0.0.1:8579 [screenshot dir]
 *
 * Use a fresh demo world each run. With a screenshot dir it saves the room listening (beside the chat), with a hand up,
 * invited, speaking, as the moderator with requests, the whole audience, and at phone width (the room, the chat).
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
  // The demo world's own notices stay out of the picture; the ring's fade and a menu's opening settle before it.
  await p.eval(`document.querySelector('.toasts')?.style.setProperty('display', 'none')`);
  await p.eval(`new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)))`);
  await p.shot(join(shots, `${name}.png`));
};

/**
 * Every microphone the page asks the browser for, watched from before the app loads: how many it asked for, and how
 * many are open now (an audio track not stopped).
 */
const MIC_WATCH = `(() => {
  const md = navigator.mediaDevices;
  if (!md) return;
  const real = md.getUserMedia.bind(md);
  const asked = [];
  window.__mics = { asked, open: () => asked.filter((s) => s.getAudioTracks().some((t) => t.readyState === 'live')).length };
  md.getUserMedia = async (c) => {
    const s = await real(c);
    if (c && c.audio) asked.push(s);
    return s;
  };
})()`;
const micsAsked = (p: Page) => p.eval<number>(`window.__mics.asked.length`);
const micsOpen = (p: Page) => p.eval<number>(`window.__mics.open()`);

/** Buttons that leave the call, as they show now (a hidden one does not count). */
const LEAVES = `[...document.querySelectorAll('button')].filter((b) => /^Leave/.test(b.getAttribute('aria-label') ?? b.textContent.trim()) && b.getClientRects().length > 0).length`;
const shown = (sel: string) => `(() => { const e = document.querySelector(${JSON.stringify(sel)}); return !!e && e.getClientRects().length > 0; })()`;

const MEDIA = ['--use-fake-ui-for-media-stream', '--use-fake-device-for-media-stream', '--autoplay-policy=no-user-gesture-required'];
const room = await launch({ args: MEDIA });
const a = await launch({ args: MEDIA });
const b = await launch({ args: MEDIA });
const browsers = [room, a, b];

/** A device page as one demo account, in the stage's chat. */
async function device(p: Page, account: string) {
  await p.send('Runtime.enable');
  await p.send('Page.enable');
  await p.send('Page.addScriptToEvaluateOnNewDocument', { source: MIC_WATCH });
  await p.size(1280, 800);
  await p.goto(hub);
  await p.eval(`localStorage.setItem('dither-chat:prefs', JSON.stringify({ ...JSON.parse(localStorage.getItem('dither-chat:prefs') || '{}'), callMode: 'bridge', sendAs: { ${JSON.stringify(stage.id)}: ${JSON.stringify(account)} } }))`);
  await p.goto(`${hub}/?calls=1#/inbox/c/${stage.id}`);
  await p.until(`!!document.querySelector('.call-join')`, 30_000);
}
const me = (p: Page) => p.eval<string | undefined>(`document.querySelector('.croom')?.dataset.me`);
const press = (p: Page, sel: string) => p.eval(`document.querySelector(${JSON.stringify(sel)}).click()`);
const text = (p: Page, sel: string) => p.eval<string>(`document.querySelector(${JSON.stringify(sel)})?.textContent ?? ''`);
const search = (p: Page, q: string) => p.eval(`(() => { const i = document.querySelector('.croom-search'); i.value = ${JSON.stringify(q)}; i.dispatchEvent(new Event('input', { bubbles: true })); })()`);
const join_ = (p: Page) => press(p, '.call-join');

try {
  await room.page.goto(`${hub}/demo/callroom.html`);
  check(await wait(room.page, `/Open/.test(document.getElementById('status').textContent)`), 'the call room connects to the hub');

  // ------------------------------------------------------------ the listener joins, on a wide pane
  await device(b.page, ALT);
  await join_(b.page);
  check(await wait(b.page, `!!document.querySelector('.croom') && !!document.querySelector('[data-call-connected]')`, 20_000), 'joining the stage opens the room');
  check(await wait(b.page, `${shown('.room-chat')} && /slides are pinned/.test(document.querySelector('.room-chat').textContent) && !!document.querySelector('.room-chat .composer, .room-chat [contenteditable], .room-chat textarea')`, 8000), "the channel's real chat and its composer beside the room");
  check(!(await b.page.eval<boolean>(shown('.room-switch'))), 'no Room / Chat switch on a wide pane');
  check(await wait(b.page, `document.querySelectorAll('.croom-speakers [data-role=speaker]').length === 3`), 'three speakers', await b.page.eval(`document.querySelectorAll('.croom-speakers [data-role=speaker]').length`));
  check(/Office hours/.test(await text(b.page, '.croom-title b')), 'the topic is the title', await text(b.page, '.croom-title'));
  check(/3 speakers · 21 listening/.test(await text(b.page, '.croom-title span')), 'the counts', await text(b.page, '.croom-title span'));
  check(/Moderator/.test(await text(b.page, '.croom-speakers')) && /Speaker/.test(await text(b.page, '.croom-speakers')), 'speakers show Moderator and Speaker', await text(b.page, '.croom-speakers'));
  check(/^\+3/.test(await text(b.page, '.croom-more')), 'the audience shows "+N more"', await text(b.page, '.croom-more'));
  check((await me(b.page)) === 'audience' && (await b.page.eval(`document.querySelector('.croom-audience [data-who]')?.dataset.who`)) === altSelf, 'you listen, first in the audience');
  check(/Hands up · 2/.test(await text(b.page, '.croom-requests h4')) && /Calla/.test(await text(b.page, '.croom-requests')), 'hands up by name, for a listener', await text(b.page, '.croom-requests'));
  check((await b.page.eval<number>(`document.querySelectorAll('.croom button.croom-person').length`)) === 0, "a listener's faces are not buttons (nothing to do to them)");
  check(await wait(b.page, `[...document.querySelectorAll('.croom-speakers .call-av')].some((x) => x.classList.contains('speaking'))`, 8000), 'someone is ringed as speaking');
  check((await micsAsked(b.page)) === 0 && (await micsOpen(b.page)) === 0, 'listening, no microphone was asked for or is open', { asked: await micsAsked(b.page), open: await micsOpen(b.page) });
  check(!(await b.page.eval<boolean>(`!!document.querySelector('.call-btn.camera, .call-btn.share, .call-btn.mic')`)), 'a listener has no microphone, camera or screen button');
  check((await b.page.eval<number>(LEAVES)) === 1, 'one Leave on screen (wide)', await b.page.eval(LEAVES));
  check(!(await b.page.eval<boolean>(`!!document.querySelector('.call-dock-buttons')`)), "the dock leaves out the room's buttons");
  await shot(b.page, 'listening');

  // The whole audience, searchable.
  await press(b.page, '.croom-more');
  check(await wait(b.page, `!!document.querySelector('.croom-all') && document.activeElement === document.querySelector('.croom-search')`, 3000), '"+N more" opens everyone listening, the search focused');
  check((await b.page.eval<number>(`document.querySelectorAll('.croom-all-row').length`)) === 21, 'all 21 listening are in it', await b.page.eval(`document.querySelectorAll('.croom-all-row').length`));
  await search(b.page, 'ves');
  check(await wait(b.page, `[...document.querySelectorAll('.croom-all-row .croom-name')].map((x) => x.textContent).join() === 'Vesna'`, 3000), 'a search finds one person', await b.page.eval(`[...document.querySelectorAll('.croom-all-row .croom-name')].map((x) => x.textContent)`));
  check(!(await b.page.eval<boolean>(`!!document.querySelector('.croom-all .croom-invite')`)), 'a listener gets no Invite in it');
  await b.page.eval(`document.querySelector('.croom-search').dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))`);
  check(await wait(b.page, `!document.querySelector('.croom-all') && !!document.querySelector('.croom-audience')`, 3000), 'Esc closes it');

  // ------------------------------------------------------------ the moderator joins
  await device(a.page, MAIN);
  await join_(a.page);
  check(await wait(a.page, `document.querySelector('.croom')?.dataset.moderator === '1'`, 20_000), 'the moderator joins, as a moderator');
  check(/Asking to speak · 2/.test(await text(a.page, '.croom-requests h4')), 'the moderator sees the requests', await text(a.page, '.croom-requests h4'));
  check(await wait(a.page, `!!document.querySelector('[data-track="stage speak"]') && !document.querySelector('[data-track="stage raise hand"]')`, 3000), 'a moderator listening gets Speak, and no Ask to speak');
  check((await a.page.eval<number>(`document.querySelectorAll('.croom-speakers button.croom-person[aria-haspopup=menu]').length`)) >= 2, "a moderator's faces open a menu");
  check((await micsAsked(a.page)) === 0, 'the moderator listening has no microphone either');

  // ------------------------------------------------------------ a hand, an invite, speaking
  await press(b.page, '[data-track="stage raise hand"]');
  check(await wait(b.page, `document.querySelector('.croom')?.dataset.me === 'hand'`, 5000), 'the listener raises a hand', await me(b.page));
  await shot(b.page, 'hand-up');
  check(await wait(a.page, `[...document.querySelectorAll('.croom-request')].at(-1)?.dataset.who === ${JSON.stringify(altSelf)}`, 5000), "the listener's request comes last: oldest first", await a.page.eval(`[...document.querySelectorAll('.croom-request .croom-name')].map((x) => x.textContent)`));
  await shot(a.page, 'moderator');
  await press(a.page, `.croom-request[data-who="${altSelf}"] .croom-invite`);
  check(await wait(b.page, `document.querySelector('.croom')?.dataset.me === 'invited'`, 5000), 'the listener is invited', await me(b.page));
  check(/invited to speak/.test(await text(b.page, '.croom-controls [role=status]')), '"You\'re invited to speak" is said aloud (role=status)', await text(b.page, '.croom-controls [role=status]'));
  check((await micsOpen(b.page)) === 0, 'invited, still no microphone open');
  await shot(b.page, 'invited');
  await press(b.page, '[data-track="stage speak"]');
  check(await wait(b.page, `document.querySelector('.croom')?.dataset.me === 'speaker'`, 5000), 'the invited speaks', await me(b.page));
  check(await wait(b.page, `window.__mics.open() === 1`, 5000), 'speaking opens the microphone', await micsOpen(b.page));
  check(await wait(a.page, `!!document.querySelector('.croom-speakers [data-who="${altSelf}"]')`, 5000), 'the moderator sees them among the speakers');
  check(await wait(b.page, `!!document.querySelector('.croom-controls .call-btn.mic') && !!document.querySelector('[data-track="stage listen"]')`, 2000), "a speaker's buttons: the mic and Move to the audience");
  check((await b.page.eval<number>(LEAVES)) === 1, 'one Leave on screen as a speaker');
  await shot(b.page, 'speaking');

  // The moderator moves them back from their face's menu; their microphone closes.
  await press(a.page, `.croom-speakers [data-who="${altSelf}"] .croom-person`);
  check(await wait(a.page, `!!document.querySelector('[data-track="stage audience"]')`, 3000), "a moderator's tap on a speaker offers Move to the audience");
  await press(a.page, '[data-track="stage audience"]');
  check(await wait(b.page, `document.querySelector('.croom')?.dataset.me === 'audience'`, 5000), 'the moderator moves them to the audience', await me(b.page));
  check(await wait(b.page, `window.__mics.open() === 0`, 5000), 'back in the audience, the microphone closes', await micsOpen(b.page));

  // A simulated hand, invited, says yes.
  const hand = await a.page.eval<string>(`[...document.querySelectorAll('.croom-request')].map((r) => r.dataset.who).find((w) => w !== ${JSON.stringify(altSelf)})`);
  await press(a.page, `.croom-request[data-who="${hand}"] .croom-invite`);
  check(await wait(a.page, `!!document.querySelector('.croom-speakers [data-who="${hand}"]')`, 6000), 'an invited person with a hand up becomes a speaker');

  // A moderator invites from the whole audience.
  await press(a.page, '.croom-more');
  await wait(a.page, `!!document.querySelector('.croom-all')`, 3000);
  await search(a.page, 'odile');
  check(await wait(a.page, `document.querySelectorAll('.croom-all-row .croom-invite').length === 1`, 3000), 'the whole audience has Invite for a moderator');
  await shot(a.page, 'audience-list');
  const odile = await a.page.eval<string>(`document.querySelector('.croom-all-row').dataset.who`);
  await press(a.page, '.croom-all-row .croom-invite');
  check(await wait(a.page, `!!document.querySelector('.croom-speakers [data-who="${odile}"]')`, 6000), 'invited from the list, they become a speaker');
  await press(a.page, '.croom-all-head .chip-btn');

  // ------------------------------------------------------------ a narrow pane: the moderator
  await press(b.page, '[data-track="stage raise hand"]');
  await a.page.size(390, 844, true);
  check(await wait(a.page, `${shown('.room-switch')} && ${shown('.croom')} && !${shown('.room-chat')}`, 5000), 'narrow: Room / Chat, the room showing');
  check(await wait(a.page, `document.querySelector('.room-switch-count')?.textContent === '2'`, 5000), "the Room tab counts the requests", await text(a.page, '.room-switch-count'));
  check(await a.page.eval<boolean>(`(() => { const r = document.querySelector('.croom-requests'), au = document.querySelector('.croom-audience'); return !!r && !!au && !!(r.compareDocumentPosition(au) & Node.DOCUMENT_POSITION_FOLLOWING) && r.getBoundingClientRect().top < au.getBoundingClientRect().top; })()`), 'narrow: the requests sit above the audience');
  check((await a.page.eval<number>(LEAVES)) === 1, 'one Leave on screen (narrow, room)', await a.page.eval(LEAVES));
  await press(a.page, '[data-track="room switch chat"]');
  check(await wait(a.page, `!${shown('.croom')} && ${shown('.room-chat')}`, 5000), 'Chat shows the channel instead');
  check(await wait(a.page, `${LEAVES} === 1 && !!document.querySelector('.call-dock-buttons')`, 3000), 'one Leave on screen (narrow, chat): the dock has it back', await a.page.eval(LEAVES));
  await press(a.page, '[data-track="room switch room"]');
  check(await wait(a.page, `${shown('.croom')}`, 5000), 'Room brings the room back');

  // ------------------------------------------------------------ the listener on a phone
  await b.page.size(390, 844, true);
  check(await wait(b.page, `${shown('.croom')} && (${LEAVES}) === 1`, 5000), 'phone: the room, one Leave');
  await shot(b.page, 'phone');
  await press(b.page, '[data-track="room switch chat"]');
  check(await wait(b.page, `${shown('.room-chat')} && (${LEAVES}) === 1`, 5000), 'phone: the chat, one Leave');
  await shot(b.page, 'phone-chat');
  // Left from Chat, the next join opens as a room again.
  await press(b.page, '.call-dock-buttons .call-btn.leave');
  check(await wait(b.page, `!document.querySelector('.croom') && (window.__activeCall.value === null || window.__activeCall.value.phase === 'ended')`, 8000), 'the dock\'s Leave ends the call');
  check(await wait(b.page, `window.__mics.open() === 0`, 3000), 'no microphone open after leaving');
  await wait(b.page, `!!document.querySelector('.call-join')`, 8000);
  await join_(b.page);
  check(await wait(b.page, `${shown('.croom')} && document.querySelector('.room-split')?.dataset.show === 'room'`, 20_000), 'joining again opens the room, not the chat it was left on');

  // ------------------------------------------------------------ leaving
  await press(b.page, '.croom-controls .call-btn.leave');
  check(await wait(b.page, `!document.querySelector('.croom') && (window.__activeCall.value === null || window.__activeCall.value.phase === 'ended')`, 8000), 'Leave quietly ends the call and the room');
  await a.page.size(1280, 800);
  await wait(a.page, `${shown('.croom-controls .call-btn.leave')}`, 3000);
  await press(a.page, '.croom-controls .call-btn.leave');
  check(await wait(room.page, `window.__room.summary().length === 0`, 8000), 'the far end lets go of both calls');

  for (const [n, x] of [['moderator', a], ['listener', b]] as const) check(x.page.errors.length === 0, `no page errors on the ${n}`, x.page.errors.slice(0, 3));
} finally {
  for (const x of browsers) await x.close().catch(() => {});
}
console.log(failures ? `\n${failures} failed` : '\nall passed');
process.exit(failures ? 1 : 0);
