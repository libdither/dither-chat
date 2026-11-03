/** Opting one device in to Web Push. */
import type * as P from '@dither-chat/protocol';
import { useEffect, useState } from 'preact/hooks';
import { android } from '../android.ts';
import { ago } from '../format.ts';
import { serviceWorkerSupported } from '../pwa.ts';
import { api, setPrefs, toast } from '../state.ts';
import { Icon } from './icons.tsx';

interface PushInfo {
  publicKey: string;
  devices: P.PushDeviceView[];
  ntfy: boolean;
}

function guessLabel(): string {
  const ua = navigator.userAgent;
  const os = /iPhone|iPad/.test(ua) ? 'iPhone or iPad' : /Android/.test(ua) ? 'Android' : /Mac/.test(ua) ? 'Mac' : /Windows/.test(ua) ? 'Windows' : /Linux/.test(ua) ? 'Linux' : 'Device';
  const app = /Firefox/.test(ua) ? 'Firefox' : /Edg/.test(ua) ? 'Edge' : /Chrome|Chromium/.test(ua) ? 'Chrome' : /Safari/.test(ua) ? 'Safari' : 'browser';
  return `${os}, ${app}`;
}

const key = (b64: string) => Uint8Array.from(atob(b64.replace(/-/g, '+').replace(/_/g, '/').padEnd(Math.ceil(b64.length / 4) * 4, '=')), (c) => c.charCodeAt(0));

/** Why this device cannot, if it cannot. */
function blocker(): string | null {
  if (!window.isSecureContext) return 'This page is not on HTTPS, so browsers do not allow push. See docs/deploy.md.';
  if (!serviceWorkerSupported() || !('PushManager' in window)) {
    return /iPhone|iPad/.test(navigator.userAgent) ? 'On iPhone and iPad, push needs iOS 16.4 or later and this app added to the Home Screen.' : 'This browser does not support push.';
  }
  return null;
}

export function PushSettings() {
  return android ? <AndroidPushSettings /> : <WebPushSettings />;
}

function WebPushSettings() {
  const [info, setInfo] = useState<PushInfo | null>(null);
  const [mine, setMine] = useState<PushSubscription | null>(null);
  const [busy, setBusy] = useState(false);
  const [canReply, setCanReply] = useState<boolean | null>(null);
  const why = blocker();
  const reload = () => api<PushInfo>('/api/push').then(setInfo).catch(() => {});
  useEffect(() => {
    reload();
    if (!why) navigator.serviceWorker.ready.then((r) => r.pushManager.getSubscription()).then(setMine).catch(() => {});
    if (why) return;
    // Only a service worker can tell: the event that carries the typed text does not exist in a page.
    const heard = (e: MessageEvent) => e.data?.t === 'canReply' && setCanReply(!!e.data.value);
    navigator.serviceWorker.addEventListener('message', heard);
    navigator.serviceWorker.ready.then((r) => r.active?.postMessage('canReply')).catch(() => {});
    return () => navigator.serviceWorker.removeEventListener('message', heard);
  }, []);
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
    if ((await Notification.requestPermission()) !== 'granted') throw new Error('Notifications are blocked for this site. Allow them in your browser settings.');
    const reg = await navigator.serviceWorker.ready;
    const sub = (await reg.pushManager.getSubscription()) ?? (await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: key(info!.publicKey) }));
    await api('/api/push/subscribe', { body: { subscription: sub.toJSON(), label: guessLabel() } });
    setMine(sub);
    setPrefs({ pushEnabled: true });
  });
  const disable = run(async () => {
    if (mine) {
      await api('/api/push/unsubscribe', { body: { endpoint: mine.endpoint } });
      await mine.unsubscribe();
    }
    setMine(null);
    setPrefs({ pushEnabled: false });
  });
  const test = run(async () => {
    const r = await api<{ ok: boolean; error?: string }>('/api/push/test', { body: { endpoint: mine?.endpoint } });
    if (!r.ok) throw new Error(r.error ?? 'It did not go through.');
    toast({ kind: 'info', title: 'Sent', body: 'It should appear in a few seconds. If not, check system notification settings.' });
  });
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
        <div class="btn-row">
          {mine ? (
            <>
              <button class="btn ghost small" disabled={busy} onClick={test}><Icon name="send" size={13} /> Send a test notification</button>
              <button class="btn ghost small" disabled={busy} onClick={disable}><Icon name="bellOff" size={13} /> Turn off on this device</button>
            </>
          ) : (
            <button class="btn small" disabled={busy || !info} onClick={enable}><Icon name="bell" size={13} /> Turn on for this device</button>
          )}
        </div>
      )}
      {canReply !== null && (
        <p class="set-help">
          {canReply
            ? 'Replying from a notification works on this browser, where the system shows the box for it. If yours shows none, tapping opens the conversation.'
            : 'This browser cannot take a reply inside a notification, so tapping one opens the conversation.'}{' '}
          Rooms the hub cannot send to, like encrypted Matrix rooms, never offer it.
        </p>
      )}
      <Devices info={info} reload={reload} />
      <p class="set-help">
        Fully self-hosted alternative: <b>{info?.ntfy ? 'ntfy is on for this hub' : 'ntfy is off'}</b>. Set <code>DITHER_NTFY_URL</code> on the hub to a topic on your own ntfy server, and use the ntfy app. No vendor relay is involved if the phone polls your server.
      </p>
    </section>
  );
}

