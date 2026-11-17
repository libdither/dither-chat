/**
 * One call between two accounts of the same hub, each on a device of its own: a computer (the web app in headless
 * Chromium with a fake microphone) or the phone (the Android app on an emulator, through android-device.ts). In a DM
 * or group DM the caller presses Call and the callee answers its ring: the ring card on a computer, Android's call
 * notification on the phone with the app in the background. In a voice channel both join. Then: both live, each sees
 * the other, a computer hears the far end, the phone hears a computer; the caller hangs up (on the phone from the
 * call notification), the callee leaves, and the hub has the call over.
 *
 *   bun scripts/verify-call-pair.ts <hub> --conversation <cnv> --caller <account>@computer|phone
 *     --callee <account>@computer|phone [--mode bridge|direct] [--callee-mode bridge|direct] [--seconds 15]
 *     [--login <hub password>] [--token-file <api token>] [--wav-caller f.wav] [--wav-callee f.wav]
 *     [--serial emulator-5580] [--package org.libdither.chat.verify]
 *
 * Only for a hub whose accounts are test accounts: it rings and joins for real. The phone end needs the debug app
 * installed (verify-android-call.ts installs it) and a UnifiedPush distributor on the emulator that reaches the hub's
 * push relay, for the ring. `--mode` is the caller's way of calling (docs/calls.md), `--callee-mode` the callee's.
 */
import { androidDevice } from './android-device.ts';
import { launch } from './browser.ts';

const args = process.argv.slice(2);
const opt = (name: string, d?: string) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 ? args[i + 1] : d;
};
const hub = (args.find((a, i) => !a.startsWith('--') && !args[i - 1]?.startsWith('--')) ?? '').replace(/\/$/, '');
const conversation = opt('conversation');
const [callerAcc, callerOn] = (opt('caller') ?? '').split('@');
const [calleeAcc, calleeOn] = (opt('callee') ?? '').split('@');
if (!hub || !conversation || !callerAcc || !calleeAcc) throw new Error('usage: bun scripts/verify-call-pair.ts <hub> --conversation <cnv> --caller <acc>@computer|phone --callee <acc>@computer|phone');
if (callerOn === 'phone' && calleeOn === 'phone') throw new Error('one end at most on the phone');
const modes = { caller: opt('mode', 'bridge')!, callee: opt('callee-mode', opt('mode', 'bridge'))! };
const SECONDS = Number(opt('seconds', '15'));
const LOGIN = opt('login');
const TOKEN = opt('token-file') ? (await Bun.file(opt('token-file')!).text()).trim() : null;
const api = (path: string, init: RequestInit = {}) => fetch(`${hub}${path}`, { ...init, headers: { ...(TOKEN ? { authorization: `Bearer ${TOKEN}` } : {}), 'content-type': 'application/json', ...(init.headers ?? {}) } }).then((r) => r.json()) as Promise<any>;

const t0 = Date.now();
const log = (...a: unknown[]) => console.log(`${((Date.now() - t0) / 1000).toFixed(1).padStart(6)}s`, ...a);
let failures = 0;
const check = (ok: unknown, what: string, detail: unknown = '') => {
  log(`${ok ? 'ok  ' : 'FAIL'} ${what}${detail !== '' ? `  ${typeof detail === 'string' ? detail : JSON.stringify(detail)}` : ''}`);
  if (!ok) failures++;
  return !!ok;
};

const boot = await api('/api/bootstrap');
const conv = boot.conversations?.find((c: any) => c.id === conversation);
if (!conv) throw new Error(`no conversation ${conversation} on ${hub} (signed in? pass --token-file)`);
const rings = conv.shape === 'direct' || conv.shape === 'group';
log(`${conv.network} ${conv.shape}/${conv.variant}: ${rings ? 'the callee is rung' : 'both join'}; caller ${callerAcc} on the ${callerOn} (${modes.caller}), callee ${calleeAcc} on the ${calleeOn} (${modes.callee})`);

/** What a device's page says of its call: the same on a computer and the phone. */
const SNAP = `(() => { const a = window.__activeCall?.value; const s = a?.stats ?? {}; return a ? { phase: a.phase, mode: a.mode, conversationId: a.conversationId, accountId: a.accountId, connected: a.self ? !!a.self.connected : null, people: a.participants?.length ?? 0, muted: a.muted, listenOnly: !!a.listenOnly, timing: a.timing, inLevel: s.inLevel ?? null, received: s.received ?? 0, stats: !!a.stats, note: a.note ?? null } : null; })()`;
const PCS = `Promise.all((window.__pcs ?? []).map(async (pc) => { const types = {}; (await pc.getStats()).forEach((r) => { types[r.type] = (types[r.type] ?? 0) + 1; }); return { ice: pc.iceConnectionState, conn: pc.connectionState, sdpRemote: (pc.remoteDescription?.sdp ?? '').split('\\r\\n').filter((l) => l.startsWith('a=candidate')).map((l) => l.split(' ').slice(4, 8).join(' ')), types }; }))`;
const prefsFor = (acc: string, mode: string) =>
  `localStorage.setItem('dither-chat:prefs', JSON.stringify({ ...JSON.parse(localStorage.getItem('dither-chat:prefs') || '{}'), callMode: ${JSON.stringify(mode)}, sendAs: { ${JSON.stringify(conversation)}: ${JSON.stringify(acc)} } }))`;

