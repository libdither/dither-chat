/**
 * The Android app's bridge (apps/android). There the page runs in a WebView that injects `DitherAndroid`, a
 * message port restricted to the hub's origin (WebViewCompat.addWebMessageListener). It does what a WebView cannot:
 * keep a call alive with the screen off, pick the audio route, and receive push through UnifiedPush.
 *
 * Messages are JSON both ways, `{ t: ... }`. Everywhere else `android` is null and nothing here runs.
 */
import { effect, signal } from '@preact/signals';
import { activeCall, leaveCall, setMuted } from './call.ts';
import { noteOpen } from './activity.ts';
import { db, go, parseHash, prefs } from './state.ts';

interface Port {
  postMessage(msg: string): void;
  addEventListener(type: 'message', fn: (e: { data: string }) => void): void;
}

const port: Port | null = (globalThis as any).DitherAndroid ?? null;

export interface AudioRoute {
  id: number;
  /** speaker, earpiece, bluetooth, wired, usb, other */
  kind: string;
  name: string;
}

export interface NativePush {
  endpoint: string;
  p256dh: string;
  auth: string;
}

/** A UnifiedPush distributor app on the phone, as the app sees it. Older builds of the app report package names only. */
export interface Distributor {
  pkg: string;
  label: string;
  /** Android does not restrict its battery use, so it can hold its connection. Unknown on older builds. */
  batteryOk?: boolean;
}

export interface AppInfo {
  version: string;
  distributors: Distributor[];
  /** The distributor this app registered with, if any. */
  current: string | null;
  /** This app may post notifications. Unknown on older builds. */
  notifications?: boolean;
  /** What this build of the app can open for the page: 'app' (another app), 'appInfo', 'notifications'. */
  opens: string[];
}

export const android = port
  ? {
      /** What the app reported about itself: version, UnifiedPush distributors, notification permission. */
      info: signal<AppInfo | null>(null),
      audio: signal<{ routes: AudioRoute[]; current: number | null } | null>(null),
      /** This app's push registration, once known. */
      push: signal<NativePush | null | undefined>(undefined),
      send(msg: Record<string, unknown>) {
        port.postMessage(JSON.stringify(msg));
      },
      /** Resolves with the next reply of type `t`, or rejects with a `${t}.error` reply. */
      ask<T>(msg: Record<string, unknown>, t: string, ms = 60_000): Promise<T> {
        return new Promise((resolve, reject) => {
          const timer = setTimeout(() => (waiters.delete(t), reject(new Error('The app did not answer.'))), ms);
          waiters.set(t, (d) => {
            clearTimeout(timer);
            if (d.error) reject(Object.assign(new Error(d.error), { data: d }));
            else resolve(d as T);
          });
          android!.send(msg);
        });
      },
      setAudioRoute(id: number) {
        android!.send({ t: 'audio.set', id });
      },
      changeHub() {
        android!.send({ t: 'hub.change' });
      },
      /** Another app, its App info page (battery use lives there), or this app's notification settings. */
      open(what: 'app' | 'appInfo' | 'notifications', pkg?: string) {
        android!.send({ t: 'open', what, pkg });
      },
    }
  : null;

const waiters = new Map<string, (d: any) => void>();

function receive(d: any) {
  const t = String(d.t ?? '');
  const base = t.endsWith('.error') ? t.slice(0, -6) : t;
  const w = waiters.get(base);
  if (w) {
    waiters.delete(base);
    w(t.endsWith('.error') ? { ...d, error: d.error ?? 'Failed' } : d);
  }
  switch (t) {
    case 'info':
      android!.info.value = {
        version: d.version,
        distributors: (d.distributors ?? []).map((x: string | Distributor) => (typeof x === 'string' ? { pkg: x, label: x === 'io.heckel.ntfy' ? 'ntfy' : x } : x)),
        current: d.current ?? null,
        notifications: d.notifications,
        opens: d.opens ?? [],
      };
      break;
    case 'audio':
      android!.audio.value = { routes: d.routes ?? [], current: d.current ?? null };
      break;
    case 'push':
      android!.push.value = d.endpoint ? { endpoint: d.endpoint, p256dh: d.p256dh, auth: d.auth } : null;
      break;
    case 'open':
      noteOpen(d.hash);
      go(parseHash(d.hash), false);
      break;
    case 'call.hangup':
      if (activeCall.value) leaveCall();
      break;
    case 'call.mute':
      if (activeCall.value) setMuted(!!d.muted);
      break;
  }
}

/** Startup timing, for docs/android.md: the app logs it and reports the activity fully drawn. */
export function reportContent(ms: number, source: string) {
  android?.send({ t: 'ready', ms: Math.round(ms), source });
}

export function reportFresh(ms: number) {
  android?.send({ t: 'fresh', ms: Math.round(ms) });
}

export function startAndroid() {
  if (!port || !android) return;
  port.addEventListener('message', (e) => {
    try {
      receive(JSON.parse(e.data));
    } catch (err) {
      console.error('android bridge', err);
    }
  });
  android.send({ t: 'hello' });
  // The call keeps going with the screen off only inside a foreground service, which the app starts and stops here.
  let last = '';
  effect(() => {
    const c = activeCall.value;
    const live = !!c && c.phase !== 'ended';
    const msg = live ? { t: 'call', active: true, conversationId: c.conversationId, title: db.conversations.get(c.conversationId)?.name ?? 'Call', phase: c.phase, muted: c.muted, since: c.since } : { t: 'call', active: false };
    const key = JSON.stringify(msg);
    if (key !== last) {
      last = key;
      android.send(msg);
    }
  });
  // Launch screen and status bar follow the theme the page picked.
  effect(() => {
    void [prefs.value.theme, prefs.value.themeDark, prefs.value.themeLight];
    requestAnimationFrame(() => android.send({ t: 'theme', bg: getComputedStyle(document.body).backgroundColor }));
  });
}
