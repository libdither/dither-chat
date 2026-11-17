/**
 * This device's notifications from the app, closed once what they show is read (docs/notifications.md, "Read
 * elsewhere, gone here"): on a read here, when the hub says something was read elsewhere (`cleared`), and after each
 * catch-up with the hub, against what the page now knows. A notification's tag is its chat, mail thread or group of
 * notices, and its data's `ts` the newest message it shows (sw.js `show`). One with `keep` in its data (a reminder you
 * set, the summary when quiet hours end, "Reply not sent" with what you typed) is never closed here: only a tap or a
 * swipe ends it. Imports no module's code (state.ts uses it).
 */
import type * as P from '@dither-chat/protocol';

/** What a notification's data says that a check may read (sw.js `show`): the notice it shows, for a group of notices. */
interface ShownData {
  notice?: unknown;
}

/** Whether what a notification shows is read: undefined when the page cannot tell, and then it stays. */
type ReadCheck = (tag: string, ts: number | undefined, data: ShownData) => boolean | undefined;

/**
 * Read as the page holds it: a chat read at or past the newest message the notification shows; a mail thread with
 * nothing unread, the notification no newer than its newest message. Unread: a chat or thread with something unread
 * that the notification may show. Undefined otherwise, and it stays: a notification without a time (of no message,
 * or made by a page), or newer than anything the page holds as read, which came after the page last caught up with
 * the hub and may show what the page has not heard of yet. Also undefined for what the page does not hold (a group of
 * notices: notices.ts).
 */
export const readIn =
  (d: { conversations: ReadonlyMap<string, P.ConversationView>; mail: { threads: ReadonlyMap<string, P.MailThreadView> } }): ReadCheck =>
  (tag, ts) => {
    const c = d.conversations.get(tag);
    if (c) {
      if (ts !== undefined && ts <= Math.max(0, ...c.vantages.map((v) => v.lastReadTs ?? 0))) return true;
      return c.vantages.some((v) => v.unread || v.mentions) ? false : undefined;
    }
    const t = d.mail.threads.get(tag);
    if (!t) return undefined;
    if (t.unread) return false;
    return ts !== undefined && ts <= t.lastAt ? true : undefined;
  };

/**
 * A group of notices' notification shows its newest notice (`notice` in its data, sw.js `show`): read when the page
 * holds that notice as read; unread when it holds it unread or not at all, since one the list lacks came after the
 * list was fetched. Undefined for one that names no notice.
 */
export const noticeReadIn =
  (items: readonly { id: string; unread: boolean }[]): ReadCheck =>
  (_tag, _ts, data) => {
    if (typeof data.notice !== 'string') return undefined;
    const n = items.find((x) => x.id === data.notice);
    return n ? !n.unread : false;
  };

async function showing(): Promise<Notification[]> {
  if (typeof navigator === 'undefined' || !('serviceWorker' in navigator)) return [];
  try {
    const reg = await navigator.serviceWorker.getRegistration();
    return (await reg?.getNotifications()) ?? [];
  } catch {
    return [];
  }
}

const tsOf = (n: Notification): number | undefined => (typeof n.data?.ts === 'number' ? n.data.ts : undefined);
const kept = (n: Notification) => n.data?.keep === true;

/** Close the notifications with these tags; with `read`, only those it does not say are still unread. */
export async function closeNotifications(tags: Iterable<string>, read?: ReadCheck): Promise<number> {
  const want = new Set(tags);
  if (!want.size) return 0;
  let n = 0;
  for (const x of await showing()) {
    if (!want.has(x.tag) || kept(x) || read?.(x.tag, tsOf(x), x.data ?? {}) === false) continue;
    x.close();
    n++;
  }
  return n;
}

/**
 * The hub's `cleared`: each closes up to `upTo`, the newest message the hub notified about, so an alert that reached
 * this device after the read stays even before the page hears of its message. One without a time (a page's own)
 * closes unless the page holds something unread there.
 */
export function closeCleared(reads: readonly { id: string; upTo: number }[], read: ReadCheck): Promise<number> {
  const upTo = new Map(reads.map((r) => [r.id, r.upTo]));
  return closeNotifications(upTo.keys(), (tag, ts, data) => (ts === undefined ? read(tag, ts, data) : ts <= (upTo.get(tag) ?? -Infinity)));
}

/** Close every notification `read` says is read; those it cannot tell about stay. */
export async function tidyNotifications(read: ReadCheck): Promise<number> {
  let closed = 0;
  for (const x of await showing()) {
    if (kept(x) || read(x.tag, tsOf(x), x.data ?? {}) !== true) continue;
    x.close();
    closed++;
  }
  return closed;
}

/** The tags of what shows now that start with this (`ntg_` for notices'). */
export async function shownTags(prefix: string): Promise<string[]> {
  return [...new Set((await showing()).map((x) => x.tag).filter((t) => t.startsWith(prefix)))];
}
