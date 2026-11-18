/**
 * Threads read ahead (docs/feed.md "Reading ahead"), in the feed's chunk: a card with replies that stays on the screen,
 * or one pointed at, has its thread read before it is opened, so opening it shows the replies at once. Each read is a
 * call to the network, so they are few: two at a time, twelve a minute, a pointed-at card first, none where data is
 * dear (Save-Data, a cellular connection, as the inbox's fetching ahead); a card that leaves the screen before its turn
 * is not read. A thread read is kept as long as the hub keeps its answer (two minutes).
 *
 * The cards say how far theirs is (`preState`): being read, or read and opening at once. A card opened before its
 * thread came shows its post at once (`seedPost`), the replies under it as they come.
 */
import { signal } from '@preact/signals';
import type * as P from '@dither-chat/protocol';
import { Budget, linkAllows, type Link } from '../../prefetch.ts';
import { api, db } from '../../state.ts';

const KEEP_MS = 2 * 60_000;
const AT_ONCE = 2;
const PER_MINUTE = 12;
/** Threads kept, at most: the oldest go first. */
const KEEP_MAX = 60;

type Key = string;
const keyOf = (network: P.Network, post: string): Key => `${network}:${post}`;

const held = new Map<Key, { at: number; v: P.PostThreadView }>();
const asking = new Map<Key, Promise<P.PostThreadView>>();
/** Changes as threads start and finish being read: the cards' dots follow it. */
const preRev = signal(0);

/** How far a post's thread is: being read, read (opens at once), or neither. */
export function preState(network: P.Network, post: string): 'loading' | 'ready' | null {
  preRev.value;
  const k = keyOf(network, post);
  if (asking.has(k)) return 'loading';
  const h = held.get(k);
  return h && Date.now() - h.at < KEEP_MS ? 'ready' : null;
}

/** The thread read ahead, while it is fresh. */
export function heldThread(network: P.Network, post: string): P.PostThreadView | null {
  const h = held.get(keyOf(network, post));
  return h && Date.now() - h.at < KEEP_MS ? h.v : null;
}

/**
 * The thread read for this post forgotten: the next open asks the hub, whose copy the hub keeps current itself (a
 * followed post's chat: the hub's checks find its new replies, which a thread read here before them lacks).
 */
export function forgetThread(network: P.Network, post: string) {
  held.delete(keyOf(network, post));
}

/** A post's thread: the one read ahead while fresh, the read in flight, else asked now. `fresh`: asked again
 * (checking for new replies). */
export function readThread(network: P.Network, post: string, fresh = false): Promise<P.PostThreadView> {
  const k = keyOf(network, post);
  if (!fresh) {
    const h = heldThread(network, post);
    if (h) return Promise.resolve(h);
    const a = asking.get(k);
    if (a) return a;
  }
  const p = api<P.PostThreadView>(`/api/posts/${network}/${post}/thread${fresh ? '?fresh=1' : ''}`)
    .then((v) => {
      v.identities.forEach((i) => db.identities.has(i.id) || db.identities.set(i.id, i));
      // A thread the hub could not ask the network for is not kept: opening it asks again.
      if (!v.stored) held.set(k, { at: Date.now(), v });
      while (held.size > KEEP_MAX) held.delete(held.keys().next().value!);
      return v;
    })
    .finally(() => {
      if (asking.get(k) === p) asking.delete(k);
      preRev.value++;
    });
  asking.set(k, p);
  preRev.value++;
  return p;
}

// ------------------------------------------------------------------ reading ahead

const queue: { network: P.Network; post: string }[] = [];
let running = 0;
const budget = new Budget(PER_MINUTE, 60_000);
let later: ReturnType<typeof setTimeout> | null = null;

function pump() {
  while (running < AT_ONCE && queue.length) {
    const { network, post } = queue[0];
    if (heldThread(network, post) || asking.has(keyOf(network, post))) {
      queue.shift();
      continue;
    }
    const now = Date.now();
    if (!budget.take(now)) {
      if (!later) later = setTimeout(() => ((later = null), pump()), budget.nextAt(now) - now + 50);
      return;
    }
    queue.shift();
    running++;
    void readThread(network, post)
      .catch(() => {})
      .finally(() => {
        running--;
        pump();
      });
  }
}

/** Whether reading ahead may go on this connection: not where data is dear (prefetch.ts, a chunk of its own). */
const allowed = () => typeof navigator === 'undefined' || linkAllows((navigator as Navigator & { connection?: Link }).connection);

/** Read this post's thread before it is opened; `soon`: before the others waiting (it is pointed at). */
export function readAhead(network: P.Network, post: string, soon = false) {
  if (!allowed()) return;
  const k = keyOf(network, post);
  if (heldThread(network, post) || asking.has(k)) return;
  const at = queue.findIndex((x) => keyOf(x.network, x.post) === k);
  if (at >= 0) {
    if (!soon) return;
    queue.splice(at, 1);
  }
  if (soon) queue.unshift({ network, post });
  else queue.push({ network, post });
  pump();
}

/** The card left the screen before its turn: not read after all. */
export function dropAhead(network: P.Network, post: string) {
  const at = queue.findIndex((x) => x.network === network && x.post === post);
  if (at >= 0) queue.splice(at, 1);
}

// ------------------------------------------------------------------ a post shown before its thread

const seeds = new Map<Key, P.PostView>();
/** The posts the page shows, by id: one opened shows at once, its thread coming under it. */
export function seedPosts(network: P.Network, posts: readonly P.PostFact[]) {
  for (const p of posts) {
    const shown = p.repostOf ?? p;
    seeds.set(keyOf(network, shown.id), { ...shown, messageId: (shown as Partial<P.PostView>).messageId ?? null });
  }
  while (seeds.size > 400) seeds.delete(seeds.keys().next().value!);
}
export const seedPost = (network: P.Network, post: string): P.PostView | null => seeds.get(keyOf(network, post)) ?? null;
