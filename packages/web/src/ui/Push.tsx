/**
 * Push, in Settings → Notifications: turning it on for this device, the devices that have it, and the push servers
 * the hub may send through. A browser uses its vendor's relay; the Android app uses a UnifiedPush server (ntfy).
 * Either way the hub only POSTs to servers the owner allowed, and allowing one is a tap here, not a hub setting.
 */
import type * as P from '@dither-chat/protocol';
import { signal } from '@preact/signals';
import { useEffect, useState } from 'preact/hooks';
import { android } from '../android.ts';
import { sayHello, thisDeviceLabel } from '../devices.ts';
import { ago } from '../format.ts';
import { serviceWorkerSupported } from '../pwa.ts';
import { setPrefs, toast } from '../state.ts';
import { Icon } from './icons.tsx';

const info = signal<P.PushInfo | null>(null);
/** This device's id on the hub (a fingerprint of its endpoint), once known. */
const mineId = signal<string | null>(null);

const reload = () =>
  call<P.PushInfo>('/api/push').then((r) => {
    if (r.ok) info.value = r.data;
  });

/** Like state.ts's api(), except a refusal keeps its body: it names the server to allow. */
async function call<T = Record<string, never>>(path: string, body?: unknown, method?: string): Promise<{ ok: boolean; status: number; data: T & { error?: string } }> {
  const res = await fetch(path, { method: method ?? (body !== undefined ? 'POST' : 'GET'), body: body !== undefined ? JSON.stringify(body) : undefined, headers: body !== undefined ? { 'content-type': 'application/json' } : undefined });
  const data = await res.json().catch(() => ({ error: `The hub answered ${res.status}` }));
  return { ok: res.ok, status: res.status, data };
}

async function must<T>(path: string, body?: unknown, method?: string): Promise<T> {
  const r = await call<T>(path, body, method);
  if (!r.ok) throw new Error(r.data.error ?? `The hub answered ${r.status}`);
  return r.data;
}

/** The hub's push.ts fingerprint(): the first 16 characters of the endpoint's SHA-256, base64url. */
async function fingerprint(endpoint: string): Promise<string> {
  const h = new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(endpoint)));
  return btoa(String.fromCharCode(...h)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '').slice(0, 16);
}

