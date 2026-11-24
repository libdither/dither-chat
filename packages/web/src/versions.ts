/**
 * What changed, and the signals components read to re-render because of it (docs/perf.md).
 *
 * - `rev`, the list: anything in `db` or the inbox. The sidebars, the rail and the panes read it.
 * - `metaRev`, names and settings: everything but a conversation's last message and unread counts, the inbox
 *   ranking and the inbox itself. What a message or a sidebar row shows beyond its own object reads this, so a
 *   message arriving re-renders its row and not every row.
 * - `timelineRev(key)`, one per timeline: its messages, its loading and what replies in it quote.
 * - `mailRev`, mail (docs/mail.md): its accounts, threads, lists and what the reader has loaded. Mail moving leaves the
 *   chat lists alone, and chat moving leaves mail alone.
 * - `presenceRev`, status dots (presence.ts): only the dots read it.
 * - `minute`, the clock: what says how long ago something was (`readMinute`).
 *
 * Changes are counted at once (`dataVersion`, which model.ts memoizes on); the signals move once the task that made
 * them is done.
 */
import { batch, effect, signal, untracked, type Signal } from '@preact/signals';

export const rev = signal(0);
export const metaRev = signal(0);
export const mailRev = signal(0);
/** Status dots: moves when `db.presence` changes (presence.ts). Only the dots read it, so lists stay as they are. */
export const presenceRev = signal(0);
const timelineRevs = new Map<string, Signal<number>>();

let version = 0;
/** Moves on every change to `db` at once, before the signals do: memos keyed on it are never stale. */
export const dataVersion = () => version;
let placesVersion = 0;
/**
 * The same, but not for who wrote (identities that came with a page of messages or the inbox, `changed('identity')`)
 * nor the inbox's messages (`changed('inbox')`): what counts, finds and orders conversations, places and people reads
 * neither (model.ts `placesMemo`), so the inbox arriving after a start does not work out the rail and the badge again.
 */
export const placesDataVersion = () => placesVersion;
let metaVersion = 0;
/**
 * The same for names, settings and what is where (a change that moves `metaRev`), not a conversation's last message
 * or counts: what is worked out from those alone (model.ts `metaMemo`) is not worked out again for a message or a read.
 */
export const metaDataVersion = () => metaVersion;
let mailVersion = 0;
/** The same for mail (`mailChanged`): the inbox's mail rows are memoized on both. */
export const mailDataVersion = () => mailVersion;

export function timelineRev(key: string): Signal<number> {
  let s = timelineRevs.get(key);
  if (!s) timelineRevs.set(key, (s = signal(0)));
  return s;
}

const dirty = { list: false, meta: false, all: false, mail: false, keys: new Set<string>() };
let scheduled = false;

/**
 * Something in `db` changed. 'meta': names or settings too, not only a conversation's last message and counts.
 * 'shown': only how things already where they are look (people's names and pictures, what a message's reaction row
 * offers), which moves `metaRev` but not what is where. 'open': only which folders are open, which moves what is where
 * (`metaDataVersion`) but nothing a message or a row shows, so `metaRev` stays and the rail draws it from `rev`.
 * 'identity': only identities, the names and pictures of who wrote: as 'shown', but `placesDataVersion` stays.
 * 'inbox': only the inbox's messages (`inbox`, `mailTriage`), and 'devices' only the hub's list of devices: `rev`
 * moves, `placesDataVersion` stays.
 */
export function changed(kind: 'list' | 'meta' | 'shown' | 'open' | 'identity' | 'inbox' | 'devices') {
  version++;
  if (kind !== 'identity' && kind !== 'inbox' && kind !== 'devices') placesVersion++;
  dirty.list = true;
  if (kind === 'meta' || kind === 'shown' || kind === 'identity') dirty.meta = true;
  if (kind === 'meta' || kind === 'open') metaVersion++;
  schedule();
}

/** Something in mail changed (db.mail, or what mail/api.ts loaded). */
export function mailChanged() {
  mailVersion++;
  dirty.mail = true;
  schedule();
}

/** A timeline's messages or loading changed; with no key, every timeline's (what replies quote). */
export function timelineChanged(key?: string) {
  if (key === undefined) dirty.all = true;
  else dirty.keys.add(key);
  schedule();
}

/** Moves the signals now. A timer does this by itself; tests call it. */
export function flush() {
  scheduled = false;
  if (!dirty.list && !dirty.all && !dirty.mail && !dirty.keys.size) return;
  const { list, meta, all, mail, keys } = dirty;
  dirty.list = dirty.meta = dirty.all = dirty.mail = false;
  dirty.keys = new Set();
  batch(() => {
    if (mail) mailRev.value++;
    if (list) rev.value = version;
    if (meta) metaRev.value++;
    if (all) for (const s of timelineRevs.values()) s.value++;
    else for (const k of keys) {
      const s = timelineRevs.get(k);
      if (s) s.value++;
    }
  });
}

/**
 * Runs `run` once, as soon as `ready()` holds: at once, or after a change to the list (`rev`) makes it so; never after
 * `ms`. `run` is not watched: whatever signals it reads and writes do not run the wait again. (Android's Answer on a
 * cold start joined the call from inside its wait, and `startCall` reads and sets the call, so each join ran the wait
 * again: a hundred joins, each asking for the microphone and opening a socket, until Preact gave up on the cycle.)
 */
export function onceListed(ready: () => boolean, run: () => void, ms: number): void {
  let done = false;
  let stop: (() => void) | null = null;
  const giveUp = setTimeout(() => stop?.(), ms);
  stop = effect(() => {
    rev.value;
    if (done || !ready()) return;
    done = true;
    clearTimeout(giveUp);
    // Not from inside the effect's own run, which may be its first, before `stop` is set.
    queueMicrotask(() => stop?.());
    untracked(run);
  });
}

/**
 * Once the task that changed things is done: a burst of events, a page and its identities, move each signal once.
 * Not once per frame: a flush in the frame renders in the same task as the layout and paint after it, which made
 * the longest task of a switch twice as long (docs/perf.md), and a hidden page gets no frames.
 */
function schedule() {
  if (scheduled) return;
  scheduled = true;
  setTimeout(flush, 0);
}

/**
 * Moves once a minute while the page is shown, and when it is shown again: what says how long ago something was
 * (an inbox row's time, a reply's ↩) reads this, not `rev`, so a message arriving draws its own row's time and not
 * every row's (docs/perf.md).
 */
const minute = signal(0);
let clock: ReturnType<typeof setInterval> | undefined;
export function readMinute(): number {
  if (clock === undefined && typeof document !== 'undefined') {
    const tick = () => document.visibilityState === 'visible' && minute.value++;
    clock = setInterval(tick, 60_000);
    document.addEventListener('visibilitychange', tick);
  }
  return minute.value;
}
