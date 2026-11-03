/**
 * Service worker lifecycle: register it, notice new builds, and swap to them.
 *
 * The shell comes from the worker's cache (sw.js), so a new build never shows up by itself, and an installed
 * PWA rarely navigates, so the browser's own update check rarely runs. We ask shortly after every start, on
 * every return to the app, every reconnect to the hub (a restart often brings a new build), and hourly. A new
 * build applies itself as soon as the page is idle: nothing typed in a text box and no call. Until then the bar
 * offers it, and it applies when the app goes out of sight.
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

/** Reloading now would lose something: a half-typed message or note, or a call. */
function busy(): boolean {
  if (document.querySelector('[data-call-phase]')) return true;
  return [...document.querySelectorAll<HTMLTextAreaElement | HTMLInputElement>('textarea, input[type=text], input:not([type])')].some((el) => el.value.trim() !== '' && !el.readOnly);
}

function watch(reg: ServiceWorkerRegistration) {
  let idleCheck: ReturnType<typeof setInterval> | undefined;
  const waiting = () => {
    if (!reg.waiting || !navigator.serviceWorker.controller) return;
    updateReady.value = true;
    if (document.visibilityState === 'hidden' || !busy()) return applyUpdate();
    // Busy: look again every few seconds, and apply once the text box is empty and the call is over.
    idleCheck ??= setInterval(() => !busy() && (clearInterval(idleCheck), applyUpdate()), 3000);
  };
  waiting();
  reg.addEventListener('updatefound', () => {
    reg.installing?.addEventListener('statechange', waiting);
  });
  document.addEventListener('visibilitychange', waiting);
}

export function registerServiceWorker() {
  if (!import.meta.env.PROD || !serviceWorkerSupported()) return;
  let controlled = !!navigator.serviceWorker.controller;
  navigator.serviceWorker.addEventListener('controllerchange', () => {
    // The first install claims this page, and nothing about the page is stale; every later swap is a new build.
    if (!controlled) return void (controlled = true);
    if (reloading) return;
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
      window.addEventListener('dither:reconnected', check);
      setInterval(check, 3_600_000);
      // Off the startup path: the first paint should not share the link with sw.js.
      setTimeout(check, 3000);
    })
    .catch((e) => console.warn('service worker registration failed', e));
}
