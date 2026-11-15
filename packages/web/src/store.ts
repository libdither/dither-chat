/**
 * The client's copy of the hub's data, and the hooks told of each event: its own module, importing nothing of
 * state.ts, so the snapshot (snapshot.ts) can read and fill it while state.ts calls the snapshot, with no import cycle
 * (docs/testing.md "Import cycles"). state.ts re-exports all of it; components keep importing from there.
 */
import { signal } from '@preact/signals';
import type * as P from '@dither-chat/protocol';
import { emptyDb } from './syncmodel.ts';

export const loaded = signal(false);

/** The hub's state as this client knows it; syncmodel.ts says how bootstraps and events change it. */
export const db = emptyDb();

export interface Timeline {
  key: string;
  messages: P.MessageView[];
  hasMore: boolean;
  loading: boolean;
  /** person timelines: the direct conversations merged into it */
  conversationIds?: string[];
  /** Jumped to an old message: this window does not reach the latest ones. */
  detached?: boolean;
  /** When its first page was asked of the hub. A reconnect catches up the ones that have it. */
  fetchedAt?: number;
  /** A copy kept on this device: the journal position it is current to, until the hub has caught it up. */
  from?: P.SyncPosition;
  /** Loaded for a glance (Catch up's cards) from what the hub stored: opening it asks the network, as a first open does. */
  glance?: boolean;
}
export const timelines = new Map<string, Timeline>();
/** Messages referenced by replies that are outside the loaded page. */
export const quoted = new Map<string, P.MessageView>();
export const inbox = signal<P.MessageView[]>([]);
/** How it sorts' mail (docs/mail.md): what triage decided on new mail this week, newest first. */
export const mailTriage = signal<P.MailTriageItem[]>([]);

/** Others react to events too (usage.ts: time spent in places, sort settings), without state.ts knowing them. */
export const eventHooks = new Set<(ev: P.ClientEvent) => void>();
