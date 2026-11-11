/**
 * Per-device notification rules and the notification's look (docs/devices.md), end to end against a demo hub in
 * headless Chromium: the page says hello, Settings lists it, Off for a network on this device keeps that network's
 * alerts from its toasts while another network's still show, with the sender and network on them, and the service
 * worker draws the sender's picture with the network's badge. Only an alert shows on a page, so the two DMs it
 * writes to are set to Always alert first.
 *
 *   bun scripts/verify-devices.ts http://127.0.0.1:8481 [/tmp/shots]
 * The hub must be a fresh demo hub (--demo) with its own data dir: this sends messages and sets rules.
 */
import { mkdirSync } from 'node:fs';
import { launch } from './browser.ts';

const hub = process.argv[2] ?? 'http://127.0.0.1:8481';
const shots = process.argv[3];
if (shots) mkdirSync(shots, { recursive: true });
const origin = new URL(hub).origin;

const boot = (await fetch(`${hub}/api/bootstrap`).then((r) => r.json())) as any;
if (!boot.accounts.every((a: any) => a.demo)) throw new Error('not a demo hub');
const dm = (network: string) => boot.conversations.find((c: any) => c.shape === 'direct' && c.network === network)?.id;
const signalDm = dm('signal');
const discordDm = dm('discord');
if (!signalDm || !discordDm) throw new Error('the demo world has no Signal or Discord DM');
// A DM's answer is a Conversation, which shows nothing on a page: every message in these two is an alert.
for (const target of [signalDm, discordDm]) {
  const r = await fetch(`${hub}/api/rules`, { method: 'PUT', headers: { 'content-type': 'application/json', origin }, body: JSON.stringify({ scope: 'conversation', target, level: 'all' }) });
  if (!r.ok) throw new Error(`could not set a DM to always alert: ${r.status}`);
}