function Devices({ info, reload }: { info: PushInfo | null; reload: () => void }) {
  if (!info?.devices.length) return null;
  return (
    <>
      <h4 class="push-devices">Devices with push</h4>
      {info.devices.map((d) => (
        <div class="set-rule">
          <span class="set-rule-label">
            <Icon name="monitor" size={15} /> {d.label} <small>via {d.relay}{d.lastOkAt ? `, last sent ${ago(d.lastOkAt)}` : ''}{d.lastError ? `, failing: ${d.lastError}` : ''}</small>
          </span>
          <button class="icon-btn small" title="Remove" onClick={() => api('/api/push/unsubscribe', { body: { id: d.id } }).then(reload)}>
            <Icon name="x" size={13} />
          </button>
        </div>
      ))}
    </>
  );
}

/**
 * The Android app has no Web Push (a WebView has no PushManager). It registers with a UnifiedPush distributor
 * instead, such as the ntfy app, whose endpoint takes the same encrypted Web Push the hub sends to browsers.
 */
function AndroidPushSettings() {
  const app = android!;
  const [info, setInfo] = useState<PushInfo | null>(null);
  const [busy, setBusy] = useState(false);
  const mine = app.push.value;
  const distributors = app.info.value?.distributors ?? [];
  const reload = () => api<PushInfo>('/api/push').then(setInfo).catch(() => {});
  useEffect(() => {
    reload();
    app.send({ t: 'push.status' });
  }, []);
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
    // The app asks for the notification permission, picks the distributor, and registers its endpoint with the hub
    // itself (so a rotated endpoint reaches the hub even with the page closed). This waits for the outcome.
    await app.ask({ t: 'push.register', vapid: info!.publicKey }, 'push', 120_000);
    setPrefs({ pushEnabled: true });
  });
  const disable = run(async () => {
    app.send({ t: 'push.unregister' });
    app.push.value = null;
    setPrefs({ pushEnabled: false });
  });
  const test = run(async () => {
    const r = await api<{ ok: boolean; error?: string }>('/api/push/test', { body: { endpoint: mine?.endpoint } });
    if (!r.ok) throw new Error(r.error ?? 'It did not go through.');
    toast({ kind: 'info', title: 'Sent', body: 'It should appear in a few seconds.' });
  });
  const registered = !!mine && !!info?.devices.length;
  return (
    <section class="set-block" id="push">
      <h3>Push on this device</h3>
      <p class="set-help">
        This app gets push through UnifiedPush: a distributor app on the phone, such as ntfy, holds one connection for every app that uses it and wakes this one. The hub sends it the same end-to-end encrypted Web Push it sends browsers, so the
        distributor's server sees when a push arrives but not what it says. The hub only sends to servers its operator listed in <code>DITHER_PUSH_RELAYS</code>.
      </p>
      {!distributors.length ? (
        <p class="set-help">
          <Icon name="alert" size={13} /> No UnifiedPush distributor is installed. Install one, for example <a href="https://f-droid.org/packages/io.heckel.ntfy/" target="_blank" rel="noreferrer">ntfy</a>, then come back here.
        </p>
      ) : (
        <div class="btn-row">
          {mine ? (
            <>
              <button class="btn ghost small" disabled={busy} onClick={test}><Icon name="send" size={13} /> Send a test notification</button>
              <button class="btn ghost small" disabled={busy} onClick={disable}><Icon name="bellOff" size={13} /> Turn off on this device</button>
            </>
          ) : (
            <button class="btn small" disabled={busy || !info} onClick={enable}><Icon name="bell" size={13} /> Turn on for this device</button>
          )}
        </div>
      )}
      {mine && !registered && info && <p class="set-help"><Icon name="alert" size={13} /> This device has an endpoint but the hub has no device: turn it off and on again.</p>}
      <Devices info={info} reload={reload} />
      <div class="btn-row">
        <button class="btn ghost small" onClick={() => app.changeHub()}><Icon name="monitor" size={13} /> Use another hub</button>
      </div>
    </section>
  );
}