interface Device {
  name: string;
  on: 'computer' | 'phone';
  eval<T = any>(expr: string): Promise<T | null>;
  until(expr: string, ms: number): Promise<boolean>;
  close(): Promise<void>;
}

async function computer(name: string, acc: string, mode: string, wav?: string): Promise<Device> {
  const b = await launch({ args: ['--use-fake-ui-for-media-stream', '--use-fake-device-for-media-stream', '--autoplay-policy=no-user-gesture-required', ...(wav ? [`--use-file-for-fake-audio-capture=${wav}`] : [])] });
  await b.page.goto(hub);
  if (LOGIN) await b.page.eval(`fetch('/api/login', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ password: ${JSON.stringify(LOGIN)} }) }).then(() => true)`);
  await b.page.eval(prefsFor(acc, mode));
  await b.page.goto(`${hub}/?calls=1#/inbox/c/${conversation}`);
  const d: Device = {
    name,
    on: 'computer',
    eval: (e) => b.page.eval(e).catch(() => null) as any,
    until: (e, ms) => b.page.until(e, ms).then(() => true, () => false),
    close: () => b.close(),
  };
  check(await d.until(`!!document.querySelector('.call-join')`, 60_000), `${name}: the computer opens the chat with its Call button`);
  return d;
}

const phone = callerOn === 'phone' || calleeOn === 'phone' ? androidDevice({ serial: opt('serial', process.env.ANDROID_SERIAL ?? 'emulator-5580')!, pkg: opt('package', 'org.libdither.chat.verify')!, hub }) : null;
async function onPhone(name: string, acc: string, mode: string): Promise<Device> {
  const p = phone!;
  await p.freshApp(LOGIN);
  p.sh(`pm grant ${p.pkg} android.permission.RECORD_AUDIO; pm grant ${p.pkg} android.permission.POST_NOTIFICATIONS`);
  await p.until(`document.querySelector('#app > .app')`, 60_000);
  // Push through the emulator's distributor, for the ring.
  const before = (await api('/api/push')).devices?.length ?? 0;
  await p.page(`(window.DitherAndroid.postMessage(JSON.stringify({ t: 'push.register', vapid: ${JSON.stringify((await api('/api/push')).publicKey)} })), true)`);
  check(await hostWait(async () => ((await api('/api/push')).devices?.length ?? 0) > before, 30_000), `${name}: the phone registers for push`);
  await p.page(`(${prefsFor(acc, mode)}, location.href = '/?calls=1#/inbox/c/${conversation}', true)`);
  await p.attach();
  const d: Device = { name, on: 'phone', eval: (e) => p.page(e), until: (e, ms) => p.until(e, ms), close: async () => void p.sh(`am force-stop ${p.pkg}`) };
  check(await d.until(`!!document.querySelector('.call-join')`, 60_000), `${name}: the phone opens the chat with its Call button`);
  return d;
}