let failures = 0;
const check = (ok: unknown, what: string, detail: unknown = '') => {
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${what}${detail !== '' ? `  ${JSON.stringify(detail)}` : ''}`);
  if (!ok) failures++;
};
const devices = async () => ((await fetch(`${hub}/api/devices`).then((r) => r.json())) as any).devices as any[];

const { page: p, close } = await launch();
try {
  await p.size(1280, 900);
  // Every notify event the hub sends this page.
  const notifies: any[] = [];
  await p.send('Network.enable');
  p.on('Network.webSocketFrameReceived', (e) => {
    if (!e.response.payloadData.includes('"t":"notify"')) return;
    try {
      for (const ev of JSON.parse(e.response.payloadData)) if (ev.t === 'notify') notifies.push(ev);
    } catch {}
  });
  await p.send('Browser.grantPermissions', { origin, permissions: ['notifications'] });
  await p.goto(`${hub}/#/settings`);
  await p.until(`!!document.querySelector('.settings')`, 15000);
  await p.until(`navigator.serviceWorker.getRegistration().then((r) => !!r && !!r.active)`, 15000);
  const me = await p.eval<string>(`localStorage.getItem('dither-chat:device')`);
  await p.until(`fetch('/api/devices').then((r) => r.json()).then((d) => d.devices.some((x) => x.id === ${JSON.stringify(me)}))`, 10000);
  const mine = (await devices()).find((d) => d.id === me);
  check(mine, 'the page said hello', { label: mine?.label });
  await p.until(`!!document.querySelector('#set-devices .device-block')`, 5000);
  check(await p.eval(`document.querySelector('#set-devices .device-block').textContent.includes('this device')`), 'Settings lists this device');

  // Off for Signal, from Settings.
  await p.eval(`(() => {
    const row = [...document.querySelectorAll('#set-devices .device-block .set-rule')].find((r) => r.textContent.includes('Signal'));
    [...row.querySelectorAll('button')].find((b) => b.textContent.trim() === 'Off').click();
  })()`);
  await p.until(`fetch('/api/devices').then((r) => r.json()).then((d) => d.devices.find((x) => x.id === ${JSON.stringify(me)}).rules.some((r) => r.scope === 'network' && r.target === 'signal' && r.level === 'none'))`, 5000);
  check(true, 'Off for Signal on this device, from Settings');
  if (shots) {
    await p.eval(`document.getElementById('set-devices').scrollIntoView()`);
    await p.shot(`${shots}/devices-settings.png`);
  }

  // The demo's DM partners answer a few seconds after a message: Signal's answer stays quiet here, Discord's shows.
  const toasts = () => p.eval<{ title: string; img: string | null; badge: boolean }[]>(`[...document.querySelectorAll('.toast.notify')].map((t) => ({ title: t.querySelector('b')?.textContent, img: t.querySelector('.avatar img')?.getAttribute('src') ?? null, badge: !!t.querySelector('.avatar .net-badge') }))`);
  const send = (conv: string) => p.eval(`fetch('/api/conversations/${conv}/send', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ body: 'are you around?' }) }).then((r) => r.status)`);
  check((await send(signalDm)) === 200, 'sent to the Signal DM');
  // Its answer still comes to the page as a notification, marked quiet for this device, and shows nothing.
  await p.until(`false`, 9000).catch(() => {});
  const quietOne = notifies.find((n) => n.conversationId === signalDm);
  check(quietOne?.quiet?.includes(me) && !quietOne.level, 'the hub sent the Signal answer as an alert, marked quiet for this device', quietOne && { quiet: quietOne.quiet, network: quietOne.network, level: quietOne.level });
  const afterSignal = await toasts();
  check(afterSignal.length === 0, 'a Signal answer shows no toast on this device', afterSignal);
  await send(discordDm);
  await p.until(`document.querySelectorAll('.toast.notify').length > 0`, 12000).catch(() => {});
  const afterDiscord = await toasts();
  check(afterDiscord.length === 1 && afterDiscord[0].badge, 'a Discord answer still shows, with the sender and the network badge', afterDiscord);
  if (shots) await p.shot(`${shots}/devices-toast.png`);

  // Back to the shared rules: Signal shows again.
  await p.eval(`fetch('/api/devices/rules', { method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ device: ${JSON.stringify(me)}, scope: 'network', target: 'signal', level: null }) })`);
  await p.eval(`document.querySelectorAll('.toast.notify .toast-x').forEach((x) => x.click())`);
  await send(signalDm);
  await p.until(`document.querySelectorAll('.toast.notify').length > 0`, 12000).catch(() => {});
  check((await toasts()).length === 1, 'with the rule cleared, a Signal answer shows again');

  // The worker's drawing: a picture, round, with the network's badge; and the network's mark as the badge.
  const shown = await p.eval<{ icon: string; badge: string }[]>(`(async () => {
    const reg = await navigator.serviceWorker.ready;
    reg.active.postMessage({ t: 'notify', d: { title: 'Ana · Signal', body: 'hi', conversationId: 'cnv_look', network: 'signal', icon: '/icon-512.png' } });
    reg.active.postMessage({ t: 'notify', d: { title: 'Bo', body: 'hi', conversationId: 'cnv_letter', network: 'discord' } });
    for (let i = 0; i < 40; i++) {
      const ns = await reg.getNotifications();
      if (ns.length >= 2) return ns.map((n) => ({ tag: n.tag, icon: n.icon, badge: n.badge }));
      await new Promise((r) => setTimeout(r, 100));
    }
    return (await reg.getNotifications()).map((n) => ({ tag: n.tag, icon: n.icon, badge: n.badge }));
  })()`);
  check(shown.length === 2 && shown.every((n) => n.icon.startsWith('data:image/png') && n.badge.startsWith('data:image/png')), 'the worker drew both icons and badges', shown.map((n: any) => ({ tag: n.tag, icon: n.icon.slice(0, 22), badge: n.badge.slice(0, 22) })));
  if (shots) {
    // Side by side on a page, to look at.
    await p.eval(`(() => {
      const d = document.createElement('div');
      d.style.cssText = 'position:fixed;inset:0;z-index:99999;background:#888;display:flex;gap:24px;padding:24px;align-items:center';
      for (const n of ${JSON.stringify(shown)}) for (const src of [n.icon, n.badge]) { const i = new Image(); i.src = src; i.style.cssText = 'width:192px;height:192px;background:#333'; d.append(i); }
      document.body.append(d);
    })()`);
    await Bun.sleep(300);
    await p.shot(`${shots}/devices-icons.png`);
  }
  check(!p.errors.length, 'no page errors', p.errors);
} finally {
  await close();
}
console.log(failures ? `${failures} FAILED` : 'all ok');
process.exit(failures ? 1 : 0);
