/**
 * The pure part of sending with more than words (docs/sending.md): whether a reply pings its author, remembered per
 * account as Discord's reply bar remembers it; the times Send later and Remind Me offer and the words for a time; what
 * waits to go out in one conversation. sending.ts has the rest, which calls the hub.
 */
import type * as P from '@dither-chat/protocol';

// ------------------------------------------------------------------ the reply's ping

const mentionKey = (accountId: string) => `dither-chat:reply-mention:${accountId}`;

/** Whether a reply from this account pings its author: the last choice made with it, else yes (Discord's default). */
export function replyMentions(accountId: string | undefined, store: Pick<Storage, 'getItem'> | null = globalThis.localStorage ?? null): boolean {
  if (!accountId || !store) return true;
  try {
    return store.getItem(mentionKey(accountId)) !== 'off';
  } catch {
    return true;
  }
}

export function rememberReplyMentions(accountId: string | undefined, on: boolean, store: Pick<Storage, 'setItem' | 'removeItem'> | null = globalThis.localStorage ?? null) {
  if (!accountId || !store) return;
  try {
    if (on) store.removeItem(mentionKey(accountId));
    else store.setItem(mentionKey(accountId), 'off');
  } catch {}
}

// ------------------------------------------------------------------ times

export interface TimeChoice {
  label: string;
  at: number;
}

const at = (d: Date, h: number, m = 0) => new Date(d.getFullYear(), d.getMonth(), d.getDate(), h, m).getTime();
const DAY = 24 * 3_600_000;

/**
 * The times Send later offers first, in this device's time zone, as Discord's own picker does: 9:00 and 13:00 today
 * when still ahead (else tomorrow), and Monday 9:00. In an hour first, for the quick case.
 */
export function laterChoices(now: number): TimeChoice[] {
  const d = new Date(now);
  const nine = at(d, 9);
  const one = at(d, 13);
  const monday = new Date(d.getFullYear(), d.getMonth(), d.getDate() + (((8 - d.getDay()) % 7) || 7), 9).getTime();
  return [
    { label: 'In 1 hour', at: now + 3_600_000 },
    nine > now + 60_000 ? { label: 'Today at 9:00', at: nine } : { label: 'Tomorrow at 9:00', at: nine + DAY },
    one > now + 60_000 ? { label: 'Today at 13:00', at: one } : { label: 'Tomorrow at 13:00', at: one + DAY },
    { label: 'Monday at 9:00', at: monday },
  ];
}

/** Remind me: Discord's own menu's times. */
export function remindChoices(now: number): TimeChoice[] {
  const d = new Date(now);
  return [
    { label: 'In 30 minutes', at: now + 30 * 60_000 },
    { label: 'In 1 hour', at: now + 3_600_000 },
    { label: 'In 3 hours', at: now + 3 * 3_600_000 },
    { label: 'Tomorrow', at: at(d, 9) + DAY },
    { label: 'Next week', at: new Date(d.getFullYear(), d.getMonth(), d.getDate() + (((8 - d.getDay()) % 7) || 7), 9).getTime() },
  ];
}

/** "today at 14:05", "tomorrow at 9:00", "Mon 17 Nov at 9:00": when something goes out or is due. */
export function whenWords(t: number, now: number): string {
  const d = new Date(t);
  const time = `${d.getHours()}:${String(d.getMinutes()).padStart(2, '0')}`;
  const day = (x: number) => new Date(x).toDateString();
  if (day(t) === day(now)) return `today at ${time}`;
  if (day(t) === day(now + DAY)) return `tomorrow at ${time}`;
  if (day(t) === day(now - DAY)) return `yesterday at ${time}`;
  return `${d.toLocaleDateString(undefined, { weekday: 'short', day: 'numeric', month: 'short' })} at ${time}`;
}

/** A datetime-local input's value for a time, and back (this device's time zone). */
export function toLocalInput(t: number): string {
  const d = new Date(t);
  const p = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}T${p(d.getHours())}:${p(d.getMinutes())}`;
}
export function fromLocalInput(v: string): number | null {
  const m = v.match(/^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})/);
  if (!m) return null;
  return new Date(+m[1], +m[2] - 1, +m[3], +m[4], +m[5]).getTime();
}


/** What waits to go out in one conversation: not sent, not the network's. */
export const waitingIn = (list: P.ScheduledSendView[] | null, conversationId: string) => (list ?? []).filter((x) => x.conversationId === conversationId && x.state !== 'sent');
