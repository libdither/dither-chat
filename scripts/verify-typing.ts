/**
 * Typing indicators end to end against a demo hub, in headless Chromium (docs/typing.md): your typing reaching the
 * account that would send (and stopping on send), a DM's answer preceded by "is typing…", a group's several typers
 * worded as Discord words them, the line never moving the timeline, the dots on the inbox row, the privacy switch,
 * and the phone layout.
 *
 *   bun scripts/verify-typing.ts http://127.0.0.1:8611 /tmp/dither-typing
 * The hub must be a demo hub (--demo) with its own data dir: this sends messages.
 */
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { launch } from './browser.ts';

const hub = process.argv[2] ?? 'http://127.0.0.1:8611';
const shots = process.argv[3] ?? '/tmp/dither-typing';
mkdirSync(shots, { recursive: true });

const boot = (await fetch(`${hub}/api/bootstrap`).then((r) => r.json())) as any;
if (!boot.accounts.every((a: any) => a.demo)) throw new Error('not a demo hub');
const name = (id: string) => boot.identities.find((i: any) => i.id === id)?.displayName;
const direct = (net: string, peer: string) => boot.conversations.find((c: any) => c.network === net && c.shape === 'direct' && c.participantIds.some((p: string) => name(p) === peer));
const group = (net: string, title: string) => boot.conversations.find((c: any) => c.network === net && c.name?.startsWith(title));
const mom = direct('signal', 'Mom');
const family = group('signal', 'Family');
const climbing = group('signal', 'Climbing crew');
const general = boot.conversations.find((c: any) => c.network === 'discord' && c.name === 'general' && c.vantages.length === 2);
if (!mom || !family || !climbing || !general) throw new Error('demo world without the expected conversations');

const typingLog = async (account: string) =>
  ((await fetch(`${hub}/api/accounts/${account}/action`, { method: 'POST', headers: { 'content-type': 'application/json', origin: hub }, body: JSON.stringify({ action: 'typingLog' }) }).then((r) => r.json())) as any).result.typing as { conversation: string; stop: boolean }[];
const nativeOf = (c: any) => c.nativeId;

let failures = 0;
const check = (ok: unknown, what: string) => {
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${what}`);
  if (!ok) failures++;
};

const { page: p, close } = await launch();
await p.size(1280, 800);

const bar = () => p.eval<{ text: string; html: string; h: number; dots: number }>(`(() => { const b = document.querySelector('.typing-bar'); return b ? { text: b.textContent, html: b.innerHTML, h: b.getBoundingClientRect().height, dots: b.querySelectorAll('.typing-dots i').length } : null })()`);
const timelineBox = () => p.eval<{ top: number; h: number }>(`(() => { const r = document.querySelector('.timeline-scroll').getBoundingClientRect(); return { top: r.top, h: r.height } })()`);
const typeAndSend = async (text: string, send = true) => {
  await p.eval(`document.querySelector('.composer textarea').focus()`);
  await p.send('Input.insertText', { text });
  await Bun.sleep(300);
  if (send) {
    await p.send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13 });
    await p.send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13 });
    await Bun.sleep(300);
  }
};

// ------------------------------------------------------------------ a DM: out, then their answer
await p.goto(`${hub}/#/inbox/c/${mom.id}`);
await p.until(`document.querySelectorAll('.msg .msg-body').length > 0 && !!document.querySelector('.typing-bar')`, 15000);
const empty = await bar();
const before = await timelineBox();
check(empty && empty.text === '' && empty.h === 20, `an empty typing line keeps its place (${empty?.h}px)`);

const sig = mom.vantages[0].accountId;
const logBefore = (await typingLog(sig)).length;
await typeAndSend('see you sunday', false);
let log = (await typingLog(sig)).slice(logBefore);
check(log.length === 1 && log[0].conversation === nativeOf(mom) && !log[0].stop, 'typing in the composer starts typing on Signal, through the account that sends');
await p.send('Input.insertText', { text: '!' });
await Bun.sleep(300);
check((await typingLog(sig)).length === logBefore + 1, 'more keystrokes within 8 s send nothing more');
await p.send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13 });
await p.send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13 });
await Bun.sleep(400);
log = (await typingLog(sig)).slice(logBefore);
check(log.length === 2 && log[1].stop, 'sending stops it');

await p.until(`document.querySelector('.typing-bar').textContent.includes('is typing')`, 6000).catch(() => {});
const one = await bar();
check(one?.html.includes('<b>Mom</b>') && one.text === 'Mom is typing…' && one.dots === 3, `their answer is preceded by "${one?.text}", name bold, with the dots`);
const during = await timelineBox();
check(during.top === before.top && during.h === before.h, 'the timeline does not move when the line fills');
const row = await p.eval<boolean>(`!!document.querySelector('[data-row="${mom.id}"] .row-typing .typing-dots')`);
check(row, 'the inbox row shows the dots on its avatar');
await p.shot(join(shots, 'dm-typing.png'));
const rowShot = await p.eval<{ x: number; y: number; w: number; h: number } | null>(`(() => { const e = document.querySelector('[data-row="${mom.id}"]'); e?.scrollIntoView({ block: 'center' }); const r = e?.getBoundingClientRect(); return r ? { x: r.left, y: r.top, w: r.width, h: r.height } : null })()`);
if (rowShot) await p.send('Page.captureScreenshot', { format: 'png', clip: { x: rowShot.x, y: rowShot.y, width: rowShot.w, height: rowShot.h, scale: 2 } }).then((r: any) => Bun.write(join(shots, 'row-typing.png'), Buffer.from(r.data, 'base64')));
await p.until(`document.querySelector('.typing-bar').textContent === ''`, 8000).catch(() => {});
check((await bar())?.text === '', 'their message ends the line');
check(!(await p.eval<boolean>(`!!document.querySelector('[data-row="${mom.id}"] .row-typing')`)), 'and the row dots');