const host = (origin: string) => origin.replace(/^https:\/\//, '');

const key = (b64: string) => Uint8Array.from(atob(b64.replace(/-/g, '+').replace(/_/g, '/').padEnd(Math.ceil(b64.length / 4) * 4, '=')), (c) => c.charCodeAt(0));

/** Why this device cannot, if it cannot. */
function blocker(): string | null {
  if (!window.isSecureContext) return 'This page is not on HTTPS, so browsers do not allow push. See docs/deploy.md.';
  if (!serviceWorkerSupported() || !('PushManager' in window)) {
    return /iPhone|iPad/.test(navigator.userAgent) ? 'On iPhone and iPad, push needs iOS 16.4 or later and this app added to the Home Screen.' : 'This browser does not support push.';
  }
  return null;
}

/** Where to unblock notifications for this site, by browser. */
function blockedHelp(): string {
  const ua = navigator.userAgent;
  if (/Android/.test(ua) && /Firefox/.test(ua)) return 'Notifications are blocked for this site. In Firefox: menu → Settings → Site permissions → Notifications, allow this site; and check Android Settings → Apps → Firefox → Notifications.';
  if (/Android/.test(ua)) return 'Notifications are blocked for this site. Tap the icon left of the address (or the app\'s menu → Site settings) → Notifications, and allow them.';
  return 'Notifications are blocked for this site. Allow them from the icon left of the address bar, then try again.';
}

/** Sends a test, then watches for the device to say it arrived. */
function useTest() {
  const [status, setStatus] = useState<{ kind: 'wait' | 'ok' | 'warn' | 'error'; text: string } | null>(null);
  const run = async (id: string, opts: { acks: boolean; where: string; hint: string }) => {
    const sentAt = Date.now();
    setStatus({ kind: 'wait', text: `Sending a test through ${opts.where}…` });
    let r = await call<{ ok: boolean; error?: string; code?: string }>('/api/push/test', { id });
    // Right after registering, ntfy's server refuses until the ntfy app has connected to it: give it a few seconds.
    for (let i = 0; i < 6 && r.data.code === 'no-subscriber'; i++) {
      setStatus({ kind: 'wait', text: `Waiting for the ntfy app to connect to ${opts.where}…` });
      await new Promise((ok) => setTimeout(ok, 2500));
      r = await call('/api/push/test', { id });
    }
    if (!r.ok || !r.data.ok) {
      reload();
      return setStatus({ kind: 'error', text: r.data.error ?? 'It did not go through.' });
    }
    if (!opts.acks) return setStatus({ kind: 'ok', text: `${opts.where} took it. It should appear in a few seconds. ${opts.hint}` });
    setStatus({ kind: 'wait', text: `${opts.where} took it. Waiting for the device to say it arrived…` });
    for (let i = 0; i < 12; i++) {
      await new Promise((ok) => setTimeout(ok, 1500));
      await reload();
      const d = info.value?.devices.find((x) => x.id === id);
      if (d?.lastArrivedAt && d.lastArrivedAt >= sentAt - 1000) return setStatus({ kind: 'ok', text: 'It arrived. Push works on this device.' });
    }
    setStatus({ kind: 'warn', text: `${opts.where} took the test, but the device has not said it arrived. ${opts.hint}` });
  };
  return { status, run, clear: () => setStatus(null) };
}

function TestStatus({ status }: { status: ReturnType<typeof useTest>['status'] }) {
  if (!status) return null;
  const icon = status.kind === 'ok' ? 'check' : status.kind === 'wait' ? 'refresh' : 'alert';
  return (
    <p class={`set-help push-status ${status.kind}`}>
      <Icon name={icon} size={13} /> {status.text}
    </p>
  );
}

export function PushSettings() {
  useEffect(() => {
    reload();
  }, []);
  return (
    <>
      {android ? <AndroidPushSettings /> : <WebPushSettings />}
      <PushDevices />
      <PushServers />
    </>
  );
}

// ------------------------------------------------------------------ allowing a server

/**
 * One tap allows a server a device tried to register through. A private address (a tailnet ntfy) asks once more,
 * and plain http is only taken typed out, under Push servers.
 */
function AllowServer({ origin, http, onAllowed }: { origin: string; http?: boolean; onAllowed?: () => void }) {
  const [confirm, setConfirm] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const allow = async (allowPrivate: boolean) => {
    setBusy(true);
    try {
      const r = await call<{ registered?: number; confirm?: string }>('/api/push/servers', { origin, allowPrivate });
      if (r.status === 409 && r.data.confirm) return setConfirm(r.data.error ?? 'This is a private address.');
      if (!r.ok) throw new Error(r.data.error);
      setConfirm(null);
      toast({ kind: 'info', title: 'Push', body: `The hub now sends through ${host(origin)}.${r.data.registered ? ` ${r.data.registered === 1 ? 'The waiting device is' : `${r.data.registered} waiting devices are`} registered.` : ''}` });
      await reload();
      onAllowed?.();
    } catch (e: any) {
      toast({ kind: 'error', title: 'Push', body: String(e?.message ?? e) });
    } finally {
      setBusy(false);
    }
  };
  if (http) return <p class="set-help"><Icon name="alert" size={13} /> {origin} is plain http. If it is your own server on the tailnet, type it under <b>Push servers</b> below to allow it.</p>;
  if (confirm)
    return (
      <div class="push-confirm">
        <p class="set-help"><Icon name="alert" size={13} /> {confirm}</p>
        <div class="btn-row">
          <button class="btn small" disabled={busy} onClick={() => allow(true)}>It is mine, allow it</button>
          <button class="btn ghost small" disabled={busy} onClick={() => setConfirm(null)}>Cancel</button>
        </div>
      </div>
    );
  return (
    <button class="btn small" disabled={busy} onClick={() => allow(false)}>
      <Icon name="check" size={13} /> Allow notifications through {host(origin)}
    </button>
  );
}

/** Shown where this device was refused: which server, and the tap that fixes it. */
function Refused({ origin, http, onAllowed }: { origin: string; http?: boolean; onAllowed: () => void }) {
  if (http)
    return (
      <div class="push-refused">
        <p class="set-help">
          <Icon name="alert" size={13} /> This device's push server is <b>{origin}</b>, plain http. The hub sends there only once you type it out: if it is your own server on the tailnet, enter it under <b>Push servers</b> below, then turn push on again.
        </p>
      </div>
    );
  return (
    <div class="push-refused">
      <p class="set-help">
        <Icon name="alert" size={13} /> This device's push server is <b>{origin}</b>, and the hub does not send there yet. The hub only sends to push servers you allow, so it cannot be aimed at other hosts. Pushes are encrypted for this device; the server sees only when one
        arrives.
      </p>
      <div class="btn-row">
        <AllowServer origin={origin} http={http} onAllowed={onAllowed} />
      </div>
    </div>
  );
}

// ------------------------------------------------------------------ this device: a browser

function WebPushSettings() {
  const [mine, setMine] = useState<PushSubscription | null>(null);
  const [busy, setBusy] = useState(false);
  const [canReply, setCanReply] = useState<boolean | null>(null);
  const [refused, setRefused] = useState<{ origin: string; http?: boolean } | null>(null);
  const [denied, setDenied] = useState(typeof Notification !== 'undefined' && Notification.permission === 'denied');
  const test = useTest();
  const why = blocker();
  useEffect(() => {
    if (why) return;
    navigator.serviceWorker.ready
      .then((r) => r.pushManager.getSubscription())
      .then(async (s) => {
        setMine(s);
        mineId.value = s ? await fingerprint(s.endpoint) : null;
      })
      .catch(() => {});
    // Only a service worker can tell: the event that carries the typed text does not exist in a page.
    const heard = (e: MessageEvent) => e.data?.t === 'canReply' && setCanReply(!!e.data.value);
    navigator.serviceWorker.addEventListener('message', heard);
    navigator.serviceWorker.ready.then((r) => r.active?.postMessage('canReply')).catch(() => {});
    return () => navigator.serviceWorker.removeEventListener('message', heard);
  }, []);
  const relay = () => info.value?.devices.find((d) => d.id === mineId.value)?.relay ?? 'the push service';
  const hint = /Android/.test(navigator.userAgent)
    ? 'If nothing shows: allow notifications for this browser in Android Settings → Apps, and turn off battery restrictions for it. Firefox and Chrome on Android receive push through Google Play services; on a phone without them, use the dither Android app with ntfy instead.'
    : 'If nothing shows, check that notifications are allowed for this browser in the system settings, and that Do Not Disturb is off.';
  const register = async (sub: PushSubscription) => {
    const r = await call<{ id: string; server?: string; http?: boolean }>('/api/push/subscribe', { subscription: sub.toJSON(), label: thisDeviceLabel() });
    if (r.status === 403 && r.data.server) {
      setRefused({ origin: r.data.server, http: r.data.http });
      return null;
    }
    if (!r.ok) throw new Error(r.data.error);
    setRefused(null);
    return r.data.id;
  };
  const run = (fn: () => Promise<void>) => async () => {
    setBusy(true);
    try {
      await fn();
    } catch (e: any) {
      toast({ kind: 'error', title: 'Push', body: String(e?.message ?? e) });
    } finally {
      setBusy(false);
      reload();
    }
  };
  const enable = run(async () => {
    test.clear();
    const perm = await Notification.requestPermission();
    setDenied(perm === 'denied');
    if (perm !== 'granted') throw new Error(perm === 'denied' ? blockedHelp() : 'Notifications were not allowed. Try again and pick Allow.');
    const reg = await navigator.serviceWorker.ready;
    const sub = (await reg.pushManager.getSubscription()) ?? (await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: key(info.value!.publicKey) }));
    setMine(sub);
    mineId.value = await fingerprint(sub.endpoint);
    const id = await register(sub);
    if (!id) return;
    setPrefs({ pushEnabled: true });
    void sayHello();
    await reload();
    await test.run(id, { acks: true, where: relay(), hint });
  });
  const disable = run(async () => {
    test.clear();
    if (mine) {
      await must('/api/push/unsubscribe', { endpoint: mine.endpoint });
      await mine.unsubscribe();
    }
    setMine(null);
    setRefused(null);
    mineId.value = null;
    setPrefs({ pushEnabled: false });
    void sayHello();
  });
  const registered = !!mine && !!info.value?.devices.some((d) => d.id === mineId.value);
  return (
    <section class="set-block" id="push">
      <h3>Push on this device</h3>
      <p class="set-help">
        Reaches this device when the app is closed. It passes through your browser vendor's relay (Google, Apple or Mozilla), which you cannot avoid with Web Push. The message itself is encrypted end to end, but the relay sees when a push arrives and for which
        device. So it stays off until you turn it on, per device.
      </p>
      {why ? (
        <p class="set-help"><Icon name="alert" size={13} /> {why}</p>
      ) : (
        <>
          {denied && <p class="set-help"><Icon name="alert" size={13} /> {blockedHelp()}</p>}
          <div class="btn-row">
            {registered ? (
              <>
                <button class="btn ghost small" disabled={busy} onClick={run(() => test.run(mineId.value!, { acks: true, where: relay(), hint }))}><Icon name="send" size={13} /> Send a test notification</button>
                <button class="btn ghost small" disabled={busy} onClick={disable}><Icon name="bellOff" size={13} /> Turn off on this device</button>
              </>
            ) : (
              <button class="btn small" disabled={busy || !info.value} onClick={enable}><Icon name="bell" size={13} /> Turn on for this device</button>
            )}
          </div>
          {refused && <Refused origin={refused.origin} http={refused.http} onAllowed={enable} />}
          <TestStatus status={test.status} />
        </>
      )}
      {canReply !== null && (
        <p class="set-help">
          {canReply
            ? 'Replying from a notification works on this browser, where the system shows the box for it. If yours shows none, tapping opens the conversation.'
            : 'This browser cannot take a reply inside a notification, so tapping one opens the conversation.'}{' '}
          Rooms the hub cannot send to, like encrypted Matrix rooms, never offer it.
        </p>
      )}
    </section>
  );
}

