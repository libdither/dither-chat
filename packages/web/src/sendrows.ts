/**
 * What a chat shows of the sends not yet in it as messages (docs/sync.md "The send queue"): this device's own copies
 * until the hub has them, then the hub's rows, which every device and tab shows alike. Pure, so it is tested without
 * a browser (test/sendrows.test.ts).
 *
 * The marks:
 * - `device` (a clock): only this device has it. It goes to the hub by itself when the hub is reachable.
 * - `hub` (one tick): the hub has it, kept through any restart; it goes when the sends before it in the chat are through.
 * - `network` (two ticks): the network named the message it became. Shown until that message is here.
 * - `held`: the chat moved on while it waited: Send, Edit or Cancel, with the countdown while a device shows the chat.
 * - `unsure`: in doubt: the hub handed it on and no answer said whether it went out. Send again or Discard.
 * - `failed`: not sent: refused, nothing went out. Try again or Discard.
 * A `hub` row behind a held or in-doubt one says so (`behind`): it waits for that one.
 */
import type * as P from '@dither-chat/protocol';

/** A copy kept on this device (state.ts PendingSend), as far as showing it goes. */
export interface DeviceCopy {
  tempId: string;
  conversationId: string;
  body: string;
  ts: number;
  files?: string[];
  failed?: string;
  queued?: boolean;
  uploading?: boolean;
}

export type SendMark = 'device' | 'hub' | 'network' | 'held' | 'unsure' | 'failed';

export interface ShownSend {
  /** The device copy's tempId, or the hub row's clientId: the same string once the hub has it. */
  key: string;
  conversationId: string;
  body: string;
  files: string[];
  mark: SendMark;
  /** Which of the two it is: what its buttons act on. */
  from: 'device' | 'hub';
  /** Waiting for the hub (device), uploading its files (device). */
  queued?: boolean;
  uploading?: boolean;
  error?: string;
  hold?: P.SendHold;
  /** The countdown's end, by the hub's clock. */
  holdUntil?: number;
  /** Waits behind this held or in-doubt send. */
  behind?: string;
  /** A sent one whose message is not here: when it stops being shown, by the hub's clock. */
  goneAt?: number;
  ts: number;
}

/** A message of yours in the loaded timeline, as far as matching a send to it goes. */
export interface OwnMessage {
  id: string;
  conversationId: string;
  body: string;
  ts: number;
}

/** How long a sent row is shown if its message never comes (a network that does not echo it), by the hub's clock. */
export const SENT_SHOWN_MS = 30_000;
/** How much older than the press an echo may be dated (the network's clock, not this device's). */
const ECHO_SLACK_MS = 30_000;

/**
 * The sends a chat shows, oldest first: device copies the hub has no row for, then the hub's rows that are still open,
 * and sent ones whose message is not here yet. `here(messageId)` says whether a message is in the loaded timeline;
 * `hubNow` is the hub's clock. `own`: your messages in the loaded timeline. A row being sent, or sent with no message
 * named (a network that names none), is not shown once a message of yours with its text came after it was pressed:
 * that is its echo, come before the account's answer, and it is not shown twice.
 */
