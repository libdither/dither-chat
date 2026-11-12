/**
 * This device on the hub, and every device's own notification rules (docs/devices.md). The page says hello with its
 * id (the activity log's, in localStorage) and the push endpoint it holds, so the hub can tie the push registration
 * to it; after that, rules set here apply to this device's push and to the toasts this page shows.
 */
import type * as P from '@dither-chat/protocol';
import { effect } from '@preact/signals';
import { deviceId } from './activity.ts';
import { android } from './android.ts';
import { takesClear } from './appversion.ts';
import { api, connected, db } from './state.ts';

export { deviceId };

/** "Android app, Pixel", "Linux, Firefox": what the device lists call it. */
export function thisDeviceLabel(ua = navigator.userAgent): string {
  if (android) {
    const model = /Android [\d.]+; ([^;)]+?)(?: Build[^;)]*)?[;)]/.exec(ua)?.[1]?.trim();
    return model && model !== 'K' ? `Android app, ${model}` : 'Android app';
  }
  const os = /iPhone|iPad/.test(ua) ? 'iPhone or iPad' : /Android/.test(ua) ? 'Android' : /Mac/.test(ua) ? 'Mac' : /Windows/.test(ua) ? 'Windows' : /Linux/.test(ua) ? 'Linux' : 'Device';
  const app = /Firefox/.test(ua) ? 'Firefox' : /Edg/.test(ua) ? 'Edge' : /Chrome|Chromium/.test(ua) ? 'Chrome' : /Safari/.test(ua) ? 'Safari' : 'browser';
  return `${os}, ${app}`;
}

async function pushEndpoint(): Promise<string | null> {
  if (android) return android.push.value?.endpoint ?? null;
  if (!window.isSecureContext || !('serviceWorker' in navigator)) return null;
  const reg = await navigator.serviceWorker.getRegistration().catch(() => undefined);
  const sub = await reg?.pushManager?.getSubscription().catch(() => null);
  return sub?.endpoint ?? null;
}

let said = '';

/** Tell the hub who this is. Again whenever the push endpoint may have changed; repeats are skipped. */
export async function sayHello(force = false) {
  if (!connected.value) return;
  const endpoint = await pushEndpoint();
  const clears = !!android && !!endpoint && takesClear(android.info.value?.version);
  const body = { id: deviceId(), label: thisDeviceLabel(), endpoint, ...(clears ? { clears } : {}) };
  const key = JSON.stringify(body);
  if (!force && key === said) return;
  said = key;
  await api('/api/devices/hello', { method: 'POST', body }).catch(() => (said = ''));
}

export function startDevices() {
  effect(() => {
    // On every (re)connect, and when the Android app reports its push registration.
    if (connected.value) void sayHello(true);
    android?.push.value;
    android?.info.value;
    void sayHello();
  });
}

/** This device as the hub lists it: by its own id, or by its push registration until that is linked. */
export function myDevice(): P.DeviceView | null {
  const id = deviceId();
  return db.devices.find((d) => d.id === id) ?? null;
}

export function deviceRule(device: P.DeviceView | null, scope: P.DeviceScope, target: string): P.DeviceLevel | null {
  return device?.rules.find((r) => r.scope === scope && r.target === target)?.level ?? null;
}

export const setDeviceRule = (device: string, scope: P.DeviceScope, target: string, level: P.DeviceLevel | null) =>
  api('/api/devices/rules', { method: 'PUT', body: { device, scope, target, level } });

export const forgetDevice = (id: string) => api('/api/devices', { method: 'DELETE', body: { id } });

/** Is this notification kept off this device by its own rules? The hub works it out (docs/devices.md). */
export const quietHere = (ev: { quiet?: string[] }) => !!ev.quiet?.includes(deviceId());