// ------------------------------------------------------------------ this device: the Android app

const NTFY = 'io.heckel.ntfy';

/**
 * The Android app has no Web Push (a WebView has no PushManager). It registers with a UnifiedPush distributor
 * instead, such as the ntfy app, whose endpoint takes the same encrypted Web Push the hub sends to browsers.
 */
function AndroidPushSettings() {
  const app = android!;
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<{ text: string; open?: string; refused?: { origin: string; http?: boolean } } | null>(null);
  const test = useTest();
  const mine = app.push.value;
  const appInfo = app.info.value;
  const distributors = appInfo?.distributors ?? [];
  const dist = distributors.find((d) => d.pkg === appInfo?.current) ?? (distributors.length === 1 ? distributors[0] : null);
  const name = dist?.label ?? 'ntfy';
  const opens = appInfo?.opens ?? [];
  const acks = opens.length > 0; // builds that can open other apps also confirm test pushes
  useEffect(() => {
    app.send({ t: 'push.status' });
  }, []);
  useEffect(() => {
    if (mine?.endpoint) fingerprint(mine.endpoint).then((id) => (mineId.value = id));
    else mineId.value = null;
  }, [mine?.endpoint]);
  const hint = `If nothing shows: open ${name} once, and set its battery use to Unrestricted (button above).`;
  const where = (endpoint?: string) => (endpoint ? host(new URL(endpoint).origin) : name);
  const run = (fn: () => Promise<void>) => async () => {
    setBusy(true);
    try {
      await fn();
    } catch (e: any) {
      toast({ kind: 'error', title: 'Push', body: String(e?.message ?? e) });
    } finally {
      setBusy(false);
      reload();
    }
  };
  const register = async () => {
    // The app asks for the notification permission, picks the distributor, and registers its endpoint with the hub
    // itself (so a rotated endpoint reaches the hub even with the page closed). This waits for the outcome.
    try {
      const p = await app.ask<{ endpoint: string }>({ t: 'push.register', vapid: info.value!.publicKey }, 'push', 30_000);
      setProblem(null);
      setPrefs({ pushEnabled: true });
      return p;
    } catch (e: any) {
      const d = e?.data ?? {};
      if (e?.message === 'The app did not answer.') {
        setProblem({ text: `${name} did not answer. Android does not let it start in the background until it has been opened once. Open it, then turn push on again here.`, open: dist?.pkg ?? NTFY });
        return null;
      }
      // Newer builds of the app say which server was refused; with older ones the hub still holds the attempt.
      await reload();
      const server = d.server ?? info.value?.pending.find((p) => p.labels.some((l) => l.startsWith('Android app')))?.origin;
      if (server) {
        setProblem({ text: '', refused: { origin: server, http: d.http ?? server.startsWith('http:') } });
        return null;
      }
      setProblem({ text: e?.message ?? String(e), open: d.action === 'open' ? d.pkg ?? dist?.pkg : undefined });
      return null;
    }
  };
  const enable = run(async () => {
    test.clear();
    const p = await register();
    if (!p?.endpoint) return;
    await reload();
    await test.run(await fingerprint(p.endpoint), { acks, where: where(p.endpoint), hint });
  });
  const disable = run(async () => {
    test.clear();
    setProblem(null);
    app.send({ t: 'push.unregister' });
    app.push.value = null;
    setPrefs({ pushEnabled: false });
  });
  const registered = !!mine && !!info.value?.devices.some((d) => d.id === mineId.value);
  return (
    <section class="set-block" id="push">
      <h3>Push on this device</h3>
      <p class="set-help">
        This app gets push through UnifiedPush: a distributor app on the phone, normally ntfy, holds one connection for every app that uses it and wakes this one. The hub encrypts each push for this phone, so ntfy's server sees when a push arrives but not what it says.
      </p>
      <ul class="push-steps">
        {!distributors.length ? (
          <li class="todo">
            <Icon name="alert" size={13} /> <span>Install <b>ntfy</b>, the app that delivers the pushes:{' '}
              <a href="https://f-droid.org/packages/io.heckel.ntfy/" target="_blank" rel="noreferrer">F-Droid</a> or <a href="https://play.google.com/store/apps/details?id=io.heckel.ntfy" target="_blank" rel="noreferrer">Google Play</a>. Then come back here.</span>
          </li>
        ) : (
          <li class="done">
            <Icon name="check" size={13} /> <span>{distributors.map((d) => d.label).join(', ')} installed.</span>
            {opens.includes('app') && <button class="btn ghost small" onClick={() => app.open('app', dist?.pkg ?? distributors[0].pkg)}>Open {name}</button>}
          </li>
        )}
        {!!distributors.length && (
          <li>
            <Icon name="send" size={13} /> <span>{name} uses ntfy.sh unless you set your own server in {name} → Settings → Default server. Set it before turning push on here (after changing it, turn push off and on again). A server the hub does not know yet gets an Allow button.</span>
          </li>
        )}
        {dist?.batteryOk === false ? (
          <li class="todo">
            <Icon name="alert" size={13} /> <span>Android restricts {name}'s battery use, so pushes can come late or not at all. In its App info → App battery usage, allow background usage and pick <b>Unrestricted</b>.</span>
            {opens.includes('appInfo') && <button class="btn ghost small" onClick={() => app.open('appInfo', dist.pkg)}>App info for {name}</button>}
          </li>
        ) : dist?.batteryOk ? (
          <li class="done"><Icon name="check" size={13} /> <span>{name} may run in the background.</span></li>
        ) : null}
        {appInfo?.notifications === false && (
          <li class="todo">
            <Icon name="alert" size={13} /> <span>Notifications are off for this app.</span>
            {opens.includes('notifications') && <button class="btn ghost small" onClick={() => app.open('notifications')}>Notification settings</button>}
          </li>
        )}
      </ul>
      {!!distributors.length && (
        <div class="btn-row">
          {registered ? (
            <>
              <button class="btn ghost small" disabled={busy} onClick={run(() => test.run(mineId.value!, { acks, where: where(mine?.endpoint), hint }))}><Icon name="send" size={13} /> Send a test notification</button>
              <button class="btn ghost small" disabled={busy} onClick={disable}><Icon name="bellOff" size={13} /> Turn off on this device</button>
            </>
          ) : (
            <button class="btn small" disabled={busy || !info.value} onClick={enable}><Icon name="bell" size={13} /> {busy ? `Waiting for ${name}…` : 'Turn on for this device'}</button>
          )}
        </div>
      )}
      {problem?.refused && <Refused origin={problem.refused.origin} http={problem.refused.http} onAllowed={enable} />}
      {problem?.text && (
        <div class="push-refused">
          <p class="set-help"><Icon name="alert" size={13} /> {problem.text}</p>
          {problem.open && opens.includes('app') && <div class="btn-row"><button class="btn ghost small" onClick={() => app.open('app', problem.open)}>Open {name}</button></div>}
        </div>
      )}
      {mine && !registered && info.value && !problem && !busy && <p class="set-help"><Icon name="alert" size={13} /> This phone has a push endpoint, but the hub has no device for it. Turn push on again.</p>}
      <TestStatus status={test.status} />
      <div class="btn-row">
        <button class="btn ghost small" onClick={() => app.changeHub()}><Icon name="monitor" size={13} /> Use another hub</button>
      </div>
    </section>
  );
}

