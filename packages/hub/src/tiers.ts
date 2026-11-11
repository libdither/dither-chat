/**
 * The Conversation rule (docs/notifications.md): people talking with you. A rule over who wrote when, never over what
 * was said, and not a model: nothing here is fitted.
 *
 * A message is a Conversation when its place is not kept to the list and it is not from a bot, and
 *  - it is in a DM, or
 *  - it mentions you by name or replies to your message (not @everyone), or
 *  - you wrote in its chat in the last `TOOK_PART`, or
 *  - you answer openings there at `ANSWER_RATE` or more (interact.ts `answerRate`: of the times someone started
 *    talking there while you were away, how often you wrote back within three hours, the last months counting most).
 *
 * On ten days of a real hub (2026-11, docs/triage-replay.md) this is 17 or 18 chats a day, 20 at most, with about 60
 * silent updates. A lower rate lets in more: counted another way on the same days, 0.05 added two chats a day to
 * 0.1's, and 0.02 added five with nearly twice the updates.
 */
import type { Facts } from './learn.ts';

const HOUR = 3_600_000;

/** You wrote there this recently: you are taking part. */
export const TOOK_PART = 24 * HOUR;
/** You answer openings there at least this often. */
export const ANSWER_RATE = 0.1;

/** What the rule needs to know of you in a chat, as of the message (interact.ts). */
export interface Part {
  /** When you last wrote there, or null. */
  lastOwn: number | null;
  /** How often you answer openings there, 0 to 1. */
  answerRate: number;
}

export type Conversing = 'dm' | 'about' | 'wrote' | 'answers' | null;

/** Why a message is a Conversation, or null when it is not. */
export function conversing(f: Pick<Facts, 'shape' | 'bot' | 'mention' | 'reply' | 'cap'>, part: Part, ts: number): Conversing {
  if (f.cap || f.bot || f.shape === 'self') return null;
  if (f.shape === 'direct') return 'dm';
  if (f.mention || f.reply) return 'about';
  if (part.lastOwn !== null && part.lastOwn <= ts && ts - part.lastOwn <= TOOK_PART) return 'wrote';
  if (part.answerRate >= ANSWER_RATE) return 'answers';
  return null;
}

export const CONVERSING_REASON: Record<Exclude<Conversing, null>, string> = {
  dm: 'A direct message',
  about: 'About you',
  wrote: 'You wrote here in the last day',
  answers: 'You usually answer here',
};