export function shownSends(conversationIds: string[], copies: DeviceCopy[], rows: P.SendRow[], here: (messageId: string) => boolean, hubNow: number, own: OwnMessage[] = []): ShownSend[] {
  const convs = new Set(conversationIds);
  const known = new Set(rows.map((r) => r.clientId));
  // Echoes not yet the message of a row that names one; each is taken by one row, oldest send first.
  const named = new Set(rows.map((r) => r.messageId).filter(Boolean));
  const free = own.filter((m) => !named.has(m.id)).sort((a, b) => a.ts - b.ts);
  const echoed = (r: P.SendRow) => {
    if (!(r.state === 'sending' || (r.state === 'sent' && !r.messageId))) return false;
    const text = r.body.trim();
    if (!text) return false;
    const k = free.findIndex((m) => m.conversationId === r.conversationId && m.body.trim() === text && m.ts >= r.pressedAt - ECHO_SLACK_MS);
    if (k < 0) return false;
    free.splice(k, 1);
    return true;
  };
  const out: ShownSend[] = [];
  for (const c of copies) {
    if (!convs.has(c.conversationId) || known.has(c.tempId)) continue;
    out.push({
      key: c.tempId,
      conversationId: c.conversationId,
      body: c.body,
      files: c.files ?? [],
      mark: c.failed ? 'failed' : 'device',
      from: 'device',
      ...(c.queued ? { queued: true } : {}),
      ...(c.uploading ? { uploading: true } : {}),
      ...(c.failed ? { error: c.failed } : {}),
      ts: c.ts,
    });
  }
  // What waits for you blocks the rows behind it in its conversation.
  const blocking = new Map<string, string>();
  for (const r of [...rows].sort((a, b) => a.seq - b.seq)) {
    if (!convs.has(r.conversationId) || r.state === 'cancelled') continue;
    if (r.state === 'sent' && ((r.messageId && here(r.messageId)) || hubNow - r.updatedAt > SENT_SHOWN_MS)) continue;
    if (echoed(r)) continue;
    const mark: SendMark = r.state === 'sent' ? 'network' : r.state === 'held' ? 'held' : r.state === 'unsure' ? 'unsure' : r.state === 'failed' ? 'failed' : 'hub';
    const behind = mark === 'hub' ? blocking.get(r.conversationId) : undefined;
    if ((mark === 'held' || mark === 'unsure') && !blocking.has(r.conversationId)) blocking.set(r.conversationId, r.clientId);
    out.push({
      key: r.clientId,
      conversationId: r.conversationId,
      body: r.body,
      files: r.files,
      mark,
      from: 'hub',
      ...(r.error && (mark === 'failed' || mark === 'unsure') ? { error: r.error } : {}),
      ...(r.hold && mark === 'held' ? { hold: r.hold } : {}),
      ...(r.holdUntil !== null && mark === 'held' ? { holdUntil: r.holdUntil } : {}),
      ...(behind ? { behind } : {}),
      ...(mark === 'network' ? { goneAt: r.updatedAt + SENT_SHOWN_MS } : {}),
      ts: r.pressedAt,
    });
  }
  return out;
}

/** Seconds left on a countdown, at least 0; null when there is none. */
export function countdownLeft(holdUntil: number | undefined, hubNow: number): number | null {
  return holdUntil === undefined ? null : Math.max(0, Math.ceil((holdUntil - hubNow) / 1000));
}

/** The line under a send: what it is doing, in words. */
export function sendNote(s: ShownSend, hubNow: number): string {
  switch (s.mark) {
    case 'device':
      return s.uploading ? 'Uploading…' : s.queued ? 'On this device: goes to the hub when it is back' : 'On this device';
    case 'hub':
      return s.behind ? 'The hub has it · waiting on the message above' : 'The hub has it';
    case 'network':
      return 'Sent';
    case 'held': {
      const n = s.hold?.count ?? 0;
      const left = countdownLeft(s.holdUntil, hubNow);
      const came = `${n} new message${n === 1 ? '' : 's'} came in since you wrote this`;
      return left === null ? `${came}. It waits for you.` : `${came}. Sends in ${left} s.`;
    }
    case 'unsure':
      return 'May have been sent: the hub lost track of it while sending. Check the chat before sending again.';
    case 'failed':
      return `Not sent: ${s.error ?? 'refused'}`;
  }
}

/**
 * The newest message you can see in a chat, as a send says it (`seenUpTo`): the newest by time across the timelines
 * shown that hold any message of the conversation (a person's chat spans several), or null when none is loaded.
 */
export function seenUpTo(conversationId: string, timelines: Iterable<{ key: string; messages: { id: string; ts: number; conversationId: string }[] }>): P.SeenUpTo | null {
  let best: { id: string; ts: number } | null = null;
  for (const t of timelines) {
    if (t.key !== `c:${conversationId}` && !t.messages.some((m) => m.conversationId === conversationId)) continue;
    for (const m of t.messages) if (!best || m.ts > best.ts) best = m;
  }
  return best ? { id: best.id, ts: best.ts } : null;
}