// ------------------------------------------------------------------ every device

function deviceStatus(d: P.PushDeviceView): { kind: 'ok' | 'warn' | 'none'; text: string } {
  if (d.lastError && (d.lastErrorAt ?? 0) >= (d.lastOkAt ?? 0)) return { kind: 'warn', text: `failing${d.lastErrorAt ? ` since ${ago(d.lastErrorAt)}` : ''}: ${d.lastError}` };
  const parts: string[] = [];
  if (d.lastOkAt) parts.push(`last push taken by ${d.relay} ${ago(d.lastOkAt)}`);
  if (d.lastArrivedAt) parts.push(`test arrived ${ago(d.lastArrivedAt)}`);
  else if (d.lastTestAt && d.lastOkAt && d.lastOkAt >= d.lastTestAt) parts.push('the device has not confirmed a test yet');
  return parts.length ? { kind: 'ok', text: parts.join(', ') } : { kind: 'none', text: 'registered, nothing sent yet' };
}

function PushDevices() {
  const [busy, setBusy] = useState<string | null>(null);
  const v = info.value;
  if (!v?.devices.length && !v?.topic) return null;
  const act = (id: string, fn: () => Promise<void>) => async () => {
    setBusy(id);
    try {
      await fn();
    } catch (e: any) {
      toast({ kind: 'error', title: 'Push', body: String(e?.message ?? e) });
    } finally {
      setBusy(null);
      reload();
    }
  };
  const test = (id: string, label: string) =>
    act(id, async () => {
      const r = await must<{ ok: boolean; error?: string }>('/api/push/test', { id });
      if (!r.ok) throw new Error(r.error ?? 'It did not go through.');
      toast({ kind: 'info', title: 'Sent', body: `A test is on its way to ${label}.` });
    });
  return (
    <section class="set-block" id="push-devices">
      <h3>Devices with push</h3>
      {v.devices.map((d) => {
        const s = deviceStatus(d);
        return (
          <div class="set-rule push-device">
            <span class="set-rule-label">
              <Icon name="monitor" size={15} />
              <span>
                {d.label}
                {d.id === mineId.value && <em class="push-this"> this device</em>} <small>via {d.relay}, added {ago(d.createdAt)}</small>
                <small class={`push-state ${s.kind}`}>{s.text}</small>
              </span>
            </span>
            <button class="icon-btn small" title="Send a test" disabled={busy === d.id} onClick={test(d.id, d.label)}><Icon name="send" size={13} /></button>
            <button class="icon-btn small" title="Remove" disabled={busy === d.id} onClick={act(d.id, () => must('/api/push/unsubscribe', { id: d.id }))}><Icon name="x" size={13} /></button>
          </div>
        );
      })}
      {v.topic && (
        <div class="set-rule push-device">
          <span class="set-rule-label">
            <Icon name="bell" size={15} />
            <span>
              ntfy topic <small>on {host(v.topic.server)}, from DITHER_NTFY_URL: plain text the ntfy server can read</small>
              <small class={`push-state ${v.topic.lastError ? 'warn' : v.topic.lastOkAt ? 'ok' : 'none'}`}>{v.topic.lastError ? `failing: ${v.topic.lastError}` : v.topic.lastOkAt ? `last sent ${ago(v.topic.lastOkAt)}` : 'nothing sent since the hub started'}</small>
            </span>
          </span>
          <button class="icon-btn small" title="Send a test" disabled={busy === 'ntfy-topic'} onClick={test('ntfy-topic', 'the ntfy topic')}><Icon name="send" size={13} /></button>
        </div>
      )}
    </section>
  );
}

