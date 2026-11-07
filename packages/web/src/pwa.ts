/**
 * Service worker lifecycle: register it, notice new builds, and swap to them.
 *
 * The shell comes from the worker's cache (sw.js), so a new build never shows up by itself, and an installed
 * PWA rarely navigates, so the browser's own update check rarely runs. We ask shortly after every start, on
 * every return to the app, every reconnect to the hub (a restart often brings a new build), and hourly.
 *
 * A page in sight never reloads by itself (update.ts): a new build goes in when the app goes out of sight with
 * nothing in progress, or when you tap the bar. A tab that another tab updated shows the bar too.
 */
import { signal } from '@preact/signals';
import { noteOpen } from './activity.ts';
import { activeCall } from './call.ts';
import { layerCount } from './phone.ts';
import { go, parseHash, pending, toast } from './state.ts';
import { busyReasons, nextStep } from './update.ts';

export const updateReady = signal(false);

let registration: ServiceWorkerRegistration | null = null;
/** A newer worker controls this page, which still runs the old build. */
let stale = false;
/** The bar was tapped here. */
let asked = false;
let reloading = false;

export function serviceWorkerSupported() {
  return 'serviceWorker' in navigator && window.isSecureContext;
}

/** The bar: go to the new build now, whatever is open. */
export function applyUpdate() {
  asked = true;
  step();
}

/** What a reload would lose now (update.ts). */
export function busy(): string[] {
  const typed = [...document.querySelectorAll<HTMLTextAreaElement | HTMLInputElement>('textarea, input[type=text], input[type=password], input[type=search], input:not([type])')].some(
    (el) => el.value.trim() !== '' && !el.readOnly,
  );
  return busyReasons({
    typed,
    call: !!activeCall.value || !!document.querySelector('[data-call-phase]'),
    verifying: !!document.querySelector('.verify-device'),
    layers: layerCount(),
    menus: document.querySelectorAll('.menu-anchor > .menu').length,
    detached: !!document.querySelector('.jump-latest'),
    sending: pending.value.filter((p) => !p.failed && !p.acked).length,
  });
}

let idleCheck: ReturnType<typeof setInterval> | undefined;

/** Look at where things stand and take the next step, if there is one. */
function step() {
  const waiting = !!registration?.waiting && !!navigator.serviceWorker.controller;
  const hidden = document.visibilityState === 'hidden';
  const s = nextStep({ waiting, stale, asked, hidden, busy: !asked && busy().length > 0 });
  updateReady.value = waiting || stale;
  // Out of sight but busy (a send on its way, say): look again now and then, while it stays out of sight.
  if (hidden && s === 'offer') idleCheck ??= setInterval(step, 5000);
  else if (idleCheck) (clearInterval(idleCheck), (idleCheck = undefined));
  if (s === 'apply') {
    // From the bar, at once. Out of sight, only if no other window of the app is in sight either (sw.js), so none is
    // left on the old build; that window lets it in when it goes out of sight itself.
    registration?.waiting?.postMessage(asked ? 'skipWaiting' : { t: 'skipWaiting', unlessSeen: true });
  } else if (s === 'reload' && !reloading) {
    reloading = true;
    location.reload();
  }
}

function watch(reg: ServiceWorkerRegistration) {
  step();
  reg.addEventListener('updatefound', () => {
    reg.installing?.addEventListener('statechange', step);
  });
  document.addEventListener('visibilitychange', step);
}

export function registerServiceWorker() {
  if (!import.meta.env.PROD || !serviceWorkerSupported()) return;
  let controlled = !!navigator.serviceWorker.controller;
  navigator.serviceWorker.addEventListener('controllerchange', () => {
    // The first install claims this page, and nothing about the page is stale; every later swap is a new build. This
    // page reloads only if it asked, or is out of sight and idle; otherwise it offers the bar.
    if (!controlled) return void (controlled = true);
    stale = true;
    step();
  });
  // A stale page asking for a part of the app it has not loaded yet (the call, the live view, the emoji list) may
  // find that the new build no longer has it: say so rather than fail without a word.
  window.addEventListener('vite:preloadError', () => {
    if (!stale) return;
    updateReady.value = true;
    toast({ kind: 'info', title: 'A new version is ready', body: 'This part of the app changed with it. Tap the bar at the top to reload.' });
  });
  navigator.serviceWorker.addEventListener('message', (e) => {
    if (e.data?.t === 'open') {
      noteOpen(e.data.hash);
      go(parseHash(e.data.hash), false);
    }
  });
  navigator.serviceWorker
    .register('/sw.js', { updateViaCache: 'none' })
    .then((reg) => {
      registration = reg;
      watch(reg);
      // Each check downloads sw.js. A deploy restarts the hub, which the sync notices (dither:reconnected): coming
      // back to the app only checks when the last check is a while ago. What it finds goes in by the same rule.
      let last = 0;
      const check = (force: boolean) => {
        if (!navigator.onLine || (!force && Date.now() - last < 10 * 60_000)) return;
        last = Date.now();
        reg.update().catch(() => {});
      };
      document.addEventListener('visibilitychange', () => document.visibilityState === 'visible' && check(false));
      window.addEventListener('dither:reconnected', () => check(true));
      setInterval(() => check(true), 3_600_000);
      // Off the startup path: the first paint should not share the link with sw.js.
      setTimeout(() => check(true), 3000);
    })
    .catch((e) => console.warn('service worker registration failed', e));
}
