/**
 * Catching up (docs/catch-up.md): the hub notices that it may be missing messages, works out where (a stretch of time
 * across an account's chats, or one chat), fetches them through the account's own history at the reading pace, and
 * keeps track of each hole until it is filled, found whole, or known to need another source.
 */
import type { Network } from './ontology.ts';

/** How sure a report is that messages are missing. A `possible` hole is probed before anything is fetched in bulk. */
export type CatchUpStrength = 'possible' | 'likely' | 'sure';

/**
 * What told the hub. Each is one of the ways the hub falls behind:
 * - `lost`: the hub itself lost events (a crash while events waited to be applied, an event that failed to apply, a
 *   stop that could not save what was left).
 * - `dropped`: dither-accounts' manager dropped events it held for the hub while the hub was away.
 * - `offline`: the account was offline, or the hub could not reach it, for a while.
 * - `adapter`: the adapter says it may have missed events (a gateway session it could not resume).
 * - `behind`: the network says a chat's latest message is newer than the newest the hub holds.
 * - `report`: someone (a person, a script) told the hub, through `POST /api/catch-up/report`.
 * - `nearby`: several chats of one account turned out to be missing messages around the same time, so the rest of the
 *   account's chats are checked for that time too.
 */
export type CatchUpCause = 'lost' | 'dropped' | 'offline' | 'adapter' | 'behind' | 'report' | 'nearby';

/**
 * Where a hole is in its life:
 * - `checking`: a `possible` hole looks at the few chats most likely to have had messages first.
 * - `fetching`: fetching every chat planned for it.
 * - `done`: everything planned was fetched (`found` says how many messages were new).
 * - `clear`: the check found nothing missing, so nothing more was fetched.
 * - `unfetchable`: no account can fetch this chat's history (Signal keeps none on its servers): another source is
 *   needed, an import (docs/import.md).
 * - `stopped`: you stopped it.
 */
export type CatchUpState = 'checking' | 'fetching' | 'done' | 'clear' | 'unfetchable' | 'stopped';

/** POST /api/catch-up/report: something suggests messages are missing. */
export interface CatchUpReport {
  /** The account whose chats may miss messages; or give `conversationId` alone. */
  accountId?: string;
  /** One chat: a chat hole, not the account's. */
  conversationId?: string;
  /** The stretch of time, ms. `to` absent: until now. */
  from: number;
  to?: number;
  strength?: CatchUpStrength;
  /** A short line on why, shown with the hole. */
  note?: string;
}

/** One chat a hole fetches. */
export interface CatchUpChatView {
  conversationId: string;
  name: string;
  shape: string;
  accountId: string;
  state: 'queued' | 'fetching' | 'done' | 'failed' | 'skipped' | 'unfetchable';
  /** Why it was planned in this order, or why skipped ("you never open it", "quiet then"). */
  why: string;
  /** Messages the hub expected in the stretch, from how busy the chat was before it. */
  expected: number;
  pages: number;
  /** Messages new to the hub. */
  found: number;
  error: string | null;
}

export interface CatchUpHoleView {
  id: string;
  /** `account`: a stretch of time across an account's chats; `chat`: one chat. */
  scope: 'account' | 'chat';
  accountId: string;
  accountName: string;
  network: Network | null;
  /** A chat hole's chat. */
  conversationId: string | null;
  conversationName: string | null;
  from: number;
  to: number;
  strength: CatchUpStrength;
  /** Every cause merged into it, first first. */
  causes: CatchUpCause[];
  /** Lines on why, newest last ("The manager dropped 2,400 events while the hub was away"). */
  notes: string[];
  state: CatchUpState;
  createdAt: number;
  updatedAt: number;
  /** Chats planned, and done (fetched, failed or skipped). */
  chats: number;
  chatsDone: number;
  /** Chats left out of the plan, and why ("you never open them"), each count once. */
  left: { why: string; count: number }[];
  pages: number;
  found: number;
  /** What it is fetching now. */
  current: string | null;
  /** Waiting on the reading pace: out of hours, the day's messages read, or a break. */
  resting: { until: number; why: 'hours' | 'cap' | 'break' } | null;
  /** The chats, busiest first; only in GET /api/catch-up/:id. */
  list?: CatchUpChatView[];
}

/** GET /api/catch-up */
export interface CatchUpView {
  holes: CatchUpHoleView[];
}
