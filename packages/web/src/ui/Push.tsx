/** Opting one device in to Web Push. */
import type * as P from '@dither-chat/protocol';
import { useEffect, useState } from 'preact/hooks';
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
  const [info, setInfo] = useState<PushInfo | null>(null);
  const [mine, setMine] = useState<PushSubscription | null>(null);
  const [busy, setBusy] = useState(false);
  const why = blocker();
  const reload = () => api<PushInfo>('/api/push').then(setInfo).catch(() => {});
  useEffect(() => {
    reload();
    if (!why) navigator.serviceWorker.ready.then((r) => r.pushManager.getSubscription()).then(setMine).catch(() => {});
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
      {!!info?.devices.length && (
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
      )}
      <p class="set-help">
        Fully self-hosted alternative: <b>{info?.ntfy ? 'ntfy is on for this hub' : 'ntfy is off'}</b>. Set <code>DITHER_NTFY_URL</code> on the hub to a topic on your own ntfy server, and use the ntfy app. No vendor relay is involved if the phone polls your server.
      </p>
    </section>
  );
}
