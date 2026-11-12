/**
 * Fetching ahead (docs/perf.md, "Fetching ahead"): the first page of the conversations you are likeliest to open next,
 * so they open at once, from memory now and from the pages kept on the device (keptpages.ts) after the next start.
 *
 * - The first AHEAD rows of the inbox, in its own order (the hub's learned order: what you will likely open), once the
 *   hub's data is in, and again as that order changes. One page at a time, each once nothing was touched, typed or
 *   opened for QUIET and the page is idle; never while out of sight, on Save-Data or a cellular or 2G connection; at
 *   most BUDGET pages in WINDOW.
 * - A conversation or person row pressed (before the click) or rested on with a mouse: at once, within its own budget.
 * - Then the pictures those pages show (avatars and small images, the service worker keeps them), at most PICTURES a
 *   page.
 *
 * A page is loaded the way Catch up's cards are (state.ts, a glance): what the hub stored, without asking the network
 * for more; opening it asks the network then, as a first open does. One kept on the device is caught up instead, with
 * a small delta, so opening it shows what is there now. What is in memory already is left alone: the live socket keeps
 * it current. Nothing is fetched under ?ahead=0. ahead.ts loads this once the first screen is up and gives it the app's
 * state: it imports none of the app itself, so its chunk leaves the startup set as it was.
 */
import type * as P from '@dither-chat/protocol';

/** Inbox rows fetched ahead. 12 served 83.5% of a week's opens from the device with 40 kept pages in a replay, 86.2% with 60, at a few pages a day (docs/perf.md). */
export const AHEAD = 12;
/** Pages fetched ahead in any WINDOW, the rows' and the presses' each. */
export const BUDGET = 30;
export const WINDOW = 10 * 60_000;
/** How long nothing must have been touched or typed before the next page. */
export const QUIET = 1500;
/**
 * Pages fetched ahead and not opened that stay in memory, the newest kept: each one in memory is part of every catch-up
 * after a reconnect (the hub takes 100 timelines at most), and those still on the device open from there.
 */
export const HELD = 2 * AHEAD;
/** Pictures fetched for one page: its newest messages' avatars and images. */
export const PICTURES = 12;
/** An image bigger than this is left to its <img> (the service worker keeps up to 512 KB). */
const PICTURE_BYTES = 256 * 1024;
/** A mouse resting on a row this long is as good as a press. */
const HOVER = 120;
/** A finger down this long without the browser taking it for a scroll (pointercancel). */
const PRESS = 40;

// ------------------------------------------------------------------ deciding (pure, tested)

/** The rows' timelines to fetch, in their order: the first `k`, less what is held already. */
export function wanted(keys: string[], held: (key: string) => boolean, k = AHEAD): string[] {
  return keys.slice(0, k).filter((key) => !held(key));
}

/** At most `max` in any `window` milliseconds. */
export class Budget {
  private at: number[] = [];
  constructor(
    private max = BUDGET,
    private window = WINDOW,
  ) {}
  /** Whether one more may go now; if so, it is counted. */
  take(now: number): boolean {
    while (this.at.length && now - this.at[0] >= this.window) this.at.shift();
    if (this.at.length >= this.max) return false;
    this.at.push(now);
    return true;
  }
  /** When the next one may go. */
  nextAt(now: number): number {
    while (this.at.length && now - this.at[0] >= this.window) this.at.shift();
    return this.at.length < this.max ? now : this.at[0] + this.window;
  }
}

/** What the browser says of the connection (the Network Information API; Chromium and Android's WebView). */
export interface Link {
  saveData?: boolean;
  type?: string;
  effectiveType?: string;
}
/** Fetching ahead is off where data is dear: Save-Data, a cellular network, or 2G speeds. */
export const linkAllows = (l: Link | undefined) => !l || (!l.saveData && l.type !== 'cellular' && !/(^|-)2g$/.test(l.effectiveType ?? ''));

/** The hub's own pictures a page's newest messages show: their authors' avatars, then small images. */
export function picturesOf(messages: P.MessageView[], avatar: (authorId: string) => string | null | undefined, max = PICTURES): string[] {
  const out = new Set<string>();
  const ours = (u: string | null | undefined): u is string => !!u && u.startsWith('/media/');
  const newest = messages.slice(-20).reverse();
  for (const m of newest) {
    const a = m.authorId ? avatar(m.authorId) : null;
    if (ours(a)) out.add(a);
  }
  for (const m of newest)
    for (const a of m.attachments) {
      const image = a.kind === 'image' || a.info?.kind === 'image';
      if (image && ours(a.url) && (a.size ?? 0) <= PICTURE_BYTES) out.add(a.url);
    }
  return [...out].slice(0, max);
}

// ------------------------------------------------------------------ in the page

/** What verify-perf reads under ?perf=1 (docs/perf.md): what was fetched ahead, and where each open came from. */
export const aheadStats = { pages: [] as string[], pictures: 0, opens: { memory: 0, ahead: 0, glance: 0, kept: 0, hub: 0 } as Record<string, number>, idle: false };
if (typeof location !== 'undefined' && new URLSearchParams(location.search).has('perf')) (globalThis as { __ditherAhead?: unknown }).__ditherAhead = aheadStats;

/** Timelines fetched ahead and not yet opened. */
const fetchedAhead = new Set<string>();

