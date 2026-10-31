/**
 * Service worker lifecycle: register it, notice new builds, and swap to them.
 *
 * An installed PWA rarely navigates, so the browser's own update check rarely runs. We ask on every
 * return to the app and hourly. A new build waits until you tap the bar, or until the app is out of
 * sight, so it never reloads under a half-typed message.
 */
import { signal } from '@preact/signals';
import { go, parseHash } from './state.ts';

export const updateReady = signal(false);

let registration: ServiceWorkerRegistration | null = null;
let reloading = false;

export function serviceWorkerSupported() {
  return 'serviceWorker' in navigator && window.isSecureContext;
}

export function applyUpdate() {
  registration?.waiting?.postMessage('skipWaiting');
}

function watch(reg: ServiceWorkerRegistration) {
  const waiting = () => {
    if (!reg.waiting || !navigator.serviceWorker.controller) return;
    updateReady.value = true;
    if (document.visibilityState === 'hidden') applyUpdate();
  };
  waiting();
  reg.addEventListener('updatefound', () => {
    reg.installing?.addEventListener('statechange', waiting);
  });
  document.addEventListener('visibilitychange', waiting);
}

export function registerServiceWorker() {
  if (!import.meta.env.PROD || !serviceWorkerSupported()) return;
  const hadController = !!navigator.serviceWorker.controller;
  navigator.serviceWorker.addEventListener('controllerchange', () => {
    // The first install claims this page, and nothing about the page is stale.
    if (!hadController || reloading) return;
    reloading = true;
    location.reload();
  });
  navigator.serviceWorker.addEventListener('message', (e) => {
    if (e.data?.t === 'open') go(parseHash(e.data.hash), false);
  });
  navigator.serviceWorker
    .register('/sw.js', { updateViaCache: 'none' })
    .then((reg) => {
      registration = reg;
      watch(reg);
      const check = () => {
        if (navigator.onLine) reg.update().catch(() => {});
      };
      document.addEventListener('visibilitychange', () => document.visibilityState === 'visible' && check());
      setInterval(check, 3_600_000);
    })
    .catch((e) => console.warn('service worker registration failed', e));
}