// ------------------------------------------------------------------ groups: several typers
await p.goto(`${hub}/#/inbox/c/${family.id}`);
await p.until(`!!document.querySelector('.composer textarea')`, 10000);
await typeAndSend('dinner at 7?');
await p.until(`/, .+ and .+ are typing/.test(document.querySelector('.typing-bar').textContent)`, 6000).catch(() => {});
const three = await bar();
check(/^[^,]+, [^,]+ and [^,]+ are typing…$/.test(three?.text ?? '') && (three?.html.match(/<b>/g) ?? []).length === 3, `three in a group: "${three?.text}"`);
await p.shot(join(shots, 'group-three.png'));
await p.until(`document.querySelector('.typing-bar').textContent === ''`, 12000).catch(() => {});
check((await bar())?.text === '', 'their stops clear the line');

await p.goto(`${hub}/#/inbox/c/${climbing.id}`);
await p.until(`!!document.querySelector('.composer textarea')`, 10000);
await typeAndSend('who is in for saturday?');
await p.until(`document.querySelector('.typing-bar').textContent.includes('Several')`, 6000).catch(() => {});
check((await bar())?.text === 'Several people are typing…', 'four or more: "Several people are typing…"');
await p.shot(join(shots, 'group-several.png'));

// ------------------------------------------------------------------ the send-as choice
const alt = general.vantages.find((v: any) => v.accountId.includes('alt')).accountId;
await p.eval(`(() => { const k = 'dither-chat:prefs'; const v = JSON.parse(localStorage.getItem(k) || '{}'); v.sendAs = { ...(v.sendAs || {}), ${JSON.stringify(general.id)}: ${JSON.stringify(alt)} }; localStorage.setItem(k, JSON.stringify(v)); })()`);
const space = general.spaceIds[0];
await p.goto(`${hub}/#/s/${space}/c/${general.id}`);
await p.eval(`location.reload()`);
await Bun.sleep(500);
await p.until(`!!document.querySelector('.composer textarea')`, 10000);
const altBefore = (await typingLog(alt)).length;
const mainBefore = (await typingLog(general.vantages.find((v: any) => v.accountId !== alt).accountId)).length;
await typeAndSend('brb', false);
await p.eval(`document.querySelector('.composer textarea').blur()`);
await Bun.sleep(400);
const altLog = (await typingLog(alt)).slice(altBefore);
check(altLog.length === 2 && !altLog[0].stop && altLog[1].stop, 'typing goes through the chosen send-as account, and leaving the composer stops it');
check((await typingLog(general.vantages.find((v: any) => v.accountId !== alt).accountId)).length === mainBefore, 'the other account says nothing');

// ------------------------------------------------------------------ privacy
await p.goto(`${hub}/#/settings`);
await p.until(`!!document.querySelector('#set-privacy input:not([disabled])')`, 10000);
await p.eval(`document.querySelector('#set-privacy').scrollIntoView({ block: 'center' })`);
await p.shot(join(shots, 'settings-privacy.png'));
await p.eval(`document.querySelector('#set-privacy input').click()`);
await Bun.sleep(400);
check((await fetch(`${hub}/api/privacy`).then((r) => r.json())).shareTyping === false, 'the switch turns sharing off on the hub');
await p.goto(`${hub}/#/inbox/c/${mom.id}`);
await p.until(`!!document.querySelector('.composer textarea')`, 10000);
const offBefore = (await typingLog(sig)).length;
await typeAndSend('quietly', false);
await Bun.sleep(300);
check((await typingLog(sig)).length === offBefore, 'with it off, typing tells nobody');
await p.eval(`(() => { const t = document.querySelector('.composer textarea'); t.value = ''; t.dispatchEvent(new Event('input', { bubbles: true })); })()`);
await fetch(`${hub}/api/privacy`, { method: 'PUT', headers: { 'content-type': 'application/json', origin: hub }, body: JSON.stringify({ shareTyping: true }) });

// ------------------------------------------------------------------ phone
await p.size(390, 844, true);
await p.goto(`${hub}/#/inbox/c/${mom.id}`);
await p.until(`!!document.querySelector('.composer textarea') && document.querySelectorAll('.msg .msg-body').length > 0`, 15000);
// A phone keyboard's Enter is a new line: the button sends.
await typeAndSend('ok!', false);
await p.eval(`document.querySelector('.send-btn').click()`);
await p.until(`document.querySelector('.typing-bar').textContent.includes('is typing')`, 6000).catch(() => {});
check((await bar())?.text === 'Mom is typing…', 'the phone layout shows the line too');
await p.shot(join(shots, 'phone-typing.png'));

await close();
console.log(failures ? `\n${failures} failed` : '\nall passed');
process.exit(failures ? 1 : 0);
