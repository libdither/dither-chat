import type { CutQuality } from './jpegscans.ts';

/**
 * The hub's send queue (docs/sync.md "The send queue"): each chat's sends kept in the hub, in order, until the network
 * has them, and held for you when the chat moved on while one waited.
 */

/**
 * - `queued`: the hub has it (one tick), and it goes when the sends before it in its chat are through.
 * - `sending`: handed to the account now.
 * - `sent`: the network named the message it became (two ticks).
 * - `held`: something came into the chat after what you could see when you pressed Send: it waits for you (Send,
 *   Edit, Cancel), or for the countdown while a device shows the chat.
 * - `unsure`: in doubt: it reached the account and no answer said whether it went out. Waits for you.
 * - `failed`: refused, nothing went out (the account not connected, not allowed, a file too big).
 * - `cancelled`: you took it back before it went.
 */
export type SendState = 'queued' | 'sending' | 'sent' | 'held' | 'unsure' | 'failed' | 'cancelled';

/**
 * The newest message of the chat you could see when you pressed Send. A reply from a notification gives only the id of
 * the message it answers, and the hub takes its time.
 */
export interface SeenUpTo {
  id?: string;
  ts?: number;
}

/** Why a send is held: messages that came after what you saw, not sent by this queue before it. */
export interface SendHold {
  count: number;
  /** Their ids, at most 20, oldest first. */
  ids: string[];
}

/** A send as the hub keeps it, for every device and tab (bootstrap `sends`, the `sends` event). */
export interface SendRow {
  clientId: string;
  conversationId: string;
  accountId: string | null;
  body: string;
  /** The attached files' names. */
  files: string[];
  replyTo: string | null;
  state: SendState;
  /** When Send was pressed, by the sending device's clock. */
  pressedAt: number;
  /** When the hub last changed it, by the hub's clock. */
  updatedAt: number;
  /** The hub's id of the message it became, once the network named it. */
  messageId: string | null;
  /** Why it failed or is in doubt. */
  error: string | null;
  hold: SendHold | null;
  /** The countdown: it goes by itself at this time (hub clock), unless you press something. Null: no countdown. */
  holdUntil: number | null;
  /** The order the hub took it in, across devices. */
  seq: number;
  /**
   * Its files are still uploading (`waitForFiles`): it goes once they are in, or, the phone having stopped, as far as its
   * photos came (docs/uploads.md "A send the hub holds"). The sends behind it in its chat wait with it.
   */
  filesComing: boolean;
  /** It went with its pictures cut as far as they had come, at this detail. */
  cut: CutQuality | null;
}

/** What a send asks for beyond the message (POST /api/conversations/:id/send). */
export interface SendQueueFields {
  /** Answer as soon as the hub has it in its queue, with its row: one tick. Without it, after the network's answer. */
  ack?: 'hub';
  seenUpTo?: SeenUpTo;
  /** This install of the app (activity.ts deviceId): its own earlier sends in the chat never hold this one. */
  device?: string;
  pressedAt?: number;
  /** Its files may still be uploading: the hub keeps it at the head of its chat until they are in (docs/uploads.md). */
  waitForFiles?: boolean;
}

/** The answer to a send with `ack: 'hub'`. */
export interface SendAccepted {
  ok: true;
  queued: true;
  row: SendRow;
}

/** POST /api/sends/:clientId */
export interface SendAction {
  action: 'send' | 'cancel' | 'edit';
}

/** Settings → Sending (GET/PUT /api/send-settings). */
export interface SendSettings {
  /** How long a held send counts down while a device shows its chat, in seconds. 0: no countdown, it waits for you. */
  holdSeconds: number;
}
export const HOLD_SECONDS_DEFAULT = 10;
export const HOLD_SECONDS_MAX = 120;

