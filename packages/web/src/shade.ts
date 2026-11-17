/**
 * This device's notifications from the app, closed once what they show is read (docs/notifications.md, "Read
 * elsewhere, gone here"): on a read here, when the hub says something was read elsewhere (`cleared`), and after each
 * catch-up with the hub, against what the page now knows. A notification's tag is its chat, mail thread or group of
 * notices, and its data's `ts` the newest message it shows (sw.js `show`). Imports no module's code (state.ts uses it).
 */
import type * as P from '@dither-chat/protocol';

/** Whether what a notification shows is read: undefined when the page cannot tell, and then it stays. */
type ReadCheck = (tag: string, ts: number | undefined) => boolean | undefined;

/**
 * Read as the page holds it: a chat with nothing unread, or read past the newest message the notification shows; a
 * mail thread with nothing unread. Undefined for what it does not hold (a group of notices: notices.ts).
 */
export const readIn =
  (d: { conversations: ReadonlyMap<string, P.ConversationView>; mail: { threads: ReadonlyMap<string, P.MailThreadView> } }): ReadCheck =>
  (tag, ts) => {
    const c = d.conversations.get(tag);
    if (c) {
      if (!c.vantages.some((v) => v.unread || v.mentions)) return true;
      return ts !== undefined && ts <= Math.max(0, ...c.vantages.map((v) => v.lastReadTs ?? 0));
    }
    const t = d.mail.threads.get(tag);
    return t ? !t.unread : undefined;
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

/** Close the notifications with these tags; with `read`, only those it does not say are still unread. */
export async function closeNotifications(tags: Iterable<string>, read?: ReadCheck): Promise<number> {
  const want = new Set(tags);
  if (!want.size) return 0;
  let n = 0;
  for (const x of await showing()) {
    if (!want.has(x.tag) || read?.(x.tag, tsOf(x)) === false) continue;
    x.close();
    n++;
  }
  return n;
}

/** Close every notification `read` says is read; those it cannot tell about stay. */
export async function tidyNotifications(read: ReadCheck): Promise<number> {
  let closed = 0;
  for (const x of await showing()) {
    if (read(x.tag, tsOf(x)) !== true) continue;
    x.close();
    closed++;
  }
  return closed;
}

/** The tags of what shows now that start with this (`ntg_` for notices'). */
export async function shownTags(prefix: string): Promise<string[]> {
  return [...new Set((await showing()).map((x) => x.tag).filter((t) => t.startsWith(prefix)))];
}