/** Polls a check on this side (the hub's API) until it holds. */
async function hostWait(fn: () => Promise<boolean>, ms: number): Promise<boolean> {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (await fn().catch(() => false)) return true;
    await Bun.sleep(500);
  }
  return false;
}
const live = (d: Device) => d.until(`window.__activeCall?.value?.phase === 'live' && (!window.__activeCall.value.self || window.__activeCall.value.self.connected)`, 45_000);
const devices: Device[] = [];
try {
  const caller = callerOn === 'phone' ? await onPhone('caller', callerAcc, modes.caller) : await computer('caller', callerAcc, modes.caller, opt('wav-caller'));
  devices.push(caller);
  const callee = calleeOn === 'phone' ? await onPhone('callee', calleeAcc, modes.callee) : await computer('callee', calleeAcc, modes.callee, opt('wav-callee'));
  devices.push(callee);
  // Keeps each page's peer connections, so a failed hearing check can say how far the connection got.
  for (const d of devices) await d.eval(`(window.__pcs = [], window.RTCPeerConnection = class extends RTCPeerConnection { constructor(...a) { super(...a); window.__pcs.push(this); } }, true)`);
  // A phone that rings is away, as a phone in a pocket is: its ring comes as a notification.
  if (rings && callee.on === 'phone') phone!.sh('input keyevent KEYCODE_HOME');

  log('caller presses Call');
  await caller.eval(`(document.querySelector('.call-join').click(), true)`);
  check(await live(caller), 'the caller is in the call', await caller.eval(SNAP));
  check((await caller.eval(SNAP))?.accountId === callerAcc, 'the caller calls from the account asked for', (await caller.eval(SNAP))?.accountId);

  let callId = '';
  if (rings) {
    const rung = await hostWait(async () => {
      const calls = ((await api(`/api/calls/ringing?conversation=${conversation}`)).calls ?? []) as any[];
      callId = calls.find((c) => c.ringing && c.accountId === calleeAcc)?.id ?? '';
      return !!callId;
    }, 30_000);
    check(rung, 'the network rings the callee', callId);
    if (callee.on === 'phone') {
      const p = phone!;
      const n = await p.poll(() => p.notification(`call:${callId}`), 20_000);
      check(n?.channel === 'rings' && n.actions.includes('Answer'), 'the phone rings, with Answer', n);
      check(p.pressInShade('Answer'), 'Answer is pressed on the phone');
      p.closeShade();
      await p.attach();
    } else {
      check(await callee.until(`!!document.querySelector('[data-call="${callId}"] [data-track="answer call"]')`, 20_000), 'the computer shows the ring card');
      await callee.eval(`(document.querySelector('[data-call="${callId}"] [data-track="answer call"]').click(), true)`);
    }
  } else {
    await callee.eval(`(document.querySelector('.call-join').click(), true)`);
  }
  check(await live(callee), 'the callee is in the call', await callee.eval(SNAP));
  for (const d of devices) {
    const ok = await d.until(`(window.__activeCall?.value?.participants?.length ?? 0) >= 2`, 20_000);
    check(ok, `the ${d.name} sees the other in the call`, await d.eval(SNAP));
  }
  if (rings) check((await api(`/api/calls/ringing?conversation=${conversation}`)).calls?.find((c: any) => c.id === callId)?.ringing === false, 'the ring stopped on the network', callId);

  // The call's details (its stats among them) show with the dock open.
  // Hearing: the far end's sound, sampled for a while on each device that has a sound to hear (an emulator's
  // microphone is silent, so a computer is not asked to hear the phone). The phone has no audio device either, and
  // WebRTC measures loudness only of sound it plays, so on the phone hearing is the far end's audio arriving: the
  // app marked its first audio and bytes keep coming at a voice call's rate.
  const levels: Record<string, number[]> = { caller: [], callee: [] };
  const bytes: Record<string, number[]> = { caller: [], callee: [] };
  const end = Date.now() + SECONDS * 1000;
  while (Date.now() < end) {
    await Bun.sleep(2500);
    for (const d of devices) {
      const s = await d.eval(SNAP);
      levels[d.name]!.push(s?.inLevel ?? 0);
      bytes[d.name]!.push(s?.received ?? 0);
    }
  }
  for (const d of devices) {
    const other = devices.find((x) => x !== d)!;
    if (other.on === 'phone') continue;
    if (d.on === 'phone') {
      const b = bytes[d.name]!;
      const rate = (b.at(-1)! - b[0]!) / ((b.length - 1) * 2.5);
      const s = await d.eval(SNAP);
      check(s?.timing?.firstAudio !== undefined && rate > 2000, `the phone gets the ${other.name}'s audio (first audio at ${s?.timing?.firstAudio} ms, ${Math.round(rate / 1000)} kB/s)`, { bytes: b, stats: await d.eval('window.__activeCall?.value?.stats ?? null'), pcs: await d.eval(PCS) });
    } else check(levels[d.name]!.filter((x) => x > 0.003).length >= levels[d.name]!.length / 2, `the ${d.name} hears the ${other.name}`, levels[d.name]!.map((x) => +x.toFixed(4)));
  }
  for (const d of devices) {
    const s = await d.eval(SNAP);
    check(s?.phase === 'live' && s.mode === modes[d.name as 'caller' | 'callee'], `the ${d.name} is still live, in ${modes[d.name as 'caller' | 'callee']} mode`, s);
  }

  // The caller hangs up: on the phone from its call notification, on a computer from the dock.
  if (caller.on === 'phone') {
    phone!.sh('input keyevent KEYCODE_HOME');
    check(phone!.pressInShade('Hang up'), 'Hang up is pressed on the phone');
    phone!.closeShade();
  } else await caller.eval(`(document.querySelector('.call-btn.leave')?.click(), true)`);
  check(await caller.until(`!window.__activeCall?.value || window.__activeCall.value.phase === 'ended'`, 15_000), 'the caller is out of the call');
  if (callee.on === 'phone') {
    phone!.sh('input keyevent KEYCODE_HOME');
    check(phone!.pressInShade('Hang up'), 'Hang up is pressed on the phone');
    phone!.closeShade();
  } else await callee.eval(`(document.querySelector('.call-btn.leave')?.click(), true)`);
  check(await callee.until(`!window.__activeCall?.value || window.__activeCall.value.phase === 'ended'`, 15_000), 'the callee is out of the call');
  if (rings) {
    const theCall = async () => ((await api(`/api/calls/ringing?conversation=${conversation}`)).calls ?? []).find((c: any) => c.id === callId);
    check(await hostWait(async () => (await theCall())?.state === 'ended', 20_000), 'the hub has the call over', await theCall());
  }
  if (phone) {
    const dead = phone.deaths();
    check(dead.length === 0, 'no crash or ANR of the app', dead.slice(0, 2));
  }
} catch (e) {
  check(false, 'ran to the end', String(e));
} finally {
  for (const d of devices) await d.close().catch(() => {});
}
log(failures ? `${failures} failed` : 'all passed');
process.exit(failures ? 1 : 0);