export interface Deps {
  loaded: () => boolean;
  connected: () => boolean;
  fresh: () => boolean;
  /** Something the user is waiting for is loading. */
  busy: () => boolean;
  /** The inbox's rows, as timeline keys, in order. */
  rows: () => string[];
  /** The timeline an inbox row opens, by its `data-row`; null for one that is not a conversation (mail). */
  rowKey: (row: string) => string | null;
  /** The timeline a person row opens. */
  personKey: (personId: string) => string | null;
  inMemory: (key: string) => boolean;
  /** Let go of one fetched ahead and never opened (it stays on the device if it was kept). False: not now. */
  drop: (key: string) => boolean;
  /** Keep it with the pages opened (keptpages.ts), so the next start has it too. */
  keep: (key: string) => void;
  glance: (key: string) => Promise<void>;
  messages: (key: string) => P.MessageView[];
  avatar: (authorId: string) => string | null | undefined;
  onRows: (fn: () => void) => void;
  onOpen: (fn: (key: string, from: string) => void) => void;
}

export function startPrefetch(d: Deps) {
  if (typeof window === 'undefined' || new URLSearchParams(location.search).get('ahead') === '0') return;
  const rows = new Budget();
  const presses = new Budget();
  let lastInput = 0;
  let running = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const held = (key: string) => d.inMemory(key);
  const link = () => (navigator as Navigator & { connection?: Link }).connection;
  const may = () => document.visibilityState === 'visible' && d.loaded() && d.connected() && d.fresh() && linkAllows(link());

  const pictures = async (key: string) => {
    for (const url of picturesOf(d.messages(key), d.avatar)) {
      if (!may()) return;
      // Through the service worker, which keeps them (sw.js); the HTTP cache otherwise.
      await fetch(url, { priority: 'low' } as RequestInit)
        .then((r) => r.blob())
        .then(
          () => void aheadStats.pictures++,
          () => {},
        );
    }
  };
  const fetchOne = async (key: string) => {
    fetchedAhead.add(key);
    // The oldest go, unless the app says not now (it tries again with the next).
    for (const old of [...fetchedAhead].slice(0, Math.max(0, fetchedAhead.size - HELD))) if (d.drop(old)) fetchedAhead.delete(old);
    aheadStats.pages.push(key);
    d.keep(key);
    await d.glance(key).catch(() => {});
    await pictures(key);
  };

  /** Until nothing was touched for QUIET and the page is idle. */
  const quiet = async () => {
    for (;;) {
      const left = lastInput + QUIET - Date.now();
      if (left <= 0 && !d.busy()) break;
      await new Promise((r) => setTimeout(r, Math.max(left, 300)));
    }
    const idle = (globalThis as { requestIdleCallback?: (cb: () => void, o?: { timeout: number }) => void }).requestIdleCallback;
    await new Promise<void>((r) => (idle ? idle(() => r(), { timeout: 2000 }) : setTimeout(r, 50)));
  };

  const pump = async () => {
    if (running) return;
    running = true;
    aheadStats.idle = false;
    try {
      for (;;) {
        await quiet();
        if (!may()) return;
        const key = wanted(d.rows(), (k) => held(k) || fetchedAhead.has(k))[0];
        if (!key) return;
        const now = Date.now();
        if (!rows.take(now)) {
          clearTimeout(timer);
          timer = setTimeout(soon, rows.nextAt(now) - now);
          return;
        }
        await fetchOne(key);
      }
    } finally {
      running = false;
      aheadStats.idle = true;
    }
  };
  const soon = () => void pump();

  // Once the hub's data is in (after a QUIET of its own: what the start asks for goes first), and whenever the order or
  // the page's sight changes.
  new PerformanceObserver((l) => {
    if (!l.getEntriesByName('dither:fresh').length) return;
    lastInput = Math.max(lastInput, Date.now());
    soon();
  }).observe({ type: 'mark', buffered: true });
  d.onRows(soon);
  document.addEventListener('visibilitychange', () => document.visibilityState === 'visible' && soon());

  // ---------------------------------------------------------------- a press or a resting mouse

  const target = (el: EventTarget | null): string | null => {
    const e = el instanceof Element ? el : null;
    const row = e?.closest('[data-row], [data-person]');
    if (!row) return null;
    const conv = row.getAttribute('data-row');
    if (conv) return d.rowKey(conv);
    const person = row.getAttribute('data-person');
    return person ? d.personKey(person) : null;
  };
  const now = (key: string | null) => {
    if (!key || held(key) || fetchedAhead.has(key) || !may() || !presses.take(Date.now())) return;
    void fetchOne(key);
  };
  let pressing: ReturnType<typeof setTimeout> | undefined;
  let hovering: ReturnType<typeof setTimeout> | undefined;
  const input = () => void (lastInput = Date.now());
  for (const t of ['keydown', 'wheel', 'scroll'] as const) addEventListener(t, input, { capture: true, passive: true });
  // A new route (routes live in the hash): what it opens goes first.
  addEventListener('hashchange', input);
  addEventListener(
    'pointerdown',
    (e) => {
      input();
      const key = target(e.target);
      clearTimeout(pressing);
      // A mouse means it; a finger may be starting a scroll, which the browser says with pointercancel.
      if (e.pointerType === 'mouse') now(key);
      else pressing = setTimeout(() => now(key), PRESS);
    },
    { capture: true, passive: true },
  );
  addEventListener('pointercancel', () => clearTimeout(pressing), { capture: true, passive: true });
  addEventListener(
    'pointerover',
    (e) => {
      if (e.pointerType !== 'mouse') return;
      clearTimeout(hovering);
      const key = target(e.target);
      if (key) hovering = setTimeout(() => now(key), HOVER);
    },
    { capture: true, passive: true },
  );
  addEventListener('pointerout', () => clearTimeout(hovering), { capture: true, passive: true });

  d.onOpen((key, from) => {
    const ahead = from === 'glance' && fetchedAhead.delete(key);
    aheadStats.opens[ahead ? 'ahead' : from]++;
  });
}