// ------------------------------------------------------------------ push servers

function PushServers() {
  const [typed, setTyped] = useState('');
  const [confirm, setConfirm] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const v = info.value;
  if (!v) return null;
  const act = (fn: () => Promise<void>) => async () => {
    setBusy(true);
    try {
      await fn();
    } catch (e: any) {
      toast({ kind: 'error', title: 'Push', body: String(e?.message ?? e) });
    } finally {
      setBusy(false);
      reload();
    }
  };
  const add = (allowPrivate: boolean) =>
    act(async () => {
      const r = await call<{ origin?: string; registered?: number; confirm?: string }>('/api/push/servers', { origin: typed, typed: true, allowPrivate });
      if (r.status === 409 && r.data.confirm) return setConfirm(r.data.error ?? 'This is a private address.');
      if (!r.ok) throw new Error(r.data.error);
      setConfirm(null);
      setTyped('');
      toast({ kind: 'info', title: 'Push', body: `The hub now sends through ${r.data.origin}.${r.data.registered ? ` ${r.data.registered} waiting device${r.data.registered === 1 ? ' is' : 's are'} registered.` : ''}` });
    });
  const remove = (s: P.PushServerView) =>
    act(async () => {
      const r = await must<{ removed: number }>('/api/push/servers', { origin: s.origin }, 'DELETE');
      toast({ kind: 'info', title: 'Push', body: `The hub no longer sends through ${host(s.origin)}.${r.removed ? ` ${r.removed} device${r.removed === 1 ? '' : 's'} on it removed.` : ''}` });
    });
  const turnOn = (s: P.PushServerView) => act(() => must('/api/push/servers', { origin: s.origin }));
  return (
    <section class="set-block" id="push-servers">
      <h3>Push servers</h3>
      <p class="set-help">
        Browsers push through their vendor's relay, which the hub always allows. The Android app pushes through a UnifiedPush server, normally ntfy's. The hub sends only to the servers below, so it cannot be pointed at other hosts. Each push is encrypted for its device
        before it leaves the hub: a server sees when a push happens and its size, never what it says.
      </p>
      {v.pending.map((p) => (
        <div class="set-rule push-pending">
          <span class="set-rule-label">
            <Icon name="alert" size={15} />
            <span>
              {host(p.origin)} <small>{p.labels.join(', ')} tried to register through it {ago(p.at)}</small>
            </span>
          </span>
          {p.http ? <small class="push-note">plain http: type it below to allow it</small> : <AllowServer origin={p.origin} />}
          <button class="icon-btn small" title="Dismiss" disabled={busy} onClick={act(() => must('/api/push/servers', { origin: p.origin, dismiss: true }, 'DELETE'))}><Icon name="x" size={13} /></button>
        </div>
      ))}
      {v.servers.map((s) => (
        <div class="set-rule">
          <span class="set-rule-label">
            <Icon name={s.off ? 'bellOff' : 'send'} size={15} />
            <span>
              {host(s.origin)}{' '}
              <small>
                {s.source === 'default'
                  ? s.off
                    ? 'off: the ntfy app\'s own public server, allowed by default until you turned it off'
                    : 'allowed by default: the ntfy app\'s own public server, which sees only timing'
                  : s.source === 'environment'
                    ? 'from DITHER_PUSH_RELAYS on the hub'
                    : `allowed ${s.addedAt ? ago(s.addedAt) : ''}${s.private ? ', on a private address' : ''}`}
                {s.devices ? `, ${s.devices} device${s.devices === 1 ? '' : 's'}` : ''}
              </small>
            </span>
          </span>
          {s.source === 'default' && s.off ? (
            <button class="btn ghost small" disabled={busy} onClick={turnOn(s)}>Allow again</button>
          ) : s.source !== 'environment' ? (
            <button class="icon-btn small" title={s.source === 'default' ? 'Turn off' : 'Remove'} disabled={busy} onClick={remove(s)}><Icon name="x" size={13} /></button>
          ) : null}
        </div>
      ))}
      <form
        class="push-add"
        onSubmit={(e) => {
          e.preventDefault();
          if (typed.trim()) add(false)();
        }}
      >
        <input class="input" aria-label="Push server address" placeholder="https://ntfy.example.net" value={typed} onInput={(e) => (setTyped((e.target as HTMLInputElement).value), setConfirm(null))} />
        <button class="btn ghost small" disabled={busy || !typed.trim()}>Allow</button>
      </form>
      {confirm && (
        <div class="push-confirm">
          <p class="set-help"><Icon name="alert" size={13} /> {confirm}</p>
          <div class="btn-row">
            <button class="btn small" disabled={busy} onClick={add(true)}>It is mine, allow it</button>
            <button class="btn ghost small" disabled={busy} onClick={() => setConfirm(null)}>Cancel</button>
          </div>
        </div>
      )}
      <p class="set-help">Your own ntfy server: type its address here (http only if it is on your tailnet), or just turn push on in the app and tap Allow when it asks.</p>
    </section>
  );
}
