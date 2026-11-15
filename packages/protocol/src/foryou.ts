/**
 * For you (docs/foryou.md): single messages from channels, threads and big groups that triage rated, one per burst,
 * in an order that stays put while you read it. Not the X notifications feed (docs/feed.md), which is a network's
 * own conversation. Seeing an item marks nothing read; what the page shows and what you do with it is logged (ids and
 * numbers only) so a ranker can be trained and replayed on it later.
 */
import type { IdentityView, MessageView } from './api.ts';

/** How an item got its place: `rank`, the order's own pick (propensity 1); `explore`, drawn by chance (plan §2). */
export type ForYouSlot = 'rank' | 'explore';

export interface ForYouItem {
  /** The served item's id: what events name. */
  id: string;
  message: MessageView;
  /** Its place in the snapshot, from 0. */
  position: number;
  slot: ForYouSlot;
  /** The exact chance it was put here: 1 for a `rank` slot. */
  propensity: number;
  /** Its burst: the messages around it from others in the same chat, it included. */
  burst: { count: number; from: number; to: number };
  /** The same message, from the same author, in other chats within ten minutes. */
  also?: string[];
  /** Why it is here, in words. */
  reasons: string[];
}

export interface ForYouPage {
  /** The snapshot this page is from: ask for the next page with it. */
  epoch: string;
  /** When the snapshot was taken. */
  at: number;
  items: ForYouItem[];
  /** The position to ask from next, or null at the end. */
  next: number | null;
  /** The messages the items reply to, for their quoted line. */
  quoted: MessageView[];
  identities: IdentityView[];
  /** The epoch asked for was gone (the hub restarted, or it was old): this is a fresh one. */
  reset?: boolean;
}

/** What the page tells the hub about one item. */
export type ForYouEventKind = 'shown' | 'clicked' | 'more' | 'less' | 'hidden';
export const FORYOU_EVENTS: readonly ForYouEventKind[] = ['shown', 'clicked', 'more', 'less', 'hidden'];

export interface ForYouEvent {
  itemId: string;
  device: string;
  kind: ForYouEventKind;
  /** When it first happened: for `shown`, when it first was at least half on screen with the page visible and in use. */
  at: number;
  /** `shown`: the milliseconds it has been on screen so far, summed (sent again as it grows: the largest stays). */
  ms?: number;
}

/** What it has done lately, for How it sorts and the scorecard. */
export interface ForYouStats {
  since: number;
  served: number;
  shown: number;
  clicked: number;
  /** Clicked of shown, or null with none shown. */
  clickRate: number | null;
  /** Of the items shown, the share from exploration slots. */
  exploreShare: number | null;
}
